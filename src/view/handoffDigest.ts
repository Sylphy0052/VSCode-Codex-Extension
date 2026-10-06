/**
 * transcript（jsonl）から会話の要点を機械的に抜き出す（Issue #1749）。
 *
 * 引き継ぎ本文へ入れる5項目（最後の圧縮要約・ユーザー発話・失敗したツール呼び出し・
 * 終わっていないbackgroundジョブ・編集したファイル）を、モデルを呼ばずに集める。
 * 会話の先頭から全件は見ず、最後の圧縮より後だけを対象にする。圧縮の行に来たら
 * それまでに集めたものを捨てて数え直す。
 *
 * 形式はローカルの実ファイルで確かめたもの:
 *
 * - Claude Code: 圧縮要約は `isCompactSummary` の付いた `type=="user"` の行。ツールの失敗は
 *   `tool_result` の `is_error`。backgroundジョブは `run_in_background` 付きの `tool_use`、
 *   `toolUseResult.backgroundTaskId`（時間切れでbackgroundへ回ったBash）、
 *   `toolUseResult.status=="async_launched"`（既定でbackgroundに回るAgent）の3通りで始まり、
 *   `<task-notification>` の `<tool-use-id>` で終わる。ターン中に届いた完了通知とユーザー発話は
 *   `type=="user"` の行にならず、`queued_command` のattachmentにだけ残る
 * - Codex: 圧縮は `type=="compacted"` の行。要約は `replacement_history` の `compaction` 項目に
 *   `encrypted_content` として入っていて読めず、`payload.message` は実測で常に空だった。
 *   コマンドの成否・編集したファイルは `event_msg` の `item_completed`（`CommandExecution` /
 *   `FileChange`）から取る。backgroundジョブは、ツール出力に `"session_id":N` が出て、まだ
 *   `process_id` が同じ `CommandExecution` の完了が来ていないもの
 *
 * 読めない形式（期待した形の行が1つも無い、読み込みに失敗した）のときは `undefined` を返し、
 * 呼び出し側は従来のポインタ形式に戻す。
 */
import { createReadStream } from 'node:fs';
import * as readline from 'node:readline';
import type { HandoffProvider } from './handoff';

/** 失敗したツール呼び出し1件。 */
export interface HandoffFailedTool {
  /** `Bash: npm test` の形。 */
  tool: string;
  /** エラー原文。上限を超えた分は先頭と末尾を残して切り詰め済み。 */
  error: string;
}

/** transcriptから抜き出した会話の要点。 */
export interface HandoffDigest {
  /** 最後の圧縮要約。圧縮が走っていない・読めないときは `undefined`。 */
  compactSummary: string | undefined;
  /** 圧縮は走ったが要約が読めない形で残っている（Codexの `encrypted_content`）。 */
  compactSummaryUnreadable: boolean;
  /** 最後の圧縮より後のユーザー発話（会話順、末尾から `MAX_USER_MESSAGES` 件）。 */
  userMessages: string[];
  /** 最後の圧縮より後に失敗したツール呼び出し（会話順、末尾から `MAX_FAILED_TOOLS` 件）。 */
  failedTools: HandoffFailedTool[];
  /** 開始したが終わった記録が無いbackgroundジョブ。 */
  runningJobs: string[];
  /** 最後の圧縮より後に編集したファイル。 */
  editedFiles: string[];
}

const MAX_USER_MESSAGES = 10;
const USER_MESSAGE_LIMIT = 1000;
const MAX_FAILED_TOOLS = 10;
const ERROR_LIMIT = 1500;
const COMPACT_SUMMARY_LIMIT = 12000;
const TOOL_LABEL_LIMIT = 200;
const MAX_RUNNING_JOBS = 20;
const MAX_EDITED_FILES = 100;
const FILE_PATH_LIMIT = 500;

/**
 * 本文へ入れる要点の節の上限（文字数）。
 *
 * 超えた分は節の末尾で切り、残りは抽出コマンドでtranscriptから読ませる。
 */
export const HANDOFF_DIGEST_LIMIT = 30000;

/** 1行を取り込み、最後に要点を返す。 */
export interface HandoffDigestBuilder {
  push(line: string): void;
  /** 期待した形の行が1つも無かったときは `undefined`。 */
  result(): HandoffDigest | undefined;
}

export type JsonObject = Record<string, unknown>;

