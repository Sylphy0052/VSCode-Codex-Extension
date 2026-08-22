import { randomBytes } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';

import { hasGitSegment, isPathWithinRoot } from './escalation';
import {
  assertValidIdentifiers,
  findSymlinkedAncestor,
  identifierError,
  runIdError,
} from './fsGuards';
import { sanitizeForLog } from './sanitize';
import { SerialQueue } from './serialQueue';
import { withRetrySuffix } from './worktree';

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

/**
 * マニフェストへ持ち込めるエントリ数の上限。これを超えるJSONは壊れているか異常な
 * ものとして扱い、パース失敗と同等に倒す（レビュー指摘: risk、Issue #380の追加指摘）。
 *
 * 根拠: 統合先（`_integration`）は差分（追加・変更されたファイル）だけを持つ疎な構成
 * のため、1回のrunで複数タスクが変更するファイル数は通常でも数百〜数千件程度に収まる。
 * 極端に大規模なモノレポでの全面書き換えを想定しても数万件が現実的な上限であり、
 * 10万件はその数倍にあたる安全側の値（かつ`Map`構築のメモリ・CPUコストが実用上
 * 無視できる範囲に収まる規模）として選んだ。
 */
const MAX_MANIFEST_ENTRIES = 100_000;

/**
 * マニフェストのファイル本体として許容する最大サイズ（バイト）。`MAX_MANIFEST_ENTRIES`の
 * チェックは`JSON.parse`が成功した後にしか効かず、`JSON.parse`自体は入力サイズに比例した
 * メモリを確保するため、キー数は少なくても値が巨大な文字列・深いネスト等の入力では
 * 上限チェックへ到達する前にメモリを圧迫しうる（レビュー指摘: medium、Issue #380の
 * 追加指摘）。`MAX_MANIFEST_ENTRIES`（10万件）×1エントリあたり数百バイト程度を見込んでも
 * 数十MBに収まるため、安全マージンを掛けた50MiBをパース前の足切りとして設ける。
 */
const MAX_MANIFEST_FILE_BYTES = 50 * 1024 * 1024;

/**
 * マニフェストのキー（ワークスペースへ反映する際の相対パス）として妥当かどうかを
 * 検証する（レビュー指摘: high、パストラバーサル。Issue #380の追加指摘）。
 *
 * このキーは`reflectIntegrationToWorkspace`で`relPath.split('/')`された後
 * `path.join(workspaceRoot, ...segments)`へそのまま渡り、ワークスペースへの
 * 反映先を決める。`manifest.json`はワークスペース内のファイルとして読み戻す
 * （Issue #380）ため、細工されたファイルを事前に置かれると外部入力がこの経路へ
 * 流れうる。空文字・絶対パス（POSIX/Windowsドライブレター双方）・バックスラッシュ
 * 区切り・`..`/`.`セグメントを含むキーは、いずれも`workspaceRoot`の外を指す
 * 余地を作るため拒否する。
 */
function isValidManifestKey(key: string): boolean {
  if (key === '' || key.includes('\\') || path.isAbsolute(key)) {
    return false;
  }
  // WindowsのドライブレターはPOSIX上の`path.isAbsolute`では絶対パスと判定されない
  // （例: `C:/x`）ため、別途弾く。
  if (/^[a-zA-Z]:/.test(key)) {
    return false;
  }
  const segments = key.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** `manifestFromParsedJson` の結果。`ok: false` は不正なキーを含む・エントリ数が上限を超える等、破棄が起きたことを表す。 */
interface ManifestParseResult {
  manifest: IntegrationManifest;
  ok: boolean;
}

/**
 * `JSON.parse`済みの値からマニフェストを組み立てる純粋関数。`deserializeManifest`と
 * `loadPersistedManifest`（壊れたJSONを「復元できなかった」ことが分かる形で返す。
 * Issue #380）の両方から共有する。どちらも壊れた入力を`ok: false`でfail-closedに扱う
 * 方針は揃えてある（Issue #440。以前は`deserializeManifest`だけが`ok`を捨てて安全側の
 * 空マニフェストへ倒すfail-openだったが、これは#380が「黙って0件成功にすると
 * 統合済みだった成果が消えたことに気づけない」と断じたのと同じ挙動であり、2つの
 * 呼び出し元が正反対の方針を持ったまま共存するのは将来の呼び出し側を誤らせる）。
 *
 * キーが不正（`isValidManifestKey`が偽）なエントリは破棄し、`ok: false`で報告する
 * （レビュー指摘: high）。値の形が不正なエントリ（`taskId`/`kind`が期待の型でない）は、
 * キーの妥当性とは別問題（パストラバーサルの脅威ではない）のため、従来どおり黙って
 * 読み飛ばすだけに留める。
 */
function manifestFromParsedJson(parsed: unknown): ManifestParseResult {
  if (typeof parsed !== 'object' || parsed === null) {
    return { manifest: new Map(), ok: true };
  }
  const rawEntries = Object.entries(parsed as Record<string, unknown>);
  if (rawEntries.length > MAX_MANIFEST_ENTRIES) {
    return { manifest: new Map(), ok: false };
  }
  const result = new Map<string, IntegrationManifestEntry>();
  let ok = true;
  for (const [key, value] of rawEntries) {
    if (!isValidManifestKey(key)) {
      ok = false;
      continue;
    }
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
  return { manifest: result, ok };
}

/**
 * `serializeManifest` の逆変換。Issue #440: 壊れたJSON・不正なキーを含むエントリは
 * `loadPersistedManifest`と同じ基準（`manifestFromParsedJson`の`ok`）でfail-closedに扱い、
 * 例外を投げる。以前はここが黙って空のマニフェストへ倒すfail-openだったため、
 * `deserializeManifest`と`loadPersistedManifest`という同じ入力を扱う2関数が
 * 正反対の方針を持ったまま共存していた（本番の呼び出し元は#380で`loadPersistedManifest`へ
 * 統一済みだが、`deserializeManifest`はexportされたテスト専用関数として残っており、
 * 将来ここを誤って掴む呼び出し側が現れると#380の事象が再発しうる）。
 */
export function deserializeManifest(json: string): IntegrationManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(
      '疑似worktreeの統合マニフェストの直列化データを復元できませんでした（内容を解析できません）',
    );
  }
  const { manifest, ok } = manifestFromParsedJson(parsed);
  if (!ok) {
    throw new Error(
      '疑似worktreeの統合マニフェストの直列化データを復元できませんでした（不正なエントリ、またはエントリ数が上限を超えています）',
    );
  }
  return manifest;
}

