# 並列処理・直列キュー・Provider境界の精査

対象:`src/util/{concurrency,memento}.ts`、`src/orchestrator/serialQueue.ts`、`src/provider/{id,types,registry,account}.ts`、`test/unit/{concurrency,serialQueue,providerRegistry}.test.ts`。全文を静的に精査した。テストは未実行。

## 関数と分岐

| 対象                                               | 精査結果                                                                                                              | テスト不足・契約上の注意                                                                                                                                                            |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mapWithLimit`、worker、worker生成callback         | 空配列は未呼出しで返す。通常は同期的なindex取得後にawaitするためindexは重複せず、入力順で結果を格納。0以下は1へ丸める | 非整数はArray.from側で切捨て。NaNはworkerが0個となり穴あき配列を返す。現呼出元はすべて定数32であり、実利用の不具合とは数えない                                                      |
| workerの失敗                                       | 一つのrejectで呼出元へrejectするが、他workerは継続する                                                                | 失敗後に副作用が止まる契約はない。既存試験はrejectだけを見て、残workerの完了を待たない                                                                                              |
| `SerialQueue.enqueue`とtail成功/失敗callback       | 前項目のsettle後に実行。各結果を個別に返し、tailは成功・失敗ともundefinedへ回復                                       | task内部で同じqueueへenqueueし、その完了をawaitすると自己待機する。一般的な非再入契約として記録。呼出元は各モジュールの精査記録を参照。worktreeの同一queue内再enqueue回避も確認済み |
| `MementoLike`                                      | getの既定値と非同期updateの最小型                                                                                     | 保存値の実行時検証・永続化成功はこの型では保証しない                                                                                                                                |
| `isProviderId`                                     | 文字列かつcodex/claudeの二段階判定                                                                                    | 他型、空文字、未知文字列、正常2値の直接テストなし。呼出側テストは別台帳                                                                                                             |
| `ProviderCapabilities/AgentProvider`               | fork/forkFromTurn/archive/deleteとlocate/list/tabTitleの境界を確認                                                    | 型だけで実CLI能力を保証しない                                                                                                                                                       |
| `AccountView/AccountSnapshot/accountNotLoadedYet`  | 未取得/取得失敗と未ログインをunionで区別。秘密値の専用フィールドなし                                                  | reasonなど文字列の無害化は生成側の責務                                                                                                                                              |
| `ProviderRegistry.constructor/get/all`             | 同じidは後勝ち。allは新配列で、provider本体は共有                                                                     | 空registry、重複id、getの未登録、配列変更の独立性は直接テストなし                                                                                                                   |
| `ProviderRegistry.listSessions`、map/sort callback | 並列読込、破損/実体なし警告、派生除外で空の警告、fallback理由の警告、例外時の継続、降順ソート、0以下上限              | 警告3系統・非Error例外・全provider失敗・上限0以下・同時刻の順序は直接テストなし。同時刻は読込完了順に依存する                                                                       |

## テスト内容

`concurrency.test.ts`の5件は遅延をずらした入力順、同時実行数の上限と並列性、空入力の未呼出し、limit=0の逐次実行、rejectを確認する。テスト内のtimerとworker内分岐を確認した。limit>件数・負値・同期throw・失敗後の継続は未検査。reject試験には完了前のworkerが残り得るが、共有状態を書き換えるfakeではない。

`serialQueue.test.ts`の5件は順序と最大active数、異種の返値、2回の非同期失敗を挟んだ継続、同期throw、最初の1件を確認する。失敗Promiseへreject assertionを登録している。「最初の項目は即座に実行」という名前の試験はawait後の値だけを見ており、同期実行は保証しない。実装はPromise.thenによるmicrotaskで開始する。

`providerRegistry.test.ts`のlogger/session/provider fakeと5件を確認した。両者の日時順、CLI片側未検出、両側未検出、片側失敗の継続とerror記録、上限2を扱う。failed fixtureはErrorしか投げず、skippedIndexLines/unresolvedは常に0なので警告分岐を通らない。

この単位では新規の実利用不具合を確定していない。未検査の境界を「問題なし」と読み替えない。