export function parseLine(line: string): JsonObject | undefined {
  if (line.trim() === '') {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(line);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** `slice` は親文字列を掴んだままにするので、長い出力の全体がメモリに残らないようコピーする。 */
export function detach(text: string): string {
  return Buffer.from(text, 'utf8').toString('utf8');
}

/** 上限を超えたら先頭と末尾を残し、間に省略した字数を書く。 */
export function clipMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const half = Math.floor(maxChars / 2);
  const omitted = text.length - half * 2;
  return detach(
    `${text.slice(0, half)}\n…（${omitted}文字省略）…\n${text.slice(text.length - half)}`,
  );
}

function clipLine(text: string, maxChars: number): string {
  const folded = text.replace(/\s+/gu, ' ').trim();
  return folded.length > maxChars ? detach(`${folded.slice(0, maxChars)}…`) : folded;
}

/** 末尾の `limit` 件だけを残して積む。 */
function pushBounded<T>(list: T[], value: T, limit: number): void {
  list.push(value);
  if (list.length > limit) {
    list.shift();
  }
}

/** `text` 要素の本文をつなぐ。文字列ならそのまま返す。 */
export function textOf(content: unknown, keys: readonly string[] = ['text']): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: string[] = [];
  for (const part of content) {
    if (!isObject(part)) {
      continue;
    }
    for (const key of keys) {
      const value = str(part[key]);
      if (value !== undefined) {
        parts.push(value);
        break;
      }
    }
  }
  return parts.join('');
}

/** 集計の途中状態。圧縮の行で丸ごと作り直す。 */
interface DigestState {
  compactSummary: string | undefined;
  compactSummaryUnreadable: boolean;
  userMessages: string[];
  failedTools: HandoffFailedTool[];
  /** ジョブのID → 表示名。挿入順を保つ。 */
  runningJobs: Map<string, string>;
  editedFiles: Set<string>;
}

function emptyState(): DigestState {
  return {
    compactSummary: undefined,
    compactSummaryUnreadable: false,
    userMessages: [],
    failedTools: [],
    runningJobs: new Map(),
    editedFiles: new Set(),
  };
}

function toDigest(state: DigestState): HandoffDigest {
  return {
    compactSummary: state.compactSummary,
    compactSummaryUnreadable: state.compactSummaryUnreadable,
    userMessages: [...state.userMessages],
    failedTools: [...state.failedTools],
    runningJobs: [...state.runningJobs.values()].slice(-MAX_RUNNING_JOBS),
    editedFiles: [...state.editedFiles].slice(-MAX_EDITED_FILES),
  };
}

/**
 * オーケストレータが発話の前へ付ける進行通知（`composeOrchestratorPrompt`）。注意書き →
 * `<task-run-event>` / `<workflow-event>` の並び → 人の発話、の順に入る。囲いの本文の `<` `>` は
 * 実体参照になっているので、最後の閉じタグより後ろが人の発話になる。
 */
const ORCHESTRATOR_EVENT_HEAD = /^次の <(task-run-event|workflow-event)> は/u;
const ORCHESTRATOR_EVENT_CLOSE = /<\/(?:task-run-event|workflow-event)>/gu;

/** Orchestratorを開いた直後に送る役割の説明（`buildIntroPrompt`）。人の発話を含まない。 */
const ORCHESTRATOR_INTRO_HEAD = /^あなたはオーケストレータモードの実行（run: /u;

export function stripOrchestratorEvents(text: string): string {
  if (ORCHESTRATOR_INTRO_HEAD.test(text)) {
    return '';
  }
  if (!ORCHESTRATOR_EVENT_HEAD.test(text)) {
    return text;
  }
  let end = -1;
  for (const match of text.matchAll(ORCHESTRATOR_EVENT_CLOSE)) {
    end = match.index + match[0].length;
  }
  return end < 0 ? '' : text.slice(end);
}

function addUserMessage(state: DigestState, text: string): void {
  const folded = clipLine(stripOrchestratorEvents(text), USER_MESSAGE_LIMIT);
  if (folded !== '') {
    pushBounded(state.userMessages, folded, MAX_USER_MESSAGES);
  }
}

function addFailure(state: DigestState, tool: string, error: string): void {
  pushBounded(
    state.failedTools,
    { tool, error: clipMiddle(error.trim() === '' ? '（出力なし）' : error.trim(), ERROR_LIMIT) },
    MAX_FAILED_TOOLS,
  );
}

