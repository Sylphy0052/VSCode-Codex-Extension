/**
 * メッセージング用MCPツールの実利用率を数える（Issue #1324 受入基準1）。
 *
 * このファイルはVSCode APIへ依存しない（`messaging.ts`・`promptMetrics.ts`と同じ方針）。
 * 数えるだけで、どのツールを見せるか（`visibleTools`）には一切影響しない。
 *
 * 目的は「30個近いツールのうち、実際に呼ばれているのはどれか」を実運用のrunで測ること。
 * ここで集めた値を見てから、接続種別・フェーズごとのallowlist（受入基準2）を決める。
 * 実測なしにツールを落とすと勘で削ることになるため、第1段はこの計測だけに絞る。
 *
 * 計測は既定で無効（`agent.orchestrator.toolUsageMetrics.enabled`）。有効にしても
 * ツール呼び出しの結果は変わらない。
 */

/**
 * 1つの接続（taskId）で数えた呼び出し回数。ツール名 → 回数。
 */
export interface ToolUsageCounts {
  /** 接続の識別子。オーケストレーター接続は`ORCHESTRATOR_CONNECTION_ID`。 */
  taskId: string;
  /** 呼び出し回数の合計。 */
  total: number;
  /** ツール名ごとの回数。回数の降順、同数なら名前の昇順。 */
  byTool: { name: string; count: number }[];
}

/**
 * 1つの`MessagingMcpServer`（＝1run）ぶんの呼び出し回数を保持する。
 *
 * `MessagingMcpServer`側は`ToolUsageMetricsPort.record`しか知らない（`messaging.ts`の
 * `DispatchErrorLogPort`と同じ「外部依存はportの向こうに置く」流儀）。集計と保持は
 * こちら側の責務にして、`messaging.ts`へ状態を増やさない。
 */
export class ToolUsageCounter {
  private readonly counts = new Map<string, Map<string, number>>();

  /**
   * ツール名ごとに保持する上限（1接続あたり）。
   *
   * 呼び出し側がツール名を自由に名乗れる（未知の名前でも`handleToolCall`の入口は通る）ため、
   * 上限が無いと1接続からの繰り返し呼び出しでMapが無制限に増える。`messaging.ts`の
   * `MAX_DISPATCH_ERROR_LOGS`と同じ「件数上限」の規律に揃える。実在するツールは29個なので、
   * 実運用の集計がこの上限に当たることはない。
   */
  private static readonly MAX_TOOL_NAMES_PER_TASK = 64;

  /**
   * 1回の呼び出しを数える。未知のツール名でも、上限内なら区別して数える
   * （「AIが存在しない道具を呼ぼうとしている」こと自体が判断材料になる）。
   */
  record(taskId: string, toolName: string): void {
    let byTool = this.counts.get(taskId);
    if (byTool === undefined) {
      byTool = new Map<string, number>();
      this.counts.set(taskId, byTool);
    }
    const current = byTool.get(toolName);
    if (current === undefined && byTool.size >= ToolUsageCounter.MAX_TOOL_NAMES_PER_TASK) {
      return;
    }
    byTool.set(toolName, (current ?? 0) + 1);
  }

  /** 何も数えていなければ`true`（出力する行が無い）。 */
  isEmpty(): boolean {
    return this.counts.size === 0;
  }

  /**
   * 接続ごとの集計を取り出す。接続の並びはtaskIdの昇順（runごとに1回しか出さないため、
   * 出力の順が実行のタイミングで揺れないようにする）。
   */
  snapshot(): ToolUsageCounts[] {
    return [...this.counts.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([taskId, byTool]) => ({
        taskId,
        total: [...byTool.values()].reduce((sum, n) => sum + n, 0),
        byTool: [...byTool.entries()]
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      }));
  }
}

/**
 * 出力パネルへ出す1行を組み立てる（`promptMetrics.ts`の`formatPromptMetricsLine`と同じ発想）。
 *
 * 1接続1行に収める。パネルを眺めるだけで「この接続はどの道具を何回使ったか」が読めるように、
 * 回数の多い順にツール名を並べる。1度も呼ばれなかったツールは行に出さない（出さないこと
 * 自体が「使われていない」という答えになる。全29個を毎行並べると読めなくなる）。
 */
export function formatToolUsageMetricsLine(runId: string, counts: ToolUsageCounts): string {
  const tools = counts.byTool.map((t) => `${t.name}:${t.count}`).join(',');
  return [
    `[toolUsageMetrics ${runId}/${counts.taskId}]`,
    `calls=${counts.total}`,
    `kinds=${counts.byTool.length}`,
    `tools=${tools === '' ? '-' : tools}`,
  ].join(' ');
}
