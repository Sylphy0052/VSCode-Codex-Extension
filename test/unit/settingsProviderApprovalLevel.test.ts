import { beforeEach, describe, expect, it } from 'vitest';
import { __mock, workspace } from '../mocks/vscode';
import type { Logger } from '../../src/log';
import { SettingsProvider } from '../../src/view/settingsProvider';

const fakeLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  show: () => undefined,
};

/**
 * `updateApprovalLevel` だけを動かすための最小の `SettingsProvider`。
 *
 * 依存は全て「呼ばれたら失敗を返す」フェイクで埋める。承認レベルの書き込みは
 * `vscode.workspace.getConfiguration` しか使わないため、CLI側は一度も呼ばれない
 * （`settingsProviderSections.test.ts` の組み立てと同じ考え方で、こちらは回数を数えない）。
 */
function createSettingsProvider(): SettingsProvider {
  const reason = async () => ({ ok: false as const, reason: 'fake' });
  const error = async () => ({ ok: false as const, error: 'fake' });
  const command = async () => ({ code: 1, stderr: 'fake' });

  return new SettingsProvider(
    { readTextFile: async () => undefined } as never,
    '/fake/models-cache',
    '/fake/config.toml',
    '/fake/claude-settings.json',
    async () => [],
    async () => undefined,
    async () => undefined,
    reason,
    reason,
    error,
    error,
    reason,
    reason,
    error,
    reason,
    reason,
    error,
    reason,
    reason,
    command,
    command,
    command,
    reason,
    reason,
    error,
    error,
    command,
    command,
    command,
    reason,
    async () => ({ snapshot: { ok: false as const, reason: 'fake' }, rawByKey: new Map() }),
    reason,
    error,
    fakeLogger,
  );
}

/** そのときの `codex` 設定（モックが保持している値）。 */
function codexConfig(): Record<string, unknown> {
  const section = workspace.getConfiguration('codex');
  return {
    approvalMode: section.get('approvalMode'),
    sandbox: section.get('sandbox'),
    approvalsReviewer: section.get('approvalsReviewer'),
    bypassApprovalsAndSandbox: section.get('bypassApprovalsAndSandbox'),
  };
}

// bypassは3項目より優先されるため、レベルを戻しても残っていると保護が戻らない（issue #1180）
describe('updateApprovalLevel とbypassの整合（issue #1180）', () => {
  beforeEach(() => {
    __mock.reset();
    __mock.setConfig('codex', {
      approvalMode: 'never',
      sandbox: 'danger-full-access',
      approvalsReviewer: 'user',
      bypassApprovalsAndSandbox: true,
    });
  });

  it('askへ戻すとbypassも解除される', async () => {
    const settings = createSettingsProvider();

    await expect(settings.updateApprovalLevel('codex', 'ask')).resolves.toBe(true);

    expect(codexConfig()).toEqual({
      approvalMode: 'untrusted',
      sandbox: 'workspace-write',
      approvalsReviewer: 'user',
      bypassApprovalsAndSandbox: false,
    });
  });

  it('autoへ戻すとbypassも解除される', async () => {
    const settings = createSettingsProvider();

    await expect(settings.updateApprovalLevel('codex', 'auto')).resolves.toBe(true);

    expect(codexConfig()).toEqual({
      approvalMode: 'on-request',
      sandbox: 'workspace-write',
      approvalsReviewer: 'auto_review',
      bypassApprovalsAndSandbox: false,
    });
  });

  it('fullを選び直した場合もbypassは残さない（3項目だけで表現する）', async () => {
    const settings = createSettingsProvider();
    __mock.showWarningMessageAnswer = 'この設定にする';

    await expect(settings.updateApprovalLevel('codex', 'full')).resolves.toBe(true);

    expect(codexConfig().bypassApprovalsAndSandbox).toBe(false);
  });

  it('bypassを解除できなければ成功扱いにせず、3項目も書き換えない', async () => {
    const settings = createSettingsProvider();
    // 書き込みを黙って捨てる設定にして、解除できない状況を作る
    const original = workspace.getConfiguration;
    workspace.getConfiguration = ((section: string) => {
      const real = original(section);
      return {
        get: real.get,
        update: async (key: string, value: unknown) =>
          key === 'bypassApprovalsAndSandbox' ? undefined : real.update(key, value),
      };
    }) as typeof original;

    try {
      await expect(settings.updateApprovalLevel('codex', 'ask')).resolves.toBe(false);
    } finally {
      workspace.getConfiguration = original;
    }

    // 3項目は元のまま。「全確認と表示されるのに実際は素通し」を新たに作らない
    expect(codexConfig()).toEqual({
      approvalMode: 'never',
      sandbox: 'danger-full-access',
      approvalsReviewer: 'user',
      bypassApprovalsAndSandbox: true,
    });
    expect(__mock.messages.warnings[0]).toContain('承認レベルを変更できませんでした');
  });

  it('もともとbypassが立っていなければ、そのまま従来どおり書き換える', async () => {
    __mock.setConfig('codex', {
      approvalMode: 'on-request',
      sandbox: 'workspace-write',
      approvalsReviewer: 'auto_review',
      bypassApprovalsAndSandbox: false,
    });
    const settings = createSettingsProvider();

    await expect(settings.updateApprovalLevel('codex', 'ask')).resolves.toBe(true);

    expect(codexConfig()).toEqual({
      approvalMode: 'untrusted',
      sandbox: 'workspace-write',
      approvalsReviewer: 'user',
      bypassApprovalsAndSandbox: false,
    });
  });
});
