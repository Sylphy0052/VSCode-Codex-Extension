import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';

import type { ClaudePermissionMode } from '../claude/types';
import { SANDBOX_MODES, type ApprovalMode } from '../codex/types';
import { LOOP_ITERATION_LIMIT } from '../loop/loopController';
import type { Logger } from '../log';
import { DANGER_PATTERN_IDS } from './escalation';
import { stripControlChars } from './sanitize';
import type { ExtensionSafetyBaseline } from './taskConfig';
import type { TaskSessionHost, TaskSessionInput } from './taskSession';
import { formatUntrusted, sanitizeInlineText } from './untrustedText';
import {
  clampClaudePermissionMode,
  clampCodexApprovalMode,
  clampSandbox,
} from '../util/safetyClamp';
import {
  CLEANUP_MODES,
  DEFAULT_AUTO_APPROVE,
  DEFAULT_CLEANUP,
  DEFAULT_CONTINUE_PROMPT,
  DEFAULT_ISOLATION,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MAX_PARALLEL,
  DEFAULT_PROVIDER,
  dropUndeclaredTemplateRefs,
  ensureDefaultsProvider,
  isProvider,
  ISOLATIONS,
  MAX_PARALLEL_MAX,
  MAX_PARALLEL_MIN,
  MAX_PROMPT_LENGTH,
  MAX_RETRIES,
  MAX_TASK_COUNT,
  MAX_WORKFLOW_FILE_BYTES,
  parseWorkflowYaml,
  PROVIDERS,
  TASK_ID_PATTERN,
  TEMPLATE_FIELDS,
  validateWorkflow,
  type DroppedTemplateRef,
  type Provider,
  type WorkflowDefinition,
  type WorkflowIssue,
} from './workflow';

/**
 * ゴール文からワークフロー定義（YAML）を生成する（design.md §16.9）。
 *
 * VSCode APIには依存しない。ファイル列挙（`PlannerWorkspacePort`）とセッション
 * （`TaskSessionHost`）は注入で受け取り、`extension.ts` が実体を組み立てる。
 * `workflow.ts` の検証・クランプ関数をそのまま再利用し、独自の安全判定は作らない。
 */

// ---- ワークスペースの情報（design.md §16.9「現在のワークスペースの情報」） ----

/** 分解セッションへ渡すワークスペースの要約。中身は概要のみで、ファイル内容そのものは含まない。 */
export interface WorkspaceSummary {
  /** ワークスペース直下の主要エントリ（ディレクトリは末尾に`/`）。ドットファイルは除く。 */
  topLevelEntries: readonly string[];
  hasAgentsMd: boolean;
  hasClaudeMd: boolean;
}

/** `buildWorkspaceSummary` が使うファイルシステムの口。テストではフェイクに差し替える。 */
export interface PlannerWorkspacePort {
  listTopLevelEntries(root: string): Promise<string[]>;
  fileExists(filePath: string): Promise<boolean>;
}

/** 巨大なモノレポ直下でも列挙が長くならないようにする上限。 */
const MAX_TOP_LEVEL_ENTRIES = 40;
/** 1エントリ名の表示上限。ファイル名は制限なく長くできるため個別にも切り詰める。 */
const MAX_ENTRY_NAME_LENGTH = 100;

/**
 * ファイル名は`runner.ts`の`handleApproval`や`sanitizeForLog`が扱うCLI・エージェント
 * 由来の文字列と同じく信用しない（design.md §16.9セキュリティ監査 medium 1）。
 * ファイル名には改行を含められるため、無害化せずにプロンプトへ結合すると、偽の見出しや
 * 偽YAMLをファイル名に仕込んでプロンプトの構造を偽装できてしまう。
 *
 * 実体は`untrustedText.ts`の`sanitizeInlineText`に委譲する（design.md §16.24、
 * Issue #369。ここに残していた独自実装は`roadmap.ts`側の同種の一覧（Issueタイトル・
 * workspaceSummary）から再利用できず、`buildRoadmapPrompt`が無防備なままになっていた）。
 */
function sanitizeEntryName(name: string): string {
  return sanitizeInlineText(name, MAX_ENTRY_NAME_LENGTH);
}

export async function buildWorkspaceSummary(
  root: string,
  port: PlannerWorkspacePort,
): Promise<WorkspaceSummary> {
  const [entries, hasAgentsMd, hasClaudeMd] = await Promise.all([
    port.listTopLevelEntries(root),
    port.fileExists(path.join(root, 'AGENTS.md')),
    port.fileExists(path.join(root, 'CLAUDE.md')),
  ]);
  return {
    topLevelEntries: entries.slice(0, MAX_TOP_LEVEL_ENTRIES).map(sanitizeEntryName),
    hasAgentsMd,
    hasClaudeMd,
  };
}

