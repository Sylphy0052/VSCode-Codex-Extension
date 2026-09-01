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

import * as fs from 'node:fs';

import {
  applyEvent,
  initialChatState,
  lastNonEmptyAgentMessageText,
  type ChatState,
} from '../../../src/appserver/chatState';
import { AppServerConnection, type ServerRequest } from '../../../src/appserver/connection';
import { buildDisabledMcpServersOverlay } from '../../../src/codex/mcpDisable';
import { SKILLS_DISABLED_CONFIG_OVERLAY } from '../../../src/codex/skillDisable';
import { sandboxPolicyFor } from '../../../src/codex/sandboxPolicy';
import type { Logger } from '../../../src/log';

import type { EvalToolCall } from './types';

/**
 * 本番のAdvisorと同じ実行条件（`src/secondOpinion/run.ts` の `buildSecondOpinionSessionInput`）。
 *
 * ここが本番と1つでも違うと、測っているのは「本番のセカンドオピニオン」ではなくなる。実際の
 * 経路は `buildSecondOpinionSessionInput` → `ChatViewManager.openTaskSession` →
 * `ChatSession.start` / `ChatSession.send` で、そこから出る値を写してある。
 *
 * - `sandbox: 'read-only'` … Advisorは読み取りのみ。`turn/start` 側の `sandboxPolicy` と組で効く
 * - `approvalPolicy: 'never'` … 承認要求を出さない
 * - `approvalsReviewer` は送らない（`toCodexConfig` が空に固定している）
 * - `bypassApprovalsAndSandbox` は false なので、`turnPolicyFor` は設定由来の
 *   `sandboxPolicy` だけを返す
 */
const SANDBOX_MODE = 'read-only';
const APPROVAL_POLICY = 'never';

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
  /**
   * 指定すると、送受信したJSON-RPCを1行1件のJSONで書き出す。
   *
   * プロトコルの読み違いは「回答が返った」だけでは見つからない。本体と同じ `applyEvent` を
   * 使っている以上、本体が取り違えていればハーネスも同じように取り違え、辻褄が合ってしまう。
   * 最初の1件は必ずこれを付けて流し、生のイベント列と `lastNonEmptyAgentMessageText` の結果を
   * 突き合わせる（`probe.ts`）。
   */
  traceFile?: string;
}

export interface CodexTurnResult {
  response: string;
  latencyMs: number;
  /** スレッド累計のトークン数。通知が届かなければ `undefined`。 */
  sessionTokens: number | undefined;
  /** いまコンテキストに載っていた量。 */
  contextUsage: ChatState['context'];
  /**
   * このターンで走らせたコマンド（Issue #1047）。
   *
   * `state.items` から取る。条件C-repoの費用は探索の往復として出るので、回数と中身の両方を
   * 残す。読んだファイルの一覧はここから集計側が取り出す（コマンドの形はCLIの版で変わるため、
   * 実行時に解釈して捨てない）。
   */
  toolCalls: EvalToolCall[];
  /** ターンが失敗・中断で終わった場合の理由。正常終了なら `undefined`。 */
  error?: string;
}

/**
 * `state.items` からコマンドの実行だけを拾う。
 *
 * `commandExecution` に限らないのは、CLIの版によって読み取りが別の種類の項目で届きうる
 * ためである。ここで種類を絞り込むと、増えた経路が黙って0件として記録される。
 * `agentMessage` / `reasoning`（回答そのもの）だけを外す。
 */
const NON_TOOL_ITEM_KINDS: ReadonlySet<string> = new Set(['agentMessage', 'reasoning']);

function collectToolCalls(items: ChatState['items']): EvalToolCall[] {
  return items
    .filter((item) => !NON_TOOL_ITEM_KINDS.has(item.kind))
    .map((item) => ({ kind: item.kind, detail: item.detail, status: item.status }));
}

/** 何も出さないLogger。ハーネスの進捗は `run.ts` が自分で出す。 */
const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  show: () => undefined,
};

