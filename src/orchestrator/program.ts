import { parse } from 'yaml';

import { findCycleGroups, TASK_ID_PATTERN, type DependencyGraphNode } from './workflow';

/**
 * プログラム定義（複数runの束）のYAMLスキーマと検証（design.md §16.37、roadmap W12、
 * Issue #604・#605・#606）。
 *
 * `workflow.ts` がタスクの束（1run）を扱うのに対し、こちらはrunの束（1プログラム）を
 * 扱う。ここに持つのはrunの一覧・run同士の依存の宣言・同時実行数の上限
 * （`maxParallel`）というスキーマと検証まで。**波のスケジューリング本体（依存の無い
 * runを同時に走らせる実際のアルゴリズム）・失敗の伝播（前段が`failed`のとき後段を
 * `skipped`にする）・人による停止（`haltedByUser`）は`programScheduler.ts` /
 * `programState.ts` / `programRunner.ts`が持つ（roadmap W12-2・W12-3、Issue #605・
 * #606。着手時点では未実装だったが、両方とも着地済み）。** `workflow.ts`と同じく
 * VSCode APIには一切依存しない純粋なロジックのみを置く。
 *
 * **上位のオーケストレーターは置かない。** プログラムが持つのは定義と状態
 * （`programState.ts`）だけで、各runのオーケストレーターは引き続き自分のrunだけを見る
 * （design.md §16.23）。
 */

/** プログラム内で束ねられるrun1件の定義。 */
export interface ProgramRunRef {
  /** プログラム内で一意。テンプレート的な参照はまだ持たない（依存の宣言にのみ使う）。 */
  id: string;
  /** そのrunが使うワークフロー定義ファイル（`workflow.ts`の定義）への相対パス。 */
  defPath: string;
  /** 先に完了していなければならないrunid。 */
  dependsOn: string[];
  /** パース時点で検出した検証エラー（`validateProgram`がそのままrunidを添えて報告する）。 */
  parseErrors: string[];
}

/** プログラム定義ファイル全体の内部表現。 */
export interface ProgramDefinition {
  version: number;
  name: string;
  /** 同時に走らせるrunの数の上限（design.md §16.37.2）。`workflow.ts`の`maxParallel`と同じ考え方。 */
  maxParallel: number;
  runs: ProgramRunRef[];
}

/** プログラム内のrunidの字種。`workflow.ts`の`TASK_ID_PATTERN`とそろえる（design.md §16.2）。 */
export const PROGRAM_RUN_ID_PATTERN = TASK_ID_PATTERN;

/** プログラムに束ねられるrunの総数の上限。`workflow.ts`の`MAX_TASK_COUNT`と同じ考え方。 */
export const MAX_PROGRAM_RUN_COUNT = 50;

/**
 * プログラム全体で同時に走らせるrunの数の下限・上限。`workflow.ts`の`MAX_PARALLEL_MIN` /
 * `MAX_PARALLEL_MAX`と同じ値を採用する（design.md §16.37.2「同時実行数の上限」）。
 */
export const PROGRAM_MAX_PARALLEL_MIN = 1;
export const PROGRAM_MAX_PARALLEL_MAX = 10;

/**
 * `maxParallel`未指定時の既定値。`workflow.ts`の`DEFAULT_MAX_PARALLEL`（タスク単位）と
 * 同じ値を踏襲する（design.md §16.37.2「同時実行数の上限」の根拠参照。runはタスクより
 * 重いことを承知のうえで、まずは既存の既定値から始め、`maxParallel`で運用実績に応じて
 * 変えられるようにした）。
 */
export const DEFAULT_PROGRAM_MAX_PARALLEL = 3;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown, fallback: number): number => {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return fallback;
};

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** `workflow.ts`の`rec()`と同じ考え方（プロトタイプ汚染を招くキーを素通しさせない）。 */
const rec = (v: unknown): Record<string, unknown> | undefined => {
  if (typeof v !== 'object' || v === null) {
    return undefined;
  }
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(v)) {
    if (!DANGEROUS_KEYS.has(key)) {
      out[key] = value;
    }
  }
  return out;
};

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** 未知のフィールドは読み飛ばす（`workflow.ts`の`resolveTask`と同じ方針）。 */
function resolveRunRef(raw: unknown): ProgramRunRef {
  const r = rec(raw) ?? {};
  const id = str(r['id']);
  const defPath = str(r['defPath']);
  const parseErrors: string[] = [];

  const dependsOnRaw = r['dependsOn'];
  let dependsOn: string[] = [];
  if (dependsOnRaw !== undefined) {
    if (!Array.isArray(dependsOnRaw)) {
      parseErrors.push('dependsOn は配列で指定してください（例: dependsOn: [R1]）');
    } else {
      const values = dependsOnRaw.filter((x): x is string => typeof x === 'string');
      if (values.length !== dependsOnRaw.length) {
        parseErrors.push('dependsOn の要素は文字列のみ指定できます');
      }
      dependsOn = values;
    }
  }

  return { id, defPath, dependsOn, parseErrors };
}

/**
 * プログラム定義のYAMLを読み込む。ここではスキーマの検証はしない（`validateProgram`が
 * 別関数、`workflow.ts`の`parseWorkflowYaml`と同じ役割分担）。
 */
export function parseProgramYaml(source: string): ProgramDefinition {
  const raw = parse(source);
  const root = rec(raw) ?? {};
  const runsRaw = arr(root['runs']);
  return {
    version: num(root['version'], 1),
    name: str(root['name']),
    maxParallel: num(root['maxParallel'], DEFAULT_PROGRAM_MAX_PARALLEL),
    runs: runsRaw.map(resolveRunRef),
  };
}

