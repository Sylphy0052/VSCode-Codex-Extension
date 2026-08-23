import { describe, expect, it } from 'vitest';
import { noDefaults } from '../../src/codex/configToml';
import { noClaudeDefaults } from '../../src/claude/settingsJson';
import type { Logger } from '../../src/log';
import { approvalLevelMeta } from '../../src/provider/approvalLevel';
import { ControlPanelViewProvider } from '../../src/view/controlPanelView';
import { controlPanelScript } from '../../src/view/controlPanelScript';
import { SECTION_IDS, type SettingsProvider } from '../../src/view/settingsProvider';

/**
 * セクション識別子は次の3箇所で独立して管理されており、型でもテストでも同期を強制
 * されていない（issue #225 レビュー指摘3）。
 *
 * - `SettingsProvider.SECTION_IDS`（取得ロジック側の正）
 * - `controlPanelScript(JSON.stringify(approvalLevelMeta()))` が出力するJS内の `SECTION_CONTAINERS`（webview側の開閉・
 *   読み込み中表示の対象）
 * - `ControlPanelViewProvider` が出すHTMLの `id="section-*"`（`<details>` 要素）
 *
 * 3箇所がずれると、`controlPanelScript(JSON.stringify(approvalLevelMeta()))` の初期化ループが
 * `el('section-' + sectionId)` を解決できずパネル全体の初期化が止まる
 * （プロバイダ選択・messageリスナー登録・readyの送信まで巻き込む）。ここでは
 * 3つの集合を突き合わせ、ズレを機械的に検出する。
 */

/** `controlPanelScript(JSON.stringify(approvalLevelMeta()))` の出力から `SECTION_CONTAINERS` のキー集合を取り出す。 */
function extractSectionContainerKeys(scriptSource: string): string[] {
  const match = scriptSource.match(/const SECTION_CONTAINERS = \{([\s\S]*?)\n {2}\};/);
  if (!match) {
    throw new Error(
      'controlPanelScript(JSON.stringify(approvalLevelMeta()))の出力からSECTION_CONTAINERSが見つかりません',
    );
  }
  const body = match[1] ?? '';
  const keys: string[] = [];
  for (const line of body.split('\n')) {
    const keyMatch = line.match(/^\s*(\w+):/);
    const key = keyMatch?.[1];
    if (key !== undefined) {
      keys.push(key);
    }
  }
  return keys;
}

/** `ControlPanelViewProvider` が出すHTMLから `id="section-*"` の集合を取り出す。 */
function extractSectionHtmlIds(html: string): string[] {
  const ids: string[] = [];
  const re = /id="section-(\w+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const id = m[1];
    if (id !== undefined) {
      ids.push(id);
    }
  }
  return ids;
}

function fakeLogger(): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    show: () => undefined,
  };
}

function fakeSettingsProvider(): SettingsProvider {
  const notLoadedYet = { ok: false as const, reason: 'まだ読み込んでいません' };
  const settings = {
    load: async () => undefined,
    loadingSections: [],
    snapshot: () => ({
      models: [],
      efforts: [],
      model: '',
      reasoningEffort: '',
      approvalMode: '',
      sandbox: '',
      defaults: noDefaults,
      profile: '',
      mcpServers: notLoadedYet,
      hooks: notLoadedYet,
      skills: notLoadedYet,
      account: notLoadedYet,
      plugins: notLoadedYet,
      apps: notLoadedYet,
      importCandidates: notLoadedYet,
      importHistory: notLoadedYet,
    }),
    claudeSnapshot: () => ({
      models: [],
      efforts: [],
      permissionModes: [],
      agents: [],
      model: '',
      effort: '',
      permissionMode: '',
      agent: '',
      defaults: noClaudeDefaults,
      mcpServers: notLoadedYet,
      hooks: notLoadedYet,
      skills: notLoadedYet,
      account: notLoadedYet,
      plugins: notLoadedYet,
    }),
    ensureSectionLoaded: async () => undefined,
  };
  return settings as unknown as SettingsProvider;
}

/** `ControlPanelViewProvider` が実際に出すHTMLを取り出す最小限のフェイク。 */
function renderedHtml(): string {
  const view = {
    webview: {
      options: {},
      html: '',
      cspSource: 'https://fake-webview.test',
      onDidReceiveMessage: () => ({ dispose: () => undefined }),
      postMessage: () => Promise.resolve(true),
    },
    onDidDispose: () => ({ dispose: () => undefined }),
  };
  const provider = new ControlPanelViewProvider(fakeSettingsProvider(), fakeLogger());
  provider.resolveWebviewView(view as never);
  return view.webview.html;
}

describe('セクション識別子の整合性（issue #225 レビュー指摘3）', () => {
  it('SECTION_IDSとSECTION_CONTAINERSのキー集合が一致する', () => {
    const containerKeys = extractSectionContainerKeys(
      controlPanelScript(JSON.stringify(approvalLevelMeta())),
    );
    expect(new Set(containerKeys)).toEqual(new Set(SECTION_IDS));
    // 重複が紛れ込んでいないことも確認する
    expect(containerKeys.length).toBe(SECTION_IDS.length);
  });

  it('SECTION_IDSとHTMLのid="section-*"の集合が一致する', () => {
    const htmlIds = extractSectionHtmlIds(renderedHtml());
    expect(new Set(htmlIds)).toEqual(new Set(SECTION_IDS));
    expect(htmlIds.length).toBe(SECTION_IDS.length);
  });

  it('SECTION_CONTAINERSのキー集合とHTMLのid="section-*"の集合が一致する', () => {
    const containerKeys = extractSectionContainerKeys(
      controlPanelScript(JSON.stringify(approvalLevelMeta())),
    );
    const htmlIds = extractSectionHtmlIds(renderedHtml());
    expect(new Set(containerKeys)).toEqual(new Set(htmlIds));
  });
});
