import { detachSubstring, type ChatItem, type ChatState } from './chatState';

/**
 * ツール出力のセッション総量の上限（issue #1325）。
 *
 * `MAX_OUTPUT_CHARS`（`chatState.ts`）は**1項目あたり**の上限で、件数には上限が無い。
 * 200KBの出力が10件あればそれだけで2MBを抱え、長い作業では項目数に比例して増え続ける。
 * 保持するのは「メタデータと直近の可視範囲だけ」にし、超えた分の本文はディスクへ退避する。
 *
 * この値は**退避の対象になる種類**（{@link OFFLOADABLE_KINDS}）の本文の合計に掛ける。
 * 発言・思考はツール出力と違って際限なく伸びる性質のものではないため数に入れない。
 */
export const MAX_SESSION_OUTPUT_CHARS = 2_000_000;

/**
 * 退避した項目にメモリへ残す本文の長さ。
 *
 * 残すのは**末尾**にする。`capOutput` が末尾を残すのと同じ理由で、コマンドの結末
 * （エラー行・要約）は後ろに出るため。先頭を捨てた印（`truncated`）も同じ意味で使える。
 */
export const OFFLOAD_PREVIEW_CHARS = 4_000;

/**
 * 退避の対象から外す直近の項目数。
 *
 * 直近のやり取りは画面にも、ゴールループの判定（`loop/`）にも効く。総量を超えていても
 * 末尾のこの件数は触らない。触っても減る量は限られる一方、影響は読みにくい。
 *
 * 実際に抱える量の上限はこの件数にも縛られる（この件数 × `MAX_OUTPUT_CHARS`）。
 * ツール出力が末尾の数件に偏っている会話では、総量の上限より手前で止まる。
 */
export const OFFLOAD_KEEP_RECENT_ITEMS = 20;

/**
 * 総量を見直す最小間隔（ミリ秒）。
 *
 * 見直しは全項目の本文長を足すだけだが、`item/commandExecution/outputDelta` は
 * 1コマンドで数万件届く（issue #246の実測）。毎回走らせると項目数×通知数の走査になる。
 * 退避は遅れてよい処理なので、間隔で間引く。
 */
export const OFFLOAD_CHECK_INTERVAL_MS = 1_000;

/**
 * 退避の対象にする項目の種類。
 *
 * ツールの出力を `text` に持つ種類だけを挙げる（Codexは `commandExecution` /
 * `mcpToolCall`、Claude Codeは `describeTool`（`claude/transcript.ts`）が付ける種類）。
 * 許可する側を並べるのは、未知の種類が増えたときに黙って退避しないため——会話の筋
 * （発言・思考・計画）を退避すると、画面から辿れても文脈として読めなくなる。
 */
export const OFFLOADABLE_KINDS: readonly string[] = [
  'commandExecution',
  'mcpToolCall',
  'fileRead',
  'webSearch',
  'subAgentActivity',
  'collabAgentToolCall',
];

const OFFLOADABLE_KIND_SET = new Set(OFFLOADABLE_KINDS);

/**
 * 退避した本文の置き場。実体はディスク（`session/nodeOutputOffload.ts`）。
 *
 * 呼び出し側は `itemId` でしか参照しない。ファイル名の決め方も置き場所も実装側に閉じる
 * ——webviewから届く値をパスの組み立てへ混ぜないための形でもある（`ChatItem` にパスを
 * 持たせない理由）。
 */
export interface OutputOffloadPort {
  /** 本文を書き出す。書けたら true。失敗した項目は退避せず本文をそのまま残す。 */
  save(itemId: string, text: string): Promise<boolean>;
  /** 退避した本文を読み戻す。読めなければ undefined。 */
  load(itemId: string): Promise<string | undefined>;
  /** このセッションが書き出した分を破棄する。 */
  dispose(): void;
}

/** この項目の本文を退避してよいか。実行中のものは追記が続くため対象にしない。 */
export function isOffloadableItem(item: ChatItem): boolean {
  if (!OFFLOADABLE_KIND_SET.has(item.kind)) {
    return false;
  }
  if (item.status === 'inProgress' || item.status === 'running') {
    return false;
  }
  return item.outputOffloaded !== true && item.text.length > OFFLOAD_PREVIEW_CHARS;
}

/** ツール出力として抱えている本文の合計。上限との比較に使う。 */
export function sessionOutputChars(items: readonly ChatItem[]): number {
  let total = 0;
  for (const item of items) {
    if (OFFLOADABLE_KIND_SET.has(item.kind)) {
      total += item.text.length;
    }
  }
  return total;
}

/** 退避する1件。本文は計画した時点のものを控える（退避後の照合に使う）。 */
export interface OffloadPlanEntry {
  id: string;
  text: string;
}

/**
 * 総量が上限を超えている分だけ、**古い項目から**退避の計画を立てる（純粋関数）。
 *
 * 末尾 {@link OFFLOAD_KEEP_RECENT_ITEMS} 件は対象から外す。上限を下回った時点で止める
 * ため、超過が小さければ退避も1〜2件で済む。
 */
