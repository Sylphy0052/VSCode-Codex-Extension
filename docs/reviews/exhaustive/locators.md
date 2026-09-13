# 実行ファイル・home・通知の精査

`src/codex/cliLocator.ts`、`src/claude/cliLocator.ts`、`src/provider/executableResolution.ts`と、`cliLocator.test.ts`、`claudeLocator.test.ts`、`executableResolution.test.ts`の全文を読んだ。テスト未実行。

Nodeのaccess/statの成功・例外、PATHEXTの未設定/空/区切りだけ/既存拡張子/展開、設定pathとPATH探索、trim、PATH空要素、home優先順位、各path組立て、debug候補の優先順位を確認した。解決失敗でもattemptedをそのままspawnへ渡す処理、2種類の案内、失敗key、連続失敗の抑制と成功時の復旧も読んだ。

CodexのテストはPATHの順序・未発見・未設定、明示pathの成功/失敗、コマンド名、空白、PATHEXTの代表形とWindows風PATH、home優先順位と空白環境変数、全pathを検査する。ClaudeはPATH探索・明示path失敗・未発見、home優先順位、projects、debugのIDあり/なし/空白を検査する。通知はspawn pathの成功と各失敗、案内の部分文字列、keyの同値/差、最初・連続・別失敗・成功を挟む再通知を検査する。

不足は実Node依存のaccess/stat、PATHEXTが区切りだけ・重複、設定値の逆斜線、PATHの空要素、home末尾区切り、空白を含む環境変数の返却値、debug IDのパス文字である。既存F01-06はWindowsの設定path判定が`/`だけである点を扱っている。ホームを子プロセスへ伝えない点はF01-01。重複して数えない。

「PATH全体を含まない」という通知テストはattemptedが1回現れることだけを検査する。別の環境情報が末尾に加わる変更でも成功するため、名前が示す非開示条件を十分に検査していない。Windowsテストはfakeの文字列一致であり、`.CMD`を実際にspawnできることの検証ではない。
