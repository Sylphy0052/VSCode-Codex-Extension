/**
 * runの振り返りから自己改善を起票・評価し、悪化した改善はrevertのIssueを起票する（Issue #2086）。
 *
 * - runの終了時に、指標（#2081）・教訓・残件から改善案を1件まで作る。教訓の昇格と起票本文は
 *   `lessonPromotion.ts`（#2085）の信頼境界を通し、予算は`selfImproveBudget.ts`（#2084）で判断する
 * - 改善案は`self-improve`ラベルのIssueにし、ロードマップには載せない。保護パス（#2082）に触れる案は
 *   `research`ラベルの調査Issueへ提案として回す
 * - 各改善の狙う指標・閾値・最小run数は起票時に事前登録し、手元の状態ファイルを正にする（後から変えない）
 * - 評価は改善を含む版で、工程プロンプトと上限値のハッシュが揃ったrunだけで行う。最小run数に満たない
 *   うちは保留。悪化ならrevertのIssueを冪等キーで1件だけ起票し、墓標を残す。revert自体は評価しない
 *
 * 判断は純関数、入出力（GitHub・ファイル）は{@link RetrospectiveForge}と状態ファイルに分ける。
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  buildLessonIssueBody,
  decideIssueFiling,
  isPromotable,
  renderPromotedLesson,
  type RepoVisibility,
} from './lessonPromotion';
import type { RunMetrics } from './runMetrics';
import type { LessonRecord, RunNotesStore } from './runNotes';
import {
  decideFile,
  decideRetrospective,
  decideStart,
  decideUsage,
  SelfImproveBudgetStore,
  withFileLock,
  type SelfImproveBudgetConfig,
} from './selfImproveBudget';
import { findProtectedTouches, SELF_IMPROVE_LABEL } from './selfImproveGuard';
import { listTasks, type TaskRun, type TaskRunEngine } from './taskRunState';

/** 評価に使う指標。どれも小さいほど良い。 */
export const RETROSPECTIVE_METRICS = [
  'sendBacks',
  'autoRetries',
  'maxReached',
  'questions',
  'msPerChildIssue',
] as const;
export type RetrospectiveMetric = (typeof RETROSPECTIVE_METRICS)[number];

/** 最小run数の既定値。これに満たないうちは判定を保留する。 */
export const DEFAULT_MIN_RUNS = 5;
/** 悪化とみなす増え方の既定値（改善前の平均に対する%）。 */
export const DEFAULT_THRESHOLD_PCT = 20;
/** 悪化とみなす増え方の絶対値の下限。改善前がほぼ0のときに1回の揺れで戻さないため。 */
const MIN_ABS_DELTA: Record<RetrospectiveMetric, number> = {
  sendBacks: 0.2,
  autoRetries: 0.2,
  maxReached: 0.2,
  questions: 0.2,
  msPerChildIssue: 10 * 60_000,
};

/** 昇格した教訓の定型文を入れる先（`taskStagePrompts.ts`のコメントが入れてよい文を定めている）。 */
export const PROMOTION_TARGET_FILE = 'src/orchestrator/taskStagePrompts.ts';
/** 自己改善のrunの名前の頭。直列の判定と、振り返りで改善案を出さない判定に使う。 */
export const SELF_IMPROVE_RUN_TITLE_PREFIX = '自己改善 #';
/** 調査Issueのラベル。保護パスに触れる案を提案として回す先。 */
export const RESEARCH_LABEL = 'research';

const STATE_FILE_NAME = 'retrospective.json';
const BUDGET_FILE_NAME = 'budget.json';
const LOG_FILE_NAME = 'retrospective-log.jsonl';
const LOCK_FILE_NAME = 'retrospective.lock';
/** 振り返りはGitHubへの問い合わせを何度か挟むので、ロックの古さの判定を長く取る。 */
const LOCK_STALE_MS = 10 * 60_000;

/** 起票時に事前登録する、機械可読の判定条件。 */
export interface ImprovementSpec {
  v: 1;
  /** 冪等キー。同じ対象・指標・根拠の改善を二重に起票しないために本文へ載せる。 */
  key: string;
  /** 何を変えるか（墓標の照合に使う）。 */
  target: string;
  /** 変えてよいファイル。保護パスの判定に使う。 */
  files: string[];
  metric: RetrospectiveMetric;
  expected: 'decrease';
  thresholdPct: number;
  minAbsDelta: number;
  minRuns: number;
  /** 根拠にした教訓のid。 */
  evidence: string[];
}

export type ImprovementVerdict = 'kept' | 'reverted' | 'abandoned' | 'noBaseline';

