/**
 * 相談を続けられるAdvisorセッション（Issue #929）。
 *
 * これまでのセカンドオピニオン（Issue #894）は、1ターン送って回答を受け取り、その場で
 * セッションを閉じていた。もう一度聞きたければ最初から起動し直すことになり、前回の回答は
 * 引き継がれない。ここは**回答が返った後もセッションを保持し、同じAdvisorへ追加の質問を
 * 送れる**ようにするための層である。
 *
 * 独立性の定義は変わらない（design.md §14.80）。Advisorは作業担当AIのセッション状態を
 * 継承せず、材料は起動時に渡したものと、その後に**利用者自身**が足したものだけである。
 * 利用者からの追加入力は作業担当AIからの影響ではなく、意思決定者からの入力なので、
 * 独立性を損なわない。
 *
 * `vscode` には依存しない。UI（追加質問の入力・結果の差し込み）は view 層の責務。
 */

import type { Logger } from '../log';
import {
  awaitSingleTurn,
  SingleTurnCancelledError,
  SingleTurnTimeoutError,
} from '../orchestrator/planner';
import type { TaskSession } from '../orchestrator/taskSession';
import type { SecondOpinionCandidate } from './candidates';
import {
  buildMaterialContextHeader,
  buildMaterialUpdatePrompt,
  materialUpdateAckToken,
} from './prompt';
import {
  FIRST_REVIEW_BUNDLE_REVISION,
  MAX_REVIEW_BUNDLE_REVISIONS,
  type ReviewBundle,
} from './reviewBundle';

/**
 * Advisorセッションの状態（Issue #929 受入基準）。
 *
 * - `consulting`: 相談中。追加の質問を送れる
 * - `handoffDrafted`: メインAIへの指示の下書きができている。編集・再生成・承認ができる
 * - `approved`: 利用者が承認した。送信はこの後にExtensionが行う
 * - `closed`: 閉じた。以後どの操作も受け付けない
 *
 * `handoffDrafted` で追加の相談をしたら `consulting` へ戻す。相談を続けた後の下書きは、
 * その相談を踏まえていない古い内容だからである。古い下書きを承認できる状態のまま
 * 残すと、利用者は「いま合意した方針」だと思って送ってしまう。
 */
export type AdvisorSessionState = 'consulting' | 'handoffDrafted' | 'approved' | 'closed';

/** 1ターンの結果。 */
export type AdvisorTurnResult =
  | {
      ok: true;
      response: string;
      /** 打ち切られ、そこまでに出ていた分だけを返した場合の理由（Issue #907 と同じ扱い）。 */
      partialReason?: string | undefined;
    }
  | {
      ok: false;
      /**
       * 失敗の種類。
       *
       * - `closed`: 既に閉じている（no-opで黙らない。黙るとUIが応答を待ち続ける）
       * - `busy`: このセッションで別のターンが走っている
       * - `cancelled`: 利用者が止めた、または閉じられた
       * - `failed`: それ以外（タイムアウト・プロバイダ側の失敗）
       */
      kind: 'closed' | 'busy' | 'cancelled' | 'failed';
      reason: string;
    };

/**
 * 材料を最新へ更新した結果（Issue #975）。
 *
 * 1ターン分の結果（{@link AdvisorTurnResult}）と分けるのは、失敗の種類が1つ多いためである。
 * `unsupported` は「この相談では材料を更新できない」——作業ツリーの変更以外を資料に選んだ
 * 相談には、更新すべき材料そのものが無い。
 */
export type AdvisorMaterialUpdateResult =
  | {
      ok: true;
      /** 更新後の世代。1始まりで、更新のたびに1つ増える。 */
      revision: number;
      response: string;
      partialReason?: string | undefined;
    }
  | {
      ok: false;
      kind: 'closed' | 'busy' | 'cancelled' | 'failed' | 'unsupported';
      reason: string;
    };

/**
 * 新しい世代の材料を書き出す手段（Issue #975）。
 *
 * 実装は view 層が持つ（現在の作業ツリーからスナップショットを取り直す処理は `vscode` と
 * git に依存する）。ここでは「書き出せた場合に、その場所をAdvisorへ伝える」ことだけを行う。
 *
 * @returns 書き出した材料の、bundleのルートからの相対パス
 */
