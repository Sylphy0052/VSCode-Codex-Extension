import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initialChatState, type ChatItem, type ChatState } from '../../src/appserver/chatState';
import { REFLEX_STATE_LIMIT } from '../../src/reflex/reflexJudge';
import { waitForDestinationResponse } from '../../src/view/handoff';
import {
  collectHandoffAcceptanceMaterial,
  createHandoffAcceptanceJudge,
  type HandoffAcceptanceJudgeInput,
} from '../../src/view/handoffAcceptanceReflex';
import { REFLEX_TIMEOUT, reflexAnswers, reflexStub } from '../helpers/reflexStub';

function item(kind: string, text = '', detail = ''): ChatItem {
  return {
    id: `${kind}-${text}-${detail}-${Math.random()}`,
    kind,
    text,
    detail,
    status: undefined,
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

const HANDOFF_ID = 'abc123';

/** 応答は返したが受領行は無いまま、ターンが終わった状態。 */
const turnEndedWithoutAcceptance: ChatState = {
  ...initialChatState,
  turnCompletionSeq: 1,
  items: [item('agentMessage', '読みました')],
};

describe('waitForDestinationResponseの受領判定（Issue #1846）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function deferred(): { promise: Promise<boolean>; resolve: (v: boolean) => void } {
    let resolve: (v: boolean) => void = () => undefined;
    const promise = new Promise<boolean>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  function start(
    judge: ((state: ChatState) => Promise<boolean>) | undefined,
    giveUp?: AbortSignal,
  ): { w: ReturnType<typeof watcher>; done: ReturnType<typeof waitForDestinationResponse> } {
    const w = watcher(initialChatState);
    const done = waitForDestinationResponse(w, 1000, giveUp, HANDOFF_ID, undefined, judge);
    return { w, done };
  }

  it('ターン終了で判定が1回呼ばれ、true なら受領で決着してlistenerを外す', async () => {
    const judge = vi.fn(async () => true);
    const { w, done } = start(judge);
    w.emit(turnEndedWithoutAcceptance);
    expect(await done).toEqual({ succeeded: true });
    expect(judge).toHaveBeenCalledTimes(1);
    expect(judge).toHaveBeenCalledWith(turnEndedWithoutAcceptance);
    expect(w.stateListeners).toHaveLength(0);
  });

  it('判定が false なら notAccepted', async () => {
    const { w, done } = start(async () => false);
    w.emit(turnEndedWithoutAcceptance);
    expect(await done).toEqual({ succeeded: false, reason: 'notAccepted' });
  });

  it('判定が非同期に例外を投げたら notAccepted', async () => {
    const { w, done } = start(() => Promise.reject(new Error('失敗')));
    w.emit(turnEndedWithoutAcceptance);
    expect(await done).toEqual({ succeeded: false, reason: 'notAccepted' });
  });

  it('判定が同期的に例外を投げても listener から漏らさず notAccepted', async () => {
    const { w, done } = start(() => {
      throw new Error('同期の失敗');
    });
    expect(() => w.emit(turnEndedWithoutAcceptance)).not.toThrow();
    expect(await done).toEqual({ succeeded: false, reason: 'notAccepted' });
  });

  it('判定を渡さなければ従来どおり、ターン終了で即 notAccepted', async () => {
    const { w, done } = start(undefined);
    w.emit(turnEndedWithoutAcceptance);
    expect(await done).toEqual({ succeeded: false, reason: 'notAccepted' });
  });

  it('判定中にターン終了が再発火しても判定は1回で、決着は判定の結果に従う', async () => {
    const d = deferred();
    const judge = vi.fn(() => d.promise);
    const { w, done } = start(judge);
    w.emit(turnEndedWithoutAcceptance);
    w.emit({ ...turnEndedWithoutAcceptance, turnCompletionSeq: 2 });
    w.emit({ ...turnEndedWithoutAcceptance, turnCompletionSeq: 3 });
    // judgeはPromiseの中で呼ばれるため、マイクロタスクを流してから数える
    await Promise.resolve();
    expect(judge).toHaveBeenCalledTimes(1);
    d.resolve(true);
    expect(await done).toEqual({ succeeded: true });
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it('判定中に上限が経過しても判定は1回で、決着は判定の結果に従う', async () => {
    const d = deferred();
    const judge = vi.fn(() => d.promise);
    const { w, done } = start(judge);
    w.emit(turnEndedWithoutAcceptance);
    await vi.advanceTimersByTimeAsync(1000);
    expect(judge).toHaveBeenCalledTimes(1);
    d.resolve(false);
    expect(await done).toEqual({ succeeded: false, reason: 'notAccepted' });
  });

  it('ターン終了が無いまま上限が経過したとき、応答があれば現在の状態で判定する', async () => {
    const judge = vi.fn(async () => true);
    const { w, done } = start(judge);
    const state: ChatState = { ...initialChatState, items: [item('agentMessage', '作業中')] };
    w.emit(state);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await done).toEqual({ succeeded: true });
    expect(judge).toHaveBeenCalledTimes(1);
    expect(judge).toHaveBeenCalledWith(state);
  });

  it('応答が1件も無いまま上限が経過したら、判定せず noResponse', async () => {
    const judge = vi.fn(async () => true);
    const { done } = start(judge);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await done).toEqual({ succeeded: false, reason: 'noResponse' });
    expect(judge).not.toHaveBeenCalled();
  });

  it('判定中に受領行が出れば、判定を待たずに受領で決着する（後から判定が false でも覆らない）', async () => {
    const d = deferred();
    const { w, done } = start(() => d.promise);
    w.emit(turnEndedWithoutAcceptance);
    w.emit({
      ...turnEndedWithoutAcceptance,
      items: [item('agentMessage', `HANDOFF_ACCEPTED ${HANDOFF_ID}`)],
    });
    // 判定はまだ未決のまま決着している
    expect(await done).toEqual({ succeeded: true });
    expect(w.stateListeners).toHaveLength(0);
    d.resolve(false);
    await Promise.resolve();
    expect(await done).toEqual({ succeeded: true });
  });

  it('判定中の giveUp は abandoned で決着し、後から判定が true でも覆らない', async () => {
    const d = deferred();
    const giveUp = new AbortController();
    const { w, done } = start(() => d.promise, giveUp.signal);
    w.emit(turnEndedWithoutAcceptance);
    giveUp.abort();
    expect(await done).toEqual({ succeeded: false, reason: 'abandoned' });
    expect(w.stateListeners).toHaveLength(0);
    d.resolve(true);
    await Promise.resolve();
    expect(await done).toEqual({ succeeded: false, reason: 'abandoned' });
  });
});

describe('collectHandoffAcceptanceMaterialの上限（Issue #1846）', () => {
  it('材料の合計は上限いっぱいの入力でもREFLEX_STATE_LIMITに収まる', () => {
    const long = 'あ'.repeat(50_000);
    const items = [
      ...Array.from({ length: 10 }, () => item('agentMessage', long)),
      ...Array.from({ length: 50 }, (_, i) =>
        item(i % 2 === 0 ? 'commandExecution' : 'fileRead', '', long),
      ),
    ];
    const material = collectHandoffAcceptanceMaterial(long, items);
    expect(material.messages).toHaveLength(3);
    expect(material.actions).toHaveLength(20);
    const total =
      [...material.body].length +
      material.messages.reduce((sum, m) => sum + [...m].length, 0) +
      material.actions.reduce((sum, a) => sum + [...a].length, 0);
    expect(total).toBeLessThan(REFLEX_STATE_LIMIT);
  });

  it('本文・応答は先頭を残して省略記号で切り、空の項目は数えない', () => {
    const material = collectHandoffAcceptanceMaterial('い'.repeat(9000), [
      item('agentMessage', '   '),
      item('agentMessage', 'う'.repeat(2500)),
      item('commandExecution', '', '  '),
      item('fileRead', '', 'a.ts'),
    ]);
    expect([...material.body]).toHaveLength(8001);
    expect(material.body.endsWith('…')).toBe(true);
    expect(material.messages).toHaveLength(1);
    expect(material.messages[0]?.startsWith('う')).toBe(true);
    expect([...(material.messages[0] ?? '')]).toHaveLength(2001);
    expect(material.actions).toEqual(['read: a.ts']);
  });
});

describe('createHandoffAcceptanceJudgeの分岐（Issue #1846）', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'handoff-acceptance-judge-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const state: ChatState = { ...initialChatState, items: [item('agentMessage', '読みました')] };

  function build(
    outcome: Parameters<typeof reflexStub>[0],
    overrides: Partial<HandoffAcceptanceJudgeInput> = {},
  ): { judge: (s: ChatState) => Promise<boolean>; prompts: string[]; traces: string[] } {
    const stub = reflexStub(outcome);
    const traces: string[] = [];
    const judge = createHandoffAcceptanceJudge({
      enabled: () => true,
      threshold: () => 0.6,
      deps: stub.deps,
      sentPrompt: '初回プロンプト本文',
      pointerPath: undefined,
      destinationDisposed: () => false,
      trace: { info: (message) => traces.push(message) },
      ...overrides,
    });
    return { judge, prompts: stub.prompts, traces };
  }

  it('確率が閾値以上なら true、未満なら false', async () => {
    expect(await build(reflexAnswers({ p: 0.6 })).judge(state)).toBe(true);
    expect(await build(reflexAnswers({ p: 0.59 })).judge(state)).toBe(false);
  });

  it('親スイッチがOFFなら、Reflexを呼ばずに false', async () => {
    const { judge, prompts, traces } = build(reflexAnswers({ p: 0.99 }), { enabled: () => false });
    expect(await judge(state)).toBe(false);
    expect(prompts).toHaveLength(0);
    expect(traces.some((t) => t.includes('親スイッチがOFF'))).toBe(true);
  });

  it('判定の間に引き継ぎ先のタブが閉じられたら、確率が高くても false', async () => {
    const { judge, prompts, traces } = build(reflexAnswers({ p: 0.99 }), {
      destinationDisposed: () => true,
    });
    expect(await judge(state)).toBe(false);
    expect(prompts).toHaveLength(1);
    expect(traces.some((t) => t.includes('タブが閉じられた'))).toBe(true);
  });

  it('pointerファイルを読めれば、その中身を本文として判定する', async () => {
    const pointerPath = join(dir, 'pointer.md');
    await writeFile(pointerPath, 'POINTERの中身', 'utf8');
    const { judge, prompts } = build(reflexAnswers({ p: 0.9 }), { pointerPath });
    expect(await judge(state)).toBe(true);
    expect(prompts[0]).toContain('POINTERの中身');
    expect(prompts[0]).not.toContain('初回プロンプト本文');
  });

  it('pointerファイルを読めなければ、初回プロンプトを本文として判定を続ける', async () => {
    const { judge, prompts, traces } = build(reflexAnswers({ p: 0.9 }), {
      pointerPath: join(dir, 'missing.md'),
    });
    expect(await judge(state)).toBe(true);
    expect(prompts[0]).toContain('初回プロンプト本文');
    expect(traces.some((t) => t.includes('pointerファイルを読めなかった'))).toBe(true);
  });

  it('Reflexの判定が失敗（時間切れ・例外）したら false', async () => {
    const timedOut = build(REFLEX_TIMEOUT);
    expect(await timedOut.judge(state)).toBe(false);
    expect(timedOut.traces.some((t) => t.includes('判定が失敗した'))).toBe(true);
    expect(await build(new Error('起動失敗')).judge(state)).toBe(false);
  });

  it('閾値の取得が投げても false で終わり、例外を漏らさない', async () => {
    const { judge, traces } = build(reflexAnswers({ p: 0.9 }), {
      threshold: () => {
        throw new Error('設定を読めない');
      },
    });
    expect(await judge(state)).toBe(false);
    expect(traces.some((t) => t.includes('設定を読めない'))).toBe(true);
  });
});
