import { DAY_MS, parseDay } from './logic';
import type { McHandoffQuery } from './protocol';

/**
 * handoff台帳（Issue #2178）の条件の組み立て。DOMの型もPreactも使わない（単体テストから直接呼ぶ）。
 */

/** 台帳の絞り込み（画面の入力欄の値）。日付は`YYYY-MM-DD`。 */
export interface McLedgerFilter {
  query: string;
  session: string;
  trigger: McHandoffQuery['trigger'];
  from: string;
  to: string;
}

export const EMPTY_LEDGER_FILTER: McLedgerFilter = {
  query: '',
  session: '',
  trigger: 'all',
  from: '',
  to: '',
};

/** 画面の条件を拡張ホストへ送る形にする。日付はローカル時刻の0時から翌日0時まで。 */
export function toHandoffQuery(filter: McLedgerFilter): McHandoffQuery {
  const from = parseDay(filter.from);
  const toStart = parseDay(filter.to);
  return {
    query: filter.query.trim(),
    session: filter.session.trim(),
    trigger: filter.trigger,
    fromMs: from,
    toMs: toStart === undefined ? undefined : toStart + DAY_MS,
  };
}
