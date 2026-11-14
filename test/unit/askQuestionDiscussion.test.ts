import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ChatItem } from '../../src/appserver/chatState';
import { prepareAskQuestionDiscussion } from '../../src/view/askQuestionDiscussion';
import { __mock } from '../mocks/vscode';

function fileChange(id: string, path: string, kind: 'add' | 'update' = 'add'): ChatItem {
  return { id, kind: 'fileChange', diffs: [{ path, kind }] } as unknown as ChatItem;
}

describe('prepareAskQuestionDiscussion（Issue #2057）', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ask-d-'));
    await mkdir(join(root, 'docs', 'chatgpt'), { recursive: true });
    __mock.messages.warnings.length = 0;
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('質問ファイルの作成項目なら、本文を固定議題として返し、プレビューを開く', async () => {
    const file = join(root, 'docs', 'chatgpt', 'ask-x.md');
    await writeFile(file, '  議題の本文\n');
    const opened = __mock.openedTextDocumentPaths.length;

    const options = await prepareAskQuestionDiscussion([fileChange('a', file)], 'a', [root]);

    expect(options).toEqual({ fixedTopic: '議題の本文' });
    expect(__mock.openedTextDocumentPaths.slice(opened)).toEqual([file]);
  });

  it('idが文字列でない・項目が無い・addの差分が無いときは、理由を出して起動しない', async () => {
    const file = join(root, 'docs', 'chatgpt', 'ask-x.md');
    await writeFile(file, '本文');
    const items = [fileChange('a', file), fileChange('u', file, 'update')];

    expect(await prepareAskQuestionDiscussion(items, 42, [root])).toBeUndefined();
    expect(await prepareAskQuestionDiscussion(items, 'none', [root])).toBeUndefined();
    expect(await prepareAskQuestionDiscussion(items, 'u', [root])).toBeUndefined();
    expect(__mock.messages.warnings).toHaveLength(3);
  });

  it('作業フォルダ外・対象外のパスや読めないファイルは、読まずに断る', async () => {
    const outside = join(root, 'docs', 'other.md');
    const missing = join(root, 'docs', 'chatgpt', 'ask-none.md');
    const items = [fileChange('o', outside), fileChange('m', missing)];

    expect(await prepareAskQuestionDiscussion(items, 'o', [root])).toBeUndefined();
    expect(await prepareAskQuestionDiscussion(items, 'm', [root])).toBeUndefined();
    expect(__mock.messages.warnings).toHaveLength(2);
    expect(__mock.messages.warnings.every((m) => m.includes('議論を始められません'))).toBe(true);
  });
});
