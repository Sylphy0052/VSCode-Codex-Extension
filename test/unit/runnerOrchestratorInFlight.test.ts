import { describe, expect, it } from 'vitest';

import type { LiveOrchestrator } from '../../src/orchestrator/runner';
import { returnInFlightToPending } from '../../src/orchestrator/runnerOrchestrator';

function orchestrator(overrides: Partial<LiveOrchestrator>): LiveOrchestrator {
  return {
    pending: [],
    inFlight: [],
    inFlightUserTexts: [],
    pendingUserTexts: [],
    taskCleanupEventsInFlight: 0,
    ...overrides,
  } as unknown as LiveOrchestrator;
}

describe('returnInFlightToPending（Issue #1517）', () => {
  it('戻したcleanup通知の件数だけ減らし、ask_userで止まった前のターンの件数は残す', () => {
    const o = orchestrator({
      // 前のターン（ask_userで止まった）で1件、失敗したターンで1件
      taskCleanupEventsInFlight: 2,
      inFlight: [
        { kind: 'taskCleanup', body: 'Issue #2 のcleanupが完了しました' },
        { kind: 'taskMessage', body: '相談' },
      ],
      pending: [{ kind: 'taskMessage', body: '後から届いた相談' }],
    });

    returnInFlightToPending(o);

    expect(o.taskCleanupEventsInFlight).toBe(1);
    expect(o.inFlight).toEqual([]);
    expect(o.pending.map((e) => e.body)).toEqual([
      'Issue #2 のcleanupが完了しました',
      '相談',
      '後から届いた相談',
    ]);
  });

  it('件数は0より下げない', () => {
    const o = orchestrator({
      taskCleanupEventsInFlight: 0,
      inFlight: [{ kind: 'taskCleanup', body: 'x' }],
    });

    returnInFlightToPending(o);

    expect(o.taskCleanupEventsInFlight).toBe(0);
  });

  it('送った人の発話を、戻っていた発話より前へ戻す', () => {
    const o = orchestrator({
      inFlightUserTexts: ['1つ目'],
      pendingUserTexts: ['2つ目'],
    });

    returnInFlightToPending(o);

    expect(o.inFlightUserTexts).toEqual([]);
    expect(o.pendingUserTexts).toEqual(['1つ目', '2つ目']);
  });
});
