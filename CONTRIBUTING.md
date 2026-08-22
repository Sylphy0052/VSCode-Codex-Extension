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

| コマンド                        | 内容                                                                |
| ------------------------------- | ------------------------------------------------------------------- |
| `npm run build`                 | esbuildで `dist/extension.js` にバンドルする                        |
| `npm run watch`                 | sourcemap付きで監視ビルドする                                       |
| `npm run typecheck`             | `tsc --noEmit`                                                      |
| `npm run lint`                  | `eslint .`                                                          |
| `npm run format`                | Prettierで整形する                                                  |
| `npm test`                      | `vitest run`（`test/unit/**`）                                      |
| `npm run test:integration`      | 実VSCode上の統合テスト（`test/integration/**`）。ディスプレイが要る |
| `npm run test:integration:xvfb` | 同上。ヘッドレスLinux/WSLでxvfb-run経由で実行する                   |
| `npm run check`                 | lint / typecheck / testをまとめて実行する（integrationは含まない）  |
| `npm run package`               | ビルドしてvsixを生成する                                            |

`scripts/check.sh` はcommit前に全緑であることを必須とする。緑にするためにテストを弱めたりskipしたりしない。`test:integration`は実VSCodeのダウンロード・起動が要り重いため`check.sh`には含めていない。必要なときに明示的に呼ぶ。

## CI

mainへのpushとPRのたびに、GitHub Actions（`.github/workflows/ci.yml`）で `npm run lint` / `npm run typecheck` / `npm test` が自動実行される。`scripts/check.sh` と同じ3つで、Node.js 20系で `npm ci` してから走る。

統合テスト（`npm run test:integration`）はCIで回らない。実VSCodeのダウンロードとxvfbが要るため対象外にしてある。実VSCodeが要る範囲は引き続き手元で確認する。

カバレッジもCIでは計測していない。計測の仕組み自体が未導入で、導入手順と閾値の決め方は `docs/repository-hygiene.md` にまとめてある。

現時点ではブランチ保護の必須チェック（required status checks）に設定していない。CIが赤くてもマージはブロックされない（可視化のみ）。

検証範囲の拡張と必須チェック化の判断は #386 で追跡している。

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
  activity/   日報バッファへの作業記録
  loop/       同じ指示を繰り返すループの制御
  view/       TreeView・設定パネル・チャット画面・会話ビューア
              （Webviewのスクリプトとスタイルは *Script.ts / *Styles.ts に分け、
               構文と hidden の打ち消しをテストで確かめる）
  util/       NDJSONなど横断的な小物
test/unit/        上記のテスト（vscodeモジュールに非依存、Vitest）
test/integration/ 実VSCode上の統合テスト（@vscode/test-electron、Mocha）
docs/design.md  設計書
```

### レイヤの制約（重要）

`src/codex` `src/claude` `src/session` `src/loop` `src/activity` `src/util` `src/provider` `src/appserver/chatState` などのロジック層は **`vscode` モジュールをimportしない**。実VSCodeを起動せずにテストできる状態を保つための制約で、ここを崩すとテストが書けなくなる。

例外は `provider.ts`（VSCodeの型を返す境界）と、ファイル監視の `sessionWatcher.ts` / `transcriptWatcher.ts`（`FileSystemWatcher` が要る）。新しくvscodeをimportしたくなったら、その処理がロジックなのか境界なのかを疑う。

ファイルシステムやプロセスなどの副作用は `src/session/ports.ts` のようなポート経由で受け取り、テストではフェイクを差す。

### プロバイダ抽象

CLI固有の事情（ファイル配置・引数・セッションIDの決まり方）は `AgentProvider`（`src/provider/types.ts`）の内側に閉じ込める。UI層・タブ復元・作業記録はこのインターフェースだけを見る。

新しいCLIに対応させる場合は次を用意して `ProviderRegistry` に足す。

1. `locate()` — 実行ファイルと設定ディレクトリの解決
2. `listSessions()` — セッション一覧の構築（純粋なパーサとして書き、I/Oはポート経由）
3. `capabilities` — fork / forkFromTurn / archive / delete / rename の可否。UIのメニュー出し分けに使われる
4. `tabTitle()` — タブと一覧の表示名

引数組み立てとセッションidの決め方は `AgentProvider` のインターフェースには無く、チャット画面側（`src/claude/streamSession.ts` の `buildClaudeStreamArgs` / `src/appserver/chatSession.ts` の `thread/start`）が担う。セッションidを起動前に決められるCLI（Claude Codeがそう）は、webview側で`randomUUID()`（`src/view/claudeChatView.ts`の`randomSessionId()`）により事前に生成し `--session-id` として渡す。起動前に決められないCLI（Codexがそう）は `thread/start` のレスポンスから `threadId` を受け取る事後照合になる。詳細は設計書 §9.1 / §14。

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

実VSCodeが要る領域のうち、**実CLIプロセスを使わずに確認できるもの**は `test/integration/`（`@vscode/test-electron`）へ切り出す土台を作った。`npm run test:integration` / `npm run test:integration:xvfb` で実行する。書き方はVitestのユニットテストと違い、実VSCodeの拡張機能ホスト上でMochaが動く点に注意（`describe`/`it`ではなく`suite`/`test`）。

- `vscode.extensions.getExtension('Sylphy0052.vscode-codex-extension')` で拡張機能を取得し、`activate()` の戻り値（`ExtensionTestApi`）経由で`view/**`側の実インスタンス（`SessionTreeProvider`）へアクセスする。VSCodeに依存する層はユニットテストからimportできないため（`docs/design.md` §11）、テスト専用の最小限の口として用意してある
- 実CLI（codex/claude）は絶対に呼ばない。`test/integration/fixtures/setup.mjs` が使い捨てのVSCodeプロファイルを作り、`codex.executablePath` / `claude.executablePath` を存在しない絶対パスへ固定した上で、`codex.codexHome` / `claude.configDir` を一時ディレクトリへ向けている。ユーザーの実環境（`~/.codex` `~/.claude` 実際のVSCodeユーザー設定）には一切触れない
- **現状自動化できているのは拡張機能の有効化・コマンド登録・設定の読み書き**（`extension.test.ts` / `configuration.test.ts`）だけ。履歴一覧（TreeView）を狙った`sessionHistory.test.ts`は`test.skip`のまま残している。`codex.executablePath`を存在しないパスに固定すると`ProviderRegistry.available()`が対象プロバイダを一覧からまるごと除外してしまい一覧が空になるため、実在する即exitスタブへ差し替える必要がある。そのスタブに対して以前は未捕捉の`EPIPE`が出て他のテストまで道連れにしていたが、issue #155の対策（`src/process/stdinSafety.ts`）で落ちることは無くなった。`test.skip`を外すと5件とも「一覧が空」で失敗する状態（issue #164で追う）
- 統合テストが**mochaの出力を一切出さないまま終わらない**場合は、`XDG_RUNTIME_DIR`が指すディレクトリが実在するか確認する。VSCodeはそこへIPCソケットを作るため、無いと起動しきらない。WSL2ではユーザーセッションが終わると`/run/user/<uid>`ごと消える。テスト側では`setup.mjs`が使い捨てのディレクトリを渡して回避している（issue #163、`docs/design.md` §14.32）
- Webviewの中身・承認カード・タブ復元・履歴一覧など、実CLIとの対話が要る範囲、および上記の理由で自動化に至らなかった範囲は引き続きF5による手動確認に頼っている。手順とチェックリストは [docs/manual-test.md](docs/manual-test.md) にある

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
