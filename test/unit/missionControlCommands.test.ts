import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SESSION_TOOLS } from '../../src/orchestrator/messaging';
import { parseRunCommand } from '../../src/view/missionControlCommands';
import { MC_EXTENSION_COMMANDS } from '../../src/webview/missionControl/extensionCommands';
import type { McTarget } from '../../src/webview/missionControl/protocol';

const KNOWN: McTarget = {
  windowId: '11111111-1111-4111-8111-111111111111',
  provider: 'claude',
  threadId: 't1',
};
const isKnown = (t: McTarget): boolean =>
  t.windowId === KNOWN.windowId && t.provider === KNOWN.provider && t.threadId === KNOWN.threadId;

describe('parseRunCommand（Issue #2161）', () => {
  it('許可リストのidは引数無しで通す', () => {
    expect(
      parseRunCommand({ type: 'runCommand', seq: 1, command: 'codex.showUsage' }, isKnown),
    ).toEqual({ id: 'codex.showUsage', args: [] });
  });

  it('providerを渡すコマンドは、知っているセッションのproviderだけを引数にする', () => {
    expect(
      parseRunCommand({ type: 'runCommand', seq: 1, command: 'agent.forgeHub', ...KNOWN }, isKnown),
    ).toEqual({ id: 'agent.forgeHub', args: ['claude'] });
    expect(
      parseRunCommand({ type: 'runCommand', seq: 1, command: 'agent.forgeHub' }, isKnown),
    ).toEqual({
      id: 'agent.forgeHub',
      args: [],
    });
  });

  it('知らないセッション・欠けた宛先・形の違う宛先は拒む', () => {
    for (const target of [
      { ...KNOWN, threadId: 'other' },
      { ...KNOWN, provider: 'codex' },
      { windowId: KNOWN.windowId },
      { ...KNOWN, provider: 'x' },
      { ...KNOWN, threadId: 1 },
      { ...KNOWN, windowId: '' },
    ]) {
      expect(
        typeof parseRunCommand(
          { type: 'runCommand', seq: 1, command: 'agent.workflows.menu', ...target },
          isKnown,
        ),
      ).toBe('string');
    }
  });

  it('引数を取らないコマンドに宛先が付いていたら拒む', () => {
    expect(
      typeof parseRunCommand(
        { type: 'runCommand', seq: 1, command: 'codex.showLog', ...KNOWN },
        isKnown,
      ),
    ).toBe('string');
  });

  it('許可リスト外のid・前方一致・大文字小文字違い・型の違う値は拒む', () => {
    for (const command of [
      'codex.deleteSession',
      'agent.localReview.send',
      'agent.sendSelectionToChat',
      'agent.workflows.stop',
      'workbench.action.terminal.new',
      'agent.workflows',
      'agent.workflows.menu.extra',
      ' codex.showUsage',
      'CODEX.SHOWUSAGE',
      '',
      '__proto__',
      'constructor',
      'toString',
      'hasOwnProperty',
      1,
      null,
      undefined,
      ['codex.showUsage'],
      { id: 'codex.showUsage' },
    ]) {
      expect(typeof parseRunCommand({ type: 'runCommand', seq: 1, command }, isKnown)).toBe(
        'string',
      );
    }
  });

  it('余分なフィールド（引数・__proto__を含む）があれば拒む', () => {
    for (const extra of [
      { args: ['x'] },
      { arguments: [] },
      { id: 'codex.showUsage' },
      JSON.parse('{"__proto__": {"command": "codex.showUsage"}}') as Record<string, unknown>,
      JSON.parse('{"constructor": {"prototype": {}}}') as Record<string, unknown>,
    ]) {
      expect(
        typeof parseRunCommand(
          { type: 'runCommand', seq: 1, command: 'codex.showUsage', ...extra },
          isKnown,
        ),
      ).toBe('string');
    }
  });

  it('プロトタイプ経由の値では通らない', () => {
    const viaProto = Object.create({ command: 'codex.showUsage' }) as Record<string, unknown>;
    viaProto.type = 'runCommand';
    viaProto.seq = 1;
    expect(typeof parseRunCommand(viaProto, isKnown)).toBe('string');
  });
});

describe('許可リストの中身（Issue #2161）', () => {
  it('idは重複せず、エディタの選択に依存するもの・取り消せないものを含まない', () => {
    const ids = MC_EXTENSION_COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const banned of [
      'agent.localReview.send',
      'agent.localReview.start',
      'agent.sendSelectionToChat',
      'codex.deleteSession',
      'codex.archiveSession',
      'agent.workflows.stop',
      'codex.clearChat',
      'claude.clearChat',
    ]) {
      expect(ids).not.toContain(banned);
    }
  });

  it('許可リストのidはすべてpackage.jsonのcontributes.commandsにある', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as {
      contributes: { commands: { command: string }[] };
    };
    const contributed = new Set(pkg.contributes.commands.map((c) => c.command));
    for (const command of MC_EXTENSION_COMMANDS) {
      expect(contributed.has(command.id)).toBe(true);
    }
  });
});

describe('MCPのエージェント経路からは呼べない（Issue #2161）', () => {
  it('SESSION_TOOLSはセッション宛の3つだけで、コマンドを実行する道具を持たない', () => {
    expect(SESSION_TOOLS.map((tool) => tool.name)).toEqual([
      'list_sessions',
      'ask_session',
      'ask_session_result',
    ]);
  });

  it('sessionBridge.ts・messaging.tsは許可リストを読まず、コマンドを実行しない', () => {
    for (const file of ['src/orchestrator/sessionBridge.ts', 'src/orchestrator/messaging.ts']) {
      const source = readFileSync(join(__dirname, '../..', file), 'utf8');
      expect(source).not.toMatch(/executeCommand/u);
      expect(source).not.toMatch(/extensionCommands|missionControlCommands/u);
    }
  });
});
