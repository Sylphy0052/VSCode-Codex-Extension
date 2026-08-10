# VSCode Codex Extension 設計書

CLIコーディングエージェント（Codex / Claude Code）のセッションを、VSCodeのファイルタブと同じ感覚でエディタタブとして扱う拡張機能。

プロバイダ抽象と作業記録（日報連携）は §14・§15 を参照。§1〜§13 はCodexを前提に書かれており、Claude Code側の差分は §14 に集約している。

## 1. 目的とスコープ

### 目的

- 1ボタンで新規Codexセッションを新しいエディタタブとして開く
- 過去セッションを一覧から選んでresumeし、同じくタブで開く
- VSCode再起動後もタブ構成が復元される

### Phase 1のスコープ

| 含む                                                          | 含まない                                      |
| ------------------------------------------------------------- | --------------------------------------------- |
| 新規セッション（1ボタン、設定既定値で即起動）                 | エディタ選択範囲のCodexへの送信               |
| 新規セッション（Advanced: モデル/承認モード選択）             | セッションの実行中/待機中ステータス表示       |
| 履歴TreeView（ワークスペース限定＋全件トグル）                | Webviewによる独自チャットUI                   |
| resume / fork / archive / unarchive / delete                  | Codex Cloud連携                               |
| タブ位置・並び順とセッションIDの記憶と再起動時の自動復元      | マルチルートワークスペースの高度な扱い（§11） |
| thread_nameへのタブ名追従                                     |                                               |
| Codex未インストール/未ログイン時のガイド                      | サインイン/サインアウトのUI                   |
| 操作パネル（モデル/effort/承認方法/sandboxの切替）            | サインイン/サインアウトのUI                   |
| Codex画面（app-server連携のチャットUI・承認・ターン指定fork） | CLIのTUIをそのまま埋め込む方式                |
| 使用量の常時表示（ステータスバー＋操作パネル）                | 使用量の履歴やグラフ                          |

## 2. 全体アーキテクチャ

> **この節はTUIタブ方式（廃止済み）の設計です。** 当初はCLIのTUIをそのままエディタタブに出し、
> 拡張機能はセッションのライフサイクル管理だけを担う構成だった。スラッシュコマンドが
> チャット画面から使えるようになり（§9.8）、退避先としての役目も終えたため廃止した。
> 現行はすべてチャット画面（Codexは §9.5、Claude Codeは §14.4）で、`src/terminal` と
> タブ状態の永続化も削除している。以下は当時の判断の記録として残す。

描画はCodex TUIそのものに委ね、拡張機能は**セッションのライフサイクル管理**だけを担っていた。

```
┌─ VSCode Extension Host (workspace側 / WSL内) ────────────────┐
│                                                              │
│  SessionTreeProvider ──┐                                     │
│  (サイドバー履歴)       │                                     │
│                        ├──> SessionStore                     │
│  Commands ─────────────┤    (~/.codex/session_index.jsonl    │
│  (新規/resume/fork/…)   │     + rollout先頭行のsession_meta)  │
│                        │           ▲                         │
│                        │           │ FileSystemWatcher       │
│                        │                                     │
│                        └──> TerminalSessionManager           │
│                                 │                            │
│                                 ├─> CodexArgvBuilder         │
│                                 ├─> TabStateStore            │
│                                 │   (workspaceState)         │
│                                 └─> SessionBinder            │
│                                     (端末 ↔ session_id 紐付け)│
└─────────────────────────────┼────────────────────────────────┘
                              │ createTerminal({shellPath: codex, …})
                              ▼
                   ┌──────────────────────────┐
                   │ Editor Tab = codex process│  ← Codex TUI が全描画を担当
                   └──────────────────────────┘
```

### 設計上の要点

- 拡張機能はCodexの**出力を解釈しない**。TUIの承認プロンプト・差分表示・スラッシュコマンドは素通しで100%動く。Codexのバージョンアップに追従不要。
- 拡張機能とCodexの唯一の接点は「起動引数」と「`~/.codex` 配下のファイル」の2つに限定する。この境界が薄いほど壊れにくい。
- **ターミナルのプロセスそのものをCodexにする**（シェルに `sendText` でコマンドを流さない）。§5.2 参照。
- `extensionKind: ["workspace"]` を指定する。WSL Remote環境で `codex` はWSL側にあるため、UI側（Windows）で動くと起動できない。

## 3. モジュール構成

```
src/
  extension.ts              activate/deactivate、DIの組み立て
  codex/
    argvBuilder.ts          設定 → codex起動引数の組み立て（純粋関数）
    cliLocator.ts           codex実行ファイルの解決・存在チェック・未導入時ガイド
    sessionIndex.ts         session_index.jsonl のパース
    sessionMeta.ts          rollout先頭行 session_meta のパース
  session/
    sessionStore.ts         セッション一覧の集約・キャッシュ・フィルタ
    sessionWatcher.ts       session_index.jsonl の変更 + ロールアウトの新規作成を監視
    sessionActions.ts       archive/unarchive/delete の実行（delete は --force 必須）
  terminal/
    terminalSessionManager.ts  端末の生成・追跡・破棄・終了ハンドリング
    sessionBinder.ts        新規端末 ↔ session_id の事後紐付け（タグ照合）
    terminalRenamer.ts      thread_name追従リネーム（フォーカス非奪取）
  state/
    tabStateStore.ts        workspaceStateへの永続化と復元
  view/
    sessionTreeProvider.ts  TreeDataProvider
    sessionTreeItem.ts      表示整形（相対時刻など）
  commands/                 各コマンドの登録
test/
  unit/                     純粋ロジック + sessionBinder のテスト
  integration/              @vscode/test-electron
```

## 4. データソース

### 4.1 `~/.codex/session_index.jsonl`

1行1セッション。一覧の骨格として使う。

```json
{ "id": "019fd7a6-...", "thread_name": "環境構築手順を確認", "updated_at": "2026-08-06T15:17:53Z" }
```

**cwdを含まない**ため、ワークスペースでのフィルタには次のsession_metaが必要。

**収録規則（スパイクで確認済み）**: このindexは全セッションを含まない。`session_meta.thread_source == "user"` のセッションのみが載り、`thread_source: "subagent"` や `source: "exec"` の非対話セッションは載らない。本拡張機能が起動するのはユーザー起点の対話セッションなので一覧のソースとして妥当だが、「sessionsディレクトリのファイル数 ≠ index行数」である点を実装時に前提としてよい。

### 4.2 `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`

**1行目のみ**を読む。全文パースは不要。

