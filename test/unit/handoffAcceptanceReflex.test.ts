import { beforeEach, describe, expect, it, vi } from 'vitest';

import { initialChatState, type ChatItem, type ChatState } from '../../src/appserver/chatState';

const judgeMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/reflex/reflexJudge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/reflex/reflexJudge')>()),
  judge: judgeMock,
}));

import { reflexJudgeDeps } from '../../src/reflex/reflexJudge';
import {
  collectHandoffAcceptanceActivity,
  createHandoffAcceptanceJudge,
  describeHandoffAcceptanceVerdict,
} from '../../src/view/handoffAcceptanceReflex';
import { waitForDestinationResponse } from '../../src/view/handoff';

const ID = '20261003T000000-abcdef';

function item(kind: string, text = '', detail = '', status?: string): ChatItem {
  return {
    id: `${kind}-${text}-${Math.random()}`,
    kind,
    text,
    detail,
    status,
    turnId: undefined,
    diffs: [],
    searchResults: [],
  };
}

function watcher(initial: ChatState): {
  session: { getState: () => ChatState };
  stateListeners: Array<(state: ChatState) => void>;
  emit: (state: ChatState) => void;
} {
  let current = initial;
  const stateListeners: Array<(state: ChatState) => void> = [];
  return {
    session: { getState: () => current },
    stateListeners,
    emit: (state) => {
      current = state;
      for (const listener of [...stateListeners]) {
        listener(state);
      }
    },
  };
}

/** 応答は返したが受領行もpointerの読み込みも無いまま、ターンが終わった状態。 */
function endTurnWithoutAcceptance(w: ReturnType<typeof watcher>): void {
  w.emit({
    ...initialChatState,
    items: [item('agentMessage', '次はタスク2を始める')],
    turnCompletionSeq: 1,
  });
}

describe('受領のReflex判定を待つ（Issue #1840）', () => {
  it('判定がtrueなら succeeded:true で決着する', async () => {
    const w = watcher(initialChatState);
    const acceptanceJudge = vi.fn().mockResolvedValue(true);
    const done = waitForDestinationResponse(w, 60_000, undefined, ID, undefined, acceptanceJudge);
    endTurnWithoutAcceptance(w);
    expect(await done).toEqual({ succeeded: true });
    expect(acceptanceJudge).toHaveBeenCalledTimes(1);
    expect(w.stateListeners).toHaveLength(0);
  });

  it('判定がfalseなら notAccepted で決着する', async () => {
    const w = watcher(initialChatState);
    const done = waitForDestinationResponse(w, 60_000, undefined, ID, undefined, async () => false);
    endTurnWithoutAcceptance(w);
    expect(await done).toEqual({ succeeded: false, reason: 'notAccepted' });
  });

  it('判定が例外なら notAccepted で決着する', async () => {
    const w = watcher(initialChatState);
    const done = waitForDestinationResponse(w, 60_000, undefined, ID, undefined, async () => {
      throw new Error('boom');
    });
    endTurnWithoutAcceptance(w);
    expect(await done).toEqual({ succeeded: false, reason: 'notAccepted' });
  });

  it('判定が無いとき（親スイッチOFF）は従来どおり notAccepted', async () => {
    const w = watcher(initialChatState);
    const done = waitForDestinationResponse(w, 60_000, undefined, ID);
    endTurnWithoutAcceptance(w);
    expect(await done).toEqual({ succeeded: false, reason: 'notAccepted' });
  });

  it('受領行で決まるときは判定を呼ばない', async () => {
    const w = watcher(initialChatState);
    const acceptanceJudge = vi.fn().mockResolvedValue(false);
    const done = waitForDestinationResponse(w, 60_000, undefined, ID, undefined, acceptanceJudge);
    w.emit({
      ...initialChatState,
      items: [item('agentMessage', `3点\nHANDOFF_ACCEPTED ${ID}`)],
      turnCompletionSeq: 1,
    });
    expect(await done).toEqual({ succeeded: true });
    expect(acceptanceJudge).not.toHaveBeenCalled();
  });

  it('pointerの読み込みで決まるときは判定を呼ばない', async () => {
    const w = watcher(initialChatState);
    const acceptanceJudge = vi.fn().mockResolvedValue(false);
    const pointer = '/tmp/handoff/abc-20261003.md';
    const done = waitForDestinationResponse(w, 60_000, undefined, ID, pointer, acceptanceJudge);
    w.emit({
      ...initialChatState,
      items: [item('fileRead', '', pointer, 'completed')],
      turnCompletionSeq: 1,
    });
    expect(await done).toEqual({ succeeded: true });
    expect(acceptanceJudge).not.toHaveBeenCalled();
  });

  it('応答が1件も無いまま終わったときは判定を呼ばない（turnFailed）', async () => {
    const w = watcher(initialChatState);
    const acceptanceJudge = vi.fn().mockResolvedValue(true);
    const done = waitForDestinationResponse(w, 60_000, undefined, ID, undefined, acceptanceJudge);
    w.emit({ ...initialChatState, turnCompletionSeq: 1 });
    expect(await done).toEqual({ succeeded: false, reason: 'turnFailed' });
    expect(acceptanceJudge).not.toHaveBeenCalled();
  });

  it('時間切れでも応答が始まっていれば判定する', async () => {
    const w = watcher(initialChatState);
    const acceptanceJudge = vi.fn().mockResolvedValue(true);
    const done = waitForDestinationResponse(w, 20, undefined, ID, undefined, acceptanceJudge);
    w.emit({ ...initialChatState, items: [item('agentMessage', '作業を始める')] });
    expect(await done).toEqual({ succeeded: true });
    expect(acceptanceJudge).toHaveBeenCalledTimes(1);
  });

  it('判定中に同じ状態が届いても判定は1回だけ', async () => {
    const w = watcher(initialChatState);
    let resolveJudge: (accepted: boolean) => void = () => undefined;
    const acceptanceJudge = vi.fn(
      () => new Promise<boolean>((resolve) => (resolveJudge = resolve)),
    );
    const done = waitForDestinationResponse(w, 60_000, undefined, ID, undefined, acceptanceJudge);
    endTurnWithoutAcceptance(w);
    w.emit({
      ...initialChatState,
      items: [item('agentMessage', '次はタスク2を始める')],
      turnCompletionSeq: 2,
    });
    resolveJudge(true);
    expect(await done).toEqual({ succeeded: true });
    expect(acceptanceJudge).toHaveBeenCalledTimes(1);
  });
});