/** Claude Codeが会話へ差し込む、ユーザーの発言ではない行の先頭（`handoff.ts` の抽出コマンドと同じ）。 */
export const CLAUDE_INJECTED_USER_TEXT =
  /^<(task-notification|local-command|command-name|command-message|command-args|event|ide_|system-reminder|content>)/u;

const TASK_NOTIFICATION_TOOL_USE_ID = /<tool-use-id>([^<]+)<\/tool-use-id>/u;

/** ファイルを書き換えるツールと、パスを持つ入力のキー。 */
const CLAUDE_EDIT_TOOLS: Record<string, string> = {
  Edit: 'file_path',
  MultiEdit: 'file_path',
  Write: 'file_path',
  NotebookEdit: 'notebook_path',
};

/** ツール呼び出しを `名前: 要点` の1行にする。 */
function claudeToolLabel(name: string, input: unknown): string {
  if (!isObject(input)) {
    return name;
  }
  const key = [
    'command',
    'description',
    'file_path',
    'notebook_path',
    'pattern',
    'url',
    'skill',
  ].find((k) => typeof input[k] === 'string' && input[k] !== '');
  const detail = key === undefined ? '' : clipLine(String(input[key]), TOOL_LABEL_LIMIT);
  return detail === '' ? name : `${name}: ${detail}`;
}

/** Claude Codeのtranscript用。 */
export function createClaudeDigestBuilder(): HandoffDigestBuilder {
  let state = emptyState();
  let recognized = 0;
  /** tool_use id → 表示名。失敗したときとbackgroundへ回ったときの名前に使う。 */
  let toolLabels = new Map<string, string>();

  const onAssistant = (entry: JsonObject): void => {
    const message = entry['message'];
    const content = isObject(message) ? message['content'] : undefined;
    if (!Array.isArray(content)) {
      return;
    }
    for (const part of content) {
      if (!isObject(part) || part['type'] !== 'tool_use') {
        continue;
      }
      const id = str(part['id']);
      const name = str(part['name']) ?? 'tool';
      const input = part['input'];
      const label = claudeToolLabel(name, input);
      if (id !== undefined) {
        toolLabels.set(id, label);
        if (isObject(input) && input['run_in_background'] === true) {
          state.runningJobs.set(id, label);
        }
      }
      const pathKey = CLAUDE_EDIT_TOOLS[name];
      const path = pathKey !== undefined && isObject(input) ? str(input[pathKey]) : undefined;
      if (path !== undefined && path !== '') {
        state.editedFiles.add(path);
      }
    }
  };

  const onToolResults = (entry: JsonObject, content: unknown[]): void => {
    const toolUseResult = entry['toolUseResult'];
    for (const part of content) {
      if (!isObject(part) || part['type'] !== 'tool_result') {
        continue;
      }
      const id = str(part['tool_use_id']);
      const label = (id === undefined ? undefined : toolLabels.get(id)) ?? 'tool';
      if (part['is_error'] === true) {
        addFailure(state, label, textOf(part['content']));
      }
      if (
        id !== undefined &&
        isObject(toolUseResult) &&
        (str(toolUseResult['backgroundTaskId']) !== undefined ||
          toolUseResult['status'] === 'async_launched')
      ) {
        state.runningJobs.set(id, label);
      }
    }
  };

  const onUser = (entry: JsonObject): void => {
    const message = entry['message'];
    const content = isObject(message) ? message['content'] : undefined;
    if (entry['isCompactSummary'] === true) {
      state = emptyState();
      toolLabels = new Map();
      const summary = textOf(content).trim();
      state.compactSummary =
        summary === '' ? undefined : clipMiddle(summary, COMPACT_SUMMARY_LIMIT);
      return;
    }
    if (Array.isArray(content) && content.some((p) => isObject(p) && p['type'] === 'tool_result')) {
      onToolResults(entry, content);
      return;
    }
    const text = textOf(content).replace(/^\s+/u, '');
    if (onTaskNotification(text)) {
      return;
    }
    if (
      entry['isMeta'] === true ||
      'toolUseResult' in entry ||
      CLAUDE_INJECTED_USER_TEXT.test(text)
    ) {
      return;
    }
    addUserMessage(state, text);
  };

  /** `<task-notification>` なら終わったジョブを外して `true` を返す。 */
  const onTaskNotification = (text: string): boolean => {
    if (!text.startsWith('<task-notification>')) {
      return false;
    }
    const id = TASK_NOTIFICATION_TOOL_USE_ID.exec(text)?.[1]?.trim();
    if (id !== undefined) {
      state.runningJobs.delete(id);
    }
    return true;
  };

  /**
   * ターンの途中に届いたものは `type=="user"` の行にならず、`queued_command` の
   * attachmentとしてだけ残る（backgroundジョブの完了通知も、ターン中に送ったユーザー発話も）。
   */
  const onQueuedCommand = (attachment: JsonObject): void => {
    const text = textOf(attachment['prompt']).replace(/^\s+/u, '');
    if (onTaskNotification(text)) {
      return;
    }
    if (attachment['commandMode'] === 'prompt' && !CLAUDE_INJECTED_USER_TEXT.test(text)) {
      addUserMessage(state, text);
    }
  };

  const onSnapshot = (entry: JsonObject): void => {
    const snapshot = entry['snapshot'];
    const backups = isObject(snapshot) ? snapshot['trackedFileBackups'] : undefined;
    if (isObject(backups)) {
      for (const path of Object.keys(backups)) {
        state.editedFiles.add(path);
      }
    }
  };

  return {
    push(line: string): void {
      const entry = parseLine(line);
      if (entry === undefined || entry['isSidechain'] === true) {
        return;
      }
      const type = str(entry['type']);
      const attachment = entry['attachment'];
      if (isObject(attachment) && attachment['type'] === 'queued_command') {
        recognized += 1;
        onQueuedCommand(attachment);
      } else if (type === 'user') {
        recognized += 1;
        onUser(entry);
      } else if (type === 'assistant') {
        recognized += 1;
        onAssistant(entry);
      } else if (type === 'file-history-snapshot') {
        recognized += 1;
        onSnapshot(entry);
      }
    },
    result(): HandoffDigest | undefined {
      return recognized === 0 ? undefined : toDigest(state);
    },
  };
}

