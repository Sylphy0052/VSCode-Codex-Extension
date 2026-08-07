import { describe, expect, it } from 'vitest';
import {
  buildCanUseToolResponse,
  buildControlRequest,
  buildUserMessage,
  describeCanUseTool,
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
    ).toEqual({ requestId: 'req_1', ok: true, error: undefined });
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
