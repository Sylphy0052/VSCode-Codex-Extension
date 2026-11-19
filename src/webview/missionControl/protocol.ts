/**
 * Mission Control（Issue #2136）の拡張ホストとwebviewの間でやり取りする形。
 *
 * webview側のbundle（`main.tsx`）と拡張ホスト側（`missionControlView.ts`）の両方が読む。
 * webviewのbundleへNode向けのモジュールが紛れ込まないよう、このファイルは何もimportしない。
 * 元の型（`PendingItem`・`SessionApprovalDetail`など）と同じ形を、ここで独立に書く。
 */

export type McProvider = 'codex' | 'claude';

/** `SessionActivityState`と同じ5値。 */
export type McActivity =
  'idle' | 'running' | 'approvalPending' | 'handoffPending' | 'backgroundRunning';

/** `PendingItemKind`と同じ6値。 */
export type McPendingKind =
  | 'toolApproval'
  | 'askUserQuestion'
  | 'codexPrompt'
  | 'workflowApproval'
  | 'taskRunQuestion'
  | 'handoff';

export type McAnswerMode = 'decision' | 'choices' | 'text';

/** Inboxの1行。`PendingItem`から、画面に要る分だけを持つ。 */
export interface McPendingItem {
  id: string;
  kind: McPendingKind;
  windowId: string;
  /** 会話のid。task runの質問ではrunId。 */
  threadId: string;
  provider: McProvider;
  isCurrentWindow: boolean;
  repoKey: string;
  title: string;
  summary: string;
  /** 待ち始めた時刻（ms）。 */
  createdAt: number;
  answer: McAnswerMode;
  /** 会話の項目の元の要求id。`approvalDetail`の応答と突き合わせる。 */
  requestId?: string | undefined;
  /** task runの質問の選択肢。 */
  options?: string[] | undefined;
}

/** セッション一覧の1行。 */
export interface McSession {
  /** `session:<provider>:<windowId>:<threadId>`。一覧の中で一意。 */
  key: string;
  windowId: string;
  threadId: string;
  provider: McProvider;
  isCurrentWindow: boolean;
  repoKey: string;
  title: string;
  activity: McActivity;
  /** 今の状態になった（と拡張ホストが最初に見た）時刻（ms）。 */
  activitySince: number;
  /** 作業ディレクトリの末尾の要素。絶対パスはhoverにだけ出す（Issue #1039）。 */
  cwdLabel: string;
  cwdFull: string;
  loop?: { running: boolean; paused: boolean } | undefined;
  pendingCount: number;
}

/** 左のrepoレールの1行。 */
export interface McRepo {
  key: string;
  label: string;
  /** hoverにだけ出す絶対パス。 */
  full: string;
  sessionCount: number;
  pendingCount: number;
}

export interface McSnapshot {
  /** 拡張ホストが作った時刻（ms）。経過時間の基準にする。 */
  now: number;
  windowId: string;
  repos: McRepo[];
  sessions: McSession[];
  /** 待ちの長い順（`createdAt`の古い順）。 */
  pending: McPendingItem[];
}

/** AskUserQuestionの質問1件（`SharedAskUserQuestion`と同じ形）。 */
export interface McQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

/** Codexの問い合わせの入力欄（`SharedPromptField`と同じ形）。 */
export interface McPromptField {
  id: string;
  label: string;
  description: string;
  options: Array<{ value: string; label: string }>;
  multiple: boolean;
  allowOther: boolean;
  required: boolean;
}

/** 承認・質問の全文（`SessionApprovalDetail`と同じ形）。 */
export interface McApprovalDetail {
  requestId: string;
  kind: string;
  title: string;
  detail: string;
  paths: string[];
  decidable: boolean;
  answer?: McAnswerMode | undefined;
  questions?: McQuestion[] | undefined;
  fields?: McPromptField[] | undefined;
  answerBlockedReason?: string | undefined;
}

export interface McTurn {
  role: 'user' | 'agent';
  text: string;
  truncated: boolean;
}

/** 拡張ホスト → webview。 */
export type McHostMessage =
  | { type: 'snapshot'; snapshot: McSnapshot }
  | {
      type: 'controlResult';
      seq: number;
      ok: boolean;
      error?: string | undefined;
      approvals?: McApprovalDetail[] | undefined;
      turns?: McTurn[] | undefined;
    };

/** 操作の宛先。 */
export interface McTarget {
  windowId: string;
  provider: McProvider;
  threadId: string;
}

/**
 * webview → 拡張ホストの操作。`action`以降の形は`sessionKanbanView.ts`の`parseAction`が
 * 受け付けるものと同じにし、拡張ホスト側は同じ関数で確かめる。
 */
export type McControlAction =
  | { action: 'open' }
  | { action: 'interrupt' }
  | { action: 'pauseLoop' }
  | { action: 'resumeLoop' }
  | { action: 'approvalDetail' }
  | { action: 'recentTurns'; limit: number }
  | { action: 'approvalDecision'; approvalRequestId: string; decision: 'accept' | 'decline' }
  | { action: 'answerQuestion'; pendingRequestId: string; answers: Record<string, string[]> }
  | {
      action: 'answerPrompt';
      pendingRequestId: string;
      submission: { action: 'submit' | 'decline'; values: Record<string, string[]> };
    }
  | { action: 'answerTaskRunQuestion'; pendingId: string; text: string };

export type McWebviewMessage =
  { type: 'ready' } | ({ type: 'control'; seq: number } & McTarget & McControlAction);
