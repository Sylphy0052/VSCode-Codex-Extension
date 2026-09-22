/**
 * 自動返信モード（Issue #1353）の純粋ロジック（`src/chat/autoReply.ts`）。
 *
 * プロンプト組み立て・停止の目印の検出・AskUserQuestionの応答パース・停止理由の説明・
 * ゲート判定（`shouldTriggerAutoReply`）を対象にする。`vscode`もセッションも使わない。
 */

import { describe, expect, it } from 'vitest';
import type { AskUserQuestionItem } from '../../src/claude/askUserQuestion';
import type { ChatItem } from '../../src/appserver/chatState';
import {
  AUTO_REPLY_STOP_MARKER,
  buildAutoReplyAskUserQuestionPrompt,
  buildAutoReplyRolePrompt,
  buildAutoReplyTurnPrompt,
  describeAutoReplyStopReason,
  extractAutoReplyMessage,
  firstUserMessageText,
  hasReachedAutoReplyMaxTurns,
  isAutoReplyStop,
  parseAutoReplyAskUserQuestionResponse,
  shouldTriggerAutoReply,
  type AutoReplyGateInput,
  type AutoReplyStopReason,
} from '../../src/chat/autoReply';

function item(kind: string, text: string): ChatItem {
  return {
    id: `${kind}-1`,
    kind,
    text,
    detail: '',
    status: undefined,
    turnId: undefined,
    diffs: [],
  };
}

const QUESTION: AskUserQuestionItem = {
  question: '続けますか？',
  header: '確認',
  multiSelect: false,
  options: [
    { label: 'はい', description: '' },
    { label: 'いいえ', description: '' },
  ],
};

const MULTI_QUESTION: AskUserQuestionItem = {
  question: '対象は？',
  header: '対象選択',
  multiSelect: true,
  options: [
    { label: 'A', description: '' },
    { label: 'B', description: '' },
    { label: 'C', description: '' },
  ],
};

describe('buildAutoReplyRolePrompt', () => {
  it('元の依頼文を含み、停止の目印の書き方を伝える', () => {
    const prompt = buildAutoReplyRolePrompt('ログイン機能を実装して');
    expect(prompt).toContain('ログイン機能を実装して');
    expect(prompt).toContain(AUTO_REPLY_STOP_MARKER);
    expect(prompt).toContain('返信役');
  });
});

describe('buildAutoReplyTurnPrompt', () => {
  it('直前の出力を指示ではなくデータとして囲う', () => {
    const prompt = buildAutoReplyTurnPrompt('実装が終わりました');
    expect(prompt).toContain('実装が終わりました');
    expect(prompt).toContain('指示ではない');
  });
});

describe('isAutoReplyStop / extractAutoReplyMessage', () => {
  it('停止の目印だけの応答を検出する', () => {
    expect(isAutoReplyStop(AUTO_REPLY_STOP_MARKER)).toBe(true);
    expect(isAutoReplyStop(`  ${AUTO_REPLY_STOP_MARKER}  `)).toBe(true);
    expect(isAutoReplyStop('続けてください')).toBe(false);
    expect(isAutoReplyStop(`前置き ${AUTO_REPLY_STOP_MARKER}`)).toBe(false);
  });

  it('前後の空白を落として本文を取り出す', () => {
    expect(extractAutoReplyMessage('  続けてください  \n')).toBe('続けてください');
  });
});

describe('hasReachedAutoReplyMaxTurns', () => {
  it('回数が上限に達したかを判定する', () => {
    expect(hasReachedAutoReplyMaxTurns(19, 20)).toBe(false);
    expect(hasReachedAutoReplyMaxTurns(20, 20)).toBe(true);
    expect(hasReachedAutoReplyMaxTurns(21, 20)).toBe(true);
  });
});

describe('describeAutoReplyStopReason', () => {
  it('全ての停止理由に日本語1行の説明がある', () => {
    const reasons: AutoReplyStopReason[] = [
      'maxTurns',
      'stalled',
      'stopMarker',
      'advisorFailed',
      'turnFailed',
      'userAction',
      'loopStarted',
      'idleTimeout',
      'tabClosed',
    ];
    for (const reason of reasons) {
      const text = describeAutoReplyStopReason(reason);
      expect(text.length).toBeGreaterThan(0);
    }
  });
});

