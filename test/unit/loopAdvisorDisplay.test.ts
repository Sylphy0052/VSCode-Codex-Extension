import { describe, expect, it } from 'vitest';
import { noAdvice, type LoopAdvice } from '../../src/loop/loopAdvisor';
import { advisorDisplay, advisorSkippedDisplay } from '../../src/view/loopAdvisorFactory';

const advice = (overrides: Partial<LoopAdvice> = {}): LoopAdvice => ({
  ...noAdvice(),
  ...overrides,
});

describe('advisorDisplay（issue #964）', () => {
  it('動いたうえで指摘が無かった周は「指摘はありませんでした」と出す', () => {
    const display = advisorDisplay({ status: 'ok', advice: advice() }, 3);
    expect(display.text).toContain('Advisor（3ターン目）');
    expect(display.text).toContain('指摘はありませんでした');
    expect(display.status).toBe('note');
  });

  it('動けなかった周は「指摘なし」とは違う文面で出す', () => {
    const display = advisorDisplay(
      { status: 'failed', reason: 'timeout', consecutiveFailures: 1 },
      2,
    );
    expect(display.text).toContain('Advisor（2ターン目）');
    expect(display.text).toContain('評価できませんでした');
    expect(display.text).toContain('時間内に応答しませんでした');
    expect(display.text).not.toContain('指摘はありませんでした');
    // 単発の失敗ではループを止めていないことも書く
    expect(display.text).toContain('ループは続行しています');
  });

  it('失敗の理由ごとに書き分ける', () => {
    const reasonOf = (reason: 'timeout' | 'invalid-response' | 'process-error'): string =>
      advisorDisplay({ status: 'failed', reason, consecutiveFailures: 1 }, 1).text;
    expect(reasonOf('invalid-response')).toContain('応答を読み取れませんでした');
    expect(reasonOf('process-error')).toContain('起動できないか、途中で終了しました');
  });

  it('1回だけの失敗では連続失敗として騒がない', () => {
    const display = advisorDisplay(
      { status: 'failed', reason: 'process-error', consecutiveFailures: 1 },
      1,
    );
    expect(display.text).not.toContain('続けて動けていません');
    expect(display.status).toBe('note');
  });

  it('連続して動けていないことが利用者に分かる', () => {
    const display = advisorDisplay(
      { status: 'failed', reason: 'process-error', consecutiveFailures: 3 },
      5,
    );
    expect(display.text).toContain('3回続けて動けていません');
    expect(display.text).toContain('進め方の点検が行われていません');
    expect(display.status).toBe('concern');
  });

  it('指摘がある周は従来どおり深刻度と指摘を出す', () => {
    const display = advisorDisplay(
      {
        status: 'ok',
        advice: advice({
          severity: 'concern',
          findings: ['テストが無い'],
          nextFocus: 'テストを足す',
          evidence: ['npm test が走っていない'],
        }),
      },
      1,
    );
    expect(display.status).toBe('concern');
    expect(display.text).toContain('テストが無い');
    expect(display.text).toContain('次に見直すこと: テストを足す');
    expect(display.detail).toContain('npm test が走っていない');
  });
});

describe('advisorDisplay（打ち切りと不動作の告知、issue #1009）', () => {
  it('呼ぶのをやめた周は、失敗の報告と区別できる文面で出す', () => {
    const display = advisorDisplay(
      { status: 'disabled', reason: 'timeout', consecutiveFailures: 3 },
      4,
    );
    expect(display.text).toContain('Advisor（4ターン目）');
    expect(display.text).toContain('呼ぶのをやめました');
    expect(display.text).toContain('3回続けて動けなかった');
    expect(display.text).toContain('時間内に応答しませんでした');
    // 設定が無効になったわけではないことも伝える
    expect(display.text).toContain('次にループを始めたときは、またAdvisorを呼びます');
    expect(display.status).toBe('concern');
  });

  it('ゴールの無いループで動かないことを、開始時に伝える', () => {
    const display = advisorSkippedDisplay();
    expect(display.text).toContain('このループでは動きません');
    expect(display.text).toContain('目的と受入基準');
    expect(display.status).toBe('note');
  });
});
