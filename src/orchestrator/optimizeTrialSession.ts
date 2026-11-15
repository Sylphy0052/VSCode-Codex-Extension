import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildClaudeTrialSandboxSettings,
  CLAUDE_TRIAL_DISALLOWED_TOOLS,
  type ClaudeSandboxEnvironment,
} from '../claude/sandbox';
import { CODEX_DENIED_FEATURES } from '../loop/headlessCli';
import {
  removeProcessRecord,
  writeProcessRecord,
  type ProcessRecordPorts,
} from './optimizeProcessRecord';

/**
 * 最適化の試行（Issue #2107）のセッション。拡張が直接起動するheadless CLIの1プロセスで、
 * 仮説の段（読み取り専用）と変更の段（候補のworktreeへの書き込みのみ）の2回行う。
 *
 * 既存の工程セッションは、Codexのapp-serverが`detached`なしで起動し、背景の端末も残るため、
 * 試行のプロセスだけを確実に止められない。ここでは`detached`で起動してプロセスグループを持たせ、
 * PID・グループID・開始時刻を記録し、終わったらグループごと止めて残りが無いことを確かめる。
 */

export type TrialEngine = 'claude' | 'codex';

export type TrialStage = 'hypothesis' | 'change';

export interface TrialEngineConfig {
  engine: TrialEngine;
  executable: string;
  /** 空または`auto`ならCLIの既定。 */
  model: string;
  effort?: string;
  /** Claudeのsandbox。`ClaudeSandboxProbe`で使えると確かめた環境を渡す。 */
  claudeSandbox?: ClaudeSandboxEnvironment;
  /** Claudeの変更の段で、sandboxの書き込みを明示的に塞ぐパス（共有の`.git`、基準・最良のworktree）。 */
  claudeDenyWrite?: readonly string[];
}

/** 仮説の段で使うClaudeのツール。書き込み系（Edit・Write・Bash）を含めない。 */
export const CLAUDE_HYPOTHESIS_TOOLS = 'Read,Glob,Grep';

/** 変更の段で使うClaudeのツール。Bashはsandbox内で動く。 */
export const CLAUDE_CHANGE_TOOLS = 'Read,Glob,Grep,Edit,Write,Bash';

/**
 * Codexで落とす能力。工程の脇役用（`CODEX_DENIED_FEATURES`）のうち、試行は作業ディレクトリの
 * コードを読み書きするためシェルだけ残す。外部アプリ・ブラウザ・プラグインは落としたまま。
 */
export const CODEX_TRIAL_DENIED_FEATURES: readonly string[] = CODEX_DENIED_FEATURES.filter(
  (feature) => feature !== 'shell_tool' && feature !== 'unified_exec',
);

const EFFORT_TOKEN = /^[A-Za-z0-9_-]{1,32}$/;

function modelArgs(model: string, flag: string): string[] {
  return model === '' || model === 'auto' ? [] : [flag, model];
}

export interface ClaudeTrialArgsInput {
  stage: TrialStage;
  model: string;
  effort?: string;
  sandbox: ClaudeSandboxEnvironment;
  /** sandboxの書き込みを明示的に塞ぐパス（変更の段のみ）。 */
  denyWrite?: readonly string[];
  /** 仮説の段の会話を続けるときのセッションID（変更の段のみ）。 */
  resumeSessionId?: string;
}

/**
 * Claudeの起動引数。`--setting-sources ""`で利用者のCLAUDE.md・hooks・skillsを読ませない。
 * 仮説の段は`--tools`で書き込み系を持たせない。変更の段は`--settings`のsandboxで、Bashの書き込みを
 * 作業ディレクトリに閉じる。`--disallowedTools`は可変長なので最後に置く。
 */
export function buildClaudeTrialArgs(input: ClaudeTrialArgsInput): string[] {
  const effort =
    input.effort !== undefined && EFFORT_TOKEN.test(input.effort) ? ['--effort', input.effort] : [];
  const common = [
    '-p',
    '--output-format',
    'json',
    '--setting-sources',
    '',
    ...modelArgs(input.model, '--model'),
    ...effort,
  ];
  if (input.stage === 'hypothesis') {
    return [...common, '--tools', CLAUDE_HYPOTHESIS_TOOLS, '--permission-mode', 'default'];
  }
  return [
    ...common,
    ...(input.resumeSessionId === undefined ? [] : ['--resume', input.resumeSessionId]),
    '--tools',
    CLAUDE_CHANGE_TOOLS,
    '--permission-mode',
    'acceptEdits',
    '--settings',
    JSON.stringify(buildClaudeTrialSandboxSettings(input.sandbox, input.denyWrite)),
    '--disallowedTools',
    CLAUDE_TRIAL_DISALLOWED_TOOLS.join(','),
  ];
}

