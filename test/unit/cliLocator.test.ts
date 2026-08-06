import { describe, expect, it } from 'vitest';
import {
  codexPaths,
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
    });
  });
});
