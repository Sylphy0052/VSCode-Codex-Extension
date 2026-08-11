import { describe, expect, it } from 'vitest';
import {
  buildCanUseToolResponse,
  buildContextUsageRequest,
  buildControlRequest,
  buildMcpStatusRequest,
  buildMcpToggleRequest,
  buildSetEffortRequest,
  buildSetModelRequest,
  buildSetPermissionModeRequest,
  buildUserMessage,
  describeCanUseTool,
  readCommandList,
  readMcpServersList,
  readModelList,
  readCommandsChanged,
  readContextUsage,
  readCurrentPermissionMode,
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

  it('画像をbase64のブロックとして本文の前に置く', () => {
    const line = buildUserMessage('これ直して', [
      { id: 'a1', name: 'shot.png', mediaType: 'image/png', data: 'QUJD', bytes: 3 },
    ]);
    expect(line.trimEnd().includes('\n')).toBe(false);
    expect(JSON.parse(line)).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
          { type: 'text', text: 'これ直して' },
        ],
      },
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

describe('readCommandList', () => {
  // 実測した `initialize` の応答（90件）の一部
  const payload = {
    commands: [
      {
        name: 'compact',
        description: 'Free up context by summarizing the conversation so far',
        argumentHint: '<optional custom summarization instructions>',
      },
      { name: 'context', description: 'Show current context usage', argumentHint: '' },
      { name: 'genshijin:genshijin', description: '原始人モード強度切替', argumentHint: '' },
      { name: 'genshijin:genshijin', description: '重複して返ってくる', argumentHint: '' },
      { name: '', description: '名前が無い', argumentHint: '' },
    ],
  };

  it('名前と説明と引数のヒントを取り出す', () => {
    expect(readCommandList(payload)?.[0]).toEqual({
      name: 'compact',
      description: 'Free up context by summarizing the conversation so far',
      argumentHint: '<optional custom summarization instructions>',
    });
  });

  it('同じ名前と名前無しを落とす', () => {
    expect(readCommandList(payload)?.map((c) => c.name)).toEqual([
      'compact',
      'context',
      'genshijin:genshijin',
    ]);
  });

  it('一覧が無いときは undefined（空の一覧と区別する）', () => {
    // 読めなかっただけで候補を消してしまわないようにする
    expect(readCommandList(undefined)).toBeUndefined();
    expect(readCommandList({})).toBeUndefined();
    expect(readCommandList({ commands: 'なにか' })).toBeUndefined();
    expect(readCommandList({ commands: [] })).toEqual([]);
  });
});

describe('readCommandsChanged', () => {
  it('セッション中の増減を受け取る', () => {
    const commands = readCommandsChanged({
      type: 'system',
      subtype: 'commands_changed',
      commands: [{ name: 'new-skill', description: '増えた', argumentHint: '' }],
    });
    expect(commands?.map((c) => c.name)).toEqual(['new-skill']);
  });

  it('他の通知は引き受けない', () => {
    expect(readCommandsChanged({ type: 'system', subtype: 'init' })).toBeUndefined();
    expect(readCommandsChanged({ type: 'assistant' })).toBeUndefined();
  });
});

describe('セッション中の設定変更', () => {
  const parse = (line: string) => JSON.parse(line.trim()) as Record<string, unknown>;

  it('モデルの変更は set_model で送る', () => {
    expect(parse(buildSetModelRequest('req_3', 'sonnet'))).toEqual({
      type: 'control_request',
      request_id: 'req_3',
      request: { subtype: 'set_model', model: 'sonnet' },
    });
  });

  it('承認方法の変更は set_permission_mode で送る', () => {
    expect(parse(buildSetPermissionModeRequest('req_4', 'plan'))).toEqual({
      type: 'control_request',
      request_id: 'req_4',
      request: { subtype: 'set_permission_mode', mode: 'plan' },
    });
  });

  it('effortは apply_flag_settings に載せる', () => {
    // set_effort / set_thinking_effort / set_reasoning_effort はどれも
    // Unsupported control request subtype になる（実測）
    expect(parse(buildSetEffortRequest('req_5', 'high'))).toEqual({
      type: 'control_request',
      request_id: 'req_5',
      request: { subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } },
    });
  });

  it('どれも1行で終わる', () => {
    for (const line of [
      buildSetModelRequest('r', 'sonnet'),
      buildSetPermissionModeRequest('r', 'plan'),
      buildSetEffortRequest('r', 'high'),
    ]) {
      expect(line.endsWith('\n')).toBe(true);
      expect(line.trimEnd().includes('\n')).toBe(false);
    }
  });
});

describe('readCurrentPermissionMode', () => {
  it('initialize の応答から今の承認方法を読む', () => {
    // 起動引数で plan にした場合、status通知は何かが変わるまで来ない
    expect(readCurrentPermissionMode({ current_permission_mode: 'plan' })).toBe('plan');
  });

  it('入っていなければ何も返さない', () => {
    expect(readCurrentPermissionMode({})).toBeUndefined();
    expect(readCurrentPermissionMode({ current_permission_mode: '' })).toBeUndefined();
    expect(readCurrentPermissionMode(undefined)).toBeUndefined();
  });
});

