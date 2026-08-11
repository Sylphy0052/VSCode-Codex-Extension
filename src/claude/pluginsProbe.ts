import { execFile } from 'node:child_process';
import type { Logger } from '../log';
import type { PluginsSnapshot } from '../provider/plugins';
import { parsePluginDetailsText, parsePluginListJson } from './pluginsList';

/** 応答が返らないまま居座らせない。 */
const TIMEOUT_MS = 15_000;

/** `claude plugin details` を呼ぶ件数の上限。導入数が多い環境でパネルが固まらないようにする。 */
const MAX_DETAILS_CALLS = 25;

/**
 * `claude plugin list --json` / `claude plugin details <id>` を単発で起動し、plugin一覧を
 * 読む（issue #32、design.md §14.20）。
 *
 * `ClaudeAuthProbe` と同じ理由（設定パネルは会話を開いていなくても使える必要がある）で
 * 通常のCLI標準出力を読む単発呼び出しにする（control protocolは使わない）。
 */
export class ClaudePluginsProbe {
  constructor(
    private readonly claudePath: () => string,
    private readonly log: Logger,
    private readonly timeoutMs = TIMEOUT_MS,
  ) {}

  async read(): Promise<PluginsSnapshot> {
    const listResult = await this.run(['plugin', 'list', '--json']);
    if (!listResult.ok) {
      this.log.warn(`plugin一覧を取得できませんでした: ${listResult.error}`);
      return { ok: false, reason: listResult.error };
    }
    const plugins = parsePluginListJson(listResult.stdout);
    if (plugins === undefined) {
      return { ok: false, reason: '応答の形が想定外でした' };
    }

    // 「提供するもの」の内訳は1件ずつ別呼び出しが要る（`claude plugin details <id>`）。
    // 導入数が多い環境でパネルが固まらないよう件数の上限を設ける。上限を超えた分は
    // 内訳が空のまま（一覧・有効無効・出どころは失わない）
    for (const plugin of plugins.slice(0, MAX_DETAILS_CALLS)) {
      const detailsResult = await this.run(['plugin', 'details', plugin.key]);
      if (!detailsResult.ok) {
        continue;
      }
      const { description, provides } = parsePluginDetailsText(detailsResult.stdout);
      if (description !== undefined) {
        plugin.description = description;
      }
      plugin.provides = provides;
    }

    return {
      ok: true,
      plugins,
      installable: true,
      // Claude Codeは `<name>@<marketplace>` を1つの文字列として自由入力させるため、
      // マーケットプレイスの選択肢は持たない（Codexとの違い。`installClaudePlugin` 参照）
      marketplaces: [],
      warnings:
        plugins.length > MAX_DETAILS_CALLS
          ? [`導入数が多いため、${MAX_DETAILS_CALLS}件を超えるpluginの内訳は表示していません。`]
          : [],
    };
  }

  private run(args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
    return new Promise((resolve) => {
      execFile(this.claudePath(), args, { timeout: this.timeoutMs }, (error, stdout, stderr) => {
        if (error !== null) {
          const reason = stderr.trim() !== '' ? stderr.trim() : error.message;
          resolve({ ok: false, error: reason });
          return;
        }
        resolve({ ok: true, stdout });
      });
    });
  }
}
