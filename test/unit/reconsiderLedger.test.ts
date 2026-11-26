/**
 * 場面の台帳で再考する（Issue #2065）。
 *
 * 固定するのは次の境界である。
 * - 実行記録は会話の記録のコマンド項目だけから作り、advisorへの入力に入る（受入基準2）
 * - 2回目の再考では、前回の台帳がadvisorへの入力に入る（受入基準4）
 * - 全場面が埋まったときだけ「埋まった」になる（受入基準5）
 * - 返った台帳は作業中のAIへ、未確認の場面を実測させる指示つきで差し込まれる（受入基準3）
 * - review工程の指示に、場面ごとの照合手順と前回の台帳が入る（受入基準6）
 */

import { describe, expect, it } from 'vitest';
import type { ChatItem } from '../../src/appserver/chatState';
import { buildExecutionRecordMarkdown } from '../../src/appserver/transcriptMarkdown';
import {
  buildLedgerInstruction,
  buildLedgerRequest,
  formatLedger,
  isLedgerFilled,
  LedgerStore,
  parseLedger,
  unsettledScenes,
} from '../../src/secondOpinion/ledger';
import type { LoopPlan, LoopStopReason } from '../../src/loop/loopController';
import { initialChatState, type ChatState } from '../../src/appserver/chatState';
import type {
  TaskSession,
  TaskSessionHost,
  TaskSessionInput,
} from '../../src/orchestrator/taskSession';
import { buildSecondOpinionPrompt } from '../../src/secondOpinion/prompt';
import { runSecondOpinion } from '../../src/secondOpinion/run';
import { buildStagePrompt } from '../../src/orchestrator/taskStagePrompts';
import type { OrchestratedTask } from '../../src/orchestrator/taskRunState';

const item = (over: Partial<ChatItem> & Pick<ChatItem, 'id' | 'kind'>): ChatItem => ({
  text: '',
  detail: '',
  status: undefined,
  turnId: undefined,
  diffs: [],
  ...over,
});

const ADVISOR_ANSWER = [
  '回答の前置き。',
  '対象: 取り込み前の編集がある状態での規定',
  '場面:',
  '  S1 配布物を変えない変更 | 種別: 自明に通る場面 | 状態: 実測済み | 根拠: npm test の出力',
  '  S2 取り込み前の編集が残っている | 種別: 本来の場面 | 状態: 未確認 | 根拠: （なし）',
  '指摘:',
  '  F1 編集が残るとmergeが失敗する | 由来の場面: S2 | 状態: 未対応',
].join('\n');

describe('台帳の解析と判定', () => {
  it('advisorの回答から場面と指摘を読む', () => {
    const ledger = parseLedger(ADVISOR_ANSWER);
    expect(ledger?.target).toBe('取り込み前の編集がある状態での規定');
    expect(ledger?.scenes.map((s) => [s.id, s.kind, s.state])).toEqual([
      ['S1', '自明に通る場面', '実測済み'],
      ['S2', '本来の場面', '未確認'],
    ]);
    expect(ledger?.findings[0]).toMatchObject({ id: 'F1', sceneId: 'S2', state: '未対応' });
  });

  it('場面が1つも読めなければundefined', () => {
    expect(parseLedger('台帳は作れませんでした')).toBeUndefined();
  });

  it('読めない種別・状態は、埋まる側へ倒さず本来の場面・未確認にする', () => {
    const ledger = parseLedger('S1 何か | 種別: ？ | 状態: たぶん大丈夫');
    expect(ledger?.scenes[0]).toMatchObject({ kind: '本来の場面', state: '未確認' });
  });

  it('自明に通る場面だけが実測済みでも「埋まった」にしない', () => {
    const ledger = parseLedger('S1 変更なし | 種別: 自明に通る場面 | 状態: 実測済み | 根拠: x');
    expect(ledger).toBeDefined();
    expect(isLedgerFilled(ledger!)).toBe(false);
  });

  it('本来の場面が未確認なら埋まらず、実測済みになれば埋まる', () => {
    const ledger = parseLedger(ADVISOR_ANSWER)!;
    expect(isLedgerFilled(ledger)).toBe(false);
    expect(unsettledScenes(ledger).map((s) => s.id)).toEqual(['S2']);
    const measured = parseLedger(
      [
        'S1 配布物を変えない変更 | 種別: 自明に通る場面 | 状態: 実測済み | 根拠: a',
        'S2 取り込み前の編集が残っている | 種別: 本来の場面 | 状態: 実測済み | 根拠: git status の出力',
        'F1 編集が残るとmergeが失敗する | 由来の場面: S2 | 状態: 対応済み（修正をcommit）',
      ].join('\n'),
    )!;
    expect(isLedgerFilled(measured)).toBe(true);
  });

  it('理由つきの不採用は決着として数え、理由が無ければ数えない', () => {
    const withReason = parseLedger(
      'S1 a | 種別: 本来の場面 | 状態: 推論のみ\nF1 x | 由来の場面: S1 | 状態: 不採用（この環境では起きない）',
    )!;
    expect(isLedgerFilled(withReason)).toBe(true);
    const withoutReason = parseLedger(
      'S1 a | 種別: 本来の場面 | 状態: 推論のみ\nF1 x | 由来の場面: S1 | 状態: 不採用',
    )!;
    expect(isLedgerFilled(withoutReason)).toBe(false);
  });

  it('書式化した台帳をもう一度読むと同じになる', () => {
    const ledger = parseLedger(ADVISOR_ANSWER)!;
    expect(parseLedger(formatLedger(ledger))).toEqual(ledger);
  });
});