export type AdvisorMaterialWriter = (bundleDir: string, revision: number) => Promise<string>;

/** 閉じた理由。ログと会話へ残す文言に使う。 */
export type AdvisorCloseReason =
  | 'userEnded'
  | 'idleTimeout'
  | 'instructionSent'
  | 'parentDisposed'
  | 'replaced'
  | 'shutdown'
  | 'failed';

const CLOSE_REASON_LABELS: Record<AdvisorCloseReason, string> = {
  userEnded: '利用者が相談を終了しました',
  idleTimeout: '一定時間操作がなかったため閉じました',
  instructionSent: 'メインAIへ指示を送ったため閉じました',
  parentDisposed: '元の会話が閉じられたため閉じました',
  replaced: '新しいセカンドオピニオンを開始したため閉じました',
  shutdown: '拡張機能の終了により閉じました',
  failed: '実行に失敗したため閉じました',
};

/**
 * 無操作でセッションを閉じるまでの既定時間（30分）。
 *
 * Advisorセッションは常駐app-serverのスレッドとして生きており、タブを開かない設定
 * （`agent.secondOpinion.headless`、既定`true`）では画面に何も出ない。利用者が相談を
 * 終える操作を忘れると、閉じる契機が無いまま残る。
 */
export const DEFAULT_ADVISOR_IDLE_TIMEOUT_MS = 30 * 60_000;

const ADVISOR_LOG_PREFIX = '[secondOpinion]';

const ADVISOR_LABEL = 'セカンドオピニオン';

export interface AdvisorSessionOptions {
  /** 保持する `TaskSession`。閉じる責任はこのクラスが持つ。 */
  session: TaskSession;
  /** 重複起動の判定に使う親セッションのid。 */
  parentSessionId: string;
  candidate: SecondOpinionCandidate;
  /** 追加ターン1回あたりの上限。既定は呼び出し側の設定値をそのまま渡す。 */
  timeoutMs: number;
  /**
   * このセッションの作業ディレクトリになっているレビュー材料（Issue #926 E）。
   *
   * 相談を続ける間は残しておく必要がある（追加の質問で `base/` を読み直しうる）。
   * **閉じる責任はこのクラスが持つ。** 渡さない呼び出し（テスト・古い経路）では何もしない。
   */
  bundle?: ReviewBundle | undefined;
  /**
   * 相談の途中で材料を最新へ更新する手段（Issue #975）。
   *
   * 渡さない呼び出しでは更新できない（{@link AdvisorSession.canUpdateMaterial} が `false`）。
   * 資料に作業ツリーの変更を選ばなかった相談には、更新すべき材料が無い。
   */
  writeMaterial?: AdvisorMaterialWriter | undefined;
  /** 無操作で閉じるまでの時間。既定は {@link DEFAULT_ADVISOR_IDLE_TIMEOUT_MS}。 */
  idleTimeoutMs?: number | undefined;
  log?: Logger | undefined;
  /**
   * 閉じたときに呼ばれる。`AdvisorSessionStore` が自分の持ち物から外すために使う。
   *
   * `close()` の中から同期で呼ぶ。ここで投げても `dispose()` は済ませてある。
   */
  onClosed?: ((session: AdvisorSession, reason: AdvisorCloseReason) => void) | undefined;
}

/**
 * 保持した1本のAdvisorセッション。
 *
 * 閉じ忘れると常駐app-server側のスレッドが残るため、閉じる経路をこのクラスへ集約する。
 * {@link close} は冪等で、何度呼んでも `dispose()` は1回しか走らない。
 */
