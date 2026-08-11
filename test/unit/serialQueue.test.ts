import { describe, expect, it } from 'vitest';

import { SerialQueue } from '../../src/orchestrator/serialQueue';

describe('SerialQueue.enqueue', () => {
  it('積んだ順に、前の項目が終わってから次を実行する（同時に2件以上走らない）', async () => {
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const queue = new SerialQueue();

    const makeTask = (label: string) => async (): Promise<string> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`start:${label}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push(`end:${label}`);
      active -= 1;
      return label;
    };

    const results = await Promise.all([
      queue.enqueue(makeTask('A')),
      queue.enqueue(makeTask('B')),
      queue.enqueue(makeTask('C')),
    ]);

    // 直列化されていなければ、10ms遅延の間に複数のタスクが同時にactiveへ入りmaxActiveが2以上になる
    expect(maxActive).toBe(1);
    expect(results).toEqual(['A', 'B', 'C']);
    expect(order).toEqual(['start:A', 'end:A', 'start:B', 'end:B', 'start:C', 'end:C']);
  });

  it('各呼び出しの結果・例外は、その呼び出し元の戻り値へ個別に返る', async () => {
    const queue = new SerialQueue();
    const a = queue.enqueue(async () => 1);
    const b = queue.enqueue(async () => 'two');
    await expect(a).resolves.toBe(1);
    await expect(b).resolves.toBe('two');
  });

  /**
   * `this.tail.then(task, task)`（成功・失敗どちらでも次のtaskを走らせる）が肝。
   * ここを`.then(task)`だけにすると、前の項目が失敗した時点で`this.tail`が
   * rejectされたPromiseのままになり、以後のenqueueが呼ばれなくなる
   * （キュー全体が静かに止まる）。この振る舞いを固定する。
   */
  it('前の項目が例外を投げても、キューは止まらず後続を実行する', async () => {
    const queue = new SerialQueue();
    const order: string[] = [];

    const failing = queue.enqueue(async () => {
      order.push('failing');
      throw new Error('boom');
    });
    const following = queue.enqueue(async () => {
      order.push('following');
      return 'ok';
    });
    const thirdAfterFailure = queue.enqueue(async () => {
      order.push('third');
      throw new Error('boom again');
    });
    const fourth = queue.enqueue(async () => {
      order.push('fourth');
      return 'still ok';
    });

    await expect(failing).rejects.toThrow('boom');
    await expect(following).resolves.toBe('ok');
    await expect(thirdAfterFailure).rejects.toThrow('boom again');
    await expect(fourth).resolves.toBe('still ok');
    expect(order).toEqual(['failing', 'following', 'third', 'fourth']);
  });

  it('前の項目がPromiseを返さず同期的に例外を投げても、後続を実行する', async () => {
    const queue = new SerialQueue();
    const failing = queue.enqueue(() => {
      throw new Error('sync boom');
    });
    const following = queue.enqueue(async () => 'ok');

    await expect(failing).rejects.toThrow('sync boom');
    await expect(following).resolves.toBe('ok');
  });

  it('空のキューへ最初に積んだ項目は即座に実行される（前段の待ちが無い）', async () => {
    const queue = new SerialQueue();
    const result = await queue.enqueue(async () => 'first');
    expect(result).toBe('first');
  });
});
