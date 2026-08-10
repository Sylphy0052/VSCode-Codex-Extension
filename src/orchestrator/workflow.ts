import { parse } from 'yaml';

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

export const CLEANUP_MODES = ['keep', 'remove'] as const;
export type CleanupMode = (typeof CLEANUP_MODES)[number];

/**
 * タスクidの字種。そのままworktreeのパスとブランチ名に入るため絞る。
 * `codex/argvBuilder.ts` がセッションidをUUIDで検証しているのと同じ理由（design.md §16.2）。
 *
 * design.mdの正規表現は `^[A-Za-z0-9_-]{1,50}$` だが、先頭のハイフンだけは別途弾く。
 * `-x` のようなidをそのまま `git` などのCLI引数へ渡すと、値ではなくオプションフラグとして
 * 解釈されうる（design.mdが変更理由に挙げている「gitの引数解釈」問題そのもの）。
 */
export const TASK_ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,49}$/;

export const MAX_PARALLEL_MIN = 1;
export const MAX_PARALLEL_MAX = 10;
export const MAX_TASK_COUNT = 50;

/** `defaults` 省略時に使う組み込みの既定値。design.md §16.2のサンプルおよび§16.13の記述に合わせる。 */
export const DEFAULT_MAX_PARALLEL = 3;
export const DEFAULT_MAX_ITERATIONS = 20;
export const DEFAULT_CONTINUE_PROMPT = '続けてください';
export const DEFAULT_PROVIDER: Provider = 'codex';
export const DEFAULT_ISOLATION: Isolation = 'worktree';
export const DEFAULT_CLEANUP: CleanupMode = 'keep';
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
}

