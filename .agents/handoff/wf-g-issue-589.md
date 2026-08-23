# WF-G Issue #589 引き継ぎ

## 1. 今どこにいるか

- ブランチ: `fix/589/intro-body-control-tools`（`origin/main` の `2c73657c` から分岐）
- worktree絶対パス: `/home/kfuruhashi/workspace/github/VSCode-Codex-Extension/.claude/worktrees/agent-adea22599c3f05363`
- Issue: #589
- PR: #641（main宛て、作成済み。CIは`checks`/`external-cli`とも`pass`。まだマージしていない。マージ可否は呼び出し元の判断）

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

実装・PR作成・強化レビュー対応・CI緑まで完了済み。残っているのは:

1. 呼び出し元（WF-Gオーケストレーター）へ完了報告し、マージ可否の判断を仰ぐ（自分ではマージしない）

## 5. コーディネーターからの強化指摘（対応済み）

初回PR検分で「`expect(introBody).toContain(tool.name)`は案内文のどこかにツール名が現れれば通ってしまい、
散文（`ask_user`の拒否文がdecide_final_mergeに言及している等）だけでも満たせる」という指摘を受けた。
対応として、`introBody`を`\n`で行分割し「`- `で始まる行」だけを道具の列挙とみなし、その中に
`tool.name`が現れるかを検査する形へ変更した（`test/unit/runner.test.ts:8838`付近）。

- 強化後のテストが、修正前の`buildIntroBody`（`decide_final_merge`の1行を除いた状態）に対して
  改めてRED（`AssertionError: 道具の列挙行にdecide_final_mergeが無い`）になることを実測した
  （一時的に該当行を除去してテスト→復元、`git diff`で復元後に差分ゼロを確認済み）
- `npm test`: 173 files / 3796 tests、全pass（変わらず）
- `npx tsc --noEmit`: エラー0件、`npm run lint`: 警告0件
- 統合テストは対象範囲外（テストファイル内のみの変更）のため再実行していない（指示どおり）
- 変更は`test/unit/runner.test.ts`の自分が追加したブロック（8838行目〜）のみ。Issue #502担当が
  触るという12001行目付近には手を入れていない（`git diff`で確認済み）
- 追いcommit `1c953e7d`をpush、PR #641のCIは`checks`/`external-cli`とも`pass`
