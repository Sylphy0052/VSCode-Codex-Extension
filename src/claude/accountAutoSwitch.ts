import type { ClaudeAccountStore, SavedAccountView } from './accountStore';
import {
  isStandbyStale,
  pickReturnTarget,
  pickSwitchTarget,
  reachedThreshold,
} from './accountPolicy';
import type { UsageProbeAccounts } from './usageProbe';
import type { UsageSlots } from './usageText';

/**
 * Claude Codeのアカウントを使用率に応じて自動で切り替える（Issue #1924）。
 *
 * `vscode`には依存しない。設定・通知・切り替え後の画面更新は呼び出し側が注入する。
 * 使用率の取得は`ClaudeUsageProbe`が全ウィンドウで1本にしているため、`onProbed`を呼ぶのも
 * その取得を行った1つのウィンドウだけになる。
 */
export interface AutoSwitchConfig {
  enabled: boolean;
  /** 稼働中のアカウントがこの使用率（%）以上になったら切り替える。 */
  thresholdPct: number;
}

export interface AutoSwitchPorts {
  store: Pick<
    ClaudeAccountStore,
    'list' | 'currentId' | 'switchTo' | 'recordUsage' | 'recordLimitHit'
  >;
  config(): AutoSwitchConfig;
  /** 利用者へ知らせる（切り替えた・切り替え先が無い・切り替えに失敗した）。 */
  notify(message: string): void;
  /** 切り替えた後に呼ぶ。画面の更新と、動いているCLIの再起動を行う。 */
  onSwitched(): Promise<void>;
  warn(message: string): void;
  /**
   * 切り替え先に選んだ待機中のアカウントの記録が古いとき、その使用率を計測する（Issue #1943）。
   * 無ければ記録のまま選ぶ。
   */
  probeStandby?(id: string, nowMs: number): Promise<void>;
  /** 定期のポーリングから呼ぶ。記録が古い待機中のアカウントを1件だけ計測する（Issue #1943）。 */
  pollStandby?(nowMs: number): Promise<void>;
}

export type SwitchOutcome = { switched: true; name: string } | { switched: false; reason: string };

/** 会話を止めた上限。チャットの `rate_limit_event` から取る。 */
export interface LimitHit {
  /** 枠の種別（`'5時間'` / `'週次'` / 未知ならCLIの表記のまま）。 */
  limitLabel: string | undefined;
  /** 解除時刻（epoch秒）。 */
  resetsAt: number | undefined;
}

export class AccountAutoSwitcher implements UsageProbeAccounts {
  /** 進行中の切り替え。切り替えの重なりを避け、上限で止まった会話はこの完了を待つ。 */
  private inFlight: Promise<SwitchOutcome> | undefined;
  /** 切り替え先が無い旨の通知を、同じ状態で繰り返さないための印。 */
  private noTargetNotified = false;
  /** 直近の切り替え失敗の理由。同じ理由の通知を繰り返さないための印。 */
  private lastFailure: string | undefined;

  constructor(private readonly ports: AutoSwitchPorts) {}

  currentId(): Promise<string | undefined> {
    return this.ports.store.currentId();
  }

  async record(id: string, slots: UsageSlots, nowMs: number): Promise<void> {
    const result = await this.ports.store.recordUsage(id, slots, nowMs);
    if (!result.ok) {
      this.ports.warn(`使用率を記録できませんでした: ${result.reason}`);
    }
  }

