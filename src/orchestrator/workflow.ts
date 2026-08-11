import { parse } from 'yaml';

import { APPROVAL_MODES, SANDBOX_MODES } from '../codex/types';
import { LOOP_ITERATION_LIMIT } from '../loop/loopController';

/**
 * ワークフロー定義のYAMLスキーマ・検証・テンプレート展開（design.md §16.2 / §16.4 / §16.16）。
 *
 * VSCode APIには一切依存しない純粋なロジックのみを置く。ファイルの探索・実行・
 * worktree操作・承認判定は後続Issue（runner.ts / scheduler.ts / worktree.ts /
 * escalation.ts）に委ねる。
 */

export const PROVIDERS = ['codex', 'claude'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const ISOLATIONS = ['worktree', 'worktree-strict', 'shared'] as const;
export type Isolation = (typeof ISOLATIONS)[number];

/**
 * `after-merge` は design.md §16.17「worktreeの片付け」の新しい既定値。
 * マージが成功した時点でそのタスクのworktreeを撤去する（`worktree.ts` の
 * `shouldRemoveWorktree` 参照）。`remove`（タスクが`done`になった時点で撤去）は、
 * `done`の意味自体が「統合ブランチへ入った（＝マージ成功）」に変わった（design.md §16.17）
 * ため、実質`after-merge`と同じ事象で発火する既存の値として残してある。
 */
export const CLEANUP_MODES = ['keep', 'after-merge', 'remove'] as const;
export type CleanupMode = (typeof CLEANUP_MODES)[number];

/**
 * タスクidの字種。そのままworktreeのパスとブランチ名に入るため絞る。
 * `codex/argvBuilder.ts` がセッションidをUUIDで検証しているのと同じ理由（design.md §16.2）。
 *
 * 先頭のハイフンを許さないのは、`-x` のようなidをそのまま `git` などのCLI引数へ渡すと、
 * 値ではなくオプションフラグとして解釈されうるため（design.mdが変更理由に挙げている
 * 「gitの引数解釈」問題そのもの）。design.md §16.2の正規表現と一致させてある。
 */
export const TASK_ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,49}$/;

/** Windowsではファイル・ディレクトリ名として使えない予約デバイス名（大文字小文字を問わない完全一致）。 */
const WINDOWS_RESERVED_NAME_PATTERN = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/**
 * 再試行時のブランチ名 `wf/<runId>/<taskId>-retry<n>`（design.md §16.5）と衝突するのを防ぐ。
 * idそのものがこの形で終わっていると、1回目の実行から衝突しうる。
 */
const RETRY_SUFFIX_PATTERN = /-retry\d+$/;

/**
 * 統合worktreeのディレクトリ名として予約されている（design.md §16.17「`_integration`は
 * タスクidとして予約する」。`id: _integration`と書けてしまうと、`integration.ts`の
 * `integrationWorktreePath`が指すディレクトリと同じ場所を指してしまう）。
 *
 * `integration.ts`の`INTEGRATION_DIR_NAME`と同じ文字列だが、`integration.ts`は
 * `workflow.ts`をimportしているため、循環importを避けてここでは文字列リテラルとして
 * 複製する（`worktree.ts`/`integration.ts`間の定数複製と同じ方針。design.mdコメント参照）。
 */
const RESERVED_INTEGRATION_TASK_ID = '_integration';

export const MAX_PARALLEL_MIN = 1;
export const MAX_PARALLEL_MAX = 10;
export const MAX_TASK_COUNT = 50;
/** 再試行のたびに新しいworktreeとCLIプロセスが増えるため、際限なく許さない。 */
export const MAX_RETRIES = 10;
/** 巨大な文字列を拡張機能ホストへ渡してハングさせないための上限（`prompt` / `done` / `continuePrompt` 共通）。 */
export const MAX_PROMPT_LENGTH = 20000;

/** `defaults` 省略時に使う組み込みの既定値。design.md §16.2のサンプルおよび§16.13の記述に合わせる。 */
export const DEFAULT_MAX_PARALLEL = 3;
export const DEFAULT_MAX_ITERATIONS = 20;
export const DEFAULT_CONTINUE_PROMPT = '続けてください';
export const DEFAULT_PROVIDER: Provider = 'codex';
export const DEFAULT_ISOLATION: Isolation = 'worktree';
/** design.md §16.17「worktreeの片付け」でこれが新しい既定になった（旧既定は`keep`）。 */
export const DEFAULT_CLEANUP: CleanupMode = 'after-merge';
/**
 * autoApproveの組み込み既定値はfalseにしてある。
 * design.mdのサンプルはtrueで書いているが、あれは「著者が明示的に選んだ値」の例であって
 * 「何も書かなかったときの既定」ではない。§16.16の「安全側に倒す」方針に合わせ、
 * 未指定なら安全側（承認は全て人へ回す）を選ぶ。
 */
