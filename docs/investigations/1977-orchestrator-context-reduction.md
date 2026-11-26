# オーケストレータモードのコンテキスト量を減らす：残りの項目の調べ直し（Issue #1977）

調査日: 2026-10-18

## 目的と結論

Issue #1977の改善案のうち、#1980（`get_run_state`の差分取得、PR #1984）と#1981（イベント通知の削減、PR #1985）はmerge済み。残りの項目と確認点を、mainのコード（898c5e0b）と直近14日のtranscriptで調べ直した。

- #1980・#1981の効果は実測していない。動いている拡張ホストはmerge前の版で、merge後の版で走ったrunがまだ無い。Reload Window後のrunで、下の「効果の測り方」の手順で測る
- 改善案2（OrchestratorのBash）: 用途を分類した。Bashの結果は2,888回・204万字で、forge操作が29%、ファイル・transcriptの読取が30%を占める。Bashを禁止すると計画時のIssue読取やgit fetchもできなくなるため、禁止はしない
- 改善案4（MCPとskill）: 起票時の「利用者のMCP 224ツールが全部載る」はCodexでの実測で、Claude Codeには当てはまらない。Claude CodeはMCPのスキーマを遅延ロードし、工程セッションの初回で載るMCP関連は平均約1.4k字（`deferred_tools_delta`）と約3.4k字（`mcp_instructions_delta`、1,264本中344本）にとどまる。`disableMcpServers`・`disableSkills`はCodex側だけの指定で、Claude側は無視する（`src/orchestrator/taskSession.ts:167-183`）
- 改善案6（世代引き継ぎ）: 生成した引き継ぎ文書は今も使っていない。加えて、Orchestrator 109本のうち20本がhandoff skillを自分で呼んでいた。この出力も次の世代へ渡らない
- 確認点「Codexのrolloutでも同じ傾向か」: 2026年の`~/.codex/sessions/`に、Orchestrator・工程セッションの記録が1本も無い。比べられない

## 対象と方法

- 対象: `~/.claude/projects/*/*.jsonl`のうち更新が直近14日のもの。最初のユーザー発話が「あなたはオーケストレータモードの実行」で始まるものをOrchestrator（109本）、「オーケストレータモードの工程セッション」で始まるものを工程（1,282本）とした
- 字数はツール結果・添付の文字数。トークン数は工程セッションの最初のassistant応答の`usage`（入力・キャッシュ作成・キャッシュ読取の合計）
- 集計スクリプトは手元のscratch（`~/.cache/claude-scratch/VSCode-Codex-Extension/t5_*.py`）に置いた。repoには入れていない

## 項目ごとの結果

### 2. OrchestratorのBash

コマンドの先頭の語で分けた（先頭の`cd <dir> &&`は外した。パイプの後段は数えていない）。

| 区分                       | 回数  | 結果の字数 | 割合 | 主なコマンド                                                                     |
| -------------------------- | ----- | ---------- | ---- | -------------------------------------------------------------------------------- |
| forge操作                  | 911   | 60.0万     | 29%  | `glab issue view`（86回・12.0万字）、`glab mr view`、`gh issue view`、`glab api` |
| ファイル・transcriptの読取 | 約630 | 60.4万     | 30%  | `sed -n`（15.0万字）、`jq`、`grep`、`cat`、`tail`、`rg`、`ls`                    |
| git                        | 385   | 22.6万     | 11%  | `git fetch`、`git diff --stat`、`git show`、`git worktree`                       |
| 別ホスト・プロセスの確認   | 313   | 23.5万     | 12%  | `ssh`（17.1万字）、`ps`                                                          |
| その他                     | 約650 | 37.3万     | 18%  | `timeout ... claude -p`、`python3`、`for`、`handoff-collect.sh`（13回・2.8万字） |

- forge操作の多くは、計画時のIssue本文の読取と、工程の報告後のPR・Issueの確認。工程の報告とget_run_stateで足りる確認も混ざるが、コマンドの文字列からは切り分けられない
- 読取の多くは`~/.claude/projects/`配下のtranscriptや`tool-results/`、他repoのファイルで、Orchestratorの判断に要るものには見えない。`ssh`・`claude -p`も同様。Orchestratorのタブで利用者が別の調査を頼んだ可能性があり、transcriptからは区別できない
- 判断: Bashは禁止しない。代わりのMCPツールも足さない（forgeの読取はIssueごとに形が違い、ツールにしても字数は減らない）。#1980・#1981の後で取り直し、読取・sshが残るなら導入文で工程へ回すよう指示するかを決める

### 3. イベント通知（#1981の残り）

- #1981は`stageStarted`・`resourcePressure`・質問と関門の判断指示・推奨値の理由を減らした。`stageDone`（起票時の集計で859件・34.7万字）は対象外で、今も1件ずつ届く（`src/orchestrator/taskRunOrchestrator.ts:1403-1408`）
- 効果は未実測。測ってから`stageDone`を減らすかを決める

### 4. 工程セッションのMCPとskill

工程セッション1,264本（最初の応答まで記録があったもの）の初回の入力は中央値34.6k tok。初回までに載る添付の平均字数は次のとおり。