export interface ProgramIssue {
  /** 関係するrunid。プログラム全体に関わるもの（run総数超過など）は空配列。 */
  runIds: string[];
  message: string;
}

export type ProgramError = ProgramIssue;
export type ProgramWarning = ProgramIssue;

export interface ProgramValidationResult {
  errors: ProgramError[];
  warnings: ProgramWarning[];
}

/**
 * `defPath`がワークスペース内の `.yaml` / `.yml` を指す相対パスか。
 * `workflow.ts`の`isSafeRoadmapPath`と同じ考え方（パストラバーサル対策、design.md §16.2）。
 */
function isSafeDefPath(value: string): boolean {
  if (value === '' || [...value].some((ch) => (ch.codePointAt(0) ?? 0) < 32)) {
    return false;
  }
  if (value.startsWith('/') || value.startsWith('\\\\') || /^[A-Za-z]:/u.test(value)) {
    return false;
  }
  const segments = value.split(/[\\/]/u);
  if (segments.some((seg) => seg === '..' || seg === '')) {
    return false;
  }
  const lower = value.toLowerCase();
  return lower.endsWith('.yaml') || lower.endsWith('.yml');
}

/**
 * プログラム定義を検証する。1件でも該当すれば実行を始めない（`workflow.ts`の
 * `validateWorkflow`と同じ方針。design.md §16.2「検証」）。エラーは全件まとめて返す。
 *
 * ここで拒否するのは、この段（W12-1）の受入基準にある**循環依存・未定義run参照**を
 * 中心にした、定義の構文的な妥当性のみ。波のスケジューリングや失敗の伝播が妥当かは
 * 後続Issue（#605・#606）の担当で、ここでは検証しない。
 */
export function validateProgram(def: ProgramDefinition): ProgramValidationResult {
  const errors: ProgramError[] = [];
  const warnings: ProgramWarning[] = [];
  const runs = def.runs;

  if (def.name.trim() === '') {
    errors.push({ runIds: [], message: 'name が指定されていません' });
  }

  if (def.version !== 1) {
    errors.push({ runIds: [], message: `version はサポートしていない値です: ${def.version}` });
  }

  if (!Array.isArray(runs) || runs.length === 0) {
    errors.push({
      runIds: [],
      message: 'runs が1件も定義されていません（配列でない場合を含む）',
    });
  }

  if (runs.length > MAX_PROGRAM_RUN_COUNT) {
    errors.push({
      runIds: [],
      message: `runの総数が上限(${MAX_PROGRAM_RUN_COUNT})を超えています: ${runs.length}`,
    });
  }

  if (
    !Number.isInteger(def.maxParallel) ||
    def.maxParallel < PROGRAM_MAX_PARALLEL_MIN ||
    def.maxParallel > PROGRAM_MAX_PARALLEL_MAX
  ) {
    errors.push({
      runIds: [],
      message:
        `maxParallel は${PROGRAM_MAX_PARALLEL_MIN}〜${PROGRAM_MAX_PARALLEL_MAX}の範囲で指定してください: ${def.maxParallel}`,
    });
  }

  const idCounts = new Map<string, number>();
  for (const r of runs) {
    idCounts.set(r.id, (idCounts.get(r.id) ?? 0) + 1);
    if (!PROGRAM_RUN_ID_PATTERN.test(r.id)) {
      errors.push({
        runIds: [r.id],
        message: `id の形式が不正です（半角英数字・_・-のみ、1〜50文字にしてください）: "${r.id}"`,
      });
    }
    // `PROGRAM_RUN_ID_PATTERN`（`TASK_ID_PATTERN`）は文字種しか見ないため、
    // "__proto__" 等のプロトタイプ汚染キーもここまでは通り抜ける。
    // `createInitialProgramState`（`programState.ts`）は`runs[r.id] = ...`と
    // ブラケット代入で`Record<string, ProgramRunEntry>`へ組み立てるため、r.idが
    // 危険キーだとプロパティ追加ではなくプロトタイプの書き換えになり、そのrunが
    // `Object.keys`・`JSON.stringify`（`workspaceState`への永続化）から静かに消える
    // （横断レビューで実測、Issue #606）。同じ危険キー集合を使う`rec()`（上記）と
    // 同じ考え方でここでも弾く
    if (DANGEROUS_KEYS.has(r.id)) {
      errors.push({
        runIds: [r.id],
        message: `id にプロトタイプ汚染を招く名前は使えません: "${r.id}"`,
      });
    }
  }
  for (const [id, count] of idCounts) {
    if (count > 1) {
      errors.push({ runIds: [id], message: `id が重複しています: ${id}` });
    }
  }

  const idSet = new Set(runs.map((r) => r.id));

  for (const r of runs) {
    if (!isSafeDefPath(r.defPath)) {
      errors.push({
        runIds: [r.id],
        message: `defPath はワークスペース内の .yaml/.yml を指す相対パスにしてください: ${r.defPath}`,
      });
    }
    for (const dep of r.dependsOn) {
      if (!idSet.has(dep)) {
        errors.push({
          runIds: [r.id],
          message: `dependsOn が未定義のrunを参照しています: ${dep}`,
        });
      }
    }
    for (const message of r.parseErrors) {
      errors.push({ runIds: [r.id], message });
    }
  }

  const nodes: DependencyGraphNode[] = runs.map((r) => ({ id: r.id, dependsOn: r.dependsOn }));
  for (const group of findCycleGroups(nodes)) {
    errors.push({
      runIds: group,
      message: `依存が循環しています: ${group.join(', ')}`,
    });
  }

  return { errors, warnings };
}
