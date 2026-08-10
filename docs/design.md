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

### 9.7 応答中の指示（割り込みと待ち行列）

送信を弾くと入力を打ち直す羽目になるため、**送信は常に受け付ける**。応答中の扱いはプロバイダで異なる。

**Codex**: `turn/steer` で進行中のターンへ割り込む。`{ threadId, expectedTurnId, input }` を送ると、**応答を止めずに**指示が届く。`expectedTurnId` は現在のターンと一致していなければならない。

- 送り先は `routeSend()` が決める。応答していなければ `turn/start`、応答中でターンidが判れば `turn/steer`、idが判らなければ待ち行列
- 割り込みに失敗した場合（ターンが入れ替わった直後など）は指示を捨てずに待ち行列へ積む
- 待ち行列に積まれた分は、ターンが終わった瞬間に先頭から送る。busyがtrueからfalseへ変わったときが契機

**Claude Code**: 割り込みに相当する制御が見つかっていない（`interrupt` の応答に `still_queued` があるため、CLI側が待ち行列を持っているとみられる）。従来どおり待ち行列へ積み、ターンが終わってから送る。

- 待機中の内容は画面に一覧で出し、1件ずつ取り消せる
- 「今すぐ送る」の意味はプロバイダで異なる。Codexは**中断せず割り込む**、Claude Codeは従来どおり**中断してから送る**（それ以外に先に届ける手段が無いため）
- 行列そのものは `ChatState.queued` に持つ。両プロバイダで同じ操作になる

### 9.8 スラッシュコマンドの候補

入力欄で `/` を打つと候補を出す。**CodexとClaude Codeで作りが違う**。判定の根拠と全一覧は [slash-commands.md](slash-commands.md) にある。

|             | 組込コマンドは効くか                       | 候補の出どころ                                      |
| ----------- | ------------------------------------------ | --------------------------------------------------- |
| Codex       | **効かない**（テキストとして素通しされる） | 擬似コマンド + `skills/list` + ファイル             |
| Claude Code | 効く                                       | `initialize` の応答（実測90件）+ `commands_changed` |

- **Codexの組込コマンドはapp-serverに存在しない**。TUI層の機能なので、`turn/start` へ `/status` を送るとただの文章としてモデルへ渡る（実測で確認）。候補から外し、代わりに拡張機能側の機能へ割り当てた**擬似コマンド**を先頭に置く（現在は `/compact` のみ）。送信時に名前で振り替え、CLIへは送らない
- 擬似コマンドは対応する動作があるものだけ載せる。**候補に出るのに押しても何も起きない状態を作らない**ため、機能ができてから足す
- **Claude Codeの一覧はCLIが持っている**。`initialize` の応答が組込・ユーザー定義・プラグイン由来をまとめて返すため、こちらでハードコードしない。手で並べていた7件のうち `review` と `cost` は実在しなかった
- `commands_changed` 通知は差分ではなく一覧をまるごと押し付けてくるので、受け取ったら入れ替える。同じ名前が重複して返ることがあるため、先に見つけたものを残す
- 一覧が取れないときだけファイル走査の結果を使う。候補がまったく出ない状態よりはよい

ファイル由来の候補は、どちらのCLIも `prompts` / `skills` / `commands` の3か所に置ける。ホーム（`~/.codex` `~/.claude`）とワークスペース（`<folder>/.codex` `<folder>/.claude`）の両方を読む。

| 置き場所          | 拾う形                 |
| ----------------- | ---------------------- |
| `<root>/skills`   | `<name>/SKILL.md` のみ |
| `<root>/prompts`  | 直下の `*.md` のみ     |
| `<root>/commands` | 直下の `*.md` のみ     |

- **参照ファイルを拾わない**。スキルは `SKILL.md` の隣に `design-guidelines.md` のような資料を置くため、再帰的に集めると候補が使えないもので埋まる（実データで93件→49件）
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

### 14.9 コンテキスト残量と手動圧縮

長い作業では「そろそろ圧縮が要る」の判断が要る。TUIはCodexが `/status`、Claude Codeが `/context` でこれを出している。チャット画面でも同じ数字を出し、その場で圧縮できるようにする。

**14.8の消費率とは別物**。あちらはレート制限（アカウントの枠）、こちらはコンテキスト（1会話に載る量）で、増減の理由も対処も違う。`ChatUsage` へ混ぜず `ContextUsage`（`usedTokens` / `contextWindow` / `remainingPercent`）として別に持ち、フッターには `使用量 42% ・ コンテキスト 22k/258k（残り92%）` のように何の数字か分かる言葉を付けて並べる。

#### 入手経路（実測で確認）

|             | 使用量                              | 圧縮の要求                          | 圧縮の合図                     |
| ----------- | ----------------------------------- | ----------------------------------- | ------------------------------ |
| Codex       | `thread/tokenUsage/updated` 通知    | `thread/compact/start { threadId }` | `contextCompaction` 項目       |
| Claude Code | `get_context_usage` control request | `/compact` を発言として送る         | `system` の `compact_boundary` |

- Codexの `ThreadTokenUsage` は `{ last, total, modelContextWindow }`。**コンテキストの占有量は `last.totalTokens`** で、`total` はスレッド全体の累計。圧縮すると `last` だけが下がる（実測: 21541 → 4831、`total` は 21541 のまま）
- Claude Codeの `get_context_usage` は `{ categories, totalTokens, maxTokens, percentage }` を返す。内訳は使わず合計と上限だけ取る。会話へ `/context` を送ると応答が会話に混ざるため、control protocol で聞く
- 読み直す契機はターンの完了時。圧縮の効果もここで表示へ反映される
- **上限が判らないときは割合を出さない**。作った残量を出すくらいなら数字だけ出す

#### 圧縮

- 入力欄の横に「圧縮」ボタンを置く。押すと**確認のモーダル**を出してから実行する（会話の内容を要約へ置き換えるため、元には戻せない）
- Codexは専用のメソッドがある。`thread/compacted` 通知はプロトコル側で非推奨なので見ず、`contextCompaction` 項目の到着で判断する
- Claude Codeには専用の制御要求が無い。TUIと同じく `/compact` を**発言として送る**（`local_command` の制御要求は `Unsupported control request subtype` で失敗する）
- Claude Codeの結果は `system` の `status` 通知に入る。`compact_result` は `success` か `failed` で、失敗時は `compact_error` が付く（例: `Not enough messages to compact.`）。**成功の項目は `compact_boundary` が受け持ち、`status` からは失敗だけを項目にする**。両方で作ると同じ圧縮が二重に並ぶ
- 圧縮後にCLIが流す要約は `content` が配列ではなく文字列で届くため、発言としては並ばない（`applyUser` は配列の part だけを見ている）
- 圧縮の位置は種類 `contextCompaction` の項目として会話に残す。CodexとClaude Codeで同じ種類にそろえてあるので、描画側の分岐は要らない

