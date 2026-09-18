import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  buildFocusUri,
  buildNotifyEnv,
  buildPowerShellArgs,
  canShowOsNotification,
  foldForToast,
  isWsl,
  parseFocusRequest,
  pickForwardedEnv,
  showOsNotificationProcess,
} from '../../src/util/osNotify';

/** `spawn`の戻り値の代わり。stdoutと終了を手で起こせるようにする。 */
type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  unref: () => void;
  kill: () => boolean;
  killed: boolean;
};

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.unref = (): void => undefined;
  child.killed = false;
  child.kill = (): boolean => {
    child.killed = true;
    return true;
  };
  return child;
}

describe('isWsl', () => {
  it('WSL_DISTRO_NAMEがあればWSLと判定する', () => {
    expect(isWsl({ WSL_DISTRO_NAME: 'Ubuntu' }, 'linux', () => '')).toBe(true);
  });

  it('環境変数が無くても/proc/versionにmicrosoftがあればWSLと判定する', () => {
    const version = 'Linux version 6.18.33.2-microsoft-standard-WSL2';
    expect(isWsl({}, 'linux', () => version)).toBe(true);
  });

  it('素のLinuxはWSLではない', () => {
    expect(isWsl({}, 'linux', () => 'Linux version 6.8.0-generic')).toBe(false);
  });

  it('macOSは/proc/versionを見るまでもなくWSLではない', () => {
    const read = vi.fn(() => 'microsoft');
    expect(isWsl({ WSL_DISTRO_NAME: 'Ubuntu' }, 'darwin', read)).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('canShowOsNotification', () => {
  it('WSLでpowershell.exeがあれば出せる', () => {
    expect(
      canShowOsNotification(
        { WSL_DISTRO_NAME: 'Ubuntu' },
        'linux',
        () => true,
        () => '',
      ),
    ).toBe(true);
  });

  it('WSLでもpowershell.exeが無ければ出せない', () => {
    expect(
      canShowOsNotification(
        { WSL_DISTRO_NAME: 'Ubuntu' },
        'linux',
        () => false,
        () => '',
      ),
    ).toBe(false);
  });

  it('Windowsでも出せる', () => {
    expect(
      canShowOsNotification(
        {},
        'win32',
        () => true,
        () => '',
      ),
    ).toBe(true);
  });

  it('素のLinux・macOSでは出せない（判定のためのPATH探索もしない）', () => {
    const hasCommand = vi.fn(() => true);
    expect(
      canShowOsNotification({}, 'linux', hasCommand, () => 'Linux version 6.8.0-generic'),
    ).toBe(false);
    expect(canShowOsNotification({}, 'darwin', hasCommand, () => '')).toBe(false);
    expect(hasCommand).not.toHaveBeenCalled();
  });
});

describe('buildNotifyEnv', () => {
  const request = { title: 'タイトル', body: '本文', activationUri: 'vscode://x/focus' };

  it('文面を環境変数で渡し、WSLENVへ名前を並べる', () => {
    const env = buildNotifyEnv(request, {});
    expect(env['AGENT_TOAST_TITLE']).toBe('タイトル');
    expect(env['AGENT_TOAST_BODY']).toBe('本文');
    expect(env['AGENT_TOAST_URI']).toBe('vscode://x/focus');
    expect(env['WSLENV']).toBe('AGENT_TOAST_TITLE/u:AGENT_TOAST_BODY/u:AGENT_TOAST_URI/u');
  });

  it('既にWSLENVがあれば消さずに足す', () => {
    const env = buildNotifyEnv(request, { WSLENV: 'FOO/p' });
    expect(env['WSLENV']).toBe('FOO/p:AGENT_TOAST_TITLE/u:AGENT_TOAST_BODY/u:AGENT_TOAST_URI/u');
  });

  it('引用符や改行を含む名前でも、値としてそのまま渡る（スクリプトへ埋め込まない）', () => {
    const nasty = "'; Remove-Item C:\\ -Recurse; #\n2行目";
    const env = buildNotifyEnv({ ...request, title: nasty }, {});
    expect(env['AGENT_TOAST_TITLE']).toBe(nasty);
    const script = decodeScript(buildPowerShellArgs());
    expect(script).not.toContain('Remove-Item');
  });
});

/** `-EncodedCommand`の引数からスクリプト本体を取り出す。 */
function decodeScript(args: readonly string[]): string {
  const index = args.indexOf('-EncodedCommand');
  expect(index).toBeGreaterThanOrEqual(0);
  const encoded = args[index + 1] ?? '';
  return Buffer.from(encoded, 'base64').toString('utf16le');
}

describe('buildPowerShellArgs', () => {
  it('プロファイルを読まず、UTF-16LEのbase64でスクリプトを渡す', () => {
    const args = buildPowerShellArgs();
    expect(args).toContain('-NoProfile');
    expect(args).toContain('-NonInteractive');
    expect(decodeScript(args)).toContain('New-BurntToastNotification');
  });

  it('スクリプトは環境変数から文面を読む（値を埋め込まない）', () => {
    const script = decodeScript(buildPowerShellArgs());
    expect(script).toContain('AGENT_TOAST_TITLE');
    expect(script).toContain('AGENT_TOAST_URI');
  });

  it('BurntToastが無いときの逃げ道を持ち、その場合はfallbackと出力する', () => {
    const script = decodeScript(buildPowerShellArgs());
    expect(script).toContain('Get-Module -ListAvailable -Name BurntToast');
    expect(script).toContain("Write-Output 'fallback'");
  });
});

describe('buildFocusUri', () => {
  it('provider と session を載せた focus のURIを作る', () => {
    const uri = buildFocusUri({
      scheme: 'vscode',
      extensionId: 'Sylphy0052.vscode-codex-extension',
      provider: 'claude',
      threadId: 'abc-123',
    });
    expect(uri).toBe(
      'vscode://Sylphy0052.vscode-codex-extension/focus?provider=claude&session=abc-123',
    );
  });

  it('会話のidがまだ無ければ空文字（押せるボタンを付けない）', () => {
    const base = { scheme: 'vscode', extensionId: 'pub.ext', provider: 'codex' };
    expect(buildFocusUri({ ...base, threadId: undefined })).toBe('');
    expect(buildFocusUri({ ...base, threadId: '' })).toBe('');
  });

  it('idに記号が含まれても壊れないようにエスケープする', () => {
    const uri = buildFocusUri({
      scheme: 'vscode',
      extensionId: 'pub.ext',
      provider: 'codex',
      threadId: 'a b&c',
    });
    expect(uri).toBe('vscode://pub.ext/focus?provider=codex&session=a+b%26c');
  });
});

describe('foldForToast', () => {
  it('改行と連続する空白を1つの空白に畳む', () => {
    expect(foldForToast('1行目\n\n  2行目\t3')).toBe('1行目 2行目 3');
  });

  it('長すぎる名前は末尾を省略する', () => {
    expect(foldForToast('あ'.repeat(200), 10)).toBe(`${'あ'.repeat(9)}…`);
  });

  it('上限ちょうどはそのまま', () => {
    expect(foldForToast('あいうえお', 5)).toBe('あいうえお');
  });

  it('NUL・制御文字・DELを落とす', () => {
    const control = `a\u0000b\u001fc\u007fd\u0008e`;
    expect(foldForToast(control)).toBe('a b c d e');
  });
});

describe('showOsNotificationProcess', () => {
  const request = { title: 'セッション', body: '応答が終わりました', activationUri: '' };

  it('fallbackの出力を受け取ると縮退したと判定する', async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => child) as never;
    const promise = showOsNotificationProcess(request, { spawnProcess, env: {} });
    child.stdout.emit('data', 'fallback\n');
    child.emit('close', 0);
    await expect(promise).resolves.toBe('fallback');
  });

  it('出力が無ければBurntToastで出せたと判定する', async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => child) as never;
    const promise = showOsNotificationProcess(request, { spawnProcess, env: {} });
    child.stdout.emit('data', 'burnt-toast\n');
    child.emit('close', 0);
    await expect(promise).resolves.toBe('burnt-toast');
  });

  it('異常終了はfailed', async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => child) as never;
    const promise = showOsNotificationProcess(request, { spawnProcess, env: {} });
    child.emit('close', 1);
    await expect(promise).resolves.toBe('failed');
  });

  it("起動そのものに失敗しても例外を投げない（'error'イベント）", async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => child) as never;
    const promise = showOsNotificationProcess(request, { spawnProcess, env: {} });
    child.emit('error', new Error('spawn ENOENT'));
    await expect(promise).resolves.toBe('failed');
  });

  it('spawnが同期で投げても例外を外へ出さない', async () => {
    const spawnProcess = vi.fn(() => {
      throw new Error('boom');
    }) as never;
    await expect(showOsNotificationProcess(request, { spawnProcess, env: {} })).resolves.toBe(
      'failed',
    );
  });

  it('巨大な出力を溜め込まない', async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => child) as never;
    const promise = showOsNotificationProcess(request, { spawnProcess, env: {} });
    child.stdout.emit('data', 'x'.repeat(10000));
    child.stdout.emit('data', 'fallback');
    child.emit('close', 0);
    // 頭256バイトで切るため、後から来たfallbackは載らない（burnt-toast扱い）
    await expect(promise).resolves.toBe('burnt-toast');
  });
});

