import { describe, expect, it } from 'vitest';
import { initialChatState, type ChatItem, type ChatState } from '../../src/appserver/chatState';
import {
  declaresDone,
  decoratePrompt,
  LoopController,
  LOOP_DONE_TOKEN,
  LOOP_ITERATION_LIMIT,
  LOOP_DURATION_LIMIT_MINUTES,
  normalizeLoopPlan,
  type LoopPlan,
} from '../../src/loop/loopController';
import {
  defaultLoopEngineeringConfig,
  DEFAULT_LOOP_ENGINEERING_CONTINUE_INSTRUCTION,
  DEFAULT_LOOP_ENGINEERING_INITIAL_INSTRUCTION,
  LOOP_ESCALATE_TOKEN,
} from '../../src/loop/loopEngineering';
import type {
  GoalEvaluation,
  GoalEvaluator,
  GoalEvaluatorInput,
  GoalEvidence,
  GoalLoopConfig,
  GoalVerdict,
} from '../../src/loop/goalLoop';
import { indeterminate } from '../../src/loop/goalPrompt';
import {
  ADVISOR_FAILURE_DISABLE_THRESHOLD,
  advisorFailed,
  advisorOk,
  noAdvice,
  type LoopAdvice,
  type LoopAdvisorConfig,
} from '../../src/loop/loopAdvisor';

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

/**
 * 1ターン分の状態変化を流す。応答中になってから完了へ落ちる。
 *
 * 完了側では`turnCompletionSeq`を進める（issue #939）。`busy`が落ちただけでは
 * `LoopController`はターンを消費しない——実機のCodexは`thread/status/changed`（idle）を
 * `turn/completed`より先に送り、その時点では応答テキストがまだ確定していないため。
 */
const finished = (completed: ChatState): ChatState => ({
  ...completed,
  busy: false,
  turnCompletionSeq: completed.turnCompletionSeq + 1,
});

