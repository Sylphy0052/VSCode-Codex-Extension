/**
 * 差分の目次（Issue #1322）のテスト。
 *
 * ここで固定するのは3つ。
 *
 * 1. `buildDiffIndex` が `git diff` の出力から正しい規模感（件数・増減・種類）を作ること
 * 2. 量に応じた3段階（inline / digest-hunks / digest）の選択
 * 3. 目次へ切り替えたプロンプト本文が、`changes.diff` を読むよう促し、上限超過の省略も
 *    落とさないこと（受入基準6）
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildDiffIndex,
  chooseDiffPresentationTier,
  DEFAULT_DIFF_PRESENTATION_THRESHOLDS,
  estimateTokens,
  MAX_DIFF_INDEX_ENTRIES,
  MAX_HUNK_HEADERS_PER_FILE,
} from '../../src/secondOpinion/diffIndex';
import {
  buildSecondOpinionPrompt,
  resolveDiffPresentationTier,
  type WorkspaceSnapshot,
} from '../../src/secondOpinion/prompt';
import { createReviewBundle } from '../../src/secondOpinion/reviewBundle';
import type { GitCommandResult, GitCommandRunner } from '../../src/orchestrator/worktree';

/** 1ファイル分の差分。`kind` でheaderの形を変える。 */
function fileDiff(
  p: string,
  options: { kind?: 'add' | 'delete' | 'modify'; hunks?: number } = {},
): string {
  const kind = options.kind ?? 'modify';
  const header =
    kind === 'add'
      ? `new file mode 100644\n--- /dev/null\n+++ b/${p}\n`
      : kind === 'delete'
        ? `deleted file mode 100644\n--- a/${p}\n+++ /dev/null\n`
        : `--- a/${p}\n+++ b/${p}\n`;
  let body = '';
  for (let i = 0; i < (options.hunks ?? 1); i += 1) {
    body += `@@ -${i + 1},2 +${i + 1},2 @@ function f${i}()\n-old${i}\n+new${i}\n`;
  }
  return `diff --git a/${p} b/${p}\n${header}${body}`;
}

function snapshotOf(diff: string, extra: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    baseCommit: 'abc1234',
    diff,
    truncated: false,
    untrackedFiles: [],
    untrackedOmissions: [],
    diffOmissions: [],
    diffPartials: [],
    diffIndex: buildDiffIndex(diff),
    ...extra,
  };
}

describe('buildDiffIndex（Issue #1322 受入基準2）', () => {
  it('種類・増減行数・hunk headerを拾う', () => {
    const diff =
      fileDiff('src/a.ts', { hunks: 2 }) +
      fileDiff('src/b.ts', { kind: 'add' }) +
      fileDiff('src/c.ts', { kind: 'delete' });
    const index = buildDiffIndex(diff);

    expect(index.entries.map((e) => [e.path, e.kind])).toEqual([
      ['src/a.ts', 'modify'],
      ['src/b.ts', 'add'],
      ['src/c.ts', 'delete'],
    ]);
    // hunk 1件につき +1 / -1
    expect(index.totalAdded).toBe(4);
    expect(index.totalDeleted).toBe(4);
    expect(index.hasDelete).toBe(true);
    expect(index.hasRename).toBe(false);
    expect(index.hasBinary).toBe(false);
    expect(index.entries[0]?.hunkHeaders).toEqual([
      '@@ -1,2 +1,2 @@ function f0()',
      '@@ -2,2 +2,2 @@ function f1()',
    ]);
  });

  it('リネームは元のパスも残す', () => {
    const diff =
      'diff --git a/old.ts b/new.ts\nsimilarity index 95%\nrename from old.ts\nrename to new.ts\n';
    const index = buildDiffIndex(diff);
    expect(index.hasRename).toBe(true);
    expect(index.entries[0]?.kind).toBe('rename');
    expect(index.entries[0]?.renamedFrom).toBe('old.ts');
  });

  it('バイナリは行数ではなくバイナリとして数える', () => {
    const diff =
      'diff --git a/img.png b/img.png\nindex 111..222 100644\nBinary files a/img.png and b/img.png differ\n';
    const index = buildDiffIndex(diff);
    expect(index.hasBinary).toBe(true);
    expect(index.entries[0]?.added).toBe(0);
  });

  it('hunk headerは1ファイルあたりの上限で打ち切る', () => {
    const index = buildDiffIndex(fileDiff('src/big.ts', { hunks: MAX_HUNK_HEADERS_PER_FILE + 5 }));
    expect(index.entries[0]?.hunkHeaders).toHaveLength(MAX_HUNK_HEADERS_PER_FILE);
    // 打ち切るのは表示だけで、増減の合計は全hunkを数える
    expect(index.entries[0]?.added).toBe(MAX_HUNK_HEADERS_PER_FILE + 5);
  });

  it('差分でない文字列を渡しても落ちない', () => {
    const index = buildDiffIndex('fatal: bad revision\n');
    expect(index.entries).toEqual([]);
    expect(index.totalAdded).toBe(0);
  });

  it('空文字では空の目次を返す', () => {
    expect(buildDiffIndex('')).toEqual({
      entries: [],
      totalBytes: 0,
      totalAdded: 0,
      totalDeleted: 0,
      hasBinary: false,
      hasRename: false,
      hasDelete: false,
    });
  });
});

