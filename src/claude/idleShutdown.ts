/**
 * 使っていないClaudeタブのCLIを終了し、次の送信で`--resume`する仕組み（Issue #1808）の、
 * vscodeにもプロセスにも依存しない判定と文面。
 */

/** `system`/`init`イベントの`mcp_servers`の1件。 */
export interface InitMcpServer {
  name: string;
  status: string;
}

/**
 * `system`/`init`イベントから`mcp_servers`を読む。initでないイベントには`undefined`を返す。
 *
 * initは毎ターンの始めに届く（`streamJson.ts`の`applySystem`）。終了前と再開後の接続状態を
 * 比べるため、最後に見た一覧を覚えておくのに使う。
 */
export function readInitMcpServers(event: Record<string, unknown>): InitMcpServer[] | undefined {
  if (event['type'] !== 'system' || event['subtype'] !== 'init') {
    return undefined;
  }
  const raw = event['mcp_servers'];
  if (!Array.isArray(raw)) {
    return [];
  }
  const servers: InitMcpServer[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const name = record['name'];
    const status = record['status'];
    if (typeof name === 'string' && name !== '') {
      servers.push({ name, status: typeof status === 'string' ? status : 'unknown' });
    }
  }
  return servers;
}

/**
 * 再開後のMCPの接続状態を、タブへ残す1行にする。
 *
 * 終了前に`connected`だったのに再開後は`connected`でないサーバ（一覧から消えたものを含む）を
 * 先に並べ、問題が無ければそう書く。終了前の一覧が無い（1ターンも走っていない）ときは、
 * 再開後の状態だけを並べる。
 */
export function describeResumedMcp(
  before: readonly InitMcpServer[] | undefined,
  after: readonly InitMcpServer[],
): string {
  const afterByName = new Map(after.map((s) => [s.name, s.status]));
  const lost = (before ?? [])
    .filter((s) => s.status === 'connected' && afterByName.get(s.name) !== 'connected')
    .map((s) => `${s.name}（${afterByName.get(s.name) ?? '一覧に無い'}）`);
  const current =
    after.length === 0 ? 'なし' : after.map((s) => `${s.name}: ${s.status}`).join(', ');
  if (lost.length > 0) {
    return `再開後、終了前に接続していたMCPサーバへ接続できていません: ${lost.join(', ')}。現在の状態: ${current}`;
  }
  return `再開後のMCPサーバの接続状態: ${current}`;
}

/** タブのCLIを終了してよいかの材料のうち、view層が持つもの。 */
export interface IdleShutdownBlockers {
  /** 設定`agent.claude.idleShutdownMinutes`。0以下なら終了しない。 */
  minutes: number;
  disposed: boolean;
  /** ワークフロー・オーケストレータモードの工程として動いているタブ。 */
  taskManaged: boolean;
  loopRunning: boolean;
  /** 自動引き継ぎ・手動引き継ぎの途中。 */
  handoffInProgress: boolean;
  /** 自動返信の1往復の途中。 */
  autoReplyInFlight: boolean;
  /** 上限解除後の自動続行を予約している。 */
  limitAutoResumePending: boolean;
  /** セッション側の判定（`ClaudeStreamSession.idleForSuspend`）。 */
  sessionIdle: boolean;
}

/** 終了してよいか。待っている間に状態が変わることがあるため、終了の直前にもう一度呼ぶ。 */
export function canShutdownIdle(b: IdleShutdownBlockers): boolean {
  return (
    b.minutes > 0 &&
    !b.disposed &&
    !b.taskManaged &&
    !b.loopRunning &&
    !b.handoffInProgress &&
    !b.autoReplyInFlight &&
    !b.limitAutoResumePending &&
    b.sessionIdle
  );
}

/**
 * 設定の生値を分へ丸める。数でない値は既定（30分）、0以下は0（機能を切る）、上限超えは上限へ倒す。
 */
export function normalizeIdleShutdownMinutes(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return DEFAULT_IDLE_SHUTDOWN_MINUTES;
  }
  if (raw <= 0) {
    return 0;
  }
  return Math.min(raw, MAX_IDLE_SHUTDOWN_MINUTES);
}

export const DEFAULT_IDLE_SHUTDOWN_MINUTES = 30;

/** 1日。`setTimeout`の上限（約24.8日）より十分小さく、package.jsonの`maximum`と揃える。 */
export const MAX_IDLE_SHUTDOWN_MINUTES = 1440;
