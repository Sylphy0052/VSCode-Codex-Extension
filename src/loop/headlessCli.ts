import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killWithEscalation } from '../process/childProcess';
import { canWriteStdin, guardStdinErrors } from '../process/stdinSafety';

/**
 * ループの脇役（Evaluator / Advisor）をCLIのヘッドレス実行として1回だけ呼ぶ共通部。
 *
 * `goalEvaluatorProcess.ts`（issue #892）が持っていた起動処理を、Advisor（issue #957）が
 * 同じ条件で呼べるように切り出したもの。**呼び出しは毎回statelessな新規実行**で、
 * ツールを渡さず、利用者の設定（`CLAUDE.md`・hooks・skills）も読ませない。ここを緩めると
 * 脇役が自分で作業を始めたり、利用者側の口調規約でJSONを返さなくなったりする。
 */

/** 設定で選べるプロバイダの指定。`inherit`は会話しているCLIに合わせる。 */
export type HeadlessProviderSetting = 'inherit' | 'claude' | 'codex';

/** 実際に起動するCLI。 */
export type HeadlessProvider = 'claude' | 'codex';

/** `model: auto` のときにClaudeへ渡すモデル。速く安いものを既定にする。 */
export const AUTO_CLAUDE_MODEL = 'haiku';

/**
 * どちらのCLIで脇役を動かすか決める。
 *
 * 既定の`inherit`は会話しているプロバイダと同じCLIを使う。認証が済んでいる・レイテンシが
 * 小さい・プロバイダ差による挙動差が出ない、の3点による。別プロバイダで動かすことも
 * 選べるが、独立性の本質は「別のCLI」ではなく「別のcontext・別の役割・別のプロンプト」の
 * 方にあるため、既定にはしない。
 */
export function resolveHeadlessProvider(
  setting: HeadlessProviderSetting,
  host: HeadlessProvider,
): HeadlessProvider {
  return setting === 'inherit' ? host : setting;
}

/**
 * Claude CLIの起動引数（実測: claude 2.1.247）。
 *
 * - `--tools ""`: built-inツールを全て無効化する。helpの記載どおり空文字で全無効。
 * - `--setting-sources ""`: 利用者の`CLAUDE.md`・hooks・skillsを読ませない。**これが無いと
 *   判断が汚染される。** 実測では、リポジトリ直下でこれを付けずに呼ぶと、利用者側の
 *   口調規約やプロンプトインジェクション警戒の指示を被り、JSONを返さなかった。
 * - `--output-format json`: 応答本文を`result`フィールドで受け取る。
 */
export function buildClaudeHeadlessArgs(model: string): string[] {
  const resolved = model === 'auto' || model === '' ? AUTO_CLAUDE_MODEL : model;
  return [
    '-p',
    '--tools',
    '',
    '--setting-sources',
    '',
    '--output-format',
    'json',
    '--model',
    resolved,
  ];
}

/**
 * Codex CLIの起動引数（実測: codex-cli 0.148.0）。
 *
 * - `--sandbox read-only`: Codexには`--tools ""`に相当するフラグが無いため、書き込みと
 *   ネットワークを伴う操作をサンドボックスで塞ぐことで代える。
 * - `--ephemeral`: セッションファイルを残さない。毎回statelessという方針と一致する。
 * - `--ignore-user-config`: Claudeの`--setting-sources ""`に相当する汚染対策。
 * - `--skip-git-repo-check`: リポジトリの外でも走らせられるようにする。
 * - `-o <file>`: 最終メッセージだけをファイルへ書かせる。標準出力には進捗も混ざるため、
 *   本文の取り出しをファイル経由にする。
 */
export function buildCodexHeadlessArgs(model: string, outputFile: string): string[] {
  const modelArgs = model === 'auto' || model === '' ? [] : ['-m', model];
  return [
    'exec',
    '--sandbox',
    'read-only',
    '--ephemeral',
    '--ignore-user-config',
    '--skip-git-repo-check',
    ...modelArgs,
    '-o',
    outputFile,
  ];
}