describe('chooseDiffPresentationTier（Issue #1322 受入基準1）', () => {
  const thresholds = DEFAULT_DIFF_PRESENTATION_THRESHOLDS;

  it('量に応じて3段階を選ぶ', () => {
    expect(chooseDiffPresentationTier('a'.repeat(100), thresholds)).toBe('inline');
    // 1トークン≒4文字の概算なので、文字数で段階をまたがせる
    expect(chooseDiffPresentationTier('a'.repeat(4 * 10_000), thresholds)).toBe('digest-hunks');
    expect(chooseDiffPresentationTier('a'.repeat(4 * 100_000), thresholds)).toBe('digest');
  });

  it('非ASCIIはASCIIより重く見積もる', () => {
    expect(estimateTokens('あ'.repeat(100))).toBeGreaterThan(estimateTokens('a'.repeat(100)));
  });
});

describe('resolveDiffPresentationTier', () => {
  const snapshot = snapshotOf(fileDiff('src/a.ts'));

  it('閾値を渡さなければinline（Issue #1044 の評価ハーネスの凍結）', () => {
    expect(
      resolveDiffPresentationTier({
        userRequest: 'レビューして',
        artifact: { kind: 'workspaceChanges', snapshot },
      }),
    ).toBe('inline');
  });

  it('作業ツリーの変更以外はinlineのまま', () => {
    expect(
      resolveDiffPresentationTier({
        userRequest: 'レビューして',
        artifact: { kind: 'lastAssistantResponse', response: 'x'.repeat(100_000) },
        diffPresentation: DEFAULT_DIFF_PRESENTATION_THRESHOLDS,
      }),
    ).toBe('inline');
  });
});

describe('buildSecondOpinionPrompt: 目次への切り替え（受入基準3・4・6）', () => {
  /** digest段階へ落とすだけの大きさの差分。 */
  function largeDiff(files: number): string {
    let diff = '';
    for (let i = 0; i < files; i += 1) {
      diff += fileDiff(`src/f${i}.ts`, { hunks: 30 });
    }
    return diff;
  }

  it('差分が小さいうちは従来どおり本文へ貼る', () => {
    const diff = fileDiff('src/a.ts');
    const prompt = buildSecondOpinionPrompt({
      userRequest: 'レビューして',
      artifact: { kind: 'workspaceChanges', snapshot: snapshotOf(diff) },
      diffPresentation: DEFAULT_DIFF_PRESENTATION_THRESHOLDS,
    });
    expect(prompt).toContain('```diff');
    expect(prompt).toContain('@@ -1,2 +1,2 @@ function f0()');
    expect(prompt).not.toContain('### 変更の目次');
  });

  it('大きい差分は目次へ置き換え、changes.diffを読むよう促す', () => {
    const diff = largeDiff(60);
    const prompt = buildSecondOpinionPrompt({
      userRequest: 'レビューして',
      artifact: { kind: 'workspaceChanges', snapshot: snapshotOf(diff) },
      diffPresentation: DEFAULT_DIFF_PRESENTATION_THRESHOLDS,
    });
    expect(prompt).toContain('### 変更の目次');
    expect(prompt).toContain('- 変更ファイル数: 60');
    expect(prompt).toContain('`changes.diff`');
    expect(prompt).toContain('必ず `changes.diff` を読んでください');
    // 目次に置き換えた以上、差分そのものは本文に無い
    expect(prompt).not.toContain('```diff');
  });

  it('目次の件数は上限で打ち切り、残りは件数だけ伝える', () => {
    const diff = largeDiff(MAX_DIFF_INDEX_ENTRIES + 3);
    const prompt = buildSecondOpinionPrompt({
      userRequest: 'レビューして',
      artifact: { kind: 'workspaceChanges', snapshot: snapshotOf(diff) },
      diffPresentation: DEFAULT_DIFF_PRESENTATION_THRESHOLDS,
    });
    expect(prompt).toContain('- ほか3件');
    expect(prompt).not.toContain(`src/f${MAX_DIFF_INDEX_ENTRIES + 2}.ts`);
  });

  it('上限超過の省略は目次へ置き換えても落とさない（受入基準6）', () => {
    const diff = largeDiff(60);
    const prompt = buildSecondOpinionPrompt({
      userRequest: 'レビューして',
      artifact: {
        kind: 'workspaceChanges',
        snapshot: snapshotOf(diff, {
          truncated: true,
          diffOmissions: [{ path: 'src/dropped.ts', bytes: 4096, reason: 'total-budget' }],
        }),
      },
      diffPresentation: DEFAULT_DIFF_PRESENTATION_THRESHOLDS,
    });
    expect(prompt).toContain('src/dropped.ts');
  });

  it('未追跡ファイルも目次段階では参照先を指す', () => {
    const diff = largeDiff(60);
    const prompt = buildSecondOpinionPrompt({
      userRequest: 'レビューして',
      artifact: {
        kind: 'workspaceChanges',
        snapshot: snapshotOf(diff, {
          untrackedFiles: [{ path: 'src/new.ts', content: 'export const a = 1;\n', bytes: 20 }],
        }),
      },
      diffPresentation: DEFAULT_DIFF_PRESENTATION_THRESHOLDS,
    });
    expect(prompt).toContain('`untracked/src/new.ts`');
    expect(prompt).not.toContain('export const a = 1;');
  });

  it('差分が小さくても、未追跡ファイルが大きければそちらだけ参照先へ落とす', () => {
    const content = `export const a = '${'x'.repeat(4 * 20_000)}';\n`;
    const prompt = buildSecondOpinionPrompt({
      userRequest: 'レビューして',
      artifact: {
        kind: 'workspaceChanges',
        snapshot: snapshotOf(fileDiff('src/a.ts'), {
          untrackedFiles: [{ path: 'src/new.ts', content, bytes: content.length }],
        }),
      },
      diffPresentation: DEFAULT_DIFF_PRESENTATION_THRESHOLDS,
    });
    // 差分は小さいので本文へ貼ったまま
    expect(prompt).toContain('```diff');
    // 未追跡ファイルは中身ではなく参照先
    expect(prompt).toContain('`untracked/src/new.ts`');
    expect(prompt).not.toContain(content);
  });

  it('未追跡ファイルが小さければ本文へ貼ったままにする', () => {
    const prompt = buildSecondOpinionPrompt({
      userRequest: 'レビューして',
      artifact: {
        kind: 'workspaceChanges',
        snapshot: snapshotOf(fileDiff('src/a.ts'), {
          untrackedFiles: [{ path: 'src/new.ts', content: 'export const a = 1;\n', bytes: 20 }],
        }),
      },
      diffPresentation: DEFAULT_DIFF_PRESENTATION_THRESHOLDS,
    });
    expect(prompt).toContain('export const a = 1;');
  });

  it('目次のパスにバッククォートが混ざっても囲みが壊れない', () => {
    const diff = largeDiff(60) + fileDiff('src/`odd`.ts');
    const prompt = buildSecondOpinionPrompt({
      userRequest: 'レビューして',
      artifact: { kind: 'workspaceChanges', snapshot: snapshotOf(diff) },
      diffPresentation: DEFAULT_DIFF_PRESENTATION_THRESHOLDS,
    });
    // 中身に含まれる最長のバッククォート連（1連）より長い囲みになる
    expect(prompt).toContain('``src/`odd`.ts``');
  });
});

