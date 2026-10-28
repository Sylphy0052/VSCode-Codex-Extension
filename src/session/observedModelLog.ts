import { readFile } from 'node:fs/promises';
import type { ObservedModel } from '../appserver/chatState';

/**
 * CLIの会話ログから、実際に使ったmodel/effortを読む（Issue #2016）。
 *
 * effortはClaude Code・Codexとも、CLIの通知には載らず会話ログにだけ残る。引き継ぎ先の
 * 初回応答の後に読み、設定値と突き合わせる。
 */

/**
 * Claude Codeのtranscriptの、本体（subagentでない）の最後のassistant行から読む。
 *
 * `message.model`はAPIの応答値、トップレベルの`effort`はCLIが送った値。読めなければ`undefined`。
 */
export async function readTranscriptModel(filePath: string): Promise<ObservedModel | undefined> {
  let found: ObservedModel | undefined;
  for (const line of await readLines(filePath)) {
    const record = parseRecord(line);
    if (record?.['type'] !== 'assistant' || record['isSidechain'] === true) {
      continue;
    }
    const message = asRecord(record['message']);
    const model = asString(message?.['model']);
    if (model === undefined || model === '<synthetic>') {
      continue;
    }
    found = { model, effort: asString(record['effort']), source: 'transcript' };
  }
  return found;
}

/**
 * Codexのrolloutの、最後の`turn_context`行の`payload.model` / `payload.effort`を読む。
 * 読めなければ`undefined`。
 */
export async function readRolloutModel(filePath: string): Promise<ObservedModel | undefined> {
  let found: ObservedModel | undefined;
  for (const line of await readLines(filePath)) {
    const record = parseRecord(line);
    if (record?.['type'] !== 'turn_context') {
      continue;
    }
    const payload = asRecord(record['payload']);
    const model = asString(payload?.['model']);
    const effort = asString(payload?.['effort']);
    if (model === undefined && effort === undefined) {
      continue;
    }
    found = { model, effort, source: 'rollout' };
  }
  return found;
}

async function readLines(filePath: string): Promise<string[]> {
  try {
    return (await readFile(filePath, 'utf8')).split('\n');
  } catch {
    // 書き出し前・削除済みのログは「読めない」として扱う。検証は任意の確認なので止めない
    return [];
  }
}

function parseRecord(line: string): Record<string, unknown> | undefined {
  if (line.trim() === '') {
    return undefined;
  }
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
