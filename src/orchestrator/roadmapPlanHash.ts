/**
 * ロードマップ実行（Issue #1465 / #1555）の計画区画の2種類のハッシュ。計画を生成したときの
 * 子Issue側（`sourceHash`）と、生成した計画（`generatedPlanHash`）のハッシュを区画のメタデータに
 * 残し、次に読むときに今の子Issue側・区画と比べて、どちらが変わったかを判定する。
 *
 * - メタデータは区画の中の1行のHTMLコメントに置く（GitHub上では表示されない）。
 *   `<!-- roadmap-kanban:plan-meta planVersion=1 sourceHash=… generatedPlanHash=… children=101:…,102:… -->`
 * - `sourceHash`は子Issueの番号の集合と各子の本文から決まる。子ごとのハッシュ（`children`）も
 *   残し、追加・削除・本文の変わった子を示せるようにする。チェックの有無は入れない（進むたびに
 *   変わるため）。ロードマップ側のチェックに加え、子の本文の中のチェックボックス（受入基準の
 *   `- [x]`など）も未チェックへ均してからハッシュにする
 * - `generatedPlanHash`はメタデータの行を除いた区画の中身を、改行コードと行末の空白、前後の
 *   空行を均してから計算する
 *
 * メタデータはIssueの本文（外部由来）から読むため、形式を厳しく確かめ、合わなければ使わない。
 */
import { createHash } from 'node:crypto';
import { isValidIssueNumber } from './roadmapRunState';

/** 区画の書式の版。書式を変えたら上げる。 */
export const ROADMAP_PLAN_VERSION = 1;

const META_PREFIX = '<!-- roadmap-kanban:plan-meta';
const META_SUFFIX = '-->';
/** `sourceHash`・`generatedPlanHash`の桁数（sha256の16進の先頭）。 */
const HASH_LENGTH = 32;
/** 子ごとのハッシュの桁数。本文が変わった子を見分けるだけなので短くする。 */
const CHILD_HASH_LENGTH = 12;
/** メタデータに載せる子の上限。`MAX_ROADMAP_PLAN_NODES`と揃える（循環importを避けて値で持つ）。 */
const MAX_META_CHILDREN = 200;

export interface RoadmapPlanMeta {
  planVersion: number;
  sourceHash: string;
  generatedPlanHash: string;
  /** 子Issueの番号 → 本文のハッシュ。 */
  children: ReadonlyMap<number, string>;
}

/** 子Issue側の今の姿。 */
export interface RoadmapSourceSnapshot {
  sourceHash: string;
  /** 子Issueの番号 → 本文のハッシュ。 */
  children: ReadonlyMap<number, string>;
}

export interface RoadmapSourceDiff {
  added: number[];
  removed: number[];
  /** 本文が変わった子。 */
  bodyChanged: number[];
}

export type RoadmapPlanChange =
  /** 子Issue側も計画も変わっていない。 */
  | { kind: 'unchanged' }
  /** 計画だけが変わった（人が区画を手で直した）。 */
  | { kind: 'manuallyModified' }
  /** 子Issue側だけが変わった。 */
  | { kind: 'sourceChanged'; source: RoadmapSourceDiff }
  /** 両方が変わった。 */
  | { kind: 'bothChanged'; source: RoadmapSourceDiff };

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 改行コードを揃え、行末の空白と前後の空行を落とす。 */
function normalizeLines(lines: readonly string[]): string {
  const trimmed = lines.map((line) => line.replace(/\s+$/u, ''));
  let start = 0;
  let end = trimmed.length;
  while (start < end && trimmed[start] === '') {
    start += 1;
  }
  while (end > start && trimmed[end - 1] === '') {
    end -= 1;
  }
  return trimmed.slice(start, end).join('\n');
}

/** 行頭のチェックボックス（`- [x]`・`1. [X]`など）。 */
const CHECKED_BOX_PATTERN = /^(\s*(?:[-*+]|\d+[.)])\s+)\[[xX]\]/u;

/** 子Issue1件の本文のハッシュ。チェックボックスは未チェックへ均す（作業が進むたびに変わるため）。 */
export function hashRoadmapChildBody(body: string): string {
  const lines = body.split(/\r?\n/u).map((line) => line.replace(CHECKED_BOX_PATTERN, '$1[ ]'));
  return sha256Hex(normalizeLines(lines)).slice(0, CHILD_HASH_LENGTH);
}

