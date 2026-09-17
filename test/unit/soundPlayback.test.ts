import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  candidatesFor,
  commandExistsOnPath,
  parsePlayerCommandTemplate,
  resolvePlayCommand,
  spawnPlayCommand,
} from '../../src/util/soundPlayback';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

const FILE = '/ext/resources/se_sac03.wav';

describe('resolvePlayCommand', () => {
  it('Linuxでは見つかった最初の候補を使う（paplayが優先）', () => {
    const resolved = resolvePlayCommand({
      file: FILE,
      platform: 'linux',
      hasCommand: (c) => c === 'paplay' || c === 'ffplay',
    });
    expect(resolved).toEqual({ command: 'paplay', args: [FILE] });
  });

  it('WSLのようにffplayしか無い環境でもffplayで鳴らせる', () => {
    const resolved = resolvePlayCommand({
      file: FILE,
      platform: 'linux',
      hasCommand: (c) => c === 'ffplay',
    });
    // ウィンドウを出さず、再生が終わったら自分で終了する指定が要る
    expect(resolved).toEqual({
      command: 'ffplay',
      args: ['-nodisp', '-autoexit', '-loglevel', 'error', FILE],
    });
  });

  it('macOSはafplayを使う', () => {
    const resolved = resolvePlayCommand({
      file: FILE,
      platform: 'darwin',
      hasCommand: () => true,
    });
    expect(resolved).toEqual({ command: 'afplay', args: [FILE] });
  });

  it('WindowsはPowerShellのSoundPlayerを同期再生で使う', () => {
    const resolved = resolvePlayCommand({
      file: 'C:\\ext\\resources\\se_sac03.wav',
      platform: 'win32',
      hasCommand: () => true,
    });
    expect(resolved?.command).toBe('powershell.exe');
    // Play()だとPowerShellが先に終わって音が出ない
    expect(resolved?.args.at(-1)).toContain('PlaySync()');
    expect(resolved?.args.at(-1)).toContain('C:\\ext\\resources\\se_sac03.wav');
  });

  it("Windowsではパス中の ' を '' へ逃がす", () => {
    const resolved = resolvePlayCommand({
      file: "C:\\it's\\se.wav",
      platform: 'win32',
      hasCommand: () => true,
    });
    expect(resolved?.args.at(-1)).toContain("C:\\it''s\\se.wav");
  });

  it('候補が1つも無ければundefined（呼び出し側が警告を出す）', () => {
    const resolved = resolvePlayCommand({
      file: FILE,
      platform: 'linux',
      hasCommand: () => false,
    });
    expect(resolved).toBeUndefined();
  });

  it('上書き指定はPATH上に無くてもそのまま使う', () => {
    const resolved = resolvePlayCommand({
      file: FILE,
      platform: 'linux',
      template: '/opt/custom/play --file ${file}',
      hasCommand: () => false,
    });
    expect(resolved).toEqual({ command: '/opt/custom/play', args: ['--file', FILE] });
  });

  it('上書きが空白だけなら候補探索へ落ちる', () => {
    const resolved = resolvePlayCommand({
      file: FILE,
      platform: 'darwin',
      template: '   ',
      hasCommand: () => true,
    });
    expect(resolved?.command).toBe('afplay');
  });
});

describe('parsePlayerCommandTemplate', () => {
  it('${file} を音源のパスへ置換する', () => {
    expect(parsePlayerCommandTemplate('paplay ${file}', FILE)).toEqual({
      command: 'paplay',
      args: [FILE],
    });
  });

  it('${file} が無ければ末尾へ足す', () => {
    expect(parsePlayerCommandTemplate('afplay', FILE)).toEqual({
      command: 'afplay',
      args: [FILE],
    });
  });

  it('引用符で囲めば空白を含む1トークンとして扱う', () => {
    expect(parsePlayerCommandTemplate('"/opt/my player/play" -q ${file}', FILE)).toEqual({
      command: '/opt/my player/play',
      args: ['-q', FILE],
    });
  });

  it('${file} は複数回出てきてもすべて置換する', () => {
    expect(parsePlayerCommandTemplate('play ${file} --also ${file}', FILE)).toEqual({
      command: 'play',
      args: [FILE, '--also', FILE],
    });
  });

  it('空文字・空白だけならundefined', () => {
    expect(parsePlayerCommandTemplate('', FILE)).toBeUndefined();
    expect(parsePlayerCommandTemplate('   ', FILE)).toBeUndefined();
  });
});

describe('candidatesFor', () => {
  it('未知のプラットフォームはLinuxと同じ顔ぶれを見る', () => {
    expect(candidatesFor('freebsd' as NodeJS.Platform).map((c) => c.command)).toEqual([
      'paplay',
      'pw-play',
      'aplay',
      'ffplay',
    ]);
  });
});

describe('spawnPlayCommand', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  /** `unref()`を持つ、子プロセスの最小限のフェイク。`error`イベントを後から流せる。 */
  function fakeChild(): EventEmitter & { unref: () => void } {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = vi.fn();
    return child;
  }

  it('待ち合わせずに起動する（detached・stdio無視・シェル無し）', () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    expect(spawnPlayCommand({ command: 'paplay', args: [FILE] })).toBe(true);
    expect(spawnMock).toHaveBeenCalledWith('paplay', [FILE], {
      detached: true,
      stdio: 'ignore',
      shell: false,
    });
    // unrefしないと拡張機能の終了が再生プロセスに引きずられる
    expect(child.unref).toHaveBeenCalled();
  });

  it("起動後の'error'は拾ってonErrorへ渡す（拾わないと拡張ホストごと落ちる）", () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const onError = vi.fn();

    spawnPlayCommand({ command: 'paplay', args: [FILE] }, onError);
    expect(() => child.emit('error', new Error('spawn paplay ENOENT'))).not.toThrow();
    expect(onError).toHaveBeenCalledWith('spawn paplay ENOENT');
  });

  it('spawnが投げてもfalseを返すだけで、例外は呼び出し側へ漏らさない', () => {
    spawnMock.mockImplementation(() => {
      throw new Error('EACCES');
    });
    const onError = vi.fn();

    expect(spawnPlayCommand({ command: 'paplay', args: [FILE] }, onError)).toBe(false);
    expect(onError).toHaveBeenCalledWith('EACCES');
  });

  it('onErrorを渡さなくても落ちない', () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    spawnPlayCommand({ command: 'paplay', args: [FILE] });
    expect(() => child.emit('error', new Error('boom'))).not.toThrow();
  });
});

describe('commandExistsOnPath', () => {
  it('空文字はfalse', () => {
    expect(commandExistsOnPath('')).toBe(false);
  });

  it('絶対パスはPATHを見ずに存在だけで判定する', () => {
    expect(commandExistsOnPath('/definitely/not/here/xyz', { PATH: '' })).toBe(false);
  });

  it('PATH上に無ければfalse', () => {
    expect(commandExistsOnPath('paplay', { PATH: '/definitely/not/here' }, 'linux')).toBe(false);
  });
});
