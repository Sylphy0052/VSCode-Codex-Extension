# WF-G Issue #579 引き継ぎ

## 1. 今どこにいるか（第1段階終了時点）

- ブランチ: `fix/579/waiting-approval-release`（`origin/main` の `2a59aec4` から作成）
- worktree絶対パス: `/home/kfuruhashi/workspace/github/VSCode-Codex-Extension/.claude/worktrees/agent-acf3140e397395f05`
- Issue: #579
- PR: 未作成（第1段階は再現確認と方針整理まで。実装は未着手）
- `git status --short`: （出力なし。クリーン。第1段階の作業は再現確認用の一時的なテスト追記のみで、確認後に `git checkout --` で元に戻した）
- `git diff --stat` （origin/main比較）: 変更なし（0 files changed）

## 2. 測って確かめた事実（実測。コマンド付き）

### 2-1. ベースラインのユニットテスト

```
npm test
```
結果: `Test Files 174 passed (174)` / `Tests 3800 passed (3800)`。指示書の基準値と一致。

（統合テストは第1段階では未実行。設計判断が出て実装に入る第2段階で `XDG_RUNTIME_DIR=/run/user/$(id -u) npm run test:integration:xvfb` を前景実行する）

### 2-2. grepによる経路の確認（Issueコメントの実測を自分でも数え直した）

```
grep -rn "scheduleApprovalTimeout\|mergeApprovalTimeoutSec" --include=*.ts src test
grep -rn "markWaitingApproval" --include=*.ts src
grep -rn "excludeFromActiveCount" --include=*.ts src
grep -rn "detectAllWaitingStalemate\|detectTimedOutWaitingReplies" --include=*.ts src
```

確認できたこと（コード上の事実、観測）:

- `markWaitingApproval`（`src/orchestrator/runState.ts:728`）の呼び出しは `src/orchestrator/runner.ts:3909` の1箇所のみ（`handleApproval`経由、通常タスクの承認要求時）
- `scheduleApprovalTimeout`（`src/orchestrator/runnerMerge.ts:782`）の呼び出しは `runnerMerge.ts:1019`（`startMergeResolution`内、衝突解決セッションの`session.onStateChanged`）の1箇所のみ。`live.mergeResolutions`側でしか動かない
- `isActiveTaskState`（`src/orchestrator/runState.ts:46`）は `running` / `waitingApproval` / `waitingReply` / `merging` の4状態を「枠を占める」として扱う
- `excludeFromActiveCount`（`src/orchestrator/runner.ts:2816-2822`）は `live.mergeResolutions` だけを集めて `nextTasksToStart` へ渡している。通常タスクの`waitingApproval`はここに入らない
- `checkWaitingReplyStalls`（`src/orchestrator/runnerMessaging.ts`内）が拾う `activeStates` は `isActiveTaskState` で「走行中」と判定した全状態（`waitingApproval`を含む）だが、`waitingSinceMsByTaskId` へ積むのは `s.state === 'waitingReply'` のタスクだけ。承認待ちの経過時間を渡す口は無い

これらはIssueコメント（2026-08-23の再現確認）の記述と完全に一致した。棚の記録を鵜呑みにせず、自分でgrepし直して数えた結果として確認。

### 2-3. 純関数レベルの再現（自分の手で実行、GREEN=現行のバグを含む挙動の記録）

一時ファイル `test/unit/issue579-repro-scratch.test.ts` を作成し、実行後に削除（コミットしていない）。

```typescript
detectAllWaitingStalemate(
  new Map([['A','waitingApproval'], ['B','waitingReply'], ['C','waitingReply']]),
  0,
) // => []

detectAllWaitingStalemate(
  new Map([['A','waitingReply'], ['B','waitingReply'], ['C','waitingReply']]),
  0,
) // => ['A','B','C']
```

実行結果: 2件とも成功（＝現行実装が上記のとおり動くことの確認。バグの副次効果を実測で裏取り）。

### 2-4. 統合ハーネスでのRED（自分の手で実行）

`test/unit/runner.test.ts` の既存ローカルヘルパー（`createHarness`/`fakeMessagingDeps`/`flush`/`vi.useFakeTimers`）を使い、「待ちぼうけの検出」describeブロック内に一時テストを追記して実行、確認後に `git checkout -- test/unit/runner.test.ts` で復元（コミットなし）。

テスト内容: `autoApprove: true` のタスクT1に危険なコマンド（`git push --force origin main`）で承認要求を出させ `waitingApproval` にした後、フェイクタイマーで24時間進める（`readReplyTimeoutSec: 10`, `readMergeApprovalTimeoutSec: 60` を設定した状態で、両方を大きく超える時間）。

実行コマンド:
```
npx vitest run --config vitest.config.ts test/unit/runner.test.ts -t "TEMP REPRO Issue #579"
```

