import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/log';
import {
  buildClaudeSandboxPrompt,
  buildClaudeSandboxSettings,
  claudeSandboxArgs,
  EXCLUDED_COMMANDS,
  normalizeExtraExcludedCommands,
  ClaudeSandboxProbe,
  nodeSandboxProbePorts,
  type ClaudeSandboxProbePorts,
  type SandboxCommandResult,
} from '../../src/claude/sandbox';
import { createFakeChildProcess, type FakeChildProcess } from '../helpers/fakeChildProcess';

const { spawnMock, execFileMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  execFileMock: vi.fn(),
}));
vi.mock('node:child_process', () => ({ spawn: spawnMock, execFile: execFileMock }));

function excludedCommands(): unknown {
  const settings = buildClaudeSandboxSettings('workspace-write', '/work', { weakerNested: false });
  return (settings['sandbox'] as Record<string, unknown>)['excludedCommands'];
}

describe('buildClaudeSandboxSettings: excludedCommands（Issue #1545）', () => {
  // mergeとリモートブランチの削除を人へ回す判定は、sandbox外の承認フロー（can_use_tool）にある。
  // ここから外したコマンドはsandbox内で承認なしに走るため、一覧を固定して外したら落とす
  it('merge・push・リモートブランチ削除を担うコマンドをsandbox外へ回す', () => {
    const list = excludedCommands();
    // `gh pr merge` / `glab mr merge` / `gh api -X DELETE .../git/refs/heads/...`
    expect(list).toContain('gh *');
    expect(list).toContain('glab *');
    // `git push origin --delete <branch>` / `git push origin :<branch>`
    expect(list).toContain('git push *');
  });

  it('一覧の内容を固定する（変えるときは承認へ回る範囲の変化を確かめてから更新する）', () => {
    expect(excludedCommands()).toEqual([
      'gh *',
      'glab *',
      'git push *',
      'git fetch *',
      'git pull *',
      'git ls-remote *',
      'git clone *',
      'curl *',
      'wget *',
      'npm install *',
      'npm ci *',
      'pip install *',
      'docker *',
      'ssh *',
      'scp *',
      'rsync *',
    ]);
  });
});

const CS_PY = 'python3 /home/u/.claude/skills/compute-server/scripts/cs.py *';

describe('extraExcludedCommands（Issue #2133）', () => {
  it('設定で足したパターンを固定の一覧の後ろへ合流させる', () => {
    const settings = buildClaudeSandboxSettings(
      'workspace-write',
      '/work',
      { weakerNested: false },
      [CS_PY],
    );
    const list = (settings['sandbox'] as Record<string, unknown>)['excludedCommands'];
    expect(list).toEqual([...EXCLUDED_COMMANDS, CS_PY]);
  });

  it('既定（空）なら固定の一覧のままで、指示文に絶対パスの案内を足さない', () => {
    expect(excludedCommands()).toEqual([...EXCLUDED_COMMANDS]);
    expect(buildClaudeSandboxPrompt()).toBe(buildClaudeSandboxPrompt([]));
    expect(buildClaudeSandboxPrompt()).not.toContain('絶対パス');
  });

  it('指示文の一覧にも載せ、絶対パスのまま単独で打つよう伝える', () => {
    const prompt = buildClaudeSandboxPrompt([CS_PY]);
    expect(prompt).toContain(
      'ssh / scp / rsync / python3 /home/u/.claude/skills/compute-server/scripts/cs.py。',
    );
    expect(prompt).toContain(
      '一覧のうち python3 /home/u/.claude/skills/compute-server/scripts/cs.py は、書かれたとおりの絶対パスのまま',
    );
  });

  it('claudeSandboxArgsは設定と指示文の両方へ同じ値を渡す', () => {
    const args = claudeSandboxArgs('workspace-write', '/work', { weakerNested: false }, [CS_PY]);
    const settings = JSON.parse(args[1] ?? '{}') as { sandbox: { excludedCommands: string[] } };
    expect(settings.sandbox.excludedCommands).toContain(CS_PY);
    expect(args[3]).toContain('cs.py');
  });

  it('壊れた要素・空・改行入り・固定の一覧との重複・重複は捨てる', () => {
    expect(
      normalizeExtraExcludedCommands([42, '', '  ', 'a\nb', 'gh *', ` ${CS_PY} `, CS_PY, null]),
    ).toEqual([CS_PY]);
    expect(normalizeExtraExcludedCommands('ssh *')).toEqual([]);
    expect(normalizeExtraExcludedCommands(undefined)).toEqual([]);
  });
});

function silentLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), show: vi.fn() };
}

interface Pending {
  signal: AbortSignal;
  resolve: (result: SandboxCommandResult) => void;
}