export interface CodexTrialArgsInput {
  stage: TrialStage;
  model: string;
  effort?: string;
  outputFile: string;
}

/**
 * Codexの起動引数。仮説の段は`--sandbox read-only`、変更の段は`--sandbox workspace-write`
 * （ネットワークは`sandbox_workspace_write.network_access=false`で明示して無効にする）。
 * `exec resume`は使わず、毎回`--ephemeral`の新しいセッションにする。
 */
export function buildCodexTrialArgs(input: CodexTrialArgsInput): string[] {
  const effort =
    input.effort !== undefined && EFFORT_TOKEN.test(input.effort)
      ? ['-c', `model_reasoning_effort=${input.effort}`]
      : [];
  return [
    'exec',
    '--sandbox',
    input.stage === 'hypothesis' ? 'read-only' : 'workspace-write',
    '--ephemeral',
    '--ignore-user-config',
    '--skip-git-repo-check',
    ...CODEX_TRIAL_DENIED_FEATURES.flatMap((feature) => ['--disable', feature]),
    '-c',
    'tools.web_search=false',
    '-c',
    'shell_environment_policy.inherit=core',
    '-c',
    'sandbox_workspace_write.network_access=false',
    ...modelArgs(input.model, '-m'),
    ...effort,
    '-o',
    input.outputFile,
  ];
}

/** プロセスグループの操作。テストから差し替える。 */
export interface TrialProcessGroupPorts {
  /** グループ全体へシグナルを送る。グループが無ければ何もしない。 */
  killGroup(pgid: number, signal: NodeJS.Signals): void;
  /** グループにプロセスが残っているか。 */
  isGroupAlive(pgid: number): boolean;
  sleep(ms: number): Promise<void>;
}

