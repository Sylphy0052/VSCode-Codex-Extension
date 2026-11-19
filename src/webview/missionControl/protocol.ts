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
  /** 最後の出力の1行（Issue #2137）。外部由来のテキストなので文字列として描くだけにする。 */
  lastOutput?: string | undefined;
  /** 出力が最後に変わった時刻（ms）。停滞の判定に使う。古い版のウィンドウでは無い。 */
  lastOutputAt?: number | undefined;
  /**
   * レビュー待ち（Issue #2138の1）。ターンが終わって作業ツリーに変更が残っていて、まだ
   * 「確認済み」にしていないときだけ載る。
   */
  review?: McReview | undefined;
}

/** レビュー待ちの変更1ファイル。 */
export interface McReviewFile {
  /** gitのtoplevelからの相対パス（`/`区切り）。 */
  path: string;
  /** 追加行数。バイナリ・未追跡は`undefined`。 */
  added?: number | undefined;
  /** 削除行数。バイナリ・未追跡は`undefined`。 */
  deleted?: number | undefined;
  /** 未追跡（新規）のファイル。 */
  untracked: boolean;
}

/** セッションの作業ツリーの変更（未commitと、比較元からの差分）。 */
export interface McReview {
  /** 比較元の表示名（`origin/main`か`HEAD`）。 */
  baseLabel: string;
  files: McReviewFile[];
  added: number;
  deleted: number;
  /** ファイルが多すぎて`files`を途中で切ったか。 */
  truncated: boolean;
}

/** Reloadで切れたセッション（Issue #2138の3）。Inboxに「再開待ち」として出す。 */
export interface McResumeItem {
  /** 一覧の中で一意（`resume:<provider>:<threadId>`）。 */
  id: string;
  windowId: string;
  provider: McProvider;
  threadId: string;
  title: string;
  repoKey: string;
  cwdLabel: string;
  /** Reloadの前に実行中だと最初に見た時刻（ms）。 */
  since: number;
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
  /** 実行中のまま出力がこの時間（ms）動かなければ「停滞」とする（Issue #2137の5）。 */
  stallMs: number;
  /** Reloadで切れたセッション（このウィンドウの分だけ）。古い版の拡張ホストでは無い。 */
  resumable?: McResumeItem[] | undefined;
}

/** 新規セッションの起動先の候補（Issue #2137の1）。 */
export interface McLaunchRepo {
  /** 起動に使う絶対パス（gitのtoplevel、または選んだフォルダ）。 */
  path: string;
  /** `McRepo.key`と同じ形。同じrepoで動いているセッションを数えるのに使う。 */
  key: string;
  label: string;
  source: 'session' | 'recent' | 'history' | 'picked';
}

/** 新規セッションの起動の要求。 */
export interface McLaunchRequest {
  cwd: string;
  provider: McProvider;
  /** 最初の指示。空なら会話を開くだけにする。 */
  prompt: string;
  /** 別のworktree（`<repo>/.claude/worktrees/`配下）で動かすか。 */
  worktree: boolean;
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

/** 引き継ぎ確認の中身（`SessionHandoffDetail`と同じ形）。 */
export interface McHandoffDetail {
  requestId: string;
  model: string;
  effort: string;
  reasons: string[];
  trigger: string;
  canReclassify: boolean;
  models: Array<{ slug: string; label: string; efforts: string[] }>;
}

export type McHandoffDecision = 'proceed' | 'repick' | 'reclassify' | 'cancel';

/** 脇道の質問1件の進み具合（`SessionSideQuestion`と同じ形）。 */
export interface McSideQuestion {
  id: string;
  status: 'running' | 'done' | 'failed';
  question: string;
  answer?: string | undefined;
  error?: string | undefined;
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
      /** `handoffDetail`の応答。保留が無ければ無い。 */
      handoff?: McHandoffDetail | undefined;
      /** `sideQuestion`・`sideQuestionResult`の応答。 */
      sideQuestion?: McSideQuestion | undefined;
    }
  | {
      /** `launchOptions`・`pickFolder`・`launch`への応答（Issue #2137）。 */
      type: 'reply';
      seq: number;
      ok: boolean;
      error?: string | undefined;
      repos?: McLaunchRepo[] | undefined;
      repo?: McLaunchRepo | undefined;
      /** 起動した作業ディレクトリ。worktreeで起動したときはそのパス。 */
      cwd?: string | undefined;
    }
  | {
      /** 詳細で選択中のセッションの直近のやり取り（ライブtail。Issue #2137の3）。 */
      type: 'liveTurns';
      target: McTarget;
      ok: boolean;
      error?: string | undefined;
      turns?: McTurn[] | undefined;
    };

/** 操作の宛先。 */
export interface McTarget {
  windowId: string;
  provider: McProvider;
  threadId: string;
}

/**
 * webview → 拡張ホストの操作。`action`以降の形は`sessionControlMessage.ts`の`parseAction`が
 * 受け付けるものと同じにし、拡張ホスト側は同じ関数で確かめる。
 */
export type McControlAction =
  | { action: 'open' }
  | { action: 'interrupt' }
  | { action: 'pauseLoop' }
  | { action: 'resumeLoop' }
  | { action: 'approvalDetail' }
  | { action: 'recentTurns'; limit: number }
  | { action: 'send'; text: string }
  | { action: 'approvalDecision'; approvalRequestId: string; decision: 'accept' | 'decline' }
  | { action: 'answerQuestion'; pendingRequestId: string; answers: Record<string, string[]> }
  | {
      action: 'answerPrompt';
      pendingRequestId: string;
      submission: { action: 'submit' | 'decline'; values: Record<string, string[]> };
    }
  | { action: 'answerTaskRunQuestion'; pendingId: string; text: string }
  | { action: 'handoffDetail' }
  | {
      action: 'handoffDecision';
      handoffRequestId: string;
      decision: McHandoffDecision;
      model?: string | undefined;
      effort?: string | undefined;
    }
  | { action: 'sideQuestion'; text: string }
  | { action: 'sideQuestionResult'; sideQuestionId: string };

export type McWebviewMessage =
  | { type: 'ready' }
  | ({ type: 'control'; seq: number } & McTarget & McControlAction)
  | { type: 'launchOptions'; seq: number }
  | { type: 'pickFolder'; seq: number }
  | ({ type: 'launch'; seq: number } & McLaunchRequest)
  /** ライブtailの対象。`target`が無ければ止める。 */
  | { type: 'watch'; target?: McTarget | undefined }
  /** レビュー待ちの1ファイルをdiffエディタで開く（Issue #2138の1）。 */
  | ({ type: 'openDiff'; seq: number; path: string } & McTarget)
  /** レビュー待ちを「確認済み」にする。 */
  | ({ type: 'reviewAck'; seq: number } & McTarget)
  /** 再開待ちの会話を開き直す（Issue #2138の3）。 */
  | ({ type: 'resume'; seq: number } & McTarget)
  /** 再開待ちを一覧から外す。 */
  | ({ type: 'resumeDismiss'; seq: number } & McTarget)
  /** ウィンドウのReload。実行中のターンがあれば拡張ホストが件数を出して確かめる。 */
  | { type: 'reloadWindow'; seq: number };