const runTurn = (controller: LoopController, completed: ChatState = state()): void => {
  controller.observe(state({ busy: true }));
  controller.observe(finished(completed));
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
  it('最終行が合図と完全一致していれば真', () => {
    expect(declaresDone(agentMessage(LOOP_DONE_TOKEN))).toBe(true);
  });

  it('本文の途中に現れただけでは偽', () => {
    expect(declaresDone(agentMessage(`まだ ${LOOP_DONE_TOKEN} は出しません`))).toBe(false);
  });

  it('本文が空なら偽', () => {
    expect(declaresDone(agentMessage('  '))).toBe(false);
  });

  it('エージェントの発言以外を渡されても偽（issue #937）', () => {
    expect(
      declaresDone({ ...agentMessage(LOOP_DONE_TOKEN), id: 'c1', kind: 'commandExecution' }),
    ).toBe(false);
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
    runTurn(controller, state({ items: [agentMessage(`了解しました\n${LOOP_DONE_TOKEN}`)] }));
    expect(sent).toHaveLength(1);
    expect(controller.getStatus().stopReason).toBe('done');
  });

  it('合図が本文の途中にあるだけでは止まらない（issue #914）', () => {
    // 合図を教えるのは`decoratePrompt`が添える文そのもので、その綴りが会話に残る。
    // `includes`判定だと「まだ出しません」という説明文で終了してしまっていた
    const { send } = spy();
    const controller = new LoopController(send);
    controller.start(plan({ condition: '20話完了' }));
    runTurn(
      controller,
      state({ items: [agentMessage(`まだ ${LOOP_DONE_TOKEN} は出しません。続けます。`)] }),
    );
    expect(controller.getStatus().stopReason).toBeUndefined();
    expect(controller.running).toBe(true);
  });

  it('最終行に合図以外の文字が混ざっていれば止まらない（issue #914）', () => {
    const { send } = spy();
    const controller = new LoopController(send);
    controller.start(plan({ condition: '20話完了' }));
    runTurn(controller, state({ items: [agentMessage(`${LOOP_DONE_TOKEN} 理由: 完了`)] }));
    expect(controller.getStatus().stopReason).toBeUndefined();
  });

  it('応答の後ろにコマンド実行が並んでいても合図を拾う（issue #914）', () => {
    const { send } = spy();
    const controller = new LoopController(send);
    controller.start(plan({ condition: '20話完了' }));
    runTurn(
      controller,
      state({
        items: [
          agentMessage(`終わりました\n${LOOP_DONE_TOKEN}`),
          { ...agentMessage(''), id: 'c1', kind: 'commandExecution', detail: 'npm test' },
        ],
      }),
    );
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
    controller.observe(finished(state()));
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
    controller.observe(finished(state()));
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

    describe('停止ポリシーは一時停止をまたいでも効く（issue #914）', () => {
      it('一時停止中に完了したターンが終了条件を満たしていればdoneで止まる', () => {
        const { sent, send } = spy();
        const controller = new LoopController(send);
        controller.start(plan({ condition: '20話完了' }));
        controller.pause();
        runTurn(controller, state({ items: [agentMessage(LOOP_DONE_TOKEN)] }));
        expect(controller.getStatus().stopReason).toBe('done');
        controller.resume();
        expect(sent).toHaveLength(1);
      });

      it('一時停止中に時間上限を超えていたらtimedOutで止まる', () => {
        const { sent, send } = spy();
        let now = 0;
        const controller = new LoopController(send, undefined, undefined, () => now);
        controller.start(plan({ maxDurationMs: 1000 }));
        controller.pause();
        now = 1000;
        runTurn(controller);
        expect(controller.getStatus().stopReason).toBe('timedOut');
        controller.resume();
        expect(sent).toHaveLength(1);
      });

      it('返信を待っている間に時間上限を跨いだら、再開しても次を送らずtimedOutで止まる', () => {
        // ターンが完了した時点では超えていない。人が答えるまでの待ち時間で超える
        const { sent, send } = spy();
        let now = 0;
        const controller = new LoopController(send, undefined, undefined, () => now);
        controller.start(plan({ maxDurationMs: 1000 }));
        controller.pause();
        now = 500;
        runTurn(controller);
        expect(controller.running).toBe(true);
        now = 5000;
        controller.resume();
        expect(sent).toHaveLength(1);
        expect(controller.getStatus().stopReason).toBe('timedOut');
      });
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

describe('LoopController（撤退の申告・時間上限・ループエンジニアリング、issue #891）', () => {
  it('応答の最終行が合図と完全一致したらescalatedで止まる', () => {
    const { sent, send } = spy();
    const controller = new LoopController(send);
    controller.start(plan({ maxIterations: 5 }));
    runTurn(
      controller,
      state({ items: [agentMessage(`権限が無く進められない。\n${LOOP_ESCALATE_TOKEN}`)] }),
    );
    expect(controller.running).toBe(false);
    expect(controller.getStatus().stopReason).toBe('escalated');
    expect(sent).toHaveLength(1);
  });

  it('合図が本文中に説明として現れただけでは止まらない', () => {
    // 指示文そのものが会話にこの綴りを含むため、includes判定だと1回目で誤停止する
    const { sent, send } = spy();
    const controller = new LoopController(send);
    controller.start(plan({ maxIterations: 5 }));
    runTurn(
      controller,
      state({
        items: [agentMessage(`行き詰まったら ${LOOP_ESCALATE_TOKEN} を返します。続けます。`)],
      }),
    );
    expect(controller.running).toBe(true);
    expect(controller.getStatus().stopReason).toBeUndefined();
    expect(sent).toHaveLength(2);
  });

  it('終了条件を設定していなくても撤退の申告は効く', () => {
    const { send } = spy();
    const controller = new LoopController(send);
    controller.start(plan({ condition: '', maxIterations: 5 }));
    runTurn(controller, state({ items: [agentMessage(LOOP_ESCALATE_TOKEN)] }));
    expect(controller.getStatus().stopReason).toBe('escalated');
  });

  it('時間上限を超えたターンの完了時にtimedOutで止まる', () => {
    const { sent, send } = spy();
    let clock = 1_000;
    const controller = new LoopController(send, undefined, undefined, () => clock);
    controller.start(plan({ maxIterations: 50, maxDurationMs: 60_000 }));
    clock += 30_000;
    runTurn(controller, state({ turnResultText: '1回目' }));
    expect(controller.running).toBe(true);
    clock += 30_000;
    runTurn(controller, state({ turnResultText: '2回目' }));
    expect(controller.running).toBe(false);
    expect(controller.getStatus().stopReason).toBe('timedOut');
    // 上限を超えたことに気づくのはターンの完了時なので、送信は2回で止まる
    expect(sent).toHaveLength(2);
  });

  it('時間上限を指定しなければ時間では止まらない', () => {
    const { send } = spy();
    let clock = 0;
    const controller = new LoopController(send, undefined, undefined, () => clock);
    controller.start(plan({ maxIterations: 3 }));
    clock += 10 * 24 * 60 * 60 * 1000;
    runTurn(controller, state({ turnResultText: '1回目' }));
    expect(controller.running).toBe(true);
    expect(controller.getStatus().stopReason).toBeUndefined();
  });

  it('1回目には方針文を、2回目以降には継続用の文を連結する', () => {
    const { sent, send } = spy();
    const controller = new LoopController(send);
    controller.start(
      plan({
        maxIterations: 3,
        engineering: { ...defaultLoopEngineeringConfig, enabled: true },
      }),
    );
    runTurn(controller, state({ turnResultText: '1回目' }));
    expect(sent[0]).toContain(DEFAULT_LOOP_ENGINEERING_INITIAL_INSTRUCTION);
    expect(sent[1]).toContain(DEFAULT_LOOP_ENGINEERING_CONTINUE_INSTRUCTION);
    expect(sent[1]).not.toContain(DEFAULT_LOOP_ENGINEERING_INITIAL_INSTRUCTION);
  });

  it('初回指示が空で継続指示から始めても、1回目には方針文を連結する', () => {
    const { sent, send } = spy();
    const controller = new LoopController(send);
    controller.start(
      plan({
        initialPrompt: '',
        engineering: { ...defaultLoopEngineeringConfig, enabled: true },
      }),
    );
    expect(sent[0]).toContain(DEFAULT_LOOP_ENGINEERING_INITIAL_INSTRUCTION);
  });

  it('モードが無効なら送信テキストは一字一句変わらない', () => {
    const { sent, send } = spy();
    const controller = new LoopController(send);
    controller.start(plan({ condition: '', engineering: defaultLoopEngineeringConfig }));
    expect(sent[0]).toBe('第1話を執筆');
  });

  it('方針は終了条件より前に置く', () => {
    const { sent, send } = spy();
    const controller = new LoopController(send);
    controller.start(
      plan({
        condition: '20話完了',
        engineering: { ...defaultLoopEngineeringConfig, enabled: true },
      }),
    );
    const first = sent[0] ?? '';
    expect(first.indexOf(DEFAULT_LOOP_ENGINEERING_INITIAL_INSTRUCTION)).toBeLessThan(
      first.indexOf('20話完了'),
    );
  });
});

describe('LoopController: 停止理由の優先順位（issue #914）', () => {
  it('撤退の申告と終了条件が同時に成立していればescalatedを採る', () => {
    // 「解決できないので止めてくれ」を「終わった」と読み替えない
    const { send } = spy();
    const controller = new LoopController(send);
    controller.start(plan({ condition: '20話完了' }));
    runTurn(
      controller,
      state({ items: [agentMessage(`${LOOP_DONE_TOKEN}\n${LOOP_ESCALATE_TOKEN}`)] }),
    );
    expect(controller.getStatus().stopReason).toBe('escalated');
  });

  it('停滞と時間切れが同時に成立していればstalledを採る', () => {
    // 「進んでいない」は原因を名指しできる分だけ理由として具体的
    const { send } = spy();
    let now = 0;
    const controller = new LoopController(send, undefined, 2, () => now);
    controller.start(plan({ maxIterations: 20, maxDurationMs: 1000 }));
    runTurn(controller, state({ turnResultText: '同じ内容' }));
    now = 5000;
    runTurn(controller, state({ turnResultText: '同じ内容' }));
    expect(controller.getStatus().stopReason).toBe('stalled');
  });

  it('時間切れと回数切れが同時に成立していればtimedOutを採る', () => {
    const { send } = spy();
    let now = 0;
    const controller = new LoopController(send, undefined, undefined, () => now);
    controller.start(plan({ maxIterations: 1, maxDurationMs: 1000 }));
    now = 5000;
    runTurn(controller);
    expect(controller.getStatus().stopReason).toBe('timedOut');
  });

  it('ターンの失敗は撤退の申告より先に見る', () => {
    const { send } = spy();
    const controller = new LoopController(send);
    controller.start(plan());
    runTurn(controller, state({ turnFailed: true, items: [agentMessage(LOOP_ESCALATE_TOKEN)] }));
    expect(controller.getStatus().stopReason).toBe('failed');
  });
});

describe('LoopController: 時間上限の境界（issue #914）', () => {
  const runWithElapsed = (elapsed: number): LoopController => {
    const { send } = spy();
    let now = 0;
    const controller = new LoopController(send, undefined, undefined, () => now);
    controller.start(plan({ maxIterations: 20, maxDurationMs: 1000 }));
    now = elapsed;
    runTurn(controller);
    return controller;
  };

  it('上限に1ミリ秒足りなければ続ける', () => {
    expect(runWithElapsed(999).running).toBe(true);
  });

  it('上限ちょうどで止める', () => {
    expect(runWithElapsed(1000).getStatus().stopReason).toBe('timedOut');
  });

  it('上限を超えていれば止める', () => {
    expect(runWithElapsed(1001).getStatus().stopReason).toBe('timedOut');
  });

  it('上限を大きく超えても、ターンが走っている間は止めない（hard timeoutではない）', () => {
    // 走行中のターンへ割り込まない割り切り。仕様として固定しておく
    const { send } = spy();
    let now = 0;
    const controller = new LoopController(send, undefined, undefined, () => now);
    controller.start(plan({ maxIterations: 20, maxDurationMs: 1000 }));
    controller.observe(state({ busy: true }));
    now = 60 * 60 * 1000;
    controller.observe(state({ busy: true }));
    expect(controller.running).toBe(true);
    expect(controller.getStatus().stopReason).toBeUndefined();
    // busyが下りたターン境界で初めて止まる
    controller.observe(finished(state()));
    expect(controller.getStatus().stopReason).toBe('timedOut');
  });
});

describe('normalizeLoopPlan（時間上限とループエンジニアリング、issue #891）', () => {
  it('分をミリ秒へ直す', () => {
    expect(
      normalizeLoopPlan({ continuePrompt: '次へ', maxIterations: 5, maxDurationMinutes: '30' })
        ?.maxDurationMs,
    ).toBe(30 * 60_000);
  });

  it('空・0以下・数値でない指定は「時間では止めない」として扱う', () => {
    for (const raw of ['', '0', '-5', 'ずっと', undefined]) {
      const plan = normalizeLoopPlan({
        continuePrompt: '次へ',
        maxIterations: 5,
        maxDurationMinutes: raw,
      });
      expect(plan).toBeDefined();
      expect(plan && 'maxDurationMs' in plan).toBe(false);
    }
  });

  it('時間上限は24時間で頭打ちにする', () => {
    expect(
      normalizeLoopPlan({ continuePrompt: '次へ', maxIterations: 5, maxDurationMinutes: 99999 })
        ?.maxDurationMs,
    ).toBe(LOOP_DURATION_LIMIT_MINUTES * 60_000);
  });

  it('方針は引数から受け取り、webviewから届いた値では差し替えられない', () => {
    const engineering = { ...defaultLoopEngineeringConfig, enabled: true };
    const built = normalizeLoopPlan(
      {
        continuePrompt: '次へ',
        maxIterations: 5,
        engineering: {
          enabled: true,
          initialInstruction: '乗っ取られた指示',
          continueInstruction: '',
        },
      },
      engineering,
    );
    expect(built?.engineering).toEqual(engineering);
  });

  it('方針を渡さなければキーごと持たない', () => {
    const built = normalizeLoopPlan({ continuePrompt: '次へ', maxIterations: 5 });
    expect(built && 'engineering' in built).toBe(false);
  });
});

/** ゴール駆動ループ（issue #892）で使う入力。 */
const goalInput = { purpose: '認証を直す', acceptanceCriteria: 'npm test が exit 0 で終わる' };

const evaluation = (overrides: Partial<GoalEvaluation> = {}): GoalEvaluation => ({
  verdict: 'continue',
  reason: '',
  evidence: [],
  gaps: [],
  nextFocus: '',
  ...overrides,
});

const commandItem = (id: string, detail: string, status: string): ChatItem => ({
  id,
  kind: 'commandExecution',
  text: '',
  detail,
  status,
  turnId: undefined,
  diffs: [],
});

describe('normalizeLoopPlan（ゴール駆動、issue #892）', () => {
  const evaluate = async (): Promise<GoalEvaluation> => indeterminate('テスト');

  it('目的と受入基準が揃い、Evaluatorが渡されたときだけゴール駆動にする', () => {
    const built = normalizeLoopPlan(
      { continuePrompt: '次へ', maxIterations: 5, goal: goalInput },
      undefined,
      { evaluate },
    );
    expect(built?.goal?.definition).toEqual(goalInput);
  });

  it('Evaluatorが渡されなければゴールの入力があっても従来のループにする', () => {
    const built = normalizeLoopPlan({ continuePrompt: '次へ', maxIterations: 5, goal: goalInput });
    expect(built && 'goal' in built).toBe(false);
  });

  it('目的だけ・受入基準だけではゴール駆動にしない', () => {
    const built = normalizeLoopPlan(
      { continuePrompt: '次へ', maxIterations: 5, goal: { purpose: '認証を直す' } },
      undefined,
      { evaluate },
    );
    expect(built && 'goal' in built).toBe(false);
  });

  it('ゴール駆動なら継続指示が空でも計画を作る', () => {
    const built = normalizeLoopPlan(
      { initialPrompt: '始めて', continuePrompt: '', maxIterations: 5, goal: goalInput },
      undefined,
      { evaluate },
    );
    expect(built?.goal).toBeDefined();
    expect(built?.continuePrompt).toBe('');
  });

  it('ゴールが無ければ継続指示は今までどおり必須', () => {
    expect(
      normalizeLoopPlan({ continuePrompt: '', maxIterations: 5 }, undefined, { evaluate }),
    ).toBeUndefined();
  });

  it('ゴール駆動では終了条件を計画へ残さない（判定はEvaluatorが持つ）', () => {
    const built = normalizeLoopPlan(
      { continuePrompt: '次へ', maxIterations: 5, condition: '20話完了', goal: goalInput },
      undefined,
      { evaluate },
    );
    expect(built?.condition).toBe('');
  });

  it('indeterminateの上限は指定があるときだけ持つ', () => {
    const withLimit = normalizeLoopPlan(
      { continuePrompt: '次へ', maxIterations: 5, goal: goalInput },
      undefined,
      { evaluate, maxIndeterminate: 2 },
    );
    expect(withLimit?.goal?.maxIndeterminate).toBe(2);
    const withoutLimit = normalizeLoopPlan(
      { continuePrompt: '次へ', maxIterations: 5, goal: goalInput },
      undefined,
      { evaluate },
    );
    expect(withoutLimit?.goal && 'maxIndeterminate' in withoutLimit.goal).toBe(false);
  });
});

describe('LoopController（ゴール駆動、issue #892）', () => {
  /** ターンを1回終わらせ、非同期の評価が進むところまで待つ。 */
  const finishTurn = async (loop: LoopController, items: ChatItem[] = []): Promise<void> => {
    loop.observe(state({ busy: true }));
    loop.observe(finished(state({ items })));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  /** `finishTurn`と同じだが、完了時の状態を丸ごと差し替えられる（停滞判定のテスト用）。 */
  const finishTurn2 = async (loop: LoopController, completed: ChatState): Promise<void> => {
    loop.observe(state({ busy: true }));
    loop.observe(finished(completed));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  const goalPlan = (
    evaluate: GoalEvaluator,
    overrides: Partial<LoopPlan> = {},
    goalOverrides: Partial<GoalLoopConfig> = {},
  ): LoopPlan => ({
    initialPrompt: '始めて',
    continuePrompt: '',
    maxIterations: 5,
    condition: '終了条件',
    goal: { definition: goalInput, evaluate, ...goalOverrides },
    ...overrides,
  });

  it('achieved でループを止める', async () => {
    const sent: string[] = [];
    const loop = new LoopController((t) => void sent.push(t));
    loop.start(goalPlan(async () => evaluation({ verdict: 'achieved' })));
    await finishTurn(loop);
    expect(loop.running).toBe(false);
    expect(loop.getStatus().stopReason).toBe('done');
    expect(sent).toHaveLength(1);
  });

  it('escalate で escalated として止める', async () => {
    const loop = new LoopController(() => undefined);
    loop.start(goalPlan(async () => evaluation({ verdict: 'escalate' })));
    await finishTurn(loop);
    expect(loop.getStatus().stopReason).toBe('escalated');
  });

  it('continue なら Evaluator の nextFocus を添えて次のターンを送る', async () => {
    const sent: string[] = [];
    const loop = new LoopController((t) => void sent.push(t));
    loop.start(
      goalPlan(async () =>
        evaluation({
          reason: 'テストが落ちている',
          gaps: ['test_auth を直す'],
          nextFocus: 'リフレッシュトークンを調べる',
        }),
      ),
    );
    await finishTurn(loop);
    expect(loop.running).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('テストが落ちている');
    expect(sent[1]).toContain('- test_auth を直す');
    expect(sent[1]).toContain('リフレッシュトークンを調べる');
  });

  it('Workerへ終了条件（<<LOOP_DONE>>の依頼）を付けない', async () => {
    const sent: string[] = [];
    const loop = new LoopController((t) => void sent.push(t));
    loop.start(goalPlan(async () => evaluation()));
    await finishTurn(loop);
    expect(sent.join('\n')).not.toContain(LOOP_DONE_TOKEN);
  });

  it('Workerの自己申告（<<LOOP_DONE>>）では止まらない', async () => {
    const loop = new LoopController(() => undefined);
    loop.start(goalPlan(async () => evaluation()));
    await finishTurn(loop, [agentMessage(`できました ${LOOP_DONE_TOKEN}`)]);
    expect(loop.running).toBe(true);
  });

  it('Workerの撤退の申告は尊重する', async () => {
    const loop = new LoopController(() => undefined);
    loop.start(goalPlan(async () => evaluation()));
    await finishTurn(loop, [agentMessage(`無理でした\n${LOOP_ESCALATE_TOKEN}`)]);
    expect(loop.getStatus().stopReason).toBe('escalated');
  });

  it('毎ターン新しく評価する（前回の判定を引き継がない）', async () => {
    const inputs: GoalEvaluatorInput[] = [];
    const loop = new LoopController(() => undefined);
    loop.start(
      goalPlan(async (i) => {
        inputs.push(i);
        return evaluation();
      }),
    );
    await finishTurn(loop);
    await finishTurn(loop);
    expect(inputs).toHaveLength(2);
    expect(inputs[0]?.iteration).toBe(1);
    expect(inputs[1]?.iteration).toBe(2);
  });

  it('コマンドの実行結果を証拠としてEvaluatorへ渡す', async () => {
    const inputs: GoalEvaluatorInput[] = [];
    const loop = new LoopController(() => undefined);
    loop.start(
      goalPlan(async (i) => {
        inputs.push(i);
        return evaluation();
      }),
    );
    await finishTurn2(
      loop,
      state({
        busy: false,
        items: [commandItem('c1', 'npm test', 'exit 0'), agentMessage('直しました')],
        // 申告はそのターンの`turnResultText`から取る（issue #933）
        turnResultText: '直しました',
      }),
    );
    const evidence = inputs[0]?.evidence ?? [];
    expect(evidence.some((e) => e.kind === 'test' && e.status === 'pass')).toBe(true);
    expect(evidence.some((e) => e.kind === 'worker-report' && e.status === 'unknown')).toBe(true);
  });

  it('同じコマンドを毎ターン積み直さない', async () => {
    const inputs: GoalEvaluatorInput[] = [];
    const loop = new LoopController(() => undefined);
    loop.start(
      goalPlan(async (i) => {
        inputs.push(i);
        return evaluation();
      }),
    );
    const items = [commandItem('c1', 'npm test', 'exit 0')];
    await finishTurn(loop, items);
    await finishTurn(loop, items);
    expect((inputs[1]?.evidence ?? []).filter((e) => e.kind === 'test')).toHaveLength(1);
  });

  describe('合図は現在のターンで出た発言にだけ効く（issue #937）', () => {
    /** idと本文を指定した`agentMessage`。ターンを跨ぐ同一性の検証に使う。 */
    const message = (id: string, text: string): ChatItem => ({ ...agentMessage(text), id });

    it('開始前に残っていた合図では止まらない', () => {
      // 前のループの最後の応答が会話に残っている状態でループを始め、1ターン目が
      // コマンド実行だけで終わる（新しい`agentMessage`が出ない）
      const before = [message('old', `終わりました\n${LOOP_DONE_TOKEN}`)];
      const controller = new LoopController(() => undefined);
      controller.start(plan({ condition: '20話完了' }), before);
      runTurn(controller, state({ items: before }));
      expect(controller.running).toBe(true);
    });

    it('開始前に残っていた撤退の申告でも止まらない', () => {
      const before = [message('old', `手が尽きた\n${LOOP_ESCALATE_TOKEN}`)];
      const controller = new LoopController(() => undefined);
      controller.start(plan(), before);
      runTurn(controller, state({ items: before }));
      expect(controller.running).toBe(true);
    });

    it('前のターンの発言を、ツールだけの次のターンで新しい発言として扱わない', () => {
      // 合図を含まない応答を1ターン目に出し、2ターン目はコマンド実行だけで終わる。
      // このとき1ターン目の発言が判定に掛かってはいけない
      const first = [message('a1', '直しました')];
      const controller = new LoopController(() => undefined);
      controller.start(plan({ condition: '20話完了', maxIterations: 5 }));
      runTurn(controller, state({ items: first }));
      expect(controller.running).toBe(true);
      // 2ターン目。`items`は変わらない（新しい発言が無い）
      runTurn(controller, state({ items: first }));
      expect(controller.running).toBe(true);
    });

    it('そのターンで新しく出た合図では、これまでどおり止まる', () => {
      const controller = new LoopController(() => undefined);
      controller.start(plan({ condition: '20話完了', maxIterations: 5 }));
      runTurn(controller, state({ items: [message('a1', '直しました')] }));
      expect(controller.running).toBe(true);
      runTurn(
        controller,
        state({ items: [message('a1', '直しました'), message('a2', LOOP_DONE_TOKEN)] }),
      );
      expect(controller.getStatus().stopReason).toBe('done');
    });

    it('idが使い回されても、新しい発言なら合図として扱う', () => {
      // Claude側は`message.id`が取れないと`assistant:text:0`へフォールバックするため、
      // 別のターンの発言が同じidになる（`streamJson.ts`の`blockId` / `partialId`）。
      // idで比べると、ここで合図を取りこぼして止まれなくなる
      const controller = new LoopController(() => undefined);
      controller.start(plan({ condition: '20話完了', maxIterations: 5 }));
      runTurn(controller, state({ items: [message('assistant:text:0', '直しました')] }));
      expect(controller.running).toBe(true);
      runTurn(controller, state({ items: [message('assistant:text:0', LOOP_DONE_TOKEN)] }));
      expect(controller.getStatus().stopReason).toBe('done');
    });

    it('turnResultTextが空でも、新しい発言に合図があれば止まる', () => {
      // `appendDelta`が作った項目は`turnId`が付かないことがあり、`summarizeTurn`が
      // それを落として`turnResultText`が空になる（`planner.ts`のフォールバック参照）。
      // 合図の判定をこの値に頼っていないことを固定する
      const controller = new LoopController(() => undefined);
      controller.start(plan({ condition: '20話完了', maxIterations: 5 }));
      runTurn(controller, state({ items: [message('a1', LOOP_DONE_TOKEN)], turnResultText: '' }));
      expect(controller.getStatus().stopReason).toBe('done');
    });

    it('始め直した後に、同じidで同じ合図を新しく返しても止まる', () => {
      // Claudeのfallback idでは、別の実行の発言が同じ`assistant:text:0`になる。
      // idと最終行だけを比べると、開始前のbaselineと区別が付かず**新しく返した合図を
      // 無視して止まれなくなる**。境界は項目そのもので比べる
      const previous = [message('assistant:text:0', LOOP_DONE_TOKEN)];
      const controller = new LoopController(() => undefined);
      controller.start(plan({ condition: '20話完了', maxIterations: 5 }), previous);
      // 別のオブジェクトだが、idも本文も開始前の発言と完全に同じ
      runTurn(controller, state({ items: [message('assistant:text:0', LOOP_DONE_TOKEN)] }));
      expect(controller.getStatus().stopReason).toBe('done');
    });

    it('止め直したループでは、前の実行の発言を持ち越さない', () => {
      const items = [message('a1', `終わりました\n${LOOP_DONE_TOKEN}`)];
      const controller = new LoopController(() => undefined);
      controller.start(plan({ condition: '20話完了' }));
      runTurn(controller, state({ items }));
      expect(controller.getStatus().stopReason).toBe('done');
      // 同じ発言が会話に残ったまま始め直す。開始時点の項目を渡すので拾い直さない
      controller.start(plan({ condition: '20話完了' }), items);
      runTurn(controller, state({ items }));
      expect(controller.running).toBe(true);
    });
  });

  describe('現在の実行以外の状態を持ち込まない（issue #933）', () => {
    it('ループを始める前に完了していたコマンドは、最初の評価の証拠に入らない', async () => {
      // `ChatState.items`は会話全体を持ち続ける。baselineを持たないと「開始前に
      // `npm test`が通っていた」だけで受入基準を満たしたと判定されうる
      const inputs: GoalEvaluatorInput[] = [];
      const before = [commandItem('old', 'npm test', 'exit 0')];
      const loop = new LoopController(() => undefined);
      loop.start(
        goalPlan(async (i) => {
          inputs.push(i);
          return evaluation();
        }),
        before,
      );
      await finishTurn(loop, before);
      expect(inputs[0]?.evidence ?? []).toHaveLength(0);
    });

    it('ループを始めた後に完了したコマンドは、これまでどおり証拠に入る', async () => {
      const inputs: GoalEvaluatorInput[] = [];
      const before = [commandItem('old', 'npm test', 'exit 0')];
      const loop = new LoopController(() => undefined);
      loop.start(
        goalPlan(async (i) => {
          inputs.push(i);
          return evaluation();
        }),
        before,
      );
      await finishTurn(loop, [...before, commandItem('new', 'npm run build', 'exit 0')]);
      const evidence = inputs[0]?.evidence ?? [];
      expect(evidence).toHaveLength(1);
      expect(evidence[0]?.source).toContain('npm run build');
    });

    it('開始時点でまだ実行中だったコマンドは、終わった時点で証拠になる', async () => {
      // baselineへ入れてよいのは終了コードの読める項目だけ（issue #909と同じ判定）
      const inputs: GoalEvaluatorInput[] = [];
      const before = [commandItem('c1', 'npm test', 'running')];
      const loop = new LoopController(() => undefined);
      loop.start(
        goalPlan(async (i) => {
          inputs.push(i);
          return evaluation();
        }),
        before,
      );
      await finishTurn(loop, [commandItem('c1', 'npm test', 'exit 0')]);
      expect((inputs[0]?.evidence ?? []).filter((e) => e.kind === 'test')).toHaveLength(1);
    });

    it('そのターンが何も言わなければ、過去の発言を申告として積み直さない', async () => {
      const inputs: GoalEvaluatorInput[] = [];
      const loop = new LoopController(() => undefined);
      loop.start(
        goalPlan(async (i) => {
          inputs.push(i);
          return evaluation();
        }),
      );
      // コマンド実行だけで本文を返さなかったターン。`items`には過去の発言が残っている
      await finishTurn2(
        loop,
        state({
          busy: false,
          items: [agentMessage('前のターンで直しました')],
          turnResultText: '',
        }),
      );
      expect((inputs[0]?.evidence ?? []).filter((e) => e.kind === 'worker-report')).toHaveLength(0);
    });

    it('古い実行のEvaluatorが返っても、新しい実行の評価待ちを折らない', async () => {
      let releaseA: ((value: GoalEvaluation) => void) | undefined;
      const gateA = new Promise<GoalEvaluation>((resolve) => {
        releaseA = resolve;
      });
      const loop = new LoopController(() => undefined);
      loop.start(goalPlan(async () => gateA));
      loop.observe(state({ busy: true }));
      loop.observe(finished(state()));
      loop.stop('manual');

      // 別の実行を始め、こちらも評価待ちにする
      let evaluatedB = 0;
      loop.start(
        goalPlan(async () => {
          evaluatedB += 1;
          return new Promise<GoalEvaluation>(() => undefined);
        }),
      );
      loop.observe(state({ busy: true }));
      loop.observe(finished(state()));
      expect(evaluatedB).toBe(1);

      // 古い評価がいま返る。Bの`evaluating`を折ってはいけない
      releaseA?.(evaluation({ verdict: 'achieved' }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(loop.running).toBe(true);
      expect(loop.getStatus().stopReason).toBeUndefined();
      // 折れていれば、次のターン完了で2回目の評価が走ってしまう
      loop.observe(state({ busy: true }));
      loop.observe(finished(state()));
      expect(evaluatedB).toBe(1);
    });

    it('同じ計画のオブジェクトで始め直しても、古い評価が新しい実行を止めない', async () => {
      // `this.plan !== plan`の参照比較だけでは、同じオブジェクトを使い回されると
      // 別の実行を自分の実行と取り違える
      let releaseA: ((value: GoalEvaluation) => void) | undefined;
      const gateA = new Promise<GoalEvaluation>((resolve) => {
        releaseA = resolve;
      });
      let first = true;
      const plan = goalPlan(async () => {
        if (first) {
          first = false;
          return gateA;
        }
        return new Promise<GoalEvaluation>(() => undefined);
      });
      const loop = new LoopController(() => undefined);
      loop.start(plan);
      loop.observe(state({ busy: true }));
      loop.observe(finished(state()));
      loop.stop('manual');
      loop.start(plan);

      releaseA?.(evaluation({ verdict: 'achieved' }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(loop.running).toBe(true);
      expect(loop.getStatus().stopReason).toBeUndefined();
    });

    it('古い実行の送信が失敗しても、新しい実行をfailedで止めない', async () => {
      let rejectA: ((reason: Error) => void) | undefined;
      const sendA = new Promise<void>((_, reject) => {
        rejectA = reject;
      });
      let first = true;
      const loop = new LoopController(() => {
        if (first) {
          first = false;
          return sendA;
        }
        return undefined;
      });
      loop.start(goalPlan(async () => evaluation()));
      loop.stop('manual');
      loop.start(goalPlan(async () => evaluation()));

      rejectA?.(new Error('古い送信の失敗'));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(loop.running).toBe(true);
      expect(loop.getStatus().stopReason).toBeUndefined();
    });
  });

  it('indeterminate が続いたら人へ渡す', async () => {
    const loop = new LoopController(() => undefined);
    loop.start(goalPlan(async () => indeterminate('証拠が足りない'), {}, { maxIndeterminate: 2 }));
    await finishTurn(loop);
    expect(loop.running).toBe(true);
    await finishTurn(loop);
    expect(loop.getStatus().stopReason).toBe('escalated');
  });

  it('indeterminate の連続は continue で途切れる', async () => {
    const verdicts: GoalVerdict[] = ['indeterminate', 'continue', 'indeterminate', 'continue'];
    let index = 0;
    const loop = new LoopController(() => undefined);
    loop.start(
      goalPlan(
        async () => evaluation({ verdict: verdicts[index++] ?? 'continue' }),
        {},
        { maxIndeterminate: 2 },
      ),
    );
    for (let i = 0; i < verdicts.length; i += 1) {
      await finishTurn(loop);
    }
    expect(loop.running).toBe(true);
  });

  it('Evaluatorが例外を投げてもループを壊さず、判定不能として扱う', async () => {
    const loop = new LoopController(() => undefined);
    loop.start(
      goalPlan(() => Promise.reject(new Error('CLIが落ちた')), {}, { maxIndeterminate: 1 }),
    );
    await finishTurn(loop);
    expect(loop.getStatus().stopReason).toBe('escalated');
  });

  it('最終ターンで達成していれば maxReached ではなく done で止める', async () => {
    const loop = new LoopController(() => undefined);
    loop.start(goalPlan(async () => evaluation({ verdict: 'achieved' }), { maxIterations: 1 }));
    await finishTurn(loop);
    expect(loop.getStatus().stopReason).toBe('done');
  });

  it('未達のまま回数を使い切れば maxReached で止める', async () => {
    const loop = new LoopController(() => undefined);
    loop.start(goalPlan(async () => evaluation(), { maxIterations: 1 }));
    await finishTurn(loop);
    expect(loop.getStatus().stopReason).toBe('maxReached');
  });

  it('初回指示が空でも空文字を送らず、元の目的を添えて始める', () => {
    const sent: string[] = [];
    const loop = new LoopController((t) => void sent.push(t));
    loop.start(goalPlan(async () => evaluation(), { initialPrompt: '' }));
    expect(sent[0]).toContain(goalInput.purpose);
  });

  it('一時停止中に終わったターンの評価結果を、再開時に空文字ではなく指示として送る', async () => {
    const sent: string[] = [];
    const loop = new LoopController((t) => void sent.push(t));
    loop.start(goalPlan(async () => evaluation({ nextFocus: 'トークンの期限を見る' })));
    loop.pause();
    await finishTurn(loop);
    // 一時停止中は送らない（issue #909。停止判定そのものは済ませている）
    expect(sent).toHaveLength(1);
    loop.resume();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain(goalInput.purpose);
    expect(sent[1]).toContain('トークンの期限を見る');
  });

  it('評価を待っている間に止められたら次のターンを送らない', async () => {
    const sent: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loop = new LoopController((t) => void sent.push(t));
    loop.start(
      goalPlan(async () => {
        await gate;
        return evaluation();
      }),
    );
    loop.observe(state({ busy: true }));
    loop.observe(finished(state()));
    loop.stop('manual');
    release?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    expect(loop.getStatus().stopReason).toBe('manual');
  });

  it('評価を待っている間に一時停止して再開しても、判定が返ったときに1回だけ送る（issue #914）', async () => {
    // `pendingPrompt` / `paused` / `evaluating` と非同期のEvaluatorが最も競合する境界。
    // resume時点ではまだ判定が無いので送らず、判定が返った時点で`paused`が解けている
    // ためそのまま送る
    const sent: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loop = new LoopController((t) => void sent.push(t));
    loop.start(
      goalPlan(async () => {
        await gate;
        return evaluation({ nextFocus: 'ログを確認する' });
      }),
    );
    loop.observe(state({ busy: true }));
    loop.observe(finished(state()));
    loop.pause();
    loop.resume();
    expect(sent).toHaveLength(1);
    release?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('ログを確認する');
  });

  describe('issue #909: 証拠の取りこぼし・pauseによるBound迂回・判定順', () => {
    /** 評価のたびに、そのとき渡された証拠を記録する。 */
    const recordingEvaluator = (
      log: GoalEvidence[][],
      verdicts: GoalVerdict[] = [],
    ): GoalEvaluator => {
      let call = 0;
      return async (input: GoalEvaluatorInput) => {
        log.push([...input.evidence]);
        const verdict = verdicts[call] ?? 'continue';
        call += 1;
        return evaluation({ verdict });
      };
    };

    it('ターン完了時に実行中だったコマンドを、終了コードが出た次のターンで証拠にする', async () => {
      const log: GoalEvidence[][] = [];
      const loop = new LoopController(() => undefined);
      loop.start(goalPlan(recordingEvaluator(log)));
      // 1ターン目の完了時点ではまだ走っている（終了コードが読めない）
      await finishTurn(loop, [commandItem('c1', 'npm test', 'running')]);
      // 2ターン目の完了時点で exit 0 になった
      await finishTurn(loop, [commandItem('c1', 'npm test', 'exit 0')]);
      // ledgerは累積するため、最後の評価へ渡ったものを見る（積み直せば2件になる）
      const commands = (log[log.length - 1] ?? []).filter((e) => e.kind !== 'worker-report');
      expect(commands).toHaveLength(1);
      expect(commands[0]?.status).toBe('pass');
    });

    it('終了コードが0以外で確定したコマンドも、fail の証拠として1回だけ積む', async () => {
      const log: GoalEvidence[][] = [];
      const loop = new LoopController(() => undefined);
      loop.start(goalPlan(recordingEvaluator(log)));
      await finishTurn(loop, [commandItem('c1', 'npm test', 'running')]);
      await finishTurn(loop, [commandItem('c1', 'npm test', 'exit 1')]);
      // 3ターン目にも同じ項目が会話へ残っているが、積み直さない
      await finishTurn(loop, [commandItem('c1', 'npm test', 'exit 1')]);
      const commands = (log[log.length - 1] ?? []).filter((e) => e.kind !== 'worker-report');
      expect(commands).toHaveLength(1);
      expect(commands[0]?.status).toBe('fail');
    });

    it('一時停止中に回数上限へ達したターンが終われば、再開しても次を送らずに止まっている', () => {
      const sent: string[] = [];
      const loop = new LoopController((t) => void sent.push(t));
      loop.start(plan({ maxIterations: 1 }));
      loop.pause();
      runTurn(loop);
      loop.resume();
      expect(sent).toHaveLength(1);
      expect(loop.running).toBe(false);
      expect(loop.getStatus().stopReason).toBe('maxReached');
    });

    it('一時停止中に撤退が申告されたら、再開を待たずに escalated で止める', () => {
      const sent: string[] = [];
      const loop = new LoopController((t) => void sent.push(t));
      loop.start(plan({ maxIterations: 5 }));
      loop.pause();
      runTurn(loop, state({ items: [agentMessage(`直せません\n${LOOP_ESCALATE_TOKEN}`)] }));
      loop.resume();
      expect(sent).toHaveLength(1);
      expect(loop.getStatus().stopReason).toBe('escalated');
    });

    it('一時停止中に停滞が成立したら、再開しても次を送らない', () => {
      const sent: string[] = [];
      const loop = new LoopController((t) => void sent.push(t), undefined, 2);
      loop.start(plan({ maxIterations: 20 }));
      const same = state({ turnResultText: '同じ報告' });
      runTurn(loop, same);
      loop.pause();
      runTurn(loop, same);
      loop.resume();
      expect(sent).toHaveLength(2);
      expect(loop.getStatus().stopReason).toBe('stalled');
    });

    it('ターンの走行中に再開しても、完了を見ないまま次を重ねて送らない', () => {
      const sent: string[] = [];
      const loop = new LoopController((t) => void sent.push(t));
      loop.start(plan({ maxIterations: 5 }));
      loop.observe(state({ busy: true }));
      loop.pause();
      loop.resume();
      expect(sent).toHaveLength(1);
      // 走行中のターンが終われば、通常どおり次を送る
      loop.observe(finished(state()));
      expect(sent).toHaveLength(2);
    });

    it('ゴール駆動で一時停止中に達成と判定されたら、再開しても次を送らない', async () => {
      const sent: string[] = [];
      const loop = new LoopController((t) => void sent.push(t));
      loop.start(goalPlan(async () => evaluation({ verdict: 'achieved' })));
      loop.pause();
      await finishTurn(loop);
      loop.resume();
      expect(sent).toHaveLength(1);
      expect(loop.getStatus().stopReason).toBe('done');
    });

    it('ゴール駆動で一時停止中に撤退と判定されたら、再開しても次を送らない', async () => {
      const sent: string[] = [];
      const loop = new LoopController((t) => void sent.push(t));
      loop.start(goalPlan(async () => evaluation({ verdict: 'escalate' })));
      loop.pause();
      await finishTurn(loop);
      loop.resume();
      expect(sent).toHaveLength(1);
      expect(loop.getStatus().stopReason).toBe('escalated');
    });

    it('ゴール駆動では、停滞が成立していても Evaluator の達成判定を先に見る', async () => {
      const log: GoalEvidence[][] = [];
      const loop = new LoopController(
        () => undefined,
        () => undefined,
        2,
      );
      loop.start(goalPlan(recordingEvaluator(log, ['continue', 'achieved'])));
      const same = state({ turnResultText: '同じ報告' });
      await finishTurn2(loop, same);
      await finishTurn2(loop, same);
      expect(log).toHaveLength(2);
      expect(loop.getStatus().stopReason).toBe('done');
    });

    it('ゴール駆動でも、未達のまま停滞すれば stalled で止める', async () => {
      const loop = new LoopController(
        () => undefined,
        () => undefined,
        2,
      );
      loop.start(goalPlan(async () => evaluation({ verdict: 'continue' })));
      const same = state({ turnResultText: '同じ報告' });
      await finishTurn2(loop, same);
      await finishTurn2(loop, same);
      expect(loop.getStatus().stopReason).toBe('stalled');
    });
  });

  describe('ターンの結果が確定するまで評価しない（issue #939）', () => {
    it('threadがidleになっただけでは評価を始めない', async () => {
      const inputs: GoalEvaluatorInput[] = [];
      const loop = new LoopController(() => undefined);
      loop.start(
        goalPlan(async (i) => {
          inputs.push(i);
          return evaluation();
        }),
      );
      loop.observe(state({ busy: true }));
      // `thread/status/changed`（idle）だけが届いた状態。`turn/completed` はまだで、
      // `turnResultText` は `turn/started` で空に戻したまま
      loop.observe(state({ busy: false, items: [agentMessage('直しました')] }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(inputs).toHaveLength(0);
    });

    it('turn/completed が届いてから、そのターンの申告を証拠として渡す', async () => {
      const inputs: GoalEvaluatorInput[] = [];
      const loop = new LoopController(() => undefined);
      loop.start(
        goalPlan(async (i) => {
          inputs.push(i);
          return evaluation();
        }),
      );
      const completed = state({
        items: [agentMessage('直しました')],
        turnResultText: '直しました',
      });
      loop.observe(state({ busy: true }));
      loop.observe(state({ busy: false, items: completed.items }));
      loop.observe(finished(completed));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(inputs).toHaveLength(1);
      const report = (inputs[0]?.evidence ?? []).filter((e) => e.kind === 'worker-report');
      expect(report).toHaveLength(1);
      expect(report[0]?.detail).toContain('直しました');
    });
  });
});

describe('LoopController: ターンの結果が確定するまで消費しない（issue #939）', () => {
  /**
   * Codexは`thread/status/changed`（idle）を`turn/completed`より先に送る。`busy`が
   * 落ちた時点の状態は「threadが暇になっただけ」で、`turnResultText`は`turn/started`が
   * 空に戻したままになっている。この状態を表す。
   */
  const idleOnly = (overrides: Partial<ChatState> = {}): ChatState =>
    state({ ...overrides, busy: false, turnResultText: '' });

  it('threadがidleになっただけでは次の指示を送らない', () => {
    const { sent, send } = spy();
    const controller = new LoopController(send);
    controller.start(plan());
    controller.observe(state({ busy: true }));
    controller.observe(idleOnly({ items: [agentMessage('直しました')] }));
    expect(sent).toHaveLength(1);
    expect(controller.running).toBe(true);
  });

  it('turn/completed が届いた時点で、1回だけ次の指示を送る', () => {
    const { sent, send } = spy();
    const controller = new LoopController(send);
    controller.start(plan());
    controller.observe(state({ busy: true }));
    controller.observe(idleOnly());
    controller.observe(finished(state({ turnResultText: '直しました' })));
    expect(sent).toHaveLength(2);
  });

  it('確定した後に別の状態変化が来ても、同じターンで二重に送らない', () => {
    const { sent, send } = spy();
    const controller = new LoopController(send);
    controller.start(plan());
    controller.observe(state({ busy: true }));
    controller.observe(idleOnly());
    const completed = finished(state({ turnResultText: '直しました' }));
    controller.observe(completed);
    expect(sent).toHaveLength(2);
    // 使用量の更新など、ターンとは関係のない状態変化が続けて届く
    controller.observe({ ...completed, items: [agentMessage('直しました')] });
    expect(sent).toHaveLength(2);
  });

  it('idle時点の空の応答を停滞の履歴へ積まない', () => {
    // 停滞閾値2。同じ本文を2ターン続けたら止まる。idle時点の空文字を積んでしまうと
    // 履歴が空だけで埋まり、本文の反復を検知できなくなる
    const controller = new LoopController(
      () => undefined,
      () => undefined,
      2,
    );
    controller.start(plan({ maxIterations: 10 }));
    for (let i = 0; i < 2; i += 1) {
      controller.observe(state({ busy: true }));
      controller.observe(idleOnly());
      controller.observe(finished(state({ turnResultText: '同じ報告' })));
    }
    expect(controller.getStatus().stopReason).toBe('stalled');
  });

  it('ターンの失敗も、確定した時点で止める', () => {
    const controller = new LoopController(() => undefined);
    controller.start(plan());
    controller.observe(state({ busy: true }));
    // idleだけの時点では、失敗かどうかもまだ確定していない
    controller.observe(idleOnly());
    expect(controller.running).toBe(true);
    controller.observe(finished(state({ turnFailed: true })));
    expect(controller.getStatus().stopReason).toBe('failed');
  });

  it('完了の合図も、確定したターンの発言として判定する', () => {
    const controller = new LoopController(() => undefined);
    controller.start(plan({ condition: '終わったら合図' }));
    const items = [agentMessage(`直しました\n${LOOP_DONE_TOKEN}`)];
    controller.observe(state({ busy: true }));
    controller.observe(idleOnly({ items }));
    expect(controller.running).toBe(true);
    controller.observe(finished(state({ items })));
    expect(controller.getStatus().stopReason).toBe('done');
  });
});

describe('LoopController（Advisor、issue #957）', () => {
  /** Advisorを挟むと待ちが1本増えるため、`finishTurn`より多めにマイクロタスクを回す。 */
  const finishAdvisedTurn = async (loop: LoopController): Promise<void> => {
    loop.observe(state({ busy: true }));
    loop.observe(finished(state()));
    for (let i = 0; i < 8; i += 1) {
      await Promise.resolve();
    }
  };

  const plan = (
    advisor: Partial<LoopAdvisorConfig> & Pick<LoopAdvisorConfig, 'advise'>,
    evaluate: GoalEvaluator = async () => evaluation({ nextFocus: 'テストを通す' }),
  ): LoopPlan => ({
    initialPrompt: '始めて',
    continuePrompt: '',
    maxIterations: 5,
    condition: '',
    goal: { definition: goalInput, evaluate },
    advisor,
  });

  const advice = (overrides: Partial<LoopAdvice> = {}): LoopAdvice => ({
    ...noAdvice(),
    ...overrides,
  });

  /** Advisorが動いて指摘を返した結果（issue #964）。 */
  const advised = (overrides: Partial<LoopAdvice> = {}) => advisorOk(advice(overrides));

  it('advisor を渡さないゴール駆動ループの挙動は変わらない', async () => {
    const sent: string[] = [];
    const loop = new LoopController((t) => void sent.push(t));
    const withAdvisor = plan({ advise: async () => advised() });
    const withoutAdvisor: LoopPlan = { ...withAdvisor };
    delete withoutAdvisor.advisor;
    loop.start(withoutAdvisor);
    loop.observe(state({ busy: true }));
    loop.observe(finished(state()));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('テストを通す');
    expect(sent[1]).not.toContain('Advisor');
  });

  it('EvaluatorとAdvisorへ同じ材料を渡す', async () => {
    let evaluatorInput: GoalEvaluatorInput | undefined;
    let advisorInput: GoalEvaluatorInput | undefined;
    const loop = new LoopController(() => undefined);
    loop.start(
      plan(
        {
          advise: async (i) => {
            advisorInput = i;
            return advised();
          },
        },
        async (i) => {
          evaluatorInput = i;
          return evaluation();
        },
      ),
    );
    await finishAdvisedTurn(loop);
    expect(advisorInput).toBe(evaluatorInput);
  });

  it('EvaluatorとAdvisorを並列に走らせる（相手の完了を待たずに始まる）', async () => {
    const started: string[] = [];
    let releaseEvaluator: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseEvaluator = resolve;
    });
    const loop = new LoopController(() => undefined);
    loop.start(
      plan(
        {
          advise: async () => {
            started.push('advisor');
            return advised();
          },
        },
        async () => {
          started.push('evaluator');
          await gate;
          return evaluation();
        },
      ),
    );
    loop.observe(state({ busy: true }));
    loop.observe(finished(state()));
    await Promise.resolve();
    // Evaluatorが止まっている間にAdvisorが走り出している
    expect(started).toEqual(['advisor', 'evaluator']);
    releaseEvaluator?.();
  });

  it('blocker でループを advised として止める（escalated とは別の理由）', async () => {
    const loop = new LoopController(() => undefined);
    loop.start(plan({ advise: async () => advised({ severity: 'blocker', findings: ['危険'] }) }));
    await finishAdvisedTurn(loop);
    expect(loop.running).toBe(false);
    expect(loop.getStatus().stopReason).toBe('advised');
  });

  it('concern では止めず、指摘を次のターンの参考として載せる', async () => {
    const sent: string[] = [];
    const loop = new LoopController((t) => void sent.push(t));
    loop.start(
      plan({
        advise: async () =>
          advised({
            severity: 'concern',
            findings: ['例外を握り潰している'],
            nextFocus: '直す',
            focus: 'inspect-regression-risk',
          }),
      }),
    );
    await finishAdvisedTurn(loop);
    expect(loop.running).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('### 別のAI（Advisor）からの指摘');
    expect(sent[1]).toContain('例外を握り潰している');
    // 指示になるのは列挙値から引いた固定文だけ（issue #962）
    expect(sent[1]).toContain('既存の動作を壊していないかを確かめてください。');
  });

  it('note の指摘は載せるが、次に集中することへは格上げしない', async () => {
    const sent: string[] = [];
    const loop = new LoopController((t) => void sent.push(t));
    loop.start(
      plan({
        advise: async () =>
          advised({
            severity: 'note',
            findings: ['命名が惜しい'],
            nextFocus: '名前を直す',
            focus: 'review-scope',
          }),
      }),
    );
    await finishAdvisedTurn(loop);
    expect(sent[1]).toContain('命名が惜しい');
    expect(sent[1]).not.toContain('名前を直す');
  });

  it('Advisorが例外を投げてもループは続く', async () => {
    const sent: string[] = [];
    const loop = new LoopController((t) => void sent.push(t));
    loop.start(
      plan({
        advise: async () => {
          throw new Error('CLIが落ちた');
        },
      }),
    );
    await finishAdvisedTurn(loop);
    expect(loop.running).toBe(true);
    expect(sent[1]).toContain('テストを通す');
  });

  it('Evaluatorが失敗してもAdvisorの指摘は使う', async () => {
    const sent: string[] = [];
    const loop = new LoopController((t) => void sent.push(t));
    loop.start(
      plan(
        {
          advise: async () => advised({ severity: 'concern', findings: ['証拠が足りない'] }),
        },
        async () => {
          throw new Error('Evaluatorが落ちた');
        },
      ),
    );
    await finishAdvisedTurn(loop);
    expect(sent[1]).toContain('証拠が足りない');
  });

  it('Advisorが失敗してもEvaluatorの判定は使う', async () => {
    const loop = new LoopController(() => undefined);
    loop.start(
      plan(
        {
          advise: async () => {
            throw new Error('Advisorが落ちた');
          },
        },
        async () => evaluation({ verdict: 'achieved' }),
      ),
    );
    await finishAdvisedTurn(loop);
    expect(loop.getStatus().stopReason).toBe('done');
  });

  it('everyNTurns の周でないターンでは呼ばず、前の周の指摘も持ち越さない', async () => {
    const sent: string[] = [];
    const calls: number[] = [];
    const loop = new LoopController((t) => void sent.push(t));
    loop.start(
      plan({
        everyNTurns: 2,
        advise: async (i) => {
          calls.push(i.iteration);
          return advised({ severity: 'concern', findings: ['1周目の指摘'] });
        },
      }),
    );
    await finishAdvisedTurn(loop);
    await finishAdvisedTurn(loop);
    await finishAdvisedTurn(loop);
    // 1ターン目は呼ばれず、2ターン目で呼ばれる
    expect(calls).toEqual([2]);
    expect(sent[1]).not.toContain('1周目の指摘');
    expect(sent[2]).toContain('1周目の指摘');
    expect(sent[3]).not.toContain('1周目の指摘');
  });

  it('Advisorが動いた周は、指摘が無くても会話へ残す', async () => {
    const notes: Array<{ status: string; severity: string; iteration: number }> = [];
    const loop = new LoopController(() => undefined);
    loop.start(
      plan({
        advise: async () => advised(),
        note: (n, iteration) =>
          notes.push({
            status: n.status,
            severity: n.status === 'ok' ? n.advice.severity : '',
            iteration,
          }),
      }),
    );
    await finishAdvisedTurn(loop);
    expect(notes).toEqual([{ status: 'ok', severity: 'note', iteration: 1 }]);
  });

  it('Advisorを呼ばない周は会話へ残さない', async () => {
    const notes: number[] = [];
    const loop = new LoopController(() => undefined);
    loop.start(
      plan({
        everyNTurns: 2,
        advise: async () => advised(),
        note: (_n, iteration) => notes.push(iteration),
      }),
    );
    await finishAdvisedTurn(loop);
    expect(notes).toEqual([]);
  });
  it('Advisorが動けなかった周は、指摘なしと区別できる形で会話へ残す（issue #964）', async () => {
    const notes: Array<{ status: string; reason?: string; failures?: number }> = [];
    const loop = new LoopController(() => undefined);
    loop.start(
      plan({
        advise: async () => advisorFailed('timeout'),
        note: (n) =>
          notes.push(
            n.status === 'failed'
              ? { status: n.status, reason: n.reason, failures: n.consecutiveFailures }
              : { status: n.status },
          ),
      }),
    );
    await finishAdvisedTurn(loop);
    expect(notes).toEqual([{ status: 'failed', reason: 'timeout', failures: 1 }]);
  });

  it('Advisorが例外を投げた周も failed として残す（指摘なしへ倒さない）', async () => {
    const statuses: string[] = [];
    const loop = new LoopController(() => undefined);
    loop.start(
      plan({
        advise: async () => {
          throw new Error('CLIが落ちた');
        },
        note: (n) => statuses.push(n.status),
      }),
    );
    await finishAdvisedTurn(loop);
    expect(statuses).toEqual(['failed']);
  });

  it('連続で動けなかった回数を数え、動いた周で0に戻す', async () => {
    const failures: number[] = [];
    let ok = false;
    const loop = new LoopController(() => undefined);
    loop.start(
      plan({
        advise: async () => (ok ? advised() : advisorFailed('process-error')),
        note: (n) => {
          if (n.status === 'failed') {
            failures.push(n.consecutiveFailures);
          }
        },
      }),
    );
    await finishAdvisedTurn(loop);
    await finishAdvisedTurn(loop);
    ok = true;
    await finishAdvisedTurn(loop);
    ok = false;
    await finishAdvisedTurn(loop);
    expect(failures).toEqual([1, 2, 1]);
  });

  it('動けなかった周の内容は次のターンの参考に載せない', async () => {
    const sent: string[] = [];
    const loop = new LoopController((t) => void sent.push(t));
    loop.start(plan({ advise: async () => advisorFailed('invalid-response') }));
    await finishAdvisedTurn(loop);
    expect(loop.running).toBe(true);
    expect(sent[1]).not.toContain('Advisor');
  });

  it('blocker と achieved が食い違ったら conflicted で止める（advised とは別）', async () => {
    const loop = new LoopController(() => undefined);
    loop.start(
      plan(
        { advise: async () => advised({ severity: 'blocker', findings: ['方向が違う'] }) },
        async () => evaluation({ verdict: 'achieved' }),
      ),
    );
    await finishAdvisedTurn(loop);
    expect(loop.running).toBe(false);
    expect(loop.getStatus().stopReason).toBe('conflicted');
  });

  it('blocker と indeterminate は従来どおり advised で止める', async () => {
    const loop = new LoopController(() => undefined);
    loop.start(
      plan(
        { advise: async () => advised({ severity: 'blocker', findings: ['方向が違う'] }) },
        async () => evaluation({ verdict: 'indeterminate' }),
      ),
    );
    await finishAdvisedTurn(loop);
    expect(loop.getStatus().stopReason).toBe('advised');
  });

  it('note が例外を投げても、その周の停止判定と次ターンの送信は行われる', async () => {
    const sent: string[] = [];
    const loop = new LoopController((t) => void sent.push(t));
    loop.start(
      plan({
        advise: async () => advised({ severity: 'concern', findings: ['例外を握り潰している'] }),
        note: () => {
          throw new Error('表示に失敗した');
        },
      }),
    );
    await finishAdvisedTurn(loop);
    expect(loop.running).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('例外を握り潰している');
  });

  it('note が例外を投げても blocker の停止は行われる', async () => {
    const loop = new LoopController(() => undefined);
    loop.start(
      plan({
        advise: async () => advised({ severity: 'blocker', findings: ['危険'] }),
        note: () => {
          throw new Error('表示に失敗した');
        },
      }),
    );
    await finishAdvisedTurn(loop);
    expect(loop.running).toBe(false);
    expect(loop.getStatus().stopReason).toBe('advised');
  });
});

describe('LoopController（Advisorの打ち切り、issue #1009）', () => {
  const finishAdvisedTurn = async (loop: LoopController): Promise<void> => {
    loop.observe(state({ busy: true }));
    loop.observe(finished(state()));
    for (let i = 0; i < 8; i += 1) {
      await Promise.resolve();
    }
  };

  const plan = (
    advisor: Partial<LoopAdvisorConfig> & Pick<LoopAdvisorConfig, 'advise'>,
  ): LoopPlan => ({
    initialPrompt: '始めて',
    continuePrompt: '',
    maxIterations: 10,
    condition: '',
    goal: {
      definition: { purpose: '直す', acceptanceCriteria: 'テストが通る' },
      evaluate: async () => evaluation({ nextFocus: '続ける' }),
    },
    advisor,
  });

  it('連続で動けない状態が続いたら、その実行では呼ぶのをやめる', async () => {
    const statuses: string[] = [];
    let calls = 0;
    const loop = new LoopController(() => undefined);
    loop.start(
      plan({
        advise: async () => {
          calls += 1;
          return advisorFailed('timeout');
        },
        note: (n) => statuses.push(n.status),
      }),
    );
    for (let i = 0; i < 5; i += 1) {
      await finishAdvisedTurn(loop);
    }
    // 3回目で打ち切る。4周目以降は呼ばれないので、呼び出しも記録も増えない
    expect(calls).toBe(ADVISOR_FAILURE_DISABLE_THRESHOLD);
    expect(statuses).toEqual(['failed', 'failed', 'disabled']);
  });

  it('打ち切っても本編は続く', async () => {
    const sent: string[] = [];
    const loop = new LoopController((t) => void sent.push(t));
    loop.start(plan({ advise: async () => advisorFailed('process-error') }));
    for (let i = 0; i < 4; i += 1) {
      await finishAdvisedTurn(loop);
    }
    expect(loop.running).toBe(true);
    expect(sent).toHaveLength(5);
  });

  it('次にループを始めれば、また呼ぶ', async () => {
    let calls = 0;
    const loop = new LoopController(() => undefined);
    const failing = plan({
      advise: async () => {
        calls += 1;
        return advisorFailed('timeout');
      },
    });
    loop.start(failing);
    for (let i = 0; i < 4; i += 1) {
      await finishAdvisedTurn(loop);
    }
    expect(calls).toBe(ADVISOR_FAILURE_DISABLE_THRESHOLD);
    // 打ち切りは実行ごとの状態であって、設定を無効にしたわけではない
    loop.start(failing);
    await finishAdvisedTurn(loop);
    expect(calls).toBe(ADVISOR_FAILURE_DISABLE_THRESHOLD + 1);
  });

  it('止めた実行の失敗は数に入れない', async () => {
    const statuses: string[] = [];
    let called = 0;
    const loop = new LoopController(() => undefined);
    loop.start(
      plan({
        advise: async () => {
          called += 1;
          // 応答が返る前にループが止められた状況を作る
          loop.stop('manual');
          return advisorFailed('process-error');
        },
        note: (n) => statuses.push(n.status),
      }),
    );
    await finishAdvisedTurn(loop);
    // Advisorは確かに呼ばれている（呼ばれないまま空になる検査にしない）
    expect(called).toBe(1);
    // そのうえで、世代の判定で降りるため会話にも残らず連続失敗にも数えない
    expect(statuses).toEqual([]);
  });

  it('会話へ残すidの材料になる実行の識別子を、実行ごとに変えて渡す', async () => {
    const runIds: number[] = [];
    const loop = new LoopController(() => undefined);
    const p = plan({
      advise: async () => advisorOk(noAdvice()),
      note: (_n, _iteration, runId) => runIds.push(runId),
    });
    loop.start(p);
    await finishAdvisedTurn(loop);
    loop.stop('manual');
    loop.start(p);
    await finishAdvisedTurn(loop);
    expect(runIds).toHaveLength(2);
    expect(runIds[0]).not.toBe(runIds[1]);
  });

  it('ループを止めると、待っているAdvisorへ打ち切りを伝える', async () => {
    let seen: AbortSignal | undefined;
    const loop = new LoopController(() => undefined);
    loop.start(
      plan({
        advise: async (_input, signal) => {
          seen = signal;
          return advisorOk(noAdvice());
        },
      }),
    );
    await finishAdvisedTurn(loop);
    expect(seen).toBeDefined();
    expect(seen?.aborted).toBe(false);
    loop.stop('manual');
    expect(seen?.aborted).toBe(true);
  });
});