/** Codexが会話へ差し込む、ユーザーの発言ではない行の先頭（`handoff.ts` の抽出コマンドと同じ）。 */
export const CODEX_INJECTED_USER_TEXT =
  /^(<environment_context>|<user_instructions>|# AGENTS.md instructions|<INSTRUCTIONS>)/u;

/** unified execが走り続けているプロセスを返すときの出力（`"session_id":44982`）。 */
const CODEX_RUNNING_SESSION = /"session_id":\s*(\d+)/gu;

/** `tools.exec_command({cmd:"…"` の `cmd` の値。 */
const CODEX_EXEC_CMD = /cmd:\s*"((?:[^"\\]|\\.)*)"/u;

/** `CommandExecution.command`（`["/bin/bash","-lc","…"]` か文字列）を1行にする。 */
function codexCommandText(command: unknown): string {
  if (Array.isArray(command)) {
    const last = command[command.length - 1];
    return typeof last === 'string' ? last : '';
  }
  return str(command) ?? '';
}

function codexCallLabel(payload: JsonObject): string {
  const name = str(payload['name']) ?? 'tool';
  const input = str(payload['input']) ?? str(payload['arguments']) ?? '';
  const cmd = CODEX_EXEC_CMD.exec(input)?.[1];
  const detail = cmd ?? input;
  return detail === '' ? name : `${name}: ${clipLine(detail, TOOL_LABEL_LIMIT)}`;
}

