import { describe, expect, it } from 'vitest';
import {
  buildImportItemKey,
  parseDetectResponse,
  parseImportNotification,
  parseImportResponse,
  parseReadHistoriesResponse,
} from '../../src/codex/importStatus';

/**
 * `externalAgentConfig/detect` の応答の形。実測（codex-cli 0.147.0。`includeHome: true` で
 * 呼び出し、実際の応答を確認した。この環境の設定は変更していない）から、
 * パス等を匿名化して間引いたもの。
 */
const detectResult = {
  items: [
    {
      itemType: 'CONFIG',
      description: 'Migrate /home/user/.claude/settings.json into /home/user/.codex/config.toml',
      cwd: null,
      details: null,
    },
    {
      itemType: 'HOOKS',
      description: 'Migrate hooks from /home/user/.claude to /home/user/.codex/hooks.json',
      cwd: null,
      details: {
        plugins: [],
        skills: [],
        sessions: [],
        mcpServers: [],
        hooks: [{ name: 'PreToolUse' }, { name: 'PostToolUse' }],
        subagents: [],
        commands: [],
      },
    },
    {
      itemType: 'SKILLS',
      description: 'Migrate skills from /home/user/.claude/skills to /home/user/.agents/skills',
      cwd: null,
      details: {
        plugins: [],
        skills: [{ name: 'gitlab-commit' }, { name: 'daily-report' }, { name: 'skill-creator' }],
        sessions: [],
        mcpServers: [],
        hooks: [],
        subagents: [],
        commands: [],
      },
    },
    {
      itemType: 'PLUGINS',
      description: 'Migrate enabled plugins from /home/user/.claude/settings.json',
      cwd: null,
      details: {
        plugins: [{ marketplaceName: 'genshijin', pluginNames: ['genshijin'] }],
        skills: [],
        sessions: [],
        mcpServers: [],
        hooks: [],
        subagents: [],
        commands: [],
      },
    },
    {
      itemType: 'SESSIONS',
      description: 'Migrate recent sessions from /home/user/.claude/projects',
      cwd: null,
      details: {
        plugins: [],
        skills: [],
        sessions: [
          { path: '/home/user/.claude/projects/a/1.jsonl', cwd: '/workspace/repo', title: 'Issue対応' },
          { path: '/home/user/.claude/projects/a/2.jsonl', cwd: '/workspace/repo', title: null },
        ],
        mcpServers: [],
        hooks: [],
        subagents: [],
        commands: [],
      },
    },
    {
      itemType: 'MEMORY',
      description: 'Migrate memory entries',
      cwd: '/workspace/repo',
      details: {
        plugins: [],
        skills: [],
        sessions: [],
        mcpServers: [],
        hooks: [],
        subagents: [],
        commands: [],
        memory: ['機密性のある内容の可能性がある1行目', '2行目'],
      },
    },
  ],
  connectors: [],
};

