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
  /** CLIが通知したmodel（Issue #2151）。外部由来のテキストなので文字列として描くだけにする。 */
  model?: string | undefined;
  /** セッション累計のトークン数（Codexだけ）。 */
  tokens?: number | undefined;
  /** セッションの推定費用（USD。Claude Codeだけ）。 */
  costUsd?: number | undefined;
  /**
   * レビュー待ち（Issue #2138の1）。ターンが終わって作業ツリーに変更が残っていて、まだ
   * 「確認済み」にしていないときだけ載る。
   */
  review?: McReview | undefined;
  /** 履歴でピン留めしているか（Issue #2160）。古い版の拡張ホストは返さない。 */
  pinned?: boolean | undefined;
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
  /** オーケストレータモードのrun（Issue #2150）。task runが使えないときは無い。 */
  runs?: McRunsSnapshot | undefined;
}

/**
 * runの状態の区分（Issue #2150）。`waiting`は一時停止中と計画の承認待ち、`suspended`は中断中、
 * `finished`は終えたrun。
 */
export type McRunState = 'running' | 'waiting' | 'suspended' | 'finished';

/** runのタスク1件。 */
export interface McRunTask {
  taskId: string;
  title: string;
  /** 工程の列の表示名（計画承認待ち・実装・レビューなど）。 */
  stage: string;
  /** 依存待ち・失敗・停止などのバッジの表示名。 */
  badges: string[];
  /** 人の対応が要るバッジがあるか。 */
  warn: boolean;
  done: boolean;
  issueNumber?: number | undefined;
  pullRequestNumber?: number | undefined;
}

/** run一覧の1行。 */
export interface McRun {
  runId: string;
  label: string;
  /** 状態の表示名（実行中・一時停止中・中断中・終了など）。 */
  status: string;
  state: McRunState;
  /** runの進み具合の説明（人の対応待ち・すべて完了など）。 */
  assessment: string;
  workspaceRoot: string;
  /** `workspaceRoot`の末尾の要素。 */
  repoLabel: string;
  engine: McProvider;
  maxParallel: number;
  activeSessions: number;
  halted: boolean;
  /** 開始時刻（ISO 8601）。 */
  startedAt: string;
  inCurrentFolder: boolean;
  taskTotal: number;
  taskDone: number;
  /** 終えたrunでは空（一覧を軽くするため）。 */
  tasks: McRunTask[];
}

/** roadmapから起動するときのフォルダの候補（開いているワークスペースフォルダ）。 */
export interface McRunFolder {
  path: string;
  label: string;
}

export interface McRunsSnapshot {
  /** Kanbanと同じ並び（開いているフォルダのrunが先、それぞれ新しい順）。 */
  runs: McRun[];
  /** 並列上限の最大値。 */
  maxParallelLimit: number;
  folders: McRunFolder[];
}

/** runへの操作（Issue #2150）。`finish`・`suspend`は拡張ホストが確認を出す。 */
export type McRunOp = 'switch' | 'pause' | 'unpause' | 'suspend' | 'resume' | 'finish';

/** roadmap・Issueの一覧の1件。 */
export interface McIssueItem {
  number: number;
  title: string;
  /** `roadmap`ラベルが付いているか。 */
  roadmap: boolean;
}

/** roadmapの着手順（本文のチェックリストの並び）。 */
export interface McRoadmapOrder {
  number: number;
  title: string;
  children: Array<{ number: number; title: string; checked: boolean }>;
}

export interface McIssueListing {
  folder: string;
  roadmaps: McRoadmapOrder[];
  /** OPENのIssue（roadmapを含む）。 */
  issues: McIssueItem[];
}

/**
 * roadmap・Issueからの起動。`roadmapIssueNumbers`は1本ずつそのroadmapで起動し（`start_roadmap_orchestrator`
 * と同じ経路）、`issueNumbers`は自由な指示から始めるrunを1本始めて、選んだIssue番号を最初の指示文で渡す。
 */
