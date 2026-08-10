/** 1ファイル分の変更。app-server の `FileUpdateChange` に対応する。 */
export interface FileDiff {
  path: string;
  /** `add` / `delete` / `update`。 */
  kind: string;
  /** 移動先。`update` で移動を伴う場合だけ入る。 */
  movePath: string | undefined;
  /** unified diff。CLIが組み立てたものをそのまま持つ。 */
  diff: string;
}

export interface ChatItem {
  id: string;
  /** app-server の ThreadItem の種類。未知の種類も捨てずに保持する。 */
  kind: string;
  /** 本文。agentMessage はデルタで伸びる。 */
  text: string;
  /** コマンド行やファイル名など、種類ごとの補足。 */
  detail: string;
  status: string | undefined;
  /** このitemが属するターン。会話内から分岐する際の `lastTurnId` になる。 */
  turnId: string | undefined;
  /** ファイル変更の差分。他の種類では空。 */
  diffs: FileDiff[];
}

/** 差分を持たない項目のための空配列。 */
export const NO_DIFFS: FileDiff[] = [];

export interface PendingApproval {
  /** JSON-RPCの要求id。応答を返すときに使う。 */
  requestId: number | string;
  /**
   * 要求の種類。応答の形がこれで決まる。
   * `applyPatch` と `execCommand` は旧形式で、decisionの語彙が他と違う。
   */
  kind: 'command' | 'fileChange' | 'permissions' | 'applyPatch' | 'execCommand';
  title: string;
  detail: string;
  /**
   * 対応する項目のid。
   *
   * ファイル変更の要求は差分を持たず、同じidの項目（`fileChange`）側に入っている。
   * 差分は要求より後に `item/fileChange/patchUpdated` で届くこともあるため、
   * 値を写さずidだけを持ち、表示のたびに項目から引く。
   */
  itemId: string | undefined;
}

export interface ChatUsage {
  /** Codex。レート制限の消費率 */
  usedPercent: number | undefined;
  /** 制限がリセットされる時刻（epoch秒）。Claude Codeは割合を返さないためこちらで示す */
  resetsAt: number | undefined;
  /** 制限の種類の表示名（`5時間` など） */
  limitLabel: string | undefined;
  /** 制限に到達しているか */
  limited: boolean | undefined;
}

/**
 * コンテキストの使用量。レート制限の消費率（`ChatUsage`）とは別物なので混ぜない。
 *
 * Codexは `thread/tokenUsage/updated` の `last`、Claude Codeは control protocol の
 * `get_context_usage` から得る。どちらも「いまコンテキストに載っている量」を表す。
 */
export interface ContextUsage {
  /** いまコンテキストに載っているトークン数。 */
  usedTokens: number;
  /** コンテキスト上限。CLIが返さないことがあるため無い場合を許す。 */
  contextWindow: number | undefined;
  /** 残りの割合（0-100の整数）。上限が判らなければ undefined。 */
  remainingPercent: number | undefined;
}

/**
 * 使用量と上限から表示用の値を作る。
 *
 * 上限が無い・0以下・使用量が負といった信用できない値では割合を出さない。
 * 誤った残量を出すくらいなら何も出さないほうがよい。
 */
export function buildContextUsage(
  usedTokens: number,
  contextWindow: number | undefined,
): ContextUsage | undefined {
  if (!Number.isFinite(usedTokens) || usedTokens < 0) {
    return undefined;
  }
  const window =
    contextWindow !== undefined && Number.isFinite(contextWindow) && contextWindow > 0
      ? contextWindow
      : undefined;
  if (window === undefined) {
    return { usedTokens, contextWindow: undefined, remainingPercent: undefined };
  }
  const remaining = Math.max(0, Math.min(100, Math.round(((window - usedTokens) / window) * 100)));
  return { usedTokens, contextWindow: window, remainingPercent: remaining };
}