```json
{
  "timestamp": "...",
  "type": "session_meta",
  "payload": {
    "session_id": "019fd7a6-...",
    "cwd": "/home/…/novel-writer",
    "originator": "codex_vscode",
    "source": "vscode",
    "cli_version": "0.146.0-…"
  }
}
```

利用フィールド: `session_id` / `cwd` / `timestamp` / `originator` / `source` / `thread_source`。

- ファイル名に `session_id` が含まれるため、**ファイルの存在自体がセッションの発生を示す**。これを紐付けの検知に使う（§9.1）。
- **作られるのはプロセス起動時ではなく、最初のユーザー発言時**（実機検証済み。TUIを18秒起動して発言しなかった場合、ファイルは1つも作られなかった）。つまりタブを開いただけのセッションは存在せず、resume対象にもならない。紐付けの待ち時間に上限を設けてはいけない。
- `originator` は環境変数 `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` で任意の値に上書きできる（検証済み）。
- アーカイブしたセッションは `~/.codex/archived_sessions/` へ**日付階層なしのフラット配置で移動**される。`unarchive` で元の `sessions/YYYY/MM/DD/` へ戻る。したがって走査対象は `sessions/**` と `archived_sessions/*` の2箇所であり、**どちらに存在するかがアーカイブ状態の判定そのものになる**。

### 4.2.1 一覧の骨格はロールアウトの実在

`session_index.jsonl` は**Codexが要約名を確定させてから**書かれる。indexだけを見ると、始めたばかりのセッションが履歴に出てこない（実機で確認）。

そのため一覧は**ロールアウトの実在**を骨格にし、indexは要約名と更新時刻の供給元として重ねる。Claude Code側（§14.2）と同じ組み立て方になる。

- 並び順は index の `updated_at`。無ければファイルの更新時刻で代用する
- 表示名は index の `thread_name`。無ければ先頭40行から最初の指示を拾う
- `thread_source` が `user` でない派生スレッドは出さない
- indexにあるのにロールアウトが消えているものは、cwdが判らず開けないので出さない（`unresolved` として数える）

**最初の指示の在り処は入口で異なる**。TUI経由は `event_msg` の `user_message` に入るが、チャット画面（app-server）経由のセッションにはこれが無く、`response_item` の `message`（role=user）だけが残る。後者は `turn_context` より前に AGENTS.md などの前置きが同じ形で入るため、`turn_context` 以降の最初の1件を採る。

### 4.3 パス解決とキャッシュ

- `id → ロールアウトファイル` は `sessions/**/rollout-*-<id>.jsonl` と `archived_sessions/rollout-*-<id>.jsonl` のglobで解決。
- `session_meta` はファイルの**1行目であり、セッション進行中に追記されても内容は変わらない**。したがって `id → {cwd, createdAt, filePath}` は不変とみなし、`globalState` に単純な永続キャッシュとして保持する（`mtime` 比較や再パースは行わない）。
- キャッシュの無効化はファイル消失時のエントリ削除のみ。`session_index.jsonl` に存在しないidは掃除する。
- `CODEX_HOME` 環境変数が設定されていればそれを優先し、なければ `~/.codex`。設定 `codex.codexHome` で明示上書きも可能にする。

## 5. 主要フロー

### 5.1 アクティベーション

`activationEvents` は `onStartupFinished` を指定する。タブ復元（§5.5）はサイドバーを開かなくても動く必要があるため、`onView:codexSessions` や `onCommand:*` だけでは不十分。

起動コストを抑えるため、activate時に行うのは以下に限る。

1. コマンドとTreeViewの登録（一覧の実データ構築はTreeViewが最初に展開されるまで遅延）
2. `TabStateStore` の読み出しとタブ復元（`codex.restore.enabled` が真の場合のみ）
3. `sessionWatcher` の登録

セッション一覧の構築は `updated_at` 降順で上位N件（`codex.history.maxEntries`、既定200）に限定し、`session_meta` の解決もその範囲に留める。

### 5.2 新規セッション（1ボタン）

```
コマンド codex.newSession
  ├ 1. cliLocator で codex の存在を確認（無ければ §5.7 のガイドへ）
  ├ 2. cwd決定（アクティブエディタのワークスペースフォルダ、なければ先頭）
  ├ 3. 一意な起動タグを生成（例: vscode-<uuid>）
  ├ 4. shellArgs = argvBuilder.build(設定)   ※ 実行ファイル名は含めない
  ├ 5. createTerminal({
  │       shellPath: codexPath, shellArgs, cwd: workspaceUri,
  │       env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: tag },
  │       location: TerminalLocation.Editor, isTransient: true, name: "Codex" })
  ├ 6. terminal.show()
  ├ 7. SessionBinder にタグを登録
  └ 8. rollout ファイル新規作成を検知 → 1行目の originator == tag で紐付け確定
                                     → TabStateStoreへ保存
                                     → thread_name確定時にタブ名更新
```

**シェルに `sendText` で流す方式は採らない。** `shellPath` / `shellArgs` を使うことで:

- 引数のクォート・エスケープが構造的に不要になる（cwdやパスの空白で壊れない）
- ターミナルのプロセス＝Codexとなり、**Codexの終了＝タブが閉じる**という素直な対応になる
- ユーザーのシェルrc出力がTUIの前に混ざらない
- 終了コードが `terminal.exitStatus.code` でそのまま取れる（§5.6）

`cwd` はターミナルオプションでも与えるが、**`-C` がプロセスのcwdより優先される**ことを確認済みのため、`session_meta.cwd` に記録される値は `-C` で渡した値になる。一覧のフィルタと一致させるため `-C` を正とし、必ず明示的に渡す。

`isTransient: true` を指定してVSCode標準のターミナル復元を**抑止**する。復元は §5.5 の自前ロジックに一本化し、二重復元を防ぐ。

### 5.3 新規セッション（Advanced）

`codex.newSessionAdvanced` はQuickPickを2段（モデル → 承認モード/sandbox）出してから同じフローに入る。選択値はそのセッション限りで、設定は書き換えない。

### 5.4 resume / fork

TreeViewのアイテムをクリック → `shellArgs = ["resume", "<session_id>", ...]`。既に同じ `session_id` のタブが開いていれば**新規に開かず既存タブをフォーカス**する（ファイルタブと同じ挙動）。forkは新しいセッションになるため常に新タブで、紐付けは §9.1 の新規セッションと同じ手順を踏む。

resume時は `thread_name` が既知なので、タブ名を最初から確定名で作成できる（リネーム不要）。

