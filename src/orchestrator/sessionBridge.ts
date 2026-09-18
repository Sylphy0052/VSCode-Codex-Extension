/**
 * ウィンドウをまたぐセッションへの宛先解決（design.md §16.21「宛先解決の統合」、
 * Issue #1274、親Issue #1270 Phase 4）。
 *
 * `messaging.ts`（同一ウィンドウのタスク間）と`src/view/sessionHub.ts`（ウィンドウ間）は
 * それぞれ別の宛先の持ち方をしていた。エージェントから見える口はMCPだけなので、
 * `send_message` / `ask_session` の宛先解決を`TaskMessagingHub`の背後の1箇所へ集める。
 * このモジュールは**その境界の型と、宛先表記の読み書きだけ**を持つ。
 *
 * `messaging.ts`と同じくVSCode APIへ依存しない。`SessionHub`の実体（共有ディレクトリへの
 * 要求ファイルの書き出し・自ウィンドウのチャット画面への直接の配送）は`extension.ts`が
 * 組み立てて`SessionBridgePort`として渡す（`OrchestratorControlPort` / `HandoffPort`と
 * 同じ「実体は呼び出し側が持ち、ここには薄い口だけ置く」流儀）。
 */

/** セッションのプロバイダ。`src/view/sessionHub.ts`の`SharedSession.provider`と同じ2値。 */
export type SessionProvider = 'codex' | 'claude';

/**
 * セッション宛先の接頭辞。
 *
 * `send_message`の`to`がこれで始まるなら、同じrunのタスクidではなくセッション宛
 * （別ウィンドウを含む）として解釈する。タスクid（`TASK_ID_PATTERN`）に`:`は含まれない
 * ため、既存の宛先と衝突しない。
 */
export const SESSION_TARGET_PREFIX = 'session:';

/** 1つのセッションを一意に指す組。 */
export interface SessionTarget {
  /** そのセッションを抱えているウィンドウのid（`SessionHubWriter`が書くファイル名と同じ値）。 */
  windowId: string;
  provider: SessionProvider;
  threadId: string;
}

/**
 * 宛先表記を組み立てる: `session:<provider>:<windowId>:<threadId>`。
 *
 * `windowId`はUUID（`:`を含まない）、`provider`は2値のいずれかなので、前から2つの`:`で
 * 割れば`threadId`に`:`が含まれていても壊れない（`parseSessionTarget`参照）。
 */
export function formatSessionTarget(target: SessionTarget): string {
  return `${SESSION_TARGET_PREFIX}${target.provider}:${target.windowId}:${target.threadId}`;
}

/**
 * 宛先表記を読み解く。セッション宛の形でなければ`undefined`を返す。
 *
 * 形が合わない値を`undefined`で返すのは、呼び出し側（`TaskMessagingHub.sendMessage`）が
 * 「セッション宛ではない＝従来どおり同じrunのタスク宛として検証する」へ分岐するため。
 * `session:`で始まるのに形が壊れている場合だけは、タスク宛として扱うと「宛先が
 * 見つかりません」という的外れな理由になるので、`malformed`として区別する。
 */
export function parseSessionTarget(
  value: string,
): { kind: 'session'; target: SessionTarget } | { kind: 'malformed' } | undefined {
  if (!value.startsWith(SESSION_TARGET_PREFIX)) {
    return undefined;
  }
  const rest = value.slice(SESSION_TARGET_PREFIX.length);
  const firstCut = rest.indexOf(':');
  if (firstCut <= 0) {
    return { kind: 'malformed' };
  }
  const provider = rest.slice(0, firstCut);
  if (provider !== 'codex' && provider !== 'claude') {
    return { kind: 'malformed' };
  }
  const afterProvider = rest.slice(firstCut + 1);
  const secondCut = afterProvider.indexOf(':');
  if (secondCut <= 0 || secondCut === afterProvider.length - 1) {
    return { kind: 'malformed' };
  }
  return {
    kind: 'session',
    target: {
      provider,
      windowId: afterProvider.slice(0, secondCut),
      threadId: afterProvider.slice(secondCut + 1),
    },
  };
}

/**
 * `list_sessions`が返す1件。
 *
 * 会話本文は載せない（`SharedSession`と同じ方針。タイトルとcwdまで）。エージェントは
 * ここで得た`ref`をそのまま`send_message`の`to`・`ask_session`の`to`へ渡す。
 */
export interface SessionSummary {
  /** `formatSessionTarget`が作った宛先表記。 */
  ref: string;
  provider: SessionProvider;
  title: string;
  /** そのセッションの作業ディレクトリ。取れなければ空文字。 */
  cwd: string;
  /** `SessionActivityState`をそのまま文字列で運ぶ（版が違えば知らない値が来る）。 */
  activity: string;
  /** 同じウィンドウのセッションか。`false`ならウィンドウをまたぐ往復になる。 */
  sameWindow: boolean;
}

/** `SessionBridgePort`の各操作の結果の基本形（`send_message`の`{accepted, reason}`に合わせる）。 */
export interface SessionBridgeResult {
  ok: boolean;
  /** 失敗の理由。人が読める文にする（そのままMCPの応答へ載る）。 */
  error?: string | undefined;
}

/** `ask_session`の結果。受け付けられていれば、以後`questionId`で進み具合を引く。 */
export interface SessionAskResult extends SessionBridgeResult {
  questionId?: string | undefined;
}

/** `ask_session_result`の結果。 */
export interface SessionAskStatusResult extends SessionBridgeResult {
  /** `running`なら回答待ち。`done`なら`answer`、`failed`なら`reason`が入る。 */
  status?: 'running' | 'done' | 'failed' | undefined;
  answer?: string | undefined;
  /** `status === 'failed'`のときの、相手側が返した理由。 */
  reason?: string | undefined;
}

/**
 * `TaskMessagingHubDeps.sessionBridge`が満たす形。
 *
 * 実体は`extension.ts`が組み立てる。同じウィンドウのセッションなら`controlSession`を
 * 直接呼び、別ウィンドウなら`SessionHubRequestPort.request`へ流す——その分岐は実体側に
 * 閉じ込め、ここから見える口は宛先の別によらず1つにする（Issue #1274「宛先解決を1箇所へ
 * 集める」）。
 *
 * **このポートを通る本文は、呼び出し側（`messaging.ts`）が`formatUntrusted`で囲ってから
 * 渡す。** 実体側では囲わない。囲いは送信側で付けるほうが、受信側のウィンドウが古い版でも
 * 効く（越境の本文は受信側のプロンプトへそのまま入る）。
 */
export interface SessionBridgePort {
  /** いま見えているセッションの一覧（自ウィンドウ分を含む）。 */
  listSessions(): readonly SessionSummary[];
  /** 本文を1件届ける。届いたかどうかだけを返し、相手の応答は待たない。 */
  send(target: SessionTarget, body: string): Promise<SessionBridgeResult>;
  /** 問いを1件投げる。回答は待たず、引き当てるための`questionId`を返す。 */
  ask(target: SessionTarget, question: string): Promise<SessionAskResult>;
  /** 投げた問いの進み具合を引く。 */
  askResult(target: SessionTarget, questionId: string): Promise<SessionAskStatusResult>;
}