export interface ChatState {
  threadId: string | undefined;
  /** Codexが会話内容から付ける要約名。ユーザーが変更することもできる。 */
  name: string | undefined;
  /** Codexが応答中かどうか。入力欄の活性制御に使う。 */
  busy: boolean;
  /** 進行中のターン。`turn/interrupt` が要求するため保持する。 */
  turnId: string | undefined;
  /**
   * 直前のターンが失敗して終わったか。
   *
   * 完了と失敗はどちらも `busy` を落とすため、それだけでは区別できない。
   * ループ実行が壊れた状態で回り続けないよう、失敗を別に持つ。
   */
  turnFailed: boolean;
  /**
   * ストリーミング中のメッセージid（Claude Codeのみ）。
   *
   * 断片の通知には message.id が入らないため、`message_start` で得た値を覚えておき、
   * 完成メッセージと同じ項目に積む。Codexは通知ごとにitemIdが来るので使わない。
   */
  streamingMessageId: string | undefined;
  /**
   * 応答中に送られた指示。ターンが終わってから順に送る。
   *
   * CLIは応答中の指示を受け取れないため、捨てずにここへ積む。
   */
  queued: string[];
  items: ChatItem[];
  approvals: PendingApproval[];
  usage: ChatUsage | undefined;
  /** コンテキストの使用量。まだ判らない間は undefined（数字を出さない）。 */
  context: ContextUsage | undefined;
  /**
   * 直前に完了/失敗したターンの応答テキスト。作業記録の成果行（`kind: 'result'`）に使う。
   * ターンが終わるたびに上書きする。
   */
  turnResultText: string;
  /**
   * 直前に完了/失敗したターンで編集したファイルパス。
   * Codexは items を turnId で辿って作るため、ここは常に turn/completed・turn/failed 時点で埋める。
   * Claude Codeは tool_use（Edit/Write/NotebookEdit）から都度積み、ターン開始時にリセットする。
   */
  turnEditedFiles: string[];
}

export const initialChatState: ChatState = {
  threadId: undefined,
  name: undefined,
  busy: false,
  turnId: undefined,
  turnFailed: false,
  streamingMessageId: undefined,
  queued: [],
  items: [],
  approvals: [],
  usage: undefined,
  context: undefined,
  turnResultText: '',
  turnEditedFiles: [],
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const numberOf = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const rec = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;

/** userMessage の content 配列からテキストを取り出す。 */
function readContentText(content: unknown): string {
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => {
      const p = rec(part);
      return p?.['type'] === 'text' ? str(p['text']) : '';
    })
    .filter((t) => t !== '')
    .join('\n');
}

/** 生の ThreadItem を表示用に正規化する。未知の種類は種類名だけ残す。 */
export function normalizeItem(raw: unknown): ChatItem | undefined {
  const item = rec(raw);
  const id = item?.['id'];
  const kind = item?.['type'];
  if (item === undefined || typeof id !== 'string' || typeof kind !== 'string') {
    return undefined;
  }

  const base: ChatItem = {
    id,
    kind,
    text: '',
    detail: '',
    status: undefined,
    turnId: undefined,
    diffs: NO_DIFFS,
  };
  const status = item['status'];
  if (typeof status === 'string') {
    base.status = status;
  }

  switch (kind) {
    case 'userMessage':
      return { ...base, text: readContentText(item['content']) };
    case 'agentMessage':
    case 'plan':
      return { ...base, text: str(item['text']) };
    case 'reasoning':
      return { ...base, text: str(item['summary']) || readContentText(item['content']) };
    case 'commandExecution': {
      const exitCode = item['exitCode'];
      return {
        ...base,
        text: str(item['aggregatedOutput']),
        detail: str(item['command']),
        status: typeof exitCode === 'number' ? `exit ${exitCode}` : base.status,
      };
    }
    case 'fileChange':
      return {
        ...base,
        detail: describeFileChanges(item['changes']),
        diffs: readFileDiffs(item['changes']),
      };
    case 'mcpToolCall':
      return { ...base, detail: `${str(item['server'])} / ${str(item['tool'])}` };
    case 'webSearch':
      return { ...base, detail: str(item['query']) };
    default:
      return base;
  }
}

/**
 * 変更の差分を取り出す。
 *
 * `diff` を持たない要素は落とす。パスだけの一覧は `describeFileChanges` が担うため、
 * ここで空の差分を残すと「開いても何も無い」表示になる。
 */
export function readFileDiffs(changes: unknown): FileDiff[] {
  if (!Array.isArray(changes)) {
    return NO_DIFFS;
  }
  const diffs: FileDiff[] = [];
  for (const raw of changes) {
    const change = rec(raw);
    const diff = str(change?.['diff']);
    const path = str(change?.['path']);
    if (change === undefined || diff === '' || path === '') {
      continue;
    }
    const kind = rec(change['kind']);
    const movePath = str(kind?.['move_path']);
    diffs.push({
      path,
      kind: str(kind?.['type']),
      movePath: movePath === '' ? undefined : movePath,
      diff,
    });
  }
  return diffs.length === 0 ? NO_DIFFS : diffs;
}

function describeFileChanges(changes: unknown): string {
  if (!Array.isArray(changes)) {
    return '';
  }
  const paths = changes
    .map((c) => {
      const change = rec(c);
      return str(change?.['path']) || str(change?.['file']);
    })
    .filter((p) => p !== '');
  return paths.join(', ');
}