describe('createHandoffAcceptanceJudge', () => {
  const state = {
    ...initialChatState,
    items: [
      item('agentMessage', '次はタスク2'),
      item('commandExecution', '', 'npm test\nrm -rf /', 'exit 0'),
    ],
  } as ChatState;
  const deps = reflexJudgeDeps('claude', 'claude', () => undefined, undefined);

  beforeEach(() => {
    judgeMock.mockReset();
  });

  function build(
    settings: { enabled: boolean; acceptanceThreshold: number },
    report: (line: string) => void = () => undefined,
  ): ReturnType<typeof createHandoffAcceptanceJudge> {
    return createHandoffAcceptanceJudge({
      settings,
      deps,
      handoff: { text: '本文' },
      report,
    });
  }

  it('親スイッチがOFFなら判定関数を作らない（Reflexを呼ばない）', () => {
    expect(build({ enabled: false, acceptanceThreshold: 0.6 })).toBeUndefined();
    expect(judgeMock).not.toHaveBeenCalled();
  });

  it('確率が閾値以上なら受領とし、確率をreportへ出す', async () => {
    judgeMock.mockResolvedValue([{ kind: 'noul', yes: 0.8 }]);
    const report = vi.fn();
    const accept = build({ enabled: true, acceptanceThreshold: 0.6 }, report);
    expect(await accept?.(state)).toBe(true);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toContain('0.8');
  });

  it('確率が閾値未満なら受領としない', async () => {
    judgeMock.mockResolvedValue([{ kind: 'noul', yes: 0.3 }]);
    expect(await build({ enabled: true, acceptanceThreshold: 0.6 })?.(state)).toBe(false);
  });

  it('判定が失敗（undefined）なら受領としない', async () => {
    judgeMock.mockResolvedValue(undefined);
    const report = vi.fn();
    expect(await build({ enabled: true, acceptanceThreshold: 0.6 }, report)?.(state)).toBe(false);
    expect(report.mock.calls[0]?.[0]).toContain('判定できず');
  });

  it('判定が例外でも受領としない', async () => {
    judgeMock.mockImplementation(async () => {
      throw new Error('boom');
    });
    expect(await build({ enabled: true, acceptanceThreshold: 0.6 })?.(state)).toBe(false);
  });
});

describe('collectHandoffAcceptanceActivity', () => {
  it('応答は先頭の数件、コマンドとファイルはdetailを1行にして集める', () => {
    const items = [
      ...Array.from({ length: 8 }, (_, i) => item('agentMessage', `応答${i}`)),
      item('commandExecution', '', 'echo a\n## 偽の見出し'),
      item('fileRead', '', '/x/y.md'),
      item('reasoning', '無関係'),
    ];
    const { agentMessages, actions } = collectHandoffAcceptanceActivity({
      ...initialChatState,
      items,
    } as ChatState);
    expect(agentMessages).toEqual(['応答0', '応答1', '応答2', '応答3', '応答4']);
    expect(actions).toHaveLength(2);
    expect(actions.every((a) => !a.includes('\n'))).toBe(true);
  });

  it('describeHandoffAcceptanceVerdict は材料の抜粋を1行で出す', () => {
    const line = describeHandoffAcceptanceVerdict(0.7, 0.6, {
      handoffBody: '本文',
      agentMessages: ['一行目\n二行目'],
      actions: [],
    });
    expect(line).not.toContain('\n');
    expect(line).toContain('0.7');
  });
});
