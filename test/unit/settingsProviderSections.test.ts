import { describe, expect, it } from 'vitest';
import type { Logger } from '../../src/log';
import { SettingsProvider } from '../../src/view/settingsProvider';

const fakeLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  show: () => undefined,
};

const NOT_LOADED_YET = { ok: false as const, reason: 'まだ読み込んでいません' };

/**
 * 呼び出し回数を数えられる `SettingsProvider` を組み立てる（issue #225）。
 *
 * セクション単位の遅延取得を検証したいので、「即時に読むもの」（モデル・エージェント）と
 * 「セクション単位で取りに行くもの」を、それぞれ独立したキーで呼び出し回数を数える。
 * `settingsProviderReloadClaudeSkills.test.ts` の `createSettingsProvider` と同じ構造だが、
 * こちらは全依存の呼び出し回数を追う必要があるため別ファイルにしている。
 */
/**
 * `listCodexMcpServers` の取得を差し替えたいテスト（issue #225 レビュー指摘2の競合
 * 再現）向けのオプション。省略時は他のセクションと同じ即時応答のフェイクを使う。
 */
interface CreateSettingsProviderOptions {
  listCodexMcpServers?: () => Promise<{ ok: false; reason: string }>;
}

function createSettingsProvider(options: CreateSettingsProviderOptions = {}): {
  settings: SettingsProvider;
  calls: Record<string, number>;
} {
  const calls: Record<string, number> = {};
  const count = (key: string): void => {
    calls[key] = (calls[key] ?? 0) + 1;
  };

  const notLoadedYetReason = (key: string) => async () => {
    count(key);
    return { ok: false as const, reason: 'fake' };
  };
  const notImplementedError = (key: string) => async () => {
    count(key);
    return { ok: false as const, error: 'fake' };
  };
  const notImplementedCommand = (key: string) => async () => {
    count(key);
    return { code: 1, stderr: 'fake' };
  };

  const listCodexMcpServers = async (): Promise<{ ok: false; reason: string }> => {
    count('listCodexMcpServers');
    return options.listCodexMcpServers ? options.listCodexMcpServers() : { ok: false, reason: 'fake' };
  };

  const settings = new SettingsProvider(
    { readTextFile: async () => undefined } as never,
    '/fake/models-cache',
    '/fake/config.toml',
    '/fake/claude-settings.json',
    async () => {
      count('listCodexModels');
      return [];
    },
    async () => {
      count('listClaudeModels');
      return undefined;
    },
    async () => {
      count('listClaudeAgents');
      return undefined;
    },
    listCodexMcpServers,
    notLoadedYetReason('listClaudeMcpServers'),
    notImplementedError('setCodexMcpServerEnabled'),
    notImplementedError('setClaudeMcpServerEnabled'),
    notLoadedYetReason('listCodexHooks'),
    notLoadedYetReason('listClaudeHooks'),
    notImplementedError('setCodexHookTrusted'),
    notLoadedYetReason('listCodexSkills'),
    notLoadedYetReason('listClaudeSkills'),
    notImplementedError('setCodexSkillEnabled'),
    notLoadedYetReason('readCodexAccount'),
    notLoadedYetReason('readClaudeAccount'),
    notImplementedCommand('logoutCodexCli'),
    notImplementedCommand('logoutClaudeCli'),
    notImplementedCommand('loginCodexApiKeyCli'),
    notLoadedYetReason('listCodexPlugins'),
    notLoadedYetReason('listClaudePlugins'),
    notImplementedError('installCodexPluginCli'),
    notImplementedError('uninstallCodexPluginCli'),
    notImplementedCommand('toggleClaudePluginCli'),
    notImplementedCommand('installClaudePluginCli'),
    notImplementedCommand('uninstallClaudePluginCli'),
    notLoadedYetReason('listCodexApps'),
    async () => {
      count('detectCodexImportCandidates');
      return { snapshot: { ok: false as const, reason: 'fake' }, rawByKey: new Map() };
    },
    notLoadedYetReason('readCodexImportHistories'),
    notImplementedError('runCodexImportCli'),
    fakeLogger,
  );

  return { settings, calls };
}

