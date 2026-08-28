import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killWithEscalation } from '../process/childProcess';
import { canWriteStdin, guardStdinErrors } from '../process/stdinSafety';
import type { GoalEvaluation, GoalEvaluator, GoalEvaluatorInput } from './goalLoop';
import { buildEvaluatorPrompt, indeterminate, parseEvaluation } from './goalPrompt';

/**
 * ゴール駆動ループ（issue #892）のEvaluatorを、CLIのヘッドレス実行として呼ぶ。
 *
 * 呼び出しは**毎ターンstatelessな新規実行**にする。前回の評価セッションをresumeすると、
 * 過去の自分の判断へのアンカリング（一度「未達」と言った手前、達成を認めにくくなる）と
 * contextの肥大化が起きる。判定はその時点の証拠だけを見て行わせる。
 *
 * Evaluatorには**ツールを渡さない**。Evaluatorが自分でコマンドを実行して直しに行った
 * 瞬間に、作業役と評価役を分けた意味が消える。
 */

/** 設定 `agent.chat.goalEvaluator.provider` の値。 */
export type GoalEvaluatorProviderSetting = 'inherit' | 'claude' | 'codex';

/** 実際に起動するCLI。 */
export type GoalEvaluatorProvider = 'claude' | 'codex';

export interface GoalEvaluatorSettings {
  provider: GoalEvaluatorProviderSetting;
  /** `auto` なら同一プロバイダの軽量モデルに任せる。 */
  model: string;
  timeoutSeconds: number;
  maxIndeterminate: number;
}

/** `model: auto` のときにClaudeへ渡すモデル。速く安いものを既定にする。 */
export const AUTO_CLAUDE_MODEL = 'haiku';

/**
 * どちらのCLIでEvaluatorを動かすか決める。
 *
 * 既定の`inherit`は会話しているプロバイダと同じCLIを使う。認証が済んでいる・レイテンシが
 * 小さい・プロバイダ差による挙動差が出ない、の3点による。別プロバイダで判定させる
 * （Worker=Claude / Evaluator=Codex）ことも選べるが、独立性の本質は「別のCLI」ではなく
 * 「別のcontext・別の役割・別のプロンプト」の方にあるため、既定にはしない。
 */
export function resolveEvaluatorProvider(
  setting: GoalEvaluatorProviderSetting,
  host: GoalEvaluatorProvider,
): GoalEvaluatorProvider {
  return setting === 'inherit' ? host : setting;
}

export interface EvaluatorCommand {
  executable: string;
  args: string[];
  /** 最終応答を書き出させるファイル。Codexのみ使う。 */
  outputFile?: string;
}

/**
 * Claude CLIの起動引数（実測: claude 2.1.247）。
 *
 * - `--tools ""`: built-inツールを全て無効化する。helpの記載どおり空文字で全無効。
 * - `--setting-sources ""`: 利用者の`CLAUDE.md`・hooks・skillsを読ませない。**これが無いと
 *   評価が汚染される。** 実測では、リポジトリ直下でこれを付けずに呼ぶと、利用者側の
 *   口調規約やプロンプトインジェクション警戒の指示をEvaluatorが被り、JSONを返さなかった。
 * - `--output-format json`: 応答本文を`result`フィールドで受け取る。
 */
export function buildClaudeEvaluatorArgs(model: string): string[] {
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
 * - `--ephemeral`: セッションファイルを残さない。毎ターンstatelessという方針と一致する。
 * - `--ignore-user-config`: Claudeの`--setting-sources ""`に相当する汚染対策。
 * - `--skip-git-repo-check`: 評価はリポジトリの外でも走らせられるようにする。
 * - `-o <file>`: 最終メッセージだけをファイルへ書かせる。標準出力には進捗も混ざるため、
 *   本文の取り出しをファイル経由にする。
 */
export function buildCodexEvaluatorArgs(model: string, outputFile: string): string[] {
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

export interface GoalEvaluatorDeps {
  provider: GoalEvaluatorProvider;
  executable: string;
  model: string;
  timeoutMs: number;
  /** 失敗の記録先。判定そのものは`indeterminate`へ倒すため、ここでは記録だけ行う。 */
  logWarn?: (message: string) => void;
}

/**
 * Evaluatorを1回呼ぶ関数を作る。
 *
 * **呼び出しに失敗しても例外を投げない。** CLIが落ちた・タイムアウトした・JSONが読めない
 * のいずれも`indeterminate`として返し、続けるか止めるかの判断は`LoopController`へ委ねる。
 * 評価の失敗でループ全体が壊れると、それまでの作業ごと失われる。
 */
export function createGoalEvaluator(deps: GoalEvaluatorDeps): GoalEvaluator {
  return async (input: GoalEvaluatorInput): Promise<GoalEvaluation> => {
    const prompt = buildEvaluatorPrompt(input);
    try {
      const raw =
        deps.provider === 'claude'
          ? await runClaudeEvaluator(deps, prompt)
          : await runCodexEvaluator(deps, prompt);
      if (raw === undefined) {
        return indeterminate('Evaluatorの呼び出しに失敗しました');
      }
      return parseEvaluation(raw);
    } catch (e) {
      deps.logWarn?.(`Evaluatorの呼び出しで例外が出ました: ${errorMessage(e)}`);
      return indeterminate('Evaluatorの呼び出しで例外が出ました');
    }
  };
}

async function runClaudeEvaluator(
  deps: GoalEvaluatorDeps,
  prompt: string,
): Promise<string | undefined> {
  const result = await runProcess(
    deps.executable,
    buildClaudeEvaluatorArgs(deps.model),
    prompt,
    deps.timeoutMs,
  );
  if (result === undefined) {
    deps.logWarn?.('Evaluator（claude）が応答しませんでした');
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

async function runCodexEvaluator(
  deps: GoalEvaluatorDeps,
  prompt: string,
): Promise<string | undefined> {
  const dir = await mkdtemp(join(tmpdir(), 'goal-eval-'));
  const outputFile = join(dir, `${randomUUID()}.txt`);
  try {
    const result = await runProcess(
      deps.executable,
      buildCodexEvaluatorArgs(deps.model, outputFile),
      prompt,
      deps.timeoutMs,
    );
    if (result === undefined) {
      deps.logWarn?.('Evaluator（codex）が応答しませんでした');
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

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
