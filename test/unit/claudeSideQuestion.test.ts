import { describe, expect, it } from 'vitest';
import {
  capSideQuestionHistory,
  describeSideQuestionError,
  describeSideQuestionProgress,
  describeSyntheticSideQuestionResponse,
  finishedSideQuestionDisplay,
  MAX_SIDE_QUESTION_HISTORY,
  pendingSideQuestionDisplay,
  progressSideQuestionDisplay,
} from '../../src/claude/sideQuestion';
import type {
  ControlRequestProgress,
  SideQuestionHistoryEntry,
  SideQuestionResult,
} from '../../src/claude/control';

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

  it('失敗時は質問を残したまま失敗として表示し、成功と誤判定しない（CLIの内部例外文言は出さない）', () => {
    const result: SideQuestionResult = {
      ok: false,
      response: undefined,
      synthetic: undefined,
      refusalFallback: undefined,
      error: {
        message: "Bt.map is not a function. (In 'Bt.map(...)', 'Bt.map' is undefined)",
        origin: 'cli',
      },
    };
    const display = finishedSideQuestionDisplay('質問', result);
    expect(display.status).toBe('failed');
    expect(display.text).toBe('質問');
    // CLI内部のJS例外メッセージをそのまま露出しない（実測、design.md §14.62）
    expect(display.detail).not.toContain('Bt.map');
    // リテラルで固定する（issue #340横断レビュー指摘: describeSideQuestionErrorとの
    // 比較は被テスト実装同士の比較になり、文言を変えても落ちない恒真テストだった）
    expect(display.detail).toBe('脇道の質問を送れませんでした（CLI側でエラーが発生しました）');
  });

  it('拡張機能自身のエラー（origin:app）は元の文言をそのまま表示する（issue #340横断レビュー指摘。CLI由来のエラーとして誤表示しない）', () => {
    const result: SideQuestionResult = {
      ok: false,
      response: undefined,
      synthetic: undefined,
      refusalFallback: undefined,
      error: { message: 'セッションが起動していません', origin: 'app' },
    };
    const display = finishedSideQuestionDisplay('質問', result);
    expect(display.status).toBe('failed');
    expect(display.detail).toBe('セッションが起動していません');
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

  it('synthetic:trueは封筒レベルは成功でもエラー相当として表示する（実測、design.md §14.62）', () => {
    const result: SideQuestionResult = {
      ok: true,
      response:
        '(The model tried to call web_search instead of answering directly. Try rephrasing or ask in the main conversation.)',
      synthetic: true,
      refusalFallback: undefined,
      error: undefined,
    };
    const display = finishedSideQuestionDisplay('質問', result);
    expect(display.status).toBe('failed');
    expect(display.text).toBe('質問');
    expect(display.detail).toBe(describeSyntheticSideQuestionResponse(result.response!));
  });

  it('synthetic:falseは従来どおり成功として扱う', () => {
    const result: SideQuestionResult = {
      ok: true,
      response: '午後3時です',
      synthetic: false,
      refusalFallback: undefined,
      error: undefined,
    };
    expect(finishedSideQuestionDisplay('今何時？', result).status).toBe('completed');
  });
});

describe('describeSideQuestionError（issue #340横断レビュー指摘: origin付きの型で由来を判定する）', () => {
  it('origin:cli（response.ok===false起因）はCLI内部の例外メッセージをそのまま出さず、常に汎用文言へ丸める（既知カタログを持たない）', () => {
    expect(describeSideQuestionError({ message: 'Bt.map is not a function. ...', origin: 'cli' })).toBe(
      '脇道の質問を送れませんでした（CLI側でエラーが発生しました）',
    );
  });

  it('undefinedも汎用文言へ丸める', () => {
    expect(describeSideQuestionError(undefined)).toBe(
      '脇道の質問を送れませんでした（CLI側でエラーが発生しました）',
    );
  });

  it('origin:app（拡張機能自身が組み立てた文言）は丸めずそのまま出す', () => {
    expect(
      describeSideQuestionError({ message: 'セッションが終了しました', origin: 'app' }),
    ).toBe('セッションが終了しました');
    expect(
      describeSideQuestionError({ message: '応答を読み取れませんでした', origin: 'app' }),
    ).toBe('応答を読み取れませんでした');
  });
});

describe('describeSyntheticSideQuestionResponse', () => {
  it('ツール呼び出しを試みたパターンは日本語の説明にCLIの文言を添えて残す', () => {
    const response =
      '(The model tried to call web_search instead of answering directly. Try rephrasing or ask in the main conversation.)';
    const described = describeSyntheticSideQuestionResponse(response);
    expect(described).toContain('ツール呼び出しを試みた');
    expect(described).toContain(response);
  });

  it('APIエラーのパターンは日本語の説明にCLIの文言を添えて残す', () => {
    const response = '(API error: rate limited)';
    const described = describeSyntheticSideQuestionResponse(response);
    expect(described).toContain('APIエラー');
    expect(described).toContain(response);
  });

  it('未知のパターンは汎用文言へ丸めつつCLIの文言は残す', () => {
    const response = '(something unexpected)';
    const described = describeSyntheticSideQuestionResponse(response);
    expect(described).toContain('実際には回答しませんでした');
    expect(described).toContain(response);
  });
});

describe('capSideQuestionHistory', () => {
  const entry = (n: number): SideQuestionHistoryEntry => ({
    question: `質問${n}`,
    response: `応答${n}`,
    fallbackNotice: undefined,
  });

  it('上限以下ならそのまま（新しいコピーを返す）', () => {
    const history = [entry(1), entry(2)];
    const capped = capSideQuestionHistory(history);
    expect(capped).toEqual(history);
    expect(capped).not.toBe(history);
  });

  it('上限を超えたら古いものから捨て、直近MAX_SIDE_QUESTION_HISTORY件だけ残す', () => {
    const history = Array.from({ length: MAX_SIDE_QUESTION_HISTORY + 5 }, (_, i) => entry(i + 1));
    const capped = capSideQuestionHistory(history);
    expect(capped).toHaveLength(MAX_SIDE_QUESTION_HISTORY);
    expect(capped[0]).toEqual(entry(6));
    expect(capped[capped.length - 1]).toEqual(entry(MAX_SIDE_QUESTION_HISTORY + 5));
  });
});
