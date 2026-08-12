import { describe, expect, it } from 'vitest';
import {
  buildCanUseToolResponse,
  buildContextUsageRequest,
  buildControlRequest,
  buildGetSettingsRequest,
  buildMcpStatusRequest,
  buildMcpToggleRequest,
  buildRewindFilesRequest,
  buildSessionCostRequest,
  buildSetEffortRequest,
  buildSetModelRequest,
  buildSetPermissionModeRequest,
  buildStopTaskRequest,
  buildUserMessage,
  describeCanUseTool,
  readAgentList,
  readCommandList,
  readMcpServersList,
  readModelList,
  readCommandsChanged,
  readContextUsage,
  readCurrentPermissionMode,
  readExtraUsage,
  readFastModeState,
  readControlRequest,
  readControlResponse,
  readRewindFilesResult,
  readSessionCost,
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

describe('buildSessionCostRequest', () => {
  it('get_usage を1行で送る（issue #37）', () => {
    const line = buildSessionCostRequest('req_3');
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line.trim())).toEqual({
      type: 'control_request',
      request_id: 'req_3',
      request: { subtype: 'get_usage' },
    });
  });
});

describe('readSessionCost', () => {
  it('get_usage の応答からコストを読む', () => {
    const payload = {
      session: { total_cost_usd: 0.21, total_lines_added: 3, total_lines_removed: 1 },
      subscription_type: 'max',
    };
    expect(readSessionCost(payload, 1000)).toEqual({
      totalCostUsd: 0.21,
      totalLinesAdded: 3,
      totalLinesRemoved: 1,
      subscriptionType: 'max',
      capturedAt: 1000,
    });
  });

  it('コストが読めない応答では何も返さない', () => {
    expect(readSessionCost(undefined, 1000)).toBeUndefined();
    expect(readSessionCost({}, 1000)).toBeUndefined();
  });
});

