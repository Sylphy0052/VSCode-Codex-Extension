import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';

import { isPathWithinRoot } from './escalation';

/**
 * gitの作業ツリーでないワークスペースでの隔離（design.md §16.20 / Issue #96）。
 *
 * `worktree.ts` は `git worktree` を使って隔離するが、gitが無い場合は同じ手段が使えない。
 * 代わりにディレクトリを丸ごと複製し、タスク終了時にスナップショットとの差分（追加・変更・
 * 削除）だけを統合先（`<runId>/_integration`）へ適用する。3-way mergeはできないため、
 * 同じファイルが既に別タスクによって統合済みなら内容を見ずに衝突として扱う。
 *
 * `worktree.ts` と同じく、VSCode APIには依存しない。ファイルシステム操作は
 * `PseudoWorktreeFileSystemPort` 越しに行い、テストではフェイクに差し替える。
 * 差分の計算・衝突の判定・除外の判定は純粋関数として切り出し、`worktree.ts` の
 * `decideWorkingDirectory` 等と同じ流儀を踏襲する。
 *
 * **`.agents/worktrees` がシンボリックリンクの脅威はここにも当てはまる。** `worktree.ts` の
 * コメント（design.md §16.6「`.agents/worktrees` がシンボリックリンクの場合」）が指摘する
 * 攻撃面——リポジトリの中身（cloneするだけで手に入るシンボリックリンク）が複製先・統合先の
 * 実体をリポジトリの外へずらせてしまう——は、gitの有無を問わず文字列結合でパスを組み立てる
 * 限り同じように成立する。`worktree.ts` と同じ二段構え（一次防御: 作成前の祖先ディレクトリの
 * シンボリックリンク検知、二次防御: 作成後の実パス解決による境界確認）をここでも行う。
 */

// ---------------------------------------------------------------------------
// スナップショット・差分・統合計画（純粋関数）
// ---------------------------------------------------------------------------

/** 1ファイルのスナップショット（サイズ・更新時刻）。design.md §16.20。 */
export interface SnapshotEntry {
  size: number;
  mtimeMs: number;
}

/** ルートからの相対パス（POSIX区切りに正規化済み）をキーにしたスナップショット。 */
export type Snapshot = ReadonlyMap<string, SnapshotEntry>;

export type DiffKind = 'added' | 'modified' | 'deleted';

export interface DiffEntry {
  /** ルートからの相対パス（POSIX区切り）。 */
  path: string;
  kind: DiffKind;
}

/**
 * 2つのスナップショットから追加・変更・削除の差分を計算する純粋関数。
 * 変更の判定はサイズまたは更新時刻(mtimeMs)のいずれかが異なる場合とする
 * （design.md §16.20「ファイル一覧とサイズ・更新時刻をスナップショットとして持つ」）。
 * 内容（ハッシュ・バイト比較）までは見ない。gitの無いワークスペースでハッシュ計算は
 * コストが無視できず、mtime+sizeでも実用上十分なため（design.mdの制約どおり、
 * 3-way mergeができない前提を前提にしている）。
 *
 * 戻り値はパスの昇順に整列する（呼び出し側の表示・テストを安定させるため）。
 */
