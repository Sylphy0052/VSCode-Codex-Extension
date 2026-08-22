import { describe, expect, it } from 'vitest';
import { initialChatState, type ChatItem, type ChatState } from '../../src/appserver/chatState';
import {
  declaresDone,
  decoratePrompt,
  LoopController,
  LOOP_DONE_TOKEN,
  LOOP_ITERATION_LIMIT,
  normalizeLoopPlan,
  type LoopPlan,
} from '../../src/loop/loopController';

const state = (overrides: Partial<ChatState> = {}): ChatState => ({
  ...initialChatState,
  ...overrides,
});

const agentMessage = (text: string): ChatItem => ({
  id: 'a1',
  kind: 'agentMessage',
  text,
  detail: '',
  status: undefined,
  turnId: undefined,
  diffs: [],
});

const plan = (overrides: Partial<LoopPlan> = {}): LoopPlan => ({
  initialPrompt: '第1話を執筆',
  continuePrompt: '次へ',
  maxIterations: 3,
  condition: '',
  ...overrides,
});

/** 1ターン分の状態変化を流す。応答中になってから完了へ落ちる。 */
const runTurn = (controller: LoopController, completed: ChatState = state()): void => {
  controller.observe(state({ busy: true }));
  controller.observe(completed);
};

const spy = (): { sent: string[]; send: (text: string) => void } => {
  const sent: string[] = [];
  return { sent, send: (text: string) => sent.push(text) };
};

describe('normalizeLoopPlan', () => {
  it('前後の空白を落として計画にする', () => {
    expect(
      normalizeLoopPlan({
        initialPrompt: ' 執筆 ',
        continuePrompt: ' 次へ ',
        maxIterations: '20',
        condition: ' 20話完了 ',
      }),
    ).toEqual({
      initialPrompt: '執筆',
      continuePrompt: '次へ',
      maxIterations: 20,
      condition: '20話完了',
    });
  });

  it('継続指示が無ければ受け付けない', () => {
    expect(normalizeLoopPlan({ continuePrompt: '  ', maxIterations: 5 })).toBeUndefined();
  });

  it('回数が数値でない、または1未満なら受け付けない', () => {
    expect(
      normalizeLoopPlan({ continuePrompt: '次へ', maxIterations: 'たくさん' }),
    ).toBeUndefined();
    expect(normalizeLoopPlan({ continuePrompt: '次へ', maxIterations: 0 })).toBeUndefined();
  });

  it('回数は上限で頭打ちにする', () => {
    expect(
      normalizeLoopPlan({ continuePrompt: '次へ', maxIterations: 100000 })?.maxIterations,
    ).toBe(LOOP_ITERATION_LIMIT);
  });

  it('オブジェクトでない入力は受け付けない', () => {
    expect(normalizeLoopPlan('次へ')).toBeUndefined();
    expect(normalizeLoopPlan(null)).toBeUndefined();
  });
});

describe('decoratePrompt', () => {
  it('条件が空なら指示をそのまま使う', () => {
    expect(decoratePrompt('次へ', '')).toBe('次へ');
  });

  it('条件があれば終了の合図を頼む文を添える', () => {
    const decorated = decoratePrompt('次へ', '20話完了');
    expect(decorated).toContain('次へ');
    expect(decorated).toContain('20話完了');
    expect(decorated).toContain(LOOP_DONE_TOKEN);
  });
});

describe('declaresDone', () => {
  it('直近のエージェント発言に合図があれば真', () => {
    expect(declaresDone(state({ items: [agentMessage(LOOP_DONE_TOKEN)] }))).toBe(true);
  });

  it('古い発言の合図は見ない', () => {
    const items = [
      { ...agentMessage(LOOP_DONE_TOKEN), id: 'old' },
      { ...agentMessage('まだ続きます'), id: 'new' },
    ];
    expect(declaresDone(state({ items }))).toBe(false);
  });

  it('エージェントの発言が無ければ偽', () => {
    expect(declaresDone(state())).toBe(false);
  });
});

