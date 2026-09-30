import { describe, expect, it } from 'vitest';
import {
  buildContextUsage,
  modelWindowOf,
  readAutoCompactTokenLimit,
  rebaseContextUsage,
} from '../../src/appserver/chatState';
import {
  extractAutoCompactWindow,
  readClaudeAutoCompactWindow,
} from '../../src/claude/autoCompactSettings';

describe('extractAutoCompactWindow', () => {
  it('下限以上の数なら返す', () => {
    expect(extractAutoCompactWindow('{"autoCompactWindow":200000}')).toBe(200000);
  });
  it('下限未満・0・負・非数・不正JSONは undefined', () => {
    expect(extractAutoCompactWindow('{"autoCompactWindow":1}')).toBeUndefined();
    expect(extractAutoCompactWindow('{"autoCompactWindow":-5}')).toBeUndefined();
    expect(extractAutoCompactWindow('{"autoCompactWindow":"x"}')).toBeUndefined();
    expect(extractAutoCompactWindow('{')).toBeUndefined();
  });
});

describe('readClaudeAutoCompactWindow', () => {
  const files: Record<string, string> = {
    '/w/.claude/settings.json': '{"autoCompactWindow":150000}',
    '/h/settings.json': '{"autoCompactWindow":300000}',
  };
  const read = (p: string): string | undefined => files[p];
  it('project が user より優先される', () => {
    expect(readClaudeAutoCompactWindow('/w', { CLAUDE_CONFIG_DIR: '/h' }, read)).toBe(150000);
  });
  it('local に有効値があれば最優先', () => {
    const r = (p: string): string | undefined =>
      p === '/w/.claude/settings.local.json' ? '{"autoCompactWindow":90000}' : read(p);
    expect(readClaudeAutoCompactWindow('/w', { CLAUDE_CONFIG_DIR: '/h' }, r)).toBe(90000);
  });
  it('無効値の層は飛ばして次の層を使う', () => {
    const r = (p: string): string | undefined =>
      p === '/w/.claude/settings.json' ? '{"autoCompactWindow":1}' : read(p);
    expect(readClaudeAutoCompactWindow('/w', { CLAUDE_CONFIG_DIR: '/h' }, r)).toBe(300000);
  });
  it('どこにも無ければ undefined', () => {
    expect(readClaudeAutoCompactWindow('/x', { CLAUDE_CONFIG_DIR: '/y' }, () => undefined)).toBe(
      undefined,
    );
  });
});

describe('buildContextUsage (auto-compact上限)', () => {
  it('上限がモデルの窓以下なら分母にする', () => {
    const u = buildContextUsage(50000, 1000000, 200000);
    expect(u).toMatchObject({
      contextWindow: 200000,
      remainingPercent: 75,
      autoCompact: true,
      modelWindow: 1000000,
    });
  });
  it('上限がモデルの窓より大きければモデルの窓を使う', () => {
    const u = buildContextUsage(50000, 100000, 200000);
    expect(u).toMatchObject({ contextWindow: 100000, autoCompact: false, modelWindow: 100000 });
  });
  it('下限未満の上限は無視する', () => {
    expect(buildContextUsage(50000, 100000, 1)).toMatchObject({
      contextWindow: 100000,
      autoCompact: false,
    });
  });
});

describe('rebaseContextUsage / modelWindowOf', () => {
  it('上限が広がったらモデルの窓へ戻せる', () => {
    const narrow = buildContextUsage(50000, 1000000, 200000);
    expect(modelWindowOf(narrow)).toBe(1000000);
    expect(rebaseContextUsage(narrow, undefined)).toMatchObject({
      contextWindow: 1000000,
      autoCompact: false,
    });
  });
  it('undefined はそのまま', () => {
    expect(rebaseContextUsage(undefined, 200000)).toBeUndefined();
    expect(modelWindowOf(undefined)).toBeUndefined();
  });
});

describe('readAutoCompactTokenLimit', () => {
  it('total スコープの値を返す', () => {
    const r = { config: { model_auto_compact_token_limit: 200000 } };
    expect(readAutoCompactTokenLimit(r)).toBe(200000);
  });
  it('body_after_prefix・下限未満・未設定は undefined', () => {
    expect(
      readAutoCompactTokenLimit({
        config: {
          model_auto_compact_token_limit: 200000,
          model_auto_compact_token_limit_scope: 'body_after_prefix',
        },
      }),
    ).toBeUndefined();
    expect(
      readAutoCompactTokenLimit({ config: { model_auto_compact_token_limit: 1 } }),
    ).toBeUndefined();
    expect(readAutoCompactTokenLimit({})).toBeUndefined();
  });
});
