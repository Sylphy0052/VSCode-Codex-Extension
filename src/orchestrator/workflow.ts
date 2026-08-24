import { randomUUID } from 'node:crypto';

import { isMap, isScalar, isSeq, parse, parseDocument } from 'yaml';

import { LOOP_ITERATION_LIMIT } from '../loop/loopController';
import {
  CLAUDE_PERMISSION_SAFETY_ORDER,
  CODEX_APPROVAL_SAFETY_ORDER,
  SANDBOX_SAFETY_ORDER,
} from '../util/safetyClamp';
import { isTeamRole, roleDefaults, TEAM_ROLES, type TeamRole } from './rolePresets';
import { formatUntrusted, truncateByCodePoint } from './untrustedText';

/**
 * ワークフロー定義のYAMLスキーマ・検証・テンプレート展開（design.md §16.2 / §16.4 / §16.16）。
 *
 * VSCode APIには一切依存しない純粋なロジックのみを置く。ファイルの探索・実行・
 * worktree操作・承認判定は後続Issue（runner.ts / scheduler.ts / worktree.ts /
 * escalation.ts）に委ねる。
 *
 * 唯一の例外は `expandTemplate` の区切り用乱数（`nonce`）で、`node:crypto` の
 * `randomUUID` を既定値として使う（セキュリティ監査指摘#3。呼び出し側が明示的に
 * 渡せば純粋関数として振る舞う。詳細は `expandTemplate` のコメント参照）。
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
 * Conventional Commitsのtype語彙（GitLab運用規約の短形に合わせる）。拡張機能が
 * 自動生成するコミットメッセージ（`integration.ts`の`uncommittedChangesCommitMessage` /
 * `mergeCommitMessage`）のtypeと、`branchNaming: conventional`（`worktree.ts`の
 * `branchName`）のブランチ名の先頭セグメントの両方がこの語彙を共有する。
 */
export const COMMIT_TYPES = [
  'feat',
  'fix',
  'refactor',
  'docs',
  'test',
  'chore',
  'perf',
  'ci',
] as const;
export type CommitType = (typeof COMMIT_TYPES)[number];
/** `type` 未指定・未知の値のときの既定値。安全側（最も無難な種別）に倒す。 */
export const DEFAULT_COMMIT_TYPE: CommitType = 'chore';

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

/**
 * オーケストレーター自身が書いた受け渡しファイル（design.md §16.44、Issue #693）の
 * 置き場を表す予約id。
 *
 * `ORCHESTRATOR_CONNECTION_ID`（`orchestratorSession.ts` の `'-orchestrator-'`）は
 * **`TASK_ID_PATTERN` にわざと合致しない値**にしてあり（タスク側からその識別子を名乗れない
 * ようにするため）、そのままではファイル名の一部にできない。`messaging.ts` が
 * `write_handoff` の呼び出し元がオーケストレーターだったときにこの値へ読み替える。
 *
 * 読み替え先を `_integration` と同じく予約するのは、同名のタスクを定義できてしまうと
 * オーケストレーターとそのタスクが同じファイル名空間を共有し、片方がもう片方のファイルを
 * 上書き・削除できてしまうため。
 */
export const RESERVED_ORCHESTRATOR_TASK_ID = '_orchestrator';

export const MAX_PARALLEL_MIN = 1;
export const MAX_PARALLEL_MAX = 10;
export const MAX_TASK_COUNT = 50;
/** 再試行のたびに新しいworktreeとCLIプロセスが増えるため、際限なく許さない。 */
export const MAX_RETRIES = 10;
/** 巨大な文字列を拡張機能ホストへ渡してハングさせないための上限（`prompt` / `done` / `continuePrompt` 共通）。 */
export const MAX_PROMPT_LENGTH = 20000;

/**
 * 巨大なYAMLで拡張機能ホスト（シングルスレッド）を固まらせないための上限。
 * `MAX_PROMPT_LENGTH`（20000文字）× `MAX_TASK_COUNT`（50）を大きく超える値を
 * 目安にした余裕のある上限で、通常のワークフロー定義には十分すぎる。
 *
 * `runner.ts`（ファイルから読む定義）と `planner.ts`（LLMの応答をパースする前）の
 * 両方から参照される。定義ファイルの読み込み・検証を担う`workflow.ts`が本来の
 * 置き場であり、`runner.ts`はVSCode層、`planner.ts`は純粋ロジック層のため、
 * どちらもこの純粋ロジック層から読む形にして依存の向きを揃える（design.md §16.10 / §16.14）。
 */
export const MAX_WORKFLOW_FILE_BYTES = 1 * 1024 * 1024;

/**
 * `{{T1.result}}` / `{{T1.summary}}` / `{{T1.files}}` の展開結果に設ける長さ上限
 * （design.md §16.4 案4「絞る」、Issue #67）。上流タスクの応答をそのまま次のタスクへ渡す
 * 経路なので、上限が無いと下流のコンテキストを圧迫するだけでなく、応答に仕込まれた
 * 指示文もそのまま増幅されて渡る。
 *
 * `files`はモデル自身が`tool_use`引数として生成した文字列（`runner.ts`の
 * `state.turnEditedFiles`、`streamJson.ts`の`str(input['file_path'])`）であり、
 * ファイルシステム上の実在検証も通っていない。拡張機能が組み立てた構造化データでは
 * ないため、`result` / `summary`と同じ扱いにする（design.md §16.24、Issue #369。
 * 以前はここに含めていなかったが、それ自体が誤りだった）。`cwd` / `branch` は
 * 拡張機能自身が組み立てた値なので引き続き対象外。
 */
