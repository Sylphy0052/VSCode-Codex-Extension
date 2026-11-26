import type { SessionSummary } from '../codex/types';
import { formatSessionTarget } from '../orchestrator/sessionBridge';
import { sanitizeInlineText } from '../orchestrator/untrustedText';
import type {
  McHistoryItem,
  McLifecycleOp,
  McLifecycleOutcome,
  McProvider,
  McSession,
  McTarget,
} from '../webview/missionControl/protocol';
import type { McRepoResolver } from './missionControlModel';
import { parseTarget } from './sessionControlMessage';

/**
 * Mission Controlからのセッションのライフサイクル操作と履歴（Issue #2149の1・3）。
 * vscodeに依らない部分。
 *
 * webviewは信頼境界の外側として扱う。宛先は形を確かめ、今の一覧に載っているものだけを
 * 操作する。確認（deleteと、実行中のセッションを止める操作）は拡張ホストが出す。
 */

/** 1回の操作でまとめて扱うセッションの上限。 */
export const MAX_LIFECYCLE_TARGETS = 100;
/** 確認の文に名前を並べる件数。残りは件数だけ出す。 */
const CONFIRM_LIST_MAX = 5;
/** 確認の文に出すタイトル1件の長さの上限（文字数）。 */
const CONFIRM_TITLE_MAX_CHARS = 80;

const LIFECYCLE_OPS: readonly McLifecycleOp[] = ['close', 'archive', 'delete'];

export function isLifecycleOp(value: unknown): value is McLifecycleOp {
  return typeof value === 'string' && (LIFECYCLE_OPS as readonly string[]).includes(value);
}

export const LIFECYCLE_LABELS: Record<McLifecycleOp, string> = {
  close: '閉じる',
  archive: 'archive',
  delete: '削除',
};

/** archive・deleteに対応しないprovider。Claude Codeにはarchiveの仕組みが無い。 */
export const LIFECYCLE_UNSUPPORTED_MESSAGE =
  'Claudeのセッションはarchive・deleteに対応していません（閉じるだけできます）';

export function supportsArchive(provider: McProvider): boolean {
  return provider === 'codex';
}

/** webviewから届いたライフサイクル操作の要求を確かめる。不正なら理由の文を返す。 */
export function parseLifecycleRequest(
  message: Record<string, unknown>,
): { op: McLifecycleOp; targets: McTarget[] } | string {
  if (!isLifecycleOp(message.op)) {
    return '操作の種類が正しくありません';
  }
  const raw = message.targets;
  if (!Array.isArray(raw) || raw.length === 0) {
    return '対象のセッションがありません';
  }
  if (raw.length > MAX_LIFECYCLE_TARGETS) {
    return `一度に操作できるのは${String(MAX_LIFECYCLE_TARGETS)}件までです`;
  }
  const targets: McTarget[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const target =
      typeof item === 'object' && item !== null
        ? parseTarget(item as Record<string, unknown>)
        : undefined;
    if (target === undefined) {
      return '対象のセッションが正しくありません';
    }
    const key = `${target.windowId}|${target.provider}|${target.threadId}`;
    if (!seen.has(key)) {
      seen.add(key);
      targets.push(target);
    }
  }
  return { op: message.op, targets };
}

/** 確認の文を作るのに要る、一覧上のセッションの情報。 */
export interface LifecycleSessionInfo {
  title: string;
  /** ターンの途中か（承認待ち・裏で実行中を含む）。止めるなら確認を出す。 */
  running: boolean;
}

export interface LifecycleConfirmation {
  message: string;
  /** 実行するボタンの文言。 */
  button: string;
}

/**
 * 確認が要るなら、その文を返す。deleteは取り消せないので必ず確認する。closeとarchiveは
 * 取り消せる（archiveは履歴から解除できる）が、実行中のセッションはプロセスを止めるので
 * 確認する（archiveも先に会話を閉じる）。
 */
export function lifecycleConfirmation(
  op: McLifecycleOp,
  sessions: readonly LifecycleSessionInfo[],
): LifecycleConfirmation | undefined {
  const names = (list: readonly LifecycleSessionInfo[]): string => {
    // タイトルは外部由来。改行を残すと、確認文の中に偽の行（件数・対象）を書き足せる
    const shown = list
      .slice(0, CONFIRM_LIST_MAX)
      .map((s) => `・${sanitizeInlineText(s.title, CONFIRM_TITLE_MAX_CHARS)}`);
    const rest = list.length - shown.length;
    return [...shown, ...(rest > 0 ? [`ほか${String(rest)}件`] : [])].join('\n');
  };
  const running = sessions.filter((s) => s.running);
  if (op === 'delete') {
    const note =
      running.length > 0 ? `\n実行中の${String(running.length)}件はプロセスを止めます。` : '';
    return {
      message: `${String(sessions.length)}件のセッションを完全に削除します。元に戻せません。${note}\n${names(sessions)}`,
      button: '削除する',
    };
  }
  if (running.length === 0) {
    return undefined;
  }
  const verb = op === 'close' ? '閉じる' : 'archiveする';
  return {
    message: `実行中のセッションが${String(running.length)}件あります。${verb}とプロセスを止めます。\n${names(running)}`,
    button: op === 'close' ? '止めて閉じる' : '止めてarchiveする',
  };
}