結果（RED）:
```
AssertionError: expected 'waitingApproval' not to be 'waitingApproval' // Object.is equality
 ❯ test/unit/runner.test.ts:7255:57
```

24時間経ってもT1は`waitingApproval`のまま。**再現は成立した。** Issueコメントの実測（`test/unit/issue579.test.ts`での再現）と同じ結果を、自分の手で独立に再現できた。

## 3. 未確認のこと・推論でしかないこと

- 統合テスト（`test:integration:xvfb`）でこの経路が実際に問題になるかは未検証（第1段階では実行していない）
- 「実害か仕様か」の最終判断はユーザー（呼び出し元）に委ねる。以下は構造から言えることの整理であり、断定ではない
- 直し方の各案が壊しうるものの列挙は、既存コードを読んだ上での推論。実際にその経路を通すテストは第2段階（方針確定後）で書く

## 4. 次の一手

方針確定待ち（下記「報告」参照）。方針が返ってきたら:

1. 選ばれた案に沿って `src/orchestrator/runState.ts` / `runner.ts` 等へ実装
2. RED→GREENのテストを新規ファイル（例: `test/unit/runStateWaitingApproval.test.ts`）または`runState`系の既存テストファイルへ追加（`test/unit/runner.test.ts`は他の回でも触るため避ける）
3. `npm test` 174 files/3800 tests以上・全pass、`npx tsc --noEmit` 0件、`npm run lint` 0件、統合テスト81 passing/0 failing（前景）を確認
4. 設定キーを新設する場合は `docs/design.md` §16.16（設定一覧）とREADMEを更新。新設の節が要る場合は §16.39 を使う
5. `docs/manual-test.md` へケースを足す必要が出たら、番号を自分で決めず報告する
6. `gh pr create` で main宛てPR作成（マージはしない）

## 5. 第2段階（実装）チェックポイント

### 5-1. 方針（コーディネーター確定）

- 案A-2 + 案B の両方（片方だけの半端な修正はしない）
- A-2: 新設定キー `agent.workflows.taskApprovalTimeoutSec`（`mergeApprovalTimeoutSec`の使い回しはしない。§16.17/§16.5の記述が事実と食い違うため）
- B: `checkWaitingReplyStalls`（`runnerMessaging.ts`）の`activeStates`から`waitingApproval`を除外し、経路1のwaitingReply解放をwaitingApprovalが1件でも塞ぐ副次効果を止める
- 解放後の状態は`blocked`ではなく`failed`＋新しい`failure.kind`。新kind名は当初`approvalTimedOut`だったが、`runnerMerge.ts`の`localOnlyStopKind: 'approvalTimeout'`/`MergeResolutionEntry.approvalTimeoutTimer`（既存16箇所、マージ解決セッション専用・`blocked`行き）と1文字違いで衝突しやすいため、コーディネーターの指示で`taskApprovalTimedOut`へ訂正
- 新kindの3性質: (1)`retries`の自動再試行対象にしない、(2)`approvalRejected`（人の拒否）とは区別、(3)`haltedByUser`には触れない
- W10自動再開（`applyAutoResume`）のホワイトリストは無改修のまま、新kindは自動的に対象外（構造で担保、テストで固定）

### 5-2. 実装した変更（ファイル別）