### 5.5 タブ復元

`TabStateStore` は `workspaceState` に以下を保存する。

```ts
type PersistedTab = {
  sessionId: string;
  viewColumn: number;
  order: number; // 同一グループ内のタブ位置
  cwd: string;
};
```

`order` は `window.tabGroups` から**実際のタブ位置を読んで**保存する。`createdAt` 順ではユーザーがドラッグで並べ替えた結果を再現できない。保存契機はタブの開閉・移動時（`window.tabGroups.onDidChangeTabs` / `onDidChangeTabGroups`）で、連続変更に備えてデバウンスする。

`activate` 時に保存済みタブを `(viewColumn, order)` 昇順で開き直す。

```ts
createTerminal({
  shellPath, shellArgs: ["resume", sessionId, ...],
  location: { viewColumn, preserveFocus: true },   // ← 列を指定しフォーカスを奪わない
  isTransient: true, name: `Codex: ${threadName}`,
})
```

- `location` は `TerminalLocation.Editor` ではなく**オブジェクト形式**を使う。列指定と `preserveFocus` の両方がこの形式でしか渡せない。
- 一斉起動を避けるため逐次（前のターミナル生成完了後に次）で開く。
- プロセスは新規なので画面バッファではなく**会話履歴からの復元**になる。この点は初回復元時のみ通知で明示する。
- 対象セッションのロールアウトファイルが消えている場合はスキップし、状態からも削除する。
- 復元数が `codex.restore.maxTabs`（既定8）を超える場合は超過分を破棄し、警告を出す。

### 5.6 終了とエラー処理

`window.onDidCloseTerminal` を購読し、追跡中の端末が閉じたときに以下を行う。

| 条件                                                          | 処理                                                                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| ユーザーがタブを閉じた（`exitStatus.reason === Shutdown` 等） | `TabStateStore` から該当エントリを削除。これを怠ると**閉じたセッションが次回起動で復活する**                 |
| `exitStatus.code !== 0` かつ起動から数秒以内                  | 起動失敗とみなしエラー通知（実行ファイル不在・未ログイン・引数不正）。通知に「出力を表示」アクションを付ける |
| `exitStatus.code === 0`                                       | 正常終了。状態から削除し、TreeViewを更新                                                                     |

いずれの場合も `SessionBinder` の未紐付けエントリと `TerminalRenamer` の保留キューから該当端末を除去する。

### 5.7 Codex未導入・未ログイン時

`cliLocator` が実行ファイルを解決できない場合、コマンド実行時にエラー通知を出す。通知にはインストール手順（`npm i -g @openai/codex` 等）へのリンクと、`codex.executablePath` 設定を開くアクションを添える。TreeViewは空状態のwelcomeビュー（`viewsWelcome`）で同じ導線を提示する。

未ログインはプロセス起動後にCodex側が判断するため、§5.6の異常終了検知で拾い、`codex login` の実行を案内する。

### 5.8 タブ名追従

```
sessionWatcher が session_index.jsonl 変更を検知
  → 紐付け済み端末の thread_name が変化していれば TerminalRenamer へ
       ├ その端末がアクティブ → workbench.action.terminal.renameWithArg で即時変更
       └ 非アクティブ         → 保留キューへ。onDidChangeActiveTerminal で
                                アクティブになった時に適用（フォーカスを奪わない）
```

VSCodeにはターミナル名を直接書き換えるAPIがなく、`workbench.action.terminal.renameWithArg` はアクティブターミナルに作用する。フォーカスを奪う副作用を避けるため、上記の「アクティブになるまで保留」戦略を採る。

**スパイクで確認済み**: `executeCommand('workbench.action.terminal.renameWithArg', { name })` は例外なく成功し、`terminal.name` と `window.tabGroups` から見えるタブのラベルの双方が新しい名前に変わる。対象はアクティブターミナルであるため、上記の保留戦略は引き続き必要。

## 6. コマンドとUI

コマンドIDの接頭辞は `codex.` / `claude.` のままにしてある。表示名を `Agent` に寄せた後も、既存の設定キー・キーバインド・永続化データと互換を保つため。

| コマンドID                                              | タイトル                          | 導線                                          |
| ------------------------------------------------------- | --------------------------------- | --------------------------------------------- |
| `codex.newChat`                                         | 新しい会話（Codex）               | ビュータイトルの `+`、パレット                |
| `claude.newChat`                                        | 新しい会話（Claude Code）         | ビュータイトルのスパークル、パレット          |
| `codex.openSession`                                     | （内部）ツリークリック            | TreeItem.command                              |
| `codex.openChat`                                        | チャット画面で開く（Codex）       | ツリー項目のホバー                            |
| `claude.openChat`                                       | チャット画面で開く（Claude Code） | ツリー項目のホバー                            |
| `codex.openConversation`                                | 会話を開いて分岐する              | ツリー項目のホバー（Codexのみ）               |
| `codex.renameChat`                                      | セッション名を変更                | Codex画面がアクティブなときのエディタタイトル |
| `codex.resumeSession`                                   | セッションを再開…                 | パレット（QuickPick）                         |
| `codex.resumeLast`                                      | 直前のセッションを再開            | パレット                                      |
| `codex.forkSession`                                     | このセッションをforkする          | ツリー右クリック                              |
| `codex.archiveSession`                                  | アーカイブする                    | ツリー右クリック（Codexのみ）                 |
| `codex.unarchiveSession`                                | アーカイブを解除する              | ツリー右クリック（アーカイブ表示時）          |
| `codex.deleteSession`                                   | 削除する                          | ツリー右クリック（確認ダイアログ必須）        |
| `codex.showAllSessions` / `codex.showWorkspaceSessions` | 表示範囲の切替                    | ビュータイトル                                |
| `codex.refreshSessions`                                 | 更新                              | ビュータイトル                                |
| `codex.showUsage`                                       | 使用量を表示                      | ステータスバー                                |
| `codex.showLog`                                         | ログを表示                        | パレット                                      |

新規セッションはチャット画面だけになった。

### TreeView

アクティビティバーに専用コンテナ `Agents` を置き、ビュー `codexSessions` を配置（ID は互換のため据え置き）。

```
Agents
├ ● 環境構築手順を確認            3分前     ← ●=タブとして開いている
│ Set up environment from docs   2時間前
└ VSCode拡張の設計               昨日
```