export interface ImprovementRecord {
  issueNumber: number;
  kind: 'improvement' | 'research';
  spec: ImprovementSpec;
  filedAt: number;
  mergedAt?: number;
  /** 改善を含む最初の版（merge commitの`package.json`の版）。 */
  version?: string;
  pullRequestNumber?: number;
  mergeCommit?: string;
  verdict?: ImprovementVerdict;
  revertIssueNumber?: number;
  evaluatedAt?: number;
}

/** revertした改善の対象と指標。新しい根拠の無い再提案を拒否するのに使う。 */
export interface Tombstone {
  target: string;
  metric: RetrospectiveMetric;
  evidence: string[];
  improvementIssue: number;
  revertIssue: number;
  at: number;
}

export interface RetrospectiveState {
  v: 1;
  improvements: ImprovementRecord[];
  tombstones: Tombstone[];
}

// ---------------------------------------------------------------- 純関数

/** 版（`2026.1115.22`の形）を比べる。数字以外を含めば`undefined`（比べられない）。 */
export function compareVersions(a: string, b: string): number | undefined {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  if ([...pa, ...pb].some((n) => !Number.isInteger(n) || n < 0)) {
    return undefined;
  }
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) {
      return d;
    }
  }
  return 0;
}

/** 指標の値。件数は子Issueあたりに均す（runの大きさで比べないため）。 */
export function metricValue(m: RunMetrics, metric: RetrospectiveMetric): number | undefined {
  if (metric === 'msPerChildIssue') {
    return m.msPerChildIssue;
  }
  return m.childIssues > 0 ? m[metric] / m.childIssues : undefined;
}

function mean(values: readonly number[]): number | undefined {
  return values.length === 0 ? undefined : values.reduce((a, b) => a + b, 0) / values.length;
}

/** 今回のrunが過去の平均から最も悪くなった指標。悪くなったものが無ければ差し戻し。 */
export function selectTargetMetric(
  current: RunMetrics,
  history: readonly RunMetrics[],
): RetrospectiveMetric {
  let best: { metric: RetrospectiveMetric; excess: number } | undefined;
  for (const metric of RETROSPECTIVE_METRICS) {
    const value = metricValue(current, metric);
    const base = mean(
      history.flatMap((m) => {
        const v = metricValue(m, metric);
        return v === undefined ? [] : [v];
      }),
    );
    if (value === undefined || base === undefined) {
      continue;
    }
    const excess = (value - base) / Math.max(base, MIN_ABS_DELTA[metric]);
    if (excess > 0 && (best === undefined || excess > best.excess)) {
      best = { metric, excess };
    }
  }
  return best?.metric ?? 'sendBacks';
}

export function improvementKey(
  target: string,
  metric: RetrospectiveMetric,
  evidence: readonly string[],
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([target, metric, [...evidence].sort()]))
    .digest('hex');
  return `si-${digest.slice(0, 16)}`;
}

/** `package.json`の`repository.url`から`owner/name`を取る。GitHubでなければ`undefined`。 */
export function parseGithubRepo(url: string | undefined): string | undefined {
  const m =
    url === undefined ? null : /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url);
  return m === null ? undefined : `${m[1]}/${m[2]}`;
}

export function revertKey(improvementIssue: number): string {
  return `si-revert-${String(improvementIssue)}`;
}

export interface Proposal {
  lesson: LessonRecord;
  promoted: string;
  spec: ImprovementSpec;
}

/**
 * 改善案を作る。今回のrunが記録した教訓のうち、昇格できる（出典がこのrepoの成果物の）最新の1件を
 * 工程プロンプトの定型文へ昇格する案にする。無ければ`undefined`。
 */
export function buildProposal(input: {
  runId: string;
  lessons: readonly LessonRecord[];
  current: RunMetrics;
  history: readonly RunMetrics[];
}): Proposal | undefined {
  for (const lesson of input.lessons) {
    if (lesson.runId !== input.runId || !isPromotable(lesson)) {
      continue;
    }
    const promoted = renderPromotedLesson(lesson);
    if (promoted === undefined) {
      continue;
    }
    const metric = selectTargetMetric(input.current, input.history);
    const target = `promoteLesson:${PROMOTION_TARGET_FILE}`;
    const evidence = [lesson.id];
    return {
      lesson,
      promoted,
      spec: {
        v: 1,
        key: improvementKey(target, metric, evidence),
        target,
        files: [PROMOTION_TARGET_FILE],
        metric,
        expected: 'decrease',
        thresholdPct: DEFAULT_THRESHOLD_PCT,
        minAbsDelta: MIN_ABS_DELTA[metric],
        minRuns: DEFAULT_MIN_RUNS,
        evidence,
      },
    };
  }
  return undefined;
}