## 15. 作業記録（日報・週報連携）

この拡張機能から実行したセッションを、日報/週報システムが読める形で残す。

### 15.1 出力

- 出力先: `~/workspace/dairy/.buffer/<YYYY-MM-DD>.jsonl`（`agent.activityLog.dir` → `DAILY_BUFFER_DIR` → 既定の順で解決）
- 形式: 1行1レコード。`{"ts","source","cwd","text","ref","session_id","kind"}`
  - `source` は `codex` / `claude-code`、`ref` は常に `vscode`
  - `session_id`: セッションを一意に識別するid（Codex: thread id、Claude: session id）。収集側（`collect.py`）がCLI由来の記録と突き合わせて重複を落とすのに使う。必須
  - `kind`: `"prompt"`（ユーザー発言）か `"result"`（ターン完了時のアシスタントの成果）
- 収集側 `~/.claude/scripts/daily/collect.py` の追記バッファ規約に合わせてある。フィールド名を変えると日報が黙って取りこぼす。未知フィールドは無視されるため、フィールドの追加自体は安全

```json
{
  "ts": "2026-08-10T17:33:33+09:00",
  "source": "codex",
  "cwd": "/abs/path",
  "text": "...",
  "ref": "vscode",
  "session_id": "<セッションid>",
  "kind": "prompt"
}
```

### 15.2 粒度と契機

`prompt` と `result` の2種類を、それぞれ発生のたびに書く（旧仕様の「セッション初回の1行だけ」という抑止は撤廃した）。

| kind     | 契機                                                                     | 本文                                                        |
| -------- | ------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `prompt` | Codex/Claude Codeチャット画面で発言のたび（ループからの送信を含む）      | その発言                                                    |
| `result` | Codexのターン完了（成功・失敗いずれも。`turn/completed`・`turn/failed`） | アシスタントの最終応答＋編集ファイル                        |
| `result` | Claude Codeのターン完了（`stream-json` の `result` イベント）            | アシスタントの最終応答（`result` フィールド）＋編集ファイル |

- `prompt`: ユーザーが実際に送信するたびに1行書く。ループ機能から同じ文面を繰り返し送った場合も、実際に送信している以上は抑止しない
- `result`: そのターンの応答テキストを1行化・200字切り詰めし、ファイルを編集していれば末尾に ` [edit: a.ts, b.ts]` のように最大5件までワークスペース相対パスで付記する（超過分は ` +N`）。相対パスにできなければ basename。全体で200字を超える場合は応答要約側から先に削り、編集ファイル一覧を優先して残す。応答テキストと編集ファイルの両方が空なら記録しない
  - 編集ファイルの抽出元: Codexはpatch/apply系のイベント（`fileChange` ThreadItem）、Claudeは `tool_use` の Edit/Write/NotebookEdit の `input.file_path`

### 15.3 会話本文の扱い

§8の「会話本文を読まない・保存しない」に対する**意図的な例外**であり、範囲を次に限定する。

- 1回の記録につき200文字までの1行要約（`prompt` は発言そのもの、`result` は応答要約＋編集ファイル）
- `agent.activityLog.enabled` を `false` にすれば一切書かない

### 15.4 収集側の重複排除

拡張機能経由のClaude Codeセッションは transcript 走査（`collect_claude`）にも現れるため、`collect.py` 側は `session_id` を軸にCLI由来の記録と突き合わせて重複を1件に畳み、`ref: "vscode"` の方を残す前提とする。

## 16. 並列オーケストレーション（ワークフロー実行）

複数のタスクを依存関係つきで定義し、独立したタスクを並列のセッションで走らせる。オーケストレータは拡張機能側に置き、各タスクは通常のチャット画面（Codex: §9.5 / Claude Code: §14.4）1枚として開く。

想定する形は `T1 → (T2 || T3) → T4`。T1が終わったらT2とT3を同時に開始し、両方の完了を見てからT4を開始する。

### 16.1 位置付けと既存機能との違い

| 機能                                          | 範囲             | 制御単位 |
| --------------------------------------------- | ---------------- | -------- |
| ループ（§9.7 の隣、`loop/loopController.ts`） | 1セッション内    | ターン   |
| ワークフロー（本節）                          | 複数セッション間 | タスク   |

ループは「同じ画面へ同じ指示を条件成立まで送り続ける」もので、ワークフローは「タスクごとに画面を作り、依存を満たした順に走らせる」もの。タスク1件の実行にはループ制御をそのまま使う（§16.5）。両者は入れ子の関係にあり、置き換えではない。

### 16.2 定義ファイル

ワークフローはワークスペース内のYAMLファイルで定義する。置き場は設定 `agent.workflows.dir`（既定 `.agents/workflows`）で、拡張子は `.yaml` / `.yml`。

```yaml
version: 1
name: 認証機能の追加

defaults:
  provider: codex # codex | claude
  maxParallel: 3 # 1〜10
  isolation: worktree # worktree | worktree-strict | shared
  sandbox: workspace-write # 拡張機能の設定より緩められない（§16.16）
  autoApprove: true # machine設定で許可されている場合のみ有効（§16.16）
  maxIterations: 20
  cleanup: keep # keep | remove（worktreeの後始末）

tasks:
  - id: T1
    prompt: 認証方式を検討し、docs/auth-design.md に設計を書く
    done: docs/auth-design.md を書き終えている

  - id: T2
    dependsOn: [T1]
    provider: claude
    prompt: |
      docs/auth-design.md に従いAPI側を実装する。
      設計時の要約:
      {{T1.result}}
    done: API側の実装が終わり、全テストが通っている
    continuePrompt: 続き
    maxIterations: 30

  - id: T3
    dependsOn: [T1]
    prompt: docs/auth-design.md に従いUI側を実装する
    done: UI側の実装が終わり、全テストが通っている

  - id: T4
    dependsOn: [T2, T3]
    isolation: shared
    prompt: |
      次のブランチをマージし、結合部分の齟齬を直してレビューする。
      - {{T2.branch}}（{{T2.cwd}}）
      - {{T3.branch}}（{{T3.cwd}}）
    done: マージが終わり、全テストが通っている
```