describe('parseDetectResponse', () => {
  it('itemTypeとdescriptionをそのまま一覧にする', () => {
    const { items } = parseDetectResponse(detectResult);
    const config = items.find((i) => i.itemType === 'CONFIG');
    expect(config?.description).toBe(
      'Migrate /home/user/.claude/settings.json into /home/user/.codex/config.toml',
    );
    expect(config?.label).toBe('設定（config.toml）');
  });

  it('cwdがnullならhomeスコープ、値があればprojectスコープにする', () => {
    const { items } = parseDetectResponse(detectResult);
    expect(items.find((i) => i.itemType === 'CONFIG')?.scope).toBe('home');
    expect(items.find((i) => i.itemType === 'MEMORY')?.scope).toBe('project');
    expect(items.find((i) => i.itemType === 'MEMORY')?.cwd).toBe('/workspace/repo');
  });

  it('itemType:cwdをキーにする', () => {
    const { items } = parseDetectResponse(detectResult);
    expect(items.find((i) => i.itemType === 'CONFIG')?.key).toBe(buildImportItemKey('CONFIG', null));
    expect(items.find((i) => i.itemType === 'MEMORY')?.key).toBe(
      buildImportItemKey('MEMORY', '/workspace/repo'),
    );
  });

  it('name付きの内訳（hooks/skills）を名前の一覧として要約する', () => {
    const { items } = parseDetectResponse(detectResult);
    const hooks = items.find((i) => i.itemType === 'HOOKS');
    const hooksDetail = hooks?.details.find((d) => d.kind === 'hooks');
    expect(hooksDetail).toEqual({
      kind: 'hooks',
      count: 2,
      sampleNames: ['PreToolUse', 'PostToolUse'],
      moreCount: 0,
    });

    const skills = items.find((i) => i.itemType === 'SKILLS');
    const skillsDetail = skills?.details.find((d) => d.kind === 'skills');
    expect(skillsDetail?.sampleNames).toEqual(['gitlab-commit', 'daily-report', 'skill-creator']);
  });

  it('pluginsは pluginName@marketplaceName の形にする', () => {
    const { items } = parseDetectResponse(detectResult);
    const plugins = items.find((i) => i.itemType === 'PLUGINS');
    const detail = plugins?.details.find((d) => d.kind === 'plugins');
    expect(detail?.sampleNames).toEqual(['genshijin@genshijin']);
  });

  it('sessionsはtitle（無ければcwd）を代表名にする', () => {
    const { items } = parseDetectResponse(detectResult);
    const sessions = items.find((i) => i.itemType === 'SESSIONS');
    const detail = sessions?.details.find((d) => d.kind === 'sessions');
    expect(detail?.count).toBe(2);
    expect(detail?.sampleNames).toEqual(['Issue対応', '/workspace/repo']);
  });

  it('memoryは中身を出さず件数のみにする（会話本文と同じ扱い）', () => {
    const { items } = parseDetectResponse(detectResult);
    const memory = items.find((i) => i.itemType === 'MEMORY');
    const detail = memory?.details.find((d) => d.kind === 'memory');
    expect(detail).toEqual({ kind: 'memory', count: 2, sampleNames: [], moreCount: 0 });
  });

  it('サンプル件数の上限を超えたらmoreCountへ回す', () => {
    const many = {
      items: [
        {
          itemType: 'SKILLS',
          description: 'x',
          cwd: null,
          details: {
            skills: Array.from({ length: 10 }, (_, i) => ({ name: `skill-${i}` })),
          },
        },
      ],
    };
    const { items } = parseDetectResponse(many);
    const detail = items[0]?.details.find((d) => d.kind === 'skills');
    expect(detail?.count).toBe(10);
    expect(detail?.sampleNames).toHaveLength(8);
    expect(detail?.moreCount).toBe(2);
  });

  it('未知のitemTypeでも一覧を落とさずUNKNOWN扱いにする', () => {
    const { items } = parseDetectResponse({
      items: [{ itemType: 'SOMETHING_NEW', description: 'x', cwd: null, details: null }],
    });
    expect(items[0]?.itemType).toBe('UNKNOWN');
    expect(items[0]?.label).toBe('SOMETHING_NEW');
  });

  it('rawByKeyにimportへ再送するための生データを保持する', () => {
    const { rawByKey } = parseDetectResponse(detectResult);
    const raw = rawByKey.get(buildImportItemKey('CONFIG', null));
    expect(raw).toEqual(detectResult.items[0]);
  });

  it('想定外の形では空を返す', () => {
    expect(parseDetectResponse(undefined).items).toEqual([]);
    expect(parseDetectResponse(null).items).toEqual([]);
    expect(parseDetectResponse({}).items).toEqual([]);
    expect(parseDetectResponse({ items: 'x' }).items).toEqual([]);
  });

  it('itemTypeを持たない項目は読み飛ばす', () => {
    const { items } = parseDetectResponse({ items: [{ description: 'x' }] });
    expect(items).toEqual([]);
  });
});