/** 墓標と同じ対象・指標で、墓標に無い根拠を1つも持たない案なら、その墓標を返す（拒否する）。 */
export function findBlockingTombstone(
  tombstones: readonly Tombstone[],
  spec: Pick<ImprovementSpec, 'target' | 'metric' | 'evidence'>,
): Tombstone | undefined {
  return tombstones.find(
    (t) =>
      t.target === spec.target &&
      t.metric === spec.metric &&
      spec.evidence.every((id) => t.evidence.includes(id)),
  );
}

export type Evaluation =
  | { kind: 'hold'; have: number; need: number }
  | { kind: 'noBaseline' }
  | { kind: 'kept'; before: number; after: number }
  | { kind: 'worsened'; before: number; after: number };

/**
 * 改善を評価する。改善後のrunは「改善を含む版で、merge後に始まり、最初の1本とプロンプト・上限値の
 * ハッシュが一致する」ものの先頭から最小run数だけ使う（後から足されるrunで判定を揺らさない）。
 * 改善前はmerge前に終わった、改善を含まない版のrunの直近の最小run数。
 */
export function evaluateImprovement(
  record: Pick<ImprovementRecord, 'spec' | 'mergedAt' | 'version'>,
  runs: readonly RunMetrics[],
): Evaluation {
  const { spec, mergedAt, version } = record;
  const need = spec.minRuns;
  if (mergedAt === undefined || version === undefined) {
    return { kind: 'hold', have: 0, need };
  }
  const valued = runs
    .map((m) => ({ m, v: metricValue(m, spec.metric) }))
    .filter((x): x is { m: RunMetrics; v: number } => x.v !== undefined)
    .sort((a, b) => Date.parse(a.m.finishedAt) - Date.parse(b.m.finishedAt));
  const candidates = valued.filter(
    ({ m }) =>
      (compareVersions(m.keys.extensionVersion, version) ?? -1) >= 0 &&
      Date.parse(m.startedAt) >= mergedAt,
  );
  const anchor = candidates[0]?.m.keys;
  const after = candidates
    .filter(
      ({ m }) =>
        anchor !== undefined &&
        m.keys.promptHash === anchor.promptHash &&
        m.keys.limitsHash === anchor.limitsHash,
    )
    .slice(0, need);
  if (after.length < need) {
    return { kind: 'hold', have: after.length, need };
  }
  const before = valued
    .filter(
      ({ m }) =>
        (compareVersions(m.keys.extensionVersion, version) ?? 0) < 0 &&
        Date.parse(m.finishedAt) < mergedAt,
    )
    .slice(-need);
  const b = mean(before.map((x) => x.v));
  const a = mean(after.map((x) => x.v)) as number;
  if (b === undefined) {
    return { kind: 'noBaseline' };
  }
  const worsened = a > b * (1 + spec.thresholdPct / 100) && a - b >= spec.minAbsDelta;
  return { kind: worsened ? 'worsened' : 'kept', before: b, after: a };
}

const METRIC_LABELS: Record<RetrospectiveMetric, string> = {
  sendBacks: '差し戻し（子Issueあたり）',
  autoRetries: '工程の自動やり直し（子Issueあたり）',
  maxReached: '送信回数の使い切り（子Issueあたり）',
  questions: '質問（子Issueあたり）',
  msPerChildIssue: '子Issueあたりの所要時間（ミリ秒）',
};

function specSection(spec: ImprovementSpec): string[] {
  return [
    '## 事前登録（後から変えない）',
    `冪等キー: \`${spec.key}\``,
    '',
    `- 狙う指標: ${METRIC_LABELS[spec.metric]}。期待する変化: 減る`,
    `- 判定の閾値: 改善後の平均が改善前の平均より${String(spec.thresholdPct)}%以上、かつ${String(spec.minAbsDelta)}以上増えたら悪化としてrevertする`,
    `- 最小run数: ${String(spec.minRuns)}（改善を含む版で、工程プロンプトと上限値のハッシュが揃ったrunがこの数に満たないうちは判定を保留する）`,
    '',
    '```json',
    JSON.stringify(spec),
    '```',
    '',
    '判定は拡張が手元に保存した登録内容で行う。この本文を書き換えても判定は変わらない。',
  ];
}

