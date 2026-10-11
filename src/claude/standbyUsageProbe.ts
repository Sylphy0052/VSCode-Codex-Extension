import { spawn } from 'node:child_process';
import { killWithEscalation } from '../process/childProcess';
import type { Logger } from '../log';
import { isStandbyStale, STANDBY_PROBE_INTERVAL_MS } from './accountPolicy';
import type { ClaudeAccountStore } from './accountStore';
import { parseUsageSlots, type UsageSlots } from './usageText';

/**
 * 待機中の（ログインしていない）Claudeアカウントの使用率を計測する（Issue #1943）。
 *
 * `claude /usage` はライブの `~/.claude` の認証でしか動かない。アカウントストアが対象の
 * 認証を一時的な `CLAUDE_CONFIG_DIR` へ写し、その中でCLIを走らせる。認証の写しと書き戻しは
 * `ClaudeAccountStore.probeStandby`、ここはCLIの起動と、どのアカウントをいつ測るかを持つ。
 */

/** 既存のprobeと同じ。ストアのロック（30秒で古いとみなされる）を持ったまま走るので延ばさない。 */
const TIMEOUT_MS = 20_000;

/**
 * 一時的な `CLAUDE_CONFIG_DIR` の認証より優先されうる環境変数。残すと別のアカウント
 * （環境変数のもの）の使用率を、待機中のアカウントの記録として書いてしまう。
 */
const AUTH_ENV_KEYS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

/**
 * `configDir` を `CLAUDE_CONFIG_DIR` とcwdにしてCLIの `/usage` を走らせ、使用率を読む。
 * cwdを一時ディレクトリにするのは、作業中のリポジトリの `.claude/` の設定やhookを読ませないため。
 * 打ち切ったときもプロセスが終わるまで待つ。終わる前に戻ると、CLIがローテーションした
 * 認証を書き終える前に、呼び出し側が書き戻しを判断してしまう。
 * stderrはトークンを含みうるので読まず、ログにも出さない。
 */
export function measureUsageIn(
  claudePath: string,
  configDir: string,
  id: string,
  log: Logger,
): Promise<UsageSlots | undefined> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
    for (const key of AUTH_ENV_KEYS) {
      delete env[key];
    }
    // transcriptを残さない（Issue #1911）
    const proc = spawn(claudePath, ['--print', '--no-session-persistence', '/usage'], {
      cwd: configDir,
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    let out = '';
    let settled = false;
    const settle = (value: UsageSlots | undefined): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }
    };
    const timer = setTimeout(() => {
      log.warn(
        `待機中のアカウント「${id}」の使用率の計測が${TIMEOUT_MS / 1000}秒で終わらないため打ち切りました`,
      );
      // `close` が来るまで待つ（SIGKILLへのエスカレーションで必ず終わる）
      killWithEscalation(proc);
    }, TIMEOUT_MS);

    proc.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    proc.on('error', (e: Error) => {
      // 起動できなかったときは `close` が来ないことがある
      if (proc.pid === undefined) {
        log.warn(`待機中のアカウント「${id}」の使用率を計測できませんでした: ${e.message}`);
        settle(undefined);
      }
    });
    proc.on('close', (code, signal) => {
      const slots = parseUsageSlots(out, Date.now());
      if (slots === undefined) {
        log.warn(
          `待機中のアカウント「${id}」の使用率を読み取れませんでした（code=${code}, signal=${signal}）`,
        );
      }
      settle(slots);
    });
  });
}

type StandbyProbeStore = Pick<ClaudeAccountStore, 'list' | 'probeStandby'>;

/**
 * どの待機中アカウントをいつ測るかを決める。記録が古いもの（`isStandbyStale`）だけを、
 * 優先度の高い順に測る。結果にかかわらず、同じアカウントは60分試し直さない。
 * 計測は1本ずつ通す。
 */
export class StandbyUsageProbe {
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  /** アカウントごとの最後に試した時刻。失敗や対象外（ライブと同じログインなど）でも空ける。 */
  private readonly attemptedAt = new Map<string, number>();

  constructor(
    private readonly store: StandbyProbeStore,
    private readonly claudePath: () => string,
    private readonly log: Logger,
    private readonly isEnabled: () => boolean,
  ) {}

  /** 定期のポーリングから呼ぶ。1件だけ測る。前の計測が残っていれば何もしない。 */
  probeOne(nowMs: number): Promise<void> {
    if (this.pending > 0) {
      return this.queue;
    }
    return this.enqueue(() => this.probeStale(nowMs, 1));
  }

  /**
   * 自動切替が切替先に選んだ待機中アカウントを測る。全件を測ると1件20秒ほどずつ切替が遅れる
   * ので、選ばれた1件だけにする。60分以内に試していれば測らない。
   */
  probeAccount(id: string, nowMs: number): Promise<void> {
    return this.enqueue(async () => {
      if (this.isEnabled() && !this.attemptedRecently(id, nowMs)) {
        await this.probe(id, nowMs);
      }
    });
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.pending += 1;
    const run = this.queue.then(task).finally(() => {
      this.pending -= 1;
    });
    // 失敗を次の計測へ持ち越さない
    this.queue = run.catch(() => undefined);
    return this.queue;
  }

  private async probeStale(nowMs: number, limit: number): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }
    const snapshot = await this.store.list();
    if (!snapshot.ok) {
      return;
    }
    const targets = snapshot.accounts
      .filter((a) => isStandbyStale(a, nowMs) && !this.attemptedRecently(a.id, nowMs))
      .slice(0, limit);
    for (const account of targets) {
      await this.probe(account.id, nowMs);
    }
  }

  private async probe(id: string, nowMs: number): Promise<void> {
    this.attemptedAt.set(id, nowMs);
    const result = await this.store.probeStandby(
      id,
      (dir) => measureUsageIn(this.claudePath(), dir, id, this.log),
      Date.now(),
    );
    if (!result.ok) {
      this.log.warn(`待機中のアカウントの使用率を記録できませんでした: ${result.reason}`);
    } else if (result.warning !== undefined) {
      this.log.warn(`待機中のアカウントの計測: ${result.warning}`);
    }
  }

  private attemptedRecently(id: string, nowMs: number): boolean {
    const at = this.attemptedAt.get(id);
    return at !== undefined && nowMs - at < STANDBY_PROBE_INTERVAL_MS;
  }
}
