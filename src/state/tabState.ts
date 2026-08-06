export interface PersistedTab {
  sessionId: string;
  viewColumn: number;
  /** 同一グループ内での並び順。ユーザーがドラッグで並べ替えた結果を再現するため。 */
  order: number;
  cwd: string | undefined;
  threadName: string | undefined;
}

/** 位置が判らなかったタブを末尾へ送るための番号。 */
export const UNKNOWN_ORDER = Number.MAX_SAFE_INTEGER;

export interface TabLike {
  label: string;
  isTerminal: boolean;
}

export interface TabGroupLike {
  viewColumn: number;
  tabs: TabLike[];
}

export interface TabPosition {
  label: string;
  viewColumn: number;
  order: number;
}

/**
 * エディタ領域にあるターミナルタブの位置を、左上から順に集める。
 *
 * VSCodeのTab APIはタブから `Terminal` を辿れないため、突き合わせはラベルで行う
 * （`assignPositions`）。誤ってもタブの並び順がずれるだけで、別セッションを開くことはない。
 */
export function collectTerminalTabPositions(groups: TabGroupLike[]): TabPosition[] {
  const positions: TabPosition[] = [];
  for (const group of [...groups].sort((a, b) => a.viewColumn - b.viewColumn)) {
    group.tabs.forEach((tab, index) => {
      if (tab.isTerminal) {
        positions.push({ label: tab.label, viewColumn: group.viewColumn, order: index });
      }
    });
  }
  return positions;
}

/**
 * ターミナル名の一覧に位置を割り当てる。
 * 同名タブが複数ある場合は、見つかった順に1つずつ消費する。
 */
export function assignPositions(
  names: readonly string[],
  positions: readonly TabPosition[],
): Array<{ viewColumn: number; order: number }> {
  const remaining = positions.map((p) => ({ ...p, used: false }));

  return names.map((name) => {
    const match = remaining.find((p) => !p.used && p.label === name);
    if (match === undefined) {
      return { viewColumn: 1, order: UNKNOWN_ORDER };
    }
    match.used = true;
    return { viewColumn: match.viewColumn, order: match.order };
  });
}

/** 復元順。左の列から、各列の中では元の並び順で開く。 */
export function sortForRestore(tabs: readonly PersistedTab[]): PersistedTab[] {
  return [...tabs].sort((a, b) => {
    if (a.viewColumn !== b.viewColumn) {
      return a.viewColumn - b.viewColumn;
    }
    return a.order - b.order;
  });
}

/**
 * 永続化された値を検証して読み直す。
 * 保存形式が変わった場合や壊れた値が入っていた場合でも落ちないようにする。
 */
export function normalizePersistedTabs(raw: unknown): PersistedTab[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const tabs: PersistedTab[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const e = entry as Record<string, unknown>;
    const sessionId = e['sessionId'];
    if (typeof sessionId !== 'string' || sessionId === '' || seen.has(sessionId)) {
      continue;
    }
    seen.add(sessionId);

    const viewColumn = e['viewColumn'];
    const order = e['order'];
    const cwd = e['cwd'];
    const threadName = e['threadName'];
    tabs.push({
      sessionId,
      viewColumn: typeof viewColumn === 'number' && viewColumn > 0 ? viewColumn : 1,
      order: typeof order === 'number' ? order : UNKNOWN_ORDER,
      cwd: typeof cwd === 'string' && cwd !== '' ? cwd : undefined,
      threadName: typeof threadName === 'string' && threadName !== '' ? threadName : undefined,
    });
  }

  return tabs;
}
