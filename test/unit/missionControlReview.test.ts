import { describe, expect, it, vi } from 'vitest';
import type { GitCommandResult, GitCommandRunner } from '../../src/orchestrator/worktree';
import {
  parseNumstatZ,
  readWorkingChanges,
  REVIEW_MAX_FILES,
  REVIEW_RECHECK_MS,
  ReviewTracker,
  reviewFingerprint,
  toMcReview,
  type WorkingChanges,
} from '../../src/view/missionControlReview';

const ok = (stdout: string): GitCommandResult => ({ code: 0, stdout, stderr: '' });
const ng: GitCommandResult = { code: 1, stdout: '', stderr: '' };

/** `args.join(' ')`の先頭一致で応答を返すフェイク。一致しなければ失敗（code 1）。 */
function fakeGit(responses: Record<string, GitCommandResult>): {
  git: GitCommandRunner;
  calls: Array<{ args: string; cwd: string }>;
} {
  const calls: Array<{ args: string; cwd: string }> = [];
  return {
    calls,
    git: {
      run: (args, cwd) => {
        const key = args.join(' ');
        calls.push({ args: key, cwd });
        return Promise.resolve(responses[key] ?? ng);
      },
    },
  };
}

const TOP = '/repo';
const baseResponses = (overrides: Record<string, GitCommandResult> = {}) => ({
  'rev-parse --show-toplevel': ok(`${TOP}\n`),
  'rev-parse --verify --quiet origin/main^{commit}': ok('abc\n'),
  'merge-base HEAD origin/main': ok('mb111\n'),
  'rev-parse --verify --quiet HEAD^{commit}': ok('head222\n'),
  'diff --numstat -z --no-renames mb111 --': ok('1\t2\ta.ts\0'),
  'ls-files --others --exclude-standard -z': ok(''),
  ...overrides,
});

describe('parseNumstatZ', () => {
  it('追加・削除・パスを読む', () => {
    expect(parseNumstatZ('3\t4\tsrc/a.ts\0-\t-\timg.png\0')).toEqual([
      { path: 'src/a.ts', added: 3, deleted: 4, untracked: false },
      { path: 'img.png', added: undefined, deleted: undefined, untracked: false },
    ]);
  });

  it('形の合わない行と空は読み飛ばす', () => {
    expect(parseNumstatZ('')).toEqual([]);
    expect(parseNumstatZ('garbage\0x\ty\tz\0\0')).toEqual([]);
  });

  it('パスに空白・改行・タブを含んでも切れない', () => {
    const files = parseNumstatZ('1\t1\ta b\nc\td.ts\0');
    expect(files).toEqual([{ path: 'a b\nc\td.ts', added: 1, deleted: 1, untracked: false }]);
  });
});