/** Codexのrollout用。 */
export function createCodexDigestBuilder(): HandoffDigestBuilder {
  let state = emptyState();
  let recognized = 0;
  /** call_id → 表示名。backgroundへ回ったプロセスの名前に使う。 */
  let callLabels = new Map<string, string>();
  /** 完了した記録のあるunified execのプロセス。後から出力が届いても走行中へ戻さない。 */
  let finishedProcesses = new Set<string>();

  const onCompacted = (payload: JsonObject): void => {
    state = emptyState();
    callLabels = new Map();
    finishedProcesses = new Set();
    const message = str(payload['message'])?.trim() ?? '';
    if (message !== '') {
      state.compactSummary = clipMiddle(message, COMPACT_SUMMARY_LIMIT);
      return;
    }
    const history = payload['replacement_history'];
    state.compactSummaryUnreadable =
      Array.isArray(history) &&
      history.some((item) => isObject(item) && item['type'] === 'compaction');
  };

  const onResponseItem = (payload: JsonObject): void => {
    const type = str(payload['type']);
    if (type === 'message' && payload['role'] === 'user') {
      const text = textOf(payload['content'], ['text', 'input_text']).replace(/^\s+/u, '');
      if (!CODEX_INJECTED_USER_TEXT.test(text)) {
        addUserMessage(state, text);
      }
      return;
    }
    const callId = str(payload['call_id']);
    if (type === 'custom_tool_call' || type === 'function_call') {
      if (callId !== undefined) {
        callLabels.set(callId, codexCallLabel(payload));
      }
      return;
    }
    if (type === 'custom_tool_call_output' || type === 'function_call_output') {
      const output = textOf(payload['output'], ['text']);
      const label = (callId === undefined ? undefined : callLabels.get(callId)) ?? 'exec';
      for (const match of output.matchAll(CODEX_RUNNING_SESSION)) {
        const id = match[1];
        if (id !== undefined && !finishedProcesses.has(id) && !state.runningJobs.has(id)) {
          state.runningJobs.set(id, label);
        }
      }
    }
  };

  const onItemCompleted = (item: JsonObject): void => {
    const type = str(item['type']);
    const failed = item['status'] === 'failed';
    if (type === 'CommandExecution') {
      const processId =
        str(item['process_id']) ??
        (typeof item['process_id'] === 'number' ? String(item['process_id']) : undefined);
      if (processId !== undefined) {
        finishedProcesses.add(processId);
        state.runningJobs.delete(processId);
      }
      if (failed) {
        const command = clipLine(codexCommandText(item['command']), TOOL_LABEL_LIMIT);
        const exitCode = item['exitCode'] ?? item['exit_code'];
        const stderr = str(item['stderr']) ?? '';
        const output = stderr.trim() === '' ? (str(item['stdout']) ?? '') : stderr;
        const head =
          exitCode === null || exitCode === undefined ? '' : `exit ${String(exitCode)}\n`;
        addFailure(state, `exec: ${command}`, `${head}${output}`);
      }
      return;
    }
    if (type === 'FileChange') {
      const changes = item['changes'];
      const paths = isObject(changes) ? Object.keys(changes) : [];
      for (const path of paths) {
        state.editedFiles.add(path);
      }
      if (failed) {
        const stderr = str(item['stderr']) ?? '';
        addFailure(
          state,
          `apply_patch: ${paths.join(', ')}`,
          stderr.trim() === '' ? (str(item['stdout']) ?? '') : stderr,
        );
      }
    }
  };

  return {
    push(line: string): void {
      const entry = parseLine(line);
      const payload = entry?.['payload'];
      if (entry === undefined || !isObject(payload)) {
        return;
      }
      const type = str(entry['type']);
      if (type === 'compacted') {
        recognized += 1;
        onCompacted(payload);
      } else if (type === 'response_item') {
        recognized += 1;
        onResponseItem(payload);
      } else if (type === 'event_msg' && payload['type'] === 'item_completed') {
        recognized += 1;
        const item = payload['item'];
        if (isObject(item)) {
          onItemCompleted(item);
        }
      }
    },
    result(): HandoffDigest | undefined {
      return recognized === 0 ? undefined : toDigest(state);
    },
  };
}

export function createHandoffDigestBuilder(provider: HandoffProvider): HandoffDigestBuilder {
  return provider === 'claude' ? createClaudeDigestBuilder() : createCodexDigestBuilder();
}

/** 読めた要点が1つも無い（拡張機能が保持している分を載せる従来形式のほうが情報が多い）。 */
function isEmptyDigest(digest: HandoffDigest): boolean {
  return (
    digest.compactSummary === undefined &&
    digest.userMessages.length === 0 &&
    digest.failedTools.length === 0 &&
    digest.runningJobs.length === 0 &&
    digest.editedFiles.length === 0
  );
}

/**
 * transcriptを1行ずつ読んで要点を返す。読めない・要点が1つも無いときは `undefined`
 * （例外は投げない）。途中で読み込みに失敗したときは、そこまでに集めた分を返す。
 *
 * 全文をメモリに載せない。transcriptは十数MBになる。
 */
