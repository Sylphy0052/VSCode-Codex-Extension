# ワークフロー承認変換・危険判定・実行保存・program定義の精査

src/orchestratorのapprovalMapping.ts、escalation.ts、runStore.ts、program.tsと、それぞれのunitテストを全文で確認した。テストは実行していない。

| 対象          | 関数・分岐・テストの確認                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 承認変換      | unknownの型絞込み、networkのallow/deny選別、文字列配列、空値、Codex/Claude別command/cwd、itemIdによるdiff探索、Edit/Write/NotebookEditのpath、permissions・旧形式を確認。移動先の欠落はEX-APPROVAL-01、実パス失敗はEX-APPROVAL-02。テストは正常変換、missing itemId、network、permissions、Notebook、旧形式、commandの実パス変換を確認するが、移動先・未作成ファイル・解決失敗を扱わない。networkとgrantRootをうたうテストにgrantRoot入力がない。    |
| 危険判定      | command正規化、各危険pattern、シェル文字、path token抽出、境界、.git/commonDir、grantRoot、exec提案、network、escalate/allow/autoApproveの優先、常時ask、理由の無害化を確認。空入力、部分データ、各patternの大文字、複数フラグ、境界の前方一致、.Git、許可解除と解除不能条件の期待値を確認。単純な文字列分類であり、任意のシェルや実行されるscriptの安全性は保証しない。argvの文字列化でquote境界を失う、引数のsymlinkは解決しないなどの限界がある。 |
| 保存          | SerialQueueによるupdate/reconcile/clear、既存run置換・追加、startedAtでの10件保持、リロード時のrunning/waitingApproval失敗化、pendingスキップ、終了時刻補完、旧PR項目を確認。waitingReplyはF35-01。10件上限は実行中も含む。reconcileは保存時にtrimする一方、返値はtrim前のmapped全件。保存型は応答全文を含まないが、型だけでは実行時の余分な属性を除去しない。runner側の保存projectionは別対象。                                                     |
| 保存テスト    | 復元状態、更新10回、12件から10件、旧スキーマ、PR、clear、参照維持を確認。競合テストのFakeMemento.updateはPromiseを返す前に同期でstoreを書き換えるため、SerialQueueを失ってもread/writeが交差しない。EX-TEST-07と同じ検出力不足。応答非保存テストは元fixtureに応答を入れていない。                                                                                                                                                                    |
| program定義   | YAML例外、record化と危険key除外、run参照・依存変換、未知型の既定値、path制約、version/name/run件数/maxParallel/id重複・危険id・依存先・cycleの全分岐を確認。数値項目に数値以外を渡すと既定値へ退避する。lexicalなdefPath検査だけではsymlink先を拘束しない。実行時の読込み境界はrunner側で別途確認する。                                                                                                                                              |
| programテスト | parserの3形式、2種のcycle、重複id、危険id、件数・並列上限、name、相対脱出・拡張子、version、整数、既定値を確認。数値の不正文字列、YAML構文例外、rootが配列、mixed依存配列、自己参照、pathの全platform表記は未確認。                                                                                                                                                                                                                                  |

## EX-APPROVAL-01[P1]:ファイル移動先が自動承認の境界検査から落ちる

approvalMapping.ts:73のcodexFileChangePathsはdiffs[].pathだけを返し、movePathを含めない。chatState.ts:951・1837はCLIのkind.move_pathをmovePathへ保持しているため、移動先は取得可能である。runner.ts:4480のclassifyApprovalRequestは変換済みpathsだけを検査し、autoならacceptを返す。

元pathが許可worktree内で、movePathが境界外または.git配下でも、grantRootなど別の停止条件がなければ移動先を理由にaskへ止められない。元と先を両方検査する必要がある。既存mappingテストはmovePathを入れない。静的に承認判定の欠落を確認したが、CLIのsandboxが実際の移動を許すかは未検証。

## EX-APPROVAL-02[P1]:未作成ファイルでは実パス解決の失敗が境界内扱いへ戻る

approvalMapping.ts:63のresolveRealPathは解決不能ならrawを返す。nodeWorktreeFileSystem.realpathはworktree.ts:147で例外をundefinedへ変える。許可root配下のlinkが外部dirを指し、その配下の新規ファイルがまだ存在しない場合、ファイル全体のrealpathは失敗する。返るrawには外向きsymlinkの情報がなく、classifyApprovalRequestの字面による境界検査を通る。

これは「失敗時は安全側」というコメントと逆で、Claude WriteやCodexの新規作成が対象になる。既存の最寄り親を解決して残りの相対成分を検査するか、解決不能をaskへ回す必要がある。CLI自体の追加防御による実書込み可否は未検証。テストのidentityFsと既存pathの置換だけでは検出できない。

## 制約

runner本体の全状態遷移、実ファイル操作、CLIの承認・sandboxはこの記録で精査済みとしない。実行検証なし。
