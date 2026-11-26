import type { TaskRun, TaskRunGoal, TaskRunGoalRevision, TaskRunGoalSource } from './taskRunState';
import { sanitizeInlineText } from './untrustedText';

/**
 * runの目的（goal）の受け取り・読み取り・修正（Issue #2193）。目的と完了条件は外部由来の文字列
 * （起動元チャットのモデル・ロードマップ本文・Orchestrator）なので、保存前に1行へ均して長さを切る。
 * 読む側は`readTaskRunGoal`を通し、壊れた保存データと以前の版の固定文を目的なしとして扱う。
 */

/** 目的・完了条件それぞれの長さの上限（UTF-16のコード単位数。`sanitizeInlineText`と同じ数え方）。 */
export const GOAL_TEXT_MAX_LENGTH = 500;
/** `set_goal`の理由の長さの上限。 */
export const GOAL_REASON_MAX_LENGTH = 300;
/** goalの修正の記録を残す上限。古いものから捨てる。 */
export const MAX_GOAL_REVISIONS = 20;

/** ツールの説明に添える、完了条件の書き方。 */
export const GOAL_CRITERIA_GUIDANCE =
  '完了条件は観測できる結果（数値・状態・動作）で書く。タスクの消化を完了条件にしない';

/** 出所の表示名。 */
export const GOAL_SOURCE_LABELS: Record<TaskRunGoalSource, string> = {
  start: '起動時に指定',
  roadmap: 'ロードマップ本文の節',
  orchestrator: 'set_goalで修正',
};

/**
 * 以前の版（Issue #2088）がロードマップのrunへ入れていた固定文の完了条件。観測できる結果ではなく
 * 評価が空回りしたため、読み込んだときは目的なしとして扱う（保存データは書き換えない）。
 */
const LEGACY_FIXED_CRITERIA = /^ロードマップIssue #\d+の目的を満たす観測できる結果が揃う$/u;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 1行へ均した文。空なら`undefined`。 */
function inlineGoalText(text: string, maxLength: number): string | undefined {
  const inline = sanitizeInlineText(text.replace(/\s+/gu, ' ').trim(), maxLength);
  return inline === '' ? undefined : inline;
}

/** 保存済みのgoalが以前の版の固定文か（Issue #2088の版が入れたもの）。 */
export function isLegacyFixedGoal(goal: unknown): boolean {
  return (
    isPlainRecord(goal) &&
    goal.source === undefined &&
    typeof goal.completionCriteria === 'string' &&
    LEGACY_FIXED_CRITERIA.test(goal.completionCriteria)
  );
}

/**
 * runのgoalを読む。項目が無い・形が壊れている・以前の版の固定文なら`undefined`。
 * 文は保存前に均してあるが、壊れた保存データに備えてもう一度均す。
 */
export function readTaskRunGoal(run: { readonly goal?: unknown }): TaskRunGoal | undefined {
  const raw: unknown = run.goal;
  if (!isPlainRecord(raw) || typeof raw.objective !== 'string' || isLegacyFixedGoal(raw)) {
    return undefined;
  }
  const objective = inlineGoalText(raw.objective, GOAL_TEXT_MAX_LENGTH);
  if (objective === undefined) {
    return undefined;
  }
  const criteria =
    typeof raw.completionCriteria === 'string'
      ? inlineGoalText(raw.completionCriteria, GOAL_TEXT_MAX_LENGTH)
      : undefined;
  const source =
    raw.source === 'start' || raw.source === 'roadmap' || raw.source === 'orchestrator'
      ? raw.source
      : undefined;
  return {
    objective,
    ...(criteria === undefined ? {} : { completionCriteria: criteria }),
    ...(source === undefined ? {} : { source }),
  };
}

/** runのgoalの修正の記録を読む。項目の無い保存データは空。壊れた要素は飛ばす。 */
export function readTaskRunGoalRevisions(
  run: Pick<TaskRun, 'goalRevisions'>,
): TaskRunGoalRevision[] {
  const raw: unknown = run.goalRevisions;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((r: unknown): TaskRunGoalRevision[] => {
    if (!isPlainRecord(r) || typeof r.reason !== 'string' || typeof r.at !== 'string') {
      return [];
    }
    // 直す前のgoalも形を確かめて読み直す。壊れていれば前はgoalなしとして扱う
    const previous = readTaskRunGoal({ goal: r.previous });
    return [{ reason: r.reason, at: r.at, ...(previous === undefined ? {} : { previous }) }];
  });
}

export type GoalInputResult =
  { ok: true; value: TaskRunGoal | undefined } | { ok: false; message: string };

/**
 * ツールの引数のgoal（`objective`・`completionCriteria`）を確かめる。省略なら`undefined`。
 * どちらも空でない文字列で、上限を超えないこと。1行へ均してから返す。
 */