| 添付                     | 平均字数 | 載った本数 | 出所                                                 |
| ------------------------ | -------- | ---------- | ---------------------------------------------------- |
| `instructions`           | 22,521   | 1,264      | 利用者のCLAUDE.md・rules・MEMORY.md、repoのCLAUDE.md |
| `prompt_snapshot`        | 7,684    | 1,264      | 工程の指示文                                         |
| `sandbox_instructions`   | 5,961    | 1,264      | Claude Codeのsandbox設定                             |
| `skill_listing`          | 5,379    | 1,264      | skillの一覧                                          |
| `agent_listing_delta`    | 3,627    | 1,264      | subagentの一覧                                       |
| `mcp_instructions_delta` | 3,352    | 344        | MCPサーバの説明                                      |
| `hook_success`           | 3,239    | 1,264      | 利用者のSessionStart hook                            |
| `deferred_tools_delta`   | 1,448    | 1,264      | 遅延ロードするツールの名前                           |

- 実際に使った本数: Skillを呼んだ工程は1,282本中19本（`gitlab-commit` 7回、`besterra-wiki` 11回、`gitlab-screenshot` 1回）。task-messaging以外のMCPを使ったのは2本（playwright、計85回）
- skillは外さない。使った19本は、repoの規約がそのskillを求める場面（merge工程のwiki更新、commit）で、外すと規約を守れなくなる
- MCPはtask-messaging以外を外せる見込みが高い。ただしClaude側には外す配線が無く（`TaskSessionInput.disableMcpServers`はCodexだけ）、減るのは1本あたり最大約4.8k字（約1.5k tok前後、初回の4%程度）。screenshotを撮る工程ではplaywrightが要るため、外すなら工程の種類かrepoの設定で選べるようにする
- 初回で最も大きいのは`instructions`（平均2.25万字）で、利用者の設定に由来する。拡張側で減らす対象にはしない

### 5. 工程セッションの定型文

mainのコードで、起票時の記述がそのまま当てはまることを確かめた。

- 続行のたびの範囲の念押し（`stageScopeReminder`、`src/orchestrator/taskStagePrompts.ts:59`、続行は`src/orchestrator/taskStageRunner.ts:1283`）: 続行の指示が実際に届いた記録はほとんど無い（transcriptの文字列形式の本文の検索で1件）。効果は小さい
- 引き継ぎ文の前後に2回付ける（`buildStageHandoffPrompt`、`taskStagePrompts.ts:269-278`）: 残っている。1回あたり約480字
- Issue起票後も要約・受入基準を埋め込む（`taskStagePrompts.ts:95-134`）: 残っている
- issueCreateへIssue本文を全文で渡す（`taskStagePrompts.ts:151-173`、最大20,000字）: 残っている。起票の工程1回あたり本文の字数分

### 6. 世代引き継ぎの引き継ぎ文書

- Orchestratorの`onHandoff`（`src/orchestrator/taskRunOrchestrator.ts:413-446`）は今も`request.trigger`しか見ない。ホスト側は分類器でのmodel/effortの判定（`src/view/handoffModelChoice.ts`）、引き継ぎ文書とreplayの書き出し（`src/view/claudeChatView.ts:1465-1530`）を済ませてから委譲先を呼ぶ。Orchestratorではこれらが全部捨てられる
- 加えて、Orchestrator 109本中20本がhandoff skillを1回ずつ呼んでいた。利用者のhook（コンテキスト75%以上で`handoff`を指示）に従ったものと見られる。skillの本文と`handoff-collect.sh`の出力（13回・2.8万字）を読み込み、引き継ぎプロンプトを書く分だけ前の世代のコンテキストと時間を使うが、その出力は次の世代へ渡らない
- 工程セッションの引き継ぎは`request.prompt`を使っている（`taskStageRunner.ts:1522`）。工程でhandoff skillを呼んだ記録は0本

### 7. Orchestratorを短命にする

- 調べ直していない。#1980・#1981の効果を測ってから、1世代の伸び（起票時は中央値約92k tok）がどれだけ残るかで要否を決める

## 確認点

- 2・4は上で実測した
- Codexのrollout: 2026年の`~/.codex/sessions/`（直近14日の更新は59本）に、Orchestrator・工程セッションの記録が無い。オーケストレータモードはClaude Codeでだけ使われている

## 切り出し候補

見込みの大きい順。どれも着手が決まってから個別のIssueにする。

1. Orchestratorにhandoff skillを呼ばせない（6）。導入文に「引き継ぎは拡張が行う。handoff skillは呼ばない」と書く。あわせて、委譲先が引き継ぎ文書を使わないとき（Orchestrator）はホスト側の分類器の起動と文書の書き出しを省く
2. #1980・#1981の効果を実測し、`stageDone`の通知（3）とOrchestratorの短命化（7）の要否を決める。Issueにする前の作業で、Reload Window後のrunが要る
3. Claudeの工程セッションでtask-messaging以外のMCPを外す（4）。Claude側の配線から作る。playwrightを使う工程があるため選べるようにする。効果は1本あたり約1.5k tok
4. 工程の定型文（5）のうち、issueCreateへの本文全文の受け渡しと、引き継ぎ文の念押しの二重化をやめる。残りの2点（続行時の念押し、起票後の要約・受入基準）は効果が小さく見送る

見送り: OrchestratorのBashの禁止・代替ツール（2）。工程セッションのskillを外すこと（4）。

## 効果の測り方（#1980・#1981）

Reload Window後に走ったrun（3タスク以上）のOrchestratorのtranscriptで、次を起票時の値と比べる。

- `get_run_state`の結果: 1回あたりの平均字数（起票時6.0k字）と1世代あたりの合計
- `<task-run-event>`: 種類ごとの件数と字数（起票時は1世代平均約1.5万字）
- Orchestratorの1世代の伸び（起票時は中央値 初回43.5k → 終了135k tok）と、1 runの世代数
