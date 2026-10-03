import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HANDOFF_DIGEST_LIMIT,
  clipMiddle,
  createClaudeDigestBuilder,
  createCodexDigestBuilder,
  createHandoffDigestBuilder,
  readHandoffDigest,
  renderHandoffDigest,
  type HandoffDigest,
  type HandoffDigestBuilder,
} from '../../src/view/handoffDigest';

function j(value: unknown): string {
  return JSON.stringify(value);
}

function feed(builder: HandoffDigestBuilder, ...entries: unknown[]): void {
  for (const entry of entries) {
    builder.push(typeof entry === 'string' ? entry : j(entry));
  }
}

function claudeUser(content: unknown, extra: Record<string, unknown> = {}): unknown {
  return { type: 'user', message: { role: 'user', content }, ...extra };
}

function claudeToolUse(
  id: string,
  name: string,
  input: unknown,
): { type: string; message: { content: unknown[] } } {
  return {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name, input }] },
  };
}

function claudeToolResult(
  id: string,
  content: unknown,
  isError = false,
  toolUseResult?: unknown,
): unknown {
  return {
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
    },
    ...(toolUseResult === undefined ? {} : { toolUseResult }),
  };
}

function emptyDigest(overrides: Partial<HandoffDigest> = {}): HandoffDigest {
  return {
    compactSummary: undefined,
    compactSummaryUnreadable: false,
    userMessages: [],
    failedTools: [],
    runningJobs: [],
    editedFiles: [],
    ...overrides,
  };
}

describe('clipMiddle', () => {
  it('上限以内ならそのまま返す', () => {
    expect(clipMiddle('abcdef', 6)).toBe('abcdef');
  });

  it('上限を超えたら先頭と末尾を残し、省略した字数を書く', () => {
    const text = `${'a'.repeat(10)}${'b'.repeat(10)}`;
    const clipped = clipMiddle(text, 8);
    expect(clipped).toBe(`aaaa\n…（12文字省略）…\nbbbb`);
  });
});

describe('createHandoffDigestBuilder', () => {
  it('providerで実装を切り替える', () => {
    const claude = createHandoffDigestBuilder('claude');
    claude.push(j(claudeUser('こんにちは')));
    expect(claude.result()?.userMessages).toEqual(['こんにちは']);

    const codex = createHandoffDigestBuilder('codex');
    // Claude形式の行はCodexでは認識されない
    codex.push(j(claudeUser('こんにちは')));
    expect(codex.result()).toBeUndefined();
  });
});

