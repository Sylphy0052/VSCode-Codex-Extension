import type { PendingApproval } from './chatState';

/** UIに出す選択肢。protocolのdecision値に対応する。 */
export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

const APPROVAL_DECISIONS: readonly ApprovalDecision[] = [
  'accept',
  'acceptForSession',
  'decline',
  'cancel',
];

/**
 * Webviewから届いた値が `ApprovalDecision` として妥当かをホワイトリストで確かめる。
 *
 * Webviewは信頼境界の外側（`chatView.ts` / `claudeChatView.ts` / `workflowView.ts` の
 * `postMessage` ハンドラは全て同じ理由でここを通す）。`typeof value === 'string'` だけの
 * チェックでは、任意の文字列がそのまま `buildApprovalResponse` を経由してapp-serverへの
 * 応答（`{ decision }`）に載る。`command` / `fileChange` 種別はdecisionの値を検証せず
 * そのまま応答へ埋め込むため、境界（この関数の呼び出し側）で弾かないと未知の値が
 * app-serverまで届いてしまう（レビュー指摘: medium 1）。
 */
export function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return typeof value === 'string' && (APPROVAL_DECISIONS as readonly string[]).includes(value);
}

/**
 * app-serverがこちらへ投げてくる要求。
 *
 * `codex app-server generate-json-schema` の ServerRequest がこの10種で、
 * **すべてに応答を返さないとapp-serverは待ち続ける**。
 * 応答の形は要求ごとに違うので、揃っていない値を返すと相手側で失敗する。
 */
export const SERVER_REQUEST_METHODS = {
  /** 承認カードに出す。応答は `{ decision }` */
  command: 'item/commandExecution/requestApproval',
  fileChange: 'item/fileChange/requestApproval',
  /** 応答は `{ permissions, scope }` */
  permissions: 'item/permissions/requestApproval',
  /** 旧形式。応答は `{ decision: ReviewDecision }` で語彙が異なる */
  applyPatch: 'applyPatchApproval',
  execCommand: 'execCommandApproval',
  /** ツールからユーザーへの問い合わせ。応答は `{ answers: { <questionId>: { answers } } }` */
  requestUserInput: 'item/tool/requestUserInput',
  /** MCPサーバからの入力要求。応答は `{ action, content? }` */
  elicitation: 'mcpServer/elicitation/request',
  /** クライアント側でツールを実行させる要求。応答は `{ success, contentItems }` */
  toolCall: 'item/tool/call',
  /** 応答に `token` が要る。こちらでは作れない */
  attestation: 'attestation/generate',
  /** 応答に `accessToken` と `chatgptAccountId` が要る。こちらでは作れない */
  authTokensRefresh: 'account/chatgptAuthTokens/refresh',
} as const;

/** 承認カードに出せる要求。以前からある3種の別名を保つ。 */
export const APPROVAL_METHODS = {
  command: SERVER_REQUEST_METHODS.command,
  fileChange: SERVER_REQUEST_METHODS.fileChange,
  permissions: SERVER_REQUEST_METHODS.permissions,
  applyPatch: SERVER_REQUEST_METHODS.applyPatch,
  execCommand: SERVER_REQUEST_METHODS.execCommand,
} as const;

/**
 * 承認要求が別の経路で解決されたことを知らせる通知。
 *
 * 同じスレッドを別のウィンドウやTUIでも開いている場合、そちらの承認でこちらの
 * カードが宙に浮く。この通知で取り下げる。
 */
export const SERVER_REQUEST_RESOLVED = 'serverRequest/resolved';

/** 拒否をCodexへ伝える文言。ReviewDecisionの `denied` はrejectionを要求する。 */
const REJECTION = 'ユーザーが拒否しました';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const rec = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/**
 * 承認要求を表示用に整える。
 * 承認カードに出せない要求は undefined を返す（勝手に許可しないため）。
 */
