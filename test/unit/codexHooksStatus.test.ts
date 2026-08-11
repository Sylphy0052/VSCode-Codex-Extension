import { describe, expect, it } from 'vitest';
import { buildHookTrustEdit, parseHooksList } from '../../src/codex/hooksStatus';

/**
 * `hooks/list` の応答の形。この環境ではhookが1件も設定されていないため実測できず、
 * `codex app-server generate-json-schema --out` の `HooksListResponse` / `HookMetadata` が
 * 根拠(スキーマ由来。実測ではない)。
 */
const hooksListResult = {
  data: [
    {
      cwd: '/workspace/repo',
      warnings: ['legacy hook format detected'],
      errors: [{ message: 'invalid matcher', path: '/workspace/repo/.codex/config.toml' }],
      hooks: [
        {
          key: 'user-pre-commit',
          eventName: 'preToolUse',
          matcher: 'Bash',
          handlerType: 'command',
          command: 'echo hi',
          source: 'user',
          sourcePath: '/home/user/.codex/config.toml',
          pluginId: null,
          enabled: true,
          trustStatus: 'trusted',
          currentHash: 'hash-a',
          displayOrder: 0,
          isManaged: false,
          timeoutSec: 30,
          statusMessage: null,
          additionalContextLimit: null,
        },
        {
          key: 'project-post-commit',
          eventName: 'postToolUse',
          matcher: null,
          handlerType: 'command',
          command: 'rm -rf $REPO',
          source: 'project',
          sourcePath: '/workspace/repo/.codex/config.toml',
          pluginId: null,
          enabled: true,
          trustStatus: 'untrusted',
          currentHash: 'hash-b',
          displayOrder: 1,
          isManaged: false,
          timeoutSec: 30,
          statusMessage: null,
          additionalContextLimit: null,
        },
        {
          key: 'plugin-hook',
          eventName: 'sessionStart',
          matcher: null,
          handlerType: 'prompt',
          command: null,
          source: 'plugin',
          sourcePath: '/home/user/.codex/plugins/foo/hooks.toml',
          pluginId: 'foo',
          enabled: true,
          trustStatus: 'managed',
          currentHash: 'hash-c',
          displayOrder: 2,
          isManaged: true,
          timeoutSec: 30,
          statusMessage: null,
          additionalContextLimit: null,
        },
      ],
    },
  ],
};

describe('parseHooksList', () => {
  it('イベント・コマンド・出どころ・信頼状態を読む', () => {
    const { hooks } = parseHooksList(hooksListResult);
    expect(hooks).toHaveLength(3);

    const projectHook = hooks.find((h) => h.key === 'project-post-commit');
    expect(projectHook).toEqual({
      key: 'project-post-commit',
      eventName: 'postToolUse',
      matcher: undefined,
      handlerType: 'command',
      command: 'rm -rf $REPO',
      origin: 'project',
      originDetail: '/workspace/repo/.codex/config.toml',
      pluginId: undefined,
      enabled: true,
      trust: 'untrusted',
      trustHash: 'hash-b',
    });
  });

  it('プラグイン由来のhookはpluginIdを持つ', () => {
    const { hooks } = parseHooksList(hooksListResult);
    const pluginHook = hooks.find((h) => h.key === 'plugin-hook');
    expect(pluginHook?.origin).toBe('plugin');
    expect(pluginHook?.pluginId).toBe('foo');
    expect(pluginHook?.command).toBeUndefined();
  });

  it('warningsとerrorsを1つの一覧にまとめる', () => {
    const { warnings } = parseHooksList(hooksListResult);
    expect(warnings).toEqual([
      'legacy hook format detected',
      'invalid matcher (/workspace/repo/.codex/config.toml)',
    ]);
  });

  it('イベント名・key順に並べる', () => {
    const { hooks } = parseHooksList(hooksListResult);
    // postToolUse < preToolUse < sessionStart (localeCompare)
    expect(hooks.map((h) => h.key)).toEqual([
      'project-post-commit',
      'user-pre-commit',
      'plugin-hook',
    ]);
  });

  it('keyを持たないhookは読み飛ばす', () => {
    const { hooks } = parseHooksList({ data: [{ hooks: [{ eventName: 'preToolUse' }] }] });
    expect(hooks).toEqual([]);
  });

  it('同じkeyが複数のcwdに現れても1件に畳む', () => {
    const dup = {
      data: [
        { hooks: [{ key: 'a', eventName: 'preToolUse', source: 'user', sourcePath: 'p' }] },
        { hooks: [{ key: 'a', eventName: 'preToolUse', source: 'user', sourcePath: 'p' }] },
      ],
    };
    expect(parseHooksList(dup).hooks).toHaveLength(1);
  });

  it('想定外の形では空を返す', () => {
    expect(parseHooksList(undefined)).toEqual({ hooks: [], warnings: [] });
    expect(parseHooksList(null)).toEqual({ hooks: [], warnings: [] });
    expect(parseHooksList({})).toEqual({ hooks: [], warnings: [] });
    expect(parseHooksList({ data: 'x' })).toEqual({ hooks: [], warnings: [] });
  });

  it('未知のsourceやtrustStatusは安全側(unknown/untrusted)へ倒す', () => {
    const { hooks } = parseHooksList({
      data: [
        {
          hooks: [
            { key: 'x', eventName: 'preToolUse', source: 'somethingNew', trustStatus: 'newState' },
          ],
        },
      ],
    });
    expect(hooks[0]?.origin).toBe('unknown');
    expect(hooks[0]?.trust).toBe('untrusted');
  });
});

describe('buildHookTrustEdit', () => {
  it('hooks.state."<key>".trusted_hash へのupsertを組み立てる(strings調査由来。実測ではない)', () => {
    expect(buildHookTrustEdit('project-post-commit', 'hash-b')).toEqual({
      keyPath: 'hooks.state."project-post-commit".trusted_hash',
      mergeStrategy: 'upsert',
      value: 'hash-b',
    });
  });

  it('不正なkeyは例外にする', () => {
    expect(() => buildHookTrustEdit('a"b', 'hash')).toThrow();
    expect(() => buildHookTrustEdit('', 'hash')).toThrow();
  });
});
