import { describe, expect, it } from 'vitest';
import {
  appendMemoryLine,
  buildMemoryAppendConfirmation,
  buildProjectMemoryCandidates,
  describeInputMode,
  describeMemoryAppendResult,
  orderMemoryCandidates,
  resolveProjectMemoryFile,
  resolveUserMemoryFile,
  routeInputMode,
  symlinkResolutionEquals,
  type MemoryCandidate,
} from '../../src/provider/inputModes';
import type { SymlinkResolution } from '../../src/session/ports';

const NOT_SYMLINK: SymlinkResolution = { kind: 'not-symlink' };
const resolved = (target: string): SymlinkResolution => ({ kind: 'resolved', target });
const UNRESOLVED: SymlinkResolution = { kind: 'unresolved' };

describe('routeInputMode', () => {
  it('先頭が ! ならシェルコマンドとして読み取る', () => {
    expect(routeInputMode('!ls -la')).toEqual({ kind: 'shell', command: 'ls -la' });
  });

  it('先頭が # ならメモリ追記として読み取る', () => {
    expect(routeInputMode('#常にpnpmを使う')).toEqual({
      kind: 'memory',
      content: '常にpnpmを使う',
    });
  });

  it('前後の空白は無視する', () => {
    expect(routeInputMode('  !ls  ')).toEqual({ kind: 'shell', command: 'ls' });
  });

  it('! の直後が空なら該当なし（空コマンドを実行させない）', () => {
    expect(routeInputMode('!')).toBeUndefined();
    expect(routeInputMode('!   ')).toBeUndefined();
  });

  it('# の直後が空なら該当なし（空の追記をさせない）', () => {
    expect(routeInputMode('#')).toBeUndefined();
    expect(routeInputMode('#   ')).toBeUndefined();
  });

  it('行頭でない ! / # は対象にしない', () => {
    expect(routeInputMode('これは!コマンドではない')).toBeUndefined();
    expect(routeInputMode('タグは#付けない')).toBeUndefined();
  });

  it('複数行にまたがる発言は対象にしない（Markdown見出しの引用等を誤って乗っ取らない）', () => {
    expect(routeInputMode('# 見出し\n本文が続く')).toBeUndefined();
    expect(routeInputMode('!ls\n次の行')).toBeUndefined();
  });

  it('通常の発言は対象にしない', () => {
    expect(routeInputMode('こんにちは')).toBeUndefined();
    expect(routeInputMode('')).toBeUndefined();
  });
});

describe('describeInputMode', () => {
  it('シェルコマンドの案内文を組み立てる', () => {
    expect(describeInputMode({ kind: 'shell', command: 'ls -la' })).toBe(
      'シェルコマンドとしてターミナルへ入力します: ls -la',
    );
  });

  it('メモリ追記の案内文を組み立てる', () => {
    expect(describeInputMode({ kind: 'memory', content: '常にpnpmを使う' })).toBe(
      'メモリへ追記します: 常にpnpmを使う',
    );
  });
});

describe('resolveProjectMemoryFile', () => {
  it('どちらも無ければ <cwd>/CLAUDE.md を使う', () => {
    expect(resolveProjectMemoryFile('/repo', false, false)).toBe('/repo/CLAUDE.md');
  });

  it('<cwd>/CLAUDE.md が既にあればそれを使う', () => {
    expect(resolveProjectMemoryFile('/repo', true, false)).toBe('/repo/CLAUDE.md');
  });

  it('<cwd>/.claude/CLAUDE.md だけがあればそれを使う', () => {
    expect(resolveProjectMemoryFile('/repo', false, true)).toBe('/repo/.claude/CLAUDE.md');
  });

  it('両方あれば <cwd>/CLAUDE.md を優先する', () => {
    expect(resolveProjectMemoryFile('/repo', true, true)).toBe('/repo/CLAUDE.md');
  });
});

describe('resolveUserMemoryFile', () => {
  it('claudeHome直下のCLAUDE.mdを指す', () => {
    expect(resolveUserMemoryFile('/home/user/.claude')).toBe('/home/user/.claude/CLAUDE.md');
  });
});

