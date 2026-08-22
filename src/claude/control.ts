import type { ApprovalDecision } from '../appserver/approvals';
import {
  buildContextUsage,
  type ContextUsage,
  type ExtraUsageView,
  type PendingApproval,
  type SessionCostView,
} from '../appserver/chatState';
import { isEffortToken, type EffortInfo, type ModelInfo } from '../codex/modelCatalog';
import { buildClaudeContent, type Attachment } from '../provider/attachments';
import type { McpServerView } from '../provider/mcpServers';
import type { SlashCommand } from '../provider/slashCommands';
import { parseSessionCost } from './costText';
import { describeTool } from './transcript';
import type { ClaudeAgentInfo } from './types';

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
      // Fast mode（Issue #198）。フィールドが無い版では `undefined` のままにして、
      // 「対応しない」と「情報が無い」を区別する
      ...('supportsFastMode' in model
        ? { supportsFastMode: model['supportsFastMode'] === true }
        : {}),
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
 * 使えるカスタムエージェントの一覧を読む。
 *
 * `initialize` の応答の `agents` に入っている（実測。Codexに相当する概念は無い）。
 * `commands` / `models` と同じ経路・同じ形（配列）で届くため、`readCommandList` /
 * `readModelList` と同じ作りにする。組込エージェント（`claude` `Explore` `Plan`
 * `general-purpose` など）とユーザー定義のカスタムエージェントが混ざって返り、
 * 一部のエントリだけ `model` を持つが、`--agent` に渡すのは `name` だけなので使わない。
 *
 * セッション中にエージェントを切り替える専用の制御要求は見つかっていない
 * （`set_agent` 等7種の候補を実測し、いずれも `Unsupported control request subtype` で
 * 拒否されることを確認済み）。そのため一覧は起動時の選択肢としてのみ使う。
 *
 * 一覧そのものが無いときは `undefined` を返す。空配列（1件も無い）と区別しないと、
 * 読めなかっただけで候補を消してしまう。
 */
