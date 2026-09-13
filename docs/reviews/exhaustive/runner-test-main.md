# 実行管理本体の全テスト内容の精査

対象:test/unit/runner.test.ts全13,117行。各テストの準備、操作、期待値、ヘルパー、モック、タイマー、後片付けを全文確認した。実装本体の記録は[runner-main.md](runner-main.md)。テストは実行していない。

## EX-TEST-12[P2]:別々の呼出し配列のindexで前後関係を判定する

runner.test.ts:3868はPR作成の位置をcli.calls、3871行はgit mergeの位置をgit.callsから取得し、3875行で大小比較する。両配列は独立した時系列であり、PR作成とmergeの実際の前後関係を表さない。merge前に無関係なgit呼出しがあれば、PRが後でも期待値を満たす。pushは件数しか比較しない。同じordered traceへ両ポートの操作を記録し、push→PR作成→mergeを確認する必要がある。

## EX-TEST-13[P2]:CI待ちの試験がレビューコメント取得を捉える

runner.test.ts:4132の「CI待ちの最中に全体停止」はgh pr viewという条件だけでstopを呼ぶ。統合PR作成直後はstartReviewCommentPollが--json=reviews,commentsのviewを先に呼ぶため、実際にはCI取得前に停止できる。3972行の「CIチェックの完了を待ってから最終マージ」も同じ広い条件でviewIndexを探し、レビューコメント取得があればCI呼出しを省いても順序の期待値が成立する。

--json=statusCheckRollupまで照合し、CI要求が始まった後の保留中に停止する必要がある。待機試験は最初からCOMPLETED/SUCCESSを返しており、未完了→完了までmergeしないこともこの試験では観測しない。forge単体の検査とrunnerの配線検査を区別する。

## EX-TEST-14[P2]:重複排除の試験で2回目の取得が起きない

runner.test.ts:4370は60秒後もレビューコメント警告が1件であることを確認するが、fakeForgeDepsの既定はfinalMerge:auto。最初のflushで最終マージが確定し、レビューpollは閉じる。後続の「最終マージ後はpoll停止」試験もこの契約を確認している。時間を進めるだけでは同じコメントを再取得せず、重複排除を削除しても1件のまま成立する。pr-only等でpollを維持し、同一idを2回以上取得したことと警告が1件であることを併せて確認する必要がある。

## 基盤の保証範囲

FakeTaskSession.runLoopは引数を記録し、finishを試験が直接呼ぶ。実LoopControllerのbusy、回数制限、停止からonFinishedへの連動は再現しない。FakeHostのopenは大半が即時完了で、worktree待機・transport待機の試験はあってもhost.open自体を保留して破棄する試験は不足する。

FakeGitは応答と呼出しを記録し、実commit graphや統合後の内容を作らない。MERGE_HEADと未解決パスが空になるだけで実merge成功を証明しない点はEX-INTEGRATION-01。FakePseudoFsは主にmtime/sizeで内容、symlink、実FS例外を再現せず、copy元なしも実FSと異なる。共通filePortは任意パスへYAMLを返すため、独立検証の必須ファイルも個別上書きがなければ存在扱いになる。

fakeMessagingのURLとclose記録、control.hubへの直接呼出しは実HTTP、認証、閉鎖後の接続失敗を検査しない。「MCPが実際に機能」の文言があっても、このファイルでは内部制御への到達までと解釈する。再開後に同じhubを保持する件数検査はあるが、実通信経路の連続性は別の統合試験が必要。

HarnessはallowAutoApproveとautoResumeを既定falseにし、各trueの試験を別群で行う。製品の既定値を組み合わせた挙動の保証とは異なる。fake timers、microtaskのflush、個別の実時間待機を併用するため、flush回数だけの否定assertは到達点の固定を保証しない。

## 全テスト群の確認内容と不足