describe('appendMemoryLine', () => {
  it('ファイルが無いとき（undefined）は新規の箇条書き1行になる', () => {
    expect(appendMemoryLine(undefined, '常にpnpmを使う')).toBe('- 常にpnpmを使う\n');
  });

  it('空文字も無いときと同じ扱いにする', () => {
    expect(appendMemoryLine('', '常にpnpmを使う')).toBe('- 常にpnpmを使う\n');
  });

  it('末尾に改行が無ければ補ってから足す', () => {
    expect(appendMemoryLine('既存の内容', '追記分')).toBe('既存の内容\n- 追記分\n');
  });

  it('末尾が改行済みならそのまま足す', () => {
    expect(appendMemoryLine('既存の内容\n', '追記分')).toBe('既存の内容\n- 追記分\n');
  });

  it('既存の内容を変更しない（immutable）', () => {
    const existing = '既存の内容\n';
    appendMemoryLine(existing, '追記分');
    expect(existing).toBe('既存の内容\n');
  });
});

describe('buildProjectMemoryCandidates（issue #144）', () => {
  it('workspaceFolderごとに1件、フォルダ名入りのラベルで組み立てる', () => {
    const candidates = buildProjectMemoryCandidates([
      { name: 'app', cwd: '/repo/app', rootClaudeMdExists: false, dotClaudeMdExists: false },
      { name: 'lib', cwd: '/repo/lib', rootClaudeMdExists: true, dotClaudeMdExists: false },
    ]);
    expect(candidates).toEqual([
      { label: 'プロジェクト（app）', path: '/repo/app/CLAUDE.md', exists: false },
      { label: 'プロジェクト（lib）', path: '/repo/lib/CLAUDE.md', exists: true },
    ]);
  });

  it('resolveProjectMemoryFileと同じ規則で.claude/CLAUDE.mdを選ぶ', () => {
    const candidates = buildProjectMemoryCandidates([
      { name: 'app', cwd: '/repo/app', rootClaudeMdExists: false, dotClaudeMdExists: true },
    ]);
    expect(candidates).toEqual([
      { label: 'プロジェクト（app）', path: '/repo/app/.claude/CLAUDE.md', exists: true },
    ]);
  });

  it('workspaceFolderが無ければ空配列', () => {
    expect(buildProjectMemoryCandidates([])).toEqual([]);
  });

  it('親ディレクトリが異なる同名フォルダは、ラベルへ親ディレクトリ名を添えて区別する', () => {
    const candidates = buildProjectMemoryCandidates([
      { name: 'project', cwd: '/a/project', rootClaudeMdExists: false, dotClaudeMdExists: false },
      { name: 'project', cwd: '/b/project', rootClaudeMdExists: false, dotClaudeMdExists: false },
    ]);
    expect(candidates).toEqual([
      { label: 'プロジェクト（a/project）', path: '/a/project/CLAUDE.md', exists: false },
      { label: 'プロジェクト（b/project）', path: '/b/project/CLAUDE.md', exists: false },
    ]);
  });

  it('フォルダ名が重複しなければ親ディレクトリ名を添えない', () => {
    const candidates = buildProjectMemoryCandidates([
      { name: 'app', cwd: '/a/app', rootClaudeMdExists: false, dotClaudeMdExists: false },
      { name: 'lib', cwd: '/b/lib', rootClaudeMdExists: false, dotClaudeMdExists: false },
    ]);
    expect(candidates.map((c) => c.label)).toEqual(['プロジェクト（app）', 'プロジェクト（lib）']);
  });
});

describe('orderMemoryCandidates（issue #144）', () => {
  const candidates: MemoryCandidate[] = [
    { label: 'プロジェクト（app）', path: '/repo/app/CLAUDE.md', exists: true },
    { label: 'プロジェクト（lib）', path: '/repo/lib/CLAUDE.md', exists: false },
    { label: 'ユーザー', path: '/home/user/.claude/CLAUDE.md', exists: true },
  ];

  it('前回選択が候補にあれば先頭へ動かす（他は元の相対順のまま）', () => {
    expect(orderMemoryCandidates(candidates, '/home/user/.claude/CLAUDE.md')).toEqual([
      { label: 'ユーザー', path: '/home/user/.claude/CLAUDE.md', exists: true },
      { label: 'プロジェクト（app）', path: '/repo/app/CLAUDE.md', exists: true },
      { label: 'プロジェクト（lib）', path: '/repo/lib/CLAUDE.md', exists: false },
    ]);
  });

  it('前回選択が既に先頭なら並びを変えない', () => {
    expect(orderMemoryCandidates(candidates, '/repo/app/CLAUDE.md')).toEqual(candidates);
  });

  it('前回選択が今回の候補に無ければ元の順のまま', () => {
    expect(orderMemoryCandidates(candidates, '/repo/other/CLAUDE.md')).toEqual(candidates);
  });

  it('前回選択がundefinedなら元の順のまま', () => {
    expect(orderMemoryCandidates(candidates, undefined)).toEqual(candidates);
  });

  it('immutable（渡した配列を書き換えない）', () => {
    const copy = [...candidates];
    orderMemoryCandidates(candidates, '/home/user/.claude/CLAUDE.md');
    expect(candidates).toEqual(copy);
  });
});