describe('createReviewBundle: untracked/（Issue #1322）', () => {
  let root: string;
  let cwd: string;

  const git: GitCommandRunner = {
    async run(): Promise<GitCommandResult> {
      return { code: 128, stdout: '', stderr: 'not found' };
    },
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'untracked-bundle-'));
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'untracked-cwd-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it('未追跡ファイルを untracked/ へ書き出し、資格情報は伏せ字にする', async () => {
    const bundle = await createReviewBundle({
      root,
      cwd,
      git,
      baseCommit: 'abc1234',
      fullDiff: fileDiff('src/a.ts'),
      changedPaths: [],
      untrackedFiles: [
        { path: 'src/new.ts', content: 'export const a = 1;\n', bytes: 20 },
        {
          path: 'nested/secret.ts',
          content: 'const token = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";\n',
          bytes: 56,
        },
      ],
    });
    try {
      const plain = await fs.readFile(path.join(bundle.dir, 'untracked/src/new.ts'), 'utf8');
      expect(plain).toBe('export const a = 1;\n');
      const secret = await fs.readFile(path.join(bundle.dir, 'untracked/nested/secret.ts'), 'utf8');
      expect(secret).not.toContain('ghp_0123456789abcdefghijklmnopqrstuvwxyz');
    } finally {
      await bundle.dispose();
    }
  });

  it('untracked/ の外を指すパスは書き出さない', async () => {
    const bundle = await createReviewBundle({
      root,
      cwd,
      git,
      baseCommit: 'abc1234',
      fullDiff: fileDiff('src/a.ts'),
      changedPaths: [],
      untrackedFiles: [{ path: '../escaped.ts', content: 'leak', bytes: 4 }],
    });
    try {
      await expect(fs.readFile(path.join(root, 'escaped.ts'), 'utf8')).rejects.toThrow();
      await expect(
        fs.readFile(path.join(path.dirname(bundle.dir), 'escaped.ts'), 'utf8'),
      ).rejects.toThrow();
    } finally {
      await bundle.dispose();
    }
  });

  it('未追跡ファイルを渡さなければ untracked/ を作らない', async () => {
    const bundle = await createReviewBundle({
      root,
      cwd,
      git,
      baseCommit: 'abc1234',
      fullDiff: fileDiff('src/a.ts'),
      changedPaths: [],
    });
    try {
      await expect(fs.stat(path.join(bundle.dir, 'untracked'))).rejects.toThrow();
    } finally {
      await bundle.dispose();
    }
  });
});