  /** 自動切り替えが有効なときの定期のポーリングから呼ぶ。待機中のアカウントを1件計測する。 */
  async pollStandby(nowMs: number): Promise<void> {
    if (!this.ports.config().enabled) {
      return;
    }
    try {
      await this.ports.pollStandby?.(nowMs);
    } catch (e) {
      this.ports.warn(
        `待機中のアカウントの使用率を計測できませんでした: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * 取得の後に呼ばれる。上限の手前なら次のアカウントへ切り替え、そうでなければ
   * 優先度の高いアカウントが戻っていないかを見て戻す。
   */
  async onProbed(_slots: UsageSlots, nowMs: number): Promise<void> {
    const { enabled, thresholdPct } = this.ports.config();
    if (!enabled) {
      return;
    }
    const snapshot = await this.ports.store.list();
    if (!snapshot.ok) {
      return;
    }
    const current = snapshot.accounts.find((a) => a.current);
    if (current === undefined) {
      return;
    }
    if (reachedThreshold(current, thresholdPct, nowMs)) {
      const target = await this.pickAfterStandbyProbe(snapshot.accounts, thresholdPct, nowMs);
      // 計測を待つ間に手動で切り替えられていれば、古い判定のまま切り替えない
      if ((await this.ports.store.currentId()) !== current.id) {
        return;
      }
      await this.switchByPolicy(
        target,
        `「${current.name}」の使用率が${String(thresholdPct)}%に達したため`,
      );
      return;
    }
    this.noTargetNotified = false;
    const back = pickReturnTarget(snapshot.accounts, thresholdPct, nowMs);
    if (back !== undefined) {
      await this.switchByPolicy(back, '優先度の高いアカウントの枠が戻ったため');
    }
  }

  /**
   * 上限で会話が止まったときの最終手段。使用率の閾値に関わらず、余裕のある次のアカウントへ
   * 切り替える。呼び出し側は、切り替えられたときだけ「続けて」を送る。
   */
  async switchOnLimit(hit: LimitHit, nowMs: number = Date.now()): Promise<SwitchOutcome> {
    // 解除時刻の表示にも使うので、自動切り替えが無効でも記録する。切り替えの最中は稼働中の
    // IDが既に切替先へ変わっているかもしれないので記録しない
    if (this.inFlight === undefined) {
      await this.recordLimitHit(hit, nowMs);
    }
    const { enabled, thresholdPct } = this.ports.config();
    if (!enabled) {
      return { switched: false, reason: '自動切り替えが無効です' };
    }
    // 閾値や優先度による切り替えの最中なら、重ねずにその完了を待つ。切り替えが済めば
    // 余裕のあるアカウントへ移っているので、止まった会話は続けてよい（Issue #1926）
    if (this.inFlight !== undefined) {
      return this.inFlight;
    }
    const snapshot = await this.ports.store.list();
    if (!snapshot.ok) {
      return { switched: false, reason: snapshot.reason };
    }
    const target = await this.pickAfterStandbyProbe(snapshot.accounts, thresholdPct, nowMs);
    // 計測を待つ間に閾値による切り替えが始まっていれば、重ねずにその完了を待つ
    if (this.inFlight !== undefined) {
      return this.inFlight;
    }
    // 計測を待つ間に別の切り替えが済んでいれば、止まったアカウントからは既に移っている。
    // 古い一覧で選んだ先へ重ねて切り替えない
    const stuckId = snapshot.accounts.find((a) => a.current)?.id;
    const nowId = await this.ports.store.currentId();
    if (nowId !== undefined && nowId !== stuckId) {
      const name = snapshot.accounts.find((a) => a.id === nowId)?.name ?? nowId;
      return { switched: true, name };
    }
    if (target === undefined) {
      this.notifyNoTarget();
      return { switched: false, reason: '切り替え先がありません' };
    }
    return this.switchTo(target.id, target.name, '上限に達したため');
  }

  /**
   * 止まったアカウントの該当枠を、解除時刻まで使用率100%として記録する（Issue #1937）。
   * 記録しないと、前回の取得値のリセット時刻を過ぎた枠が空いているとみなされ、上限中の
   * まま切替先や戻り先に選ばれる。解除時刻が判らなければ、解除まで外し続けることになる
   * ので記録しない。
   */
  private async recordLimitHit(hit: LimitHit, nowMs: number): Promise<void> {
    if (hit.resetsAt === undefined) {
      return;
    }
    const id = await this.ports.store.currentId();
    if (id === undefined) {
      return;
    }
    const result = await this.ports.store.recordLimitHit(
      id,
      slotsOf(hit.limitLabel),
      hit.resetsAt * 1000,
      nowMs,
    );
    if (!result.ok) {
      this.ports.warn(`上限に達したことを記録できませんでした: ${result.reason}`);
    }
  }

  /**
   * 切り替え先を選ぶ。選んだ先の記録が古ければ計測し、一覧を取り直して選び直す（Issue #1943）。
   * 計測は1件ごとに20秒ほどかかりストアのロックも持つので、全件ではなく選ばれた先だけを測る。
   * 同じアカウントは1回しか測らないので、待機中のアカウントの数で必ず終わる。
   */
  private async pickAfterStandbyProbe(
    accounts: readonly SavedAccountView[],
    thresholdPct: number,
    nowMs: number,
  ): Promise<SavedAccountView | undefined> {
    const probed = new Set<string>();
    let latest = accounts;
    for (;;) {
      const target = pickSwitchTarget(latest, thresholdPct, nowMs);
      if (
        target === undefined ||
        this.ports.probeStandby === undefined ||
        probed.has(target.id) ||
        !isStandbyStale(target, nowMs)
      ) {
        return target;
      }
      probed.add(target.id);
      await this.probeStandby(target.id, nowMs);
      const snapshot = await this.ports.store.list();
      if (!snapshot.ok) {
        return target;
      }
      latest = snapshot.accounts;
    }
  }

  private async probeStandby(id: string, nowMs: number): Promise<void> {
    try {
      await this.ports.probeStandby?.(id, nowMs);
    } catch (e) {
      // 計測できなくても、記録のまま切り替え先を選ぶ
      this.ports.warn(
        `待機中のアカウントの使用率を計測できませんでした: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private async switchByPolicy(
    target: { id: string; name: string } | undefined,
    why: string,
  ): Promise<void> {
    if (target === undefined) {
      this.notifyNoTarget();
      return;
    }
    await this.switchTo(target.id, target.name, why);
  }

  private notifyNoTarget(): void {
    if (this.noTargetNotified) {
      return;
    }
    this.noTargetNotified = true;
    this.ports.notify(
      'Claude Codeの全アカウントが閾値以上のため、自動で切り替えませんでした。リセットを待つか、閾値を見直してください',
    );
  }

  private switchTo(id: string, name: string, why: string): Promise<SwitchOutcome> {
    if (this.inFlight !== undefined) {
      return Promise.resolve({ switched: false, reason: '切り替え中です' });
    }
    const running = this.runSwitch(id, name, why).finally(() => {
      this.inFlight = undefined;
    });
    this.inFlight = running;
    return running;
  }

  private async runSwitch(id: string, name: string, why: string): Promise<SwitchOutcome> {
    const { store } = this.ports;
    const result = await store.switchTo(id);
    if (!result.ok) {
      // 利用者に確かめられない自動の経路では、稼働中の記録が曖昧なまま切り替えない
      const reason =
        result.confirmCurrent === undefined
          ? result.reason
          : `${result.reason}（アカウント一覧から手動で切り替えると、稼働中のアカウントを確認できます）`;
      // 取得のたびに同じ失敗を知らせ続けない
      if (this.lastFailure !== reason) {
        this.lastFailure = reason;
        this.ports.notify(
          `Claude Codeのアカウントを「${name}」へ自動で切り替えられませんでした: ${reason}`,
        );
      }
      return { switched: false, reason };
    }
    if (result.warning !== undefined) {
      this.ports.warn(result.warning);
    }
    this.noTargetNotified = false;
    this.lastFailure = undefined;
    this.ports.notify(
      `${why}、Claude Codeのアカウントを「${name}」へ切り替えました${result.warning === undefined ? '' : `（${result.warning}）`}`,
    );
    await this.ports.onSwitched();
    return { switched: true, name };
  }
}

/** 上限の種別から、記録する枠を決める。種別が判らなければ両方の枠とする。 */
function slotsOf(limitLabel: string | undefined): (keyof UsageSlots)[] {
  if (limitLabel === '5時間') {
    return ['fiveHour'];
  }
  if (limitLabel === '週次') {
    return ['weekly'];
  }
  return ['fiveHour', 'weekly'];
}