- label = `thread_name`（未確定なら `(untitled)`）、description = 相対時刻、tooltip = id / cwd / 絶対時刻。
- 全件表示トグル時のみ description に cwd のベース名を併記する。
- 開いているセッションは `contextValue` を分け、アイコンで区別する。
- セッションが0件、または `codex` 未検出の場合は `viewsWelcome` で導線を出す（§5.7）。

### 操作パネル（Webview）

サイドバーの上段に、モデル・reasoning effort・承認方法・サンドボックスを切り替えるWebviewを置く。CodexとClaude Codeをタブで切り替える。公式Codex拡張機能のサイドバーが提供する `Select model` / `Reasoning effort` と同等の操作をこちらでも行えるようにするため。

- 選択肢は `~/.codex/models_cache.json` から読む。**effortはモデルごとに異なる**ため（例: `gpt-5.5` は `low`〜`xhigh`、`gpt-5.6-sol` は `ultra` まで）、モデル選択に連動して選択肢を差し替える。モデルを変えた結果それまでのeffortが非対応になった場合は既定へ戻す。
- カタログが読めない場合は既知の値の和集合へフォールバックし、パネルは動作を続ける。
- 変更値はVSCode設定へ書く。`approvalMode` / `sandbox` は machine スコープのため、**必ず `ConfigurationTarget.Global`（ユーザー設定）へ書き込む**。ワークスペース設定への書き込みは失敗する。
- 設定画面から変更された場合も `onDidChangeConfiguration` でパネルへ反映し、表示が二重管理にならないようにする。
- CSPは `default-src 'none'` を基点にし、スクリプトはnonceで限定する。配色はVSCodeのCSS変数のみを使い、テーマに追従させる。

**適用範囲の制約**: ここでの変更が効くのは**次に開くセッション**。Codex画面は `turn/start` に毎回渡すため次の発言から効く（§9.5）。

**プロバイダの切り替え**: パネル上部のタブで Codex / Claude Code を1クリックで切り替える。選んだ側は `setState` に持たせ、リロード後も保つ。

Claude Code側で扱う設定と選択肢の出どころは次のとおり。

| 項目   | 選択肢                                             | 既定値の出どころ                 |
| ------ | -------------------------------------------------- | -------------------------------- |
| モデル | `fable` / `opus` / `sonnet` / `haiku` のエイリアス | `settings.json` の `model`       |
| effort | `low` / `medium` / `high` / `xhigh` / `max`        | `settings.json` の `effortLevel` |

Claude Codeだけは `claude.model` = `opus`、`claude.effort` = `medium` を拡張機能側の既定値として持つ。Codex側の「空＝CLIへ委譲」とは異なるが、Claude Codeには一覧APIも要約名も無く、未指定だと何が使われるか画面から分からないため、既定を明示する方を採った。「既定」を選べば従来どおり `settings.json` へ委譲する。
| 承認方法 | `--permission-mode` が受け付ける6種 | `settings.json` の `permissions.defaultMode` |

- **モデル一覧を返すAPIが無い**ため、CLIのヘルプが案内するエイリアスを固定で並べる。正式名（`claude-fable-5` など）を使う場合は `claude.model` を直接編集する。一覧に無い現在値は「(一覧外)」として選択肢に補うので、設定が失われることはない。
- `permissionMode` を `bypassPermissions` にするときは、Codexの `danger-full-access` + `never` と同じくモーダルで同意を取る。
- 使用量はCodex側にしか出せない（§14.8）ため、Claudeタブには表示しない。

### 使用量の表示

レート制限の使用量をステータスバーに常時表示し、詳細を操作パネルに出す。

**データ源**: ロールアウトの `event_msg` / `token_count` イベント。`rate_limits.primary.used_percent` / `window_minutes` / `resets_at`、`credits.balance`、`plan_type`、`info.total_token_usage`、`model_context_window` が得られる。

- レート制限は**アカウント単位**のため、最後に更新されたロールアウトの最新 `token_count` が現在値になる。セッションを跨いで最新ファイルを探す。
- ファイルは伸びるため、**末尾64KBだけを読んで**最後の `token_count` 行を拾う。先頭が欠けた行はパースに失敗するので黙って読み飛ばす。
- 使用率に応じてステータスバーの背景色を変える（75%以上で警告、90%以上でエラー）。

**取得元は2つ**。app-serverに繋がっていれば `account/rateLimits/read` で**現在値を問い合わせる**（当初は手段が無いと考えてロールアウト由来だけにしていたが、実機で確認して置き換えた）。繋がっていないときはロールアウトの末尾から読む。後者はCodexがAPIを呼んだ時点のスナップショットで、どのセッションも動いていなければ古いままなので、どちらの経路でも取得時刻（`capturedAt`）を併記する。

更新契機はロールアウトの追記イベント。会話中は頻発するため1.5秒デバウンスする。リセットまでの残り時間の表記だけは60秒ごとに再描画する（ファイルは読まない）。

**Claude Codeの制限は別項目にする**。情報は stream-json の `rate_limit_event` でしか流れず、transcript には残らない（実機で確認）。したがってCodexのように起動直後から出すことはできず、チャット画面が一度でも値を受け取ってからの表示になる。値が無い間は項目ごと隠す（枠だけ出ていると、取得できていないのか制限が無いのか区別できないため）。§14.8を参照。

### 破壊操作の実行仕様（スパイクで確認済み）

| 操作      | コマンド                    | 備考                                                                                                                                                                            |
| --------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| archive   | `codex archive <id>`        | `~/.codex/archived_sessions/` へ移動。成功=0 / 失敗=1                                                                                                                           |
| unarchive | `codex unarchive <id>`      | 元の `sessions/YYYY/MM/DD/` へ戻る                                                                                                                                              |
| delete    | `codex delete --force <id>` | **`--force` 必須**。拡張機能はTTYを持たないため、これがないと「対話端末なしでは確認できない」として exit 1 で拒否される。ユーザーへの確認は拡張機能側のモーダルダイアログで行う |

いずれも失敗時は exit 1 とstderrのメッセージを返すため、終了コードで成否を判定しエラー通知に本文を載せる。

## 7. 設定項目

**スコープの原則**: 実行経路（どのバイナリをどの引数で起動するか）と権限（sandbox / 承認）に影響する設定は `machine` スコープとし、リポジトリの `.vscode/settings.json` から上書きできないようにする。これを怠ると、リポジトリをクローンして開いただけで任意コマンドが実行され、Codexのサンドボックスも無効化される。