describe('buildMemoryAppendConfirmation（issue #144）', () => {
  it('シンボリックリンクでなければ追記先のパスだけ出す', () => {
    expect(buildMemoryAppendConfirmation('常にpnpmを使う', '/repo/CLAUDE.md', NOT_SYMLINK)).toBe(
      '次の内容を追記します:\n\n常にpnpmを使う\n\n追記先: /repo/CLAUDE.md',
    );
  });

  it('シンボリックリンクなら実体の絶対パスも出す', () => {
    expect(
      buildMemoryAppendConfirmation(
        '常にpnpmを使う',
        '/repo/CLAUDE.md',
        resolved('/home/user/dotfiles/CLAUDE.md'),
      ),
    ).toBe(
      '次の内容を追記します:\n\n常にpnpmを使う\n\n追記先: /repo/CLAUDE.md\nリンク先: /home/user/dotfiles/CLAUDE.md',
    );
  });

  it('シンボリックリンクだが実体パスを特定できないときは警告を出す（CRITICAL指摘の再発防止）', () => {
    const text = buildMemoryAppendConfirmation('常にpnpmを使う', '/repo/CLAUDE.md', UNRESOLVED);
    expect(text).toContain('次の内容を追記します:\n\n常にpnpmを使う\n\n追記先: /repo/CLAUDE.md');
    expect(text).toContain('警告');
    expect(text).toContain('実体のパスを特定できません');
  });
});

describe('describeMemoryAppendResult（issue #144）', () => {
  it('シンボリックリンクでなければ追記先のパスだけ出す', () => {
    expect(describeMemoryAppendResult('/repo/CLAUDE.md', NOT_SYMLINK)).toBe(
      'メモリへ追記しました: /repo/CLAUDE.md',
    );
  });

  it('シンボリックリンクなら実体の絶対パスも出す', () => {
    expect(
      describeMemoryAppendResult('/repo/CLAUDE.md', resolved('/home/user/dotfiles/CLAUDE.md')),
    ).toBe('メモリへ追記しました: /repo/CLAUDE.md（リンク先: /home/user/dotfiles/CLAUDE.md）');
  });

  it('シンボリックリンクだが実体パスを特定できないときは会話の記録にも警告を残す', () => {
    const text = describeMemoryAppendResult('/repo/CLAUDE.md', UNRESOLVED);
    expect(text).toContain('メモリへ追記しました: /repo/CLAUDE.md');
    expect(text).toContain('警告');
    expect(text).toContain('実体のパスを特定できません');
  });
});

describe('symlinkResolutionEquals（issue #144のTOCTOU対策）', () => {
  it('両方とも not-symlink なら等しい', () => {
    expect(symlinkResolutionEquals(NOT_SYMLINK, NOT_SYMLINK)).toBe(true);
  });

  it('resolvedで実体パスが同じなら等しい', () => {
    expect(symlinkResolutionEquals(resolved('/a/CLAUDE.md'), resolved('/a/CLAUDE.md'))).toBe(true);
  });

  it('resolvedでも実体パスが違えば等しくない（リンク先が差し替わった）', () => {
    expect(symlinkResolutionEquals(resolved('/a/CLAUDE.md'), resolved('/b/CLAUDE.md'))).toBe(false);
  });

  it('両方とも unresolved なら等しい', () => {
    expect(symlinkResolutionEquals(UNRESOLVED, UNRESOLVED)).toBe(true);
  });

  it('kindが違えば等しくない（not-symlink→resolvedはリンクに差し替わった）', () => {
    expect(symlinkResolutionEquals(NOT_SYMLINK, resolved('/a/CLAUDE.md'))).toBe(false);
    expect(symlinkResolutionEquals(resolved('/a/CLAUDE.md'), UNRESOLVED)).toBe(false);
    expect(symlinkResolutionEquals(NOT_SYMLINK, UNRESOLVED)).toBe(false);
  });
});
