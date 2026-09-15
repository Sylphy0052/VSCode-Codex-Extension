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
