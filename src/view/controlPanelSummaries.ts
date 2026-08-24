import type { HooksSnapshot } from '../provider/hooks';
import type { McpServersSnapshot } from '../provider/mcpServers';
import type { AppsSnapshot, PluginsSnapshot } from '../provider/plugins';
import type { SkillsSnapshot } from '../provider/skills';
import type { SectionId } from './settingsProvider';

/**
 * 折りたたまれたセクションの見出しに出す集計（issue #740）。
 *
 * セクションは既定で閉じており、開くまで中身が分からない。「MCPサーバー」を開くまで
 * 接続できていないサーバーがあることに気付けない。見出しに1行の集計を出し、閉じたままでも
 * 読めるようにする。
 *
 * 判定はホスト側（TypeScript）で行い、webviewへは文字列だけを渡す。
 * `controlPanelScript.ts`はテンプレートリテラル中の素のJSで、型検査もlintも効かない
 * （`controlPanelAlerts.ts`と同じ理由）。
 *
 * 色は付けない。異常の強調は先頭の帯（issue #741）が担っており、ここでも色を付けると
 * 同じことを2箇所で言うことになる。ここは件数だけを出す。
 */

/** セクションidごとの集計文字列。載っていないセクションは見出しに何も出さない。 */
export type SectionSummaries = Partial<Record<SectionId, string>>;

/** 集計に使う分だけを受け取る。プロバイダ2つ分をまとめて渡す。 */
export interface SectionSummaryInput {
  readonly codexMcp: McpServersSnapshot;
  readonly codexHooks: HooksSnapshot;
  readonly codexSkills: SkillsSnapshot;
  readonly codexPlugins: PluginsSnapshot;
  readonly codexApps: AppsSnapshot;
  readonly claudeMcp: McpServersSnapshot;
  readonly claudeHooks: HooksSnapshot;
  readonly claudeSkills: SkillsSnapshot;
  readonly claudePlugins: PluginsSnapshot;
  /**
   * 一度でも取得したセクション（`SettingsProvider.loadedSectionIds`）。
   *
   * 未取得のセクションは`{ ok: false, reason: 'まだ読み込んでいません' }`のままで、
   * 取得に失敗した状態と形が区別できない。ここに載っていないセクションは集計しない
   * （読んでいないのに「0件」と出すと、本当に0件なのか読んでいないだけなのか分からない）。
   *
   * 遅延読み込み（issue #225）はそのまま残す方針を採った。一度開けば以降は閉じていても
   * 集計が残る（`SettingsProvider`が値を保持し続け、`load()`が読み直す対象にもなる）ので、
   * 起動時のコストを増やさずに目的を満たせる。例外はhooksで、これはissue #741で
   * 折りたたまれていても先に読むようにしてあるため、初回から集計が出る。
   */
  readonly loadedSections: ReadonlySet<SectionId>;
}

export function buildSectionSummaries(input: SectionSummaryInput): SectionSummaries {
  const summaries: SectionSummaries = {};
  assign(summaries, 'codexMcp', input, mcpSummary(input.codexMcp));
  assign(summaries, 'codexHooks', input, hooksSummary(input.codexHooks));
  assign(summaries, 'codexSkills', input, skillsSummary(input.codexSkills));
  assign(summaries, 'codexPlugins', input, pluginsSummary(input.codexPlugins));
  assign(summaries, 'codexApps', input, appsSummary(input.codexApps));
  assign(summaries, 'claudeMcp', input, mcpSummary(input.claudeMcp));
  assign(summaries, 'claudeHooks', input, hooksSummary(input.claudeHooks));
  assign(summaries, 'claudeSkills', input, skillsSummary(input.claudeSkills));
  assign(summaries, 'claudePlugins', input, pluginsSummary(input.claudePlugins));
  return summaries;
}

/** 読み込み済みで、かつ集計できたセクションだけを載せる。 */
function assign(
  summaries: SectionSummaries,
  id: SectionId,
  input: SectionSummaryInput,
  summary: string | undefined,
): void {
  if (summary !== undefined && input.loadedSections.has(id)) {
    summaries[id] = summary;
  }
}

/**
 * MCPは「接続できている数 / 全体」。無効化したものも母数に入れる
 * （一覧に並ぶ数と見出しの数が食い違うと、どちらが正しいのか読み手が確かめる必要が出る）。
 */
function mcpSummary(snapshot: McpServersSnapshot): string | undefined {
  if (!snapshot.ok) {
    return undefined;
  }
  const connected = snapshot.servers.filter((server) => server.state === 'connected').length;
  return `${connected}/${snapshot.servers.length} 接続`;
}

/**
 * hooksは件数と、未信頼・改変されたものの数。数え方は先頭の帯（`controlPanelAlerts.ts`）に
 * 揃える（有効なものだけを数え、`managed`と`unsupported`は数えない）。
 * 同じ画面の2箇所が違う数を出さないため。
 */
function hooksSummary(snapshot: HooksSnapshot): string | undefined {
  if (!snapshot.ok) {
    return undefined;
  }
  const untrusted = snapshot.hooks.filter(
    (hook) => hook.enabled && (hook.trust === 'untrusted' || hook.trust === 'modified'),
  ).length;
  return untrusted === 0
    ? `${snapshot.hooks.length}件`
    : `${snapshot.hooks.length}件（未信頼${untrusted}）`;
}

/** skillsは件数のみ。無効にできるのはCodexだけで、両側で同じ形にならない。 */
function skillsSummary(snapshot: SkillsSnapshot): string | undefined {
  return snapshot.ok ? `${snapshot.skills.length}件` : undefined;
}

/** pluginsは件数と、無効になっているものの数。 */
function pluginsSummary(snapshot: PluginsSnapshot): string | undefined {
  if (!snapshot.ok) {
    return undefined;
  }
  const disabled = snapshot.plugins.filter((plugin) => !plugin.enabled).length;
  return disabled === 0
    ? `${snapshot.plugins.length}件`
    : `${snapshot.plugins.length}件（無効${disabled}）`;
}

/** appsは閲覧のみの一覧なので件数だけ。 */
function appsSummary(snapshot: AppsSnapshot): string | undefined {
  return snapshot.ok ? `${snapshot.apps.length}件` : undefined;
}