- `src/orchestrator/runState.ts`: `TaskFailureReason`ユニオンの末尾（`reloadInterrupted`の後）に`{ readonly kind: 'taskApprovalTimedOut' }`を追加（JSDocで`approvalTimeout`との区別・3性質・auto-resume除外を明記）。`markApprovalRejected`の直後に`markTaskApprovalTimedOut(run, tasks, taskId)`を新設（構造は`markApprovalRejected`と同型）
- `src/orchestrator/runnerApproval.ts`（新規）: `DEFAULT_TASK_APPROVAL_TIMEOUT_SEC = 3600`、`scheduleTaskApprovalTimeout`（公開）、`handleTaskApprovalTimeout`（非公開）。`runnerMerge.ts`の`scheduleApprovalTimeout`/`handleMergeApprovalTimeout`と同じ「毎回clearTimeoutしてから条件付きsetTimeout+unref」パターン。多層防御（`waitingApprovalSinceMs`の一致チェック＋現在の`state`再確認）も同型
- `src/orchestrator/runner.ts`: `WorkflowRunnerDeps.readTaskApprovalTimeoutSec?`追加。`LiveTask`に`waitingApprovalSinceMs`/`taskApprovalTimeoutTimer`/`taskApprovalTimedOut`を追加。`handleApproval()`で`markWaitingApproval`直後にタイマー起動、`onApprovalResolved()`でタイマー解除、`onTaskFinished()`で`reason==='taskStopped' && liveTask?.taskApprovalTimedOut===true`のときだけ`markTaskApprovalTimedOut`へ分岐（それ以外は従来どおり`applyLoopStopReason`）
- `src/orchestrator/runnerMessaging.ts`: `checkWaitingReplyStalls`の`activeStates`収集条件に`&& s.state !== 'waitingApproval'`を追加（案B）
- `src/config.ts`: `taskApprovalTimeoutSec`フィールド・`normalizeTaskApprovalTimeoutSec`（`normalizeMergeApprovalTimeoutSec`と同型、`MAX_TIMEOUT_SEC=2147483`共有）
- `src/extension.ts`: `readTaskApprovalTimeoutSec`の配線を追加
- `package.json`: `contributes.configuration.properties`に`agent.workflows.taskApprovalTimeoutSec`を`mergeApprovalTimeoutSec`の直後へ追加（type number, default 3600, min 1, max 2147483）
- `README.md`: ワークフロー設定表に行を追加（Bash/python3経由。Edit/Writeでの直接編集はしていない）
- `docs/design.md`: §16.16の表に行を追加し「全15項目」→「全16項目」（実際に行数を数え直して修正）、§16.17に2つのタイムアウトキーが互いに独立している旨の補足段落を追加、新設 §16.39「通常タスクの承認待ちにも時間切れの解放を持たせる（Issue #579）」を末尾に追加（`approvalTimeout`（マージ、→`blocked`）と`taskApprovalTimedOut`（通常タスク、→`failed`）が別物である旨も明記）
- `src/view/workflowScript.ts`: **意図的に未修正**。`FAILURE_LABEL[kind] || kind`のフォールバックがあるため新kindは生の英語文字列で表示されるだけでクラッシュはしない。担当範囲（`src/orchestrator/`）外のため、対応要否は保留し報告する

### 5-3. 追加したテスト

- `test/unit/runnerTaskApproval.test.ts`（新規、`runnerDispose.test.ts`と同じ「自己完結ハーネス複製」方針。理由をファイル冒頭JSDocに明記）: RED→GREEN本体、承認が先に来れば時間切れが起きないこと、拒否が先に来れば`approvalRejected`のままなこと（回帰）、`stopTask()`で止めた場合は`manualStop`のままなこと（回帰、タイマーの状態ガードの確認を兼ねる）、依存する後続の`dependencyFailed`/`skipped`カスケードが新kindでも変わらないこと、案Bの副次効果修正（waitingApprovalが1件あっても他タスクのwaitingReplyが経路1で解放されること）の6ケース
- `test/unit/runState.test.ts`: `markTaskApprovalTimedOut`の状態ガード2ケース、`applyAutoResume`が新kindを「他の失敗」として扱いW10自動再開を諦めさせることの回帰1ケース
- `test/unit/config.test.ts`: `taskApprovalTimeoutSec`の既定値・指定値・不正値フォールバック・上限、`mergeApprovalTimeoutSec`と互いに影響しないことの計4ケース

### 5-4. 実測結果（すべて第2段階でコマンド実行して確認）

- `npx tsc --noEmit`: 0エラー
- `npm run lint`: 0警告
- `npm test`: `Test Files 175 passed (175)` / `Tests 3813 passed (3813)`（基準174/3800を超過。新規テスト計13ケース分の増分と一致）
- `XDG_RUNTIME_DIR=/run/user/1000 npm run test:integration:xvfb`（前景実行）: `81 passing (44s)`、`Exit code: 0`、failing 0件

### 5-5. 未解決・報告事項（コーディネーターへの確認待ち）

1. `docs/manual-test.md`: `mergeApprovalTimeoutSec`/`waitingApproval`/`承認待ち.*タイムアウト`でgrepしたが、時間切れ専用のケースは既存に無い（3600秒待つ手動テストは非現実的なため、そもそも要らない可能性が高いという推論）。ケース追加が必要かどうか、必要ならケース番号を指示してほしい（自分では採番しない）
2. `src/view/workflowScript.ts`の`FAILURE_LABEL`マップに`taskApprovalTimedOut`の日本語ラベルが無い（フォールバックで生の英語文字列が出るだけでクラッシュはしない）。担当範囲外のため未着手。対応要否・担当を指示してほしい

## 6. 次の一手（この引き継ぎ更新時点）

1. `git add`で変更ファイルをステージし、Conventional Commits短形でコミット（`--no-verify`は使わない）
2. `git diff --stat`で差分がスコープ内（上記ファイル一覧）に収まっていることを再確認
3. `gh pr create` で `main` 宛てPRを作成（マージはしない）
4. `gh pr diff <番号> | grep "^diff --git"` で意図しないファイルが混ざっていないか確認
5. 上記5-5の2件を含め、実測結果一式をコーディネーターへ報告