| キー                       | 型       | 既定        | スコープ            | 説明                                                                                       |
| -------------------------- | -------- | ----------- | ------------------- | ------------------------------------------------------------------------------------------ |
| `codex.executablePath`     | string   | `codex`     | **machine**         | 実行ファイルのパス                                                                         |
| `codex.codexHome`          | string   | `""`        | **machine**         | 空なら `CODEX_HOME` → `~/.codex`                                                           |
| `codex.additionalArgs`     | string[] | `[]`        | **machine**         | 任意の追加引数                                                                             |
| `codex.sandbox`            | enum     | `""`        | **machine**         | `read-only` / `workspace-write` / `danger-full-access`                                     |
| `codex.approvalMode`       | enum     | `""`        | **machine**         | `untrusted` / `on-request` / `never`                                                       |
| `codex.model`              | string   | `""`        | machine-overridable | 空なら `-m` を渡さずconfig.tomlに委譲                                                      |
| `codex.reasoningEffort`    | string   | `""`        | machine-overridable | `model_reasoning_effort`。専用フラグが無いため `-c model_reasoning_effort=<値>` として渡す |
| `codex.profile`            | string   | `""`        | machine-overridable | `-p`                                                                                       |
| `codex.restore.enabled`    | boolean  | `true`      | window              | 再起動時の自動resume                                                                       |
| `codex.restore.maxTabs`    | number   | `8`         | window              | 復元上限                                                                                   |
| `codex.history.scope`      | enum     | `workspace` | window              | `workspace` / `all`                                                                        |
| `codex.history.maxEntries` | number   | `200`       | window              | 一覧構築の上限件数                                                                         |

- **空文字＝フラグを渡さない**を徹底し、Codex側 `config.toml` との二重管理を避ける。
- `danger-full-access` と `never` の組み合わせを選んだ場合のみ、初回に確認ダイアログを出す。
- `argvBuilder` は設定値をenumのホワイトリストで検証し、未知の値は無視してログに残す（`machine` スコープでも壊れた値で起動しないため）。

## 8. セキュリティ考慮

| 項目                                     | 対処                                                                                                |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------- |
| ワークスペース設定による任意コマンド実行 | §7のスコープ設計。`executablePath` / `additionalArgs` / `codexHome` を `machine` に固定             |
| サンドボックス無効化の誘導               | `sandbox` / `approvalMode` も `machine`。危険な組み合わせは初回に確認ダイアログ                     |
| 引数インジェクション                     | `shellPath` / `shellArgs` 方式によりシェル解釈を経由しない（§5.2）                                  |
| セッション本文の漏洩                     | 拡張機能はロールアウトファイルの**1行目のみ**を読み、会話本文は読まない・保存しない・ログに出さない |
| 破壊操作                                 | `delete` は確認ダイアログ必須。`archive` は取り消し可能なため確認不要                               |

## 9. リスクと検証項目

実装開始前に潰しておくべき未確定事項。各項目はPhase 1の最初のタスクとして実機検証する。

| ID     | 内容                                                                                                                                                | 影響                                                     | 緩和策                                                                                                             |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| ~~V1~~ | **解決済**: `isTransient: true` で作った端末は Reload Window 後に復元されない（リロード前 tabs=1 → リロード後 エディタタブ0・拡張機能製の端末なし） | —                                                        | VSCode標準復元との二重化対策は不要。§5.5 の自前復元に一本化してよい                                                |
| ~~V2~~ | **解決済**: `workbench.action.terminal.renameWithArg` に `{ name }` を渡す形式が機能し、`terminal.name` とタブのラベル表示の双方が追従する          | —                                                        | フォールバック（固定名）は不要。§5.8 の追従を実装する                                                              |
| ~~V3~~ | **解決済**: `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` が `session_meta.originator` に反映されることを確認                                                | —                                                        | §9.1 の確定方式へ置換。ヒューリスティックと直列化は不要になった                                                    |
| V4     | `session_index.jsonl` の追記が行単位でアトミックか（部分行読み込み）                                                                                | パースエラー                                             | 末尾の不完全行を捨てる。パース失敗行は個別にスキップしログのみ。※紐付けはindexに依存しなくなったため影響は表示のみ |
| V5     | セッション数が数千件規模になった時の一覧構築コスト                                                                                                  | 起動が重い                                               | `updated_at` 降順で上位N件（§7 `history.maxEntries`）のみsession_metaを解決する                                    |
| ~~V6~~ | **解決済**: 成功=exit 0、失敗=exit 1（stderrにメッセージ）。`delete` は非対話端末では拒否され **`--force` が必須**                                  | —                                                        | 拡張機能はTTYを持たないため `delete --force` を使う。確認は拡張機能側のダイアログで行う                            |
| V7     | **同一セッションの多重resume**（別ウィンドウ・CLIから同じidを開く）                                                                                 | 同一ロールアウトファイルへの並行書き込みで履歴破損の恐れ | S6スパイクで確認。防げないなら、開始時に警告を出す／`fork` を促す                                                  |
| ~~V8~~ | **解決済**: `-C` がプロセスcwdより優先される                                                                                                        | —                                                        | `-C` を正とし常に明示的に渡す（§5.2）                                                                              |
| V9     | index に載っているセッションを `archive` したとき index から消えるか                                                                                | アーカイブ済みが一覧に残る                               | S6スパイクで確認。消えないなら `archived_sessions` の存在でフィルタする（§4.2の判定で代替可能）                    |

### 9.1 セッションIDの紐付け（V3・スパイクで解決済み）

CLIは対話起動時にsession_idを呼び出し元へ返さないため、当初は「起動時刻とcwdによるヒューリスティック照合＋起動の直列化」を予定していた。スパイクの結果、**環境変数による確定的な紐付けが可能**であることが判明したため、その方式を採る。

**確認できた事実**

- `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=<任意の値>` で起動すると、`session_meta.originator` がその値になる。
- ロールアウトファイルは起動直後に作られ、ファイル名に `session_id` が含まれる。

**採用する方式（タグ照合）**

1. 新規セッション起動ごとに一意なタグ（`vscode-<uuid>`）を生成し、`CODEX_INTERNAL_ORIGINATOR_OVERRIDE` として端末の `env` に渡す。
2. `sessions/**` 配下のロールアウトファイルの**新規作成**を監視する（`session_index.jsonl` の追記は待たない）。
3. 新規ファイルの1行目 `session_meta.originator` が自分のタグと一致すれば、そのファイル名の `session_id` を確定として紐付ける。

この方式の利点は、当初案の弱点をすべて解消する点にある。