describe('SettingsProviderのセクション単位の遅延取得（issue #225）', () => {
  it('load()は即時に読むもの（モデル・エージェント）だけを取得し、セクションのCLIは起動しない', async () => {
    const { settings, calls } = createSettingsProvider();

    await settings.load();

    expect(calls.listCodexModels).toBe(1);
    expect(calls.listClaudeModels).toBe(1);
    expect(calls.listClaudeAgents).toBe(1);
    // 展開したことのないセクションのCLIは1件も起動しない
    expect(calls.listCodexMcpServers).toBeUndefined();
    expect(calls.listClaudeMcpServers).toBeUndefined();
    expect(calls.listCodexHooks).toBeUndefined();
    expect(calls.listClaudeHooks).toBeUndefined();
    expect(calls.listCodexSkills).toBeUndefined();
    expect(calls.listClaudeSkills).toBeUndefined();
    expect(calls.readCodexAccount).toBeUndefined();
    expect(calls.readClaudeAccount).toBeUndefined();
    expect(calls.listCodexPlugins).toBeUndefined();
    expect(calls.listClaudePlugins).toBeUndefined();
    expect(calls.listCodexApps).toBeUndefined();
    expect(calls.detectCodexImportCandidates).toBeUndefined();
    expect(calls.readCodexImportHistories).toBeUndefined();
  });

  it('ensureSectionLoadedは要求したセクションだけCLIを起動する', async () => {
    const { settings, calls } = createSettingsProvider();
    await settings.load();

    await settings.ensureSectionLoaded('codexMcp');

    expect(calls.listCodexMcpServers).toBe(1);
    expect(calls.readCodexAccount).toBeUndefined();
    expect(calls.listCodexHooks).toBeUndefined();
  });

  it('一度取得したセクションはensureSectionLoadedを呼び直してもCLIを起動し直さない', async () => {
    const { settings, calls } = createSettingsProvider();

    await settings.ensureSectionLoaded('codexAccount');
    expect(calls.readCodexAccount).toBe(1);

    await settings.ensureSectionLoaded('codexAccount');
    await settings.ensureSectionLoaded('codexAccount');

    expect(calls.readCodexAccount).toBe(1);
  });

  it('load()は展開済みのセクションを読み直す（既存操作の直後に古い内容が残らない）', async () => {
    const { settings, calls } = createSettingsProvider();
    await settings.ensureSectionLoaded('codexMcp');
    expect(calls.listCodexMcpServers).toBe(1);

    await settings.load();

    expect(calls.listCodexMcpServers).toBe(2);
    // 一度も展開していないセクションはload()でも読まない
    expect(calls.readCodexAccount).toBeUndefined();
  });

  it('codexImportセクションは候補と履歴をまとめて1セクションとして取得する', async () => {
    const { settings, calls } = createSettingsProvider();

    await settings.ensureSectionLoaded('codexImport');

    expect(calls.detectCodexImportCandidates).toBe(1);
    expect(calls.readCodexImportHistories).toBe(1);
  });

  it('snapshot()/claudeSnapshot()は未取得セクションを「まだ読み込んでいません」で返す', async () => {
    const { settings } = createSettingsProvider();
    await settings.load();

    const snapshot = settings.snapshot();
    expect(snapshot.mcpServers).toEqual(NOT_LOADED_YET);
    expect(snapshot.account).toEqual(NOT_LOADED_YET);
    expect(snapshot.hooks).toEqual(NOT_LOADED_YET);
    expect(snapshot.skills).toEqual(NOT_LOADED_YET);
    expect(snapshot.plugins).toEqual(NOT_LOADED_YET);
    expect(snapshot.apps).toEqual(NOT_LOADED_YET);
    expect(snapshot.importCandidates).toEqual(NOT_LOADED_YET);
    expect(snapshot.importHistory).toEqual(NOT_LOADED_YET);

    const claudeSnapshot = settings.claudeSnapshot();
    expect(claudeSnapshot.mcpServers).toEqual(NOT_LOADED_YET);
    expect(claudeSnapshot.account).toEqual(NOT_LOADED_YET);
  });

  it('reloadClaudeSkillsで読んだ後は、そのセクションもload()の読み直し対象になる', async () => {
    const { settings, calls } = createSettingsProvider();

    await settings.reloadClaudeSkills();
    expect(calls.listClaudeSkills).toBe(1);

    await settings.load();

    expect(calls.listClaudeSkills).toBe(2);
  });

  it(
    '取得中に同じセクションへ重複してensureSectionLoadedを呼んでもCLIは1回しか' +
      '起動せず、完了後は両方の呼び出しが解決する（issue #225 レビュー指摘2）',
    async () => {
      let resolveFetch: (() => void) | undefined;
      const { settings, calls } = createSettingsProvider({
        listCodexMcpServers: () =>
          new Promise((resolve) => {
            resolveFetch = () => resolve({ ok: false, reason: 'fake' });
          }),
      });

      const first = settings.ensureSectionLoaded('codexMcp');
      const second = settings.ensureSectionLoaded('codexMcp');
      // まだ`fetchSection`が解決していないうちに2件目の要求を出しても、CLIの起動は
      // 1回目の実行中のPromiseへ相乗りするだけで、この時点ではまだ1回しか起動しない
      expect(calls.listCodexMcpServers).toBe(1);

      resolveFetch?.();
      await Promise.all([first, second]);

      expect(calls.listCodexMcpServers).toBe(1);
    },
  );

  it(
    '取得中のセクションはloadingSectionsに載り、完了すると外れる' +
      '（issue #225 レビュー指摘1、ControlPanelViewProviderがstateへ載せる元）',
    async () => {
      let resolveFetch: (() => void) | undefined;
      const { settings } = createSettingsProvider({
        listCodexMcpServers: () =>
          new Promise((resolve) => {
            resolveFetch = () => resolve({ ok: false, reason: 'fake' });
          }),
      });

      expect(settings.loadingSections).toEqual([]);

      const loading = settings.ensureSectionLoaded('codexMcp');
      expect(settings.loadingSections).toEqual(['codexMcp']);

      resolveFetch?.();
      await loading;

      expect(settings.loadingSections).toEqual([]);
    },
  );

  it(
    '別セクションを開いている間に他のセクションが取得中でも、その別セクションの' +
      '取得自体は待たされず独立して進む（issue #225 レビュー指摘1の競合再現）',
    async () => {
      let resolveMcpFetch: (() => void) | undefined;
      const { settings, calls } = createSettingsProvider({
        listCodexMcpServers: () =>
          new Promise((resolve) => {
            resolveMcpFetch = () => resolve({ ok: false, reason: 'fake' });
          }),
      });

      // セクションA（codexMcp）を開く。fetchSectionはまだ解決しない
      const loadingA = settings.ensureSectionLoaded('codexMcp');

      // Aの応答を待たずにセクションB（codexAccount）を開く。Bの取得はAとは独立
      // した別のCLI呼び出しなので、Aの完了を待たずに解決してよい
      await settings.ensureSectionLoaded('codexAccount');

      expect(calls.readCodexAccount).toBe(1);
      // このタイミングではAはまだ取得中のまま（loadingSectionsに残っている）。
      // ここが直る前は、Bのtoggleが引き起こす`post()`でstate全体が再送され、
      // Aの「読み込み中…」が「取得できませんでした」へ一時的に上書きされていた
      expect(settings.loadingSections).toEqual(['codexMcp']);

      resolveMcpFetch?.();
      await loadingA;

      expect(settings.loadingSections).toEqual([]);
    },
  );
});