/** ワークフロー定義ファイル全体の内部表現。 */
export interface WorkflowDefinition {
  version: number;
  name: string;
  /** `defaults.maxParallel` を解決した値。タスク単位ではなくワークフロー全体に効く。 */
  maxParallel: number;
  tasks: WorkflowTask[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const rec = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strArr = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === 'string');
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

function resolveDefaults(raw: unknown): ResolvedDefaults {
  const d = rec(raw) ?? {};
  const providerRaw = str(d['provider']);
  const isolationRaw = str(d['isolation']);
  const cleanupRaw = str(d['cleanup']);
  return {
    provider: isProvider(providerRaw) ? providerRaw : DEFAULT_PROVIDER,
    isolation: isIsolation(isolationRaw) ? isolationRaw : DEFAULT_ISOLATION,
    maxIterations: num(d['maxIterations'], DEFAULT_MAX_ITERATIONS),
    autoApprove: bool(d['autoApprove'], DEFAULT_AUTO_APPROVE),
    cleanup: isCleanup(cleanupRaw) ? cleanupRaw : DEFAULT_CLEANUP,
    sandbox: optStr(d['sandbox']),
    model: optStr(d['model']),
    effort: optStr(d['effort']),
    approvalMode: optStr(d['approvalMode']),
    maxParallel: num(d['maxParallel'], DEFAULT_MAX_PARALLEL),
  };
}

/** 未知のフィールドは読み飛ばす（存在するキーだけを読み、他は無視する）。 */
function resolveTask(raw: unknown, defaults: ResolvedDefaults): WorkflowTask {
  const t = rec(raw) ?? {};
  const providerRaw = str(t['provider']);
  const isolationRaw = str(t['isolation']);
  const continuePromptRaw = str(t['continuePrompt']);

  return {
    id: str(t['id']),
    prompt: str(t['prompt']),
    done: str(t['done']),
    dependsOn: strArr(t['dependsOn']),
    continuePrompt: continuePromptRaw === '' ? DEFAULT_CONTINUE_PROMPT : continuePromptRaw,
    maxIterations: num(t['maxIterations'], defaults.maxIterations),
    provider: isProvider(providerRaw) ? providerRaw : defaults.provider,
    isolation: isIsolation(isolationRaw) ? isolationRaw : defaults.isolation,
    cwd: optStr(t['cwd']),
    model: optStr(t['model']) ?? defaults.model,
    effort: optStr(t['effort']) ?? defaults.effort,
    approvalMode: optStr(t['approvalMode']) ?? defaults.approvalMode,
    sandbox: optStr(t['sandbox']) ?? defaults.sandbox,
    autoApprove: bool(t['autoApprove'], defaults.autoApprove),
    escalate: strArr(t['escalate']),
    allow: strArr(t['allow']),
    retries: Math.max(0, Math.trunc(num(t['retries'], 0))),
    // cleanupはworktreeの後始末で、taskごとの上書きはスキーマに無い（design.md §16.2）
    cleanup: defaults.cleanup,
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
  const defaults = resolveDefaults(root['defaults']);
  const tasksRaw = arr(root['tasks']);
  return {
    version: num(root['version'], 1),
    name: str(root['name']),
    maxParallel: defaults.maxParallel,
    tasks: tasksRaw.map((t) => resolveTask(t, defaults)),
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
 * 循環に含まれるidだけを返す（循環の下流で待っているだけのタスクは含めない）。
 *
 * 白黒灰の3色DFSで、探索スタック上にある頂点へ戻るエッジを見つけたら、
 * スタックのその頂点から現在位置までを丸ごと循環に含める。
 */
function findCycleIds(tasks: readonly WorkflowTask[]): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const color = new Map<string, 1 | 2>(); // 1=探索中(灰), 2=確定(黒)。無ければ白
  const inCycle = new Set<string>();
  const stack: string[] = [];

  function visit(id: string): void {
    color.set(id, 1);
    stack.push(id);
    const current = byId.get(id);
    for (const dep of current?.dependsOn ?? []) {
      if (!byId.has(dep)) {
        continue; // 未定義参照は別のチェックで報告済み。循環判定の対象にはしない
      }
      const depColor = color.get(dep);
      if (depColor === undefined) {
        visit(dep);
      } else if (depColor === 1) {
        const idx = stack.indexOf(dep);
        for (const s of stack.slice(idx)) {
          inCycle.add(s);
        }
      }
    }
    stack.pop();
    color.set(id, 2);
  }

  for (const id of byId.keys()) {
    if (color.get(id) === undefined) {
      visit(id);
    }
  }
  return [...inCycle];
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
 * `cwd` のワークスペース境界検証とClaudeの承認無効化検証（`approvalMode` が
 * `bypassPermissions` 相当）は、ファイルシステムや拡張機能設定に触れるため
 * このIssueの範囲外。`WorkflowTask.cwd` のコメントの通り、拡張の余地は残してある。
 */
export function validateWorkflow(def: WorkflowDefinition): WorkflowValidationResult {
  const errors: WorkflowError[] = [];
  const warnings: WorkflowWarning[] = [];
  const tasks = def.tasks;

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

  const idCounts = new Map<string, number>();
  for (const t of tasks) {
    idCounts.set(t.id, (idCounts.get(t.id) ?? 0) + 1);
    if (!TASK_ID_PATTERN.test(t.id)) {
      errors.push({
        taskIds: [t.id],
        message: `id の形式が不正です（半角英数字・_・-のみ、1〜50文字にしてください）: "${t.id}"`,
      });
    }
  }
  for (const [id, count] of idCounts) {
    if (count > 1) {
      errors.push({ taskIds: [id], message: `id が重複しています: ${id}` });
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
    for (const dep of t.dependsOn) {
      if (!idSet.has(dep)) {
        errors.push({
          taskIds: [t.id],
          message: `dependsOn が未定義のタスクを参照しています: ${dep}`,
        });
      }
    }
  }

  const cycleIds = findCycleIds(tasks);
  if (cycleIds.length > 0) {
    errors.push({
      taskIds: cycleIds,
      message: `依存が循環しています: ${cycleIds.join(', ')}`,
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

/** クランプ関数の結果。`warning` は緩める指定を無視したときだけ入る。 */
export interface ClampResult {
  value: string;
  warning: string | undefined;
}

/**
 * `sandbox` の安全順序。左ほど安全（読み取り専用）、右ほど危険（無制限）。
 * `src/codex/types.ts` の `SANDBOX_MODES` の宣言順そのままが安全順序と一致している。
 */
export const SANDBOX_SAFETY_ORDER: readonly string[] = [
  'read-only',
  'workspace-write',
  'danger-full-access',
];

/**
 * Codexの `approvalMode` の安全順序。左ほど安全（毎回確認を挟む）、右ほど危険（無確認）。
 * `src/codex/types.ts` の `APPROVAL_MODES` の宣言順そのままが安全順序と一致している。
 */
export const CODEX_APPROVAL_SAFETY_ORDER: readonly string[] = ['untrusted', 'on-request', 'never'];

/**
 * Claudeの `permissionMode` の安全順序。`src/claude/types.ts` の `CLAUDE_PERMISSION_MODES`
 * は語彙の列挙順であって安全順ではないため、ここで独自に定義する。
 *
 * 根拠（Claude Code公式ドキュメント「Choose a permission mode」の記述に基づく）:
 * - `plan`: 読み取りのみで編集そのものができない。最も安全
 * - `manual`: 全ての操作を都度確認する既定モード
 * - `acceptEdits`: 編集と基本的なファイル操作だけ自動承認し、それ以外は確認する
 * - `dontAsk`: 人には一切確認しないが、事前に許可した操作以外は自動で拒否する
 *   （CI向け。保護パスへの書き込みも常に拒否される）
 * - `auto`: 分類器の判定だけで広く自動承認する（保護パスも分類器任せになる）
 * - `bypassPermissions`: 検査そのものを無効化する。最も危険
 */
export const CLAUDE_PERMISSION_SAFETY_ORDER: readonly string[] = [
  'plan',
  'manual',
  'acceptEdits',
  'dontAsk',
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