function hashChildren(children: ReadonlyMap<number, string>): string {
  const lines = [...children.entries()]
    .sort(([a], [b]) => a - b)
    .map(([issueNumber, hash]) => `${String(issueNumber)}:${hash}`);
  return sha256Hex(lines.join('\n')).slice(0, HASH_LENGTH);
}

/** 子Issueの本文（番号 → 本文）から子Issue側の姿を作る。並び順には依らない。 */
export function computeRoadmapSourceSnapshot(
  bodies: ReadonlyMap<number, string>,
): RoadmapSourceSnapshot {
  const children = new Map<number, string>();
  for (const [issueNumber, body] of bodies) {
    children.set(issueNumber, hashRoadmapChildBody(body));
  }
  return { sourceHash: hashChildren(children), children };
}

function isMetaLine(line: string): boolean {
  return line.trim().startsWith(META_PREFIX);
}

/** 区画の中身（目印の行を除く）から計画のハッシュを計算する。メタデータの行は除く。 */
export function computeRoadmapPlanHash(content: readonly string[]): string {
  return sha256Hex(normalizeLines(content.filter((line) => !isMetaLine(line)))).slice(
    0,
    HASH_LENGTH,
  );
}

/**
 * 区画の中身をメタデータの行も含めて丸ごとハッシュにする。作り直した計画で区画を置き換える
 * 直前に、人が見て決めたときの区画から変わっていないことを確かめるのに使う。
 */
export function hashRoadmapPlanSectionContent(content: readonly string[]): string {
  return sha256Hex(normalizeLines(content)).slice(0, HASH_LENGTH);
}

export function formatRoadmapPlanMeta(meta: RoadmapPlanMeta): string {
  const children = [...meta.children.entries()]
    .sort(([a], [b]) => a - b)
    .map(([issueNumber, hash]) => `${String(issueNumber)}:${hash}`)
    .join(',');
  return (
    `${META_PREFIX} planVersion=${String(meta.planVersion)} sourceHash=${meta.sourceHash}` +
    ` generatedPlanHash=${meta.generatedPlanHash} children=${children} ${META_SUFFIX}`
  );
}

/** 区画の中身（目印の行を除く）のメタデータの行を`meta`で差し替える。無ければ先頭へ入れる。 */
export function replaceRoadmapPlanMetaLine(
  content: readonly string[],
  meta: RoadmapPlanMeta,
): string[] {
  return [formatRoadmapPlanMeta(meta), ...content.filter((line) => !isMetaLine(line))];
}

const META_BODY_PATTERN =
  /^planVersion=(\d{1,6}) sourceHash=([0-9a-f]{32}) generatedPlanHash=([0-9a-f]{32}) children=((?:\d+:[0-9a-f]{12})(?:,\d+:[0-9a-f]{12})*)?$/u;

export type FoundRoadmapPlanMeta =
  | { kind: 'absent' }
  | { kind: 'present'; meta: RoadmapPlanMeta }
  | { kind: 'malformed'; message: string };

