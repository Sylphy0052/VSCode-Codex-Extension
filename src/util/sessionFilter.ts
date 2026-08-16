import type { SessionSummary } from '../codex/types';

/**
 * 履歴ビューのタイトルバーの絞り込み（issue #293）。セッション名（`threadName`）と
 * 作業ディレクトリ（`cwd`）に対して大小文字を無視した部分一致で照合する。
 *
 * 表示だけを変えるための関数で、読み込み件数（`codex.history.maxEntries`）には関与しない
 * （`SessionTreeProvider` 側で読み込み済みの一覧に対して掛けるだけ）。
 */
export function matchesSessionQuery(session: SessionSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') {
    return true;
  }
  const name = (session.threadName ?? '').toLowerCase();
  const cwd = (session.cwd ?? '').toLowerCase();
  return name.includes(q) || cwd.includes(q);
}
