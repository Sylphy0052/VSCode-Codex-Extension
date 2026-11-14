import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ASK_QUESTION_TOPIC_MAX_LENGTH,
  checkAskQuestionTopic,
  isAskQuestionFilePath,
  readAskQuestionTopic,
} from '../../src/webGpt/askQuestionFile';

describe('isAskQuestionFilePath', () => {
  const root = '/work/repo';

  it('docs/chatgpt/ask-<slug>.md（絶対・相対）と連番付きに一致する', () => {
    expect(isAskQuestionFilePath(root, '/work/repo/docs/chatgpt/ask-foo-bar.md')).toBe(true);
    expect(isAskQuestionFilePath(root, 'docs/chatgpt/ask-foo.md')).toBe(true);
    expect(isAskQuestionFilePath(root, '/work/repo/docs/chatgpt/ask-foo-2.md')).toBe(true);
    expect(isAskQuestionFilePath(root, '/work/repo/docs/chatgpt/ask-3d-model.md')).toBe(true);
  });

  it('それ以外のパスには一致しない', () => {
    for (const p of [
      '/work/repo/docs/chatgpt/notes.md',
      '/work/repo/docs/chatgpt/ask-.md',
      '/work/repo/docs/chatgpt/ask--x.md',
      '/work/repo/docs/chatgpt/ask-foo.txt',
      '/work/repo/docs/chatgpt/sub/ask-foo.md',
      '/work/repo/docs/other/ask-foo.md',
      '/work/repo/src/docs/chatgpt/ask-foo.md',
      '/work/repo/ask-foo.md',
      '',
    ]) {
      expect(isAskQuestionFilePath(root, p), p).toBe(false);
    }
  });

  it('リポジトリ外を指すパスには一致しない', () => {
    expect(isAskQuestionFilePath(root, '/other/docs/chatgpt/ask-foo.md')).toBe(false);
    expect(isAskQuestionFilePath(root, '/work/repo2/docs/chatgpt/ask-foo.md')).toBe(false);
    expect(isAskQuestionFilePath(root, '../other/docs/chatgpt/ask-foo.md')).toBe(false);
    expect(isAskQuestionFilePath(root, 'docs/chatgpt/../../../x/docs/chatgpt/ask-foo.md')).toBe(
      false,
    );
  });
});

describe('checkAskQuestionTopic', () => {
  it('12000文字ちょうどは通し、12001文字は超過字数を示して断る', () => {
    const ok = checkAskQuestionTopic('あ'.repeat(ASK_QUESTION_TOPIC_MAX_LENGTH));
    expect(ok).toEqual({ ok: true, topic: 'あ'.repeat(12000) });
    const ng = checkAskQuestionTopic('あ'.repeat(ASK_QUESTION_TOPIC_MAX_LENGTH + 1));
    expect(ng.ok).toBe(false);
    if (!ng.ok) expect(ng.message).toContain('1文字超えています');
  });

  it('末尾の改行は字数に数えない。空は断る', () => {
    expect(checkAskQuestionTopic('a'.repeat(12000) + '\n').ok).toBe(true);
    expect(checkAskQuestionTopic(' \n').ok).toBe(false);
  });
});

describe('readAskQuestionTopic', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ask-q-'));
    await mkdir(join(root, 'docs', 'chatgpt'), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('本文を議題として返す', async () => {
    const file = join(root, 'docs', 'chatgpt', 'ask-a.md');
    await writeFile(file, '# 質問\n本文\n');
    expect(await readAskQuestionTopic([root], file)).toEqual({
      ok: true,
      topic: '# 質問\n本文',
      absolutePath: file,
    });
  });

  it('読めない・シンボリックリンク・対象外は理由付きで断る', async () => {
    const missing = await readAskQuestionTopic([root], join(root, 'docs', 'chatgpt', 'ask-x.md'));
    expect(missing.ok).toBe(false);
    await writeFile(join(root, 'secret.txt'), 'x');
    const link = join(root, 'docs', 'chatgpt', 'ask-link.md');
    await symlink(join(root, 'secret.txt'), link);
    const linked = await readAskQuestionTopic([root], link);
    expect(linked.ok).toBe(false);
    const outside = await readAskQuestionTopic([root], join(root, 'docs', 'ask-a.md'));
    expect(outside.ok).toBe(false);
  });

  it('12001文字のファイルは送らず超過字数を返す', async () => {
    const file = join(root, 'docs', 'chatgpt', 'ask-big.md');
    await writeFile(file, 'a'.repeat(12001));
    const r = await readAskQuestionTopic([root], file);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('1文字超えています');
  });
});