- 時刻やcwdの一致に依存しないため、**誤紐付けが原理的に起きない**（タグは一意）
- 同時起動の取り違えがないため、**起動の直列化が不要**になり複数タブを並行して開ける
- indexの書き込みタイミングに依存しないため、**紐付けが即時**に完了する
- `thread_source` によるindexの収録規則（§4.1）の影響を受けない

**待ち時間に上限は設けない**。実機検証の結果、ロールアウトは**最初のユーザー発言時**に作られることが判明した（§4.2）。タブを開いてから話しかけるまで何分かかっても紐付かないのが正常な状態であり、タイムアウトで打ち切ると通常操作が壊れる。

待ちの寿命は端末の寿命に一致させる。`onDidCloseTerminal` で `cancel(tag)` を呼べば取りこぼしはなく、`shellPath` 方式によりCodexの終了は必ず端末の終了になる（§5.2）ため、待ちが残り続けることもない。この設計により時刻依存のロジックが消え、`Clock` の注入は不要になった。

unit testでは以下を検証する。

- タグ一致で正しく紐付く／タグ不一致のファイルを無視する
- 複数タブを同時に開いた場合、それぞれが自分のタグのセッションに紐付く
- 無関係なロールアウトが何度現れても待ちを取り下げない
- `cancel` 後は紐付かない

**注意**: この環境変数は名前が示すとおりCodexの内部向けであり、将来のバージョンで挙動が変わりうる。`argvBuilder` 側でタグが機能しなかった場合に備え、**タイムアウト時は静かに劣化する**（クラッシュせず未追跡扱いにする）設計を守る。CIでこの前提を検証する統合テストを1本置き、Codexのバージョンアップ時に気づけるようにする。

### 9.5 Codex画面（app-server連携）

`codex app-server` と繋いで会話を自前で描画する。当初はTUIをそのままエディタタブに出す方式と併存させていたが、スラッシュコマンドがチャット画面から使えるようになり、退避先としての役目も終えたため**TUIタブ方式は廃止した**（下の履歴を参照）。

### イベントモデル

実測した1ターンの流れは次のとおり。

```
turn/started
  item/started → item/agentMessage/delta（ストリーミング）→ item/completed
thread/tokenUsage/updated / account/rateLimits/updated
turn/completed
```

扱うのは `item` 系・`turn` 系・`thread/status/changed`・使用量・`thread/name/updated` のみ。**未知の通知は状態を変えずに素通しする**（プロトコルの追加で壊れないため）。ThreadItemは18種あるが、未知の種類も種類名だけ保持して捨てない。

### 接続

拡張機能全体で `codex app-server` を1プロセスだけ常駐させ、通知は `threadId` で画面へ振り分ける。スレッドごとにプロセスを起こさない。

### 承認

`item/commandExecution/requestApproval` などのサーバー要求は、**応答を返すまでCodexが停止する**。画面内に承認カードを出し、`accept` / `acceptForSession` / `decline` のいずれかで応答する。

- 宛先の画面が見つからない要求は**必ず拒否側に倒す**。ユーザーの目に触れないまま実行を許さないため。
- 画面を閉じるときは保留中の要求を全て `cancel` で解放する。放置するとCodexが待ち続ける。

### 会話途中からの分岐

`thread/fork` に `lastTurnId` を渡すと、そのターンまでを引き継いだ新しいスレッドができる（元は無傷）。CLIの `codex fork` はターンを指定できないため、この操作はapp-server経由でのみ実現できる。

### タブ名

Codexが会話内容から名前を付けると `thread/name/updated` が届くのでタブ名に反映する。`thread/name/set` で変更でき、Codex側に永続化されるため履歴一覧やTUIタブにも波及する。

### タブ復元

`registerWebviewPanelSerializer` で復元する。webview側が `setState` で `threadId` を保持しており、復元時にそれを使って `thread/resume` する。TUIタブの復元（§5.5）とは別経路になる。

### 9.6 中断したターンの扱い

`turn/interrupt` で止めたターンは `status: "interrupted"` として残るが、**itemsには自分の発言しか保存されない**（実機で確認）。途中まで流れていた応答はCodex側に永続化されないため、`thread/resume` でも戻らない。

タブ復元やresumeの直後に応答だけが消えて見えるのはこのため。拡張機能側で本文を退避すれば見た目は保てるが、§8の「会話本文を読まない・保存しない」に反するので採らない。

### 9.7 応答中の指示（待ち行列）

CodexもClaude Codeも応答中の指示を受け取れない。送信を弾くと入力を打ち直す羽目になるため、**送信は常に受け付け、応答中なら待ち行列へ積む**。

- ターンが終わった瞬間に先頭の1件を送る。busyがtrueからfalseへ変わったときが契機
- 待機中の内容は画面に一覧で出し、1件ずつ取り消せる
- 「今すぐ送る」は**中断してから送る**。応答中に割り込む手段がCLIに無いため、`turn/interrupt`（Codex）/ control protocol の `interrupt`（Claude Code）を挟む
- 行列そのものは `ChatState.queued` に持つ。両プロバイダで同じ操作になる

### 9.8 スラッシュコマンドの候補

入力欄で `/` を打つと候補を出す。**送信そのものはCLIに任せる**。`/name` をそのまま渡せば、Codexは `~/.codex/prompts/*.md` を展開し、Claude Codeはコマンドとして解釈する（どちらも実機で確認）。拡張機能の仕事は「何が使えるか」を見せるところまで。

どちらのCLIも `prompts` / `skills` / `commands` の3か所に置ける。ホーム（`~/.codex` `~/.claude`）とワークスペース（`<folder>/.codex` `<folder>/.claude`）の両方を読む。

| 置き場所          | 拾う形                 |
| ----------------- | ---------------------- |
| `<root>/skills`   | `<name>/SKILL.md` のみ |
| `<root>/prompts`  | 直下の `*.md` のみ     |
| `<root>/commands` | 直下の `*.md` のみ     |

- **参照ファイルを拾わない**。スキルは `SKILL.md` の隣に `design-guidelines.md` のような資料を置くため、再帰的に集めると候補が使えないもので埋まる（実データで93件→49件）
- 組込コマンドの一覧を返すAPIは無いため、名前は固定で持つ。**使えるかどうかは判定しない**。CLIが `isn't available in this environment` のように返すので、こちらで可否を決めると版差で嘘をつく
- 候補は `description` と `argument-hint` を frontmatter から読む。完全なYAML解析はせず、折り返した値は先頭行だけを採る
- 確定しても送信はしない。引数を書き足せるように `/name ` を入力欄へ入れるところで止める
- 候補が出ている間は `↑` `↓` が候補の移動になる（入力履歴の操作より優先）

