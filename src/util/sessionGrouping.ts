import type { SessionSummary } from '../codex/types';
import { DATE_BUCKET_LABEL, DATE_BUCKET_ORDER, dateBucketFor } from './dateBucket';
import { basenameOf } from './paths';

/** `codex.history.groupBy` の取りうる値。`none` は現状どおりのフラット表示。 */
export type HistoryGroupBy = 'date' | 'folder' | 'none';

/** 作業ディレクトリが無いセッションをまとめるグループのキー。空文字は現実のcwdと衝突しない。 */
const UNKNOWN_FOLDER_KEY = '';
const UNKNOWN_FOLDER_LABEL = '不明な作業ディレクトリ';

export interface SessionGroup {
  /** グループの種類とキーの組。`SessionTreeProvider` がツリー要素の `id` を組み立てるのに使う。 */
  readonly kind: 'date' | 'folder';
  readonly key: string;
  readonly label: string;
  readonly sessions: SessionSummary[];
}

/**
 * 日付（今日・昨日・今週・それ以前）でグループ化する。
 *
 * 入力は呼び出し側（`SessionTreeProvider`）が更新時刻の新しい順に揃えた状態で渡す前提。
 * 各バケット内の並びは入力の順序をそのまま保つ。空のバケットは出さない。
 */
export function buildDateGroups(sessions: readonly SessionSummary[], now: number): SessionGroup[] {
  const buckets = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    const bucket = dateBucketFor(session.updatedAt, now);
    const list = buckets.get(bucket) ?? [];
    list.push(session);
    buckets.set(bucket, list);
  }

  return DATE_BUCKET_ORDER.filter((bucket) => (buckets.get(bucket)?.length ?? 0) > 0).map(
    (bucket): SessionGroup => ({
      kind: 'date',
      key: bucket,
      label: DATE_BUCKET_LABEL[bucket],
      // filter済みなので必ず存在するが、noUncheckedIndexedAccess対策で空配列を保険にする
      sessions: buckets.get(bucket) ?? [],
    }),
  );
}

/**
 * 作業ディレクトリ（`cwd`）でグループ化する。全ワークスペース表示（issue #293）向けの選択肢。
 *
 * グループの並び順はキーの初出順にする。入力が更新時刻の新しい順であれば、結果として
 * 「直近に触った作業ディレクトリが先頭」になる（`Map` の挿入順そのまま利用、追加のソートは
 * 行わない）。
 *
 * ラベルはディレクトリ名（basename）を使うが、異なるパスが同じbasenameを持つ場合は
 * 区別が付くようフルパスへ差し替える（例: `~/a/app` と `~/b/app` が両方 `app` になる事故を防ぐ）。
 */
export function buildFolderGroups(sessions: readonly SessionSummary[]): SessionGroup[] {
  const buckets = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    const key = session.cwd ?? UNKNOWN_FOLDER_KEY;
    const list = buckets.get(key) ?? [];
    list.push(session);
    buckets.set(key, list);
  }

  const basenameCounts = new Map<string, number>();
  for (const key of buckets.keys()) {
    if (key === UNKNOWN_FOLDER_KEY) {
      continue;
    }
    const name = basenameOf(key);
    basenameCounts.set(name, (basenameCounts.get(name) ?? 0) + 1);
  }

  return [...buckets.entries()].map(([key, groupSessions]): SessionGroup => {
    if (key === UNKNOWN_FOLDER_KEY) {
      return { kind: 'folder', key, label: UNKNOWN_FOLDER_LABEL, sessions: groupSessions };
    }
    const name = basenameOf(key);
    const label = (basenameCounts.get(name) ?? 0) > 1 ? key : name;
    return { kind: 'folder', key, label, sessions: groupSessions };
  });
}