export class AdvisorSession {
  private state: AdvisorSessionState = 'consulting';
  private readonly session: TaskSession;
  private readonly options: AdvisorSessionOptions;
  private readonly idleTimeoutMs: number;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** 実行中のターンを止めるためのハンドル。走っていなければ `undefined`。 */
  private turn: AbortController | undefined;
  private closeReason: AdvisorCloseReason | undefined;
  /**
   * 下書きの世代（Issue #929）。{@link markHandoffDrafted} のたびに1つ増える。
   *
   * 状態だけでは「どの下書きを承認したのか」が定まらない。承認の画面で古い下書きAを開いた
   * まま新しい下書きBを作ると、状態は `handoffDrafted` に戻っているので承認は通り、送られる
   * のはAになる。承認のときに世代まで一致させることで、この取り違えを塞ぐ。
   */
  private draftRevision = 0;
  /**
   * Advisorが**正本として受け取った**材料の世代（Issue #975）。開始時点が1。
   *
   * 進めるのは、更新の合図（{@link materialUpdateAckToken}）が返ったときだけである。
   * 書き出せただけで進めると、Advisorが古い材料のまま話しているのに「最新」と数えることに
   * なり、書き戻しのときの古さの警告が出なくなる。
   */
  private materialRevision = FIRST_REVIEW_BUNDLE_REVISION;
  /**
   * **書き出した**材料の世代（Issue #975）。{@link materialRevision} とは別に持つ。
   *
   * 番号は一度使ったら再利用しない。通知が失敗した世代へ新しい内容を上書きすると、Advisorが
   * 既に読んだかもしれないパスの中身が入れ替わる——1世代目を上書きしない理由と同じ問題が、
   * 2世代目以降で再発する。失敗した世代のディレクトリはそのまま置き、次は次の番号へ書く。
   */
  private writtenRevision = FIRST_REVIEW_BUNDLE_REVISION;
  /** 正本の材料の置き場（bundleのルートからの相対）。1世代目は `undefined`。 */
  private materialPath: string | undefined;
  /**
   * 材料の更新が走っているか（Issue #975）。
   *
   * `turn` とは別に持つ。更新は「材料の書き出し」と「Advisorへの通知」の2段で、前半には
   * ターンが無い。前半を無防備にすると、書き出している最中に別の質問が始まり、閉じられ、
   * bundleが消された後に `mkdir` が消えたディレクトリを作り直す（回収対象外の残骸になる）。
   */
  private updating = false;
  /**
   * 閉じたときに、材料の後始末を更新の完了まで遅らせたか（Issue #975）。
   *
   * `close()` が更新中に来たら、その場では消さずにここへ印を付ける。先に消しても、走って
   * いる書き出しがディレクトリを作り直してしまう。
   */
  private bundleDisposalPending = false;

  constructor(options: AdvisorSessionOptions) {
    this.options = options;
    this.session = options.session;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_ADVISOR_IDLE_TIMEOUT_MS;
    this.armIdleTimer();
  }

  get parentSessionId(): string {
    return this.options.parentSessionId;
  }

  get candidate(): SecondOpinionCandidate {
    return this.options.candidate;
  }

  currentState(): AdvisorSessionState {
    return this.state;
  }

  /** 走っているターンがあるか。UIの押下可否の判定に使う。材料の更新中も含む。 */
  isBusy(): boolean {
    return this.turn !== undefined || this.updating;
  }

  /**
   * 追加の質問を送る（Issue #929 Consult）。
   *
   * メインセッションへは何も送らない。送るのはこのAdvisorセッションだけである。
   *
   * `handoffDrafted` からこれを呼ぶと `consulting` へ戻る。相談を続けた以上、前の
   * 下書きは古いものになるため、承認できる状態のまま残さない。
   */
  async ask(prompt: string, signal?: AbortSignal): Promise<AdvisorTurnResult> {
    return this.runTurn(prompt, signal, () => {
      // 追加の相談は下書きを無効化する。承認済みの状態からも相談へ戻す（送信前なら
      // 考え直せるべきで、承認を取り消す専用の操作を別に置く理由が無い）
      this.state = 'consulting';
    });
  }

  /**
   * メインAIへの指示の下書きを作らせる（Issue #929 Handoff）。
   *
   * 返すのは生の応答本文だけで、その解釈（`userSummary` / `mainInstruction` への分解）は
   * 呼び出し側の責務とする。ここで解釈まで抱えると、パースの失敗と、ターンの失敗が
   * 同じ型の中で混ざる。
   *
   * 状態は呼び出し側が {@link markHandoffDrafted} で進める。パースに成功したときだけ
   * `handoffDrafted` にしたいためである（形式が読めない応答は下書きとして扱わない）。
   */
  async draftHandoff(prompt: string, signal?: AbortSignal): Promise<AdvisorTurnResult> {
    return this.runTurn(prompt, signal);
  }