/** 改善Issue・調査Issueの本文。起票してはいけないときは`undefined`。 */
export function renderProposalBody(input: {
  proposal: Proposal;
  kind: 'improvement' | 'research';
  protectedTouches: readonly string[];
  runId: string;
  openRemaining: number;
  visibility: RepoVisibility;
  ownRepo: string;
}): string | undefined {
  const { proposal, kind } = input;
  const lessonPart = buildLessonIssueBody(proposal.lesson, input.visibility, {
    ownRepo: input.ownRepo,
  });
  if (lessonPart === undefined) {
    return undefined;
  }
  const change = [
    '## 改善の内容',
    `\`${PROMOTION_TARGET_FILE}\`の工程プロンプトへ次の定型文を加える。文は言い換えず、このまま入れる。`,
    '',
    `> ${proposal.promoted}`,
  ];
  const header =
    kind === 'improvement'
      ? [
          `run \`${input.runId}\`の振り返りが自動で起票した自己改善。ロードマップには載せず、`,
          '`start_self_improve_run`で通常のrunとは別のrunとして直列に回す。',
        ]
      : [
          `run \`${input.runId}\`の振り返りで出た改善案のうち、保護パスに触れるため自己改善としては`,
          '実装しない提案。人が判断する。',
          '',
          `触れる保護パス: ${input.protectedTouches.map((p) => `\`${p}\``).join('、')}`,
        ];
  return [
    ...header,
    '',
    lessonPart,
    '',
    ...change,
    '',
    `このrunの未完了の残件: ${String(input.openRemaining)}件`,
    '',
    ...specSection(proposal.spec),
  ].join('\n');
}

export function renderRevertBody(input: {
  record: ImprovementRecord;
  evaluation: Extract<Evaluation, { kind: 'worsened' }>;
  key: string;
}): string {
  const { record, evaluation } = input;
  const pr =
    record.pullRequestNumber === undefined ? '' : `（PR #${String(record.pullRequestNumber)}）`;
  const commit = record.mergeCommit === undefined ? '' : `merge commit \`${record.mergeCommit}\`を`;
  return [
    `自己改善 #${String(record.issueNumber)}${pr}が事前登録した指標で悪化と判定されたため戻す。`,
    `${commit}\`git revert\`で戻すPRを作る。ほかの変更は入れない。`,
    '',
    `- 指標: ${METRIC_LABELS[record.spec.metric]}`,
    `- 改善前の平均: ${evaluation.before.toFixed(3)} / 改善後の平均: ${evaluation.after.toFixed(3)}`,
    `- 閾値: ${String(record.spec.thresholdPct)}%以上かつ${String(record.spec.minAbsDelta)}以上の増加`,
    '',
    'このrevertは評価しない。同じ対象・指標の改善は、新しい根拠（教訓）が無い限り再提案しない。',
    '',
    `冪等キー: \`${input.key}\``,
  ].join('\n');
}

// ---------------------------------------------------------------- 状態ファイル

export class RetrospectiveStateCorruptError extends Error {}

const EMPTY_STATE: RetrospectiveState = { v: 1, improvements: [], tombstones: [] };

export function parseRetrospectiveState(text: string): RetrospectiveState {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new RetrospectiveStateCorruptError('振り返りの状態ファイルがJSONとして読めない');
  }
  const r = raw as Partial<RetrospectiveState> | null;
  if (
    r === null ||
    typeof r !== 'object' ||
    r.v !== 1 ||
    !Array.isArray(r.improvements) ||
    !Array.isArray(r.tombstones)
  ) {
    throw new RetrospectiveStateCorruptError('振り返りの状態ファイルの形が想定と違う');
  }
  return { v: 1, improvements: r.improvements, tombstones: r.tombstones };
}

async function readState(file: string): Promise<RetrospectiveState> {
  try {
    return parseRetrospectiveState(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...EMPTY_STATE, improvements: [], tombstones: [] };
    }
    throw err;
  }
}

async function writeState(file: string, state: RetrospectiveState): Promise<void> {
  const tmp = `${file}.${String(process.pid)}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
}

function isRunMetrics(value: unknown): value is RunMetrics {
  const m = value as Partial<RunMetrics> | null;
  return (
    m !== null &&
    typeof m === 'object' &&
    m.schemaVersion === 1 &&
    typeof m.runId === 'string' &&
    typeof m.startedAt === 'string' &&
    typeof m.finishedAt === 'string' &&
    typeof m.childIssues === 'number' &&
    typeof m.keys === 'object' &&
    m.keys !== null &&
    typeof m.keys.extensionVersion === 'string'
  );
}

/** runごとの指標（`<globalStorage>/run-metrics/*.json`）をすべて読む。読めないものは飛ばす。 */
export async function readAllRunMetrics(dir: string): Promise<RunMetrics[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: RunMetrics[] = [];
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
      if (isRunMetrics(parsed)) {
        out.push(parsed);
      }
    } catch {
      // 書きかけ・壊れた記録は使わない
    }
  }
  return out;
}

// ---------------------------------------------------------------- 入出力の口

