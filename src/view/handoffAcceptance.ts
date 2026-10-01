import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { ChatItem, ChatState } from '../appserver/chatState';

/**
 * 引き継ぎ先の受領確認（Issue #1751）。
 *
 * 初回プロンプトの末尾へ「3点を出したあと `HANDOFF_ACCEPTED <handoff_id>` を書け」と指示し、
 * 引き継ぎ先の応答にその行が現れるまで旧タブを閉じない。応答が始まっただけでは、本文を
 * 読めたかどうかが分からないため。
 */

/** 受領確認の行の接頭辞。 */
export const HANDOFF_ACCEPTED_TOKEN = 'HANDOFF_ACCEPTED';

/** handoff skillが採番する形（`<YYYYMMDDTHHMMSS>-<16進6桁>`）と同じ形のidを作る。 */
export function newHandoffId(now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/\.\d+Z$/u, '')
    .replace(/[-:]/gu, '');
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

/** 初回プロンプトの末尾へ足す、受領確認の指示。 */
export function buildHandoffAcceptanceInstruction(handoffId: string): string {
  return [
    '',
    '---',
    '受け取ったら、次の順で応答すること。',
    '1. 「前セッションでやったこと / 未解決・未履行 / これからやること」の3点を出す',
    `2. そのあと、次の1行を単独の行で書く（前後に装飾を付けない）: ${HANDOFF_ACCEPTED_TOKEN} ${handoffId}`,
  ].join('\n');
}

/** 初回プロンプトへ受領確認の指示を足す。 */
export function withHandoffAcceptance(text: string, handoffId: string): string {
  return `${text}\n${buildHandoffAcceptanceInstruction(handoffId)}`;
}

const ACCEPTED_LINE = new RegExp(`^\\s*${HANDOFF_ACCEPTED_TOKEN}\\s+(\\S+)\\s*$`, 'gmu');

/** 応答本文が `HANDOFF_ACCEPTED <expectedId>` の行を持つか。idが違う行は数えない。 */
export function hasHandoffAcceptance(text: string, expectedId: string): boolean {
  for (const match of text.matchAll(ACCEPTED_LINE)) {
    if (match[1] === expectedId) {
      return true;
    }
  }
  return false;
}

