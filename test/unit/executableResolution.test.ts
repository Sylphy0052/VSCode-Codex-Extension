import { describe, expect, it } from 'vitest';
import {
  formatResolutionFailureMessage,
  ResolutionNotificationTracker,
  resolutionFailureKey,
  resolveSpawnPath,
  type LocateFailure,
} from '../../src/provider/executableResolution';
import type { LocateResult } from '../../src/codex/cliLocator';

const provider = { label: 'Codex', executableSettingKey: 'codex.executablePath' };

const settingNotExecutable = (attempted: string): LocateFailure => ({
  ok: false,
  reason: 'setting-not-executable',
  attempted,
});

const notFound = (attempted: string): LocateFailure => ({
  ok: false,
  reason: 'not-found',
  attempted,
});

describe('resolveSpawnPath', () => {
  // issue #305: 解決に失敗しても、別のバイナリ（裸のコマンド名）へ黙ってすり替えない。
  it('解決に成功していればその実パスを返す', () => {
    const located: LocateResult = { ok: true, path: '/opt/codex/bin/codex', source: 'setting' };
    expect(resolveSpawnPath(located)).toBe('/opt/codex/bin/codex');
  });

  it('明示指定が壊れている場合、指定されたパスをそのまま返す（"codex"へすり替えない）', () => {
    const located = settingNotExecutable('/nonexistent/codex-must-not-run');
    expect(resolveSpawnPath(located)).toBe('/nonexistent/codex-must-not-run');
    expect(resolveSpawnPath(located)).not.toBe('codex');
  });

  it('指定が無くPATH探索が空振りした場合、探索に使った名前をそのまま返す', () => {
    const located = notFound('codex');
    expect(resolveSpawnPath(located)).toBe('codex');
  });

  it('指定がPATH上のカスタム名で見つからない場合、そのカスタム名を返す（既定名へ丸めない）', () => {
    const located = notFound('codex-nightly');
    expect(resolveSpawnPath(located)).toBe('codex-nightly');
  });
});

describe('formatResolutionFailureMessage', () => {
  it('明示指定が壊れている場合、設定キーと試みたパスを含む', () => {
    const message = formatResolutionFailureMessage(
      provider,
      settingNotExecutable('/opt/codex/bin/codex'),
    );
    expect(message).toContain('codex.executablePath');
    expect(message).toContain('/opt/codex/bin/codex');
  });

  it('PATHから見つからない場合、プロバイダ名と設定キーの両方を案内する', () => {
    const message = formatResolutionFailureMessage(provider, notFound('codex'));
    expect(message).toContain('Codex');
    expect(message).toContain('codex.executablePath');
    expect(message).toContain('codex');
  });

  it('PATH全体などの無関係な環境情報を含まない（試みたパスは1回だけ現れる）', () => {
    const message = formatResolutionFailureMessage(
      provider,
      settingNotExecutable('/opt/codex/bin/codex'),
    );
    // PATH区切り文字（':'）を含む余計な文字列が混入していれば、区切りの数がずれて出る
    expect(message.split('/opt/codex/bin/codex')).toHaveLength(2);
  });
});

describe('resolutionFailureKey', () => {
  it('同じ原因・同じパスなら同じキーになる', () => {
    expect(resolutionFailureKey(notFound('codex'))).toBe(resolutionFailureKey(notFound('codex')));
  });

  it('パスが違えばキーも違う', () => {
    expect(resolutionFailureKey(notFound('codex'))).not.toBe(
      resolutionFailureKey(notFound('codex-nightly')),
    );
  });

  it('原因が違えばパスが同じでもキーが違う', () => {
    expect(resolutionFailureKey(notFound('/opt/codex/bin/codex'))).not.toBe(
      resolutionFailureKey(settingNotExecutable('/opt/codex/bin/codex')),
    );
  });
});

describe('ResolutionNotificationTracker', () => {
  it('最初の失敗は通知する', () => {
    const tracker = new ResolutionNotificationTracker();
    expect(tracker.shouldNotify(settingNotExecutable('/nonexistent/codex'))).toBe(true);
  });

  it('同じ失敗が続く間は再通知しない', () => {
    const tracker = new ResolutionNotificationTracker();
    expect(tracker.shouldNotify(settingNotExecutable('/nonexistent/codex'))).toBe(true);
    expect(tracker.shouldNotify(settingNotExecutable('/nonexistent/codex'))).toBe(false);
    expect(tracker.shouldNotify(settingNotExecutable('/nonexistent/codex'))).toBe(false);
  });

  it('設定が変わって別の失敗になったら、あらためて通知する', () => {
    const tracker = new ResolutionNotificationTracker();
    expect(tracker.shouldNotify(settingNotExecutable('/nonexistent/codex'))).toBe(true);
    expect(tracker.shouldNotify(settingNotExecutable('/other/path/codex'))).toBe(true);
  });

  it('一度成功すると、以後同じ失敗でもあらためて通知する', () => {
    const tracker = new ResolutionNotificationTracker();
    expect(tracker.shouldNotify(settingNotExecutable('/nonexistent/codex'))).toBe(true);
    expect(
      tracker.shouldNotify({ ok: true, path: '/nonexistent/codex', source: 'setting' }),
    ).toBe(false);
    expect(tracker.shouldNotify(settingNotExecutable('/nonexistent/codex'))).toBe(true);
  });
});