export function describeApproval(
  requestId: number | string,
  method: string,
  params: Record<string, unknown>,
): PendingApproval | undefined {
  if (method === APPROVAL_METHODS.command) {
    return {
      requestId,
      kind: 'command',
      title: 'コマンドの実行を許可しますか',
      detail: withCwd(str(params['command']), str(params['cwd'])),
      itemId: undefined,
    };
  }

  if (method === APPROVAL_METHODS.fileChange) {
    // この要求は変更内容を持たない（itemId / threadId / turnId / startedAtMs / reason だけ）。
    // 差分は同じidの項目側にあるため、idを渡して表示のときに引く
    return {
      requestId,
      kind: 'fileChange',
      title: 'ファイルの変更を許可しますか',
      detail: str(params['reason']),
      itemId: str(params['itemId']) || undefined,
    };
  }

  if (method === APPROVAL_METHODS.permissions) {
    // 理由の文章だけでは何を許可するのか分からない。許可対象（ネットワーク・パス）を
    // 要求から読んで並べ、応答（buildApprovalResponse）も同じ読み取り結果から作る
    return {
      requestId,
      kind: 'permissions',
      title: '権限の昇格を許可しますか',
      detail: withCwd(
        describePermissionDetail(
          str(params['reason']),
          summarizePermissions(params['permissions']),
        ),
        str(params['cwd']),
      ),
      itemId: undefined,
    };
  }

  // 旧形式。paramsの形が新しい要求と違うため、取り出し方を分ける
  if (method === APPROVAL_METHODS.applyPatch) {
    return {
      requestId,
      kind: 'applyPatch',
      title: 'ファイルの変更を許可しますか',
      detail: describeFileChangeMap(params['fileChanges']) || str(params['reason']),
      itemId: undefined,
    };
  }

  if (method === APPROVAL_METHODS.execCommand) {
    return {
      requestId,
      kind: 'execCommand',
      title: 'コマンドの実行を許可しますか',
      detail: withCwd(joinCommand(params['command']), str(params['cwd'])),
      itemId: undefined,
    };
  }

  return undefined;
}

function withCwd(command: string, cwd: string): string {
  return [command, cwd === '' ? '' : `(${cwd})`].filter((s) => s !== '').join('\n');
}

/** 権限要求（`RequestPermissionProfile`）を読んだ結果。表示と応答の両方をここから作る。 */
export interface PermissionSummary {
  /** 画面に出す行。空なら追加の権限は無い。 */
  lines: string[];
  /** 応答へ載せる権限。読み取れて表示した項目だけを持つ。 */
  granted: Record<string, unknown>;
  /** 読み取れなかった項目のキー。表示で明示し、応答へは載せない。 */
  unreadable: string[];
}

const ACCESS_LABELS: Record<string, string> = {
  read: '読み取り',
  write: '書き込み',
  deny: 'アクセス禁止',
};

/**
 * 権限要求の `permissions` を、許可対象の一覧と応答用の権限へ分ける。
 *
 * 形は Codex CLI 0.154.0 の `RequestPermissionProfile`（`network.enabled` と
 * `fileSystem.read` / `write` / `entries`）。この関数が読めた項目だけを `granted` に
 * 写すため、承認カードに出ていない権限が応答に混ざらない。未知の項目や形の違う
 * 項目は `unreadable` に名前だけ残し、許可の対象から外す（issue #1184）。
 */
