import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __mock } from '../mocks/vscode';
import type { ModelInfo } from '../../src/codex/modelCatalog';
import { resolveHandoffModelSettings } from '../../src/view/handoffModelChoice';
import * as judge from '../../src/view/handoffLevelJudge';

function model(slug: string, efforts: readonly string[]): ModelInfo {
  return {
    slug,
    displayName: slug,
    description: undefined,
    defaultEffort: undefined,
    supportsEffort: efforts.length > 0,
    efforts: efforts.map((effort) => ({ effort, description: undefined })),
  };
}

const FIVE = ['low', 'medium', 'high', 'xhigh', 'max'];
const models = [
  model('gpt-5.6-terra', FIVE),
  model('gpt-5.6-sol', FIVE),
  model('gpt-5.6-astra', FIVE),
];

const current = { model: 'gpt-5.6-sol', effort: 'medium' };
const input = {
  recentUserMessages: ['続きをやって'],
  turnFailed: false,
  cwd: '/workspace/root',
  gitBranch: 'main',
  turnEditedFiles: [],
};

function deps() {
  return { provider: 'codex' as const, executable: 'codex', models };
}

/** 判定を固定値で返させる。実CLIは起動しない。 */
function stubJudge(level: 0 | 1 | 2 | 3 | 4 | 5 | undefined): void {
  vi.spyOn(judge, 'judgeHandoffLevel').mockResolvedValue(
    level === undefined ? undefined : { level, reason: 'テスト' },
  );
}

describe('resolveHandoffModelSettings', () => {
  beforeEach(() => {
    __mock.reset();
    vi.restoreAllMocks();
  });

  it('判定が返ればその値で決まる', async () => {
    stubJudge(4);
    const { settings, reasons } = await resolveHandoffModelSettings(current, input, deps());
    expect(settings).toEqual({ model: 'gpt-5.6-astra', effort: 'high' });
    expect(reasons[0]).toBe('L4: テスト');
  });

  it('判定に失敗したら引き継ぎ元を踏襲する（グローバル設定へ戻さない）', async () => {
    stubJudge(undefined);
    const { settings, reasons } = await resolveHandoffModelSettings(current, input, deps());
    expect(settings).toEqual(current);
    expect(reasons).toContain('レベル判定に失敗したため引き継ぎ元を踏襲');
  });

  it('routerがOFFなら判定を呼ばず引き継ぎ元を踏襲する', async () => {
    __mock.setConfig('agent', { 'autoHandoff.router': false });
    const spy = vi.spyOn(judge, 'judgeHandoffLevel');
    const { settings, reasons } = await resolveHandoffModelSettings(current, input, deps());
    expect(spy).not.toHaveBeenCalled();
    expect(settings).toEqual(current);
    expect(reasons).toContain('レベル判定は無効（引き継ぎ元を踏襲）');
  });

  it('明示設定は判定より優先する', async () => {
    stubJudge(0);
    __mock.setConfig('agent', {
      'autoHandoff.model': 'gpt-5.6-astra',
      'autoHandoff.effort': 'xhigh',
    });
    const { settings } = await resolveHandoffModelSettings(current, input, deps());
    expect(settings).toEqual({ model: 'gpt-5.6-astra', effort: 'xhigh' });
  });

  it('明示モデルで非対応のeffortは未指定へ戻す', async () => {
    stubJudge(5); // xhigh を選ばせる
    __mock.setConfig('agent', { 'autoHandoff.model': 'legacy-model' });
    const withLegacy = [...models, model('legacy-model', ['low'])];
    const { settings, reasons } = await resolveHandoffModelSettings(current, input, {
      ...deps(),
      models: withLegacy,
    });
    expect(settings).toEqual({ model: 'legacy-model', effort: '' });
    expect(reasons).toContain('effortは指定モデルで非対応のため未指定に戻した');
  });

  it('会話しているCLIと同じプロバイダで判定させる', async () => {
    const spy = vi.spyOn(judge, 'judgeHandoffLevel').mockResolvedValue({ level: 2, reason: 'x' });
    await resolveHandoffModelSettings(current, input, {
      provider: 'claude',
      executable: '/usr/bin/claude',
      models,
    });
    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      provider: 'claude',
      executable: '/usr/bin/claude',
    });
  });
});
