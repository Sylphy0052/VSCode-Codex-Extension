import { afterEach, describe, expect, it } from 'vitest';
import * as vscodeMock from '../mocks/vscode';
import { __mock } from '../mocks/vscode';
import { openChatFileLink } from '../../src/view/chatShared';

type WritableVscodeMock = typeof vscodeMock & {
  Uri: typeof vscodeMock.Uri & {
    parse: (value: string) => { scheme: string; fsPath: string; path: string; fragment: string };
  };
  commands: {
    executeCommand: (command: string, ...args: unknown[]) => Promise<undefined>;
  };
};

const writableMock = vscodeMock as WritableVscodeMock;
const originalParse = writableMock.Uri.parse;
const originalExecuteCommand = writableMock.commands.executeCommand;

afterEach(() => {
  writableMock.Uri.parse = originalParse;
  writableMock.commands.executeCommand = originalExecuteCommand;
  __mock.reset();
});

describe('openChatFileLink', () => {
  it('ワークスペース外のPNGを標準エディタで開く', async () => {
    const calls: Array<{ command: string; args: unknown[] }> = [];
    writableMock.Uri.parse = (value) => ({
      scheme: 'file',
      fsPath: value.replace(/^file:\/\//u, ''),
      path: value.replace(/^file:\/\//u, ''),
      fragment: '',
    });
    writableMock.commands.executeCommand = async (command, ...args) => {
      calls.push({ command, args });
      return undefined;
    };

    await expect(openChatFileLink('file:///outside-workspace/image.png', '/workspace')).resolves.toBe(
      true,
    );

    expect(calls).toEqual([
      {
        command: 'vscode.open',
        args: [{ fsPath: '/outside-workspace/image.png' }, { preview: false }],
      },
    ]);
  });
});
