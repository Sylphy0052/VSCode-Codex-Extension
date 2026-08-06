/**
 * 時刻依存ロジックをテスト可能にするための最小の抽象。
 * SessionBinder のタイムアウト処理（設計書 §9.1）で使う。
 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

/** テスト用。手動で時間を進められる。 */
export class FakeClock implements Clock {
  constructor(private current = 0) {}

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}
