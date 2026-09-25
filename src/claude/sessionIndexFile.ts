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

/**
 * `size`/`ino` は数値でなければ未設定扱いに落とす（Issue #1460レビュー指摘）。
 * どちらも `canSkipHeadRead` の安全側フォールバック（未設定なら先頭を読み直す）に
 * 乗るだけなので、エントリ全体を捨てずに済む。
 */
function sanitizeEntry(entry: ClaudeSessionIndexEntry): ClaudeSessionIndexEntry {
  const size = typeof entry.size === 'number' ? entry.size : undefined;
  const ino = typeof entry.ino === 'number' ? entry.ino : undefined;
  if (size === entry.size && ino === entry.ino) {
    return entry;
  }
  return { ...entry, size, ino };
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
    return file.entries.filter(isValidEntry).map(sanitizeEntry);
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

/**
 * 書き込み直後の検証読み戻し用（Issue #1460 旧キー削除の可否判定）。
 *
 * 各エントリの意味的な妥当性（`isValidEntry`）までは見ない。索引は作り直せるキャッシュ
 * なので、トップレベルのschema（版・配列であること）さえ壊れていなければ十分とする
 * （レビュー指摘: 件数の完全一致を求めると、書き込みと検証の間に他ウィンドウの書き込みが
 * 割り込んだだけで旧キーが永久に残ってしまう）。
 */
async function verifySessionIndexFile(filePath: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return false;
    }
    const file = parsed as Partial<PersistedIndexFile>;
    return file.version === SCHEMA_VERSION && Array.isArray(file.entries);
  } catch {
    return false;
  }
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
 * globalStateの旧キー（`CLAUDE_SESSION_INDEX_KEY`）を片付ける（Issue #1460）。
 *
 * ファイルの有無だけで移行要否を決めない（レビュー指摘: 一度検証に失敗すると、次回起動時
 * ファイルが既にあるので移行分岐へ二度と入らず、旧キーが1MB近く残ったままになる）。
 * 旧キーがまだ残っている限り、起動のたびに毎回この関数を呼ぶ。
 *
 * - ファイルに既にエントリがある（`fileHasEntries`）→ ファイルを正として使う。上書きせず
 *   検証だけして旧キーを消す
 * - ファイルが無い・空 → 旧キーからファイルを作り、検証してから旧キーを消す
 *
 * 検証は件数の完全一致を求めない（schema的に読めれば十分。索引は作り直せるキャッシュ）。
 * 呼び出し側は起動をブロックしないよう、この関数の完了を待たずに進んでよい。
 */
export async function reconcileLegacyIndex(
  filePath: string,
  memento: MementoLike,
  fileHasEntries: boolean,
): Promise<void> {
  const legacyRaw = memento.get<ClaudeSessionIndexEntry[] | undefined>(CLAUDE_SESSION_INDEX_KEY, undefined);
  if (legacyRaw === undefined) {
    return; // 旧キー自体が無い
  }
  if (!fileHasEntries) {
    const legacy = legacyRaw.filter((entry) => entry.filePath !== '' && entry.session.provider === 'claude');
    await writeSessionIndexFile(filePath, legacy);
  }
  if (await verifySessionIndexFile(filePath)) {
    await memento.update(CLAUDE_SESSION_INDEX_KEY, undefined);
  }
}
