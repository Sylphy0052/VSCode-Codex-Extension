import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildClaudeTrialArgs,
  buildCodexTrialArgs,
  parseClaudeTrialOutput,
  runTrialProcess,
  runTrialStage,
  trialEnvironment,
} from '../../src/orchestrator/optimizeTrialSession';

function settingsOf(args: string[]): Record<string, unknown> {
  const i = args.indexOf('--settings');
  return JSON.parse(args[i + 1] ?? '{}') as Record<string, unknown>;
}

describe('buildClaudeTrialArgs', () => {
  const base = { model: 'sonnet', sandbox: { weakerNested: false } };

  it('仮説の段は書き込み系のツールを持たせない', () => {
    const args = buildClaudeTrialArgs({ ...base, stage: 'hypothesis' });
    const tools = args[args.indexOf('--tools') + 1];
    expect(tools).toBe('Read,Glob,Grep');
    expect(args).not.toContain('--settings');
    expect(args).not.toContain('acceptEdits');
  });

  it('変更の段はsandboxを有効にし、sandbox外のコマンドとネットワークを許さない', () => {
    const args = buildClaudeTrialArgs({ ...base, stage: 'change' });
    const sandbox = settingsOf(args)['sandbox'] as Record<string, unknown>;
    expect(sandbox['enabled']).toBe(true);
    expect(sandbox['excludedCommands']).toEqual([]);
    expect(sandbox['allowUnsandboxedCommands']).toBe(false);
    expect(sandbox['failIfUnavailable']).toBe(true);
    expect(sandbox['network']).toEqual({ strictAllowlist: true, allowedDomains: [] });
  });

  it('denyWriteを渡したときだけ、sandboxの書き込み禁止に入る', () => {
    const none = settingsOf(buildClaudeTrialArgs({ ...base, stage: 'change' }));
    expect((none['sandbox'] as Record<string, unknown>)['filesystem']).toBeUndefined();
    const args = buildClaudeTrialArgs({ ...base, stage: 'change', denyWrite: ['/repo/.git'] });
    const sandbox = settingsOf(args)['sandbox'] as Record<string, unknown>;
    expect(sandbox['filesystem']).toEqual({ denyWrite: ['/repo/.git'] });
  });

  it('git・gh・glabのBashを拒否し、--disallowedToolsは最後に置く', () => {
    const args = buildClaudeTrialArgs({ ...base, stage: 'change' });
    const flag = args.indexOf('--disallowedTools');
    expect(flag).toBe(args.length - 2);
    const denied = args[flag + 1] ?? '';
    for (const tool of ['Bash(git *)', 'Bash(gh *)', 'Bash(glab *)']) {
      expect(denied).toContain(tool);
    }
  });

  it('続けるときだけ--resumeを付ける', () => {
    expect(buildClaudeTrialArgs({ ...base, stage: 'change' })).not.toContain('--resume');
    const args = buildClaudeTrialArgs({ ...base, stage: 'change', resumeSessionId: 'abc' });
    expect(args[args.indexOf('--resume') + 1]).toBe('abc');
  });

  it('利用者の設定を読ませない', () => {
    const args = buildClaudeTrialArgs({ ...base, stage: 'change' });
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
  });
});

describe('buildCodexTrialArgs', () => {
  const base = { model: 'auto', outputFile: '/tmp/out.txt' };

  it('仮説の段はread-only、変更の段はworkspace-write', () => {
    const one = buildCodexTrialArgs({ ...base, stage: 'hypothesis' });
    const two = buildCodexTrialArgs({ ...base, stage: 'change' });
    expect(one[one.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(two[two.indexOf('--sandbox') + 1]).toBe('workspace-write');
  });

  it('ネットワークを無効にし、シェル以外の外部到達の能力を落とす', () => {
    const args = buildCodexTrialArgs({ ...base, stage: 'change' });
    expect(args).toContain('sandbox_workspace_write.network_access=false');
    expect(args).toContain('tools.web_search=false');
    expect(args).toContain('browser_use');
    expect(args).toContain('apps');
    expect(args).not.toContain('shell_tool');
  });
});

describe('parseClaudeTrialOutput', () => {
  it('結果とセッションIDを取る', () => {
    expect(
      parseClaudeTrialOutput(JSON.stringify({ result: 'ok', session_id: 's1', is_error: false })),
    ).toEqual({ text: 'ok', sessionId: 's1', isError: false });
  });

  it('JSONでなければエラーとして扱う', () => {
    expect(parseClaudeTrialOutput('boom').isError).toBe(true);
  });
});

describe('runTrialProcess', () => {
  let dir: string;
  let recordDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'optimize-session-test-'));
    recordDir = join(dir, 'records');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const base = () => ({
    executable: process.execPath,
    stdin: '',
    cwd: dir,
    timeoutMs: 10_000,
    recordDir,
    label: 'test',
  });

  it('起動中はPIDが記録に残り、終わって残りが無ければ記録を消す', async () => {
    const script = `
      const fs = require('fs');
      setTimeout(() => {
        console.log(JSON.stringify({ records: fs.readdirSync(${JSON.stringify(recordDir)}), pid: process.pid }));
      }, 300);
    `;
    const result = await runTrialProcess({ ...base(), args: ['-e', script] });
    const out = JSON.parse(result.stdout.trim()) as { records: string[]; pid: number };
    expect(out.records).toEqual([`process-${out.pid}.json`]);
    expect(result.pid).toBe(out.pid);
    expect(result.groupRemains).toBe(false);
    expect(await readdir(recordDir)).toEqual([]);
  });

  it('先頭が終わっても残った孫のプロセスをグループごと止める', async () => {
    const script = `
      const { spawn } = require('child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      child.unref();
      console.log(child.pid);
    `;
    const result = await runTrialProcess({ ...base(), args: ['-e', script] });
    const grandchild = Number(result.stdout.trim());
    expect(Number.isInteger(grandchild)).toBe(true);
    expect(alive(grandchild)).toBe(false);
    expect(result.groupRemains).toBe(false);
  });

  it('時間の上限を超えたら止める', async () => {
    const result = await runTrialProcess({
      ...base(),
      timeoutMs: 300,
      args: ['-e', 'setInterval(() => {}, 1000)'],
    });
    expect(result.timedOut).toBe(true);
    expect(result.groupRemains).toBe(false);
    expect(result.pid !== undefined && alive(result.pid)).toBe(false);
  });

  it('グループが残ったままなら、そう報告して記録を消さない', async () => {
    const result = await runTrialProcess({
      ...base(),
      args: ['-e', 'console.log(1)'],
      groupPorts: {
        killGroup: () => undefined,
        isGroupAlive: () => true,
        sleep: () => Promise.resolve(),
      },
    });
    expect(result.groupRemains).toBe(true);
    expect(await readdir(recordDir)).toHaveLength(1);
  });

  it('起動できなければ、記録を作らずに失敗を返す', async () => {
    const result = await runTrialProcess({
      ...base(),
      executable: join(dir, 'no-such-command'),
      args: [],
    });
    expect(result.pid).toBeUndefined();
    expect(result.error).toBeDefined();
  });
});

