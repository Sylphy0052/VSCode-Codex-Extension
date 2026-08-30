/**
 * 実物の `codex app-server` で1ターン走らせる（Issue #1044）。
 *
 * 拡張本体と**同じ接続実装・同じイベント解釈**を使う。`AppServerConnection` と `applyEvent` を
 * 呼ぶだけにしてあるのは、ハーネス側でJSON-RPCの往復やイベントの読み方を書き直すと、測っている
 * のが本体の挙動ではなくハーネスの挙動になるためである。
 *
 * VSCodeは起動しない。`src/appserver` `src/codex` `src/process` はいずれも `vscode` に依存して
 * いないため、素のNodeプロセスから使える（`test/external-cli/threadStart.test.mjs` と同じ前提）。
 */

import {
  applyEvent,
  initialChatState,
  lastNonEmptyAgentMessageText,
  type ChatState,
} from '../../../src/appserver/chatState';
import { AppServerConnection, type ServerRequest } from '../../../src/appserver/connection';
import type { Logger } from '../../../src/log';

/** 起動先。CIやローカルでバージョンを固定したい場合に環境変数で差し替える。 */
const CODEX_BIN = process.env['CODEX_BIN'] ?? 'codex';

/**
 * 1ターンを待つ上限。
 *
 * 本体の既定（`agent.secondOpinion.timeoutMs` の15分）へ合わせてある。ここだけ短くすると、
 * 本体なら返っていた回答がハーネスでは打ち切られ、条件の差ではなく上限の差を測ることになる。
 */
export const TURN_TIMEOUT_MS = 15 * 60_000;

export interface CodexTurnRequest {
  /** セッションの作業ディレクトリ。レビュー材料を置いたbundleのパスを渡す。 */
  cwd: string;
  prompt: string;
  model: string;
  effort: string;
}

export interface CodexTurnResult {
  response: string;
  latencyMs: number;
  /** スレッド累計のトークン数。通知が届かなければ `undefined`。 */
  sessionTokens: number | undefined;
  /** いまコンテキストに載っていた量。 */
  contextUsage: ChatState['context'];
  /** ターンが失敗・中断で終わった場合の理由。正常終了なら `undefined`。 */
  error?: string;
}

/** 何も出さないLogger。ハーネスの進捗は `run.ts` が自分で出す。 */
const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  show: () => undefined,
};

/**
 * 承認要求への応答。
 *
 * Advisorは読み取りのみ（`approvalPolicy: 'never'`）で動かすため、本来ここへは来ない。
 * それでも**必ず何か返す**必要がある。応答を返さないとapp-serverは待ち続け、ターンが
 * タイムアウトするまでハーネスが止まる（`ServerRequestHandler` の契約）。
 *
 * 返すのは一律の拒否である。ここで承認してしまうと、測定中のAdvisorが読み取り以外のことを
 * できてしまい、本体の権限と条件が変わる。
 */
async function denyServerRequest(request: ServerRequest): Promise<unknown> {
  if (request.method.includes('Approval') || request.method.includes('approval')) {
    return { decision: 'denied' };
  }
  return {};
}

/**
 * 1ターン送って回答を得る。
 *
 * 接続はターンごとに立て直す。1本を使い回すと、前の案件のスレッドが同じプロセスに残り、
 * 「独立した相談」という前提が崩れる可能性がある。測定の回数はたかだか数百回なので、
 * 起動コストより独立性を優先する。
 */
export async function runCodexTurn(request: CodexTurnRequest): Promise<CodexTurnResult> {
  let state: ChatState = initialChatState;
  let onEvent: (() => void) | undefined;

  const connection = new AppServerConnection(
    () => CODEX_BIN,
    silentLogger,
    (method, params) => {
      state = applyEvent(state, method, params);
      onEvent?.();
    },
    denyServerRequest,
  );

  try {
    await connection.ensureStarted();
    const started = await connection.request('thread/start', { cwd: request.cwd });
    if (started.error !== undefined) {
      return {
        response: '',
        latencyMs: 0,
        sessionTokens: undefined,
        contextUsage: undefined,
        error: `thread/startに失敗しました: ${JSON.stringify(started.error)}`,
      };
    }
    const threadId = readThreadId(started.result);
    if (threadId === undefined) {
      return {
        response: '',
        latencyMs: 0,
        sessionTokens: undefined,
        contextUsage: undefined,
        error: `thread/startの応答からthreadIdを取れませんでした: ${JSON.stringify(started.result)}`,
      };
    }

    const startedAt = Date.now();
    const completion = waitForTurnEnd((listener) => {
      onEvent = listener;
    });
    const turn = await connection.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: request.prompt }],
      model: request.model,
      effort: request.effort,
      // Advisorは読み取りのみ。本体（`buildSummarySessionInput` と同じ固定値）へ揃える
      approvalPolicy: 'never',
    });
    if (turn.error !== undefined) {
      return {
        response: '',
        latencyMs: Date.now() - startedAt,
        sessionTokens: state.sessionTokens,
        contextUsage: state.context,
        error: `turn/startに失敗しました: ${JSON.stringify(turn.error)}`,
      };
    }

    const outcome = await completion(() => state);
    const latencyMs = Date.now() - startedAt;
    return {
      response: lastNonEmptyAgentMessageText(state.items),
      latencyMs,
      sessionTokens: state.sessionTokens,
      contextUsage: state.context,
      ...(outcome === undefined ? {} : { error: outcome }),
    };
  } finally {
    connection.dispose();
  }
}

/** `thread/start` の応答から threadId を読む（`chatSession.ts` の readThreadId と同じ場所）。 */
function readThreadId(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) {
    return undefined;
  }
  const thread = (result as Record<string, unknown>)['thread'];
  if (typeof thread !== 'object' || thread === null) {
    return undefined;
  }
  const id = (thread as Record<string, unknown>)['id'];
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/**
 * ターンの終わりを待つ。
 *
 * `busy` の立ち下がりでは判定しない。`busy` は `turn/completed` より先に落ちることがあり
 * （`chatState.ts` の注記）、そこで打ち切ると回答の途中を最終結果として記録してしまう。
 * ここでは `turnId` が消えたこと（`turn/completed` / `turn/failed` の処理後）を終わりとみなす。
 *
 * 戻り値は「異常終了の理由」。正常終了なら `undefined`。
 */
function waitForTurnEnd(
  subscribe: (listener: () => void) => void,
): (readState: () => ChatState) => Promise<string | undefined> {
  return (readState) =>
    new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => {
        resolve(`ターンが${TURN_TIMEOUT_MS}ms以内に終わりませんでした`);
      }, TURN_TIMEOUT_MS);
      timer.unref();

      const check = (): void => {
        const state = readState();
        if (state.turnId !== undefined || state.busy) {
          return;
        }
        clearTimeout(timer);
        resolve(state.turnFailed ? 'ターンが失敗として終了しました' : undefined);
      };
      subscribe(check);
    });
}