describe('LoopController', () => {
  it('開始すると初回指示を送る', () => {
    const { sent, send } = spy();
    new LoopController(send).start(plan());
    expect(sent).toEqual(['第1話を執筆']);
  });

  it('初回指示が空なら継続指示で始める', () => {
    const { sent, send } = spy();
    new LoopController(send).start(plan({ initialPrompt: '' }));
    expect(sent).toEqual(['次へ']);
  });

  it('ターンが終わるたびに継続指示を送る', () => {
    const { sent, send } = spy();
    const controller = new LoopController(send);
    controller.start(plan());
    runTurn(controller);
    runTurn(controller);
    expect(sent).toEqual(['第1話を執筆', '次へ', '次へ']);
  });

  it('指定回数を送り終えたら止まる', () => {
    const { sent, send } = spy();
    const controller = new LoopController(send);
    controller.start(plan({ maxIterations: 2 }));
    runTurn(controller);
    runTurn(controller);
    expect(sent).toEqual(['第1話を執筆', '次へ']);
    expect(controller.running).toBe(false);
    expect(controller.getStatus().stopReason).toBe('maxReached');
  });

  it('終了条件があれば指示へ添える', () => {
    const { sent, send } = spy();
    new LoopController(send).start(plan({ condition: '20話完了' }));
    expect(sent[0]).toContain('20話完了');
    expect(sent[0]).toContain(LOOP_DONE_TOKEN);
  });

  it('エージェントが合図を出したら止まる', () => {
    const { sent, send } = spy();
    const controller = new LoopController(send);
    controller.start(plan({ condition: '20話完了' }));
    runTurn(controller, state({ items: [agentMessage(`了解しました ${LOOP_DONE_TOKEN}`)] }));
    expect(sent).toHaveLength(1);
    expect(controller.getStatus().stopReason).toBe('done');
  });

  it('条件を指定していなければ合図があっても回数で回る', () => {
    const { sent, send } = spy();
    const controller = new LoopController(send);
    controller.start(plan());
    runTurn(controller, state({ items: [agentMessage(LOOP_DONE_TOKEN)] }));
    expect(sent).toHaveLength(2);
  });

  it('ターンが失敗したら止まる', () => {
    const { sent, send } = spy();
    const controller = new LoopController(send);
    controller.start(plan());
    runTurn(controller, state({ turnFailed: true }));
    expect(sent).toHaveLength(1);
    expect(controller.getStatus().stopReason).toBe('failed');
  });

  it('承認待ちの間は次の指示を送らない', () => {
    const { sent, send } = spy();
    const controller = new LoopController(send);
    controller.start(plan());
    controller.observe(state({ busy: true }));
    controller.observe(
      state({
        approvals: [{ requestId: 1, kind: 'command', title: 'rm', detail: '', itemId: undefined }],
      }),
    );
    expect(sent).toHaveLength(1);
    expect(controller.running).toBe(true);

    // 承認が片付いてターンが終われば続きへ進む
    controller.observe(state());
    expect(sent).toHaveLength(2);
  });

  it('手で積まれた指示が残っている間は送らない', () => {
    const { sent, send } = spy();
    const controller = new LoopController(send);
    controller.start(plan());
    controller.observe(state({ busy: true }));
    controller.observe(state({ queued: [{ text: '先に送りたい指示', attachments: [] }] }));
    expect(sent).toHaveLength(1);
    expect(controller.running).toBe(true);

    // 待ち行列が捌ければ続きへ進む
    controller.observe(state());
    expect(sent).toHaveLength(2);
  });

  it('ターンが始まる前の完了状態では次を送らない', () => {
    const { sent, send } = spy();
    const controller = new LoopController(send);
    controller.start(plan());
    controller.observe(state());
    expect(sent).toHaveLength(1);
  });

  it('手動の操作が入ったら止まる', () => {
    const { sent, send } = spy();
    const controller = new LoopController(send);
    controller.start(plan());
    controller.noteUserAction();
    runTurn(controller);
    expect(sent).toHaveLength(1);
    expect(controller.getStatus().stopReason).toBe('interrupted');
  });

  it('送信が失敗したら止まる', () => {
    const controller = new LoopController(() => {
      throw new Error('セッションが起動していません');
    });
    controller.start(plan());
    expect(controller.running).toBe(false);
    expect(controller.getStatus().stopReason).toBe('failed');
  });

  it('送信のPromiseが失敗しても止まる', async () => {
    const controller = new LoopController(() => Promise.reject(new Error('切断')));
    controller.start(plan());
    await Promise.resolve();
    expect(controller.getStatus().stopReason).toBe('failed');
  });

  it('進行状況を通知する', () => {
    const seen: Array<[boolean, number]> = [];
    const controller = new LoopController(
      () => undefined,
      (status) => seen.push([status.running, status.iteration]),
    );
    controller.start(plan({ maxIterations: 1 }));
    runTurn(controller);
    expect(seen).toEqual([
      [true, 1],
      [false, 1],
    ]);
  });

  it('止まったあとは状態を流しても何も送らない', () => {
    const { sent, send } = spy();
    const controller = new LoopController(send);
    controller.start(plan());
    controller.stop('manual');
    runTurn(controller);
    expect(sent).toHaveLength(1);
    expect(controller.getStatus().stopReason).toBe('manual');
  });

  /**
   * `stop()`の戻り値（issue #514）。`WorkflowRunner.stopTask`はこの`boolean`だけを
   * 「実際に止められたか」の根拠にするため、走っているループを止めたときは`true`、
   * 既に止まっているループへの呼び出しは（存在チェックではなく）`false`を返す必要がある。
   */
  it('stop()は走っているループを止められればtrue、既に止まっていればfalseを返す', () => {
    const controller = new LoopController(() => undefined);
    controller.start(plan());
    expect(controller.stop('taskStopped')).toBe(true);
    // 既に止まっている状態へもう一度呼んでも、何も起きておらずfalse
    expect(controller.stop('taskStopped')).toBe(false);
  });

  describe('pause/resume（design.md §16.21 waitingReplyへの遷移）', () => {
    it('一時停止中はターンが終わっても継続指示を送らない。runningのまま止まる', () => {
      const { sent, send } = spy();
      const controller = new LoopController(send);
      controller.start(plan());
      controller.pause();
      runTurn(controller);
      expect(sent).toEqual(['第1話を執筆']);
      // 「実際は止まっていないのに止まっていると偽る」を避ける: runningはtrueのまま
      // （stop()を呼んでいない。#105が避けた問題への対応）
      expect(controller.running).toBe(true);
      expect(controller.getStatus().stopReason).toBeUndefined();
    });

    it('resume()を呼ぶと直ちに次の継続指示を送る', () => {
      const { sent, send } = spy();
      const controller = new LoopController(send);
      controller.start(plan());
      controller.pause();
      runTurn(controller);
      controller.resume();
      expect(sent).toEqual(['第1話を執筆', '次へ']);
    });

    it('resume後は通常どおり回数上限・終了条件の判定に戻る', () => {
      const { sent, send } = spy();
      const controller = new LoopController(send);
      controller.start(plan({ maxIterations: 2 }));
      controller.pause();
      runTurn(controller);
      controller.resume();
      expect(sent).toHaveLength(2);
      runTurn(controller);
      expect(sent).toHaveLength(2); // 2回目の継続指示（=resumeで送った1回）で上限に到達済み
      expect(controller.getStatus().stopReason).toBe('maxReached');
    });

    it('一時停止中でもターンが失敗していれば止める（安全側）', () => {
      const { sent, send } = spy();
      const controller = new LoopController(send);
      controller.start(plan());
      controller.pause();
      runTurn(controller, state({ turnFailed: true }));
      expect(sent).toHaveLength(1);
      expect(controller.running).toBe(false);
      expect(controller.getStatus().stopReason).toBe('failed');
    });

    it('走っていなければpause()は何もしない', () => {
      const { sent, send } = spy();
      const controller = new LoopController(send);
      controller.pause();
      controller.start(plan());
      expect(sent).toEqual(['第1話を執筆']);
      runTurn(controller);
      expect(sent).toEqual(['第1話を執筆', '次へ']);
    });

    it('一時停止中でなければresume()は何もしない', () => {
      const { sent, send } = spy();
      const controller = new LoopController(send);
      controller.start(plan());
      controller.resume();
      expect(sent).toEqual(['第1話を執筆']);
    });

    it('stop()すると一時停止フラグも解ける', () => {
      const { sent, send } = spy();
      const controller = new LoopController(send);
      controller.start(plan());
      controller.pause();
      controller.stop('manual');
      // 停止後にresume()を呼んでも何も起きない（走っていないため）
      controller.resume();
      expect(sent).toEqual(['第1話を執筆']);
    });
  });
});