export function defaultTrialProcessGroupPorts(): TrialProcessGroupPorts {
  return {
    killGroup: (pgid, signal) => {
      try {
        process.kill(-pgid, signal);
      } catch {
        // 既に空
      }
    },
    isGroupAlive: (pgid) => {
      try {
        process.kill(-pgid, 0);
        return true;
      } catch (e) {
        // EPERMは存在するが送れない
        return (e as NodeJS.ErrnoException).code === 'EPERM';
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** 認証に要る接頭辞。名前に`TOKEN`などを含んでも渡す。 */
const AUTH_ENV_PREFIXES = ['CLAUDE_', 'ANTHROPIC_', 'CODEX_', 'OPENAI_'];

const SECRET_ENV_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/iu;

/**
 * 試行のプロセスへ渡す環境変数。拡張の環境にある`GH_TOKEN`・`GITLAB_TOKEN`などを渡すと、
 * 変更の段が書き出して許可パスのファイルへ残せてしまうため、秘密らしい名前のものを外す。
 * CLI自身の認証（`CLAUDE_`・`ANTHROPIC_`・`CODEX_`・`OPENAI_`の接頭辞）は残す。
 */
export function trialEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    const isAuth = AUTH_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
    if (isAuth || !SECRET_ENV_NAME.test(name)) {
      kept[name] = value;
    }
  }
  return kept;
}

/** 標準出力を溜める上限。 */
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;

/** SIGTERMからSIGKILLへ上げるまでの猶予。 */
const TERM_GRACE_MS = 3_000;

/** グループが空になるのを待つ間隔と上限。 */
const GROUP_POLL_MS = 50;
const GROUP_WAIT_MS = 3_000;

export interface RunTrialProcessInput {
  executable: string;
  args: readonly string[];
  stdin: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  /** プロセスの記録（#2110）を置く場所。拡張のglobalStorage配下で、worktreeの外。 */
  recordDir: string;
  label: string;
  groupPorts?: TrialProcessGroupPorts;
  recordPorts?: ProcessRecordPorts;
  spawnFn?: typeof spawn;
}

export interface TrialProcessResult {
  /** 起動できなかったときは`undefined`。 */
  pid: number | undefined;
  stdout: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  /** 起動に失敗した、またはシグナルで終わった説明。 */
  error?: string;
  /** 終了後にSIGKILLを送っても、プロセスグループにプロセスが残っていた。記録も残す。 */
  groupRemains: boolean;
}

/**
 * 試行のプロセスを`detached`で起動し、終わるまで待つ。終わったら（時間の上限・中断も含めて）
 * プロセスグループごと止め、残っていないことを確かめてから返す。残っていたら
 * `groupRemains`を立て、プロセスの記録を消さない（再開のときに止められるように）。
 */
export async function runTrialProcess(input: RunTrialProcessInput): Promise<TrialProcessResult> {
  const ports = input.groupPorts ?? defaultTrialProcessGroupPorts();
  const spawnFn = input.spawnFn ?? spawn;
  if (input.signal?.aborted === true) {
    return {
      pid: undefined,
      stdout: '',
      exitCode: null,
      timedOut: false,
      aborted: true,
      groupRemains: false,
    };
  }
  let child: ChildProcess;
  try {
    child = spawnFn(input.executable, [...input.args], {
      cwd: input.cwd,
      detached: true,
      stdio: ['pipe', 'pipe', 'ignore'],
      // 指定が無ければ、秘密らしい環境変数を外した拡張の環境を渡す
      env: input['env'] ?? trialEnvironment(process['env']),
    });
  } catch (e) {
    return failedStart(e);
  }
  const pid = child.pid;
  const chunks: Buffer[] = [];
  let size = 0;
  let timedOut = false;
  let aborted = false;
  let spawnError: string | undefined;

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('error', (e) => {
      spawnError = e.message;
      resolve({ code: null, signal: null });
    });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  if (pid === undefined) {
    const result = await exited;
    return {
      pid: undefined,
      stdout: '',
      exitCode: result.code,
      timedOut: false,
      aborted: false,
      error: spawnError ?? '起動できませんでした',
      groupRemains: false,
    };
  }

  child.stdout?.on('data', (chunk: Buffer) => {
    if (size < MAX_STDOUT_BYTES) {
      chunks.push(chunk);
      size += chunk.length;
    }
  });
  child.stdin?.on('error', () => undefined);
  child.stdin?.end(input.stdin);

  // 中断は記録の書き込みを待つ間も取りこぼさないよう、先に登録する
  let killTimer: NodeJS.Timeout | undefined;
  const stop = (): void => {
    ports.killGroup(pid, 'SIGTERM');
    killTimer ??= setTimeout(() => ports.killGroup(pid, 'SIGKILL'), TERM_GRACE_MS);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, input.timeoutMs);
  const onAbort = (): void => {
    aborted = true;
    stop();
  };
  input.signal?.addEventListener('abort', onAbort, { once: true });
  // 起動の途中で中断されていた場合（上の確認は起動前なので、型の絞り込みを避けて関数で読む）
  const isAborted = (): boolean => input.signal?.aborted === true;
  if (isAborted()) {
    onAbort();
  }

  let recorded = false;
  try {
    await writeProcessRecord(
      input.recordDir,
      { pid, pgid: pid, label: input.label },
      input.recordPorts,
    );
    recorded = true;
  } catch {
    // 記録できなくても試行は続ける。終了後のグループ確認は同じように行う
  }

  const result = await exited;
  clearTimeout(timer);
  // 終了後にPIDが使い回されても、遅れたSIGKILLが無関係のグループへ届かないようにする
  clearTimeout(killTimer);
  input.signal?.removeEventListener('abort', onAbort);

  // 先頭が終わっても、孫がグループに残りうる。理由を問わずグループごと止める
  ports.killGroup(pid, 'SIGKILL');
  let waited = 0;
  while (ports.isGroupAlive(pid) && waited < GROUP_WAIT_MS) {
    await ports.sleep(GROUP_POLL_MS);
    waited += GROUP_POLL_MS;
    ports.killGroup(pid, 'SIGKILL');
  }
  const groupRemains = ports.isGroupAlive(pid);
  if (recorded && !groupRemains) {
    await removeProcessRecord(input.recordDir, pid).catch(() => undefined);
  }
  return {
    pid,
    stdout: Buffer.concat(chunks).toString('utf8'),
    exitCode: result.code,
    timedOut,
    aborted,
    ...(spawnError !== undefined
      ? { error: spawnError }
      : result.signal !== null
        ? { error: `シグナル${result.signal}で終了しました` }
        : {}),
    groupRemains,
  };
}

function failedStart(e: unknown): TrialProcessResult {
  return {
    pid: undefined,
    stdout: '',
    exitCode: null,
    timedOut: false,
    aborted: false,
    error: e instanceof Error ? e.message : String(e),
    groupRemains: false,
  };
}

export interface RunTrialStageInput {
  stage: TrialStage;
  prompt: string;
  /** 候補のworktree。 */
  cwd: string;
  engine: TrialEngineConfig;
  /** Claudeの変更の段で、仮説の段の会話を続けるときのセッションID。 */
  resumeSessionId?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  recordDir: string;
  env?: NodeJS.ProcessEnv;
  groupPorts?: TrialProcessGroupPorts;
  recordPorts?: ProcessRecordPorts;
  spawnFn?: typeof spawn;
}

export interface TrialStageResult {
  /** プロセスが正常に終わり、本文を取り出せた。 */
  ok: boolean;
  /** モデルの最終メッセージ。 */
  text: string;
  /** Claudeの`session_id`。 */
  sessionId?: string;
  failure?: string;
  process: TrialProcessResult;
}

interface ClaudeJsonResult {
  result?: unknown;
  session_id?: unknown;
  is_error?: unknown;
}

/** Claudeの`--output-format json`の応答から本文とセッションIDを取る。 */
export function parseClaudeTrialOutput(stdout: string): {
  text?: string;
  sessionId?: string;
  isError: boolean;
} {
  try {
    const parsed = JSON.parse(stdout) as ClaudeJsonResult | null;
    if (parsed === null || typeof parsed !== 'object') {
      return { isError: true };
    }
    return {
      ...(typeof parsed.result === 'string' ? { text: parsed.result } : {}),
      ...(typeof parsed.session_id === 'string' && parsed.session_id !== ''
        ? { sessionId: parsed.session_id }
        : {}),
      isError: parsed.is_error === true,
    };
  } catch {
    return { isError: true };
  }
}

/** 試行の1段を起動し、プロセスの終了と本文の取り出しまでを行う。 */
export async function runTrialStage(input: RunTrialStageInput): Promise<TrialStageResult> {
  const cfg = input.engine;
  let outputDir: string | undefined;
  let args: string[];
  let outputFile: string | undefined;
  if (cfg.engine === 'claude') {
    if (cfg.claudeSandbox === undefined) {
      throw new Error('Claudeの試行にはsandboxの確認結果が要ります');
    }
    args = buildClaudeTrialArgs({
      stage: input.stage,
      model: cfg.model,
      ...(cfg.effort === undefined ? {} : { effort: cfg.effort }),
      sandbox: cfg.claudeSandbox,
      ...(cfg.claudeDenyWrite === undefined ? {} : { denyWrite: cfg.claudeDenyWrite }),
      ...(input.resumeSessionId === undefined ? {} : { resumeSessionId: input.resumeSessionId }),
    });
  } else {
    outputDir = await mkdtemp(path.join(os.tmpdir(), 'optimize-trial-'));
    outputFile = path.join(outputDir, 'last-message.txt');
    args = buildCodexTrialArgs({
      stage: input.stage,
      model: cfg.model,
      ...(cfg.effort === undefined ? {} : { effort: cfg.effort }),
      outputFile,
    });
  }
  try {
    const proc = await runTrialProcess({
      executable: cfg.executable,
      args,
      stdin: input.prompt,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      recordDir: input.recordDir,
      label: `optimize-trial:${cfg.engine}:${input.stage}`,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.env === undefined ? {} : { env: input.env }),
      ...(input.groupPorts === undefined ? {} : { groupPorts: input.groupPorts }),
      ...(input.recordPorts === undefined ? {} : { recordPorts: input.recordPorts }),
      ...(input.spawnFn === undefined ? {} : { spawnFn: input.spawnFn }),
    });
    const failure = describeProcessFailure(proc);
    if (failure !== undefined) {
      return { ok: false, text: '', failure, process: proc };
    }
    if (cfg.engine === 'claude') {
      const out = parseClaudeTrialOutput(proc.stdout);
      if (out.isError || out.text === undefined) {
        return {
          ok: false,
          text: out.text ?? '',
          failure: 'Claudeの応答を読めませんでした',
          process: proc,
        };
      }
      return {
        ok: true,
        text: out.text,
        ...(out.sessionId === undefined ? {} : { sessionId: out.sessionId }),
        process: proc,
      };
    }
    const written = await readFile(outputFile!, 'utf8').catch(() => '');
    const text = written.trim() === '' ? proc.stdout : written;
    return text.trim() === ''
      ? { ok: false, text: '', failure: 'Codexの応答が空でした', process: proc }
      : { ok: true, text, process: proc };
  } finally {
    if (outputDir !== undefined) {
      await rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function describeProcessFailure(proc: TrialProcessResult): string | undefined {
  if (proc.groupRemains) {
    return 'プロセスグループが残っています';
  }
  if (proc.aborted) {
    return '中断されました';
  }
  if (proc.timedOut) {
    return '時間の上限を超えて止めました';
  }
  if (proc.error !== undefined) {
    return proc.error;
  }
  if (proc.exitCode !== 0) {
    return `exit code ${String(proc.exitCode)}`;
  }
  return undefined;
}