export interface McIssueStartRequest {
  folder: string;
  engine: McProvider;
  roadmapIssueNumbers: number[];
  issueNumbers: number[];
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

/**
 * 起動時に選べる設定（Issue #2149の2）。空文字・未指定は「拡張機能の設定のまま」を表す。
 * 承認方針は拡張機能の設定より緩められない（拡張ホストがクランプする）。
 */
export interface McLaunchSettings {
  model?: string | undefined;
  effort?: string | undefined;
  /** Codexは`approvalMode`、Claudeは`permissionMode`の値。 */
  approval?: string | undefined;
  /** `agent.sessionPresets`の`name`。プリセットの値を土台にし、上の3つで上書きする。 */
  preset?: string | undefined;
}

/** 新規セッションの起動の要求。 */
export interface McLaunchRequest extends McLaunchSettings {
  cwd: string;
  provider: McProvider;
  /** 最初の指示。空なら会話を開くだけにする。 */
  prompt: string;
  /** 別のworktree（`<repo>/.claude/worktrees/`配下）で動かすか。 */
  worktree: boolean;
}

/** 開始ダイアログのmodelの候補1件。 */
export interface McLaunchModel {
  slug: string;
  label: string;
  /** このmodelで選べるeffort。空ならeffortを選べないmodel。 */
  efforts: string[];
}

/** 開始ダイアログの承認方針の候補1件。 */
export interface McLaunchApproval {
  value: string;
  label: string;
}

/** providerごとの候補。 */
export interface McLaunchProviderChoices {
  models: McLaunchModel[];
  /** modelを選ばないときのeffortの候補。 */
  efforts: string[];
  /** 拡張機能の設定と同じか、それより厳しいものだけ。 */
  approvals: McLaunchApproval[];
  /** 拡張機能の設定の値（「設定のまま」の表示に使う）。 */
  current: { model: string; effort: string; approval: string };
}

/** プリセット1件（`agent.sessionPresets`）。 */
export interface McLaunchPreset {
  name: string;
  provider: McProvider;
  model: string;
  effort: string;
  approval: string;
}

/** repoごとに覚えた前回の選択。 */
export interface McLaunchDefaults extends McLaunchSettings {
  provider: McProvider;
}

export interface McLaunchChoices {
  providers: Record<McProvider, McLaunchProviderChoices>;
  presets: McLaunchPreset[];
  /** `McLaunchRepo.key` → 前回の選択。 */
  defaults: Record<string, McLaunchDefaults>;
}

/**
 * セッションのライフサイクル操作（Issue #2149の1）。`archive`は取り消せる（履歴から
 * archive解除できる）。`delete`は取り消せないので拡張ホストが確認を出す。
 */
export type McLifecycleOp = 'close' | 'archive' | 'delete';

/** ライフサイクル操作の1件ごとの結果。 */
export interface McLifecycleOutcome {
  target: McTarget;
  ok: boolean;
  error?: string | undefined;
}

/** 履歴の1件（Issue #2149の3）。archive済みを含む。 */
export interface McHistoryItem {
  provider: McProvider;
  threadId: string;
  title: string;
  repoKey: string;
  repoLabel: string;
  cwdFull: string;
  /** 最後に更新された時刻（ms）。不明なら0。 */
  updatedAt: number;
  archived: boolean;
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
  /** `tool`はツール呼び出し、`diff`はファイル変更（Issue #2157。詳細ペインで折りたたんで出す）。 */
  role: 'user' | 'agent' | 'tool' | 'diff';
  text: string;
  truncated: boolean;
  /** `tool` / `diff`の見出し（コマンド行・ツール名・変更したファイル）。 */
  title?: string | undefined;
  /** 人の発言の固定のid（Issue #2160）。巻き戻しの起点の指定に使う。 */
  id?: string | undefined;
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
      /** `turns`の先頭が会話の何件目か（0始まり）と会話全体の件数（Issue #2157）。古い版は返さない。 */
      turnStart?: number | undefined;
      turnTotal?: number | undefined;
      /** `handoffDetail`の応答。保留が無ければ無い。 */
      handoff?: McHandoffDetail | undefined;
      /** `sideQuestion`・`sideQuestionResult`の応答。 */
      sideQuestion?: McSideQuestion | undefined;
      /** `fileCandidates`の応答（Issue #2158）。会話の作業ディレクトリからの相対パス。 */
      files?: string[] | undefined;
      /** `commandCandidates`の応答（Issue #2158）。 */
      commands?: McSlashCommand[] | undefined;
      /** `queuedMessages`の応答（Issue #2158）。 */
      queued?: McQueuedMessage[] | undefined;
      /** `sessionSettings`・`changeSetting`の応答（Issue #2159）。 */
      settings?: McSessionSettings | undefined;
      /** `rewindPreview`の応答（Issue #2160）。戻すと変わるファイル。 */
      rewindFiles?: string[] | undefined;
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
      /** `launchOptions`の応答: model・effort・承認方針・プリセットの候補（Issue #2149の2）。 */
      choices?: McLaunchChoices | undefined;
      /** `lifecycle`の応答: 1件ごとの結果（Issue #2149の1）。確認で取りやめたら無い。 */
      outcomes?: McLifecycleOutcome[] | undefined;
      /** `history`の応答（Issue #2149の3）。 */
      history?: McHistoryItem[] | undefined;
      /** `issueList`の応答（Issue #2150）。 */
      issues?: McIssueListing | undefined;
      /** run・roadmapの操作の結果の説明（Issue #2150）。 */
      message?: string | undefined;
      /** `pickAttachments`の応答: 画像（Issue #2158）。 */
      attachments?: McAttachment[] | undefined;
      /** `pickAttachments`の応答: 画像以外のファイルの絶対パス。本文へ`@パス`で差し込む。 */
      paths?: string[] | undefined;
    }
  | {
      /** 詳細で選択中のセッションの直近のやり取り（ライブtail。Issue #2137の3）。 */
      type: 'liveTurns';
      target: McTarget;
      ok: boolean;
      error?: string | undefined;
      turns?: McTurn[] | undefined;
      turnStart?: number | undefined;
      turnTotal?: number | undefined;
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
  /** `before`を付けると、その件数目より前を取る（Issue #2157。古いやり取りを遡る）。 */
  | { action: 'recentTurns'; limit: number; before?: number | undefined }
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
  | { action: 'sideQuestionResult'; sideQuestionId: string }
  // Issue #2158: Composerの添付・補完・送信キュー
  | { action: 'sendWithAttachments'; text: string; attachments: McAttachment[] }
  | { action: 'fileCandidates'; query: string }
  | { action: 'commandCandidates' }
  | { action: 'queuedMessages' }
  | { action: 'cancelQueued'; index: number; queuedId: string }
  // Issue #2159: 実行中セッションの設定
  | { action: 'sessionSettings' }
  | McSettingChangeAction
  // Issue #2160: 選んだセッションへの操作。clear・巻き戻しはwebviewで確認してから送る
  | { action: 'rename'; name: string }
  | { action: 'fork' }
  | { action: 'pin' }
  | { action: 'unpin' }
  | { action: 'clear' }
  | { action: 'handoff' }
  /** `messageId`は`McTurn.id`（人の発言の固定のid）。表示テキストや位置では指さない。 */
  | { action: 'rewindPreview'; messageId: string }
  | { action: 'rewind'; messageId: string };

/** 設定の変更1件（Issue #2159）。形は`sessionHub.ts`の`parseSessionSettingChange`が確かめる。 */
export type McSettingChangeAction =
  | { action: 'changeSetting'; setting: 'model' | 'effort'; value: string }
  | { action: 'changeSetting'; setting: 'approvalLevel'; value: McApprovalLevel }
  | { action: 'changeSetting'; setting: 'planMode' | 'fastMode'; value: boolean };

export type McApprovalLevel = 'ask' | 'auto' | 'full';

/**
 * 実行中セッションの今の設定（Issue #2159）。`sessionHub.ts`の`SessionSettingsDetail`と同じ形。
 *
 * `approvalScope`は承認レベルの変更が効く範囲: `session`はこのセッションだけ（Claude）、
 * `global`はCodex全体の設定（タスク設定を持たない全Codexセッション）、`task`は変えられない。
 */
export interface McSessionSettings {
  model: string;
  effort: string;
  /** 先頭は既定（`slug: ''`）。 */
  models: Array<{ slug: string; label: string; efforts: string[] }>;
  /** 空文字はどのレベルにも当たらない（カスタム）。 */
  approvalLevel: string;
  approvalScope: 'session' | 'global' | 'task';
  planMode: boolean;
  /** 無ければこのセッションで使えない。 */
  fastMode?: boolean | undefined;
  editable: boolean;
}

/** 送る画像1件（Issue #2158）。`dataUrl`はpng / jpeg / gif / webpのbase64。 */
export interface McAttachment {
  name: string;
  dataUrl: string;
}

/** スラッシュコマンドの候補1件（Issue #2158）。 */
export interface McSlashCommand {
  name: string;
  description: string;
  argumentHint: string;
}

/** 送信キューの1件（Issue #2158）。 */
export interface McQueuedMessage {
  /** 項目の安定したid。取り消しの照合に使う。 */
  id: string;
  text: string;
  truncated: boolean;
  /** 添えた画像の枚数。 */
  attachments: number;
}

export type McWebviewMessage =
  | { type: 'ready' }
  | ({ type: 'control'; seq: number } & McTarget & McControlAction)
  | { type: 'launchOptions'; seq: number }
  | { type: 'pickFolder'; seq: number }
  | ({ type: 'launch'; seq: number } & McLaunchRequest)
  /** 閉じる・archive・delete（Issue #2149の1）。複数選択はまとめて1件で送る。 */
  | { type: 'lifecycle'; seq: number; op: McLifecycleOp; targets: McTarget[] }
  /** 履歴の一覧を取り寄せる（Issue #2149の3）。絞り込みはwebviewで行う。 */
  | { type: 'history'; seq: number }
  /** 履歴の1件をこのウィンドウで開き直す。 */
  | { type: 'historyOpen'; seq: number; provider: McProvider; threadId: string }
  /** ライブtailの対象。`target`が無ければ止める。 */
  | { type: 'watch'; target?: McTarget | undefined }
  /** レビュー待ちの1ファイルをdiffエディタで開く（Issue #2138の1）。 */
  | ({ type: 'openDiff'; seq: number; path: string } & McTarget)
  /** レビュー待ちを「確認済み」にする。 */
  | ({ type: 'reviewAck'; seq: number } & McTarget)
  /** runの操作（Issue #2150）。 */
  | { type: 'runOp'; seq: number; op: McRunOp; runId: string }
  /** runの並列上限を変える。 */
  | { type: 'runParallel'; seq: number; runId: string; maxParallel: number }
  /** 新しいrunを始める（`agent.taskRun.start`と同じ）。 */
  | { type: 'runStart'; seq: number }
  /** roadmapの着手順とOPENのIssueを取り寄せる。 */
  | { type: 'issueList'; seq: number; folder: string }
  /** roadmap・Issueからオーケストレータを起動する。 */
  | ({ type: 'issueStart'; seq: number } & McIssueStartRequest)
  /** 再開待ちの会話を開き直す（Issue #2138の3）。 */
  | ({ type: 'resume'; seq: number } & McTarget)
  /** 再開待ちを一覧から外す。 */
  | ({ type: 'resumeDismiss'; seq: number } & McTarget)
  /** ウィンドウのReload。実行中のターンがあれば拡張ホストが件数を出して確かめる。 */
  | { type: 'reloadWindow'; seq: number }
  /** セッションidをクリップボードへコピーする（旧統括ページの「idをコピー」）。 */
  | ({ type: 'copyRef'; seq: number } & McTarget)
  /** 添付するファイルを選ぶ（Issue #2158）。`cwd`はダイアログの初期位置にだけ使う。 */
  | { type: 'pickAttachments'; seq: number; cwd?: string | undefined }
  /**
   * 許可リスト（`extensionCommands.ts`）の拡張コマンドを実行する（Issue #2161）。送るのは
   * コマンドidだけで、引数は拡張ホストが決める。宛先は、選択中のセッションのproviderを渡す
   * コマンドにだけ付ける。
   */
  | ({ type: 'runCommand'; seq: number; command: string } & Partial<McTarget>);