export function summarizePermissions(permissions: unknown): PermissionSummary {
  const profile = rec(permissions);
  if (profile === undefined) {
    const absent = permissions === undefined || permissions === null;
    return { lines: [], granted: {}, unreadable: absent ? [] : ['permissions'] };
  }
  const lines: string[] = [];
  const granted: Record<string, unknown> = {};
  const unreadable: string[] = [];
  for (const key of Object.keys(profile)) {
    const value = profile[key];
    if (value === null || value === undefined) {
      continue;
    }
    if (key === 'network') {
      const enabled = rec(value)?.['enabled'];
      if (enabled !== null && enabled !== undefined && typeof enabled !== 'boolean') {
        unreadable.push(key);
        continue;
      }
      if (enabled === true) {
        lines.push('ネットワーク接続: 許可');
      } else if (enabled === false) {
        lines.push('ネットワーク接続: 禁止');
      }
      granted[key] = { enabled: enabled ?? null };
      continue;
    }
    if (key === 'fileSystem') {
      const fs = summarizeFileSystem(value);
      if (fs === undefined) {
        unreadable.push(key);
        continue;
      }
      lines.push(...fs.lines);
      granted[key] = fs.granted;
      continue;
    }
    unreadable.push(key);
  }
  return { lines, granted, unreadable };
}

/** `AdditionalFileSystemPermissions`。1項目でも読めなければ全体を読めない扱いにする。 */
function summarizeFileSystem(
  value: unknown,
): { lines: string[]; granted: Record<string, unknown> } | undefined {
  const fs = rec(value);
  if (fs === undefined) {
    return undefined;
  }
  const lines: string[] = [];
  const granted: Record<string, unknown> = {};
  for (const key of Object.keys(fs)) {
    const v = fs[key];
    if (v === null || v === undefined) {
      // `read` / `write` はnull必須の項目。受け取った形のまま返す
      granted[key] = v;
      continue;
    }
    if (key === 'read' || key === 'write') {
      if (!Array.isArray(v) || !v.every((p) => typeof p === 'string')) {
        return undefined;
      }
      lines.push(...v.map((p) => `${ACCESS_LABELS[key]}: ${p}`));
      granted[key] = v;
      continue;
    }
    if (key === 'entries') {
      if (!Array.isArray(v)) {
        return undefined;
      }
      const entries = v.map(describeSandboxEntry);
      if (entries.some((e) => e === undefined)) {
        return undefined;
      }
      lines.push(...(entries as string[]));
      granted[key] = v;
      continue;
    }
    if (key === 'globScanMaxDepth' && typeof v === 'number') {
      granted[key] = v;
      continue;
    }
    return undefined;
  }
  return { lines, granted };
}

/** `FileSystemSandboxEntry` を「アクセス種別: パス」の1行にする。 */
function describeSandboxEntry(entry: unknown): string | undefined {
  const e = rec(entry);
  const access = str(e?.['access']);
  const label = ACCESS_LABELS[access];
  const path = describeFileSystemPath(e?.['path']);
  return label === undefined || path === undefined ? undefined : `${label}: ${path}`;
}

/** `FileSystemPath`。特別なパスは語で示し、知らない種類は読めない扱いにする。 */
function describeFileSystemPath(value: unknown): string | undefined {
  const p = rec(value);
  switch (str(p?.['type'])) {
    case 'path':
      return str(p?.['path']) || undefined;
    case 'glob_pattern':
      return str(p?.['pattern']) || undefined;
    case 'special': {
      const special = rec(p?.['value']);
      const subpath = str(special?.['subpath']);
      const withSub = (base: string): string => (subpath === '' ? base : `${base}/${subpath}`);
      switch (str(special?.['kind'])) {
        case 'root':
          return 'ルート（/ 以下すべて）';
        case 'minimal':
          return '最小構成';
        case 'project_roots':
          return withSub('プロジェクトルート');
        case 'tmpdir':
          return '一時ディレクトリ';
        case 'slash_tmp':
          return '/tmp';
        case 'unknown':
          return str(special?.['path']) === '' ? undefined : withSub(str(special?.['path']));
        default:
          return undefined;
      }
    }
    default:
      return undefined;
  }
}

/** 理由と許可対象を承認カードの本文にまとめる。 */
function describePermissionDetail(reason: string, summary: PermissionSummary): string {
  const lines = reason === '' ? [] : [reason];
  lines.push(...(summary.lines.length === 0 ? ['許可する対象: なし'] : summary.lines));
  if (summary.unreadable.length > 0) {
    lines.push(
      `内容を読み取れない項目（許可しても付与しません）: ${summary.unreadable.join(', ')}`,
    );
  }
  return lines.join('\n');
}

