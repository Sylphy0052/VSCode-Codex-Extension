import type { Logger } from '../log';

/**
 * ツリーの一覧を裏で取り直し、取り終えてから描画を促すための入れ物（Issue #1396）。
 *
 * VS Codeはツリーの最上位を取り直すとき、要素とハンドルの対応表を消してから
 * `getChildren`を待つ（`extHostTreeViews.ts`の`_fetchChildrenNodes` → `_addAllToClear`）。
 * その間に右クリックメニューのコマンドが走ると、引数の要素が`undefined`になる。
 * `getChildren`が一覧の取得（数秒かかることがある）を待っていると、この時間がそのまま
 * 延びるため、取得は`reload`の契機で先に済ませ、`getChildren`は保持済みの値をすぐ返す。
 */
export class BackgroundList<T> {
  private value: T | undefined;
  private running: Promise<T> | undefined;
  /** 取得中に`reload`が来たら、終わった後にもう1回取り直す（最新の状態を取りこぼさない）。 */
  private rerun = false;

  constructor(
    private readonly load: () => Promise<T>,
    /** 取り直しが終わったときに呼ぶ。ツリーの`onDidChangeTreeData`を発火させる。 */
    private readonly onLoaded: () => void,
    private readonly log: Logger,
    private readonly label: string,
  ) {}

  /**
   * 取り直しを依頼する。終わると`onLoaded`を呼ぶ。失敗しても直前の値を保ち、ログに残す。
   * 返り値は取り直し（と`onLoaded`）が終わったら解決する。reject はしない。
   */
  async reload(): Promise<void> {
    try {
      await this.run();
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.log.error(`${this.label}を取り直せませんでした: ${reason}`);
      return;
    }
    this.onLoaded();
  }

  /** 保持している値。まだ一度も取れていなければ、取り終えるまで待つ。 */
  async get(): Promise<T> {
    if (this.value !== undefined) {
      return this.value;
    }
    return this.running ?? this.run();
  }

  private run(): Promise<T> {
    if (this.running !== undefined) {
      this.rerun = true;
      return this.running;
    }
    // 本体は次のマイクロタスクで始める。`load`が同期的に投げても、`finally`が
    // `this.running`を代入より先に消してしまわないようにする
    const running = Promise.resolve().then(async () => {
      try {
        let value: T;
        do {
          this.rerun = false;
          value = await this.load();
          this.value = value;
        } while (this.rerun);
        return value;
      } finally {
        this.running = undefined;
      }
    });
    this.running = running;
    return running;
  }
}