describe('runTrialStage', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'optimize-stage-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function fakeCli(body: string): Promise<string> {
    const file = join(dir, 'fake-cli.js');
    await writeFile(file, `#!${process.execPath}\n${body}`);
    await chmod(file, 0o755);
    return file;
  }

  it('Claude: 引数を渡し、応答の本文とセッションIDを返す', async () => {
    const argvFile = join(dir, 'argv.json');
    const executable = await fakeCli(`
      require('fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
      console.log(JSON.stringify({ result: 'done', session_id: 'sess-9' }));
    `);
    const result = await runTrialStage({
      stage: 'change',
      prompt: 'p',
      cwd: dir,
      engine: {
        engine: 'claude',
        executable,
        model: 'auto',
        claudeSandbox: { weakerNested: false },
      },
      resumeSessionId: 'sess-1',
      timeoutMs: 10_000,
      recordDir: join(dir, 'records'),
    });
    expect(result).toMatchObject({ ok: true, text: 'done', sessionId: 'sess-9' });
    const argv = JSON.parse(await readFile(argvFile, 'utf8')) as string[];
    expect(argv[argv.indexOf('--resume') + 1]).toBe('sess-1');
  });

  it('Codex: -oのファイルから最終メッセージを読む', async () => {
    const executable = await fakeCli(`
      const args = process.argv.slice(2);
      require('fs').writeFileSync(args[args.indexOf('-o') + 1], 'codexの応答');
    `);
    const result = await runTrialStage({
      stage: 'hypothesis',
      prompt: 'p',
      cwd: dir,
      engine: { engine: 'codex', executable, model: 'auto' },
      timeoutMs: 10_000,
      recordDir: join(dir, 'records'),
    });
    expect(result).toMatchObject({ ok: true, text: 'codexの応答' });
    expect(result.sessionId).toBeUndefined();
  });

  it('exit codeが0でなければ失敗にする', async () => {
    const executable = await fakeCli('process.exit(3);');
    const result = await runTrialStage({
      stage: 'hypothesis',
      prompt: 'p',
      cwd: dir,
      engine: { engine: 'codex', executable, model: 'auto' },
      timeoutMs: 10_000,
      recordDir: join(dir, 'records'),
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toContain('exit code 3');
  });

  it('Claudeはsandboxの確認結果が無ければ起動しない', async () => {
    await expect(
      runTrialStage({
        stage: 'change',
        prompt: 'p',
        cwd: dir,
        engine: { engine: 'claude', executable: 'claude', model: 'auto' },
        timeoutMs: 1000,
        recordDir: join(dir, 'records'),
      }),
    ).rejects.toThrow('sandbox');
  });
});

describe('trialEnvironment', () => {
  it('秘密らしい環境変数を外し、CLIの認証と普通の変数は残す', () => {
    const kept = trialEnvironment({
      PATH: '/bin',
      GH_TOKEN: 'x',
      GITLAB_TOKEN: 'x',
      DB_PASSWORD: 'x',
      CLAUDE_CODE_OAUTH_TOKEN: 'keep',
      ANTHROPIC_API_KEY: 'keep',
      CODEX_HOME: '/h',
    });
    expect(Object.keys(kept).sort()).toEqual([
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CODEX_HOME',
      'PATH',
    ]);
  });
});