export interface McLifecycleDeps {
  /** 今の一覧に載っていれば、その情報。載っていなければ`undefined`。 */
  describe(target: McTarget): (LifecycleSessionInfo & { provider: McProvider }) | undefined;
  /** モーダルの確認。実行してよければ`true`。 */
  confirm(confirmation: LifecycleConfirmation): Promise<boolean>;
  /** 宛先のウィンドウで1件を実行する（自ウィンドウか、session-hub経由か）。 */
  dispatch(
    target: McTarget,
    op: McLifecycleOp,
  ): Promise<{ ok: boolean; error?: string | undefined }>;
}

export type McLifecycleRunResult =
  { cancelled: true } | { cancelled: false; outcomes: McLifecycleOutcome[] };

/**
 * 複数のセッションへ同じ操作を行う。一覧に無いもの・対応しないものは実行せず理由を返す。
 * archive・deleteはCLIを1件ずつ起動するため、並べずに順に流す。
 */
export async function runLifecycle(
  op: McLifecycleOp,
  targets: readonly McTarget[],
  deps: McLifecycleDeps,
): Promise<McLifecycleRunResult> {
  const outcomes: McLifecycleOutcome[] = [];
  const runnable: Array<{ target: McTarget; info: LifecycleSessionInfo }> = [];
  for (const target of targets) {
    const info = deps.describe(target);
    if (info === undefined) {
      outcomes.push({ target, ok: false, error: 'このセッションは一覧にありません' });
    } else if (op !== 'close' && !supportsArchive(info.provider)) {
      outcomes.push({ target, ok: false, error: LIFECYCLE_UNSUPPORTED_MESSAGE });
    } else {
      runnable.push({ target, info });
    }
  }
  if (runnable.length === 0) {
    return { cancelled: false, outcomes };
  }
  const confirmation = lifecycleConfirmation(
    op,
    runnable.map((r) => r.info),
  );
  if (confirmation !== undefined && !(await deps.confirm(confirmation))) {
    return { cancelled: true };
  }
  for (const { target } of runnable) {
    try {
      const result = await deps.dispatch(target, op);
      outcomes.push({ target, ok: result.ok, error: result.error });
    } catch (e: unknown) {
      outcomes.push({ target, ok: false, error: `操作に失敗しました: ${String(e)}` });
    }
  }
  return { cancelled: false, outcomes };
}

/** 結果をまとめた1文（トーストに出す）。 */
export function summarizeOutcomes(
  op: McLifecycleOp,
  outcomes: readonly McLifecycleOutcome[],
): string {
  const ok = outcomes.filter((o) => o.ok).length;
  const failed = outcomes.filter((o) => !o.ok);
  const label = LIFECYCLE_LABELS[op];
  if (failed.length === 0) {
    return `${String(ok)}件を${label === '閉じる' ? '閉じました' : `${label}しました`}`;
  }
  const reason = failed[0]?.error ?? '理由は不明';
  return `${String(ok)}件成功、${String(failed.length)}件失敗（${reason}）`;
}

/** 履歴に出す件数の上限。 */
export const MAX_HISTORY_ITEMS = 500;

/**
 * 一覧（`thread/list`由来。archive済みを含まない）へ、archive済みのセッションを重ねる。
 * 同じセッションが両方にあれば一覧の方を残す。
 */
export function mergeArchivedSessions(
  listed: readonly SessionSummary[],
  archived: readonly SessionSummary[],
): SessionSummary[] {
  const seen = new Set(listed.map((s) => `${s.provider}|${s.id}`));
  return [...listed, ...archived.filter((s) => !seen.has(`${s.provider}|${s.id}`))];
}

/** 履歴（`SessionSummary`）を画面の形へ変える。新しい順に並べる。 */
export function toHistoryItems(
  sessions: readonly SessionSummary[],
  resolveRepo: McRepoResolver,
): McHistoryItem[] {
  const items: McHistoryItem[] = [];
  for (const session of sessions) {
    if (session.provider !== 'codex' && session.provider !== 'claude') {
      continue;
    }
    const repo = resolveRepo(session.cwd);
    const updatedAt = Date.parse(session.updatedAt);
    items.push({
      provider: session.provider,
      threadId: session.id,
      title: session.threadName ?? '(名称未設定)',
      repoKey: repo.key,
      repoLabel: repo.label,
      cwdFull: session.cwd ?? '',
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
      archived: session.archived,
    });
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return items.slice(0, MAX_HISTORY_ITEMS);
}

/** 既読の要求を送り直すまでの間隔（ms）。宛先のウィンドウの書き込みが届くまで連打しない。 */
export const MARK_READ_RETRY_MS = 5_000;

/**
 * Mission Controlの詳細ペインで表示したセッションの既読（Issue #2171）。
 *
 * 未読の印は会話を持つウィンドウが立て、共有ファイル経由で全ウィンドウへ伝わる。詳細ペインで
 * 未読のセッションを表示したら、そのウィンドウへ`markRead`を送る。スナップショットは250msごとに
 * 作り直すので、印が下がったのが伝わるまでの間は同じ要求を重ねて送らない。
 */
export class ReadMarker {
  private readonly requested = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** 既読の要求を送るべきなら`true`を返し、送ったものとして覚える。 */
  take(
    sessions: ReadonlyArray<Pick<McSession, 'key' | 'unread'>> | undefined,
    target: McTarget | undefined,
  ): boolean {
    if (sessions === undefined || target === undefined) {
      return false;
    }
    const key = formatSessionTarget(target);
    const session = sessions.find((s) => s.key === key);
    if (session?.unread !== true) {
      this.requested.delete(key);
      return false;
    }
    const at = this.now();
    const last = this.requested.get(key);
    if (last !== undefined && at - last < MARK_READ_RETRY_MS) {
      return false;
    }
    this.requested.set(key, at);
    return true;
  }
}
