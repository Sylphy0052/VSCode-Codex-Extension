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

## docs/roadmap/ の5本の関係

- [ux-improvements.md](ux-improvements.md) — R1〜R11。**全項目完了済み**（epic #297 もクローズ）。
  記録として残してある
- [workflow-autonomy.md](workflow-autonomy.md) — W1〜W12。本ロードマップの WF-E が担当する
- [chat-conversation-parity.md](chat-conversation-parity.md) — X1〜X3。WF-F が担当する
- [orchestration-accuracy.md](orchestration-accuracy.md) — H1〜H7。WF-H が担当する。
  **他の3本と出所が違う**: レビュー指摘や機能要求ではなく、2026-08-21〜23に人手で
  同じ構造（オーケストレーター起点の並列実行）を回した実運用の観測から起こしたもの
- 本ドキュメント — 上の8項目と全体レビューの26指摘を統合した、8ワークフローの分割と運用規約

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

**各ワークフローの棚・進捗・依存・影響ファイルは、それぞれの文書にある。**
WF-E / WF-F / WF-H は上の「5本の関係」で挙げた既存の担当文書がそのまま書き場で、
`wf/` 配下には専用文書を持たないワークフロー（WF-A〜WF-D、WF-G）だけを置く。
この骨格には進捗を書かない（書き手ごとにファイルを分けて記帳の衝突をなくすため。Issue #609）。

### 第1波 土台の修正（並列4）

- [WF-A オーケストレーター実行系](wf/wf-a.md)（11項目）
- [WF-B 生成・安全系](wf/wf-b.md)（4項目）
- [WF-C チャットUIの土台](wf/wf-c.md)（9項目）
- [WF-D リポジトリ基盤](wf/wf-d.md)（2項目）

### 第2波 機能の追加（並列2）

- [WF-E ワークフローの自律性と安全な統制](workflow-autonomy.md)（12項目）
- [WF-F チャット画面の会話操作と表示](chat-conversation-parity.md)（3項目）

### 第3波 仕上げ

- [WF-G 横断の仕上げ](wf/wf-g.md)（15項目）

### 第4波 実行の精度

- [WF-H オーケストレーション実行の精度](orchestration-accuracy.md)（7項目）

## 共通の文書

- [運用規約](ops-rules.md) — 全ワークフロー共通の手順と規律。
  **全体オーケストレーターだけが書く**
- [番号の割り当て](numbering.md) — epic Issueとdesign.md / manual-test.mdの採番

## 着手前の整理（完了済みの記録）

第1波を始める前に済ませた項目。**すべて完了しており、これから対応するものは無い。**

- **このロードマップを含むPR [#342](https://github.com/Sylphy0052/VSCode-Codex-Extension/pull/342) の
  マージは済んでいる**（2026-08-22）。取りこぼした差分も PR
  [#345](https://github.com/Sylphy0052/VSCode-Codex-Extension/pull/345) で回収済み
- **`feat/332/markdown-table-quote-nested-list` の未コミット変更の引き継ぎは完了した**（2026-08-22）。
  worktree `.claude/worktrees/agent-afc5d95d062c971b9` に残っていた `src/view/markdown.ts` の
  271行分の変更を、X1の担当が検分したうえでコミットし `wf/wf-f/integration` へ rebase した
  （`markdown.ts` は `cac40c73` 以降 main で変更されていなかったためコンフリクトなし）
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

**この節はWF-C着手前の申し送りだったが、WF-Cは完了した**（2026-08-22、PR #431でmainへマージ済み）。
その後さらにWF-A（PR #447）とWF-B（PR #429）もmainへマージされており、
`.agents/workflows/` の行番号は当時（`cac40c73`時点）のまま一切更新されていないため、
上表の「現在のmain」列との差分に加えて、WF-A / WF-B / WF-Cそれぞれの変更分だけ
さらにずれが積み重なっている。WF-E / WF-Fの担当は、YAMLの行番号をそのまま信じず、
シンボル名と説明文で現物を確認してから着手すること。

## 進め方

- 第1波の4ワークフローは同時に始めてよい。互いにファイルを共有しない
- 第2波は第1波の全完了を待つ。**第1波は4本とも完了済み**（2026-08-22、WF-A: PR #447 / WF-B: PR #429 /
  WF-C: PR #431 / WF-D: PR #394、いずれもmainへマージ済み）。WF-Aの後続として、実装過程とその後の
  横断レビューで分離した追いIssue epic [#466](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/466)
  （16件、統合ブランチ `wf/wf-a2/integration`）は **PR [#542](https://github.com/Sylphy0052/VSCode-Codex-Extension/pull/542) で完了した**（2026-08-22）。
  第2波は **WF-Fのみ先に着手する**という決定（2026-08-22）のもとで進み、
  **WF-FはPR [#510](https://github.com/Sylphy0052/VSCode-Codex-Extension/pull/510) で完了した**（2026-08-22）。
  WF-E は WF-A2 と `runner.ts` / `forge.ts` を共有しファイルの集合が交差するため後回しにしていたが、
  **WF-A2 の完了で交差が解け、2026-08-23 に着手した**（統合ブランチ `wf/wf-e/integration`）。
  WF-EとWF-Fは互いに交差しないので先にWF-Fだけを流した。**第2波で残るのはWF-Eのみ**
- 第3波は第2波の完了後。型情報ルールの導入は全ファイルへ波及するため最後に置く
- 各ワークフローの完了時に、READMEの該当箇所（機能の節・設定・既知の制約）を同じPRで更新する
- 全実装の完了後、拡張のワークフロー機能そのものでこの運用を回せるか（ドッグフーディング）を
  安定した版で確かめる。W6の受入確認をここで兼ねる