  /** 現在の材料の世代（Issue #975）。下書きに記録し、書き戻しのときに古さを見る。 */
  currentMaterialRevision(): number {
    return this.materialRevision;
  }

  /** 材料を更新できる相談か（Issue #975）。UIのボタンを出すかどうかの判定に使う。 */
  canUpdateMaterial(): boolean {
    return this.options.writeMaterial !== undefined && this.options.bundle !== undefined;
  }

  /**
   * 材料を現在の作業ツリーの状態へ更新する（Issue #975）。
   *
   * **利用者が明示的に押したときにだけ呼ぶ。** 自動で更新すると、利用者の知らないうちに
   * Advisorの前提が変わり、同じ問いに同じ答えが返らなくなる。
   *
   * 手順は「新しい世代を書き出す → Advisorへ伝える」の順である。書き出しに失敗した時点で
   * 止め、Advisorには何も送らない。逆順にすると、存在しない材料を正本だと伝えることになる。
   *
   * 世代を進めるのは、通知のターンが成立したときだけである（{@link materialRevision}）。
   *
   * 送信文をここで組むのは、`ask` / `draftHandoff` が呼び出し側から受け取るのと非対称だが、
   * 更新では**書き出した場所**が本文の中身になる。呼び出し側で組ませるには、書き出しと
   * 送信を別のAPIへ割ることになり、その間に片方だけ済んだ状態が挟まる。
   */
  async updateMaterial(signal?: AbortSignal): Promise<AdvisorMaterialUpdateResult> {
    const write = this.options.writeMaterial;
    const bundle = this.options.bundle;
    if (write === undefined || bundle === undefined) {
      return {
        ok: false,
        kind: 'unsupported',
        reason:
          'この相談では材料を更新できません（作業ツリーの変更を資料に選んだ相談でのみ使えます）',
      };
    }
    if (this.isClosed()) {
      return { ok: false, kind: 'closed', reason: 'この相談は既に終了しています' };
    }
    if (this.updating || this.turn !== undefined) {
      return { ok: false, kind: 'busy', reason: 'この相談では別の問い合わせが実行中です' };
    }
    if (this.state === 'approved') {
      // `runTurn` も同じ理由で弾くが、そこまで進むと材料を書き出してから断ることになる。
      // 送信を待っている間の更新は、書き出す前に断る
      return { ok: false, kind: 'busy', reason: '承認した指示を送信中です' };
    }
    if (this.writtenRevision >= MAX_REVIEW_BUNDLE_REVISIONS) {
      return {
        ok: false,
        kind: 'failed',
        reason: `1回の相談で作れる材料は${MAX_REVIEW_BUNDLE_REVISIONS}世代までです（相談をやり直すと、いまの状態から始められます）`,
      };
    }
    const next = this.writtenRevision + 1;
    // 書き出しの間は `turn` が無いので、この印で守る。閉じる側（`close`）も、これを見て
    // 材料の後始末を後回しにする
    this.updating = true;
    let materialPath: string;
    try {
      materialPath = await write(bundle.dir, next);
    } catch (e) {
      this.finishUpdating();
      return {
        ok: false,
        kind: 'failed',
        reason: `材料を書き出せませんでした: ${errorMessage(e)}`,
      };
    }
    // 番号は使い切りにする。通知が失敗しても、この番号へ別の内容を上書きしない
    this.writtenRevision = next;
    if (this.isClosed()) {
      // 書き出している間に閉じられた。ここで止めないと、閉じた相談へ通知を送ることになる。
      // 材料は `finishUpdating()` がbundleごと消す
      this.finishUpdating();
      return { ok: false, kind: 'closed', reason: 'この相談は既に終了しています' };
    }
    let result: AdvisorTurnResult;
    try {
      result = await this.runTurn(
        buildMaterialUpdatePrompt(next, materialPath),
        signal,
        () => {
          // 材料が変われば、それ以前の相談から作った下書きは前提が違う。承認できる状態の
          // まま残さない（追加の相談（`ask`）が下書きを無効にするのと同じ理由）
          this.state = 'consulting';
        },
        // この本文自体が新しい正本を伝えるものなので、正本のヘッダは付けない
        { withMaterialHeader: false },
      );
    } finally {
      this.finishUpdating();
    }
    if (!result.ok) {
      return { ok: false, kind: result.kind, reason: result.reason };
    }
    if (result.partialReason !== undefined) {
      // 打ち切りで途中まで返っただけの応答は、正本を切り替えた証拠にならない
      return {
        ok: false,
        kind: 'failed',
        reason: `${result.partialReason}（材料の切り替えを確認できませんでした）`,
      };
    }
    if (!result.response.includes(materialUpdateAckToken(next))) {
      // 合図が返らない＝正本を切り替えられなかった、と扱う。世代を進めると、Advisorが
      // 古い材料で答えているのに最新だと数えることになる
      return {
        ok: false,
        kind: 'failed',
        reason: '相談相手が材料の切り替えを確認しませんでした（前の材料のまま相談を続けられます）',
      };
    }
    this.materialRevision = next;
    this.materialPath = materialPath;
    this.options.log?.info(
      `${ADVISOR_LOG_PREFIX} レビュー材料を更新しました（第${next}世代 / ${materialPath}）`,
    );
    return {
      ok: true,
      revision: next,
      response: result.response,
    };
  }

