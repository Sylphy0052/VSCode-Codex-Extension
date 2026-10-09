import { randomBytes } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { startHttpMcpServer, type HttpMcpServerHandle } from '../orchestrator/mcpHttpServer';
import {
  failure,
  success,
  toolTextResult,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpConnection,
  type McpToolDefinition,
} from '../orchestrator/messaging';
import {
  generateImage,
  IMAGE_PROMPT_MAX_LENGTH,
  parseGenerateImageArgs,
  pruneOldImages,
  type GenerateImageRequest,
  type GenerateImageResult,
} from './imageGeneration';

/**
 * ChatGPT（Web）で画像を生成するMCPサーバ（Issue #1901）。
 *
 * ウィンドウにつき1つのHTTPサーバを立て、同じURLを新しく開く会話のMCP設定へ渡す。
 * ツールは誰が呼んでも同じ動作で、呼び出し元を区別する必要が無いため、トークンは
 * セッションごとに分けない（URLを知らない他プロセスから呼べないようにするためだけに使う）。
 */

/** CLIのMCP設定に書くサーバ名。`isValidMcpServerName`を満たす。 */
export const IMAGE_GENERATION_MCP_SERVER_NAME = 'webgpt_image';
/**
 * Codexのツール呼び出しの待ち時間（秒）。既定の60秒では生成を待てない。生成の待ち上限
 * （10分）に、Chromeの起動とページの読み込みの分を足す。
 */
export const IMAGE_GENERATION_TOOL_TIMEOUT_SEC = 900;

const SERVER_INFO_RESULT = {
  protocolVersion: '2024-11-05',
  serverInfo: { name: 'vscode-codex-extension-webgpt-image', version: '1' },
  capabilities: { tools: {} },
};

const GENERATE_IMAGE_TOOL: McpToolDefinition = {
  name: 'generate_image',
  description:
    'ログイン済みChromeのChatGPT（Web）に画像を生成させ、画像をローカルへ保存して絶対パスを返す。' +
    '生成には数十秒から数分かかる。失敗しても自動では再送しない。' +
    '同じ会話で修正を続けるときは、前回の結果のconversationUrlを渡す。',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: `ChatGPTへ送る画像生成の指示（1〜${IMAGE_PROMPT_MAX_LENGTH}文字）`,
      },
      conversationUrl: {
        type: 'string',
        description:
          '前回の結果のconversationUrl（https://chatgpt.com/c/<id>）。このウィンドウでgenerate_imageが返した会話だけを指定できる。省略すると新しい会話を作る',
      },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
};

export interface ImageGenerationMcpDeps {
  /** 呼び出しのたびに読む。設定の変更を次の呼び出しから反映するため。 */
  readEndpoint: () => string;
  outputDir: string;
  /** Claude Codeへ渡すMCP設定ファイルを置くディレクトリ。 */
  configDir: string;
  /**
   * 呼び出しのたびに確かめる。設定が無効、または信頼済みワークスペースでなければ理由を
   * 返す。設定を無効へ戻す前に開いた会話からも呼べないようにするため。
   */
  checkAvailable: () => string | undefined;
  logWarn: (message: string) => void;
  /** テスト用の差し替え口。 */
  generate?: (request: GenerateImageRequest, signal: AbortSignal) => Promise<GenerateImageResult>;
}

interface HostState {
  readonly deps: ImageGenerationMcpDeps;
  /**
   * このサーバが返した会話URL。続きの生成はここにある会話に限る。ログイン中のアカウントの
   * 他の会話（機密を含みうる）へ、エージェントが任意に書き込めないようにするため。
   */
  readonly conversations: Set<string>;
  /** 生成を1件ずつ順に流す。タブとChatGPTへの送信を並行させない。 */
  queue: Promise<unknown>;
  /** 応答待ちの呼び出し。サーバを閉じるときに中断してタブを閉じる。 */
  readonly inFlight: Set<AbortController>;
}

export interface ImageGenerationMcpHost {
  /** Codexの`thread/start`のMCP設定へ渡すURL。JSON-RPCで渡すためプロセスの引数には載らない。 */
  readonly url: string;
  /**
   * Claude Codeの`--mcp-config`へ渡す設定ファイルのパス。URLを引数へ直接書くと、トークンが
   * プロセスの引数一覧（`ps`）に載るため、権限600のファイルに書いてパスだけを渡す
   * （Issue #1903）。
   */
  readonly claudeConfigPath: string;
  close(): Promise<void>;
}

