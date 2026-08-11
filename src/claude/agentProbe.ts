import { spawn } from 'node:child_process';
import type { Logger } from '../log';
import { buildControlRequest, readAgentList, readControlResponse } from './control';
import type { ClaudeAgentInfo } from './types';

/** 応答が返らないまま居座らせない。エージェント一覧は無くても選択肢を出さないだけで済む。 */
const TIMEOUT_MS = 20_000;

/**
 * `claude` を単発で起動し、`initialize` の応答からエージェント一覧だけを読む。
 *
 * `ClaudeModelProbe`（モデル一覧）と同じ作り。設定パネルは会話を開いていなくても
 * 選択肢を出す必要があるため、会話用の常駐プロセスとは別に単発で聞く。
 *
 * 取得できない場合は `undefined` を返す。呼び出し側は「選択肢を出さない」側に倒すこと
 * （モデルと違い、エージェントには意味のあるフォールバック一覧が無い）。
 */
export class ClaudeAgentProbe {
  constructor(
    private readonly claudePath: () => string,
    private readonly log: Logger,
    private readonly timeoutMs = TIMEOUT_MS,
  ) {}

  read(): Promise<ClaudeAgentInfo[] | undefined> {
    return new Promise((resolve) => {
      const proc = spawn(
        this.claudePath(),
        ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
        { stdio: ['pipe', 'pipe', 'ignore'] },
      );

      let buffer = '';
      let settled = false;
      const finish = (agents: ClaudeAgentInfo[] | undefined): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        proc.kill();
        resolve(agents);
      };

      const timer = setTimeout(() => {
        this.log.warn('エージェント一覧を取得できませんでした: 応答がありません');
        finish(undefined);
      }, this.timeoutMs);

      proc.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line !== '') {
            const agents = readAgentsFromLine(line);
            if (agents !== undefined) {
              finish(agents);
              return;
            }
          }
          index = buffer.indexOf('\n');
        }
      });

      proc.on('error', (e: Error) => {
        this.log.warn(`エージェント一覧を取得できませんでした: ${e.message}`);
        finish(undefined);
      });
      proc.on('close', () => finish(undefined));

      proc.stdin.write(buildControlRequest('1', { subtype: 'initialize', hooks: {} }));
    });
  }
}

/**
 * 出力の1行からエージェント一覧を読む。
 *
 * `initialize` の応答以外の行（system通知など）は素通しする。
 */
export function readAgentsFromLine(line: string): ClaudeAgentInfo[] | undefined {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof event !== 'object' || event === null || Array.isArray(event)) {
    return undefined;
  }
  const response = readControlResponse(event as Record<string, unknown>);
  if (response === undefined || !response.ok) {
    return undefined;
  }
  return readAgentList(response.payload);
}
