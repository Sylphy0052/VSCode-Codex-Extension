# WF-G Issue #589 引き継ぎ

## 1. 今どこにいるか

- ブランチ: `fix/589/intro-body-control-tools`（`origin/main` の `2c73657c` から分岐）
- worktree絶対パス: `/home/kfuruhashi/workspace/github/VSCode-Codex-Extension/.claude/worktrees/agent-adea22599c3f05363`
- Issue: #589
- PR: 作成準備完了（このあとcommit → PR作成）

`git status --short`:
```
 M docs/design.md
 M src/orchestrator/runnerOrchestrator.ts
 M test/unit/runner.test.ts
?? .agents/handoff/
```

`git diff --stat`:
```
 docs/design.md                         |  2 ++
 src/orchestrator/runnerOrchestrator.ts |  3 +++
 test/unit/runner.test.ts               | 19 +++++++++++++++++++
 3 files changed, 24 insertions(+)
```

`docs/design.md`の変更は§16.33（W8、Issue #583）の既存の穴の記録に「Issue #589で埋めた」旨を2行追記しただけ（節番号の新設はしていない。指示された§16.39は使っていない＝既存節の更新で足りたため）。

## 2. 測って確かめた事実と、それを測ったコマンド

- `git fetch origin && git log --oneline -1 origin/main` → `2c73657c Merge pull request #640 ...`（着手時点）。その後コーディネーターから `7571a19d`（`docs/roadmap/ops-rules.md` の1ファイルのみの差分）へ進んだ旨の連絡を受けた。差分がそのファイルのみのためrebase不要と判断（コーディネーターの指示どおり、まだ実測でrebase後の状態は見ていない）。
- `ORCHESTRATOR_CONTROL_TOOLS`（`src/orchestrator/messaging.ts:950`）の全要素を`grep`で実測: `get_run_status` / `stop_task` / `retry_task` / `continue_task` / `decide_approval` / `update_task_prompt` / `decide_final_merge` / `ask_user` / `add_task` / `remove_task` / `update_task_dependencies` の11個。
- 修正前の`buildIntroBody`出力（`test/unit/runner.test.ts`に追加したテストのRED実測）を確認したところ、案内文に無かったのは`decide_final_merge`**だけ**。他の10個はすべて既に列挙されていた（`get_run_status`はlist_tasksと並記、`add_task`等はまとめて列挙、等）。
- `npx vitest run test/unit/runner.test.ts -t "ORCHESTRATOR_CONTROL_TOOLS"`
  - 修正前: 1 failed（`AssertionError: 案内文にdecide_final_mergeが列挙されていない`）
  - 修正後（`buildIntroBody`へ`decide_final_merge`の1行を追加した後）: 1 passed
- `npm test`（vitestのユニットのみ、統合テストは含まない）: **Test Files 173 passed / Tests 3796 passed**（基準値3795+自分が足した1件で3796、一致）
- `npx tsc --noEmit`: 出力なし（エラー0件）
- `npm run lint`: 出力なし（警告0件）
- 統合テスト（`XDG_RUNTIME_DIR=/run/user/1000 npm run test:integration:xvfb`）: 1回目は**80 passing / 1 failing**（L-40が失敗、`AssertionError`でCLAUDE.md追記内容の正規表現不一致）。単体で`--grep "L-40"`を実行すると**1 passing**（順序依存のflaky）。全体を再実行すると**81 passing / 0 failing**（基準値と一致）。L-40失敗は自分の変更（`runnerOrchestrator.ts`/messaging系）と無関係なテスト（CLAUDE.mdへの直接追記機能）であり、コード変更前から存在する既知の順序依存と判断（ただしこの断定は今回の実測のみに基づく。過去に同種の記録がgotchasに無いか未確認）

## 3. 未確認のこと・推論でしかないこと

- コーディネーターが報告した「エディタ上の`test/unit/runner.test.ts` 6126行目・6171行目の`'key' is declared but its value is never read`」診断について: 自分のworktreeで該当行（`get<T>(key: string, defaultValue: T): T { return defaultValue; }`というテスト内フェイクの`WorkflowRunMemento.get`実装、複数箇所に同型パターンあり）を確認したが、これは**自分が触っていない既存コード**であり、`npm run lint`は0件で通っている。よってこの診断はエディタ側のstaleな診断か、別バッファのものだと推測する（**構造から言うと**、eslintの実行結果と食い違う診断はエディタ側のキャッシュの可能性が高いが、断定はできない）。
- `origin/main`が`7571a19d`へ進んだ後の状態は、まだ`git fetch`で自分のworktree上で確認していない（このファイル作成時点）。
- PRはまだ作成していないため、PR番号・CI状態は無し。

## 4. 次の一手

1. `git fetch origin`で`origin/main`が`7571a19d`かを確認する（rebaseは不要という指示だが、実測はしておく）
2. `git add`で対象ファイル（`docs/design.md` / `src/orchestrator/runnerOrchestrator.ts` / `test/unit/runner.test.ts` / `.agents/handoff/wf-g-issue-589.md`）をcommitする
3. `gh pr create`で`main`宛てのPRを作成する（統合ブランチは作らない）。本文には突き合わせテストの形と`ORCHESTRATOR_CONTROL_TOOLS`の全要素をどう列挙したかを書く
4. `gh pr diff <番号> | grep "^diff --git"`で意図しないファイルが含まれていないことを確認する
5. PRはマージしない（呼び出し元の判断）
6. このファイルをPR作成後の区切りで更新する（この一手が完了した時点で更新済み）
