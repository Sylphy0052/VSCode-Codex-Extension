const DAY_MS = 24 * 60 * 60 * 1000;

export type DateBucket = 'today' | 'yesterday' | 'thisWeek' | 'older';

/** 各バケットの表示ラベルと並び順（この配列順に並べる）。 */
export const DATE_BUCKET_ORDER: readonly DateBucket[] = ['today', 'yesterday', 'thisWeek', 'older'];

export const DATE_BUCKET_LABEL: Readonly<Record<DateBucket, string>> = {
  today: '今日',
  yesterday: '昨日',
  thisWeek: '今週',
  older: 'それ以前',
};

/** ローカル時刻での「その日の0時」に丸める。 */
function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * セッションの更新時刻を「今日・昨日・今週・それ以前」へ分類する。
 *
 * `vscode` に依存しない純粋関数（CONTRIBUTING.mdのレイヤの制約）。`now` を引数で受けるため、
 * テストは固定時刻で境界を確かめられる。
 *
 * 暦日（ローカルのカレンダー日）で区切る。`formatRelativeTime`（`src/view/relativeTime.ts`）の
 * ような「経過ミリ秒」基準のローリング判定にはしていない。履歴を「今日触ったもの」として
 * 探すときの直感（深夜0時をまたいだら「今日」ではなくなる）に合わせるための判断で、
 * Finder/Gmail等の日付グルーピングと同じ考え方。
 *
 * 「今週」は暦週（月曜起点など）ではなく、今日・昨日を除く直近7日以内のローリング判定。
 * 週の起点をどこに置くかは locale 依存で決めが割れやすく、実装も表示もどちらも単純な
 * 「直近7日」の方が説明しやすいと判断した（issue #293、design.md §14.54）。
 */
export function dateBucketFor(isoTimestamp: string, now: number): DateBucket {
  const t = Date.parse(isoTimestamp);
  if (Number.isNaN(t)) {
    // 壊れた値は最も安全側（それ以前）に倒す。グルーピングが目的の表示専用ロジックなので、
    // 例外にせず落ち着いた既定へ丸める（CONTRIBUTING.mdの「未知の入力で壊さない」方針）。
    return 'older';
  }

  const diffDays = Math.floor((startOfDay(now) - startOfDay(t)) / DAY_MS);
  if (diffDays <= 0) {
    // 未来のタイムスタンプ（クロックのずれ等）も「今日」に丸める
    return 'today';
  }
  if (diffDays === 1) {
    return 'yesterday';
  }
  if (diffDays <= 7) {
    return 'thisWeek';
  }
  return 'older';
}
