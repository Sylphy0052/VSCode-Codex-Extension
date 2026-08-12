import { describe, expect, it } from 'vitest';
import type { Logger } from '../../src/log';
import type { SkillsSnapshot } from '../../src/provider/skills';
import { SettingsProvider } from '../../src/view/settingsProvider';

const fakeLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  show: () => undefined,
};

/**
 * `SettingsProvider`の全依存を無害なフェイクで埋める。`reloadClaudeSkills`の検証に要るのは
 * `listClaudeSkills`だけなので、それ以外は「呼ばれたら空/未対応を返すだけ」に揃える
 * （`claudeChatViewManager.test.ts`の`fakeSettingsProvider`とは違い、ここでは実クラスの
 * 挙動を検証したいため、キャストではなく本物のコンストラクタへ実際に渡す）。
 */
function createSettingsProvider(listClaudeSkills: () => Promise<SkillsSnapshot>): SettingsProvider {
  const notImplementedReason = async () => ({ ok: false as const, reason: 'not implemented' });
  const notImplementedError = async () => ({ ok: false as const, error: 'not implemented' });
  const notImplementedCommand = async () => ({ code: 1, stderr: 'not implemented' });

  return new SettingsProvider(
    { readTextFile: async () => undefined } as never,
    '/fake/models-cache',
    '/fake/config.toml',
    '/fake/claude-settings.json',
    async () => [], // listCodexModels
    async () => undefined, // listClaudeModels
    async () => undefined, // listClaudeAgents
    notImplementedReason, // listCodexMcpServers
    notImplementedReason, // listClaudeMcpServers
    notImplementedError, // setCodexMcpServerEnabled
    notImplementedError, // setClaudeMcpServerEnabled
    notImplementedReason, // listCodexHooks
    notImplementedReason, // listClaudeHooks
    notImplementedError, // setCodexHookTrusted
    notImplementedReason, // listCodexSkills
    listClaudeSkills, // listClaudeSkills（検証対象）
    notImplementedError, // setCodexSkillEnabled
    notImplementedReason, // readCodexAccount
    notImplementedReason, // readClaudeAccount
    notImplementedCommand, // logoutCodexCli
    notImplementedCommand, // logoutClaudeCli
    notImplementedCommand, // loginCodexApiKeyCli
    notImplementedReason, // listCodexPlugins
    notImplementedReason, // listClaudePlugins
    notImplementedError, // installCodexPluginCli
    notImplementedError, // uninstallCodexPluginCli
    notImplementedCommand, // toggleClaudePluginCli
    notImplementedCommand, // installClaudePluginCli
    notImplementedCommand, // uninstallClaudePluginCli
    notImplementedReason, // listCodexApps
    async () => ({ snapshot: { ok: false, reason: 'not implemented' }, rawByKey: new Map() }), // detectCodexImportCandidates
    notImplementedReason, // readCodexImportHistories
    notImplementedError, // runCodexImportCli
    fakeLogger,
  );
}

describe('SettingsProvider.reloadClaudeSkills（issue #202、design.md TP-90）', () => {
  it('呼ぶたびにlistClaudeSkillsを聞き直し、claudeSnapshot().skillsが置き換わる', async () => {
    const responses: SkillsSnapshot[] = [
      { ok: true, skills: [], warnings: [] },
      {
        ok: true,
        skills: [
          {
            key: 'zzz-temp',
            name: 'zzz-temp',
            description: '増えた一時skill',
            origin: 'user',
            originDetail: undefined,
            enabled: true,
            toggleable: false,
          },
        ],
        warnings: [],
      },
    ];
    let callCount = 0;
    const settings = createSettingsProvider(async () => {
      const response = responses[callCount];
      callCount += 1;
      return response ?? { ok: false, reason: '想定外の呼び出し' };
    });

    await settings.reloadClaudeSkills();
    expect(settings.claudeSnapshot().skills).toEqual({ ok: true, skills: [], warnings: [] });

    // ディスク上へskillが増えた後、もう一度読み直す
    await settings.reloadClaudeSkills();
    expect(callCount).toBe(2);
    const second = settings.claudeSnapshot().skills;
    expect(second.ok && second.skills.map((s) => s.name)).toEqual(['zzz-temp']);
  });

  it('取得に失敗したら ok:false の理由付きスナップショットへ置き換わる', async () => {
    const settings = createSettingsProvider(async () => ({
      ok: false,
      reason: '応答がありませんでした',
    }));

    await settings.reloadClaudeSkills();

    expect(settings.claudeSnapshot().skills).toEqual({
      ok: false,
      reason: '応答がありませんでした',
    });
  });
});