| テスト群                      | 確認した操作・期待値と不足                                                                                                                                                                                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 定義・起動・DAG・テンプレート | 読込み失敗、定義拒否、provider、並列数、依存成果、nonce、権限制限、許可確認、保存を確認。同意中にYAMLを書き換える試験はなくEX-EXT-01を検出しない。                                                                                                                     |
| 停止・失敗・再試行            | 単一/全体停止、停止できないsession、独立タスクと依存失敗、manual/interrupted、maxReached/stalledの会話保持、retry上限と新branch、手動再実行を確認。全体停止の先行フラグを観測する試験はある。DONE後の検証待機中の停止はない。                                          |
| 承認と待機                    | 自動承認、拒否、待機数、衝突解決と並列数、停止通知の重複抑止を確認。大半の承認解決はcallback直呼びで、実承認RPCの往復ではない。別ファイルのrunnerTaskApprovalも併読した。                                                                                              |
| ローカル統合・衝突解決        | commit、merge、依存の再開、失敗とblocked、stop_taskと全体停止の違い、lease占有、待機解除、再入、open/runLoop例外、同期finish、finallyを確認。独立作業継続という名前で独立ノードを作らない試験もあるが、別のT5付き試験は正の観測を持つ。                                |
| Forge・CI・最終マージ         | GH/GL、PRモード、base、URL/番号保存、draft解除、ready失敗、CI赤/緑、停止、merge/hold、判断理由と期限、confirmの期限なし、停止後のmerge拒否とhold許可を確認。PR作成とgit順序、CI待機の誤検査は上記2指摘。                                                               |
| レビューコメント              | 取得、無効化、CLI失敗の継続、最終マージ後のpoll停止、pr-onlyでの継続、追加タスクの完了と再判断を確認。同一idの再取得による重複排除はEX-TEST-14。CI復旧計画→修正完了→再度CI→最終マージを通す検査は不足する。                                                            |
| Issueと命名                   | 既存/新規Issue、作成失敗の継続、Closes、commit type、branch styleの通常・fallbackを確認。一部はprefixや本文の部分文字列だけで、衝突しない名前や完全なCloses構文は保証しない。EX-WORKTREE-01。                                                                          |
| タスクPRレビュー              | レビューsession生成、read-only向け引数、空findingsの完了を確認。レビュー失敗時に統合しない契約を保証せず、EX-FORGE-04はforge本体の記録へ集約する。                                                                                                                     |
| 撤去・疑似統合                | done/running/dirty、進捗、branch保持、全retry上限、git/pseudoの分離、競合時のclone保持、baseline更新、部分反映、rename失敗、禁止パス、manifest破損・直列化・復元を確認。manifest読込みI/O障害、復元前の人の編集、統合先リンク差替えはEX-PSEUDOの指摘を検出しない。     |
| 通信・返信・ハンドオフ        | 開始/失敗/依存なし、URL、表示警告、返信待ち、解除、タイムアウト、全員待機、MAXの終了理由、遅延transportと破棄、同じhubの保持を確認。MAXのfinish直呼びは実予算の消費を保証しない。prompt変換結果は外部CLIの実受領ではない。                                             |
| 終了通知・再開                | 成功/失敗の通知、retry/continue後の通知回数、ロードマップ・疑似反映の再適用を確認。レビュー成功後にForgeなしでMCPを閉じる条件は不足しEX-RUNNER-01を検出しない。                                                                                                        |
| オーケストレーター            | 起動設定、autoApprove、busy時の通知、会話送信、snapshot、未読数、run状態とツール一覧を確認。read-onlyという名前でもcwdと件数だけを確認する試験がある。閉鎖後にhubを直呼びする確認はHTTP到達性の保証ではない。                                                          |
| 制御ツールと計画変更          | 未知/停止/pending/終了タスクの拒否、stopのfalse、continue、prompt空白/上限/template/history、add/remove、依存cycle/self/未知、50件制約、原子性、保存復元を確認。prompt変更の「開始前後」名に対して未知タスクだけを渡すケースは、既存pending/doneへの拒否を確認しない。 |
| 人への質問                    | 2〜4選択肢、重複、上限、忙しいときの延期、未質問/不正index/再回答、自由文と選択肢の区別、pending保存・復元を確認。応答済み質問の復元や質問数上限の復元はrunner-orchestrator-main.mdの不足も参照する。                                                                  |
| 自動復元                      | 明示true/false、全体停止、retry上限、allow設定、他タスク失敗、復元後のmerge順序、旧新subjectを確認。保存状態を試験内で手動変更するものは、その復元分岐の検査に限定する。実作業内容やcommit親を復元する試験ではない。                                                   |
| 破棄・期限・例外              | 通常session、通信close例外、dispose例外、同期finish、lease待機、保存queue、衝突解決承認の59秒/60秒/既定/再設定/解除を確認。clearTimeout呼出しの検査は全タイマー消滅を保証せず、復旧待ちと最終判断のtimerはEX-RUNNER-03の対象。                                         |

テスト名だけから保証を推定せず、実際に変化する状態・引数・呼出しとassertionの対応を確認した。上記以外にも詳細な不足は関連モジュールの精査記録へ保存している。テスト合格、実行時分岐網羅率、全非同期順序の安全性は報告しない。
