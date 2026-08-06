const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * 一覧の description に出す相対時刻。
 * 「いつ触ったか」が一目で判ればよいので、粒度は粗くてよい。
 */
export function formatRelativeTime(isoTimestamp: string, now: number): string {
  const then = Date.parse(isoTimestamp);
  if (Number.isNaN(then)) {
    return '';
  }

  const diff = now - then;
  if (diff < 0) {
    return 'たった今';
  }
  if (diff < MINUTE) {
    return 'たった今';
  }
  if (diff < HOUR) {
    return `${Math.floor(diff / MINUTE)}分前`;
  }
  if (diff < DAY) {
    return `${Math.floor(diff / HOUR)}時間前`;
  }
  if (diff < 2 * DAY) {
    return '昨日';
  }
  if (diff < 7 * DAY) {
    return `${Math.floor(diff / DAY)}日前`;
  }

  const d = new Date(then);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}/${mm}/${dd}`;
}

/** tooltip に出す絶対時刻。 */
export function formatAbsoluteTime(isoTimestamp: string): string {
  const t = Date.parse(isoTimestamp);
  if (Number.isNaN(t)) {
    return isoTimestamp;
  }
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
