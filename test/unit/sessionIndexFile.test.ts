import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claudeSessionIndexFilePath,
  readSessionIndexFileSync,
  reconcileLegacyIndex,
  writeSessionIndexFile,
} from '../../src/claude/sessionIndexFile';
import {
  CLAUDE_SESSION_INDEX_KEY,
  type ClaudeSessionIndexEntry,
} from '../../src/claude/sessionIndex';
import type { MementoLike } from '../../src/util/memento';

const SHA = 'a'.repeat(64);

function entry(
  id: string,
  overrides: Partial<ClaudeSessionIndexEntry> = {},
): ClaudeSessionIndexEntry {
  return {
    filePath: `/home/u/.claude/projects/p/${id}.jsonl`,
    mtimeMs: 1000,
    size: 10,
    ino: 5,
    session: {
      id,
      provider: 'claude',
      threadName: undefined,
      updatedAt: '2026-10-01T00:00:00.000Z',
      cwd: undefined,
      archived: false,
    },
    ...overrides,
  };
}

/** schema版1のファイルとして、任意のentriesをそのまま書く（型を通さず壊れた値を入れるため） */
function persisted(entries: unknown[], version: unknown = 1): string {
  return JSON.stringify({ version, entries });
}

function fakeMemento(initial: ClaudeSessionIndexEntry[] | undefined): {
  memento: MementoLike;
  update: ReturnType<typeof vi.fn>;
} {
  const update = vi.fn(() => Promise.resolve());
  const memento: MementoLike = {
    get: <T>(key: string, defaultValue: T): T =>
      key === CLAUDE_SESSION_INDEX_KEY && initial !== undefined ? (initial as T) : defaultValue,
    update,
  };
  return { memento, update };
}

