import { describe, expect, it } from 'vitest';
import {
  describeSideQuestionProgress,
  finishedSideQuestionDisplay,
  pendingSideQuestionDisplay,
  progressSideQuestionDisplay,
} from '../../src/claude/sideQuestion';
import type { ControlRequestProgress, SideQuestionResult } from '../../src/claude/control';

describe('pendingSideQuestionDisplay（issue #334、design.md §14.62）', () => {
  it('送信直後は質問を本文に、状態はinProgressにする', () => {
    expect(pendingSideQuestionDisplay('今何時？')).toEqual({
      status: 'inProgress',
      text: '今何時？',
      detail: '送信中…',
    });
  });
});

describe('describeSideQuestionProgress', () => {
  it('startedは追加の注記を出さない（空文字）', () => {
    const progress: ControlRequestProgress = {
      requestId: 'req_1',
      status: 'started',
      attempt: undefined,
      maxRetries: undefined,
      retryDelayMs: undefined,
      errorStatus: undefined,
    };
    expect(describeSideQuestionProgress(progress)).toBe('');
  });

  it('api_retryはattempt/maxRetries/retryDelayMs/errorStatusを1つの文にする', () => {
    const progress: ControlRequestProgress = {
      requestId: 'req_2',
      status: 'api_retry',
      attempt: 2,
      maxRetries: 5,
      retryDelayMs: 3000,
      errorStatus: 'overloaded',
    };
    expect(describeSideQuestionProgress(progress)).toBe(
      'リトライ中 (2/5) ・3秒後に再試行 （overloaded）',
    );
  });

  it('api_retryでも付随情報が無ければ「リトライ中」だけを返す', () => {
    const progress: ControlRequestProgress = {
      requestId: 'req_3',
      status: 'api_retry',
      attempt: undefined,
      maxRetries: undefined,
      retryDelayMs: undefined,
      errorStatus: undefined,
    };
    expect(describeSideQuestionProgress(progress)).toBe('リトライ中');
  });

  it('未知のstatusは意味を決め打ちせず空文字を返す', () => {
    const progress: ControlRequestProgress = {
      requestId: 'req_4',
      status: 'something_new',
      attempt: undefined,
      maxRetries: undefined,
      retryDelayMs: undefined,
      errorStatus: undefined,
    };
    expect(describeSideQuestionProgress(progress)).toBe('');
  });
});

describe('progressSideQuestionDisplay', () => {
  it('注記が無いprogress（started等）はundefinedを返し、表示を更新させない', () => {
    const progress: ControlRequestProgress = {
      requestId: 'req_1',
      status: 'started',
      attempt: undefined,
      maxRetries: undefined,
      retryDelayMs: undefined,
      errorStatus: undefined,
    };
    expect(progressSideQuestionDisplay('質問', progress)).toBeUndefined();
  });

  it('api_retryは質問を保ったままinProgressの表示を更新する', () => {
    const progress: ControlRequestProgress = {
      requestId: 'req_2',
      status: 'api_retry',
      attempt: 1,
      maxRetries: 3,
      retryDelayMs: 1000,
      errorStatus: undefined,
    };
    expect(progressSideQuestionDisplay('質問', progress)).toEqual({
      status: 'inProgress',
      text: '質問',
      detail: 'リトライ中 (1/3) ・1秒後に再試行',
    });
  });
});

describe('finishedSideQuestionDisplay', () => {
  it('成功時は質問と応答を1本文にまとめ、本流に残らない旨の注記を添える', () => {
    const result: SideQuestionResult = {
      ok: true,
      response: '午後3時です',
      synthetic: false,
      refusalFallback: undefined,
      error: undefined,
    };
    const display = finishedSideQuestionDisplay('今何時？', result);
    expect(display.status).toBe('completed');
    expect(display.text).toBe('今何時？\n\n午後3時です');
    expect(display.detail).toContain('本流の会話には送られません');
  });

  it('refusal_fallback が付いていれば別モデルへ切り替わった旨を注記に足す', () => {
    const result: SideQuestionResult = {
      ok: true,
      response: '代わりに答えます',
      synthetic: false,
      refusalFallback: {
        originalModel: 'claude-opus-5',
        fallbackModel: 'claude-sonnet-5',
        content: '代わりに答えます',
      },
      error: undefined,
    };
    const display = finishedSideQuestionDisplay('質問', result);
    expect(display.detail).toContain('claude-opus-5');
    expect(display.detail).toContain('claude-sonnet-5');
  });

  it('失敗時は質問を残したまま失敗として表示し、成功と誤判定しない', () => {
    const result: SideQuestionResult = {
      ok: false,
      response: undefined,
      synthetic: undefined,
      refusalFallback: undefined,
      error: 'turn running',
    };
    const display = finishedSideQuestionDisplay('質問', result);
    expect(display.status).toBe('failed');
    expect(display.text).toBe('質問');
    expect(display.detail).toContain('turn running');
  });

  it('ok:trueでもresponseが無い（想定外の形）場合はfailed扱いにする', () => {
    const result: SideQuestionResult = {
      ok: true,
      response: undefined,
      synthetic: undefined,
      refusalFallback: undefined,
      error: undefined,
    };
    const display = finishedSideQuestionDisplay('質問', result);
    expect(display.status).toBe('failed');
  });
});