describe('parseImportResponse', () => {
  it('importIdを取り出す', () => {
    expect(parseImportResponse({ importId: 'imp-1' })).toBe('imp-1');
  });

  it('想定外の形ではundefinedを返す', () => {
    expect(parseImportResponse(undefined)).toBeUndefined();
    expect(parseImportResponse({})).toBeUndefined();
  });
});

/**
 * `externalAgentConfig/import/completed`（および`progress`）通知の形。スキーマ根拠
 * （実行していないため実測ではない）。
 */
const completedNotification = {
  importId: 'imp-1',
  itemTypeResults: [
    {
      itemType: 'SKILLS',
      successes: [{ itemType: 'SKILLS', target: '/home/user/.agents/skills/gitlab-commit' }],
      failures: [],
    },
    {
      itemType: 'HOOKS',
      successes: [],
      failures: [{ itemType: 'HOOKS', failureStage: 'write', message: '書き込みに失敗しました' }],
    },
  ],
};

describe('parseImportNotification', () => {
  it('importIdと種別ごとの成功/失敗件数を取り出す', () => {
    const parsed = parseImportNotification(completedNotification);
    expect(parsed?.importId).toBe('imp-1');
    expect(parsed?.results).toEqual([
      { itemType: 'SKILLS', label: 'skills', successCount: 1, failureCount: 0, failureMessages: [] },
      {
        itemType: 'HOOKS',
        label: 'hooks',
        successCount: 0,
        failureCount: 1,
        failureMessages: ['書き込みに失敗しました'],
      },
    ]);
  });

  it('想定外の形ではundefinedを返す', () => {
    expect(parseImportNotification(undefined)).toBeUndefined();
    expect(parseImportNotification({})).toBeUndefined();
  });
});

/**
 * `externalAgentConfig/import/readHistories` の応答の形。実測（この環境は過去の実行が
 * 無かったため `data: []` だった。ここでは形の確認用に合成データを使う。スキーマ根拠）。
 */
const readHistoriesResult = {
  data: [
    {
      importId: 'imp-old',
      completedAtMs: 1000,
      providerId: 'vscode-codex-extension',
      successes: [{ itemType: 'SKILLS' }, { itemType: 'SKILLS' }],
      failures: [{ itemType: 'HOOKS', failureStage: 'write', message: '失敗しました' }],
    },
    {
      importId: 'imp-new',
      completedAtMs: 2000,
      providerId: null,
      successes: [{ itemType: 'CONFIG' }],
      failures: [],
    },
  ],
  connectors: [],
};

describe('parseReadHistoriesResponse', () => {
  it('新しい実行を先頭にする', () => {
    const entries = parseReadHistoriesResponse(readHistoriesResult);
    expect(entries.map((e) => e.importId)).toEqual(['imp-new', 'imp-old']);
  });

  it('成功/失敗をitemType単位でまとめる', () => {
    const entries = parseReadHistoriesResponse(readHistoriesResult);
    const old = entries.find((e) => e.importId === 'imp-old');
    expect(old?.results).toEqual([
      { itemType: 'SKILLS', label: 'skills', successCount: 2, failureCount: 0, failureMessages: [] },
      {
        itemType: 'HOOKS',
        label: 'hooks',
        successCount: 0,
        failureCount: 1,
        failureMessages: ['失敗しました'],
      },
    ]);
  });

  it('providerIdがnullならundefinedにする', () => {
    const entries = parseReadHistoriesResponse(readHistoriesResult);
    expect(entries.find((e) => e.importId === 'imp-new')?.providerId).toBeUndefined();
  });

  it('想定外の形では空を返す', () => {
    expect(parseReadHistoriesResponse(undefined)).toEqual([]);
    expect(parseReadHistoriesResponse({})).toEqual([]);
  });
});