describe('readModelList', () => {
  // 実測した `initialize` の応答（CLI 2.1.227）
  const payload = {
    models: [
      {
        value: 'default',
        resolvedModel: 'claude-opus-5[1m]',
        displayName: 'Default (recommended)',
        description: 'Opus 5 with 1M context · Best for everyday, complex tasks',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      {
        value: 'haiku',
        resolvedModel: 'claude-haiku-4-5-20251001',
        displayName: 'Haiku',
        description: 'Haiku 4.5 · Fastest',
      },
      { value: '', displayName: '値が無い' },
    ],
  };

  it('表示名・説明・effortを取り出す', () => {
    expect(readModelList(payload)?.[0]).toEqual({
      slug: 'default',
      displayName: 'Default (recommended)',
      description: 'Opus 5 with 1M context · Best for everyday, complex tasks',
      defaultEffort: undefined,
      supportsEffort: true,
      efforts: [
        { effort: 'low', description: undefined },
        { effort: 'medium', description: undefined },
        { effort: 'high', description: undefined },
        { effort: 'xhigh', description: undefined },
        { effort: 'max', description: undefined },
      ],
    });
  });

  it('supportsEffortが無いモデルはeffortを持たない', () => {
    const haiku = readModelList(payload)?.[1];
    expect(haiku?.supportsEffort).toBe(false);
    expect(haiku?.efforts).toEqual([]);
  });

  it('値が無いモデルを落とす', () => {
    expect(readModelList(payload)?.map((m) => m.slug)).toEqual(['default', 'haiku']);
  });

  it('引数として渡せない形のeffortを捨てる', () => {
    const models = readModelList({
      models: [
        { value: 'x', supportsEffort: true, supportedEffortLevels: ['high', '--search', ''] },
      ],
    });
    expect(models?.[0]?.efforts.map((e) => e.effort)).toEqual(['high']);
  });

  it('一覧が無いときは undefined（空の一覧と区別する）', () => {
    expect(readModelList(undefined)).toBeUndefined();
    expect(readModelList({})).toBeUndefined();
    expect(readModelList({ models: 'なにか' })).toBeUndefined();
    expect(readModelList({ models: [] })).toEqual([]);
  });
});

describe('buildMcpStatusRequest / buildMcpToggleRequest', () => {
  it('mcp_status要求を作る', () => {
    const line = buildMcpStatusRequest('req_1');
    expect(JSON.parse(line)).toEqual({
      type: 'control_request',
      request_id: 'req_1',
      request: { subtype: 'mcp_status' },
    });
  });

  it('mcp_toggle要求はserverName（camelCase）で送る', () => {
    // 実測: server_name / name は Server not found: undefined になる
    const line = buildMcpToggleRequest('req_2', 'codegraph', false);
    expect(JSON.parse(line)).toEqual({
      type: 'control_request',
      request_id: 'req_2',
      request: { subtype: 'mcp_toggle', serverName: 'codegraph', enabled: false },
    });
  });
});

describe('readMcpServersList', () => {
  it('接続済みサーバーのツール数とバージョンを読む（実測: CLI 2.1.227）', () => {
    const servers = readMcpServersList({
      mcpServers: [
        {
          name: 'codegraph',
          status: 'connected',
          serverInfo: { name: 'codegraph', version: '1.5.0' },
          config: { type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'] },
          scope: 'local',
          tools: [{ name: 'codegraph_explore', annotations: { readOnly: true } }],
        },
      ],
    });
    expect(servers).toEqual([
      { name: 'codegraph', state: 'connected', toolCount: 1, version: '1.5.0', reason: undefined },
    ]);
  });

  it('失敗したサーバーはerrorをそのまま理由にする', () => {
    const servers = readMcpServersList({
      mcpServers: [
        {
          name: 'mcpprobe-fail',
          status: 'failed',
          error: "ENOENT: no such file or directory, posix_spawn '/nonexistent/binary-xyz'",
          config: { type: 'stdio', command: '/nonexistent/binary-xyz', args: ['--foo'] },
          scope: 'local',
        },
      ],
    });
    expect(servers).toEqual([
      {
        name: 'mcpprobe-fail',
        state: 'unavailable',
        toolCount: 0,
        version: undefined,
        reason: "ENOENT: no such file or directory, posix_spawn '/nonexistent/binary-xyz'",
      },
    ]);
  });

  it('無効化されたサーバーを読む', () => {
    const servers = readMcpServersList({
      mcpServers: [{ name: 'codegraph', status: 'disabled', config: {}, scope: 'local' }],
    });
    expect(servers).toEqual([
      { name: 'codegraph', state: 'disabled', toolCount: 0, version: undefined, reason: undefined },
    ]);
  });

  it('未知のstatusは使えない側へ倒す', () => {
    const servers = readMcpServersList({
      mcpServers: [{ name: 'x', status: 'pending', config: {}, scope: 'local' }],
    });
    expect(servers).toEqual([
      { name: 'x', state: 'unavailable', toolCount: 0, version: undefined, reason: undefined },
    ]);
  });

  it('名前を持たないエントリは読み飛ばす', () => {
    expect(readMcpServersList({ mcpServers: [{ status: 'connected' }] })).toEqual([]);
  });

  it('一覧が無いときはundefined（空の一覧と区別する）', () => {
    expect(readMcpServersList(undefined)).toBeUndefined();
    expect(readMcpServersList({})).toBeUndefined();
    expect(readMcpServersList({ mcpServers: 'なにか' })).toBeUndefined();
    expect(readMcpServersList({ mcpServers: [] })).toEqual([]);
  });
});