/**
 * マニフェストの永続化先（`<runId>/manifest.json`。`_integration`と同じ`<runId>`配下、
 * かつ`.agents/worktrees`配下のため常にスナップショット走査（`listFiles`）の除外対象に
 * 入る。ワークスペースへの反映（`reflectIntegrationToWorkspace`）がこのファイル自身を
 * 誤って拾うことはない）。Issue #380。
 */
export function integrationManifestPath(workspaceRoot: string, runId: string): string {
  const message = runIdError(runId);
  if (message !== undefined) {
    throw new Error(message);
  }
  return path.join(pseudoWorktreesRootDir(workspaceRoot), runId, 'manifest.json');
}

export type LoadManifestResult =
  | { ok: true; manifest: IntegrationManifest }
  | { ok: false; message: string };

/**
 * 永続化されたマニフェストを読み戻す（design.md §16.11の対象。Issue #380）。
 *
 * ファイルが無い場合（初回実行、またはまだ1件も統合していない実行）は「復元できない」
 * ではなく「復元すべきものがまだ無い」正常系のため、空のマニフェストで`ok: true`を返す。
 * ファイルはあるが内容を解析できない場合（破損）、不正なキー（パストラバーサルの疑いが
 * あるエントリ）を含む場合、エントリ数が上限を超える場合は`ok: false`にする。ここを
 * 黙って空マニフェストへ倒すと、統合済みだった成果があったことに呼び出し側が
 * 気づけない（「0件で成功」に見えてしまう。Issueの本題。`deserializeManifest`も
 * Issue #440で同じ基準のfail-closedへ揃えてある）。
 *
 * 読み込みの前に、`integrationManifestPath`が指す経路にシンボリックリンクが含まれて
 * いないかを確かめる（レビュー指摘: medium）。`.agents/worktrees/<runId>`の親のいずれかが
 * シンボリックリンクだと境界外のファイルを読んでしまう。`ensureIntegrationDir`等と同じ
 * `findSymlinkedAncestor`による一次防御をI/Oの前に通す。
 *
 * 一次防御（事前のシンボリックリンク検知）と実際の読み込みの間には短いが実在する
 * ウィンドウがあり、その間に経路がシンボリックリンクへ差し替えられるとすり抜ける
 * （TOCTOU、レビュー指摘: medium）。`cloneWorkspace`/`ensureIntegrationDir`が「作成後に
 * `realpath`で実パスを確認し、境界外なら撤去する」二次防御を対にしているのと同じ考え方で、
 * 読み込んだファイルの実パスを事後に`realpath`で確認し、`workspaceRoot`の外を指して
 * いれば読んだ内容を破棄して「復元できなかった」として扱う（撤去ではなく破棄で足りる
 * のは、読み込みは書き込みと違って対象への副作用を残さないため）。
 *
 * ファイルサイズの上限（`MAX_MANIFEST_FILE_BYTES`）による足切りも`JSON.parse`の前に行う
 * （レビュー指摘: medium、Issue #380の追加指摘。`MAX_MANIFEST_ENTRIES`の項のコメント参照）。
 */
