import { isWithinAnyRoot, isWithinRoot } from '../util/paths';

export type LocalReviewProvider = 'codex' | 'claude';

export interface LocalReviewSession {
  provider: LocalReviewProvider;
  threadId: string;
  title: string;
  cwd: string | undefined;
  activity: string;
}

export interface LocalReviewSource {
  provider: LocalReviewProvider;
  threadId: string;
  cwd: string | undefined;
}

export function isChangedLineSelection(
  startLine: number,
  endLine: number,
  changedLineRanges: readonly { start: number; end: number }[],
): boolean {
  return changedLineRanges.some((range) => startLine >= range.start && endLine <= range.end);
}

export function reviewCandidates(
  sessions: readonly LocalReviewSession[],
  source: LocalReviewSource,
  workspaceRoots: readonly string[],
  documentPath: string,
): Array<LocalReviewSession & { cwd: string }> {
  return sessions.filter(
    (session): session is LocalReviewSession & { cwd: string } =>
      session.activity === 'running' &&
      !(session.provider === source.provider && session.threadId === source.threadId) &&
      source.cwd !== undefined &&
      session.cwd !== undefined &&
      isWithinAnyRoot(session.cwd, workspaceRoots) &&
      isWithinRoot(session.cwd, source.cwd) &&
      isWithinRoot(source.cwd, session.cwd) &&
      isWithinAnyRoot(documentPath, [session.cwd]),
  );
}

export function noReviewCandidateMessage(
  sessions: readonly LocalReviewSession[],
  source: LocalReviewSource,
  workspaceRoots: readonly string[],
): string {
  const hasDifferentWorktree = sessions.some(
    (session) =>
      session.activity === 'running' &&
      !(session.provider === source.provider && session.threadId === source.threadId) &&
      session.cwd !== undefined &&
      source.cwd !== undefined &&
      isWithinAnyRoot(session.cwd, workspaceRoots) &&
      !(isWithinRoot(session.cwd, source.cwd) && isWithinRoot(source.cwd, session.cwd)),
  );
  return hasDifferentWorktree
    ? '同じworkspaceに実行中の別会話はありますが、worktreeが一致しません'
    : '同じworkspaceとworktreeにある実行中の別会話がありません';
}

export function reviewMessages(input: {
  provider: LocalReviewProvider;
  file: string;
  startLine: number;
  endLine: number;
  comment: string;
  selected: string;
}): { payload: string; confirmation: string } {
  const details = [
    `ファイル: ${input.file}`,
    `行: ${input.startLine}-${input.endLine}`,
    `指摘: ${input.comment}`,
  ];
  return {
    payload: [
      'レビュー指摘です。次の変更後の範囲を確認してください。',
      ...details,
      '```',
      input.selected,
      '```',
    ].join('\n'),
    confirmation: [
      `${input.provider === 'codex' ? 'Codex' : 'Claude Code'}の会話へ次のレビュー指摘を送信しますか？`,
      ...details,
      '引用:',
      input.selected,
    ].join('\n'),
  };
}

export function reviewDeliveryFailureMessage(
  result: 'sessionUnavailable' | 'deliveryFailed',
): string {
  return result === 'sessionUnavailable'
    ? '送信先の会話は終了したか、送信できる状態ではありません'
    : 'providerへの送信に失敗しました。接続状態を確認してからもう一度送信してください';
}

/**
 * 指摘を送った結果。`queued` は送信先が応答中で待ち行列に積まれた状態で、応答が
 * 終わると送られる。Codexは送信を待ってから返すため `queued` を返さない。
 */
export type ReviewDeliveryResult = 'sent' | 'queued' | 'sessionUnavailable' | 'deliveryFailed';

/** 指摘を送れなかった理由。`stale` は送信直前の再検査で弾かれた場合。 */
export type ReviewFailureReason = 'stale' | 'sessionUnavailable' | 'deliveryFailed';

export function reviewFailureOf(result: ReviewDeliveryResult): ReviewFailureReason | undefined {
  return result === 'sent' || result === 'queued' ? undefined : result;
}

export const REVIEW_QUEUED_MESSAGE =
  '送信先は応答中のため、レビュー指摘を待ち行列に入れました。応答が終わると送られます';

export const REVIEW_RETRY_ACTION = '見直して送り直す';
export const REVIEW_DISCARD_ACTION = '破棄する';

export function reviewRetryPrompt(reason: ReviewFailureReason): string {
  const cause =
    reason === 'stale'
      ? '対象のDiffまたは送信先の状態が変わりました。'
      : `${reviewDeliveryFailureMessage(reason)}。`;
  return `${cause}指摘は保持しています。対象のDiffを開いて確かめてから「${REVIEW_RETRY_ACTION}」を選ぶと、同じ内容を再検査して送ります`;
}

/**
 * 送れなかった指摘をメモリ上に1件だけ保持する。新しい指摘を保持すると、古い指摘は
 * 送り直せなくなる（通知が残っていても `decide` が `superseded` を返す）。
 */
export class PendingReviewFeedback<T> {
  private current: T | undefined;

  hold(item: T): void {
    this.current = item;
  }

  get held(): T | undefined {
    return this.current;
  }

  /** 送れた指摘を手放す。より新しい指摘を保持している場合は何もしない。 */
  release(item: T): void {
    if (this.current === item) this.current = undefined;
  }

  /** 通知で選ばれた操作を判定する。送り直し以外（通知を閉じた場合を含む）は破棄として扱う。 */
  decide(item: T, choice: string | undefined): 'retry' | 'discard' | 'superseded' {
    if (this.current !== item) return 'superseded';
    if (choice === REVIEW_RETRY_ACTION) return 'retry';
    this.current = undefined;
    return 'discard';
  }
}
