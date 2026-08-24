/**
 * 承認要求の自動レビュー（`--approve-for-me` / `approvalsReviewer: auto_review`）の通知を、
 * 会話へ出せる文字列へ整える。
 *
 * app-serverは `item/autoApprovalReview/started` と `item/autoApprovalReview/completed` の
 * 2つで1件の審査を知らせる。どちらも同じ `reviewId` を持つため、画面では1件の項目として
 * 状態が進むように見せる（開始で「判定中」、完了で結果に差し替える）。
 *
 * **スキーマ側で `[UNSTABLE]` と明記されている**（`GuardianApprovalReview` の説明文。
 * CLI 0.147.0）。形が変わりうる前提で、読めなかった値は捨てて表示を削るだけに留め、
 * 「読めない＝承認された」と解釈しない。
 */

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const rec = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((e): e is string => typeof e === 'string') : [];

/**
 * 判定の状態（`GuardianApprovalReviewStatus`）。
 *
 * スキーマ由来の語彙だが、内側でunionとして宣言する（Issue #649）。`isBlockedByReview`が
 * この語彙のうち2つを名指しで見ているため、綴りが食い違うと**その判定が黙って外れる**
 * （承認を止めるべき状態を素通りさせる）。unionにしておけばtscが落とす。
 * スキーマ側が種類を増やしたことまでは検出できないが、それはこの型の役目ではなく、
 * 未知の値をそのまま出すフォールバック（`describeReviewOutcome`）の担当である。
 */
export type AutoApprovalReviewStatus =
  'inProgress' | 'approved' | 'denied' | 'timedOut' | 'aborted';

/** 表示語をこちらで持つ。unionに値を足してここへ足し忘れるとコンパイルが落ちる。 */
const STATUS_LABELS: Record<AutoApprovalReviewStatus, string> = {
  inProgress: '判定中',
  approved: '承認',
  denied: '拒否',
  timedOut: '時間切れ',
  aborted: '中止',
};

/**
 * 実行が止まっている状態。ここを`AutoApprovalReviewStatus`で型付けしてあるので、
 * unionの綴りを変えるとこの配列が落ちる。リテラルの`===`比較を散らすと同じ守りが効かない。
 */
const BLOCKING_STATUSES: readonly AutoApprovalReviewStatus[] = ['denied', 'timedOut'];

/** 人が覆せる（＝Codexが実行を止めた）状態か。 */
export function isBlockedByReview(status: string): boolean {
  return (BLOCKING_STATUSES as readonly string[]).includes(status);
}

/**
 * 審査対象の操作を1行にする。
 *
 * 6種類（command / execve / applyPatch / networkAccess / mcpToolCall / requestPermissions）が
 * 定義されているが、未知の種類が増えても種類名だけは残す。
 */
export function describeReviewAction(action: unknown): string {
  const a = rec(action);
  if (a === undefined) {
    return '';
  }
  const type = str(a['type']);
  const cwd = str(a['cwd']);
  const withCwd = (text: string): string => (cwd === '' ? text : `${text}（${cwd}）`);

  switch (type) {
    case 'command':
      return withCwd(str(a['command']));
    case 'execve': {
      const argv = strings(a['argv']);
      return withCwd(argv.length > 0 ? argv.join(' ') : str(a['program']));
    }
    case 'applyPatch': {
      const files = strings(a['files']);
      return files.length === 0 ? 'ファイルの変更' : `ファイルの変更: ${files.join(', ')}`;
    }
    case 'networkAccess': {
      const target = str(a['target']) || str(a['host']);
      return target === '' ? 'ネットワーク接続' : `ネットワーク接続: ${target}`;
    }
    case 'mcpToolCall': {
      const server = str(a['server']);
      const tool = str(a['toolName']);
      return `MCPツール: ${server} / ${tool}`;
    }
    case 'requestPermissions': {
      const permissions = strings(a['permissions']).join(', ');
      const reason = str(a['reason']);
      const head = permissions === '' ? '権限の昇格' : `権限の昇格: ${permissions}`;
      return reason === '' ? head : `${head}（${reason}）`;
    }
    default:
      return type;
  }
}

/** 判定の結果（状態・リスク・理由）を1行にする。 */
export function describeReviewOutcome(review: unknown): string {
  const r = rec(review);
  const status = str(r?.['status']);
  // 未知の状態は語を訳さずそのまま出す。表を引けないことを「承認」と読み替えない
  const label =
    (STATUS_LABELS as Record<string, string | undefined>)[status] ??
    (status === '' ? '不明' : status);
  const risk = str(r?.['riskLevel']);
  const rationale = str(r?.['rationale']);
  const head = risk === '' ? `自動レビュー: ${label}` : `自動レビュー: ${label}（リスク ${risk}）`;
  return rationale === '' ? head : `${head} — ${rationale}`;
}

export interface AutoApprovalReview {
  reviewId: string;
  turnId: string | undefined;
  /** 審査対象の操作。 */
  action: string;
  /** 判定の1行。 */
  outcome: string;
  /** `GuardianApprovalReviewStatus` の生値。 */
  status: string;
}

/**
 * `item/autoApprovalReview/*` の通知から、画面に出す値だけを取り出す。
 *
 * `reviewId` は項目のidに使うため、無ければ扱わない（開始と完了を結び付けられない）。
 */
export function readAutoApprovalReview(
  params: Record<string, unknown>,
): AutoApprovalReview | undefined {
  const reviewId = str(params['reviewId']);
  if (reviewId === '') {
    return undefined;
  }
  const turnId = str(params['turnId']);
  return {
    reviewId,
    turnId: turnId === '' ? undefined : turnId,
    action: describeReviewAction(params['action']),
    outcome: describeReviewOutcome(params['review']),
    status: str(rec(params['review'])?.['status']),
  };
}