export function diffSnapshots(baseline: Snapshot, current: Snapshot): DiffEntry[] {
  const entries: DiffEntry[] = [];
  for (const [entryPath, cur] of current) {
    const base = baseline.get(entryPath);
    if (base === undefined) {
      entries.push({ path: entryPath, kind: 'added' });
    } else if (base.size !== cur.size || base.mtimeMs !== cur.mtimeMs) {
      entries.push({ path: entryPath, kind: 'modified' });
    }
  }
  for (const entryPath of baseline.keys()) {
    if (!current.has(entryPath)) {
      entries.push({ path: entryPath, kind: 'deleted' });
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/** 統合先で各パスを最後に書いたタスクとその変更種別。 */
export interface IntegrationManifestEntry {
  taskId: string;
  kind: DiffKind;
}

/** 統合先の現在の状態（相対パス→最後に書いたタスク）。 */
export type IntegrationManifest = ReadonlyMap<string, IntegrationManifestEntry>;

export interface ConflictEntry {
  path: string;
  kind: DiffKind;
  /** 先に統合済みの、衝突相手のタスクid。 */
  conflictingTaskId: string;
}

export interface IntegrationPlan {
  /** 衝突なく適用してよい差分。 */
  toApply: DiffEntry[];
  /** 衝突として弾かれた差分（内容のマージはしない。両方の版をそのまま残す）。 */
  conflicts: ConflictEntry[];
  /** `toApply` を適用した後のマニフェスト。呼び出し側は次回の判定にこれを使い回す。 */
  manifest: IntegrationManifest;
}

/**
 * タスク1件分の差分を統合先へ適用してよいかを判定する純粋関数（design.md §16.20）。
 *
 * 同じパスが既に「別のタスク」によって統合先へ書かれていれば衝突として弾く。
 * 同じタスクが同じパスを2回適用しようとした場合（リトライ等）は衝突にしない
 * （所有者が自分自身なら上書きしてよい）。3-way mergeは行わず、内容は一切見ない。
 * ファイルシステムへは触れず、適用してよい一覧と更新後のマニフェストを返すだけ。
 * 実際の適用（ファイルのコピー）は `applyDiffToIntegration` が担う。
 */
export function planIntegration(
  taskId: string,
  diff: readonly DiffEntry[],
  manifest: IntegrationManifest,
): IntegrationPlan {
  const toApply: DiffEntry[] = [];
  const conflicts: ConflictEntry[] = [];
  const nextManifest = new Map(manifest);
  for (const entry of diff) {
    const existing = manifest.get(entry.path);
    if (existing !== undefined && existing.taskId !== taskId) {
      conflicts.push({
        path: entry.path,
        kind: entry.kind,
        conflictingTaskId: existing.taskId,
      });
      continue;
    }
    toApply.push(entry);
    nextManifest.set(entry.path, { taskId, kind: entry.kind });
  }
  return { toApply, conflicts, manifest: nextManifest };
}

/**
 * マニフェストをJSON文字列へ直列化する。統合ディレクトリは差分（追加・変更されたファイル）
 * しか持たない疎な構成のため、「どのパスが誰によってどう変更されたか」という情報自体は
 * ファイルシステムの実体だけからは復元できない。永続化・プロセス再起動をまたいだ復元
 * （design.md §16.11の対象。呼び出し側が行う）のために、明示的な直列化手段を用意する。
 */
export function serializeManifest(manifest: IntegrationManifest): string {
  return JSON.stringify(Object.fromEntries(manifest), null, 2);
}

/** `serializeManifest` の逆変換。壊れたJSONは空のマニフェストとして扱う（安全側）。 */
export function deserializeManifest(json: string): IntegrationManifest {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) {
      return new Map();
    }
    const result = new Map<string, IntegrationManifestEntry>();
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as { taskId?: unknown }).taskId === 'string' &&
        typeof (value as { kind?: unknown }).kind === 'string'
      ) {
        const kind = (value as { kind: string }).kind;
        if (kind === 'added' || kind === 'modified' || kind === 'deleted') {
          result.set(key, { taskId: (value as { taskId: string }).taskId, kind });
        }
      }
    }
    return result;
  } catch {
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// 除外判定
// ---------------------------------------------------------------------------

/**
 * 設定 `agent.workflows.pseudoWorktreeExclude` の既定値（design.md §16.20）。
 * `package.json` の `contributes.configuration` に同じ配列をリテラルで持つ
 * （設定スキーマはJSONで書く必要があり、ここから直接参照できないための重複。
 * 値を変える場合は両方を合わせて直すこと）。
 */
export const DEFAULT_PSEUDO_WORKTREE_EXCLUDE = ['node_modules', '.venv', 'dist', 'out'] as const;

/** `.agents/worktrees` 自身の相対パス（POSIX区切り）。複製が無限に再帰するのを防ぐため常に除外する。 */
const WORKTREES_ROOT_RELATIVE = '.agents/worktrees';

/**
 * 複製元からの相対パス（`/` 区切りに正規化済み）が除外対象かどうかを判定する純粋関数。
 *
 * 除外するのは2種類:
 * 1. `.agents/worktrees` 自身とその配下（無限再帰の防止。design.md §16.20）
 * 2. `exclude` に含まれる名前のディレクトリ・ファイル（深さを問わずパスの
 *    どこかのセグメントが一致すれば対象。`node_modules` が `packages/foo/node_modules`
 *    のように深い位置にあっても効くようにするため）
 */
export function isExcludedPath(relativePath: string, exclude: readonly string[]): boolean {
  const normalized = relativePath.split(path.sep).join('/');
  if (
    normalized === WORKTREES_ROOT_RELATIVE ||
    normalized.startsWith(`${WORKTREES_ROOT_RELATIVE}/`)
  ) {
    return true;
  }
  const segments = normalized.split('/');
  return segments.some((segment) => exclude.includes(segment));
}

// ---------------------------------------------------------------------------
// 識別子の検証（worktree.tsのRUN_ID_PATTERNと同じ理由で複製）
// ---------------------------------------------------------------------------

/**
 * `runId` の字種（UUID）。`worktree.ts` の `RUN_ID_PATTERN` と同じ正規表現だが、あえて
 * 複製している。両モジュールは互いをimportしない構造にしてあり（循環を避けるため）、
 * 「形式がUUIDである」という要件はdesign.md由来でどちらのモジュールにも共通して課される
 * ものなので、意味の異なるモジュール間の結合を避けてここでも複製する
 * （`worktree.ts` 自身のコメントと同じ方針）。
 */
const RUN_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * `taskId` の字種。`workflow.ts` の `TASK_ID_PATTERN` と同じ正規表現をここでも複製する
 * （このファイルは `workflow.ts` をimportしない。`worktree.ts` は直接importして共有して
 * いるが、循環の心配が無いことを個別に確認する手間を避け、`RUN_ID_PATTERN` と対称な方針で
 * 統一する）。
 */
const TASK_ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,49}$/;

