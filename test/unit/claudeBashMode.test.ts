import { describe, expect, it } from 'vitest';
import {
  buildBashModeDisabledNotice,
  buildBashModeErrorItem,
  buildCompletedCommandItem,
  buildRunningCommandItem,
} from '../../src/claude/bashMode';
import type { ShellCommandResult } from '../../src/process/shellCommandRunner';

function result(overrides: Partial<ShellCommandResult> = {}): ShellCommandResult {
  return {
    stdout: '',
    stderr: '',
    code: 0,
    timedOut: false,
    aborted: false,
    spawnError: undefined,
    truncated: false,
    ...overrides,
  };
}

describe('buildBashModeDisabledNotice', () => {
  it('bashモードが無効である旨の通知項目を作る', () => {
    const item = buildBashModeDisabledNotice('id-1');
    expect(item.id).toBe('id-1');
    expect(item.kind).toBe('settingsChanged');
    expect(item.detail).toContain('claude.bashMode.enabled');
  });
});

describe('buildRunningCommandItem', () => {
  it('commandExecution種別・running状態の項目を作る', () => {
    const item = buildRunningCommandItem('id-1', 'echo hi');
    expect(item).toMatchObject({
      id: 'id-1',
      kind: 'commandExecution',
      text: '',
      detail: 'echo hi',
      status: 'running',
    });
  });
});

describe('buildCompletedCommandItem', () => {
  it('成功時: stdoutを本文に、exit 0をstatusにする', () => {
    const item = buildCompletedCommandItem('id-1', 'echo hi', result({ stdout: 'hi\n' }), 60000);
    expect(item.text).toBe('hi\n');
    expect(item.status).toBe('exit 0');
    expect(item.detail).toBe('echo hi');
    expect(item.truncated).toBe(false);
  });

  it('stderrがあれば本文に[stderr]セクションとして含める', () => {
    const item = buildCompletedCommandItem(
      'id-1',
      'cmd',
      result({ stdout: 'out', stderr: 'err', code: 0 }),
      60000,
    );
    expect(item.text).toContain('out');
    expect(item.text).toContain('[stderr]');
    expect(item.text).toContain('err');
  });

  it('非ゼロ終了: statusに終了コードを出す（理由が画面で分かる）', () => {
    const item = buildCompletedCommandItem(
      'id-1',
      'false',
      result({ code: 1, stderr: 'boom' }),
      60000,
    );
    expect(item.status).toBe('exit 1');
    expect(item.text).toContain('boom');
  });

  it('タイムアウト: 本文とstatusにタイムアウトである旨が出る（理由が画面で分かる）', () => {
    const item = buildCompletedCommandItem(
      'id-1',
      'sleep 100',
      result({ timedOut: true, code: null }),
      1234,
    );
    expect(item.status).toBe('タイムアウト');
    expect(item.text).toContain('1234ms');
  });

  it('起動失敗: 本文とstatusに起動できなかった理由が出る（理由が画面で分かる）', () => {
    const item = buildCompletedCommandItem(
      'id-1',
      'nosuchcmd',
      result({ spawnError: 'ENOENT: no such file or directory' }),
      60000,
    );
    expect(item.status).toBe('起動失敗');
    expect(item.text).toContain('ENOENT');
  });

  it('truncatedをそのまま項目へ伝える', () => {
    const item = buildCompletedCommandItem(
      'id-1',
      'cmd',
      result({ stdout: 'x', truncated: true }),
      60000,
    );
    expect(item.truncated).toBe(true);
  });

  it('中断: 本文とstatusに中断した旨が出る（タブを閉じた・拡張機能終了。理由が画面で分かる）', () => {
    const item = buildCompletedCommandItem('id-1', 'sleep 100', result({ aborted: true }), 60000);
    expect(item.status).toBe('中断');
    expect(item.text).toContain('中断しました');
  });
});

describe('buildBashModeErrorItem', () => {
  it('commandExecution種別で、失敗理由を本文に含む項目を作る（実行中を同じidで畳む）', () => {
    const item = buildBashModeErrorItem('bash:1', 'echo hi', '想定外の例外');
    expect(item).toMatchObject({
      id: 'bash:1',
      kind: 'commandExecution',
      detail: 'echo hi',
      status: '失敗',
    });
    expect(item.text).toContain('想定外の例外');
  });
});