export const MAX_TEMPLATE_RESULT_LENGTH = 4000;

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
  /**
   * チームモードの役割（design.md §16.44、Issue #693）。`undefined` は「役割なし」で、
   * 従来どおりの振る舞い（`model` / `effort` は `defaults` と拡張機能の設定に従う）になる。
   *
   * **役割はタスクidではない。** 同じ役割を複数のタスクへ割り当ててよく（実装を2人に
   * 分ける等）、そのときも `id` は従来どおりタスクごとに一意である必要がある。
   *
   * 役割が決めるのは `model` / `effort` の**既定値だけ**で、権限（`approvalMode` /
   * `sandbox` / `autoApprove`）には一切関与しない（`rolePresets.ts` のJSDoc参照）。
   */
  role: TeamRole | undefined;
  prompt: string;
  done: string;
  dependsOn: string[];
  continuePrompt: string;
  maxIterations: number;
  provider: Provider;
  isolation: Isolation;
  /**
   * Conventional Commitsのtype。拡張機能が自動生成するコミットメッセージのtypeと、
   * `branchNaming: conventional` のときのブランチ名の先頭セグメントに使う。
   * 未指定なら `chore`。
   */
  type: CommitType;
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
  /**
   * 対応するIssue番号。指定されていればPR/MRの本文へ `Closes #<N>` として出す
   * （design.md §16.2・§16.18・§16.19）。`undefined` は「未指定」。
   */
  issue: number | undefined;
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
  /**
   * 生成元のロードマップ（design.md §16.19「ロードマップの更新」、Issue #173）。ワークスペース
   * ルートからの相対パス。ロードマップの1フェーズから生成した定義にだけ入り、ゴール文から
   * 直接生成した定義には入らない。runが終わったとき、`done` になったタスクに対応する項目の
   * チェックをここが指すファイルへ書き戻す。
   *
   * 値は**ワークスペースの中の `.md` を指す相対パス**に限る（`validateWorkflow` が確かめる）。
   * ワークフロー定義はエージェントが生成しうるファイルなので、書き戻し先を任意のパスへ
   * 向けられないようにする（§8の引数インジェクション対策と同じ動機）。
   */
  roadmap?: string;
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

export function isProvider(v: string): v is Provider {
  return (PROVIDERS as readonly string[]).includes(v);
}
function isIsolation(v: string): v is Isolation {
  return (ISOLATIONS as readonly string[]).includes(v);
}
function isCleanup(v: string): v is CleanupMode {
  return (CLEANUP_MODES as readonly string[]).includes(v);
}
function isCommitType(v: string): v is CommitType {
  return (COMMIT_TYPES as readonly string[]).includes(v);
}

/**
 * 未知の値を`DEFAULT_COMMIT_TYPE`へ倒す。`integration.ts`のコミットメッセージ組み立てと
 * `worktree.ts`の`branchName`（`branchNaming: conventional`時のbranchType読み替え）の
 * 両方が使う、型の妥当性チェックの唯一の実装（重複実装しない）。
 *
 * `value`を`unknown`で受けるのは、`worktree.ts`の`BranchNamingOptions.type`や
 * `integration.ts`の`uncommittedChangesCommitMessage` / `mergeCommitMessage`の
 * `type?: string`（省略可能な引数）が、実行時には文字列以外（`undefined`を含む）を
 * 渡しうるため。
 */
export function normalizeCommitType(value: unknown): CommitType {
  return typeof value === 'string' && isCommitType(value) ? value : DEFAULT_COMMIT_TYPE;
}

/** `resolveIssue` の戻り値。`error` はフィールドが指定されていたが不正な値だった場合にだけ入る。 */
interface ResolvedIssue {
  value: number | undefined;
  error: string | undefined;
}

/**
 * `issue`（対応するIssue番号）を解決する。他の数値フィールド（`retries` / `maxIterations`
 * 等が使う `num()`）と違い、不正な値を既定値へ黙って倒さない。この値はPR/MRの本文へ
 * `Closes #<N>` としてそのまま出る（design.md §16.2・§16.18）ため、誤った番号が紛れ込むと
 * 無関係のIssueを閉じかねない。「未指定」（フィールド自体が無い。`undefined`）と
 * 「指定されたが不正」を区別し、後者は `parseErrors` へ積んで読み込みごと止める
 * （`dependsOn` が配列でない場合と同じ扱い）。
 */