/** 区画の中身からメタデータの行を探して読む。 */
export function findRoadmapPlanMeta(content: readonly string[]): FoundRoadmapPlanMeta {
  const lines = content.filter(isMetaLine).map((line) => line.trim());
  if (lines.length === 0) {
    return { kind: 'absent' };
  }
  const [line] = lines;
  if (lines.length > 1 || line === undefined) {
    return { kind: 'malformed', message: '計画区画のメタデータの行が2行以上あります' };
  }
  if (!line.endsWith(META_SUFFIX)) {
    return { kind: 'malformed', message: '計画区画のメタデータの行を読めません' };
  }
  const inner = line.slice(META_PREFIX.length, -META_SUFFIX.length).trim();
  const match = META_BODY_PATTERN.exec(inner);
  if (match === null) {
    return { kind: 'malformed', message: '計画区画のメタデータの行を読めません' };
  }
  const planVersion = Number(match[1]);
  if (planVersion !== ROADMAP_PLAN_VERSION) {
    return {
      kind: 'malformed',
      message: `計画区画の版(${String(planVersion)})に対応していません`,
    };
  }
  const children = new Map<number, string>();
  const entries = match[4] === undefined ? [] : match[4].split(',');
  if (entries.length > MAX_META_CHILDREN) {
    return { kind: 'malformed', message: '計画区画のメタデータの子Issueが多すぎます' };
  }
  for (const entry of entries) {
    const [numberText = '', hash = ''] = entry.split(':');
    const issueNumber = Number(numberText);
    if (!isValidIssueNumber(issueNumber) || children.has(issueNumber)) {
      return { kind: 'malformed', message: '計画区画のメタデータの子Issueの番号が不正です' };
    }
    children.set(issueNumber, hash);
  }
  const sourceHash = match[2] ?? '';
  if (hashChildren(children) !== sourceHash) {
    return {
      kind: 'malformed',
      message: '計画区画のメタデータのsourceHashが子Issueごとのハッシュと合いません',
    };
  }
  return {
    kind: 'present',
    meta: { planVersion, sourceHash, generatedPlanHash: match[3] ?? '', children },
  };
}

/** 生成時の子Issue側と今の子Issue側の違い。 */
export function diffRoadmapSource(
  before: ReadonlyMap<number, string>,
  after: ReadonlyMap<number, string>,
): RoadmapSourceDiff {
  const added: number[] = [];
  const removed: number[] = [];
  const bodyChanged: number[] = [];
  for (const [issueNumber, hash] of after) {
    const previous = before.get(issueNumber);
    if (previous === undefined) {
      added.push(issueNumber);
    } else if (previous !== hash) {
      bodyChanged.push(issueNumber);
    }
  }
  for (const issueNumber of before.keys()) {
    if (!after.has(issueNumber)) {
      removed.push(issueNumber);
    }
  }
  const ascending = (a: number, b: number): number => a - b;
  return {
    added: added.sort(ascending),
    removed: removed.sort(ascending),
    bodyChanged: bodyChanged.sort(ascending),
  };
}

/**
 * メタデータ（生成時）と今の子Issue側・区画のハッシュを比べ、4つのどれに当たるかを返す。
 * どの場合も区画を書き換えない。書き換えるかどうかは呼び出し側が人に決めてもらう。
 */
export function classifyRoadmapPlanChange(
  meta: RoadmapPlanMeta,
  source: RoadmapSourceSnapshot,
  planHash: string,
): RoadmapPlanChange {
  const sourceChanged = meta.sourceHash !== source.sourceHash;
  const planChanged = meta.generatedPlanHash !== planHash;
  if (!sourceChanged) {
    return planChanged ? { kind: 'manuallyModified' } : { kind: 'unchanged' };
  }
  const diff = diffRoadmapSource(meta.children, source.children);
  return planChanged
    ? { kind: 'bothChanged', source: diff }
    : { kind: 'sourceChanged', source: diff };
}

/**
 * 子Issue側の違いを1行で表す（番号だけ。本文は出さない）。
 *
 * `titles`を渡すと、追加・本文の変更の番号に今のタイトルを添える（削除された番号は
 * 今の子Issue一覧に無いためタイトルを持たず、番号だけになる）。何が変わったかを番号だけで
 * 見せると、確認する人が対象を確かめるために毎回子Issueを開き直す必要があった（#1581）。
 */
export function describeRoadmapSourceDiff(
  diff: RoadmapSourceDiff,
  titles?: ReadonlyMap<number, string>,
): string {
  const label = (n: number): string => {
    const title = titles?.get(n);
    return title === undefined ? `#${String(n)}` : `#${String(n)}（${title}）`;
  };
  const list = (numbers: readonly number[]): string => numbers.map(label).join(', ');
  const parts: string[] = [];
  if (diff.added.length > 0) {
    parts.push(`追加: ${list(diff.added)}`);
  }
  if (diff.removed.length > 0) {
    parts.push(`削除: ${list(diff.removed)}`);
  }
  if (diff.bodyChanged.length > 0) {
    parts.push(`本文の変更: ${list(diff.bodyChanged)}`);
  }
  return parts.length === 0 ? '子Issueの変更' : parts.join(' / ');
}
