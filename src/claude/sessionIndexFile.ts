import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { MementoLike } from '../util/memento';
import { CLAUDE_SESSION_INDEX_KEY, type ClaudeSessionIndexEntry } from './sessionIndex';

/**
 * 索引ファイルのschema版（Issue #1460）。
 *
 * 形式を変えたら上げる。読み込み側は版が一致しないファイルを読み捨てて空を返す。
 * 索引は`~/.claude/projects`から作り直せるキャッシュなので、読み捨てても走査し直せば戻る。
 */
const SCHEMA_VERSION = 1;

const FILE_NAME = 'claude-session-index.json';

interface PersistedIndexFile {
  version: number;
  entries: ClaudeSessionIndexEntry[];
}

/** 索引ファイルの置き場所。`context.globalStorageUri`配下（ウィンドウ間で配信されない、Issue #1460）。 */
export function claudeSessionIndexFilePath(globalStorageDir: string): string {
  return join(globalStorageDir, FILE_NAME);
}

function isValidEntry(value: unknown): value is ClaudeSessionIndexEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.filePath !== 'string' || entry.filePath === '') {
    return false;
  }
  if (entry.mtimeMs !== undefined && typeof entry.mtimeMs !== 'number') {
    return false;
  }
  const session = entry.session;
  if (typeof session !== 'object' || session === null) {
    return false;
  }
  const s = session as Record<string, unknown>;
  return (
    typeof s.id === 'string' &&
    s.id !== '' &&
    s.provider === 'claude' &&
    typeof s.updatedAt === 'string' &&
    typeof s.archived === 'boolean'
  );
}

/** JSONを索引エントリの配列へ解釈する。壊れている・schemaが古いときは空を返す。 */
function parsePersisted(raw: string): ClaudeSessionIndexEntry[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return [];
    }
    const file = parsed as Partial<PersistedIndexFile>;
    if (file.version !== SCHEMA_VERSION || !Array.isArray(file.entries)) {
      return [];
    }
    return file.entries.filter(isValidEntry);
  } catch {
    return [];
  }
}

/** 起動時の同期読み込み用。小さな1ファイルなので、コンストラクタから直接呼べる。 */
export function readSessionIndexFileSync(filePath: string): ClaudeSessionIndexEntry[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  return parsePersisted(raw);
}

/** 書き込み直後の検証読み戻し用（Issue #1460 移行手順の3.）。 */
export async function readSessionIndexFile(filePath: string): Promise<ClaudeSessionIndexEntry[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return [];
  }
  return parsePersisted(raw);
}

/**
 * 一時ファイル経由で全量を置き換える（Issue #1460）。
 *
 * read-modify-writeはしない。呼び出し側が自分のメモリ上の索引の全量を渡す。
 * 複数ウィンドウが同時に呼んでも、最後に`rename`した内容が残るだけで壊れない。
 */
export async function writeSessionIndexFile(
  filePath: string,
  entries: readonly ClaudeSessionIndexEntry[],
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const payload: PersistedIndexFile = { version: SCHEMA_VERSION, entries: [...entries] };
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(payload), 'utf8');
  await rename(tmp, filePath);
}

/**
 * globalStateの旧キー（`CLAUDE_SESSION_INDEX_KEY`）からファイルへ移す（Issue #1460）。
 *
 * 手順: 旧キーを読む → tmp経由でファイルへ書く → 読み戻して検証する → 件数が一致した
 * ときだけ旧キーを`undefined`で消す。検証できなければ旧キーは残す（次回起動でやり直す）。
 * 呼び出し側は起動をブロックしないよう、この関数の完了を待たずに進んでよい。
 */
export async function migrateLegacyIndex(filePath: string, memento: MementoLike): Promise<void> {
  const legacy = memento
    .get<ClaudeSessionIndexEntry[]>(CLAUDE_SESSION_INDEX_KEY, [])
    .filter((entry) => entry.filePath !== '' && entry.session.provider === 'claude');
  if (legacy.length === 0) {
    return;
  }
  await writeSessionIndexFile(filePath, legacy);
  const verified = await readSessionIndexFile(filePath);
  if (verified.length === legacy.length) {
    await memento.update(CLAUDE_SESSION_INDEX_KEY, undefined);
  }
}
