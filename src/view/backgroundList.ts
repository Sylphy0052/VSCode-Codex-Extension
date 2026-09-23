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
  /**
   * ビューが見えているか（Issue #1402）。見えていない間は取り直さず、取り直しが
   * 必要になったことだけ`pending`に覚えておき、見えるようになったときに1回取り直す。
   * 取り直しのたびに`codex app-server`を起動するため、見えていないウィンドウで
   * ファイル監視に付いて取り直し続けると、全ウィンドウで起動が途切れなくなる。
   */
  private visible = true;
  private pending = false;
  private soonTimer: ReturnType<typeof setTimeout> | undefined;
  /** `reloadSoon`の取り直しが走っている間か。この間の依頼は、終わってから次の間隔を数える。 */
  private soonRunning = false;
  private soonAgain = false;

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
    if (!this.visible) {
      // 一度も取れていなければ、見えるようになったときの`get`が取るので覚えなくてよい
      this.pending = this.value !== undefined;
      return;
    }
    try {
      await this.run();
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.log.error(`${this.label}を取り直せませんでした: ${reason}`);
      return;
    }
    this.onLoaded();
  }

  /**
   * 少し後に1回だけ取り直す（Issue #1402）。待っている間に来た依頼は、その1回にまとめる。
   * 依頼のたびに待ち直す（debounce）と、追記が途切れず続く間いつまでも取り直さないため、
   * 最初の依頼から`delayMs`後に必ず取り直す。
   *
   * 取り直し中に来た依頼は、取り直しが終わってから`delayMs`を数え始める。取得（数秒）が
   * `delayMs`より長いと、そうしない限り取り直しが間を置かずに続くため。
   */
  reloadSoon(delayMs: number): void {
    if (this.soonTimer !== undefined) {
      return;
    }
    if (this.soonRunning) {
      this.soonAgain = true;
      return;
    }
    this.soonTimer = setTimeout(() => {
      this.soonTimer = undefined;
      this.soonRunning = true;
      void this.reload().finally(() => {
        this.soonRunning = false;
        if (this.soonAgain) {
          this.soonAgain = false;
          this.reloadSoon(delayMs);
        }
      });
    }, delayMs);
  }

  /** ビューの表示状態を受ける。見えるようになったとき、保留中の取り直しを1回行う。 */
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible && this.pending) {
      void this.reload();
    }
  }

  dispose(): void {
    this.soonAgain = false;
    if (this.soonTimer !== undefined) {
      clearTimeout(this.soonTimer);
      this.soonTimer = undefined;
    }
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
          // これから取る値が最新なので、見えない間に溜めた依頼はここで満たされる
          this.pending = false;
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
