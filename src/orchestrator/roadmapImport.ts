/**
 * ロードマップ実行（Issue #1465）の取り込み: ロードマップIssueの本文から子Issueを取り出し、
 * 着手順（計画）の区画を読み書きする。
 *
 * - 子Issueは行頭が`- [ ] #<番号>`/`- [x] #<番号>`のチェックリスト行だけとする
 *   （`checkIssueChecklistItems`と同じ`ISSUE_CHECKLIST_LINE_PATTERN`で読む）。
 *   `[x]`も子として返し、runの側で「終了」として置く
 * - 計画は本文の`<!-- roadmap-kanban:plan -->`〜`<!-- /roadmap-kanban:plan -->`の区画に置く。
 *   書き戻すのは区画だけで、区画以外の本文は1文字も変えない
 * - MVPでは区画があれば生成せずにそのまま使い、区画を自動で上書きしない。子Issue側と計画の
 *   ハッシュによる変更の検出は後続（Issue #1465 決定事項）
 *
 * Issueのタイトルは外部由来のテキストのため、1行へ均して長さを切るだけにし、表示や
 * プロンプトへ入れる側で`formatUntrusted`等を通す。
 */
import {
  fetchIssueBody,
  updateIssue,
  type CliCommandRunner,
  type ForgeFileSystemPort,
  type ForgeHost,
} from './forge';
import { ISSUE_CHECKLIST_LINE_PATTERN } from './roadmap';
import { runExclusiveOnRoadmapIssue } from './roadmapIssueSync';
import { isValidIssueNumber, type RoadmapPlanNode } from './roadmapRunState';
import { sanitizeInlineText } from './untrustedText';
import { findCycleGroups } from './workflow';

export const ROADMAP_PLAN_START_MARKER = '<!-- roadmap-kanban:plan -->';
export const ROADMAP_PLAN_END_MARKER = '<!-- /roadmap-kanban:plan -->';

/** 子Issueのタイトルとして持つ最大文字数。 */
const CHILD_TITLE_MAX_LENGTH = 200;

/** 計画に載せられるノードの最大数。 */
export const MAX_ROADMAP_PLAN_NODES = 200;

export interface RoadmapChild {
  issueNumber: number;
  /** 外部由来のテキスト（1行へ均し、長さを切ってある）。 */
  title: string;
  checked: boolean;
}

export interface ExtractedRoadmapChildren {
  /** 本文での出現順。同じ番号は最初の行だけを採る。 */
  children: RoadmapChild[];
  /** 2回目以降に出てきた番号（採らなかった行）。 */
  duplicates: number[];
}

/**
 * 本文から子Issueを取り出す。行の途中に番号がある行（`- [ ] 評価基盤 (#19)`）や
 * 番号の無い項目は子にしない。
 */
export function extractRoadmapChildren(body: string): ExtractedRoadmapChildren {
  const children: RoadmapChild[] = [];
  const seen = new Set<number>();
  const duplicates: number[] = [];
  for (const line of splitLines(body)) {
    const match = ISSUE_CHECKLIST_LINE_PATTERN.exec(line);
    if (match === null) {
      continue;
    }
    const issueNumber = Number(match[4]);
    if (!isValidIssueNumber(issueNumber)) {
      continue;
    }
    if (seen.has(issueNumber)) {
      duplicates.push(issueNumber);
      continue;
    }
    seen.add(issueNumber);
    const rest = (match[3] ?? '').replace(/^\]\s+#\d+/u, '').replace(/^\s*[:：]?\s*/u, '');
    children.push({
      issueNumber,
      title: sanitizeInlineText(rest, CHILD_TITLE_MAX_LENGTH),
      checked: match[2] !== ' ',
    });
  }
  return { children, duplicates };
}

/* -------------------------------------------------------------------------------------------- */
/* 計画区画                                                                                       */
/* -------------------------------------------------------------------------------------------- */

export type RoadmapPlanSection =
  | { kind: 'absent' }
  /** `startLine`/`endLine`は開始・終了の目印の行（0始まり、両端を含む）。 */
  | { kind: 'present'; startLine: number; endLine: number; content: string[] }
  | { kind: 'malformed'; message: string };

