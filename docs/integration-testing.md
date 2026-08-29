# 統合テスト（実VSCode）の走らせ方

`test/integration/**` は実物のVSCode（Electron）をダウンロードして起動し、その拡張機能ホストの中でMochaを走らせる。ユニットテスト（Vitest）と違って重く、環境の影響も受ける。ここでは実行方法と、結果を誤読しやすい箇所をまとめる。

書き方の規約（`suite`/`test`、実CLIを呼ばないこと、`ExtensionTestApi` 経由でのアクセス）は [CONTRIBUTING.md](../CONTRIBUTING.md) にある。

## 実行コマンド

| やりたいこと                    | コマンド                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| 全件走らせる                    | `npm run test:integration`                                                                |
| ヘッドレス環境（WSL・CI）で全件 | `npm run test:integration:xvfb`                                                           |
| 1件だけ                         | `npm run build:integration && npx vscode-test -g "C-42"`                                  |
| suite単位                       | `npm run build:integration && npx vscode-test -g "Codex画面: プロトコルの状態遷移と配線"` |
| 特定の1件を除いて全件           | `npm run build:integration && npx vscode-test -g "C-13:" -i`                              |

全件は手元で2分前後かかる。1件だけなら1分弱で、その大半はVSCodeの起動時間である。

### `npx vscode-test` を直接叩くときはビルドを先に走らせる

`npm run test:integration` は `npm run build:integration`（＝ `npm run build` + `tsc -p tsconfig.integration.json`）を挟んでから `vscode-test` を呼ぶ。`vscode-test` を単体で叩くと**このビルドが走らない**。拡張機能の実体は `dist/extension.js` にバンドル済みのものが読まれるため、ブランチを切り替えた後・別のコミットで最後にビルドした後などは、いま見ているソースと違うものを検査することになる。

症状は分かりにくい。ソースを直した直後なら「直したはずの箇所が直っていない」で済むが、`dist/` が古すぎるとコマンド登録の時点で食い違い、**ほぼ全件が次の形で落ちる**。

```
Error: codex.openSession が登録されていない
```

この見た目は「統合テストの土台がまるごと壊れた」ように読めるが、実際にはビルドし忘れているだけのことが多い。`npx vscode-test` を叩く前に `npm run build:integration` を通す。

### 絞り込みは `-g`。`--mocha_grep` は存在しない

`vscode-test` はmochaのオプションをそのまま受ける。1件に絞るのは `-g`（`--grep`）で、`-i` を足すと反転（マッチしたものを除く）になる。

```
$ npx vscode-test -g "C-42"
  ✔ C-42: /btwは元のスレッドをephemeralにforkし、別タブで一往復だけ聞く。質問なしはエラーで送らない (461ms)
 1 passing (767ms)
```

`--mocha_grep` のような名前は**受け付けられないだけでエラーにならず、黙って全件が走る**。「1件に絞ったつもりが全件の結果を読んでいた」という誤読につながるので、絞ったときは末尾の `N passing` の件数が想定どおりかを必ず見る。

使えるオプションは `npx vscode-test --help` で引ける（`-b`（bail）、`-t`（timeout）、`--dry-run` あたりが実用的）。

## 変更前から落ちていたかを確かめる

統合テストには後述の既知の失敗があるため、「落ちた ＝ 自分の変更が壊した」ではない。判断するにはベースラインを測る。手元のworktreeで、比較したいコミットへdetached checkoutして同じコマンドを走らせるのが確実である。

```bash
git checkout --detach origin/main
npm run test:integration          # ベースラインの件数を控える
git checkout <作業ブランチ>
npm run test:integration          # 自分の変更での件数
```

`npm run test:integration` はビルドを含むので、この往復で `dist/` の食い違いも自動的に解消される。stashではなくcheckoutを使うのは、worktreeのstashスタックがメインの作業ツリーや他のworktreeと共有されており、別のセッションと踏み合う余地があるため（`CLAUDE.md`）。

比較するのは**失敗したテストの名前**であって、passingの件数ではない。ブランチ間でテストの総数が変わっていると件数は当然ずれる。

## 既知の失敗（2026-08-29時点）

`origin/main`（`ed1757bd`）で全件を走らせると `85 passing / 2 failing` になる。2件は性質が違う。

### `C-13`（`chatCodexThreadFlow.test.ts`）

```
C-13: 応答中の指示はturn/steerで割り込み、turnIdが未確定の間は待ち行列に積んでターン完了後に送る:
  Error: waitFor: 20000ms待っても条件を満たさなかった
```

`npx vscode-test -g "C-13:"` で**単体でも落ちる**。他のテストとは無関係に失敗している。

### `C-42`（同ファイル）

```
C-42: /btwは元のスレッドをephemeralにforkし、別タブで一往復だけ聞く。質問なしはエラーで送らない:
  Error: waitFor: 20000ms待っても条件を満たさなかった
```

こちらは**単体では通る**（上の実行例のとおり）。落ちるのは他のテストと一緒に走らせたときだけで、順序に依存している。`-g "C-13:" -i` で `C-13` を除いても落ちるため、原因は `C-13` ではなく、同じsuiteの先行テストが残す状態にある。suite単位（`-g "Codex画面: プロトコルの状態遷移と配線"`）で走らせても再現する。

順序依存の失敗は、自分の変更が「テストを1件増やした」だけでも顕在化・消失しうる。落ちたテストを見つけたら、まず `-g` で単体実行して切り分ける。

## 起動しない・出力が出ないとき

mochaの出力が1行も出ないまま止まる場合は、`XDG_RUNTIME_DIR` が指すディレクトリが実在するかを最初に疑う。VSCodeはそこへIPCソケットを作るため、無いと起動しきらない。WSL2ではユーザーセッションが終わると `/run/user/<uid>` ごと消える。

テスト側は `test/integration/fixtures/setup.mjs` が使い捨てのディレクトリを作って `.vscode-test.mjs` の `env.XDG_RUNTIME_DIR` へ渡すことで回避している（issue #163、`docs/design.md` §14.32）。それでも起動しない場合は、渡している先が実際に作られているかを確認する。

ヘッドレス環境（ディスプレイが無いWSL・SSH越し）では `npm run test:integration:xvfb` を使う。`scripts/xvfb-vscode-test.sh` が `xvfb-run` を挟む。

## 実行時に触られるもの・触られないもの

`setup.mjs` が使い捨てのVSCodeプロファイルを作り、`codex.executablePath` / `claude.executablePath` を存在しない絶対パスへ固定し、`codex.codexHome` / `claude.configDir` を一時ディレクトリへ向ける。実CLIは起動しない。ユーザーの `~/.codex` `~/.claude` と実際のVSCodeユーザー設定には触れない。

VSCode本体は `.vscode-test/` へダウンロードされる（初回のみ数分かかる。数GBある）。ここはビルド成果物と同じ扱いで、消しても次回再取得される。