describe('createClaudeDigestBuilder', () => {
  it('期待した形の行が無ければ result は undefined', () => {
    const b = createClaudeDigestBuilder();
    feed(b, '', '   ', 'not json', '[1,2]', '"str"', { type: 'summary' });
    expect(b.result()).toBeUndefined();
  });

  it('sidechainの行は無視する', () => {
    const b = createClaudeDigestBuilder();
    feed(b, claudeUser('サブ', { isSidechain: true }));
    expect(b.result()).toBeUndefined();
  });

  it('ユーザー発話を会話順に集め、空白を畳み、末尾10件に絞る', () => {
    const b = createClaudeDigestBuilder();
    for (let i = 1; i <= 12; i++) {
      feed(b, claudeUser(`  発話  ${i}\n続き`));
    }
    const digest = b.result();
    expect(digest?.userMessages).toHaveLength(10);
    expect(digest?.userMessages[0]).toBe('発話 3 続き');
    expect(digest?.userMessages[9]).toBe('発話 12 続き');
  });

  it('textパーツの配列からも本文を取り、textを持たない要素は飛ばす', () => {
    const b = createClaudeDigestBuilder();
    feed(b, claudeUser([{ type: 'text', text: '前半' }, 'x', { type: 'image' }, { text: '後半' }]));
    expect(b.result()?.userMessages).toEqual(['前半後半']);
  });

  it('contentが文字列でも配列でもなければ空発話として捨てる', () => {
    const b = createClaudeDigestBuilder();
    feed(b, claudeUser(42), { type: 'user', message: 'oops' }, { type: 'user' });
    expect(b.result()?.userMessages).toEqual([]);
  });

  it('1000文字を超える発話は切って省略記号を付ける', () => {
    const b = createClaudeDigestBuilder();
    feed(b, claudeUser('あ'.repeat(1500)));
    const msg = b.result()?.userMessages[0] ?? '';
    expect(msg).toBe(`${'あ'.repeat(1000)}…`);
  });

  it('差し込み行・isMeta・toolUseResult付きはユーザー発話にしない', () => {
    const b = createClaudeDigestBuilder();
    feed(
      b,
      claudeUser('<system-reminder>x</system-reminder>'),
      claudeUser('<command-name>/foo</command-name>'),
      claudeUser('<local-command-stdout>x'),
      claudeUser('メタ', { isMeta: true }),
      claudeUser('結果つき', { toolUseResult: { a: 1 } }),
      claudeUser('本物'),
    );
    expect(b.result()?.userMessages).toEqual(['本物']);
  });

  it('オーケストレータの進行通知は人の発話だけ残す', () => {
    const b = createClaudeDigestBuilder();
    const header = '次の <task-run-event> は進行通知です。';
    feed(
      b,
      claudeUser(
        `${header}\n<task-run-event>a</task-run-event>\n<workflow-event>b</workflow-event>\n人の発話`,
      ),
      // 閉じタグが無ければ全部通知扱いで捨てる
      claudeUser(`${header}\n<task-run-event>a`),
      // 役割説明は人の発話を含まない
      claudeUser('あなたはオーケストレータモードの実行（run: abc）です'),
      claudeUser('次の文は通知ではない'),
    );
    expect(b.result()?.userMessages).toEqual(['人の発話', '次の文は通知ではない']);
  });

  it('assistantのtool_useから編集ファイルを集める', () => {
    const b = createClaudeDigestBuilder();
    feed(
      b,
      claudeToolUse('t1', 'Edit', { file_path: '/a.ts' }),
      claudeToolUse('t2', 'Write', { file_path: '/b.ts' }),
      claudeToolUse('t3', 'MultiEdit', { file_path: '/a.ts' }),
      claudeToolUse('t4', 'NotebookEdit', { notebook_path: '/n.ipynb' }),
      claudeToolUse('t5', 'Edit', { file_path: '' }),
      claudeToolUse('t6', 'Edit', {}),
      claudeToolUse('t7', 'Edit', 'string input'),
      claudeToolUse('t8', 'Read', { file_path: '/ignored.ts' }),
    );
    expect(b.result()?.editedFiles).toEqual(['/a.ts', '/b.ts', '/n.ipynb']);
  });

  it('assistantのcontentが配列でない・tool_use以外の要素は無視する', () => {
    const b = createClaudeDigestBuilder();
    feed(
      b,
      { type: 'assistant', message: { content: 'text' } },
      { type: 'assistant' },
      { type: 'assistant', message: { content: ['x', { type: 'text', text: 'hi' }] } },
      // idも名前も無いtool_useはラベルだけ作って何も記録しない
      { type: 'assistant', message: { content: [{ type: 'tool_use', input: {} }] } },
    );
    const digest = b.result();
    expect(digest).toBeDefined();
    expect(digest?.editedFiles).toEqual([]);
    expect(digest?.runningJobs).toEqual([]);
  });

  it('run_in_backgroundのtool_useを走行中ジョブにし、task-notificationで外す', () => {
    const b = createClaudeDigestBuilder();
    feed(
      b,
      claudeToolUse('bg1', 'Bash', { command: 'npm run dev', run_in_background: true }),
      claudeToolUse('bg2', 'Bash', { command: 'sleep 99', run_in_background: true }),
      claudeToolUse('fg', 'Bash', { command: 'ls', run_in_background: false }),
    );
    expect(b.result()?.runningJobs).toEqual(['Bash: npm run dev', 'Bash: sleep 99']);

    feed(
      b,
      claudeUser('<task-notification>\n<tool-use-id> bg1 </tool-use-id>\n</task-notification>'),
    );
    const digest = b.result();
    expect(digest?.runningJobs).toEqual(['Bash: sleep 99']);
    // 通知はユーザー発話に入らない
    expect(digest?.userMessages).toEqual([]);
  });

  it('tool-use-idの無いtask-notificationは何も外さず、発話にもしない', () => {
    const b = createClaudeDigestBuilder();
    feed(
      b,
      claudeToolUse('bg1', 'Bash', { command: 'x', run_in_background: true }),
      claudeUser('<task-notification>done</task-notification>'),
    );
    const digest = b.result();
    expect(digest?.runningJobs).toEqual(['Bash: x']);
    expect(digest?.userMessages).toEqual([]);
  });

  it('toolUseResultのbackgroundTaskIdとasync_launchedを走行中ジョブにする', () => {
    const b = createClaudeDigestBuilder();
    feed(
      b,
      claudeToolUse('a1', 'Bash', { command: 'long' }),
      claudeToolResult('a1', 'started', false, { backgroundTaskId: 'task-1' }),
      claudeToolUse('a2', 'Agent', { description: 'サブ調査' }),
      claudeToolResult('a2', 'launched', false, { status: 'async_launched' }),
      claudeToolUse('a3', 'Bash', { command: 'quick' }),
      claudeToolResult('a3', 'ok', false, { status: 'completed' }),
    );
    expect(b.result()?.runningJobs).toEqual(['Bash: long', 'Agent: サブ調査']);
  });

  it('失敗したtool_resultをラベル付きで集め、本文が空なら（出力なし）にする', () => {
    const b = createClaudeDigestBuilder();
    feed(
      b,
      claudeToolUse('f1', 'Bash', { command: 'npm test' }),
      claudeToolResult('f1', [{ type: 'text', text: 'FAIL  a.test.ts' }], true),
      claudeToolUse('f2', 'Bash', { command: 'false' }),
      claudeToolResult('f2', '   ', true),
      // 対応するtool_useが無い失敗は 'tool'
      claudeToolResult('unknown', 'boom', true),
      // idが無い失敗も 'tool'
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', content: 'noid', is_error: true }] },
      },
      // 成功は集めない
      claudeToolResult('f1', 'fine', false),
      // tool_result以外の要素は無視
      {
        type: 'user',
        message: { content: ['x', { type: 'tool_result', tool_use_id: 'f1', content: 'ok' }] },
      },
    );
    expect(b.result()?.failedTools).toEqual([
      { tool: 'Bash: npm test', error: 'FAIL  a.test.ts' },
      { tool: 'Bash: false', error: '（出力なし）' },
      { tool: 'tool', error: 'boom' },
      { tool: 'tool', error: 'noid' },
    ]);
  });

  it('長いエラーは先頭と末尾を残して切り、失敗は末尾10件に絞る', () => {
    const b = createClaudeDigestBuilder();
    feed(b, claudeToolResult('x', `${'a'.repeat(1000)}${'z'.repeat(1000)}`, true));
    const first = b.result()?.failedTools[0]?.error ?? '';
    expect(first).toContain('文字省略');
    expect(first.startsWith('a'.repeat(750))).toBe(true);
    expect(first.endsWith('z'.repeat(750))).toBe(true);

    for (let i = 0; i < 12; i++) {
      feed(b, claudeToolResult(`id${i}`, `err${i}`, true));
    }
    const failures = b.result()?.failedTools ?? [];
    expect(failures).toHaveLength(10);
    expect(failures[0]?.error).toBe('err2');
    expect(failures[9]?.error).toBe('err11');
  });

  it('ツールラベルは最初に文字列の入力キーを使い、長ければ切る', () => {
    const b = createClaudeDigestBuilder();
    feed(
      b,
      claudeToolUse('l1', 'Grep', { pattern: 'foo', other: 1 }),
      claudeToolResult('l1', 'e1', true),
      claudeToolUse('l2', 'WebFetch', { url: 'https://example.com', command: '' }),
      claudeToolResult('l2', 'e2', true),
      claudeToolUse('l3', 'Skill', { skill: 'handoff' }),
      claudeToolResult('l3', 'e3', true),
      claudeToolUse('l4', 'Foo', { unrelated: 'x' }),
      claudeToolResult('l4', 'e4', true),
      claudeToolUse('l5', 'Bash', { command: `echo ${'x'.repeat(300)}` }),
      claudeToolResult('l5', 'e5', true),
      // nameが無いtool_useは 'tool'
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'l6', input: { command: 'c' } }] },
      },
      claudeToolResult('l6', 'e6', true),
    );
    const tools = b.result()?.failedTools.map((f) => f.tool) ?? [];
    expect(tools[0]).toBe('Grep: foo');
    expect(tools[1]).toBe('WebFetch: https://example.com');
    expect(tools[2]).toBe('Skill: handoff');
    expect(tools[3]).toBe('Foo');
    expect(tools[4]).toBe(`Bash: ${`echo ${'x'.repeat(300)}`.slice(0, 200)}…`);
    expect(tools[5]).toBe('tool: c');
  });

  it('queued_commandのattachmentから発話と完了通知を拾う', () => {
    const b = createClaudeDigestBuilder();
    feed(
      b,
      claudeToolUse('bg', 'Bash', { command: 'serve', run_in_background: true }),
      {
        type: 'attachment',
        attachment: { type: 'queued_command', commandMode: 'prompt', prompt: '  途中の発話' },
      },
      {
        type: 'attachment',
        attachment: {
          type: 'queued_command',
          commandMode: 'prompt',
          prompt: '<task-notification><tool-use-id>bg</tool-use-id></task-notification>',
        },
      },
      {
        type: 'attachment',
        attachment: { type: 'queued_command', commandMode: 'prompt', prompt: '<system-reminder>x' },
      },
      {
        type: 'attachment',
        attachment: { type: 'queued_command', commandMode: 'bash', prompt: 'ls' },
      },
      // queued_command以外のattachmentは認識しない
      { type: 'attachment', attachment: { type: 'other' } },
    );
    const digest = b.result();
    expect(digest?.userMessages).toEqual(['途中の発話']);
    expect(digest?.runningJobs).toEqual([]);
  });

  it('prompt が配列形式でも本文を取る', () => {
    const b = createClaudeDigestBuilder();
    feed(b, {
      type: 'attachment',
      attachment: {
        type: 'queued_command',
        commandMode: 'prompt',
        prompt: [{ type: 'text', text: '配列の発話' }],
      },
    });
    expect(b.result()?.userMessages).toEqual(['配列の発話']);
  });

  it('file-history-snapshotのtrackedFileBackupsを編集ファイルへ足す', () => {
    const b = createClaudeDigestBuilder();
    feed(
      b,
      {
        type: 'file-history-snapshot',
        snapshot: { trackedFileBackups: { '/x.ts': {}, '/y.ts': {} } },
      },
      { type: 'file-history-snapshot', snapshot: {} },
      { type: 'file-history-snapshot' },
    );
    expect(b.result()?.editedFiles).toEqual(['/x.ts', '/y.ts']);
  });

  it('編集ファイルは末尾100件、走行中ジョブは末尾20件に絞る', () => {
    const b = createClaudeDigestBuilder();
    for (let i = 0; i < 105; i++) {
      feed(b, claudeToolUse(`e${i}`, 'Write', { file_path: `/f${i}.ts` }));
    }
    for (let i = 0; i < 25; i++) {
      feed(b, claudeToolUse(`j${i}`, 'Bash', { command: `job${i}`, run_in_background: true }));
    }
    const digest = b.result();
    expect(digest?.editedFiles).toHaveLength(100);
    expect(digest?.editedFiles[0]).toBe('/f5.ts');
    expect(digest?.runningJobs).toHaveLength(20);
    expect(digest?.runningJobs[0]).toBe('Bash: job5');
  });

  it('圧縮要約の行でそれまでの状態を捨てて数え直す', () => {
    const b = createClaudeDigestBuilder();
    feed(
      b,
      claudeUser('圧縮前の発話'),
      claudeToolUse('old', 'Edit', { file_path: '/old.ts' }),
      claudeToolUse('oldbg', 'Bash', { command: 'old', run_in_background: true }),
      claudeToolResult('old', 'err', true),
      claudeUser([{ type: 'text', text: '  要約本文  ' }], { isCompactSummary: true }),
      claudeUser('圧縮後の発話'),
    );
    const digest = b.result();
    expect(digest).toEqual({
      compactSummary: '要約本文',
      compactSummaryUnreadable: false,
      userMessages: ['圧縮後の発話'],
      failedTools: [],
      runningJobs: [],
      editedFiles: [],
    });
    // 圧縮前のtool_useラベルも捨てている
    feed(b, claudeToolResult('old', 'err2', true));
    expect(b.result()?.failedTools[0]?.tool).toBe('tool');
  });

  it('空の圧縮要約は undefined、長い要約は切る', () => {
    const b = createClaudeDigestBuilder();
    feed(b, claudeUser('   ', { isCompactSummary: true }));
    expect(b.result()?.compactSummary).toBeUndefined();

    feed(b, claudeUser('s'.repeat(13000), { isCompactSummary: true }));
    const summary = b.result()?.compactSummary ?? '';
    expect(summary).toContain('1000文字省略');
    expect(summary.length).toBeLessThan(12100);
  });
});

