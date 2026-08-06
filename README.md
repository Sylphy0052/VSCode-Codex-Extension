# Codex Sessions (VSCode Extension)

Codexのセッションを、VSCodeのファイルタブと同じ感覚でエディタタブとして扱う拡張機能。

- 1ボタンで新規Codexセッションを新しいエディタタブとして開く
- 過去セッションをサイドバーの履歴から選んでresumeし、同じくタブで開く
- VSCode再起動後もタブの列・並び順ごと復元する

描画はCodexのTUIそのものに委ね、拡張機能はセッションのライフサイクル管理だけを担う。承認プロンプト・差分表示・スラッシュコマンドはCodex本来の挙動がそのまま使え、Codexのバージョンアップに追従する必要がない。

## 開発状況

**Phase 1実装中。まだ動作する拡張機能ではない。**

| 層 | 状態 |
| --- | --- |
| CLIスパイク（起動引数・セッション紐付け・破壊操作の仕様確認） | 完了 |
| 純粋ロジック層（引数組み立て・パーサ・一覧構築・紐付け） | 完了、テスト64件 |
| VSCode API依存層（ターミナル・TreeView・タブ復元） | 未着手 |

VSCode API依存層は、前提となる挙動（`isTransient` によるターミナル復元の抑止、ターミナル名の変更手段）の実機検証待ち。詳細は[設計書](docs/design.md)の §9 リスクと検証項目を参照。

## 必要環境

- VSCode 1.90以降
- Node.js 20以降
- [Codex CLI](https://developers.openai.com/codex/) がPATH上にあること（`codex --version` で確認）

WSL Remoteなど、リモート環境で開発している場合はCodex CLIもその環境側に必要になる。この拡張機能は `extensionKind: ["workspace"]` として動作するため、UI側（Windows等）のCodexは参照しない。

## 設定

| キー | 既定 | スコープ | 説明 |
| --- | --- | --- | --- |
| `codex.executablePath` | `codex` | machine | 実行ファイルのパス |
| `codex.codexHome` | `""` | machine | 空なら `CODEX_HOME` → `~/.codex` |
| `codex.additionalArgs` | `[]` | machine | 任意の追加引数 |
| `codex.sandbox` | `""` | machine | `read-only` / `workspace-write` / `danger-full-access` |
| `codex.approvalMode` | `""` | machine | `untrusted` / `on-request` / `never` |
| `codex.model` | `""` | machine-overridable | 空なら `-m` を渡さない |
| `codex.profile` | `""` | machine-overridable | `-p` に渡すプロファイル名 |
| `codex.restore.enabled` | `true` | window | 再起動時の自動resume |
| `codex.restore.maxTabs` | `8` | window | 復元するタブ数の上限 |
| `codex.history.scope` | `workspace` | window | `workspace` / `all` |
| `codex.history.maxEntries` | `200` | window | 一覧構築の上限件数 |

空文字は「そのフラグを渡さない」を意味し、Codex側の `~/.codex/config.toml` に委譲する。拡張機能側とCodex側で設定を二重管理しないための方針。

### machineスコープについて

実行するバイナリと権限に影響する設定は `machine` スコープに固定しており、リポジトリの `.vscode/settings.json` からは変更できない。これがないと、リポジトリをクローンして開いただけで任意のバイナリが起動され、Codexのサンドボックスも無効化されうる。

## 開発

```bash
npm install
npm run check     # lint + typecheck + test
npm test          # テストのみ
npm run build     # dist/extension.js を生成
```

`scripts/check.sh` はcommit前に全緑であることを必須とする。

### 構成

```
src/
  codex/      Codex CLIとの境界（引数組み立て・パーサ）
  session/    セッション一覧の構築とキャッシュ
  terminal/   端末とセッションIDの紐付け
  util/       時計など横断的な小物
test/unit/    上記のテスト（vscodeモジュールに非依存）
docs/design.md  設計書
```

`src/codex` `src/session` `src/terminal` `src/util` は `vscode` モジュールをimportしない。実VSCodeを起動せずにテストできる状態を保つための制約。

## ライセンス

MIT