/** 旧形式のコマンドは配列で届く。 */
function joinCommand(command: unknown): string {
  if (typeof command === 'string') {
    return command;
  }
  if (!Array.isArray(command)) {
    return '';
  }
  return command.filter((part): part is string => typeof part === 'string').join(' ');
}

/** 旧形式の変更はパスをキーにしたオブジェクトで届く。 */
function describeFileChangeMap(fileChanges: unknown): string {
  const changes = rec(fileChanges);
  return changes === undefined ? '' : Object.keys(changes).join('\n');
}

/**
 * 決定を応答の形に変換する。
 *
 * 要求ごとに語彙が違う。権限要求は decision を持たず、旧形式は ReviewDecision の語彙を使う。
 */
export function buildApprovalResponse(
  kind: PendingApproval['kind'],
  decision: ApprovalDecision,
  params: Record<string, unknown>,
): unknown {
  if (kind === 'permissions') {
    if (decision === 'accept' || decision === 'acceptForSession') {
      // 承認カードに出した分だけを許可する。読み取れなかった項目は表示できておらず、
      // 利用者が同意した内容に含まれないため応答へ載せない（issue #1184）
      return {
        permissions: summarizePermissions(params['permissions']).granted,
        scope: decision === 'acceptForSession' ? 'session' : 'turn',
      };
    }
    return { permissions: {}, scope: 'turn' };
  }

  if (kind === 'applyPatch' || kind === 'execCommand') {
    return { decision: reviewDecision(decision) };
  }

  return { decision };
}

/** 旧形式の応答に使う ReviewDecision。 */
function reviewDecision(decision: ApprovalDecision): unknown {
  switch (decision) {
    case 'accept':
      return 'approved';
    case 'acceptForSession':
      return 'approved_for_session';
    case 'cancel':
      // 中断。次の指示まで何もさせない
      return 'abort';
    default:
      return { denied: { rejection: REJECTION } };
  }
}

/**
 * ユーザーに聞けない要求への既定応答。拒否側に倒す。
 *
 * 応答の値を組み立てられない要求では undefined を返す。呼び出し側はJSON-RPCの
 * エラーで応答すること。**黙って返さないとapp-serverが待ち続ける**。
 */
export function defaultDenyResponse(
  method: string,
  params: Record<string, unknown>,
): unknown | undefined {
  switch (method) {
    case SERVER_REQUEST_METHODS.command:
    case SERVER_REQUEST_METHODS.fileChange:
      return { decision: 'decline' };

    case SERVER_REQUEST_METHODS.permissions:
      return { permissions: {}, scope: 'turn' };

    case SERVER_REQUEST_METHODS.applyPatch:
    case SERVER_REQUEST_METHODS.execCommand:
      return { decision: { denied: { rejection: REJECTION } } };

    case SERVER_REQUEST_METHODS.requestUserInput:
      // 質問には答えられないが、idを揃えた空の回答なら形が合う
      return { answers: emptyAnswers(params['questions']) };

    case SERVER_REQUEST_METHODS.elicitation:
      return { action: 'decline' };

    case SERVER_REQUEST_METHODS.toolCall:
      return {
        success: false,
        contentItems: [{ type: 'inputText', text: 'この拡張機能はツールを実行できません' }],
      };

    default:
      // attestation/generate と account/chatgptAuthTokens/refresh を含む。
      // 値を捏造すると認証や検証が誤って通るため、応答しない
      return undefined;
  }
}

function emptyAnswers(questions: unknown): Record<string, { answers: string[] }> {
  if (!Array.isArray(questions)) {
    return {};
  }
  const answers: Record<string, { answers: string[] }> = {};
  for (const question of questions) {
    const id = str(rec(question)?.['id']);
    if (id !== '') {
      answers[id] = { answers: [] };
    }
  }
  return answers;
}