describe('readExtraUsage（issue #204）', () => {
  it('get_usage の応答（rate_limits.extra_usage）から追加クレジットの状態を読む', () => {
    // issue #204のコメントに載っている実測値（CLI 2.1.227）そのまま
    const payload = {
      rate_limits: {
        extra_usage: {
          is_enabled: false,
          monthly_limit: 4000,
          used_credits: 0,
          utilization: 0,
          currency: 'USD',
          decimal_places: 2,
          disabled_reason: 'out_of_credits',
          user_disabled: false,
          spend_limit_reached: false,
          credits_ever_enabled: true,
          daily: null,
          weekly: null,
        },
      },
    };
    expect(readExtraUsage(payload)).toEqual({
      isEnabled: false,
      monthlyLimit: 40,
      usedCredits: 0,
      utilization: 0,
      currency: 'USD',
      disabledReason: 'out_of_credits',
      spendLimitReached: false,
    });
  });

  it('有効時は上限到達フラグと消費率をそのまま読む', () => {
    const payload = {
      rate_limits: {
        extra_usage: {
          is_enabled: true,
          monthly_limit: 10000,
          used_credits: 10000,
          utilization: 100,
          currency: 'USD',
          decimal_places: 2,
          disabled_reason: null,
          user_disabled: false,
          spend_limit_reached: true,
          credits_ever_enabled: true,
        },
      },
    };
    expect(readExtraUsage(payload)).toEqual({
      isEnabled: true,
      monthlyLimit: 100,
      usedCredits: 100,
      utilization: 100,
      currency: 'USD',
      disabledReason: undefined,
      spendLimitReached: true,
    });
  });

  it('decimal_placesが読めないときは金額を作らない（0円と決め付けない）', () => {
    const payload = {
      rate_limits: {
        extra_usage: { is_enabled: false, monthly_limit: 4000, used_credits: 500 },
      },
    };
    const result = readExtraUsage(payload);
    expect(result?.monthlyLimit).toBeUndefined();
    // usedCreditsは他の数値項目（totalLinesAdded等）と同じく0扱いにする
    expect(result?.usedCredits).toBe(0);
  });

  it('rate_limits.extra_usage自体が無ければ何も返さない（組織が対応しない・古いCLI）', () => {
    expect(readExtraUsage(undefined)).toBeUndefined();
    expect(readExtraUsage({})).toBeUndefined();
    expect(readExtraUsage({ rate_limits: {} })).toBeUndefined();
    expect(readExtraUsage({ rate_limits: { extra_usage: {} } })).toBeUndefined();
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

describe('readFastModeState（Issue #198）', () => {
  it('initialize の応答からFast modeの現在値を読む', () => {
    // 実測（CLI 2.1.227）の値は "off"
    expect(readFastModeState({ fast_mode_state: 'off' })).toBe(false);
    expect(readFastModeState({ fast_mode_state: 'on' })).toBe(true);
  });

  it('入っていなければ何も返さない（対応しない版と「オフ」を区別する）', () => {
    expect(readFastModeState({})).toBeUndefined();
    expect(readFastModeState({ fast_mode_state: '' })).toBeUndefined();
    expect(readFastModeState(undefined)).toBeUndefined();
  });

  it('知らない値はオフとして扱う（未知の状態で「オン」に倒さない）', () => {
    expect(readFastModeState({ fast_mode_state: 'unknown-value' })).toBe(false);
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

  it('supportsFastMode を三値で持つ（Issue #198）', () => {
    const models = readModelList({
      models: [
        { value: 'a', supportsFastMode: true },
        { value: 'b', supportsFastMode: false },
        // フィールドそのものが無い版では「情報が無い」として undefined のままにする
        { value: 'c' },
      ],
    });
    expect(models?.map((m) => m.supportsFastMode)).toEqual([true, false, undefined]);
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

describe('buildGetSettingsRequest', () => {
  it('get_settings要求を作る（hooks一覧の唯一の取得経路。issue #28）', () => {
    const line = buildGetSettingsRequest('req_1');
    expect(JSON.parse(line)).toEqual({
      type: 'control_request',
      request_id: 'req_1',
      request: { subtype: 'get_settings' },
    });
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

describe('buildStopTaskRequest（issue #33、design.md §14.23）', () => {
  it('stop_task要求はtask_id（スネークケース）で送る', () => {
    // 実測: 実際にBashをrun_in_background:trueで開始させ、この形の要求で
    // 開始から数秒後に停止できることを確認した（自然終了より十分前）
    const line = buildStopTaskRequest('req_3', 'b1xre2r80');
    expect(JSON.parse(line)).toEqual({
      type: 'control_request',
      request_id: 'req_3',
      request: { subtype: 'stop_task', task_id: 'b1xre2r80' },
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

describe('buildRewindFilesRequest', () => {
  it('user_message_id と dry_run を送る（実測: パラメータ名はスネークケース）', () => {
    // messageId 等キャメルケースでは通らないことをバイナリのstrings解析と実機で確認済み
    const line = buildRewindFilesRequest('req_1', 'msg-uuid-1', true);
    expect(JSON.parse(line.trim())).toEqual({
      type: 'control_request',
      request_id: 'req_1',
      request: { subtype: 'rewind_files', user_message_id: 'msg-uuid-1', dry_run: true },
    });
  });

  it('dry_run: false で実際に適用する要求を作る', () => {
    const line = buildRewindFilesRequest('req_2', 'msg-uuid-2', false);
    expect(JSON.parse(line.trim())).toEqual({
      type: 'control_request',
      request_id: 'req_2',
      request: { subtype: 'rewind_files', user_message_id: 'msg-uuid-2', dry_run: false },
    });
  });
});

describe('readRewindFilesResult', () => {
  it('戻せる場合は対象ファイルと増減行数を読む（実測: CLI 2.1.227、env var有効時）', () => {
    const response = readControlResponse({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req_1',
        response: { canRewind: true, filesChanged: ['/w/a.txt'], insertions: 0, deletions: 1 },
      },
    });
    expect(response).toBeDefined();
    expect(readRewindFilesResult(response!)).toEqual({
      ok: true,
      filesChanged: ['/w/a.txt'],
      insertions: 0,
      deletions: 1,
      error: undefined,
    });
  });

  it('実適用（dry_run: false）の応答は filesChanged を持たない', () => {
    // 実測: {"canRewind":true,"skippedLinks":0}
    const response = readControlResponse({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req_2',
        response: { canRewind: true, skippedLinks: 0 },
      },
    });
    expect(readRewindFilesResult(response!)).toEqual({
      ok: true,
      filesChanged: [],
      insertions: undefined,
      deletions: undefined,
      error: undefined,
    });
  });

  it('チェックポイントが無い場合（success包みでcanRewind: false）はエラーとして読む', () => {
    // 実測: dry_run:true かつチェックポイント無しは success 応答に包まれて canRewind: false で返る
    const response = readControlResponse({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req_3',
        response: { canRewind: false, error: 'No file checkpoint found for this message.' },
      },
    });
    expect(readRewindFilesResult(response!)).toEqual({
      ok: false,
      filesChanged: [],
      insertions: undefined,
      deletions: undefined,
      error: 'No file checkpoint found for this message.',
    });
  });

  it('トップレベルのエラー応答も読む（実測: dry_run:falseでチェックポイント無しのとき）', () => {
    const response = readControlResponse({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: 'req_4',
        error: 'No file checkpoint found for this message.',
      },
    });
    expect(readRewindFilesResult(response!)).toEqual({
      ok: false,
      filesChanged: [],
      insertions: undefined,
      deletions: undefined,
      error: 'No file checkpoint found for this message.',
    });
  });

  it('未対応のCLIでも安全に失敗として読む', () => {
    const response = readControlResponse({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: 'req_5',
        error: 'Unsupported control request subtype: rewind_files',
      },
    });
    expect(readRewindFilesResult(response!).ok).toBe(false);
  });
});

describe('readAgentList', () => {
  // 実測した `initialize` の応答（CLI 2.1.227）の一部。組込エージェントとユーザー定義の
  // カスタムエージェントが混ざって返る。`model` は一部のエントリにしか無い
  const payload = {
    agents: [
      {
        name: 'claude',
        description: "Catch-all for any task that doesn't fit a more specific agent.",
      },
      {
        name: 'code-reviewer',
        description: 'コード品質レビュー専用subagent。',
        model: 'sonnet',
      },
      { name: 'code-reviewer', description: '重複して返ってくる' },
      { name: '', description: '名前が無い' },
    ],
  };

  it('名前と説明を取り出す（modelは使わない）', () => {
    expect(readAgentList(payload)?.[0]).toEqual({
      name: 'claude',
      description: "Catch-all for any task that doesn't fit a more specific agent.",
    });
  });

  it('同じ名前と名前無しを落とす', () => {
    expect(readAgentList(payload)?.map((a) => a.name)).toEqual(['claude', 'code-reviewer']);
  });

  it('一覧が無いときは undefined（空の一覧と区別する）', () => {
    // 読めなかっただけで候補を消してしまわないようにする
    expect(readAgentList(undefined)).toBeUndefined();
    expect(readAgentList({})).toBeUndefined();
    expect(readAgentList({ agents: 'なにか' })).toBeUndefined();
    expect(readAgentList({ agents: [] })).toEqual([]);
  });
});
