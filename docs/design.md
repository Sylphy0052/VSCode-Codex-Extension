# VSCode Codex Extension 設計書

Codexのセッションを、VSCodeのファイルタブと同じ感覚でエディタタブとして扱う拡張機能。

## 1. 目的とスコープ

### 目的

- 1ボタンで新規Codexセッションを新しいエディタタブとして開く
- 過去セッションを一覧から選んでresumeし、同じくタブで開く
- VSCode再起動後もタブ構成が復元される

### Phase 1のスコープ

| 含む | 含まない |
| --- | --- |
| 新規セッション（1ボタン、設定既定値で即起動） | エディタ選択範囲のCodexへの送信 |
| 新規セッション（Advanced: モデル/承認モード選択） | セッションの実行中/待機中ステータス表示 |
| 履歴TreeView（ワークスペース限定＋全件トグル） | Webviewによる独自チャットUI |
| resume / fork / archive / unarchive / delete | Codex Cloud連携 |
| タブ位置・並び順とセッションIDの記憶と再起動時の自動復元 | マルチルートワークスペースの高度な扱い（§11） |
| thread_nameへのタブ名追従 | |
| Codex未インストール/未ログイン時のガイド | |

## 2. 全体アーキテクチャ

描画はCodex TUIそのものに委ね、拡張機能は**セッションのライフサイクル管理**だけを担う。

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
    sessionBinder.ts        新規端末 ↔ session_id の事後紐付け（Clock注入）
    terminalRenamer.ts      thread_name追従リネーム（フォーカス非奪取）
  state/
    tabStateStore.ts        workspaceStateへの永続化と復元
  view/
    sessionTreeProvider.ts  TreeDataProvider
    sessionTreeItem.ts      表示整形（相対時刻など）
  util/
    clock.ts                Clockインタフェース（テストで差し替え可能）
  commands/                 各コマンドの登録
test/
  unit/                     純粋ロジック + sessionBinder のテスト
  integration/              @vscode/test-electron
```

## 4. データソース

### 4.1 `~/.codex/session_index.jsonl`

1行1セッション。一覧の骨格として使う。

```json
{"id":"019fd7a6-...","thread_name":"環境構築手順を確認","updated_at":"2026-08-06T15:17:53Z"}
```

**cwdを含まない**ため、ワークスペースでのフィルタには次のsession_metaが必要。

**収録規則（スパイクで確認済み）**: このindexは全セッションを含まない。`session_meta.thread_source == "user"` のセッションのみが載り、`thread_source: "subagent"` や `source: "exec"` の非対話セッションは載らない。本拡張機能が起動するのはユーザー起点の対話セッションなので一覧のソースとして妥当だが、「sessionsディレクトリのファイル数 ≠ index行数」である点を実装時に前提としてよい。

### 4.2 `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`

**1行目のみ**を読む。全文パースは不要。

```json
{"timestamp":"...","type":"session_meta","payload":{
  "session_id":"019fd7a6-...","cwd":"/home/…/novel-writer",
  "originator":"codex_vscode","source":"vscode","cli_version":"0.146.0-…"}}