#### タスクのフィールド

| フィールド                                | 必須 | 既定                     | 意味                                                                                                               |
| ----------------------------------------- | ---- | ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `id`                                      | 必須 | -                        | ワークフロー内で一意。テンプレート変数の参照名になる                                                               |
| `prompt`                                  | 必須 | -                        | 最初に送る指示                                                                                                     |
| `done`                                    | 必須 | -                        | 終了条件（§16.5）。全タスクに書かせる                                                                              |
| `dependsOn`                               | -    | `[]`                     | 先に完了していなければならないタスクid                                                                             |
| `continuePrompt`                          | -    | `続けてください`         | 2回目以降に送る指示                                                                                                |
| `maxIterations`                           | -    | defaults                 | 送信回数の上限。既存のループと同じく200で頭打ち                                                                    |
| `provider`                                | -    | defaults                 | `codex` / `claude`                                                                                                 |
| `isolation`                               | -    | defaults                 | `worktree` / `worktree-strict` / `shared`（§16.6）                                                                 |
| `cwd`                                     | -    | -                        | 明示するとworktreeを作らずそのディレクトリで走らせる。`isolation` より優先する。ワークスペース配下に限る（§16.16） |
| `model` `effort` `approvalMode` `sandbox` | -    | defaults→拡張機能の設定  | そのタスクのセッションにだけ効く。安全側にしか動かせない（§16.16）                                                 |
| `autoApprove`                             | -    | defaults（既定 `false`） | `true` にすると危険と判定した要求以外を自動で許可する（§16.7）。どこにも書かなければ全ての承認を人へ回す           |
| `escalate`                                | -    | `[]`                     | 自動承認しないコマンドのパターン追加                                                                               |
| `allow`                                   | -    | `[]`                     | 既定の停止条件から外すパターン。解除できない固定ルールがある（§16.16）                                             |
| `retries`                                 | -    | `0`                      | 失敗時の再試行回数                                                                                                 |

未知のフィールドは読み飛ばす（CLIやスキーマの更新で壊れないようにする）。

#### 検証

読み込み時に次を検査し、1件でも該当すれば実行を始めない。エラーは全件まとめて返す（1件直すたびに再実行させない）。

- `id` の重複、`dependsOn` の未定義参照
- `id` の大文字小文字だけが違う重複。worktreeのパスとブランチ名に使うため、大小文字を区別しないファイルシステムでは同じ場所を指してしまう（`toLowerCase()` で正規化したキーでも見る）
- 依存の循環（強連結成分ごとに検出し、循環に含まれるidを全て示す。独立した複数の循環（例: `A<->B` と `C<->D`）があれば、成分ごとに別のエラーとして返す）
- `done` の欠落、`prompt` の欠落
- `tasks` が配列でない、またはタスクが0件
- `dependsOn` が配列でない（例: `dependsOn: T1` のような書き忘れ。黙って `[]` として扱うと、直列であるべきタスクが並列で走ってしまう）
- `id` が `^[A-Za-z0-9_][A-Za-z0-9_-]{0,49}$` に一致しない。この値はそのままパスとブランチ名に入るため、パストラバーサルやgitの引数解釈を防ぐために字種を絞る（`codex/argvBuilder.ts` がセッションidをUUIDで検証しているのと同じ理由）。先頭のハイフンを許さないのは、`-` で始まる文字列がコマンドのオプションとして解釈されうるため
- `id` がWindowsの予約デバイス名（`CON` `PRN` `AUX` `NUL` `COM1`〜`COM9` `LPT1`〜`LPT9`、大文字小文字を問わない完全一致）。worktreeのディレクトリ名に使えない
- `id` が `-retry` に数字が続く形で終わっている（`/-retry\d+$/`）。再試行時のブランチ名 `wf/<runId>/<taskId>-retry<n>`（§16.5）と衝突する
- `maxParallel` が1未満、または10を超える。タスクの総数が50を超える
- `retries` が上限（`MAX_RETRIES` = 10）を超える。再試行のたびに新しいworktreeとCLIプロセスが増えるため
- `maxIterations` が1未満、または200（既存のループ制御の上限 `LOOP_ITERATION_LIMIT` と共通）を超える
- `prompt` `done` `continuePrompt` が長すぎる（上限 `MAX_PROMPT_LENGTH` = 20000文字程度）。巨大な文字列で拡張機能ホストを固まらせないため
- テンプレート変数（§16.4）が未定義のタスクや、依存に挙げていないタスクを参照している
- `cwd` がワークスペースフォルダの外を指している（§16.16）
- Claudeタスクの `approvalMode` が `bypassPermissions` である。この設定では危険判定そのものが働かない（§16.7）
- `isolation: shared` のタスク同士が、依存関係の上で同時に走りうる。ファイル衝突が避けられないため警告する（`cwd` を明示していれば警告しない）
- `provider` / `isolation` / `cleanup` に未知の値が指定されている（空文字＝未指定は対象外）。既定値へ黙って置き換わる前に気づけるよう警告する（例: `isolation: Worktree-Strict` のようなタイプミスが、安全側の指定のつもりで既定の `worktree` にすり替わる事故を防ぐ）
- `escalate` / `dependsOn` の配列に文字列以外の要素が混ざっている。特に `escalate` は自動承認を止める側（安全性を強める側）のフィールドで、黙って要素を捨てるとフェイルオープンになりうるため警告する。`allow` の配列も同様に警告するが、こちらは停止条件を緩める側のフィールドで、要素を捨てても安全側に倒れる（設定ミスに気づけるようにするための警告）

### 16.3 スケジューリング

依存を満たしたタスクを、`maxParallel` の範囲で同時に開始する。

- 走らせる集合の決定は純粋関数（`scheduler.ts`）に閉じる。入力は「タスク定義」と「タスクごとの状態」、出力は「次に開始するidの集合」
- Codexは1つのapp-serverプロセスが複数スレッドを扱えるため、並列数を上げてもプロセスは増えない。Claude Codeはセッションごとに `claude` プロセスが立つため、`maxParallel` の主な意味はこちら側にある
- タスクの状態は `pending` / `running` / `waitingApproval` / `done` / `failed` / `skipped`
- `waitingApproval` も並列の枠を占める。人待ちのセッションもプロセスとしては生きているため
- 同じ段のタスクが複数開始できるとき、定義ファイルに書かれた順で埋める（再現性のため）

### 16.4 タスク間の引き継ぎ

