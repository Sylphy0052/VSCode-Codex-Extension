import { describe, expect, it } from 'vitest';
import { readHooksFromSettings } from '../../src/claude/hooksSettings';

/**
 * `get_settings` の応答を模したもの。実測(CLI 2.1.227)で、`~/.claude/settings.json` に
 * PreToolUse/PostToolUseのhookを、プロジェクトの `.claude/settings.json` に
 * SessionStartのhookを1件だけ置いた状態で取得した実際の形をそのまま縮めたもの
 * (issue #28の調査で実際に確認)。
 */
const getSettingsResult = {
  effective: {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            { type: 'command', command: 'bash $HOME/.claude/hooks/pre-bash-guard.sh' },
            { type: 'command', command: 'python3 $HOME/.claude/hooks/dangerous-command-guard.py' },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: 'Write|Edit',
          hooks: [{ type: 'command', command: 'bash $HOME/.claude/hooks/auto-format.sh' }],
        },
      ],
      SessionStart: [
        {
          matcher: 'startup',
          hooks: [{ type: 'command', command: 'echo project-hook-probe' }],
        },
      ],
    },
  },
  sources: [
    {
      source: 'userSettings',
      settings: {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                { type: 'command', command: 'bash $HOME/.claude/hooks/pre-bash-guard.sh' },
                {
                  type: 'command',
                  command: 'python3 $HOME/.claude/hooks/dangerous-command-guard.py',
                },
              ],
            },
          ],
          PostToolUse: [
            {
              matcher: 'Write|Edit',
              hooks: [{ type: 'command', command: 'bash $HOME/.claude/hooks/auto-format.sh' }],
            },
          ],
        },
      },
    },
    {
      source: 'projectSettings',
      settings: {
        hooks: {
          SessionStart: [
            {
              matcher: 'startup',
              hooks: [{ type: 'command', command: 'echo project-hook-probe' }],
            },
          ],
        },
      },
    },
  ],
  applied: { model: 'claude-opus-5[1m]', effort: 'high' },
};

describe('readHooksFromSettings', () => {
  it('イベント・matcher・コマンドを取り出す', () => {
    const hooks = readHooksFromSettings(getSettingsResult);
    const preToolUseHooks = hooks?.filter((h) => h.eventName === 'PreToolUse');
    expect(preToolUseHooks).toHaveLength(2);
    expect(preToolUseHooks?.[0]).toMatchObject({
      eventName: 'PreToolUse',
      matcher: 'Bash',
      handlerType: 'command',
      command: 'bash $HOME/.claude/hooks/pre-bash-guard.sh',
    });
  });

  it('userSettings由来のhookをoriginで見分ける', () => {
    const hooks = readHooksFromSettings(getSettingsResult);
    const userHook = hooks?.find((h) => h.command?.includes('pre-bash-guard'));
    expect(userHook?.origin).toBe('user');
    expect(userHook?.originDetail).toBe('userSettings');
  });

  it('projectSettings由来(リポジトリ内)のhookをoriginで見分ける', () => {
    const hooks = readHooksFromSettings(getSettingsResult);
    const projectHook = hooks?.find((h) => h.eventName === 'SessionStart');
    expect(projectHook?.origin).toBe('project');
    expect(projectHook?.originDetail).toBe('projectSettings');
  });

  it('信頼状態は常にunsupported(プロトコルに信頼の概念が無いため)', () => {
    const hooks = readHooksFromSettings(getSettingsResult);
    expect(hooks?.every((h) => h.trust === 'unsupported')).toBe(true);
    expect(hooks?.every((h) => h.trustHash === undefined)).toBe(true);
  });

  it('どのsourceにも見つからないグループはunknown(plugin由来の可能性がある)', () => {
    const hooks = readHooksFromSettings({
      effective: {
        hooks: {
          SessionStart: [
            { matcher: 'startup', hooks: [{ type: 'command', command: 'plugin-injected' }] },
          ],
        },
      },
      sources: [{ source: 'userSettings', settings: {} }],
    });
    expect(hooks?.[0]?.origin).toBe('unknown');
    expect(hooks?.[0]?.originDetail).toBeUndefined();
  });

  it('hooksが無いときはundefined(空の一覧と区別する)', () => {
    expect(readHooksFromSettings({ effective: {} })).toBeUndefined();
    expect(readHooksFromSettings({})).toBeUndefined();
    expect(readHooksFromSettings(undefined)).toBeUndefined();
  });

  it('hooksが空オブジェクトなら空配列(0件そのもの)', () => {
    expect(readHooksFromSettings({ effective: { hooks: {} } })).toEqual([]);
  });
});
