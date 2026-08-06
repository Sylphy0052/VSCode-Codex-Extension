# Codex Sessions (VSCode Extension)

Codexのセッションを、VSCodeのファイルタブと同じ感覚でエディタタブとして扱う拡張機能。

- 1ボタンで新規セッションをエディタタブとして開く
- 過去セッションをサイドバーの履歴から選んで再開する
- VSCode再起動後もタブの列・並び順ごと復元する
- 会話の途中から分岐して、別のタブで続きをやり直す

## 2つの画面

用途の異なる2方式を併存させている。どちらもエディタタブとして開く。

| | Codex画面 | TUIタブ |
| --- | --- | --- |
| 描画 | 拡張機能が自前で描画 | Codex本体のTUIが担当 |
| 設定の反映 | 次の発言から即座に | 次のセッションから |
| 会話途中からの分岐 | 画面内のボタンで直接 | 履歴から会話ビューアを開く |
| 承認 | 画面内のカードで許可/拒否 | Codex本来のプロンプト |
| スラッシュコマンド | 使えない | `/review` `/compact` など全て使える |

日常的な対話はCodex画面、スラッシュコマンドが必要な場面やCodex画面が未対応の表示に当たった場合はTUIタブ、という使い分けを想定している。

## 開発状況

**動作するが、実機での検証は途上。**

| 領域 | 状態 |
| --- | --- |
| 純粋ロジック層（引数組み立て・パーサ・一覧・紐付け・状態遷移） | 完了、テスト181件 |
| TUIタブ方式（起動・履歴・復元・fork/archive/delete） | 実装完了、セッション紐付けを実機確認済み |
| Codex画面（対話・承認・分岐・タブ名） | 実装完了、実機未確認 |

## 必要環境

- VSCode 1.90以降
- Node.js 20以降
- [Codex CLI](https://developers.openai.com/codex/) がPATH上にあること（`codex --version` で確認）

WSL Remoteなどリモート環境で開発している場合、Codex CLIもその環境側に必要になる。この拡張機能は `extensionKind: ["workspace"]` として動作するため、UI側（Windows等）のCodexは参照しない。

## 使い方

| 操作 | 導線 |
| --- | --- |
| 新しい会話（Codex画面） | サイドバーの `+`、またはエディタ右上の吹き出しアイコン |
| 新しいセッション（TUIタブ） | サイドバーの `+`、またはエディタ右上の `…` メニュー |
| 過去セッションを再開 | サイドバーの履歴をクリック |
| 会話の途中から分岐 | Codex画面の各発言にある「ここから分岐」 |
| 履歴から会話を読んで分岐 | 履歴の項目にホバー → ブランチアイコン |
| セッション名の変更 | Codex画面がアクティブなときエディタ右上の鉛筆アイコン |
| モデル/effort/承認の切替 | サイドバーの設定パネル、またはCodex画面の入力欄下 |
| 使用量の確認 | ステータスバー（常時表示） |

セッション名は会話内容からCodexが自動で付ける。変更するとCodex側に永続化されるため、履歴一覧にも反映される。

## 設定

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
| `codex.restore.enabled` | `true` | window | 再起動時の自動resume |
| `codex.restore.maxTabs` | `8` | window | 復元するタブ数の上限 |
| `codex.history.scope` | `workspace` | window | `workspace` / `all` |
| `codex.history.maxEntries` | `200` | window | 一覧構築の上限件数 |

空文字は「そのフラグを渡さない」を意味し、Codex側の `~/.codex/config.toml` に委譲する。設定パネルには委譲先の実際の値が `既定: gpt-5.6-terra` のように表示される。

### machineスコープについて

実行するバイナリと権限に影響する設定は `machine` スコープに固定しており、リポジトリの `.vscode/settings.json` からは変更できない。これがないと、リポジトリをクローンして開いただけで任意のバイナリが起動され、Codexのサンドボックスも無効化されうる。

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
  codex/      Codex CLIとの境界（引数組み立て・パーサ・カタログ・使用量）
  session/    セッション一覧・監視・破壊操作
  terminal/   TUIタブの端末管理とセッションIDの紐付け
  appserver/  app-serverとの接続・会話状態・承認
  state/      タブ構成の永続化
  view/       TreeView・設定パネル・Codex画面・会話ビューア
test/unit/    上記のテスト（vscodeモジュールに非依存）
docs/design.md  設計書
```

`src/codex` `src/session` `src/state` `src/appserver/chatState` などのロジック層は `vscode` モジュールをimportしない。実VSCodeを起動せずにテストできる状態を保つための制約。

## ライセンス

MIT
