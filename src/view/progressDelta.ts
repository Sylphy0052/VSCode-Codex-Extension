import type { ProgressTurn, ProgressView } from './progressModel';

/**
 * 進捗画面へ送るターンの差し分（issue #1024）。
 *
 * `ProgressViewManager.notify` は状態が変わるたびに `buildProgress` の結果を丸ごと
 * `postMessage` していた。webviewへの送信は構造化クローンを通るため、変わったのが
 * 末尾の1ターンだけでも全ターンが直列化される。会話項目の側は同じ理由で issue #262
 * （Codex）・#356（Claude）で差し分へ移してあり、進捗画面はその経路に載っていなかった。
 *
 * 実測（`test/bench/progressBench.ts`。`JSON.stringify` を直列化の代理指標にする）:
 *
 * | 項目数 | ターン数 | 組み立て+直列化 p95 |
 * | ------ | -------- | ------------------- |
 * | 1000   | 167      | 1.9〜6.4ms          |
 * | 4000   | 667      | 10.5〜22.3ms        |
 * | 10000  | 1667     | 11.4〜34.0ms        |
 *
 * 状態の通知は `STATE_POST_INTERVAL_MS`（50ms）で間引かれる。10000項目の p95 は
 * その2〜7割にあたり、`docs/design.md` §9.6 が「送信が終わった直後に次の送信が
 * 始まる」と書いた域に近づく。
 */
export interface TurnsDelta {
  /**
   * `full` は受け取った並びでそのまま置き換える。`delta` は `turns` を
   * {@link ProgressTurn.index} で当てて差し替え、無いものを末尾へ足す。
   */
  mode: 'full' | 'delta';
  /** 送るターン。`delta` のときは変わったターンと増えたターンだけ。 */
  turns: readonly ProgressTurn[];
  /** 適用後にあるべきターン数。webview側が並びのズレに気付くための照合値。 */
  total: number;
}

/** 進捗画面へ1回で送る内容。ターンだけを差し分にし、集計とTODOは毎回そのまま送る。 */
export interface ProgressPayload {
  /** 集計。ターン数に依らず一定の大きさなので分割しない。 */
  summary: ProgressView['summary'];
  /** 現在のTODO一覧。同上。 */
  checklist: ProgressView['checklist'];
  turns: TurnsDelta;
}

/**
 * 前回送った内容と今回を比べ、送るターンだけを選ぶ。
 *
 * 会話項目の {@link import('./stateDelta').buildItemsDelta} と違い、変化の判定は
 * **中身の比較**で行う。`buildProgress` は状態が届くたびにターンを作り直す純粋関数で、
 * 変わっていないターンでも参照が変わるためである。組み立て自体は実測で p50 2.3ms
 * と軽く（上表の内訳）、重いのは直列化の側なので、比較を1回足して送る量を減らす方が安い。
 *
 * ターン数が減ったとき（巻き戻し・`thread/resume` による総入れ替え）は全量へ落とす。
 * 判定を凝らすより送り直す方が安い。
 */
export function buildProgressPayload(
  previous: ProgressView | undefined,
  next: ProgressView,
): ProgressPayload {
  return {
    summary: next.summary,
    checklist: next.checklist,
    turns: buildTurnsDelta(previous?.turns, next.turns),
  };
}

function buildTurnsDelta(
  previous: readonly ProgressTurn[] | undefined,
  next: readonly ProgressTurn[],
): TurnsDelta {
  const total = next.length;
  if (previous === undefined || previous.length > total) {
    return { mode: 'full', turns: next, total };
  }
  const changed: ProgressTurn[] = [];
  for (let i = 0; i < previous.length; i += 1) {
    const before = previous[i];
    const after = next[i];
    if (before === undefined || after === undefined || before.index !== after.index) {
      return { mode: 'full', turns: next, total };
    }
    if (!turnEquals(before, after)) {
      changed.push(after);
    }
  }
  for (let i = previous.length; i < total; i += 1) {
    const added = next[i];
    if (added !== undefined) {
      changed.push(added);
    }
  }
  return { mode: 'delta', turns: changed, total };
}

/**
 * ターンが表示上まったく同じかを見る。
 *
 * 画面へ出ない差は無視してよいが、`fileEditCounts` は「同じファイルを何回直したか」の
 * 表示に使われるため（`progressScript` の `renderFiles`）比較に含める。キーは
 * `editedFiles` と1対1なので、そちらを回って値だけを突き合わせれば足りる。
 */
function turnEquals(a: ProgressTurn, b: ProgressTurn): boolean {
  if (a.instruction !== b.instruction || a.response !== b.response) {
    return false;
  }
  if (!sameStrings(a.commands, b.commands) || !sameStrings(a.editedFiles, b.editedFiles)) {
    return false;
  }
  for (const file of a.editedFiles) {
    if (a.fileEditCounts[file] !== b.fileEditCounts[file]) {
      return false;
    }
  }
  if (a.todoChanges.length !== b.todoChanges.length) {
    return false;
  }
  return a.todoChanges.every((change, i) => {
    const other = b.todoChanges[i];
    return other !== undefined && change.content === other.content && change.kind === other.kind;
  });
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/**
 * webviewへ埋め込む積み直しの実装（issue #1024）。
 *
 * webview側のスクリプトはテンプレートリテラルの中身で型検査もlintも効かないため、
 * ここにソースとして置いて `progressScript` から差し込む。同じ処理を両側へ書くと
 * 片方だけ直したときに黙ってずれるので、実装はこの1か所に持つ。テストは
 * `test/unit/progressDelta.test.ts` がこの文字列を評価して確かめる
 * （`stateDelta.ts` の `MERGE_ITEMS_SOURCE` と同じやり方）。
 *
 * 積み直せなかったとき（総数が合わない = 取りこぼしか並びのずれ）は `undefined` を
 * 返す。呼び出し側は全量の送り直しを頼む。
 */
export const MERGE_TURNS_SOURCE = `function mergeTurns(current, payload) {
    var turns = payload.mode === 'full' ? payload.turns.slice() : current;
    if (payload.mode !== 'full') {
      for (var i = 0; i < payload.turns.length; i += 1) {
        var turn = payload.turns[i];
        var at = turns.findIndex(function (x) { return x.index === turn.index; });
        if (at === -1) turns.push(turn);
        else turns[at] = turn;
      }
    }
    return turns.length === payload.total ? turns : undefined;
  }`;
