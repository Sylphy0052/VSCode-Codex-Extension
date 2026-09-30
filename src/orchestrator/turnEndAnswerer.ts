import type { ChatItem } from '../appserver/chatState';
import { lastAgentMessage } from '../loop/loopEngineering';
import type { AnswererVerdict } from '../reflex/answererJudge';

/**
 * ターン末の問いかけの回答者判定（Issue #1708）。オーケストレーターがターンを終えて待機へ
 * 戻ったとき、直前の出力の問いかけをオーケストレーター自身が決めてよいとReflexが判定したら、
 * 自分で決めるよう促す次のターンを送る。ワークフローモードとオーケストレータモードの両方で使う。
 *
 * 促しは人の発言またはイベント1回につき1回まで。促しへの返答をまた判定して促し続けないため。
 * 送る側は、人の発言・イベントを送るたびと、外から始まったターン（会話画面からの発言）を
 * 見つけるたびに`reset`を呼ぶ。
 */
export class TurnEndAnswererNudge {
  private nudged = false;
  private judgedMessageId: string | undefined;
  /** `reset`のたびに進める。判定の間に次の発言・イベントが送られたら、古い判定では促さない。 */
  private epoch = 0;

  reset(): void {
    this.nudged = false;
    this.epoch += 1;
  }

  /**
   * 待機へ戻ったときに呼ぶ。`deliver`は促しを送れたら`true`を返す（ターンの最中や引き継ぎ中など、
   * 送れない状態なら送らずに`false`）。同じ発言は二度判定しない。
   */
  async onIdle(
    items: readonly ChatItem[],
    judge: (lastMessage: string) => Promise<AnswererVerdict>,
    deliver: (text: string) => boolean,
  ): Promise<void> {
    const message = lastAgentMessage(items);
    if (this.nudged || message === undefined || message.text.trim() === '') {
      return;
    }
    if (message.id === this.judgedMessageId) {
      return;
    }
    // 判定の失敗・送れなかったときも同じ発言は判定し直さない。待機のまま状態が変わるたびにReflexを
    // 呼び直さないため（促しが落ちても、問いはユーザーへ残るので安全側）
    this.judgedMessageId = message.id;
    const epoch = this.epoch;
    let verdict: AnswererVerdict;
    try {
      verdict = await judge(message.text);
    } catch {
      return;
    }
    if (verdict.kind !== 'orchestrator' || epoch !== this.epoch || this.nudged) {
      return;
    }
    if (deliver(buildAnswererNudge(verdict.summary))) {
      this.nudged = true;
    }
  }
}

function buildAnswererNudge(summary: string): string {
  return [
    '直前の出力でユーザーへ問いかけましたが、回答者判定（Reflex）で、この問いはオーケストレーターが',
    `自分で決めてよいと判定しました（${summary}）。計画・Issue・コード・これまでの回答から自分で決めて`,
    '進めてください。ユーザーにしか決められない理由があるなら、その理由を添えて改めて問いかけてください。',
  ].join('');
}
