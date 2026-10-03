import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  compileReadDenyRule,
  findDeniedDirectory,
  inspectReadOnlyCwd,
  type ReadDenyPattern,
} from '../../src/claude/sandboxReadDeny';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: vi.fn(),
}));

const CWD = '/work/proj';
const HOME = '/home/user';

const matches = (rule: string, target: string, cwd = CWD, home = HOME): boolean => {
  const compiled = compileReadDenyRule(rule, cwd, home);
  if (compiled === undefined) {
    throw new Error(`ルールをコンパイルできませんでした: ${rule}`);
  }
  return compiled.pattern.test(target);
};

describe('compileReadDenyRule', () => {
  it.each(['Write(./secrets/**)', 'Bash(ls)', 'Read(', 'Read./a)', 'secrets'])(
    'Read(...)形でないルール %s は undefined',
    (rule) => {
      expect(compileReadDenyRule(rule, CWD, HOME)).toBeUndefined();
    },
  );

  it.each(['Read()', 'Read(   )'])('中身が空のルール %s は undefined', (rule) => {
    expect(compileReadDenyRule(rule, CWD, HOME)).toBeUndefined();
  });

  it('元のルール文字列をそのまま保持する', () => {
    expect(compileReadDenyRule('Read(./a)', CWD, HOME)?.rule).toBe('Read(./a)');
  });

  it('中身の前後の空白を無視する', () => {
    expect(matches('Read(  ./secrets/**  )', `${CWD}/secrets`)).toBe(true);
  });

  it('./始まりは作業ディレクトリ基準で、末尾の/**はそのディレクトリ自体を覆う', () => {
    expect(matches('Read(./secrets/**)', `${CWD}/secrets`)).toBe(true);
    expect(matches('Read(./secrets/**)', `${CWD}/other`)).toBe(false);
    expect(matches('Read(./secrets/**)', `${CWD}/a/secrets`)).toBe(false);
    expect(matches('Read(./secrets/**)', `${CWD}/secretsX`)).toBe(false);
  });

  it('末尾が/**/や/が連なる形も同じ扱いにする', () => {
    expect(matches('Read(./secrets/**/)', `${CWD}/secrets`)).toBe(true);
    expect(matches('Read(./secrets///)', `${CWD}/secrets`)).toBe(true);
    expect(matches('Read(./secrets/**/**)', `${CWD}/secrets`)).toBe(true);
  });

  it('/始まりも作業ディレクトリ基準で照合する', () => {
    expect(matches('Read(/secrets/**)', `${CWD}/secrets`)).toBe(true);
    expect(matches('Read(/secrets/**)', `${CWD}/a/secrets`)).toBe(false);
  });

  it('//始まりは絶対パスとして扱う', () => {
    expect(matches('Read(//etc/ssl/**)', '/etc/ssl')).toBe(true);
    expect(matches('Read(//etc/ssl/**)', `${CWD}/etc/ssl`)).toBe(false);
  });

  it('~/始まりはホーム基準、~だけはホーム自身に一致する', () => {
    expect(matches('Read(~/.ssh/**)', `${HOME}/.ssh`)).toBe(true);
    expect(matches('Read(~/.ssh/**)', `${CWD}/.ssh`)).toBe(false);
    expect(matches('Read(~)', HOME)).toBe(true);
    expect(matches('Read(~)', `${HOME}/sub`)).toBe(false);
  });

  it('~で始まっても~/でない名前はホーム扱いにしない', () => {
    expect(matches('Read(~tmp)', `${CWD}/~tmp`)).toBe(true);
    expect(matches('Read(~tmp)', `${HOME}/tmp`)).toBe(false);
  });

  it('/を含まない無印は任意の深さに一致する', () => {
    expect(matches('Read(node_modules)', `${CWD}/node_modules`)).toBe(true);
    expect(matches('Read(node_modules)', `${CWD}/a/b/node_modules`)).toBe(true);
    expect(matches('Read(node_modules)', `${CWD}/node_modules2`)).toBe(false);
    expect(matches('Read(node_modules/)', `${CWD}/a/node_modules`)).toBe(true);
  });

  it('/を含む無印は作業ディレクトリ直下だけに一致する', () => {
    expect(matches('Read(a/b)', `${CWD}/a/b`)).toBe(true);
    expect(matches('Read(a/b)', `${CWD}/x/a/b`)).toBe(false);
  });

  it('globが空なら基点のディレクトリ自身だけに一致する', () => {
    expect(matches('Read(./)', CWD)).toBe(true);
    expect(matches('Read(./)', `${CWD}/sub`)).toBe(false);
  });

  it('globが**なら基点自身と配下の全てに一致する', () => {
    expect(matches('Read(./**)', CWD)).toBe(true);
    expect(matches('Read(./**)', `${CWD}/a/b`)).toBe(true);
    expect(matches('Read(./**)', '/work/proj2')).toBe(false);
    expect(matches('Read(**)', `${CWD}/deep/dir`)).toBe(true);
  });

  it('基点の末尾スラッシュを無視する', () => {
    expect(matches('Read(./a)', `${CWD}/a`, `${CWD}/`)).toBe(true);
    expect(matches('Read(~/a)', `${HOME}/a`, CWD, `${HOME}/`)).toBe(true);
  });

  it('基点内の正規表現メタ文字をエスケープする', () => {
    expect(matches('Read(./a)', '/w.rk (1)/a', '/w.rk (1)')).toBe(true);
    expect(matches('Read(./a)', '/wxrk (1)/a', '/w.rk (1)')).toBe(false);
  });

  describe('glob', () => {
    it('*は1階層内の任意の文字列に一致し、/は越えない', () => {
      expect(matches('Read(./a/*)', `${CWD}/a/x`)).toBe(true);
      expect(matches('Read(./a/*)', `${CWD}/a/x/y`)).toBe(false);
      expect(matches('Read(./a*b)', `${CWD}/aXYb`)).toBe(true);
      expect(matches('Read(./a*b)', `${CWD}/a/b`)).toBe(false);
    });

    it('**/は0階層以上のディレクトリに一致する', () => {
      expect(matches('Read(./**/secrets)', `${CWD}/secrets`)).toBe(true);
      expect(matches('Read(./**/secrets)', `${CWD}/a/b/secrets`)).toBe(true);
      expect(matches('Read(./**/secrets)', `${CWD}/a/b/other`)).toBe(false);
    });

    it('**が/の前に来ない場合は/を含む任意の文字列に一致する', () => {
      expect(matches('Read(./a**z)', `${CWD}/a/b/z`)).toBe(true);
      expect(matches('Read(./a**z)', `${CWD}/ay`)).toBe(false);
    });

    it('?は/以外の1文字に一致する', () => {
      expect(matches('Read(./a?c)', `${CWD}/abc`)).toBe(true);
      expect(matches('Read(./a?c)', `${CWD}/ac`)).toBe(false);
      expect(matches('Read(./a?c)', `${CWD}/a/c`)).toBe(false);
    });

    it('[abc]は文字クラスとして扱う', () => {
      expect(matches('Read(./f[ab])', `${CWD}/fa`)).toBe(true);
      expect(matches('Read(./f[ab])', `${CWD}/fb`)).toBe(true);
      expect(matches('Read(./f[ab])', `${CWD}/fc`)).toBe(false);
    });

    it('[!abc]と[^abc]は否定の文字クラスにする', () => {
      expect(matches('Read(./f[!ab])', `${CWD}/fc`)).toBe(true);
      expect(matches('Read(./f[!ab])', `${CWD}/fa`)).toBe(false);
      expect(matches('Read(./f[^ab])', `${CWD}/fc`)).toBe(true);
      expect(matches('Read(./f[^ab])', `${CWD}/fb`)).toBe(false);
    });

    it('文字クラス内の\\は文字として扱う', () => {
      expect(matches('Read(./f[\\x])', `${CWD}/f\\`)).toBe(true);
      expect(matches('Read(./f[\\x])', `${CWD}/fx`)).toBe(true);
      expect(matches('Read(./f[\\x])', `${CWD}/fy`)).toBe(false);
    });

    it('閉じられない[は文字そのものとして扱う', () => {
      expect(matches('Read(./a[b)', `${CWD}/a[b`)).toBe(true);
      expect(matches('Read(./a[b)', `${CWD}/ab`)).toBe(false);
      // `[]`は閉じ括弧を探す位置が1つ先なので文字クラスにならない
      expect(matches('Read(./a[])', `${CWD}/a[]`)).toBe(true);
    });

    it('{a,b}は選択肢に展開し、各選択肢にもglobを使える', () => {
      expect(matches('Read(./{aa,b*}/x)', `${CWD}/aa/x`)).toBe(true);
      expect(matches('Read(./{aa,b*}/x)', `${CWD}/bcd/x`)).toBe(true);
      expect(matches('Read(./{aa,b*}/x)', `${CWD}/cc/x`)).toBe(false);
    });

    it('閉じられない{は文字そのものとして扱う', () => {
      expect(matches('Read(./a{b)', `${CWD}/a{b`)).toBe(true);
      expect(matches('Read(./a{b)', `${CWD}/ab`)).toBe(false);
    });

    it('.などのメタ文字はリテラルとして扱う', () => {
      expect(matches('Read(./.git)', `${CWD}/.git`)).toBe(true);
      expect(matches('Read(./.git)', `${CWD}/xgit`)).toBe(false);
      expect(matches('Read(./a+b)', `${CWD}/a+b`)).toBe(true);
      expect(matches('Read(./a+b)', `${CWD}/aab`)).toBe(false);
    });
  });
});