export type MergeState =
  | { state: 'open' }
  | { state: 'closedWithoutMerge' }
  | {
      state: 'merged';
      mergedAt: number;
      version: string;
      pullRequestNumber: number;
      mergeCommit: string;
    }
  | { state: 'unknown'; reason: string };

export interface RetrospectiveForge {
  isGithub(root: string): Promise<boolean>;
  repoInfo(root: string): Promise<{ nameWithOwner: string; visibility: RepoVisibility }>;
  /** `self-improve`ラベルのIssue番号（closeを含む）。取れなければ`undefined`。 */
  listSelfImproveIssueNumbers(root: string): Promise<number[] | undefined>;
  /** 冪等キーを本文に含むIssue。無ければ`undefined`、確かめられなければ`'error'`。 */
  findIssueByKey(root: string, key: string): Promise<number | undefined | 'error'>;
  ensureLabel(root: string, name: string): Promise<void>;
  createIssue(
    root: string,
    issue: { title: string; body: string; labels: readonly string[] },
  ): Promise<{ ok: true; issueNumber: number } | { ok: false; message: string }>;
  readMergeState(root: string, issueNumber: number): Promise<MergeState>;
  /** `origin/main`の保護パスの一覧。取れなければ`undefined`。 */
  readProtectedPaths(root: string): Promise<string[] | undefined>;
  readIssueInfo(
    root: string,
    issueNumber: number,
  ): Promise<{ open: boolean; labels: string[]; title: string } | undefined>;
}

export interface RunRetrospectiveDeps {
  /** 状態・予算・記録の置き場（`<globalStorage>/self-improve`）。 */
  stateDir: string;
  /** runごとの指標の置き場（`<globalStorage>/run-metrics`）。 */
  metricsDir: string;
  runNotes: Pick<RunNotesStore, 'listLessons' | 'listRemaining'> | undefined;
  forge: RetrospectiveForge;
  /** この拡張自身のリポジトリ（`owner/name`）。分からなければ振り返らない。 */
  ownRepo: string | undefined;
  budgetConfig(): SelfImproveBudgetConfig;
  /** 週次使用率（%）。分からなければ`undefined`（止めない）。 */
  weeklyUsagePct(engine: TaskRunEngine): Promise<number | undefined>;
  now(): number;
  log(message: string): void;
}

export type RetrospectiveEvent =
  | 'skipped'
  | 'stopped'
  | 'evaluationHeld'
  | 'evaluated'
  | 'revertFiled'
  | 'filed'
  | 'rejected'
  | 'noProposal'
  | 'startAllowed'
  | 'startDenied'
  | 'error';

/** 自己改善の起票・評価・着手。runの終了時と`start_self_improve_run`から呼ぶ。 */
export class RunRetrospective {
  private readonly budget: SelfImproveBudgetStore;

  constructor(private readonly deps: RunRetrospectiveDeps) {
    this.budget = new SelfImproveBudgetStore(path.join(deps.stateDir, BUDGET_FILE_NAME));
  }