describe('createCodexDigestBuilder', () => {
  function respItem(payload: unknown): unknown {
    return { type: 'response_item', payload };
  }
  function completed(item: unknown): unknown {
    return { type: 'event_msg', payload: { type: 'item_completed', item } };
  }

  it('期待した形の行が無ければ undefined', () => {
    const b = createCodexDigestBuilder();
    feed(
      b,
      '',
      'bad',
      { type: 'response_item' },
      { type: 'response_item', payload: 'str' },
      { type: 'event_msg', payload: { type: 'other' } },
      { type: 'session_meta', payload: {} },
    );
    expect(b.result()).toBeUndefined();
  });

  it('ユーザー発話を取り、差し込み行は除く', () => {
    const b = createCodexDigestBuilder();
    feed(
      b,
      respItem({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '  やって' }],
      }),
      respItem({ type: 'message', role: 'user', content: [{ type: 'text', text: 'こちらも' }] }),
      respItem({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<environment_context>x' }],
      }),
      respItem({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '# AGENTS.md instructions for /x' }],
      }),
      respItem({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'a' }],
      }),
    );
    expect(b.result()?.userMessages).toEqual(['やって', 'こちらも']);
  });

  it('compactedのmessageが読めれば要約にする', () => {
    const b = createCodexDigestBuilder();
    feed(b, respItem({ type: 'message', role: 'user', content: 'before' }), {
      type: 'compacted',
      payload: { message: ' 要約です ' },
    });
    expect(b.result()).toMatchObject({
      compactSummary: '要約です',
      compactSummaryUnreadable: false,
      userMessages: [],
    });
  });

  it('messageが空でreplacement_historyにcompactionがあれば読めない扱い', () => {
    const b = createCodexDigestBuilder();
    feed(b, {
      type: 'compacted',
      payload: {
        message: '',
        replacement_history: [{ type: 'message' }, { type: 'compaction', encrypted_content: 'x' }],
      },
    });
    expect(b.result()).toMatchObject({
      compactSummary: undefined,
      compactSummaryUnreadable: true,
    });
  });

  it('compactionが無い圧縮は読めない扱いにしない', () => {
    const b = createCodexDigestBuilder();
    feed(
      b,
      { type: 'compacted', payload: { replacement_history: [{ type: 'message' }] } },
      { type: 'compacted', payload: { replacement_history: 'x' } },
    );
    expect(b.result()?.compactSummaryUnreadable).toBe(false);
  });

  it('出力に出たsession_idを走行中ジョブにし、同じprocess_idの完了で外す', () => {
    const b = createCodexDigestBuilder();
    feed(
      b,
      respItem({
        type: 'function_call',
        call_id: 'c1',
        name: 'exec_command',
        arguments: '{"cmd":"npm run dev"}',
      }),
      respItem({
        type: 'function_call_output',
        call_id: 'c1',
        output: 'Process running with session ID 1\n{"session_id": 44982}',
      }),
      // 重複した出力は二重登録しない
      respItem({
        type: 'function_call_output',
        call_id: 'c1',
        output: '{"session_id":44982}',
      }),
      respItem({
        type: 'custom_tool_call',
        call_id: 'c2',
        name: 'exec',
        input: 'await tools.exec_command({cmd:"sleep 100"})',
      }),
      respItem({
        type: 'custom_tool_call_output',
        call_id: 'c2',
        output: [{ type: 'text', text: '{"session_id":7}' }],
      }),
    );
    expect(b.result()?.runningJobs).toEqual([
      'exec_command: {"cmd":"npm run dev"}',
      'exec: sleep 100',
    ]);

    feed(
      b,
      completed({ type: 'CommandExecution', process_id: 44982, status: 'completed' }),
      completed({ type: 'CommandExecution', process_id: '7', status: 'completed' }),
    );
    expect(b.result()?.runningJobs).toEqual([]);

    // 完了済みのプロセスは後から出力が届いても走行中へ戻さない
    feed(
      b,
      respItem({ type: 'function_call_output', call_id: 'c1', output: '{"session_id":44982}' }),
    );
    expect(b.result()?.runningJobs).toEqual([]);
  });

  it('call_idが無い出力は exec ラベル、名前も入力も無い呼び出しは tool', () => {
    const b = createCodexDigestBuilder();
    feed(
      b,
      respItem({ type: 'function_call', call_id: 'n1' }),
      respItem({ type: 'function_call', name: 'ignored' }),
      respItem({ type: 'function_call_output', output: '{"session_id":1}' }),
      respItem({ type: 'function_call_output', call_id: 'n1', output: '{"session_id":2}' }),
      respItem({ type: 'reasoning' }),
    );
    expect(b.result()?.runningJobs).toEqual(['exec', 'tool']);
  });

  it('失敗したCommandExecutionをexit codeと出力付きで集める', () => {
    const b = createCodexDigestBuilder();
    feed(
      b,
      completed({
        type: 'CommandExecution',
        status: 'failed',
        command: ['/bin/bash', '-lc', 'npm   test'],
        exitCode: 1,
        stderr: 'boom\n',
        stdout: 'ignored',
      }),
      completed({
        type: 'CommandExecution',
        status: 'failed',
        command: 'make',
        exit_code: 2,
        stderr: '  ',
        stdout: 'from stdout',
      }),
      completed({ type: 'CommandExecution', status: 'failed', command: [] }),
      completed({ type: 'CommandExecution', status: 'failed', command: [1], exitCode: null }),
      completed({ type: 'CommandExecution', status: 'failed' }),
      completed({ type: 'CommandExecution', status: 'completed', command: 'ok' }),
    );
    expect(b.result()?.failedTools).toEqual([
      { tool: 'exec: npm test', error: 'exit 1\nboom' },
      { tool: 'exec: make', error: 'exit 2\nfrom stdout' },
      { tool: 'exec: ', error: '（出力なし）' },
      { tool: 'exec: ', error: '（出力なし）' },
      { tool: 'exec: ', error: '（出力なし）' },
    ]);
  });

  it('FileChangeから編集ファイルを集め、失敗はapply_patchとして記録する', () => {
    const b = createCodexDigestBuilder();
    feed(
      b,
      completed({ type: 'FileChange', status: 'completed', changes: { '/a.ts': {}, '/b.ts': {} } }),
      completed({
        type: 'FileChange',
        status: 'failed',
        changes: { '/c.ts': {} },
        stderr: 'patch failed',
      }),
      completed({ type: 'FileChange', status: 'failed', changes: 'bad', stdout: 'out' }),
      completed({ type: 'Other' }),
      // itemがオブジェクトでなければ数えるだけ
      { type: 'event_msg', payload: { type: 'item_completed', item: 'x' } },
    );
    const digest = b.result();
    expect(digest?.editedFiles).toEqual(['/a.ts', '/b.ts', '/c.ts']);
    expect(digest?.failedTools).toEqual([
      { tool: 'apply_patch: /c.ts', error: 'patch failed' },
      { tool: 'apply_patch: ', error: 'out' },
    ]);
  });

  it('圧縮でCodexの状態も作り直す', () => {
    const b = createCodexDigestBuilder();
    feed(
      b,
      respItem({ type: 'function_call', call_id: 'c', name: 'exec', input: 'x' }),
      respItem({ type: 'function_call_output', call_id: 'c', output: '{"session_id":9}' }),
      completed({ type: 'FileChange', changes: { '/a': {} } }),
      { type: 'compacted', payload: { message: 's' } },
    );
    expect(b.result()).toMatchObject({ runningJobs: [], editedFiles: [], compactSummary: 's' });
  });
});

