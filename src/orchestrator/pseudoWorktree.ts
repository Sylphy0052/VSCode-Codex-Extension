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
 * `filePath`の実パスを`realpath`で確認する。
 *
 * **この確認は「境界内か」（`isPathWithinRoot`）ではなく「想定した場所そのものか」の
 * 厳密一致にする（Issue #505、セキュリティ監査で発覚。high）。** `isPathWithinRoot`
 * だけだと、`filePath`（`manifest.json`）がワークスペース**内**の別の実体（典型的には
 * `.git/hooks`配下の攻撃者が置いたJSON）へのシンボリックリンクへ差し替えられていた
 * 場合に「境界内」として素通りし、偽装されたマニフェストを正当な内容として読み込んで
 * しまう。この関数はrun実行開始時だけでなくVS Codeのウィンドウ再読み込み（リロード
 * 復元）時にも呼ばれるため、レースに勝つ必要が無く「実行中に差し替えを仕込み、後続の
 * 通常のリロードを待つ」だけで発火しうる。他4箇所（`persistManifest`/`cloneWorkspace`/
 * `resolveRealRemovalTarget`/`ensureIntegrationDir`）と同じく、`workspaceRoot`
 * （呼び出し元から固定値で渡り、攻撃者が差し替えられない唯一のアンカー）の実パスと
 * `path.relative(workspaceRoot, filePath)`から組み立てた「想定した場所」との厳密一致で
 * 判定する。
 *
 * **この確認は`readTextFile`より前に行う（Issue #505、確認順序の非対称の解消）。**
 * 以前はここが読み込みの後にあり、「読み込んだ内容がこの関数の外へ出ないので事後確認で
 * 足りる」という理由で許容していたが、他の読み出し箇所（`reflectIntegrationToWorkspace`の
 * 反映元コピー）が「読み出しの前に確認する」方針を明言しているのと非対称だった。ファイルが
 * まだ存在しない（初回実行等）場合の`realpath`の`undefined`はここでは正常系（後段の
 * `readTextFile`も`undefined`を返し、空マニフェストとして扱われる）のため、
 * `realFilePath !== undefined`のときだけ境界を確認し、フェイルクローズしない。
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

  // Issue #505（監査指摘、確認順序の非対称）: 事後の境界確認（realpathによる
  // isPathWithinRoot判定）を`readTextFile`より前に動かす。従来はこの確認が読み出しの
  // 後にあり、「読み込んだ内容がこの関数の外へ出ないので事後確認で足りる」という理由
  // （`reflectIntegrationToWorkspace`の反映元コピー側のコメント参照）で許容していたが、
  // その反映元コピーが「読み出しの前に確認する」方針を明言しているのと非対称だった。
  //
  // ファイルがまだ存在しない（初回実行、統合未実施）場合の`realpath`の`undefined`は
  // ここでは正常系（後段の`readTextFile`も`undefined`を返し、空マニフェストとして
  // `ok: true`になる）のため、境界確認は`realFilePath !== undefined`のときだけ行う。
  //
  // Issue #505（再々監査で発覚）: `realRoot`（`workspaceRoot`自身の`realpath`）は
  // このファイル内の全ての実パス厳密一致・境界確認における唯一のアンカーであり、
  // 攻撃者が動かせない前提そのもの。以前はここが`(await fs.realpath(workspaceRoot))
  // ?? workspaceRoot`という、確認できない場合に非正規化パスへ黙ってフォールバックする
  // 形になっていたが、アンカーであるべき値が確認できないのにフェイルオープンするのは
  // 筋が通らないため、確認できない場合はフェイルクローズする。
  //
  // Issue #505（セキュリティ監査、high）: ここが`isPathWithinRoot`のみだと、`filePath`が
  // ワークスペース内の別の実体（`.git/hooks`配下の攻撃者作成JSON等）へのシンボリック
  // リンクへ差し替えられていた場合に境界内として素通りしてしまう。他4箇所と同じ
  // `workspaceRoot`起点＋`path.relative`の厳密一致へ揃える。
  const realFilePath = await fs.realpath(filePath);
  if (realFilePath !== undefined) {
    const realRoot = await fs.realpath(workspaceRoot);
    const expectedFilePath =
      realRoot !== undefined ? path.join(realRoot, path.relative(workspaceRoot, filePath)) : undefined;
    if (realRoot === undefined || expectedFilePath === undefined || realFilePath !== expectedFilePath) {
      return {
        ok: false,
        message: `疑似worktreeの統合マニフェストを復元できませんでした（読み込み元が実際には想定した場所以外を指しています）: ${sanitizeForLog(filePath)}`,
      };
    }
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

  // Issue #505（監査指摘、二段構え）: 上の事前確認だけでは、確認した瞬間だけ
  // `realpath`が`undefined`（一時的な失敗も含む。ENOENTと区別できない）だった場合に、
  // 以降このcallで境界確認が一度も行われないまま内容を採用してしまう回帰が生じる
  // （旧実装は読み込み成功後に無条件で確認していたため、読み込みが成立した時点で
  // 必ず1回は確認が走っていた。この保証を後退させないため、読み込みが実際に成立した
  // ここでもう一度確認する）。「ファイルが元々無い」場合は直前の`content === undefined`
  // 分岐で既に空マニフェストとして返しているため、ここへ到達する時点で読み込みは
  // 成立済み＝`filePath`は実在する。したがってここでの`realFilePath2`の`undefined`は
  // 正常系ではなく、読み込みと確認の間で消えた・差し替えられた異常系として扱う。
  const realFilePath2 = await fs.realpath(filePath);
  const realRootForSecondCheck = await fs.realpath(workspaceRoot);
  const expectedFilePath2 =
    realRootForSecondCheck !== undefined
      ? path.join(realRootForSecondCheck, path.relative(workspaceRoot, filePath))
      : undefined;
  if (
    realFilePath2 === undefined ||
    expectedFilePath2 === undefined ||
    realFilePath2 !== expectedFilePath2
  ) {
    return {
      ok: false,
      message: `疑似worktreeの統合マニフェストを復元できませんでした（読み込み元が実際には想定した場所以外を指しています）: ${sanitizeForLog(realFilePath2 ?? filePath)}`,
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
 * さらに、`reflectIntegrationToWorkspace`の書き込み経路（PR #504）と同じ二段構えの
 * 二段目（書き込み後に実パスを確認し、境界外なら撤去する）も対にする（レビュー指摘:
 * medium、TOCTOU）。ここは間に`fs.mkdir(path.dirname(filePath))`を挟むぶん一次防御から
 * 実I/Oまでのウィンドウが他箇所より広く、非対称のまま放置すると一次防御をすり抜けられた
 * 場合に唯一無防備になる。
 *
 * **事後確認は「境界内か」（`isPathWithinRoot`）ではなく「想定した場所そのものか」の
 * 厳密一致にする（Issue #505、監査指摘）。** `isPathWithinRoot`だけだと、`dirPath`
 * （`<runId>`ディレクトリ）が`mkdir`から`writeTextFile`までの間にワークスペース内の
 * 別ディレクトリ（典型的には`.git/hooks`）を指すシンボリックリンクへ差し替えられた場合に
 * 「境界内」として素通りしてしまい、`manifest.json`という名前の既存ファイルを上書き
 * しうる（`hasGitSegment`によるIssue #406の`.git`無条件拒否は`relPath`の文字列にしか
 * 掛からないため迂回される）。
 *
 * **「想定した場所」は`dirPath`自身（あるいはその途中にある`.agents/worktrees`のような
 * 中間ディレクトリ）から組み立ててはいけない（Issue #505、再監査・再々監査で2段階発覚
 * した循環）。** 当初の実装は`dirPath`（`<runId>`）自身の`realpath`を基準にしていたが、
 * `dirPath`自体が差し替えられている攻撃では、`dirPath`の`realpath`も書き込み後の
 * `filePath`の`realpath`もどちらも差し替え後の実体（例: `.git/hooks`・
 * `.git/hooks/manifest.json`）を指すため必ず一致してしまい、検査が自己無矛盾になって
 * 何も検知できない（`cloneWorkspace`の実装コメントで実測済み。同じクラスの欠陥）。
 * 次に`resolveRealRemovalTarget`（Issue #493）の前例に倣い`worktreesRoot`
 * （`.agents/worktrees`）へ起点を引き上げたが、**`<ws>/.agents`自体がワークスペース内の
 * 別ディレクトリへ差し替えられると、`realpath(worktreesRoot)`と`realpath(filePath)`が
 * どちらも差し替え後の同じ実体を指してしまい、まったく同じ循環が1段上で再現する
 * （攻撃者は`.agents/worktrees`自体も動かせるため、これはアンカーとして成立しない）。**
 * 攻撃者が動かせない唯一のアンカーは、呼び出し元から固定値で渡る`workspaceRoot`
 * 自身であるため、ここまで起点を引き上げる。`workspaceRoot`の`realpath`が`undefined`を
 * 返すのはここでは正常系ではなく異常（TOCTOU窓の間に削除・差し替えされた）として
 * フェイルクローズする（`mkdir`が`recursive: true`で必ず`dirPath`を作る以上、
 * `workspaceRoot`自体は通常存在するはずのため）。
 */
export async function persistManifest(
  workspaceRoot: string,
  runId: string,
  manifest: IntegrationManifest,
  fs: PseudoWorktreeFileSystemPort,
): Promise<void> {
  const filePath = integrationManifestPath(workspaceRoot, runId);
  const dirPath = path.dirname(filePath);

  const symlinkedAncestor = await findSymlinkedAncestor(workspaceRoot, filePath, fs);
  if (symlinkedAncestor !== undefined) {
    throw new Error(
      `疑似worktreeの統合マニフェストの永続化先の経路にシンボリックリンクが含まれています。書き込みを中止しました: ${sanitizeForLog(symlinkedAncestor)}`,
    );
  }

  await fs.mkdir(dirPath);

  await fs.writeTextFile(filePath, serializeManifest(manifest));

  // Issue #505（再々監査で発覚）: `expected`の起点を`.agents/worktrees`
  // （`pseudoWorktreesRootDir(workspaceRoot)`）に置いていたが、これでもまだ低い。
  // `<ws>/.agents`自体が（`<ws>/.git`等）ワークスペース内の別ディレクトリへの
  // シンボリックリンクへ差し替えられると、`realpath(worktreesRoot)`と`realpath(filePath)`は
  // どちらも差し替え後の実体を指し、両者は必ず一致してしまう（`<runId>`を差し替える
  // 循環とまったく同じ構造で、起点が1段上がっただけでは解消しない）。
  // `resolveRealRemovalTarget`（Issue #493）も含め、このファイル内で`.agents/worktrees`
  // 起点にしていた箇所は全てこの穴を持っていた。攻撃者が動かせない唯一の起点は
  // 呼び出し元から固定値で渡る`workspaceRoot`自身であるため、ここへ揃える。
  //
  // Issue #505（レビュー指摘、low）: `realRoot`の取得は、他4箇所（`cloneWorkspace` /
  // `ensureIntegrationDir` / `resolveRealRemovalTarget` / `reflectIntegrationToWorkspace`）と
  // 同じく、比較対象の実パス（`realFilePath`）の取得と同じタイミング（比較の直前）に
  // 揃える。以前は`realRoot`だけを`writeTextFile`より前に取得しており、「取得できなければ
  // 書き込む前に打ち切る」という意図に見えたが、この関数は`realRoot`取得の前に既に
  // `mkdir(dirPath)`で`dirPath`（`<runId>`ディレクトリ）を作成済みであり、「書き込みより
  // 前に打ち切る」という性質はI/O全体では既に成立していない（ディレクトリの作成という
  // 副作用は`realRoot`取得前から発生している）。`writeTextFile`もこの関数のI/Oの一部でしか
  // ないため、その前に限って`realRoot`だけ先取りする理由は無く、揃えたほうが「4箇所は
  // 同じ形」という主張に対して素直になる。`realRoot`が取得できない場合は、下の分岐で
  // 書き込み済みの`filePath`を`removeFile`で取り消してから同じエラーとして報告する
  // （既存の不一致検知と同じ後始末）。
  const realRoot = await fs.realpath(workspaceRoot);
  const realFilePath = await fs.realpath(filePath);
  const expectedFilePath =
    realRoot !== undefined ? path.join(realRoot, path.relative(workspaceRoot, filePath)) : undefined;
  if (realFilePath === undefined || expectedFilePath === undefined || realFilePath !== expectedFilePath) {
    await fs.removeFile(filePath);
    throw new Error(
      `疑似worktreeの統合マニフェストの永続化先が実際には想定した場所以外を指していたため、` +
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
  /**
   * 空のディレクトリだけを非再帰的に削除する。対象が空でなければ削除しない
   * （中身を巻き込まない）。存在しない場合も削除しなかったものとして扱う。
   *
   * `removeRunDirIfEmpty`（Issue #438のレビュー指摘）が「readdirで空と判定してから
   * `removeDirRecursive`で消す」という二段構えをやめ、判定と削除をOSレベルで一体化する
   * ために使う。`fsPromises.rmdir`は対象が空でなければ`ENOTEMPTY`を投げる性質があり、
   * それをそのまま「消さなかった」の合図として使うことで、判定と削除の間に他プロセスが
   * ファイルを置く余地（TOCTOU）が構造的に無くなる。
   */
  removeEmptyDir(target: string): Promise<void>;
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
  async removeEmptyDir(target: string): Promise<void> {
    try {
      await fsPromises.rmdir(target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOTEMPTY' || code === 'ENOENT' || code === 'EEXIST') {
        return;
      }
      throw error;
    }
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
 * 5. 二次防御: 実際に作られた場所を実パス解決し、呼び出し元から固定値で渡る
 *    `workspaceRoot`（攻撃者が差し替えられない唯一のアンカー）の実パスを基準に組み立てた
 *    「想定した場所」と厳密一致することを確認する。ここで多数のファイルをコピーする前に
 *    確認することで、境界を外れた場合の書き込みを最小限（空ディレクトリ1つ）に抑える
 * 6. ワークスペースを複製し、複製先のスナップショットを返す
 *
 * `retry`は`worktree.ts`の`createWorktree`と同じ意味（Issue #396）。再試行のたびに
 * 呼び出し側（`runnerWorkingDirectory.ts`）が異なる`retry`を渡すことで、`pseudoWorktreePath`が
 * 別ディレクトリを指すようになり、前回の複製が残っていても`alreadyExists`にならない。
 *
 * **5.の事後確認は「境界内か」（`isPathWithinRoot`）ではなく「想定した場所そのものか」の
 * 厳密一致にする（Issue #505、監査指摘）。** `isPathWithinRoot`だけだと、`target`自身が
 * `mkdir`から実パス確認までの間にワークスペース内の別ディレクトリ（典型的には
 * `.git/hooks`）を指すシンボリックリンクへ差し替えられた場合に「境界内」として素通り
 * してしまい、後続のコピーループが`.git/hooks`配下へワークスペースの内容を書き込みうる
 * （`hasGitSegment`によるIssue #406の`.git`無条件拒否は`relPath`の文字列にしか掛からない
 * ため迂回される）。
 *
 * **「想定した場所」は`target`の直接の親から組み立ててはいけない（Issue #505、再監査で
 * 発覚した循環）。** 当初の実装は`target`の親ディレクトリ（`<runId>`）自身の`realpath`を
 * 基準にしていたが、その親ディレクトリ自体が差し替えられている攻撃では、親の`realpath`も
 * `target`の`realpath`もどちらも差し替え後の実体を指すため必ず一致してしまい、検査が
 * 自己無矛盾になって何も検知できない（実測で確認済み。下の実装コメント参照）。
 * 次に`resolveRealRemovalTarget`（Issue #493）の前例に倣い`worktreesRoot`
 * （`.agents/worktrees`。`<runId>`より1段上）へ起点を引き上げたが、**`<ws>/.agents`自体が
 * ワークスペース内の別ディレクトリへ差し替えられると、`realpath(worktreesRoot)`と
 * `realpath(target)`がどちらも差し替え後の同じ実体を指してしまい、まったく同じ循環が
 * 1段上で再現する（`.agents/worktrees`はアンカーとして成立しない）。** 攻撃者が動かせない
 * 唯一のアンカーは、呼び出し元から固定値で渡る`workspaceRoot`自身であるため、ここまで
 * 起点を引き上げる。`workspaceRoot`の`realpath`が`undefined`を返すのはここでは正常系では
 * なく異常（TOCTOU窓の間に削除・差し替えされた）としてフェイルクローズする。
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

  // Issue #505（監査指摘、再監査でさらに発覚）: 事後確認の`expected`は、`target`の
  // **親から**組み立ててはいけない。当初の実装は`realParentDir = await fs.realpath(parentDir)`
  // （`parentDir = path.dirname(target)`）から`expectedTarget`を組み立てていたが、
  // `parentDir`自体が`.git/hooks`等へ差し替えられている攻撃では、`realpath(parentDir)`も
  // `realpath(target)`もどちらも差し替え後の実体（`.git/hooks`・`.git/hooks/T1`）を指す
  // ため、両者は必ず一致してしまい、検査が自己無矛盾（攻撃者に汚染された値どうしを
  // 比較しているだけ）になって何も検知できない。実測でも
  // `mkdir(target, {recursive:true})`は例外を投げずに`.git/hooks/T1`を作ってしまい、
  // このチェックを素通りすることを確認済み。
  //
  // **`.agents/worktrees`（`worktreesRoot`）を起点にしても同じ穴が残る。** 一度目の
  // 修正ではここを`resolveRealRemovalTarget`（Issue #493）の前例に倣い`worktreesRoot`
  // 起点へ直したが、`<ws>/.agents`自体が（`<ws>/.git`等）ワークスペース内の別ディレクトリ
  // へ差し替えられると、`realpath(worktreesRoot)`と`realpath(target)`はどちらも差し替え
  // 後の実体を指し、やはり必ず一致してしまう。起点をどれだけ`target`から遠ざけても、
  // その起点自体が攻撃者の書き込み可能な範囲にある限り同じ循環が再現する。
  // 攻撃者が動かせない唯一のアンカーは、呼び出し元から固定値で渡る`workspaceRoot`
  // 自身であるため、ここまで起点を引き上げる。
  const realRoot = await fs.realpath(workspaceRoot);
  const realTarget = await fs.realpath(target);
  const expectedTarget =
    realRoot !== undefined ? path.join(realRoot, path.relative(workspaceRoot, target)) : undefined;
  if (realTarget === undefined || expectedTarget === undefined || realTarget !== expectedTarget) {
    // Issue #505（監査指摘）: ここで`fs.removeDirRecursive(target)`を呼ぶと、`target`の
    // 祖先ディレクトリ（`<runId>`）が`.git/hooks`等の既存ディレクトリへ差し替えられていた場合、`target`は文字列上は
    // 「自分がmkdirした空ディレクトリ」でも、実体はそのシンボリックリンクを辿った先の
    // 既存ディレクトリ（`.git/hooks/<taskId>`等）になっている。この状態で再帰削除すると、
    // 攻撃者の差し替え先にあった既存の内容ごと消してしまい、境界外へのコピーより悪い
    // 結果（任意ディレクトリの再帰削除）になる。`target`が本当に自分の作った空ディレクトリ
    // なのか、差し替えられた先の既存ディレクトリなのかを、渡されたパス文字列だけでは
    // 区別できない（`fs.promises`にはこれを安全に見分ける`openat`相当が無い。design.mdの
    // 同種の残存TOCTOU窓の記述を参照）ため、ここでは削除を試みず、複製自体を打ち切る
    // だけに留める（残りうるのは、境界の外・想定と異なる場所に作られた空ディレクトリ1つ
    // であり、書き込み・削除のどちらよりも被害が小さい）。
    //
    // **削除しないと決めた後に残る「空ディレクトリ」がどうなるか（Issue #505フォローアップ、
    // ここを「後始末漏れ」と見て`removeDirRecursive`を復活させないこと）。**
    //
    // 実際に`<runId>`ディレクトリが差し替えられた攻撃のケースでは、シンボリックリンクは
    // 既存のディレクトリを同名で置き換えることでしか作れない（`symlink`は対象名が既に存在すると
    // 失敗する）ため、攻撃者が`<runId>`を差し替える操作それ自体が、直前に`mkdir(target)`で
    // 作った実体を道連れに消す。つまりこの経路では「自分が作った空ディレクトリ」はそもそも
    // 残らない（攻撃者の差し替え後の実体は攻撃者自身の`.git/hooks`であり、我々の後始末の
    // 対象ではない）。
    //
    // 残りうるのは、差し替えが起きていない良性のfail-close（一時的なI/O障害等で
    // `realpath`が想定外の値を返した場合）で、この場合`target`は差し替えられておらず、
    // 想定どおりの場所（`.agents/worktrees/<runId>/<taskId>`、`retry`ありなら
    // `-retry<n>`付き）に空ディレクトリとして残る。これは**回収される**。
    // `removeWorktrees`（`runner.ts:1875`、UIの「統合ブランチと残ったworktreeをまとめて
    // 片付ける」操作＝`cleanupIntegration`から呼ばれる）が、`state`が`done`/`failed`/
    // `blocked`/`skipped`のいずれかになった全タスクに対して`removePseudoTaskWorktree`
    // （`runner.ts:1985`）を呼び、`removePseudoWorktreeAttempts`（`pseudoWorktree.ts:1201`。
    // `retry`なし＋`0..totalAttempts-1`の全試行分）経由で`removePseudoWorktree`を呼ぶ。
    // `cloneWorkspace`の失敗は`prepareTaskLaunch`の例外として`startTask`（`runner.ts`）の
    // catchで捕捉され`applyLoopStopReason(..., 'failed')`によりタスクは`failed`になる
    // ため、この対象に含まれる（実装を`git grep`で追って確認済み）。`removePseudoWorktree`
    // 自身も呼び出し前に`resolveRealRemovalTarget`（Issue #493）で「`.agents/worktrees`
    // 配下の想定した場所そのものか」を厳密一致で確かめてから消すため、通常の
    // worktree撤去と同じ安全性で回収される。
    //
    // 回収は`cleanupIntegration`という利用者操作を経由するため即時ではないが、これは
    // 疑似worktreeの通常の後始末モデルと同じである。`removePseudoWorktreeAttempts`自身の
    // JSDocが明言するとおり、過去の`retry`試行分の複製も同じ経路でしか回収されない
    // （run実行中に自動では消えない）設計であり、この失敗ケースだけが特別に放置される
    // わけではない。また、直後に同じ`retry`値で再度`cloneWorkspace`を呼んでも、冒頭の
    // `directoryExists(target)`チェックが引っかかって`alreadyExists`になるだけで、
    // 黙って上書き・混在することはない（この判定自体は本Issueより前から存在する）。
    return {
      ok: false,
      reason: 'boundaryEscape',
      message: `複製先が実際には想定した場所以外を指しているため、複製を中止しました: ${sanitizeForLog(realTarget ?? target)}`,
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
  | {
      ok: false;
      reason: 'invalidIdentifier' | 'boundaryEscape' | 'removalFailed';
      message: string;
    };

export type RemovePseudoIntegrationResult =
  | { ok: true; warning?: string }
  | {
      ok: false;
      reason: 'invalidIdentifier' | 'boundaryEscape' | 'removalFailed';
      message: string;
    };

/**
 * 撤去3関数（`removePseudoWorktree` / `removeManifestFile` / `removeRunDirIfEmpty`）に
 * 共通する、消す前の実パス確認（Issue #493。Issue #484 / PR #504が
 * `reflectIntegrationToWorkspace`の書き込み・削除経路に適用した規律を、撤去系3関数へも
 * 横展開する）。
 *
 * 事後確認を「`.agents/worktrees`の境界内か」（`isPathWithinRoot`）ではなく
 * 「想定していた場所そのものか」の厳密一致にする。`isPathWithinRoot`だけだと、
 * `target`の途中のディレクトリ（典型的には`<runId>`）が`.agents/worktrees`配下の別
 * ディレクトリ（他runの複製や統合先）を指すシンボリックリンクへ差し替えられていた場合に
 * 「境界内」として素通りしてしまい、撤去対象を取り違えたまま削除してしまう。`target`は
 * `runId`/`taskId`（`identifierError`/`runIdError`で検証済み）から組み立てる固定構造の
 * パスであり、`path.relative`は途中のディレクトリが差し替えられても変わらない文字列
 * 計算のため、これを実パス解決済みのルートへ再度連結した値を「想定した場所」として
 * 比較する。
 *
 * **この「実パス解決済みのルート」は`.agents/worktrees`（`worktreesRoot`）ではなく
 * `workspaceRoot`にする（Issue #505、再々監査で発覚）。** この関数自身もかつては
 * `worktreesRoot`を起点にしており「攻撃者が動かせないルート」の前例として他の3箇所へ
 * 横展開されていたが、`<ws>/.agents`自体がワークスペース内の別ディレクトリへ差し替え
 * られると、`realpath(worktreesRoot)`と`realpath(target)`がどちらも差し替え後の同じ実体を
 * 指してしまい、`.agents/worktrees`を起点にする限り必ず一致してしまう（`<runId>`を差し
 * 替える攻撃とまったく同じ循環構造）。攻撃者が動かせない唯一のアンカーは、呼び出し元
 * から固定値で渡る`workspaceRoot`自身であるため、ここへ起点を引き上げる。
 *
 * 呼び出し側との役割分担: ここでは「何を削除してよいか」の確認だけを行い、実際の削除
 * （`removeDirRecursive`/`removeFile`/`removeEmptyDir`）とその失敗の扱いは呼び出し側に残す
 * （関数によって削除方法が異なるため）。
 */
async function resolveRealRemovalTarget(
  workspaceRoot: string,
  target: string,
  fs: PseudoWorktreeFileSystemPort,
): Promise<
  | { status: 'absent' }
  | { status: 'ok'; realTarget: string }
  | { status: 'mismatch'; realTarget: string | undefined }
> {
  const realTarget = await fs.realpath(target);
  if (realTarget === undefined) {
    // 対象が既に存在しない（既に撤去済み、または元々作られなかった）。`realpath`は
    // ENOENTを含むあらゆる失敗でundefinedを返す（`PseudoWorktreeFileSystemPort`の
    // JSDoc参照）ため、ここは正常系として扱う。
    return { status: 'absent' };
  }
  // 規範: `expected`は、攻撃者が差し替えられない起点から組み立てること。**差し替え
  // られうる中間ノード（`target`自身の親、あるいは`.agents/worktrees`のような中間
  // ディレクトリ）の`realpath`から組み立ててはいけない。** 差し替えられうるノードを
  // 起点にすると、そのノード自体がシンボリックリンクへ差し替えられていた場合、起点の
  // `realpath`も`target`の`realpath`もどちらも差し替え後の同じ実体を指すため比較が
  // 常に一致してしまい、検査が自己無矛盾になって何も検知できなくなる（Issue #484の
  // 書き込み経路・削除経路、Issue #505で再発を確認した`cloneWorkspace`/`persistManifest`
  // いずれも、`target`の直接の親から`expected`を組み立てていたためにこの欠陥を持って
  // いた。レビュー・監査を2巡通過してマージされた実装でも再発したため、次に実パス
  // 厳密一致の検査を書く際はこの関数の形へ揃えること。新しい起点の選び方を発明しない
  // こと）。
  //
  // **この関数自身もかつて`.agents/worktrees`（`pseudoWorktreesRootDir(workspaceRoot)`）を
  // 起点にしており、同じ循環を持っていた（Issue #505、再々監査で発覚）。** `<ws>/.agents`
  // 自体がワークスペース内の別ディレクトリへ差し替えられると、`realpath(worktreesRoot)`と
  // `realpath(target)`はどちらも差し替え後の実体を指し、やはり必ず一致してしまう。
  // 起点をどれだけ`target`から遠ざけても、その起点自体が攻撃者の書き込み可能な範囲に
  // ある限り同じ穴が再現するため、攻撃者が動かせない唯一のアンカー＝呼び出し元から
  // 固定値で渡る`workspaceRoot`自身まで起点を引き上げてある。
  const realRoot = await fs.realpath(workspaceRoot);
  if (realRoot === undefined) {
    return { status: 'mismatch', realTarget };
  }
  const expectedTarget = path.join(realRoot, path.relative(workspaceRoot, target));
  if (realTarget !== expectedTarget) {
    return { status: 'mismatch', realTarget };
  }
  return { status: 'ok', realTarget };
}

/**
 * 削除操作の実行をラップし、失敗を`Result`型へ正規化する（Issue #493）。
 *
 * `fs.removeDirRecursive`/`removeFile`/`removeEmptyDir`はいずれも「対象が既に無い」
 * （`ENOENT`等）は自前で握りつぶす規約だが、`EACCES`/`EPERM`等の権限エラーは素通りで
 * throwする。呼び出し側（`removePseudoWorktree`等）に`try/catch`が無いと、この例外が
 * `removePseudoIntegration`を越えて`runner.ts`の`cleanupIntegration`まで伝播しうる
 * （Issue #438が問題視した「削除失敗が握り潰される」の逆方向で、失敗が例外化されて
 * 上位を巻き込む）。ここでcatchし、他の失敗（`boundaryEscape`等）と同じ`Result`型へ
 * 正規化することで、呼び出し側は常に戻り値だけを見ればよい状態を保つ。
 *
 * **権限エラーだけの話ではない。** 上の「境界内リダイレクト」と同一のシナリオで実際に
 * 連鎖する。`<runId>`ディレクトリがファイルや他ディレクトリへのシンボリックリンクへ
 * 差し替えられていると、`removeRunDirIfEmpty`の`rmdir`は「ディレクトリではないもの」に
 * 対する呼び出しになり`ENOTDIR`を投げる。従来はこれが未捕捉のまま上位を巻き込んでいた
 * （Issue #493のRED確認で実際に観測した）。つまりここでcatchするのは、`EACCES`のような
 * 環境要因への保険ではなく、**差し替え攻撃そのものが例外の形で現れる経路を塞ぐため**でも
 * ある。この`try/catch`を「握り潰し」と見て外さないこと。
 */
async function tryRemove(
  operation: () => Promise<void>,
  target: string,
): Promise<{ ok: true } | { ok: false; reason: 'removalFailed'; message: string }> {
  try {
    await operation();
    return { ok: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: 'removalFailed',
      message: `撤去に失敗しました（${sanitizeForLog(target)}）: ${sanitizeForLog(detail)}`,
    };
  }
}

/**
 * 疑似worktree（`<workspace>/.agents/worktrees/<runId>/<taskId>`）を1件撤去する。
 * `taskId`に`'_integration'`を渡せば統合先（`integrationPath`と同じ場所）も同じ入口で
 * 撤去できる（`pseudoWorktreePath`と`integrationPath`は同じ組み立てのため）。
 *
 * gitの`removeWorktree`（`worktree.ts`）と違い「`git worktree remove`だけを使う」という
 * 安全弁が無く、`removeDirRecursive`でディレクトリを直接消す必要がある。`cloneWorkspace`が
 * 作成時に行う二段構え（一次防御: 祖先ディレクトリのシンボリックリンク検知、二次防御:
 * 作成後の実パス解決による境界確認）のうち、ここでは後段だけを撤去向けに行う。
 * **消す前に対象を実パス解決し、その実体が想定した場所（`resolveRealRemovalTarget`）と
 * 厳密に一致することを確かめる。** ここで確かめずに`removeDirRecursive`へ渡すと、
 * `.agents/worktrees`自体や`<runId>`ディレクトリがシンボリックリンクに差し替えられていた
 * 場合にリンク先（ワークスペースの外、または`.agents/worktrees`配下の別の実体）を
 * 再帰削除してしまう。
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

  const check = await resolveRealRemovalTarget(workspaceRoot, target, fs);
  if (check.status === 'absent') {
    return { ok: true };
  }
  if (check.status === 'mismatch') {
    return {
      ok: false,
      reason: 'boundaryEscape',
      message:
        `撤去対象が実際には想定した場所以外を指しているため撤去しませんでした: ` +
        `${sanitizeForLog(check.realTarget ?? target)}`,
    };
  }

  // 削除操作自体は、確認済みの実パス（`check.realTarget`）に対して行う（Issue #493の
  // 対応候補1）。これは「一次防御＋二次防御」の二段構えの後段であり、確認から削除まで
  // 一切のI/Oを挟まない（残存する僅かな窓——確認後・削除前に`realTarget`自身の祖先が
  // 差し替えられる場合——はNode標準API（`fs.promises`）だけでは閉じ切れない。
  // `openat`/`O_NOFOLLOW`相当が`FileHandle`に無く、移植可能な形での解消は不可能と
  // Issue #484で判明済み。過剰な作り込みはせず、規律の統一と将来の退行防止に留める）。
  return tryRemove(() => fs.removeDirRecursive(check.realTarget), check.realTarget);
}

/**
 * `<runId>/manifest.json`（`integrationManifestPath`、Issue #380）を撤去する。
 * `removePseudoWorktree`と同じ規律（消す前に実パス解決し、想定した場所と厳密に一致する
 * ことを確かめる。削除自体も確認済みの実パスに対して行う）を、ディレクトリではなく
 * ファイル1つに対して行う。
 */
async function removeManifestFile(
  workspaceRoot: string,
  runId: string,
  fs: PseudoWorktreeFileSystemPort,
): Promise<RemovePseudoIntegrationResult> {
  const identifierMessage = runIdError(runId);
  if (identifierMessage !== undefined) {
    return { ok: false, reason: 'invalidIdentifier', message: identifierMessage };
  }
  const target = integrationManifestPath(workspaceRoot, runId);

  const check = await resolveRealRemovalTarget(workspaceRoot, target, fs);
  if (check.status === 'absent') {
    return { ok: true };
  }
  if (check.status === 'mismatch') {
    return {
      ok: false,
      reason: 'boundaryEscape',
      message:
        `撤去対象が実際には想定した場所以外を指しているため撤去しませんでした: ` +
        `${sanitizeForLog(check.realTarget ?? target)}`,
    };
  }

  return tryRemove(() => fs.removeFile(check.realTarget), check.realTarget);
}

/**
 * `_integration`と`manifest.json`をどちらも撤去し終えた後、`<runId>`ディレクトリ自体が
 * 空になっていれば片付ける。空でなければ（他タスクの複製がまだ残っている、あるいは
 * `removeWorktrees`が先に走らず未撤去のタスクがある等）そのディレクトリには触れず、
 * 中身を温存する。`<runId>`という入れ物自体には情報が無い（`_integration`と
 * `manifest.json`が無くなればもう意味を持たない）ため、空なら消してよいと判断した。
 *
 * 「空かどうかを`readdir`で判定してから`removeDirRecursive`で消す」という二段構えだと、
 * 判定と削除の間（TOCTOU窓）に`retryMergeTask`のマージ継続や`cloneWorkspace`の再複製が
 * 同じ`<runId>`配下へ書き込みを始めた場合、そのファイルごと丸ごと消してしまう。
 * `removePseudoWorktree`（`<runId>/<taskId>`粒度）と違い、ここは兄弟ディレクトリを
 * 巻き込みうる`<runId>`粒度の再帰削除であり、この種のレースを許容できない。そのため
 * `removeEmptyDir`（非再帰の`rmdir`。対象が空でなければOS側が`ENOTEMPTY`で拒否する）を使い、
 * 「空だと判定すること」と「削除すること」を1回のシステムコールへ一体化する。空でなければ
 * 削除自体が起きないため、レースが窓として成立しない。
 *
 * 境界逸脱（`<runId>`が実際には想定した場所以外を指す）を検知した場合、または削除自体が
 * 失敗した場合は`ok:false`を返すが、`removePseudoIntegration`はこれを致命的失敗としては
 * 扱わない（`_integration`と`manifest.json`の撤去は既に完了しているため、Issue #438が
 * 塞ごうとした「幽霊マニフェストの読み戻し」は起きない。入れ物が片付かなかっただけ）。
 * 呼び出し側で警告として観測できれば足りる。
 *
 * 消す前に実パス解決し想定した場所と厳密に一致することを確かめ、削除自体も確認済みの
 * 実パスに対して行う規律（Issue #493）は`removePseudoWorktree`/`removeManifestFile`と同じ。
 */
async function removeRunDirIfEmpty(
  workspaceRoot: string,
  runId: string,
  fs: PseudoWorktreeFileSystemPort,
): Promise<RemovePseudoIntegrationResult> {
  const runDir = path.join(pseudoWorktreesRootDir(workspaceRoot), runId);

  const check = await resolveRealRemovalTarget(workspaceRoot, runDir, fs);
  if (check.status === 'absent') {
    return { ok: true };
  }
  if (check.status === 'mismatch') {
    return {
      ok: false,
      reason: 'boundaryEscape',
      message:
        `runIdディレクトリが実際には想定した場所以外を指しているため撤去しませんでした: ` +
        `${sanitizeForLog(check.realTarget ?? runDir)}`,
    };
  }

  return tryRemove(() => fs.removeEmptyDir(check.realTarget), check.realTarget);
}

/**
 * 統合worktree（`_integration`）と、その永続化マニフェスト（`manifest.json`、Issue #380）を
 * まとめて撤去する（Issue #438）。
 *
 * 生成側（`integrationManifestPath`）は`manifest.json`を`_integration`と同じ`<runId>`配下に
 * 置くが、撤去側は従来`removePseudoWorktree(..., '_integration', ...)`しか呼んでおらず、
 * 兄弟の`manifest.json`が残り続けていた。残ったマニフェストを`resolvePseudoState`が
 * 読み戻すと、実体の無い`_integration`を指す古いエントリで`IntegrationQueue`が
 * 再構築され、再実行時の`reflectPseudoWorktree`が「消えたsourceからの`copyFile`」の
 * 警告や、`kind:'deleted'`のエントリによる「ワークスペース側ファイルの再削除」を
 * 引き起こす（Issueの実害）。
 *
 * 撤去順序: 1) `manifest.json` 2) `_integration`本体（`removePseudoWorktree`をそのまま使う）
 * 3) `<runId>`ディレクトリ自体が空になっていれば、その入れ物も消す。1か2が失敗すれば
 * そこで打ち切り、部分的な状態のまま3へは進まない。
 *
 * **なぜmanifest優先か（レビュー指摘・Issue #438の再発防止）。** 素朴には`_integration`を
 * 先に消したくなる（生成順の逆）が、それだと非対称な穴が残る。`<runId>/_integration`
 * だけがシンボリックリンクに差し替えられ`manifest.json`は正当なファイルのまま、という
 * 状況で`_integration`を先に撤去しようとすると`removePseudoWorktree`が`boundaryEscape`で
 * 打ち切り、`manifest.json`が一度も撤去されない。残ったマニフェストを次回`resolvePseudoState`
 * が読み戻すと、Issue #438がまさに塞ごうとした「実体の無い`_integration`を指す古い
 * マニフェストの読み戻し」が再現する。
 *
 * 逆に`manifest.json`を先に消せば、対称の穴（`manifest.json`だけがシンボリックリンク化され
 * `_integration`は残る）は生じるが、その場合は**マニフェストが既に無いので幽霊読み戻し
 * 自体が発生しない**。実害（幽霊マニフェストの読み戻し）に対して二つの順序は非対称であり、
 * manifest優先のほうが安全側に倒れる。なお`<runId>`ディレクトリ全体がシンボリックリンク化
 * されるケースは、順序に関わらず`manifest.json`側の実パス解決も同じく境界外へ解決される
 * ため両方`boundaryEscape`になり、この変更で退行しない。
 *
 * 消す前に実パス解決して`.agents/worktrees`配下にあることを確認する規律は
 * `removePseudoWorktree`と同じ（PR #444のシンボリックリンク対策への退行を避ける）。
 * 削除対象は常に当該`runId`配下のみで、他runの`manifest.json`や複製には触れない。
 */
export async function removePseudoIntegration(
  workspaceRoot: string,
  runId: string,
  fs: PseudoWorktreeFileSystemPort,
): Promise<RemovePseudoIntegrationResult> {
  const manifestResult = await removeManifestFile(workspaceRoot, runId, fs);
  if (!manifestResult.ok) {
    return manifestResult;
  }

  const integrationResult = await removePseudoWorktree(
    workspaceRoot,
    runId,
    INTEGRATION_DIR_NAME,
    fs,
  );
  if (!integrationResult.ok) {
    return integrationResult;
  }

  const runDirResult = await removeRunDirIfEmpty(workspaceRoot, runId, fs);
  if (!runDirResult.ok) {
    // `<runId>`の入れ物が片付かなかっただけで、`manifest.json`と`_integration`の撤去は
    // 既に成功している（Issue #438の実害はここでは起きない）。呼び出し側
    // （`runner.ts`の`cleanupIntegration`）が警告として観測できれば足りるため、
    // 全体をok:falseにはせず`warning`へ委ねる。
    return { ok: true, warning: runDirResult.message };
  }
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
 * （gitの統合worktreeと同じ役割。design.md §16.17）。`cloneWorkspace`と同じ二段構えの
 * シンボリックリンク対策（一次防御: `findSymlinkedAncestor`によるI/O前の事前検知、
 * 二次防御: 事後の実パス厳密一致）を行う。
 *
 * Issue #505 / #526（監査指摘）: 事後確認はかつて`isPathWithinRoot`（境界内か）のみで、
 * 厳密一致を欠いていた。`<runId>`が一次防御通過後に`.git/hooks`等ワークスペース**内**の
 * 別ディレクトリへ差し替えられると（境界内リダイレクト）、`mkdir`が`.git/hooks/_integration`
 * を作ってしまっても`isPathWithinRoot`はtrueを返すため素通りしていた（攻撃A）。
 * 加えて、境界外と正しく検知できた場合でも無条件に`fs.removeDirRecursive(dir)`を呼んで
 * いたため、`<runId>`がワークスペース**外**の既存ディレクトリへのシンボリックリンクへ
 * 差し替えられていると、その差し替え先の実体（既存のファイルを含む）を丸ごと再帰削除
 * してしまっていた（攻撃B。実測で検証先に置いたファイルが消えることを確認済み）。
 * これは`cloneWorkspace`が同じ理由（`fs.promises`に`openat`相当が無く「自分が作った
 * 空ディレクトリか」を安全に判別できない）で撤去をやめた操作そのものであり、この関数
 * だけが取り残されていた。
 *
 * 他の3+1箇所（`persistManifest` / `cloneWorkspace` / `reflectIntegrationToWorkspace`の
 * 書き込み・削除経路）と同じ「攻撃者が動かせないルート（呼び出し元から固定値で渡る
 * `workspaceRoot`自身。`.agents/worktrees`のような中間ディレクトリは、その中間ディレク
 * トリ自体の差し替えで同じ循環が再現するため起点にならない）＋`path.relative`」の
 * 厳密一致へ揃え、不一致・境界外と判明した場合は撤去せず作成の中止のみに留める。
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

  // Issue #505 / #526（再々監査で発覚）: `expected`の起点を`.agents/worktrees`
  // （`pseudoWorktreesRootDir(workspaceRoot)`）に置いていたが、これでもまだ攻撃者の
  // 手が届く。`<ws>/.agents`自体がワークスペース内の別ディレクトリへ差し替えられると、
  // `realpath(worktreesRoot)`と`realpath(dir)`はどちらも差し替え後の実体を指し、
  // 必ず一致してしまう（`<runId>`を差し替える攻撃とまったく同じ構造で、起点が1段
  // 上がっただけでは解消しない）。攻撃者が動かせない唯一のアンカーは呼び出し元から
  // 固定値で渡る`workspaceRoot`自身であるため、ここへ揃える。
  const realRoot = await fs.realpath(workspaceRoot);
  const realDir = await fs.realpath(dir);
  const expectedDir =
    realRoot !== undefined ? path.join(realRoot, path.relative(workspaceRoot, dir)) : undefined;
  if (realDir === undefined || expectedDir === undefined || realDir !== expectedDir) {
    // Issue #505 / #526（監査指摘）: ここで`fs.removeDirRecursive(dir)`は呼ばない。
    // `<runId>`が差し替えられている攻撃では、`dir`は文字列上「自分がmkdirした空
    // ディレクトリ」でも、実体は差し替え先の既存ディレクトリになっている可能性があり
    // （`cloneWorkspace`の同種のコメント参照）、`target`が自分の作った空ディレクトリなのか
    // 差し替え先の既存ディレクトリなのかを渡されたパス文字列だけでは区別できない
    // （`openat`相当の欠如）。撤去せず作成を中止するだけに留め、残りうる空ディレクトリは
    // `cloneWorkspace`と同じ経路（`removeWorktrees`等）での回収に委ねる。
    return {
      ok: false,
      reason: 'boundaryEscape',
      message: `統合先が実際には想定した場所以外を指しているため、作成を中止しました: ${sanitizeForLog(realDir ?? dir)}`,
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

/**
 * 反映の途中で、`rename`を持たないポート実装向けの後方互換経路（TOCTOU対策の無い
 * 直接コピー、Issue #445のフォールバック）へ1回でも落ちたか。1エントリごとではなく
 * 反映全体（1回の`reflectIntegrationToWorkspace`呼び出し）で1個のフラグにする。
 * 呼び出し側（`runnerWorkingDirectory.ts`の`reflectPseudoWorktree`）はこれを見て、
 * 反映1回につき1回だけ警告ログを出す（ファイル単位で出すとログが溢れるため）。
 */
type LegacyCopyFallbackUsed = { usedLegacyCopyFallback: boolean };

export type ReflectToWorkspaceResult =
  | ({ ok: true; appliedPaths: string[] } & SkippedPaths & LegacyCopyFallbackUsed)
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
    } & SkippedPaths &
      LegacyCopyFallbackUsed);

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

  // Issue #505（再々監査で発覚）: `realRoot`（`workspaceRoot`自身の`realpath`）は
  // このファイル内の実パス厳密一致における唯一のアンカーであり、攻撃者が動かせない
  // 前提そのもの。以前はここが`(await fs.realpath(workspaceRoot)) ?? workspaceRoot`
  // という、確認できない場合に非正規化パスへ黙ってフォールバックする形になっていたが、
  // アンカーであるべき値が確認できないのにフェイルオープンするのは筋が通らないため、
  // 確認できない場合はフェイルクローズする（`partialApply`。まだ1件も反映していない
  // ため`appliedPaths`は空、全エントリを`remainingPaths`として返す）。
  const realRoot = await fs.realpath(workspaceRoot);
  if (realRoot === undefined) {
    return {
      ok: false,
      reason: 'partialApply',
      message: `ワークスペースルート自身の実パスを確認できなかったため、反映を中止しました: ${sanitizeForLog(workspaceRoot)}`,
      appliedPaths: [],
      failedPath: workspaceRoot,
      remainingPaths: [...manifest.keys()],
      skippedPaths: [],
      usedLegacyCopyFallback: false,
    };
  }
  const realIntegrationDir = (await fs.realpath(integrationDir)) ?? integrationDir;

  const entries = [...manifest.entries()];
  const appliedPaths: string[] = [];
  const skippedPaths: string[] = [];
  let usedLegacyCopyFallback = false;
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
        //
        // Issue #484（監査指摘、書き込み側と同じ穴が削除側にも残っていた）:
        // 「境界内か」ではなく「想定していた場所そのものか」を厳密一致で確かめる。
        // `isPathWithinRoot`だけだと、`target`の親ディレクトリ（`relPath`の親、例: `sub`）
        // がTOCTOU窓の間にワークスペース内の別ディレクトリ（典型的には`.git/hooks`）を
        // 指すシンボリックリンクへ差し替えられた場合に「境界内」として素通りしてしまい、
        // `hasGitSegment`（Issue #406の`.git`無条件拒否）は`relPath`の文字列しか見ていない
        // ためこの経路は迂回できてしまう。
        //
        // **「想定した場所」は`target`の親（`targetDir`）自身から組み立ててはいけない
        // （Issue #505、再監査で発覚した循環。マージ済みのPR #504で入った実装に残っていた
        // 欠陥）。** `targetDir`自体が差し替えられている攻撃では、`targetDir`の`realpath`も
        // `target`の`realpath`もどちらも差し替え後の実体を指すため必ず一致してしまい、
        // 検査が自己無矛盾になって何も検知できない（`cloneWorkspace`の実装コメントで
        // 実測済み。同じクラスの欠陥）。ここでは関数冒頭で確定済みの`realRoot`
        // （`workspaceRoot`自身の`realpath`。攻撃者はこの経路の`relPath`ループの外にいる
        // ため動かせない）を基準に、`path.relative(workspaceRoot, target)`という文字列
        // 計算（差し替えの影響を受けない）を再度連結して「想定した場所」を組み立てる。
        const targetDir = path.dirname(target);
        const realTargetDir = await fs.realpath(targetDir);
        if (realTargetDir === undefined) {
          // 親ディレクトリが無い＝削除対象も存在しない正常系（`realpath`はENOENTを
          // 含むあらゆる失敗でundefinedを返す。書き込み側の`realTargetDir`確認とは
          // 異なり、こちらは新規作成の前提が無いため「無ければ何もしない」でよい）。
          // `removeFile`は「存在しなくてもエラーにしない」規約（下の`PseudoWorktreeFileSystemPort`
          // のJSDoc参照）なので、対象が無いときに何もしないのは修正前と同じ挙動である。
          // `skippedPaths`は`exclude`に一致したパスを人へ見せるためのもので意味が違うため
          // ここでは使わない（`runnerWorkingDirectory.ts`側の警告文言は「除外設定に一致した」
          // 前提で固定されており、事実と食い違う）。それでも`removeFile`を呼ばずに`continue`
          // するのは、`realpath`が失敗したまま`removeFile`へ進むフェイルオープンを避けるため。
          continue;
        }
        const realTarget = await fs.realpath(target);
        if (realTarget === undefined) {
          // 削除対象が既に存在しない（`kind: 'deleted'`のエントリでは正常系）。
          // 上と同じ理由で`skippedPaths`は使わず、`removeFile`を呼ばずに次のエントリへ進む。
          continue;
        }
        const expectedTarget = path.join(realRoot, path.relative(workspaceRoot, target));
        if (realTarget !== expectedTarget) {
          throw new Error(
            `削除対象が実際には想定した場所以外を指しています（${safeRelPath}）: ${sanitizeForLog(realTarget)}`,
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
        // ここでは**作ったディレクトリを`removeDirRecursive`で撤去しない**
        // （レビュー指摘への裁定。将来のレビューで安易に「揃える」と称して撤去を
        // 追加しないこと）。撤去対象は「`realpath`が境界外に解決されたディレクトリ」
        // であり、その実体はシンボリックリンクの指す先＝既にユーザーのデータが
        // 入っている可能性のある場所。空ディレクトリが1つ残る害と、境界外を
        // 再帰削除する害が釣り合わない。
        // 補足（Issue #505）: 以前は`cloneWorkspace`側は「自分専用の新規ディレクトリ
        // （`<runId>/<taskId>`）だから撤去してよい」という前提で`removeDirRecursive`を
        // 呼んでいたが、その前提自体が誤りだった（祖先ディレクトリが差し替えられていると
        // `target`は既存の実ディレクトリへ解決され、撤去は任意ディレクトリの再帰削除になる）。
        // 現在は`cloneWorkspace`側もこの箇所と同様に撤去しない実装へ揃えたため、
        // 「撤去できる/できない前提が違う」という対比はもう成立しない。両者とも
        // 同じ理由（安全に撤去できるか判別できない）で撤去しない、という点で一致している。
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
          // 一時ファイル+`rename`で塞げるのは、この窓のうち「`target`という名前そのものが
          // シンボリックリンクへ差し替えられる」攻撃だけである。`rename`は対象パスの終端が
          // シンボリックリンクであってもそれを解決せず、ディレクトリエントリそのものを
          // 置き換える（POSIXの`rename(2)`の性質）ため、`target`がその時点でリンクへ
          // 差し替えられていても、置き換え先（リンク先）を書き換えることは原理的にない。
          //
          // **親ディレクトリ`targetDir`側の窓は、この変更の前後で閉じていない**
          // （監査指摘）。`realTargetDir`確認から`fs.copyFile(source, tempTarget)`までの間に
          // `targetDir`自体がシンボリックリンクへ差し替えられると、`tempTarget`は
          // `path.join(targetDir, ...)`という文字列結合で作った名前にすぎず、`copyFile`は
          // その途中のディレクトリ部分のリンクを解決して書き込むため、境界外へ書かれうる。
          // ロールバックの`fs.removeFile(tempTarget)`も同じ差し替え済みパスを辿るため防御に
          // ならない。窓の長さ自体もこの変更で変わっていない。
          //
          // Issue #484: 上記の窓自体は、Nodeの標準API（`fs.promises`）だけでは移植可能な
          // 形で閉じられないと判明した。`openat`/`mkdirat`/`renameat`相当が`FileHandle`に
          // 存在せず、唯一の代替であるLinuxの`/proc/self/fd`経由のマジックリンクは
          // Linux専用でWindowsに相当物が無い。ディレクトリの`realpath`確認直後に
          // セグメントを自前で降りる案も、最終的に`copyFile`へ渡すのが文字列パスである以上
          // 窓が縮まらない。`O_NOFOLLOW`相当も終端コンポーネントにしか効かず親には無力
          // （いずれも実測で確認済み）。
          //
          // そこで、窓の存在は残存リスクとして受け入れたうえで、下の事後確認を
          // 「`realTemp`が境界内か」ではなく「想定していた場所そのものか」へ厳格化する。
          // 境界内チェックだけだと、`targetDir`がワークスペース内の別ディレクトリ
          // （典型的には`.git/hooks`）を指すシンボリックリンクへ差し替えられた場合に
          // 「境界内」として素通りしてしまう。`hasGitSegment`（Issue #406の`.git`無条件
          // 拒否）は`relPath`にしか掛からないため、この経路は迂回できてしまい、実測でも
          // `.git/hooks/pre-commit`が無警告で書き換わることを確認している。
          //
          // **「想定していた場所」は`targetDir`自身の`realpath`（`realTargetDir`）から
          // 組み立ててはいけない（Issue #505、再監査で発覚した循環。当初のこの実装
          // 自体がこの欠陥を持ったままマージされていた）。** `targetDir`自体が差し替え
          // られている攻撃では、`targetDir`の`realpath`も一時ファイルの`realpath`も
          // どちらも差し替え後の実体（`.git/hooks`・`.git/hooks/<一時ファイル名>`）を
          // 指すため必ず一致してしまい、検査が自己無矛盾になって何も検知できない
          // （`cloneWorkspace`の実装コメントで実測済み。同じクラスの欠陥）。
          // 攻撃者が動かせない`realRoot`（`workspaceRoot`自身の`realpath`。関数冒頭で
          // 確定済み）を基準に、`path.relative(workspaceRoot, tempTarget)`という文字列
          // 計算（差し替えの影響を受けない）を再度連結して「想定した場所」を組み立てる
          // ことで、`targetDir`確認からこの一時ファイル書き込みまでの間に差し替えが
          // 起きた場合を検知できる（プラットフォーム差のある`openat`/`O_NOFOLLOW`系の
          // 防御ではなく、純粋なパス文字列比較にしたのは、既存の「一次防御＋二次防御」の
          // 二段構えと一貫させ、かつWindowsでも同じロジックで一様に効かせるため）。
          // ただし`fs.promises`に`openat`相当が無い以上、この窓自体を完全に閉じることは
          // できない。ここで検知できるのは「確認時点の想定と異なる実パスへ書かれたこと」
          // であり、確認そのものより後の差し替え（別のTOCTOU）まで防げるわけではない。
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
            //
            // Issue #505: `expectedTemp`は`realTargetDir`（`targetDir`自身の`realpath`）
            // からではなく、関数冒頭で確定済みの`realRoot`から組み立てる（上の大きな
            // コメント参照。`realTargetDir`起点だと`targetDir`自体が差し替えられた場合に
            // 自己無矛盾になり検知できない）。
            const realTemp = await fs.realpath(tempTarget);
            const expectedTemp = path.join(realRoot, path.relative(workspaceRoot, tempTarget));
            if (realTemp === undefined || realTemp !== expectedTemp) {
              throw new Error(
                `反映先が実際には想定した場所以外へ書き込まれたため、書き込みを取り消しました` +
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
          // 本番はここだけを使う）でのみ効く。ここへ落ちたことは
          // `usedLegacyCopyFallback`で呼び出し側へ伝え、反映1回につき1回だけ警告させる
          // （1件ごとに出すとログが溢れるため）。
          //
          // Issue #484: この経路は一時ファイルを使わないため、書き込み先の名前が
          // `relPath`から予測可能で、境界外の既存ファイルを上書きし、失敗時のロールバック
          // （下の`removeFile(target)`）がその既存ファイルを削除しうる（任意ファイル破壊）。
          // 本番で実際に使われるポート（`nodePseudoWorktreeFileSystem`）は`rename`を持つため
          // この経路には落ちず、上の一時ファイル+`rename`経路のみが通る。
          usedLegacyCopyFallback = true;
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
        usedLegacyCopyFallback,
      };
    }
    appliedPaths.push(relPath);
  }
  return {
    ok: true,
    appliedPaths: appliedPaths.sort((a, b) => a.localeCompare(b)),
    skippedPaths: skippedPaths.sort((a, b) => a.localeCompare(b)),
    usedLegacyCopyFallback,
  };
}