  /**
   * 材料の更新の後始末（Issue #975）。
   *
   * 更新中に `close()` が来ていたら、遅らせておいた材料の削除をここで行う。閉じる側で先に
   * 消すと、走っている書き出しが `mkdir` でディレクトリを作り直し、回収されない残骸になる。
   */
  private finishUpdating(): void {
    this.updating = false;
    if (this.bundleDisposalPending) {
      this.bundleDisposalPending = false;
      this.disposeBundle();
    }
  }

  /** 材料の一時ディレクトリを消す。`close()` と {@link finishUpdating} の共通処理。 */
  private disposeBundle(): void {
    void this.options.bundle?.dispose().catch((e: unknown) => {
      this.options.log?.warn(
        `${ADVISOR_LOG_PREFIX} レビュー材料を消せませんでした: ${errorMessage(e)}`,
      );
    });
  }

  /**
   * 下書きが読めたことを記録し、その下書きの世代を返す。`closed` では `undefined`。
   *
   * 返した世代は下書きと一緒に持ち回り、承認のときに {@link markApproved} へ渡す。
   */
  markHandoffDrafted(): number | undefined {
    if (this.state === 'closed') {
      return undefined;
    }
    this.state = 'handoffDrafted';
    this.draftRevision += 1;
    this.armIdleTimer();
    return this.draftRevision;
  }

  /**
   * 利用者が下書きを承認したことを記録する。
   *
   * 承認できるのは `handoffDrafted` からだけである。相談中や閉じた後から承認へ飛べると、
   * 「何を承認したのか」が定まらない。
   */
  markApproved(revision: number): boolean {
    if (this.state !== 'handoffDrafted' || revision !== this.draftRevision) {
      return false;
    }
    this.state = 'approved';
    this.armIdleTimer();
    return true;
  }

  /**
   * 無操作タイマーを張り直す（Issue #929）。
   *
   * 承認の画面（エディタ）を開いた時点で呼ぶ。長い指示文を読んでいる間は状態が変わらないため、
   * これが無いと「読んでいる最中に相談が閉じ、押した瞬間に送れない」ことが起こる。閉じていれば
   * 何もしない（閉じたセッションを生き返らせない）。
   */
  keepAlive(): void {
    if (this.isClosed()) {
      return;
    }
    this.armIdleTimer();
  }

  /**
   * 承認を下書きの状態へ戻す（Issue #929）。
   *
   * 承認は通ったが**送信そのものに失敗した**ときだけ使う。`approved` のまま残すと、
   * 同じ下書きをもう一度承認しようとしても {@link markApproved} が `false` を返し、
   * 「下書きが最新ではありません」という事実と違う理由で弾かれる。送れなかっただけで
   * 下書きは古くなっていないので、作り直させる理由が無い。
   *
   * 戻すのは `approved` からだけである。追加の相談で `consulting` へ戻っている場合は
   * 下書き自体が無効なので、ここで `handoffDrafted` へ引き上げてはならない。
   */
  revertApproval(): void {
    if (this.state !== 'approved') {
      return;
    }
    this.state = 'handoffDrafted';
    this.armIdleTimer();
  }

