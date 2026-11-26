import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunningTurnEntry } from '../../src/view/missionControlResume';

const h = vi.hoisted(() => ({
  exists: vi.fn((_p: string) => true),
  approvalPending: true,
  sound: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  exec: vi.fn(),
  provider: undefined as
    undefined | { provideTextDocumentContent(uri: { query: string }): Promise<string> },
}));

vi.mock('node:fs', () => ({ existsSync: (p: string) => h.exists(p) }));
vi.mock('../../src/config', () => ({
  readNotificationsConfig: () => ({ approvalPending: h.approvalPending, turnComplete: false }),
}));
vi.mock('../../src/view/notificationSound', () => ({
  playNotificationSound: (...args: unknown[]) => h.sound(...args),
}));
vi.mock('vscode', () => ({
  Uri: {
    from: (v: { scheme: string; path: string; query?: string }) => ({
      scheme: v.scheme,
      path: v.path,
      query: v.query ?? '',
      kind: 'from',
    }),
    file: (p: string) => ({ fsPath: p, kind: 'file' }),
  },
  window: {
    showInformationMessage: (...a: unknown[]) => h.info(...a),
    showWarningMessage: (...a: unknown[]) => h.warn(...a),
  },
  commands: { executeCommand: (...a: unknown[]) => h.exec(...a) },
  workspace: {
    registerTextDocumentContentProvider: (_scheme: string, p: typeof h.provider) => {
      h.provider = p;
      return { dispose: () => undefined };
    },
  },
}));

import {
  createMissionControlHost,
  isRunningTurn,
  MC_BASE_SCHEME,
  resumeKey,
  type McHostDeps,
} from '../../src/view/missionControlHost';
import type { McSnapshot } from '../../src/webview/missionControl/protocol';

const target = { provider: 'codex', windowId: 'win1', threadId: 'th1' } as const;
const sessionKey = 'session:codex:win1:th1';

function entry(over: Partial<RunningTurnEntry> = {}): RunningTurnEntry {
  return { provider: 'codex', threadId: 'th1', title: 'T', cwd: '/w/app', since: 1, ...over };
}

function setup(over: Partial<McHostDeps> = {}) {
  const diffSource = vi.fn();
  const acknowledge = vi.fn();
  const gitRun = vi.fn();
  const openThread = vi.fn(async () => undefined);
  const showMissionControl = vi.fn();
  const resumable = new Map<string, RunningTurnEntry>();
  const forgetResumable = vi.fn();
  const deps: McHostDeps = {
    review: { diffSource, acknowledge } as never,
    git: { run: gitRun } as never,
    windowId: 'win1',
    resumable,
    forgetResumable,
    openThread,
    runningTurnCount: () => 0,
    showMissionControl,
    log: { info: vi.fn() } as never,
    ...over,
  };
  const host = createMissionControlHost(deps);
  return {
    host,
    deps,
    diffSource,
    acknowledge,
    gitRun,
    openThread,
    showMissionControl,
    resumable,
    forgetResumable,
  };
}

beforeEach(() => {
  h.exists.mockReset().mockReturnValue(true);
  h.approvalPending = true;
  h.sound.mockReset();
  h.info.mockReset().mockResolvedValue(undefined);
  h.warn.mockReset().mockResolvedValue(undefined);
  h.exec.mockReset().mockResolvedValue(undefined);
  h.provider = undefined;
});

describe('resumeKey / isRunningTurn', () => {
  it('キーは provider:threadId', () => {
    expect(resumeKey({ provider: 'claude', threadId: 'x' })).toBe('claude:x');
  });
  it('idle以外は実行中のターン', () => {
    expect(isRunningTurn('idle')).toBe(false);
    expect(isRunningTurn('running')).toBe(true);
    expect(isRunningTurn('approvalPending')).toBe(true);
  });
});