## 10. 既知の制約

- **app-serverはexperimental**: チャット画面が依存するプロトコルは `[experimental]` 表記であり、将来変更されうる。未知の通知とitem種別を素通しする設計で、変更時に機能が落ちても壊れないようにしている。
- **マルチルートワークスペース**: Phase 1は「アクティブエディタが属するフォルダ、なければ先頭フォルダ」を1つ選ぶだけ。フォルダ別のセッション分離はPhase 2。
- **復元は会話履歴ベース**: 中断したターンの応答は戻らない（§9.6）。
- **プロセスは各タブ独立**: 同一ウィンドウ内での同一セッションの二重オープンは防ぐが、ウィンドウを跨いだ排他は行わない（V7）。
- **Codex側の外部変更**: CLIから直接archive/deleteした場合、TreeViewはファイル監視で追従するが、開いているタブは残る。

## 11. 技術スタック

- TypeScript / Node 20 / esbuild（バンドル）
- eslint + prettier、`tsc --noEmit` で型チェック
- テスト
  - unit: `argvBuilder` / `sessionIndex` / `sessionMeta` / `sessionStore`のフィルタ / `tabStateStore`のシリアライズ / **`sessionBinder`（§9.1の異常系）**
  - integration: `@vscode/test-electron` でコマンド登録・TreeView・タブ復元
- `scripts/check.sh` に lint / typecheck / test を集約し、commit前に全緑を必須とする
- パッケージング: `@vscode/vsce`

## 12. 実装順序（TDD）

0. ~~CLIスパイク（V3・V6・V8）~~ **完了**。結果は §4・§5.2・§6・§9 に反映済み。
1. **VSCodeスパイク（V1・V2・V7・V9）**（使い捨て。結果を本設計書に反映してから先へ進む）
2. `argvBuilder` + `cliLocator` — 設定 → 引数の純粋関数、enum検証、未導入時の判定（RED→GREEN）
3. `sessionIndex` / `sessionMeta` パーサ — 壊れた行・欠損フィールドの異常系込み
4. `sessionStore` + 永続キャッシュ + ワークスペースフィルタ + 件数上限
5. `util/clock.ts` + `sessionBinder` — 紐付けロジックを先にテストで固める
6. `terminalSessionManager`（`shellPath`方式・`onDidCloseTerminal`）— 新規セッション1ボタンが動く
7. `sessionTreeProvider` + `sessionWatcher` + `viewsWelcome` — 履歴一覧とresume
8. `tabStateStore`（tabGroupsからのorder取得）+ 復元フロー
9. `terminalRenamer` — thread_name追従（V2の結果次第でスキップ可）
10. fork / archive / unarchive / delete
11. README・設定ドキュメント整備、vsceパッケージング確認

## 13. Phase 1の完了条件

- 新規セッションボタン1回でエディタタブにCodex TUIが起動する
- Codexを終了するとタブが閉じ、異常終了時はエラー通知が出る
- タブを閉じたセッションは次回起動で復元されない
- `codex` 未検出時に、インストール手順への導線を含む通知とwelcomeビューが出る
- 履歴TreeViewが現在のワークスペースのセッションのみを更新時刻降順で表示し、全件トグルが機能する
- 一覧クリックでresumeされ、既に開いているセッションは既存タブがフォーカスされる
- ウィンドウリロード後、リロード前に開いていたセッションのタブが**同じ列・同じ並び順**で復元され、復元時にフォーカスを奪わない
- `executablePath` / `additionalArgs` / `codexHome` / `sandbox` / `approvalMode` がワークスペース設定から上書きできないことを確認する
- fork / archive / unarchive / delete が動作し、deleteは確認ダイアログを経る
- `scripts/check.sh` が全緑（lint / typecheck / test）で、そのログを完了報告に添付する

## 14. プロバイダ抽象とClaude Code対応

Codex専用だった構成に薄い抽象を1枚入れ、Claude Code CLI（`claude`）を同じ体験で扱えるようにする。UI層（履歴TreeView・タブ復元・チャット画面のHTML・作業記録）はプロバイダ非依存。

### 14.1 境界

```
src/provider/
  id.ts        ProviderId ('codex' | 'claude')
  types.ts     AgentProvider（locate / listSessions / buildLaunch / capabilities / tabTitle）
  registry.ts  利用可能なプロバイダの束。一覧を1本にマージする
src/codex/provider.ts   既存のargvBuilder・cliLocator・SessionStoreを束ねたアダプタ
src/claude/
  cliLocator.ts    claude実行ファイルと CLAUDE_CONFIG_DIR の解決
  argvBuilder.ts   stream-json用の引数（純粋関数）
  transcript.ts    projects/**/<id>.jsonl のパースとChatItemへの変換
  sessionStore.ts  一覧構築（mtime降順で上位N件だけ先頭を読む）
  streamJson.ts    stream-jsonイベント → ChatState（純粋関数）
  control.ts       control protocolのメッセージ組み立てと承認カード化（純粋関数）
  streamSession.ts claudeプロセスの常駐と入出力
  provider.ts      AgentProvider実装
```

`SessionSummary` と `PersistedTab` に `provider` を持たせ、履歴・タブ復元・作業記録をプロバイダ横断で扱う。`provider` を持たない旧形式のタブ状態は `codex` として読む。

### 14.2 Claude Code のデータソース

| 用途           | 場所                                                                  |
| -------------- | --------------------------------------------------------------------- |
| セッション実体 | `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`（1行1イベント）     |
| ホーム         | `CLAUDE_CONFIG_DIR` → `~/.claude`（設定 `claude.configDir` で上書き） |

- Codexの `session_index.jsonl` にあたる索引が無いため、transcriptを **mtime降順** に並べ、上位N件だけ先頭40行を読んで一覧を作る。
- Claude Codeには `thread_name` に相当する要約名が無い。表示名は **最初の人の発言**から作る（`isSidechain` のsubagent発言・ツール結果・IDEが挿入する制御タグは除く）。
- 更新契機は `projects/**/*.jsonl` のファイル監視。

### 14.3 セッションIDの紐付け（実機検証済み）

`claude --session-id <uuid>` で **起動前にidを決められる**。Codexで必要だった originator タグの事後照合（§9.1）はClaude側では不要で、タブは起動と同時に紐付く。

検証（2026-08-07、CLI 2.1.223）: 指定したUUIDと同名の transcript が `~/.claude/projects/<slug>/` に作られることを確認。