describe('一時ディレクトリを使うテスト', () => {
  const created: string[] = [];

  const makeTmp = async (): Promise<string> => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'sandbox-read-deny-'));
    created.push(dir);
    // macOSの/var→/private/varのようなsymlinkを解決した実パスで返す
    return fs.realpath(dir);
  };

  const pattern = (rule: string, cwd: string, home = HOME): ReadDenyPattern => {
    const compiled = compileReadDenyRule(rule, cwd, home);
    if (compiled === undefined) {
      throw new Error(`ルールをコンパイルできませんでした: ${rule}`);
    }
    return compiled;
  };

  const noAbort = (): AbortSignal => new AbortController().signal;

  /** src側の`MAX_SCANNED_DIRECTORIES`（未export）と同じ値 */
  const MAX_SCANNED_DIRECTORIES = 200_000;

  /** cwdの直下に上限+1個のディレクトリがあるように見せ、実ディレクトリを作らずに上限を超えさせる */
  const mockOverLimitDirectories = (cwd: string): void => {
    const entries = Array.from({ length: MAX_SCANNED_DIRECTORIES + 1 }, (_, i) => ({
      name: `d${String(i)}`,
      isDirectory: () => true,
      isSymbolicLink: () => false,
    }));
    vi.spyOn(fs, 'readdir').mockImplementation(((dir: string) =>
      Promise.resolve(dir === cwd ? entries : [])) as unknown as typeof fs.readdir);
    vi.spyOn(fs, 'realpath').mockImplementation((target) => Promise.resolve(String(target)));
  };

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const dir of created.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  describe('findDeniedDirectory', () => {
    it('作業ディレクトリ自身が一致したらfoundを返し、配下は辿らない', async () => {
      const cwd = await makeTmp();
      const readdir = vi.spyOn(fs, 'readdir');
      const result = await findDeniedDirectory(cwd, [pattern('Read(./**)', cwd)], noAbort());
      expect(result).toEqual({
        kind: 'found',
        denied: { directory: cwd, rule: 'Read(./**)' },
      });
      expect(readdir).not.toHaveBeenCalled();
    });

    it('祖先ディレクトリが一致したらfoundを返す', async () => {
      const root = await makeTmp();
      const cwd = path.join(root, 'a', 'b');
      await fs.mkdir(cwd, { recursive: true });
      const rule = `Read(/${path.join(root, 'a')}/**)`;
      const result = await findDeniedDirectory(cwd, [pattern(rule, '/')], noAbort());
      expect(result).toEqual({
        kind: 'found',
        denied: { directory: path.join(root, 'a'), rule },
      });
    });

    it('相対パスのcwdは絶対パスへ解決してから照合する', async () => {
      const cwd = await makeTmp();
      const relative = path.relative(process.cwd(), cwd);
      const result = await findDeniedDirectory(relative, [pattern('Read(./**)', cwd)], noAbort());
      expect(result).toEqual({
        kind: 'found',
        denied: { directory: cwd, rule: 'Read(./**)' },
      });
    });

    it('配下のディレクトリが一致したらそのパスと最初に当たったルールを返す', async () => {
      const cwd = await makeTmp();
      await fs.mkdir(path.join(cwd, 'src', 'secrets'), { recursive: true });
      const result = await findDeniedDirectory(
        cwd,
        [pattern('Read(./nothing)', cwd), pattern('Read(secrets)', cwd), pattern('Read(**)', cwd)],
        noAbort(),
      );
      // cwd自身が3つ目の`**`に一致するため、最初に見つかるのはcwd
      expect(result).toEqual({ kind: 'found', denied: { directory: cwd, rule: 'Read(**)' } });

      const narrowed = await findDeniedDirectory(
        cwd,
        [pattern('Read(./nothing)', cwd), pattern('Read(secrets)', cwd)],
        noAbort(),
      );
      expect(narrowed).toEqual({
        kind: 'found',
        denied: { directory: path.join(cwd, 'src', 'secrets'), rule: 'Read(secrets)' },
      });
    });

    it('一致するものが無ければnoneを返す', async () => {
      const cwd = await makeTmp();
      await fs.mkdir(path.join(cwd, 'a', 'b'), { recursive: true });
      const result = await findDeniedDirectory(cwd, [pattern('Read(secrets)', cwd)], noAbort());
      expect(result).toEqual({ kind: 'none' });
    });

    it('パターンが空ならnoneを返す', async () => {
      const cwd = await makeTmp();
      await fs.mkdir(path.join(cwd, 'a'));
      expect(await findDeniedDirectory(cwd, [], noAbort())).toEqual({ kind: 'none' });
    });

    it('一致する名前のファイルは無視する', async () => {
      const cwd = await makeTmp();
      await fs.writeFile(path.join(cwd, 'secrets'), 'x');
      const result = await findDeniedDirectory(cwd, [pattern('Read(secrets)', cwd)], noAbort());
      expect(result).toEqual({ kind: 'none' });
    });

    it('ディレクトリへのsymlinkは辿り、symlinkのパスで一致させる', async () => {
      const cwd = await makeTmp();
      const outside = await makeTmp();
      await fs.mkdir(path.join(outside, 'secrets'));
      await fs.symlink(outside, path.join(cwd, 'link'));
      const result = await findDeniedDirectory(cwd, [pattern('Read(secrets)', cwd)], noAbort());
      expect(result).toEqual({
        kind: 'found',
        denied: { directory: path.join(cwd, 'link', 'secrets'), rule: 'Read(secrets)' },
      });
    });

    it('ファイルへのsymlinkと壊れたsymlinkは無視する', async () => {
      const cwd = await makeTmp();
      await fs.writeFile(path.join(cwd, 'file'), 'x');
      await fs.symlink(path.join(cwd, 'file'), path.join(cwd, 'secrets'));
      await fs.symlink(path.join(cwd, 'missing'), path.join(cwd, 'broken'));
      const result = await findDeniedDirectory(
        cwd,
        [pattern('Read(secrets)', cwd), pattern('Read(broken)', cwd)],
        noAbort(),
      );
      expect(result).toEqual({ kind: 'none' });
    });

    it('祖先を指すsymlinkの循環でも止まる', async () => {
      const cwd = await makeTmp();
      await fs.mkdir(path.join(cwd, 'a'));
      await fs.symlink(cwd, path.join(cwd, 'a', 'loop'));
      const readdir = vi.spyOn(fs, 'readdir');
      const result = await findDeniedDirectory(cwd, [pattern('Read(secrets)', cwd)], noAbort());
      expect(result).toEqual({ kind: 'none' });
      // cwdとcwd/aの2回だけ。loop先は同じ実体なので辿り直さない
      expect(readdir).toHaveBeenCalledTimes(2);
    });

    it('同じ実体への複数のsymlinkは1回だけ辿る', async () => {
      const cwd = await makeTmp();
      const target = await makeTmp();
      await fs.symlink(target, path.join(cwd, 'one'));
      await fs.symlink(target, path.join(cwd, 'two'));
      const readdir = vi.spyOn(fs, 'readdir');
      const result = await findDeniedDirectory(cwd, [pattern('Read(secrets)', cwd)], noAbort());
      expect(result).toEqual({ kind: 'none' });
      // cwdと、one/twoのうち先に当たった1つ
      expect(readdir).toHaveBeenCalledTimes(2);
    });

    it('読めないディレクトリは飛ばして残りを調べる', async () => {
      const cwd = await makeTmp();
      await fs.mkdir(path.join(cwd, 'a-unreadable', 'secrets'), { recursive: true });
      await fs.mkdir(path.join(cwd, 'readable', 'secrets'), { recursive: true });
      const original = fs.readdir.bind(fs);
      vi.spyOn(fs, 'readdir').mockImplementation(((dir: string, options: unknown) =>
        dir === path.join(cwd, 'a-unreadable')
          ? Promise.reject(new Error('EACCES'))
          : original(dir, options as never)) as typeof fs.readdir);
      const result = await findDeniedDirectory(cwd, [pattern('Read(secrets)', cwd)], noAbort());
      expect(result).toEqual({
        kind: 'found',
        denied: { directory: path.join(cwd, 'readable', 'secrets'), rule: 'Read(secrets)' },
      });
    });

    it('realpathが失敗しても元のパスで探索を続ける', async () => {
      const cwd = await makeTmp();
      await fs.mkdir(path.join(cwd, 'a', 'secrets'), { recursive: true });
      vi.spyOn(fs, 'realpath').mockRejectedValue(new Error('EIO'));
      const result = await findDeniedDirectory(cwd, [pattern('Read(secrets)', cwd)], noAbort());
      expect(result).toEqual({
        kind: 'found',
        denied: { directory: path.join(cwd, 'a', 'secrets'), rule: 'Read(secrets)' },
      });
    });

    it('中止済みのsignalなら、祖先に一致が無い限りabortedを返す', async () => {
      const cwd = await makeTmp();
      await fs.mkdir(path.join(cwd, 'secrets'));
      const controller = new AbortController();
      controller.abort();
      const readdir = vi.spyOn(fs, 'readdir');
      const result = await findDeniedDirectory(
        cwd,
        [pattern('Read(secrets)', cwd)],
        controller.signal,
      );
      expect(result).toEqual({ kind: 'aborted' });
      expect(readdir).not.toHaveBeenCalled();
    });

    it('中止済みでもcwd自身の一致はfoundを優先する', async () => {
      const cwd = await makeTmp();
      const controller = new AbortController();
      controller.abort();
      const result = await findDeniedDirectory(
        cwd,
        [pattern('Read(./**)', cwd)],
        controller.signal,
      );
      expect(result.kind).toBe('found');
    });

    it('探索の途中で中止されたらabortedを返す', async () => {
      const cwd = await makeTmp();
      await fs.mkdir(path.join(cwd, 'a'));
      const controller = new AbortController();
      const original = fs.readdir.bind(fs);
      vi.spyOn(fs, 'readdir').mockImplementation(((dir: string, options: unknown) => {
        controller.abort();
        return original(dir, options as never);
      }) as typeof fs.readdir);
      const result = await findDeniedDirectory(
        cwd,
        [pattern('Read(secrets)', cwd)],
        controller.signal,
      );
      // 1回目のreaddirで中止し、次のディレクトリ(a)を調べる前にabortedで止まる
      expect(result).toEqual({ kind: 'aborted' });
    });

    it('辿るディレクトリが上限を超えたらlimitを返す', async () => {
      const cwd = await makeTmp();
      mockOverLimitDirectories(cwd);
      const result = await findDeniedDirectory(cwd, [pattern('Read(secrets)', cwd)], noAbort());
      expect(result).toEqual({ kind: 'limit' });
    });
  });

  describe('inspectReadOnlyCwd', () => {
    type FakeStream = EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
    type FakeProc = EventEmitter & {
      stdout: FakeStream;
      stderr: FakeStream;
      stdin: EventEmitter & { end: ReturnType<typeof vi.fn> };
      exitCode: number | null;
      signalCode: string | null;
      kill: ReturnType<typeof vi.fn>;
    };

    const spawnMock = vi.mocked(spawn);
    const homedirMock = vi.mocked(homedir);

    const stream = (): FakeStream => Object.assign(new EventEmitter(), { setEncoding: vi.fn() });

    const fakeProc = (): FakeProc =>
      Object.assign(new EventEmitter(), {
        stdout: stream(),
        stderr: stream(),
        stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
        exitCode: null as number | null,
        signalCode: null as string | null,
        kill: vi.fn(),
      });

    /** inspectReadOnlyCwdが起動するCLIの代わりに、`proc`を返させる。 */
    const useProc = (proc: FakeProc): void => {
      spawnMock.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
    };

    const response = (rules: unknown): string =>
      `${JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'list_permission_rules',
          response: { state: { rules } },
        },
      })}\n`;

    const deny = (rule: string): { behavior: string; rule: string } => ({
      behavior: 'deny',
      rule,
    });

    beforeEach(() => {
      spawnMock.mockReset();
      homedirMock.mockReset();
      homedirMock.mockReturnValue(HOME);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('--bareの空起動でCLIを作業ディレクトリに起動し、2つのcontrol_requestをstdinへ送る', async () => {
      const cwd = await makeTmp();
      const proc = fakeProc();
      useProc(proc);
      const result = inspectReadOnlyCwd('/bin/claude', cwd, noAbort());
      proc.stdout.emit('data', response([]));
      await result;

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [command, args, options] = spawnMock.mock.calls[0] as [
        string,
        string[],
        { cwd: string },
      ];
      expect(command).toBe('/bin/claude');
      expect(args).toContain('--bare');
      expect(args).toContain('--no-session-persistence');
      expect(options.cwd).toBe(cwd);

      const written = String(proc.stdin.end.mock.calls[0]?.[0]);
      expect(written.endsWith('\n')).toBe(true);
      const messages = written
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { request_id: string; request: { subtype: string } });
      expect(messages.map((m) => [m.request_id, m.request.subtype])).toEqual([
        ['initialize', 'initialize'],
        ['list_permission_rules', 'list_permission_rules'],
      ]);
    });

    it('Readのdenyルールが無ければokを返し、ディレクトリを調べない', async () => {
      const cwd = await makeTmp();
      const proc = fakeProc();
      useProc(proc);
      const readdir = vi.spyOn(fs, 'readdir');
      const result = inspectReadOnlyCwd('claude', cwd, noAbort());
      proc.stdout.emit('data', response([]));
      expect(await result).toEqual({ ok: true });
      expect(readdir).not.toHaveBeenCalled();
    });

    it('allowや他ツールのルール、不正な要素はdenyのReadとして扱わない', async () => {
      const cwd = await makeTmp();
      await fs.mkdir(path.join(cwd, 'secrets'));
      const proc = fakeProc();
      useProc(proc);
      const result = inspectReadOnlyCwd('claude', cwd, noAbort());
      proc.stdout.emit(
        'data',
        response([
          { behavior: 'allow', rule: 'Read(./secrets/**)' },
          deny('Write(./secrets/**)'),
          { behavior: 'deny', rule: 123 },
          { behavior: 'deny' },
          'Read(./secrets/**)',
          null,
          [deny('Read(./secrets/**)')],
        ]),
      );
      expect(await result).toEqual({ ok: true });
    });

    it('コンパイルできないReadルールだけならokを返す', async () => {
      const cwd = await makeTmp();
      const proc = fakeProc();
      useProc(proc);
      const result = inspectReadOnlyCwd('claude', cwd, noAbort());
      proc.stdout.emit('data', response([deny('Read()')]));
      expect(await result).toEqual({ ok: true });
    });

    it('deny対象のディレクトリが実在すると、理由にパスとルールを含めて拒否する', async () => {
      const cwd = await makeTmp();
      await fs.mkdir(path.join(cwd, 'secrets'));
      const proc = fakeProc();
      useProc(proc);
      const result = inspectReadOnlyCwd('claude', cwd, noAbort());
      proc.stdout.emit('data', response([deny('Read(./secrets/**)')]));
      const inspection = await result;
      expect(inspection.ok).toBe(false);
      if (!inspection.ok) {
        expect(inspection.reason).toContain(path.join(cwd, 'secrets'));
        expect(inspection.reason).toContain('Read(./secrets/**)');
        expect(inspection.reason).toContain('#1630');
      }
    });

    it('denyルールがあっても一致するディレクトリが無ければokを返す', async () => {
      const cwd = await makeTmp();
      await fs.writeFile(path.join(cwd, '.env'), 'x');
      const proc = fakeProc();
      useProc(proc);
      const result = inspectReadOnlyCwd('claude', cwd, noAbort());
      proc.stdout.emit('data', response([deny('Read(./.env)'), deny('Read(./secrets/**)')]));
      expect(await result).toEqual({ ok: true });
    });

    it('~/ルールは実際のホームではなくhomedir()の値で照合する', async () => {
      const home = await makeTmp();
      await fs.mkdir(path.join(home, '.ssh'));
      homedirMock.mockReturnValue(home);
      const proc = fakeProc();
      useProc(proc);
      const result = inspectReadOnlyCwd('claude', home, noAbort());
      proc.stdout.emit('data', response([deny('Read(~/.ssh/**)')]));
      const inspection = await result;
      expect(inspection.ok).toBe(false);
      if (!inspection.ok) {
        expect(inspection.reason).toContain(path.join(home, '.ssh'));
      }
    });

    it('ディレクトリ数が上限を超えたら、確かめきれない理由で拒否する', async () => {
      const cwd = await makeTmp();
      mockOverLimitDirectories(cwd);
      const proc = fakeProc();
      useProc(proc);
      const result = inspectReadOnlyCwd('claude', cwd, noAbort());
      proc.stdout.emit('data', response([deny('Read(./secrets/**)')]));
      const inspection = await result;
      expect(inspection.ok).toBe(false);
      if (!inspection.ok) {
        expect(inspection.reason).toContain(String(MAX_SCANNED_DIRECTORIES));
      }
    });

    it('ルール取得後の探索中に中止されたら、中止の理由で拒否する', async () => {
      const cwd = await makeTmp();
      const controller = new AbortController();
      const proc = fakeProc();
      useProc(proc);
      const result = inspectReadOnlyCwd('claude', cwd, controller.signal);
      proc.stdout.emit('data', response([deny('Read(./secrets/**)')]));
      controller.abort();
      expect(await result).toEqual({
        ok: false,
        reason: '拡張機能の終了により確認を中止しました',
      });
    });

    it('開始前に中止済みならCLIを起動せずに拒否する', async () => {
      const cwd = await makeTmp();
      const controller = new AbortController();
      controller.abort();
      expect(await inspectReadOnlyCwd('claude', cwd, controller.signal)).toEqual({
        ok: false,
        reason: 'Readのdenyルールを確かめられません: 拡張機能の終了により確認を中止しました',
      });
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('応答待ちの間に中止されたら、拒否してCLIを終了させる', async () => {
      const cwd = await makeTmp();
      const controller = new AbortController();
      const proc = fakeProc();
      useProc(proc);
      const result = inspectReadOnlyCwd('claude', cwd, controller.signal);
      controller.abort();
      expect(await result).toEqual({
        ok: false,
        reason: 'Readのdenyルールを確かめられません: 拡張機能の終了により確認を中止しました',
      });
      expect(proc.kill).toHaveBeenCalledTimes(1);
    });

    it('応答を得たらCLIの終了を待たずに終了させ、以降のcloseは結果を変えない', async () => {
      const cwd = await makeTmp();
      const proc = fakeProc();
      useProc(proc);
      const result = inspectReadOnlyCwd('claude', cwd, noAbort());
      proc.stdout.emit('data', response([]));
      proc.emit('close', 1);
      expect(await result).toEqual({ ok: true });
      expect(proc.kill).toHaveBeenCalledTimes(1);
    });

    it('CLIが既に終了していれば、killしない', async () => {
      const cwd = await makeTmp();
      const proc = fakeProc();
      proc.exitCode = 0;
      useProc(proc);
      const result = inspectReadOnlyCwd('claude', cwd, noAbort());
      proc.stdout.emit('data', response([]));
      expect(await result).toEqual({ ok: true });
      expect(proc.kill).not.toHaveBeenCalled();
    });

    it('シグナルで終了済みのCLIもkillしない', async () => {
      const cwd = await makeTmp();
      const proc = fakeProc();
      proc.signalCode = 'SIGTERM';
      useProc(proc);
      const result = inspectReadOnlyCwd('claude', cwd, noAbort());
      proc.stdout.emit('data', response([]));
      expect(await result).toEqual({ ok: true });
      expect(proc.kill).not.toHaveBeenCalled();
    });

    it('30秒応答が無ければタイムアウトとして拒否する', async () => {
      vi.useFakeTimers();
      const cwd = await makeTmp();
      const proc = fakeProc();
      useProc(proc);
      const result = inspectReadOnlyCwd('claude', cwd, noAbort());
      await vi.advanceTimersByTimeAsync(29_999);
      proc.stdout.emit('data', 'unrelated\n');
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toEqual({
        ok: false,
        reason: 'Readのdenyルールを確かめられません: 30000ms以内に応答がありませんでした',
      });
      expect(proc.kill).toHaveBeenCalledTimes(1);
    });

    it('応答が複数のchunkに分かれても行として組み立てる', async () => {
      const cwd = await makeTmp();
      await fs.mkdir(path.join(cwd, 'secrets'));
      const proc = fakeProc();
      useProc(proc);
      const result = inspectReadOnlyCwd('claude', cwd, noAbort());
      const line = response([deny('Read(./secrets/**)')]);
      const middle = Math.floor(line.length / 2);
      proc.stdout.emit('data', line.slice(0, middle));
      proc.stdout.emit('data', line.slice(middle));
      const inspection = await result;
      expect(inspection.ok).toBe(false);
    });

    it('応答以外の行を読み飛ばして、後続の応答を使う', async () => {
      const cwd = await makeTmp();
      const proc = fakeProc();
      useProc(proc);
      const result = inspectReadOnlyCwd('claude', cwd, noAbort());
      const ignored = [
        '{"type":"system","subtype":"init"}',
        // IDを含むがJSONでない
        'log: list_permission_rules {broken',
        // IDを含むがオブジェクトでない
        '["list_permission_rules"]',
        // control_responseでない
        JSON.stringify({ type: 'result', id: 'list_permission_rules' }),
        // responseがオブジェクトでない
        JSON.stringify({ type: 'control_response', response: 'list_permission_rules' }),
        // 別のrequest_idへの応答
        JSON.stringify({
          type: 'control_response',
          response: { subtype: 'success', request_id: 'initialize', note: 'list_permission_rules' },
        }),
      ].join('\n');
      proc.stdout.emit('data', `${ignored}\n${response([])}`);
      expect(await result).toEqual({ ok: true });
    });

    it('応答がsuccess以外ならエラー内容を理由に含めて拒否する', async () => {
      const cwd = await makeTmp();
      const proc = fakeProc();
      useProc(proc);
      const result = inspectReadOnlyCwd('claude', cwd, noAbort());
      proc.stdout.emit(
        'data',
        `${JSON.stringify({
          type: 'control_response',
          response: { subtype: 'error', request_id: 'list_permission_rules', error: 'boom' },
        })}\n`,
      );
      expect(await result).toEqual({
        ok: false,
        reason: 'Readのdenyルールを確かめられません: list_permission_rulesが失敗しました: boom',
      });
    });

    it.each([
      ['response.responseが無い', undefined],
      ['response.responseが配列', []],
      ['stateが無い', {}],
      ['stateが文字列', { state: 'x' }],
      ['rulesが配列でない', { state: { rules: 'Read(./a)' } }],
    ])('%sなら、rulesが無い理由で拒否する', async (_label, payload) => {
      const cwd = await makeTmp();
      const proc = fakeProc();
      useProc(proc);
      const result = inspectReadOnlyCwd('claude', cwd, noAbort());
      proc.stdout.emit(
        'data',
        `${JSON.stringify({
          type: 'control_response',
          response: { subtype: 'success', request_id: 'list_permission_rules', response: payload },
        })}\n`,
      );
      expect(await result).toEqual({
        ok: false,
        reason:
          'Readのdenyルールを確かめられません: list_permission_rulesの応答にrulesがありません',
      });
    });

    it('1行が4MiBを超えたら、長すぎる理由で拒否する', async () => {
      const cwd = await makeTmp();
      const proc = fakeProc();
      useProc(proc);
      const result = inspectReadOnlyCwd('claude', cwd, noAbort());
      proc.stdout.emit('data', 'a'.repeat(4 * 1024 * 1024 + 1));
      expect(await result).toEqual({
        ok: false,
        reason: 'Readのdenyルールを確かめられません: CLIの出力の1行が長すぎます',
      });
    });

    it('起動に失敗したら、errorのメッセージを理由に含めて拒否する', async () => {
      const cwd = await makeTmp();
      const proc = fakeProc();
      useProc(proc);
      const result = inspectReadOnlyCwd('/no/such/claude', cwd, noAbort());
      proc.emit('error', new Error('spawn /no/such/claude ENOENT'));
      expect(await result).toEqual({
        ok: false,
        reason: 'Readのdenyルールを確かめられません: spawn /no/such/claude ENOENT',
      });
    });

    it('応答前に終了したら、exit codeとstderrを理由に含めて拒否する', async () => {
      const cwd = await makeTmp();
      const proc = fakeProc();
      useProc(proc);
      const result = inspectReadOnlyCwd('claude', cwd, noAbort());
      proc.stderr.emit('data', '  fatal: bad flag\n');
      proc.emit('close', 2);
      expect(await result).toEqual({
        ok: false,
        reason:
          'Readのdenyルールを確かめられません: ルールの一覧を返す前に終了しました（exit code 2）: fatal: bad flag',
      });
    });

    it('signalで終了してexit codeがnullでも理由を組み立てる', async () => {
      const cwd = await makeTmp();
      const proc = fakeProc();
      useProc(proc);
      const result = inspectReadOnlyCwd('claude', cwd, noAbort());
      proc.emit('close', null);
      expect(await result).toEqual({
        ok: false,
        reason:
          'Readのdenyルールを確かめられません: ルールの一覧を返す前に終了しました（exit code null）: ',
      });
    });

    it('stderrは上限(1200文字)を超えたら以降のchunkを溜めない', async () => {
      const cwd = await makeTmp();
      const proc = fakeProc();
      useProc(proc);
      const result = inspectReadOnlyCwd('claude', cwd, noAbort());
      proc.stderr.emit('data', 'a'.repeat(1200));
      proc.stderr.emit('data', 'LATER');
      proc.emit('close', 1);
      const inspection = await result;
      expect(inspection.ok).toBe(false);
      if (!inspection.ok) {
        expect(inspection.reason).toContain('a'.repeat(1200));
        expect(inspection.reason).not.toContain('LATER');
      }
    });

    it('stdinの書き込みエラーは無視し、errorとcloseの結果に任せる', async () => {
      const cwd = await makeTmp();
      const proc = fakeProc();
      useProc(proc);
      const result = inspectReadOnlyCwd('claude', cwd, noAbort());
      expect(() => proc.stdin.emit('error', new Error('EPIPE'))).not.toThrow();
      proc.emit('close', 1);
      const inspection = await result;
      expect(inspection.ok).toBe(false);
      if (!inspection.ok) {
        expect(inspection.reason).toContain('exit code 1');
      }
    });
  });
});