describe('LoopController: 停滞検知（design.md §16.27、Issue #336）', () => {
  it('同じ応答がしきい値回連続すると、maxIterationsを使い切る前にstalledで止まる', () => {
    const { sent, send } = spy();
    const controller = new LoopController(send, undefined, 3);
    controller.start(plan({ maxIterations: 20 }));
    runTurn(controller, state({ turnResultText: '同じ内容の応答です' }));
    runTurn(controller, state({ turnResultText: '同じ内容の応答です' }));
    runTurn(controller, state({ turnResultText: '同じ内容の応答です' }));
    // 初回送信 + 継続2回 = 3回。4回目（4件目の継続指示）は送らずに止まる
    expect(sent).toHaveLength(3);
    expect(controller.running).toBe(false);
    expect(controller.getStatus().stopReason).toBe('stalled');
  });

  it('応答が変化し続けていれば停滞と判定せず、指定回数まで回り続ける', () => {
    const { sent, send } = spy();
    const controller = new LoopController(send, undefined, 3);
    controller.start(plan({ maxIterations: 4 }));
    runTurn(controller, state({ turnResultText: '1回目の応答' }));
    runTurn(controller, state({ turnResultText: '2回目の応答' }));
    runTurn(controller, state({ turnResultText: '3回目の応答' }));
    expect(controller.running).toBe(true);
    runTurn(controller, state({ turnResultText: '4回目の応答' }));
    expect(controller.getStatus().stopReason).toBe('maxReached');
    expect(sent).toHaveLength(4);
  });

  it('空応答（まだ応答が無い）の反復は停滞と判定しない（誤検知しない）', () => {
    const { sent, send } = spy();
    const controller = new LoopController(send, undefined, 2);
    controller.start(plan({ maxIterations: 5 }));
    runTurn(controller, state());
    runTurn(controller, state());
    expect(controller.running).toBe(true);
    expect(sent).toHaveLength(3);
  });

  it('しきい値を変えると検知のタイミングが変わる', () => {
    const { sent: sent2, send: send2 } = spy();
    const short = new LoopController(send2, undefined, 2);
    short.start(plan({ maxIterations: 20 }));
    runTurn(short, state({ turnResultText: '同じ内容' }));
    runTurn(short, state({ turnResultText: '同じ内容' }));
    expect(short.getStatus().stopReason).toBe('stalled');
    expect(sent2).toHaveLength(2);

    const { sent: sent5, send: send5 } = spy();
    const long = new LoopController(send5, undefined, 5);
    long.start(plan({ maxIterations: 20 }));
    runTurn(long, state({ turnResultText: '同じ内容' }));
    runTurn(long, state({ turnResultText: '同じ内容' }));
    // しきい値5に対してまだ2回目。長いしきい値のほうはまだ止まらない
    expect(long.running).toBe(true);
    expect(sent5).toHaveLength(3);
  });

  it('start()し直すと停滞履歴もリセットされる（前回の実行の履歴を持ち越さない）', () => {
    const { send } = spy();
    const controller = new LoopController(send, undefined, 2);
    controller.start(plan({ maxIterations: 20 }));
    runTurn(controller, state({ turnResultText: '同じ内容' }));
    runTurn(controller, state({ turnResultText: '同じ内容' }));
    expect(controller.getStatus().stopReason).toBe('stalled');

    // 新しい計画で再開始。前回と同じ文言が1回出ただけでは、まだ停滞と判定されない
    controller.start(plan({ maxIterations: 20 }));
    runTurn(controller, state({ turnResultText: '同じ内容' }));
    expect(controller.running).toBe(true);
  });

  it('本文を出さずツールだけを動かすターンが続いても停滞と誤検知しない（design.md §16.27、Issue #336のblocking指摘）', () => {
    // turnResultTextが空でも、items（過去のターンの発言）には非空の古い発言が残っている状態。
    // ここでitems全体へフォールバックすると、編集内容が毎回違っても同じ署名を拾い続けて
    // 誤検知する。turnResultTextだけを見て「比較不能（空文字）」として扱えば誤検知しない
    const { sent, send } = spy();
    const controller = new LoopController(send, undefined, 2);
    controller.start(plan({ maxIterations: 5 }));
    const oldMessage = agentMessage('最初のターンで出た発言');
    runTurn(controller, state({ turnResultText: '', items: [oldMessage] }));
    runTurn(controller, state({ turnResultText: '', items: [oldMessage] }));
    runTurn(controller, state({ turnResultText: '', items: [oldMessage] }));
    expect(controller.running).toBe(true);
    expect(controller.getStatus().stopReason).toBeUndefined();
    expect(sent).toHaveLength(4);
  });

  it('maxIterations到達と同じターンで停滞条件も満たすときはstalledを優先する（design.md §16.27、Issue #336のshould-fix指摘）', () => {
    const { sent, send } = spy();
    const controller = new LoopController(send, undefined, 3);
    // しきい値3とmaxIterations3を一致させ、最終ターンで両条件が同時に成立する状態を作る
    controller.start(plan({ maxIterations: 3 }));
    runTurn(controller, state({ turnResultText: '同じ内容の応答です' }));
    runTurn(controller, state({ turnResultText: '同じ内容の応答です' }));
    runTurn(controller, state({ turnResultText: '同じ内容の応答です' }));
    expect(sent).toHaveLength(3);
    expect(controller.running).toBe(false);
    expect(controller.getStatus().stopReason).toBe('stalled');
  });
});