describe('openDiff（Issue #2138）', () => {
  const source = {
    toplevel: '/w/app',
    base: 'abc123',
    file: { path: 'src/a.ts', untracked: false },
  };

  it('一覧に無いファイルは開かずエラー文を返す', async () => {
    const { host, diffSource } = setup();
    diffSource.mockReturnValue(undefined);
    expect(await host.port.openDiff(target, 'x')).toBe(
      'このファイルはレビュー待ちの一覧にありません',
    );
    expect(diffSource).toHaveBeenCalledWith(sessionKey, 'x');
    expect(h.exec).not.toHaveBeenCalled();
  });

  it('実在するファイルは左=比較元の仮想文書、右=実ファイルでvscode.diffを開く', async () => {
    const { host, diffSource } = setup();
    diffSource.mockReturnValue(source);
    expect(await host.port.openDiff(target, 'src/a.ts')).toBeUndefined();
    const [cmd, left, right, title] = h.exec.mock.calls[0] ?? [];
    expect(cmd).toBe('vscode.diff');
    expect(left).toMatchObject({ scheme: MC_BASE_SCHEME, path: '/src/a.ts' });
    expect(JSON.parse((left as { query: string }).query)).toEqual({
      key: sessionKey,
      file: 'src/a.ts',
    });
    expect(right).toMatchObject({ kind: 'file', fsPath: '/w/app/src/a.ts' });
    expect(title).toBe('src/a.ts（app）');
  });

  it('消したファイルは右側を空の仮想文書にする', async () => {
    const { host, diffSource } = setup();
    diffSource.mockReturnValue(source);
    h.exists.mockReturnValue(false);
    await host.port.openDiff(target, 'src/a.ts');
    const right = h.exec.mock.calls[0]?.[2] as { scheme: string; query: string };
    expect(right.scheme).toBe(MC_BASE_SCHEME);
    expect(JSON.parse(right.query)).toEqual({});
  });
});

describe('比較元の内容プロバイダ', () => {
  const query = (q: unknown) => ({ query: typeof q === 'string' ? q : JSON.stringify(q) });
  const source = { toplevel: '/w/app', base: 'abc', file: { path: 'a.ts', untracked: false } };

  it('git showの標準出力を返す', async () => {
    const { diffSource, gitRun } = setup();
    diffSource.mockReturnValue(source);
    gitRun.mockResolvedValue({ code: 0, stdout: 'BASE', stderr: '' });
    expect(await h.provider?.provideTextDocumentContent(query({ key: 'k', file: 'a.ts' }))).toBe(
      'BASE',
    );
    expect(gitRun).toHaveBeenCalledWith(['show', 'abc:a.ts'], '/w/app');
  });

  it('git showが失敗したら空', async () => {
    const { diffSource, gitRun } = setup();
    diffSource.mockReturnValue(source);
    gitRun.mockResolvedValue({ code: 128, stdout: 'x', stderr: 'e' });
    expect(await h.provider?.provideTextDocumentContent(query({ key: 'k', file: 'a.ts' }))).toBe(
      '',
    );
  });

  it('キー・ファイルが無い、壊れたJSON、JSONがオブジェクトでない、一覧に無い、未追跡なら空でgitを呼ばない', async () => {
    const { diffSource, gitRun } = setup();
    diffSource.mockReturnValue(undefined);
    for (const q of [{}, { key: 'k' }, 'not json', 'null', '5', { key: 'k', file: 'a.ts' }]) {
      expect(await h.provider?.provideTextDocumentContent(query(q))).toBe('');
    }
    diffSource.mockReturnValue({ ...source, file: { path: 'a.ts', untracked: true } });
    expect(await h.provider?.provideTextDocumentContent(query({ key: 'k', file: 'a.ts' }))).toBe(
      '',
    );
    expect(gitRun).not.toHaveBeenCalled();
  });
});

describe('reviewAck', () => {
  it('確認済みにできたらundefined、できなければエラー文', () => {
    const { host, acknowledge } = setup();
    acknowledge.mockReturnValueOnce(true).mockReturnValueOnce(false);
    expect(host.port.reviewAck(target)).toBeUndefined();
    expect(acknowledge).toHaveBeenCalledWith(sessionKey);
    expect(host.port.reviewAck(target)).toBe('このセッションはレビュー待ちではありません');
  });
});

