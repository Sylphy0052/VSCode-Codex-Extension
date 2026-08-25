import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `contributes.menus` の `inline` グループへ置いたコマンドは、`contributes.commands` 側に
 * `icon` が無いとホバーしても何も表示されない（ラベルだけのコマンドは描画されない）。
 * 追加したつもりで出ないことに気付けないため、機械的に突き合わせる（issue #237）。
 *
 * あわせて、セッションツリーのメニューが参照するコマンドが実在することも見る。
 * `contributes.commands` に無いコマンドをメニューに書いても黙って無視されるだけで、
 * 気付ける手がかりが残らない。
 */

type Command = { command: string; icon?: string };
type MenuEntry = { command: string; group?: string; when?: string };
type Manifest = {
  contributes: {
    commands: readonly Command[];
    menus: Record<string, readonly MenuEntry[]>;
  };
};

const manifest = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'),
) as Manifest;
const commands = manifest.contributes.commands;
const itemMenus = manifest.contributes.menus['view/item/context'] ?? [];
const titleMenus = manifest.contributes.menus['view/title'] ?? [];

function iconOf(command: string): string | undefined {
  return commands.find((c) => c.command === command)?.icon;
}

describe('メニューとコマンド定義の整合性（issue #237）', () => {
  it('inlineグループのコマンドはすべてiconを持つ', () => {
    const inlineCommands = itemMenus
      .filter((m) => m.group?.startsWith('inline') === true)
      .map((m) => m.command);

    expect(inlineCommands.length).toBeGreaterThan(0);
    const missing = inlineCommands.filter((c) => iconOf(c) === undefined);
    expect(missing).toEqual([]);
  });

  it('view/item/contextのコマンドはcontributes.commandsに定義されている', () => {
    const defined = new Set(commands.map((c) => c.command));

    const unknown = itemMenus.map((m) => m.command).filter((c) => !defined.has(c));
    expect(unknown).toEqual([]);
  });

  it('forkはCodex・Claude Codeのどちらもインラインと右クリックの両方から呼べる', () => {
    for (const command of ['codex.forkSession', 'claude.forkSession']) {
      const groups = itemMenus.filter((m) => m.command === command).map((m) => m.group);
      expect(groups.some((g) => g?.startsWith('inline') === true)).toBe(true);
      expect(groups.some((g) => g?.startsWith('1_open') === true)).toBe(true);
    }
  });

  it('同じインラインの並び順を2つのコマンドが取り合っていない', () => {
    const byViewItem = new Map<string, string[]>();
    for (const menu of itemMenus) {
      if (menu.group?.startsWith('inline') !== true) {
        continue;
      }
      const key = menu.when ?? '';
      byViewItem.set(key, [...(byViewItem.get(key) ?? []), menu.group]);
    }

    for (const [when, groups] of byViewItem) {
      expect(new Set(groups).size, `when句「${when}」でinlineの順番が重複している`).toBe(
        groups.length,
      );
    }
  });

  it('チームモードはセッションViewのタイトルアイコンから直接開始できる', () => {
    const team = titleMenus.find((m) => m.command === 'agent.workflows.team');

    expect(team).toMatchObject({
      when: 'view == codex.sessions',
      group: 'navigation@5.1',
    });
    expect(iconOf('agent.workflows.team')).toBe('$(organization)');
  });
});
