import { randomBytes } from 'node:crypto';

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
          '既存の会話で生成するときの会話URL（https://chatgpt.com/c/<id>）。省略すると新しい会話を作る',
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
  /** 信頼済みワークスペースでなければ理由を返す。 */
  checkTrusted: () => string | undefined;
  logWarn: (message: string) => void;
  /** テスト用の差し替え口。 */
  generate?: (request: GenerateImageRequest) => Promise<GenerateImageResult>;
}

export interface ImageGenerationMcpHost {
  /** 会話のMCP設定へ渡すURL。 */
  readonly url: string;
  close(): Promise<void>;
}

export async function startImageGenerationMcpHost(
  deps: ImageGenerationMcpDeps,
): Promise<ImageGenerationMcpHost> {
  const token = randomBytes(16).toString('hex');
  const server: HttpMcpServerHandle = await startHttpMcpServer((candidate) =>
    candidate === token
      ? {
          connectionId: IMAGE_GENERATION_MCP_SERVER_NAME,
          handle: (connection) => handleConnection(deps, connection),
        }
      : undefined,
  );
  return {
    url: server.urlForToken(token),
    close: () => server.close(),
  };
}

function handleConnection(deps: ImageGenerationMcpDeps, connection: McpConnection): void {
  connection.onRequest((request) => {
    void dispatch(deps, request)
      .catch((error: unknown) => {
        deps.logWarn(
          `[webgpt-image] 要求の処理で例外: ${error instanceof Error ? error.message : String(error)}`,
        );
        return failure(request.id, -32603, '内部エラーが発生しました');
      })
      .then((response) => connection.send(response));
  });
}

async function dispatch(
  deps: ImageGenerationMcpDeps,
  request: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  switch (request.method) {
    case 'initialize':
      return success(request.id, SERVER_INFO_RESULT);
    case 'tools/list':
      return success(request.id, { tools: [GENERATE_IMAGE_TOOL] });
    case 'tools/call':
      return handleToolCall(deps, request);
    default:
      return failure(request.id, -32601, `未知のメソッドです: ${request.method}`);
  }
}

async function handleToolCall(
  deps: ImageGenerationMcpDeps,
  request: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const params =
    typeof request.params === 'object' && request.params !== null
      ? (request.params as Record<string, unknown>)
      : {};
  if (params['name'] !== GENERATE_IMAGE_TOOL.name) {
    return failure(request.id, -32602, `未知のツールです: ${String(params['name'])}`);
  }
  const untrusted = deps.checkTrusted();
  if (untrusted !== undefined) {
    return success(request.id, toolTextResult(untrusted, true));
  }
  const parsed = parseGenerateImageArgs(params['arguments']);
  if (!parsed.ok) {
    return success(request.id, toolTextResult(parsed.error, true));
  }
  const generate =
    deps.generate ??
    ((input: GenerateImageRequest) =>
      generateImage(input, { endpoint: deps.readEndpoint(), outputDir: deps.outputDir }));
  const result = await generate(parsed.request);
  if (!result.ok) {
    return success(request.id, toolTextResult(result.error, true));
  }
  return success(
    request.id,
    toolTextResult(
      JSON.stringify({ images: result.paths, conversationUrl: result.conversationUrl }),
    ),
  );
}