/** 本文から計画区画を探す。目印は行全体（前後の空白は除く）が一致するものだけを数える。 */
export function findRoadmapPlanSection(body: string): RoadmapPlanSection {
  const lines = splitLines(body);
  const starts: number[] = [];
  const ends: number[] = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === ROADMAP_PLAN_START_MARKER) {
      starts.push(index);
    } else if (trimmed === ROADMAP_PLAN_END_MARKER) {
      ends.push(index);
    }
  });
  if (starts.length === 0 && ends.length === 0) {
    return { kind: 'absent' };
  }
  const [start] = starts;
  const [end] = ends;
  if (starts.length !== 1 || ends.length !== 1 || start === undefined || end === undefined) {
    return {
      kind: 'malformed',
      message: `計画区画の目印の数が不正です（開始${String(starts.length)}件、終了${String(ends.length)}件）`,
    };
  }
  if (end < start) {
    return { kind: 'malformed', message: '計画区画の終了の目印が開始より前にあります' };
  }
  return { kind: 'present', startLine: start, endLine: end, content: lines.slice(start + 1, end) };
}

/**
 * 計画の1行: `- #102 段2 依存: #101, #100`。段は省いてよい。依存が無ければ`依存: なし`。
 * チェックボックスを付けない（gantや`extractRoadmapChildren`が子Issueとして読まないように）。
 */
const PLAN_NODE_LINE_PATTERN =
  /^\s*[-*+]\s+#(\d+)(?:\s+段(\d+))?\s+依存[:：]\s*(なし|#\d+(?:\s*[,、]\s*#\d+)*)\s*$/u;
const LIST_ITEM_PATTERN = /^\s*[-*+]\s/u;

export interface ParsedRoadmapPlan {
  /** 区画に書かれた順。 */
  nodes: RoadmapPlanNode[];
  errors: string[];
}

/**
 * 区画の中身を読む。箇条書きの行はすべて計画の行として読み、書式に合わない行はエラーにする
 * （人が手で直した区画の書き損じを黙って捨てない）。見出しや説明の段落は読み飛ばす。
 */