/**
 * 完了したターンの応答テキストと編集ファイルを items から集める。
 * turnId が判らないと items 全体（他ターン分を含む）を拾ってしまうため、
 * その場合は何も返さない。
 */
export function summarizeTurn(
  items: readonly ChatItem[],
  turnId: string | undefined,
): { text: string; editedFiles: string[] } {
  if (turnId === undefined) {
    return { text: '', editedFiles: [] };
  }

  const turnItems = items.filter((i) => i.turnId === turnId);
  const text = turnItems
    .filter((i) => i.kind === 'agentMessage')
    .map((i) => i.text)
    .join('\n');
  const editedFiles = uniqueOrdered(
    turnItems
      .filter((i) => i.kind === 'fileChange')
      .flatMap((i) => i.detail.split(', '))
      .map((p) => p.trim())
      .filter((p) => p !== ''),
  );
  return { text, editedFiles };
}

function uniqueOrdered(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function upsertItem(items: readonly ChatItem[], item: ChatItem): ChatItem[] {
  const index = items.findIndex((i) => i.id === item.id);
  if (index === -1) {
    return [...items, item];
  }
  const existing = items[index];
  const next = [...items];
  next[index] = {
    ...item,
    // デルタで積んだ本文を、本文が空の completed で消さない
    text: item.text === '' && existing !== undefined ? existing.text : item.text,
    // turnIdは後続の通知で判ることがあるため、一度得た値を保持する
    turnId: item.turnId ?? existing?.turnId,
    // 差分は patchUpdated が先に届くことがある。空で上書きしない
    diffs: item.diffs.length === 0 && existing !== undefined ? existing.diffs : item.diffs,
  };
  return next;
}

function appendDelta(items: readonly ChatItem[], itemId: string, delta: string): ChatItem[] {
  const index = items.findIndex((i) => i.id === itemId);
  if (index === -1) {
    return [
      ...items,
      {
        id: itemId,
        kind: 'agentMessage',
        text: delta,
        detail: '',
        status: undefined,
        turnId: undefined,
        diffs: NO_DIFFS,
      },
    ];
  }
  const next = [...items];
  const existing = next[index];
  if (existing !== undefined) {
    next[index] = { ...existing, text: existing.text + delta };
  }
  return next;
}

/**
 * app-serverの通知を状態に畳み込む。
 *
 * 扱うのは `item/*` `turn/*` `thread/status/changed` と使用量のみ。
 * 未知の通知は状態を変えずに素通しする（プロトコルの追加で壊れないようにするため）。
 */
export function applyEvent(
  state: ChatState,
  method: string,
  params: Record<string, unknown>,
): ChatState {
  switch (method) {
    case 'turn/started': {
      // turnIdはトップレベルではなく turn オブジェクトの中にある（実機で確認）
      const turnId = str(rec(params['turn'])?.['id']);
      return {
        ...state,
        busy: true,
        turnId: turnId === '' ? undefined : turnId,
        turnFailed: false,
        // 前のターンの成果を次のターンへ持ち越さない
        turnResultText: '',
        turnEditedFiles: [],
      };
    }

    case 'turn/completed': {
      const summary = summarizeTurn(state.items, state.turnId);
      return {
        ...state,
        busy: false,
        turnId: undefined,
        turnFailed: false,
        turnResultText: summary.text,
        turnEditedFiles: summary.editedFiles,
      };
    }

    case 'turn/failed': {
      const summary = summarizeTurn(state.items, state.turnId);
      return {
        ...state,
        busy: false,
        turnId: undefined,
        turnFailed: true,
        turnResultText: summary.text,
        turnEditedFiles: summary.editedFiles,
      };
    }

    case 'thread/name/updated': {
      const name = params['threadName'];
      return { ...state, name: typeof name === 'string' && name !== '' ? name : undefined };
    }

    case 'thread/status/changed': {
      const status = rec(params['status']);
      return { ...state, busy: str(status?.['type']) === 'active' };
    }

    case 'item/started':
    case 'item/updated':
    case 'item/completed': {
      const item = normalizeItem(params['item']);
      if (item === undefined) {
        return state;
      }
      const turnId = str(params['turnId']);
      const withTurn = turnId === '' ? item : { ...item, turnId };
      return {
        ...state,
        // turn/started を取り逃しても中断できるよう、item側の値でも補う
        turnId: turnId === '' ? state.turnId : turnId,
        items: upsertItem(state.items, withTurn),
      };
    }

    case 'item/agentMessage/delta': {
      const itemId = str(params['itemId']);
      const delta = str(params['delta']);
      if (itemId === '' || delta === '') {
        return state;
      }
      return { ...state, items: appendDelta(state.items, itemId, delta) };
    }

    case 'account/rateLimits/updated': {
      const primary = rec(rec(params['rateLimits'])?.['primary']);
      const usedPercent = primary?.['usedPercent'];
      return {
        ...state,
        usage: {
          usedPercent: typeof usedPercent === 'number' ? usedPercent : state.usage?.usedPercent,
          resetsAt: state.usage?.resetsAt,
          limitLabel: state.usage?.limitLabel,
          limited: state.usage?.limited,
        },
      };
    }

    case 'thread/tokenUsage/updated': {
      // `total` はスレッド全体の累計。コンテキストの占有量は `last` 側で、
      // 圧縮すると（実測で 21541 → 4831 のように）そちらだけが下がる
      const tokenUsage = rec(params['tokenUsage']);
      const usedTokens = numberOf(rec(tokenUsage?.['last'])?.['totalTokens']);
      if (tokenUsage === undefined || usedTokens === undefined) {
        return state;
      }
      const context = buildContextUsage(usedTokens, numberOf(tokenUsage['modelContextWindow']));
      return context === undefined ? state : { ...state, context };
    }

    case 'item/fileChange/patchUpdated': {
      // 差分だけが後から届く。項目そのものは item/* で作られている
      const itemId = str(params['itemId']);
      const index = state.items.findIndex((i) => i.id === itemId);
      const existing = state.items[index];
      if (index === -1 || existing === undefined) {
        return state;
      }
      const diffs = readFileDiffs(params['changes']);
      if (diffs.length === 0) {
        return state;
      }
      const items = [...state.items];
      items[index] = { ...existing, diffs, detail: diffs.map((d) => d.path).join(', ') };
      return { ...state, items };
    }

    case 'serverRequest/resolved': {
      // 別のウィンドウやTUIで承認された。こちらのカードは用済み
      const requestId = params['requestId'];
      if (typeof requestId !== 'number' && typeof requestId !== 'string') {
        return state;
      }
      const next = removeApproval(state, requestId);
      return next.approvals.length === state.approvals.length ? state : next;
    }

    default:
      return state;
  }
}

/** 指示の送り先。 */
export type SendRoute =
  /** 新しいターンを始める。 */
  | 'start'
  /** 進行中のターンへ割り込む。 */
  | 'steer'
  /** 送れないので待ち行列へ積む。 */
  | 'queue';

/**
 * 応答中の指示をどう送るか決める。
 *
 * `turn/steer` は割り込む先のターンidを要求する。idが判らない場合だけ待ち行列へ回す。
 */
export function routeSend(state: ChatState): SendRoute {
  if (!state.busy) {
    return 'start';
  }
  return state.turnId === undefined ? 'queue' : 'steer';
}

/** 応答中の指示を待ち行列の末尾へ積む。 */
export function enqueue(state: ChatState, text: string): ChatState {
  if (text.trim() === '') {
    return state;
  }
  return { ...state, queued: [...state.queued, text] };
}

/** 先頭の指示を取り出す。空なら取り出さない。 */
export function takeQueued(state: ChatState): { text: string | undefined; next: ChatState } {
  const [head, ...rest] = state.queued;
  if (head === undefined) {
    return { text: undefined, next: state };
  }
  return { text: head, next: { ...state, queued: rest } };
}

/** 待機中の指示を1件取り消す。 */
export function removeQueued(state: ChatState, index: number): ChatState {
  if (index < 0 || index >= state.queued.length) {
    return state;
  }
  return { ...state, queued: state.queued.filter((_, i) => i !== index) };
}

export function clearQueue(state: ChatState): ChatState {
  return state.queued.length === 0 ? state : { ...state, queued: [] };
}

/**
 * 会話とは別に起きたことを1行残す。設定の変更のように、CLIとのやり取りの結果を
 * 見せる用途に使う。同じidで呼び直すと上書きする。
 */
export function appendNotice(state: ChatState, id: string, text: string): ChatState {
  return {
    ...state,
    items: upsertItem(state.items, {
      id,
      kind: 'settingsChanged',
      text: '',
      detail: text,
      status: undefined,
      turnId: undefined,
      diffs: NO_DIFFS,
    }),
  };
}

export function addApproval(state: ChatState, approval: PendingApproval): ChatState {
  return { ...state, approvals: [...state.approvals, approval] };
}

export function removeApproval(state: ChatState, requestId: number | string): ChatState {
  return { ...state, approvals: state.approvals.filter((a) => a.requestId !== requestId) };
}
