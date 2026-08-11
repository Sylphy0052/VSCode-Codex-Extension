import { describe, expect, it } from 'vitest';
import { PendingStartRegistry } from '../../src/view/pendingStarts';

interface FakeEntry {
  label: string;
  threadId: string | undefined;
}

describe('PendingStartRegistry', () => {
  it('後から開始したエントリが先発のエントリの宛先を上書きしない', () => {
    // design.md §16.10「開始待ちの管理を複数件に対応させる」の回帰テスト。
    // 旧実装は `pending: ChatPanel | undefined` という単一値で持っており、
    // 2件目の開始が1件目を上書きすると、1件目宛の要求が2件目へ誤配送されていた。
    const registry = new PendingStartRegistry<FakeEntry>();
    const first: FakeEntry = { label: 'task-A', threadId: undefined };
    const second: FakeEntry = { label: 'task-B', threadId: undefined };

    registry.begin(first);
    registry.begin(second);

    // 1件目のthread/startの応答だけが先に返り、threadIdが判った状況を模す。
    first.threadId = 'thread-A';

    const resolved = registry.findByThreadId('thread-A', (e) => e.threadId);

    expect(resolved).toBe(first);
    expect(resolved).not.toBe(second);
  });

  it('どのエントリのthreadIdとも一致しない場合はundefined（誤配送より安全な失敗）', () => {
    const registry = new PendingStartRegistry<FakeEntry>();
    const only: FakeEntry = { label: 'task-A', threadId: undefined };
    registry.begin(only);

    // まだどのエントリもthreadIdを記録していない状態で要求が来た場合、
    // 「開始待ちが1件だけだから」と決め打ちで返さない。
    const resolved = registry.findByThreadId('thread-unknown', (e) => e.threadId);

    expect(resolved).toBeUndefined();
  });

  it('開始待ちが1件だけならsoleEntryで拾える（応答前の通知の取りこぼし防止）', () => {
    // thread/startの応答が返る前にも、そのスレッド宛の通知は届く。応答前のエントリは
    // まだthreadIdを記録していないのでfindByThreadIdでは拾えず、そのまま捨てると
    // 開始直後の通知を取りこぼす。1件しか無いなら宛先は一意に定まる。
    const registry = new PendingStartRegistry<FakeEntry>();
    const only: FakeEntry = { label: 'task-A', threadId: undefined };
    registry.begin(only);

    expect(registry.soleEntry()).toBe(only);
  });

  it('開始待ちが2件以上あるときsoleEntryは諦める（誤配送を避ける）', () => {
    const registry = new PendingStartRegistry<FakeEntry>();
    registry.begin({ label: 'task-A', threadId: undefined });
    registry.begin({ label: 'task-B', threadId: undefined });

    expect(registry.soleEntry()).toBeUndefined();
  });

  it('開始待ちが無ければsoleEntryはundefined', () => {
    const registry = new PendingStartRegistry<FakeEntry>();

    expect(registry.soleEntry()).toBeUndefined();
  });

  it('endで取り除いたエントリはfindByThreadIdの対象から外れる', () => {
    const registry = new PendingStartRegistry<FakeEntry>();
    const entry: FakeEntry = { label: 'task-A', threadId: 'thread-A' };
    const key = registry.begin(entry);
    registry.end(key);

    expect(registry.findByThreadId('thread-A', (e) => e.threadId)).toBeUndefined();
    expect(registry.values()).toHaveLength(0);
  });

  it('removeは鍵を知らなくても値で取り除ける', () => {
    const registry = new PendingStartRegistry<FakeEntry>();
    const entry: FakeEntry = { label: 'task-A', threadId: undefined };
    registry.begin(entry);

    registry.remove(entry);

    expect(registry.values()).toHaveLength(0);
  });

  it('values()は現在の開始待ち全件を返す', () => {
    const registry = new PendingStartRegistry<FakeEntry>();
    const a: FakeEntry = { label: 'task-A', threadId: undefined };
    const b: FakeEntry = { label: 'task-B', threadId: undefined };
    registry.begin(a);
    registry.begin(b);

    expect(registry.values()).toEqual([a, b]);
  });
});
