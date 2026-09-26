import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  countTextLines,
  measureWorktreeChanges,
  parseNumstat,
  UNTRACKED_LINE_COUNT_MAX_BYTES,
  UNTRACKED_LINE_COUNT_MAX_FILES,
} from '../../src/orchestrator/taskOverlap';
import type { GitCommandRunner, GitCommandResult } from '../../src/orchestrator/worktree';

/**
 * `measureWorktreeChanges`（Issue #1508）の実測ロジック。gitの呼び出しはフェイクで完結させ、
 * 未追跡ファイルの行数計測だけ実ファイルシステム（`os.tmpdir()`配下）を使う。
 */

describe('parseNumstat（`git diff --numstat -z --no-renames`の出力を読む）', () => {
  it('通常行は追加・削除・ファイルを積む', () => {
    const result = parseNumstat('5\t3\tsrc/a.ts\0');
    expect(result).toEqual({ files: ['src/a.ts'], addedLines: 5, deletedLines: 3 });
  });

  it('複数行を合算する', () => {
    // `\0`直後が数字だと`\010`のような8進エスケープ（バックスペース）に化けるため、
    // `\u0000`で明示する
    const result = parseNumstat('5\t3\ta.ts\u000010\t0\tb.ts\0');
    expect(result).toEqual({ files: ['a.ts', 'b.ts'], addedLines: 15, deletedLines: 3 });
  });

  it('バイナリ（`-\\t-\\tpath`）は行数に数えず、ファイルには含める', () => {
    const result = parseNumstat('-\t-\timg.png\0');
    expect(result).toEqual({ files: ['img.png'], addedLines: 0, deletedLines: 0 });
  });

  it('バイナリと通常行が混ざっても、バイナリ分だけ行数から外れる', () => {
    const result = parseNumstat('-\t-\timg.png\u00002\t1\ta.ts\0');
    expect(result).toEqual({ files: ['img.png', 'a.ts'], addedLines: 2, deletedLines: 1 });
  });

  it('パスにタブ・改行を含んでいても、追加・削除の後ろを丸ごとパスとして読む', () => {
    const weirdPath = 'weird\tname\nwith-newline.ts';
    const result = parseNumstat(`1\t2\t${weirdPath}\0`);
    expect(result).toEqual({ files: [weirdPath], addedLines: 1, deletedLines: 2 });
  });

  it('空出力は空の結果になる', () => {
    expect(parseNumstat('')).toEqual({ files: [], addedLines: 0, deletedLines: 0 });
  });
});

describe('countTextLines（`git diff --numstat`と同じ数え方）', () => {
  it('空は0行', () => {
    expect(countTextLines(new TextEncoder().encode(''))).toBe(0);
  });

  it('末尾に改行が無い最終行も1行に数える', () => {
    expect(countTextLines(new TextEncoder().encode('a\nb'))).toBe(2);
  });

  it('末尾に改行がある場合はその行を二重に数えない', () => {
    expect(countTextLines(new TextEncoder().encode('a\nb\n'))).toBe(2);
  });

  it('改行のみのバイト列は改行の数だけ数える', () => {
    expect(countTextLines(new TextEncoder().encode('\n\n'))).toBe(2);
  });
});

/** args[1]（`--no-optional-locks`の次）でdiff/ls-filesを見分けるフェイク。 */
function fakeGit(options: {
  numstatStdout: string;
  lsFilesStdout: string;
  numstatCode?: number;
  lsFilesCode?: number;
}): GitCommandRunner {
  return {
    run(args): Promise<GitCommandResult> {
      if (args[1] === 'diff') {
        return Promise.resolve({
          code: options.numstatCode ?? 0,
          stdout: options.numstatStdout,
          stderr: '',
        });
      }
      if (args[1] === 'ls-files') {
        return Promise.resolve({
          code: options.lsFilesCode ?? 0,
          stdout: options.lsFilesStdout,
          stderr: '',
        });
      }
      throw new Error(`想定外のgit呼び出し: ${args.join(' ')}`);
    },
  };
}