describe('resume / resumeDismiss', () => {
  it('再開待ちで自分のウィンドウなら会話を開き、一覧から外す', async () => {
    const { host, resumable, openThread, deps, forgetResumable } = setup();
    resumable.set('codex:th1', entry());
    expect(await host.port.resume(target)).toBeUndefined();
    expect(openThread).toHaveBeenCalledWith('codex', 'th1', 'T', '/w/app');
    expect(resumable.has('codex:th1')).toBe(false);
    expect(forgetResumable).toHaveBeenCalledWith(entry());
    expect(deps.log.info).toHaveBeenCalled();
  });

  it('開き終わる前に重ねて押されても二重に開かない', async () => {
    const { host, resumable, openThread } = setup();
    resumable.set('codex:th1', entry());
    const first = host.port.resume(target);
    expect(await host.port.resume(target)).toBe('この会話は再開待ちではありません');
    expect(await first).toBeUndefined();
    expect(openThread).toHaveBeenCalledTimes(1);
  });

  it('再開待ちに無ければエラー文で開かない', async () => {
    const { host, openThread } = setup();
    expect(await host.port.resume(target)).toBe('この会話は再開待ちではありません');
    expect(openThread).not.toHaveBeenCalled();
  });

  it('他のウィンドウ宛は開かず、一覧からも外さない', async () => {
    const { host, resumable, openThread } = setup();
    resumable.set('codex:th1', entry());
    expect(await host.port.resume({ ...target, windowId: 'other' })).toBe(
      'この会話は再開待ちではありません',
    );
    expect(openThread).not.toHaveBeenCalled();
    expect(resumable.has('codex:th1')).toBe(true);
  });

  it('開くのに失敗したら一覧に残す', async () => {
    const { host, resumable, openThread, forgetResumable } = setup();
    resumable.set('codex:th1', entry());
    openThread.mockRejectedValueOnce(new Error('boom'));
    await expect(host.port.resume(target)).rejects.toThrow('boom');
    expect(resumable.has('codex:th1')).toBe(true);
    expect(forgetResumable).not.toHaveBeenCalled();
  });

  it('resumeDismiss: 外せたらundefined、無ければエラー文', () => {
    const { host, resumable, forgetResumable } = setup();
    resumable.set('codex:th1', entry());
    expect(host.port.resumeDismiss(target)).toBeUndefined();
    expect(resumable.size).toBe(0);
    expect(forgetResumable).toHaveBeenCalledWith(entry());
    expect(host.port.resumeDismiss(target)).toBe('この会話は再開待ちではありません');
  });

  it('resumeDismiss: 他のウィンドウ宛は外さない', () => {
    const { host, resumable } = setup();
    resumable.set('codex:th1', entry());
    expect(host.port.resumeDismiss({ ...target, windowId: 'other' })).toBe(
      'この会話は再開待ちではありません',
    );
    expect(resumable.has('codex:th1')).toBe(true);
  });
});

describe('reloadWindow', () => {
  it('実行中が無ければ確認せずReloadする', async () => {
    const { host } = setup();
    expect(await host.port.reloadWindow()).toBeUndefined();
    expect(h.warn).not.toHaveBeenCalled();
    expect(h.exec).toHaveBeenCalledWith('workbench.action.reloadWindow');
  });

  it('実行中があれば件数入りのモーダル確認を出し、承認でReloadする', async () => {
    const { host } = setup({ runningTurnCount: () => 2 });
    h.warn.mockResolvedValue('Reloadする');
    expect(await host.port.reloadWindow()).toBeUndefined();
    const [message, options, button] = h.warn.mock.calls[0] ?? [];
    expect(message).toContain('2件');
    expect(options).toEqual({ modal: true });
    expect(button).toBe('Reloadする');
    expect(h.exec).toHaveBeenCalledWith('workbench.action.reloadWindow');
  });

  it('キャンセル（undefined）ならReloadしない', async () => {
    const { host } = setup({ runningTurnCount: () => 1 });
    h.warn.mockResolvedValue(undefined);
    expect(await host.port.reloadWindow()).toBe('Reloadを取りやめました');
    expect(h.exec).not.toHaveBeenCalled();
  });
});

describe('observe（通知）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const pending = (id: string) => ({
    id,
    kind: 'workflowApproval',
    isCurrentWindow: false,
    title: `t-${id}`,
  });
  const snap = (...ids: string[]) => ({ pending: ids.map(pending) }) as unknown as McSnapshot;

  it('増えた待ちを窓の後に音と通知で知らせ、「開く」でMCを開く', async () => {
    const { host, showMissionControl } = setup();
    h.info.mockResolvedValue('Mission Controlを開く');
    host.port.observe(snap(), false);
    host.port.observe(snap('a'), false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.sound).toHaveBeenCalledWith('approvalPending', false);
    expect(h.info.mock.calls[0]?.[0]).toBe('Mission Control: 「t-a」が待っています');
    expect(showMissionControl).toHaveBeenCalledTimes(1);
  });

  it('通知を閉じただけならMCを開かない', async () => {
    const { host, showMissionControl } = setup();
    host.port.observe(snap(), false);
    host.port.observe(snap('a'), false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.info).toHaveBeenCalled();
    expect(showMissionControl).not.toHaveBeenCalled();
  });

  it('設定でapprovalPendingが無効なら音も通知も出さない', async () => {
    const { host } = setup();
    h.approvalPending = false;
    host.port.observe(snap(), false);
    host.port.observe(snap('a'), false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.sound).not.toHaveBeenCalled();
    expect(h.info).not.toHaveBeenCalled();
  });

  it('前面なら通知しない。disposablesのdisposeで保留も止まる', async () => {
    const { host } = setup();
    host.port.observe(snap(), true);
    host.port.observe(snap('a'), true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.info).not.toHaveBeenCalled();

    host.port.observe(snap('a', 'b'), false);
    for (const d of host.disposables) d.dispose();
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.info).not.toHaveBeenCalled();
  });
});