describe('showOsNotificationProcess（固まったとき）', () => {
  const request = { title: 'セッション', body: '応答が終わりました', activationUri: '' };

  it('closeもerrorも来ないまま時間切れになったら殺してfailedにする', async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => child) as never;
    const outcome = await showOsNotificationProcess(request, {
      spawnProcess,
      env: {},
      timeoutMs: 5,
    });
    expect(outcome).toBe('failed');
    expect(child.killed).toBe(true);
  });

  it('時間内に終わっていれば後から殺さない', async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => child) as never;
    const promise = showOsNotificationProcess(request, { spawnProcess, env: {}, timeoutMs: 50 });
    child.emit('close', 0);
    await expect(promise).resolves.toBe('burnt-toast');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(child.killed).toBe(false);
  });
});

describe('parseFocusRequest', () => {
  it('providerとsessionを読み取る', () => {
    expect(parseFocusRequest('/focus', 'provider=claude&session=abc')).toEqual({
      ok: true,
      provider: 'claude',
      sessionId: 'abc',
    });
  });

  it('focus以外のパスは受け取らない', () => {
    expect(parseFocusRequest('/other', 'provider=codex&session=abc')).toEqual({
      ok: false,
      reason: 'not-focus',
    });
  });

  it('sessionが無ければ受け取らない', () => {
    expect(parseFocusRequest('/focus', 'provider=codex')).toEqual({
      ok: false,
      reason: 'no-session',
    });
  });

  it('既知の2つ以外のproviderは受け取らない（黙ってCodex扱いにしない）', () => {
    expect(parseFocusRequest('/focus', 'provider=Claude&session=abc')).toEqual({
      ok: false,
      reason: 'unknown-provider',
    });
    expect(parseFocusRequest('/focus', 'session=abc')).toEqual({
      ok: false,
      reason: 'unknown-provider',
    });
  });
});

describe('pickForwardedEnv', () => {
  it('powershell.exeの起動に要るものとWSLの相互運用だけを通す', () => {
    const picked = pickForwardedEnv({
      PATH: '/usr/bin',
      SystemRoot: 'C:\\Windows',
      WSL_INTEROP: '/run/WSL/1_interop',
      WSL_DISTRO_NAME: 'Ubuntu',
    });
    expect(picked).toEqual({
      PATH: '/usr/bin',
      SystemRoot: 'C:\\Windows',
      WSL_INTEROP: '/run/WSL/1_interop',
      WSL_DISTRO_NAME: 'Ubuntu',
    });
  });

  it('関係のない環境変数はWindows側のプロセスへ渡さない', () => {
    const picked = pickForwardedEnv({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-test',
      HOME: '/home/user',
    });
    expect(Object.keys(picked)).toEqual(['PATH']);
  });
});
