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

- **WF-B 生成・安全系**（3項目）
  - T10 外部由来テキストの整形を1モジュールへ集約し、全プロンプト経路をそこへ通す
  - T15 ワークフロー生成（planner）の3件の不具合
  - T16 ロードマップMarkdownのパースを堅くする
  - 依存: T15←T10 / T16←T10, T15
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
  - W6 タスクごとにIssueとPRを作り統合ブランチへマージする（後述。Issueは未起票）
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

## W6 タスクごとにIssueとPRを作り統合ブランチへマージする

- 依存: W1
- Issue: 未起票（着手時に起票する）
- 現状: [runner.ts](../../src/orchestrator/runner.ts) はタスクのworktreeで作業したあと、
  統合ブランチ（`wf/<runId>/integration`）へ直接マージする。タスク単位のIssueもPRも作らないため、
  個々のタスクの意図と差分がGitHub/GitLab上に残らず、レビューの単位も存在しない。
  PR/MRを作るのは [forge.ts](../../src/orchestrator/forge.ts) が扱う統合ブランチ→mainの1本だけ
- 変更: タスクの開始時にIssueを起票し、完了時に統合ブランチを宛先とするPR/MRを作る。
  レビューを通してからマージする。`forge.ts` のPR/MR作成をタスク単位でも使えるようにし、
  宛先ブランチを引数で受け取れるようにする。Issue本文とPR本文はタスクの `prompt` と `done` から
  組み立て、外部由来テキストは[T10で集約するサニタイズ](#第1波-土台の修正並列4)を通す。
  この挙動は設定で切り替えられるようにし、既定をどちらにするかは実装時に決めて design.md へ残す
- 受入基準: タスクの開始でIssueが起票される／完了で統合ブランチ宛のPR/MRが作られる／
  レビューを経てマージされる／PR/MRを作れない環境（CLI・認証が無い）では警告を出して
  従来どおり直接マージへ退避しrunは止まらない／設定で従来の挙動へ戻せる
- 影響: [forge.ts](../../src/orchestrator/forge.ts) / [runner.ts](../../src/orchestrator/runner.ts) /
  [runnerMerge.ts](../../src/orchestrator/runnerMerge.ts) / [config.ts](../../src/config.ts) /
  [workflowView.ts](../../src/view/workflowView.ts)

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

## 番号の割り当て

epic Issueは各ワークフローの開始時に起票し、採番できた時点でこの表へ追記する。

| ワークフロー | 波 | 項目数 | epic Issue | 統合ブランチ |
| --- | --- | --- | --- | --- |
| WF-A オーケストレーター実行系 | 1 | 11 | 未採番 | `wf/wf-a/integration` |
| WF-B 生成・安全系 | 1 | 3 | 未採番 | `wf/wf-b/integration` |
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

- **このロードマップを含むPR [#342](https://github.com/Sylphy0052/VSCode-Codex-Extension/pull/342) を
  mainへマージする。** W/X群のIssueが参照しており、第2波の前提になる
- **`feat/332/markdown-table-quote-nested-list` の未コミット変更を引き継ぐ。**
  worktree `.claude/worktrees/agent-afc5d95d062c971b9` に `src/view/markdown.ts` の変更が
  271行分残っている（`table` / `quote` / `hr` / `strike` / ネスト付き `ListItem` の追加まで進んでいる）。
  X1の担当は、この差分を捨てずに検分してから続きを実装する。
  `chatScript.ts` / `chatStyles.ts` / `MARKDOWN_PARSE_SOURCE` / テストは未確認
- **不要なworktreeを整理する。** `approval-levels` は登録だけが残りディレクトリの実体が無い
  （`git worktree prune` の対象）。`feat/335/final-merge-confirm` などmainとの差分が無いブランチも
  着手時に切り直す

## 進め方

- 第1波の4ワークフローは同時に始めてよい。互いにファイルを共有しない
- 第2波は第1波の全完了を待つ。WF-E / WF-Fは互いに交差しないので並列に進める
- 第3波は第2波の完了後。型情報ルールの導入は全ファイルへ波及するため最後に置く
- 各ワークフローの完了時に、READMEの該当箇所（機能の節・設定・既知の制約）を同じPRで更新する
- 全実装の完了後、拡張のワークフロー機能そのものでこの運用を回せるか（ドッグフーディング）を
  安定した版で確かめる。W6の受入確認をここで兼ねる