/** 呼ばれた確認を保留し、テストから終わらせる。 */
function pendingPorts(): { ports: ClaudeSandboxProbePorts; bwrap: Pending[]; cli: Pending[] } {
  const bwrap: Pending[] = [];
  const cli: Pending[] = [];
  const ports: ClaudeSandboxProbePorts = {
    platform: 'linux',
    inContainer: () => false,
    tryBwrap: (_withProc, signal) =>
      new Promise((resolve) => {
        bwrap.push({ signal, resolve });
      }),
    tryCli: (_settingsJson, signal) =>
      new Promise((resolve) => {
        cli.push({ signal, resolve });
      }),
    inspectReadOnlyCwd: () => Promise.resolve({ ok: true }),
  };
  return { ports, bwrap, cli };
}

describe('ClaudeSandboxProbe.dispose（Issue #1545）', () => {
  it('進行中の確認へ渡したsignalを中止する', async () => {
    const { ports, bwrap } = pendingPorts();
    const probe = new ClaudeSandboxProbe(ports, silentLogger());
    const result = probe.check();
    await vi.waitFor(() => {
      expect(bwrap).toHaveLength(1);
    });
    expect(bwrap[0]?.signal.aborted).toBe(false);

    probe.dispose();

    expect(bwrap[0]?.signal.aborted).toBe(true);
    // 子プロセスが止まって確認が終わっても、次の段（CLIの空起動）へ進まない
    bwrap[0]?.resolve({ ok: true, detail: '' });
    await expect(result).resolves.toMatchObject({ ok: false });
  });

  it('bubblewrapの確認中に止めたら、CLIを空起動しない', async () => {
    const { ports, bwrap, cli } = pendingPorts();
    const probe = new ClaudeSandboxProbe(ports, silentLogger());
    const result = probe.check();
    await vi.waitFor(() => {
      expect(bwrap).toHaveLength(1);
    });

    probe.dispose();
    bwrap[0]?.resolve({ ok: true, detail: '' });
    await result;

    expect(cli).toHaveLength(0);
  });

  it('CLIの空起動中に止めたら、成功で終わっても使える結果として覚えない', async () => {
    const { ports, bwrap, cli } = pendingPorts();
    const probe = new ClaudeSandboxProbe(ports, silentLogger());
    const result = probe.check();
    await vi.waitFor(() => {
      expect(bwrap).toHaveLength(1);
    });
    bwrap[0]?.resolve({ ok: true, detail: '' });
    await vi.waitFor(() => {
      expect(cli).toHaveLength(1);
    });

    probe.dispose();

    expect(cli[0]?.signal.aborted).toBe(true);
    cli[0]?.resolve({ ok: true, detail: '' });
    await expect(result).resolves.toMatchObject({ ok: false });
    await expect(probe.check()).resolves.toMatchObject({ ok: false });
  });

  it('dispose後は新たな確認を始めない', async () => {
    const tryBwrap = vi.fn();
    const tryCli = vi.fn();
    const inspectReadOnlyCwd = vi.fn();
    const probe = new ClaudeSandboxProbe(
      { platform: 'linux', inContainer: () => false, tryBwrap, tryCli, inspectReadOnlyCwd },
      silentLogger(),
    );

    probe.dispose();

    await expect(probe.check()).resolves.toMatchObject({ ok: false });
    expect(tryBwrap).not.toHaveBeenCalled();
    expect(tryCli).not.toHaveBeenCalled();
  });
});

describe('nodeSandboxProbePorts: 中止で子プロセスを止める（Issue #1545）', () => {
  let fake: FakeChildProcess;
  let execFileCallback: ((error: Error | null, stdout: string, stderr: string) => void) | undefined;

  beforeEach(() => {
    fake = createFakeChildProcess();
    execFileCallback = undefined;
    spawnMock.mockReset().mockReturnValue(fake.proc);
    execFileMock.mockReset().mockImplementation((...args: unknown[]) => {
      execFileCallback = args[3] as typeof execFileCallback;
      return fake.proc;
    });
  });

  it('bubblewrapの試し起動をkillWithEscalationで止める', async () => {
    const abort = new AbortController();
    const result = nodeSandboxProbePorts(() => 'claude').tryBwrap(true, abort.signal);

    abort.abort();

    expect(fake.kill).toHaveBeenCalledTimes(1);
    expect(fake.kill).toHaveBeenCalledWith();
    execFileCallback?.(new Error('killed'), '', '');
    await expect(result).resolves.toMatchObject({ ok: false });
  });

  it('CLIの空起動をkillWithEscalationで止める', async () => {
    const abort = new AbortController();
    const result = nodeSandboxProbePorts(() => 'claude').tryCli('{}', abort.signal);

    abort.abort();

    expect(fake.kill).toHaveBeenCalledTimes(1);
    expect(fake.kill).toHaveBeenCalledWith();
    fake.emitExit(null, 'SIGTERM');
    await expect(result).resolves.toMatchObject({ ok: false });
  });

  it('終わった後の中止では何も止めない', async () => {
    const abort = new AbortController();
    const result = nodeSandboxProbePorts(() => 'claude').tryCli('{}', abort.signal);
    fake.emitExit(0);
    await expect(result).resolves.toEqual({ ok: true, detail: '' });

    abort.abort();

    expect(fake.kill).not.toHaveBeenCalled();
  });
});