describe('readWorkingChanges', () => {
  it('origin/mainがあれば分岐点を比較元にし、未追跡も加える', async () => {
    const { git, calls } = fakeGit(
      baseResponses({ 'ls-files --others --exclude-standard -z': ok('new.ts\0') }),
    );
    const result = await readWorkingChanges(git, '/repo/sub');
    expect(result).toEqual({
      toplevel: TOP,
      base: 'mb111',
      baseLabel: 'origin/main',
      files: [
        { path: 'a.ts', added: 1, deleted: 2, untracked: false },
        { path: 'new.ts', untracked: true },
      ],
      truncated: false,
    });
    // 最初だけ与えたcwd、以降はtoplevelで実行する
    expect(calls[0]).toEqual({ args: 'rev-parse --show-toplevel', cwd: '/repo/sub' });
    expect(calls.slice(1).every((c) => c.cwd === TOP)).toBe(true);
  });

  it('origin/mainが無ければHEADを比較元にする', async () => {
    const { git } = fakeGit(
      baseResponses({
        'rev-parse --verify --quiet origin/main^{commit}': ng,
        'diff --numstat -z --no-renames head222 --': ok('0\t5\tb.ts\0'),
      }),
    );
    const result = await readWorkingChanges(git, TOP);
    expect(result).toMatchObject({ base: 'head222', baseLabel: 'HEAD' });
    expect(result?.files).toEqual([{ path: 'b.ts', added: 0, deleted: 5, untracked: false }]);
  });

  it('merge-baseが失敗・空ならHEADへ落ちる', async () => {
    for (const mb of [ng, ok('\n')]) {
      const { git } = fakeGit(
        baseResponses({
          'merge-base HEAD origin/main': mb,
          'diff --numstat -z --no-renames head222 --': ok(''),
        }),
      );
      expect(await readWorkingChanges(git, TOP)).toMatchObject({
        base: 'head222',
        baseLabel: 'HEAD',
        files: [],
      });
    }
  });

  it('gitのrepoでない（失敗・空出力）ならundefined', async () => {
    expect(await readWorkingChanges(fakeGit({}).git, TOP)).toBeUndefined();
    const empty = fakeGit({ 'rev-parse --show-toplevel': ok('  \n') });
    expect(await readWorkingChanges(empty.git, TOP)).toBeUndefined();
  });

  it('HEADが無ければundefined', async () => {
    const { git } = fakeGit(
      baseResponses({
        'rev-parse --verify --quiet origin/main^{commit}': ng,
        'rev-parse --verify --quiet HEAD^{commit}': ng,
      }),
    );
    expect(await readWorkingChanges(git, TOP)).toBeUndefined();
    const emptyHead = fakeGit(
      baseResponses({
        'rev-parse --verify --quiet origin/main^{commit}': ng,
        'rev-parse --verify --quiet HEAD^{commit}': ok('\n'),
      }),
    );
    expect(await readWorkingChanges(emptyHead.git, TOP)).toBeUndefined();
  });

  it('diffが失敗ならundefined', async () => {
    const { git } = fakeGit(baseResponses({ 'diff --numstat -z --no-renames mb111 --': ng }));
    expect(await readWorkingChanges(git, TOP)).toBeUndefined();
  });

  it('ls-filesが失敗してもdiffの分は返す', async () => {
    const { git } = fakeGit(baseResponses({ 'ls-files --others --exclude-standard -z': ng }));
    expect((await readWorkingChanges(git, TOP))?.files).toHaveLength(1);
  });

  it('上限までに切り詰めてtruncatedを立てる', async () => {
    const tracked = Array.from({ length: REVIEW_MAX_FILES }, (_, i) => `1\t1\tf${i}.ts\0`).join('');
    const { git } = fakeGit(
      baseResponses({
        'diff --numstat -z --no-renames mb111 --': ok(tracked),
        'ls-files --others --exclude-standard -z': ok('extra.ts\0'),
      }),
    );
    const result = await readWorkingChanges(git, TOP);
    expect(result?.files).toHaveLength(REVIEW_MAX_FILES);
    expect(result?.truncated).toBe(true);
    // 未追跡は後ろに並ぶので切り捨てられる
    expect(result?.files.some((f) => f.untracked)).toBe(false);
  });

  it('ちょうど上限ならtruncatedは立たない', async () => {
    const tracked = Array.from({ length: REVIEW_MAX_FILES }, (_, i) => `1\t1\tf${i}.ts\0`).join('');
    const { git } = fakeGit(
      baseResponses({ 'diff --numstat -z --no-renames mb111 --': ok(tracked) }),
    );
    const result = await readWorkingChanges(git, TOP);
    expect(result?.files).toHaveLength(REVIEW_MAX_FILES);
    expect(result?.truncated).toBe(false);
  });
});

function changes(overrides: Partial<WorkingChanges> = {}): WorkingChanges {
  return {
    toplevel: TOP,
    base: 'b1',
    baseLabel: 'origin/main',
    files: [
      { path: 'a.ts', added: 2, deleted: 1, untracked: false },
      { path: 'img.png', added: undefined, deleted: undefined, untracked: false },
      { path: 'n.ts', untracked: true },
    ],
    truncated: false,
    ...overrides,
  };
}

describe('toMcReview / reviewFingerprint', () => {
  it('行数を合計し、未定義は0として数える', () => {
    expect(toMcReview(changes())).toEqual({
      baseLabel: 'origin/main',
      files: changes().files,
      added: 2,
      deleted: 1,
      truncated: false,
    });
  });

  it('指紋は比較元・ファイル・truncatedの変化で変わる', () => {
    const a = reviewFingerprint(changes());
    expect(reviewFingerprint(changes())).toBe(a);
    expect(reviewFingerprint(changes({ base: 'b2' }))).not.toBe(a);
    expect(reviewFingerprint(changes({ truncated: true }))).not.toBe(a);
    expect(reviewFingerprint(changes({ files: [] }))).not.toBe(a);
    // baseLabelは指紋に入らない
    expect(reviewFingerprint(changes({ baseLabel: 'HEAD' }))).toBe(a);
  });
});

