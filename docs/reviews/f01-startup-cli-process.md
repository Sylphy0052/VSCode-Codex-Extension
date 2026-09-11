# F01レビュー:起動・CLI探索・プロセス管理

レビュー日:2026-09-08。対象commit:`efd5cd67eb6a9b0a957538c9b5f981e2969875b6`。

静的レビューで6件の指摘を記録した。P1が1件、P2が5件。すべて未修正・実行による再現未確認。P1は優先修正、P2は通常の修正対象を表す。コードの制御フローから判定し、実機での発生頻度は評価していない。

[機能別レビュー台帳へ戻る](../feature-inventory.md#f01)。修正時は各指摘の確認条件を受入基準へ引き継ぐ。

## レビュー範囲

| 小項目 | 確認内容                                                                                              | 結果                                  |
| ------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------- |
| F01.01 | activateの接続・ビュー・コマンド登録、subscriptions、監視・定期更新、チャット破棄から接続破棄への経路 | 静的レビュー済み。F01-04を参照        |
| F01.02 | 両プロバイダの実行ファイル・ホーム解決、設定の伝播、会話開始時のcwd                                   | 静的レビュー済み。F01-01/F01-06を参照 |
| F01.03 | 解決失敗時の通知、導入手順・設定への導線、同じ失敗の重複抑制                                          | 静的レビュー済み。F01-04を参照        |
| F01.04 | spawn、stdinの生存判定・エラー、終了・中断、SIGTERMからSIGKILLへの移行                                | 静的レビュー済み。F01-03/F01-05を参照 |
| F01.05 | Codex常駐接続と単発問い合わせの初期化、フレーム分割、要求・応答・通知、接続断と世代判定               | 静的レビュー済み。F01-02を参照        |
| F01.06 | Claudeの起動引数、control protocolの送受信、NDJSONから状態更新への入口、初期化失敗・終了時の待機解放  | 静的レビュー済み。F01-03/F01-05を参照 |

CodeGraphのMCP接続と検索が成功し、このリポジトリの546ファイルが索引対象だった。呼出関係の探索に使用し、返却されなかった関数本体は直接読んだ。`.worktree/`はmain側のローカル設定`codegraph.json`で除外されているため、ソース差分のない同一commitのmainを検索した。CodeGraphの結果は動作検証として扱っていない。

## 指摘一覧

| ID     | 重要度 | 問題                                                    | 主な箇所                                                     |
| ------ | ------ | ------------------------------------------------------- | ------------------------------------------------------------ |
| F01-01 | P1     | ホーム設定がCLIの起動環境へ渡らない                     | extension.ts:308、connection.ts:112、streamSession.ts:296    |
| F01-02 | P2     | 同時起動時にCodexの初期化待ちを飛ばす                   | connection.ts:87                                             |
| F01-03 | P2     | Claudeの受信チャンク境界でUTF-8文字が壊れる             | streamSession.ts:329                                         |
| F01-04 | P2     | 拡張起動だけで未導入CLIのエラーを通知する               | extension.ts:938                                             |
| F01-05 | P2     | stdinエラー時に生きた子プロセスを回収できない           | connection.ts:129、streamSession.ts:312、commandRunner.ts:60 |
| F01-06 | P2     | Windows形式の明示パスをPATH上のコマンド名として探索する | cliLocator.ts:87                                             |

### F01-01[P1]:ホーム設定がCLIの起動環境へ渡らない

**条件:**`codex.codexHome`または`claude.configDir`に、拡張ホストの環境変数・既定値と異なるディレクトリを指定する。

[extension.ts:308](../../src/extension.ts#L308)と[extension.ts:317](../../src/extension.ts#L317)は設定優先でホームを解決し、履歴ストア・設定ファイル・監視へ渡す。一方、[connection.ts:112](../../src/appserver/connection.ts#L112)と[appServerClient.ts:740](../../src/codex/appServerClient.ts#L740)のspawnには`env`指定がない。[streamSession.ts:296](../../src/claude/streamSession.ts#L296)の`env`も`process.env`とチェックポイント用変数だけで、解決済みの`CLAUDE_CONFIG_DIR`を設定しない。[Claudeの起動引数](../../src/claude/argvBuilder.ts)にも設定ディレクトリの指定はない。

拡張が読む履歴・設定と、CLIが読む設定・保存する履歴が別のディレクトリになる。指定先の既存セッションをCLIが再開できない、開始した会話が拡張の監視先に現れない、表示上の設定とCLI側の設定が一致しない、といった結果になる条件がある。

**修正方針:**解決済みホームをプロバイダごとのプロセス起動へ渡し、常駐接続・単発問い合わせで統一する。環境全体を書き換えず、各spawnの`env`へ反映する。

**修正後の確認条件:**環境変数と設定値に異なるディレクトリを用意し、両CLIのspawn環境が設定値を使うことを確認する。設定を空にしたときの環境変数・既定値へのフォールバックも確認する。実CLIでの再開と履歴保存先の照合は未実施。

### F01-02[P2]:同時起動時にCodexの初期化待ちを飛ばす

**条件:**常駐接続の最初の`initialize`への応答がまだ届いていない間に、別の会話開始・再開が同じ接続の`ensureStarted()`を呼ぶ。

[connection.ts:87](../../src/appserver/connection.ts#L87)は`this.proc`が存在すれば即座に戻る。`this.proc`は[startのspawn直後](../../src/appserver/connection.ts#L113)に設定され、初期化完了とは区別されていない。2番目の呼出しは`this.starting`を待たず、[ChatSession.start:153](../../src/appserver/chatSession.ts#L153)や[resume:194](../../src/appserver/chatSession.ts#L194)の後続要求へ進める。

この順序では`initialized`通知より前に`thread/start`や`thread/resume`を送れる。初期化前の要求をCLIが拒否すると、最初の会話は開始できても同時に開いた会話だけ失敗する。既存の[connection.test.ts](../../test/unit/connection.test.ts)は初期化失敗後の再起動を扱うが、初期化中に2番目の呼出しを待たせるケースは確認できなかった。

**修正方針:**起動中のPromiseがあれば先に待つ。初期化完了状態を明示する場合も、プロセスの存在だけを接続完了と判定しない。

**修正後の確認条件:**`initialize`応答を保留した状態で2回呼び、両方が未完了であること、spawnが1回であること、初期化成功・失敗が両呼出元へ伝わることを確認する。

### F01-03[P2]:Claudeの受信チャンク境界でUTF-8文字が壊れる

**条件:**Claudeの標準出力に含まれる日本語などのUTF-8文字が、2つのBufferに分割されて届く。

[streamSession.ts:329](../../src/claude/streamSession.ts#L329)はBufferごとに`toString('utf8')`を呼び、文字列を`receive()`へ渡す。不完全なバイト列はこの時点で置換文字になり、[receive:1087](../../src/claude/streamSession.ts#L1087)で文字列を連結しても復元できない。JSONの文字列値としては解析できる場合もあるため、本文やツール入力が文字化けしたまま画面に反映される。

Codex側は[StringDecoderを持つFrameBuffer](../../src/codex/jsonRpc.ts#L98)で同じ問題に対応しており、[jsonRpc.test.ts:124](../../test/unit/jsonRpc.test.ts#L124)に全分割位置を確認するテストがある。Claude側で確認した既存テストは完成済み文字列やBufferを渡しており、この受信境界を保護していない。

**修正方針:**Claude側もプロセスごとにUTF-8デコーダーを保持し、不完全なバイト列を次の受信まで持ち越す。接続破棄時にはデコーダーの残りも捨てる。

**修正後の確認条件:**日本語を含むstream-jsonイベントを全バイト位置で2分割し、実際のstdoutハンドラーを経由して本文が一致することを確認する。破棄後に旧プロセスの未完成文字を引き継がないことも確認する。

### F01-04[P2]:拡張起動だけで未導入CLIのエラーを通知する

**条件:**CodexかClaude Codeの片方だけを導入し、拡張を起動する。未導入側の会話を開く必要はない。

[extension.ts:938](../../src/extension.ts#L938)は起動時に`refreshModelCatalog()`を呼ぶ。[SettingsProvider.refreshModels:357](../../src/view/settingsProvider.ts#L357)は両CLIのモデル読込を開始し、[loadCodexModels:555](../../src/view/settingsProvider.ts#L555)と[loadClaudeModels:580](../../src/view/settingsProvider.ts#L580)はCLIへの問い合わせを先に試す。問い合わせに渡す実行パスのresolverは[extension.ts:2911](../../src/extension.ts#L2911)で作られ、未導入なら`showErrorMessage()`を呼ぶ。

[READMEの片方だけで使う説明](../../README.md#片方のcliだけで使う)にある「起動時は探索しない」「未導入側のエラーは出ない」という挙動と一致しない。重複通知の抑制は働くが、起動直後の不要な1回を防がない。5分ごとの更新でも探索とエラーログ出力が繰り返される。

**修正方針:**自動更新では通知を伴わない実行可否判定を使い、未導入側はキャッシュなどへ退避する。利用者がそのCLIの機能を明示操作したときの導入案内を残す。READMEだけを実装に合わせて変更するかは、製品挙動の選択として別途判断する。

**修正後の確認条件:**片方だけを導入した状態で、起動と定期更新がエラー通知を出さないことを確認する。未導入側を明示的に開いたときは通知し、同じ失敗は重複通知しないことを確認する。

### F01-05[P2]:stdinエラー時に生きた子プロセスを回収できない

**条件:**起動済みの子プロセスがstdinを閉じても終了せず、その後の書込みでstdinのerrorイベントが発生する。stdinの破損と子プロセスの終了は同義ではない。

[connection.ts:129](../../src/appserver/connection.ts#L129)は`reset()`だけを行い、[reset:302](../../src/appserver/connection.ts#L302)でプロセス参照を消す。[streamSession.ts:312](../../src/claude/streamSession.ts#L312)も参照を消し、待機解放と状態更新だけを行う。その後の`dispose()`では対象を取得できず、まだ動いている子プロセスを終了できない。

共通の[commandRunner.ts:60](../../src/process/commandRunner.ts#L60)もstdinエラーで`finish()`を呼ぶだけで、[finish:32](../../src/process/commandRunner.ts#L32)は30秒の回収用タイマーを解除する。子が終了しなければ、結果を返した後も残る。

**修正方針:**stdinエラーによる接続破棄では、対象の世代を確認したうえで生存中の子へ`killWithEscalation()`を適用する。実際のexitとエラー通知が重なっても二重終了処理にならないようにする。

**修正後の確認条件:**exitを発生させずstdinエラーだけを発生させ、待機の解放とSIGTERM送信、猶予後のSIGKILLを確認する。旧世代から遅れて届くstdinエラーは新世代を終了させないことも確認する。

### F01-06[P2]:Windows形式の明示パスをPATH上のコマンド名として探索する

**条件:**`codex.executablePath`または`claude.executablePath`へ、区切りがバックスラッシュの絶対パスを設定する。例:`C:\Tools\codex.exe`。

[cliLocator.ts:87](../../src/codex/cliLocator.ts#L87)は`/`を含む値だけを明示パスとして扱う。例の値はこの分岐を通らず、[cliLocator.ts:100](../../src/codex/cliLocator.ts#L100)で各PATHディレクトリの後ろに連結される。指定した実行ファイルそのものを検査しないため、存在していても`not-found`を返し、不要な導入エラーを通知する。

`resolveSpawnPath()`は失敗時も指定文字列を返すため、これだけを根拠にspawnも必ず失敗するとは判定しない。確認できた問題は、探索結果と通知が誤る点。

**修正方針:**Windowsの絶対パス・区切り文字を明示パスの判定へ含める。`PATHEXT`の既存候補展開は維持する。

**修正後の確認条件:**Windows形式の実在・非実在パス、空白を含むパス、拡張子省略を確認する。Unix形式とPATH上のカスタムコマンド名の挙動も保持する。Windows実機での確認は未実施。

## 確認した既存の保護と参照テスト

以下はコードと既存テストの記述を確認したもの。今回テストが成功したという意味ではない。

- Codexの初期化タイムアウト時の回収、接続断時の要求待ち解放、旧プロセスのイベント除外:[connection.test.ts](../../test/unit/connection.test.ts)。単発問い合わせの関連ケース:[appServerClientRobustness.test.ts](../../test/unit/appServerClientRobustness.test.ts)。
- CLIの実行パスとホームの解決、失敗通知の重複抑制:[cliLocator.test.ts](../../test/unit/cliLocator.test.ts)、[claudeLocator.test.ts](../../test/unit/claudeLocator.test.ts)、[executableResolution.test.ts](../../test/unit/executableResolution.test.ts)。探索単体と、設定をspawnへ渡す配線は別の確認範囲。
- UTF-8のチャンク分割と未完成行の上限:[jsonRpc.test.ts](../../test/unit/jsonRpc.test.ts)。Claudeの未完成行上限と破棄時の回収:[claudeStreamSessionBufferOverflow.test.ts](../../test/unit/claudeStreamSessionBufferOverflow.test.ts)。
- Claudeのexit/error時の待機解放と旧世代イベントの除外:[claudeStreamSessionExitRelease.test.ts](../../test/unit/claudeStreamSessionExitRelease.test.ts)、[claudeStreamSessionStaleProc.test.ts](../../test/unit/claudeStreamSessionStaleProc.test.ts)。
- SIGKILLへの移行とstdinの生存判定:[childProcess.test.ts](../../test/unit/childProcess.test.ts)、[stdinSafety.test.ts](../../test/unit/stdinSafety.test.ts)。

## 検証と残る範囲

変更はこの結果文書と台帳の進捗記録。実装・テストコードは変更していない。テスト・型チェック・lint、実VSCode、実CLI、Windows・Remote環境での動作確認は実施していない。実行検証の追加・実行は明示依頼時のみという個人規約に従った。

F01のチェックは、上表の入口・接続・終了処理の静的レビュー完了を示す。各公開コマンドの処理本体、Claudeイベントごとの描画・費用・ツール承認などの意味、全probeの個別実装は、それぞれF03〜F17などの機能別レビューへ残す。全関数・全競合順序を精査したという意味ではない。

次の機能レビューは[F02:履歴の収集・検索・整理](../feature-inventory.md#f02)。F01-01のホーム不一致を前提に、CLIによる一覧取得とファイル読込へのフォールバック、監視先の整合を追う。
