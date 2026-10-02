import { describe, expect, it } from 'vitest';
import {
  canShutdownIdle,
  describeResumedMcp,
  normalizeIdleShutdownMinutes,
  readInitMcpServers,
  type IdleShutdownBlockers,
} from '../../src/claude/idleShutdown';

const idle: IdleShutdownBlockers = {
  minutes: 30,
  disposed: false,
  taskManaged: false,
  loopRunning: false,
  handoffInProgress: false,
  autoReplyInFlight: false,
  limitAutoResumePending: false,
  sessionIdle: true,
};

describe('canShutdownIdle（Issue #1808）', () => {
  it('どの条件にも当たらなければ終了してよい', () => {
    expect(canShutdownIdle(idle)).toBe(true);
  });

  it.each([
    ['設定が0', { minutes: 0 }],
    ['閉じたタブ', { disposed: true }],
    ['工程のタブ', { taskManaged: true }],
    ['ループ実行中', { loopRunning: true }],
    ['引き継ぎ中', { handoffInProgress: true }],
    ['自動返信の途中', { autoReplyInFlight: true }],
    ['自動続行の予約あり', { limitAutoResumePending: true }],
    ['セッション側が使用中', { sessionIdle: false }],
  ])('%sなら終了しない', (_label, patch) => {
    expect(canShutdownIdle({ ...idle, ...patch })).toBe(false);
  });
});

describe('normalizeIdleShutdownMinutes', () => {
  it('数でなければ既定の30分', () => {
    expect(normalizeIdleShutdownMinutes(undefined)).toBe(30);
    expect(normalizeIdleShutdownMinutes('10')).toBe(30);
  });

  it('0以下は0（無効）、上限超えは1440', () => {
    expect(normalizeIdleShutdownMinutes(0)).toBe(0);
    expect(normalizeIdleShutdownMinutes(-5)).toBe(0);
    expect(normalizeIdleShutdownMinutes(5)).toBe(5);
    expect(normalizeIdleShutdownMinutes(100_000)).toBe(1440);
  });
});

describe('readInitMcpServers', () => {
  it('init以外はundefined、mcp_servers無しは空', () => {
    expect(readInitMcpServers({ type: 'assistant' })).toBeUndefined();
    expect(readInitMcpServers({ type: 'system', subtype: 'init' })).toEqual([]);
  });

  it('名前と状態を読む', () => {
    expect(
      readInitMcpServers({
        type: 'system',
        subtype: 'init',
        mcp_servers: [{ name: 'a', status: 'connected' }, { name: 'b' }, 'x', { status: 'y' }],
      }),
    ).toEqual([
      { name: 'a', status: 'connected' },
      { name: 'b', status: 'unknown' },
    ]);
  });
});

describe('describeResumedMcp', () => {
  it('終了前に接続していて再開後につながらないサーバを挙げる', () => {
    const text = describeResumedMcp(
      [
        { name: 'a', status: 'connected' },
        { name: 'b', status: 'connected' },
      ],
      [{ name: 'a', status: 'failed' }],
    );
    expect(text).toContain('a（failed）');
    expect(text).toContain('b（一覧に無い）');
  });

  it('問題が無ければ現在の状態だけを書く', () => {
    expect(
      describeResumedMcp(
        [{ name: 'a', status: 'connected' }],
        [{ name: 'a', status: 'connected' }],
      ),
    ).toBe('再開後のMCPサーバの接続状態: a: connected');
    expect(describeResumedMcp(undefined, [])).toBe('再開後のMCPサーバの接続状態: なし');
  });
});
