# Codex Sessions (VSCode Extension)

CLIコーディングエージェント（Codex / Claude Code）のセッションを、VSCodeのファイルタブと同じ感覚でエディタタブとして扱う拡張機能。

- 1ボタンで新規セッションをエディタタブとして開く
- 過去セッションをサイドバーの履歴から選んで再開する（CodexとClaude Codeを1つの一覧で扱う）
- VSCode再起動後もタブの列・並び順ごと復元する
- 会話の途中から分岐して、別のタブで続きをやり直す（Codex）
- 実行したセッションを日報・週報システムへ流す

## 2つの画面

用途の異なる2方式を併存させている。どちらもエディタタブとして開く。

| | チャット画面 | TUIタブ |
| --- | --- | --- |
| 描画 | 拡張機能が自前で描画 | CLI本体のTUIが担当 |
| 設定の反映 | 次の発言から即座に（Codex） | 次のセッションから |
| 会話途中からの分岐 | 画面内のボタンで直接（Codex） | 履歴から会話ビューアを開く |
| 承認 | 画面内のカードで許可/拒否 | CLI本来のプロンプト |
| スラッシュコマンド | 使えない | `/review` `/compact` など全て使える |

日常的な対話はチャット画面、スラッシュコマンドが必要な場面やチャット画面が未対応の表示に当たった場合はTUIタブ、という使い分けを想定している。

## 対応CLI

| | Codex | Claude Code |
| --- | --- | --- |
| TUIタブ（新規 / 再開 / タブ復元） | ○ | ○ |
| チャット画面（承認・中断込み） | ○（app-server） | ○（stream-json） |
| fork（セッション全体） | ○ | ○（新しいidは追跡できない） |
| 会話の途中のターンから分岐 | ○ | ×（CLIに手段が無い） |
| archive / unarchive / delete | ○ | ×（CLIに手段が無い） |
| 使用量のステータスバー表示 | ○ | － |

Claude Codeには会話の要約名が無いため、一覧とタブ名は最初の指示から作る。

## 開発状況

**動作するが、実機での検証は途上。**

| 領域 | 状態 |
| --- | --- |
| 純粋ロジック層（引数組み立て・パーサ・一覧・紐付け・状態遷移） | 完了、テスト264件 |
| TUIタブ方式（起動・履歴・復元・fork/archive/delete） | 実装完了、Codexの紐付けを実機確認済み |
| Codex画面（対話・承認・分岐・タブ名） | 実装完了、実機未確認 |
| Claude Code画面（対話・承認・中断） | 実装完了、CLIの前提（`--session-id`・control protocol）のみ実機確認済み |
| 作業記録の日報連携 | 実装完了、収集スクリプトとの疎通を確認済み |

## 必要環境

