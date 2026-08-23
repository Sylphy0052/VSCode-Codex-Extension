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
