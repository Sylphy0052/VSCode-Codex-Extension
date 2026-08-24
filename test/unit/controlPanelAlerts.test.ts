import { describe, expect, it } from 'vitest';
import type { HookTrustState, HookView, HooksSnapshot } from '../../src/provider/hooks';
import type { McpServersSnapshot } from '../../src/provider/mcpServers';
import { buildPanelAlert, type PanelAlertInput } from '../../src/view/controlPanelAlerts';
import type { SectionId } from '../../src/view/settingsProvider';

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

const notLoaded = { ok: false, reason: 'まだ読み込んでいません' } as const;

/** 既定は「すべて読み込み済み・異常なし」。各テストは必要な分だけ差し替える。 */
function input(overrides: Partial<PanelAlertInput> = {}): PanelAlertInput {
  const allSections: SectionId[] = ['codexHooks', 'claudeHooks', 'codexMcp', 'claudeMcp'];
  return {
    codexHooks: hooksOf(),
    claudeHooks: hooksOf(),
    codexMcp: mcpOf(),
    claudeMcp: mcpOf(),
    loadedSections: new Set(allSections),
    ...overrides,
  };
}

describe('buildPanelAlert（issue #741）', () => {
  it('異常が無ければ帯を出さない', () => {
    expect(buildPanelAlert(input())).toBeUndefined();
  });

  it('未信頼のhookがあれば件数つきで出し、hooksのセクションへ飛ばす', () => {
    const alert = buildPanelAlert(input({ codexHooks: hooksOf(hook('untrusted')) }));
    expect(alert).toEqual({
      message: '未信頼または改変されたhookが1件あります',
      sectionId: 'codexHooks',
      severity: 'error',
    });
  });

  it('改変されたhookも同じ数に含める', () => {
    const alert = buildPanelAlert(
      input({ codexHooks: hooksOf(hook('untrusted'), hook('modified'), hook('trusted')) }),
    );
    expect(alert?.message).toBe('未信頼または改変されたhookが2件あります');
  });

  it('managedとunsupportedは数えない', () => {
    // managedは人が承認する対象ではなく、unsupportedは「未信頼だと分かった」わけではない
    const alert = buildPanelAlert(
      input({
        codexHooks: hooksOf(hook('managed')),
        claudeHooks: hooksOf(hook('unsupported'), hook('unsupported')),
      }),
    );
    expect(alert).toBeUndefined();
  });

  it('無効なhookは数えない（実行されないものを警告しても手が無い）', () => {
    const alert = buildPanelAlert(input({ codexHooks: hooksOf(hook('untrusted', false)) }));
    expect(alert).toBeUndefined();
  });

  it('起動していないMCPサーバーがあれば件数つきで出す', () => {
    const alert = buildPanelAlert(input({ codexMcp: mcpOf('connected', 'unavailable') }));
    expect(alert).toEqual({
      message: '起動していないMCPサーバーが1件あります',
      sectionId: 'codexMcp',
      severity: 'warning',
    });
  });

  it('無効化されたMCPサーバーは数えない（人が選んだ状態）', () => {
    expect(buildPanelAlert(input({ codexMcp: mcpOf('disabled') }))).toBeUndefined();
  });

  it('Codex側に無くClaude側にだけあるときはClaudeのセクションへ飛ばす', () => {
    const alert = buildPanelAlert(input({ claudeMcp: mcpOf('unavailable') }));
    expect(alert?.sectionId).toBe('claudeMcp');
  });

  it('両プロバイダのMCPを合算する', () => {
    const alert = buildPanelAlert(
      input({ codexMcp: mcpOf('unavailable'), claudeMcp: mcpOf('unavailable', 'unavailable') }),
    );
    expect(alert?.message).toBe('起動していないMCPサーバーが3件あります');
  });

  it('hookのほうがMCPより重い（両方あればhookを出す）', () => {
    const alert = buildPanelAlert(
      input({ codexHooks: hooksOf(hook('untrusted')), codexMcp: mcpOf('unavailable') }),
    );
    expect(alert?.sectionId).toBe('codexHooks');
  });

  it('読み込みに失敗したセクションがあれば最後に出す', () => {
    const alert = buildPanelAlert(input({ codexMcp: { ok: false, reason: 'CLIが落ちた' } }));
    expect(alert).toEqual({
      message: 'CodexのMCPサーバーの読み込みに失敗しました',
      sectionId: 'codexMcp',
      severity: 'warning',
    });
  });

  it('まだ読み込んでいないセクションは失敗として扱わない', () => {
    // 未取得の中身は取得失敗と形が同じ（どちらも ok: false）。読み込み済みの集合で分ける
    const alert = buildPanelAlert(
      input({ codexMcp: notLoaded, loadedSections: new Set<SectionId>(['codexHooks']) }),
    );
    expect(alert).toBeUndefined();
  });

  it('読み込み失敗よりMCPの起動失敗のほうが先に出る', () => {
    const alert = buildPanelAlert(
      input({ codexMcp: mcpOf('unavailable'), claudeMcp: { ok: false, reason: '取得できない' } }),
    );
    expect(alert?.message).toBe('起動していないMCPサーバーが1件あります');
  });
});