describe('renderHandoffDigest', () => {
  it('空のdigestは各節を「無し」で埋める', () => {
    const text = renderHandoffDigest(emptyDigest()).join('\n');
    expect(text).toContain('## 会話の要点（transcriptから機械抽出）');
    expect(text).toContain('### 最後の自動圧縮の要約\n\n無し');
    expect(text).toContain('### ユーザー発話（末尾10件まで）\n\n無し');
    expect(text).toContain('### 終わっていないbackgroundジョブ\n\n無し');
    expect(text).toContain(
      '### 編集したファイル\n\n無し（シェルで書き換えたファイルは記録されない',
    );
    expect(text).toContain('### 失敗したツール呼び出し（末尾10件まで）\n\n無し');
  });

  it('暗号化された要約は読めない旨を書く', () => {
    const text = renderHandoffDigest(emptyDigest({ compactSummaryUnreadable: true })).join('\n');
    expect(text).toContain('暗号化された形でしか残っておらず読めない');
    expect(text).not.toContain('### 最後の自動圧縮の要約\n\n無し');
  });

  it('要約はバッククォートより長いフェンスで囲む', () => {
    const lines = renderHandoffDigest(emptyDigest({ compactSummary: 'a ```` b\n# 見出し' }));
    const text = lines.join('\n');
    expect(text).toContain('`````text\na ```` b\n# 見出し\n`````');
  });

  it('発話・ジョブ・ファイル・失敗を箇条書きにし、1行化して長さを制限する', () => {
    const text = renderHandoffDigest(
      emptyDigest({
        userMessages: ['依頼A', '依頼B'],
        runningJobs: ['Bash: a\n## 偽見出し', `Bash: ${'x'.repeat(300)}`],
        editedFiles: ['/a.ts', `/${'p'.repeat(600)}`],
        failedTools: [{ tool: 'Bash: npm\ntest', error: 'エラー\n- 偽箇条書き' }],
      }),
    ).join('\n');
    expect(text).toContain('- 依頼A\n- 依頼B');
    expect(text).toContain('- Bash: a ## 偽見出し');
    expect(text).toContain(`- Bash: ${'x'.repeat(194)}…`);
    expect(text).toContain('開始の記録はあるが、終わった記録がtranscriptに無いもの');
    expect(text).toContain('- /a.ts');
    expect(text).toContain(`- /${'p'.repeat(499)}…`);
    expect(text).toContain('- Bash: npm test\n\n```text\nエラー\n- 偽箇条書き\n```\n');
    expect(text).not.toContain('\n## 偽見出し');
  });

  it('上限を超えたら行の境目で切って書き添える', () => {
    const failedTools = Array.from({ length: 10 }, (_, i) => ({
      tool: `tool${i}`,
      error: `${i}`.repeat(1500),
    }));
    const lines = renderHandoffDigest(
      emptyDigest({
        compactSummary: 's'.repeat(12000),
        userMessages: Array.from({ length: 10 }, () => 'あ'.repeat(1000)),
        failedTools,
      }),
    );
    const text = lines.join('\n');
    expect(text.length).toBeLessThanOrEqual(HANDOFF_DIGEST_LIMIT);
    expect(text).toContain(`上限${HANDOFF_DIGEST_LIMIT}文字を超えたためここで切った`);
    // 切り口でフェンスが開いたまま残らない
    expect(text.match(/```text/gu)?.length).toBe(text.match(/\n```\n/gu)?.length);
  });

  it('上限に収まるなら切らない', () => {
    const text = renderHandoffDigest(emptyDigest({ userMessages: ['x'] })).join('\n');
    expect(text).not.toContain('上限');
  });
});

