import type { PendingApproval } from './chatState';

/** UIに出す選択肢。protocolのdecision値に対応する。 */
export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export const APPROVAL_METHODS = {
  command: 'item/commandExecution/requestApproval',
  fileChange: 'item/fileChange/requestApproval',
  permissions: 'item/permissions/requestApproval',
} as const;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * 承認要求を表示用に整える。
 * 未知の要求でも「何を求められているか」だけは出せるようにする。
 */
export function describeApproval(
  requestId: number | string,
  method: string,
  params: Record<string, unknown>,
): PendingApproval | undefined {
  if (method === APPROVAL_METHODS.command) {
    const command = str(params['command']);
    const cwd = str(params['cwd']);
    return {
      requestId,
      kind: 'command',
      title: 'コマンドの実行を許可しますか',
      detail: [command, cwd === '' ? '' : `(${cwd})`].filter((s) => s !== '').join('\n'),
    };
  }

  if (method === APPROVAL_METHODS.fileChange) {
    return {
      requestId,
      kind: 'fileChange',
      title: 'ファイルの変更を許可しますか',
      detail: describeChanges(params['changes']) || str(params['reason']),
    };
  }

  if (method === APPROVAL_METHODS.permissions) {
    return {
      requestId,
      kind: 'permissions',
      title: '権限の昇格を許可しますか',
      detail: str(params['reason']),
    };
  }

  return undefined;
}

function describeChanges(changes: unknown): string {
  if (!Array.isArray(changes)) {
    return '';
  }
  return changes
    .map((c) => {
      const change = typeof c === 'object' && c !== null ? (c as Record<string, unknown>) : {};
      return str(change['path']) || str(change['file']);
    })
    .filter((p) => p !== '')
    .join('\n');
}

/**
 * 決定を応答の形に変換する。
 * 権限要求は形が異なり、許可＝要求された権限をそのまま与える。
 */
export function buildApprovalResponse(
  kind: PendingApproval['kind'],
  decision: ApprovalDecision,
  params: Record<string, unknown>,
): unknown {
  if (kind !== 'permissions') {
    return { decision };
  }

  if (decision === 'accept' || decision === 'acceptForSession') {
    return {
      permissions: params['permissions'] ?? {},
      scope: decision === 'acceptForSession' ? 'session' : 'turn',
    };
  }
  return { permissions: {}, scope: 'turn' };
}

/** ユーザーに聞けない要求への既定応答。拒否側に倒す。 */
export function defaultDenyResponse(method: string): unknown {
  if (method === APPROVAL_METHODS.permissions) {
    return { permissions: {}, scope: 'turn' };
  }
  return { decision: 'decline' };
}
