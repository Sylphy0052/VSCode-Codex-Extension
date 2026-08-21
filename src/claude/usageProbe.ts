import { spawn } from 'node:child_process';
import { killWithEscalation } from '../process/childProcess';
import type { ChatUsage } from '../appserver/chatState';
import type { Logger } from '../log';
import { parseUsageReport } from './usageText';

/** 応答が返らないまま居座らせない。使用量は無くても困らない情報なので短く切る。 */
const TIMEOUT_MS = 20_000;

/** 続けて発言しても叩き直さない間隔。 */
const MIN_INTERVAL_MS = 60_000;

/**
 * `claude --print /usage` を単独で実行して消費率を読む。
 *
 * 会話中のセッションへ `/usage` を送ると応答が会話に混ざるため、別プロセスで聞く。
 * `rate_limit_event` は割合を持たないので、これが唯一の取得手段になる。
 */
export class ClaudeUsageProbe {
  private lastReadAt = 0;
  private running = false;

  constructor(
    private readonly claudePath: () => string,
    private readonly log: Logger,
  ) {}

  /**
   * 前回から間隔が空いていれば読む。
   *
   * @param now 現在時刻（ミリ秒）。テストから差し替える。
   */
  async read(now: number = Date.now()): Promise<ChatUsage | undefined> {
    if (this.running || now - this.lastReadAt < MIN_INTERVAL_MS) {
      return undefined;
    }
    this.running = true;
    this.lastReadAt = now;
    try {
      const output = await this.run();
      return output === undefined ? undefined : parseUsageReport(output);
    } finally {
      this.running = false;
    }
  }

  private run(): Promise<string | undefined> {
    return new Promise((resolve) => {
      const proc = spawn(this.claudePath(), ['--print', '/usage'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });

      let out = '';
      const finish = (value: string | undefined): void => {
        clearTimeout(timer);
        // SIGTERMに応答しないハングしたプロセスも回収できるよう、SIGKILLへの
        // エスカレーションを共通処理へ寄せる（issue #402、2点目のLOW対応）。
        killWithEscalation(proc);
        resolve(value);
      };
      const timer = setTimeout(() => finish(undefined), TIMEOUT_MS);

      proc.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString();
      });
      proc.on('error', (e: Error) => {
        this.log.warn(`使用量を取得できませんでした: ${e.message}`);
        finish(undefined);
      });
      proc.on('close', () => finish(out));
    });
  }
}