describe('実行記録（受入基準2）', () => {
  const items: ChatItem[] = [
    item({ id: 'u1', kind: 'userMessage', text: '直して' }),
    item({
      id: 'c1',
      kind: 'commandExecution',
      detail: 'npm test',
      status: 'failed',
      text: `${'a'.repeat(5000)}\nFAIL: 3 tests`,
    }),
    item({ id: 'a1', kind: 'agentMessage', text: '全部通りました' }),
    item({
      id: 'c2',
      kind: 'commandExecution',
      detail: 'git status',
      status: 'completed',
      text: 'clean',
    }),
  ];

  it('コマンド項目だけを、コマンド・終了状態・出力の末尾つきで抜く', () => {
    const md = buildExecutionRecordMarkdown(items, 'Codex');
    expect(md).toContain('npm test');
    expect(md).toContain('failed');
    expect(md).toContain('FAIL: 3 tests');
    expect(md).toContain('git status');
    expect(md).not.toContain('全部通りました');
    expect(md).not.toContain('直して');
    // 出力は末尾だけ（先頭の省略が明記される）
    expect(md).toContain('先頭');
    expect(md).not.toContain('a'.repeat(2000));
  });

  it('コマンドが無ければ空', () => {
    expect(buildExecutionRecordMarkdown([items[0]!], 'Codex')).toBe('');
  });

  it('advisorへの入力に「実行記録」の区画として入る。無ければ区画を出さない', () => {
    const records = buildExecutionRecordMarkdown(items, 'Codex');
    const prompt = buildSecondOpinionPrompt({
      userRequest: '台帳',
      artifact: { kind: 'none' },
      executionRecords: records,
    });
    expect(prompt).toContain('## 実行記録');
    expect(prompt).toContain('FAIL: 3 tests');
    const without = buildSecondOpinionPrompt({ userRequest: '台帳', artifact: { kind: 'none' } });
    expect(without).not.toContain('## 実行記録');
  });
});

class CapturingSession implements TaskSession {
  readonly sessionId = 'ledger-session';
  private finished: ((reason: LoopStopReason, state: ChatState) => void) | undefined;
  constructor(private readonly onPrompt: (prompt: string) => void) {}
  send(): void {}
  setPromptTransform(): void {}
  onApprovalResolved(): void {}
  compact(): Promise<void> {
    return Promise.resolve();
  }
  note(): void {}
  pauseLoop(): void {}
  resumeLoop(): void {}
  async checkMessagingToolVisible(): Promise<boolean> {
    return true;
  }
  stopLoop(): boolean {
    return true;
  }
  open(): void {}
  decideApproval(): void {}
  reveal(): void {}
  setApprovalHandler(): void {}
  onStateChanged(): void {}
  onFinished(handler: (reason: LoopStopReason, state: ChatState) => void): void {
    this.finished = handler;
  }
  runLoop(plan: LoopPlan): void {
    this.onPrompt(plan.initialPrompt);
    this.finished?.('maxReached', { ...initialChatState, turnResultText: ADVISOR_ANSWER });
  }
  async interrupt(): Promise<void> {}
  dispose(): void {}
}

