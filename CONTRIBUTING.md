# 開発ガイド

この拡張機能に手を入れるための情報をまとめる。使い方と設定は [README.md](README.md)、設計の背景・検証結果・未解決の論点は [docs/design.md](docs/design.md) にある。

## セットアップ

```bash
git clone https://github.com/Sylphy0052/VSCode-Codex-Extension.git
cd VSCode-Codex-Extension
npm install
npm run check     # lint + typecheck + test
```

必要なのは Node.js 20以降とVSCode 1.90以降。動作確認には Codex CLI か Claude Code のどちらかがPATH上にあるとよい（無くても大半のテストは通る）。

## npmスクリプト

| コマンド            | 内容                                            |
| ------------------- | ----------------------------------------------- |
| `npm run build`     | esbuildで `dist/extension.js` にバンドルする    |
| `npm run watch`     | sourcemap付きで監視ビルドする                   |
| `npm run typecheck` | `tsc --noEmit`                                  |
| `npm run lint`      | `eslint .`                                      |
| `npm run format`    | Prettierで整形する                              |
| `npm test`          | `vitest run`                                    |
| `npm run check`     | 上記のlint / typecheck / testをまとめて実行する |
| `npm run package`   | ビルドしてvsixを生成する                        |

`scripts/check.sh` はcommit前に全緑であることを必須とする。緑にするためにテストを弱めたりskipしたりしない。

## デバッグ実行

F5（`Run Extension`）で拡張機能ホストが起動する。`preLaunchTask` でビルドが走るため、事前の `npm run build` は不要。

- ログは出力チャネル `Agent Sessions`（コマンドパレットの `Agent: ログを表示`）に出る。起動した引数・無視した設定値・一覧構築の異常が記録される
- Webview（チャット画面・設定パネル）のDOMを見るには、拡張機能ホスト側で `Developer: Open Webview Developer Tools` を実行する
- 手を入れたあとは拡張機能ホストのウィンドウをリロードすれば反映される

## アーキテクチャ

```text
src/
  provider/   プロバイダ抽象（AgentProvider・ProviderRegistry）
  codex/      Codex CLIとの境界（引数組み立て・パーサ・カタログ・使用量）
  claude/     Claude Code CLIとの境界（引数組み立て・transcript・stream-json・承認）
  appserver/  app-serverとの接続・会話状態・承認（ChatStateは両CLI共通）
  session/    セッション一覧・監視・破壊操作
  terminal/   TUIタブの端末管理とセッションIDの紐付け
  activity/   日報バッファへの作業記録
  state/      タブ構成の永続化
  view/       TreeView・設定パネル・チャット画面・会話ビューア
              （Webviewのスクリプトとスタイルは *Script.ts / *Styles.ts に分け、
               構文と hidden の打ち消しをテストで確かめる）
  util/       NDJSONなど横断的な小物
test/unit/    上記のテスト（vscodeモジュールに非依存）
docs/design.md  設計書
```

### レイヤの制約（重要）

`src/codex` `src/claude`（どちらも `provider.ts` を除く）・`src/session` `src/state` `src/activity` `src/util` `src/appserver/chatState` などのロジック層は **`vscode` モジュールをimportしない**。実VSCodeを起動せずにテストできる状態を保つための制約で、ここを崩すとテストが書けなくなる。

ファイルシステムやプロセスなどの副作用は `src/session/ports.ts` のようなポート経由で受け取り、テストではフェイクを差す。

### プロバイダ抽象

CLI固有の事情（ファイル配置・引数・セッションIDの決まり方）は `AgentProvider`（`src/provider/types.ts`）の内側に閉じ込める。UI層・タブ復元・作業記録はこのインターフェースだけを見る。

新しいCLIに対応させる場合は次を用意して `ProviderRegistry` に足す。

1. `locate()` — 実行ファイルと設定ディレクトリの解決
2. `listSessions()` — セッション一覧の構築（純粋なパーサとして書き、I/Oはポート経由）
3. `buildLaunch()` — 引数・環境変数・起動前に決まるセッションid
4. `capabilities` — fork / forkFromTurn / archive / delete / rename の可否。UIのメニュー出し分けに使われる
5. `tabTitle()` — タブと一覧の表示名

セッションidを起動前に決められないCLI（Codexがそう）は `buildLaunch()` で `sessionId: undefined` を返し、起動タグによる事後照合に委ねる。詳細は設計書 §9.1。

## コーディング規約

- TypeScript strict。`tsconfig.json` では `noUncheckedIndexedAccess` `exactOptionalPropertyTypes` も有効
- ESLintは `no-console: error` と `eqeqeq` を追加している。ログは `src/log.ts` のLoggerを使う
- 整形はPrettier（printWidth 100 / シングルクォート / セミコロンあり / trailingComma all）
- 状態は書き換えず、新しい値を返す。会話状態（`ChatState`）の遷移は純粋関数として書き、Webview側は結果を描くだけにする
- 未知の入力で壊さない。未知のイベント種別・壊れたJSON行は、状態を変えずに読み飛ばすか素通しする（CLIのプロトコル変更に耐えるための方針）

## テスト

- フレームワークはVitest。`test/unit/**` に置き、対象モジュールと1対1で名前を合わせる（`src/codex/argvBuilder.ts` → `test/unit/argvBuilder.test.ts`）
- テスト名は振る舞いを日本語で書く。例: `新規セッションは -C だけを渡す（空設定はconfig.tomlへ委譲）`
- Arrange-Act-Assertで組み、異常系（壊れた行・欠損フィールド・未知のenum値）を必ず1件は入れる
- パーサと引数組み立ては純粋関数として切り出し、実CLIを起動せずにテストする

実VSCodeが要る領域（コマンド登録・TreeView・タブ復元・チャット画面の対話）は現状ユニットテストの対象外で、F5による手動確認に頼っている。手順とチェックリストは [docs/manual-test.md](docs/manual-test.md) にある。

## 変更を入れるときの流れ

1. 設計書（`docs/design.md`）の該当節を読む。CLIの挙動には実機検証の結果が根拠として書いてある
2. テストを先に書く（RED）
3. 実装して緑にする
4. `npm run check` を全緑にする
5. Conventional Commits の短い形式でcommitする（`feat:` `fix:` `refactor:` `docs:` `test:` `chore:` `perf:` `ci:`）
6. CLIの挙動や仕様判断が変わったら設計書も同じcommitで更新する

## パッケージング

```bash
npm run package
code --install-extension vscode-codex-extension-0.0.1.vsix
```

`.vscodeignore` で `src` `test` `docs` `scripts` `node_modules` を除いており、vsixにはバンドル済みの `dist/extension.js` とマニフェスト・README・LICENSE・アイコンだけが入る。

Marketplaceへ公開する場合は、`package.json` の `publisher` を実際のpublisher IDに合わせ、`private: true` を外す必要がある。

## 未検証の領域

実機での確認が済んでいない箇所は README の[開発状況](README.md#開発状況)に一覧がある。Codex画面とClaude Code画面の対話・承認まわりは実装済みだが実機未確認で、ここを触るときは [docs/manual-test.md](docs/manual-test.md) の該当ケースを実行し、結果を添えてほしい。