/** `node:fs/promises` を使う既定の実装。`runner.ts` の `nodeWorkflowFilePort` と同じ流儀。 */
export const nodePlannerWorkspacePort: PlannerWorkspacePort = {
  async listTopLevelEntries(root: string): Promise<string[]> {
    try {
      const entries = await fsPromises.readdir(root, { withFileTypes: true });
      return entries
        .filter((e) => !e.name.startsWith('.'))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  },
  async fileExists(filePath: string): Promise<boolean> {
    try {
      await fsPromises.access(filePath);
      return true;
    } catch {
      return false;
    }
  },
};

// ---- スキーマの説明（プロンプトの一部） ----

export interface SchemaDescriptionOptions {
  /**
   * 無人実行向けの指定（`defaults.autoApprove: true` と `allow`）を書かせるか
   * （design.md §16.9、issue #278）。
   *
   * 有効にするのは `agent.workflows.allowAutoApprove`（machineスコープ）が既にonのときだけ。
   * offのまま書かせても `clampAutoApprove` が無視して警告を足すだけで、YAMLと実際の挙動が
   * 食い違う説明を人に読ませることになる。
   */
  unattended?: boolean;
  /**
   * 分解に使っているエージェント（issue #321）。生成されるYAMLの `defaults.provider` へ
   * これを書くよう指示する。省略時は `DEFAULT_PROVIDER`。
   */
  provider?: Provider;
}

/**
 * `workflow.ts` の定数・型からスキーマの説明を組み立てる。
 *
 * 列挙値・上限・既定値は全て`workflow.ts`からimportした定数を文字列化しているだけで、
 * ここに数値や語彙を手で書き写さない。`workflow.ts`側の値が変われば、このプロンプトも
 * 再ビルドすれば自動的に追従する（二重管理を避ける。design.mdのタスク指示）。
 * フィールドの意味・必須かどうかの説明文（プローズ）は手で書くしかない部分で、
 * `test/unit/planner.test.ts` がフィールド名の記載漏れを検出する。
 */
export function buildSchemaDescription(options: SchemaDescriptionOptions = {}): string {
  const unattended = options.unattended ?? false;
  const provider = options.provider ?? DEFAULT_PROVIDER;
  return [
    '# ワークフロー定義（YAML）のスキーマ',
    '',
    '## ルート',
    '- version: 数値。1を指定する',
    '- name: ワークフロー名（文字列）',
    '- defaults: 省略可。省略時の既定値は次のとおり:' +
      ` provider=${DEFAULT_PROVIDER}, isolation=${DEFAULT_ISOLATION},` +
      ` maxParallel=${DEFAULT_MAX_PARALLEL}（${MAX_PARALLEL_MIN}〜${MAX_PARALLEL_MAX}）,` +
      ` maxIterations=${DEFAULT_MAX_ITERATIONS}（1〜${LOOP_ITERATION_LIMIT}）,` +
      ` cleanup=${DEFAULT_CLEANUP}, autoApprove=${DEFAULT_AUTO_APPROVE}`,
    // 分解に使っているエージェントと、出来たワークフローを実行するエージェントを
    // 揃える（issue #321）。書かれなかった場合は`ensureDefaultsProvider`が補う
    `- defaults.provider には ${provider} を書くこと（この分解を行っているエージェントに` +
      `合わせる。省略すると${DEFAULT_PROVIDER}で実行される）`,
    `- tasks: タスクの配列。1件以上、最大${MAX_TASK_COUNT}件`,
    '',
    '## タスク1件のフィールド',
    `- id（必須）: ワークフロー内で一意。文字種は正規表現 ${TASK_ID_PATTERN.source}` +
      '（半角英数字・アンダースコア・ハイフンのみ、1〜50文字、先頭にハイフンは使えない）',
    `- prompt（必須）: 最初に送る指示。${MAX_PROMPT_LENGTH}文字以内`,
    '- done（必須）: 終了条件。エージェントの応答を読まなくても外から判定できる書き方にすること' +
      '（例:「テストが通っている」。「頑張って実装した」のような自己申告に頼る書き方は避ける）',
    '- dependsOn（省略可、既定 []）: 先に完了していなければならないタスクidの配列。' +
      '並列に進められるタスクは別々のdependsOnに分け、合流させたい場合は両方をdependsOnに挙げた' +
      '合流タスクを置くこと',
    `- provider（省略可、既定 defaults.provider）: ${PROVIDERS.join(' または ')}`,
    `- isolation（省略可、既定 defaults.isolation）: ${ISOLATIONS.join(' または ')}`,
    `- continuePrompt（省略可、既定「${DEFAULT_CONTINUE_PROMPT}」）: 2回目以降に送る指示`,
    `- maxIterations（省略可、既定 defaults.maxIterations）: 1〜${LOOP_ITERATION_LIMIT}`,
    `- retries（省略可、既定 0）: 失敗時の自動再試行回数（上限${MAX_RETRIES}）`,
    '- issue（省略可）: 対応するIssue番号（正の整数）。指定するとPR/MRの本文へ' +
      'Closes #<番号>として出る。ロードマップの項目から変換する場合は、対応するIssue番号を' +
      'そのまま書き写すこと（無ければ省略する）',
    `- cleanup（省略可）: ${CLEANUP_MODES.join(' または ')}。タスク単位では指定できず defaults.cleanup に従う`,
    '- model / effort / approvalMode / sandbox（省略可）: 拡張機能側の設定より安全な方向にしか' +
      '動かせない。緩める指定は無視されるので、特別な理由がなければ書かないこと',
    unattended
      ? '- autoApprove（省略可、既定 false）: trueにすると危険と判定した要求以外を自動で許可する。' +
        'このワークフローは無人で実行するので、defaults へ autoApprove: true を書くこと'
      : '- autoApprove（省略可、既定 false）: trueにすると危険と判定した要求以外を自動で許可する。' +
        'このワークフローは人がレビューする前提の下書きなので、特別な理由がなければ指定しないこと',
    '- escalate（省略可、既定 []）: 自動承認しないコマンドのパターンを追加する',
    unattended
      ? '- allow（省略可、既定 []）: 既定の停止条件から外すパターン。' +
        `テストやビルドのコマンドはパイプ・リダイレクトを含むと ${DANGER_PATTERN_IDS.shellMetacharacters} に当たって` +
        `毎回人の承認を待つため、全てのタスクへ allow: [${DANGER_PATTERN_IDS.shellMetacharacters}] を書くこと` +
        '（allowはタスク単位のフィールドで、defaultsには書けない）。' +
        'それ以外のidは書かないこと（削除・force push・外部送信の停止条件を外すことになる）'
      : '- allow（省略可、既定 []）: 既定の停止条件から外すパターン。特別な理由がなければ指定しないこと',
    '',
    '## テンプレート変数',
    `依存タスクの結果を差し込みたい場合だけ、prompt内に {{<id>.<field>}} と書く。` +
      `<id>はdependsOnに挙げたタスクidに限り、<field>は ${TEMPLATE_FIELDS.join(' | ')} のいずれか。` +
      '依存タスクの応答を無条件に前置きする必要はない',
    '**dependsOnに挙げていないタスクを参照してはならない。** 依存を増やせない場合' +
      '（ロードマップの依存をそのまま写す場合など）は、テンプレート変数を使わず、' +
      '必要なことをpromptの文章として直接書くこと。',
    '各タスクは独立したgit worktreeで走り、成果は統合ブランチを介して次のタスクへ渡る。' +
      '他タスクの作業ディレクトリやブランチを直接読む必要はないため、' +
      '{{<id>.cwd}} や {{<id>.branch}} は基本的に書かないこと。',
    '',
    '未知のフィールドは読み飛ばされる。',
  ].join('\n');
}

// ---- プロンプトの組み立て ----

export interface BuildPlannerPromptInput {
  goal: string;
  workspaceSummary: WorkspaceSummary;
  /**
   * ロードマップの一部をタスク分解の材料として渡す場合に使う（design.md §16.19 2段目
   * 「ロードマップからYAML」）。整形済みのテキストブロックをそのまま埋め込む。
   * `roadmap.ts` の `formatRoadmapMaterial` が組み立てる（この関数自体はロードマップの
   * 型を知らない。文字列を受け取るだけにして、planner.ts と roadmap.ts の循環import を避ける）。
   */
  roadmapMaterial?: string;
  /**
   * 無人実行向けの指定を書かせるか（`buildSchemaDescription` へそのまま渡す。issue #278）。
   */
  unattended?: boolean;
  /**
   * 分解に使っているエージェント（`buildSchemaDescription` へそのまま渡す。issue #321）。
   */
  provider?: Provider;
}

function describeWorkspace(summary: WorkspaceSummary): string {
  const entries =
    summary.topLevelEntries.length > 0
      ? summary.topLevelEntries.join(', ')
      : '（取得できませんでした）';
  return [
    '## 現在のワークスペースの情報',
    `- 直下の構成: ${entries}`,
    `- AGENTS.md: ${summary.hasAgentsMd ? 'あり' : 'なし'}`,
    `- CLAUDE.md: ${summary.hasClaudeMd ? 'あり' : 'なし'}`,
  ].join('\n');
}

const OUTPUT_FORMAT_INSTRUCTION =
  '## 出力形式（厳守）\n' +
  '出力はYAMLのみとすること。説明文・前置き・コードフェンスなど、YAML以外の文字を' +
  '一切含めないこと';

/**
 * ゴール文の展開に設ける長さ上限。人が直接入力する値だが、ロードマップの生成セッション
 * （LLM）が組み立てた`buildRoadmapPlanGoal`の返値がここへ渡ることもあり、由来を問わず
 * 一律に上限を設ける（design.md §16.24、Issue #369）。
 */
const MAX_GOAL_LENGTH = 8000;

/**
 * ゴール文からタスク分解のYAMLを作らせるための最初のプロンプト（design.md §16.9）。
 *
 * このセッションは`sandbox: read-only`相当・承認は全拒否で起動する（`planWorkflow`側の
 * 設定）。「タスクを実行しないでください」という指示はここにも書くが、それは補助であって、
 * 実際に実行できない設定になっていることが本来の防御である（design.md §16.9「プロンプトで
 * 頼むだけでは足りない」）。
 *
 * `input.goal`は`untrustedText.ts`の`formatUntrusted`で囲う（design.md §16.24、
 * Issue #369）。以前は無加工・上限なしで連結していた。
 */
export function buildPlannerPrompt(input: BuildPlannerPromptInput): string {
  const parts = [
    'あなたはワークフロー定義（YAML）の作成担当です。次のゴールを、依存関係を持つ' +
      'タスクへ分解し、下記スキーマに従うYAML定義だけを出力してください。',
    '実際にタスクを実行することはしないでください（読み取りと提案のみ）。',
    '',
    `## ゴール\n${formatUntrusted(input.goal, { id: 'planner', field: 'goal', maxLength: MAX_GOAL_LENGTH, preserveNewlines: true })}`,
    '',
  ];
  if (input.roadmapMaterial !== undefined && input.roadmapMaterial !== '') {
    parts.push(input.roadmapMaterial, '');
  }
  parts.push(
    describeWorkspace(input.workspaceSummary),
    '',
    buildSchemaDescription({
      unattended: input.unattended ?? false,
      provider: input.provider ?? DEFAULT_PROVIDER,
    }),
    '',
    '## 分解の指針',
    '- 並列に進められるタスクは、それぞれ独立したタスクとして分け、dependsOnで直列にしないこと',
    '- 並列に走らせたタスクの結果を統合・レビューする合流タスクを置くこと' +
      '（design.md §16.4のテンプレート変数で各タスクの結果を参照できる）',
    '- 全てのタスクにdoneを書くこと。外から判定できる終了条件にすること',
    '',
    OUTPUT_FORMAT_INSTRUCTION,
  );
  return parts.join('\n');
}

/**
 * 検証に落ちたときの再生成プロンプト（design.md §16.9「もう1度だけ投げ直す」）。
 *
 * `previousYaml`（直前のLLM応答）は`formatUntrusted`等の囲いを通さず、そのまま埋め込む。
 * 同一セッションへの折り返し（分解セッション自身の直前の応答を、同じセッションへ
 * 再度渡すだけ）であり、信頼境界を跨がないため。将来この値を別のセッション（別の
 * 権限・別の指示文脈を持つセッション）へ渡す変更を加える場合は、`untrustedText.ts`の
 * `formatUntrusted`を通すこと。
 */
export function buildRetryPrompt(previousYaml: string, errors: readonly WorkflowIssue[]): string {
  const errorLines = errors
    .map((e) => `- ${e.taskIds.length > 0 ? `[${e.taskIds.join(', ')}] ` : ''}${e.message}`)
    .join('\n');
  return [
    '直前に出力したYAMLは、次の検証エラーにより受理できませんでした。' +
      'エラーを踏まえて修正したYAML定義だけを出力してください。',
    '',
    '## 前回のYAML',
    previousYaml,
    '',
    '## 検証エラー',
    errorLines,
    '',
    OUTPUT_FORMAT_INSTRUCTION,
  ].join('\n');
}

// ---- 応答からのYAML抽出 ----

/** ```yaml ... ``` / ``` ... ``` の最初のコードフェンスを拾う。 */
const FENCE_PATTERN = /```(?:ya?ml)?\r?\n([\s\S]*?)```/i;
/** コードフェンスが無いとき、YAMLのルートキーが現れる行を本文の開始とみなす。 */
const ROOT_KEY_PATTERN = /^(version|name|defaults|tasks)\s*:/m;

/**
 * 分解セッションの応答からYAML本文を取り出す（design.md §16.9「コードフェンスで囲まれて
 * 返ることが多いので、剥がしてからパーサへ渡す」）。
 *
 * 優先順位: 1) 最初のコードフェンスの中身 2) フェンスが無ければ、ルートキー
 * （version/name/defaults/tasks）が最初に現れる行から末尾まで 3) それも無ければ応答全体。
 * 3)はほぼ確実にparseWorkflowYamlが例外を投げ、通常の再試行経路に合流する。
 */
export function extractYamlFromResponse(response: string): string {
  const fenceMatch = FENCE_PATTERN.exec(response);
  const fenced = fenceMatch?.[1];
  if (fenced !== undefined) {
    return fenced.trim();
  }
  const rootKeyMatch = ROOT_KEY_PATTERN.exec(response);
  if (rootKeyMatch !== null) {
    return response.slice(rootKeyMatch.index).trim();
  }
  return response.trim();
}

// ---- 生成物のセキュリティ警告（design.md §16.9「通常の検証エラーとは別に強調して知らせる」） ----

export interface SecurityWarning {
  taskId: string;
  kind: 'autoApprove' | 'allow' | 'sandbox' | 'approvalMode';
  message: string;
}

/**
 * 生成されたYAMLに、既定の安全設定を上書きする指定が含まれていないかを調べる。
 *
 * `autoApprove: true` と非空の `allow` はYAMLに書かれているだけで無条件に警告する
 * （machineスコープの設定が許していても、生成物としては目立たせる。design.md §16.9）。
 * `sandbox` / `approvalMode` は「拡張機能側の設定より緩い指定」だけを対象にする。
 * `workflow.ts` の `clampSandbox` / `clampCodexApprovalMode` / `clampClaudePermissionMode` を
 * そのまま使い、`runner.ts` の実行時クランプと判定基準を1つに保つ（design.md §16.16）。
 */
export function detectSecurityWarnings(
  def: WorkflowDefinition,
  baseline: ExtensionSafetyBaseline,
): SecurityWarning[] {
  const warnings: SecurityWarning[] = [];
  for (const task of def.tasks) {
    if (task.autoApprove) {
      warnings.push({
        taskId: task.id,
        kind: 'autoApprove',
        message: `${task.id}: autoApprove: true が指定されています。無人実行の設定なので内容を確認してください`,
      });
    }
    if (task.allow.length > 0) {
      warnings.push({
        taskId: task.id,
        kind: 'allow',
        message: `${task.id}: allow で危険操作チェックの一部を解除しています: ${task.allow.join(', ')}`,
      });
    }

    const approvalBaseline =
      task.provider === 'claude' ? baseline.claudePermissionMode : baseline.codexApprovalMode;
    const approvalResult =
      task.provider === 'claude'
        ? clampClaudePermissionMode(approvalBaseline, task.approvalMode ?? '')
        : clampCodexApprovalMode(approvalBaseline, task.approvalMode ?? '');
    if (approvalResult.warning !== undefined) {
      warnings.push({
        taskId: task.id,
        kind: 'approvalMode',
        message: `${task.id}: approvalModeが既定の安全設定より緩く指定されています（${task.approvalMode}）`,
      });
    }

    if (task.provider === 'codex') {
      const sandboxResult = clampSandbox(baseline.codexSandbox, task.sandbox ?? '');
      if (sandboxResult.warning !== undefined) {
        warnings.push({
          taskId: task.id,
          kind: 'sandbox',
          message: `${task.id}: sandboxが既定の安全設定より緩く指定されています（${task.sandbox}）`,
        });
      }
    }
  }
  return warnings;
}

const SECURITY_FIELD_PATTERN: Record<SecurityWarning['kind'], RegExp> = {
  autoApprove: /^\s*autoApprove\s*:/,
  allow: /^\s*allow\s*:/,
  sandbox: /^\s*sandbox\s*:/,
  approvalMode: /^\s*approvalMode\s*:/,
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * セキュリティ警告に対応する行番号（1始まり）を、生成されたYAMLのテキストから
 * best-effortで探す。`yaml`パッケージのposition情報は使わない（テキスト上の該当タスクの
 * ブロック内を探すだけで十分な精度があり、パーサの作り直しをするほどの重みではない）。
 * 見つからなければ、そのタスクの `id:` 行を返す。タスク自体が見つからなければ `undefined`。
 */
export function locateSecurityWarningLine(
  yamlText: string,
  taskId: string,
  kind: SecurityWarning['kind'],
): number | undefined {
  const lines = yamlText.split('\n');
  const idPattern = new RegExp(`^\\s*-?\\s*id\\s*:\\s*["']?${escapeRegExp(taskId)}["']?\\s*$`);
  const nextTaskPattern = /^\s*-\s*id\s*:/;

  let taskStart = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (idPattern.test(lines[i] ?? '')) {
      taskStart = i;
      break;
    }
  }
  if (taskStart === -1) {
    return undefined;
  }

  let taskEnd = lines.length;
  for (let i = taskStart + 1; i < lines.length; i += 1) {
    if (nextTaskPattern.test(lines[i] ?? '')) {
      taskEnd = i;
      break;
    }
  }

  const fieldPattern = SECURITY_FIELD_PATTERN[kind];
  for (let i = taskStart; i < taskEnd; i += 1) {
    if (fieldPattern.test(lines[i] ?? '')) {
      return i + 1;
    }
  }
  return taskStart + 1;
}

// ---- ファイル名（design.md §16.9「ゴール文から作った短いスラッグ」） ----

/** ファイル名として使えない文字。制御文字も含めて空白に潰す。 */
const UNSAFE_FILENAME_CHARS = /[\\/:*?"<>|\u0020\u002d]/gu;
/**
 * ゴール文に混じったファイルパスらしき断片。
 *
 * 「`docs/plan/x.md` を読んで」のようなゴールをそのままファイル名にすると、パス区切りが
 * 潰れて `docs-plan-x.md...` という読みにくい名前になる（実測: issue #328）。パスの部分は
 * ファイル名（拡張子なし）へ縮めてから残りと繋ぐ。
 *
 * **ASCIIのパス構成文字だけで書かれ、拡張子で終わるものに限る。** 「認証 機能/を追加」の
 * ように区切り文字を別の意味で使っている日本語混じりの文まで巻き込むと、意味のある語が
 * 落ちてしまうため（区切りの前後が日本語ならパスとみなさない）。
 */
const PATH_LIKE_TOKEN = /(?:[A-Za-z0-9._-]+[\\/])+([A-Za-z0-9._-]+)\.[A-Za-z0-9]{1,8}/gu;
const WINDOWS_RESERVED_FILENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const SLUG_MAX_LENGTH = 40;
/**
 * 人が入力欄で付けられる名前の上限（`validateSlugInput`）。自動生成の `SLUG_MAX_LENGTH`
 * より緩い。機械的に切り詰めた既定値と違い、人が意図して付けた名前は途中で切りたくない。
 */
const SLUG_INPUT_MAX_LENGTH = 80;

/**
 * ゴール文から短いスラッグを作る。日本語のゴール文をローマ字化する依存ライブラリは
 * 使わず、ファイル名として不正な文字だけを除いて元の文字（漢字・かな含む）を残す
 * （UTF-8のファイル名はLinux/macOS/Windowsのいずれでも問題なく扱える。それより、
 * ローマ字化で意味が失われるほうが「ゴール文から作った」スラッグの目的に反する）。
 *
 * `stripControlChars`（`sanitize.ts`）を先に通す。ゴール文は人が直接入力する値だが、
 * 双方向制御文字・ゼロ幅文字を含む値がそのままファイル名（＝タブ・ファイル一覧に出る
 * 表示文字列）へ入り込むのを防ぐ、既存のワークフロー機能と同じ防御線を通しておく。
 */
/**
 * ゴール文からファイルパスらしき断片を取り除き、そのファイル名（拡張子なし）へ縮める。
 * `slugifyGoal` の前処理。`roadmap.ts` 側の `slugifyGoal` も同じ前処理を通すため、
 * 実装はここ1つに置いて共有する（`roadmap.ts` は `planner.ts` を参照しているので、
 * この向きの依存なら循環しない）。
 */
export function stripPathLikeTokens(goal: string): string {
  return goal.replace(PATH_LIKE_TOKEN, (_match, base: string) => base);
}

/**
 * 人が入力したファイル名（拡張子なし）を検証する。問題があれば理由を返す
 * （`vscode.window.showInputBox` の `validateInput` へそのまま渡せる形）。
 *
 * `slugifyGoal` が作る既定値は必ずこの検証を通るが、利用者はそれを編集できるため、
 * パス区切りを書いて出力先の外へ出ることを防ぐ必要がある（出力先の解決側でも検証して
 * いるが、入口でも弾いて理由をその場で見せる）。
 */
export function validateSlugInput(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === '') {
    return 'ファイル名を入力してください';
  }
  if (trimmed !== stripControlChars(trimmed)) {
    return '制御文字は使えません';
  }
  if (/[\\/:*?"<>|]/u.test(trimmed)) {
    return 'パス区切り・記号（\\ / : * ? " < > |）は使えません';
  }
  if (trimmed === '.' || trimmed === '..') {
    return 'ファイル名として使えません';
  }
  if (WINDOWS_RESERVED_FILENAME.test(trimmed)) {
    return 'Windowsの予約名は使えません';
  }
  if (trimmed.length > SLUG_INPUT_MAX_LENGTH) {
    return `${SLUG_INPUT_MAX_LENGTH}文字以内にしてください`;
  }
  return undefined;
}

export function slugifyGoal(goal: string): string {
  const collapsed = stripPathLikeTokens(stripControlChars(goal))
    .replace(UNSAFE_FILENAME_CHARS, ' ')
    .trim()
    .replace(/\s+/gu, '-');
  const trimmedDashes = collapsed.replace(/^-+|-+$/gu, '');
  const truncated = trimmedDashes.slice(0, SLUG_MAX_LENGTH).replace(/-+$/gu, '');
  if (truncated === '' || WINDOWS_RESERVED_FILENAME.test(truncated)) {
    return 'workflow';
  }
  return truncated;
}

/** 同名があれば `-2` `-3` ... と連番を足す（design.md §16.9）。 */
export function resolveUniqueFileName(
  slug: string,
  existingBaseNames: ReadonlySet<string>,
): string {
  if (!existingBaseNames.has(slug)) {
    return slug;
  }
  let n = 2;
  while (existingBaseNames.has(`${slug}-${n}`)) {
    n += 1;
  }
  return `${slug}-${n}`;
}

// ---- 生成の実行 ----

export interface PlanWorkflowInput {
  goal: string;
  workspaceSummary: WorkspaceSummary;
  /** 分解セッションに使うプロバイダ（design.md §16.9「defaults.providerと同じ既定」）。 */
  provider: Provider;
  /** `chat` / `claudeChat`（`TaskSessionHost`実装）。`provider`に対応する側を渡すこと。 */
  host: TaskSessionHost;
  /** 分解セッションの作業ディレクトリ。読み取り専用なのでworktreeは作らない。 */
  cwd: string;
  /** #52のクランプ基準（design.md §16.16）。 */
  baseline: ExtensionSafetyBaseline;
  log: Logger;
  /** `buildPlannerPrompt`にそのまま渡す（design.md §16.19 2段目）。 */
  roadmapMaterial?: string;
}

export interface PlanWorkflowSuccess {
  ok: true;
  /** コードフェンスを剥がし、未依存のテンプレート変数を落とした後のYAML本文。そのままファイルへ保存できる。 */
  yaml: string;
  definition: WorkflowDefinition;
  /**
   * `dependsOn` に挙げていないタスクを参照していたため落としたテンプレート変数
   * （`dropUndeclaredTemplateRefs`）。空でなければ、参照が消えて意味が通らなくなった箇所が
   * ありうるので人へ知らせること。
   */
  droppedTemplateRefs: readonly DroppedTemplateRef[];
  /** 空でなければ、保存前に強調して知らせること（design.md §16.9）。 */
  securityWarnings: readonly SecurityWarning[];
  attempts: 1 | 2;
}

export interface PlanWorkflowFailure {
  ok: false;
  /** 2回とも検証を通らなかったときの、2回目の生の応答（コードフェンス抽出前）。 */
  rawResponse: string;
  attempts: 2;
  lastErrors: readonly WorkflowIssue[];
}

export type PlanWorkflowResult = PlanWorkflowSuccess | PlanWorkflowFailure;

interface ParseAttempt {
  ok: boolean;
  definition: WorkflowDefinition | undefined;
  errors: WorkflowIssue[];
}

function tryParseAndValidate(yamlText: string): ParseAttempt {
  // `runner.ts`はファイルから読む定義に対して`MAX_WORKFLOW_FILE_BYTES`を必ず確認して
  // からパースするが、LLMの応答は検査なしで`parseWorkflowYaml`へ渡っていた
  // （#58セキュリティ監査 medium 2）。`MAX_PROMPT_LENGTH`/`MAX_TASK_COUNT`は
  // `validateWorkflow`の中、つまりパースが終わった後にしか効かないため、巨大な応答は
  // `yaml`パッケージの`parse`自体（パース前のtokenize等）を無検査で走らせてしまう。
  // 同じ上限をパース直前に確認する（`runner.ts`と同じ定数を再利用し、値の二重管理を避ける）
  const byteLength = Buffer.byteLength(yamlText, 'utf8');
  if (byteLength > MAX_WORKFLOW_FILE_BYTES) {
    return {
      ok: false,
      definition: undefined,
      errors: [
        {
          taskIds: [],
          message: `応答が大きすぎるため解析しませんでした（上限${MAX_WORKFLOW_FILE_BYTES}バイト、実際は${byteLength}バイト）`,
        },
      ],
    };
  }
  let def: WorkflowDefinition;
  try {
    def = parseWorkflowYaml(yamlText);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      definition: undefined,
      errors: [{ taskIds: [], message: `YAMLの解析に失敗しました: ${message}` }],
    };
  }
  const validation = validateWorkflow(def);
  if (validation.errors.length > 0) {
    return { ok: false, definition: def, errors: validation.errors };
  }
  return { ok: true, definition: def, errors: [] };
}

/**
 * Codexの分解セッションで使う`approvalMode`。
 *
 * **安全順序表の先頭（`untrusted`）ではなく`never`を使う。** 分解セッションは承認要求を
 * 理由を問わず全て拒否する（`sendSingleTurn`）ため、`untrusted`（信頼済み以外は全て承認を
 * 求める）と組み合わせると、read-onlyサンドボックスの中で完結する単なるファイル読みまで
 * 一律で拒否されてしまう。実際に材料を読もうとしたコマンドが拒否され、中身の無い応答しか
 * 返らずロードマップ・ワークフローの生成が成立しなかった（issue #266）。
 *
 * `never`は「承認を求めず、サンドボックスの中でできることだけをする」という意味であり、
 * サンドボックスを出る必要がある操作は承認へ回らずそのまま失敗する。分解セッションに
 * 与えたい権限（ワークスペースの読み取りだけ）とちょうど一致する。一次防御は引き続き
 * `sandbox: read-only`が担う（design.md §16.9「一次防御はサンドボックス」）。
 */
const PLANNER_CODEX_APPROVAL_MODE: ApprovalMode = 'never';

/**
 * Claudeの分解セッションで使う`permissionMode`。
 *
 * こちらも安全順序表の先頭（`plan`）は使わない。`plan`はモデルに計画を立てさせて
 * `ExitPlanMode`で承認を求めさせるモードであり、承認を全て拒否する分解セッションでは
 * 計画が却下されたまま終わる。「YAML（またはMarkdown）だけを出力せよ」という分解
 * セッションの指示ともかみ合わない。
 *
 * `manual`（公式ドキュメントの表記では`default`。CLIの表示名がManual）は
 * 「What runs without asking: Reads only」であり、読み取りは承認を経ずに通り、書き込みや
 * コマンド実行は承認要求として現れて`sendSingleTurn`が拒否する。Codex側の`never`+
 * read-onlyサンドボックスと同じ権限になる。
 */
const PLANNER_CLAUDE_PERMISSION_MODE: ClaudePermissionMode = 'manual';

/**
 * コマンド引数で渡されたプロバイダの手がかりを`Provider`へ解決する（issue #266）。
 *
 * チャット画面のアイコンから起動したときは、その画面のプロバイダが
 * `executeCommand('agent.workflows.menu', 'claude')` のように引数で届く。ただし
 * `executeCommand` は拡張機能の外からも呼べるため、値は信用せず`isProvider`を通す。
 * 未知の値・欠落はどちらも`undefined`（起動元を特定できなかった）として返し、
 * 呼び出し側がその場で選ばせる。
 */
export function providerHintToProvider(hint: unknown): Provider | undefined {
  return typeof hint === 'string' && isProvider(hint) ? hint : undefined;
}

/** 分解セッションの`approvalMode`（Codex）/`permissionMode`（Claude）。 */
function plannerApprovalModeFor(provider: Provider): string {
  return provider === 'claude' ? PLANNER_CLAUDE_PERMISSION_MODE : PLANNER_CODEX_APPROVAL_MODE;
}

/**
 * 分解セッションの`TaskSessionInput`を組み立てる。
 *
 * **`buildEffectiveTaskConfig`（#52。design.md §16.16の唯一の入口）を経由しない。**
 * 当初はこれを通していたが、`clampToSafer`は「baselineより緩めない」ための道具であり、
 * 「baselineが何であれ最安全を強制する」という分解セッションの要求とは意図が逆だった。
 * 拡張機能側の設定（`codex.sandbox`等）が既定の空文字（CLI側の設定に委譲する、の意）の
 * とき、`clampToSafer`は安全性を判定できずbaselineをそのまま採用してしまい、YAML側が
 * 最安全値を明示しても無視される抜け穴があった（#58セキュリティ監査 critical）。
 * `clampToSafer`自体も「YAML側が安全順序の最安全値なら採用する」よう直したが、
 * plannerはそもそもbaselineに依存する必要が無いため、ここでは固定値を直接使う
 * （baselineが何であっても分解セッションの権限は一定にするべきなので、「baselineより
 * 安全な方向にしか動かせない」という汎用クランプの意味論に頼らない）。
 *
 * 与える権限は「ワークスペースの読み取りだけ」で固定する。承認要求は全て拒否するため、
 * 承認を経ないと何も読めない設定（Codexの`untrusted`、Claudeの`plan`）を選ぶと、分解に
 * 必要な読み取りごと潰れて生成が成立しない（`PLANNER_CODEX_APPROVAL_MODE` /
 * `PLANNER_CLAUDE_PERMISSION_MODE`のコメント、issue #266）。
 *
 * プロンプトでの指示ではなく、この関数が組み立てる起動設定こそが縛りの実体である
 * （design.md §16.9「プロンプトで頼むだけでは足りない」）。
 */
/**
 * `roadmap.ts`（design.md §16.19「生成セッションは§16.9の分解セッションと同じ制限
 * （`sandbox: read-only`相当、承認要求は全て拒否）で走らせる」）からも使う共通の組み立て。
 * 両者は同じ安全要件を持つ別のユースケース（ワークフロー分解／ロードマップ生成）のため、
 * 独自に作り直さず、ここで唯一の実装として`export`する（`detectForgeHost`等を`forge.ts`
 * 一箇所に集約したのと同じ「重複を残さない」判断）。
 */
export function buildPlannerSessionInput(provider: Provider, cwd: string): TaskSessionInput {
  return {
    cwd,
    config: { model: '', effort: '', approvalMode: plannerApprovalModeFor(provider) },
    sandbox: SANDBOX_MODES[0],
  };
}

/**
 * `buildPlannerSessionInput`が組み立てた値が、分解セッション用に決めた固定値から
 * ずれていないかを起動直前に確かめる。`runner.ts`の`startTask`が実効`approvalMode`について
 * `bypassPermissions`を弾く最終防御と同じ形（design.md §16.16セキュリティ監査対応）。
 *
 * 通常のコード経路では`buildPlannerSessionInput`の戻り値をそのまま渡すだけなので
 * 一致しないことはありえないが、将来ここへ`buildEffectiveTaskConfig`のような
 * baseline依存のクランプが再び挟まれた場合や、呼び出し側の実装ミスで安全でない値が
 * 混入した場合に、プロンプトでの指示だけに頼らず起動そのものを止める最後の砦にする。
 */
function assertPlannerSessionIsSafe(provider: Provider, input: TaskSessionInput): void {
  const expectedApprovalMode = plannerApprovalModeFor(provider);
  if (input.config.approvalMode !== expectedApprovalMode) {
    throw new Error(
      '分解セッションの実効approvalModeが期待値と一致しないため、' +
        `起動を中止しました（実効値: "${input.config.approvalMode}", 期待値: "${expectedApprovalMode}"）`,
    );
  }
  if (provider === 'codex' && input.sandbox !== SANDBOX_MODES[0]) {
    throw new Error(
      '分解セッションの実効sandboxが期待値と一致しないため、' +
        `起動を中止しました（実効値: "${input.sandbox}", 期待値: "${SANDBOX_MODES[0]}"）`,
    );
  }
}

/**
 * 分解専用のセッションを1つ開き、1ターンだけ送って応答を受け取り、閉じる。
 *
 * `TaskSession.runLoop`（`LoopController`）を`maxIterations: 1, condition: ''`で使う。
 * `condition`が空文字なら`decoratePrompt`は何も付け足さない（`loopController.ts`参照）ため、
 * 「YAMLのみを出力する」というこちらの指示とLOOP_DONEの合図が混ざらない。1回送った時点で
 * `maxReached`として`onFinished`が呼ばれるので、そこで`state.turnResultText`を受け取る。
 *
 * 承認要求は理由を問わず全て拒否する（design.md §16.9「承認要求は全て拒否する」）。
 * `escalation.ts`の危険判定は経由しない。分解セッションに「妥当な危険操作」という
 * カテゴリは無く、判定するまでもなく拒否してよいため。
 */
/** `roadmap.ts`からも使う（`buildPlannerSessionInput`と同じ理由でexportする）。 */
export async function sendSingleTurn(
  host: TaskSessionHost,
  provider: Provider,
  input: TaskSessionInput,
  prompt: string,
): Promise<string> {
  assertPlannerSessionIsSafe(provider, input);
  const session = await host.openTaskSession(input);
  session.setApprovalHandler(async () => ({ kind: 'auto', decision: 'decline' }));
  session.open({ preserveFocus: true });
  try {
    return await new Promise<string>((resolve, reject) => {
      session.onFinished((reason, state) => {
        if (reason === 'failed') {
          reject(new Error('分解セッションのターンが失敗しました'));
          return;
        }
        resolve(state.turnResultText);
      });
      session.runLoop({
        initialPrompt: prompt,
        continuePrompt: '',
        maxIterations: 1,
        condition: '',
      });
    });
  } finally {
    // design.md §16.9「生成が終わったらセッションを閉じる」。1ターンごとに新しいセッション
    // を開くため（`runner.ts`の再試行が新しいセッションを作るのと同じ流儀）、ここで閉じる
    session.dispose();
  }
}

/**
 * 応答からYAMLを取り出し、`dependsOn` に挙げていないタスクを参照するテンプレート変数を
 * 落としてから返す。
 *
 * 修復を検証の前に置くのは、この誤りが再生成で直らないため。ロードマップ経路では依存を
 * 増やすことを禁じているので、モデルは参照を消すしか辻褄の合わせようがないが、実際には
 * 同じ参照を書き続けて2回とも失敗する（`dropUndeclaredTemplateRefs`のコメント参照）。
 */
function extractAndRepair(
  response: string,
  provider: Provider,
): { yaml: string; dropped: DroppedTemplateRef[] } {
  const extracted = extractYamlFromResponse(response);
  const repaired = dropUndeclaredTemplateRefs(extracted);
  // 分解に使ったエージェントを実行にも引き継ぐ（issue #321）。プロンプトで指示しても
  // 書かれないことがあるため、検証にかける前に補う。明示されていれば上書きしない
  const withProvider = ensureDefaultsProvider(repaired.yaml, provider);
  return { yaml: withProvider.yaml, dropped: repaired.dropped };
}

/**
 * ゴール文からワークフロー定義（YAML）を生成する（design.md §16.9）。
 *
 * 1. 分解セッションへゴール・スキーマ・ワークスペース情報を渡し、YAMLの生成を頼む
 * 2. 応答からYAMLを取り出し、`workflow.ts`の検証にかける
 * 3. 通らなければ、検証エラーを添えてもう1度だけ（新しいセッションで）投げ直す
 * 4. それでも通らなければ、2回目の生の応答を`ok: false`で返す（エディタで開くのは呼び出し側）
 *
 * 実行（`WorkflowRunner.start`）は一切呼ばない。この関数はYAML文字列を作るだけで、
 * ワークフローを走らせる手段を持たない（design.md §16.13「生成したまま自動で実行しない」）。
 */
export async function planWorkflow(input: PlanWorkflowInput): Promise<PlanWorkflowResult> {
  const sessionInput = buildPlannerSessionInput(input.provider, input.cwd);

  const firstPrompt = buildPlannerPrompt({
    goal: input.goal,
    workspaceSummary: input.workspaceSummary,
    // `exactOptionalPropertyTypes`下では`roadmapMaterial: undefined`を明示的に
    // 書き込めない（プロパティ自体の省略と`undefined`代入を区別する）ため、
    // 値がある場合だけキーを足す（`runner.ts`の`mcp`と同じ書き方）
    ...(input.roadmapMaterial !== undefined ? { roadmapMaterial: input.roadmapMaterial } : {}),
    // 無人実行を許した環境（machineスコープ設定がon）でだけ、生成の時点でその形にする
    unattended: input.baseline.allowAutoApprove,
    // 分解に使ったエージェントを、そのまま実行にも使う（issue #321）
    provider: input.provider,
  });
  const firstResponse = await sendSingleTurn(input.host, input.provider, sessionInput, firstPrompt);
  const first = extractAndRepair(firstResponse, input.provider);
  const firstYaml = first.yaml;
  const firstAttempt = tryParseAndValidate(firstYaml);
  if (firstAttempt.ok && firstAttempt.definition !== undefined) {
    return {
      ok: true,
      yaml: firstYaml,
      definition: firstAttempt.definition,
      securityWarnings: detectSecurityWarnings(firstAttempt.definition, input.baseline),
      droppedTemplateRefs: first.dropped,
      attempts: 1,
    };
  }

  input.log.warn(
    `[planner] 生成されたYAMLが検証を通らなかったため再生成します: ${firstAttempt.errors
      .map((e) => e.message)
      .join(' / ')}`,
  );
  const retryPrompt = buildRetryPrompt(firstYaml, firstAttempt.errors);
  const secondResponse = await sendSingleTurn(
    input.host,
    input.provider,
    sessionInput,
    retryPrompt,
  );
  const second = extractAndRepair(secondResponse, input.provider);
  const secondYaml = second.yaml;
  const secondAttempt = tryParseAndValidate(secondYaml);
  if (secondAttempt.ok && secondAttempt.definition !== undefined) {
    return {
      ok: true,
      yaml: secondYaml,
      definition: secondAttempt.definition,
      securityWarnings: detectSecurityWarnings(secondAttempt.definition, input.baseline),
      droppedTemplateRefs: second.dropped,
      attempts: 2,
    };
  }

  input.log.warn(
    `[planner] 再生成後もYAMLが検証を通らなかったため、生の応答を人に委ねます: ${secondAttempt.errors
      .map((e) => e.message)
      .join(' / ')}`,
  );
  return {
    ok: false,
    rawResponse: secondResponse,
    attempts: 2,
    lastErrors: secondAttempt.errors,
  };
}
