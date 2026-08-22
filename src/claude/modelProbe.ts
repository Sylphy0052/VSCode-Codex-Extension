import { spawn } from 'node:child_process';
import { killWithEscalation } from '../process/childProcess';
import type { ModelInfo } from '../codex/modelCatalog';
import type { Logger } from '../log';
import { guardStdinErrors, safeWriteStdin } from '../process/stdinSafety';
import { buildControlRequest, readControlResponse, readModelList } from './control';

/** 応答が返らないまま居座らせない。モデル一覧は無くてもフォールバックがある。 */
const TIMEOUT_MS = 20_000;

/**
 * `claude` を単発で起動し、`initialize` の応答からモデル一覧だけを読む。
 *
 * Codexの `model/list` に相当する問い合わせが stream-json には無く、`initialize` の
 * 応答に同梱されるものが唯一の取得手段（実測）。会話中のセッションからも同じものが
 * 取れるが、設定パネルは会話を開いていなくても選択肢を出す必要があるため、ここで
 * 別プロセスとして聞く。
 *
 * 取得できない場合は `undefined` を返す。呼び出し側は静的な既定値へ退避すること。
 */
export class ClaudeModelProbe {
  constructor(
    private readonly claudePath: () => string,
    private readonly log: Logger,
    private readonly timeoutMs = TIMEOUT_MS,
  ) {}

  read(): Promise<ModelInfo[] | undefined> {
    return new Promise((resolve) => {
      const proc = spawn(
        this.claudePath(),
        ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
        { stdio: ['pipe', 'pipe', 'ignore'] },
      );

      let buffer = '';
      let settled = false;
      const finish = (models: ModelInfo[] | undefined): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        // SIGTERMに応答しないハングしたプロセスも回収できるよう、SIGKILLへの
        // エスカレーションを共通処理へ寄せる（issue #402、2点目のLOW対応）。
        killWithEscalation(proc);
        resolve(models);
      };

      const timer = setTimeout(() => {
        this.log.warn('モデル一覧を取得できませんでした: 応答がありません');
        finish(undefined);
      }, this.timeoutMs);

      proc.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line !== '') {
            const models = readModelsFromLine(line);
            if (models !== undefined) {
              finish(models);
              return;
            }
          }
          index = buffer.indexOf('\n');
        }
      });

      proc.on('error', (e: Error) => {
        this.log.warn(`モデル一覧を取得できませんでした: ${e.message}`);
        finish(undefined);
      });
      proc.on('close', () => finish(undefined));

      // `proc.on('error')`は起動失敗しか拾わない。起動後に相手が終了した状態へ書き込むと
      // 飛ぶEPIPE等はここで捕まえないとNodeの未捕捉例外になる（issue #155、design.md
      // §14.31）。単発の問い合わせなので、既に決着させる作りの`finish`へそのまま寄せる。
      guardStdinErrors(proc, (e) => {
        this.log.warn(`モデル一覧を取得できませんでした: ${e.message}`);
        finish(undefined);
      });

      safeWriteStdin(proc, buildControlRequest('1', { subtype: 'initialize', hooks: {} }));
    });
  }
}

/**
 * 出力の1行からモデル一覧を読む。
 *
 * `initialize` の応答以外の行（system通知など）は素通しする。
 */
export function readModelsFromLine(line: string): ModelInfo[] | undefined {
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
  return readModelList(response.payload);
}
