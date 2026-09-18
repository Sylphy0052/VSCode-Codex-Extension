/**
 * 「中身を取り寄せた相手にだけ、その承認要求への決定を通す」記録（Issue #1259）。
 *
 * 承認・拒否のボタンを取り寄せた中身の中にしか置かないのは統括ページ
 * （`sessionKanbanView.ts`）側の作りで、それだけでは画面の約束にとどまる。版の違う
 * ウィンドウや、要求ファイルを直接置くプロセスは統括ページを経由しない。受信側でも
 * 同じ条件を確かめられるよう、`approvalDetail`で何を渡したかをここへ残す。
 *
 * **これは共有ディレクトリへ書けるプロセスに対する防御ではない**（design.md §14.112）。
 * その立場なら`approvalDetail`を自分で投げてidを得られるため、順序を1つ増やすだけで
 * 止まらない。ここで担保するのは「取り寄せていない要求へ決定が飛ばない」という
 * 経路の整合であって、真正性ではない。
 */

/**
 * 記録を保つ時間。
 *
 * 人がカードを広げたまま席を外し、戻って押すまでを通す長さにする。短くすると
 * 「画面には中身が出ているのに押せない」が起きる。長くしても、対象の承認要求が
 * 解決すれば`controlSession`側が弾く（`state.approvals`に残っているものだけを対象にする）。
 */
const DISCLOSURE_TTL_MS = 30 * 60_000;

/** 記録が無制限に増えないための上限。古いものから捨てる。 */
const MAX_ENTRIES = 500;

export interface ApprovalDisclosureTarget {
  /** 要求元のwindowId。別のウィンドウが取り寄せた分を流用できないよう鍵に含める。 */
  from: string;
  provider: 'codex' | 'claude';
  threadId: string;
}

export class ApprovalDisclosureLog {
  /** 鍵は`from|provider|threadId|approvalRequestId`。値は渡した時刻。 */
  private readonly issued = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** `approvalDetail`で中身を渡したことを残す。 */
  record(target: ApprovalDisclosureTarget, approvalRequestIds: readonly string[]): void {
    this.prune();
    for (const id of approvalRequestIds) {
      this.issued.set(keyOf(target, id), this.now());
    }
  }

  /**
   * その要求へ決定を通してよいかを判定し、通した分は使い切る。
   *
   * 1回の取り寄せで1回だけ通す。押した後は統括ページが取り寄せ直す作りなので、
   * 使い切っても人の操作は続けられる。
   */
  consume(target: ApprovalDisclosureTarget, approvalRequestId: string): boolean {
    const key = keyOf(target, approvalRequestId);
    const at = this.issued.get(key);
    if (at === undefined) {
      return false;
    }
    this.issued.delete(key);
    return this.now() - at <= DISCLOSURE_TTL_MS;
  }

  private prune(): void {
    const limit = this.now() - DISCLOSURE_TTL_MS;
    for (const [key, at] of this.issued) {
      if (at < limit) {
        this.issued.delete(key);
      }
    }
    // 期限切れが無いまま溜まった場合の保険。Mapは挿入順なので先頭が最も古い
    while (this.issued.size > MAX_ENTRIES) {
      const oldest = this.issued.keys().next();
      if (oldest.done === true) {
        return;
      }
      this.issued.delete(oldest.value);
    }
  }
}

function keyOf(target: ApprovalDisclosureTarget, approvalRequestId: string): string {
  return `${target.from}|${target.provider}|${target.threadId}|${approvalRequestId}`;
}
