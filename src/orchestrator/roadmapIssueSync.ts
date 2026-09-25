/**
 * runの完了をロードマップIssueのチェックリストへ書き戻す（Issue #1422）。
 *
 * 「ロードマップIssueから生成」で作ったロードマップは、変換元のIssue番号を `元Issue: #N` として
 * 持っている。runでチェックが入った項目のうち `Issue: #M` を持つものについて、#N の本文の
 * `- [ ] #M...` 行を `- [x] #M...` にする。ローカルの `.md` への書き戻し
 * （`applyRunCompletionToFile`）が済んだ後に呼ぶ前提で、失敗してもそちらには影響させない。
 */
import {
  fetchIssueBody,
  updateIssue,
  type CliCommandRunner,
  type ForgeFileSystemPort,
  type ForgeHost,
} from './forge';
import { checkIssueChecklistItems, parseRoadmapMarkdown, readRoadmapSourceIssue } from './roadmap';
import { SerialQueue } from './serialQueue';

export interface SyncRoadmapIssueDeps {
  cli: CliCommandRunner;
  fs: ForgeFileSystemPort;
}

export interface SyncRoadmapIssueInput {
  host: ForgeHost;
  cwd: string;
  /** ローカルへの書き戻しが済んだ後のロードマップ本文。 */
  roadmapMarkdown: string;
  /** 今回チェックを入れた項目のid（`applyRunCompletionToFile`の`updatedItemIds`）。 */
  updatedItemIds: readonly string[];
}

export type SyncRoadmapIssueOutcome =
  /** 変換元Issueの記録が無い、または対象の項目が無い。Issueには触れていない。 */
  | { kind: 'skipped'; sourceIssue: number | undefined; itemsWithoutIssue: string[] }
  | {
      kind: 'updated' | 'unchanged';
      sourceIssue: number;
      checked: number[];
      missing: number[];
      itemsWithoutIssue: string[];
    }
  | { kind: 'failed'; sourceIssue: number; message: string; itemsWithoutIssue: string[] };

export async function syncRoadmapCompletionToIssue(
  deps: SyncRoadmapIssueDeps,
  input: SyncRoadmapIssueInput,
): Promise<SyncRoadmapIssueOutcome> {
  const sourceIssue = readRoadmapSourceIssue(input.roadmapMarkdown);
  const updated = new Set(input.updatedItemIds);
  const items = parseRoadmapMarkdown(input.roadmapMarkdown)
    .phases.flatMap((phase) => phase.items)
    .filter((item) => updated.has(item.id));
  const itemsWithoutIssue = items.filter((item) => item.issue === undefined).map((item) => item.id);
  const issues = [
    ...new Set(items.flatMap((item) => (item.issue === undefined ? [] : [item.issue]))),
  ];
  if (sourceIssue === undefined || issues.length === 0) {
    return { kind: 'skipped', sourceIssue, itemsWithoutIssue };
  }

  return runExclusiveOnRoadmapIssue(input.host, input.cwd, sourceIssue, () =>
    checkIssueAndUpdate(deps, input, sourceIssue, issues, itemsWithoutIssue),
  );
}

/**
 * 同じロードマップIssueの本文への read-modify-write を直列化する。子Issueのチェックと
 * 計画区画の書き戻し（`roadmapImport.ts`）は同じ本文を置き換えるため、同じ列に並べる。
 */
export function runExclusiveOnRoadmapIssue<T>(
  host: ForgeHost,
  cwd: string,
  issue: number,
  task: () => Promise<T>,
): Promise<T> {
  return runExclusiveOnIssue(`${host}:${cwd}:${String(issue)}`, task);
}

/**
 * 本文の取得から更新までは read-modify-write で、`updateIssue` は本文をまるごと置き換える。
 * 同じロードマップIssueの子を別々のrunが同時に完了させると、後から書いた側が先のチェックを
 * 消すため、Issueごとに直列化する。ローカルの `.md` 側（`runExclusiveOnRoadmapFile`）と同じく
 * プロセス内の排他だけで、別ウィンドウや人の手による同時編集は防げない。
 */
const issueWriteQueues = new Map<string, { queue: SerialQueue; pending: number }>();

async function runExclusiveOnIssue<T>(key: string, task: () => Promise<T>): Promise<T> {
  let entry = issueWriteQueues.get(key);
  if (entry === undefined) {
    entry = { queue: new SerialQueue(), pending: 0 };
    issueWriteQueues.set(key, entry);
  }
  entry.pending += 1;
  try {
    return await entry.queue.enqueue(task);
  } finally {
    entry.pending -= 1;
    if (entry.pending === 0) {
      issueWriteQueues.delete(key);
    }
  }
}

async function checkIssueAndUpdate(
  deps: SyncRoadmapIssueDeps,
  input: SyncRoadmapIssueInput,
  sourceIssue: number,
  issues: number[],
  itemsWithoutIssue: string[],
): Promise<SyncRoadmapIssueOutcome> {
  const body = await fetchIssueBody(deps.cli, input.host, input.cwd, sourceIssue);
  if (body === undefined) {
    return {
      kind: 'failed',
      sourceIssue,
      message: `ロードマップIssue #${String(sourceIssue)} の本文を取得できませんでした`,
      itemsWithoutIssue,
    };
  }
  const result = checkIssueChecklistItems(body, issues);
  if (result.checked.length === 0) {
    return {
      kind: 'unchanged',
      sourceIssue,
      checked: [],
      missing: result.missing,
      itemsWithoutIssue,
    };
  }
  const outcome = await updateIssue(deps, {
    host: input.host,
    cwd: input.cwd,
    number: sourceIssue,
    body: result.body,
  });
  if (!outcome.ok) {
    return { kind: 'failed', sourceIssue, message: outcome.message, itemsWithoutIssue };
  }
  return {
    kind: 'updated',
    sourceIssue,
    checked: result.checked,
    missing: result.missing,
    itemsWithoutIssue,
  };
}
