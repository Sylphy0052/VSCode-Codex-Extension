import { describe, expect, it } from 'vitest';
import { buildGoalDraftReply } from '../../src/view/goalDraftFactory';
import type { GoalDraftSettings } from '../../src/loop/goalDraftProcess';

/**
 * `loop/planGoal` の応答の組み立て（issue #961）。
 *
 * 確かめたいのは中身より**必ず1つ返ること**。webview側は要求を出した時点で開始ボタンを
 * 無効化し、この応答でだけ元へ戻すため、返らない経路が1つでもあると画面が操作不能で残る。
 */

const settings = (overrides: Partial<GoalDraftSettings> = {}): GoalDraftSettings => ({
  enabled: true,
  confirm: true,
  provider: 'inherit',
  model: 'auto',
  timeoutSeconds: 120,
  ...overrides,
});

const goal = { purpose: '直す', acceptanceCriteria: '緑になる' };

describe('buildGoalDraftReply（issue #961）', () => {
  it('下書きができたら3欄の値を返す', async () => {
    const reply = await buildGoalDraftReply(1, 'Issue #1に着手', {
      readSettings: () => settings(),
      plan: async () => ({ ok: true, goal }),
      logWarn: () => undefined,
    });
    expect(reply).toEqual({ type: 'loop/goalDraft', id: 1, ok: true, goal, start: false });
  });

  it('confirm が false のときだけ start を立てる', async () => {
    const reply = await buildGoalDraftReply(1, '着手', {
      readSettings: () => settings({ confirm: false }),
      plan: async () => ({ ok: true, goal }),
      logWarn: () => undefined,
    });
    expect(reply['start']).toBe(true);
  });

  it('要求の通し番号をそのまま返す（古い応答を画面側で捨てられるように）', async () => {
    const reply = await buildGoalDraftReply(42, '着手', {
      readSettings: () => settings(),
      plan: async () => ({ ok: true, goal }),
      logWarn: () => undefined,
    });
    expect(reply['id']).toBe(42);
  });

  it('通し番号が数値でなければ載せない', async () => {
    const reply = await buildGoalDraftReply('abc', '着手', {
      readSettings: () => settings(),
      plan: async () => ({ ok: true, goal }),
      logWarn: () => undefined,
    });
    expect(reply['id']).toBeUndefined();
  });

  it('設定が無効なら生成を呼ばずに失敗を返す', async () => {
    let called = false;
    const reply = await buildGoalDraftReply(1, '着手', {
      readSettings: () => settings({ enabled: false }),
      plan: async () => {
        called = true;
        return { ok: true, goal };
      },
      logWarn: () => undefined,
    });
    expect(called).toBe(false);
    expect(reply['ok']).toBe(false);
  });

  it('依頼文が空白だけなら生成を呼ばずに失敗を返す', async () => {
    const reply = await buildGoalDraftReply(1, '  \n ', {
      readSettings: () => settings(),
      plan: async () => ({ ok: true, goal }),
      logWarn: () => undefined,
    });
    expect(reply['ok']).toBe(false);
  });

  it('生成が失敗を返したら、その理由をそのまま画面へ渡す', async () => {
    const reply = await buildGoalDraftReply(1, '着手', {
      readSettings: () => settings(),
      plan: async () => ({ ok: false, message: '応答がありません' }),
      logWarn: () => undefined,
    });
    expect(reply).toMatchObject({ ok: false, message: '応答がありません' });
  });

  it('生成が例外を投げても応答を返す（gh や git の失敗で画面を止めない）', async () => {
    const warnings: string[] = [];
    const reply = await buildGoalDraftReply(7, '着手', {
      readSettings: () => settings(),
      plan: async () => {
        throw new Error('gh: command not found');
      },
      logWarn: (message) => warnings.push(message),
    });
    expect(reply).toMatchObject({ type: 'loop/goalDraft', id: 7, ok: false });
    expect(warnings[0]).toContain('gh: command not found');
  });

  it('設定の読み出しが例外を投げても応答を返す', async () => {
    const reply = await buildGoalDraftReply(1, '着手', {
      readSettings: () => {
        throw new Error('設定が読めない');
      },
      plan: async () => ({ ok: true, goal }),
      logWarn: () => undefined,
    });
    expect(reply).toMatchObject({ ok: false });
  });

  it('例外がErrorでなくても応答を返す', async () => {
    const reply = await buildGoalDraftReply(1, '着手', {
      readSettings: () => settings(),
      plan: async () => {
        throw 'なにか';
      },
      logWarn: () => undefined,
    });
    expect(reply).toMatchObject({ ok: false });
  });
});