/** 引き継ぎ先のアシスタント応答のどれかが受領確認の行を持つか。 */
export function stateHasHandoffAcceptance(state: ChatState, expectedId: string): boolean {
  return state.items.some(
    (item) => item.kind === 'agentMessage' && hasHandoffAcceptance(item.text, expectedId),
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * 引き継ぎ先がpointerファイルを読み込んだか（Issue #1797）。
 *
 * 引き継ぎ先は受領行を出さずに作業を始めることがあるが、pointerを読めたのなら本文は届いている。
 * 成功したReadツール（`fileRead`）か、コマンド（`commandExecution`）のうち、pointerのファイル名を
 * 1語として含むものを受領とみなす。ファイル名はセッションidと時刻を含み一意なので、`~` 始まりや
 * 相対パスで読んだ場合も拾える。`<名前>-prompt.md` や `<名前>.bak` のような別ファイルは拾わない。
 */
export function stateHasPointerRead(state: ChatState, pointerPath: string): boolean {
  const name = basename(pointerPath);
  if (name === '') {
    return false;
  }
  const word = new RegExp(`(?:^|[\\s/'"=<])${escapeRegExp(name)}(?=$|[\\s'";&|)<>])`, 'u');
  return state.items.some(
    (item) =>
      (item.kind === 'fileRead' || item.kind === 'commandExecution') &&
      isSucceeded(item.status) &&
      word.test(item.detail),
  );
}

/** 引き継ぎ元が作ったIssue・PR/MRの参照。二重に作らせないために本文へ載せる。 */
export interface CreatedReference {
  kind: 'issue' | 'pr';
  number: string;
  url: string;
}

const CREATE_COMMAND =
  /(?:^|[;&|(]|-l?c\s+['"]?)\s*(?:gh|glab)(?:\s+-\S+(?:\s+(?!-)[^\s;&|]+)?)*\s+(issue|pr|mr)\s+create\b/mu;
const CREATED_URL = /https?:\/\/\S+?\/(issues|pull|merge_requests)\/(\d+)(?=[\s)"'>]|$)/gu;

function isSucceeded(status: string | undefined): boolean {
  const value = status?.trim();
  return value === 'completed' || value === 'exit 0';
}

/**
 * このセッションで成功した `gh|glab issue|pr|mr create` の出力から、作成物のURLと番号を拾う。
 * 作成コマンドの出力にしか現れないURLだけを見るため、参照しただけのIssueは入らない。
 */
export function extractCreatedReferences(
  items: ReadonlyArray<Pick<ChatItem, 'kind' | 'detail' | 'status' | 'text'>>,
): CreatedReference[] {
  const found = new Map<string, CreatedReference>();
  for (const item of items) {
    if (item.kind !== 'commandExecution' || !isSucceeded(item.status)) {
      continue;
    }
    const created = CREATE_COMMAND.exec(item.detail)?.[1];
    if (created === undefined) {
      continue;
    }
    for (const match of item.text.matchAll(CREATED_URL)) {
      const kind = match[1] === 'issues' ? 'issue' : 'pr';
      if ((created === 'issue') !== (kind === 'issue')) {
        continue;
      }
      const number = match[2] ?? '';
      const key = `${kind}#${number}`;
      if (!found.has(key)) {
        found.set(key, { kind, number, url: match[0] });
      }
    }
  }
  return [...found.values()];
}

/** 引き継ぎ時点のgitの状態。取れなかった項目は `undefined`。 */
export interface HandoffGitFacts {
  branch: string | undefined;
  head: string | undefined;
  /** `git diff HEAD` と未追跡ファイル（パスと内容）のsha256。どちらも無ければ `clean`。 */
  diffHash: string | undefined;
}

function git(cwd: string, args: string[], timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => resolve(error === null ? stdout : undefined),
    );
  });
}

/** 追跡差分と未追跡ファイル（パスと内容）のハッシュ先頭16桁。差分が無ければ `clean`、取れなければ `undefined`。 */
async function hashWorkingChanges(
  cwd: string,
  tracked: string | undefined,
  untrackedList: string | undefined,
): Promise<string | undefined> {
  if (tracked === undefined || untrackedList === undefined) {
    return undefined;
  }
  const paths = untrackedList.split('\0').filter((path) => path !== '');
  if (tracked === '' && paths.length === 0) {
    return 'clean';
  }
  const hash = createHash('sha256').update(tracked);
  for (const path of paths.sort()) {
    hash.update(`\0untracked:${path}\0`);
    try {
      hash.update(await readFile(join(cwd, path)));
    } catch {
      hash.update('unreadable');
    }
  }
  return hash.digest('hex').slice(0, 16);
}

/** branch・HEAD・未commit差分のハッシュを取る。失敗は項目単位で `undefined` に倒し、投げない。 */
export async function resolveHandoffGitFacts(
  cwd: string | undefined,
  gitBranch: string | undefined,
  timeoutMs = 5_000,
): Promise<HandoffGitFacts> {
  if (cwd === undefined) {
    return { branch: gitBranch, head: undefined, diffHash: undefined };
  }
  const [head, tracked, untrackedList] = await Promise.all([
    git(cwd, ['rev-parse', 'HEAD'], timeoutMs),
    git(cwd, ['diff', 'HEAD'], timeoutMs),
    git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], timeoutMs),
  ]);
  return {
    branch: gitBranch,
    head: head?.trim() || undefined,
    diffHash: await hashWorkingChanges(cwd, tracked, untrackedList),
  };
}

/** 引き継ぎ本文の末尾へ足す「引き継ぎ時点の事実」の節。 */
export function buildHandoffFactsSection(
  facts: HandoffGitFacts,
  created: readonly CreatedReference[],
): string {
  const lines = [
    '## 引き継ぎ時点の事実（拡張機能が機械取得）',
    `- branch: ${facts.branch ?? '不明'}`,
    `- HEAD: ${facts.head ?? '不明'}`,
    `- 未commit差分のハッシュ（git diff HEAD のsha256先頭16桁）: ${facts.diffHash ?? '不明'}`,
  ];
  if (created.length === 0) {
    lines.push('- このセッションで作成したIssue・PR: なし');
  } else {
    lines.push(
      `- このセッションで作成したIssue・PR（二重に作らないこと）: ${created
        .map((ref) => `${ref.kind === 'issue' ? 'Issue' : 'PR'} #${ref.number} (${ref.url})`)
        .join(', ')}`,
    );
  }
  return lines.join('\n');
}
