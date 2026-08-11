import { execFile } from 'node:child_process';
import type { Logger } from '../log';
import type { AccountSnapshot } from '../provider/account';
import { parseAuthStatusJson } from './authStatus';

/** 応答が返らないまま居座らせない。 */
const TIMEOUT_MS = 15_000;

/**
 * `claude auth status --json` を単発で起動し、ログイン状態を読む（issue #29）。
 *
 * `ClaudeMcpProbe` / `ClaudeModelProbe` と違い、control protocol（stream-json）を使わない。
 * `claude auth status --json` という専用サブコマンドが構造化された応答をそのまま返すため
 * （`claude auth --help` で確認、`--json` は既定でもある）、`--print
 * --input-format stream-json` を起動して `initialize` の応答を待つより単純で確実
 * （`parseAuthStatusJson` のコメントを参照）。
 */
export class ClaudeAuthProbe {
  constructor(
    private readonly claudePath: () => string,
    private readonly log: Logger,
    private readonly timeoutMs = TIMEOUT_MS,
  ) {}

  read(): Promise<AccountSnapshot> {
    return new Promise((resolve) => {
      execFile(
        this.claudePath(),
        ['auth', 'status', '--json'],
        { timeout: this.timeoutMs },
        (error, stdout, stderr) => {
          if (error !== null) {
            const reason = stderr.trim() !== '' ? stderr.trim() : error.message;
            this.log.warn(`ログイン状態を取得できませんでした: ${reason}`);
            resolve({ ok: false, reason });
            return;
          }
          const account = parseAuthStatusJson(stdout);
          if (account === undefined) {
            this.log.warn('ログイン状態を取得できませんでした: 応答の形が想定外でした');
            resolve({ ok: false, reason: '応答の形が想定外でした' });
            return;
          }
          resolve({ ok: true, account });
        },
      );
    });
  }
}
