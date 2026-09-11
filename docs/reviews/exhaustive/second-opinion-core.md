# セカンドオピニオンの材料・起動・要約の精査

下表の21ファイルを全文で確認した。関数本体、早期return、例外、非同期の境界と、テストの準備・入力・期待値・後片付けを読んだ。テストは実行していない。

| 対象                                                                                           | 確認内容と不足                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| secondOpinion/wait.ts、view/secondOpinionParent.ts、view/handoff.ts、secondOpinionWait.test.ts | 親のbusy/queueによる待機、購読後の再確認、abort前後、タイマー解除と購読解除、親への転送とresolver再試行を確認。既定のretryは初回を含め4回。resolverのthrowは再試行しない。waitの購読は同期通知しない契約。テストの通知はlistener配列のコピーを走査し、実viewの通知・解除との統合は確認しない。承認待ちやループ評価中はidle判定の直接条件に入らない。                                                                                                                                                                                                         |
| secondOpinion/handoff.ts、secondOpinionHandoff.test.ts                                         | JSONフェンス抽出、複数ブロック拒否、JSON構文・object・必須文字列・trim・各8,000文字上限、optional summaryを確認。有効ブロックの後ろに閉じていない第2ブロックがある場合は抽出件数に入らない。フェンス全体のMarkdown構造、未閉鎖ブロック、サロゲート境界、全必須キーそれぞれの欠落は直接テストしない。                                                                                                                                                                                                                                                         |
| secondOpinion/redact.ts、redact.test.ts                                                        | PEM、URL資格情報、Authorization、既知token形式、汎用代入の順序、placeholder・短い値・裸の識別子の除外、件数集計と集計結合を確認。引用符内の空白で値が切れる問題はEX-REDACT-01。テストは引用キー、既知形式、通常識別子などを扱うが、PEM・URL・各header・引用値内の空白を一通り確認する内容ではない。                                                                                                                                                                                                                                                          |
| secondOpinion/summaryRollout.ts、summaryRollout.test.ts                                        | sessionIdを含む候補列挙、単一候補、先頭metaのid照合、再試行、読取失敗、削除失敗の吸収を確認。候補絞込みはファイル名だけでなくパス全体のincludes。meta照合が別sessionの削除を防ぐ。テストは仮想Mapであり、Nodeの列挙・読取・削除factoryを通さない。先頭行が部分書込み中でJSON不正なら再試行しない。                                                                                                                                                                                                                                                           |
| secondOpinion/untracked.ts、secondOpinion/snapshot.ts、secondOpinionUntracked.test.ts          | Gitのroot/status/diff/ls-files、HEADなし退避、untrackedのbyte予算、パス境界、realpath、open/fstat/read/close、binary判定、読取失敗と省略理由を確認。競合はEX-UNTRACKED-01、一覧失敗の黙殺はEX-SNAPSHOT-01。relative.startsWith('..')で内部の..cacheも拒否する点はEX-ACT-01と同型。先頭8,192byteだけのbinary判定、stat後の増大、root自体のsymlinkは未検証。テストは最初から存在する外向きsymlinkを確認するが差替え競合は作らない。                                                                                                                            |
| secondOpinion/candidates.ts、secondOpinion/run.ts、secondOpinion.test.ts                       | 候補最大20件、文字列長・制御文字・model/effort形式・重複・既定値への退避、read-only/neverとMCP・skill無効化、単発実行のtimeout/abort/部分回答、引継ぎ時だけsession保持、親/run別registryのbegin/cancel/endを確認。FakeSessionは即時通知主体。snapshotの「HEAD差分を1回」は呼出回数をassertせず、実Gitの一貫した時点も保証しない。loggerやcallbackの同期throw、実プロセスとの競合は直接確認しない。材料時点の不一致はF21-02。                                                                                                                                 |
| secondOpinion/diffBudget.ts、secondOpinionDiffBudget.test.ts                                   | diff/header/hunkの分割、binaryと生成物の分類、予算内原文維持、binary除外、生成物の大きい順の除外、header保持、小さいhunkからの採用、元順序復元、省略通知とUTF-8予算を確認。header自体が予算を超える場合は上限超過を許す。Gitがquoteした特殊パスはdecodeしない。テストはhunk本文の@@、巨大header、日本語byte数などを扱うが、実Gitの特殊パス出力や改行なし末尾は確認しない。                                                                                                                                                                                   |
| secondOpinion/prompt.ts、secondOpinion/summary.ts、secondOpinionSummary.test.ts                | 信頼しない材料のフェンス長、材料3種、依頼位置、差分省略/部分採用、未追跡内容、追伸、材料更新通知とrevision、handoffのJSON指示を確認。要約は会話の先頭20%・末尾80%、最大30,000文字、隔離tmp、read-only/never、2分timeout、空応答・失敗・中断、sessionとtmpとrolloutの後片付けを確認。要約の2,000文字は指示であり出力長強制ではない。通常レビューとは異なり要約ではskillsを明示無効化しない。テストは隔離・削除順・空会話・分割・設定を扱うが、mkdtemp失敗・実CLI・実token上限は確認しない。未追跡の省略一覧は件数上限がなく、材料予算とは別にpromptが増える。 |

## EX-REDACT-01[P1]:引用された秘密値の空白以降が伏せられない

src/secondOpinion/redact.ts:176付近の汎用代入規則は、引用符内でも空白・comma・semicolonなどを値の終端として扱う。空白を含むpasswordは先頭部分しかcaptureされない。先頭部分が8文字未満なら短い値として原文全体を残し、それ以上でも後半が残る。

src/loop/goalDraftProcess.ts:71、src/loop/loopAdvisorProcess.ts:62はこの関数を通したpromptを外部Providerへ渡す。伏せ字を呼ばないF21-01とは異なり、呼んでも漏れる経路である。引用値の全体を、escapeも含めて認識して伏せる必要がある。既存テストには引用値内の空白を含む入力がない。実際の秘密値・外部送信による再現は行っていない。

## EX-UNTRACKED-01[P1]:実パスの確認とopenの間に差し替えられる

src/secondOpinion/untracked.ts:131でrealpathを確認した後、:140でそのパスをopenする。この間にファイルまたは親ディレクトリを外向きsymlinkへ差し替えると、openしたfdは確認時と異なる外部ファイルを指しうる。fstatは通常ファイルかとサイズしか確認せず、root内か・同じinodeかを確認しない。

snapshotからレビュー材料へ進む経路であり、workspace内のパスを変更できる主体が存在する競合条件付きの読出し問題。fdから読むことだけではopen前の競合は防げない。親経路を含む原子的な境界維持、または開いた対象の検証が必要。既存テストは静的なsymlinkのみで競合を検証しない。実機での再現は未実施。

## EX-SNAPSHOT-01[P2]:未追跡一覧の取得失敗を「未追跡なし」と扱う

src/secondOpinion/snapshot.ts:269付近はls-files失敗時にfilesとomissionsを空配列へ落とす。追跡済み差分があれば成功した材料として返り、新規ファイルを確認できなかったことが表示されない。新規ファイルだけなら変更なしと誤認する経路になる。

secondOpinionUntracked.test.tsの失敗ケースも空のomissionsを期待し、この区別の欠落を固定している。継続自体は可能でも「一覧取得失敗」を省略理由として残す必要がある。実Gitの失敗は再現していない。

## 制約

上表のsrcはsrc/、testはtest/unit/の配下。display、view本体、セカンドオピニオンmanager、追加テスト・評価benchはこの記録の対象に含めない。テスト、lint、型チェック、外部CLI、攻撃の再現は実行していない。