export function parseRoadmapPlanSection(content: readonly string[]): ParsedRoadmapPlan {
  const nodes: RoadmapPlanNode[] = [];
  const errors: string[] = [];
  content.forEach((line, index) => {
    if (!LIST_ITEM_PATTERN.test(line)) {
      return;
    }
    const match = PLAN_NODE_LINE_PATTERN.exec(line);
    if (match === null) {
      errors.push(
        `計画区画の${String(index + 1)}行目を読めません: ${sanitizeInlineText(line, 120)}`,
      );
      return;
    }
    const wave = match[2] === undefined ? undefined : Number(match[2]);
    const depsText = match[3] ?? 'なし';
    nodes.push({
      issueNumber: Number(match[1]),
      wave,
      dependsOn:
        depsText === 'なし' ? [] : [...depsText.matchAll(/#(\d+)/gu)].map((m) => Number(m[1])),
    });
  });
  return { nodes, errors };
}

/**
 * 計画をControllerとして検証する。ノードの存在（子Issueと1対1）、番号・段の形式、依存先の
 * 存在、重複、循環を確かめる。エラーが1件でもあれば実行に使わない。
 */
export function validateRoadmapPlan(
  nodes: readonly RoadmapPlanNode[],
  children: readonly RoadmapChild[],
): string[] {
  const errors: string[] = [];
  if (nodes.length > MAX_ROADMAP_PLAN_NODES) {
    errors.push(
      `計画のノード数が上限(${String(MAX_ROADMAP_PLAN_NODES)})を超えています: ${String(nodes.length)}`,
    );
    return errors;
  }
  const childNumbers = new Set(children.map((child) => child.issueNumber));
  const planned = new Set<number>();
  for (const node of nodes) {
    const label = `#${String(node.issueNumber)}`;
    if (!isValidIssueNumber(node.issueNumber)) {
      errors.push(`計画のIssue番号が不正です: ${String(node.issueNumber)}`);
      continue;
    }
    if (planned.has(node.issueNumber)) {
      errors.push(`計画に同じIssueが2回あります: ${label}`);
      continue;
    }
    planned.add(node.issueNumber);
    if (!childNumbers.has(node.issueNumber)) {
      errors.push(`計画の${label}はロードマップの子Issueにありません`);
    }
    if (node.wave !== undefined && (!Number.isSafeInteger(node.wave) || node.wave < 1)) {
      errors.push(`${label}の段が不正です: ${String(node.wave)}`);
    }
    const deps = new Set<number>();
    for (const dep of node.dependsOn) {
      if (deps.has(dep)) {
        errors.push(`${label}の依存に同じIssueが2回あります: #${String(dep)}`);
      }
      deps.add(dep);
    }
  }
  for (const node of nodes) {
    for (const dep of new Set(node.dependsOn)) {
      if (!planned.has(dep)) {
        errors.push(`#${String(node.issueNumber)}の依存先#${String(dep)}が計画にありません`);
      }
    }
  }
  for (const child of children) {
    if (!planned.has(child.issueNumber)) {
      errors.push(`子Issue#${String(child.issueNumber)}が計画にありません`);
    }
  }
  const cycles = findCycleGroups(
    nodes.map((node) => ({ id: String(node.issueNumber), dependsOn: node.dependsOn.map(String) })),
  );
  for (const group of cycles) {
    errors.push(`計画の依存が循環しています: ${group.map((id) => `#${id}`).join(' → ')}`);
  }
  return errors;
}

/**
 * 計画区画の本文（目印の行を含む）を作る。段が無いノードは、依存を辿った深さ
 * （依存の無いノードを1段目）で埋める。検証済み（循環なし）の計画を渡す前提。
 */
export function formatRoadmapPlanSection(nodes: readonly RoadmapPlanNode[]): string[] {
  const waves = computeWaves(nodes);
  return [
    ROADMAP_PLAN_START_MARKER,
    '## 着手順',
    '',
    'Kanban実行用の着手順。依存に並べたIssueがすべて終わってから着手する。段は表示のためだけに使う。',
    '',
    ...nodes.map((node) => {
      const wave = node.wave ?? waves.get(node.issueNumber) ?? 1;
      const deps =
        node.dependsOn.length === 0
          ? 'なし'
          : node.dependsOn.map((dep) => `#${String(dep)}`).join(', ');
      return `- #${String(node.issueNumber)} 段${String(wave)} 依存: ${deps}`;
    }),
    ROADMAP_PLAN_END_MARKER,
  ];
}

function computeWaves(nodes: readonly RoadmapPlanNode[]): Map<number, number> {
  const byNumber = new Map(nodes.map((node) => [node.issueNumber, node] as const));
  const waves = new Map<number, number>();
  const visiting = new Set<number>();
  const waveOf = (issueNumber: number): number => {
    const known = waves.get(issueNumber);
    if (known !== undefined) {
      return known;
    }
    const node = byNumber.get(issueNumber);
    if (node === undefined || visiting.has(issueNumber)) {
      return 0; // 計画外の依存先・循環は検証で弾く。ここでは無限再帰だけを防ぐ
    }
    visiting.add(issueNumber);
    const wave = 1 + Math.max(0, ...node.dependsOn.map(waveOf));
    visiting.delete(issueNumber);
    waves.set(issueNumber, wave);
    return wave;
  };
  for (const node of nodes) {
    waveOf(node.issueNumber);
  }
  return waves;
}

/**
 * 本文へ計画区画を入れる。区画が無ければ末尾へ足し、あれば区画だけを置き換える。
 * 区画以外の行と改行コード（CRLF/LF）はそのまま保つ。目印が壊れていれば`undefined`。
 */
export function replaceRoadmapPlanSection(
  body: string,
  sectionLines: readonly string[],
): string | undefined {
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const section = findRoadmapPlanSection(body);
  if (section.kind === 'malformed') {
    return undefined;
  }
  if (section.kind === 'absent') {
    const separator = body === '' ? '' : body.endsWith(eol) ? eol : eol + eol;
    return `${body}${separator}${sectionLines.join(eol)}${eol}`;
  }
  // 改行コードが混ざった本文でも`findRoadmapPlanSection`と行番号が揃うよう、区切りを残して割る
  // （偶数番目が行、奇数番目がその行の後ろの改行）
  const parts = body.split(/(\r?\n)/u);
  return (
    parts.slice(0, section.startLine * 2).join('') +
    sectionLines.join(eol) +
    parts.slice(section.endLine * 2 + 1).join('')
  );
}

function splitLines(body: string): string[] {
  return body.split(/\r?\n/u);
}

/* -------------------------------------------------------------------------------------------- */
/* ロードマップIssueの読み込みと計画の書き戻し                                                     */
/* -------------------------------------------------------------------------------------------- */

export interface RoadmapImportDeps {
  cli: CliCommandRunner;
  fs: ForgeFileSystemPort;
}

export interface RoadmapImportTarget {
  host: ForgeHost;
  cwd: string;
  roadmapIssueNumber: number;
}

export type RoadmapImportOutcome =
  | { kind: 'failed'; message: string }
  | {
      kind: 'imported';
      children: RoadmapChild[];
      duplicates: number[];
      plan:
        | { kind: 'absent' }
        /** 区画があり、検証を通った。MVPではそのまま使う。 */
        | { kind: 'valid'; nodes: RoadmapPlanNode[] }
        /** 区画はあるが読めない・検証に通らない。実行前に拒否する。 */
        | { kind: 'invalid'; errors: string[] };
    };

/** ロードマップIssueの本文を取り、子Issueと計画区画を読む。 */
export async function importRoadmap(
  deps: RoadmapImportDeps,
  target: RoadmapImportTarget,
): Promise<RoadmapImportOutcome> {
  const body = await fetchIssueBody(deps.cli, target.host, target.cwd, target.roadmapIssueNumber);
  if (body === undefined) {
    return {
      kind: 'failed',
      message: `ロードマップIssue #${String(target.roadmapIssueNumber)} の本文を取得できませんでした`,
    };
  }
  const { children, duplicates } = extractRoadmapChildren(body);
  if (children.length === 0) {
    return {
      kind: 'failed',
      message: `ロードマップIssue #${String(target.roadmapIssueNumber)} に行頭が「- [ ] #番号」の子Issueがありません`,
    };
  }
  return { kind: 'imported', children, duplicates, plan: readPlan(body, children) };
}

function readPlan(
  body: string,
  children: readonly RoadmapChild[],
): Extract<RoadmapImportOutcome, { kind: 'imported' }>['plan'] {
  const section = findRoadmapPlanSection(body);
  if (section.kind === 'absent') {
    return { kind: 'absent' };
  }
  if (section.kind === 'malformed') {
    return { kind: 'invalid', errors: [section.message] };
  }
  const parsed = parseRoadmapPlanSection(section.content);
  const errors = [...parsed.errors, ...validateRoadmapPlan(parsed.nodes, children)];
  return errors.length > 0 ? { kind: 'invalid', errors } : { kind: 'valid', nodes: parsed.nodes };
}

export type WriteRoadmapPlanOutcome =
  | { kind: 'written'; body: string }
  /** 読み直した本文に区画が既にあった。MVPでは上書きしない。 */
  | { kind: 'sectionExists' }
  | { kind: 'invalid'; errors: string[] }
  | { kind: 'failed'; message: string };

/**
 * 検証済みの計画を、区画が無いロードマップIssueへ書き戻す。書く直前に本文を読み直して
 * 子Issueで検証し直し、区画以外の本文が変わらないことを確かめてから送る。
 * 子Issueのチェック（`syncRoadmapCompletionToIssue`）と同じ列で直列化する。
 */
export async function writeRoadmapPlan(
  deps: RoadmapImportDeps,
  target: RoadmapImportTarget,
  nodes: readonly RoadmapPlanNode[],
): Promise<WriteRoadmapPlanOutcome> {
  return runExclusiveOnRoadmapIssue(
    target.host,
    target.cwd,
    target.roadmapIssueNumber,
    async () => {
      const body = await fetchIssueBody(
        deps.cli,
        target.host,
        target.cwd,
        target.roadmapIssueNumber,
      );
      if (body === undefined || body.trim() === '') {
        return {
          kind: 'failed',
          message: `ロードマップIssue #${String(target.roadmapIssueNumber)} の本文を取得できませんでした`,
        };
      }
      const section = findRoadmapPlanSection(body);
      if (section.kind === 'present') {
        return { kind: 'sectionExists' };
      }
      if (section.kind === 'malformed') {
        return { kind: 'invalid', errors: [section.message] };
      }
      const errors = validateRoadmapPlan(nodes, extractRoadmapChildren(body).children);
      if (errors.length > 0) {
        return { kind: 'invalid', errors };
      }
      const next = replaceRoadmapPlanSection(body, formatRoadmapPlanSection(nodes));
      if (next === undefined || !next.startsWith(body.replace(/(\r?\n)*$/u, ''))) {
        return { kind: 'failed', message: '計画区画以外の本文が変わるため書き戻しを中止しました' };
      }
      const outcome = await updateIssue(deps, {
        host: target.host,
        cwd: target.cwd,
        number: target.roadmapIssueNumber,
        body: next,
      });
      return outcome.ok
        ? { kind: 'written', body: next }
        : { kind: 'failed', message: outcome.message };
    },
  );
}