export async function loadPersistedManifest(
  workspaceRoot: string,
  runId: string,
  fs: PseudoWorktreeFileSystemPort,
): Promise<LoadManifestResult> {
  const filePath = integrationManifestPath(workspaceRoot, runId);

  const symlinkedAncestor = await findSymlinkedAncestor(workspaceRoot, filePath, fs);
  if (symlinkedAncestor !== undefined) {
    return {
      ok: false,
      message: `疑似worktreeの統合マニフェストの読み込み元の経路にシンボリックリンクが含まれています。読み込みを中止しました: ${sanitizeForLog(symlinkedAncestor)}`,
    };
  }

  const stat = await fs.statFile(filePath);
  if (stat !== undefined && stat.size > MAX_MANIFEST_FILE_BYTES) {
    return {
      ok: false,
      message: `疑似worktreeの統合マニフェストを復元できませんでした（ファイルサイズが上限を超えています）: ${sanitizeForLog(filePath)}`,
    };
  }

  const content = await fs.readTextFile(filePath);
  if (content === undefined) {
    return { ok: true, manifest: new Map() };
  }

  const realFilePath = await fs.realpath(filePath);
  const realRoot = (await fs.realpath(workspaceRoot)) ?? workspaceRoot;
  if (realFilePath === undefined || !isPathWithinRoot(realFilePath, realRoot)) {
    return {
      ok: false,
      message: `疑似worktreeの統合マニフェストを復元できませんでした（読み込み元が実際にはワークスペースの外を指しています）: ${sanitizeForLog(filePath)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return {
      ok: false,
      message: `疑似worktreeの統合マニフェストを復元できませんでした（内容を解析できません）: ${sanitizeForLog(filePath)}`,
    };
  }
  const { manifest, ok } = manifestFromParsedJson(parsed);
  if (!ok) {
    return {
      ok: false,
      message: `疑似worktreeの統合マニフェストを復元できませんでした（不正なエントリ、またはエントリ数が上限を超えています）: ${sanitizeForLog(filePath)}`,
    };
  }
  return { ok: true, manifest };
}

/**
 * マニフェストを永続化する（design.md §16.11の対象。Issue #380）。タスク1件分の統合
 * （`IntegrationQueue.integrate`）が成功するたびに呼び出し側（`integratePseudoWorktree`）
 * から呼ぶ。書き込み失敗（EACCES/ENOSPC等）はここでは吸収せず、他のポートメソッドと
 * 同じく素通しでthrowする（呼び出し側が「統合自体は成立している」ことと区別して扱うため）。
 *
 * 書き込みの前に、`loadPersistedManifest`と同じくシンボリックリンクの経路検知を行う
 * （レビュー指摘: medium）。
 *
 * さらに、`cloneWorkspace`/`ensureIntegrationDir`と同じ二段構えの二段目（書き込み後に
 * `realpath`で実パスを確認し、境界外なら撤去する）も対にする（レビュー指摘: medium、
 * TOCTOU）。ここは間に`fs.mkdir(path.dirname(filePath))`を挟むぶん一次防御から実I/Oまでの
 * ウィンドウが他箇所より広く、非対称のまま放置すると一次防御をすり抜けられた場合に
 * 唯一無防備になる。
 */
export async function persistManifest(
  workspaceRoot: string,
  runId: string,
  manifest: IntegrationManifest,
  fs: PseudoWorktreeFileSystemPort,
): Promise<void> {
  const filePath = integrationManifestPath(workspaceRoot, runId);

  const symlinkedAncestor = await findSymlinkedAncestor(workspaceRoot, filePath, fs);
  if (symlinkedAncestor !== undefined) {
    throw new Error(
      `疑似worktreeの統合マニフェストの永続化先の経路にシンボリックリンクが含まれています。書き込みを中止しました: ${sanitizeForLog(symlinkedAncestor)}`,
    );
  }

  await fs.mkdir(path.dirname(filePath));
  await fs.writeTextFile(filePath, serializeManifest(manifest));

  const realFilePath = await fs.realpath(filePath);
  const realRoot = (await fs.realpath(workspaceRoot)) ?? workspaceRoot;
  if (realFilePath === undefined || !isPathWithinRoot(realFilePath, realRoot)) {
    await fs.removeFile(filePath);
    throw new Error(
      `疑似worktreeの統合マニフェストの永続化先が実際にはワークスペースの外を指していたため、` +
        `書き込みを取り消しました: ${sanitizeForLog(realFilePath ?? filePath)}`,
    );
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
// 識別子の検証・パスの組み立て
// ---------------------------------------------------------------------------

/**
 * `runId` / `taskId` の字種の検証は `worktree.ts` / `integration.ts` と共通の
 * `fsGuards.ts` から読む。以前はここへも同じ正規表現・同じロジックが複製されていた
 * （「`workflow.ts` / `worktree.ts` をimportしない」という理由づけだったが、`fsGuards.ts`
 * は他モジュールに依存しない末端モジュールのため、importしても循環しない。Issue #146）。
 */

/** 統合先ディレクトリのタスクid相当の固定名。design.md §16.17「`_integration` はタスクidとして予約する」。 */
const INTEGRATION_DIR_NAME = '_integration';

/** 疑似worktreeを置くディレクトリ。gitの場合（`worktree.ts` の `worktreesRootDir`）と同じ置き場。 */
export function pseudoWorktreesRootDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.agents', 'worktrees');
}

/**
 * タスク1件分の複製先の絶対パス。`<workspace>/.agents/worktrees/<runId>/<taskId>`
 * （design.md §16.20）。`retry`を渡すとディレクトリ名にも`-retry<n>`が付く。
 *
 * `worktree.ts`の`worktreePath`と対称にする（Issue #396）。以前はここが`retry`を
 * 受け取らず、`failed`になったタスクを再試行すると`cloneWorkspace`が前回の複製先と
 * 同じパスへ2回目の複製を試みて必ず`alreadyExists`で失敗していた（gitの`worktreePath`は
 * 既にretry対応済みで、疑似worktree側だけが取り残されていた）。`-retry<n>`の組み立て
 * ロジック自体は`worktree.ts`の`withRetrySuffix`をそのまま使い、ここで複製しない。
 *
 * **`_integration`（統合先、design.md §16.17で予約済みのタスクid）には接尾辞を付けない。**
 * 統合先には「再試行」という概念が無く、`integrationPath`が指す場所とずれてしまうため。
 */
export function pseudoWorktreePath(
  workspaceRoot: string,
  runId: string,
  taskId: string,
  retry?: number,
): string {
  assertValidIdentifiers(runId, taskId);
  const dirName = taskId === INTEGRATION_DIR_NAME ? taskId : withRetrySuffix(taskId, retry);
  return path.join(pseudoWorktreesRootDir(workspaceRoot), runId, dirName);
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
  /**
   * ファイルを改名（同一ディレクトリ内での置き換え）する。`to`が既存のファイル・
   * シンボリックリンクを指していても、その実体を辿らずディレクトリエントリそのものを
   * 置き換える（POSIXの`rename(2)`の性質）。`reflectIntegrationToWorkspace`が
   * コピー先へのTOCTOU（Issue #445）を塞ぐために「一時ファイルへ書いてからrenameで
   * 確定させる」用途にだけ使う。オプショナルにしているのは、この関数を持たない
   * 既存のポート実装（テスト用フェイク等）に影響を与えないため。持たないポートを
   * 渡した場合は`reflectIntegrationToWorkspace`側が従来どおりの直接コピー経路へ
   * フォールバックする。
   */
  rename?(from: string, to: string): Promise<void>;
  /**
   * テキストファイルを読む。存在しない・読めない場合は undefined（他の読み取り系
   * ポートメソッドと同じ規約）。マニフェストの永続化・復元（Issue #380）にだけ使う。
   */
  readTextFile(target: string): Promise<string | undefined>;
  /**
   * テキストファイルを書く（親ディレクトリは呼び出し側が事前に作る）。マニフェストの
   * 永続化（Issue #380）にだけ使う。書き込み失敗は素通しでthrowする（`copyFile`等と同じ）。
   */
  writeTextFile(target: string, content: string): Promise<void>;
  /**
   * ディレクトリを再帰的に削除する。存在しなくてもエラーにしない。境界逸脱時の後始末
   * （`cloneWorkspace` / `ensureIntegrationDir`が作成直後に自分の作った分だけを消す）と、
   * `removePseudoWorktree`による明示的な撤去（Issue #298）の両方から使う。
   */
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
  async rename(from: string, to: string): Promise<void> {
    await fsPromises.rename(from, to);
  },
  async readTextFile(target: string): Promise<string | undefined> {
    try {
      return await fsPromises.readFile(target, 'utf8');
    } catch {
      return undefined;
    }
  },
  async writeTextFile(target: string, content: string): Promise<void> {
    await fsPromises.writeFile(target, content, 'utf8');
  },
  async removeDirRecursive(target: string): Promise<void> {
    await fsPromises.rm(target, { recursive: true, force: true });
  },
};

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
 *
 * `retry`は`worktree.ts`の`createWorktree`と同じ意味（Issue #396）。再試行のたびに
 * 呼び出し側（`runnerWorkingDirectory.ts`）が異なる`retry`を渡すことで、`pseudoWorktreePath`が
 * 別ディレクトリを指すようになり、前回の複製が残っていても`alreadyExists`にならない。
 */
export async function cloneWorkspace(
  workspaceRoot: string,
  runId: string,
  taskId: string,
  exclude: readonly string[],
  fs: PseudoWorktreeFileSystemPort,
  retry?: number,
): Promise<CloneWorkspaceResult> {
  const identifierMessage = identifierError(runId, taskId);
  if (identifierMessage !== undefined) {
    return { ok: false, reason: 'invalidIdentifier', message: identifierMessage };
  }

  const target = pseudoWorktreePath(workspaceRoot, runId, taskId, retry);

  const symlinkedAncestor = await findSymlinkedAncestor(workspaceRoot, target, fs);
  if (symlinkedAncestor !== undefined) {
    return {
      ok: false,
      reason: 'symlinkDetected',
      message: `複製先の経路にシンボリックリンクが含まれています。作成を中止しました: ${sanitizeForLog(symlinkedAncestor)}`,
    };
  }

  if (await fs.directoryExists(target)) {
    return {
      ok: false,
      reason: 'alreadyExists',
      message: `複製先が既に存在します: ${sanitizeForLog(target)}`,
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
      message: `複製先がワークスペースの外に作られたため、撤去しました: ${sanitizeForLog(realTarget ?? target)}`,
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
// 撤去（design.md §16.17「worktreeの片付け」・§16.20、Issue #298）
// ---------------------------------------------------------------------------

export type RemovePseudoWorktreeResult =
  | { ok: true }
  | { ok: false; reason: 'invalidIdentifier' | 'boundaryEscape'; message: string };

/**
 * 疑似worktree（`<workspace>/.agents/worktrees/<runId>/<taskId>`）を1件撤去する。
 * `taskId`に`'_integration'`を渡せば統合先（`integrationPath`と同じ場所）も同じ入口で
 * 撤去できる（`pseudoWorktreePath`と`integrationPath`は同じ組み立てのため）。
 *
 * gitの`removeWorktree`（`worktree.ts`）と違い「`git worktree remove`だけを使う」という
 * 安全弁が無く、`removeDirRecursive`でディレクトリを直接消す必要がある。`cloneWorkspace`が
 * 作成時に行う二段構え（一次防御: 祖先ディレクトリのシンボリックリンク検知、二次防御:
 * 作成後の実パス解決による境界確認）のうち、ここでは後段だけを撤去向けに行う。
 * **消す前に対象を実パス解決し、その実体が`.agents/worktrees`の配下にあることを確かめる。**
 * ここで確かめずに`removeDirRecursive`へ渡すと、`.agents/worktrees`自体がシンボリックリンクに
 * 差し替えられていた場合にリンク先（ワークスペースの外）を再帰削除してしまう。
 *
 * 対象が実在しなければ（既に撤去済み）、`worktree.ts`の`removeWorktree`と同じく成功として返す。
 *
 * `retry`を渡すと、その番号の複製先（`cloneWorkspace`に同じ`retry`を渡して作った場所）
 * だけを撤去する（Issue #396）。全試行分をまとめて撤去したい場合は
 * `removePseudoWorktreeAttempts`を使う。
 */
export async function removePseudoWorktree(
  workspaceRoot: string,
  runId: string,
  taskId: string,
  fs: PseudoWorktreeFileSystemPort,
  retry?: number,
): Promise<RemovePseudoWorktreeResult> {
  const identifierMessage = identifierError(runId, taskId);
  if (identifierMessage !== undefined) {
    return { ok: false, reason: 'invalidIdentifier', message: identifierMessage };
  }
  const target = pseudoWorktreePath(workspaceRoot, runId, taskId, retry);

  const realTarget = await fs.realpath(target);
  if (realTarget === undefined) {
    return { ok: true };
  }
  const realWorktreesRoot = await fs.realpath(pseudoWorktreesRootDir(workspaceRoot));
  if (realWorktreesRoot === undefined || !isPathWithinRoot(realTarget, realWorktreesRoot)) {
    return {
      ok: false,
      reason: 'boundaryEscape',
      message: `撤去対象が.agents/worktreesの外を指しているため撤去しませんでした: ${sanitizeForLog(realTarget)}`,
    };
  }

  await fs.removeDirRecursive(target);
  return { ok: true };
}

/**
 * 疑似worktreeの1タスク分の複製を、すべての試行分まとめて撤去する（Issue #396）。
 *
 * `worktree.ts`側の`runner.ts`にある`removeGitTaskWorktree`と対になる撤去で、対象は
 * 「retryなし（初回）」と`0..totalAttempts-1`のすべて。`cloneWorkspace`が`retry`ごとに
 * 別ディレクトリ（ワークスペース丸ごとの複製）を作るため、1件も撤去し忘れると
 * ディスクを試行回数ぶん無駄に占有し続ける（過去の試行分は`blocked`の場合を除き
 * 中身を後から見返す必要が無いため、gitのブランチのように残す理由が無い）。
 *
 * 既に存在しないパスは`removePseudoWorktree`が撤去済みとして成功扱いにするため、
 * 実在を気にせず全件呼んでよい。1件でも失敗すればそれらのメッセージをまとめて返す
 * （`removeGitTaskWorktree`と同じ集約の仕方）。
 */
export async function removePseudoWorktreeAttempts(
  workspaceRoot: string,
  runId: string,
  taskId: string,
  totalAttempts: number,
  fs: PseudoWorktreeFileSystemPort,
): Promise<RemovePseudoWorktreeResult> {
  const retries: Array<number | undefined> = [
    undefined,
    ...Array.from({ length: totalAttempts }, (_, i) => i),
  ];
  const messages: string[] = [];
  let firstFailureReason: Extract<RemovePseudoWorktreeResult, { ok: false }>['reason'] | undefined;
  for (const retry of retries) {
    const result = await removePseudoWorktree(workspaceRoot, runId, taskId, fs, retry);
    if (!result.ok) {
      messages.push(result.message);
      firstFailureReason ??= result.reason;
    }
  }
  if (messages.length === 0) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: firstFailureReason ?? 'boundaryEscape',
    message: messages.join(' / '),
  };
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
      message: `統合先の経路にシンボリックリンクが含まれています。作成を中止しました: ${sanitizeForLog(symlinkedAncestor)}`,
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
      message: `統合先がワークスペースの外に作られたため、撤去しました: ${sanitizeForLog(realDir ?? dir)}`,
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
 * `worktree.ts` の `WorktreeCreationQueue` と同じ理由（直列化そのものの実装は
 * `serialQueue.ts` の `SerialQueue` を共有する。Issue #146）。複数タスクが同時に完了すると、
 * マニフェストへの読み取り→更新→書き戻しが競合し、後勝ちで前の更新が消える
 * （典型的なread-modify-writeレース）。gitの `index.lock` のような排他機構がここには
 * 無いため、呼び出し側でキューに通して直列化する。
 *
 * **1回の実行（run）につき、このキューのインスタンスは1つだけ使うこと。** `WorktreeCreationQueue`
 * と同じ注意。
 */
export class IntegrationQueue {
  private readonly queue = new SerialQueue();
  private manifest: IntegrationManifest;
  private readonly manifestRestoreError: string | undefined;

  /**
   * `manifestRestoreError`はリロード復元時（Issue #380）、永続化されたマニフェストが
   * 壊れていて読み戻せなかった場合に呼び出し側（`resolvePseudoState`）が渡す。定義されて
   * いれば、このrunの統合状態はもう分からない（空マニフェストのまま続行すると「復元済み
   * だが実は何も統合していない」と区別が付かない）ため、`reflectPseudoWorktree`側が
   * ワークスペースへの反映を「0件で成功」にせず明示的に止める判定材料として使う。
   */
  constructor(initialManifest: IntegrationManifest = new Map(), manifestRestoreError?: string) {
    this.manifest = initialManifest;
    this.manifestRestoreError = manifestRestoreError;
  }

  /** 現在のマニフェスト（永続化・`reflectIntegrationToWorkspace` へ渡す用）。 */
  getManifest(): IntegrationManifest {
    return this.manifest;
  }

  /** マニフェストの復元に失敗していればその理由。成功・初回実行時は undefined。 */
  getManifestRestoreError(): string | undefined {
    return this.manifestRestoreError;
  }

  /**
   * タスク1件分の差分を統合先へ適用する（`planIntegration` + `applyDiffToIntegration` をキュー経由で呼ぶ）。
   *
   * `onIntegrated`（省略可）はマニフェスト更新後の永続化用のフック（レビュー指摘: risk、
   * Issue #380の追加指摘）。`persistManifest`の呼び出しをこの`enqueue`の外で行うと、
   * `integrate`自体は直列化されていても後段の書き込み同士には順序保証が無く、
   * 先に完了したタスクの古いマニフェストが、後から完了した別タスクの新しい書き込みより
   * 後にディスクへ着地しうる（Issueが防ごうとした事象の再発）。`enqueue`されたこの関数の
   * 中で`await`することで、次のタスクの`integrate`（と、その`onIntegrated`）が始まる前に
   * 必ず書き込みが完了している状態を保証する。
   *
   * 呼び出し側が渡す`onIntegrated`が例外を投げると、それがそのままこの`Promise`の
   * rejectになり統合自体の失敗として扱われてしまう。永続化の失敗は統合の成否とは
   * 別問題（`integratePseudoWorktree`が従来から独立したtry/catchで警告に留めている
   * 判断はここでも変えない）のため、失敗を統合の成否に混ぜたくない呼び出し側は
   * `onIntegrated`自身の内側でtry/catchすること。
   */
  integrate(
    taskId: string,
    taskDir: string,
    integrationDir: string,
    diff: readonly DiffEntry[],
    fs: PseudoWorktreeFileSystemPort,
    onIntegrated?: (manifest: IntegrationManifest) => Promise<void>,
  ): Promise<IntegrationPlan> {
    return this.enqueue(async () => {
      const plan = planIntegration(taskId, diff, this.manifest);
      await applyDiffToIntegration(taskDir, integrationDir, plan.toApply, fs);
      this.manifest = plan.manifest;
      if (onIntegrated !== undefined) {
        await onIntegrated(plan.manifest);
      }
      return plan;
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    return this.queue.enqueue(task);
  }
}

// ---------------------------------------------------------------------------
// ワークスペースへの反映（run終了時）
// ---------------------------------------------------------------------------

/**
 * 除外設定（`exclude`）に一致したためスキップしたパス。反映は中断せず次のエントリへ進むが、
 * **黙って捨てない**（Issue #380が「黙って0件成功として扱うと、統合済みだった成果が
 * 失われたことに気づけない」と断じたのと同じ穴になるため）。呼び出し側
 * （`runnerWorkingDirectory.ts`の`reflectPseudoWorktree`）が警告として人に見せる。
 *
 * 成功時（`ok: true`）だけでなく`partialApply`にも持たせる。持たせないと
 * 「`appliedPaths` + `failedPath` + `remainingPaths` で全エントリを覆う」という
 * 呼び出し側の適用済み・未適用の勘定が崩れ、スキップされた分がどちらにも現れなくなる。
 */
type SkippedPaths = { skippedPaths: string[] };

export type ReflectToWorkspaceResult =
  | ({ ok: true; appliedPaths: string[] } & SkippedPaths)
  | { ok: false; reason: 'workspaceChanged'; message: string; changedPaths: string[] }
  | ({
      ok: false;
      reason: 'partialApply';
      message: string;
      /** 反映済み（成功した）パス。 */
      appliedPaths: string[];
      /** 反映に失敗した1件（この後は試みていない）。 */
      failedPath: string;
      /** `failedPath`より後ろにあり、まだ試みていないパス。 */
      remainingPaths: string[];
    } & SkippedPaths);

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
 *
 * **1件ごとに、このファイルの他の経路（`cloneWorkspace` / `ensureIntegrationDir` /
 * `loadPersistedManifest` / `persistManifest`）と同じ二段構えの境界確認を行う**
 * （Issue #433）。一次防御として`findSymlinkedAncestor`でI/O前に経路のシンボリックリンクを
 * 検知し、二次防御として`realpath`で実パスが境界（ワークスペース／統合先）の配下に
 * あることを確かめる。`isPathWithinRoot`は字面の判定でシンボリックリンクを解決せず、
 * マニフェストのキーは永続化ファイル（Issue #380）由来にもなりうるため、この経路だけ
 * 字面の判定に頼ると「ワークスペース内に実在するシンボリックリンクを経由して外へ書く・
 * 外を消す」キーを止められない。`listFiles`がシンボリックリンクを除外する結果、その手の
 * キーは`workspaceChanged`の保護（人の編集の検知）にも現れない。
 *
 * 除外（`isExcludedPath`）と`.git`セグメントの拒否も同じ場所で行う（Issue #406）。
 * ただし**扱いは対称にしない**。`isExcludedPath`はそのエントリだけスキップして先へ進み、
 * `hasGitSegment`は従来どおり反映全体を中断する（理由はループ内のコメントを参照）。
 * 非対称なので**判定順が意味を持つ**。`hasGitSegment`を先に評価し、`.git`セグメントを
 * 含むキーは`exclude`との一致有無に関わらず必ず中断させる。
 *
 * 検証に失敗したエントリは、I/Oエラーと同じく`partialApply`（適用済み・失敗した1件・
 * 未着手の残り）として返し、人が状況を追えるようにする。
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

  const realRoot = (await fs.realpath(workspaceRoot)) ?? workspaceRoot;
  const realIntegrationDir = (await fs.realpath(integrationDir)) ?? integrationDir;

  const entries = [...manifest.entries()];
  const appliedPaths: string[] = [];
  const skippedPaths: string[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry === undefined) {
      continue;
    }
    const [relPath, manifestEntry] = entry;
    const segments = relPath.split('/');
    const target = path.join(workspaceRoot, ...segments);
    const safeRelPath = sanitizeForLog(relPath);
    try {
      // マニフェストの出どころ（実行時に内部生成されたものか、永続化ファイルから
      // 読み戻されたものか）に関わらず、反映処理自体が境界を守る（レビュー指摘: high、
      // 多層防御の2段目）。`manifestFromParsedJson`のキー検証（1段目）をすり抜けた
      // 場合でも、ここで`workspaceRoot`/`integrationDir`の外を指すエントリを弾く。
      //
      // `.git`セグメントは`exclude`の設定内容に関わらず無条件で拒否する。ワークスペースが
      // 後からgitリポジトリになったとき、仕込まれた`.git/hooks/*`が永続的なコード実行経路に
      // なるため（判定は`escalation.ts`の`hasGitSegment`を共有し、`.GIT`等の亜種も同じ扱い）。
      // こちらは`isExcludedPath`（設定ドリフトで正当なキーが一致しうるためスキップ扱い）と
      // 違い、**反映全体を中断する**。攻撃シナリオが明確で、かつ正当なマニフェストに
      // `.git`セグメントが入る筋が無いため、1件でも現れたらマニフェスト全体を疑う。
      //
      // そのため`isExcludedPath`のスキップ判定より**前**に置く。順序が逆だと、
      // `exclude`に一致するセグメントを併せ持つ`.git`キーがスキップへ吸われて無条件拒否が
      // 効かなくなる（下の`isExcludedPath`のコメントも参照）。
      if (hasGitSegment(relPath)) {
        throw new Error(`反映対象から除外されるパスです（${safeRelPath}）`);
      }
      // 除外の判定は、スナップショット（`listFiles`）と同じ`isExcludedPath`をここでも
      // 通す（Issue #406 / #433）。マニフェストのキーは永続化ファイル由来にもなりうる
      // （Issue #380）ため、`listFiles`が除外したものと同じ範囲を反映側でも拒否しないと、
      // 走査では一度も見ないパス（`node_modules`配下等）がワークスペースへ書き戻される。
      //
      // **ヒットしてもそのエントリをスキップするだけで、反映全体は中断しない**
      // （レビュー指摘: medium）。`exclude`は起動時に固定される一方、
      // `loadPersistedManifest`はディスク上のマニフェストを`exclude`と無関係に復元するため、
      // 「前回実行時のexclude設定下で正当に作られたキーが、設定変更後の今回のexcludeに
      // 一致する」設定ドリフトが構造的に起こりうる。中断すると、Mapの反復順で後ろにある
      // 正当なエントリまで一律で未適用になってしまう。走査側の`listFiles`も同じ判定を
      // `continue`で流しており、扱いを揃える。
      //
      // ただし黙って捨てず`skippedPaths`へ載せ、呼び出し側が警告として人に見せる。
      //
      // **この判定は必ず`hasGitSegment`より後に置くこと**（レビュー2巡目の指摘）。
      // 先に置くと`node_modules/.git/hooks/pre-commit`のように「除外対象のディレクトリ名と
      // `.git`セグメントを両方含むキー」がスキップへ倒れ、`.git`の無条件拒否へ到達しない。
      // 既定の`exclude`のままで成立し、細工したマニフェストに除外ヒットするダミーを
      // 混ぜるだけで`.git`混入の中断（Issue #406）が無効化される。
      if (isExcludedPath(relPath, exclude)) {
        skippedPaths.push(relPath);
        continue;
      }
      if (!isPathWithinRoot(target, workspaceRoot)) {
        throw new Error(`反映先がワークスペースの外を指しています（${safeRelPath}）`);
      }
      // 一次防御: 反映先の経路にシンボリックリンクが無いことをI/Oの前に確かめる
      // （`cloneWorkspace` / `ensureIntegrationDir` / `persistManifest`と同じ二段構えの1段目。
      // Issue #433）。`isPathWithinRoot`は字面の判定でシンボリックリンクを解決しないため、
      // これ単体では「ワークスペース内に実在するシンボリックリンクを経由して外へ出る」
      // キーを止められない。`listFiles`がシンボリックリンクを捨てる不変条件は、キーが
      // 永続化ファイル由来になった時点（Issue #380）から反映側の前提にできない。
      const targetSymlink = await findSymlinkedAncestor(workspaceRoot, target, fs);
      if (targetSymlink !== undefined) {
        throw new Error(
          `反映先の経路にシンボリックリンクが含まれています（${safeRelPath}）: ${sanitizeForLog(targetSymlink)}`,
        );
      }
      if (manifestEntry.kind === 'deleted') {
        // 二次防御。削除は取り消せない（`persistManifest`のように「書いた後に撤去する」
        // 形にできない）ため、実パスの確認も削除の**前**に行う。`removePseudoWorktree`が
        // `removeDirRecursive`の前に`realpath`で確かめているのと同じ形。
        const realTarget = await fs.realpath(target);
        if (realTarget !== undefined && !isPathWithinRoot(realTarget, realRoot)) {
          throw new Error(
            `削除対象が実際にはワークスペースの外を指しています（${safeRelPath}）: ${sanitizeForLog(realTarget)}`,
          );
        }
        await fs.removeFile(target);
      } else {
        const source = path.join(integrationDir, ...segments);
        if (!isPathWithinRoot(source, integrationDir)) {
          throw new Error(`反映元が統合先の外を指しています（${safeRelPath}）`);
        }
        const sourceSymlink = await findSymlinkedAncestor(integrationDir, source, fs);
        if (sourceSymlink !== undefined) {
          throw new Error(
            `反映元の経路にシンボリックリンクが含まれています（${safeRelPath}）: ${sanitizeForLog(sourceSymlink)}`,
          );
        }
        // 読み出しは`copyFile`の中で起きてしまうため、反映元の実パス確認は読み出しの前に
        // 行う（`loadPersistedManifest`が読み込み後に確認して内容を破棄できるのは、
        // 読んだ内容がその関数の中に留まるため。ここは読んだ内容がワークスペースへ
        // そのまま書かれるので、事後の確認では統合先の外の内容を持ち込んだ後になる）。
        const realSource = await fs.realpath(source);
        if (realSource === undefined || !isPathWithinRoot(realSource, realIntegrationDir)) {
          throw new Error(
            `反映元が実際には統合先の外を指しています（${safeRelPath}）: ${sanitizeForLog(realSource ?? source)}`,
          );
        }
        // 親ディレクトリを作った直後に実パスを確かめてからコピーする（`cloneWorkspace`が
        // 「多数のファイルをコピーする前に、作ったディレクトリの実パスを確認する」のと
        // 同じ順序。ここで確認しておけば、ファイル本体の書き込みが境界の外で起きない）。
        const targetDir = path.dirname(target);
        await fs.mkdir(targetDir);
        const realTargetDir = await fs.realpath(targetDir);
        // ここでは`cloneWorkspace` / `ensureIntegrationDir`と違い、
        // **作ったディレクトリを`removeDirRecursive`で撤去しない**（レビュー指摘への裁定。
        // 揃っていないのは意図的なので、将来のレビューで安易に揃えないこと）。
        // 撤去対象は「`realpath`が境界外に解決されたディレクトリ」であり、その実体は
        // シンボリックリンクの指す先＝既にユーザーのデータが入っている可能性のある場所。
        // 空ディレクトリが1つ残る害と、境界外を再帰削除する害が釣り合わない。
        // `cloneWorkspace`側が撤去できるのは、そこで作るのが自分専用の新規ディレクトリ
        // （`<runId>/<taskId>`）だからで、前提が違う。
        if (realTargetDir === undefined || !isPathWithinRoot(realTargetDir, realRoot)) {
          throw new Error(
            `反映先のディレクトリが実際にはワークスペースの外を指しています（${safeRelPath}）: ${sanitizeForLog(realTargetDir ?? targetDir)}`,
          );
        }
        if (fs.rename !== undefined) {
          // Issue #445: 上の`realTargetDir`確認と、実際にワークスペースへ書き込む瞬間
          // （旧実装では`fs.copyFile(source, target)`）の間には、なお短いTOCTOU窓が残る。
          // `fs.copyFile`はシンボリックリンクを解決して書き込むため、この窓の間に`target`
          // が外部を指すシンボリックリンクへ差し替えられると、書き込みが境界外（リンク先）
          // で起きてしまう。
          //
          // これを塞ぐため、`target`と同じディレクトリ内の一時ファイルへコピーしてから
          // `rename`で`target`の名前へ確定させる。`rename`は対象パスの終端が
          // シンボリックリンクであってもそれを解決せず、ディレクトリエントリそのものを
          // 置き換える（POSIXの`rename(2)`の性質）ため、`target`がその時点でリンクへ
          // 差し替えられていても、置き換え先（リンク先）を書き換えることが原理的にない。
          //
          // 一時ファイルは`targetDir`と同一ディレクトリに置く。別ディレクトリ（別ファイル
          // システム）だと`rename`がクロスデバイスで`EXDEV`になり失敗しうるため。
          // ファイル名は`crypto.randomBytes`による推測不能な接尾辞を持たせる。予測可能な
          // 名前だと、そこへ先回りしてシンボリックリンクを仕込まれる別の攻撃面になる。
          const tempTarget = path.join(targetDir, `.pwt-reflect-${randomBytes(16).toString('hex')}.tmp`);
          try {
            await fs.copyFile(source, tempTarget);
            // 二次防御の仕上げ（TOCTOU）。`persistManifest`と同じく、書いた後に実パスを
            // 確かめる。ここは`target`ではなく一時ファイルに対して行う点が異なる。
            // `rename`前に確認することで、境界外へ書かれた内容が`target`の名前で
            // 一瞬でも見える窓自体を作らない。
            const realTemp = await fs.realpath(tempTarget);
            if (realTemp === undefined || !isPathWithinRoot(realTemp, realRoot)) {
              throw new Error(
                `反映先が実際にはワークスペースの外に書き込まれたため、書き込みを取り消しました` +
                  `（${safeRelPath}）: ${sanitizeForLog(realTemp ?? tempTarget)}`,
              );
            }
            await fs.rename(tempTarget, target);
          } catch (e) {
            // 例外の理由を問わず（上のthrowだけでなく`copyFile`自体の失敗も含む）、
            // 一時ファイルを残置しない。プロセスが途中で落ちた場合まではこれで防げないが、
            // 通常の失敗経路では残らないようにする。
            await fs.removeFile(tempTarget);
            throw e;
          }
        } else {
          // 後方互換の経路（レビュー指摘への裁定）。`rename`を提供しないポート実装
          // （テスト用フェイク等）向けに、従来どおり直接コピー+事後確認+ロールバックを行う。
          // Issue #445のTOCTOU閉塞は`rename`を持つポート（`nodePseudoWorktreeFileSystem`。
          // 本番はここだけを使う）でのみ効く。
          await fs.copyFile(source, target);
          const realTarget = await fs.realpath(target);
          if (realTarget === undefined || !isPathWithinRoot(realTarget, realRoot)) {
            await fs.removeFile(target);
            throw new Error(
              `反映先が実際にはワークスペースの外を指していたため、書き込みを取り消しました` +
                `（${safeRelPath}）: ${sanitizeForLog(realTarget ?? target)}`,
            );
          }
        }
      }
    } catch (e) {
      // 途中のI/Oエラーで中断した場合、それ以前のパスだけが適用済みの中途半端な状態に
      // なる。ここで例外を投げ直すと、どこまで適用できたか・どこから先が未適用かの情報が
      // 呼び出し側から失われる（Issue #380の追加指摘）。適用済み・失敗した1件・まだ
      // 試みていない残りを、呼び出し側が警告として人に見せられる形で返す
      const message = sanitizeForLog(e instanceof Error ? e.message : String(e));
      return {
        ok: false,
        reason: 'partialApply',
        message: `統合結果のワークスペースへの反映が${safeRelPath}で失敗し、途中で中断しました: ${message}`,
        appliedPaths: [...appliedPaths].sort((a, b) => a.localeCompare(b)),
        skippedPaths: [...skippedPaths].sort((a, b) => a.localeCompare(b)),
        failedPath: relPath,
        remainingPaths: entries
          .slice(i + 1)
          .map(([p]) => p)
          .sort((a, b) => a.localeCompare(b)),
      };
    }
    appliedPaths.push(relPath);
  }
  return {
    ok: true,
    appliedPaths: appliedPaths.sort((a, b) => a.localeCompare(b)),
    skippedPaths: skippedPaths.sort((a, b) => a.localeCompare(b)),
  };
}