export function readAgentList(source: unknown): ClaudeAgentInfo[] | undefined {
  const raw = rec(source)?.['agents'];
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const agents: ClaudeAgentInfo[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const agent = rec(entry);
    const name = str(agent?.['name']);
    if (name === '' || seen.has(name)) {
      continue;
    }
    seen.add(name);
    agents.push({ name, description: str(agent?.['description']) });
  }
  return agents;
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
 * 会話の名前を変える（issue #199、design.md §14.35）。
 *
 * **実測で見つけた専用の制御要求**（バイナリのstrings解析で `rename_session` /
 * `rename_generate_name` / `rename_err_code` を発見し、`claude --print --input-format
 * stream-json --output-format stream-json --verbose` を実際に起動して確認。CLI 2.1.227）。
 * `{ subtype: 'rename_session', title }` を送ると `{"subtype":"success"}` が返り、
 * transcript（`~/.claude/projects/**\/*.jsonl`）へ
 * `{"type":"custom-title","customTitle":"<title>","sessionId":"<id>"}` という行が
 * その時点で追記されることを実機で確認した（＝CLI側に永続化される。`set_agent` 等の
 * 「送っても効果を確認できない」経路とは違う）。
 *
 * ただし**この行を読み戻して一覧に使うことはしない**。`custom-title` は要求を送った
 * 時点の会話の位置にそのまま挟まるため、長い会話の途中で改名すると先頭からかなり
 * 離れた行に現れうる。`ClaudeSessionStore.list()` は一覧のために全セッションの
 * transcriptを先頭40行だけ読む設計（`HEAD_LINES`。全文読みは件数分のI/Oが重い）のため、
 * 確実に見つけられる保証が無い。加えてCodexの `thread/name/set` と違って読み出し用の
 * 索引（`thread/list` 相当）も無い。そのため表示用の名前は拡張機能側
 * （`ClaudeSessionStore` の `ClaudeSessionNameStore`）を正とし、この要求は「同じ
 * transcriptを他のツール（TUIなど）で開いたときにも新しい名前が見えるように」という
 * ベストエフォートの副送信として送る（`streamSession.ts` の `setName`）。
 */
export function buildRenameSessionRequest(requestId: string, title: string): string {
  return buildControlRequest(requestId, { subtype: 'rename_session', title });
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

/**
 * `initialize` の応答から、Fast mode（`/fast`）の現在値を読む（Issue #198）。
 *
 * 実測（CLI 2.1.227）の値は `"off"`。応答に含まれない版・そもそも対応しない環境では
 * `undefined` を返し、呼び出し側は「対応しない」として扱う（承認方法と同じ流儀で、
 * 取れなかったことと `off` を区別する）。
 */
export function readFastModeState(payload: unknown): boolean | undefined {
  const state = str(rec(payload)?.['fast_mode_state']);
  if (state === '') {
    return undefined;
  }
  return state === 'on';
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

/**
 * ファイルを指定した発言の直前まで戻す要求。
 *
 * 実測（CLI 2.1.227、バイナリのstrings解析で判明）: パラメータ名は**スネークケース**の
 * `user_message_id`（戻す起点にする発言のuuid）と `dry_run`。`messageId` 等キャメルケースの
 * 名では通らない。会話の巻き戻し（`rewind` subtype）とは別物で、`rewind_files` は
 * **ファイルだけ**を対象にする（`rewind` は `Unsupported control request subtype: rewind` で
 * 拒否されることを実測済み。design.md「Claude Codeの巻き戻し」参照）。
 *
 * 既定では常に失敗する。CLIは非対話（`--print`）環境ではファイルのチェックポイントを
 * 作らないため（実測: `QF()` ゲート関数がinteractive判定を見ている）。
 * `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=1` を環境変数として渡した場合のみ有効になる
 * （`streamSession.ts` の `start()` で設定）。
 */
export function buildRewindFilesRequest(
  requestId: string,
  userMessageId: string,
  dryRun: boolean,
): string {
  return buildControlRequest(requestId, {
    subtype: 'rewind_files',
    user_message_id: userMessageId,
    dry_run: dryRun,
  });
}

/** `rewind_files` の応答を読んだ結果。戻せるかどうかを1つの形にまとめる。 */
export interface RewindFilesResult {
  ok: boolean;
  /** 対象ファイルの一覧（絶対パス）。プレビュー（dry_run）でのみ埋まる。実適用の応答には無い。 */
  filesChanged: string[];
  /** プレビューでのみ入る増減行数。 */
  insertions: number | undefined;
  deletions: number | undefined;
  /** 戻せない理由。チェックポイントが無い・CLIが対応していない等。 */
  error: string | undefined;
}

/**
 * `rewind_files` の応答を読む。
 *
 * 実測した形は3通り:
 * 1. 戻せる場合（プレビュー）: `{canRewind:true, filesChanged:[...], insertions, deletions}`
 * 2. 戻せる場合（実適用）: `{canRewind:true, skippedLinks:0}`（filesChangedを含まない）
 * 3. チェックポイントが無い場合: dry_runなら成功応答に包まれた `canRewind:false`、
 *    dry_run:falseならトップレベルの `subtype:"error"` で返る（実測、CLI 2.1.227）。
 * どの経路でも「戻せたか」を1つの形にまとめ、呼び出し側が分岐を持たなくて済むようにする。
 */
export function readRewindFilesResult(response: ControlResponse): RewindFilesResult {
  if (!response.ok) {
    return {
      ok: false,
      filesChanged: [],
      insertions: undefined,
      deletions: undefined,
      error: response.error ?? '不明なエラー',
    };
  }
  const payload = response.payload;
  if (payload?.['canRewind'] !== true) {
    return {
      ok: false,
      filesChanged: [],
      insertions: undefined,
      deletions: undefined,
      error: strOrUndefined(payload?.['error']) ?? '不明なエラー',
    };
  }
  const raw = payload['filesChanged'];
  const filesChanged = Array.isArray(raw)
    ? raw.filter((p): p is string => typeof p === 'string')
    : [];
  return {
    ok: true,
    filesChanged,
    insertions: num(payload['insertions']),
    deletions: num(payload['deletions']),
    error: undefined,
  };
}

/**
 * 会話を指定した発言の手前まで戻す要求（issue #333、design.md §14.61）。
 *
 * `rewind_files`（ファイルだけを戻す）とは別物で、会話（transcript上のやり取り）だけを
 * 戻す。ファイルには一切触れない（実測、CLI 2.1.235。design.md §14.61参照）。
 *
 * パラメータはスネークケースの `target_message_uuid`（戻す対象の発言。transcript jsonlの
 * `"type":"user"` 行のトップレベル `uuid`。`message.id` ではない）と
 * `interrupt_if_running`（ターン走行中なら中断してから戻す。省略/falseで走行中だと
 * `turn running` エラーになる）。
 *
 * **対象は実質「現在の最後のユーザー発言」しか指定できない**（対象より後ろに人間由来の
 * ユーザー発言が残っていると `stale target` で拒否される）。途中のターンまで戻すには、
 * 対象以降の発言を新しい順に1件ずつ逐次送る必要がある
 * （`streamSession.ts` の `rewindConversationToTurn` 参照）。
 *
 * **`--fork-session` していないセッション（`-r` のみのresume）へ送ると、元セッションの
 * transcriptが壊れる**（実測: `{"type":"last-prompt","rewound":true,...}` が追記され、
 * 次回resume時に会話が切り捨てられる）。呼び出し側でforkしたセッションにだけ限ること。
 */
export function buildRewindConversationRequest(
  requestId: string,
  targetMessageUuid: string,
  interruptIfRunning: boolean,
): string {
  return buildControlRequest(requestId, {
    subtype: 'rewind_conversation',
    target_message_uuid: targetMessageUuid,
    interrupt_if_running: interruptIfRunning,
  });
}

/** `rewind_conversation` の応答を読んだ結果。 */
export interface RewindConversationResult {
  rewound: boolean;
  targetMessageUuid: string | undefined;
  /** 戻した対象の発言本文。成功時のみ入る。入力欄への差し戻しに使う。 */
  prefillText: string | undefined;
  precedingAssistantUuid: string | undefined;
  /** 戻せない理由。`turn running` / `stale target` / `target not found` など。 */
  error: string | undefined;
}

/**
 * `rewind_conversation` の応答を読む。
 *
 * **応答は失敗時も `subtype:"success"` の封筒で返る**（実測、CLI 2.1.235）。
 * `readRewindFilesResult` のように `response.ok` で早期に成否を決めてはいけない
 * （`ok` は封筒レベルの成否でしかなく、rewind自体が成功したかは別）。判定は必ず
 * `payload.rewound` で行う。
 *
 * control protocol自体が失敗した場合（`response.ok` が false。応答が壊れている等）だけは
 * rewind要求そのものが届いていないとみなし、`rewound:false` として扱う。
 */
export function readRewindConversationResult(response: ControlResponse): RewindConversationResult {
  if (!response.ok) {
    return {
      rewound: false,
      targetMessageUuid: undefined,
      prefillText: undefined,
      precedingAssistantUuid: undefined,
      error: response.error ?? '不明なエラー',
    };
  }
  const payload = response.payload;
  return {
    rewound: payload?.['rewound'] === true,
    targetMessageUuid: strOrUndefined(payload?.['targetMessageUuid']),
    prefillText: strOrUndefined(payload?.['prefillText']),
    precedingAssistantUuid: strOrUndefined(payload?.['precedingAssistantUuid']),
    error: strOrUndefined(payload?.['error']),
  };
}

/**
 * 過去に送った脇道の質問1件（issue #334、design.md §14.62）。
 *
 * `side_question` の `history` に載せる。スネークケースの `fallback_notice`（実測）。
 */
export interface SideQuestionHistoryEntry {
  question: string;
  response: string;
  /** 別モデルへ切り替わった旨の注記。無ければ省略する。 */
  fallbackNotice: string | undefined;
}

/**
 * 脇道の質問を送る要求（issue #334、design.md §14.62、Codexの `/btw` 相当）。
 *
 * 実測（`/tmp`の実測記録、CLI 2.1.235）: `{subtype:"side_question", question, history?}`。
 * `history` は任意で、省略すると質問単体として扱われる（過去のやり取りを踏まえない）。
 * Codexの `thread/fork`（`ephemeral: true`）と違い、**新しいスレッド/セッションを
 * 作らない**。現在つながっている1本のCLIプロセスへ直接 `control_request` を送るだけで、
 * 応答も1往復で返る。
 *
 * **走行中のターンがあっても送れる**（実測: 長いターンを走らせたまま送り、ターンの
 * 完了より先に応答が返ることを確認済み。design.md §14.62参照）。`rewind_conversation`の
 * ような走行チェックは無い。
 *
 * **本流のtranscriptに一切痕跡が残らない**（実測: `side_question`だけを送ったセッションは
 * transcriptファイル自体が作られない。実会話がある場合でも質問・応答の文字列は
 * transcript中に一切現れない。design.md §14.62参照）。この要求はコード上の根拠
 * （`skipTranscript:true`等）だけでなく実測でも裏付けが取れている、数少ない経路。
 */
export function buildSideQuestionRequest(
  requestId: string,
  question: string,
  history: readonly SideQuestionHistoryEntry[] = [],
): string {
  return buildControlRequest(requestId, {
    subtype: 'side_question',
    question,
    ...(history.length > 0
      ? {
          history: history.map((entry) => ({
            question: entry.question,
            response: entry.response,
            ...(entry.fallbackNotice !== undefined
              ? { fallback_notice: entry.fallbackNotice }
              : {}),
          })),
        }
      : {}),
  });
}

/** モデルが拒否し、別モデルへ自動的に切り替わった旨の記録。 */
export interface SideQuestionRefusalFallback {
  originalModel: string;
  fallbackModel: string;
  /** 切替後のモデルが実際に返した本文。`response` と同じ値のことが多い。 */
  content: string;
}

/** `side_question` の応答を読んだ結果。 */
export interface SideQuestionResult {
  ok: boolean;
  response: string | undefined;
  /** 実際にモデルへ問い合わせず合成された応答か（実測で存在を確認したフィールド。意味は未確認）。 */
  synthetic: boolean | undefined;
  /** 元のモデルが拒否し、別モデルへ切り替わって答えたときだけ入る。 */
  refusalFallback: SideQuestionRefusalFallback | undefined;
  error: string | undefined;
}

/**
 * `side_question` の応答を読む。
 *
 * 実測した成功時の形: `{response:"...", synthetic:false}`。任意で
 * `refusal_fallback:{original_model, fallback_model, content}` が付く。
 *
 * `rewind_conversation` と違い、**失敗が `subtype:"success"` の封筒に包まれて返る事例は
 * 実測できていない**（測ったのは成功応答1件のみ。design.md §14.62「未確認」参照）。
 * そのため成否は素直に `response.ok`（封筒レベル。`subtype:"error"` かどうか）で判定し、
 * 成功の封筒なのに `response` 本文が読み取れない（空文字・欠落）場合だけ、想定外の形として
 * 追加で失敗扱いにする（CLIが将来この応答の中身だけ形を変えても、黙って空応答を成功と
 * 誤判定しないための安全側）。
 */
export function readSideQuestionResult(response: ControlResponse): SideQuestionResult {
  if (!response.ok) {
    return {
      ok: false,
      response: undefined,
      synthetic: undefined,
      refusalFallback: undefined,
      error: response.error ?? '不明なエラー',
    };
  }
  const payload = response.payload;
  const text = strOrUndefined(payload?.['response']);
  if (text === undefined) {
    return {
      ok: false,
      response: undefined,
      synthetic: undefined,
      refusalFallback: undefined,
      error: '応答を読み取れませんでした',
    };
  }
  const syntheticRaw = payload?.['synthetic'];
  const synthetic =
    syntheticRaw === true ? true : syntheticRaw === false ? false : undefined;
  const fallback = rec(payload?.['refusal_fallback']);
  const refusalFallback =
    fallback === undefined
      ? undefined
      : {
          originalModel: str(fallback['original_model']),
          fallbackModel: str(fallback['fallback_model']),
          content: str(fallback['content']),
        };
  return { ok: true, response: text, synthetic, refusalFallback, error: undefined };
}

/**
 * 脇道の質問の処理経過（`control_request_progress`。issue #334、design.md §14.62）。
 *
 * 実測: `{type:"system", subtype:"control_request_progress", request_id, status}`。
 * `status` は `started` と `api_retry`（`attempt`/`max_retries`/`retry_delay_ms`/
 * `error_status` を伴う）を確認済み。この通知は `side_question` 専用（実測メモより）。
 * `control_response` とは別経路（`type:"system"`）で届くため、`readControlResponse` では
 * 拾えない。未知の `status` 値もそのまま文字列で通す（呼び出し側が丸める）。
 */
export interface ControlRequestProgress {
  requestId: string;
  status: string;
  attempt: number | undefined;
  maxRetries: number | undefined;
  retryDelayMs: number | undefined;
  errorStatus: string | undefined;
}

export function readControlRequestProgress(
  event: Record<string, unknown>,
): ControlRequestProgress | undefined {
  if (str(event['type']) !== 'system' || str(event['subtype']) !== 'control_request_progress') {
    return undefined;
  }
  const requestId = str(event['request_id']);
  if (requestId === '') {
    return undefined;
  }
  return {
    requestId,
    status: str(event['status']),
    attempt: num(event['attempt']),
    maxRetries: num(event['max_retries']),
    retryDelayMs: num(event['retry_delay_ms']),
    errorStatus: strOrUndefined(event['error_status']),
  };
}

/**
 * セッションのコストを問い合わせる要求（issue #37、design.md TP-60）。
 *
 * `get_session_cost`（整形済みの英文テキストのみ）より `get_usage` のほうが情報量が多く
 * （`session.total_cost_usd` 等を構造化して返す。実測、CLI 2.1.227）、両方を送る必要が無い。
 * 会話へ `/cost` を送ると応答が会話に混ざるため、`get_context_usage` と同じく
 * control protocolで聞く。
 */
export function buildSessionCostRequest(requestId: string): string {
  return buildControlRequest(requestId, { subtype: 'get_usage' });
}

/** `get_usage` の応答からセッションのコストを読む。中身の詳細は `costText.ts` を参照。 */
export function readSessionCost(payload: unknown, capturedAt: number): SessionCostView | undefined {
  return parseSessionCost(payload, capturedAt);
}

/**
 * `get_usage` の応答から追加クレジット（usage credits）の状態を読む
 * （issue #204、design.md §14.38）。
 *
 * `readSessionCost` と同じ応答（`buildSessionCostRequest`で送る）を読む。実測
 * （CLI 2.1.227）した形: `rate_limits.extra_usage` に
 * `{is_enabled, monthly_limit, used_credits, utilization, currency, decimal_places,
 *   disabled_reason, user_disabled, spend_limit_reached, credits_ever_enabled,
 *   daily, weekly}`。`daily`/`weekly`と`user_disabled`/`credits_ever_enabled`は
 * この機能の対象外（基本のレート制限は既存の`ChatUsage`が別経路(`rate_limit_event`)で
 * 持つ。混同を避けるため読まない。導線の出し分けは`is_enabled`/`spend_limit_reached`/
 * `disabled_reason`だけで足りるため増やさない）。
 *
 * `monthly_limit`/`used_credits`は`decimal_places`（実測では常に2）で割った実額に
 * 変換する。桁数が読めない場合はどちらの値も信用できないため`monthlyLimit`は
 * `undefined`（作った数字を出さない）、`usedCredits`は他の数値項目
 * （`parseSessionCost`の`totalLinesAdded`等）と同じく0扱いにする。
 *
 * `rate_limits.extra_usage`自体が無い（組織が対応しない・古いCLI）場合は`undefined`を
 * 返し、画面は追加クレジットの表示・導線ごと出さない。
 */
export function readExtraUsage(payload: unknown): ExtraUsageView | undefined {
  const e = rec(rec(rec(payload)?.['rate_limits'])?.['extra_usage']);
  const isEnabled = e?.['is_enabled'];
  if (e === undefined || typeof isEnabled !== 'boolean') {
    return undefined;
  }

  const decimalPlaces = num(e['decimal_places']);
  const scale =
    decimalPlaces !== undefined && Number.isInteger(decimalPlaces) && decimalPlaces >= 0
      ? 10 ** decimalPlaces
      : undefined;
  const toAmount = (raw: unknown): number | undefined => {
    const value = num(raw);
    return value === undefined || scale === undefined ? undefined : value / scale;
  };

  return {
    isEnabled,
    monthlyLimit: toAmount(e['monthly_limit']),
    usedCredits: toAmount(e['used_credits']) ?? 0,
    utilization: num(e['utilization']),
    currency: strOrUndefined(e['currency']),
    disabledReason: strOrUndefined(e['disabled_reason']),
    spendLimitReached: e['spend_limit_reached'] === true,
  };
}

/**
 * バックグラウンドで走っているタスクを停止する要求（issue #33、design.md §14.23）。
 *
 * 実測（本issueの調査。実際に `sleep` をバックグラウンドで開始させ、開始直後に
 * この要求を送って止まることを確認した）: パラメータ名は**スネークケース**の `task_id`
 * （`background_tasks_changed` 通知が返す `task_id` をそのまま渡す）。応答は常に空 `{}`
 * で成否の情報を持たないため、`interrupt` と同じく発行するだけにし、実際に止まったかは
 * 後続の `background_tasks_changed` 通知（一覧から消える）で判断する。
 */
export function buildStopTaskRequest(requestId: string, taskId: string): string {
  return buildControlRequest(requestId, { subtype: 'stop_task', task_id: taskId });
}

/** MCPサーバーの一覧・状態を問い合わせる要求（issue #27、design.md TP-50）。 */
export function buildMcpStatusRequest(requestId: string): string {
  return buildControlRequest(requestId, { subtype: 'mcp_status' });
}

/**
 * 有効な設定一式を問い合わせる要求（issue #28、design.md TP-52）。
 *
 * hooksの一覧に相当する専用の要求はプロトコルに無い（`hooks_list` 等6候補を実測で
 * 総当たりし、いずれも `Unsupported control request subtype` だった）。`get_settings` の
 * 応答の `effective.hooks` がその代わりになる（実測。CLI 2.1.227）。詳細は
 * `src/claude/hooksSettings.ts` を参照。
 */
export function buildGetSettingsRequest(requestId: string): string {
  return buildControlRequest(requestId, { subtype: 'get_settings' });
}

/**
 * skillsの一覧を問い合わせる要求（issue #35、design.md TP-56）。
 *
 * 専用の一覧取得要求はプロトコルに無い（`skills_list` `list_skills` `get_skills`
 * `skill_list` `skills` の5候補を実測で総当たりし、いずれも`Unsupported control request
 * subtype`だった）。`reload_skills`の応答がその代わりになる（実測。CLI 2.1.227）。
 * 詳細は `src/claude/skillsList.ts` を参照。
 */
export function buildReloadSkillsRequest(requestId: string): string {
  return buildControlRequest(requestId, { subtype: 'reload_skills' });
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
      servers.push({
        name,
        state: 'disabled',
        toolCount: 0,
        version: undefined,
        reason: undefined,
      });
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
