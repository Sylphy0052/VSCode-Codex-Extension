import type { ApprovalDecision } from '../appserver/approvals';
import { buildContextUsage, type ContextUsage, type PendingApproval } from '../appserver/chatState';
import { isEffortToken, type EffortInfo, type ModelInfo } from '../codex/modelCatalog';
import { buildClaudeContent, type Attachment } from '../provider/attachments';
import type { McpServerView } from '../provider/mcpServers';
import type { SlashCommand } from '../provider/slashCommands';
import { describeTool } from './transcript';

/**
 * `claude` の stream-json 入出力に流す制御メッセージ。
 *
 * この制御プロトコルは公式ドキュメントに無く、SDKが使っている形に合わせている。
 * CLIの更新で形が変わりうるため、**扱えなければ静かに劣化する**（承認カードが
 * 出ないだけで会話は続く）ことを前提に組み立てる。
 */

export interface IncomingControlRequest {
  requestId: string;
  subtype: string;
  payload: Record<string, unknown>;
}

export interface ControlResponse {
  requestId: string;
  ok: boolean;
  error: string | undefined;
  /** 応答の中身。要求の種類ごとに形が違うため、読み取りは呼び出し側が担う。 */
  payload: Record<string, unknown> | undefined;
}

/**
 * stdinへ書く発言。1行で書き切る。
 *
 * 画像はbase64の `image` ブロックとして本文の前に置く（実測で受理を確認）。
 */