describe('sessionIndexFile', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'session-index-file-test-'));
    filePath = claudeSessionIndexFilePath(dir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  describe('claudeSessionIndexFilePath', () => {
    it('保存先ディレクトリ配下の固定ファイル名を返す', () => {
      expect(claudeSessionIndexFilePath('/g/storage')).toBe(
        join('/g/storage', 'claude-session-index.json'),
      );
    });
  });

  describe('readSessionIndexFileSync', () => {
    it('ファイルが無ければ空配列を返す', () => {
      expect(readSessionIndexFileSync(filePath)).toEqual([]);
    });

    it('writeSessionIndexFileで書いた内容をそのまま読み戻せる', async () => {
      const entries = [
        entry('s1', { head: { bytes: 128, sha256: SHA } }),
        entry('s2', { mtimeMs: undefined }),
      ];
      await writeSessionIndexFile(filePath, entries);

      const read = readSessionIndexFileSync(filePath);
      expect(read).toHaveLength(2);
      expect(read[0]).toEqual(entries[0]);
      expect(read[1]?.session.id).toBe('s2');
      expect(read[1]?.mtimeMs).toBeUndefined();
    });

    it('JSONとして壊れていれば空配列を返す', async () => {
      await writeFile(filePath, '{"version":1,"entries":[', 'utf8');
      expect(readSessionIndexFileSync(filePath)).toEqual([]);
    });

    it('トップレベルがオブジェクトでなければ空配列を返す', async () => {
      await writeFile(filePath, '42', 'utf8');
      expect(readSessionIndexFileSync(filePath)).toEqual([]);
      await writeFile(filePath, 'null', 'utf8');
      expect(readSessionIndexFileSync(filePath)).toEqual([]);
    });

    it('schema版が一致しなければ読み捨てて空配列を返す', async () => {
      await writeFile(filePath, persisted([entry('s1')], 2), 'utf8');
      expect(readSessionIndexFileSync(filePath)).toEqual([]);
    });

    it('entriesが配列でなければ空配列を返す', async () => {
      await writeFile(filePath, JSON.stringify({ version: 1, entries: { a: 1 } }), 'utf8');
      expect(readSessionIndexFileSync(filePath)).toEqual([]);
    });

    it('妥当でないエントリだけを読み捨てる', async () => {
      const good = entry('good');
      const bad = [
        null,
        'text',
        { ...good, filePath: '' },
        { ...good, filePath: 1 },
        { ...good, mtimeMs: 'x' },
        { ...good, session: null },
        { ...good, session: 'x' },
        { ...good, session: { ...good.session, id: '' } },
        { ...good, session: { ...good.session, id: 1 } },
        { ...good, session: { ...good.session, provider: 'codex' } },
        { ...good, session: { ...good.session, updatedAt: 1 } },
        { ...good, session: { ...good.session, archived: 'no' } },
      ];
      await writeFile(filePath, persisted([bad[0], good, ...bad.slice(1)]), 'utf8');

      const read = readSessionIndexFileSync(filePath);
      expect(read).toHaveLength(1);
      expect(read[0]?.session.id).toBe('good');
    });

    it('mtimeMsが無いエントリは妥当として残す', async () => {
      const noMtime: Partial<ClaudeSessionIndexEntry> = entry('s1');
      delete noMtime.mtimeMs;
      await writeFile(filePath, persisted([noMtime]), 'utf8');
      expect(readSessionIndexFileSync(filePath)).toHaveLength(1);
    });

    it('size/ino/headが揃って妥当なら同じ内容のまま返す', async () => {
      const e = entry('s1', { size: 99, ino: 7, head: { bytes: 64, sha256: SHA } });
      await writeFile(filePath, persisted([e]), 'utf8');
      expect(readSessionIndexFileSync(filePath)).toEqual([e]);
    });

    it('sizeとinoが数値でなければ未設定へ落とし、他の項目は残す', async () => {
      await writeFile(filePath, persisted([{ ...entry('s1'), size: '10', ino: null }]), 'utf8');
      const [read] = readSessionIndexFileSync(filePath);
      expect(read?.size).toBeUndefined();
      expect(read?.ino).toBeUndefined();
      expect(read?.mtimeMs).toBe(1000);
      expect(read?.session.id).toBe('s1');
    });

    it.each([
      ['オブジェクトでない', 'x'],
      ['nullである', null],
      ['空オブジェクトである', {}],
      ['bytesが数値でない', { bytes: '1', sha256: SHA }],
      ['bytesが整数でない', { bytes: 1.5, sha256: SHA }],
      ['bytesが0以下', { bytes: 0, sha256: SHA }],
      ['bytesが安全な整数の範囲外', { bytes: Number.MAX_SAFE_INTEGER + 2, sha256: SHA }],
      ['sha256が文字列でない', { bytes: 1, sha256: 5 }],
      ['sha256が64桁のhexでない', { bytes: 1, sha256: 'xyz' }],
      ['sha256に大文字が混じる', { bytes: 1, sha256: 'A'.repeat(64) }],
    ])('headが%sなら未設定へ落とす', async (_name, head) => {
      await writeFile(filePath, persisted([{ ...entry('s1'), head }]), 'utf8');
      const [read] = readSessionIndexFileSync(filePath);
      expect(read?.head).toBeUndefined();
      expect(read?.session.id).toBe('s1');
    });
  });

  describe('writeSessionIndexFile', () => {
    it('存在しない親ディレクトリを作って書く', async () => {
      const nested = join(dir, 'a', 'b', 'index.json');
      await writeSessionIndexFile(nested, [entry('s1')]);

      const parsed = JSON.parse(await readFile(nested, 'utf8')) as {
        version: number;
        entries: ClaudeSessionIndexEntry[];
      };
      expect(parsed.version).toBe(1);
      expect(parsed.entries.map((e) => e.session.id)).toEqual(['s1']);
    });

    it('既存ファイルを全量で置き換え、一時ファイルを残さない', async () => {
      await writeSessionIndexFile(filePath, [entry('old1'), entry('old2')]);
      await writeSessionIndexFile(filePath, [entry('new')]);

      expect(readSessionIndexFileSync(filePath).map((e) => e.session.id)).toEqual(['new']);
      expect(await readdir(dir)).toEqual(['claude-session-index.json']);
    });

    it('空配列でも書ける', async () => {
      await writeSessionIndexFile(filePath, []);
      expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({ version: 1, entries: [] });
    });

    it('親パスがファイルで作れなければ例外を投げる', async () => {
      const blocker = join(dir, 'blocker');
      await writeFile(blocker, 'x', 'utf8');
      await expect(writeSessionIndexFile(join(blocker, 'index.json'), [])).rejects.toMatchObject({
        code: 'EEXIST',
      });
    });
  });

  describe('reconcileLegacyIndex', () => {
    it('旧キーが無ければ何もしない', async () => {
      const { memento, update } = fakeMemento(undefined);
      await reconcileLegacyIndex(filePath, memento, false);

      expect(update).not.toHaveBeenCalled();
      expect(readSessionIndexFileSync(filePath)).toEqual([]);
    });

    it('ファイルが空なら旧キーからファイルを作り、検証して旧キーを消す', async () => {
      const keep = entry('keep');
      const noPath = entry('nopath', { filePath: '' });
      const foreign = entry('foreign');
      foreign.session = { ...foreign.session, provider: 'codex' };
      const { memento, update } = fakeMemento([keep, noPath, foreign]);

      await reconcileLegacyIndex(filePath, memento, false);

      expect(readSessionIndexFileSync(filePath).map((e) => e.session.id)).toEqual(['keep']);
      expect(update).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledWith(CLAUDE_SESSION_INDEX_KEY, undefined);
    });

    it('ファイルに既にエントリがあれば上書きせず、検証だけして旧キーを消す', async () => {
      await writeSessionIndexFile(filePath, [entry('fromFile')]);
      const { memento, update } = fakeMemento([entry('legacy')]);

      await reconcileLegacyIndex(filePath, memento, true);

      expect(readSessionIndexFileSync(filePath).map((e) => e.session.id)).toEqual(['fromFile']);
      expect(update).toHaveBeenCalledWith(CLAUDE_SESSION_INDEX_KEY, undefined);
    });

    it('ファイルがあるはずなのに読めなければ旧キーを残す', async () => {
      const { memento, update } = fakeMemento([entry('legacy')]);

      await reconcileLegacyIndex(filePath, memento, true);

      expect(update).not.toHaveBeenCalled();
    });

    it.each([
      ['JSONが壊れている', '{broken'],
      ['トップレベルが配列でも版が無い', '[]'],
      ['nullである', 'null'],
      ['数値である', '7'],
      ['schema版が違う', persisted([], 2)],
      ['entriesが配列でない', JSON.stringify({ version: 1, entries: 'x' })],
    ])('検証読み戻しで%sなら旧キーを残す', async (_name, content) => {
      await writeFile(filePath, content, 'utf8');
      const { memento, update } = fakeMemento([entry('legacy')]);

      await reconcileLegacyIndex(filePath, memento, true);

      expect(update).not.toHaveBeenCalled();
    });

    it('各エントリが妥当でなくても、schemaが読めれば旧キーを消す', async () => {
      await writeFile(filePath, persisted([{ junk: true }]), 'utf8');
      const { memento, update } = fakeMemento([entry('legacy')]);

      await reconcileLegacyIndex(filePath, memento, true);

      expect(update).toHaveBeenCalledWith(CLAUDE_SESSION_INDEX_KEY, undefined);
    });

    it('旧キーが空配列でも、空のファイルを作って旧キーを消す', async () => {
      const { memento, update } = fakeMemento([]);

      await reconcileLegacyIndex(filePath, memento, false);

      expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({ version: 1, entries: [] });
      expect(update).toHaveBeenCalledWith(CLAUDE_SESSION_INDEX_KEY, undefined);
    });

    it('ファイルの書き込みに失敗したら例外を伝え、旧キーは消さない', async () => {
      const blocker = join(dir, 'blocker');
      await writeFile(blocker, 'x', 'utf8');
      const { memento, update } = fakeMemento([entry('legacy')]);

      await expect(
        reconcileLegacyIndex(join(blocker, 'index.json'), memento, false),
      ).rejects.toMatchObject({ code: 'EEXIST' });
      expect(update).not.toHaveBeenCalled();
    });
  });
});