export async function readHandoffDigest(
  provider: HandoffProvider,
  transcriptPath: string,
): Promise<HandoffDigest | undefined> {
  const builder = createHandoffDigestBuilder(provider);
  const stream = createReadStream(transcriptPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const collected = (): HandoffDigest | undefined => {
    const digest = builder.result();
    return digest === undefined || isEmptyDigest(digest) ? undefined : digest;
  };
  try {
    for await (const line of rl) {
      builder.push(line);
    }
    return collected();
  } catch {
    return collected();
  } finally {
    rl.close();
    stream.destroy();
  }
}

const NONE = '無し';

/**
 * 要点の節をMarkdownの行にする。
 *
 * 全体が `HANDOFF_DIGEST_LIMIT` を超えたら行の境目で切り、残りは抽出コマンドで読むよう書き添える。
 * 切られるのは後ろの節からなので、短くて復旧に効く節（backgroundジョブ・編集したファイル）を
 * 長くなりやすい失敗したツール呼び出しより前に置く。
 *
 * transcript由来の文字列は、見出しや箇条書きを偽装できないよう、複数行のものはフェンスで囲み、
 * 1行のものは改行を畳んでから入れる。
 */
export function renderHandoffDigest(digest: HandoffDigest): string[] {
  const lines: string[] = [];
  lines.push('## 会話の要点（transcriptから機械抽出）');
  lines.push('');
  lines.push(
    '最後の自動圧縮より後だけを、拡張機能がtranscriptから機械的に抜き出したもの。要約ではない。ここに無いことは下の抽出コマンドで読む。',
  );
  lines.push('');
  lines.push('### 最後の自動圧縮の要約');
  lines.push('');
  if (digest.compactSummary !== undefined) {
    lines.push(fenceText(digest.compactSummary));
  } else if (digest.compactSummaryUnreadable) {
    lines.push(
      '自動圧縮は走っているが、要約は暗号化された形でしか残っておらず読めない。圧縮より前の経緯は下の発話と抽出コマンドから辿る。',
    );
  } else {
    lines.push(NONE);
  }
  lines.push('');
  lines.push(`### ユーザー発話（末尾${MAX_USER_MESSAGES}件まで）`);
  lines.push('');
  if (digest.userMessages.length === 0) {
    lines.push(NONE);
  } else {
    for (const message of digest.userMessages) {
      lines.push(`- ${message}`);
    }
  }
  lines.push('');
  lines.push('### 終わっていないbackgroundジョブ');
  lines.push('');
  if (digest.runningJobs.length === 0) {
    lines.push(NONE);
  } else {
    for (const job of digest.runningJobs) {
      lines.push(`- ${clipLine(job, TOOL_LABEL_LIMIT)}`);
    }
    lines.push('');
    lines.push(
      '開始の記録はあるが、終わった記録がtranscriptに無いもの。引き継ぎ元のセッションと一緒に止まっている場合がある。',
    );
  }
  lines.push('');
  lines.push('### 編集したファイル');
  lines.push('');
  if (digest.editedFiles.length === 0) {
    lines.push(
      `${NONE}（シェルで書き換えたファイルは記録されない。空を「編集していない」と解釈しない）`,
    );
  } else {
    for (const file of digest.editedFiles) {
      lines.push(`- ${clipLine(file, FILE_PATH_LIMIT)}`);
    }
  }
  lines.push('');
  lines.push(`### 失敗したツール呼び出し（末尾${MAX_FAILED_TOOLS}件まで）`);
  lines.push('');
  if (digest.failedTools.length === 0) {
    lines.push(NONE);
  } else {
    for (const failure of digest.failedTools) {
      lines.push(`- ${clipLine(failure.tool, TOOL_LABEL_LIMIT)}`);
      lines.push('');
      lines.push(fenceText(failure.error));
      lines.push('');
    }
  }
  lines.push('');
  return capLines(lines, HANDOFF_DIGEST_LIMIT);
}

/** 本文中のバッククォートの並びより長いフェンスで囲む。 */
function fenceText(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/gu)].map((m) => m[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

/**
 * 行の境目で `maxChars` 以内に切る（切ったときの書き添えも含めて収める）。
 *
 * `fenceText` の囲みは1要素に収まっているので、要素の境目で切ればフェンスが開いたまま残らない。
 */
function capLines(lines: string[], maxChars: number): string[] {
  const note = `（上限${maxChars}文字を超えたためここで切った。続きは下の抽出コマンドでtranscriptから読む）`;
  const tail = ['', note, ''];
  const tailChars = tail.reduce((sum, line) => sum + line.length + 1, 0);
  if (lines.reduce((sum, line) => sum + line.length + 1, 0) <= maxChars) {
    return lines;
  }
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    total += (lines[i] ?? '').length + 1;
    if (total + tailChars > maxChars) {
      return [...lines.slice(0, i), ...tail];
    }
  }
  return lines;
}