/** 統合先ディレクトリのタスクid相当の固定名。design.md §16.17「`_integration` はタスクidとして予約する」。 */
const INTEGRATION_DIR_NAME = '_integration';

function runIdError(runId: string): string | undefined {
  return RUN_ID_PATTERN.test(runId) ? undefined : `不正なrunId（UUID形式ではありません）: ${runId}`;
}

function identifierError(runId: string, taskId: string): string | undefined {
  const runIdMessage = runIdError(runId);
  if (runIdMessage !== undefined) {
    return runIdMessage;
  }
  if (!TASK_ID_PATTERN.test(taskId)) {
    return `不正なtaskId（許可されない文字を含みます）: ${taskId}`;
  }
  return undefined;
}

function assertValidIdentifiers(runId: string, taskId: string): void {
  const message = identifierError(runId, taskId);
  if (message !== undefined) {
    throw new Error(message);
  }
}

// ---------------------------------------------------------------------------
// パスの組み立て
// ---------------------------------------------------------------------------

/** 疑似worktreeを置くディレクトリ。gitの場合（`worktree.ts` の `worktreesRootDir`）と同じ置き場。 */
export function pseudoWorktreesRootDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.agents', 'worktrees');
}

/** タスク1件分の複製先の絶対パス。`<workspace>/.agents/worktrees/<runId>/<taskId>`（design.md §16.20）。 */
export function pseudoWorktreePath(workspaceRoot: string, runId: string, taskId: string): string {
  assertValidIdentifiers(runId, taskId);
  return path.join(pseudoWorktreesRootDir(workspaceRoot), runId, taskId);
}

/** 統合先の絶対パス。`<runId>/_integration`（design.md §16.20 / §16.17）。 */
export function integrationPath(workspaceRoot: string, runId: string): string {
  const message = runIdError(runId);
  if (message !== undefined) {
    throw new Error(message);
  }
  return path.join(pseudoWorktreesRootDir(workspaceRoot), runId, INTEGRATION_DIR_NAME);
}

// ---------------------------------------------------------------------------
// ファイルシステムポート
// ---------------------------------------------------------------------------

export interface PseudoWorktreeDirEntry {
  name: string;
  isDirectory: boolean;
  /** シンボリックリンクかどうか（`lstat`相当。辿らない）。 */
  isSymbolicLink: boolean;
}

export interface PseudoWorktreeFileStat {
  size: number;
  mtimeMs: number;
}

/**
 * ファイルシステムへのアクセスの抽象。`worktree.ts` の `WorktreeFileSystemPort` と同じ考え方で、
 * 複製・スナップショット・差分適用に要る操作だけに絞る。
 */
