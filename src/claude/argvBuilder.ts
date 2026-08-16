import { isSessionId } from '../codex/argvBuilder';
import type { LaunchTarget } from '../codex/types';
import {
  CLAUDE_EFFORTS,
  CLAUDE_PERMISSION_MODES,
  type ClaudeConfig,
  type ClaudeEffort,
  type ClaudePermissionMode,
} from './types';

export interface ClaudeBuildInput {
  target: LaunchTarget;
  /**
   * 新規セッションのidを起動前に決めて `--session-id` で渡す。
   * Codexと違い事後の紐付けが要らない（`--session-id` はCLIが受け付ける）。
   */
  sessionId: string | undefined;
  cwd: string | undefined;
  config: ClaudeConfig;
}

export interface ClaudeBuildResult {
  args: string[];
  warnings: string[];
}

/** 全承認をスキップする指定。設定にもフラグにも現れうる。 */
const SKIP_PERMISSIONS_FLAGS = [
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
];

function isEffort(value: string): value is ClaudeEffort {
  return (CLAUDE_EFFORTS as readonly string[]).includes(value);
}

function isPermissionMode(value: string): value is ClaudePermissionMode {
  return (CLAUDE_PERMISSION_MODES as readonly string[]).includes(value);
}

/**
 * `--agent` に渡してよい形か。
 *
 * エージェント名はユーザー定義のカスタムエージェントを含むため固定の一覧で検証できない
 * （`isEffort` / `isPermissionMode` のような enum チェックが使えない）。代わりに
 * `codex/modelCatalog.ts` の `isEffortToken` と同じ考え方で、引数として安全な形だけを
 * 許す形式検証にする。先頭を英数字に限定することで `--foo` のような別のフラグに
 * 化けさせる余地を塞ぐ。実在するエージェント名（`code-reviewer` `genshijin:genshijin-builder`
 * など）はすべて通る。
 */
const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9_:-]*$/;

function isAgentToken(value: string): boolean {
  return AGENT_RE.test(value);
}

/**
 * TUIタブとして起動するための引数を組み立てる。
 *
 * `claude` には `-C` に相当する作業ディレクトリ指定が無いため、cwdは
 * `createTerminal({ cwd })` 側で与える（引数には現れない）。
 */
export function buildClaudeShellArgs(input: ClaudeBuildInput): ClaudeBuildResult {
  const args: string[] = [];
  const warnings: string[] = [];

  args.push(...targetArgs(input));
  args.push(...configArgs(input.config, warnings));

  return { args, warnings };
}

/**
 * Webviewチャット用。stdin/stdoutをNDJSONで繋いだまま常駐させる。
 * `--verbose` は stream-json 出力の前提条件で、`--print` 無しでは各フラグが効かない。
 *
 * `--permission-prompt-tool stdio` は承認要求をcontrol protocolへ流すための必須指定
 * （§14.5、issue #276）。これが無いと `--print` 経路のCLIは承認が要るツール呼び出しを
 * **拡張機能へ問い合わせないまま自動で拒否する**（実測: `bash -c "echo hi"` が
 * `This command requires approval` で失敗し、`can_use_tool` は一度も届かない。CLI 2.1.229）。
 * 承認カード・§16.7の危険判定・`autoApprove` は全て `can_use_tool` の到着が前提のため、
 * ここを落とすとそれらが丸ごと働かなくなる。TUIタブ（`buildClaudeShellArgs`）はCLI自身が
 * 承認を対話で聞くため付けない。
 */
export function buildClaudeStreamArgs(input: ClaudeBuildInput): ClaudeBuildResult {
  const warnings: string[] = [];
  const args = [
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--replay-user-messages',
    '--permission-prompt-tool',
    'stdio',
    ...targetArgs(input),
    ...configArgs(input.config, warnings),
  ];
  return { args, warnings };
}

/**
 * 起動対象の指定。idはUUID以外を受け付けない。
 * 値がそのままCLIの引数になるため、ここを緩めるとフラグを注入されうる。
 */
function targetArgs(input: ClaudeBuildInput): string[] {
  if (input.target.kind === 'new') {
    if (input.sessionId === undefined) {
      return [];
    }
    if (!isSessionId(input.sessionId)) {
      throw new Error(`不正なsession id: ${input.sessionId}`);
    }
    return ['--session-id', input.sessionId];
  }

  if (!isSessionId(input.target.sessionId)) {
    throw new Error(`不正なsession id: ${input.target.sessionId}`);
  }
  return input.target.kind === 'fork'
    ? ['-r', input.target.sessionId, '--fork-session']
    : ['-r', input.target.sessionId];
}

function configArgs(config: ClaudeConfig, warnings: string[]): string[] {
  const args: string[] = [];

  if (config.model !== '') {
    args.push('--model', config.model);
  }

  if (config.effort !== '') {
    if (isEffort(config.effort)) {
      args.push('--effort', config.effort);
    } else {
      warnings.push(`claude.effort の値が不正なため無視します: ${config.effort}`);
    }
  }

  if (config.permissionMode !== '') {
    if (isPermissionMode(config.permissionMode)) {
      args.push('--permission-mode', config.permissionMode);
    } else {
      warnings.push(`claude.permissionMode の値が不正なため無視します: ${config.permissionMode}`);
    }
  }

  if (config.agent !== '') {
    if (isAgentToken(config.agent)) {
      args.push('--agent', config.agent);
    } else {
      warnings.push(`claude.agent の値が不正なため無視します: ${config.agent}`);
    }
  }

  for (const extra of config.additionalArgs) {
    if (typeof extra !== 'string' || extra === '') {
      warnings.push('claude.additionalArgs に空または非文字列の要素があるため無視します');
      continue;
    }
    args.push(extra);
  }

  return args;
}

/**
 * 承認をすべて外す指定かどうか。起動前に確認ダイアログを出す
 * （Codexの `danger-full-access` + `never` と同じ扱い）。
 */
export function isUnsafeClaudeCombination(config: ClaudeConfig): boolean {
  if (config.permissionMode === 'bypassPermissions') {
    return true;
  }
  return config.additionalArgs.some((a) => SKIP_PERMISSIONS_FLAGS.includes(a));
}
