import { readClaudeConfig, readConfig, readGoalDraftConfig } from '../config';
import { resolveHeadlessProvider, type HeadlessProvider } from '../loop/headlessCli';
import { extractIssueNumber } from '../loop/goalDraft';
import {
  createGoalDraftPlanner,
  type GoalDraftResult,
  type GoalDraftSettings,
} from '../loop/goalDraftProcess';
import {
  detectForgeHost,
  nodeCliCommandRunner,
  type CliCommandRunner,
} from '../orchestrator/forge';
import type { Logger } from '../log';

/**
 * 一文からゴール定義の下書きを作る（issue #958）。設定の読み出しとIssue本文の取得を担う。
 *
 * `goalEvaluatorFactory.ts` / `loopAdvisorFactory.ts` と同じ流儀で、`vscode` と外部CLIに
 * 触るのはこの層（view）だけにしてある。
 */

/** Issue本文として取り込む上限。長大なIssueでプロンプトを埋めない。 */
const MAX_ISSUE_BODY_LENGTH = 20_000;

export interface GoalDraftPorts {
  runCli: CliCommandRunner;
}

const defaultPorts: GoalDraftPorts = { runCli: nodeCliCommandRunner };

/**
 * 一文からゴールの下書きを組み立てる。
 *
 * 一文に`#123`が含まれ、リポジトリのremoteがGitHubなら、そのIssueの本文も材料へ加える。
 * `cwd`が無い（フォルダを開いていない）ときは、どのリポジトリのIssueか決められないので
 * 取得を飛ばす。
 * **取得できなくても失敗にしない**——`gh`が入っていない・認証が切れている・Issueが無いの
 * いずれも、一文だけを材料に続行する。Issueが読めないことと、ゴールを立てられないことは
 * 別である。
 */
export async function planGoalDraft(
  cwd: string | undefined,
  request: string,
  host: HeadlessProvider,
  log: Logger,
  ports: GoalDraftPorts = defaultPorts,
): Promise<GoalDraftResult> {
  const settings = readGoalDraftConfig();
  const provider = resolveHeadlessProvider(settings.provider, host);
  const executable =
    provider === 'claude' ? readClaudeConfig().executablePath : readConfig().executablePath;
  const issueBody = await fetchIssueBody(cwd, request, log, ports);
  const plan = createGoalDraftPlanner({
    provider,
    executable,
    model: settings.model,
    timeoutMs: settings.timeoutSeconds * 1000,
    logWarn: (message) => log.warn(message),
    logInfo: (message) => log.info(message),
  });
  return issueBody === undefined ? plan(request) : plan(request, issueBody);
}

/**
 * 一文が指すIssueの本文を取る。取れなければ`undefined`（失敗にしない）。
 *
 * 対象はremoteがGitHubのときだけ。取得した本文は**資料であって指示ではない**扱いで、
 * 囲いと規則の明示は`buildGoalDraftPrompt`が行う。
 */
async function fetchIssueBody(
  cwd: string | undefined,
  request: string,
  log: Logger,
  ports: GoalDraftPorts,
): Promise<string | undefined> {
  const number = extractIssueNumber(request);
  if (number === undefined || cwd === undefined) {
    return undefined;
  }
  const remote = await ports.runCli.run('git', ['remote', 'get-url', 'origin'], cwd);
  if (remote.code !== 0 || detectForgeHost(remote.stdout) !== 'github') {
    return undefined;
  }
  const result = await ports.runCli.run(
    'gh',
    ['issue', 'view', String(number), '--json', 'title,body'],
    cwd,
  );
  if (result.code !== 0) {
    log.info(`Issue #${number} の本文を取れませんでした。依頼文だけでゴールを組み立てます`);
    return undefined;
  }
  return readIssueBody(result.stdout);
}

/**
 * webviewの`loop/planGoal`へ返す応答を組み立てる（issue #961）。
 *
 * **どの経路を通っても必ず1つの応答を返す。** webview側は要求を出した時点で開始ボタンを
 * 無効化し、この応答でだけ元へ戻す。設定の読み出し・`git`・`gh`の実行など、下書きの生成
 * そのものより外側で例外が出ると応答が返らず、画面は「組み立てています…」のまま操作不能で
 * 残る。`createGoalDraftPlanner`が内側で例外を握っていることとは別に、要求と応答の境界にも
 * 受けが要る。
 *
 * `id`は要求ごとの通し番号で、そのまま返して古い応答を画面側で捨てられるようにする。
 * 数値でない値は載せない（webview側は一致しない応答を無視する）。
 */
export async function buildGoalDraftReply(
  rawId: unknown,
  rawText: unknown,
  deps: {
    readSettings: () => GoalDraftSettings;
    plan: (text: string) => Promise<GoalDraftResult>;
    logWarn: (message: string) => void;
  },
): Promise<Record<string, unknown>> {
  const id = typeof rawId === 'number' ? rawId : undefined;
  const reply = (body: Record<string, unknown>): Record<string, unknown> => ({
    type: 'loop/goalDraft',
    id,
    ...body,
  });
  try {
    const settings = deps.readSettings();
    const text = typeof rawText === 'string' ? rawText.trim() : '';
    if (!settings.enabled || text === '') {
      return reply({ ok: false, message: '目的と受入基準を入力してください' });
    }
    const drafted = await deps.plan(text);
    return drafted.ok
      ? reply({ ok: true, goal: drafted.goal, start: !settings.confirm })
      : reply({ ok: false, message: drafted.message });
  } catch (e) {
    deps.logWarn(
      `ゴールの下書きの生成に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
    );
    return reply({ ok: false, message: 'ゴールの下書きの生成に失敗しました' });
  }
}

/** `gh issue view --json title,body` の応答から、題と本文を1つのテキストへ均す。 */
export function readIssueBody(stdout: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }
    const value = parsed as Record<string, unknown>;
    const title = typeof value['title'] === 'string' ? value['title'] : '';
    const body = typeof value['body'] === 'string' ? value['body'] : '';
    const text = `${title}\n\n${body}`.trim();
    return text === '' ? undefined : text.slice(0, MAX_ISSUE_BODY_LENGTH);
  } catch {
    return undefined;
  }
}