export interface PseudoWorktreeFileSystemPort {
  /** ディレクトリのエントリ一覧。存在しない・読めない場合は空配列を返す。 */
  readdir(target: string): Promise<readonly PseudoWorktreeDirEntry[]>;
  /** 通常ファイルのサイズ・更新時刻。存在しない・ディレクトリ・シンボリックリンクの場合は undefined。 */
  statFile(target: string): Promise<PseudoWorktreeFileStat | undefined>;
  /** `target` そのものがシンボリックリンクか（`lstat`。辿らない）。存在しなければ `false`。 */
  isSymbolicLink(target: string): Promise<boolean>;
  /** `target` がディレクトリとして存在するか（`lstat`。シンボリックリンクは含まない）。 */
  directoryExists(target: string): Promise<boolean>;
  /** シンボリックリンクを解決した実パス。存在しなければ undefined。 */
  realpath(target: string): Promise<string | undefined>;
  /** ディレクトリを再帰的に作る（既に存在していてもエラーにしない）。 */
  mkdir(target: string): Promise<void>;
  /** ファイルを複製する（親ディレクトリは呼び出し側が事前に作る）。 */
  copyFile(from: string, to: string): Promise<void>;
  /** ファイルを削除する。存在しなくてもエラーにしない。 */
  removeFile(target: string): Promise<void>;
  /** ディレクトリを再帰的に削除する。存在しなくてもエラーにしない（境界逸脱時の後始末専用）。 */
  removeDirRecursive(target: string): Promise<void>;
}

export const nodePseudoWorktreeFileSystem: PseudoWorktreeFileSystemPort = {
  async readdir(target: string): Promise<readonly PseudoWorktreeDirEntry[]> {
    try {
      const entries = await fsPromises.readdir(target, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isSymbolicLink: entry.isSymbolicLink(),
      }));
    } catch {
      return [];
    }
  },
  async statFile(target: string): Promise<PseudoWorktreeFileStat | undefined> {
    try {
      const stat = await fsPromises.lstat(target);
      if (!stat.isFile()) {
        return undefined;
      }
      return { size: stat.size, mtimeMs: stat.mtimeMs };
    } catch {
      return undefined;
    }
  },
  async isSymbolicLink(target: string): Promise<boolean> {
    try {
      const stat = await fsPromises.lstat(target);
      return stat.isSymbolicLink();
    } catch {
      return false;
    }
  },
  async directoryExists(target: string): Promise<boolean> {
    try {
      const stat = await fsPromises.lstat(target);
      return stat.isDirectory();
    } catch {
      return false;
    }
  },
  async realpath(target: string): Promise<string | undefined> {
    try {
      return await fsPromises.realpath(target);
    } catch {
      return undefined;
    }
  },
  async mkdir(target: string): Promise<void> {
    await fsPromises.mkdir(target, { recursive: true });
  },
  async copyFile(from: string, to: string): Promise<void> {
    await fsPromises.copyFile(from, to);
  },
  async removeFile(target: string): Promise<void> {
    await fsPromises.rm(target, { force: true });
  },
  async removeDirRecursive(target: string): Promise<void> {
    await fsPromises.rm(target, { recursive: true, force: true });
  },
};

// ---------------------------------------------------------------------------
// シンボリックリンク対策（`worktree.ts` の `findSymlinkedAncestor` と同じ考え方）
// ---------------------------------------------------------------------------

/**
 * `root` から `target` までの各中間ディレクトリにシンボリックリンクが含まれていないかを
 * 確かめる。見つかった最初のパスを返す（無ければ undefined）。一次防御（事前検知）。
 *
 * `worktree.ts` の同名関数と同じロジックだが、`PseudoWorktreeFileSystemPort` は別の
 * インターフェース型のため、型を跨いで共有する構造は取らず複製する
 * （このファイルの他の複製箇所と同じ理由）。`target`（複製先・統合先そのもの）はこれから
 * 作られる前提のため存在しないが、その祖先（`.agents` / `.agents/worktrees` / `<runId>`）は
 * 既存でありうる。存在しないセグメントは `isSymbolicLink` が `false` を返すだけで安全に
 * 読み飛ばせる。
 */
