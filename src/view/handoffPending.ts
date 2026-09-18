import { randomUUID } from 'node:crypto';
import type {
  HandoffDecision,
  HandoffModelChoice,
  HandoffPendingPort,
  HandoffPendingPresentation,
} from './handoffModelChoice';
import type { SessionHandoffDetail, SharedHandoffDecision } from './sessionHub';

/**
 * 保留中の引き継ぎ確認を、セッションの状態として持つ（Issue #1280）。
 *
 * これまで引き継ぎ先のmodel / effortの確認は、引き継ぎ元のウィンドウのモーダルの中だけで
 * 完結していた。カンバン（セッション統括ページ）は全ウィンドウ横断（Issue #1244）なのに、
 * 別ウィンドウで確認が出て止まっていることを知る手段が無かった。
 *
 * ここは「保留を公開し、決定が来るまで待つ」側だけを担う。モーダルとの競争と、決着した
 * ときの後始末は`chooseHandoffModelSettings`が持つ。
 */
export class PendingHandoffChoice implements HandoffPendingPort {
  private snapshot: PendingSnapshot | undefined;
  /** `external()`が返した約束の解決口。まだ誰も待っていなければ`undefined`。 */
  private waiter: ((decision: HandoffDecision) => void) | undefined;

  constructor(
    /** 引き継ぎの契機を人が読める文にしたもの（`triggerLabel`）。 */
    private readonly trigger: string,
    /** 保留の有無が変わったときに呼ぶ。タブ名の印と統括ページの列を更新させる。 */
    private readonly onChanged: () => void,
  ) {}

  /** 確認待ちとして公開中か。セッションの活動状態の判定に使う。 */
  get active(): boolean {
    return this.snapshot !== undefined;
  }

  publish(proposal: HandoffModelChoice, presentation: HandoffPendingPresentation): void {
    // idは提案ごとに振り直す。中身を取り寄せてから決定を押すまでの間に「再判定」で
    // 提案が入れ替わっていたら、見ていない値で引き継ぐことになるため一致させない
    this.snapshot = {
      requestId: randomUUID(),
      proposal,
      presentation,
      decided: undefined,
      claimedByModal: false,
    };
    this.onChanged();
  }

  external(): Promise<HandoffDecision> {
    const decided = this.snapshot?.decided;
    if (decided !== undefined) {
      // `decide()`が解決した約束を待たずに捨てた周回がありうる（モーダルが競争に
      // 勝った直後など）。決定は保留側に残してあるので、ここで読み直す
      return Promise.resolve(decided);
    }
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  claim(): boolean {
    if (this.snapshot === undefined || this.snapshot.decided !== undefined) {
      return false;
    }
    this.snapshot.claimedByModal = true;
    return true;
  }

  clear(): void {
    this.snapshot = undefined;
    this.waiter = undefined;
    this.onChanged();
  }

  /**
   * 保留したまま会話が閉じられたときに中止する（Issue #1280の確認点4）。
   *
   * タブを閉じた側のウィンドウでは、これを呼ばないと`chooseHandoffModelSettings`が
   * 誰も答えない確認を待ち続ける。別ウィンドウごと落ちた場合は、要求を送った側が
   * 応答待ちの上限（`REPLY_TIMEOUT_MS`）で打ち切る。
   */
  cancelForTeardown(): void {
    if (this.snapshot === undefined) {
      return;
    }
    this.snapshot.decided = { kind: 'cancel' };
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.({ kind: 'cancel' });
  }

  /** 統括ページへ運ぶ中身。保留が無ければ`undefined`。 */
  detail(): SessionHandoffDetail | undefined {
    if (this.snapshot === undefined) {
      return undefined;
    }
    return {
      requestId: this.snapshot.requestId,
      model: this.snapshot.proposal.settings.model,
      effort: this.snapshot.proposal.settings.effort,
      reasons: [...this.snapshot.proposal.reasons],
      trigger: this.trigger,
      canReclassify: this.snapshot.presentation.canReclassify,
      models: this.snapshot.presentation.models.map((option) => ({
        ...option,
        efforts: [...option.efforts],
      })),
    };
  }

  /**
   * 統括ページからの決定を受ける。
   *
   * 取り寄せてから押すまでの間に、タブ側のモーダルで答えられていたり「再判定」で提案が
   * 入れ替わっていたりする。残っている保留だけを対象にし、消えていれば失敗として返す
   * （黙って握りつぶさない）。
   */
  decide(
    requestId: string,
    decision: SharedHandoffDecision,
    settings: { model: string; effort: string } | undefined,
  ): { ok: boolean; error?: string } {
    const snapshot = this.snapshot;
    if (snapshot === undefined || snapshot.requestId !== requestId) {
      return { ok: false, error: 'この引き継ぎ確認は既に解決されています' };
    }
    if (snapshot.decided !== undefined || snapshot.claimedByModal) {
      return { ok: false, error: 'この引き継ぎ確認は既に答えられています' };
    }
    if (decision === 'reclassify' && !snapshot.presentation.canReclassify) {
      return { ok: false, error: '再判定は無効です（agent.autoHandoff.router）' };
    }
    const resolved = this.toDecision(snapshot, decision, settings);
    if ('error' in resolved) {
      return { ok: false, error: resolved.error };
    }
    snapshot.decided = resolved.decision;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.(resolved.decision);
    return { ok: true };
  }

  /**
   * 受け取った値を決定へ変える。
   *
   * 選び直しのmodel / effortは統括ページ（webview。信頼境界の外）や別ウィンドウから届く
   * ため、公開した候補に含まれる値だけを通す。CLIへそのまま渡る値なので、ここで弾く。
   */
  private toDecision(
    snapshot: PendingSnapshot,
    decision: SharedHandoffDecision,
    settings: { model: string; effort: string } | undefined,
  ): { decision: HandoffDecision } | { error: string } {
    if (decision === 'proceed') {
      return { decision: { kind: 'proceed' } };
    }
    if (decision === 'cancel') {
      return { decision: { kind: 'cancel' } };
    }
    if (decision === 'reclassify') {
      return { decision: { kind: 'reclassify' } };
    }
    if (settings === undefined) {
      return { error: '選び直すmodelが指定されていません' };
    }
    const option = snapshot.presentation.models.find((m) => m.slug === settings.model);
    if (option === undefined) {
      return { error: `このセッションで選べないmodelです: ${settings.model || '(既定)'}` };
    }
    if (settings.effort !== '' && !option.efforts.includes(settings.effort)) {
      return { error: `このmodelで選べないeffortです: ${settings.effort}` };
    }
    return {
      decision: { kind: 'repick', settings: { model: settings.model, effort: settings.effort } },
    };
  }
}

interface PendingSnapshot {
  requestId: string;
  proposal: HandoffModelChoice;
  presentation: HandoffPendingPresentation;
  /** 統括ページから来た決定。決着済みの目印を兼ねる。 */
  decided: HandoffDecision | undefined;
  /** モーダル側が決着させる途中か。統括ページからの二重の決定を弾く。 */
  claimedByModal: boolean;
}