export function parseGoalInput(raw: unknown, source: TaskRunGoalSource): GoalInputResult {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  const invalid = {
    ok: false as const,
    message: `goalはobjectiveとcompletionCriteriaを持つオブジェクトで、それぞれ1〜${String(GOAL_TEXT_MAX_LENGTH)}文字の文字列で指定する`,
  };
  if (!isPlainRecord(raw)) {
    return invalid;
  }
  const { objective, completionCriteria } = raw;
  if (typeof objective !== 'string' || typeof completionCriteria !== 'string') {
    return invalid;
  }
  // 切り詰めずに均してから長さを確かめる。`sanitizeInlineText`はUTF-16のコード単位で切るため、
  // 先に切ると上限を超えた入力が通り、サロゲートペアの片割れが残る。上限もコード単位で数え、
  // 表示側の`sanitizeInlineText(…, GOAL_TEXT_MAX_LENGTH)`が受け付けた文を切らないようにする
  const o = inlineGoalText(objective, Number.MAX_SAFE_INTEGER);
  const c = inlineGoalText(completionCriteria, Number.MAX_SAFE_INTEGER);
  if (
    o === undefined ||
    c === undefined ||
    o.length > GOAL_TEXT_MAX_LENGTH ||
    c.length > GOAL_TEXT_MAX_LENGTH
  ) {
    return invalid;
  }
  return { ok: true, value: { objective: o, completionCriteria: c, source } };
}

/** 見出し行（ATX）。`#`の数と見出しの文を返す。 */
function parseHeading(line: string): { level: number; text: string } | undefined {
  const match = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/u.exec(line);
  if (match === null) {
    return undefined;
  }
  return { level: match[1]?.length ?? 0, text: (match[2] ?? '').trim() };
}

/**
 * ロードマップ本文から「目的」「完了条件」の見出しの節を読む（Issue #2193）。節は次の同じか上の
 * レベルの見出しまで。コードブロックの中の見出しは見ない。節の行は「 / 」で1行へつなぐ。
 * どちらの節も無いか空なら`undefined`。完了条件の節だけがあれば、目的はロードマップの題にする。
 */
export function extractRoadmapGoal(body: string, roadmapTitle: string): TaskRunGoal | undefined {
  const sections = new Map<string, string[]>();
  let current: { name: string; level: number } | undefined;
  let fence: string | undefined;
  for (const line of body.split(/\r?\n/u)) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
    if (fenceMatch !== null) {
      const marker = fenceMatch[1] ?? '';
      if (fence === undefined) {
        fence = marker;
      } else if (marker.startsWith(fence[0] ?? '') && marker.length >= fence.length) {
        fence = undefined;
      }
    }
    const heading = fence === undefined && fenceMatch === null ? parseHeading(line) : undefined;
    if (heading !== undefined) {
      if (current !== undefined && heading.level <= current.level) {
        current = undefined;
      }
      if (
        current === undefined &&
        (heading.text === '目的' || heading.text === '完了条件') &&
        !sections.has(heading.text)
      ) {
        current = { name: heading.text, level: heading.level };
        sections.set(heading.text, []);
        continue;
      }
    }
    if (current !== undefined) {
      sections.get(current.name)?.push(line);
    }
  }
  const join = (name: string): string | undefined => {
    const lines = (sections.get(name) ?? [])
      // HTMLコメントの行（計画区画の目印など）は節の中身にしない
      .filter((l) => !/^\s*<!--.*-->\s*$/u.test(l))
      // 箇条書きの記号と下位の見出しの`#`は外す
      .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)]|#{1,6})\s+/u, '').trim())
      .filter((l) => l !== '');
    return lines.length === 0 ? undefined : inlineGoalText(lines.join(' / '), GOAL_TEXT_MAX_LENGTH);
  };
  const objective = join('目的');
  const criteria = join('完了条件');
  if (objective === undefined && criteria === undefined) {
    return undefined;
  }
  const fallbackObjective = inlineGoalText(roadmapTitle, GOAL_TEXT_MAX_LENGTH);
  const resolvedObjective = objective ?? fallbackObjective;
  if (resolvedObjective === undefined) {
    return undefined;
  }
  return {
    objective: resolvedObjective,
    ...(criteria === undefined ? {} : { completionCriteria: criteria }),
    source: 'roadmap',
  };
}

/**
 * goalを差し替え、理由と前のgoalを記録へ足した新しいrunを返す（`set_goal`。Issue #2193）。
 * 記録は`MAX_GOAL_REVISIONS`件まで残す。
 */
export function setTaskRunGoal(
  run: TaskRun,
  goal: TaskRunGoal,
  reason: string,
  now: string,
): TaskRun {
  const previous = readTaskRunGoal(run);
  const revision: TaskRunGoalRevision = {
    reason,
    at: now,
    ...(previous === undefined ? {} : { previous }),
  };
  return {
    ...run,
    goal,
    goalRevisions: [...readTaskRunGoalRevisions(run), revision].slice(-MAX_GOAL_REVISIONS),
  };
}

/**
 * Orchestratorへ見せるgoalの行（`get_run_state`・merge時の促し）。文は保存前に均してあるが、
 * 表示の上限でもう一度切る。完了条件が無ければその行は出さない。
 */
export function formatGoalLines(goal: TaskRunGoal, maxLength: number): string[] {
  return [
    `目的: ${sanitizeInlineText(goal.objective, maxLength)}`,
    ...(goal.completionCriteria === undefined
      ? []
      : [`完了条件: ${sanitizeInlineText(goal.completionCriteria, maxLength)}`]),
  ];
}