export function planOutputOffload(
  items: readonly ChatItem[],
  limit: number = MAX_SESSION_OUTPUT_CHARS,
): OffloadPlanEntry[] {
  let total = sessionOutputChars(items);
  if (total <= limit) {
    return [];
  }
  const plan: OffloadPlanEntry[] = [];
  const last = items.length - OFFLOAD_KEEP_RECENT_ITEMS;
  for (let i = 0; i < last; i += 1) {
    const item = items[i];
    if (item === undefined || !isOffloadableItem(item)) {
      continue;
    }
    plan.push({ id: item.id, text: item.text });
    total -= item.text.length - OFFLOAD_PREVIEW_CHARS;
    if (total <= limit) {
      break;
    }
  }
  return plan;
}

/**
 * 退避が済んだ項目の本文をプレビューへ差し替える（純粋関数）。
 *
 * 計画した時点と本文が変わっている項目は**差し替えない**。退避の書き出しを待つ間に
 * 状態は進みうるため、控えた本文と長さが合わないものは別の内容になったと見なす。
 * 差し替える対象が無ければ元の状態をそのまま返す（参照の同一性で変化を捉える
 * `buildItemsDelta` が、中身の変わっていない項目を送り直さないようにするため）。
 */
export function applyOutputOffload(
  state: ChatState,
  offloaded: readonly OffloadPlanEntry[],
): ChatState {
  if (offloaded.length === 0) {
    return state;
  }
  const byId = new Map(offloaded.map((entry) => [entry.id, entry.text]));
  let changed = false;
  const items = state.items.map((item) => {
    const saved = byId.get(item.id);
    if (saved === undefined || item.text !== saved || item.outputOffloaded === true) {
      return item;
    }
    changed = true;
    return {
      ...item,
      // 親の全文を手放すため、切り出しはコピーへ通す（`detachSubstring` のJSDoc参照）。
      // ここを `slice` のままにすると、ディスクへ移しても元の本文が回収されない
      text: detachSubstring(saved.slice(saved.length - OFFLOAD_PREVIEW_CHARS)),
      // 先頭を捨てた印は既存のものを流用する。表示側は退避と合わせて注記する
      truncated: true,
      outputOffloaded: true,
      outputChars: saved.length,
    };
  });
  return changed ? { ...state, items } : state;
}

/**
 * 退避を実際に走らせる係（issue #1325）。
 *
 * 状態の更新（`applyEvent`）は同期の純粋関数で、ディスクへの書き出しはそこへ持ち込めない。
 * セッション（`appserver/chatSession.ts`・`claude/streamSession.ts`）は状態を差し替える
 * たびにここへ渡すだけにし、書き出しと差し替えは非同期でこちらが行う。
 *
 * 状態は待っている間に進むため、計画は控えた本文との照合付きで後から当てる
 * （{@link applyOutputOffload}）。`commit` は差し替えが起きたときだけ呼ぶ。
 */
export class OutputOffloadRunner {
  private running = false;
  private lastCheckedAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(private readonly port: OutputOffloadPort) {}

  /**
   * 退避が要るか見て、要るなら走らせる。
   *
   * 間隔に達していないときは、**見送らずに残り時間だけ待ってから**見直す。出力が伸びて
   * いる間の項目は実行中（`inProgress`）で対象外なので、退避できるようになるのは
   * `item/completed` が届いた瞬間——直前の通知で間隔を使い切っている場面である。見送ると
   * その分が次のターンまで残ってしまう。待機は1本だけ持ち、通知が連続しても増やさない。
   *
   * @param current 判定と差し替えの土台。待っている間に進むため、関数で毎回取り直す
   * @param commit 差し替えた状態の受け取り先
   */
  schedule(current: () => ChatState, commit: (next: ChatState) => void): void {
    if (this.running || this.disposed || this.timer !== undefined) {
      return;
    }
    const now = Date.now();
    const wait = OFFLOAD_CHECK_INTERVAL_MS - (now - this.lastCheckedAt);
    if (wait > 0) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.schedule(current, commit);
      }, wait);
      return;
    }
    this.lastCheckedAt = now;
    const plan = planOutputOffload(current().items);
    if (plan.length === 0) {
      return;
    }
    this.running = true;
    void this.run(plan, current, commit).finally(() => {
      this.running = false;
    });
  }

  /** 退避した本文の全文。退避していない項目・読めない項目では undefined。 */
  async load(itemId: string): Promise<string | undefined> {
    return this.disposed ? undefined : this.port.load(itemId);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.port.dispose();
  }

  private async run(
    plan: readonly OffloadPlanEntry[],
    current: () => ChatState,
    commit: (next: ChatState) => void,
  ): Promise<void> {
    const saved: OffloadPlanEntry[] = [];
    for (const entry of plan) {
      if (this.disposed) {
        return;
      }
      if (await this.port.save(entry.id, entry.text)) {
        saved.push(entry);
      }
    }
    if (this.disposed || saved.length === 0) {
      return;
    }
    const before = current();
    const next = applyOutputOffload(before, saved);
    if (next !== before) {
      commit(next);
    }
  }
}