export const DEFAULT_AUTO_APPROVE = false;

/** 1タスク分の内部表現。`defaults` を解決済みで持つため、呼び出し側はdefaultsを意識しなくてよい。 */
export interface WorkflowTask {
  id: string;
  prompt: string;
  done: string;
  dependsOn: string[];
  continuePrompt: string;
  maxIterations: number;
  provider: Provider;
  isolation: Isolation;
  /**
   * 明示するとworktreeを作らずここで走る（`isolation` より優先）。
   * ワークスペース境界の検証はファイルシステムに触れるためこのIssueの範囲外（design.md §16.16）。
   * 検証を足すときは `validateWorkflow` に `workspaceRoots: string[]` のような追加引数を
   * 増やす形で拡張できるよう、フィールド自体はここで確保してある。
   */
  cwd: string | undefined;
  /** 拡張機能の設定へ委譲する場合は undefined（空文字は「未指定」として扱う）。 */
  model: string | undefined;
  effort: string | undefined;
  /**
   * Codexの `approvalMode` とClaudeの `permissionMode` の両方をこのフィールドに書く。
   * design.md §16.2の定義ファイルスキーマは provider を問わず `approvalMode` という
   * 1つのキー名で統一している。実際の値の妥当性（Codex/Claudeどちらの語彙か）と
   * 危険値の無効化は、拡張機能の設定を知っている呼び出し側（runner.ts）が
   * `clampCodexApprovalMode` / `clampClaudePermissionMode` を使って判定する。
   */
  approvalMode: string | undefined;
  sandbox: string | undefined;
  autoApprove: boolean;
  escalate: string[];
  allow: string[];
  retries: number;
  cleanup: CleanupMode;
  /**
   * パース時点で検出した検証エラーのメッセージ。`validateWorkflow` がそのままタスクidを添えて報告する。
   * 例: `dependsOn: T1`（配列記法の書き忘れ）は解決後の値だけでは「未指定」と区別が付かないため、
   * ここに残しておく。
   */
  parseErrors: string[];
  /**
   * パース時点で検出した警告メッセージ。`validateWorkflow` がそのままタスクidを添えて報告する。
   * 例: `provider` / `isolation` の値が未知の文字列だった、`escalate` / `dependsOn` / `allow` の
   * 配列に文字列以外の要素が混ざっていた、など。
   */
  parseWarnings: string[];
}