describe('ReviewTracker', () => {
  function setup(responses = baseResponses()) {
    const { git, calls } = fakeGit(responses);
    const onChange = vi.fn();
    let now = 1_000_000;
    const tracker = new ReviewTracker(git, onChange, () => now);
    return {
      tracker,
      onChange,
      calls,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }
  const idle = (key = 's1', cwd: string | undefined = '/repo') => ({
    key,
    cwd,
    activity: 'idle' as const,
  });
  const running = (key = 's1', cwd = '/repo') => ({ key, cwd, activity: 'running' as const });

  it('初回は空を返し、確認後にonChangeして次のobserveでレビュー待ちが出る', async () => {
    const { tracker, onChange } = setup();
    expect(tracker.observe([idle()]).size).toBe(0);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    const review = tracker.observe([idle()]).get('s1');
    expect(review).toMatchObject({ baseLabel: 'origin/main', added: 1, deleted: 2 });
  });

  it('cwdが無い・空のセッションは対象にしない', async () => {
    const { tracker, calls } = setup();
    const sessions = [
      { key: 'a', cwd: undefined, activity: 'idle' as const },
      { key: 'b', cwd: '', activity: 'idle' as const },
    ];
    expect(tracker.observe(sessions).size).toBe(0);
    await Promise.resolve();
    expect(calls).toHaveLength(0);
  });

  it('待機中でなければ確認せず、レビューも出さない', async () => {
    const { tracker, calls } = setup();
    tracker.observe([running()]);
    await Promise.resolve();
    expect(calls).toHaveLength(0);
    expect(tracker.observe([running()]).size).toBe(0);
  });

  it('実行中から待機中へ変わったら確かめ直す', async () => {
    const { tracker, onChange, calls } = setup();
    tracker.observe([idle()]);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
    const before = calls.length;
    tracker.observe([running()]);
    // 実行中のあいだはレビューを出さない
    expect(tracker.observe([running()]).size).toBe(0);
    tracker.observe([idle()]);
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(before));
  });

  it('待機のままでも間隔が過ぎるまでは確かめ直さない', async () => {
    const { tracker, onChange, calls, advance } = setup();
    tracker.observe([idle()]);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
    const before = calls.length;
    advance(REVIEW_RECHECK_MS - 1);
    tracker.observe([idle()]);
    await Promise.resolve();
    expect(calls.length).toBe(before);
    advance(1);
    tracker.observe([idle()]);
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(before));
  });

  it('結果が変わらなければonChangeを呼ばない', async () => {
    const { tracker, onChange, calls, advance } = setup();
    tracker.observe([idle()]);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    const before = calls.length;
    advance(REVIEW_RECHECK_MS);
    tracker.observe([idle()]);
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(before));
    await Promise.resolve();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('変更が無い（files空）ならレビュー待ちにしない', async () => {
    const { tracker, onChange } = setup(
      baseResponses({ 'diff --numstat -z --no-renames mb111 --': ok('') }),
    );
    tracker.observe([idle()]);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(tracker.observe([idle()]).size).toBe(0);
    expect(tracker.acknowledge('s1')).toBe(false);
  });

  it('gitのrepoでなければレビュー待ちにしない', async () => {
    const { tracker, onChange, calls } = setup({});
    tracker.observe([idle()]);
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    await Promise.resolve();
    expect(onChange).not.toHaveBeenCalled();
    expect(tracker.observe([idle()]).size).toBe(0);
  });

  it('git実行が例外を投げてもキューが止まらない', async () => {
    const onChange = vi.fn();
    let fail = true;
    const git: GitCommandRunner = {
      run: (args) => {
        if (fail) {
          return Promise.reject(new Error('boom'));
        }
        return Promise.resolve(
          baseResponses()[args.join(' ') as keyof ReturnType<typeof baseResponses>] ?? ng,
        );
      },
    };
    const tracker = new ReviewTracker(git, onChange, () => 0);
    tracker.observe([idle('a')]);
    await new Promise((r) => setTimeout(r, 0));
    fail = false;
    tracker.observe([idle('b')]);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(tracker.observe([idle('b')]).has('b')).toBe(true);
  });

  it('acknowledgeで消え、変更が増えると再び出る', async () => {
    let numstat = '1\t2\ta.ts\0';
    const { git } = fakeGit({});
    const base = baseResponses();
    const onChange = vi.fn();
    let now = 0;
    const runner: GitCommandRunner = {
      run: (args) => {
        const key = args.join(' ');
        if (key.startsWith('diff --numstat')) {
          return Promise.resolve(ok(numstat));
        }
        return Promise.resolve(base[key as keyof typeof base] ?? ng);
      },
    };
    void git;
    const tracker = new ReviewTracker(runner, onChange, () => now);
    tracker.observe([idle()]);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(tracker.observe([idle()]).size).toBe(1);

    expect(tracker.acknowledge('s1')).toBe(true);
    expect(tracker.observe([idle()]).size).toBe(0);
    // 確認済みの後の二重acknowledgeはfalse
    expect(tracker.acknowledge('s1')).toBe(false);

    numstat = '1\t2\ta.ts\0' + '5\t0\tb.ts\0';
    now += REVIEW_RECHECK_MS;
    tracker.observe([idle()]);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
    expect(tracker.observe([idle()]).get('s1')?.files).toHaveLength(2);
  });

  it('未知のキーはacknowledgeできない', () => {
    expect(setup().tracker.acknowledge('none')).toBe(false);
  });

  it('スナップショットから消えたセッションは忘れる', async () => {
    const { tracker, onChange } = setup();
    tracker.observe([idle()]);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
    tracker.observe([]);
    expect(tracker.diffSource('s1', 'a.ts')).toBeUndefined();
    expect(tracker.acknowledge('s1')).toBe(false);
  });

  it('cwdが変わったら覚えた結果を捨てて確かめ直す', async () => {
    const { tracker, onChange, calls } = setup();
    tracker.observe([idle()]);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(tracker.observe([idle('s1', '/other')]).size).toBe(0);
    await vi.waitFor(() => expect(calls.some((c) => c.cwd === '/other')).toBe(true));
  });

  it('確かめている間にセッションが外されたら結果を捨てる', async () => {
    const { tracker, onChange } = setup();
    tracker.observe([idle()]);
    tracker.observe([]);
    await new Promise((r) => setTimeout(r, 0));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('disposeの後は確認しない', async () => {
    const { tracker, onChange, calls } = setup();
    tracker.dispose();
    tracker.observe([idle()]);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(0);
    expect(onChange).not.toHaveBeenCalled();
  });

  describe('diffSource', () => {
    async function loaded(files: string) {
      const s = setup(baseResponses({ 'diff --numstat -z --no-renames mb111 --': ok(files) }));
      s.tracker.observe([idle()]);
      await vi.waitFor(() => expect(s.onChange).toHaveBeenCalled());
      return s.tracker;
    }

    it('変更一覧にあるファイルだけ返す', async () => {
      const tracker = await loaded('1\t2\ta.ts\0');
      expect(tracker.diffSource('s1', 'a.ts')).toEqual({
        toplevel: TOP,
        base: 'mb111',
        file: { path: 'a.ts', added: 1, deleted: 2, untracked: false },
      });
    });

    it('一覧に無いパスや未知のキーは拒否する', async () => {
      const tracker = await loaded('1\t2\ta.ts\0');
      expect(tracker.diffSource('s1', 'other.ts')).toBeUndefined();
      expect(tracker.diffSource('s1', '../etc/passwd')).toBeUndefined();
      expect(tracker.diffSource('s1', '/etc/passwd')).toBeUndefined();
      expect(tracker.diffSource('none', 'a.ts')).toBeUndefined();
    });

    it('一覧にあってもtoplevelの外を指すパスは拒否する', async () => {
      const tracker = await loaded('1\t1\t../outside.ts\0' + '1\t1\t/abs.ts\0');
      expect(tracker.diffSource('s1', '../outside.ts')).toBeUndefined();
      // 絶対パスはresolveでtoplevelの外になる
      expect(tracker.diffSource('s1', '/abs.ts')).toBeUndefined();
    });

    it('git未確認の間（changes無し）はundefined', () => {
      const { tracker } = setup();
      tracker.observe([idle()]);
      expect(tracker.diffSource('s1', 'a.ts')).toBeUndefined();
    });

    it('toplevel内の`..`始まりのファイル名は拒否しない', async () => {
      const tracker = await loaded('1\t1\t..foo\0');
      expect(tracker.diffSource('s1', '..foo')).toBeDefined();
    });
  });
});