  /**
   * 閉じる。冪等。
   *
   * 順は「タイマー解除 → 走っているターンを止める → `dispose()`」。`dispose()` は
   * 進行中のターンを止めない（`ChatSession.dispose()` は保留中の承認を解放するだけで、
   * app-server側のターンには触れない。Issue #926 D）ため、先に打ち切りを要求する。
   *
   * `dispose()` は `finally` で呼ぶ。打ち切りの要求が投げても、セッションは必ず閉じる。
   */
  close(reason: AdvisorCloseReason): void {
    if (this.state === 'closed') {
      return;
    }
    this.state = 'closed';
    this.closeReason = reason;
    this.clearIdleTimer();
    try {
      // 走っているターンがあれば止める。`awaitSingleTurn` は `SingleTurnCancelledError`
      // で決着し、待っている `runTurn` は `cancelled` を返す
      this.turn?.abort();
    } finally {
      try {
        this.session.dispose();
      } catch (e) {
        this.options.log?.warn(
          `${ADVISOR_LOG_PREFIX} Advisorセッションを閉じられませんでした: ${errorMessage(e)}`,
        );
      }
      // 材料の一時ディレクトリも一緒に消す（Issue #926 E）。相談が続く限り残すが、
      // 閉じた後まで置いておく理由は無い。`close()` は同期なので待たずに投げる。
      // ただし材料の更新が走っている間は消さない（Issue #975）。ここで消しても、走って
      // いる書き出しが `mkdir` でディレクトリを作り直し、誰にも消されない残骸になる
      if (this.updating) {
        this.bundleDisposalPending = true;
      } else {
        this.disposeBundle();
      }
      this.options.log?.info(
        `${ADVISOR_LOG_PREFIX} Advisorセッションを閉じました（${CLOSE_REASON_LABELS[reason]}）`,
      );
      this.options.onClosed?.(this, reason);
    }
  }

  /** 閉じた理由。閉じていなければ `undefined`。 */
  closedReason(): AdvisorCloseReason | undefined {
    return this.closeReason;
  }

  /**
   * 1ターン分の共通処理。
   *
   * このクラス自身で直列化する。コマンド層の `SecondOpinionRegistry` だけに任せると、
   * 別の呼び出し経路（追加質問と下書き生成）が同時に走る余地が残る。同じスレッドへ2本の
   * ターンを送ると、どちらの回答がどちらの問いに対するものか分からなくなる。
   */
  private async runTurn(
    prompt: string,
    signal: AbortSignal | undefined,
    onStart?: () => void,
    options?: { withMaterialHeader?: boolean },
  ): Promise<AdvisorTurnResult> {
    if (this.isClosed()) {
      return { ok: false, kind: 'closed', reason: 'この相談は既に終了しています' };
    }
    if (this.turn !== undefined) {
      return { ok: false, kind: 'busy', reason: 'この相談では別の問い合わせが実行中です' };
    }
    if (this.state === 'approved') {
      // `approved` でいるのは送信を待っている間だけである。ここで相談を受けると
      // `consulting` へ戻り、送信が失敗したときの `revertApproval()` が効かなくなる
      return { ok: false, kind: 'busy', reason: '承認した指示を送信中です' };
    }
    onStart?.();
    this.clearIdleTimer();
    const controller = new AbortController();
    this.turn = controller;
    // 呼び出し側の停止（会話の項目の「停止」ボタン）と、`close()` からの打ち切りの
    // どちらでも止まるようにする
    const forward = (): void => controller.abort();
    signal?.addEventListener('abort', forward);
    if (signal?.aborted === true) {
      controller.abort();
    }
    try {
      const response = await awaitSingleTurn(
        this.session,
        this.withMaterialHeader(prompt, options),
        {
          timeoutMs: this.options.timeoutMs,
          log: this.options.log,
          label: ADVISOR_LABEL,
          logPrefix: ADVISOR_LOG_PREFIX,
          partialOnTimeout: true,
          signal: controller.signal,
        },
      );
      if (response.trim() === '') {
        return { ok: false, kind: 'failed', reason: 'セカンドオピニオンの応答が空でした' };
      }
      return { ok: true, response };
    } catch (e) {
      if (e instanceof SingleTurnTimeoutError && e.partialText !== undefined) {
        return { ok: true, response: e.partialText, partialReason: e.message };
      }
      if (e instanceof SingleTurnCancelledError) {
        if (e.partialText !== undefined) {
          return { ok: true, response: e.partialText, partialReason: e.message };
        }
        return { ok: false, kind: 'cancelled', reason: e.message };
      }
      return { ok: false, kind: 'failed', reason: errorMessage(e) };
    } finally {
      signal?.removeEventListener('abort', forward);
      this.turn = undefined;
      // 閉じた後にタイマーを張り直さない（閉じたセッションを生かし続けることになる）
      if (!this.isClosed()) {
        this.armIdleTimer();
      }
    }
  }

