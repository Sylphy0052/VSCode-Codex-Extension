import { spawn } from 'node:child_process';
import type { Logger } from '../log';
import { guardStdinErrors, safeWriteStdin } from '../process/stdinSafety';
import type { SkillsSnapshot } from '../provider/skills';
import {
  buildControlRequest,
  buildReloadSkillsRequest,
  readControlResponse,
  type ControlResponse,
} from './control';
import { parseClaudeSkillsList } from './skillsList';

/** 応答が返らないまま居座らせない。 */
const TIMEOUT_MS = 20_000;

/**
 * `claude` を単発で起動し、skillsの一覧を読む（issue #35、design.md TP-56）。
 *
 * `ClaudeHooksProbe` と同じ理由（設定パネルは会話を開いていなくても使える必要がある）で
 * 別プロセスとして問い合わせる。有効/無効を切り替える経路も判別する経路もプロトコルに
 * 無いため（`skillsList.ts` のコメント参照）、`ClaudeMcpProbe.toggle` に相当する
 * 書き込みメソッドは持たない。
 */
export class ClaudeSkillsProbe {
  constructor(
    private readonly claudePath: () => string,
    private readonly log: Logger,
    private readonly timeoutMs = TIMEOUT_MS,
  ) {}

  /** skillsの一覧を読む。取得できなければ理由付きで返す。 */
  async read(): Promise<SkillsSnapshot> {
    const response = await this.send(buildReloadSkillsRequest('reload_skills'), 'reload_skills');
    if (response === undefined) {
      const reason = '応答がありませんでした';
      this.log.warn(`skills一覧を取得できませんでした: ${reason}`);
      return { ok: false, reason };
    }
    if (!response.ok) {
      const reason = response.error ?? '不明なエラー';
      this.log.warn(`skills一覧を取得できませんでした: ${reason}`);
      return { ok: false, reason };
    }
    const skills = parseClaudeSkillsList(response.payload);
    if (skills === undefined) {
      return { ok: false, reason: '応答の形が想定外でした' };
    }
    return {
      ok: true,
      skills,
      warnings: [
        'Claude Codeには有効/無効を切り替える経路も、判別する経路もありません（実測。' +
          'design.mdの14.17参照）。出どころ(ユーザー/プロジェクト/プラグイン)はCLIの表示用' +
          '文字列からの推測です。',
      ],
    };
  }

  /**
   * `claude` を起動し、`initialize` に続けて1件だけ制御要求を送って応答を待つ。
   * 対応する `request_id` の応答が届くか、タイムアウトするまで待つ。
   */
  private send(requestLine: string, requestId: string): Promise<ControlResponse | undefined> {
    return new Promise((resolve) => {
      const proc = spawn(
        this.claudePath(),
        ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
        { stdio: ['pipe', 'pipe', 'ignore'] },
      );

      let buffer = '';
      let settled = false;
      const finish = (value: ControlResponse | undefined): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        proc.kill();
        resolve(value);
      };

      const timer = setTimeout(() => finish(undefined), this.timeoutMs);

      proc.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line !== '') {
            const response = readResponseFromLine(line, requestId);
            if (response !== undefined) {
              finish(response);
              return;
            }
          }
          index = buffer.indexOf('\n');
        }
      });

      proc.on('error', (e: Error) => {
        this.log.warn(`claudeを起動できませんでした: ${e.message}`);
        finish(undefined);
      });
      proc.on('close', () => finish(undefined));

      // `proc.on('error')`は起動失敗しか拾わない。起動後に相手が終了した状態へ書き込むと
      // 飛ぶEPIPE等はここで捕まえないとNodeの未捕捉例外になる（issue #155、design.md
      // §14.31）。単発の問い合わせなので、既に決着させる作りの`finish`へそのまま寄せる。
      guardStdinErrors(proc, (e) => {
        this.log.warn(`claudeへの書き込みに失敗しました: ${e.message}`);
        finish(undefined);
      });

      safeWriteStdin(proc, buildControlRequest('initialize', { subtype: 'initialize', hooks: {} }));
      safeWriteStdin(proc, requestLine);
    });
  }
}

/** 出力の1行を読み、指定した `requestId` への応答であればそれだけ返す。 */
function readResponseFromLine(line: string, requestId: string): ControlResponse | undefined {
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
  return response?.requestId === requestId ? response : undefined;
}