function resolveIssue(raw: unknown): ResolvedIssue {
  if (raw === undefined) {
    return { value: undefined, error: undefined };
  }
  const n = typeof raw === 'number' ? raw : Number.parseInt(str(raw), 10);
  // `Number.isInteger`だけでは上限が無く、`issue: 1e21`のような値も通ってしまう
  // （`Number.isInteger(1e21) === true`）。`String(1e21)`は`"1e+21"`になり、ブランチ名へ
  // 展開すると`CONVENTIONAL_BRANCH_PATTERN`に一致しない形になってpush/mergeが失敗し、
  // runが途中で止まる（レビュー指摘）。`Number.isSafeInteger`（2^53-1以下）で弾く
  if (!Number.isSafeInteger(n) || n <= 0) {
    return {
      value: undefined,
      error: `issue が正の整数ではありません: ${JSON.stringify(raw)}`,
    };
  }
  return { value: n, error: undefined };
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

/** `role` を解決した結果。既定値が「役割なし」（`undefined`）なので `resolveEnum` とは別にする。 */
interface ResolvedRole {
  value: TeamRole | undefined;
  invalidRaw: string | undefined;
}

/**
 * `role` を解決する（design.md §16.44、Issue #693）。未指定は「役割なし」、未知の値は
 * 「役割なし」へ倒しつつ `invalidRaw` に残す（`resolveEnum` と同じく呼び出し側が警告を出す）。
 *
 * 未知の役割を黙って受け入れないのは、役割が `model` / `effort` の既定値を引くキーであり、
 * 綴り違いが「意図しないモデルで走った」という気付きにくい形で現れるため。
 */
function resolveRole(raw: unknown): ResolvedRole {
  const s = str(raw);
  if (s === '') {
    return { value: undefined, invalidRaw: undefined };
  }
  if (isTeamRole(s)) {
    return { value: s, invalidRaw: undefined };
  }
  return { value: undefined, invalidRaw: s };
}

interface ResolvedDefaults {
  provider: Provider;
  /** `defaults.role`。タスクが `role` を書かなかったときに使う（design.md §16.44）。 */
  role: TeamRole | undefined;
  isolation: Isolation;
  maxIterations: number;
  autoApprove: boolean;
  cleanup: CleanupMode;
  sandbox: string | undefined;
  model: string | undefined;
  effort: string | undefined;
  approvalMode: string | undefined;
  maxParallel: number;
  type: CommitType;
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
  const type = resolveEnum(d['type'], isCommitType, DEFAULT_COMMIT_TYPE);
  const role = resolveRole(d['role']);

  const warnings: string[] = [];
  if (role.invalidRaw !== undefined) {
    warnings.push(
      `defaults.role に未知の値が指定されたため役割なしとして扱いました（指定できる値: ${TEAM_ROLES.join(' / ')}）: ${role.invalidRaw}`,
    );
  }
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
  if (type.invalidRaw !== undefined) {
    warnings.push(
      `defaults.type に未知の値が指定されたため既定値(${DEFAULT_COMMIT_TYPE})を使いました: ${type.invalidRaw}`,
    );
  }

  return {
    defaults: {
      provider: provider.value,
      role: role.value,
      isolation: isolation.value,
      maxIterations: num(d['maxIterations'], DEFAULT_MAX_ITERATIONS),
      autoApprove: bool(d['autoApprove'], DEFAULT_AUTO_APPROVE),
      cleanup: cleanup.value,
      sandbox: optStr(d['sandbox']),
      model: optStr(d['model']),
      effort: optStr(d['effort']),
      approvalMode: optStr(d['approvalMode']),
      maxParallel: num(d['maxParallel'], DEFAULT_MAX_PARALLEL),
      type: type.value,
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
  const type = resolveEnum(t['type'], isCommitType, defaults.type);
  if (type.invalidRaw !== undefined) {
    parseWarnings.push(
      `type に未知の値が指定されたため既定値(${type.value})を使いました: ${type.invalidRaw}`,
    );
  }

  // 役割（design.md §16.44、Issue #693）。タスクが書いていなければ`defaults.role`を継ぐ
  const roleResult = resolveRole(t['role']);
  if (roleResult.invalidRaw !== undefined) {
    parseWarnings.push(
      `role に未知の値が指定されたため役割なしとして扱いました（指定できる値: ${TEAM_ROLES.join(' / ')}）: ${roleResult.invalidRaw}`,
    );
  }
  const role = roleResult.value ?? defaults.role;
  // 役割から引くのは`model` / `effort`の既定値だけ（権限には関与しない）。
  // 優先順は「タスクが明示 > タスクの役割 > defaults が明示 > defaults の役割」——
  // 同じ階層では明示した値が役割より強く、階層が下（タスク）のほうが上（defaults）より
  // 強い。役割だけが階層を飛び越えて defaults.model を上書きすることはない
  const taskRoleDefaults =
    roleResult.value === undefined ? undefined : roleDefaults(roleResult.value, provider.value);
  const defaultsRoleDefaults =
    defaults.role === undefined ? undefined : roleDefaults(defaults.role, provider.value);

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

  const issueResult = resolveIssue(t['issue']);
  if (issueResult.error !== undefined) {
    parseErrors.push(issueResult.error);
  }

  return {
    id: str(t['id']),
    role,
    prompt: str(t['prompt']),
    done: str(t['done']),
    dependsOn,
    continuePrompt: continuePromptRaw === '' ? DEFAULT_CONTINUE_PROMPT : continuePromptRaw,
    maxIterations: num(t['maxIterations'], defaults.maxIterations),
    provider: provider.value,
    isolation: isolation.value,
    type: type.value,
    cwd: optStr(t['cwd']),
    model:
      optStr(t['model']) ??
      taskRoleDefaults?.model ??
      defaults.model ??
      defaultsRoleDefaults?.model,
    effort:
      optStr(t['effort']) ??
      taskRoleDefaults?.effort ??
      defaults.effort ??
      defaultsRoleDefaults?.effort,
    approvalMode: optStr(t['approvalMode']) ?? defaults.approvalMode,
    sandbox: optStr(t['sandbox']) ?? defaults.sandbox,
    autoApprove: bool(t['autoApprove'], defaults.autoApprove),
    escalate: escalateFiltered.values,
    allow: allowFiltered.values,
    retries: Math.max(0, Math.trunc(num(t['retries'], 0))),
    issue: issueResult.value,
    // cleanupはworktreeの後始末で、taskごとの上書きはスキーマに無い（design.md §16.2）
    cleanup: defaults.cleanup,
    parseErrors,
    parseWarnings,
  };
}

/**
 * オーケストレーターの`add_task`（design.md §16.29、roadmap W4、Issue #338）が追加する
 * タスクを組み立てる。`resolveTask`（YAMLの1タスク分の解決）とほぼ同じ考え方で未知の
 * フィールドを読み飛ばすが、次の2点が異なる。
 *
 * - `autoApprove` / `allow` / `sandbox` / `approvalMode` は受け取らない。**指定されて
 *   いれば（値によらず）拒否する。** 黙って既定値へ落とすと「指定したのに反映されな
 *   かった」だけに見え、拒否されたことにモデルが気付けない（design.md §16.29「指定を
 *   無視して黙って既定で作る形にはしない」）
 * - `defaults`ブロック（YAMLの`defaults:`）は実行時には残っていない
 *   （`WorkflowDefinition`は解決済みの`WorkflowTask[]`しか持たない）ため、拡張機能の
 *   既定値（`DEFAULT_PROVIDER`等）を使う。人が書いた`defaults`より安全側に倒れることは
 *   あっても緩い側には倒れない
 *
 * ここでは`id`/`prompt`/`done`が空でも構わない（`validateWorkflow`が候補となる
 * `WorkflowDefinition`全体に対してまとめて検証する。呼び出し側の責務）。
 */
export function buildOrchestratorTask(
  raw: Record<string, unknown>,
): { task: WorkflowTask } | { error: string } {
  for (const field of ['autoApprove', 'allow', 'sandbox', 'approvalMode'] as const) {
    if (Object.prototype.hasOwnProperty.call(raw, field)) {
      return {
        error:
          `${field} はadd_taskから指定できません（権限の緩和は人が書いたワークフロー` +
          `定義からのみ許可されます）: ${field}`,
      };
    }
  }
  const provider = resolveEnum(raw['provider'], isProvider, DEFAULT_PROVIDER).value;
  const isolation = resolveEnum(raw['isolation'], isIsolation, DEFAULT_ISOLATION).value;
  const type = resolveEnum(raw['type'], isCommitType, DEFAULT_COMMIT_TYPE).value;
  // 役割（design.md §16.44、Issue #693）は`add_task`から指定できる。上の禁止リスト
  // （autoApprove / allow / sandbox / approvalMode）と違い、役割が決めるのは
  // `model` / `effort` の既定値だけで権限には関与しないため（`rolePresets.ts`）。
  // 未知の値は「役割なし」へ倒す（ここでは警告の置き場が無いので黙って倒し、
  // 実効値は従来の add_task と同じ「拡張機能の設定に従う」になる）
  const role = resolveRole(raw['role']).value;
  const roleModelEffort = role === undefined ? undefined : roleDefaults(role, provider);
  const dependsOnRaw = raw['dependsOn'];
  const dependsOn = Array.isArray(dependsOnRaw) ? filterStringArray(dependsOnRaw).values : [];
  const continuePromptRaw = str(raw['continuePrompt']);
  const issueResult = resolveIssue(raw['issue']);
  const task: WorkflowTask = {
    id: str(raw['id']),
    role,
    prompt: str(raw['prompt']),
    done: str(raw['done']),
    dependsOn,
    continuePrompt: continuePromptRaw === '' ? DEFAULT_CONTINUE_PROMPT : continuePromptRaw,
    maxIterations: num(raw['maxIterations'], DEFAULT_MAX_ITERATIONS),
    provider,
    isolation,
    type,
    cwd: undefined,
    model: roleModelEffort?.model,
    effort: roleModelEffort?.effort,
    approvalMode: undefined,
    sandbox: undefined,
    autoApprove: DEFAULT_AUTO_APPROVE,
    escalate: [],
    allow: [],
    retries: Math.max(0, Math.trunc(num(raw['retries'], 0))),
    issue: issueResult.error === undefined ? issueResult.value : undefined,
    // cleanupはworktreeの後始末で、taskごとの上書きはスキーマに無い（resolveTaskと同じ）
    cleanup: DEFAULT_CLEANUP,
    parseErrors: issueResult.error !== undefined ? [issueResult.error] : [],
    parseWarnings: [],
  };
  return { task };
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
  const roadmap = str(root['roadmap']);
  return {
    version: num(root['version'], 1),
    name: str(root['name']),
    maxParallel: defaults.maxParallel,
    tasks: tasksRaw.map((t) => resolveTask(t, defaults)),
    defaultsWarnings,
    // 未指定と空文字は同じ「ロードマップ由来ではない」扱いにする（検証側で分岐を増やさない）
    ...(roadmap !== '' ? { roadmap } : {}),
  };
}

/** `dropUndeclaredTemplateRefs` が落とした参照1件。 */
export interface DroppedTemplateRef {
  taskId: string;
  /** 落とした参照の文字列（`{{R3.cwd}}` の形）。 */
  ref: string;
}

/**
 * `dependsOn` に挙げていないタスクを参照するテンプレート変数を、YAMLのテキストから落とす。
 *
 * 分解セッション（LLM）は `{{R3.cwd}}` のような参照を、依存に挙げていないタスクに対しても
 * 書いてしまう。特にロードマップ経路では「依存はロードマップのものをそのまま写し、それ以外の
 * 依存を追加しないこと」と縛っているため、モデルは依存を増やして辻褄を合わせることができず、
 * 再生成しても同じ検証エラー（`テンプレート変数が dependsOn に挙げていないタスクを
 * 参照しています`）を繰り返して生成が失敗し続ける。プロンプトでの指示だけでは防げなかった
 * ため、検証にかける前に機械的に落とす。
 *
 * **落とすのは参照だけで、`dependsOn` は増やさない。** 依存を足す方向で辻褄を合わせると、
 * ロードマップに書かれた依存と食い違ううえ（§16.19の転記確認に引っかかる）、並列度が落ち、
 * 循環依存を作る危険もある。参照が消えて意味が通らなくなった箇所は人が直す前提で、
 * 落とした件数を呼び出し側から知らせる（生成物は人がレビューしてから実行する設計）。
 *
 * 未定義のタスクidを参照している場合はここでは触らない。それは依存の書き忘れではなく
 * 分解そのものの誤りで、検証エラーとして人へ見せるべきものだから。
 *
 * YAMLの整形やコメントを保つため、テキストの置換ではなくDocument APIで該当スカラーだけを
 * 書き換える（同じ文字列が別のタスクにも現れうるため、単純な全置換では依存を正しく
 * 書けているほうまで壊してしまう）。
 */
export function dropUndeclaredTemplateRefs(yamlText: string): {
  yaml: string;
  dropped: DroppedTemplateRef[];
} {
  const dropped: DroppedTemplateRef[] = [];
  let doc;
  try {
    doc = parseDocument(yamlText);
  } catch {
    // パースできないYAMLは修復の対象外（検証側がYAMLの解析エラーとして扱う）
    return { yaml: yamlText, dropped };
  }
  if (doc.errors.length > 0) {
    return { yaml: yamlText, dropped };
  }

  const tasksNode = doc.get('tasks', true);
  if (!isSeq(tasksNode)) {
    return { yaml: yamlText, dropped };
  }

  // 定義済みのタスクid。未定義タスクへの参照は落とさず検証エラーとして残す
  const definedIds = new Set<string>();
  for (const item of tasksNode.items) {
    if (!isMap(item)) {
      continue;
    }
    const id = item.get('id');
    if (typeof id === 'string') {
      definedIds.add(id);
    }
  }

  let changed = false;
  for (const item of tasksNode.items) {
    if (!isMap(item)) {
      continue;
    }
    const rawId = item.get('id');
    const taskId = typeof rawId === 'string' ? rawId : '';
    const dependsOnNode = item.get('dependsOn', true);
    const dependsOn = new Set<string>();
    if (isSeq(dependsOnNode)) {
      for (const dep of dependsOnNode.items) {
        if (isScalar(dep) && typeof dep.value === 'string') {
          dependsOn.add(dep.value);
        }
      }
    }

    for (const key of ['prompt', 'continuePrompt']) {
      const node = item.get(key, true);
      if (!isScalar(node) || typeof node.value !== 'string') {
        continue;
      }
      const next = node.value.replace(templatePattern(), (whole: string, id: string) => {
        if (!definedIds.has(id) || dependsOn.has(id)) {
          return whole;
        }
        dropped.push({ taskId, ref: whole });
        return '';
      });
      if (next !== node.value) {
        node.value = next;
        changed = true;
      }
    }
  }

  return { yaml: changed ? String(doc) : yamlText, dropped };
}

/**
 * 生成されたYAMLへ `defaults.provider` を補う（issue #321）。
 *
 * 分解セッションに使ったエージェントと、出来たワークフローを実行するエージェントは
 * 一致しているのが人の期待になる（Claude Codeの画面から生成したのにCodexで実行される、
 * というねじれを起こさない）。ところがスキーマ説明は `provider` を「省略可」としか
 * 言えないため、生成物には書かれないことが多く、その場合は `DEFAULT_PROVIDER`（codex）で
 * 実行される。プロンプトでの指示（`buildSchemaDescription`）だけでは守られないので、
 * 検証にかける前に機械的に補う（`dropUndeclaredTemplateRefs` と同じ考え方）。
 *
 * **明示された値は上書きしない。** `defaults.provider` が既にある場合はそのまま返す。
 * タスク単位の `provider` はそもそも `defaults` より優先されるため触る必要が無い
 * （プロバイダを混ぜたワークフローを壊さない）。
 *
 * YAMLの整形とコメントを保つため、テキストの結合ではなくDocument APIで書き換える。
 * `defaults` ごと無い場合は `tasks` の直前へ差し込む（末尾に足すとタスク定義のあとに
 * 既定値が並ぶ読みにくいYAMLになる）。解析できないYAMLには何もしない（検証側が
 * 解析エラーとして人へ見せる）。
 */
export function ensureDefaultsProvider(
  yamlText: string,
  provider: Provider,
): { yaml: string; applied: boolean } {
  let doc;
  try {
    doc = parseDocument(yamlText);
  } catch {
    return { yaml: yamlText, applied: false };
  }
  if (doc.errors.length > 0) {
    return { yaml: yamlText, applied: false };
  }
  const contents = doc.contents;
  if (!isMap(contents)) {
    return { yaml: yamlText, applied: false };
  }

  const defaultsNode = doc.get('defaults', true);
  if (isMap(defaultsNode)) {
    if (defaultsNode.has('provider')) {
      return { yaml: yamlText, applied: false };
    }
    defaultsNode.set('provider', provider);
    return { yaml: String(doc), applied: true };
  }
  if (defaultsNode !== undefined && defaultsNode !== null) {
    // `defaults` がマップ以外（スカラーや配列）。検証側がエラーにする形なので触らない
    return { yaml: yamlText, applied: false };
  }

  // `doc.set`で足すと末尾（tasksの後ろ）に付くため、追加された1件を`tasks`の直前へ移す。
  // `createPair`の戻り値を直接itemsへ入れると、解析済みノード（`ParsedNode`）の配列に
  // 未解析のノードを混ぜることになり型が合わない
  doc.set('defaults', { provider });
  const added = contents.items.pop();
  if (added === undefined) {
    return { yaml: String(doc), applied: true };
  }
  const tasksIndex = contents.items.findIndex(
    (item) => isScalar(item.key) && item.key.value === 'tasks',
  );
  contents.items.splice(tasksIndex >= 0 ? tasksIndex : contents.items.length, 0, added);
  return { yaml: String(doc), applied: true };
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

/**
 * exportしてある。`planner.ts`がゴール生成プロンプトのスキーマ説明をここから組み立て、
 * 手書きの一覧との二重管理を避けるため（design.md §16.9のプロンプトはスキーマの説明を
 * 含む必要があるが、フィールド名の一覧そのものは`workflow.ts`の定義が唯一の正）。
 */
export const TEMPLATE_FIELDS = ['result', 'cwd', 'branch', 'files', 'summary'] as const;
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
 * `findCycleGroups` が扱える最小限の形。`id` と `dependsOn`（他ノードの `id` への
 * 参照の一覧）さえ持っていれば、それが表すものがワークフローのタスクでもロードマップの
 * 項目でも構わない。
 */
export interface DependencyGraphNode {
  readonly id: string;
  readonly dependsOn: readonly string[];
}

/**
 * 依存関係を1件の循環ずつ、強連結成分（SCC）単位で返す。
 * `A<->B` と `C<->D` のように無関係な循環が複数あれば、別々のグループとして返す
 * （呼び出し側はグループごとに1件のエラーを作る）。循環の下流で待っているだけの
 * ノード（例: `T3 dependsOn: [T2]` で `T1<->T2` が循環しているときのT3）は含めない。
 *
 * Tarjanの強連結成分アルゴリズム。要素数2以上のSCC、または自己参照
 * （`T1` が `dependsOn: [T1]`）を1件のグループとして採用する。
 *
 * ワークフローのタスク（`WorkflowTask`）とロードマップの項目（`roadmap.ts` の
 * `RoadmapItem`）の両方が同じ形（`{ id: string; dependsOn: readonly string[] }`）を
 * 持つため、対象の型をジェネリクスにして共有する（Issue #146。以前は`roadmap.ts`が
 * 「対象の型が違うため複製」としてTarjanベースの同じロジックをほぼそのまま複製していた）。
 */
export function findCycleGroups<T extends DependencyGraphNode>(nodes: readonly T[]): string[][] {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
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
 * 与えた安全順序表でdownstreamがupstreamより緩いかどうかを判定する（design.md §16.4
 * 案2「警告する」、Issue #67）。既存のクランプの安全順序（`SANDBOX_SAFETY_ORDER` /
 * `CODEX_APPROVAL_SAFETY_ORDER` / `CLAUDE_PERMISSION_SAFETY_ORDER`）をそのまま使う。
 *
 * どちらか一方でも安全順序表に無い値（YAML未指定でundefined、または未知の文字列）だと
 * 判定できない。未指定は「拡張機能側の設定に委ねる」という意味で、その実効値はこの
 * 読み込み時点（`validateWorkflow`はVSCodeの設定を知らない純粋関数）では分からないため、
 * 判定できないケースは「緩くなっていない」側（false）に倒す。誤検知を増やしてまで
 * 未指定同士を警告する実益が薄いという判断で、design.mdにこの限界を明記する。
 */
function isLooser(
  order: readonly string[],
  upstreamValue: string | undefined,
  downstreamValue: string | undefined,
): boolean {
  if (upstreamValue === undefined || downstreamValue === undefined) {
    return false;
  }
  const upstreamIndex = order.indexOf(upstreamValue);
  const downstreamIndex = order.indexOf(downstreamValue);
  if (upstreamIndex === -1 || downstreamIndex === -1) {
    return false;
  }
  return downstreamIndex > upstreamIndex;
}

/**
 * 権限の比較に使う4項目だけを持つ形。`WorkflowTask`（読み込み時のYAML値）と、
 * `runner.ts`が実行時に組み立てる実効値（クランプ後の値）の両方をこの形に揃えることで、
 * 比較ロジック（`permissionEscalationReasons`）を読み込み時・実行時の両方から共有する
 * （design.md §16.4 案2、Issue #67）。
 */
export type PermissionProfile = Pick<
  WorkflowTask,
  'provider' | 'sandbox' | 'approvalMode' | 'autoApprove'
>;

/**
 * 上流・下流の`approvalMode`を比較した際の理由文字列を組み立てる。安全順序表にsandboxと
 * `approvalMode`/`permissionMode`を混ぜて渡すバグ（セキュリティ監査指摘#1）を防ぐため、
 * 比較そのものと、どちらの語彙（フィールド名）を使うかの決定を1箇所にまとめる。
 *
 * `approvalMode`はprovider問わず同じキー名で定義ファイルへ書くが、語彙（安全順序）は
 * providerごとに別（`taskConfig.ts`の`buildEffectiveTaskConfig`と同じ分岐）。providerが
 * 異なるタスク間では語彙が異なり安全順序として比較できないため、判定そのものをしない
 * （`sandbox`も同様。Claudeタスクでは常に無意味な値なので比較対象にしない）。
 */
function approvalModeEscalationReason(
  upstream: PermissionProfile,
  downstream: PermissionProfile,
): string | undefined {
  if (upstream.provider !== downstream.provider) {
    return undefined;
  }
  const order =
    downstream.provider === 'claude' ? CLAUDE_PERMISSION_SAFETY_ORDER : CODEX_APPROVAL_SAFETY_ORDER;
  const label = downstream.provider === 'claude' ? 'permissionMode' : 'approvalMode';
  if (!isLooser(order, upstream.approvalMode, downstream.approvalMode)) {
    return undefined;
  }
  return `${label}: ${upstream.approvalMode} → ${downstream.approvalMode}`;
}

/**
 * downstreamがupstreamより緩い権限を持つかどうかを判定し、緩んでいる項目の説明を返す
 * （design.md §16.4 案2「警告する」、Issue #67）。空配列なら緩んでいない。
 *
 * `sandbox`はCodex固有の概念でClaudeタスクでは常に無意味（`taskConfig.ts`のコメント参照）
 * なので、比較するのは両方Codexのときだけにする。`approvalMode`はproviderごとに語彙が
 * 異なるため、providerが一致するときだけ比較する（`approvalModeEscalationReason`）。
 * `autoApprove`はprovider共通の軸なので常に比較する。
 *
 * 読み込み時（`findPermissionEscalationWarnings`、YAMLの値）・実行時（`runner.ts`、
 * クランプ後の実効値）の両方から呼ぶ、比較ロジックの唯一の実装。
 */
export function permissionEscalationReasons(
  upstream: PermissionProfile,
  downstream: PermissionProfile,
): string[] {
  const reasons: string[] = [];
  if (
    upstream.provider === 'codex' &&
    downstream.provider === 'codex' &&
    isLooser(SANDBOX_SAFETY_ORDER, upstream.sandbox, downstream.sandbox)
  ) {
    reasons.push(`sandbox: ${upstream.sandbox} → ${downstream.sandbox}`);
  }
  const approvalReason = approvalModeEscalationReason(upstream, downstream);
  if (approvalReason !== undefined) {
    reasons.push(approvalReason);
  }
  if (!upstream.autoApprove && downstream.autoApprove) {
    reasons.push('autoApprove: false → true');
  }
  return reasons;
}

/**
 * `referencedResultFields` が返す1件。フィールドは自由記述（モデルが自由に書ける文字列）を
 * 渡す3つに絞ってある。`files`は`result` / `summary`と同じくモデル自身が生成した文字列
 * （design.md §16.24、Issue #369）であり、`cwd` / `branch`（拡張機能が組み立てた構造化
 * データ）とは扱いが異なるため、対象に含める。
 */
export interface ResultFieldReference {
  id: string;
  field: 'result' | 'summary' | 'files';
}

/**
 * タスクの `prompt` / `continuePrompt` から、`dependsOn` に挙げた依存先の `result` /
 * `summary` / `files` への参照を重複を除いて集める（design.md §16.4、Issue #67。
 * `files`はIssue #369で対象に追加した）。
 *
 * 読み込み時の警告（`findPermissionEscalationWarnings`）と、実行時（実効値ベース）の
 * 警告（`runner.ts`）の両方がこれを使う。参照抽出ロジックを2箇所に複製しない。
 */
export function referencedResultFields(
  task: Pick<WorkflowTask, 'prompt' | 'continuePrompt' | 'dependsOn'>,
): ResultFieldReference[] {
  const seen = new Set<string>();
  const refs: ResultFieldReference[] = [];
  for (const text of [task.prompt, task.continuePrompt]) {
    for (const ref of extractTemplateRefs(text)) {
      if (ref.field !== 'result' && ref.field !== 'summary' && ref.field !== 'files') {
        continue;
      }
      // 未定義参照・dependsOn外の参照は別のチェック（`validateWorkflow`）で既に
      // エラーとして報告済みなので、ここでは黙って除外する
      if (!task.dependsOn.includes(ref.id)) {
        continue;
      }
      const key = `${ref.id}.${ref.field}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      refs.push({ id: ref.id, field: ref.field });
    }
  }
  return refs;
}

/**
 * 上流タスクより緩い権限を持つ下流タスクが、上流の自由記述の出力（`result` / `summary` /
 * `files`）をテンプレート変数で参照している場合に警告する（design.md §16.4 案2「警告する」、
 * Issue #67）。
 *
 * 上流タスクがリポジトリの中身（README・コメント・テストデータ等）を読む過程で、そこに
 * 仕込まれた指示文を応答へ含めてしまうと、それが下流タスクの指示として下流の権限で
 * 実行されうる。ワークフローのYAML自体は無害なまま成立するのがこの経路の厄介な点で、
 * ここではその可能性がある組み合わせを機械的に検出するだけであり、実行そのものは止めない
 * （書けてしまうこと自体は許容し、見えるようにする方針。design.md §16.7の危険判定と同じ
 * 位置付け）。
 *
 * これは読み込み時（YAMLに書かれたリテラルの値）だけを見た検出であり、`sandbox` /
 * `approvalMode` がどちらか一方でも未指定（拡張機能側の設定に委ねる）だと実効値が
 * 分からず判定できない（`isLooser`のコメント参照）。実効値（クランプ後の値）に基づく
 * 第二段の検出は`runner.ts`の`checkEffectivePermissionEscalation`が担う（セキュリティ
 * 監査指摘#2。読み込み時に出せない警告を実行時に出す）。
 *
 * `cwd` / `branch` は拡張機能が組み立てた構造化データであり、リポジトリの中身に由来する
 * 自由記述ではないため対象外にする。`files`は以前ここに含めていなかったが、実体はモデルが
 * `tool_use`引数として生成した文字列であり構造化データではないため、対象へ加えた
 * （design.md §16.24、Issue #369）。
 */
export function findPermissionEscalationWarnings(
  tasks: readonly WorkflowTask[],
): WorkflowWarning[] {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const warnings: WorkflowWarning[] = [];

  for (const t of tasks) {
    for (const ref of referencedResultFields(t)) {
      const upstream = byId.get(ref.id);
      // dependsOnに未定義のidが挙がっているケース（別のエラーで既に報告済み）
      if (upstream === undefined) {
        continue;
      }

      const reasons = permissionEscalationReasons(upstream, t);
      if (reasons.length === 0) {
        continue;
      }

      warnings.push({
        taskIds: [upstream.id, t.id],
        message:
          `${t.id} は上流タスク ${upstream.id} より緩い権限で {{${upstream.id}.${ref.field}}} を` +
          `参照しています（${reasons.join(', ')}）。${upstream.id} の応答に仕込まれた指示文が ` +
          `${t.id} の権限で実行されうるため、参照する内容を確認してください`,
      });
    }
  }

  return warnings;
}

/**
 * `roadmap` に許す形（design.md §16.19、Issue #173）。ワークフロー定義はエージェントが
 * 生成しうるため、書き戻し先を任意のパスへ向けられないようにする。
 *
 * - 絶対パス（POSIX / Windowsのドライブレター / UNC）を許さない
 * - `..` を含むセグメントを許さない（ワークスペースの外へ出られない）
 * - 拡張子は `.md` のみ
 * - 制御文字・NUL を含まない
 */
function isSafeRoadmapPath(value: string): boolean {
  // 制御文字の判定は正規表現ではなくコードポイントで見る（`src/provider/import.ts` と同じ流儀。
  // 正規表現へ直接書くと `no-control-regex` に触れる）
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
  return value.toLowerCase().endsWith('.md');
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

  if (def.roadmap !== undefined && !isSafeRoadmapPath(def.roadmap)) {
    errors.push({
      taskIds: [],
      message: `roadmap はワークスペース内の .md を指す相対パスにしてください: ${def.roadmap}`,
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
    if (t.id === RESERVED_ORCHESTRATOR_TASK_ID) {
      errors.push({
        taskIds: [t.id],
        message: `id "${RESERVED_ORCHESTRATOR_TASK_ID}" はオーケストレーターの受け渡しファイル用に予約されているため使えません`,
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
  warnings.push(...findPermissionEscalationWarnings(tasks));

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
  /**
   * `taskSummary.ts` の `buildResponseSummary` が作る1行要約（design.md §16.4 案4「絞る」、
   * Issue #67）。`result` は応答全文をそのまま渡すのに対し、こちらは書き手が「要点だけで
   * 十分」と判断したときに選べる、短く切り詰め済みの代替。
   */
  summary: string;
}

/**
 * 文字列をUnicodeのコードポイント単位（サロゲートペアを1文字として数える）で
 * `max`個までに切り詰める。切り詰めが起きたかどうかも返す。
 *
 * 実体は`untrustedText.ts`にある（design.md §16.24、Issue #369で集約）。
 * `messaging.ts`の`composeNextPrompt`（design.md §16.21、Issue #132）が、連結後の
 * 総量の切り詰めにこの関数をimportして使っているため、ここから引き続きexportする
 * （既存の参照箇所を壊さない）。
 */
export { truncateByCodePoint };

/**
 * `result` / `summary` / `files` の展開値へ、切り詰め（案4）と区切り（案3）の両方を
 * 適用する。`cwd` / `branch` は拡張機能が組み立てた構造化データのため対象外
 * （design.md §16.4 案4）。
 *
 * 実体は`untrustedText.ts`の`formatUntrusted`に委譲する（design.md §16.24、Issue #369）。
 * `files`はファイルパスの一覧という構造上、改行で並べたほうが読みやすいため
 * `preserveNewlines: true`で展開する。
 */
function wrapFreeTextField(
  id: string,
  field: 'result' | 'summary' | 'files',
  value: string,
  nonce: string,
): string {
  return formatUntrusted(value, {
    id,
    field,
    maxLength: MAX_TEMPLATE_RESULT_LENGTH,
    preserveNewlines: true,
    nonce,
  });
}

/** `TemplateField` の網羅性をコンパイラに保証させる（フィールドを増やしたら分岐漏れがエラーになる）。 */
function fieldValue(id: string, field: TemplateField, result: TaskResult, nonce: string): string {
  switch (field) {
    case 'cwd':
      return result.cwd;
    case 'branch':
      return result.branch;
    case 'files':
      return wrapFreeTextField(id, 'files', result.files.join('\n'), nonce);
    case 'result':
      return wrapFreeTextField(id, 'result', result.result, nonce);
    case 'summary':
      return wrapFreeTextField(id, 'summary', result.summary, nonce);
  }
}

/**
 * `MAX_TEMPLATE_RESULT_LENGTH`はフィールド単位の上限なので、1つのpromptが複数の
 * `result`/`summary`を参照すればその数だけ積み上がる（`MAX_PROMPT_LENGTH`は展開**前**の
 * `prompt`自体にしか効かない）。展開後の全体にも粗い安全弁として緩い上限を設ける
 * （design.md §16.4 案4、セキュリティ監査指摘#7）。個々のフィールドの上限より一貫して
 * 緩くしてあるため、通常の使い方では発動しない。
 */
export const MAX_EXPANDED_PROMPT_LENGTH = 60000;

function capExpandedLength(text: string): string {
  const { text: capped, truncated } = truncateByCodePoint(text, MAX_EXPANDED_PROMPT_LENGTH);
  if (!truncated) {
    return capped;
  }
  return `${capped}\n…（展開後の全体が上限${MAX_EXPANDED_PROMPT_LENGTH}文字を超えたため以下省略）`;
}

/**
 * `{{<id>.<field>}}` を展開する。
 *
 * 読み込み時（`parseWorkflowYaml` / `validateWorkflow`）ではなく、タスクの開始直前に
 * 呼ぶ（design.md §16.4）。読み込み時にできるのは変数名の検証だけで、値はその時点で
 * まだ存在しないため。値が無い（対応表に該当タスクが無い、または該当フィールドが
 * 未知）場合は空文字を差し込む。テンプレート構文に一致しない部分は一切変更しない。
 *
 * `result` / `summary` / `files` は展開時に長さを打ち切り（案4）、前後を区切り文字列で
 * 挟む（案3）。`cwd` / `branch` はこれまでどおり値をそのまま差し込む。展開後の全体にも
 * 緩い上限を掛ける（`capExpandedLength`、監査指摘#7）。
 *
 * `nonce` は区切りに埋め込む乱数（監査指摘#3）。省略時は `randomUUID()` で生成する
 * （この関数がこのモジュールで唯一、暗黙の非決定性を持つ理由。モジュール先頭のコメント
 * 参照）。`runner.ts` は同じタスクの「Viewに見せる値」と「実際にCLIへ送る値」を
 * 一致させるため、taskの開始時に1回だけ生成した値を明示的に渡す。
 */
export function expandTemplate(
  text: string,
  results: ReadonlyMap<string, TaskResult>,
  nonce: string = randomUUID(),
): string {
  const expanded = text.replace(templatePattern(), (whole, id: string, field: string) => {
    if (!isTemplateField(field)) {
      return '';
    }
    const result = results.get(id);
    if (result === undefined) {
      return '';
    }
    return fieldValue(id, field, result, nonce);
  });
  return capExpandedLength(expanded);
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
