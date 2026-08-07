import type { ChatItem } from '../appserver/chatState';
import { isSessionId } from '../codex/argvBuilder';
import type { TranscriptMeta } from './types';

/**
 * `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` のパーサ。
 *
 * Claude Code の transcript は1行1イベントのJSONLで、ファイル名がそのまま
 * セッションidになる。壊れた行は個別に読み飛ばし、全体を捨てない。
 */

/** IDEやCLIが挿入する制御タグ。表示名に出ると邪魔なので落とす。 */
const CONTROL_BLOCK =
  /<(system-reminder|command-message|command-name|command-args|local-command-stdout|ide_selection|ide_opened_file)>[\s\S]*?<\/\1>/g;

const JSONL_SUFFIX = '.jsonl';

export function sessionIdFromTranscriptName(fileName: string): string | undefined {
  if (!fileName.endsWith(JSONL_SUFFIX)) {
    return undefined;
  }
  const id = fileName.slice(0, -JSONL_SUFFIX.length);
  return isSessionId(id) ? id : undefined;
}

/**
 * 先頭の数行からセッションの素性を組み立てる。
 *
 * 先頭行が必ずしも本文ではない（`queue-operation` などが挟まる）ため、
 * cwd と最初のユーザー発言が揃うまで読み進める。
 */
export function parseTranscriptHead(lines: readonly string[]): TranscriptMeta | undefined {
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let startedAt: string | undefined;
  let gitBranch: string | undefined;
  let firstUserText: string | undefined;

  for (const line of lines) {
    const entry = parseLine(line);
    if (entry === undefined) {
      continue;
    }

    sessionId ??= str(entry['sessionId']) || undefined;
    cwd ??= str(entry['cwd']) || undefined;
    startedAt ??= str(entry['timestamp']) || undefined;
    gitBranch ??= str(entry['gitBranch']) || undefined;

    if (firstUserText === undefined && isHumanMessage(entry)) {
      const text = cleanText(messageText(entry));
      if (text !== '') {
        firstUserText = text;
      }
    }

    if (sessionId !== undefined && cwd !== undefined && firstUserText !== undefined) {
      break;
    }
  }

  if (sessionId === undefined || cwd === undefined) {
    return undefined;
  }
  return { sessionId, cwd, firstUserText, startedAt, gitBranch };
}

/**
 * 会話全体を表示用の項目列にする。
 * Codexのチャット画面と同じ `ChatItem` へ寄せ、描画側を1本に保つ。
 */
export function transcriptItems(lines: readonly string[]): ChatItem[] {
  const items: ChatItem[] = [];
  /** tool_use id → items上の位置。tool_result で結果を書き戻すため。 */
  const toolIndex = new Map<string, number>();

  for (const line of lines) {
    const entry = parseLine(line);
    if (entry === undefined || entry['isSidechain'] === true) {
      continue;
    }

    const type = str(entry['type']);
    if (type === 'user') {
      appendUserEntry(entry, items, toolIndex);
      continue;
    }
    if (type === 'assistant') {
      appendAssistantEntry(entry, items, toolIndex);
    }
  }

  return items;
}

function appendUserEntry(
  entry: Record<string, unknown>,
  items: ChatItem[],
  toolIndex: Map<string, number>,
): void {
  const content = messageContent(entry);

  for (const part of content) {
    if (str(part['type']) !== 'tool_result') {
      continue;
    }
    const target = toolIndex.get(str(part['tool_use_id']));
    const existing = target === undefined ? undefined : items[target];
    if (target === undefined || existing === undefined) {
      continue;
    }
    items[target] = {
      ...existing,
      text: toolResultText(part['content']),
      status: part['is_error'] === true ? 'エラー' : 'completed',
    };
  }

  if (!isHumanMessage(entry)) {
    return;
  }
  const text = cleanText(messageText(entry));
  if (text === '') {
    return;
  }
  items.push(item(entry, 'userMessage', { text }));
}

function appendAssistantEntry(
  entry: Record<string, unknown>,
  items: ChatItem[],
  toolIndex: Map<string, number>,
): void {
  for (const part of messageContent(entry)) {
    const type = str(part['type']);
    if (type === 'text') {
      const text = cleanText(str(part['text']));
      if (text !== '') {
        items.push(item(entry, 'agentMessage', { text }));
      }
      continue;
    }
    if (type === 'thinking') {
      const text = cleanText(str(part['thinking']));
      if (text !== '') {
        items.push(item(entry, 'reasoning', { text }));
      }
      continue;
    }
    if (type === 'tool_use') {
      const tool = describeTool(str(part['name']), rec(part['input']) ?? {});
      items.push(item(entry, tool.kind, { detail: tool.detail, id: str(part['id']) }));
      toolIndex.set(str(part['id']), items.length - 1);
    }
  }
}

/** ツール呼び出しをCodex側の項目種別へ寄せる。描画側の分岐を増やさないため。 */
export function describeTool(
  name: string,
  input: Record<string, unknown>,
): { kind: string; detail: string } {
  switch (name) {
    case 'Bash':
    case 'BashOutput':
      return { kind: 'commandExecution', detail: str(input['command']) };
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return { kind: 'fileChange', detail: str(input['file_path']) };
    case 'Read':
      return { kind: 'fileRead', detail: str(input['file_path']) };
    case 'WebSearch':
      return { kind: 'webSearch', detail: str(input['query']) };
    case 'WebFetch':
      return { kind: 'webSearch', detail: str(input['url']) };
    default:
      return { kind: 'mcpToolCall', detail: name };
  }
}

function item(
  entry: Record<string, unknown>,
  kind: string,
  overrides: { text?: string; detail?: string; id?: string },
): ChatItem {
  return {
    id: overrides.id !== undefined && overrides.id !== '' ? overrides.id : str(entry['uuid']),
    kind,
    text: overrides.text ?? '',
    detail: overrides.detail ?? '',
    status: undefined,
    turnId: undefined,
  };
}

/**
 * 人の発言かどうか。
 * subagentの指示・ツール結果・システム挿入は表示名にも会話の起点にも使わない。
 */
function isHumanMessage(entry: Record<string, unknown>): boolean {
  if (str(entry['type']) !== 'user' || entry['isSidechain'] === true || entry['isMeta'] === true) {
    return false;
  }
  const userType = entry['userType'];
  if (userType !== undefined && userType !== 'external') {
    return false;
  }
  const origin = rec(entry['origin']);
  if (origin !== undefined && str(origin['kind']) !== 'human') {
    return false;
  }
  return messageContent(entry).some((part) => str(part['type']) === 'text');
}

function messageContent(entry: Record<string, unknown>): Record<string, unknown>[] {
  const message = rec(entry['message']);
  const content = message?.['content'];
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.map((part) => rec(part) ?? {});
}

function messageText(entry: Record<string, unknown>): string {
  return messageContent(entry)
    .filter((part) => str(part['type']) === 'text')
    .map((part) => str(part['text']))
    .filter((text) => text !== '')
    .join('\n');
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => {
      const p = rec(part);
      return p !== undefined && str(p['type']) === 'text' ? str(p['text']) : '';
    })
    .filter((text) => text !== '')
    .join('\n');
}

function cleanText(text: string): string {
  return text.replace(CONTROL_BLOCK, '').trim();
}

function parseLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (trimmed === '') {
    return undefined;
  }
  try {
    return rec(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const rec = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
