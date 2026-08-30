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
 * Codexが持てる能力のうち、脇役として明示的に禁止するもの（実測: codex-cli 0.148.0）。
 *
 * `--sandbox read-only`は**ローカルの書き込みを止めるだけ**で、読み取りもネットワークも
 * 止めない。実測では、この引数だけの状態でCodexが`/bin/bash -c`を起動し、作業ディレクトリ
 * の外の絶対パス・ホーム配下のファイル・環境変数のすべてを読めた。さらにシェルを止めても
 * `web__run`で外部サイトを取得でき、`mcp__codex_apps__*`（利用者のアカウントに繋がった
 * GitHub・Google Drive等）が生きていて、読み取りだけでなくファイル作成やPRのマージのような
 * 副作用を持つツールまで露出していた。これらはローカルのサンドボックスの管轄外であるため、
 * サンドボックスを固くしても防げない。
 *
 * 脇役に必要な能力はJSONを1つ書くことだけなので、能力は列挙して落とす。
 * 詳細な実測結果はissue #962に記録した。
 *
 * **守る不変条件**: Codexのヘッドレス実行は、ローカルのファイル読取・環境変数・外部
 * ネットワーク・連携アプリ（apps / plugins）のいずれにも到達できず、モデルへのプロンプトと
 * JSONの応答だけを行う。**Codex CLIを更新したときは、この文が成り立つかを実測で確かめる**
 * ——allowlistの機構が無い以上、新しい能力が既定で有効なまま追加されれば黙って露出が戻る。
 */
export const CODEX_DENIED_FEATURES = [
  // シェル経由の任意コマンド実行。これが最も広い読み取り経路。
  'shell_tool',
  'unified_exec',
  // 利用者のアカウントに繋がった外部アプリ。ローカルsandboxの外側で副作用を起こせる。
  'apps',
  'plugins',
  // ブラウザ操作。外部への到達と持ち出しの経路になる。
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'in_app_browser',
  'computer_use',
  // 判定には要らない生成・分岐系。露出を減らす目的で落とす。
  'image_generation',
  'multi_agent',
  'view_image',
  // 上記を落としても、code modeが残っているとツール呼び出しの受け皿として機能する。
  'code_mode_host',
] as const;

/**
 * フラグでは落とせない能力を設定値で塞ぐ。
 *
 * - `tools.web_search=false`: 検索経由の外部到達を止める。
 * - `shell_environment_policy.inherit=none`: シェルを無効化していても残す。将来別のツールが
 *   環境変数を参照する経路への備えであり、冗長ではない。
 */
export const CODEX_CONFIG_OVERRIDES = [
  'tools.web_search=false',
  'shell_environment_policy.inherit=none',
] as const;

/**
 * Codex CLIの起動引数（実測: codex-cli 0.148.0）。
 *
 * - `--sandbox read-only`: ローカルへの書き込みを塞ぐ。**読み取りは止まらない**ため、
 *   これ単体を隔離の根拠にしない（`CODEX_DENIED_FEATURES`を参照）。
 * - `--ephemeral`: セッションファイルを残さない。毎回statelessという方針と一致する。
 * - `--ignore-user-config`: Claudeの`--setting-sources ""`に相当する汚染対策。
 * - `--skip-git-repo-check`: リポジトリの外でも走らせられるようにする。
 * - `--disable <feature>`: 脇役に不要な能力を明示的に落とす。
 * - `-o <file>`: 最終メッセージだけをファイルへ書かせる。標準出力には進捗も混ざるため、
 *   本文の取り出しをファイル経由にする。
 *
 * 禁止の列挙はCLIの更新に弱い。allowlistの機構が無い以上、**Codex CLIを上げたときは
 * 露出するツール一覧を測り直し、許可していない新しい能力が増えていないか確認する**
 * 必要がある（issue #962の受入基準）。
 */
export function buildCodexHeadlessArgs(model: string, outputFile: string): string[] {
  const modelArgs = model === 'auto' || model === '' ? [] : ['-m', model];
  const denyArgs = CODEX_DENIED_FEATURES.flatMap((feature) => ['--disable', feature]);
  const configArgs = CODEX_CONFIG_OVERRIDES.flatMap((override) => ['-c', override]);
  return [
    'exec',
    '--sandbox',
    'read-only',
    '--ephemeral',
    '--ignore-user-config',
    '--skip-git-repo-check',
    ...denyArgs,
    ...configArgs,
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
  /**
   * 呼び出し側が実行を打ち切るための合図（issue #1009）。
   *
   * 脇役（Evaluator / Advisor）の応答を待っている間にループが止められると、それまでは
   * `timeoutMs`（Advisorの既定は120秒）ぶんプロセスが居座り続けていた。結果は世代の
   * 判定で捨てられるため害は無いが、止めたはずのものが走り続けるのは費用の面でも
   * 説明の面でも良くない。**abortされた実行の結果は使われない前提**で、その場で回収する。
   */
  signal?: AbortSignal;
}

/** 呼び出しが失敗した理由。応答が得られなかったときだけ使う。 */
export type HeadlessFailureReason = 'timeout' | 'process-error';

/**
 * ヘッドレス実行の結果。
 *
 * 失敗を`undefined`の1値に潰さないのは、呼び出し側が「時間切れ」と「起動・終了の失敗」を
 * 人へ言い分けられるようにするため（issue #964）。判断そのものは呼び出し側の責務で、
 * ここでは何が起きたかだけを返す。
 */
export type HeadlessOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: HeadlessFailureReason };

