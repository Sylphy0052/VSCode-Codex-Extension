import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { killWithEscalation } from '../process/childProcess';
import type { Logger } from '../log';
import { isStandbyStale, STANDBY_PROBE_INTERVAL_MS } from './accountPolicy';
import type { ClaudeAccountStore } from './accountStore';
import { logExcerpt } from './usageProbe';
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

/** CLI本体が終わってから `close` を待つ上限。 */
const CLOSE_GRACE_MS = 2_000;

/**
 * 一時的な `CLAUDE_CONFIG_DIR` の認証より優先されうる環境変数。残すと別のアカウント
 * （環境変数のもの）の使用率を、待機中のアカウントの記録として書いてしまう。
 */
const AUTH_ENV_KEYS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

/**
 * 接続先や認証方式を差し替える環境変数の接頭辞（`ANTHROPIC_BASE_URL`・`ANTHROPIC_CUSTOM_HEADERS`・
 * `CLAUDE_CODE_USE_BEDROCK`/`CLAUDE_CODE_USE_VERTEX` など）。個別に列挙すると漏れるので接頭辞で外す。
 */
const AUTH_ENV_PREFIXES = ['ANTHROPIC_', 'CLAUDE_CODE_USE_', 'AWS_BEARER_TOKEN_'];

/** stdoutとして溜める上限（文字数）。`/usage` の出力より十分大きく、暴走した出力でメモリを使わない。 */
const STDOUT_MAX_CHARS = 64 * 1024;

/** CLIのデバッグログの置き場所（`configDir` の中。計測後に一時ディレクトリごと消える）。 */
const DEBUG_LOG = 'cli-debug.log';

/**
 * CLIの `/usage` は使用率の取得（`/api/oauth/usage`）に失敗すると、使用率の節を省いて
 * code=0で終わる。stdoutからは失敗の理由が分からないので、デバッグログのうち取得と
 * トークンの更新に関わる行だけを拾う（Issue #1958）。
 */
const DIAGNOSTIC_LINE =
  /fetchUtilization|Failed to load usage data|OAuth refresh|Token refresh|oauth profile/;

/** ログへ残す診断行の上限。同じ失敗の繰り返しでログを埋めないよう、末尾の数行だけにする。 */
const DIAGNOSTIC_MAX_LINES = 6;

/** 診断行1行の上限。 */
const DIAGNOSTIC_LINE_CHARS = 300;

/**
 * CLIのデバッグログから使用率の取得の失敗理由を表す行を抜き出す。CLIはトークンを
 * 伏せて書くが、念のためトークンらしい部分も伏せる。読めなければ `undefined`。
 */
export async function readUsageDiagnostics(path: string): Promise<string | undefined> {
  const text = await readFile(path, 'utf8').catch(() => undefined);
  if (text === undefined) {
    return undefined;
  }
  const lines = text
    .split('\n')
    .filter((line) => DIAGNOSTIC_LINE.test(line))
    .slice(-DIAGNOSTIC_MAX_LINES)
    .map((line) => {
      const masked = line
        .replace(/sk-ant-[\w-]+/g, '[REDACTED]')
        .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
        .trim();
      return masked.length > DIAGNOSTIC_LINE_CHARS
        ? `${masked.slice(0, DIAGNOSTIC_LINE_CHARS)}…`
        : masked;
    });
  return lines.length === 0 ? '（該当する行なし）' : lines.join(' | ');
}

/**
 * `configDir` を `CLAUDE_CONFIG_DIR` とcwdにしてCLIの `/usage` を走らせ、使用率を読む。
 * cwdを一時ディレクトリにするのは、作業中のリポジトリの `.claude/` の設定やhookを読ませないため。
 * 打ち切ったときもプロセスが終わるまで待つ。終わる前に戻ると、CLIがローテーションした
 * 認証を書き終える前に、呼び出し側が書き戻しを判断してしまう。
 * stderrはトークンを含みうるので読まず、ログにも出さない。読み取れなかったときは、原因を
 * 調べられるようstdoutの先頭と、CLIのデバッグログのうち使用率の取得に関わる行だけを
 * ログに残す（Issue #1958）。
 */
export function measureUsageIn(
  claudePath: string,
  configDir: string,
  id: string,
  log: Logger,
): Promise<UsageSlots | undefined> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
    for (const key of Object.keys(env)) {
      if (AUTH_ENV_KEYS.includes(key) || AUTH_ENV_PREFIXES.some((p) => key.startsWith(p))) {
        delete env[key];
      }
    }
    const debugLog = join(configDir, DEBUG_LOG);
    // transcriptを残さない（Issue #1911）
    const proc = spawn(
      claudePath,
      ['--print', '--no-session-persistence', '--debug-file', debugLog, '/usage'],
      {
        cwd: configDir,
        env,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );

    let out = '';
    let finished = false;
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
        `待機中のアカウント「${id}」の使用率の計測が${String(TIMEOUT_MS / 1000)}秒で終わらないため打ち切りました`,
      );
      // `close` が来るまで待つ（SIGKILLへのエスカレーションで必ず終わる）
      killWithEscalation(proc);
    }, TIMEOUT_MS);

    proc.stdout.on('data', (chunk: Buffer) => {
      if (out.length < STDOUT_MAX_CHARS) {
        out += chunk.toString();
      }
    });
    proc.on('error', (e: Error) => {
      // 起動できなかったときは `close` が来ないことがある
      if (proc.pid === undefined) {
        log.warn(`待機中のアカウント「${id}」の使用率を計測できませんでした: ${e.message}`);
        settle(undefined);
      }
    });
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled || finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      const slots = parseUsageSlots(out, Date.now());
      if (slots !== undefined) {
        settle(slots);
        return;
      }
      // 呼び出し側が一時ディレクトリを消す前に読む
      void readUsageDiagnostics(debugLog).then((diagnostics) => {
        log.warn(
          `待機中のアカウント「${id}」の使用率を読み取れませんでした（code=${String(code)}, signal=${String(signal)}）。stdout: ${logExcerpt(out)} / CLIのログ: ${diagnostics ?? '（読めませんでした）'}`,
        );
        settle(undefined);
      });
    };
    proc.on('close', finish);
    // CLIが残した孫プロセスがstdoutを握っていると `close` が来ない。CLI本体が終わっていれば
    // 認証の書き込みも済んでいるので、少し待っても来なければ読めた分で終える
    proc.on('exit', (code, signal) => {
      setTimeout(() => finish(code, signal), CLOSE_GRACE_MS).unref();
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
    // 失敗を次の計測へ持ち越さない。呼び出し側には失敗をそのまま返し、警告を出させる
    this.queue = run.catch(() => undefined);
    return run;
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
