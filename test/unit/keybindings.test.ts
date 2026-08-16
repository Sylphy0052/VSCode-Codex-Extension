import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `contributes.keybindings` は既定のキーバインドを1件足すだけで壊れやすい設定
 * （対象コマンドの綴り間違い・`when`の書き忘れ・`mac`の書き忘れ・キーの重複）が起きても
 * VSCode起動時に静かに無視されるだけで気付ける手がかりが残らないため、機械的に突き合わせる
 * （issue #289）。
 */

type Command = { command: string };
type Keybinding = { command: string; key: string; mac?: string; when?: string };
type Manifest = {
  contributes: {
    commands: readonly Command[];
    keybindings?: readonly Keybinding[];
  };
};

const manifest = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'),
) as Manifest;
const commands = manifest.contributes.commands;
const keybindings = manifest.contributes.keybindings ?? [];

describe('既定のキーバインド（contributes.keybindings、issue #289）', () => {
  it('1件以上定義されている', () => {
    expect(keybindings.length).toBeGreaterThan(0);
  });

  it('対象コマンドはすべてcontributes.commandsに定義されている', () => {
    const defined = new Set(commands.map((c) => c.command));

    const unknown = keybindings.map((k) => k.command).filter((c) => !defined.has(c));
    expect(unknown).toEqual([]);
  });

  it('when句が空でない', () => {
    const missingWhen = keybindings.filter((k) => (k.when ?? '').trim().length === 0);
    expect(missingWhen).toEqual([]);
  });

  it('keyとmacの両方を持つ（Windows/Linuxとmacosの両対応）', () => {
    const missingKey = keybindings.filter((k) => (k.key ?? '').trim().length === 0);
    expect(missingKey).toEqual([]);

    const missingMac = keybindings.filter((k) => (k.mac ?? '').trim().length === 0);
    expect(missingMac).toEqual([]);
  });

  it('keyが重複していない', () => {
    const keys = keybindings.map((k) => k.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('macが重複していない', () => {
    const macs = keybindings.map((k) => k.mac).filter((m): m is string => m !== undefined);
    expect(new Set(macs).size).toBe(macs.length);
  });

  it('対象4コマンドがすべて割り当てられている（issue #289の受入基準）', () => {
    const boundCommands = new Set(keybindings.map((k) => k.command));

    for (const command of [
      'codex.newChat',
      'claude.newChat',
      'codex.resumeLast',
      'agent.workflows.view',
    ]) {
      expect(boundCommands.has(command), `${command} にキーバインドが割り当てられていない`).toBe(
        true,
      );
    }
  });
});