/** 承認要求のメソッド名か。 */
function isApprovalRequest(method: string): boolean {
  return method.toLowerCase().includes('approval');
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
  /**
   * 想定していないサーバー要求。
   *
   * 応答は返す（返さないとapp-serverが待ち続け、ターンがタイムアウトするまで止まる）が、
   * **その実行は失敗として記録する**。測定系で未知のプロトコルを黙って握り潰すと、条件の差の
   * つもりでプロトコル不一致の影響を測ることになる。
   */
  const unexpectedRequests: string[] = [];

  const trace =
    request.traceFile === undefined
      ? undefined
      : fs.createWriteStream(request.traceFile, { flags: 'a' });
  const record = (kind: string, payload: unknown): void => {
    trace?.write(`${JSON.stringify({ at: new Date().toISOString(), kind, payload })}\n`);
  };

  const connection = new AppServerConnection(
    () => CODEX_BIN,
    silentLogger,
    (method, params) => {
      record('notification', { method, params });
      state = applyEvent(state, method, params);
      onEvent?.();
    },
    async (serverRequest: ServerRequest) => {
      record('serverRequest', { method: serverRequest.method, params: serverRequest.params });
      if (isApprovalRequest(serverRequest.method)) {
        // Advisorは読み取りのみ（`approvalPolicy: 'never'`）なので本来ここへは来ない。承認して
        // しまうと測定中のAdvisorが読み取り以外をできてしまい、本体と権限が変わる
        return { decision: 'denied' };
      }
      unexpectedRequests.push(serverRequest.method);
      return {};
    },
  );

  try {
    await connection.ensureStarted();

    // MCPサーバを1本も接続させない（Issue #944）。本番のAdvisorは `disableMcpServers: true` で
    // 開くため、ここで載せるとツール定義の分だけ条件が変わる。`config/read` に失敗しても
    // 本体と同じく組み込み分だけのオーバーレイで続ける
    let mcpServers: Record<string, unknown>;
    try {
      const config = await connection.request('config/read', {});
      record('response', { method: 'config/read', error: config.error });
      mcpServers = buildDisabledMcpServersOverlay(config.result);
    } catch {
      mcpServers = buildDisabledMcpServersOverlay(undefined);
    }

    const startParams = {
      cwd: request.cwd,
      sandbox: SANDBOX_MODE,
      approvalPolicy: APPROVAL_POLICY,
      model: request.model,
      // 本番と同じくskillを提示させない（`buildSecondOpinionSessionInput` の
      // `disableSkills: true`）。提示があるとAdvisorはbundleの外の `SKILL.md` を読みに行き、
      // 費用の指標である `toolCalls` に材料と無関係な読み取りが混ざる（Issue #1061）
      config: { mcp_servers: mcpServers, ...SKILLS_DISABLED_CONFIG_OVERLAY },
    };
    record('request', { method: 'thread/start', params: startParams });
    const started = await connection.request('thread/start', startParams);
    record('response', { method: 'thread/start', result: started.result, error: started.error });
    if (started.error !== undefined) {
      return {
        response: '',
        latencyMs: 0,
        sessionTokens: undefined,
        contextUsage: undefined,
        toolCalls: collectToolCalls(state.items),
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
        toolCalls: collectToolCalls(state.items),
        error: `thread/startの応答からthreadIdを取れませんでした: ${JSON.stringify(started.result)}`,
      };
    }

    const startedAt = Date.now();
    const completion = waitForTurnEnd((listener) => {
      onEvent = listener;
    });
    const turnParams = {
      threadId,
      input: [{ type: 'text', text: request.prompt }],
      model: request.model,
      effort: request.effort,
      approvalPolicy: APPROVAL_POLICY,
      // 本体は `turnPolicyFor` がこれを載せる（planMode無し・bypass無しなので、設定由来の
      // `sandboxPolicy` だけが出る）。`thread/start` の `sandbox` と組で読み取り専用になる
      sandboxPolicy: sandboxPolicyFor(SANDBOX_MODE),
    };
    record('request', { method: 'turn/start', params: { ...turnParams, input: '<prompt>' } });
    const turn = await connection.request('turn/start', turnParams);
    record('response', { method: 'turn/start', result: turn.result, error: turn.error });
    if (turn.error !== undefined) {
      return {
        response: '',
        latencyMs: Date.now() - startedAt,
        sessionTokens: state.sessionTokens,
        contextUsage: state.context,
        toolCalls: collectToolCalls(state.items),
        error: `turn/startに失敗しました: ${JSON.stringify(turn.error)}`,
      };
    }

    const outcome = await completion(() => state);
    const latencyMs = Date.now() - startedAt;
    const failure =
      outcome ??
      (unexpectedRequests.length === 0
        ? undefined
        : `想定していないサーバー要求を受けました: ${[...new Set(unexpectedRequests)].join(', ')}`);
    return {
      response: lastNonEmptyAgentMessageText(state.items),
      latencyMs,
      sessionTokens: state.sessionTokens,
      contextUsage: state.context,
      toolCalls: collectToolCalls(state.items),
      ...(failure === undefined ? {} : { error: failure }),
    };
  } finally {
    connection.dispose();
    trace?.end();
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

      // ターンが始まったことを見てからでないと終了を判定しない。`turn/started` より先に
      // 別の通知（`thread/tokenUsage/updated` など）が届くことがあり、その時点の状態は
      // 「turnIdが無く busy でもない」——つまり終了条件と見分けが付かない。始まる前に
      // 判定すると、回答が1文字も返っていないのに正常終了として記録してしまう
      let started = false;
      const check = (): void => {
        const state = readState();
        if (state.turnId !== undefined || state.busy) {
          started = true;
          return;
        }
        if (!started) {
          return;
        }
        clearTimeout(timer);
        resolve(state.turnFailed ? 'ターンが失敗として終了しました' : undefined);
      };
      subscribe(check);
    });
}
