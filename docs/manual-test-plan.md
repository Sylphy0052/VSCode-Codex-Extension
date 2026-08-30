# 実機確認の実施計画

実機確認を**いつ・何を・どの順で**通すかを決めた文書。
ケースごとの具体的な手順は [manual-test.md](manual-test.md) が原本であり、ここでは重複させない。

- [manual-test.md](manual-test.md) — ケースの手順。何を操作して何を期待するか
- 本文書 — 実施の計画。いつ始め、どの順で通し、どこで区切り、結果をどう残すか

## 実施の前提

**全実装の完了後にまとめて行う。** 実装中に部分的に通しても、後続のワークフローが同じ画面を
触るため確認が無効になる。

待つ対象は次の3つ。すべて main へマージされてから始める。

- **WF-A2**（epic [#466](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/466)）—
  オーケストレーター実行系の追いIssue
- **WF-E**（epic [#341](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/341)）—
  ワークフローの自律性。W群のケースが増える
- **WF-G** — 横断の仕上げ（eslintの型情報ルール導入と全体レビュー）

**WF-F**（epic [#340](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/340)）は
完了済み（PR [#510](https://github.com/Sylphy0052/VSCode-Codex-Extension/pull/510)）。
U-26〜U-33 がこの回で増えている。

進捗は [roadmap/review-and-feature-consolidation.md](roadmap/review-and-feature-consolidation.md) の
状態表を見る。

## 対象と件数

現時点で実機確認が要るのは **192件**。内訳は次のとおり。

| 群  | 対象                                     | 件数 | 範囲                                            |
| --- | ---------------------------------------- | ---- | ----------------------------------------------- |
| C群 | Codex画面（app-server）                  | 54   | C-01〜C-02, C-11, C-13b〜C-17, C-20, C-22〜C-58 |
| L群 | Claude Code画面（stream-json）           | 48   | L-01, L-04, L-07〜L-08, L-10〜L-17, L-19〜L-52  |
| P群 | ループ実行                               | 5    | P-01〜P-05                                      |
| H群 | 履歴とタブ復元                           | 10   | H-00〜H-09                                      |
| A群 | 作業記録（日報連携）                     | 4    | A-01〜A-04                                      |
| W群 | ワークフロー（並列オーケストレーション） | 23   | W-A〜W-W                                        |
| U群 | UX改善（横断機能）とチャットの会話操作   | 48   | U-04〜U-47                                      |

**この表は手で書かない。** `node scripts/count-manual-test-cases.mjs` が
[manual-test.md](manual-test.md) の見出しを数えて同じ形の表を出すので、ケースを足したら
実行して貼り替える。この文書は過去2回、件数が実態から離れた状態で放置されている
（Issue [#498](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/498) が
[manual-test.md](manual-test.md) の「進め方」節を、Issue
[#1028](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/1028) が本文書を直した）。

U群のうち U-26〜U-33 は WF-F が追加したもの。内訳は U-26〜U-28（X1、Markdown描画の表・引用・
ネストしたリスト）、U-29〜U-31（X2、会話の途中のターンからの分岐）、U-32・U-33（X3、脇道の質問）。

U-34〜U-47 はその後に増えた分で、由来は3つに分かれる。U-34〜U-42 は会話の見え方の作り込み
（ツール出力の折りたたみ・ターンの切れ目・行間と行長・成否の色・見出しアイコン・見出しの固定・
構文強調・表示密度・発言のカード化。Issue #679・#712〜#719）、U-43〜U-46 はセカンドオピニオン
（Issue #894ほか・#944・#929・#999）、U-47 は一文からゴールの下書きを組み立てる分
（Issue #956ほか）である。

C-49〜C-58 と L-50〜L-52 も同じくその後に増えた分で、応答中の外枠の色（#701）・応答末尾の要約
（#709）・進捗画面（#721・#748〜#751・#781・#1013）・ワークフロー画面の進捗表示
（#752〜#754）・大きいセッションの分岐（#795）・使用量ゲージ（#756）・4画面の見た目の統一
（#757）が入る。L-50〜L-52 は C-49・C-50・C-51 の Claude Code 版で、対で見ると差分に気づきやすい。

W群のうち **W-F・W-G・W-H・W-I・W-J・W-L・W-M・W-N・W-O・W-P は WF-E が確定させた**（2026-08-23）。
**W-K・W-Q を含め、いずれも main の [manual-test.md](manual-test.md) へ入っている**（当初は統合ブランチ
`wf/wf-e/integration` 上にあると書いていたが、WF-E の統合PRで取り込まれた）。W-F は W1（最終マージの判断を
オーケストレーターが行う、Issue [#335](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/335)）で、
`orchestrator` 既定での判断待ちの見え方・`decide_final_merge` の `merge`/`hold`・タイムアウトの
自動 `hold`・`confirm` のボタン経路を見る。W-H は W3（生成したワークフローの分解のレビュー、
Issue [#337](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/337)）で、
**ゴール文起点とロードマップ起点の両方**から指摘が出ること、指摘が無いときは通常の完了通知だけに
なること、レビューでYAMLが書き換わっていないことを見る。
W-G は W2（タスクのループ・停滞を検知して止める、
Issue [#336](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/336)）で、期待が5件。
W-L は W7（タスクからオーケストレーターへ判断を仰ぐ経路、
Issue [#571](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/571)）で、期待が5件。
W-N は W9（タスク間の直接メッセージングを廃し、オーケストレーターの中継にする、
Issue [#547](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/547)）で、期待が6つある
（操作5・確認3を挟む）。宛先固定の拒否・オーケストレーターへの通知・転送の往復がViewから
追えること・`expectReply` の解除・権限差での中継、の5つに加えて、
**権限差のあるタスク間で中継しても権限昇格の警告が出ないのは現在の仕様であって不具合ではない**
ことを確かめる。最後の1件は Issue
[#562](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/562)
が未決である旨も本文に書かれている。
W-P は W11（CIの完了待ちとブランチ保護への対応、
Issue [#556](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/556)）で、
操作/期待が**9組**ある。CIの完了待ち・CI失敗・待ち時間の上限・「baseの最新でない」からの
取り込み直し・`ciUpdateBranchMaxRetries: 0`・GitLab側・CIを1件も設定していないリポジトリ・
CI待ち中の「全体の停止」・停止を解除しても最終マージが自動では再開しないこと、の9つを見る。
**ブランチ保護（`checks`必須・strict）を設定した使い捨てリポジトリが要る**ため、W-Dと同じ
リポジトリを流用する。
W-I は W4（オーケストレーターが実行中の計画を書き換える、
Issue [#338](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/338)）で、期待が11件。
`add_task` の反映・権限を緩める追加の拒否・検証（未定義参照や循環依存）での拒否・`remove_task` と
依存の付け替え・走行中タスクの削除の拒否・`update_task_dependencies` の警告欄への全文表示、そして
**リロードすると保存済みYAML本来の内容へ戻ること**を見る。この1件は、実行中に加減したタスクの
永続状態を定義と突き合わせる修正（レビューの指摘、design.md §16.29「リロード時の突き合わせ」）が
効いているかの確認も兼ねる。
着地後の後追い修正で4件を足した。**削除で宙に浮くテンプレート参照が残る場合の `remove_task` の拒否**
（Issue [#764](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/764)）、
**同一タスクへの `update_task_dependencies` の警告が直近1件へ丸められること**と
**追加・削除の履歴警告が50件で頭打ちになり `orchestratorPlanHistoryTrimmed` が出ること**
（Issue [#765](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/765)）、
**`add_task` の `escalate` / `cwd` の拒否**
（Issue [#766](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/766)）の4件で、
いずれも拒否理由や警告欄の見え方が画面上で確かめられるかを見る。
W-J は W5（PR/MRのレビュー結果を取り込んでタスクへ反映する、
Issue [#339](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/339)）で、期待が10件。
警告欄とオーケストレーターの会話への到達・2件目だけが追記される重複排除・GitLab側での同じ結果・
コメントが1件も無いときに既存の完走経路が変わらないこと・`reviewCommentPollIntervalSec: 0` での
無効化・長すぎる本文の切り詰め・CLIの認証が切れていてもrunが止まらないこと、に加えて、
**最終マージの判断が付く前に届いたレビューを踏まえた `add_task` が通り、その成果が統合PR/MRを
2本目に増やさずにmainへ入ること**と、**最終マージ確定後の `add_task` は理由付きで拒否されること**
を見る。後ろの3件は実装中に見つかった3件の欠陥（finished後の計画変更が常に拒否される・
`finalizeForge` の冪等ガードが最終マージ自体を飛ばす・確定後もポーリングが止まらない）に対応する
確認で、いずれも実機でしか最終形を確かめられない。**W-D・W-Pと同じ使い捨てリポジトリを流用してよい**。
W-M は W8（オーケストレーターから人へ確認する経路、
Issue [#583](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/583)）で、期待が5件。
問いと選択肢の表示・**押した直後はまだ届かず「お待ちください」になること**・ターンが終わってから
答えが溜まっていた通知と一緒に届くこと・呼び出し回数の上限での拒否・リロード後はボタンが押せなく
なることを見る。2件目は「ターンの最中に答えを即送信すると届かない」というレビューの指摘に対応する
確認であり、**押してすぐ届かないのは不具合ではない**。
W-O は W10（中断からの自動再開、
Issue [#584](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/584)）で、期待が7件。
リロードとWSLの停止の両方からの自動再開・人が止めたrunは再開しないこと・`autoResume: false` での
従来どおりの手動再開・再開試行の上限での停止と理由の表示・allow確認を自動再開が代行しないこと・
`ask_user` 待ちだったrunが問いを出し直すことを見る。**実VSCodeの再起動とWSLの停止を伴う唯一の群**である。

W-K は W6（タスクごとにIssueを起票し、PRのレビューを経てマージする、Issue #596）、
W-Q は W12（runをまたぐ統括・プログラム、epic #341）。**2026-08-22にW6〜W12を追加したため、
当初の W-F〜W-J から W-Q までへ広がった**（Issue #497）。増えた分のうち
**W-O（W10、中断からの自動再開）は実VSCodeの再起動やWSLの停止を伴う**ため、下の「実施の順序」で
W群を通すときに一緒に確かめる。**W-N（W9）も同じ理由で挙げていたが、実際に書かれたW-Nに再起動や
停止は要らなかった**（CLIプロセス2つとオーケストレーターのMCP接続で完結する）。着手前の見込みで
書いた前提は、ケースが確定した時点で実物と突き合わせる。

**W-R〜W-W の6件は W1〜W12 の割り当てとは別に、個別のIssueから増えた分**である。W-R は通常タスクの
承認待ちの時間切れ（Issue #579）、W-S は2つの親から `mergeBlocked` された後続の停止解除後の自動復帰
（Issue #527）、W-T はワークフローが開くセッションのタブ名（Issue #599）、W-U は終了したrunを
再開したときのオーケストレーターへの通知（Issue #491）、W-V は警告通知からログを開く導線
（Issue #524）、W-W はチームモード（Issue #693）。

**この数は今後さらに増える。** ケースを足したら、上の「対象と件数」の表を
`node scripts/count-manual-test-cases.mjs` の出力で貼り替え、下の「実施の順序」の区切りにも
入れること。

### 実機確認が不要なもの

C群・L群の番号には欠番がある。これらは**統合テストへ移した**ものであり、実機で通す必要は無い。

- **C-03〜C-10 / C-12 / C-13**（Issue [#187](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/187)）
  — 承認カードの往復、中断、タブ名の追従、会話の分岐など。
  `chatCodexApprovals.test.ts` / `chatCodexThreadFlow.test.ts` が押さえている
- **L-02 / L-03 / L-05 / L-06 / L-18**（Issue
  [#186](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/186)）
  — `initialize` ハンドシェイク、`can_use_tool` の往復、`interrupt`、セッションidの採番など
- **W-05 / W-07 / W-08 / W-18 / W-19 / W-20**（旧番号）— W群の再編で機械確認へ移した分。
  現行の W-A〜W-E との対応は [manual-test.md](manual-test.md) の「旧番号（W-01〜W-21）との対応」を見る

詳細は [manual-test.md](manual-test.md) の「統合テストで自動化した範囲」と
「C群・L群の仕分け（Issue #186）」にある。

## 準備

[manual-test.md](manual-test.md) の「準備」節に従う。要点だけ再掲する。

- `npm run check` が全緑、`npm run build` で `dist/extension.js` を更新してから `F5`
- **ファイルを壊してよい捨てフォルダ**を開発ホスト側で開く（承認の確認で実際にコマンドを走らせる）
- `Agent: ログを表示` でOutputChannelを常時開く
- WSL Remoteなら `which codex` / `which claude` でリモート側のPATHを確認する
- サンドボックスの実行に `bubblewrap` が要る（`sudo apt install bubblewrap`）
- 設定は `codex.sandbox: read-only` / `codex.approvalMode: on-request` /
  `claude.permissionMode` は空か `manual` / `agent.activityLog.enabled: true`

**承認カードが出ない設定にしない。** `codex.approvalMode: never`、
`danger-full-access` + `never`、`claude.permissionMode: bypassPermissions`、
`codex.sandbox: workspace-write` はいずれも承認ケースを潰す。

実施した環境（Codex CLIの版・Claude Code CLIの版・OS・VSCodeの版・拡張機能のcommit hash）を
最初に記録する。

## 実施の順序

上から順に通す。1行が1セッションの区切り。

| 回  | 対象                                                          | 件数 | 前提が崩れたら                                                                                                                |
| --- | ------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | C群の基本（C-01, C-02, C-11, C-13b〜C-17, C-20, C-22〜C-28b） | 17   | C-01が落ちたらC群を中断                                                                                                       |
| 2   | C群の管理系（C-29〜C-48）                                     | 22   | 個別に切り分け可能                                                                                                            |
| 3   | C群の表示系（C-49〜C-52f, C-56〜C-58）                        | 12   | 進捗タブと応答の表示・使用量の見た目。C-53〜C-55はワークフロー画面の表示なので回9へ回す                                       |
| 4   | L群の基本（L-01, L-04, L-07〜L-17, L-19〜L-24）               | 19   | L-01が落ちたらL群を中断                                                                                                       |
| 5   | L群の管理系（L-25〜L-52）                                     | 29   | 個別に切り分け可能                                                                                                            |
| 6   | P群 + H群                                                     | 15   | H群はC群・L群の会話が残っている状態で行う                                                                                     |
| 7   | A群 + U-04〜U-33                                              | 38   | U-26〜U-33 は WF-F が追加した分                                                                                               |
| 8   | U-34〜U-47                                                    | 14   | 送信の操作・入力補助・横断の表示。回7と同じ画面で続けて通せる                                                                 |
| 9   | W群 + C-53〜C-55                                              | 26   | W-Dは実ホスト（GitHub/GitLab）が要る。**W-O は実VSCodeの再起動とWSLの停止を伴う**。W-P もブランチ保護を設定した実ホストが要る |

**前提が崩れるケース（C-01 / L-01）が落ちた場合、その群の残りは実行しても意味がない。**
中断して原因を先に潰す。

回3と回9を分けたのは、C-53〜C-55がワークフロー画面の表示を見るケースで、W群と同じ
`run` の準備が要るため。C群の他の表示系（進捗タブ・応答・使用量）はチャット1本あれば
確認できるので、回3にまとめてある。

回5でH群をC群・L群の後に置くのは、履歴とタブ復元の確認に**実際の会話が残っている状態**が
要るため。C群・L群を先に通しておけば、H群のために会話を作り直す手間が省ける。

## 1回の通しで兼ねられるもの

同じ操作で複数のケースを見られる組み合わせ。手戻りを減らせる。

- **C-47 / C-48 / L-48 / L-49**（WF-C由来）— C-47とL-49が接続断・異常終了での承認カード解放、
  C-48とL-48がSIGTERM無応答と改行なし出力。**Codex画面とClaude Code画面で1回ずつ通せば4件とも見られる**
- **C-45 / L-43**（会話の1行要約）、**C-46 / L-47**（`/clear` 相当）、
  **C-34b**（承認3段階の一致）— いずれもCodex側とClaude Code側が対になっている。
  片方を確認した直後にもう片方を見ると差分に気づきやすい
- **C-30 / C-33 / C-36 / C-44**（Codexの管理系の書き込み経路）— どれも
  `config/batchWrite` 系のCLI依存。同じセッションで続けて通す
- **U-08〜U-10**（Markdown描画）と **U-26〜U-28**（WF-Fが足した表・引用・ネスト）—
  同じ描画経路なので続けて見る

## CLIを更新したら必ず見るケース

CLIの版に強く依存し、更新で黙って壊れうるもの。`codex --version` / `claude --version` が
上がったら、全体を通さずここだけでも見る。一覧は [manual-test.md](manual-test.md) の
「CLIを更新したら必ず見るケース」にある（L-29 / C-30 / C-33 / C-36 / C-44 / C-28 / C-43 /
L-13 / C-14 / L-38）。

**「スキーマ根拠のみ」と書いてあるケースは、実機で初めて可否が分かる。** 落ちたらIssueを立て、
design.mdの該当節の「スキーマが根拠」という記述を実測の結果へ書き換える。

## 記録

[manual-test.md](manual-test.md) の「記録テンプレート」に従い、
Issueまたは `docs/manual-test-<YYYY-MM-DD>.md` へ残す。

```
確認日: YYYY-MM-DD
拡張機能: <commit hash>
Codex CLI: x.y.z / Claude Code: x.y.z
環境: WSL Remote / ローカル

| ケース | 結果 | 備考 |
| --- | --- | --- |
| C-01 | OK / NG / 未 |  |
```

**NGは再現手順とログの該当行をそのまま貼る。要約しない。**

## NGが出たときの扱い

- **その場では直さない。** 再現手順と観測した挙動を添えて個別のIssueとして起票し、確認を続ける
- 前提が崩れるケース（C-01 / L-01）だけは例外で、中断して原因を潰してから再開する
- 落ちたケースがCLIの版に依存するものだった場合、design.mdの該当節の根拠の記述
  （「スキーマが根拠」など）も実測の結果へ直す

## 既存の実機確認Issueとの対応

実機確認のIssueが6件 open のまま残っている。

| Issue                                                                   | スコープ（起票時の記述） |
| ----------------------------------------------------------------------- | ------------------------ |
| [#189](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/189) | C-01〜C-16               |
| [#190](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/190) | C-17〜C-28b              |
| [#191](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/191) | C-29〜C-44               |
| [#192](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/192) | L-01〜L-13               |
| [#193](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/193) | L-14〜L-24               |
| [#194](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/194) | L-25〜L-40               |

**これらのスコープ記述は起票時のもので、現状と合っていない。**

- 統合テストへ移した欠番（C-03〜C-10 など）が範囲に含まれたままになっている
- その後に増えたケース（C-45〜C-48、L-41〜L-49、U群、W群）がどのIssueにも入っていない

実施の際は、Issueのスコープ記述ではなく**本文書の「実施の順序」の区切り**に従う。
結果を書き込む先としてこれらのIssueを使う場合は、着手時にスコープ記述を現状へ直す。
