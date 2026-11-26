---
name: roadmap-plan-needs-all-children
description: ロードマップIssueの着手順の区画には、チェックリストの子Issueを1件残らず載せる。載せないと計画の検証で弾かれる。「着手条件待ちは着手順に載せない」という書き方は誤り
updated: 2026-11-27
---

# ロードマップの着手順には、チェックリストの子Issueをすべて載せる

## 何が起きたか

ロードマップ#1457の冒頭には、2026-11-16ごろから「#1324・#1381は着手条件を待っているので、Kanban実行用の着手順には載せていない（着手順に無い子Issueはrunのタスクにならない）」と書かれていた。ところが実際の着手順の区画には、#2181・#1324・#1381が載っていた（オーケストレータが計画を作るときに足していた）。

2026-11-27に#1457を整理したとき、この食い違いに気づいた。コードを確かめると、冒頭の説明のほうが誤っていた。

## なぜ

- `src/orchestrator/roadmapImport.ts`の`validateRoadmapPlan`は、チェックリストの子Issue（`- [ ] #<番号>` / `- [x] #<番号>`の行）がすべて計画に載っているかを確かめる。1件でも欠けていれば`子Issue#<番号>が計画にありません`のエラーを出し、その計画は実行に使われない
- つまり「チェックリストには載せるが、着手順からは外す」という状態は作れない。冒頭の説明は、この検証が入る前の挙動か、検証を確かめずに書いたものと考えられる

## どうするか

- 着手順の区画には、チェックリストの子Issueを1件残らず載せる。着手条件を待つIssueも、`段1 依存: なし`などで載せる
- 着手条件を待つIssueしか残っていないときは、条件を満たすまでrunを起動しない。runの対象から外す手段は、チェックリストから外すことだけ
- ロードマップの本文を書き換えたら、反映後の本文を`extractRoadmapChildren`・`findRoadmapPlanSection`・`parseRoadmapPlanSection`・`validateRoadmapPlan`に通し、エラーが0件か確かめる。4つの関数を`src/orchestrator/roadmapImport.ts`からimportする小さな`.ts`をscratchに書き、`node_modules/.bin/esbuild <script>.ts --bundle --platform=node --external:vscode --outfile=<scratch>/check_plan.cjs`で束ね、`gh issue view <番号> --json body -q .body`で取った本文のファイルを`node <scratch>/check_plan.cjs <本文>`に渡す。本文が空でないこと（`test -s`）を先に確かめる
- ロードマップの説明文に、コードの挙動についての主張（「〜はrunのタスクにならない」など）を書くときは、該当コードを確かめてから書く

関連: #1457
