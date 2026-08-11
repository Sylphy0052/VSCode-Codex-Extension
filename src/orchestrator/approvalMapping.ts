import type { ChatItem, PendingApproval } from '../appserver/chatState';
import {
  normalizeCommand,
  type EscalationRequest,
  type NetworkApprovalContext,
  type NetworkPolicyAmendment,
} from './escalation';
import type { WorktreeFileSystemPort } from './worktree';
import type { Provider } from './workflow';

/**
 * 承認要求の生パラメータ（Codex: `ServerRequest.params`、Claude:
 * `can_use_tool` control_requestのpayload）を `escalation.ts` の入力
 * （`EscalationRequest`）へ変換する（design.md §16.7）。
 *
 * `PendingApproval`（`describeApproval` / `describeCanUseTool` が作る表示用の値）は
 * `title` / `detail` に文字列結合済みで、`command` / `cwd` / 変更対象パスを個別に
 * 持たない。判定へ渡すのは常にこのモジュールが組み立てた生の値であり、
 * 表示用の文字列を逆にパースすることはしない。
 *
 * `fileChange` の変更対象パスは、Codexでは要求そのものに含まれない
 * （`itemId` から `ChatState.items` の同じidの項目を引き、`diffs[].path` を使う。
 * 実測で確認済み・§16.7）。Claudeでは `Edit` / `Write` / `NotebookEdit` ツールの
 * `input.file_path` / `input.notebook_path` に直接入っているため、itemIdの参照は不要。
 */

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const rec = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function readNetworkApprovalContext(v: unknown): NetworkApprovalContext | undefined {
  const o = rec(v);
  if (o === undefined) {
    return undefined;
  }
  return { host: str(o['host']), protocol: str(o['protocol']) };
}

function readNetworkPolicyAmendments(v: unknown): NetworkPolicyAmendment[] {
  return arr(v)
    .map((raw) => {
      const o = rec(raw);
      const action = o?.['action'];
      if (action !== 'allow' && action !== 'deny') {
        return undefined;
      }
      return { action, host: str(o?.['host']) };
    })
    .filter((a): a is NetworkPolicyAmendment => a !== undefined);
}

function readStringArray(v: unknown): string[] {
  return arr(v).filter((x): x is string => typeof x === 'string');
}

function readOptionalString(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** パスらしい文字列を実パスへ解決する。解決できなければ元の文字列のまま返す（安全側＝境界外と判定されやすい方に倒す）。 */
async function resolveRealPath(fs: WorktreeFileSystemPort, raw: string): Promise<string> {
  if (raw === '') {
    return raw;
  }
  const resolved = await fs.realpath(raw);
  return resolved ?? raw;
}

/** `fileChange` のitemIdから、Codexの `ChatState.items` に積まれた差分のパス一覧を引く。 */
function codexFileChangePaths(itemId: string | undefined, items: readonly ChatItem[]): string[] {
  if (itemId === undefined) {
    return [];
  }
  const item = items.find((i) => i.id === itemId);
  return item === undefined ? [] : item.diffs.map((d) => d.path).filter((p) => p !== '');
}

/** ClaudeのEdit/Write/NotebookEdit要求から変更対象パスを引く。itemIdの参照は不要。 */
function claudeFileChangePaths(rawParams: Record<string, unknown>): string[] {
  const input = rec(rawParams['input']) ?? {};
  const path = str(input['file_path']) || str(input['notebook_path']);
  return path === '' ? [] : [path];
}

const EMPTY_REQUEST_FIELDS = {
  networkApprovalContext: undefined,
  proposedNetworkPolicyAmendments: [],
  grantRoot: undefined,
  proposedExecpolicyAmendment: [],
} as const;

/**
 * 承認要求（生パラメータ）から `EscalationRequest` を組み立てる。
 *
 * `approval.kind` は `describeApproval` / `describeCanUseTool` が既に判定済みの
 * 種別（`command` / `fileChange` / `permissions` / 旧形式）をそのまま使う。旧形式
 * （`applyPatch` / `execCommand`）は判定に使える構造化フィールドが薄いため、
 * 安全側（`unknown` → 常に `ask`）に倒す。
 */
export async function buildEscalationRequest(
  provider: Provider,
  approval: PendingApproval,
  rawParams: Record<string, unknown>,
  taskCwd: string,
  latestItems: readonly ChatItem[],
  fs: WorktreeFileSystemPort,
): Promise<EscalationRequest> {
  const grantRoot = readOptionalString(rawParams['grantRoot']);
  const networkApprovalContext = readNetworkApprovalContext(rawParams['networkApprovalContext']);
  const proposedNetworkPolicyAmendments = readNetworkPolicyAmendments(
    rawParams['proposedNetworkPolicyAmendments'],
  );
  const proposedExecpolicyAmendment = readStringArray(rawParams['proposedExecpolicyAmendment']);

  if (approval.kind === 'command') {
    const command =
      provider === 'claude'
        ? str(rec(rawParams['input'])?.['command'])
        : normalizeCommand(rawParams['command']);
    const rawCwd = provider === 'claude' ? taskCwd : str(rawParams['cwd']);
    const cwd = rawCwd === '' ? '' : await resolveRealPath(fs, rawCwd);
    return {
      kind: 'command',
      command,
      cwd,
      paths: [],
      networkApprovalContext,
      proposedNetworkPolicyAmendments,
      grantRoot,
      proposedExecpolicyAmendment,
    };
  }

  if (approval.kind === 'fileChange') {
    const rawPaths =
      provider === 'claude'
        ? claudeFileChangePaths(rawParams)
        : codexFileChangePaths(approval.itemId, latestItems);
    const paths = await Promise.all(rawPaths.map((p) => resolveRealPath(fs, p)));
    return {
      kind: 'fileChange',
      command: '',
      cwd: '',
      paths,
      ...EMPTY_REQUEST_FIELDS,
      grantRoot,
    };
  }

  if (approval.kind === 'permissions') {
    return { kind: 'permissions', command: '', cwd: '', paths: [], ...EMPTY_REQUEST_FIELDS };
  }

  // applyPatch / execCommand（旧形式）。judgeできる材料が薄いため常にaskへ倒す
  return { kind: 'unknown', command: '', cwd: '', paths: [], ...EMPTY_REQUEST_FIELDS };
}
