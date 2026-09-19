import { describe, expect, it } from 'vitest';
import {
  HandoffTrace,
  describeAssessment,
  describeDecision,
  describeGate,
  describeProfile,
} from '../../src/view/handoffTrace';
import type { TaskAssessment } from '../../src/view/handoffRouter';

/** `Logger` の代わり。出た行をそのまま貯める。 */
function sink(): { info: string[]; warn: string[]; logger: HandoffTrace } {
  const info: string[] = [];
  const warn: string[] = [];
  const logger = new HandoffTrace({
    info: (m) => info.push(m),
    warn: (m) => warn.push(m),
  });
  return { info, warn, logger };
}

const gate = {
  busy: false,
  turnFailed: false,
  pendingApprovals: 0,
  pendingPrompts: 0,
  awaitingUserAnswer: false,
  queued: 0,
  loopRunning: false,
  taskManaged: false,
  backgroundRunning: false,
};

const assessment: TaskAssessment = {
  taskType: 'implementation',
  difficulty: 1,
  scope: 2,
  ambiguity: 0,
  risk: 1,
  autonomy: 2,
  confidence: 0.8,
  reasons: [],
  switchSafe: true,
  switchReason: '実装が一段落した',
  handoffSuggested: true,
  handoffSuggestReason: '別セッションでの実装を勧めている',
  awaitingUserAnswer: false,
  awaitingUserAnswerReason: '',
};

describe('判定過程のログ（Issue #1097）', () => {
  it('行頭を autoHandoff: で揃える', () => {
    const s = sink();
    s.logger.info('gate blocked');
    expect(s.info).toEqual(['autoHandoff: gate blocked']);
  });

  it('同じ理由が連続したときは出さない', () => {
    const s = sink();
    s.logger.info('前回と同じ材料のため分類器を起動しない');
    s.logger.info('前回と同じ材料のため分類器を起動しない');
    s.logger.info('前回と同じ材料のため分類器を起動しない');
    expect(s.info).toHaveLength(1);
  });

  it('間に別の理由が挟まれば、同じ理由でもまた出す', () => {
    const s = sink();
    s.logger.info('A');
    s.logger.info('B');
    s.logger.info('A');
    expect(s.info).toEqual(['autoHandoff: A', 'autoHandoff: B', 'autoHandoff: A']);
  });

  it('警告は抑制しない（分類器の失敗は毎回残す）', () => {
    const s = sink();
    s.logger.warn('時間切れ');
    s.logger.warn('時間切れ');
    expect(s.warn).toHaveLength(2);
  });
});

describe('ログの1行の中身（Issue #1097）', () => {
  it('前段で落ちたときは全条件の値を並べる', () => {
    const line = describeGate({ ...gate, busy: true, queued: 2 });
    expect(line).toContain('busy=true');
    expect(line).toContain('queued=2');
    // 原因でない条件も並べる（どれが原因かを後から絞れるように）
    expect(line).toContain('turnFailed=false');
    expect(line).toContain('loopRunning=false');
    expect(line).toContain('taskManaged=false');
    expect(line).toContain('backgroundRunning=false');
  });

  it('分類器の結果は5軸と switchSafe / handoffSuggested を出す', () => {
    const line = describeAssessment(assessment);
    expect(line).toContain('taskType=implementation');
    for (const axis of ['difficulty=1', 'scope=2', 'ambiguity=0', 'risk=1', 'autonomy=2']) {
      expect(line).toContain(axis);
    }
    expect(line).toContain('switchSafe=true');
    expect(line).toContain('handoffSuggested=true');
    expect(line).toContain('switchReason=実装が一段落した');
    expect(line).toContain('handoffSuggestReason=別セッションでの実装を勧めている');
  });

  it('解決したmodel/effortと profileChanged を出す', () => {
    expect(
      describeProfile({
        assessment,
        switchSafe: true,
        switchReason: '',
        handoffSuggested: true,
        handoffSuggestReason: '',
        awaitingUserAnswer: false,
        awaitingUserAnswerReason: '',
        profileChanged: true,
        profile: { model: 'gpt-5.6-astra', effort: 'high' },
      }),
    ).toBe('model=gpt-5.6-astra effort=high profileChanged=true');
  });

  it('発火した契機と、発火しなかった旨をどちらも出す', () => {
    expect(describeDecision(undefined)).toBe('decision: 発火しない');
    expect(
      describeDecision({
        kind: 'assistantSuggested',
        switchReason: '',
        suggestReason: '別セッションを勧めている',
      }),
    ).toBe('decision: assistantSuggested (別セッションを勧めている)');
    expect(describeDecision({ kind: 'threshold', remainingPercent: 12 })).toBe(
      'decision: threshold (remainingPercent=12)',
    );
    expect(
      describeDecision({ kind: 'profileChanged', model: 'opus', effort: '', switchReason: '' }),
    ).toBe('decision: profileChanged (opus / 既定)');
    expect(describeDecision({ kind: 'compactBoundary' })).toBe('decision: compactBoundary');
  });
});