async function withTmpDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskoverlap-measure-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('measureWorktreeChanges', () => {
  it('未追跡のテキストファイルの行数を、numstatの追加行数へ合算する', async () => {
    await withTmpDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'untracked.txt'), 'line1\nline2\nline3');
      const git = fakeGit({
        numstatStdout: '2\t1\ttracked.ts\0',
        lsFilesStdout: 'untracked.txt\0',
      });
      const result = await measureWorktreeChanges(git, dir, 'origin-sha');
      expect(result).toEqual({
        files: new Set(['tracked.ts', 'untracked.txt']),
        addedLines: 2 + 3,
        deletedLines: 1,
      });
    });
  });

  it('NULを含む未追跡ファイルはバイナリとみなし、行数に数えない（ファイルには含める）', async () => {
    await withTmpDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'binary.bin'), Buffer.from([0x61, 0x00, 0x62, 0x0a]));
      const git = fakeGit({ numstatStdout: '', lsFilesStdout: 'binary.bin\0' });
      const result = await measureWorktreeChanges(git, dir, 'origin-sha');
      expect(result).toEqual({
        files: new Set(['binary.bin']),
        addedLines: 0,
        deletedLines: 0,
      });
    });
  });

  it('上限ちょうどの大きさの未追跡ファイルは数え、1バイト超えたものは数えない', async () => {
    await withTmpDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'at-limit.txt'), Buffer.alloc(UNTRACKED_LINE_COUNT_MAX_BYTES, 0x0a));
      await fs.writeFile(
        path.join(dir, 'over-limit.txt'),
        Buffer.alloc(UNTRACKED_LINE_COUNT_MAX_BYTES + 1, 0x0a),
      );
      const git = fakeGit({ numstatStdout: '', lsFilesStdout: 'at-limit.txt\0over-limit.txt\0' });
      const result = await measureWorktreeChanges(git, dir, 'origin-sha');
      expect(result?.files.size).toBe(2);
      expect(result?.addedLines).toBe(UNTRACKED_LINE_COUNT_MAX_BYTES);
    });
  });

  it('未追跡ファイルの行数は上限の件数までだけ数える（ファイルには全件含める）', async () => {
    await withTmpDir(async (dir) => {
      const names = Array.from(
        { length: UNTRACKED_LINE_COUNT_MAX_FILES + 1 },
        (_, index) => `f${String(index).padStart(4, '0')}.txt`,
      );
      await Promise.all(names.map((name) => fs.writeFile(path.join(dir, name), 'x\n')));
      const git = fakeGit({ numstatStdout: '', lsFilesStdout: names.join('\0') + '\0' });
      const result = await measureWorktreeChanges(git, dir, 'origin-sha');
      expect(result?.files.size).toBe(UNTRACKED_LINE_COUNT_MAX_FILES + 1);
      expect(result?.addedLines).toBe(UNTRACKED_LINE_COUNT_MAX_FILES);
    });
  });

  it('symlinkの未追跡ファイルは辿らず、行数に数えない（ファイルには含める）', async () => {
    await withTmpDir(async (dir) => {
      const targetPath = path.join(dir, 'target.txt');
      await fs.writeFile(targetPath, 'a\nb\nc\n');
      await fs.symlink(targetPath, path.join(dir, 'link.txt'));
      const git = fakeGit({ numstatStdout: '', lsFilesStdout: 'link.txt\0' });
      const result = await measureWorktreeChanges(git, dir, 'origin-sha');
      expect(result).toEqual({
        files: new Set(['link.txt']),
        addedLines: 0,
        deletedLines: 0,
      });
    });
  });

  it('gitが非0を返すとundefined', async () => {
    await withTmpDir(async (dir) => {
      const git = fakeGit({ numstatStdout: '', lsFilesStdout: '', numstatCode: 1 });
      const result = await measureWorktreeChanges(git, dir, 'origin-sha');
      expect(result).toBeUndefined();
    });
  });

  it('ls-filesが非0を返してもundefined', async () => {
    await withTmpDir(async (dir) => {
      const git = fakeGit({ numstatStdout: '', lsFilesStdout: '', lsFilesCode: 1 });
      const result = await measureWorktreeChanges(git, dir, 'origin-sha');
      expect(result).toBeUndefined();
    });
  });
});