/**
 * プロンプトを1回だけ投げ、応答本文を返す。**失敗しても例外を投げず`undefined`を返す。**
 *
 * CLIが落ちた・タイムアウトした・何も返らなかったのいずれも`undefined`で、続けるか
 * 止めるかの判断は呼び出し側に委ねる。脇役の失敗でループ全体が壊れると、それまでの
 * 作業ごと失われる。
 *
 * 失敗の理由まで要るときは`runHeadlessPromptDetailed`を使う。
 */
export async function runHeadlessPrompt(
  deps: HeadlessCliDeps,
  prompt: string,
): Promise<string | undefined> {
  const outcome = await runHeadlessPromptDetailed(deps, prompt);
  return outcome.ok ? outcome.text : undefined;
}

/**
 * `runHeadlessPrompt`の、失敗の理由まで返す版。
 *
 * **例外は投げない。** 時間切れは`timeout`、起動できなかった・異常終了した・何も
 * 返らなかったは`process-error`にする。応答本文がJSONとして読めるかどうかは、その内容を
 * 知っている呼び出し側（Advisor・Evaluator）の判断であり、ここでは見ない。
 */
export async function runHeadlessPromptDetailed(
  deps: HeadlessCliDeps,
  prompt: string,
): Promise<HeadlessOutcome> {
  return deps.provider === 'claude' ? runClaude(deps, prompt) : runCodex(deps, prompt);
}

async function runClaude(deps: HeadlessCliDeps, prompt: string): Promise<HeadlessOutcome> {
  const result = await runProcess(
    deps.executable,
    buildClaudeHeadlessArgs(deps.model),
    prompt,
    deps.timeoutMs,
    undefined,
    deps.signal,
  );
  if (!result.ok) {
    // 打ち切りは利用者が止めた結果であり、CLIの不調ではない。警告として残さない
    if (deps.signal?.aborted !== true) {
      deps.logWarn?.('claudeのヘッドレス実行が応答しませんでした');
    }
    return result;
  }
  const body = readClaudeResult(result.text);
  // `result`が空文字だった場合も「何も返らなかった」として扱う
  return body === undefined ? { ok: false, reason: 'process-error' } : { ok: true, text: body };
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

async function runCodex(deps: HeadlessCliDeps, prompt: string): Promise<HeadlessOutcome> {
  const dir = await mkdtemp(join(tmpdir(), 'loop-headless-'));
  const outputFile = join(dir, `${randomUUID()}.txt`);
  try {
    // 空の一時ディレクトリで動かす。ツールは落としてあるが、作業ディレクトリを
    // 渡す理由が無い以上、渡さない側へ倒す（issue #962）
    const result = await runProcess(
      deps.executable,
      buildCodexHeadlessArgs(deps.model, outputFile),
      prompt,
      deps.timeoutMs,
      dir,
      deps.signal,
    );
    if (!result.ok) {
      if (deps.signal?.aborted !== true) {
        deps.logWarn?.('codexのヘッドレス実行が応答しませんでした');
      }
      return result;
    }
    const written = await readFile(outputFile, 'utf8').catch(() => '');
    return { ok: true, text: written.trim() === '' ? result.text : written };
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
 * 応答が無いまま居座らせない。時間切れは`timeout`、起動失敗・異常終了は`process-error`。
 *
 * `cwd`を渡すと、その場所で起動する。省略すると拡張機能ホストの作業ディレクトリを継ぐ。
 */
function runProcess(
  executable: string,
  args: string[],
  stdin: string,
  timeoutMs: number,
  cwd?: string,
  signal?: AbortSignal,
): Promise<HeadlessOutcome> {
  return new Promise((resolve) => {
    // 起動前に既に打ち切られていれば、プロセスを作らずに返す
    if (signal?.aborted === true) {
      resolve({ ok: false, reason: 'process-error' });
      return;
    }
    const proc = spawn(executable, args, {
      stdio: ['pipe', 'pipe', 'ignore'],
      ...(cwd === undefined ? {} : { cwd }),
    });
    let stdout = '';
    let settled = false;

    const finish = (value: HeadlessOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // SIGTERMに応答しないプロセスも回収できるよう、共通処理へ寄せる
      killWithEscalation(proc);
      resolve(value);
    };
    const fail = (reason: HeadlessFailureReason): void => finish({ ok: false, reason });

    // 打ち切りは時間切れとは分けて`process-error`にする。時間切れなら設定を延ばす、が
    // 次の手になるが、打ち切りは利用者が止めただけで設定は関係ない
    const onAbort = (): void => fail('process-error');
    signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => fail('timeout'), timeoutMs);

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    proc.on('error', () => fail('process-error'));
    proc.on('close', (code) => {
      finish(code === 0 ? { ok: true, text: stdout } : { ok: false, reason: 'process-error' });
    });

    // 起動後に相手が終了した状態への書き込みで飛ぶEPIPE等は、ここで捕まえないと
    // Nodeの未捕捉例外になる（design.md §14.31）
    guardStdinErrors(proc, () => fail('process-error'));
    if (canWriteStdin(proc)) {
      proc.stdin.end(stdin);
    }
  });
}
