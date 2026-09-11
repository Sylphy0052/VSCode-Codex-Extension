import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fillTranscriptPath, handoffExtractCommands } from '../../src/view/handoff';

/**
 * ポインタファイルへ埋め込む `jq` 式を、実物と同じ形のJSONLに対して実行して確かめる
 * （Issue #1079）。
 *
 * **陽性対照を必ず置く**。この種の式は書き間違えると例外で全件0件になり、「除外条件が
 * 効いて何も残らなかった」という正常な結果と見分けが付かない。実際、Codex側の式は
 * 最初に書いたとき `... | gsub(...) as $s | ...` の形で入力が文字列に変わり、後続の
 * `.timestamp` が `Cannot index string with string "timestamp"` で落ちて全件0件になって
 * いた。「0件だった」だけを見ていると気付けないため、必ず「出るはずのものが出ている」
 * ことと「出てはいけないものが出ていない」ことの両方を見る。
 */

const exec = promisify(execFile);

/** 抽出コマンドはPOSIXシェル経由で実行する（パイプと引用符をそのまま使うため）。 */
async function runCommand(command: string): Promise<string> {
  const { stdout } = await exec('bash', ['-c', command], { maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

/** 見出しからコマンドを引く。見出しが変わったらテストも落ちるようにする。 */
function commandFor(provider: 'claude' | 'codex', title: string, transcriptPath: string): string {
  const entry = handoffExtractCommands(provider).find((c) => c.title === title);
  if (entry === undefined) {
    throw new Error(`抽出コマンドが見つかりません: ${provider} / ${title}`);
  }
  return fillTranscriptPath(entry.command, transcriptPath);
}

function toJsonl(rows: readonly unknown[]): string {
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'handoff-extract-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('Claude Codeのtranscriptからの抽出', () => {
  /**
   * 実測した `type` の混ざり方を再現する。人間の発言は2件だけで、残りは全て
   * 除外されなければならない行。
   */
  const rows = [
    // 陽性対照1: 素の発言（content は配列）
    {
      type: 'user',
      timestamp: '2026-09-11T01:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: '実装を始めて' }] },
    },
    // 陰性対照: ツール結果の戻り
    {
      type: 'user',
      timestamp: '2026-09-11T01:00:01.000Z',
      toolUseResult: { stdout: 'TOOL_RESULT_LEAK' },
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: 'TOOL_RESULT_LEAK' }],
      },
    },
    // 陰性対照: システム注入（isMeta）
    {
      type: 'user',
      timestamp: '2026-09-11T01:00:02.000Z',
      isMeta: true,
      message: { role: 'user', content: [{ type: 'text', text: 'META_LEAK' }] },
    },
    // 陰性対照: isMeta が付かない注入
    {
      type: 'user',
      timestamp: '2026-09-11T01:00:03.000Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '<task-notification>TASK_LEAK</task-notification>' }],
      },
    },
    // 陰性対照: サブエージェント側の発言
    {
      type: 'user',
      timestamp: '2026-09-11T01:00:04.000Z',
      isSidechain: true,
      message: { role: 'user', content: [{ type: 'text', text: 'SIDECHAIN_LEAK' }] },
    },
    // 陽性対照2: content が文字列の発言。先頭の空白を落とせているかも見る
    {
      type: 'user',
      timestamp: '2026-09-11T01:00:05.000Z',
      message: { role: 'user', content: '  次はテストを書いて' },
    },
    // 陰性対照（ユーザー指示としては）: 自動圧縮の要約。専用の式では陽性対照になる
    {
      type: 'user',
      timestamp: '2026-09-11T01:00:06.000Z',
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
      message: { role: 'user', content: 'COMPACT_SUMMARY_BODY' },
    },
    {
      type: 'assistant',
      timestamp: '2026-09-11T01:00:07.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'THINKING_LEAK' },
          { type: 'text', text: 'ASSISTANT_TEXT' },
          { type: 'tool_use', name: 'Bash', input: { command: 'TOOL_USE_LEAK' } },
        ],
      },
    },
    {
      type: 'file-history-snapshot',
      timestamp: '2026-09-11T01:00:08.000Z',
      snapshot: {
        trackedFileBackups: {
          '/repo/src/a.ts': { backupId: '1' },
          '/repo/src/b.ts': { backupId: '2' },
        },
      },
    },
  ];

  let transcript: string;

  beforeAll(async () => {
    transcript = join(dir, 'claude.jsonl');
    await writeFile(transcript, toJsonl(rows), 'utf8');
  });

  it('ユーザー指示は人間の発言だけを拾う', async () => {
    const stdout = await runCommand(commandFor('claude', 'ユーザー指示（末尾20件）', transcript));
    const lines = stdout.trimEnd().split('\n');

    // 陽性対照。ここが空なら式が壊れている（「除外しすぎた」ではなく「動いていない」）
    expect(lines).toEqual([
      '[2026-09-11T01:00:00.000Z] 実装を始めて',
      '[2026-09-11T01:00:05.000Z] 次はテストを書いて',
    ]);

    // 陰性対照
    for (const leak of [
      'TOOL_RESULT_LEAK',
      'META_LEAK',
      'TASK_LEAK',
      'SIDECHAIN_LEAK',
      'COMPACT_SUMMARY_BODY',
    ]) {
      expect(stdout).not.toContain(leak);
    }
  });

  it('ユーザー指示は1件を1行へ畳み、300字で切る', async () => {
    const long = 'あ'.repeat(400);
    const path = join(dir, 'claude-long.jsonl');
    await writeFile(
      path,
      toJsonl([
        {
          type: 'user',
          timestamp: '2026-09-11T02:00:00.000Z',
          message: { role: 'user', content: [{ type: 'text', text: `前半\n\n後半${long}` }] },
        },
      ]),
      'utf8',
    );

    const stdout = await runCommand(commandFor('claude', 'ユーザー指示（末尾20件）', path));
    const lines = stdout.trimEnd().split('\n');

    expect(lines).toHaveLength(1);
    // 改行が畳まれて1行になっている
    expect(lines[0]).toContain('前半 後半');

    // 300字で切ってから空白を畳むため、本文は300字ちょうどではなく「300字以下」になる。
    // 長さそのものではなく「元の400字が丸ごと入っていない」ことを見る
    const body = lines[0]!.slice('[2026-09-11T02:00:00.000Z] '.length);
    expect(body.length).toBeGreaterThan(290);
    expect(body.length).toBeLessThanOrEqual(300);
    expect(body).not.toContain(long);
  });

  it('自動圧縮の要約を取り出す', async () => {
    const stdout = await runCommand(
      commandFor('claude', '自動圧縮の要約（あれば最初にこれを読む）', transcript),
    );
    expect(stdout.trim()).toBe('COMPACT_SUMMARY_BODY');
  });

  it('自動圧縮が無いセッションでは要約の式が空を返す', async () => {
    const path = join(dir, 'claude-no-compact.jsonl');
    await writeFile(path, toJsonl([rows[0]]), 'utf8');

    const stdout = await runCommand(
      commandFor('claude', '自動圧縮の要約（あれば最初にこれを読む）', path),
    );
    expect(stdout.trim()).toBe('');
  });

  it('アシスタント応答は text だけを拾い、thinking と tool_use を落とす', async () => {
    const stdout = await runCommand(
      commandFor('claude', '直前のアシスタント応答（末尾3件）', transcript),
    );
    expect(stdout.trim()).toBe('ASSISTANT_TEXT');
    expect(stdout).not.toContain('THINKING_LEAK');
    expect(stdout).not.toContain('TOOL_USE_LEAK');
  });

  it('編集したファイルは file-history-snapshot から取る', async () => {
    const stdout = await runCommand(commandFor('claude', '編集したファイル', transcript));
    expect(stdout.trimEnd().split('\n')).toEqual(['/repo/src/a.ts', '/repo/src/b.ts']);
  });
});

