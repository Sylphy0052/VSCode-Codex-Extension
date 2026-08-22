# 実機確認の実施計画

実機確認を**いつ・何を・どの順で**通すかを決めた文書。
ケースごとの具体的な手順は [manual-test.md](manual-test.md) が原本であり、ここでは重複させない。

- [manual-test.md](manual-test.md) — ケースの手順。何を操作して何を期待するか
- 本文書 — 実施の計画。いつ始め、どの順で通し、どこで区切り、結果をどう残すか

## 実施の前提

**全実装の完了後にまとめて行う。** 実装中に部分的に通しても、後続のワークフローが同じ画面を
触るため確認が無効になる。

待つ対象は次の4つ。すべて main へマージされてから始める。

- **WF-A2**（epic [#466](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/466)）—
  オーケストレーター実行系の追いIssue
- **WF-F**（epic [#340](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/340)）—
  チャット画面の会話操作と表示。U群のケースが増える
- **WF-E**（epic [#341](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/341)）—
  ワークフローの自律性。W群のケースが増える
- **WF-G** — 横断の仕上げ（eslintの型情報ルール導入と全体レビュー）

進捗は [roadmap/review-and-feature-consolidation.md](roadmap/review-and-feature-consolidation.md) の
状態表を見る。

## 対象と件数

現時点で実機確認が要るのは **129件**。内訳は次のとおり。

| 群 | 対象 | 件数 | 範囲 |
| --- | --- | --- | --- |
| C群 | Codex画面（app-server） | 38 | C-01, C-02, C-11, C-13b, C-14〜C-17, C-20, C-22〜C-48 |
| L群 | Claude Code画面（stream-json） | 45 | L-01, L-04, L-07〜L-17, L-19〜L-49 |
| P群 | ループ実行 | 5 | P-01〜P-05 |
| H群 | 履歴とタブ復元 | 10 | H-00〜H-09 |
| A群 | 作業記録（日報連携） | 4 | A-01〜A-04 |
| W群 | ワークフロー（並列オーケストレーション） | 5 | W-A〜W-E |
| U群 | UX改善（横断機能） | 22 | U-04〜U-25 |

**この数は今後増える。** 進行中のワークフローが追加する分は次のとおり。

- **WF-F**: U-26〜U-28（X1、Markdown描画の表・引用・ネスト）、U-29〜U-31（X2、会話の途中からの分岐）、
  X3（脇道の質問）でさらに2件の予定
- **WF-E**: W-F〜W-J（W1〜W5に1件ずつ。
  [roadmap/workflow-autonomy.md](roadmap/workflow-autonomy.md) の割り当て表を参照）

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

| 回 | 対象 | 件数 | 前提が崩れたら |
| --- | --- | --- | --- |
| 1 | C群の基本（C-01, C-02, C-11, C-13b〜C-17, C-20, C-22〜C-28b） | 15 | C-01が落ちたらC群を中断 |
| 2 | C群の管理系（C-29〜C-48） | 23 | 個別に切り分け可能 |
| 3 | L群の基本（L-01, L-04, L-07〜L-17, L-19〜L-24） | 20 | L-01が落ちたらL群を中断 |
| 4 | L群の管理系（L-25〜L-49） | 25 | 個別に切り分け可能 |
| 5 | P群 + H群 | 15 | H群はC群・L群の会話が残っている状態で行う |
| 6 | A群 + U群 | 26 | — |
| 7 | W群 | 5 | W-Dは実ホスト（GitHub/GitLab）が要る |

**前提が崩れるケース（C-01 / L-01）が落ちた場合、その群の残りは実行しても意味がない。**
中断して原因を先に潰す。

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
- **U-08〜U-10**（Markdown描画）と **U-26〜U-28**（WF-Fが足す表・引用・ネスト）—
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

| Issue | スコープ（起票時の記述） |
| --- | --- |
| [#189](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/189) | C-01〜C-16 |
| [#190](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/190) | C-17〜C-28b |
| [#191](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/191) | C-29〜C-44 |
| [#192](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/192) | L-01〜L-13 |
| [#193](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/193) | L-14〜L-24 |
| [#194](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/194) | L-25〜L-40 |

**これらのスコープ記述は起票時のもので、現状と合っていない。**

- 統合テストへ移した欠番（C-03〜C-10 など）が範囲に含まれたままになっている
- その後に増えたケース（C-45〜C-48、L-41〜L-49、U群、W群）がどのIssueにも入っていない

実施の際は、Issueのスコープ記述ではなく**本文書の「実施の順序」の区切り**に従う。
結果を書き込む先としてこれらのIssueを使う場合は、着手時にスコープ記述を現状へ直す。