`prompt` と `continuePrompt` の中で `{{<id>.<field>}}` を書いたときだけ、その値を差し込む。依存タスクの応答を無条件に前置きすることはしない（長文でコンテキストを圧迫するため）。

| 変数            | 中身                                                         |
| --------------- | ------------------------------------------------------------ |
| `{{T1.result}}` | T1の最後のターンの応答テキスト（`ChatState.turnResultText`） |
| `{{T1.cwd}}`    | T1が走ったディレクトリの絶対パス                             |
| `{{T1.branch}}` | T1のworktreeのブランチ名（`shared` のときは現在のブランチ）  |
| `{{T1.files}}`  | T1が編集したファイルのパス一覧（改行区切り）                 |

参照できるのは `dependsOn` に挙げたタスクのみ。それ以外を参照した定義は検証で弾く（完了していない値を読む事故を防ぐ）。

**展開は読み込み時ではなく、タスクの開始直前に行う。** 読み込み時にできるのは変数名の検査だけで、値はその時点でまだ存在しない。展開そのものは純粋関数（入力: 文字列と、完了済みタスクの結果の対応表）として `workflow.ts` に置き、呼ぶのは `runner.ts` である。

`{{T1.result}}` はエージェントの応答をそのまま次のタスクへ渡す。応答に機微な内容が含まれていれば、それが展開後のプロンプトを通じて作業記録（§16.12）へも流れる。この点は §16.16 で扱う。

### 16.5 タスクの完了判定

全タスクに終了条件（`done`）を書かせる。判定は既存のループ制御（`LoopController`）をそのまま使う。

1. `prompt` に終了条件を添えて送る（`decoratePrompt` と同じ形。条件を満たしていれば作業をせず `<<LOOP_DONE>>` とだけ返すよう頼む）
2. ターンの完了（`busy` の立ち下がり）を見て、宣言が出ていなければ `continuePrompt` を送る
3. 宣言が出たらタスクは `done`

ループの停止理由をタスクの結果へそのまま対応させる。

| `LoopStopReason`         | タスクの結果                             |
| ------------------------ | ---------------------------------------- |
| `done`                   | `done`                                   |
| `maxReached`             | `failed`（回数切れ。理由を記録する）     |
| `failed`                 | `failed`（`retries` の範囲で再試行）     |
| `manual` / `interrupted` | 実行全体を停止（人が割り込んだとみなす） |

タスクが `failed` になった時点で、そのタスクに依存する後続を `skipped` にし、実行全体を止める。独立した枝も止める（合流タスクの前提が崩れた状態で走らせない）。ただし、すでに `running` のタスクは走らせ切る。途中で殺すと中途半端な変更がworktreeに残るため。

#### 再試行

`retries` の再試行は、**新しいスレッドと新しいworktreeで最初からやり直す**。失敗した文脈のまま `continuePrompt` を送り直しても、同じところで詰まるだけになりやすいため。ブランチ名は `wf/<runId>/<taskId>-retry<n>` として既存と衝突させない。

人が承認要求を拒否したために止まったタスクは、自動再試行の対象にしない（同じ危険操作を繰り返し提示させないため）。Viewからの手動の「再実行」だけを受け付ける。

### 16.6 作業ディレクトリの分離

`isolation: worktree` のタスクは、専用のgit worktreeで走らせる。同時に走るタスクが同じファイルを書いて壊れるのを、原理的に防ぐため。

- 置き場: `<repo>/.agents/worktrees/<runId>/<taskId>`
- ブランチ: `wf/<runId>/<taskId>`、分岐元は実行開始時のHEAD
- `<repo>` はワークフローの定義ファイルが属するワークスペースフォルダに固定する。マルチルートでも `currentWorkspaceFolder()`（アクティブエディタ基準で揺れる）は使わない
- `runId` はUUID。`taskId` は §16.2 の検証で字種を絞ってある
- 実行後は既定で残す（`cleanup: keep`）。マージは合流タスクのpromptで指示するか、人が行う
- `cleanup: remove` を指定した場合のみ、`done` になったタスクのworktreeを撤去する。`failed` のものは残す
- 撤去は `git worktree remove`。ディレクトリを直接消さない。未コミットの変更があるworktreeは撤去せず警告する

#### 実装上の注意

- gitの呼び出しはシェルを経由しない（`execFile` にargv配列を渡す）。`id` の字種は検証済みだが、シェル解釈を挟まないこと自体を守る（§8「引数インジェクション」と同じ方針）
- **worktreeの作成は直列化する。** 同時に依存が解けた複数タスクが同時に `git worktree add` を叩くと、同じリポジトリの `index.lock` で競合する。タスクの並列実行とは別に、worktree操作だけは1本のキューに通す
- 同名のブランチが既にある場合はエラーにする（既存の作業を踏まない）
- worktree作成に失敗したタスクは開始しない（中途半端なディレクトリで走らせない）
- `.gitignore` に `.agents/worktrees/` が無ければ追記を促す（勝手には書き換えない）

#### gitリポジトリでない場合

worktreeを作れないため、次のように落とす。

1. ワークスペースがgitの作業ツリーでないと判定したら、そのタスクを `shared`（ワークスペース直下）へフォールバックする
2. 「並列タスクが同じディレクトリで走るためファイル衝突しうる」旨を、ログとワークフローViewの両方に警告として出す
3. `{{T.branch}}` は空文字になる。マージ前提のpromptを書いていると噛み合わないため、警告文でそれも示す

フォールバックを望まない場合のために `isolation: worktree-strict` を用意し、こちらはgit外なら実行を開始せずエラーにする。

### 16.7 無人実行と停止条件

`autoApprove: true` のとき、承認要求は拡張機能が自動で許可する。ただし**危険と判定した要求だけは自動で通さず、そのタスクを止めて人へ回す**。

#### 一次防御はサンドボックス、パターン照合は補助

先に位置付けを決めておく。**この判定は防御の主軸ではない。**

コマンドは文字列として渡ってくるだけで、シェルの構文木は得られない。`rm -rf` を止めても `rm${IFS}-rf`、`rm -fr`、`X=rm; $X -rf`、`find . -delete`、`printf '...' > /tmp/x.sh && bash /tmp/x.sh`、`echo <base64> | base64 -d | sh` はいずれも同じ結果になる。パターン照合でこれを塞ぎ切ることはできないし、塞げるふりをしてはいけない。

したがって次の二段構えにする。

