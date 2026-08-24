import { describe, expect, it } from 'vitest';
import type { HookTrustState, HookView, HooksSnapshot } from '../../src/provider/hooks';
import type { McpServersSnapshot } from '../../src/provider/mcpServers';
import {
  emptyPluginProvides,
  type AppsSnapshot,
  type PluginView,
  type PluginsSnapshot,
} from '../../src/provider/plugins';
import type { SkillView, SkillsSnapshot } from '../../src/provider/skills';
import {
  buildSectionSummaries,
  type SectionSummaryInput,
} from '../../src/view/controlPanelSummaries';
import { SECTION_IDS, type SectionId } from '../../src/view/settingsProvider';

const hook = (trust: HookTrustState, enabled = true): HookView => ({
  key: `key-${trust}`,
  eventName: 'preToolUse',
  matcher: undefined,
  handlerType: 'command',
  command: 'echo hi',
  origin: 'project',
  originDetail: undefined,
  pluginId: undefined,
  enabled,
  trust,
  trustHash: undefined,
});

const hooksOf = (...hooks: HookView[]): HooksSnapshot => ({ ok: true, hooks, warnings: [] });

const mcpOf = (...states: Array<'connected' | 'disabled' | 'unavailable'>): McpServersSnapshot => ({
  ok: true,
  servers: states.map((state, index) => ({
    name: `server${index}`,
    state,
    toolCount: 0,
    version: undefined,
    reason: undefined,
  })),
});

const skill = (name: string): SkillView => ({
  key: name,
  name,
  description: '',
  origin: 'project',
  originDetail: undefined,
  enabled: true,
  toggleable: true,
});

const skillsOf = (...skills: SkillView[]): SkillsSnapshot => ({ ok: true, skills, warnings: [] });

const plugin = (name: string, enabled: boolean): PluginView => ({
  key: name,
  name,
  description: '',
  version: undefined,
  origin: 'local',
  scope: undefined,
  enabled,
  toggleable: true,
  removable: true,
  provides: emptyPluginProvides,
});

const pluginsOf = (...plugins: PluginView[]): PluginsSnapshot => ({
  ok: true,
  plugins,
  installable: true,
  marketplaces: [],
  warnings: [],
});

const appsOf = (count: number): AppsSnapshot => ({
  ok: true,
  apps: Array.from({ length: count }, (_unused, index) => ({
    key: `app${index}`,
    name: `app${index}`,
    description: undefined,
    enabled: true,
    callable: true,
  })),
});

const notLoaded = { ok: false, reason: 'まだ読み込んでいません' } as const;

/** 既定は「すべて読み込み済み・0件」。各テストは必要な分だけ差し替える。 */
function input(overrides: Partial<SectionSummaryInput> = {}): SectionSummaryInput {
  return {
    codexMcp: mcpOf(),
    codexHooks: hooksOf(),
    codexSkills: skillsOf(),
    codexPlugins: pluginsOf(),
    codexApps: appsOf(0),
    claudeMcp: mcpOf(),
    claudeHooks: hooksOf(),
    claudeSkills: skillsOf(),
    claudePlugins: pluginsOf(),
    loadedSections: new Set<SectionId>(SECTION_IDS),
    ...overrides,
  };
}

describe('buildSectionSummaries（issue #740）', () => {
  it('MCPは接続できている数と全体を出す', () => {
    const summaries = buildSectionSummaries(
      input({ codexMcp: mcpOf('connected', 'unavailable', 'disabled') }),
    );
    expect(summaries.codexMcp).toBe('1/3 接続');
  });

  it('hooksは件数だけを出す（未信頼が無いとき）', () => {
    const summaries = buildSectionSummaries(
      input({ codexHooks: hooksOf(hook('trusted'), hook('managed')) }),
    );
    expect(summaries.codexHooks).toBe('2件');
  });

  it('hooksは未信頼の数を添える', () => {
    const summaries = buildSectionSummaries(
      input({ codexHooks: hooksOf(hook('trusted'), hook('untrusted'), hook('modified')) }),
    );
    expect(summaries.codexHooks).toBe('3件（未信頼2）');
  });

  it('hooksの未信頼の数え方は先頭の帯と揃える（無効なものは数えない）', () => {
    const summaries = buildSectionSummaries(
      input({ codexHooks: hooksOf(hook('untrusted', false)) }),
    );
    expect(summaries.codexHooks).toBe('1件');
  });

  it('skillsは件数のみ', () => {
    const summaries = buildSectionSummaries(
      input({ codexSkills: skillsOf(skill('a'), skill('b')) }),
    );
    expect(summaries.codexSkills).toBe('2件');
  });

  it('pluginsは無効の数を添える', () => {
    const summaries = buildSectionSummaries(
      input({ codexPlugins: pluginsOf(plugin('a', true), plugin('b', false)) }),
    );
    expect(summaries.codexPlugins).toBe('2件（無効1）');
  });

  it('pluginsは全部有効なら件数のみ', () => {
    const summaries = buildSectionSummaries(input({ codexPlugins: pluginsOf(plugin('a', true)) }));
    expect(summaries.codexPlugins).toBe('1件');
  });

  it('appsは件数のみ', () => {
    expect(buildSectionSummaries(input({ codexApps: appsOf(2) })).codexApps).toBe('2件');
  });

  it('Claude Code側も同じ形で出す', () => {
    const summaries = buildSectionSummaries(input({ claudeMcp: mcpOf('connected') }));
    expect(summaries.claudeMcp).toBe('1/1 接続');
  });

  it('0件でも読み込み済みなら出す（「読んだ結果0件」は情報）', () => {
    expect(buildSectionSummaries(input()).codexMcp).toBe('0/0 接続');
  });

  it('まだ読み込んでいないセクションには何も出さない', () => {
    // 読んでいないのに「0件」と出すと、本当に0件なのか読んでいないだけなのか分からない
    const summaries = buildSectionSummaries(
      input({ codexMcp: notLoaded, loadedSections: new Set<SectionId>(['codexHooks']) }),
    );
    expect(summaries.codexMcp).toBeUndefined();
  });

  it('読み込み済みでも取得に失敗していれば何も出さない', () => {
    const summaries = buildSectionSummaries(
      input({ codexMcp: { ok: false, reason: 'CLIが落ちた' } }),
    );
    expect(summaries.codexMcp).toBeUndefined();
  });

  it('集計を出さないセクション（アカウント・インポート）は載せない', () => {
    const summaries = buildSectionSummaries(input());
    expect(summaries.codexAccount).toBeUndefined();
    expect(summaries.claudeAccount).toBeUndefined();
    expect(summaries.codexImport).toBeUndefined();
  });
});