```

利用フィールド: `session_id` / `cwd` / `timestamp` / `originator` / `source` / `thread_source`。

- ファイル名に `session_id` が含まれるため、**ファイルの存在自体がセッションの発生を示す**。これを紐付けの検知に使う（§9.1）。
- `originator` は環境変数 `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` で任意の値に上書きできる（検証済み）。
- アーカイブしたセッションは `~/.codex/archived_sessions/` へ**日付階層なしのフラット配置で移動**される。`unarchive` で元の `sessions/YYYY/MM/DD/` へ戻る。したがって走査対象は `sessions/**` と `archived_sessions/*` の2箇所であり、**どちらに存在するかがアーカイブ状態の判定そのものになる**。

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
  sessionId: string
  viewColumn: number
  order: number       // 同一グループ内のタブ位置
  cwd: string
}
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

| 条件 | 処理 |
| --- | --- |
| ユーザーがタブを閉じた（`exitStatus.reason === Shutdown` 等） | `TabStateStore` から該当エントリを削除。これを怠ると**閉じたセッションが次回起動で復活する** |
| `exitStatus.code !== 0` かつ起動から数秒以内 | 起動失敗とみなしエラー通知（実行ファイル不在・未ログイン・引数不正）。通知に「出力を表示」アクションを付ける |
| `exitStatus.code === 0` | 正常終了。状態から削除し、TreeViewを更新 |

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

VSCodeにはターミナル名を直接書き換えるAPIがなく、`workbench.action.terminal.renameWithArg` はアクティブターミナルに作用する。フォーカスを奪う副作用を避けるため、上記の「アクティブになるまで保留」戦略を採る。**このコマンドの引数仕様と挙動は実装初期に実機検証する**（§9-V2）。

## 6. コマンドとUI

| コマンドID | タイトル | 導線 |
| --- | --- | --- |
| `codex.newSession` | Codex: New Session | ビュータイトルの `+`、キーバインド、パレット |
| `codex.newSessionAdvanced` | Codex: New Session (Advanced…) | パレット |
| `codex.resumeSession` | Codex: Resume Session… | パレット（QuickPick） |
| `codex.resumeLast` | Codex: Resume Last Session | パレット |
| `codex.openSession` | （内部）ツリークリック | TreeItem.command |
| `codex.forkSession` | Codex: Fork Session | ツリー右クリック |
| `codex.archiveSession` | Codex: Archive Session | ツリー右クリック |
| `codex.unarchiveSession` | Codex: Unarchive Session | ツリー右クリック（アーカイブ表示時） |
| `codex.deleteSession` | Codex: Delete Session | ツリー右クリック（確認ダイアログ必須） |
| `codex.toggleScope` | Codex: Toggle All Workspaces | ビュータイトルのトグル |
| `codex.refreshSessions` | Codex: Refresh | ビュータイトル |

### TreeView

アクティビティバーに専用コンテナ `Codex` を置き、ビュー `codexSessions` を配置。

```
Codex
├ ● 環境構築手順を確認            3分前     ← ●=タブとして開いている
│ Set up environment from docs   2時間前
└ VSCode拡張の設計               昨日
```

- label = `thread_name`（未確定なら `(untitled)`）、description = 相対時刻、tooltip = id / cwd / 絶対時刻。
- 全件表示トグル時のみ description に cwd のベース名を併記する。
- 開いているセッションは `contextValue` を分け、アイコンで区別する。
- セッションが0件、または `codex` 未検出の場合は `viewsWelcome` で導線を出す（§5.7）。

### 破壊操作の実行仕様（スパイクで確認済み）

| 操作 | コマンド | 備考 |
| --- | --- | --- |
| archive | `codex archive <id>` | `~/.codex/archived_sessions/` へ移動。成功=0 / 失敗=1 |
| unarchive | `codex unarchive <id>` | 元の `sessions/YYYY/MM/DD/` へ戻る |
| delete | `codex delete --force <id>` | **`--force` 必須**。拡張機能はTTYを持たないため、これがないと「対話端末なしでは確認できない」として exit 1 で拒否される。ユーザーへの確認は拡張機能側のモーダルダイアログで行う |

いずれも失敗時は exit 1 とstderrのメッセージを返すため、終了コードで成否を判定しエラー通知に本文を載せる。

## 7. 設定項目

**スコープの原則**: 実行経路（どのバイナリをどの引数で起動するか）と権限（sandbox / 承認）に影響する設定は `machine` スコープとし、リポジトリの `.vscode/settings.json` から上書きできないようにする。これを怠ると、リポジトリをクローンして開いただけで任意コマンドが実行され、Codexのサンドボックスも無効化される。

| キー | 型 | 既定 | スコープ | 説明 |
| --- | --- | --- | --- | --- |
| `codex.executablePath` | string | `codex` | **machine** | 実行ファイルのパス |
| `codex.codexHome` | string | `""` | **machine** | 空なら `CODEX_HOME` → `~/.codex` |
| `codex.additionalArgs` | string[] | `[]` | **machine** | 任意の追加引数 |
| `codex.sandbox` | enum | `""` | **machine** | `read-only` / `workspace-write` / `danger-full-access` |
| `codex.approvalMode` | enum | `""` | **machine** | `untrusted` / `on-request` / `never` |
| `codex.model` | string | `""` | machine-overridable | 空なら `-m` を渡さずconfig.tomlに委譲 |
| `codex.profile` | string | `""` | machine-overridable | `-p` |
| `codex.restore.enabled` | boolean | `true` | window | 再起動時の自動resume |
| `codex.restore.maxTabs` | number | `8` | window | 復元上限 |
| `codex.history.scope` | enum | `workspace` | window | `workspace` / `all` |
| `codex.history.maxEntries` | number | `200` | window | 一覧構築の上限件数 |

- **空文字＝フラグを渡さない**を徹底し、Codex側 `config.toml` との二重管理を避ける。
- `danger-full-access` と `never` の組み合わせを選んだ場合のみ、初回に確認ダイアログを出す。
- `argvBuilder` は設定値をenumのホワイトリストで検証し、未知の値は無視してログに残す（`machine` スコープでも壊れた値で起動しないため）。

## 8. セキュリティ考慮

| 項目 | 対処 |
| --- | --- |
| ワークスペース設定による任意コマンド実行 | §7のスコープ設計。`executablePath` / `additionalArgs` / `codexHome` を `machine` に固定 |
| サンドボックス無効化の誘導 | `sandbox` / `approvalMode` も `machine`。危険な組み合わせは初回に確認ダイアログ |
| 引数インジェクション | `shellPath` / `shellArgs` 方式によりシェル解釈を経由しない（§5.2） |
| セッション本文の漏洩 | 拡張機能はロールアウトファイルの**1行目のみ**を読み、会話本文は読まない・保存しない・ログに出さない |
| 破壊操作 | `delete` は確認ダイアログ必須。`archive` は取り消し可能なため確認不要 |

## 9. リスクと検証項目

実装開始前に潰しておくべき未確定事項。各項目はPhase 1の最初のタスクとして実機検証する。

| ID | 内容 | 影響 | 緩和策 |
| --- | --- | --- | --- |
| V1 | 拡張機能作成ターミナルのリロード時挙動が `isTransient` で意図通り抑止されるか | 二重にタブが開く | 検証で否なら、復元時に既存ターミナルを走査して重複を除去する |
| V2 | `workbench.action.terminal.renameWithArg` の引数形式と対象 | タブ名追従が機能しない | 否ならPhase 1は固定名（`Codex: <folder> #n`）にフォールバックし、追従はPhase 2送り |
| ~~V3~~ | **解決済**: `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` が `session_meta.originator` に反映されることを確認 | — | §9.1 の確定方式へ置換。ヒューリスティックと直列化は不要になった |
| V4 | `session_index.jsonl` の追記が行単位でアトミックか（部分行読み込み） | パースエラー | 末尾の不完全行を捨てる。パース失敗行は個別にスキップしログのみ。※紐付けはindexに依存しなくなったため影響は表示のみ |
| V5 | セッション数が数千件規模になった時の一覧構築コスト | 起動が重い | `updated_at` 降順で上位N件（§7 `history.maxEntries`）のみsession_metaを解決する |
| ~~V6~~ | **解決済**: 成功=exit 0、失敗=exit 1（stderrにメッセージ）。`delete` は非対話端末では拒否され **`--force` が必須** | — | 拡張機能はTTYを持たないため `delete --force` を使う。確認は拡張機能側のダイアログで行う |
| V7 | **同一セッションの多重resume**（別ウィンドウ・CLIから同じidを開く） | 同一ロールアウトファイルへの並行書き込みで履歴破損の恐れ | S6スパイクで確認。防げないなら、開始時に警告を出す／`fork` を促す |
| ~~V8~~ | **解決済**: `-C` がプロセスcwdより優先される | — | `-C` を正とし常に明示的に渡す（§5.2） |
| V9 | index に載っているセッションを `archive` したとき index から消えるか | アーカイブ済みが一覧に残る | S6スパイクで確認。消えないなら `archived_sessions` の存在でフィルタする（§4.2の判定で代替可能） |

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

**残る異常系**: 15秒経ってもタグ付きファイルが現れない場合は起動失敗とみなし、そのタブを「復元対象外」として扱う（誤ったIDを記憶するより安全）。この状態はタブ名に `(未追跡)` を付けて可視化する。このタイムアウト処理のみ時刻に依存するため、`SessionBinder` は `util/clock.ts` の `Clock` を注入して構築し、unit testで以下を検証する。

- タグ一致で正しく紐付く／タグ不一致のファイルを無視する
- 複数タブを同時に開いた場合、それぞれが自分のタグのセッションに紐付く
- タイムアウト時に状態を保存せず、タブ名に `(未追跡)` が付く

**注意**: この環境変数は名前が示すとおりCodexの内部向けであり、将来のバージョンで挙動が変わりうる。`argvBuilder` 側でタグが機能しなかった場合に備え、**タイムアウト時は静かに劣化する**（クラッシュせず未追跡扱いにする）設計を守る。CIでこの前提を検証する統合テストを1本置き、Codexのバージョンアップ時に気づけるようにする。

## 10. 既知の制約

- **マルチルートワークスペース**: Phase 1は「アクティブエディタが属するフォルダ、なければ先頭フォルダ」を1つ選ぶだけ。フォルダ別のセッション分離はPhase 2。
- **復元は会話履歴ベース**: TUIのスクロールバックや画面状態は復元されない。
- **プロセスは各タブ独立**: 同一ウィンドウ内での同一セッションの二重オープンは防ぐが、ウィンドウを跨いだ排他は行わない（V7）。
- **Codex側の外部変更**: CLIやTUIから直接archive/deleteした場合、TreeViewはファイル監視で追従するが、開いているタブは残る。

## 11. 技術スタック

- TypeScript / Node 20 / esbuild（バンドル）
- eslint + prettier、`tsc --noEmit` で型チェック
- テスト
  - unit: `argvBuilder` / `sessionIndex` / `sessionMeta` / `sessionStore`のフィルタ / `tabStateStore`のシリアライズ / **`sessionBinder`（Clock注入、§9.1の異常系）**
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