describe('advisorへ実際に送る本文（受入基準2・4）', () => {
  async function sentPrompt(request: string, executionRecords: string): Promise<string> {
    let sent = '';
    const host: TaskSessionHost = {
      openTaskSession: (_input: TaskSessionInput) =>
        Promise.resolve(
          new CapturingSession((p) => {
            sent = p;
          }),
        ),
    };
    const result = await runSecondOpinion(host, {
      cwd: '/repo',
      candidate: { name: 'Sol', model: 'gpt-6.1-sol', effort: 'high' },
      request,
      artifact: { kind: 'none' },
      executionRecords,
      headless: true,
    });
    expect(result.ok).toBe(true);
    return sent;
  }

  it('実行記録が送信本文に入る', async () => {
    const prompt = await sentPrompt(
      buildLedgerRequest(undefined, false),
      '## コマンド ・ npm test ・ failed',
    );
    expect(prompt).toContain('## 実行記録');
    expect(prompt).toContain('npm test');
  });

  it('2回目の再考では、前回の台帳が送信本文に入る', async () => {
    const previous = parseLedger(ADVISOR_ANSWER)!;
    const first = await sentPrompt(buildLedgerRequest(undefined, false), 'x');
    expect(first).not.toContain('前回の台帳');
    const second = await sentPrompt(buildLedgerRequest(previous, false), 'x');
    expect(second).toContain('前回の台帳');
    expect(second).toContain('S2 取り込み前の編集が残っている');
    expect(second).toContain('新しい場面の追加と状態の更新だけ');
  });

  it('埋まった台帳での再考は、列挙漏れだけを探させる', () => {
    const filled = parseLedger('S1 a | 種別: 本来の場面 | 状態: 実測済み | 根拠: x')!;
    expect(buildLedgerRequest(filled, true)).toContain('列挙漏れだけを探す');
  });
});

describe('作業中のAIへ差し込む指示（受入基準3・5）', () => {
  it('未確認の場面があれば、実測して台帳を更新する指示が付く', () => {
    const ledger = parseLedger(ADVISOR_ANSWER)!;
    const text = buildLedgerInstruction(ledger, ADVISOR_ANSWER);
    expect(text).toContain('未確認の場面（1件）を実測し、台帳を更新');
    expect(text).toContain('どの場面の取りこぼしかを書いて');
    expect(text).toContain('S2 取り込み前の編集が残っている');
  });

  it('埋まった台帳には実測の指示を付けない', () => {
    const filled = parseLedger('S1 a | 種別: 本来の場面 | 状態: 実測済み | 根拠: x')!;
    const text = buildLedgerInstruction(filled, '');
    expect(text).toContain('場面の台帳は埋まりました');
    expect(text).not.toContain('を実測し、台帳を更新');
  });

  it('台帳は会話（親セッション）ごとに保存される', () => {
    const store = new LedgerStore();
    const ledger = parseLedger(ADVISOR_ANSWER)!;
    store.set('a', ledger);
    expect(store.get('a')).toBe(ledger);
    expect(store.get('b')).toBeUndefined();
    store.delete('a');
    expect(store.get('a')).toBeUndefined();
  });
});

describe('review工程の指示（受入基準6）', () => {
  const baseTask = (over: Partial<OrchestratedTask>): OrchestratedTask =>
    ({
      taskId: 'T2',
      title: 't',
      summary: '',
      acceptanceCriteria: ['基準A'],
      branch: 'feature/x',
      pullRequest: { number: 5, url: 'https://example.test/pull/5' },
      review: undefined,
      ...over,
    }) as unknown as OrchestratedTask;
  const ref = {
    taskId: 'T2',
    executionId: 'e',
    stage: 'review' as const,
    attemptId: 'a',
  };

  it('受入基準を場面ごとに照合する手順と台帳の書式が入る', () => {
    const prompt = buildStagePrompt(
      { task: baseTask({}), ref, instruction: undefined, cwd: '/w' },
      'nonce',
    );
    expect(prompt).toContain('受入基準を1つずつ、それが働く場面と一緒に照合する');
    expect(prompt).toContain('自明に通る場面だけを試した検証は「推論のみ」と同じ扱い');
    expect(prompt).toContain('場面:');
    expect(prompt).not.toContain('前回のレビューの要約');
  });

  it('差し戻し後は、前回の台帳（レビューの要約）と指摘を渡す', () => {
    const prompt = buildStagePrompt(
      {
        task: baseTask({
          review: {
            summary: '要約\nS2 取り込み前の編集が残っている | 種別: 本来の場面 | 状態: 未確認',
            remainingFindings: ['F1 mergeが失敗する'],
            passed: false,
          },
        }),
        ref,
        instruction: undefined,
        cwd: '/w',
      },
      'nonce',
    );
    expect(prompt).toContain('S2 取り込み前の編集が残っている');
    expect(prompt).toContain('F1 mergeが失敗する');
    expect(prompt).toContain('新しい場面の追加と状態の更新だけ');
  });
});