1. **一次防御はサンドボックス**。`sandbox` は既定で有効のまま（`workspace-write`）にし、YAMLから緩められないようにする（§16.16）。ファイルシステムの境界はここで技術的に強制する
2. **パターン照合は補助的な検知**。分かりやすい危険が来たときに先回りして人へ回すためのもの。取りこぼす前提で置く

#### 判定の流れ

- 承認要求は今まで通り受け取る（Codexは `approvalPolicy` を `never` にせず `on-request` のままにする。要求が来なければ判定もできないため）
- 判定関数（`escalation.ts`）には、表示用に整形済みの `PendingApproval` ではなく**生の要求パラメータ**（`command` / `cwd` / 変更対象のパス）と、そのタスクの作業ディレクトリ・worktreeルートを渡す。既存の `describeApproval`（`src/appserver/approvals.ts`）は表示用に文字列を結合してしまうため、判定の入力には使わない
- `auto` なら即座に許可を返す。`ask` ならタスクを `waitingApproval` にして、通知とワークフローViewで知らせる。人が決めるまでそのタスクは進まない（他のタスクは走り続ける）
- `auto` で通したものも含め、判定の結果と理由をログとViewに残す

> 実装前に確認すること: Codex app-server / Claude Code control protocol の `command` パラメータが文字列か配列か。既存の `approvals.ts` は `typeof v === 'string'` でなければ空文字にするため、配列で来ているなら判定入力が常に空になり、**全て `auto` に倒れる**。配列なら結合してから判定する。

#### 既定で `ask` に倒す対象