export function buildUserMessage(text: string, attachments: readonly Attachment[] = []): string {
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: buildClaudeContent(text, attachments) },
  })}\n`;
}

export function buildControlRequest(requestId: string, request: Record<string, unknown>): string {
  return `${JSON.stringify({ type: 'control_request', request_id: requestId, request })}\n`;
}

/** CLIからの要求への応答。返さないとCLIは待ち続ける。 */
export function buildControlResponse(requestId: string, response: unknown): string {
  return `${JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response },
  })}\n`;
}

export function readControlRequest(
  event: Record<string, unknown>,
): IncomingControlRequest | undefined {
  if (str(event['type']) !== 'control_request') {
    return undefined;
  }
  const requestId = str(event['request_id']);
  const payload = rec(event['request']);
  if (requestId === '' || payload === undefined) {
    return undefined;
  }
  return { requestId, subtype: str(payload['subtype']), payload };
}

export function readControlResponse(event: Record<string, unknown>): ControlResponse | undefined {
  if (str(event['type']) !== 'control_response') {
    return undefined;
  }
  const response = rec(event['response']);
  const requestId = str(response?.['request_id']);
  if (response === undefined || requestId === '') {
    return undefined;
  }
  const ok = str(response['subtype']) !== 'error';
  return {
    requestId,
    ok,
    error: ok ? undefined : str(response['error']) || '不明なエラー',
    payload: rec(response['response']),
  };
}

/**
 * 使えるスラッシュコマンドの一覧を読む。
 *
 * `initialize` の応答と `commands_changed` 通知の両方が同じ形（`commands` 配列）で
 * 持っている。組込・ユーザー定義・プラグイン由来が混ざり、同じ名前が重複することも
 * あるため、先に見つけたものを残す。
 *
 * 一覧そのものが無いときは `undefined` を返す。空配列（コマンドが1件も無い）と
 * 区別しないと、読めなかっただけで候補を消してしまう。
 */
export function readCommandList(source: unknown): SlashCommand[] | undefined {
  const raw = rec(source)?.['commands'];
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const commands: SlashCommand[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const command = rec(entry);
    const name = str(command?.['name']);
    if (name === '' || seen.has(name)) {
      continue;
    }
    seen.add(name);
    commands.push({
      name,
      description: str(command?.['description']),
      argumentHint: str(command?.['argumentHint']),
    });
  }
  return commands;
}

/**
 * 使えるモデルの一覧を読む。
 *
 * `initialize` の応答の `models` に入っている。Codexの `model/list` に相当するものが
 * stream-json には無く、これが唯一の取得手段。
 *
 * 実測の1件（CLI 2.1.227）:
 * `{value, resolvedModel, displayName, description, supportsEffort, supportedEffortLevels}`。
 * `--model` へ渡すのは `value`。haiku のように `supportsEffort` を持たないモデルがあり、
 * その場合はeffortの選択肢を出さない。
 *
 * 一覧そのものが無いときは `undefined` を返す（コマンド一覧と同じ理由で空配列と区別する）。
 */
export function readModelList(source: unknown): ModelInfo[] | undefined {
  const raw = rec(source)?.['models'];
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const models: ModelInfo[] = [];
  for (const entry of raw) {
    const model = rec(entry);
    const slug = str(model?.['value']);
    if (model === undefined || slug === '') {
      continue;
    }
    const displayName = str(model['displayName']);
    const description = str(model['description']);
    const supportsEffort = model['supportsEffort'] === true;

    models.push({
      slug,
      displayName: displayName === '' ? slug : displayName,
      description: description === '' ? undefined : description,
      // Claude Codeは既定のeffortを返さない（CLI側の設定に委ねる）
      defaultEffort: undefined,
      supportsEffort,
      efforts: supportsEffort ? readEffortLevels(model['supportedEffortLevels']) : [],
    });
  }
  return models;
}

/** `supportedEffortLevels` は説明の無い文字列配列。引数に渡せない形は捨てる。 */
function readEffortLevels(raw: unknown): EffortInfo[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const efforts: EffortInfo[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string' && isEffortToken(entry)) {
      efforts.push({ effort: entry, description: undefined });
    }
  }
  return efforts;
}

/**
 * セッションの途中でコマンドが増減したときの通知。
 *
 * CLIは差分ではなく一覧をそのまま押し付けてくるので、受け取った側は入れ替える。
 */
export function readCommandsChanged(event: Record<string, unknown>): SlashCommand[] | undefined {
  if (str(event['type']) !== 'system' || str(event['subtype']) !== 'commands_changed') {
    return undefined;
  }
  return readCommandList(event);
}

/**
 * 会話中にモデルを変える。
 *
 * 実測: 成功すると `<local-command-stdout>Set model to sonnet (claude-sonnet-5)</local-command-stdout>`
 * が user イベントで届く。次の発言から新しいモデルになる。
 */
export function buildSetModelRequest(requestId: string, model: string): string {
  return buildControlRequest(requestId, { subtype: 'set_model', model });
}

/**
 * 会話中に承認方法を変える。
 *
 * 実測: 応答は `{ mode }`。加えて `system` の `status` 通知でも `permissionMode` が届く。
 * **表示はその通知を正とする**（要求の成功だけを信じない）。
 */
export function buildSetPermissionModeRequest(requestId: string, mode: string): string {
  return buildControlRequest(requestId, { subtype: 'set_permission_mode', mode });
}

/**
 * 会話中にeffortを変える。
 *
 * **専用の制御要求は無い**（`set_effort` / `set_thinking_effort` / `set_reasoning_effort` は
 * どれも `Unsupported control request subtype` になる。実測）。セッション単位の設定を
 * 差し込む `apply_flag_settings` に `effortLevel` を載せるのが唯一の手段。
 *
 * ただし**効いたことを観測できない**。`effortLevel` に出鱈目な値を入れても success が返り、
 * 確認の通知も来ない（実測）。画面には「送った」までしか出さないこと。
 */
export function buildSetEffortRequest(requestId: string, effort: string): string {
  return buildControlRequest(requestId, {
    subtype: 'apply_flag_settings',
    settings: { effortLevel: effort },
  });
}

/**
 * `initialize` の応答から、いま効いている承認方法を読む。
 *
 * 起動引数で `--permission-mode plan` を渡した場合、`status` 通知は何かが変わるまで
 * 来ない。開いた時点のPlan modeを取り違えないよう、ここで拾う。
 */
export function readCurrentPermissionMode(payload: unknown): string | undefined {
  const mode = str(rec(payload)?.['current_permission_mode']);
  return mode === '' ? undefined : mode;
}

/** コンテキスト使用量を問い合わせる要求。TUIの `/context` と同じ数字が返る。 */
export function buildContextUsageRequest(requestId: string): string {
  return buildControlRequest(requestId, { subtype: 'get_context_usage' });
}

/**
 * `get_context_usage` の応答を読む。
 *
 * 実測した中身は `{categories, totalTokens, maxTokens, percentage, ...}`。
 * 内訳（categories）は使わず、合計と上限だけを取る。
 */
export function readContextUsage(payload: unknown): ContextUsage | undefined {
  const body = rec(payload);
  const usedTokens = num(body?.['totalTokens']);
  if (usedTokens === undefined) {
    return undefined;
  }
  return buildContextUsage(usedTokens, num(body?.['maxTokens']));
}

/** MCPサーバーの一覧・状態を問い合わせる要求（issue #27、design.md TP-50）。 */
export function buildMcpStatusRequest(requestId: string): string {
  return buildControlRequest(requestId, { subtype: 'mcp_status' });
}

/**
 * MCPサーバーの有効/無効を切り替える要求。
 *
 * 実測（CLI 2.1.227）: パラメータ名は **`serverName`**（camelCase）。`server_name` /
 * `name` はどちらも `Server not found: undefined` になる（Phase 0の追試項目への回答）。
 * 存在しないサーバー名を指定すると `Server not found: <name>` エラーが返る。
 * プロセスを終了しても設定は残る（`.claude.json` に永続化される。実測で確認）ため、
 * 会話を開いていない設定パネルからの単発呼び出しでも切り替えられる。
 */
export function buildMcpToggleRequest(
  requestId: string,
  serverName: string,
  enabled: boolean,
): string {
  return buildControlRequest(requestId, { subtype: 'mcp_toggle', serverName, enabled });
}

/**
 * `mcp_status` の応答からMCPサーバー一覧を読む。
 *
 * 実測（CLI 2.1.227）した形:
 * `{ mcpServers: [{ name, status: 'connected'|'failed'|'disabled', serverInfo？,
 * config, scope, tools？: [{name, annotations}], error？ }] }`。
 * Codexの `mcpServerStatus/list` と違い、**失敗理由（`error`）がこの応答だけで取れる**
 * （スレッドの開始も、別途の通知購読も要らない）。
 *
 * 一覧そのものが無いときは `undefined` を返す（他の読み取り関数と同じ理由）。
 */
export function readMcpServersList(payload: unknown): McpServerView[] | undefined {
  const raw = rec(payload)?.['mcpServers'];
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const servers: McpServerView[] = [];
  for (const entry of raw) {
    const e = rec(entry);
    const name = str(e?.['name']);
    if (name === '') {
      continue;
    }
    const status = str(e?.['status']);

    if (status === 'disabled') {
      servers.push({ name, state: 'disabled', toolCount: 0, version: undefined, reason: undefined });
      continue;
    }
    if (status === 'connected') {
      const tools = e?.['tools'];
      const serverInfo = rec(e?.['serverInfo']);
      servers.push({
        name,
        state: 'connected',
        toolCount: Array.isArray(tools) ? tools.length : 0,
        version: serverInfo === undefined ? undefined : strOrUndefined(serverInfo['version']),
        reason: undefined,
      });
      continue;
    }
    // 'failed' に限らず未知の状態も「使えない」側へ倒す。理由が取れていれば添える
    servers.push({
      name,
      state: 'unavailable',
      toolCount: 0,
      version: undefined,
      reason: strOrUndefined(e?.['error']),
    });
  }
  return servers;
}

/** `can_use_tool` 要求を承認カードにする。 */
export function describeCanUseTool(
  requestId: string,
  request: Record<string, unknown>,
): PendingApproval | undefined {
  const name = str(request['tool_name']);
  if (name === '') {
    return undefined;
  }
  const input = rec(request['input']) ?? {};
  const tool = describeTool(name, input);

  if (tool.kind === 'commandExecution') {
    return {
      requestId,
      kind: 'command',
      title: 'コマンドの実行を許可しますか',
      detail: tool.detail,
      itemId: undefined,
    };
  }
  if (tool.kind === 'fileChange') {
    return {
      requestId,
      kind: 'fileChange',
      title: 'ファイルの変更を許可しますか',
      detail: tool.detail,
      itemId: undefined,
    };
  }
  return {
    requestId,
    kind: 'permissions',
    title: `${name} の実行を許可しますか`,
    detail: tool.detail === name ? summarizeInput(input) : tool.detail,
    itemId: undefined,
  };
}

/**
 * 承認の決定を応答の形にする。
 * CLI側に「この会話では常に許可」の区別が無いため、許可として返す。
 */
export function buildCanUseToolResponse(
  decision: ApprovalDecision,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (decision === 'accept' || decision === 'acceptForSession') {
    return { behavior: 'allow', updatedInput: input };
  }
  return { behavior: 'deny', message: 'ユーザーが拒否しました' };
}

/**
 * ユーザーに聞けない要求への既定応答。
 *
 * 内容を読み取れない要求を許可してしまうと、目に触れないまま実行される。必ず拒否側に倒す。
 */
export function defaultDenyControlResponse(): Record<string, unknown> {
  return { behavior: 'deny', message: '内容を読み取れないため拒否しました' };
}

function summarizeInput(input: Record<string, unknown>): string {
  const text = JSON.stringify(input);
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const strOrUndefined = (value: unknown): string | undefined => {
  const s = str(value);
  return s === '' ? undefined : s;
};
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const rec = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