export async function startImageGenerationMcpHost(
  deps: ImageGenerationMcpDeps,
): Promise<ImageGenerationMcpHost> {
  const token = randomBytes(16).toString('hex');
  const state: HostState = {
    deps,
    conversations: new Set(),
    queue: Promise.resolve(),
    inFlight: new Set(),
  };
  const server: HttpMcpServerHandle = await startHttpMcpServer((candidate) =>
    candidate === token
      ? {
          connectionId: IMAGE_GENERATION_MCP_SERVER_NAME,
          handle: (connection) => handleConnection(state, connection),
        }
      : undefined,
  );
  const url = server.urlForToken(token);
  let claudeConfigPath: string;
  try {
    claudeConfigPath = await writeClaudeConfig(deps.configDir, url);
  } catch (error) {
    await server.close();
    throw error;
  }
  void pruneOldImages(deps.outputDir).catch((error: unknown) => {
    deps.logWarn(
      `[webgpt-image] 古い画像を消せませんでした: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  return {
    url,
    claudeConfigPath,
    close: async () => {
      // 生成中の呼び出しを中断し、タブを閉じ終えてからサーバを閉じる
      for (const controller of state.inFlight) controller.abort();
      await state.queue;
      await Promise.all([server.close(), unlink(claudeConfigPath).catch(() => undefined)]);
    },
  };
}

/** ウィンドウごとに別のファイルにする。globalStorageは全ウィンドウで共有されるため。 */
async function writeClaudeConfig(configDir: string, url: string): Promise<string> {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const path = join(configDir, `webgpt-image-mcp-${randomBytes(8).toString('hex')}.json`);
  const config = {
    mcpServers: {
      [IMAGE_GENERATION_MCP_SERVER_NAME]: {
        type: 'http',
        url,
        // HTTPのMCPは応答の無いまま5分で打ち切られる（CLI 2.1.286の既定）。生成を待てるよう延ばす
        timeout: IMAGE_GENERATION_TOOL_TIMEOUT_SEC * 1000,
      },
    },
  };
  await writeFile(path, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
  return path;
}

function handleConnection(state: HostState, connection: McpConnection): void {
  // 呼び出し元が応答を待たずに切断したら（会話の中断など）、生成を止めてタブを閉じる
  const abort = new AbortController();
  state.inFlight.add(abort);
  connection.onClose(() => abort.abort());
  connection.onRequest((request) => {
    void dispatch(state, request, abort.signal)
      .catch((error: unknown) => {
        state.deps.logWarn(
          `[webgpt-image] 要求の処理で例外: ${error instanceof Error ? error.message : String(error)}`,
        );
        return failure(request.id, -32603, '内部エラーが発生しました');
      })
      .then((response) => connection.send(response))
      .finally(() => state.inFlight.delete(abort));
  });
}

async function dispatch(
  state: HostState,
  request: JsonRpcRequest,
  signal: AbortSignal,
): Promise<JsonRpcResponse> {
  switch (request.method) {
    case 'initialize':
      return success(request.id, SERVER_INFO_RESULT);
    case 'tools/list':
      return success(request.id, { tools: [GENERATE_IMAGE_TOOL] });
    case 'tools/call':
      return handleToolCall(state, request, signal);
    default:
      return failure(request.id, -32601, `未知のメソッドです: ${request.method}`);
  }
}

async function handleToolCall(
  state: HostState,
  request: JsonRpcRequest,
  signal: AbortSignal,
): Promise<JsonRpcResponse> {
  const { deps } = state;
  const params =
    typeof request.params === 'object' && request.params !== null
      ? (request.params as Record<string, unknown>)
      : {};
  if (params['name'] !== GENERATE_IMAGE_TOOL.name) {
    return failure(request.id, -32602, `未知のツールです: ${String(params['name'])}`);
  }
  const unavailable = deps.checkAvailable();
  if (unavailable !== undefined) {
    return success(request.id, toolTextResult(unavailable, true));
  }
  const parsed = parseGenerateImageArgs(params['arguments']);
  if (!parsed.ok) {
    return success(request.id, toolTextResult(parsed.error, true));
  }
  const conversationUrl = parsed.request.conversationUrl;
  if (conversationUrl !== undefined && !state.conversations.has(conversationUrl)) {
    return success(
      request.id,
      toolTextResult(
        'conversationUrlには、このウィンドウでgenerate_imageが返した会話だけを指定できます。新しい会話で生成するときは省略してください',
        true,
      ),
    );
  }
  const generate =
    deps.generate ??
    ((input: GenerateImageRequest, abortSignal: AbortSignal) =>
      generateImage(input, {
        endpoint: deps.readEndpoint(),
        outputDir: deps.outputDir,
        signal: abortSignal,
        logWarn: deps.logWarn,
      }));
  const run = state.queue.then(() => {
    // 順番を待つ間に呼び出し元が離れていたら、送信しない
    if (signal.aborted) {
      return { ok: false, error: '呼び出し元が中断したため生成しませんでした' } as const;
    }
    return generate(parsed.request, signal);
  });
  state.queue = run.catch(() => undefined);
  const result = await run;
  if (!result.ok) {
    // 送信後の失敗（画像なし・質問返しなど）は、同じ会話で続きを頼めるようにする
    if (result.conversationUrl !== undefined) state.conversations.add(result.conversationUrl);
    return success(request.id, toolTextResult(result.error, true));
  }
  state.conversations.add(result.conversationUrl);
  return success(
    request.id,
    toolTextResult(
      JSON.stringify({ images: result.paths, conversationUrl: result.conversationUrl }),
    ),
  );
}
