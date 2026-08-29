/**
 * 親セッションのidle待ち（Issue #949）の単体。
 *
 * ここで固定するのは、待ち合わせそのものの性質である。
 * - 判定と購読の間にidleへ遷移しても取り残されない（lost wakeup）
 * - 決着は1回だけで、そのとき購読を必ず解く
 * - 停止（`AbortSignal`）でも同じく1回だけ決着し、購読を残さない
 */

import { describe, expect, it } from 'vitest';
import {
  waitForParentIdle,
  type DisposableLike,
  type SecondOpinionParentPort,
} from '../../src/secondOpinion/wait';

/** idleかどうかを外から切り替えられるポート。購読の登録・解除の回数を数える。 */
class FakeParent implements SecondOpinionParentPort {
  idle: boolean;
  subscribeCalls = 0;
  disposeCalls = 0;
  /** `isParentIdle()` が呼ばれるたびに走らせる細工（lost wakeupの再現に使う）。 */
  onCheck: (() => void) | undefined;
  private readonly listeners: Array<() => void> = [];

  constructor(idle: boolean) {
    this.idle = idle;
  }

  isParentIdle(): boolean {
    // 細工は答えを返した「後」に走らせる。判定の最中に状態が変わると、その判定自身が
    // 新しい状態を返してしまい、lost wakeupの再現にならない（購読より前に決着する）
    const answer = this.idle;
    this.onCheck?.();
    return answer;
  }

  onParentStateChanged(listener: () => void): DisposableLike {
    this.subscribeCalls += 1;
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.disposeCalls += 1;
        const index = this.listeners.indexOf(listener);
        if (index >= 0) {
          this.listeners.splice(index, 1);
        }
      },
    };
  }

  /** 画面の状態が変わったことにする。 */
  emit(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  get listenerCount(): number {
    return this.listeners.length;
  }
}

describe('waitForParentIdle（Issue #949）', () => {
  it('最初からidleなら待たず、購読も張らない', async () => {
    const parent = new FakeParent(true);
    const result = await waitForParentIdle(parent, new AbortController().signal);
    expect(result).toBe('idle');
    expect(parent.subscribeCalls).toBe(0);
  });

  it('idleへ遷移したら解除する', async () => {
    const parent = new FakeParent(false);
    const waiting = waitForParentIdle(parent, new AbortController().signal);
    parent.idle = true;
    parent.emit();
    await expect(waiting).resolves.toBe('idle');
    expect(parent.listenerCount).toBe(0);
  });

  it('idleにならない限り解決しない', async () => {
    const parent = new FakeParent(false);
    let settled = false;
    void waitForParentIdle(parent, new AbortController().signal).then(() => {
      settled = true;
    });
    // 状態は変わったが、まだidleではない（`busy` は落ちたが待機列が残っている等）
    parent.emit();
    parent.emit();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(parent.listenerCount).toBe(1);
  });

  it('購読を張るまでの間にidleになっても取り残されない（lost wakeup）', async () => {
    const parent = new FakeParent(false);
    // 最初の判定の直後（購読より前）にidleへ移り、通知は一切飛ばさない
    parent.onCheck = () => {
      parent.onCheck = undefined;
      parent.idle = true;
    };
    // 通知が来ないので、購読後の再判定が無ければここで永久に待つ
    await expect(waitForParentIdle(parent, new AbortController().signal)).resolves.toBe('idle');
    expect(parent.listenerCount).toBe(0);
  });

  it('idle後に状態変化が続いても解決は1回だけ', async () => {
    const parent = new FakeParent(false);
    let resolved = 0;
    const waiting = waitForParentIdle(parent, new AbortController().signal).then((result) => {
      resolved += 1;
      return result;
    });
    parent.idle = true;
    parent.emit();
    await expect(waiting).resolves.toBe('idle');
    // 解除済みなので、以後の変化は誰にも届かない
    parent.emit();
    parent.emit();
    await Promise.resolve();
    expect(resolved).toBe(1);
    expect(parent.disposeCalls).toBe(1);
  });

  it('待機中に止められたら cancelled で返し、購読を残さない', async () => {
    const parent = new FakeParent(false);
    const controller = new AbortController();
    const waiting = waitForParentIdle(parent, controller.signal);
    controller.abort();
    await expect(waiting).resolves.toBe('cancelled');
    expect(parent.listenerCount).toBe(0);
    expect(parent.disposeCalls).toBe(1);
  });

  it('止めた後にidleになっても解決は cancelled のまま', async () => {
    const parent = new FakeParent(false);
    const controller = new AbortController();
    const waiting = waitForParentIdle(parent, controller.signal);
    controller.abort();
    parent.idle = true;
    parent.emit();
    await expect(waiting).resolves.toBe('cancelled');
  });

  it('既に止まっているsignalなら購読を張らずに即返す', async () => {
    const parent = new FakeParent(false);
    const controller = new AbortController();
    controller.abort();
    await expect(waitForParentIdle(parent, controller.signal)).resolves.toBe('cancelled');
    expect(parent.subscribeCalls).toBe(0);
  });

  it('購読を張るまでの間に止められても取り残されない', async () => {
    const parent = new FakeParent(false);
    const controller = new AbortController();
    // 最初の判定の直後（abortの購読より前）に止める。`abort` は一度きりなので、
    // 張った後の再確認が無ければ通知は二度と来ない
    parent.onCheck = () => {
      parent.onCheck = undefined;
      controller.abort();
    };
    await expect(waitForParentIdle(parent, controller.signal)).resolves.toBe('cancelled');
    expect(parent.listenerCount).toBe(0);
  });
});