- VSCode 1.90以降
- Node.js 20以降
- [Codex CLI](https://developers.openai.com/codex/) または [Claude Code](https://code.claude.com/docs/en/quickstart) がPATH上にあること

WSL Remoteなどリモート環境で開発している場合、CLIもその環境側に必要になる。この拡張機能は `extensionKind: ["workspace"]` として動作するため、UI側（Windows等）のCLIは参照しない。

## 使い方

| 操作 | 導線 |
| --- | --- |
| 新しい会話（チャット画面） | サイドバーの吹き出し / スパークルアイコン |
| 新しいセッション（TUIタブ） | サイドバーの `+`（Codex）/ スパークル（Claude Code） |
| 過去セッションを再開 | サイドバーの履歴をクリック |
| チャット画面で開く | 履歴の項目にホバー → 吹き出し / スパークルアイコン |
| 会話の途中から分岐 | Codex画面の各発言にある「ここから分岐」 |
| 履歴から会話を読んで分岐 | 履歴の項目にホバー → ブランチアイコン（Codexのみ） |
| セッション名の変更 | Codex画面がアクティブなときエディタ右上の鉛筆アイコン |
| モデル/effort/承認の切替 | サイドバーの設定パネル、またはCodex画面の入力欄下 |
| 使用量の確認 | ステータスバー（常時表示） |

## 設定

### Codex

| キー | 既定 | スコープ | 説明 |
| --- | --- | --- | --- |
| `codex.executablePath` | `codex` | machine | 実行ファイルのパス |
| `codex.codexHome` | `""` | machine | 空なら `CODEX_HOME` → `~/.codex` |
| `codex.additionalArgs` | `[]` | machine | 任意の追加引数 |
| `codex.sandbox` | `""` | machine | `read-only` / `workspace-write` / `danger-full-access` |
| `codex.approvalMode` | `""` | machine | `untrusted` / `on-request` / `never` |
| `codex.model` | `""` | machine-overridable | 空なら `-m` を渡さない |
| `codex.reasoningEffort` | `""` | machine-overridable | `model_reasoning_effort`。選択肢はモデルごとに異なる |
| `codex.profile` | `""` | machine-overridable | `-p` に渡すプロファイル名 |

### Claude Code

| キー | 既定 | スコープ | 説明 |
| --- | --- | --- | --- |
| `claude.executablePath` | `claude` | machine | 実行ファイルのパス |
| `claude.configDir` | `""` | machine | 空なら `CLAUDE_CONFIG_DIR` → `~/.claude` |
| `claude.additionalArgs` | `[]` | machine | 任意の追加引数 |
| `claude.permissionMode` | `""` | machine | `manual` / `auto` / `acceptEdits` / `plan` / `dontAsk` / `bypassPermissions` |
| `claude.model` | `""` | machine-overridable | エイリアス（`opus` 等）か正式名。空なら `--model` を渡さない |
| `claude.effort` | `""` | machine-overridable | `low` / `medium` / `high` / `xhigh` / `max` |

### 共通

| キー | 既定 | スコープ | 説明 |
| --- | --- | --- | --- |
| `codex.restore.enabled` | `true` | window | 再起動時の自動resume |
| `codex.restore.maxTabs` | `8` | window | 復元するタブ数の上限 |
| `codex.history.scope` | `workspace` | window | `workspace` / `all` |
| `codex.history.maxEntries` | `200` | window | 一覧構築の上限件数 |
| `agent.activityLog.enabled` | `true` | window | 実行したセッションを日報バッファへ記録する |
| `agent.activityLog.dir` | `""` | machine | 空なら `DAILY_BUFFER_DIR` → `~/workspace/dairy/.buffer` |

空文字は「そのフラグを渡さない」を意味し、CLI側の設定（`~/.codex/config.toml` / `~/.claude/settings.json`）に委譲する。設定パネルには委譲先の実際の値が `既定: gpt-5.6-terra` のように表示される。

### machineスコープについて

実行するバイナリと権限に影響する設定は `machine` スコープに固定しており、リポジトリの `.vscode/settings.json` からは変更できない。これがないと、リポジトリをクローンして開いただけで任意のバイナリが起動され、CLIのサンドボックスも無効化されうる。

## 日報・週報連携

この拡張機能から実行したセッションを、**セッションごとに1行**だけ日報の追記バッファへ書き出す。

- 出力先: `~/workspace/dairy/.buffer/<YYYY-MM-DD>.jsonl`
- 形式: `{"ts","source","cwd","text","ref"}`（`source` は `codex` / `claude-code`、`ref` は `vscode`）
- 本文は1行要約200文字まで。会話本文そのものは書き出さない
- `agent.activityLog.enabled` を `false` にすれば一切書かない

`~/.claude/scripts/daily/collect.py` がこのバッファを読み、日報・週報の作業ログに載る。拡張機能経由のClaude Codeセッションは transcript 走査とも重複しうるため、収集側で1件に畳んでいる（設計書 §15.4）。

## 開発

```bash
npm install
npm run check     # lint + typecheck + test
npm test          # テストのみ
npm run build     # dist/extension.js を生成
```

F5（Run Extension）で拡張機能ホストが起動する。`scripts/check.sh` はcommit前に全緑であることを必須とする。

### 構成

```
src/
  provider/   プロバイダ抽象（AgentProvider・registry）
  codex/      Codex CLIとの境界（引数組み立て・パーサ・カタログ・使用量）
  claude/     Claude Code CLIとの境界（引数組み立て・transcript・stream-json・承認）
  appserver/  app-serverとの接続・会話状態・承認（ChatStateは両CLI共通）
  session/    セッション一覧・監視・破壊操作
  terminal/   TUIタブの端末管理とセッションIDの紐付け
  activity/   日報バッファへの作業記録
  state/      タブ構成の永続化
  view/       TreeView・設定パネル・チャット画面・会話ビューア
  util/       NDJSONなど横断的な小物
test/unit/    上記のテスト（vscodeモジュールに非依存）
docs/design.md  設計書
```

`src/codex` `src/claude`（`provider.ts` を除く）・`src/session` `src/state` `src/activity` `src/util` `src/appserver/chatState` などのロジック層は `vscode` モジュールをimportしない。実VSCodeを起動せずにテストできる状態を保つための制約。

## ライセンス

MIT
