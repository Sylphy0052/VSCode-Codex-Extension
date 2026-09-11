# F20レビュー:ループAdvisor・補助CLIの制限

対象commit:efd5cd67eb6a9b0a957538c9b5f981e2969875b6。[台帳](../feature-inventory.md#f20)の4項目を静的レビューした。P2が1件。

| 項目   | 確認内容                                                                                                                                                                                 |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F20.01 | ゴール型ループだけで指定間隔に呼び出し、評価役と並行して結果を待つ                                                                                                                       |
| F20.02 | 助言は会話に残し、次ターンでは参考情報として区切る。実指示に使うfocusは列挙値へ正規化                                                                                                    |
| F20.03 | timeout/process-error/invalid-responseを指摘なしと分離。連続3回失敗で当該実行のAdvisorを無効化。blockerとachievedの衝突はconflictedで停止                                                |
| F20.04 | Claudeはtoolsとsetting-sourcesを空指定。Codexは一時cwd、read-only、ephemeral、ユーザー設定無視と機能無効化。stdin入力、timeout/abort/close時の終了処理、Codex一時資料のfinally削除を確認 |

### F20-01[P2]:補助CLIのstdoutを無制限に保持する

[runProcess](../../src/loop/headlessCli.ts#L331)は出力を文字列へ追加し続ける。時間制限はあるが容量制限はなく、壊れたCLIや大量出力では期限前に拡張ホストのメモリを圧迫する。評価役・Advisor・下書き役の共通経路で起きる。

期待するJSON応答に合わせたバイト上限を設け、超過時は子を終了して明示的な失敗にする。多量出力とUTF-8境界、timeoutとの同時発生を確認する。

根拠:[補助CLI](../../src/loop/headlessCli.ts)、[Advisor送信](../../src/loop/loopAdvisorProcess.ts)、[応答解析](../../src/loop/advisorPrompt.ts#L116)、[実行間隔](../../src/loop/loopAdvisor.ts#L213)、[優先順位と世代照合](../../src/loop/loopController.ts#L847)。CLIの無効化フラグが実際に全ツールを遮断するかはCLI版ごとの実行確認が必要。今回はテスト・補助CLIを実行していない。