describe('Codexのrolloutからの抽出', () => {
  const rows = [
    {
      timestamp: '2026-09-11T03:00:00.000Z',
      ordinal: 1,
      type: 'session_meta',
      payload: { id: 'thread-1', cwd: '/repo', originator: 'vscode', context_window: 272000 },
    },
    // 陰性対照: environment_context の注入
    {
      timestamp: '2026-09-11T03:00:01.000Z',
      ordinal: 2,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '<environment_context>ENV_LEAK</environment_context>' },
        ],
      },
    },
    // 陰性対照: AGENTS.md の注入
    {
      timestamp: '2026-09-11T03:00:02.000Z',
      ordinal: 3,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '# AGENTS.md instructions\nAGENTS_LEAK' }],
      },
    },
    // 陽性対照1
    {
      timestamp: '2026-09-11T03:00:03.000Z',
      ordinal: 4,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'バグを直して' }],
      },
    },
    // 陽性対照2: 先頭の空白を落とせているか
    {
      timestamp: '2026-09-11T03:00:04.000Z',
      ordinal: 5,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '  テストも足して' }],
      },
    },
    {
      timestamp: '2026-09-11T03:00:05.000Z',
      ordinal: 6,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'CODEX_ASSISTANT_TEXT' }],
      },
    },
    {
      timestamp: '2026-09-11T03:00:06.000Z',
      ordinal: 7,
      type: 'response_item',
      payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'REASONING_LEAK' }] },
    },
    {
      timestamp: '2026-09-11T03:00:07.000Z',
      ordinal: 8,
      type: 'turn_context',
      payload: { cwd: '/repo', model: 'gpt-5.1-codex', effort: 'high', summary: 'auto' },
    },
    {
      timestamp: '2026-09-11T03:00:08.000Z',
      ordinal: 9,
      type: 'compacted',
      payload: {
        window_number: 2,
        first_window_id: 'w0',
        previous_window_id: 'w1',
        window_id: 'w2',
      },
    },
  ];

  let rollout: string;

  beforeAll(async () => {
    rollout = join(dir, 'rollout-test.jsonl');
    await writeFile(rollout, toJsonl(rows), 'utf8');
  });

  it('ユーザー指示は人間の発言だけを拾う', async () => {
    const stdout = await runCommand(commandFor('codex', 'ユーザー指示（末尾20件）', rollout));
    const lines = stdout.trimEnd().split('\n');

    // 陽性対照。`as` の束縛で入力がオブジェクトでなくなっていると、ここで全件0件になる
    expect(lines).toEqual([
      '[2026-09-11T03:00:03.000Z] バグを直して',
      '[2026-09-11T03:00:04.000Z] テストも足して',
    ]);

    for (const leak of ['ENV_LEAK', 'AGENTS_LEAK']) {
      expect(stdout).not.toContain(leak);
    }
  });

  it('アシスタント応答は output_text を拾い、reasoning を落とす', async () => {
    const stdout = await runCommand(
      commandFor('codex', '直前のアシスタント応答（末尾2件）', rollout),
    );
    expect(stdout.trim()).toBe('CODEX_ASSISTANT_TEXT');
    expect(stdout).not.toContain('REASONING_LEAK');
  });

  it('自動圧縮が走ったかを判定できる', async () => {
    const stdout = await runCommand(commandFor('codex', '自動圧縮が走ったか', rollout));
    expect(JSON.parse(stdout.trim())).toEqual({
      window_number: 2,
      first_window_id: 'w0',
      previous_window_id: 'w1',
      window_id: 'w2',
    });
  });

  it('圧縮されていないrolloutでは空を返す', async () => {
    const path = join(dir, 'rollout-no-compact.jsonl');
    await writeFile(path, toJsonl([rows[0]]), 'utf8');

    const stdout = await runCommand(commandFor('codex', '自動圧縮が走ったか', path));
    expect(stdout.trim()).toBe('');
  });

  it('セッションのメタ情報を取り出す', async () => {
    const stdout = await runCommand(commandFor('codex', 'セッションのメタ情報', rollout));
    expect(JSON.parse(stdout.trim())).toEqual({
      cwd: '/repo',
      model: 'gpt-5.1-codex',
      effort: 'high',
      summary: 'auto',
    });
  });
});

describe('パスの埋め込み', () => {
  it('空白や引用符を含むパスでも壊れない', async () => {
    const path = join(dir, "aw kward's name.jsonl");
    await writeFile(
      path,
      toJsonl([
        {
          type: 'user',
          timestamp: '2026-09-11T04:00:00.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'QUOTED_PATH_OK' }] },
        },
      ]),
      'utf8',
    );

    const stdout = await runCommand(commandFor('claude', 'ユーザー指示（末尾20件）', path));
    expect(stdout).toContain('QUOTED_PATH_OK');
  });
});