  /**
   * 送信文の先頭へ、正本の材料の所在を足す（Issue #975）。
   *
   * 更新の通知は会話が伸びるほど履歴の奥へ流れる。一方でbundleの直下には1世代目の
   * `changes.diff` が残り続けるため、Advisorが材料を探し直すと古い方に当たる。毎ターンの
   * 先頭で正本を名指ししておく。1世代目のままなら何も足さない。
   */
  private withMaterialHeader(prompt: string, options?: { withMaterialHeader?: boolean }): string {
    if (options?.withMaterialHeader === false || this.materialPath === undefined) {
      return prompt;
    }
    const header = buildMaterialContextHeader(this.materialRevision, this.materialPath);
    return header === undefined ? prompt : `${header}\n\n${prompt}`;
  }

  /**
   * 閉じているか。
   *
   * `this.state` を直に比べる形にすると、`await` を挟んだ後も型の絞り込みが残り、
   * 「閉じられているかもしれない」再確認が不要と判定されてしまう（実際には待っている
   * 間に `close()` が走りうる）。メソッド越しに読むことで毎回評価させる。
   */
  private isClosed(): boolean {
    return this.state === 'closed';
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.close('idleTimeout');
    }, this.idleTimeoutMs);
    // タイマーだけがイベントループを生かし続けないようにする（テストのプロセスが
    // 終わらなくなる。`unref` を持たない実行環境では何もしない）
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 親セッションごとに保持しているAdvisorセッションの置き場（Issue #929）。
 *
 * 1つの親につき1本だけ持つ。並行して2本の相談を持てるようにすると、会話の項目から
 * 「どちらへの追加質問か」を選ばせる導線が要るうえ、`SecondOpinionRegistry` が
 * 親ごとに1本しか実行を許さないことと噛み合わない。
 */
export class AdvisorSessionStore {
  private readonly sessions = new Map<string, AdvisorSession>();

  get(parentSessionId: string): AdvisorSession | undefined {
    return this.sessions.get(parentSessionId);
  }

  /**
   * 保持する。同じ親の古いセッションは閉じる。
   *
   * 閉じてから登録する。逆にすると、古いセッションの `close()` から届く
   * {@link remove} が、いま登録したばかりの新しいセッションを消す。
   */
  set(session: AdvisorSession): void {
    this.sessions.get(session.parentSessionId)?.close('replaced');
    this.sessions.set(session.parentSessionId, session);
  }

  /**
   * 登録から外す。**同じインスタンスのときだけ**消す。
   *
   * 古いセッションの後始末が、後から登録された別のセッションを消してしまうのを防ぐ
   * （`SecondOpinionRegistry.end()` が `runId` で守っているのと同じ形の穴）。
   */
  remove(session: AdvisorSession): void {
    if (this.sessions.get(session.parentSessionId) === session) {
      this.sessions.delete(session.parentSessionId);
    }
  }

  /** 親の会話が閉じたときに呼ぶ。 */
  closeFor(parentSessionId: string, reason: AdvisorCloseReason): void {
    this.sessions.get(parentSessionId)?.close(reason);
  }

  /** 拡張機能の終了時に呼ぶ。保持しているセッションを全部閉じる。 */
  closeAll(reason: AdvisorCloseReason): void {
    for (const session of [...this.sessions.values()]) {
      session.close(reason);
    }
    this.sessions.clear();
  }
}
