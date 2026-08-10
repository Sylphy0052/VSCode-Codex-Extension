import { describe, expect, it } from 'vitest';
import {
  buildCanUseToolResponse,
  buildContextUsageRequest,
  buildControlRequest,
  buildUserMessage,
  describeCanUseTool,
  readContextUsage,
  readControlRequest,
  readControlResponse,
} from '../../src/claude/control';

describe('buildUserMessage', () => {
  it('stdinへ書く1行のユーザーメッセージを作る', () => {
    const line = buildUserMessage('直して');
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '直して' }] },
    });
  });
});

describe('buildControlRequest', () => {
  it('request_id付きの制御要求を作る', () => {
    const line = buildControlRequest('req_1', { subtype: 'interrupt' });
    expect(JSON.parse(line)).toEqual({
      type: 'control_request',
      request_id: 'req_1',
      request: { subtype: 'interrupt' },
    });
  });
});

describe('readControlRequest', () => {
  it('CLIからの承認要求を読み取る', () => {
    const request = readControlRequest({
      type: 'control_request',
      request_id: 'r1',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf /' } },
    });
    expect(request).toEqual({
      requestId: 'r1',
      subtype: 'can_use_tool',
      payload: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf /' } },
    });
  });

  it('制御要求でないイベントは無視する', () => {
    expect(readControlRequest({ type: 'assistant' })).toBeUndefined();
    expect(readControlRequest({ type: 'control_request' })).toBeUndefined();
  });
});

describe('readControlResponse', () => {
  it('自分が出した要求への応答を読み取る', () => {
    expect(
      readControlResponse({
        type: 'control_response',
        response: { subtype: 'success', request_id: 'req_1', response: { ok: true } },
      }),
    ).toEqual({ requestId: 'req_1', ok: true, error: undefined, payload: { ok: true } });
  });

  it('エラー応答を読み取る', () => {
    expect(
      readControlResponse({
        type: 'control_response',
        response: { subtype: 'error', request_id: 'req_1', error: '未対応' },
      }),
    ).toEqual({ requestId: 'req_1', ok: false, error: '未対応' });
  });
});

describe('describeCanUseTool', () => {
  it('コマンド実行を承認カードにする', () => {
    const approval = describeCanUseTool('r1', {
      tool_name: 'Bash',
      input: { command: 'npm test', description: 'テスト実行' },
    });
    expect(approval).toEqual({
      requestId: 'r1',
      kind: 'command',
      title: 'コマンドの実行を許可しますか',
      detail: 'npm test',
    });
  });

  it('ファイル変更を承認カードにする', () => {
    const approval = describeCanUseTool('r1', {
      tool_name: 'Edit',
      input: { file_path: '/w/repo/src/a.ts' },
    });
    expect(approval?.kind).toBe('fileChange');
    expect(approval?.detail).toBe('/w/repo/src/a.ts');
  });

  it('未知のツールでも何を求められたかは出す', () => {
    const approval = describeCanUseTool('r1', {
      tool_name: 'WebFetch',
      input: { url: 'https://x' },
    });
    expect(approval?.kind).toBe('permissions');
    expect(approval?.title).toContain('WebFetch');
  });
});

describe('buildCanUseToolResponse', () => {
  it('許可は入力をそのまま返す', () => {
    expect(buildCanUseToolResponse('accept', { command: 'npm test' })).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'npm test' },
    });
  });

  it('この会話では常に許可も許可として返す（CLI側に区別が無い）', () => {
    expect(buildCanUseToolResponse('acceptForSession', {})).toEqual({
      behavior: 'allow',
      updatedInput: {},
    });
  });

  it('拒否と取り消しは deny', () => {
    expect(buildCanUseToolResponse('decline', {})).toEqual({
      behavior: 'deny',
      message: 'ユーザーが拒否しました',
    });
    expect(buildCanUseToolResponse('cancel', {})).toEqual({
      behavior: 'deny',
      message: 'ユーザーが拒否しました',
    });
  });
});

describe('buildContextUsageRequest', () => {
  it('get_context_usage を1行で送る', () => {
    const line = buildContextUsageRequest('req_2');
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line.trim())).toEqual({
      type: 'control_request',
      request_id: 'req_2',
      request: { subtype: 'get_context_usage' },
    });
  });
});

describe('readContextUsage', () => {
  // 実測した応答の一部。内訳（categories）は使わず合計と上限だけ取る
  const payload = {
    categories: [{ name: 'System prompt', tokens: 3897, color: 'promptBorder' }],
    totalTokens: 36342,
    maxTokens: 1000000,
    percentage: 4,
  };

  it('合計と上限から残りの割合を作る', () => {
    expect(readContextUsage(payload)).toEqual({
      usedTokens: 36342,
      contextWindow: 1000000,
      remainingPercent: 96,
    });
  });

  it('上限が無ければ割合を出さない', () => {
    expect(readContextUsage({ totalTokens: 100 })?.remainingPercent).toBeUndefined();
  });

  it('読めない応答では何も返さない', () => {
    expect(readContextUsage(undefined)).toBeUndefined();
    expect(readContextUsage({})).toBeUndefined();
  });
});

describe('readControlResponse の中身', () => {
  it('応答の中身を持ち帰る', () => {
    const response = readControlResponse({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'req_2', response: { totalTokens: 10 } },
    });
    expect(response?.payload).toEqual({ totalTokens: 10 });
  });

  it('中身が無ければ undefined', () => {
    const response = readControlResponse({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'req_1' },
    });
    expect(response?.ok).toBe(true);
    expect(response?.payload).toBeUndefined();
  });
});