describe('readHandoffDigest', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'handoff-digest-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('Claudeのtranscriptを1行ずつ読んで要点を返す', async () => {
    const file = join(dir, 'claude.jsonl');
    const lines = [
      j(claudeUser('依頼です')),
      j(claudeToolUse('t1', 'Edit', { file_path: '/a.ts' })),
      'broken line',
      j(claudeToolResult('t1', 'bad', true)),
    ];
    await writeFile(file, `${lines.join('\r\n')}\n`, 'utf8');
    const digest = await readHandoffDigest('claude', file);
    expect(digest).toEqual({
      compactSummary: undefined,
      compactSummaryUnreadable: false,
      userMessages: ['依頼です'],
      failedTools: [{ tool: 'Edit: /a.ts', error: 'bad' }],
      runningJobs: [],
      editedFiles: ['/a.ts'],
    });
  });

  it('Codexのrolloutも読める', async () => {
    const file = join(dir, 'codex.jsonl');
    await writeFile(
      file,
      `${j({ type: 'response_item', payload: { type: 'message', role: 'user', content: 'こんにちは' } })}\n`,
      'utf8',
    );
    const digest = await readHandoffDigest('codex', file);
    expect(digest?.userMessages).toEqual(['こんにちは']);
  });

  it('存在しないファイルは undefined（例外を投げない）', async () => {
    await expect(readHandoffDigest('claude', join(dir, 'missing.jsonl'))).resolves.toBeUndefined();
  });

  it('認識できる行が無い・要点が空のときは undefined', async () => {
    const unknown = join(dir, 'unknown.jsonl');
    await writeFile(unknown, `${j({ type: 'summary' })}\n`, 'utf8');
    await expect(readHandoffDigest('claude', unknown)).resolves.toBeUndefined();

    // 認識はできるが要点が1つも無い（assistantの発話だけ）
    const empty = join(dir, 'empty.jsonl');
    await writeFile(empty, `${j({ type: 'assistant', message: { content: [] } })}\n`, 'utf8');
    await expect(readHandoffDigest('claude', empty)).resolves.toBeUndefined();
  });

  it('途中の読み込み失敗ではそこまでの分を返す', async () => {
    // ディレクトリを読むとストリームがEISDIRで失敗する。何も集まらないので undefined
    await expect(readHandoffDigest('claude', dir)).resolves.toBeUndefined();
  });
});