例外は `fork`（`-r <id> --fork-session`）で、この場合の新しいidはCLIが振るためこちらから指定できない。そのタブは紐付け未確定のまま扱い、復元と作業記録の対象外になる。

### 14.4 チャット画面（stream-json）

```
claude --print --input-format stream-json --output-format stream-json --verbose
       --include-partial-messages --replay-user-messages
       [--session-id <uuid> | -r <id>] [--model …] [--effort …] [--permission-mode …]
```

- app-serverと違い **1プロセス1セッション**。画面ごとにプロセスを常駐させ、発言のたびに起動し直さない。
- 出力イベントは `streamJson.ts` でCodexと共通の `ChatItem` / `ChatState` へ正規化する。未知のtypeは状態を変えず素通しする。実機で確認した種類: `system/init` / `assistant` / `user` / `stream_event` / `result` / `rate_limit_event` / `control_response`。
- `--resume` は過去のやり取りを標準出力に流さないため、初期表示は transcript を読んで作る。

### 14.5 承認（control protocol）

stdin/stdoutのNDJSON上を流れる `control_request` / `control_response` で扱う。**公式ドキュメントに無い**プロトコルのため、次の劣化方針を守る。

1. 起動直後に `{"subtype":"initialize"}` を送る（実機で `control_response/success` が返ることを確認済み）。
2. CLIから `can_use_tool` が届いたら承認カードを出し、決定を `{"behavior":"allow"|"deny"}` で返す。
3. ハンドシェイクが失敗した場合は **会話は続けたまま** 1度だけ通知し、以後は `claude.permissionMode` の設定に委ねる。

`acceptForSession`（この会話では常に許可）はCLI側に区別が無いため、許可として返す。

### 14.6 プロバイダごとにできること

| 操作                           | Codex | Claude Code                                          |
| ------------------------------ | ----- | ---------------------------------------------------- |
| 新規 / resume / タブ復元       | ○     | ○                                                    |
| チャット画面（承認・中断込み） | ○     | ○                                                    |
| fork（セッション全体）         | ○     | ○（idは未確定のまま）                                |
| 会話の途中のターンから分岐     | ○     | ×（CLIに手段が無い）                                 |
| archive / unarchive / delete   | ○     | ×（CLIに手段が無い。ファイルを直接消すことはしない） |
| セッション名の変更             | ○     | ×（要約名の概念が無い）                              |

対応しない操作はTreeViewの `contextValue`（`codexSession.<provider>`）でメニューから隠す。

### 14.7 チャット画面の設定行

Codex画面と同じHTML（`renderShell`）を使うため、画面下の設定行はClaude Code側にも出る。承認方法の選択肢だけプロバイダごとに差し替える（Codexは `APPROVAL_MODES`、Claude Codeは `--permission-mode` の6種）。

- Webview側のスクリプトはCodexのスナップショット形状を前提にしているため、Claude側は同じ形へ整えて送る。モデルカタログが無いのでエイリアスを `ModelInfo` 相当に見せ、キーも `reasoningEffort` → `effort`、`approvalMode` → `permissionMode` と読み替える。
- **適用範囲が違う**。Codex画面は `turn/start` に毎回渡すので次の発言から効くが、Claude Codeは1プロセス1セッションで起動時に引数が確定するため、**次に開くセッションから**効く。

### 14.8 使用量（rate_limit_event）

Claude Codeは消費率（`usedPercent`）を返さない。実測した中身は次のとおりで、**制限の種類とリセット時刻**しか得られない。

```json
{
  "type": "rate_limit_event",
  "rate_limit_info": {
    "status": "allowed",
    "resetsAt": 1786342200,
    "rateLimitType": "five_hour",
    "overageStatus": "rejected",
    "isUsingOverage": false
  }
}
```

- チャット画面の入力欄の下に `5時間制限 リセット 3時間後` のように出す。`status` が `allowed` 以外なら `到達` を併記する
- `rateLimitType` の未知の値はCLIの表記のまま出す（種類が増えても表示が消えないように）
- transcriptには残らないため、Codexのように常時表示はできない。ステータスバーには別項目として並べ、チャット画面が値を受け取ってから `Claude 5時間 ・ 3時間後` のように出す。制限に到達している場合は警告色にする
- **消費率は `/usage` から補う**。`rate_limit_event` には割合が無いが、`/usage` の応答には `Current session: 16% used` の形で入っている。会話中のセッションへ送ると応答が会話に混ざるため、`claude --print /usage` を別プロセスで叩く。ターンが終わるたびに読み、続けて発言しても60秒は叩き直さない
- 英語の文章をあてにしているので、**文言が変われば読めなくなる**。読めなければ黙って諦め、`rate_limit_event` 由来の表示（制限の種類とリセット時刻）に任せる
- 表示はCodexと共通のフッターで行い、消費率があればそちらを優先する

トークン数は表示しない。Codexの `thread/tokenUsage/updated` もClaudeの `result.usage` も取り込まない。

## 15. 作業記録（日報・週報連携）

この拡張機能から実行したセッションを、日報/週報システムが読める形で残す。

### 15.1 出力

- 出力先: `~/workspace/dairy/.buffer/<YYYY-MM-DD>.jsonl`（`agent.activityLog.dir` → `DAILY_BUFFER_DIR` → 既定の順で解決）
- 形式: 1行1レコード。`{"ts","source","cwd","text","ref"}`。`source` は `codex` / `claude-code`、`ref` は常に `vscode`
- 収集側 `~/.claude/scripts/daily/collect.py` の追記バッファ規約に合わせてある。フィールド名を変えると日報が黙って取りこぼす

### 15.2 粒度と契機

**1セッション1行**。発言のたびには書かない。

| 入口                    | 契機   | 本文     |
| ----------------------- | ------ | -------- |
| Codexチャット画面       | 発言時 | その発言 |
| Claude Codeチャット画面 | 発言時 | その発言 |

二重記録は `globalState` に持つ記録済みidの集合で抑止する（30日で掃除）。書き込みに失敗したものは既記録にせず、次の契機で書き直す。

### 15.3 会話本文の扱い

§8の「会話本文を読まない・保存しない」に対する**意図的な例外**であり、範囲を次に限定する。

- セッションごとに1行だけ、200文字までの1行要約
- `agent.activityLog.enabled` を `false` にすれば一切書かない

### 15.4 収集側の重複排除

拡張機能経由のClaude Codeセッションは transcript 走査（`collect_claude`）にも現れるため、`collect.py` 側で `(source, cwd, 分, 要約の先頭50字)` が一致する行を1件に畳み、`ref: "vscode"` の方を残す。
