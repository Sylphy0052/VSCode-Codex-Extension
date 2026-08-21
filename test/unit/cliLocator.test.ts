import { describe, expect, it } from 'vitest';
import {
  codexPaths,
  executableNameCandidates,
  resolveCodexHome,
  resolveCodexPath,
  type LocatorDeps,
} from '../../src/codex/cliLocator';

const deps = (over: Partial<LocatorDeps> = {}): LocatorDeps => ({
  isExecutable: () => false,
  env: {},
  homedir: () => '/home/user',
  delimiter: ':',
  ...over,
});

describe('resolveCodexPath', () => {
  it('PATHを順に探して最初に見つかった実行ファイルを返す', () => {
    const result = resolveCodexPath(
      '',
      deps({
        env: { PATH: '/usr/bin:/home/user/.local/bin' },
        isExecutable: (p) => p === '/home/user/.local/bin/codex',
      }),
    );
    expect(result).toEqual({ ok: true, path: '/home/user/.local/bin/codex', source: 'path' });
  });

  it('見つからなければ not-found', () => {
    const result = resolveCodexPath('', deps({ env: { PATH: '/usr/bin' } }));
    expect(result).toEqual({ ok: false, reason: 'not-found', attempted: 'codex' });
  });

  it('PATH未設定でも落ちない', () => {
    expect(resolveCodexPath('', deps()).ok).toBe(false);
  });

  it('パス指定の設定はそれだけを見る（PATHへフォールバックしない）', () => {
    const result = resolveCodexPath(
      '/opt/codex/bin/codex',
      deps({
        env: { PATH: '/usr/bin' },
        // PATH上には存在するが、設定のパスには存在しない状況
        isExecutable: (p) => p === '/usr/bin/codex',
      }),
    );
    expect(result).toEqual({
      ok: false,
      reason: 'setting-not-executable',
      attempted: '/opt/codex/bin/codex',
    });
  });

  it('パス指定が実行可能ならそれを使う', () => {
    const result = resolveCodexPath(
      '/opt/codex/bin/codex',
      deps({ isExecutable: (p) => p === '/opt/codex/bin/codex' }),
    );
    expect(result).toEqual({ ok: true, path: '/opt/codex/bin/codex', source: 'setting' });
  });

  it('パスを含まない設定値はPATH上のコマンド名として扱う', () => {
    const result = resolveCodexPath(
      'codex-next',
      deps({ env: { PATH: '/usr/bin' }, isExecutable: (p) => p === '/usr/bin/codex-next' }),
    );
    expect(result).toEqual({ ok: true, path: '/usr/bin/codex-next', source: 'path' });
  });

  it('前後の空白を無視する', () => {
    const result = resolveCodexPath(
      '  ',
      deps({ env: { PATH: '/usr/bin' }, isExecutable: (p) => p === '/usr/bin/codex' }),
    );
    expect(result.ok).toBe(true);
  });
});

describe('executableNameCandidates（Windowsの拡張子解決。Issue #404）', () => {
  it('PATHEXT未設定（Windows以外）なら元の名前だけを候補にする', () => {
    expect(executableNameCandidates('gh', {})).toEqual(['gh']);
  });

  it('PATHEXTが空文字なら元の名前だけを候補にする', () => {
    expect(executableNameCandidates('gh', { PATHEXT: '' })).toEqual(['gh']);
  });

  it('PATHEXT設定時は元の名前に続けて各拡張子を付けた候補を返す', () => {
    expect(executableNameCandidates('gh', { PATHEXT: '.COM;.EXE;.BAT;.CMD' })).toEqual([
      'gh',
      'gh.COM',
      'gh.EXE',
      'gh.BAT',
      'gh.CMD',
    ]);
  });

  it('既に拡張子付きの名前は展開しない（大文字小文字を無視して判定）', () => {
    expect(executableNameCandidates('gh.exe', { PATHEXT: '.COM;.EXE;.BAT;.CMD' })).toEqual([
      'gh.exe',
    ]);
  });
});

describe('resolveCodexPath（Windowsの拡張子解決。Issue #404）', () => {
  it('PATH上に拡張子付き（gh.exe相当）でしか無くても見つかる', () => {
    const result = resolveCodexPath(
      '',
      deps({
        env: { PATH: 'C:\\tools', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
        delimiter: ';',
        isExecutable: (p) => p === 'C:\\tools/codex.EXE',
      }),
    );
    expect(result).toEqual({ ok: true, path: 'C:\\tools/codex.EXE', source: 'path' });
  });

  it('パス指定の設定値も拡張子省略から解決できる', () => {
    const result = resolveCodexPath(
      '/opt/codex/bin/codex',
      deps({
        env: { PATHEXT: '.COM;.EXE;.BAT;.CMD' },
        isExecutable: (p) => p === '/opt/codex/bin/codex.CMD',
      }),
    );
    expect(result).toEqual({ ok: true, path: '/opt/codex/bin/codex.CMD', source: 'setting' });
  });
});

describe('resolveCodexHome', () => {
  it('設定 > 環境変数 > ホームの順で解決する', () => {
    expect(resolveCodexHome('/custom', deps({ env: { CODEX_HOME: '/from-env' } }))).toBe('/custom');
    expect(resolveCodexHome('', deps({ env: { CODEX_HOME: '/from-env' } }))).toBe('/from-env');
    expect(resolveCodexHome('', deps())).toBe('/home/user/.codex');
  });

  it('空白だけの環境変数は無視する', () => {
    expect(resolveCodexHome('', deps({ env: { CODEX_HOME: '   ' } }))).toBe('/home/user/.codex');
  });
});

describe('codexPaths', () => {
  it('アーカイブ先を含む主要パスを組み立てる', () => {
    expect(codexPaths('/home/user/.codex')).toEqual({
      home: '/home/user/.codex',
      sessions: '/home/user/.codex/sessions',
      archivedSessions: '/home/user/.codex/archived_sessions',
      sessionIndex: '/home/user/.codex/session_index.jsonl',
      modelsCache: '/home/user/.codex/models_cache.json',
      configToml: '/home/user/.codex/config.toml',
    });
  });
});