  /** runの終了時の振り返り。失敗はrunの進行に影響させず、記録に残す。 */
  async onRunFinished(run: TaskRun): Promise<void> {
    try {
      await this.retrospect(run);
    } catch (e) {
      await this.record(run.runId, 'error', e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * 自己改善Issueに着手してよいか確かめ、よければ`start`を同じ直列化の中で呼ぶ（別ウィンドウと
   * 同時に2本始めないため）。`runsInFolder`は同じフォルダのrun。
   */
  async startSelfImprove<T extends { ok: boolean; message: string }>(input: {
    workspaceRoot: string;
    engine: TaskRunEngine;
    issueNumber: number;
    runsInFolder: () => readonly TaskRun[];
    start: (title: string) => Promise<T>;
  }): Promise<T | { ok: false; message: string }> {
    const { workspaceRoot: root, issueNumber } = input;
    const deny = async (message: string): Promise<{ ok: false; message: string }> => {
      await this.record(undefined, 'startDenied', `#${String(issueNumber)}: ${message}`);
      return { ok: false, message };
    };
    const own = await this.resolveOwnRepo(root);
    if (!own.ok) {
      return deny(`${own.reason}ため自己改善に着手しない`);
    }
    const info = await this.deps.forge.readIssueInfo(root, issueNumber);
    if (info === undefined) {
      return deny(`Issue #${String(issueNumber)}を読めない`);
    }
    if (!info.open || !info.labels.includes(SELF_IMPROVE_LABEL)) {
      return deny(
        `Issue #${String(issueNumber)}は${SELF_IMPROVE_LABEL}ラベルの開いたIssueでないため着手しない`,
      );
    }
    try {
      return await this.locked(async () => {
        const running = input
          .runsInFolder()
          .find(
            (r) => r.finishedAt === undefined && r.title?.startsWith(SELF_IMPROVE_RUN_TITLE_PREFIX),
          );
        if (running !== undefined) {
          return deny(`自己改善のrun（runId=${running.runId}）が終わっていないため直列に待つ`);
        }
        const state = await readState(this.stateFile());
        await this.refreshMergeStates(root, state);
        await writeState(this.stateFile(), state);
        const usage = await this.deps.weeklyUsagePct(input.engine);
        const decision = decideStart(await this.budget.read(), usage, this.deps.budgetConfig());
        if (!decision.allowed) {
          return deny(decision.reason);
        }
        const title = `${SELF_IMPROVE_RUN_TITLE_PREFIX}${String(issueNumber)}`;
        const result = await input.start(title);
        await this.record(
          undefined,
          result.ok ? 'startAllowed' : 'startDenied',
          `#${String(issueNumber)}: ${result.message}`,
        );
        return result;
      });
    } catch (e) {
      return deny(e instanceof Error ? e.message : String(e));
    }
  }

  private stateFile(): string {
    return path.join(this.deps.stateDir, STATE_FILE_NAME);
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    return withFileLock(path.join(this.deps.stateDir, LOCK_FILE_NAME), fn, {
      staleMs: LOCK_STALE_MS,
    });
  }

  /**
   * runのワークスペースがこの拡張自身のリポジトリか。自己改善はこの拡張を直すものなので、
   * 他のリポジトリのrunからは起票も評価もしない（他repoへこの拡張の改善を起票しないため）。
   */
  private async resolveOwnRepo(
    root: string,
  ): Promise<
    | { ok: true; repo: { nameWithOwner: string; visibility: RepoVisibility } }
    | { ok: false; reason: string }
  > {
    const own = this.deps.ownRepo?.toLowerCase();
    if (own === undefined) {
      return { ok: false, reason: 'この拡張のリポジトリが分からない' };
    }
    if (!(await this.deps.forge.isGithub(root))) {
      return { ok: false, reason: 'GitHubのリポジトリでない' };
    }
    const repo = await this.deps.forge.repoInfo(root);
    if (repo.nameWithOwner.toLowerCase() !== own) {
      return { ok: false, reason: 'この拡張自身のリポジトリでない' };
    }
    return { ok: true, repo };
  }

  private async retrospect(run: TaskRun): Promise<void> {
    const own = await this.resolveOwnRepo(run.workspaceRoot);
    if (!own.ok) {
      await this.record(run.runId, 'skipped', `${own.reason}ため振り返らない`);
      return;
    }
    const config = this.deps.budgetConfig();
    const usage = await this.deps.weeklyUsagePct(run.engine);
    const usageDecision = decideUsage(usage, config);
    if (!usageDecision.allowed) {
      await this.record(run.runId, 'stopped', usageDecision.reason);
      return;
    }
    if (usage === undefined) {
      await this.record(run.runId, 'skipped', '週次使用率が分からないため、止めずに続ける');
    }
    const isSelfImproveRun = await this.isSelfImproveRun(run);
    if (isSelfImproveRun === undefined) {
      await this.record(
        run.runId,
        'stopped',
        `${SELF_IMPROVE_LABEL}ラベルのIssueを確かめられず、自己改善のrunか分からないため振り返らない`,
      );
      return;
    }
    await this.locked(async () => {
      const state = await readState(this.stateFile());
      try {
        await this.evaluatePending(run, state);
        const decision = decideRetrospective(usage, config, isSelfImproveRun);
        if (!decision.allowed) {
          await this.record(run.runId, 'stopped', decision.reason);
          return;
        }
        await this.propose(run, state, own.repo, usage, config);
      } finally {
        await writeState(this.stateFile(), state);
      }
    });
  }

  private async isSelfImproveRun(run: TaskRun): Promise<boolean | undefined> {
    if (run.title?.startsWith(SELF_IMPROVE_RUN_TITLE_PREFIX) === true) {
      return true;
    }
    const labeled = await this.deps.forge.listSelfImproveIssueNumbers(run.workspaceRoot);
    if (labeled === undefined) {
      return undefined;
    }
    return listTasks(run).some(
      (t) =>
        (t.issueNumber !== undefined && labeled.includes(t.issueNumber)) ||
        (t.existingIssueNumber !== undefined && labeled.includes(t.existingIssueNumber)),
    );
  }

  /** 起票済みでmerge前の改善が、mergeされたか・merge無しで閉じられたかを確かめて状態へ移す。 */
  private async refreshMergeStates(root: string, state: RetrospectiveState): Promise<void> {
    const now = this.deps.now();
    for (const rec of state.improvements) {
      if (rec.kind !== 'improvement' || rec.verdict !== undefined || rec.mergedAt !== undefined) {
        continue;
      }
      const m = await this.deps.forge.readMergeState(root, rec.issueNumber);
      if (m.state === 'merged') {
        rec.mergedAt = m.mergedAt;
        rec.version = m.version;
        rec.pullRequestNumber = m.pullRequestNumber;
        rec.mergeCommit = m.mergeCommit;
        await this.budget.markMerged(rec.issueNumber, m.mergedAt);
      } else if (m.state === 'closedWithoutMerge') {
        rec.verdict = 'abandoned';
        rec.evaluatedAt = now;
        await this.budget.markEvaluated(rec.issueNumber, now);
      }
    }
  }

  private async evaluatePending(run: TaskRun, state: RetrospectiveState): Promise<void> {
    const root = run.workspaceRoot;
    await this.refreshMergeStates(root, state);
    const pending = state.improvements.filter(
      (r) => r.kind === 'improvement' && r.verdict === undefined && r.mergedAt !== undefined,
    );
    if (pending.length === 0) {
      return;
    }
    const runs = await readAllRunMetrics(this.deps.metricsDir);
    for (const rec of pending) {
      const ev = evaluateImprovement(rec, runs);
      const n = `#${String(rec.issueNumber)}`;
      if (ev.kind === 'hold') {
        await this.record(
          run.runId,
          'evaluationHeld',
          `${n}: 対象のrunが${String(ev.have)}/${String(ev.need)}本のため判定を保留する`,
        );
        continue;
      }
      const now = this.deps.now();
      if (ev.kind === 'worsened') {
        const revert = await this.fileRevert(root, rec, ev);
        if (revert === undefined) {
          continue; // 起票できなかった。次の振り返りでやり直す
        }
        rec.revertIssueNumber = revert;
        rec.verdict = 'reverted';
        state.tombstones.push({
          target: rec.spec.target,
          metric: rec.spec.metric,
          evidence: rec.spec.evidence,
          improvementIssue: rec.issueNumber,
          revertIssue: revert,
          at: now,
        });
      } else {
        rec.verdict = ev.kind;
      }
      rec.evaluatedAt = now;
      await this.budget.markEvaluated(rec.issueNumber, now);
      await this.record(
        run.runId,
        'evaluated',
        ev.kind === 'noBaseline'
          ? `${n}: 改善前のrunが無く比べられないため維持する`
          : `${n}: ${rec.verdict}（改善前${ev.before.toFixed(3)} → 改善後${ev.after.toFixed(3)}）`,
      );
    }
  }

  /** revertのIssueを冪等キーで1件だけ起票する。起票済みならその番号、失敗なら`undefined`。 */
  private async fileRevert(
    root: string,
    rec: ImprovementRecord,
    evaluation: Extract<Evaluation, { kind: 'worsened' }>,
  ): Promise<number | undefined> {
    if (rec.revertIssueNumber !== undefined) {
      return rec.revertIssueNumber;
    }
    const key = revertKey(rec.issueNumber);
    const existing = await this.deps.forge.findIssueByKey(root, key);
    if (existing === 'error') {
      await this.record(
        undefined,
        'error',
        `#${String(rec.issueNumber)}のrevert Issueが既にあるか確かめられないため起票しない`,
      );
      return undefined;
    }
    if (existing !== undefined) {
      return existing;
    }
    await this.deps.forge.ensureLabel(root, SELF_IMPROVE_LABEL);
    const created = await this.deps.forge.createIssue(root, {
      title: `自己改善 #${String(rec.issueNumber)}をrevertする（${rec.spec.metric}が悪化）`,
      body: renderRevertBody({ record: rec, evaluation, key }),
      labels: [SELF_IMPROVE_LABEL],
    });
    if (!created.ok) {
      await this.record(undefined, 'error', `revert Issueを起票できない: ${created.message}`);
      return undefined;
    }
    await this.record(
      undefined,
      'revertFiled',
      `#${String(rec.issueNumber)}のrevertとして#${String(created.issueNumber)}を起票した`,
    );
    return created.issueNumber;
  }

  private async propose(
    run: TaskRun,
    state: RetrospectiveState,
    repo: { nameWithOwner: string; visibility: RepoVisibility },
    usage: number | undefined,
    config: SelfImproveBudgetConfig,
  ): Promise<void> {
    const root = run.workspaceRoot;
    const { forge, runNotes } = this.deps;
    const all = await readAllRunMetrics(this.deps.metricsDir);
    const current = all.find((m) => m.runId === run.runId);
    if (current === undefined) {
      await this.record(
        run.runId,
        'noProposal',
        'このrunの指標が記録されていないため改善案を作らない',
      );
      return;
    }
    const lessons = runNotes === undefined ? [] : await runNotes.listLessons(root);
    const proposal = buildProposal({
      runId: run.runId,
      lessons,
      current,
      history: all.filter((m) => m.runId !== run.runId),
    });
    if (proposal === undefined) {
      await this.record(
        run.runId,
        'noProposal',
        '昇格できる（出典がこのrepoの成果物の）教訓が無い',
      );
      return;
    }
    const { spec } = proposal;
    const tomb = findBlockingTombstone(state.tombstones, spec);
    if (tomb !== undefined) {
      await this.record(
        run.runId,
        'rejected',
        `#${String(tomb.improvementIssue)}をrevertした墓標と同じ対象・指標（${spec.metric}）で、新しい根拠が無いため再提案しない`,
      );
      return;
    }
    if (state.improvements.some((r) => r.spec.key === spec.key)) {
      await this.record(run.runId, 'rejected', `同じ改善（${spec.key}）を起票済み`);
      return;
    }
    const existing = await forge.findIssueByKey(root, spec.key);
    if (existing === 'error') {
      await this.record(
        run.runId,
        'stopped',
        `既存のIssueを確かめられないため起票しない（${spec.key}）`,
      );
      return;
    }
    if (existing !== undefined) {
      await this.record(
        run.runId,
        'rejected',
        `同じ改善（${spec.key}）が#${String(existing)}で起票済み`,
      );
      return;
    }
    const filing = decideIssueFiling(proposal.lesson, repo.visibility);
    if (!filing.ok) {
      await this.record(run.runId, 'stopped', filing.reason);
      return;
    }
    const patterns = await forge.readProtectedPaths(root);
    if (patterns === undefined) {
      await this.record(run.runId, 'stopped', '保護パスの一覧を読めないため起票しない');
      return;
    }
    const touches = findProtectedTouches(spec.files, patterns);
    const kind = touches.length > 0 ? 'research' : 'improvement';
    const budgetDecision = decideFile(await this.budget.read(), usage, config, this.deps.now());
    if (!budgetDecision.allowed) {
      await this.record(run.runId, 'stopped', budgetDecision.reason);
      return;
    }
    const openRemaining =
      runNotes === undefined
        ? 0
        : (await runNotes.listRemaining(root)).filter(
            (r) => r.runId === run.runId && r.status === 'open',
          ).length;
    const body = renderProposalBody({
      proposal,
      kind,
      protectedTouches: touches,
      runId: run.runId,
      openRemaining,
      visibility: repo.visibility,
      ownRepo: repo.nameWithOwner,
    });
    if (body === undefined) {
      await this.record(run.runId, 'stopped', '教訓の出典か宛先の公開範囲により起票しない');
      return;
    }
    const label = kind === 'improvement' ? SELF_IMPROVE_LABEL : RESEARCH_LABEL;
    await forge.ensureLabel(root, label);
    const created = await forge.createIssue(root, {
      title:
        kind === 'improvement'
          ? `自己改善: 教訓${proposal.lesson.id.slice(0, 8)}を工程プロンプトの定型文へ昇格する`
          : `提案: 教訓${proposal.lesson.id.slice(0, 8)}の昇格（保護パスに触れるため人が判断）`,
      body,
      labels: [label],
    });
    if (!created.ok) {
      await this.record(run.runId, 'error', `改善Issueを起票できない: ${created.message}`);
      return;
    }
    const now = this.deps.now();
    await this.budget.recordFiled(created.issueNumber, now);
    state.improvements.push({ issueNumber: created.issueNumber, kind, spec, filedAt: now });
    await this.record(
      run.runId,
      'filed',
      `${kind === 'improvement' ? '改善' : '調査'}Issue #${String(created.issueNumber)}を起票した（${spec.key}、指標: ${spec.metric}）`,
    );
  }

  /** 判断の記録。出力パネルと`retrospective-log.jsonl`へ残す。 */
  private async record(
    runId: string | undefined,
    event: RetrospectiveEvent,
    detail: string,
  ): Promise<void> {
    this.deps.log(`[retrospective] ${event}${runId === undefined ? '' : ` (${runId})`}: ${detail}`);
    try {
      await fs.mkdir(this.deps.stateDir, { recursive: true });
      await fs.appendFile(
        path.join(this.deps.stateDir, LOG_FILE_NAME),
        `${JSON.stringify({ at: new Date(this.deps.now()).toISOString(), runId, event, detail })}\n`,
        'utf8',
      );
    } catch (e) {
      this.deps.log(
        `[retrospective] 記録を書けない: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
