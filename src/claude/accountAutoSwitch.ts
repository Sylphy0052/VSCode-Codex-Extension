import type { ClaudeAccountStore } from './accountStore';
import { pickReturnTarget, pickSwitchTarget, reachedThreshold } from './accountPolicy';
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
      await this.switchByPolicy(
        pickSwitchTarget(snapshot.accounts, thresholdPct, nowMs),
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
    const { enabled, thresholdPct } = this.ports.config();
    if (!enabled) {
      return { switched: false, reason: '自動切り替えが無効です' };
    }
    // 閾値や優先度による切り替えの最中なら、重ねずにその完了を待つ。切り替えが済めば
    // 余裕のあるアカウントへ移っているので、止まった会話は続けてよい（Issue #1926）
    if (this.inFlight !== undefined) {
      return this.inFlight;
    }
    await this.recordLimitHit(hit, nowMs);
    const snapshot = await this.ports.store.list();
    if (!snapshot.ok) {
      return { switched: false, reason: snapshot.reason };
    }
    const target = pickSwitchTarget(snapshot.accounts, thresholdPct, nowMs);
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