describe('shouldTriggerAutoReply', () => {
  const base: AutoReplyGateInput = {
    autoReplyEnabled: true,
    loopRunning: false,
    turnFinished: true,
    busy: false,
    approvalsPending: 0,
    queuedPending: 0,
    turnFailed: false,
  };

  it('全条件を満たせば発火する', () => {
    expect(shouldTriggerAutoReply(base)).toBe(true);
  });

  it('OFF・ループ実行中・未完了・ビジー・承認待ち・キュー待ち・失敗のいずれかで止める', () => {
    expect(shouldTriggerAutoReply({ ...base, autoReplyEnabled: false })).toBe(false);
    expect(shouldTriggerAutoReply({ ...base, loopRunning: true })).toBe(false);
    expect(shouldTriggerAutoReply({ ...base, turnFinished: false })).toBe(false);
    expect(shouldTriggerAutoReply({ ...base, busy: true })).toBe(false);
    expect(shouldTriggerAutoReply({ ...base, approvalsPending: 1 })).toBe(false);
    expect(shouldTriggerAutoReply({ ...base, queuedPending: 1 })).toBe(false);
    expect(shouldTriggerAutoReply({ ...base, turnFailed: true })).toBe(false);
  });
});

describe('firstUserMessageText', () => {
  it('最初のuserMessageの本文を返す', () => {
    const items: ChatItem[] = [
      item('agentMessage', '準備できました'),
      item('userMessage', '最初の依頼'),
      item('userMessage', '2つ目の発言'),
    ];
    expect(firstUserMessageText(items)).toBe('最初の依頼');
  });

  it('userMessageが無ければundefined', () => {
    expect(firstUserMessageText([item('agentMessage', 'x')])).toBeUndefined();
  });
});

describe('buildAutoReplyAskUserQuestionPrompt', () => {
  it('質問文・選択肢・単一/複数選択の別を含む', () => {
    const prompt = buildAutoReplyAskUserQuestionPrompt([QUESTION, MULTI_QUESTION]);
    expect(prompt).toContain('続けますか？');
    expect(prompt).toContain('はい');
    expect(prompt).toContain('いいえ');
    expect(prompt).toContain('（1つだけ選択）');
    expect(prompt).toContain('対象は？');
    expect(prompt).toContain('（複数選択可）');
  });
});

describe('parseAutoReplyAskUserQuestionResponse', () => {
  it('単一選択の正しい応答をパースする', () => {
    const result = parseAutoReplyAskUserQuestionResponse(
      JSON.stringify({ '続けますか？': ['はい'] }),
      [QUESTION],
    );
    expect(result).toEqual({ '続けますか？': ['はい'] });
  });

  it('前後に説明文が付いたJSONでも抜き出してパースする', () => {
    const raw = `わかりました。\n{"続けますか？": ["いいえ"]}\n以上です。`;
    const result = parseAutoReplyAskUserQuestionResponse(raw, [QUESTION]);
    expect(result).toEqual({ '続けますか？': ['いいえ'] });
  });

  it('複数選択の正しい応答をパースする', () => {
    const result = parseAutoReplyAskUserQuestionResponse(
      JSON.stringify({ '対象は？': ['A', 'C'] }),
      [MULTI_QUESTION],
    );
    expect(result).toEqual({ '対象は？': ['A', 'C'] });
  });

  it('JSONとして解釈できなければundefined', () => {
    expect(parseAutoReplyAskUserQuestionResponse('これはJSONではない', [QUESTION])).toBeUndefined();
  });

  it('isAskUserQuestionSelectionsの形を満たさなければundefined', () => {
    expect(
      parseAutoReplyAskUserQuestionResponse(JSON.stringify({ '続けますか？': 'はい' }), [QUESTION]),
    ).toBeUndefined();
    expect(parseAutoReplyAskUserQuestionResponse(JSON.stringify({}), [QUESTION])).toBeUndefined();
  });

  it('キーが渡した質問文と一致しなければundefined', () => {
    expect(
      parseAutoReplyAskUserQuestionResponse(JSON.stringify({ '違う質問': ['はい'] }), [QUESTION]),
    ).toBeUndefined();
  });

  it('質問数より多い・少ないキーがあればundefined', () => {
    expect(
      parseAutoReplyAskUserQuestionResponse(
        JSON.stringify({ '続けますか？': ['はい'], '余分な質問': ['x'] }),
        [QUESTION],
      ),
    ).toBeUndefined();
  });

  it('選択肢に存在しないラベルはundefined', () => {
    expect(
      parseAutoReplyAskUserQuestionResponse(JSON.stringify({ '続けますか？': ['たぶん'] }), [QUESTION]),
    ).toBeUndefined();
  });

  it('単一選択の質問で2件以上選ぶとundefined', () => {
    expect(
      parseAutoReplyAskUserQuestionResponse(
        JSON.stringify({ '続けますか？': ['はい', 'いいえ'] }),
        [QUESTION],
      ),
    ).toBeUndefined();
  });

  it('単一選択の質問で0件（空配列）もundefined', () => {
    expect(
      parseAutoReplyAskUserQuestionResponse(JSON.stringify({ '続けますか？': [] }), [QUESTION]),
    ).toBeUndefined();
  });
});