/** ワークフロー定義ファイル全体の内部表現。 */
export interface WorkflowDefinition {
  version: number;
  name: string;
  /** `defaults.maxParallel` を解決した値。タスク単位ではなくワークフロー全体に効く。 */
  maxParallel: number;
  tasks: WorkflowTask[];
  /**
   * `defaults` ブロック自体（`provider` / `isolation` / `cleanup`）の値が未知だった場合の警告。
   * タスク単位の同種の警告は各 `WorkflowTask.parseWarnings` に入る。
   * 手組みの `WorkflowDefinition`（テストなど）ではそもそも `defaults` を経由しないため任意項目にしてある。
   */
  defaultsWarnings?: string[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** オブジェクトのプロトタイプへ書き込める特殊キー名。`rec()` で無条件に無視する。 */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * YAMLの1階層をRecordとして扱う。`yaml@2.9.0` 自体はプロトタイプ汚染を起こさない実装だが、
 * 依存の実装詳細に暗黙に守られている状態にしないため、`__proto__` / `constructor` / `prototype`
 * という名前のキーは、値がどう構築されていても無視して素通しさせない。
 */
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

/** 配列の要素から文字列以外を除いた結果と、除いた要素があったかどうかを返す。 */
interface FilteredStringArray {
  values: string[];
  hadNonStringElements: boolean;
}
const filterStringArray = (raw: unknown[]): FilteredStringArray => {
  const values = raw.filter((x): x is string => typeof x === 'string');
  return { values, hadNonStringElements: values.length !== raw.length };
};

const optStr = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : undefined;
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

/**
 * 数値以外（数値に見える文字列を含む）も受け付ける。`normalizeLoopPlan` と同じ考え方で、
 * ここでは弾かず素通しし、範囲外の値は `validateWorkflow` 側でエラーとして報告する。
 */
const num = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number.parseInt(str(v), 10);
  return Number.isFinite(n) ? n : fallback;
};

function isProvider(v: string): v is Provider {
  return (PROVIDERS as readonly string[]).includes(v);
}
function isIsolation(v: string): v is Isolation {
  return (ISOLATIONS as readonly string[]).includes(v);
}
function isCleanup(v: string): v is CleanupMode {
  return (CLEANUP_MODES as readonly string[]).includes(v);
}

/** 列挙値を解決した結果。`invalidRaw` は非空の文字列が指定されたが既知の値でなかった場合にだけ入る。 */
interface ResolvedEnum<T extends string> {
  value: T;
  invalidRaw: string | undefined;
}

/**
 * `provider` / `isolation` / `cleanup` のような列挙値を解決する。
 * 未指定（空文字）は既定値へ黙って倒し、未知の値（タイプミス等）は既定値へ倒しつつ
 * `invalidRaw` に残す。呼び出し側はこれを見て警告を出す（design.md §16.2）。
 */
function resolveEnum<T extends string>(
  raw: unknown,
  isValid: (v: string) => v is T,
  fallback: T,
): ResolvedEnum<T> {
  const s = str(raw);
  if (s === '') {
    return { value: fallback, invalidRaw: undefined };
  }
  if (isValid(s)) {
    return { value: s, invalidRaw: undefined };
  }
  return { value: fallback, invalidRaw: s };
}

interface ResolvedDefaults {
  provider: Provider;
  isolation: Isolation;
  maxIterations: number;
  autoApprove: boolean;
  cleanup: CleanupMode;
  sandbox: string | undefined;
  model: string | undefined;
  effort: string | undefined;
  approvalMode: string | undefined;
  maxParallel: number;
}

/** `resolveDefaults` の戻り値。`warnings` は `defaults` ブロック自体の値が未知だった場合のメッセージ。 */
interface ResolvedDefaultsResult {
  defaults: ResolvedDefaults;
  warnings: string[];
}

function resolveDefaults(raw: unknown): ResolvedDefaultsResult {
  const d = rec(raw) ?? {};
  const provider = resolveEnum(d['provider'], isProvider, DEFAULT_PROVIDER);
  const isolation = resolveEnum(d['isolation'], isIsolation, DEFAULT_ISOLATION);
  const cleanup = resolveEnum(d['cleanup'], isCleanup, DEFAULT_CLEANUP);

  const warnings: string[] = [];
  if (provider.invalidRaw !== undefined) {
    warnings.push(
      `defaults.provider に未知の値が指定されたため既定値(${DEFAULT_PROVIDER})を使いました: ${provider.invalidRaw}`,
    );
  }
  if (isolation.invalidRaw !== undefined) {
    warnings.push(
      `defaults.isolation に未知の値が指定されたため既定値(${DEFAULT_ISOLATION})を使いました: ${isolation.invalidRaw}`,
    );
  }
  if (cleanup.invalidRaw !== undefined) {
    warnings.push(
      `defaults.cleanup に未知の値が指定されたため既定値(${DEFAULT_CLEANUP})を使いました: ${cleanup.invalidRaw}`,
    );
  }

  return {
    defaults: {
      provider: provider.value,
      isolation: isolation.value,
      maxIterations: num(d['maxIterations'], DEFAULT_MAX_ITERATIONS),
      autoApprove: bool(d['autoApprove'], DEFAULT_AUTO_APPROVE),
      cleanup: cleanup.value,
      sandbox: optStr(d['sandbox']),
      model: optStr(d['model']),
      effort: optStr(d['effort']),
      approvalMode: optStr(d['approvalMode']),
      maxParallel: num(d['maxParallel'], DEFAULT_MAX_PARALLEL),
    },
    warnings,
  };
}

/** 未知のフィールドは読み飛ばす（存在するキーだけを読み、他は無視する）。 */
function resolveTask(raw: unknown, defaults: ResolvedDefaults): WorkflowTask {
  const t = rec(raw) ?? {};
  const continuePromptRaw = str(t['continuePrompt']);
  const parseErrors: string[] = [];
  const parseWarnings: string[] = [];

  const provider = resolveEnum(t['provider'], isProvider, defaults.provider);
  if (provider.invalidRaw !== undefined) {
    parseWarnings.push(
      `provider に未知の値が指定されたため既定値(${provider.value})を使いました: ${provider.invalidRaw}`,
    );
  }
  const isolation = resolveEnum(t['isolation'], isIsolation, defaults.isolation);
  if (isolation.invalidRaw !== undefined) {
    parseWarnings.push(
      `isolation に未知の値が指定されたため既定値(${isolation.value})を使いました: ${isolation.invalidRaw}`,
    );
  }

  // dependsOnは配列であること自体が意味を持つ（直列/並列の分岐点）。
  // `dependsOn: T1`のような書き忘れを黙って`[]`にすると、直列であるべきタスクが並列で走ってしまうため、
  // 「配列でなかった」ことをparseErrorsへ残し、validateWorkflowでエラーにする。
  const dependsOnRaw = t['dependsOn'];
  let dependsOn: string[] = [];
  if (dependsOnRaw !== undefined) {
    if (!Array.isArray(dependsOnRaw)) {
      parseErrors.push('dependsOn は配列で指定してください（例: dependsOn: [T1]）');
    } else {
      const filtered = filterStringArray(dependsOnRaw);
      dependsOn = filtered.values;
      if (filtered.hadNonStringElements) {
        // dependsOnは依存関係＝実行順序を決めるフィールドなので、黙って要素を捨てると
        // 「直列のつもりが並列で走る」というescalateと同種のフェイルオープンになりうる
        parseWarnings.push('dependsOn に文字列でない要素が含まれていたため無視しました');
      }
    }
  }

  const escalateFiltered = filterStringArray(arr(t['escalate']));
  if (escalateFiltered.hadNonStringElements) {
    // escalateは自動承認を止める側（安全性を強める側）のフィールド。黙って要素を捨てると
    // 本来止まるはずの操作が自動承認されてしまうフェイルオープンになるため警告する
    parseWarnings.push('escalate に文字列でない要素が含まれていたため無視しました');
  }

  const allowFiltered = filterStringArray(arr(t['allow']));
  if (allowFiltered.hadNonStringElements) {
    // allowは停止条件を緩める側のフィールド。要素を捨てても「緩めそこなう」だけで安全側に
    // 倒れるが、設定ミスに気づけるよう警告だけは出す（escalateとは無効化の方向が逆）
    parseWarnings.push('allow に文字列でない要素が含まれていたため無視しました');
  }

  return {
    id: str(t['id']),
    prompt: str(t['prompt']),
    done: str(t['done']),
    dependsOn,
    continuePrompt: continuePromptRaw === '' ? DEFAULT_CONTINUE_PROMPT : continuePromptRaw,
    maxIterations: num(t['maxIterations'], defaults.maxIterations),
    provider: provider.value,
    isolation: isolation.value,
    cwd: optStr(t['cwd']),
    model: optStr(t['model']) ?? defaults.model,
    effort: optStr(t['effort']) ?? defaults.effort,
    approvalMode: optStr(t['approvalMode']) ?? defaults.approvalMode,
    sandbox: optStr(t['sandbox']) ?? defaults.sandbox,
    autoApprove: bool(t['autoApprove'], defaults.autoApprove),
    escalate: escalateFiltered.values,
    allow: allowFiltered.values,
    retries: Math.max(0, Math.trunc(num(t['retries'], 0))),
    // cleanupはworktreeの後始末で、taskごとの上書きはスキーマに無い（design.md §16.2）
    cleanup: defaults.cleanup,
    parseErrors,
    parseWarnings,
  };
}

/**
 * YAML文字列を内部表現へ変換する。
 *
 * ここではスキーマの検証はしない（`validateWorkflow` が別関数）。欠落や範囲外の値も
 * そのまま（空文字・既定値・範囲外の数値のまま）保持し、検証側がまとめてエラーにできるようにする。
 * YAML自体の構文が壊れている場合は `yaml` パッケージの `parse` がそのまま例外を投げる。
 */
export function parseWorkflowYaml(source: string): WorkflowDefinition {
  const raw = parse(source);
  const root = rec(raw) ?? {};
  const { defaults, warnings: defaultsWarnings } = resolveDefaults(root['defaults']);
  const tasksRaw = arr(root['tasks']);
  return {
    version: num(root['version'], 1),
    name: str(root['name']),
    maxParallel: defaults.maxParallel,
    tasks: tasksRaw.map((t) => resolveTask(t, defaults)),
    defaultsWarnings,
  };
}

export interface WorkflowIssue {
  /** 関係するタスクid。ワークフロー全体に関わるもの（タスク総数超過など）は空配列。 */
  taskIds: string[];
  message: string;
}

export type WorkflowError = WorkflowIssue;
export type WorkflowWarning = WorkflowIssue;

export interface WorkflowValidationResult {
  errors: WorkflowError[];
  warnings: WorkflowWarning[];
}

const TEMPLATE_FIELDS = ['result', 'cwd', 'branch', 'files'] as const;
export type TemplateField = (typeof TEMPLATE_FIELDS)[number];

function isTemplateField(v: string): v is TemplateField {
  return (TEMPLATE_FIELDS as readonly string[]).includes(v);
}

/** `{{<id>.<field>}}` のみを対象にする。idの字種は `TASK_ID_PATTERN` と揃えてある。 */
function templatePattern(): RegExp {
  return /\{\{([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\}\}/g;
}

interface TemplateRef {
  id: string;
  field: string;
}

function extractTemplateRefs(text: string): TemplateRef[] {
  const refs: TemplateRef[] = [];
  for (const m of text.matchAll(templatePattern())) {
    const id = m[1];
    const field = m[2];
    if (id !== undefined && field !== undefined) {
      refs.push({ id, field });
    }
  }
  return refs;
}

/**
 * 依存関係を1件の循環ずつ、強連結成分（SCC）単位で返す。
 * `A<->B` と `C<->D` のように無関係な循環が複数あれば、別々のグループとして返す
 * （呼び出し側はグループごとに1件のエラーを作る）。循環の下流で待っているだけの
 * タスク（例: `T3 dependsOn: [T2]` で `T1<->T2` が循環しているときのT3）は含めない。
 *
 * Tarjanの強連結成分アルゴリズム。要素数2以上のSCC、または自己参照
 * （`T1` が `dependsOn: [T1]`）を1件のグループとして採用する。
 */
function findCycleGroups(tasks: readonly WorkflowTask[]): string[][] {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  let counter = 0;
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const groups: string[][] = [];

  function strongConnect(id: string): void {
    index.set(id, counter);
    lowlink.set(id, counter);
    counter += 1;
    stack.push(id);
    onStack.add(id);

    const current = byId.get(id);
    for (const dep of current?.dependsOn ?? []) {
      if (!byId.has(dep)) {
        continue; // 未定義参照は別のチェックで報告済み。循環判定の対象にはしない
      }
      if (!index.has(dep)) {
        strongConnect(dep);
        lowlink.set(id, Math.min(lowlink.get(id) as number, lowlink.get(dep) as number));
      } else if (onStack.has(dep)) {
        lowlink.set(id, Math.min(lowlink.get(id) as number, index.get(dep) as number));
      }
    }

    if (lowlink.get(id) === index.get(id)) {
      const group: string[] = [];
      let member: string;
      do {
        member = stack.pop() as string;
        onStack.delete(member);
        group.push(member);
      } while (member !== id);

      const isSelfLoop = group.length === 1 && (byId.get(id)?.dependsOn ?? []).includes(id);
      if (group.length > 1 || isSelfLoop) {
        groups.push(group);
      }
    }
  }

  for (const id of byId.keys()) {
    if (!index.has(id)) {
      strongConnect(id);
    }
  }
  return groups;
}

/**
 * idの祖先（依存を辿って先に完了していなければならないタスク）を全て集める。
 * 循環があっても無限再帰しないよう、辿る前にmemoへ空集合を仮置きしてから埋める。
 */
function ancestorsOf(
  id: string,
  byId: ReadonlyMap<string, WorkflowTask>,
  memo: Map<string, Set<string>>,
): Set<string> {
  const cached = memo.get(id);
  if (cached !== undefined) {
    return cached;
  }
  const result = new Set<string>();
  memo.set(id, result);
  const task = byId.get(id);
  for (const dep of task?.dependsOn ?? []) {
    if (!byId.has(dep) || result.has(dep)) {
      continue;
    }
    result.add(dep);
    for (const a of ancestorsOf(dep, byId, memo)) {
      result.add(a);
    }
  }
  return result;
}

/**
 * `isolation: shared` のタスク同士が、依存関係の上で同時に走りうる組を警告として返す。
 * どちらの祖先にも相手が含まれていなければ、実行順序が確定していない＝並列で走りうる。
 * `cwd` を明示したタスクは対象から外す（design.md §16.2）。
 */
function findSharedIsolationWarnings(tasks: readonly WorkflowTask[]): WorkflowWarning[] {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const memo = new Map<string, Set<string>>();
  const candidates = tasks.filter((t) => t.isolation === 'shared' && t.cwd === undefined);
  const warnings: WorkflowWarning[] = [];

  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const a = candidates[i];
      const b = candidates[j];
      if (a === undefined || b === undefined) {
        continue;
      }
      const ancestorsOfA = ancestorsOf(a.id, byId, memo);
      const ancestorsOfB = ancestorsOf(b.id, byId, memo);
      if (!ancestorsOfA.has(b.id) && !ancestorsOfB.has(a.id)) {
        warnings.push({
          taskIds: [a.id, b.id],
          message: `isolation: shared のタスクが依存関係の上で同時に走りうります（${a.id} と ${b.id}）。ファイル衝突を避けたい場合はcwdを明示するか依存を追加してください`,
        });
      }
    }
  }
  return warnings;
}

/**
 * 読み込み時の検証（design.md §16.2「検証」）。1件でも該当すれば実行を始めない前提で、
 * エラーは1件見つかった時点で止めず全件まとめて返す。
 *
 * `cwd` のワークスペース境界検証は、ファイルシステムに触れるためこのIssueの範囲外。
 * `WorkflowTask.cwd` のコメントの通り、拡張の余地は残してある。
 */
export function validateWorkflow(def: WorkflowDefinition): WorkflowValidationResult {
  const errors: WorkflowError[] = [];
  const warnings: WorkflowWarning[] = [];
  const tasks = def.tasks;

  if (!Array.isArray(tasks) || tasks.length === 0) {
    errors.push({
      taskIds: [],
      message: 'tasks が1件も定義されていません（配列でない場合を含む）',
    });
  }

  if (tasks.length > MAX_TASK_COUNT) {
    errors.push({
      taskIds: [],
      message: `タスクの総数が上限(${MAX_TASK_COUNT})を超えています: ${tasks.length}`,
    });
  }

  if (
    !Number.isInteger(def.maxParallel) ||
    def.maxParallel < MAX_PARALLEL_MIN ||
    def.maxParallel > MAX_PARALLEL_MAX
  ) {
    errors.push({
      taskIds: [],
      message: `maxParallel は${MAX_PARALLEL_MIN}〜${MAX_PARALLEL_MAX}の範囲で指定してください: ${def.maxParallel}`,
    });
  }

  for (const message of def.defaultsWarnings ?? []) {
    warnings.push({ taskIds: [], message });
  }

  const idCounts = new Map<string, number>();
  for (const t of tasks) {
    idCounts.set(t.id, (idCounts.get(t.id) ?? 0) + 1);
    if (!TASK_ID_PATTERN.test(t.id)) {
      errors.push({
        taskIds: [t.id],
        message: `id の形式が不正です（半角英数字・_・-のみ、1〜50文字にしてください）: "${t.id}"`,
      });
    }
    if (WINDOWS_RESERVED_NAME_PATTERN.test(t.id)) {
      errors.push({
        taskIds: [t.id],
        message: `id にWindowsの予約デバイス名は使えません（worktreeのディレクトリ名になるため）: ${t.id}`,
      });
    }
    if (RETRY_SUFFIX_PATTERN.test(t.id)) {
      errors.push({
        taskIds: [t.id],
        message: `id を"-retry<数字>"で終わらせることはできません（再試行時のブランチ名と衝突します）: ${t.id}`,
      });
    }
    if (t.id === RESERVED_INTEGRATION_TASK_ID) {
      errors.push({
        taskIds: [t.id],
        message: `id "${RESERVED_INTEGRATION_TASK_ID}" は統合worktree用に予約されているため使えません`,
      });
    }
  }
  for (const [id, count] of idCounts) {
    if (count > 1) {
      errors.push({ taskIds: [id], message: `id が重複しています: ${id}` });
    }
  }

  // 大文字小文字だけが違うidはworktreeのパスとブランチ名の上では区別できない
  // （大小文字を区別しないファイルシステムでは同じ場所を指す）ため、正規化したキーでも見る。
  const idsByLowerCase = new Map<string, Set<string>>();
  for (const t of tasks) {
    const key = t.id.toLowerCase();
    const variants = idsByLowerCase.get(key) ?? new Set<string>();
    variants.add(t.id);
    idsByLowerCase.set(key, variants);
  }
  for (const variants of idsByLowerCase.values()) {
    if (variants.size > 1) {
      const ids = [...variants];
      errors.push({
        taskIds: ids,
        message: `id が大文字小文字だけ違う形で重複しています: ${ids.join(', ')}`,
      });
    }
  }

  const idSet = new Set(tasks.map((t) => t.id));

  for (const t of tasks) {
    if (t.done.trim() === '') {
      errors.push({ taskIds: [t.id], message: 'done が指定されていません' });
    }
    if (t.prompt.trim() === '') {
      errors.push({ taskIds: [t.id], message: 'prompt が指定されていません' });
    }
    for (const [field, value] of [
      ['prompt', t.prompt],
      ['done', t.done],
      ['continuePrompt', t.continuePrompt],
    ] as const) {
      if (value.length > MAX_PROMPT_LENGTH) {
        errors.push({
          taskIds: [t.id],
          message: `${field} が長すぎます（上限${MAX_PROMPT_LENGTH}文字）: ${value.length}文字`,
        });
      }
    }
    if (t.retries > MAX_RETRIES) {
      errors.push({
        taskIds: [t.id],
        message: `retries は${MAX_RETRIES}以下にしてください: ${t.retries}`,
      });
    }
    if (t.maxIterations < 1 || t.maxIterations > LOOP_ITERATION_LIMIT) {
      errors.push({
        taskIds: [t.id],
        message: `maxIterations は1〜${LOOP_ITERATION_LIMIT}の範囲で指定してください: ${t.maxIterations}`,
      });
    }
    // 注意: ここで見ているのはYAMLに書かれたリテラルの値だけ。approvalModeを
    // 一切指定しない（undefined）タスクはこのチェックを素通りする。拡張機能側の設定
    // （baseline）が既にbypassPermissionsなら、実効値（クランプ後の値）はそれを継承して
    // bypassPermissionsになりうるが、baselineはこの純粋関数からは見えないため
    // ここでは判定できない（レビュー指摘: critical 3）。**実効値に対する最終防御は
    // `runner.ts`の`startTask`が担う**。このチェックは「YAMLで明示的に指定した」
    // 分かりやすいミスを早期に拾うだけの、追加の一枚に過ぎない
    if (t.provider === 'claude' && t.approvalMode === 'bypassPermissions') {
      errors.push({
        taskIds: [t.id],
        message: 'Claudeタスクの approvalMode に bypassPermissions は指定できません',
      });
    }
    for (const dep of t.dependsOn) {
      if (!idSet.has(dep)) {
        errors.push({
          taskIds: [t.id],
          message: `dependsOn が未定義のタスクを参照しています: ${dep}`,
        });
      }
    }
    for (const message of t.parseErrors) {
      errors.push({ taskIds: [t.id], message });
    }
    for (const message of t.parseWarnings) {
      warnings.push({ taskIds: [t.id], message });
    }
  }

  for (const group of findCycleGroups(tasks)) {
    errors.push({
      taskIds: group,
      message: `依存が循環しています: ${group.join(', ')}`,
    });
  }

  for (const t of tasks) {
    for (const text of [t.prompt, t.continuePrompt]) {
      for (const ref of extractTemplateRefs(text)) {
        if (!idSet.has(ref.id)) {
          errors.push({
            taskIds: [t.id],
            message: `テンプレート変数が未定義のタスクを参照しています: {{${ref.id}.${ref.field}}}`,
          });
          continue;
        }
        if (!t.dependsOn.includes(ref.id)) {
          errors.push({
            taskIds: [t.id],
            message: `テンプレート変数が dependsOn に挙げていないタスクを参照しています: {{${ref.id}.${ref.field}}}`,
          });
          continue;
        }
        if (!isTemplateField(ref.field)) {
          errors.push({
            taskIds: [t.id],
            message: `未知のテンプレート変数フィールドです: {{${ref.id}.${ref.field}}}`,
          });
        }
      }
    }
  }

  warnings.push(...findSharedIsolationWarnings(tasks));

  return { errors, warnings };
}

/** `expandTemplate` の入力。完了済みタスクの結果の対応表を組み立てるために使う。 */
export interface TaskResult {
  /** そのタスクの最後のターンの応答テキスト（`ChatState.turnResultText`）。 */
  result: string;
  /** タスクが走ったディレクトリの絶対パス。 */
  cwd: string;
  /** worktreeのブランチ名。`shared` のときは実行時の現在のブランチ。 */
  branch: string;
  /** そのタスクが編集したファイルパスの一覧。改行区切りで展開する。 */
  files: string[];
}

/**
 * `{{<id>.<field>}}` を展開する。
 *
 * 読み込み時（`parseWorkflowYaml` / `validateWorkflow`）ではなく、タスクの開始直前に
 * 呼ぶ（design.md §16.4）。読み込み時にできるのは変数名の検証だけで、値はその時点で
 * まだ存在しないため。値が無い（対応表に該当タスクが無い、または該当フィールドが
 * 未知）場合は空文字を差し込む。テンプレート構文に一致しない部分は一切変更しない。
 */
export function expandTemplate(text: string, results: ReadonlyMap<string, TaskResult>): string {
  return text.replace(templatePattern(), (whole, id: string, field: string) => {
    if (!isTemplateField(field)) {
      return '';
    }
    const result = results.get(id);
    if (result === undefined) {
      return '';
    }
    return field === 'files' ? result.files.join('\n') : result[field];
  });
}

/**
 * 終了条件（`task.done`）へ「変更をコミットしてあること」を自動で足す
 * （design.md §16.17「タスク完了時のコミット」1.）。マージには成果がコミットされている
 * 必要があるが、`done`の宣言はコミットの有無を問わないため、エージェントが未コミットの
 * まま終了を宣言することがある。人が書いた`done`はそのまま残し、末尾に連結するだけ
 * （`decoratePrompt`（`loopController.ts`）が`condition`を指示文へ埋め込むのと同じ経路。
 * 呼び出し側 `runner.ts` はこの結果を`LoopPlan.condition`として渡す）。
 *
 * これは「エージェントに伝える終了条件の文面」を広げるだけの合図に過ぎず、実際に
 * コミットされている保証にはならない。取りこぼしは`commitUncommittedChangesIfNeeded`
 * （`integration.ts`）が拾う。
 *
 * `isolation: worktree` でタスク専用のブランチを使うタスクにのみ意味を持つ
 * （`shared` / 明示`cwd`のタスクは統合ブランチへマージする対象を持たないため、
 * 呼び出し側はそもそもこの関数を呼ばない）。
 */
export function withCommitRequirement(done: string): string {
  return `${done}、かつすべての変更をコミットしてあること`;
}

/** クランプ関数の結果。`warning` は緩める指定を無視したときだけ入る。 */
export interface ClampResult {
  value: string;
  warning: string | undefined;
}

/**
 * `sandbox` の安全順序。左ほど安全（読み取り専用）、右ほど危険（無制限）。
 * `src/codex/types.ts` の `SANDBOX_MODES` は宣言順がそのまま安全順序になっているため、
 * 値をそのまま再利用する（値と順序を別々に持つと将来どちらかだけ変更されて乖離しうる）。
 */
export const SANDBOX_SAFETY_ORDER: readonly string[] = SANDBOX_MODES;

/**
 * Codexの `approvalMode` の安全順序。左ほど安全（毎回確認を挟む）、右ほど危険（無確認）。
 * `src/codex/types.ts` の `APPROVAL_MODES` は宣言順がそのまま安全順序になっているため、
 * 値をそのまま再利用する。
 */
export const CODEX_APPROVAL_SAFETY_ORDER: readonly string[] = APPROVAL_MODES;

/**
 * Claudeの `permissionMode` の安全順序。`src/claude/types.ts` の `CLAUDE_PERMISSION_MODES`
 * は語彙の列挙順であって安全順ではないため、ここで独自に定義する。
 *
 * 出典: Claude Code公式ドキュメント「Permission modes」の「Available modes」表
 * （https://code.claude.com/docs/en/permission-modes.md、確認日2026-08-10）。要点は次のとおり。
 *
 * | Mode（表内の呼称）                              | What runs without asking                                              |
 * | ------------------------------------------------ | ----------------------------------------------------------------------- |
 * | `default`（CLIの表示名はManual。`manual`はそのalias） | Reads only                                                          |
 * | `acceptEdits`                                     | Reads, file edits, and common filesystem commands（`mkdir` `touch` `mv` `cp` 等） |
 * | `plan`                                            | Reads, plus classifier-approved commands when auto mode is available   |
 * | `auto`                                            | Everything, with background safety checks                              |
 * | `dontAsk`                                         | Only pre-approved tools                                                |
 * | `bypassPermissions`                               | Everything                                                              |
 *
 * 同ページには「Writes to protected paths are never auto-approved except in
 * `bypassPermissions` mode and in planning sessions with bypass permissions available.」
 * ともある。
 *
 * **`dontAsk` はこの順序表に含めていない。** 「事前承認したツールだけ通す」という性質は、
 * 利用者が設定した `permissions.allow` の中身次第で安全にも危険にもなり、他のモードと
 * 一次元の安全順序では比較できない。仮に無理な位置（例えば `acceptEdits` と `auto` の間）へ
 * 割り当てると、拡張機能側が `dontAsk` を使っているときにYAML側の値を実際より「安全」と
 * 誤判定して通してしまう恐れがある。`clampToSafer` は順序表に無い値を「安全性を判定できない」
 * として拡張機能側の値をそのまま採用する（design.md §16.16）ため、`dontAsk` を順序表から
 * 除外しておくことでfail-closedになる。
 */
export const CLAUDE_PERMISSION_SAFETY_ORDER: readonly string[] = [
  'plan',
  'manual',
  'acceptEdits',
  'auto',
  'bypassPermissions',
];

/**
 * 拡張機能側の値より安全な方向にしか動かせないようにする（design.md §16.16）。
 *
 * 安全順序の中に無い値（拡張機能・YAMLのいずれか）は判定のしようがないため、
 * 緩められる側に倒さず拡張機能側の値を採用する。YAML側が空文字（未指定）なら
 * そのまま拡張機能側を使う。
 */
export function clampToSafer(
  order: readonly string[],
  extensionValue: string,
  yamlValue: string,
): ClampResult {
  if (yamlValue === '') {
    return { value: extensionValue, warning: undefined };
  }
  const extIndex = order.indexOf(extensionValue);
  const yamlIndex = order.indexOf(yamlValue);
  if (extIndex === -1 || yamlIndex === -1) {
    return {
      value: extensionValue,
      warning: `安全性を判定できない値のため無視しました: ${yamlValue}`,
    };
  }
  if (yamlIndex <= extIndex) {
    return { value: yamlValue, warning: undefined };
  }
  return {
    value: extensionValue,
    warning: `拡張機能の設定より緩い指定は無視しました: ${yamlValue} → ${extensionValue}`,
  };
}

export function clampSandbox(extensionValue: string, yamlValue: string): ClampResult {
  return clampToSafer(SANDBOX_SAFETY_ORDER, extensionValue, yamlValue);
}

export function clampCodexApprovalMode(extensionValue: string, yamlValue: string): ClampResult {
  return clampToSafer(CODEX_APPROVAL_SAFETY_ORDER, extensionValue, yamlValue);
}

export function clampClaudePermissionMode(extensionValue: string, yamlValue: string): ClampResult {
  return clampToSafer(CLAUDE_PERMISSION_SAFETY_ORDER, extensionValue, yamlValue);
}

export interface AutoApproveClampResult {
  value: boolean;
  warning: string | undefined;
}

/**
 * `autoApprove: true` は、machineスコープの設定 `agent.workflows.allowAutoApprove`
 * が有効なときだけ通す（design.md §16.16）。無効なら常に人へ回す方向（false）へ倒す。
 */
export function clampAutoApprove(
  yamlValue: boolean,
  allowAutoApprove: boolean,
): AutoApproveClampResult {
  if (yamlValue && !allowAutoApprove) {
    return {
      value: false,
      warning:
        'autoApprove: true が指定されていますが、agent.workflows.allowAutoApprove が無効なため無視しました',
    };
  }
  return { value: yamlValue, warning: undefined };
}
