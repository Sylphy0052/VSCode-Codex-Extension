# Issue #527 引き継ぎ

worktree: `.claude/worktrees/fix-527-merge-succeeded-restore`
branch: `fix/527/merge-succeeded-restore`
base: `b2354234`（main、最新）

## 第1段階（再現、実装なし）完了

Issue本文の5ステップをそのまま自動テストにした:
`test/unit/runState.test.ts`
`describe('マージの結果に応じた遷移（design.md §16.17）') > describe('markMergeSucceeded') > it('（Issue #527）2つの親からmergeBlockedされた後続が、停止解除後の再マージ成功で自動復帰する')`

シナリオ:
- T4はT2・T6の2つの親に依存する合流タスク
- T2・T6を`markMergeBlocked`でblockedにし、T4を`skipped(mergeBlocked, blockedTaskIds:['T2','T6'])`にする
- `haltedByUser: true`にしてからT2を再マージ成功 → T4は`isRunHalted`中のため`skipped(runHalted)`へ書き換わる（意図どおり）
- T4とは無関係なT5（回数切れで`failed`）へ`retryTask`を呼び、`haltedByUser`を解除する
- T6を再マージ成功 → 現状のフィルタ（`s.failure?.kind !== 'mergeBlocked'`）はT4の`failure.kind`が
  もう`mergeBlocked`ではない（`runHalted`のまま）ことを理由に素通りし、`pending`へ戻さない

RED実測ログ（`npx vitest run test/unit/runState.test.ts -t "Issue #527"`）:

```
FAIL  test/unit/runState.test.ts > マージの結果に応じた遷移（design.md §16.17） > markMergeSucceeded > （Issue #527）2つの親からmergeBlockedされた後続が、停止解除後の再マージ成功で自動復帰する
AssertionError: expected 'skipped' to be 'pending' // Object.is equality

Expected: "pending"
Received: "skipped"

 ❯ test/unit/runState.test.ts:853:40
    851|
    852|       // 5. T4は自動でpendingへ戻る（依存する親T2・T6が両方done）べきである
    853|       expect(stateOf(run, 'T4').state).toBe('pending');
       |                                        ^
    854|       expect(stateOf(run, 'T4').failure).toBeUndefined();

 Test Files  1 failed (1)
      Tests  1 failed | 72 skipped (73)
```

テストはステップ1〜4のアサーション（T2/T6両方のblockedTaskIds、T4のrunHalted遷移、
retryTask後のisRunHalted解除、T6のdone遷移）を全て通過した上でステップ5だけが失敗しており、
再現手順を過不足なくなぞれていることを確認済み。

テスト末尾では、修正後に満たすべき追加条件（PR #517の不変条件）も併記済み:
- `nextTasksToStart(d, run)`がT4を実際に拾うこと
- `getRunOutcome(run)`が`'running'`のまま（孤立`pending`にならない）こと
これらは現状のコードでは（T4がskippedのままのため）到達すらしない。

## 次（第2段階、未着手）

オーケストレーターの判断待ち。方向性はIssue本文どおり
「復帰判定を`failure.kind`ではなく依存する親が全てdoneかで行う」。

- `markMergeSucceeded`の復帰フィルタ（`src/orchestrator/runState.ts:658`付近）を、
  `failure.kind === 'mergeBlocked'`ではなく「対象タスクの`dependsOn`が全て`done`か」で
  判定する形へ変更する案
- 変更対象JSDoc: `markMergeSucceeded`直上のJSDoc（`runState.ts:635`付近）の
  「副作用として、複数の親からブロックされていたタスクは自動復帰しなくなる」の記述が
  嘘になるため同時に直す
- `docs/design.md` §16.40を新設（オーケストレーター割当済み番号、§16.39が最新）
- `docs/manual-test.md`のケース要否は要判断（番号はオーケストレーターが割り当てる、W-Rが最新）
