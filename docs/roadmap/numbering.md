# 番号の割り当て

全体の骨格は
[review-and-feature-consolidation.md](review-and-feature-consolidation.md) を見ること。

書き手: **Issueを起票した担当が、採番できた時点で追記する。**

epic Issueは各ワークフローの開始時に起票し、採番できた時点でこの表へ追記する。

**`docs/design.md` の節番号と `docs/manual-test.md` のケース記号は、末尾への追記のみとする。**
既存の番号を動かさない（挿入・繰り上げ・体系の付け替えをしない）。動かす必要が出た場合は、
実行前に全体オーケストレーターを通す。子Issueの本文や他ワークフローのIssueが同じ番号を
参照しているため、**動かした本人には見えないところに影響が出る**。
Issue
[#487](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/487)
で §16.24 が先に使われていたため W1 以降を1つずつ繰り下げた結果、子Issue 5件（#335〜#339）の本文が
すべて腐った。しかも**ずれた先が隣の項目の有効な割り当てと一致する**という壊れ方で、
そのまま着手すると別項目の節へ書けてしまう状態だった。
なお、レビューや監査の指摘から起票されたIssueが持つ節番号は、起票時点で実在するものを
指しているため腐りにくい。ただし安全なのは起票時点までで、その後に割り当てが動けば同じように腐る。

| ワークフロー | 波 | 項目数 | epic Issue | 統合ブランチ | 状態 |
| --- | --- | --- | --- | --- | --- |
| WF-A オーケストレーター実行系 | 1 | 11 | [#352](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/352) | `wf/wf-a/integration` | 完了（PR [#447](https://github.com/Sylphy0052/VSCode-Codex-Extension/pull/447)、mainへマージ済み。統合ブランチは削除済み）。後続はWF-A2行（次行）を参照 |
| WF-A2 オーケストレーター実行系の追いIssue | 1 | 16 | [#466](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/466) | `wf/wf-a2/integration` | 完了（PR [#542](https://github.com/Sylphy0052/VSCode-Codex-Extension/pull/542)、mainへマージ済み。統合ブランチは削除済み）。必須7件（[#528](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/528)・[#529](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/529)・[#530](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/530)・[#531](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/531)・[#413](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/413)・[#514](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/514)・[#511](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/511)）を解消し、残件はWF-Gへ送った（下の「WF-G 横断の仕上げ」を参照） |
| WF-B 生成・安全系 | 1 | 4 | [#350](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/350) | `wf/wf-b/integration` | 完了（PR [#429](https://github.com/Sylphy0052/VSCode-Codex-Extension/pull/429)、mainへマージ済み。統合ブランチは削除済み） |
| WF-C チャットUIの土台 | 1 | 9 | [#351](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/351) | `wf/wf-c/integration` | 完了（PR [#431](https://github.com/Sylphy0052/VSCode-Codex-Extension/pull/431)、mainへマージ済み。統合ブランチは削除済み） |
| WF-D リポジトリ基盤 | 1 | 2 | [#353](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/353) | `wf/wf-d/integration` | 完了（PR [#394](https://github.com/Sylphy0052/VSCode-Codex-Extension/pull/394)、mainへマージ済み。統合ブランチは削除済み） |
| WF-E ワークフローの自律性 | 2 | 12 | [#341](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/341) | `wf/wf-e/integration` | **進行中**。第1波（W1 [#335](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/335) / W3 [#337](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/337) / W9 [#547](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/547) / W11 [#556](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/556)）が統合ブランチへ着地済み（2026-08-23）。第2波（W2 [#336](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/336) / W7 [#571](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/571)）も着地済み（2026-08-23）。第3波（W8 [#583](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/583) → W10 [#584](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/584) の**直列**。W10の受入基準に「`ask_user`待ちだったrunは問いを出し直す」が含まれ、W8が無いと満たせない。依存欄の食い違いは [#586](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/586) で修正）も着地済み（2026-08-23）。以降、W4 [#338](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/338) / W5 [#339](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/339) / W6 [#596](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/596) も着地し、**W1〜W11の11項目は統合ブランチへ着地済み**（2026-08-23、実測: `git log origin/main..origin/wf/wf-e/integration`）。**W12は着手時に3件へ分割した**（W12-1 [#604](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/604) / W12-2 [#605](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/605) / W12-3 [#606](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/606)）。W12-1 は PR [#611](https://github.com/Sylphy0052/VSCode-Codex-Extension/pull/611) で着地済みで、**残るのは #605 / #606 の2件**。**節番号は着手のたびに、[workflow-autonomy.md](workflow-autonomy.md) の「着手前に必ず実測する」に従って実測すること**（割り当ては Issue [#543](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/543) で §16.26〜§16.37 へ移動済み）。追いIssue [#562](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/562) を WF-G へ送った。第2波からは追いIssue [#579](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/579) を、第3波からは [#589](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/589) を WF-G へ送った |
| WF-F チャットの会話操作と表示 | 2 | 3 | [#340](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/340) | `wf/wf-f/integration` | 完了（PR [#510](https://github.com/Sylphy0052/VSCode-Codex-Extension/pull/510)、mainへマージ済み。統合ブランチは削除済み） |
| WF-G 横断の仕上げ | 3 | 15 | 未採番 | `wf/wf-g/integration` | 第2波の完了待ち |
| WF-H オーケストレーション実行の精度 | 4 | 7 | 未採番 | `wf/wf-h/integration` | 第3波の完了待ち。**節番号とケース記号は事前予約しない**（波をまたぐ予約は Issue [#487](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/487) と同じ形で腐るため）。詳細は [orchestration-accuracy.md](orchestration-accuracy.md) |

W1〜W5とX1〜X3のIssue番号・ブランチ名・design.mdの節・manual-test.mdの番号は、
[workflow-autonomy.md](workflow-autonomy.md) と [chat-conversation-parity.md](chat-conversation-parity.md) で
既に割り当ててある。担当はそこに書かれた番号だけを使う。
