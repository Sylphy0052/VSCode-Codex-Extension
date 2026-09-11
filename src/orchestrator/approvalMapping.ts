import * as path from 'node:path';

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

/**
 * パスらしい文字列を実パスへ解決する。解決できなければ `undefined` を返す。
 *
 * まだ作られていないファイル（Claudeの `Write` やCodexの新規作成）は、パス全体の
 * `realpath` が失敗する。生の文字列をそのまま返すと、許可root配下のsymlinkが外部を
 * 指していてもその情報が落ちて字面の境界検査を通ってしまうため、実在する最寄りの親を
 * 解決し、そこへ残りの成分を連結した値を返す（レビュー指摘: EX-APPROVAL-02）。
 * ルートまで遡っても解決できないときだけ `undefined` にして、呼び出し側から
 * 「判定に失敗した」＝ `ask` へ倒す。
 */
async function resolveRealPath(
  fs: WorktreeFileSystemPort,
  raw: string,
): Promise<string | undefined> {
  if (raw === '') {
    return raw;
  }
  const direct = await fs.realpath(raw);
  if (direct !== undefined) {
    return direct;
  }
  // 末尾の成分を1つずつ剥がしながら、実在する最寄りの親を探す。
  const trailing: string[] = [];
  let current = raw;
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    trailing.unshift(path.basename(current));
    const resolvedParent = await fs.realpath(parent);
    if (resolvedParent !== undefined) {
      return path.join(resolvedParent, ...trailing);
    }
    current = parent;
  }
}

/**
 * `fileChange` のitemIdから、Codexの `ChatState.items` に積まれた差分のパス一覧を引く。
 *
 * 移動（rename）の要求では移動先 `movePath` も書き込み先になるため、元パスと併せて
 * 境界検査へ渡す。元が境界内でも移動先が境界外・`.git` 配下のことがある
 * （レビュー指摘: EX-APPROVAL-01）。
 */
function codexFileChangePaths(itemId: string | undefined, items: readonly ChatItem[]): string[] {
  if (itemId === undefined) {
    return [];
  }
  const item = items.find((i) => i.id === itemId);
  return item === undefined
    ? []
    : item.diffs.flatMap((d) => [d.path, d.movePath ?? '']).filter((p) => p !== '');
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
    // cwdは実行時に存在するディレクトリなので、解決できないのは指定自体が無効なとき。
    // その場合は生の文字列のまま境界検査へ回す（fileChangeと違い、握り潰す経路がない）。
    const cwd = rawCwd === '' ? '' : ((await resolveRealPath(fs, rawCwd)) ?? rawCwd);
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
    const resolved = await Promise.all(rawPaths.map((p) => resolveRealPath(fs, p)));
    // 1つでも実パスへ落とせないものがあれば、そのパスを字面のまま検査しても境界の
    // 外向きリンクを見落とす。パス一覧を空にして `classifyApprovalRequest` の
    // 「変更対象のパスを取得できない＝判定に失敗」の経路（allowでは解除できない ask）へ回す。
    const paths = resolved.every((p): p is string => p !== undefined) ? resolved : [];
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