export interface HeadlessCliDeps {
  provider: HeadlessProvider;
  executable: string;
  model: string;
  timeoutMs: number;
  /** 失敗の記録先。判断そのものは呼び出し側で安全側へ倒すため、ここでは記録だけ行う。 */
  logWarn?: (message: string) => void;
}

/**
 * プロンプトを1回だけ投げ、応答本文を返す。**失敗しても例外を投げず`undefined`を返す。**
 *
 * CLIが落ちた・タイムアウトした・何も返らなかったのいずれも`undefined`で、続けるか
 * 止めるかの判断は呼び出し側に委ねる。脇役の失敗でループ全体が壊れると、それまでの
 * 作業ごと失われる。
 */
export async function runHeadlessPrompt(
  deps: HeadlessCliDeps,
  prompt: string,
): Promise<string | undefined> {
  return deps.provider === 'claude' ? runClaude(deps, prompt) : runCodex(deps, prompt);
}

async function runClaude(deps: HeadlessCliDeps, prompt: string): Promise<string | undefined> {
  const result = await runProcess(
    deps.executable,
    buildClaudeHeadlessArgs(deps.model),
    prompt,
    deps.timeoutMs,
  );
  if (result === undefined) {
    deps.logWarn?.('claudeのヘッドレス実行が応答しませんでした');
    return undefined;
  }
  return readClaudeResult(result);
}

/** `--output-format json` の応答から本文（`result`）だけを取り出す。 */
export function readClaudeResult(stdout: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed === 'object' && parsed !== null) {
      const value = (parsed as Record<string, unknown>)['result'];
      if (typeof value === 'string') {
        return value;
      }
    }
  } catch {
    // JSONでなければ本文そのものとして扱う（出力形式が変わっても壊さない）
  }
  return stdout.trim() === '' ? undefined : stdout;
}

async function runCodex(deps: HeadlessCliDeps, prompt: string): Promise<string | undefined> {
  const dir = await mkdtemp(join(tmpdir(), 'loop-headless-'));
  const outputFile = join(dir, `${randomUUID()}.txt`);
  try {
    const result = await runProcess(
      deps.executable,
      buildCodexHeadlessArgs(deps.model, outputFile),
      prompt,
      deps.timeoutMs,
    );
    if (result === undefined) {
      deps.logWarn?.('codexのヘッドレス実行が応答しませんでした');
      return undefined;
    }
    const written = await readFile(outputFile, 'utf8').catch(() => '');
    return written.trim() === '' ? result : written;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * プロンプトを標準入力から渡してCLIを1回だけ実行し、標準出力を返す。
 *
 * プロンプトには会話の抜粋（ファイル内容やコマンド出力）が含まれるため、引数ではなく
 * 標準入力で渡す。引数に載せるとプロセス一覧から他の利用者に読めてしまう。
 *
 * 応答が無いまま居座らせない。時間切れ・起動失敗・異常終了はいずれも`undefined`。
 */
function runProcess(
  executable: string,
  args: string[],
  stdin: string,
  timeoutMs: number,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const proc = spawn(executable, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    let settled = false;

    const finish = (value: string | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      // SIGTERMに応答しないプロセスも回収できるよう、共通処理へ寄せる
      killWithEscalation(proc);
      resolve(value);
    };

    const timer = setTimeout(() => finish(undefined), timeoutMs);

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    proc.on('error', () => finish(undefined));
    proc.on('close', (code) => finish(code === 0 ? stdout : undefined));

    // 起動後に相手が終了した状態への書き込みで飛ぶEPIPE等は、ここで捕まえないと
    // Nodeの未捕捉例外になる（design.md §14.31）
    guardStdinErrors(proc, () => finish(undefined));
    if (canWriteStdin(proc)) {
      proc.stdin.end(stdin);
    }
  });
}