- **シェルメタ文字を含む、または複数のコマンドが連結されている**（`;` `|` `&` `$` `` ` `` `(` `)` `<` `>` 改行）。単純な1コマンドでなくなった時点で、判定の当てが外れたとみなす
- 削除・巻き戻し: 再帰的な強制削除、追跡外ファイルの一括削除、作業ツリーの強制巻き戻し、ブランチやタグの削除、テーブルの削除や全消去、`find` の `-delete` / `-exec`
- 外部へ出る操作: リモートへのpush（`--force` / `-f` / `--force-with-lease` を含む全て）、デプロイ、パッケージの公開、`curl` / `wget` / `nc` など外部へ到達しうるコマンド
- デコード・間接実行: `base64` / `xxd` などのデコード、スクリプトファイルを作ってから実行する形
- 作業ディレクトリの外への書き込み（後述）
- `.git` 配下への書き込み（後述）
- 権限そのものの変更（`permissions` 種別の要求）
- 判定に失敗した・種別が未知の要求

#### パスの判定

「作業ディレクトリの外」を字面の前方一致で判定してはいけない。

- 対象パスと境界パスの**両方を実行直前に実パスへ解決**し、区切り文字の境界まで含めて比較する（`/repo` が `/repo-evil/x` に一致する類のバグを避ける）
- シンボリックリンクの**作成そのもの**も対象にする。リンク先が境界の外なら `ask`。リポジトリに最初から入っているリンク経由の書き込みも、実パス解決で境界の外に出る
- **`.git` 配下への書き込みは常に `ask`**。worktreeの `.git` は実体がファイルで、hooksなどの実データは親リポジトリの共有領域（`git rev-parse --git-common-dir`）にある。字面ではworktree内に見えるため、この規則を別途置かないと素通りする。`.git/hooks` に何か置かれると、以降そのリポジトリの全操作（他のタスクも、人の操作も）で任意コードが走る

#### `escalate` と `allow`

`escalate` でパターンを足し、`allow` で既定の停止条件から外せる。ただし `allow` には次の制限を置く。

- `.git` 配下への書き込みと `permissions` 種別の要求は、`allow` でも解除できない
- `allow` を含むタスクがあるワークフローは、実行開始時に「既定の危険操作チェックを解除しているタスクがある」旨を明示して確認を取る。ワークフローViewの警告欄にも、どのタスクがどのパターンを解除しているかを常時出す
- `allow` はタスク単位に閉じる。他のタスクの判定には影響しない

`allow` が「そのタスクに関する限りの全許可」になりうることは避けられない（YAMLを書いた人がそう書いたのだから）。防ぐのではなく、**見えるようにする**のがここでの方針である。

#### 人が見ていないときの扱い

`ask` は人の応答を待つ。無人実行との噛み合わせを次のように決める。

- 応答が得られないまま時間が経っても、勝手に許可へ倒さない。そのタスクは `waitingApproval` のまま止まる
- 確認ダイアログ（サンドボックス無効化の組み合わせなど）への応答が得られない場合は**拒否**として扱い、そのタスクを開始しない
- 該当する組み合わせを持つタスクが複数あっても、確認はワークフロー全体で1回にまとめる。タスクごとにモーダルが積み上がると、無人実行の入口で操作が詰まる

### 16.8 ワークフローView

専用のWebviewパネル（`workflow.run`）で、定義と進行を1枚で見る。並列で走っている複数のセッションを追うのが目的なので、**この画面だけ見ていれば全体の状況が分かる**ことを要件にする。

#### 全体の進捗

画面の最上段に、状態ごとの件数と全体の進み具合を出す。

```
認証機能の追加   4タスク中 1完了 / 2実行中 / 1待機      経過 12:43   [停止]
[####------------] 25%
```

- 状態の内訳: `done` / `running` / `waitingApproval` / `pending` / `failed` / `skipped`
- 承認待ちと失敗が1件でもあれば、その旨を最上段で目立たせる（並列で走っていると個々のノードを見落とすため）

#### 依存グラフ

タスクをノード、`dependsOn` をエッジとした有向グラフを描く。外部ライブラリは使わず、Webview内でSVGを組み立てる（CSPを緩めない・バンドルを太らせないため）。

- レイアウト: 依存の深さで段（rank）を決め、同じ段のタスクを横に並べる。段が「同時に走りうる集合」に対応するので、`T1 → (T2 || T3) → T4` がそのまま縦3段の図になる
- ノードの見た目で状態を示す。色に加えて記号も添える（色だけに頼らない）

| 状態              | 見た目                                               |
| ----------------- | ---------------------------------------------------- |
| `pending`         | 灰色の枠線のみ・記号なし                             |
| `running`         | 強調色の枠＋進行を示すアニメーション、`n回目` を併記 |
| `waitingApproval` | 警告色＋一時停止の記号                               |
| `done`            | 塗りつぶし＋チェック                                 |
| `failed`          | エラー色＋バツ、理由（回数切れ・ターン失敗など）     |
| `skipped`         | 破線の枠＋斜線                                       |

- ノードには id・状態・経過時間・送信回数・**直近の応答の1行要約**を出す。要約があるだけで「今なにをしているか」がグラフ上で分かる
- エッジは依存元→依存先。依存元が未完了のものは薄く描く
- VSCodeのテーマ色（`--vscode-*` 変数）を使い、ライト/ダークの双方で読めるようにする

#### タスク一覧

グラフの下に表形式でも並べる。グラフは全体像、一覧は詳細という分担にする。列は id・状態・provider・作業ディレクトリ（worktreeのブランチ）・経過・送信回数・直近の応答。

#### 会話を見る・中断する

- ノードまたは一覧の行を押すと、そのタスクのチャットタブへ移動する。会話の中身は通常のチャット画面そのものなので、途中経過も承認カードも同じ見た目で読める
- タスクを開始したとき、チャットタブは**背面で開く**（`preserveFocus`）。フォーカスは奪わないが、いつでも切り替えて経過を追える
- **タブを閉じてもタスクは止まらない**。閉じた後にノードを押せば同じセッションのタブが開き直り、それまでの会話が全て復元される。そのために、タスク実行中のセッション（`ChatSession` / `ClaudeStreamSession`）の寿命をパネルから切り離す（§16.10）
- ノードから直接できる操作
  - `中断`: 進行中のターンだけ止める（`turn/interrupt` 相当）。タスクは止まらず、次の指示から続く
  - `タスク停止`: そのタスクのループを止め、`failed`（手動）にする
  - `再実行`: `failed` / `skipped` のタスクを、依存が満たされていればもう1度走らせる
  - `承認`: `waitingApproval` のとき、要求の内容をその場に出して許可・拒否を決める

#### そのほか

- 操作: 実行、全体の停止、worktreeの撤去、定義ファイルを開く
- 警告欄: git外フォールバック、サンドボックス無効の指定、`allow` による危険判定の解除、回数切れなど
- 更新はタスクの状態が変わったときと、実行中の経過時間の表示のため1秒ごと（送るのは差分のみ）
- **画面に出す動的な文字列（応答の要約・タスクid・ブランチ名・ファイルパス）は、必ずテキストノードとして挿入する。** これらはエージェントの出力やYAMLに由来し、内容を信用できない。HTML/SVGの文字列結合で組み立てるとWebview内でスクリプトが走り、承認操作の偽装に繋がる。CSPは既存のチャット画面と同じく nonce 付きの単一スクリプトのみとし、`unsafe-inline` は使わない
- 入力欄のスラッシュコマンド候補はメインワークスペース基準のままで、worktree固有のカスタムコマンドには追従しない（`loadCommands` が `workspaceFolderPaths()` を見ているため。CLI自身が `cwd` から読む `AGENTS.md` などの解決には影響しない）

### 16.9 定義ファイルの生成

ゴールの文を渡すと、タスク分解済みのYAMLを作る。

1. コマンド（`workflow.plan`）でゴールを入力する
2. 分解用のセッションを1つ作り、スキーマの説明と現在のワークスペースの情報を添えてゴールを渡す。返答はYAMLのみとするよう指示する
3. 受け取ったYAMLを§16.2の検証にかける。コードフェンスで囲まれて返ることが多いので、剥がしてからパーサへ渡す。通らなければ、検証エラーを添えてもう1度だけ投げ直す
4. `agent.workflows.dir` へ保存し、エディタで開く。ワークフローViewを同時に開き、依存関係の図を見ながら人が直す
5. 人が直したら「実行」で走り出す

生成に使うプロバイダは `defaults.provider` と同じ既定（設定で変更可）。

#### 分解セッションの制限

分解セッションはワークスペースの中身を読む。つまり**リポジトリに仕込まれた文が指示として効きうる**。「タスクを実行しないでください」とプロンプトで頼むだけでは足りない。

- 分解セッションは `sandbox: read-only` 相当で起動し、承認要求は全て拒否する。プロンプトの指示ではなく起動時の設定で縛る
- 生成されたYAMLに `autoApprove: true` / 非空の `allow` / `sandbox` や `approvalMode` の緩和指定が含まれる場合は、通常の検証エラーとは別に強調して知らせる。エディタでは該当行へ移動し、ワークフローViewの警告欄にも「このワークフローは既定の安全設定を上書きしています」と出す。多数のタスクに紛れた1件の `allow` を人が見落とすのを防ぐ
- 生成したまま自動で実行することはしない

### 16.10 モジュール構成

```
src/
  orchestrator/
    workflow.ts     YAMLの読み込み・スキーマ検証・循環検出・テンプレート展開（純粋）
    scheduler.ts    完了状態から次に開始する集合を決める（純粋）
    escalation.ts   承認要求を auto / ask に振り分ける（純粋）
    runState.ts     実行状態の保持と遷移（純粋）
    worktree.ts     worktreeの作成・撤去、git作業ツリーかの判定
    runner.ts       セッションの生成・指示の送信・完了検知（VSCode層）
    planner.ts      ゴール文からYAMLを生成する
  view/
    workflowView.ts ワークフローViewのWebview
```

チャット画面側には、オーケストレータが使う口を1つ足す。CodexとClaude Codeで同じ形にし、`runner.ts` はプロバイダを見ない。

```ts
interface TaskSessionHost {
  /** タスク用のセッションを開く。cwdとタスク単位の設定を渡せる。 */
  openTaskSession(input: TaskSessionInput): Promise<TaskSession>;
}

interface TaskSession {
  readonly sessionId: string;
  /** 終了条件つきの繰り返しを始める（LoopControllerをそのまま使う）。 */
  runLoop(plan: LoopPlan): void;
  /** 停止理由が決まったら1度だけ呼ばれる。 */
  onFinished(listener: (reason: LoopStopReason, state: ChatState) => void): void;
  /** 状態が変わるたびに呼ばれる。Viewの進捗表示と応答の1行要約に使う。 */
  onStateChanged(listener: (state: ChatState) => void): void;
  /** 承認要求の判定を差し込む。返り値がそのまま応答になる。 */
  setApprovalHandler(handler: (approval: PendingApproval) => Promise<ApprovalDecision>): void;
  /**
   * 進行中のターンだけ止める。タスクのループは続く。
   *
   * 画面の「中断」ボタンは `loop.noteUserAction()` を呼んでループごと止めるため、
   * その経路は使えない。`session.interrupt()` だけを呼ぶ別の口として持つ。
   */
  interrupt(): Promise<void>;
  /** タブを前面に出す。閉じられていれば作り直し、それまでの会話を復元する。 */
  reveal(): void;
  /** タブを背面で用意する。開始時に呼ぶ。 */
  open(options: { preserveFocus: boolean }): void;
  dispose(): void;
}
```

#### 既存のチャット画面に対する変更

見た目の追加より、既存の作りに入っている前提を外す作業のほうが大きい。実装前に次を洗い出してある。既存の呼び出しは全て既定値でそのまま動くようにする。

**1. cwdとタスク単位の設定を受け取る**

`ChatViewManager.openNew()` はワークスペース直下に固定されている。cwdを引数に取れるようにする。

**2. パネルを背面で作れるようにする**

`createWebviewPanel` に `preserveFocus` を渡す。

**3. 開始待ちの管理を複数件に対応させる**

現状 `pending` は「`thread/start` の応答を待っている画面」を**1件だけ**保持し、`findByThreadId` は threadId で引けない通知やサーバー要求を無条件に `pending` へ流す。並列で2つ以上のCodexタスクを同時に開始すると、後から開始した画面が `pending` を上書きし、先に開始した画面宛の通知・**承認要求**が別タスクへ誤配送される。承認の誤配送は「別タスクの操作を勝手に許可する」事故になる。

開始待ちを複数持てる形（開始要求ごとのキーで引ける表）に変える。Claude側は `randomSessionId()` で起動前にidが決まり、即座に `panels` へ入るためこの問題は無い。

**4. セッションの寿命をパネルから切り離す**

現状 `panel.onDidDispose` は `session.dispose()` に加えて `panels` からエントリを削除する。`routeNotification` / `routeServerRequest` は `panels` を見て宛先を引くため、**エントリを消すと通知が届かなくなり、`LoopController.observe()` も呼ばれなくなる**。タブを閉じた瞬間にタスクの進行検知が止まり、「閉じてもタスクは走り続ける」が成立しない。

`ChatPanel` の `panel` を「今そのタブがあるか」を表す省略可能な値にし、エントリ自体は `panels` に残す。`reveal()` でパネルを作り直し、`ChatState` から会話を描き直す。承認の保留も持ち越す（閉じた時点で拒否しない）。

この切り離しは、閉じ忘れたセッションが残り続ける危険と裏表なので、範囲をタスク実行中のセッションだけに限る。人が手で開いた画面はこれまで通りタブを閉じたら終わる。タスクが `done` / `failed` になった時点でセッションを解放する。

**5. タスク単位の設定を画面ごとに持つ**

Codexは送信のたびに `readConfig().codex`（VSCodeのグローバル設定）を読み直して `model` / `effort` / `approvalPolicy` を組み立てている。このままではタスクごとの上書きができないうえ、実行中に人が別タブの設定を変えると、走っている全タスクの次のターンに効いてしまう。

タスク用の設定を `ChatPanel` に持たせ、そのエントリからの送信は全てそちらを使う。`sandbox` は `thread/start` 時の1回きりなので、`openTaskSession` に渡せば済む。

**6. 承認要求のルーティングに自動判定を差し込む**

現状の承認は「要求を受け取る → 承認カードを出す → 人が決める」で固定されている。`setApprovalHandler` を効かせるには、`routeServerRequest`（Codex）と control 要求の処理（Claude）に「タスク実行中のセッションなら先に自動判定へ回す」分岐が要る。

**7. 汎用のパネル復元をタスク管理下のセッションでは使わない**

`registerWebviewPanelSerializer` の `restorePanel` はcwdを保持しておらず、常にワークスペース直下を充てて `thread/resume` する。リロード時にこれが先に走ると、worktreeで動いていたタスクのセッションがワークスペース直下のcwdで `panels` に登録され、後からオーケストレータが正しいcwdで開き直そうとしても `openThread` が既存エントリを `reveal()` して終わる。

タスク管理下のスレッドは汎用復元の対象から外し、オーケストレータが `workspaceState` の記録から明示的に扱う（§16.11）。

> なお `claude.chat` には `registerWebviewPanelSerializer` が登録されておらず、Claude Code側のタブはリロードで復元されない（§14.6 の表とは食い違っている既存の不整合）。§16.11 はこれを前提に組む。

### 16.11 永続化と復元

- キーは `codex.workflow.runs`。値はrunの配列で、各runが `runId`（UUID）・定義ファイルのパス・開始時刻・タスクごとの `{ 状態, sessionId, cwd, ブランチ名, 送信回数, 失敗理由 }` を持つ
- **応答本文は保存しない。** `{{T.result}}` の元になるテキストは機微を含みうるため、暗号化されない `workspaceState` に平文で置かない。必要になったらセッションの `ChatState` から読み直す（リロードで失われた場合は、そのタスクは再実行の対象になる）
- ウィンドウのリロードで走行中だったタスクは、いったん `failed`（理由: 中断）として扱う。人がViewから再実行できる
- タスク管理下のセッションは、汎用のパネル復元（§16.10 の7）に任せない
- 走り終えたrunの記録も残し、Viewから開き直せるようにする（最新10件。それより古いものは消す。手動で全消去する手段も用意する）

### 16.12 作業記録との関係

タスクから送る指示も、通常の発言と同じく作業記録（§15）へ書く。ループからの送信を抑止していないのと同じ理由で、実際に送っている以上は記録する。ワークフロー由来であることは記録のフィールドを増やさず、cwdとsession_idで辿れる範囲に留める（収集側の規約を変えないため）。

ただし `{{T1.result}}` を展開したプロンプトは、前のタスクの応答をそのまま含む。§15.3 の「1回200文字までの1行要約」という制限はそのまま効くが、**前タスクの応答が日報バッファという別の保存先・別の読み手へ流れる経路**になる点は §15 の想定と異なる。展開部分は記録から落とし、展開前の文面（`{{T1.result}}` を含んだまま）を記録する。

### 16.13 制約

- タスクの粒度と分割の妥当性は人が担保する。並列タスクが同じ設計判断を別々に下す事故は、worktreeでは防げない
- 回数切れ（`maxReached`）は「終わっていないのに止まった」状態であり、成功として扱わない
- Claude Codeは並列数だけプロセスが立つ。既定の `maxParallel: 3` はここを見た値
- 並列数を上げるとアカウントのレート制限の消費も早まる。Codexは1つの接続で複数スレッドが同時にターンを回すため、プロセス数が増えないぶん見落としやすい
- 危険判定（§16.7）は取りこぼす。サンドボックスと併せて初めて意味を持つ
- `allow` を書いたタスクは、そのタスクに関する限り危険判定が効かなくなる。防げないので、見えるようにする方針を採っている（§16.7）
- 分解の生成（§16.9）はあくまで下書き。人のレビューを前提とし、生成したまま自動で実行することはしない

### 16.14 実装順序（TDD）

純粋ロジックを先に固め、VSCodeに触る層を後に回す。

1. `workflow.ts`: YAMLの読み込みと検証、循環検出、テンプレート展開（展開は開始直前に呼ぶ純粋関数として分ける）
2. `scheduler.ts`: 依存と `maxParallel` から次に開始する集合を出す
3. `runState.ts`: 状態遷移（失敗時の後続 `skipped` 化、再試行、`allow` がタスクを越えないこと）
4. `escalation.ts`: 危険判定。入力は生の要求パラメータとタスクの境界パス
5. `worktree.ts`: 作成・撤去・git判定（gitの呼び出しはポート越しに差し替え可能にし、シェルを経由しない）
6. `runner.ts`: セッションの生成と完了検知
7. `workflowView.ts`: 表示と操作
8. `planner.ts`: ゴール文からの生成

YAMLの解析には `yaml` パッケージを使う（現状ランタイム依存は無いが、esbuildのバンドルに含める）。

`runner.ts` に着手する前に、§16.10 の「既存のチャット画面に対する変更」7点のうち3〜7（開始待ちの複数化・寿命の切り離し・タスク単位の設定・承認の差し込み・パネル復元の除外）を先に済ませる。これらは既存の挙動を変えないまま入れられるので、オーケストレータ本体とは別に検証できる。

### 16.15 完了条件

見た目で判断する項目は避け、記録や状態から確かめられる形にする。

| 確認すること        | 確かめ方                                                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T2とT3が並列で走る  | 2つのタスクの `running` の区間（開始・終了時刻）が重なっていることを、実行記録から確認する                                                                       |
| 依存グラフの段組み  | 段レイアウトの計算（依存の深さ→段）がユニットテストで、`T1 → (T2 \|\| T3) → T4` を3段に割り当てる                                                                |
| 会話の復元          | タブを閉じてから開き直したあとの `ChatState.items` が、閉じる直前と一致する                                                                                      |
| 中断                | `中断` の後もタスクの状態が `running` のままで、次の指示が送られ、送信回数が増える                                                                               |
| タスク停止          | `タスク停止` でそのタスクだけが `failed` になり、他のタスクの状態が変わらない                                                                                    |
| worktreeの分離      | T2とT3の作業ディレクトリが異なり、どちらのブランチも実行開始時のHEADから分岐している                                                                             |
| git外フォールバック | gitでないフォルダで `worktree` 指定のタスクが `shared` に落ち、警告が記録される。`worktree-strict` では実行が始まらない                                          |
| 危険判定            | 既定で `ask` にする対象のコマンドが `ask`、通常のテスト実行が `auto` と判定される（ユニットテスト）。実機では該当タスクが `waitingApproval` で止まり、許可で続く |
| `.git` への書き込み | `allow` を指定しても `.git` 配下への書き込みが `ask` のままになる                                                                                                |
| 循環の検出          | 循環を含む定義が実行前にエラーになり、循環に含まれるidが全て示される                                                                                             |
| 設定のクランプ      | 拡張機能の設定より緩い `sandbox` / `approvalMode` をYAMLに書いても、緩まずに警告が出る（§16.16）                                                                 |
| `cwd` の境界        | ワークスペース外を指す `cwd` が実行前にエラーになる                                                                                                              |
| YAMLの生成          | ゴール文から生成したYAMLが §16.2 の検証を通り、`autoApprove` や `allow` を含む場合は警告として提示される                                                         |

### 16.16 設定の信頼境界

§8 は「ワークスペース設定による任意コマンド実行」を防ぐため、`executablePath` / `additionalArgs` / `codexHome` / `sandbox` / `approvalMode` / `permissionMode` を `machine` スコープに固定している。リポジトリの `.vscode/settings.json` からは差し替えられない、というのがこの保証である。

**ワークフローのYAMLはワークスペース内のファイルなので、同じ脅威にさらされる。** cloneしただけのリポジトリに `.agents/workflows/setup.yaml` が入っていて、`sandbox: danger-full-access` / `approvalMode: never` / `autoApprove: true` と書いてあったら、設定パネルを一度も触らないまま §8 で塞いだ穴が開く。しかも設定UIより見つかりにくい。

そこで、YAMLから設定を動かせる方向を制限する。

| フィールド                                    | YAMLからできること                                                                                                                                                                     |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox` `approvalMode` `permissionMode`     | 拡張機能の設定より**安全な方向へ絞ることだけ**できる。緩める指定は無視し、警告を出す（例: 拡張機能側が `on-request` のとき、YAMLの `never` は `on-request` に留める）                  |
| `permissionMode: dontAsk`（Claude）           | 「事前承認したツールだけ通す」という性質上、他のモードと安全性を一次元の順序で比較できない。安全側にも危険側にも判定できないため、YAMLの指定に関わらず拡張機能側の値をそのまま採用する |
| `autoApprove`                                 | `true` にできるのは、machineスコープの設定 `agent.workflows.allowAutoApprove`（既定 `false`）が有効なときだけ。無効なら全ての承認を人へ回して走る                                      |
| `escalate`                                    | 常に有効。安全側にしか働かない                                                                                                                                                         |
| `allow`                                       | 有効。ただし `.git` 配下と `permissions` 種別は解除できない。使用時は実行前の確認とViewへの常時表示（§16.7）                                                                           |
| `cwd`                                         | ワークスペースフォルダの実パス配下に限る。外れていれば実行前エラー                                                                                                                     |
| `executablePath` `additionalArgs` `codexHome` | **YAMLからは指定できない**。フィールド自体を設けない                                                                                                                                   |
| `model` `effort`                              | 自由に指定できる（これらは `machine-overridable` であり、実行経路や権限には関わらない）                                                                                                |

`cwd` を無検証で許すと、`sandbox: workspace-write` の「workspace」の基準そのものを付け替えられる（例: `cwd: ~/.ssh` にすればそこが書き込み可能な領域になる）。境界の検証はサンドボックスの意味を保つために要る。

この節の方針は「安全側へは動かせる、危険側へは動かせない」の一点に尽きる。ワークフローの定義は便利さのための入力であって、権限を決める場所ではない。