async function findSymlinkedAncestor(
  root: string,
  target: string,
  fs: PseudoWorktreeFileSystemPort,
): Promise<string | undefined> {
  const rel = path.relative(root, target);
  const segments = rel.split(path.sep).filter((segment) => segment !== '' && segment !== '..');
  let cursor = root;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    if (await fs.isSymbolicLink(cursor)) {
      return cursor;
    }
  }
  return undefined;
}

/**
 * `root` 配下を再帰的に走査し、除外に該当しないファイルの相対パス（`/` 区切り）一覧を返す。
 * ディレクトリ自体は含まない。**シンボリックリンクは辿らず、対象からも除く。** ワークスペース内の
 * ファイルが外部を指すシンボリックリンクである場合、それを複製・統合・反映のいずれの経路でも
 * 一切扱わないことで、リンク先（ワークスペースの外）への書き込み・読み出しが発生する余地を
 * 構造的に無くす（`worktree.ts` の祖先ディレクトリ対策とは別に、ファイル単位でも同じ脅威に備える）。
 */
async function listFiles(
  root: string,
  exclude: readonly string[],
  fs: PseudoWorktreeFileSystemPort,
  relDir = '',
): Promise<string[]> {
  const absDir = relDir === '' ? root : path.join(root, ...relDir.split('/'));
  const entries = await fs.readdir(absDir);
  const results: string[] = [];
  for (const entry of entries) {
    const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
    if (isExcludedPath(relPath, exclude)) {
      continue;
    }
    if (entry.isSymbolicLink) {
      continue;
    }
    if (entry.isDirectory) {
      results.push(...(await listFiles(root, exclude, fs, relPath)));
    } else {
      results.push(relPath);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// スナップショット取得
// ---------------------------------------------------------------------------

/** `root` 配下のスナップショット（除外・シンボリックリンクを除いたファイルのサイズ・更新時刻）を取る。 */
export async function takeSnapshot(
  root: string,
  exclude: readonly string[],
  fs: PseudoWorktreeFileSystemPort,
): Promise<Snapshot> {
  const files = await listFiles(root, exclude, fs);
  const snapshot = new Map<string, SnapshotEntry>();
  for (const relPath of files) {
    const stat = await fs.statFile(path.join(root, ...relPath.split('/')));
    if (stat !== undefined) {
      snapshot.set(relPath, stat);
    }
  }
  return snapshot;
}

// ---------------------------------------------------------------------------
// 複製（タスク開始時）
// ---------------------------------------------------------------------------

export type CloneWorkspaceResult =
  | { ok: true; cwd: string; snapshot: Snapshot }
  | {
      ok: false;
      reason: 'invalidIdentifier' | 'symlinkDetected' | 'boundaryEscape' | 'alreadyExists';
      message: string;
    };

/**
 * タスク1件分の複製を作る。gitの `WorktreeCreationQueue.create`（`worktree.ts`）に相当する。
 *
 * 手順（`worktree.ts` の `createWorktree` と対称に、多層防御を先に済ませてから重い処理へ進む）:
 * 1. `runId` / `taskId` を検証する
 * 2. 一次防御: 作成先までの経路にシンボリックリンクが無いかを確かめる
 * 3. 複製先が既に存在すればエラーにする（既存の作業を踏まない。gitの「同名ブランチ」と同じ意図）
 * 4. 複製先ディレクトリを作る
 * 5. 二次防御: 実際に作られた場所を実パス解決し、`workspaceRoot` の配下にあることを確認する。
 *    ここで多数のファイルをコピーする前に確認することで、境界を外れた場合の書き込みを
 *    最小限（空ディレクトリ1つ）に抑える
 * 6. ワークスペースを複製し、複製先のスナップショットを返す
 */
export async function cloneWorkspace(
  workspaceRoot: string,
  runId: string,
  taskId: string,
  exclude: readonly string[],
  fs: PseudoWorktreeFileSystemPort,
): Promise<CloneWorkspaceResult> {
  const identifierMessage = identifierError(runId, taskId);
  if (identifierMessage !== undefined) {
    return { ok: false, reason: 'invalidIdentifier', message: identifierMessage };
  }

  const target = pseudoWorktreePath(workspaceRoot, runId, taskId);

  const symlinkedAncestor = await findSymlinkedAncestor(workspaceRoot, target, fs);
  if (symlinkedAncestor !== undefined) {
    return {
      ok: false,
      reason: 'symlinkDetected',
      message: `複製先の経路にシンボリックリンクが含まれています。作成を中止しました: ${symlinkedAncestor}`,
    };
  }

  if (await fs.directoryExists(target)) {
    return {
      ok: false,
      reason: 'alreadyExists',
      message: `複製先が既に存在します: ${target}`,
    };
  }

  await fs.mkdir(target);

  const realTarget = await fs.realpath(target);
  const realRoot = (await fs.realpath(workspaceRoot)) ?? workspaceRoot;
  if (realTarget === undefined || !isPathWithinRoot(realTarget, realRoot)) {
    await fs.removeDirRecursive(target);
    return {
      ok: false,
      reason: 'boundaryEscape',
      message: `複製先がワークスペースの外に作られたため、撤去しました: ${realTarget ?? target}`,
    };
  }

  const files = await listFiles(workspaceRoot, exclude, fs);
  for (const relPath of files) {
    const segments = relPath.split('/');
    const from = path.join(workspaceRoot, ...segments);
    const to = path.join(target, ...segments);
    await fs.mkdir(path.dirname(to));
    await fs.copyFile(from, to);
  }

  const snapshot = await takeSnapshot(target, exclude, fs);
  return { ok: true, cwd: target, snapshot };
}

// ---------------------------------------------------------------------------
// 統合先の準備・適用（タスク終了時）
// ---------------------------------------------------------------------------

export type EnsureIntegrationDirResult =
  | { ok: true; dir: string }
  | { ok: false; reason: 'symlinkDetected' | 'boundaryEscape'; message: string };

/**
 * 統合先ディレクトリ（`<runId>/_integration`）を用意する。実行開始時に一度だけ呼ぶ想定
 * （gitの統合worktreeと同じ役割。design.md §16.17）。`cloneWorkspace` と同じ二段構えの
 * シンボリックリンク対策を行う。
 */
export async function ensureIntegrationDir(
  workspaceRoot: string,
  runId: string,
  fs: PseudoWorktreeFileSystemPort,
): Promise<EnsureIntegrationDirResult> {
  const message = runIdError(runId);
  if (message !== undefined) {
    return { ok: false, reason: 'symlinkDetected', message };
  }

  const dir = integrationPath(workspaceRoot, runId);

  const symlinkedAncestor = await findSymlinkedAncestor(workspaceRoot, dir, fs);
  if (symlinkedAncestor !== undefined) {
    return {
      ok: false,
      reason: 'symlinkDetected',
      message: `統合先の経路にシンボリックリンクが含まれています。作成を中止しました: ${symlinkedAncestor}`,
    };
  }

  await fs.mkdir(dir);

  const realDir = await fs.realpath(dir);
  const realRoot = (await fs.realpath(workspaceRoot)) ?? workspaceRoot;
  if (realDir === undefined || !isPathWithinRoot(realDir, realRoot)) {
    await fs.removeDirRecursive(dir);
    return {
      ok: false,
      reason: 'boundaryEscape',
      message: `統合先がワークスペースの外に作られたため、撤去しました: ${realDir ?? dir}`,
    };
  }

  return { ok: true, dir };
}

/**
 * 差分（`toApply`。`planIntegration` で衝突が除かれた後のもの）を統合先へ適用する。
 *
 * 統合先は差分だけを持つ疎な構成（design.md §16.20「これがgitの場合のマージにあたる」）。
 * 追加・変更されたファイルは複製先から統合先へコピーする。削除は統合先に実体を持たない
 * （元々そこには何も無い）ため、ファイルシステム上の操作は無く、`manifest` 側の記録
 * （`kind: 'deleted'`）だけで表現する。ワークスペースへの反映時（`reflectIntegrationToWorkspace`）
 * にこの記録を読んで実際の削除を行う。
 */
export async function applyDiffToIntegration(
  taskDir: string,
  integrationDir: string,
  entries: readonly DiffEntry[],
  fs: PseudoWorktreeFileSystemPort,
): Promise<void> {
  for (const entry of entries) {
    if (entry.kind === 'deleted') {
      continue;
    }
    const segments = entry.path.split('/');
    const from = path.join(taskDir, ...segments);
    const to = path.join(integrationDir, ...segments);
    await fs.mkdir(path.dirname(to));
    await fs.copyFile(from, to);
  }
}

/**
 * 統合先への適用（差分適用 + マニフェスト更新）を1本のキューへ通して直列化する。
 *
 * `worktree.ts` の `WorktreeCreationQueue` と同じ理由。複数タスクが同時に完了すると、
 * マニフェストへの読み取り→更新→書き戻しが競合し、後勝ちで前の更新が消える
 * （典型的なread-modify-writeレース）。gitの `index.lock` のような排他機構がここには
 * 無いため、呼び出し側でキューに通して直列化する。
 *
 * **1回の実行（run）につき、このキューのインスタンスは1つだけ使うこと。** `WorktreeCreationQueue`
 * と同じ注意。
 */
export class IntegrationQueue {
  private tail: Promise<void> = Promise.resolve();
  private manifest: IntegrationManifest;

  constructor(initialManifest: IntegrationManifest = new Map()) {
    this.manifest = initialManifest;
  }

  /** 現在のマニフェスト（永続化・`reflectIntegrationToWorkspace` へ渡す用）。 */
  getManifest(): IntegrationManifest {
    return this.manifest;
  }

  /** タスク1件分の差分を統合先へ適用する（`planIntegration` + `applyDiffToIntegration` をキュー経由で呼ぶ）。 */
  integrate(
    taskId: string,
    taskDir: string,
    integrationDir: string,
    diff: readonly DiffEntry[],
    fs: PseudoWorktreeFileSystemPort,
  ): Promise<IntegrationPlan> {
    return this.enqueue(async () => {
      const plan = planIntegration(taskId, diff, this.manifest);
      await applyDiffToIntegration(taskDir, integrationDir, plan.toApply, fs);
      this.manifest = plan.manifest;
      return plan;
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

// ---------------------------------------------------------------------------
// ワークスペースへの反映（run終了時）
// ---------------------------------------------------------------------------

export type ReflectToWorkspaceResult =
  | { ok: true; appliedPaths: string[] }
  | { ok: false; reason: 'workspaceChanged'; message: string; changedPaths: string[] };

/**
 * runの終了時に、統合先の内容をワークスペースへ反映する（design.md §16.20）。
 *
 * 反映の前に、ワークスペース側が実行中に変更されていないかをスナップショットで確かめる。
 * `workspaceBaseline`（run開始時に一度だけ取ったスナップショット）と現在のワークスペースを
 * 比較し、差分が1件でもあれば**反映せず**警告として返す。人が実行中に編集した内容を
 * 無条件で上書きしないため（design.md §16.20「人の編集を上書きしない」）。
 *
 * 変更が無ければ、マニフェストに記録された各パスをワークスペースへ適用する。
 * `kind: 'deleted'` はワークスペースから削除し、それ以外は統合先からコピーする。
 */
export async function reflectIntegrationToWorkspace(
  workspaceRoot: string,
  integrationDir: string,
  workspaceBaseline: Snapshot,
  manifest: IntegrationManifest,
  exclude: readonly string[],
  fs: PseudoWorktreeFileSystemPort,
): Promise<ReflectToWorkspaceResult> {
  const currentWorkspaceSnapshot = await takeSnapshot(workspaceRoot, exclude, fs);
  const workspaceDiff = diffSnapshots(workspaceBaseline, currentWorkspaceSnapshot);
  if (workspaceDiff.length > 0) {
    return {
      ok: false,
      reason: 'workspaceChanged',
      message:
        '実行中にワークスペースが変更されたため、統合結果を反映せず中止しました。人の編集を上書きしないため。',
      changedPaths: workspaceDiff.map((entry) => entry.path).sort((a, b) => a.localeCompare(b)),
    };
  }

  const appliedPaths: string[] = [];
  for (const [relPath, entry] of manifest) {
    const segments = relPath.split('/');
    const target = path.join(workspaceRoot, ...segments);
    if (entry.kind === 'deleted') {
      await fs.removeFile(target);
    } else {
      const source = path.join(integrationDir, ...segments);
      await fs.mkdir(path.dirname(target));
      await fs.copyFile(source, target);
    }
    appliedPaths.push(relPath);
  }
  return { ok: true, appliedPaths: appliedPaths.sort((a, b) => a.localeCompare(b)) };
}
