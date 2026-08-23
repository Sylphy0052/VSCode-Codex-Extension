# WF-G 横断の仕上げ

第3波 仕上げ。

全体の骨格は
[review-and-feature-consolidation.md](../review-and-feature-consolidation.md)
を見ること。運用規約は [ops-rules.md](../ops-rules.md)、番号の割り当ては
[numbering.md](../numbering.md) にある。

書き手: **WF-Gの担当セッションだけが書く。**

- **WF-G 横断の仕上げ**（18項目）
  - T26 eslintへ型情報を要するルールを導入し、未処理Promiseを機械的に検出できるようにする
    **当初の前提は `chatScript.ts` 1ファイルだったが、実測は3ファイル4739行である**
    （2026-08-23、第2回の途中で測り直した）。`chatScript.ts` 2476 /
    `controlPanelScript.ts` 1141 / `workflowScript.ts` 1122。
    **前提の出どころはWF-Fの見積りで、チャット画面という担当領域の内側で数えたため
    1ファイルになった。**T26は「テンプレートリテラルで型検査が効かない場所」という
    横断の条件で切るもので、担当領域で切ると `workflowScript.ts` と
    `controlPanelScript.ts` が落ちる。
    **検出は `grep -rln "acquireVsCodeApi" src/view/*.ts` で引くこと**
    （`conversationView.ts` 224行も返るが、これはHTMLを組み立てる側なので除外）。
    `grep -rln "型検査もlintも効かない" src/` は使わない——`workflowScript.ts` の
    ヘッダでその一文が折り返し、「型検査もlintも」と「効かない」が別の行にあるため
    **取りこぼす**。
    **ラベル表は16あり、3階層に分かれる。直し方が違う**（以下は #527 時点の観測。
    **着手時に測り直すこと**——#645 のマージで `FAILURE_LABEL` の件数が11→12へ動き、
    この数字は書いた直後に既に古くなった）。
    (1) **`Record<UnionType, string>` — tscが網羅を強制する。2件。何もしなくてよい**
    （`src/extension.ts:2232` `ACTION_LABELS`、`src/provider/import.ts:110`
    `ITEM_TYPE_LABEL`）。値を足してラベルを足し忘れるとコンパイルが落ちる。
    **「確認して、何もしなくてよいと分かった」を書き残すこと**——書かないと次の人が
    同じ確認をやり直す。
    (2) **`Record<string, string>` — 型は付いているが開いている。7件**
    （`appserver/autoApprovalReview.ts:23` / `appserver/chatState.ts:569`・`578`・`881` /
    `appserver/transcriptMarkdown.ts:15`・`33` / `view/settingsProvider.ts:1048`）。
    **直し方はテストではない。キーのunion型を作って `Record<UnionType, string>` に変える**
    ——(1)の形にすればtscが守る。T26（型情報ルールの導入）の本題そのもの。
    (3) **テンプレートリテラルの中 — 型検査が届かない。7件**
    （`chatScript.ts:92` `KIND_LABEL` / `:159` `STATUS_LABEL` / `:1338` `TODO_MARK` /
    `:1717` `EXTRA_USAGE_DISABLED_REASON_LABEL` / `:1805` `LOOP_STOP_LABEL` /
    `workflowScript.ts:19` `STATE_LABEL` / `:31` `FAILURE_LABEL` / `:975`
    `PROGRAM_SKIP_REASON_LABEL`）。型注釈を書く場所が無いので、
    `test/unit/webviewScript.test.ts` が `FAILURE_LABEL` にやっている形
    （対応する型定義をソースから抽出してキーを突き合わせる）しか手が無い。
    **「同じテストを繰り返すだけ」ではない。抽出の形が4種以上ある**——
    `FAILURE_LABEL` は `| { readonly kind: 'x' }` の複数行union、
    `PROGRAM_SKIP_REASON_LABEL` は同じunionだが**1行書き**で範囲の切り出しが効かない、
    `LOOP_STOP_LABEL` は `| 'maxReached'` のstring literal unionで正規表現が別物、
    `STATE_LABEL` は `(typeof TASK_STATES)[number]` で配列リテラルからの抽出が要る。
    そして **`EXTRA_USAGE_DISABLED_REASON_LABEL` は閉じた型が存在しない**
    （CLIの語彙をそのまま受けている）ため、**網羅を主張する相手がおらず同じ検査は
    原理的に書けない**。型を作るところからになる。
    **追いIssueに「6回繰り返すだけ」と書かないこと**——着手した人が最初の1つで止まる
  - [#491](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/491)
    終了したrunを `retry_task` で再開してもオーケストレーターの制御ツールが復活しない
  - [#502](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/502)
    dispose()後に宙に浮いたstartTaskの継続がCLIセッションを起動しうる。
    **2026-08-23に再現を確認済み（RED実測つき、Issueのコメントに全文）。実害として直す。**
    `pump()` が `void this.startTask(...)` を await せずに呼び、`startTask` は複数の `await` 点を
    経て `prepareTaskLaunch` に到達する。`WorkflowRunner.dispose()` は同期関数のため、
    その間に dispose が走ると、既に dispose 済みの状態でCLIセッションが起動しうる。
    実測で分かったこと: **`disposing` を見ている箇所は5つあるが、`startTask` の継続を中断する
    ものは1つも無い。** `ensureMessaging` の入口ガード（#475 / PR #495 由来）はメッセージング
    資源だけを守って早期returnし、`prepareTaskLaunch` はそのまま先へ進む。**そのガードの
    コメント自身がこの窓の存在を明記していた**（書かれていたのに拾われなかった）。
    被害は「起動しうる」で止まらず、`dispose()` 後に到達したセッションは `disposed=false` の
    まま `live.tasks` へ入るため、**dispose() の解放対象を外れて閉じる経路が二度と無い**。
    直すときは、そのガードのコメントも一緒に更新すること
    **完了。PR #642が2026-08-23にmainへマージ済み（マージコミット
    `2a59aec4`）。**`startTask` 内・`host.openTaskSession` 呼び出しの
    直前へ `this.disposing` のガードを置いて窓を塞いだ。`live.finished`
    は使っていない（`retryTask` が `false` へ戻すため）。`ensureMessaging`
    の入口コメントも「ここはメッセージング資源だけを守る、継続の番人は
    `startTask` 側」と書き分けた。既存テスト（`test/unit/runner.test.ts`、
    Issue #475 / PR #495由来）は**古い挙動を前提にしていたため期待値・
    表題・JSDocを更新した。**再現テストは `test/unit/runnerDispose.test.ts`
    を新設。design.mdへ§16.38を新設。
    **第1回で `test/unit/runner.test.ts` を2つのPRが同時に触った**
    （#641が8838行目付近へテストを追加、#642が12001行目付近の
    既存テストを更新）。同じファイルの離れた場所だったため衝突は
    出なかった。**衝突が出なくても、衝突解決で片方の枝が黙って消える
    形は起こりうる。**その場合 `tsc --noEmit` もlintもテストも緑のまま
    通るため、検査では捕まらない。したがって**マージ後に、各PRが
    入れた枝を名指しでgrepして実在を確かめる**。確認は2つの層で
    独立に行った（WF-G担当と全体オーケストレーターが別々のパターンで
    引いた）。**確認は実装側とテスト側の両方で行った**——テスト側だけを
    見ても、実装側の枝が消えていれば分からない。実例: `grep -c
    "ORCHESTRATOR_CONTROL_TOOLS" test/unit/runner.test.ts` の出力は
    `3`（**PR #641が追加した枝**）。`grep -n "dispose()後に
    retryTaskで再開してもCLIセッション" test/unit/runner.test.ts` の
    出力は`12041:    it('dispose()後にretryTaskで再開してもCLIセッ
    ション・MCPサーバ・タイマーを新たに立てない', async () => {`
    （**PR #642が更新した既存テストの枝。2つのPRが同じファイルを
    触った場所はここ**）。`grep -c 'dispose()後に宙に浮いていた
    継続の再開を止める' src/orchestrator/runner.ts` の出力は`1`
    （**PR #642が実装側へ入れたガード本体**）。`ls
    test/unit/runnerDispose.test.ts` は`test/unit/runnerDispose.test.ts`
    を返し、**PR #642が新設したファイル**の実在も確認した
  - [#485](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/485)
    疑似worktree反映: renameの必須化と一時ファイルの掃除
  - [#490](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/490)
    worktree撤去の試行回数に上限が無い（git側・疑似worktree側の両方）
  - [#524](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/524)
    警告ポップアップの「詳しくはログ」に出力チャネルを開く導線が無い
  - [#527](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/527)
    複数の親からブロックされた後続が、停止解除後に自動復帰しない
    **完了。PR #645が2026-08-23にmainへマージ済み（マージコミット
    `1a5a11da`）。**`TaskFailureReason` へ `mergeBlockedWhileHalted` を新設し（11→12種）、
    `markMergeSucceeded` が停止中に倒す先をそれに変え、復帰フィルタが
    `mergeBlocked` と併せて2つを見るようにした。`blockedTaskIds` は倒す前から引き継ぐ。
    design.mdへ§16.40を新設、manual-test.mdへW-Sを追加。
    **担当が最初に立てた案（判断軸を「`dependsOn` が全て `done` か」へ置き換える）は
    採らなかった。**採らなかった理由が§16.40に残っている——復帰条件を「マージブロック
    だったか」から「依存が揃ったか」へ広げると、停止時にまだ `pending` だっただけの
    子孫まで巻き込む。**原因は「区別が記録されていないこと」であり、区別を条件で
    補おうとすると別の巻き込みを生む。だから区別そのものを状態へ記録した。**
    **`runHalted` を書く経路は3つあり、そのうち1つだけが由来が違った**
    （`skipRemainingPending` と `reconcileRunOnReload` は `pending` から、
    `markMergeSucceeded` だけが `skipped(mergeBlocked)` から）。**1つの値が由来の違う
    2種類を指していたのが原因そのもの。**
    **`blockedTaskIds` は判定に使われていない**（読み手は `markMergeBlocked` の累積と
    `workflowScript.ts` の括弧書き表示だけ）。だから「どの親でブロックされていたか」を
    復元する必要は無く、`pending` へ戻して `nextTasksToStart` の依存充足チェックに
    委ねられる。**停止を挟むと括弧書きが消えていた既存の欠落も、引き継ぎで直った。**
    **第2回（#589 / #502 / #579 / #527、いずれも2026-08-23）の記録。**
    **第1回で決めた「マージ後に各PRの枝を名指しでgrepする」は今回も実行した**が、
    **確認対象に存在しないものを1つ混ぜてしまった。**全体オーケストレーターが
    「#643の枝と#644の枝が両方あること」と書いたが、**#644 は棚を触っていないので
    #644の枝は存在しない。**担当は実行前にこれを見つけられなかった。理由が本質で、
    **検査は「見つからない」を返すだけで、それが「消えた」なのか「もともと無い」なのかを
    区別しない。**今回は無害だったが、同じ形で「確認したが見つからなかった」を「消えた」と
    読めば差し戻しの理由になる。**確認対象を並べるとき、各項目が「あるはず」なのか
    「無いはず」なのかを先に書くこと。**書かないと0件がどちらの意味かを事後に決めることに
    なり、そのとき都合のいいほうへ倒れる。
    **`.agents/handoff/` の削除は #644 で守られず、#645 で守られた。**
    PR #638 で「Issueをクローズするコミットで同じく削除する」と決めた直後の #644 が
    `wf-g-issue-579.md` を残した（本PRで回収）。#645 は指示に「#644 で守られなかった」を
    添えたら守られた。**規約は「書いてある」だけでは守られず、「直近で破られた」を
    添えて初めて守られる。**
    **前の回の申し送りは、効く範囲を測ってから渡すこと。**#527 の申し送り5件のうち
    2件（`TaskFailureReason` は12種 / `toHaveLength(12)` がまた RED になる）は、
    第3回の #533・#599 には効かなかった——どちらも `runState.ts` に触らないため。
    効かない項目が混ざっても害は無いように見えるが、**受け取る側は「全部関係がある」と
    読んで確認に時間を使う。**
    **Issue本文のコード引用は、起票時点のスナップショットであって現在の実態ではない。**
    #599 本文が両ファイル同じコードとして1つだけ引いていた箇所は、実測では片方が
    `Codex:` の直書き、もう片方が `${LABEL}:` の変数だった。#533「純粋関数へ切り出す」の
    設計が変わる差である
  - [#533](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/533)
    セッションのタブ名の組み立てがユニットテストで検証されていない。
    **#599 と同じ回で扱う**（テストの無い関数の優先順位を変えるため、先にテストを置く）
  - [#599](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/599)
    ワークフローが開くセッションのタブ名をオーケストレーターが指定し、上書きされないようにする。
    `openTaskSession`は開くときにタブ名を渡しているが、**通常タスクは`Codex`/`Claude`だけで
    taskIdが入らない**（衝突解決セッションには`衝突解決 <taskId>`が入る。PR #532）。
    並列に開いた複数タスクのタブが全部同名になる。しかも**その初期タイトルは後から
    `deriveTitle`に上書きされる**——`deriveTitle`の優先順位は`state.name`（app-serverの
    `thread/name/updated`由来）→ 最初の発言の要約、の2段で、`openTaskSession`が渡した名前は
    どこにも残らない。`pinnedName`を足して`deriveTitle`の最優先に置き、通常タスクにも
    taskIdを含める。**#533 と同じ回で扱う**（#533の「タイトル組み立てを純粋関数として
    切り出し3分岐まとめて扱う」と作業が重なる）。
    動機は2026-08-23の実例——並列で動く5つのセッションが自動生成名だったため、
    どれが何の担当か分からず**身元確認の往復が4回必要になった**。自動生成名は再開のたびに
    変わるため識別子として使えない（Claude Code側は `claude -n <name>` で固定できる）
  - [#541](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/541)
    統合テスト C-42 が並列負荷下で間欠タイムアウトし、統合テスト全緑がEvidenceにならない。
    **再現は1回のみで成立未確認。着手する場合は修正から入らず再現条件の特定から始め、
    再現しなければ直さずに報告して閉じてよい。** 対象は1テストではなく
    `test/integration/helpers/waitFor.ts` を使う統合テスト全体の待ち方であり、
    C-42 に個別タイムアウトを与える対処は次に別のテストで同じことを起こす。
    Issue #522（PR #523で解消）と同じクラスで、**そこで実際に起きた害は
    「テストが落ちること」ではなく「実装者が失敗を無視する習慣をつけたこと」だった**
    **L-40（`test/integration/chatClaudeSettings.test.ts:444`
    「行頭#はCLIへ送らず、確認後にCLAUDE.mdへ直接追記する」）でも
    同種の間欠失敗を1回観測した**（2026-08-23、WF-G第1回の統合テスト
    実行時）。全体実行で1回失敗し、`--grep "L-40"` の単独実行では成功、
    全体を再実行すると81 passing / 0 failingに戻った。
    **L-40も`test/integration/helpers/waitFor.ts`を使っている**
    （テスト本体の中で2回）。C-42（`test/integration/
    chatCodexThreadFlow.test.ts:364`）と同じヘルパーである。実測で
    確認済み。したがって**調査対象はC-42とL-40の両方**とし、
    `waitFor.ts` を使う統合テストを網羅的に洗い出したうえで待ち方
    そのものを見る。**ただしこれは観測であって、原因が順序依存だという
    断定ではない。** **L-40を足したことで、この項目のクローズ条件を
    厳しくしない。**2つとも再現しなければ、2つとも再現しなかったと
    報告して閉じてよい
  - [#551](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/551)
    prettierの設定とコードが乖離している（121ファイル非準拠、lintが見ていない）。
    **T26と同じlint基盤の作業のため同じ回で扱う。** 一括 `prettier --write .` は開いているPRが
    無いときにしかできない（121ファイルへ同時に手を入れるため進行中のPRが全て衝突する）
  - [#562](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/562)
    権限昇格の検出（`messagingPermissionEscalation`）がW9以降 恒常的に不発火である。
    **まず「復活させる」か「削除する」かを決める作業であり、復活を既定として着手しないこと。**
    W9でメッセージングをオーケストレーター中継型にした結果 `from` が常に `-orchestrator-` になり、
    `checkMessagingPermissionEscalation` は全反復で `continue` して警告を出さない。
    型検査もlintもテストも通るため機械的には検出できず、**関数名と実装だけを読むと
    動いている防御に見える**。復活させる場合の設計の本体は由来の追跡情報を足すことではなく、
    **オーケストレーターが本文を書き換えられる以上、由来と本文の一致をどう保証するか**である
  - [#579](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/579)
    `waitingApproval`のタスクが無期限に並列枠を占める。
    **2026-08-23に再現を確認済み（RED実測つき、Issueのコメントに全文）。実害として直す。**
    通常タスクの`waitingApproval`に**時間ベースの解放は無い**。抜ける経路は4つ（承認決定 /
    `stopTask` / `stop` / セッション終了・リロード）で、すべて人か外部要因である。
    `mergeApprovalTimeoutSec`は解放にならない——`scheduleApprovalTimeout`の呼び出し元は
    `runnerMerge.ts:930`（`startMergeResolution`内）の**1箇所のみ**で衝突解決セッション限定、
    `excludeFromActiveCount`も`live.mergeResolutions`しか集めない。
    **実害と判定した決め手は副次効果である。** `waitingApproval`が1件あると
    `detectAllWaitingStalemate`が成立せず、**他タスクの返信待ちの解放まで止まる**
    （`{A:waitingApproval, B:waitingReply, C:waitingReply}` → `[]`、Aも`waitingReply`なら
    `['A','B','C']`）。承認待ちに解放が無いだけなら「人が承認するのが仕様」で済むが、
    **その状態が別の自動解放を無効化するなら解放機構の側の欠陥である**。W8（`ask_user`）・
    W10（自動再開）で無人運転へ寄せている方向とも整合しない。
    近いが別のIssueとして #413・#539（どちらも衝突解決セッションの承認待ち、クローズ済み）が
    あるが、そこで入った除外もタイムアウトも通常タスクには適用されていない。
    出どころはW7（#571）のセキュリティ監査のlow指摘で、W7の範囲外として記録だけ残したもの
    **完了。PR #644が2026-08-23にmainへマージ済み（マージコミット
    `b2354234`）。**`taskApprovalTimeoutSec` を新設し、超過した通常タスクの
    `waitingApproval` を `failed` + 新しい理由 `taskApprovalTimedOut` で解放する。
    design.mdへ§16.39を新設（§16.16の件数も16へ再導出、§16.17を更新）、
    manual-test.mdへW-Rを追加。
    **`approvalTimedOut` ではなく `taskApprovalTimedOut` にした。**`approvalTimeout`
    という語は既に衝突解決セッションの経路を16箇所で指しており、**倒す先が違う**
    （あちらは `blocked`、こちらは `failed`）。**1つの語が2つの意味を持つと、
    判定側で分離できなくなる**——これは #527 で `runHalted` が実際にそうなっていた形と
    同じで、#527 の直し方（区別を状態へ記録する）もここから来ている。
    **`FAILURE_LABEL` の網羅テストをこのPRで入れた**
    （`test/unit/webviewScript.test.ts`）。`TaskFailureReason` の定義ブロックから
    kindを抽出して件数を固定し、ラベル表と突き合わせる。
    **件数を固定した理由がテスト自身のコメントに書いてある**——「範囲の切り出しに失敗すると
    0件になりうる。0件だと後続の検査が何も検査しないまま素通りしてしまう」。
    **抽出の正規表現を `TaskFailureReason` の定義ブロックに限らないと
    `AutoResumeOutcome` の4件が混ざる**（担当と全体オーケストレーターがこの取り違えで
    11と15に割れた）。その取り違えを `not.toContain` の主張に変換してテストへ入れてある。
    **これが #527 で新kind名の衝突検査として実際に効いた。**
    **取り違えを直すときは、同じ取り違えが次に起きたら機械が落ちる形にしてから閉じること。**
    **そして、そうして入れた検査が後の変更で RED になっても、緩めたり削ったりしないこと**
    ——変更した側から見れば「自分のせいで落ちたテスト」なので、最小の手当ては検査を
    消すことになる。そこで検出力が消える。#527 の指示にはこの一文を明示的に入れ、守られた
  - [#589](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/589)
    オーケストレーターへの案内文（`buildIntroBody`）に`decide_final_merge`だけが列挙されていない。
    W1（#335）が道具を足したときの列挙漏れで、**W8より前からある既存の穴である**。
    `ask_user`の拒否文が「最終マージの判断であれば`decide_final_merge`のholdで止めてください」と
    案内している一方、その道具の存在は案内文に無いという食い違いも生じている。
    直すのは1行だが、受入基準は**`ORCHESTRATOR_CONTROL_TOOLS`の全要素と案内文を突き合わせる
    テストを置くこと**まで含む（片方だけ足して他が漏れる形をここで終わらせる）。
    出どころはW8（#583）の実装中、`ask_user`を案内文へ足す作業の隣で見つかったもの
    **完了。PR #641が2026-08-23にmainへマージ済み（マージコミット
    `c9a376f6`）。**`buildIntroBody` へ `decide_final_merge` を足し、
    `ORCHESTRATOR_CONTROL_TOOLS` の全要素が案内文の道具の列挙行に1つ
    ずつ現れることを確かめるテストを `test/unit/runner.test.ts` へ置いた。
    突き合わせの結果、**漏れていたのは `decide_final_merge` だけ
    だった**（11要素を行で確認）。design.mdは新規節を作らず§16.33の
    既存節を更新
  - [#624](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/624)
    READMEがWF-Eで入った設定・コマンド・プログラム機能を反映していない。
    実測（WF-E担当、2026-08-23）: 設定22件のうち**8件**が未記載
    （`mergeApprovalTimeoutSec` / `reviewCommentPollIntervalSec` /
    `createTaskIssue` / `reviewTaskPullRequest` / `stallRepeatCount` /
    `maxAskUserPerRun` / `autoResume` / `maxAutoResumeAttempts`）、
    コマンド8件のうち**3件**が未記載
    （`menu` / `runProgram` / `stopProgram`）。W12の「プログラム」機能への言及は実質ゼロ
    （ヒット1件はMCP elicitationの文脈で無関係）。
    **WF-E本体ではなく後追いの文書作業としてここへ置く。**
    W2〜W6・W8・W10・W12の8項目にまたがり、**どの項目の受入基準にも入っていなかった**ため、
    WF-Eの完了条件には含めない（epic #341のクローズ条件からも外してある）。
    着手はWF-Eの統合PRがmainへ入った後。**未リリースの機能をREADMEへ書いても実機で
    確かめられない**ため
  - [#630](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/630)
    `docs/manual-test.md` のC群・L群の内訳3行（機械 / 一部機械 / 実機）が排他でなく、
    どの行にも出てこない見出しが16件あった。**PR #634 で解消済み**（3行を排他の分割へ作り直し、
    見出しには「全51件。うち文書に手順が残るのは38件」の形で母数を2つ書いた）。
    棚に残すのは、この形の腐りが**件数を合わせるだけの修正では隠れる**ためで、
    次に群を足す人が同じ確認をできるようにしておく
  - [#636](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/636)
    `docs/roadmap/ops-rules.md` へ足す規約を溜める箱（#622の後継）。
    **単独PRを刻まず、溜まってから1本で出す。** 規約が1項目ずつ別PRで入ると、
    レビューする側が「この項目だけ見ればよい」と読み、一覧全体の重複や矛盾に気付けなくなる
    **WF-Gは規約の候補を溜めて全体オーケストレーターへ渡すところまでを
    担う。`ops-rules.md`へ実際に書くのは全体オーケストレーターである。**
    理由: `ops-rules.md`は「全体オーケストレーターだけが書く」と定めて
    おり、WF-Gの担当も書き手にすると同じ文書に複数の書き手ができる。
    並行する書き場ができて二重管理になる事故（PR #612）を自分から
    作りに行くことになる
  - 全体レビュー（第1波・第2波の全変更を横断でレビューする）
  - 依存: 第1波・第2波の全完了
  - ファイル: `src` 全域（型情報ルールの導入は全ファイルへ波及する）
  - **申し送り**（2026-08-22、WF-A2 の担当から）
    - **#491 をここへ送った理由**: オーケストレーターのMCP URLはCLIプロセスの起動時に固定される
      （Codexは `thread/start` の `config.mcp_servers.<name>`、Claude Codeは `--mcp-config`）。
      サーバを立て直しても既存プロセスは古いURLを掴んだままなので、Issue #475 の案A
      （hubを捨てず再利用する）では救えない。救うにはオーケストレーターセッションの再起動か
      URLを差し替え可能にする設計変更が要り、WF-A2 の追いIssueの範囲を超える。あわせて
      #401 の方向(b)が制御ツールの可視性そのものにガードを足すため、**その着地を見てからでないと
      正しい形が決まらない**
    - **`chatScript.ts`（2333行）はテンプレートリテラルのため型検査もlintも効かない。**
      WF-G は型情報を要するeslintルールを入れる回なので、この負債も同じ回で扱うのが筋
      （型検査が効かないファイルが残っていると、型情報ルールの効果がそこだけ穴になる）。
      **この申し送りの出所は WF-F の担当**（X1〜X3 の着手前に自分の担当範囲として検分した結果）。
      `renderShell` の `chatShared.ts` への分離は WF-C が行った別件で、そちらは完了済み。
      残っているのはこの負債だけ。
      解消に要ると見積もられているのは、webview JS の実ファイル化とビルド導入（esbuild等）・
      CSP / nonce の見直し・エスケープ規約の全面的な書き換えの3点。
      **WF-F が検分したうえで「X1〜X3 では分離しない」と判断している**（X1〜X3 が触るのは
      `renderMarkdownInto` 付近と分岐・脇道質問のハンドラのみで局所的な一方、大規模移設は
      CI落ちと回帰の両リスクが高く、カバレッジ下限の余裕も小さいため）
    - **`chatScript.ts` のコメントにバッククォートを書かない。** テンプレートリテラルが切れて
      `tsc` が壊れる
  - **WF-A2から統合PR前に線引きした5件を送る**（2026-08-22、WF-A2 の担当から）
    - WF-A2の成果を統合ブランチへ置き去りにするのが最悪の結果であり、それに比べれば
      残件がWF-Gへ送られるのは小さい問題だと判断した。線引きの基準は、実害のある欠陥
      （データが届かない・runが終わらない）と誤った記録を残すもの（無効なテスト）は必ず入れる。
      テストの不足そのもの・可視化や導線・回避手段のある振る舞いの後退は送る、というもの
    - [#485](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/485)
      疑似worktree反映: renameの必須化と一時ファイルの掃除。`rename` を提供しないポート向けの
      後方互換経路（一時ファイルを使わない直接コピー）は、書き込み先の名前が `relPath` から
      予測可能なままのため、境界外の既存ファイルを上書きし、ロールバックがそれを削除しうる
      （任意ファイル破壊）性質を残している。
      **送る理由**: 本番で実際に使われるポート（`nodePseudoWorktreeFileSystem`）は `rename` を
      持つためこの経路には落ちない。残存リスクとして [design.md](../../design.md) §16.20 に
      **正直に記述済み**であり、「守られている」という誤った記録にはなっていない
    - [#490](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/490)
      worktree撤去の試行回数に上限が無い（git側・疑似worktree側の両方）。
      `retryCount + manualRetryCount` に上限が無く、撤去時の処理コスト（`realpath` +
      ブロッキングI/O）が線形に増加する。
      **送る理由**: 実害は処理コストのみ。データ消失も境界越えも無い（各撤去は個別に境界
      チェックを通る）。PR #477 / #483 / #488 の監査で3回lowとして挙がり、いずれも
      「既存のパターン」として据え置かれてきた。**git側と疑似worktree側の両方をまとめて
      直す必要がある**（片方だけだと対称性が崩れる）
    - [#524](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/524)
      警告ポップアップの「詳しくはログ」に出力チャネルを開く導線が無い。
      **送る理由**: 可視化・導線の改善であり、振る舞いの欠陥ではない。
      `（詳しくはログ）` という文言は既存の6箇所で同じ形で使われており、**この1箇所だけ
      直すと不揃いになる。** 6箇所まとめて扱うべきで、それはWF-A2の追いIssueの範囲を超える
    - [#527](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/527)
      複数の親からブロックされた後続が、停止解除後に自動復帰しない。PR #517（Issue #432）の
      副作用。`markMergeSucceeded` の復帰対象フィルタが `s.failure?.kind === 'mergeBlocked'` を
      要求するが、停止中に `runHalted` へ書き換わったタスクは以降このフィルタに掛からない。
      **送る理由**: 詰みではない（当該タスク自身へ `retryTask` を呼べば救える）。修正前の
      全体挙動は「停止が解除されれば自動復帰するが、解除されなければ回収できない `pending` が
      生まれる」というより悪いもので、PR #517はそれを解いた。**この後退を直すには、停止中の
      `failure.kind` の扱いを設計から見直す必要がある**ため、局所修正では戻せない
    - [#533](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/533)
      セッションのタブ名の組み立てがユニットテストで検証されていない。`chatView.ts` /
      `claudeChatView.ts` のパネルタイトル組み立てを直接検証するテストが無い。PR #532の
      可視化効果（タブ名にtaskIdを含める）はユニットテストのレベルでは未検証。
      **送る理由**: テストが**無い**のであって、あるのに何も検証していない（誤った記録が
      残る）わけではない。既存の `role === 'orchestrator'` 分岐にも同じ欠落があり、PR #532が
      持ち込んだものではない。直すにはタイトル組み立てを純粋関数として切り出す必要があり、
      3分岐まとめて扱うのが筋
    - **WF-A2が統合PRへ必ず含める分**（送る5件と対比するため記録する）
      - #528 / #529 / #530 無効なテストの修正、#531 テストの書き方の規約
      - Issue #413のPR5（承認待ちのアイドルタイムアウト）
      - #514 `stop_task` が衝突解決セッションへ届かず、届いていないのに成功を返す
      - #511 疑似worktree: baselineが更新されないため、再開後の2周目の統合内容が
        ワークスペースへ届かない。**#511を送らずに入れる理由**: runは成功して終わるのに
        成果物がワークスペースへ届かないため、実質的に「誤った記録」と同じ性質を持つ
  - **`chatScript.ts` の実ファイル化に着手する前に読むこと**（2026-08-22、WF-F の担当から。
    X1〜X3 で `renderMarkdownInto` 付近と Claude Code の control protocol 層を実際に触った結果）
    - **分割の本丸はビルド手順とCSPであって、行数ではない。** `chatScript.ts` は
      テンプレートリテラル1本で webview 用のJSを組み立てている。実ファイル化には
      (a) webview用JSを別ファイルへ出す、(b) それをバンドルするビルド手順を足す、
      (c) CSP / nonce の与え方を作り直す、(d) 現在テンプレート補間で行っている値の埋め込み規約を
      全面的に書き直す、が要る。**行数を機械的に割るだけでは終わらない**
    - **`${` とバッククォートの禁止は、移行が完了するまで残る。** 実ファイル化するとこの制約は
      消えるが、**移行の途中で消えたと勘違いすると壊れる。**完全に外へ出し切るまでは効き続ける
    - **型検査とlintが届いた瞬間に、既存の違反がまとめて表面化する。** いまこのファイルは
      `tsc` も `eslint` も効いていない。実ファイル化すると初めて届くため、既存のバグや規約違反が
      一度に出る可能性がある。**「移動するだけ」の想定で見積もると規模が膨らむ。**
      分割PRの見積もりへその修正分を織り込んでおく
    - **【分割PRのレビュー観点】Markdown描画のDOM構築が最も壊れやすい。** X1 で `createTable` /
      `createQuote` / `createList` を足した。`createList` は深さのスタックでネストを組み立てる、
      このファイルで数少ない状態を持つ箇所。またこのファイルは**エージェントの出力を信用しない
      描画**（HTML文字列を組み立てず `createElement` + `createTextNode` / `textContent` のみ、
      リンクの `href` は `'#'` 固定で実遷移は `postMessage`）を守っている。
      **移送の過程でこの規約が崩れると、そのまま XSS 経路になる。**分割PRのレビューでは
      この規約が維持されているかを独立した観点として確認すること
    - **TS実装と webview 実装の二重管理があり、パリティテストは片方へ寄せるまで消さない。**
      [markdown.ts](../../../src/view/markdown.ts) の `parseMarkdown` と、webview へ埋め込む
      `MARKDOWN_PARSE_SOURCE`（JSのソース文字列）が同じトークン列を返すことをテストで固定している。
      実ファイル化はこの二重管理を解消できる好機だが、**統合の際にパリティテストを消すと、
      TS側だけ直して webview 側が置き去りになる事故が検出できなくなる**
    - **`INLINE_RE` はキャプチャグループの位置に依存している。** X1 で `~~([^~]+)~~` を足したとき、
      それ以降のグループ番号が全部ずれた。正規表現へ何かを足すときは、**番号で分岐している箇所を
      全部見ること**
