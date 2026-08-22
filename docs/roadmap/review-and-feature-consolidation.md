# レビュー指摘と機能追加の統合ロードマップ

2026-08-22の全体レビューで挙がった26件の指摘と、同日のワークフロー確認で立てた8件の機能追加を
1本にまとめ、互いに干渉しない7つのワークフローへ再編したもの。

## きっかけ

この日、独立した2つのセッションが別々の成果を出した。

- **全体レビュー**: 50k LOC / 162ファイルを7領域で並列監査し、26件の指摘を
  [.agents/workflows/](../../.agents/workflows/) の3本のYAML（core / ui / final）へ計画としてまとめた
- **ワークフロー確認**: 拡張のワークフロー機能とチャット画面の不足を洗い出し、
  [workflow-autonomy.md](workflow-autonomy.md)（W1〜W5、epic [#341](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/341)）と
  [chat-conversation-parity.md](chat-conversation-parity.md)（X1〜X3、epic [#340](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/340)）を書いた

両者は同じファイルへ集中する。`runner.ts` は11項目が、`claudeChatView.ts` は7項目が触る。
別々に進めると統合ブランチでのマージ衝突が後段へ集中するため、34項目を統合して分割し直した。
あわせて、後述の運用規約から導かれる項目をW6として1件追加した（計35項目）。

## docs/roadmap/ の4本の関係

- [ux-improvements.md](ux-improvements.md) — R1〜R11。**全項目完了済み**（epic #297 もクローズ）。
  記録として残してある
- [workflow-autonomy.md](workflow-autonomy.md) — W1〜W5。本ロードマップの WF-E が担当する
- [chat-conversation-parity.md](chat-conversation-parity.md) — X1〜X3。WF-F が担当する
- 本ドキュメント — 上の8項目と全体レビューの26指摘を統合した、7ワークフローの分割と運用規約

## 方針

1. **ワークフロー同士がファイルを共有しない。** 分割の第一基準は担当領域の意味ではなく、
   触るファイルの集合が交差しないことに置く。交差するものは同じワークフローが持つか、
   波を分けて前後関係にする
2. **拡張のワークフロー機能は今回の実装には使わない。** 直す対象が runner の停止・dispose・
   worktree撤去・ループ制御そのものであり、走行中に自分の足元を掘ると原因の切り分けが
   できなくなる。機能としての検証（ドッグフーディング）は全実装の完了後に、安定した版で別途行う
3. **人が見るのは main へのマージだけにする。** タスク単位のPRはレビューを通したうえで
   統合ブランチへ自動でマージし、統合ブランチから main へのPRで人が判断する

## 分割の原則

全35項目について、触るファイルの集合から連結成分を求めた。結果、次の2つが大きなハブになる。

- `runner.ts` / `runnerOrchestrator.ts` / `runState.ts` を中心とするオーケストレーター実行系
- `claudeChatView.ts` / `chatView.ts` / `streamSession.ts` / `chatScript.ts` を中心とするチャットUI系

この2つは互いに交差しない。ハブを共有する項目は分割できないため、ハブ単位でワークフローを立て、
ハブに属さない項目（CI・ドキュメント・生成系）を独立させた。

`extension.ts` は T03（`context.subscriptions` への登録）と T19（`activate()` での `pruneCache` 呼出）が
触るため、この2件は同じワークフロー（WF-A）が持つ。

## ワークフローと波

波の内側は互いにファイルが交差しないため並列に進められる。波をまたぐ依存は一方向になる。

### 第1波 土台の修正（並列4）

- **WF-A オーケストレーター実行系**（11項目）
  - T02 `waitingReply` のタスクがターン失敗時に確定せず並列枠を占有する
  - T03 `WorkflowRunner.dispose()` がどこからも呼ばれない
  - T04 再試行時のworktree撤去が誤ったディレクトリを対象にする
  - T07 疑似worktreeの統合・反映で未ハンドルrejectが起き `merging` のまま枠を占有する
  - T08 「全体の停止」が衝突解決セッションを止めない／永続化の時点ずれ
  - T09 PR/MR操作の2件の不具合
  - T13 リロード復元後に統合成果がワークスペースへ届かない
  - T14 タスク間メッセージングの4件の不具合
  - T19 セッション一覧まわりの性能とキャッシュの3件
  - T20 オーケストレーターの警告が無制限に増える
  - T21 統合worktreeの排他制御の調査と修正
  - 依存: T08←T07 / T19←T03 / T21←T04, T13
  - ファイル: `src/orchestrator/runner*.ts`, `loopController.ts`, `runState.ts`, `forge.ts`,
    `integration.ts`, `pseudoWorktree.ts`, `messaging.ts`, `scheduler.ts`, `src/extension.ts`,
    `src/session/*`, `src/claude/sessionStore.ts`, `src/util/paths.ts`, `src/codex/cliLocator.ts`

- **WF-B 生成・安全系**（4項目）
  - T10 外部由来テキストの整形を1モジュールへ集約し、全プロンプト経路をそこへ通す
  - T15 ワークフロー生成（planner）の3件の不具合
  - T16 ロードマップMarkdownのパースを堅くする
  - T27 `slugifyGoal` の前処理にあるReDoSで長いゴール文がUIスレッドを止める（着手後に見つけて足した項目）
  - 依存: T15←T10 / T16←T10, T15 / T27←T15
  - ファイル: `src/orchestrator/workflow.ts`, `roadmap.ts`, `planner.ts`

- **WF-C チャットUIの土台**（9項目）
  - T05 app-server接続の初期化失敗・接続断で待機中のPromiseが解放されない
  - T06 Claude CLIの異常終了で応答待ちのPromiseが解放されず永久ハングする
  - T11 Claude側の `postState` に間引きが無い
  - T12 未使用の `AgentProvider.buildLaunch` 経路の整理
  - T17 ストリーム受信とプロセス終了の頑健性
  - T18 View層の軽微な2件（`controlPanelView` の参照クリア・CSPの集約）
  - T22 `chatView.ts` の破壊的操作系へのテスト追加（実装は変更しない）
  - T23 `chatView.ts` からプロバイダ非依存の共有ユーティリティを抽出
  - T24 `ChatViewManager` と `ClaudeChatViewManager` の重複を基底クラスへ抽出
  - 依存: T17←T05, T06 / T23←T11, T22 / T24←T23
  - ファイル: `src/appserver/*`, `src/claude/*`, `src/codex/*`, `src/provider/types.ts`,
    `src/util/ndjson.ts`, `src/view/chat*.ts`, `src/view/controlPanelView.ts`, `src/view/conversationView.ts`

- **WF-D リポジトリ基盤**（2項目）
  - T01 GitHub ActionsのCIワークフローを新規追加する（lint / typecheck / test）
  - T25 リポジトリ衛生の課題を調査し、対処方針を文書化する
  - 依存: なし
  - ファイル: `.github/workflows/ci.yml`, `docs/`

### 第2波 機能の追加（並列2）

- **WF-E ワークフローの自律性と安全な統制**（6項目、詳細は [workflow-autonomy.md](workflow-autonomy.md)）
  - W1 mainへの最終マージに人の承認を必須にする（[#335](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/335)）
  - W2 タスクのループ・停滞を検知して止める（[#336](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/336)）
  - W3 生成したワークフローの分解が妥当かをレビューする段を足す（[#337](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/337)）
  - W4 オーケストレーターがタスクを追加・削除・依存変更できるようにする（[#338](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/338)）
  - W5 PR/MRのレビュー結果を取り込んでタスクへ反映する（[#339](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/339)）
  - W6 タスクごとにIssueを起票し、PRのレビューを経てマージする（後述。Issueは未起票）
  - 依存: W2←W1 / W4←W2 / W5←W4 / W6←W1
  - 前提: WF-AとWF-Bの完了（`runner.ts` / `forge.ts` / `planner.ts` / `roadmap.ts` を共有する）

- **WF-F チャット画面の会話操作と表示**（3項目、詳細は [chat-conversation-parity.md](chat-conversation-parity.md)）
  - X1 応答のMarkdown描画へ表・引用・ネストしたリストを足す（[#332](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/332)）
  - X2 Claude Codeでも会話の途中のターンから分岐できるようにする（[#333](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/333)）
  - X3 Claude Codeでも脇道の質問を使えるようにする（[#334](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/334)）
  - 依存: X1 → X2 → X3（逐次。3項目とも `chatScript.ts` かcontrol protocol層を触る）
  - 前提: WF-Cの完了（`chatScript.ts` / `claudeChatView.ts` / `streamSession.ts` を共有する）

### 第3波 仕上げ

- **WF-G 横断の仕上げ**（2項目）
  - T26 eslintへ型情報を要するルールを導入し、未処理Promiseを機械的に検出できるようにする
  - 全体レビュー（第1波・第2波の全変更を横断でレビューする）
  - 依存: 第1波・第2波の全完了
  - ファイル: `src` 全域（型情報ルールの導入は全ファイルへ波及する）

## W6 タスクごとにIssueを起票し、PRのレビューを経てマージする

- 依存: W1
- Issue: 未起票（着手時に起票する）
- 現状: **タスクごとのPR作成は既に実装されている。** `agent.workflows.pullRequest` の既定が
  `per-task` で（[config.ts](../../src/config.ts) の `normalizePullRequestLayerConfig`）、
  [runnerMerge.ts](../../src/orchestrator/runnerMerge.ts) が `shouldCreateTaskPullRequest` を見て
  [forge.ts](../../src/orchestrator/forge.ts) の `runTaskPullRequestFlow` を回す。その段取りは
  「タスクブランチをpush → 統合ブランチをpush → PRを作る → ローカルでマージして統合ブランチをpush →
  PRをready化」である。PR作成時の宛先ブランチも引数（`baseBranch`）で受け取っている。
  無いのは次の2つだけ。
  - **タスクごとのIssue起票**（`gh issue create` を呼ぶ経路が `src` 配下に無い）
  - **PRのレビューを経てからマージする段**（PRは記録として残すだけで、マージはローカルで行うため、
    PR上のレビューを待つ余地が無い）
- 変更: 上の2点だけを足す。既にある `per-task` のフローを作り直さない。
  - (a) タスクの開始時にIssueを起票し、PR本文から参照する。Issue本文はタスクの `prompt` と `done`
    から組み立て、外部由来テキストはT10で集約するサニタイズを通す
  - (b) PRを作ったあと、ローカルマージの前にレビューを1段挟む。レビューの実施主体
    （別セッションを立てるのか、forgeのレビュー機能を使うのか）は実装時に決めて design.md へ残す
  - どちらも設定で切り替えられるようにし、既定をどちらにするかは実装時に決めて design.md へ残す
- 受入基準: タスクの開始でIssueが起票されPR本文から参照される／PRがレビューを経てからマージされる／
  Issueを起票できない環境（CLIや認証が無い）では警告を出して従来どおり進み、runは止まらない／
  設定で従来の挙動へ戻せる／`per-task` 以外（`none` / `integration`）を選んだときの挙動が変わらない
- 影響: [forge.ts](../../src/orchestrator/forge.ts) /
  [runnerMerge.ts](../../src/orchestrator/runnerMerge.ts) / [runner.ts](../../src/orchestrator/runner.ts) /
  [config.ts](../../src/config.ts) / [workflowView.ts](../../src/view/workflowView.ts)

## 運用規約

全ワークフローで同じ手順を踏む。

1. ワークフローの開始時に **epic Issueを1件起票** し、統合ブランチ `wf/<wf-id>/integration` を作る
   （例: `wf/wf-a/integration`）。epic Issueにはタスクをチェックリストで並べる
2. タスクごとに **Issueを1件起票** し、worktreeでブランチを切る。ブランチ名は
   `<type>/<Issue番号>/<slug>`
3. 実装 → **統合ブランチを宛先とするPR** を作る → レビュー → 指摘対応 → マージ、を1タスクずつ繰り返す。
   **人の承認は挟まない**
4. すべてのタスクが終わったら、ワークフローの最後に **全体レビュー** を1段置く。
   統合ブランチに入った全変更を横断で見る
5. ワークフローの終了時に **統合ブランチから main へPR** を出す。mainへのマージは人が判断する
6. **ブランチは必ずworktreeで作る**。作業ツリーを直接切り替えない

補足。

- レビューはsubagent（`code-reviewer` / `security-auditor`）で行い、指摘は潰してからマージする。
  潰せないものはPR本文へ残す
- タスクの詳細な指示（根拠・行番号・変更内容・受入基準・自己レビュー手順）は
  [.agents/workflows/](../../.agents/workflows/) の該当タスクをそのまま使う。
  YAMLのファイル分け（core / ui / final）は本ドキュメントの分割で置き換わっており、
  参照するのは各タスクの `prompt` と `done` だけとする
- YAMLの `prompt` には「検証済み」「未検証」が明記してある。**未検証のタスクは、修正の前に
  再現条件の確認から始める**。確認の結果として指摘が成立しなかった場合は、直さずにその旨を報告する
- ロジック層（`vscode` を import しない層）へ寄せられる部分はユニットテストを付ける
- 実VSCodeでしか確かめられない受入基準は [docs/manual-test.md](../manual-test.md) へ追記する
- 権限や信頼境界に触れる変更は、[design.md](../design.md) §16.16（設定の信頼境界）の方針から
  外れないことを確かめてから入れる

### 担当セッションの動き方

各ワークフローの担当は、自分で手を動かさず**オーケストレーターとして振る舞う**。

- 調査・実装・レビューは担当自身が行わず、そのつど**新しいセッションを作って任せる**。
  担当がするのは、ユーザーおよび作ったセッションとのやりとり、指示の分解、結果の検証、統合、最終判断
- **並列にできる作業は複数のセッションを同時に作ってよい。** ただし同じファイルを書くセッションは
  同時に走らせない（本ロードマップがワークフロー同士に課している制約を、ワークフローの内側でも守る）
- **作ったセッションはユーザーと直接やりとりしない。** ユーザーとのやりとりは必ず担当を経由する
  （ユーザー ←→ 担当（オーケストレーター）←→ セッション）。作ったセッションが判断に迷ったときは
  担当へ返し、担当が必要と判断したときだけユーザーへ確認する
- **タスクは追加・修正・削除してよい。** 着手して初めて分かることは多い。指摘が成立しなかった、
  分割し直したほうがよい、前提が変わった、といった場合は担当の判断で直す。
  ただし**方針が変わる場合はユーザーへ確認する**。方針が変わるとは、担当領域をまたぐ、
  設計の前提を変える、受入基準を下げる、他のワークフローへ影響する、といった場合を指す。
  変更した内容とその理由は epic Issue へ記録する

## 番号の割り当て

epic Issueは各ワークフローの開始時に起票し、採番できた時点でこの表へ追記する。

| ワークフロー | 波 | 項目数 | epic Issue | 統合ブランチ |
| --- | --- | --- | --- | --- |
| WF-A オーケストレーター実行系 | 1 | 11 | 未採番 | `wf/wf-a/integration` |
| WF-B 生成・安全系 | 1 | 4 | [#350](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/350)（完了） | `wf/wf-b/integration`（mainへマージ済み・削除） |
| WF-C チャットUIの土台 | 1 | 9 | 未採番 | `wf/wf-c/integration` |
| WF-D リポジトリ基盤 | 1 | 2 | 未採番 | `wf/wf-d/integration` |
| WF-E ワークフローの自律性 | 2 | 6 | [#341](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/341) | `wf/wf-e/integration` |
| WF-F チャットの会話操作と表示 | 2 | 3 | [#340](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/340) | `wf/wf-f/integration` |
| WF-G 横断の仕上げ | 3 | 2 | 未採番 | `wf/wf-g/integration` |

W1〜W5とX1〜X3のIssue番号・ブランチ名・design.mdの節・manual-test.mdの番号は、
[workflow-autonomy.md](workflow-autonomy.md) と [chat-conversation-parity.md](chat-conversation-parity.md) で
既に割り当ててある。担当はそこに書かれた番号だけを使う。

## 着手前の整理

第1波を始める前に次を済ませる。

- **このロードマップを含むPR [#342](https://github.com/Sylphy0052/VSCode-Codex-Extension/pull/342) の
  マージは済んでいる**（2026-08-22）。取りこぼした差分も PR
  [#345](https://github.com/Sylphy0052/VSCode-Codex-Extension/pull/345) で回収済み
- **`feat/332/markdown-table-quote-nested-list` の未コミット変更を引き継ぐ。**
  worktree `.claude/worktrees/agent-afc5d95d062c971b9` に `src/view/markdown.ts` の変更が
  271行分残っている（`table` / `quote` / `hr` / `strike` / ネスト付き `ListItem` の追加まで進んでいる）。
  X1の担当は、この差分を捨てずに検分してから続きを実装する。
  `chatScript.ts` / `chatStyles.ts` / `MARKDOWN_PARSE_SOURCE` / テストは未確認
- **不要なブランチの整理は済んでいる**（2026-08-22）。`feat/unified-approval-levels`（PR #343 で
  マージ済み）、`worktree-agent-a5ff0a7b5eea5cdfd`、`feat/335/final-merge-confirm`（いずれも独自の
  コミットが無い空ブランチ）と、リモートの `feat/327/workflow-branch-naming-conventions`
  （PR #330 でマージ済み）を削除した。W1のブランチは着手時に現在のmainから切り直す

### YAMLの行番号は古い

[.agents/workflows/](../../.agents/workflows/) の各タスクが根拠として挙げている行番号は、
全体レビューを実施した時点のmain（`cac40c73`）のものである。その後 PR
[#343](https://github.com/Sylphy0052/VSCode-Codex-Extension/pull/343)（承認方法をCodexとClaude Codeで
共通の3段階に揃える）がマージされ、次が変わっている。

- 変更: `src/view/chatScript.ts` / `chatView.ts` / `claudeChatView.ts` / `controlPanelView.ts` /
  `controlPanelScript.ts` / `chatStyles.ts` / `controlPanelStyles.ts` / `settingsProvider.ts`
- 削除: `src/provider/approvalCycle.ts`（かわりに `src/provider/approvalLevel.ts` が新設された）

**ずれているのはWF-Cの範囲だけで、`src/orchestrator/` 配下は変わっていない。**
WF-A / WF-B の根拠行はそのまま使える。WF-Cの根拠行を実測した結果は次のとおりで、
対象のコード自体はいずれも残っている。

| 根拠 | YAMLの記載 | 現在のmain |
| --- | --- | --- |
| `claudeChatView.ts` の `postState` | 355 | 360 |
| `chatView.ts` の `STATE_POST_INTERVAL_MS` | 144 | 151 |
| `chatView.ts` の `postState` | 2012 | 2028 |
| `controlPanelView.ts` の `this.view = view` | 100 | 108 |
| `conversationView.ts` のCSP組み立て | 145 | 157 |
| `chatCsp.ts` の `chatCsp()` | 11 | 11（ずれなし） |

行番号ではなくシンボル名と説明文で該当箇所を特定すること。また PR #343 は承認まわりで
`chatView.ts` と `claudeChatView.ts` に手を入れているため、T23 / T24 の抽出設計はその結果を
読んでから決める。承認まわりの変更で既に解消している指摘があれば、直さずにその旨を報告する。

## 進め方

- 第1波の4ワークフローは同時に始めてよい。互いにファイルを共有しない
- 第2波は第1波の全完了を待つ。WF-E / WF-Fは互いに交差しないので並列に進める
- 第3波は第2波の完了後。型情報ルールの導入は全ファイルへ波及するため最後に置く
- 各ワークフローの完了時に、READMEの該当箇所（機能の節・設定・既知の制約）を同じPRで更新する
- 全実装の完了後、拡張のワークフロー機能そのものでこの運用を回せるか（ドッグフーディング）を
  安定した版で確かめる。W6の受入確認をここで兼ねる
