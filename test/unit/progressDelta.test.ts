import { describe, expect, it } from 'vitest';
import { MERGE_TURNS_SOURCE, buildProgressPayload } from '../../src/view/progressDelta';
import type { ProgressTurn, ProgressView } from '../../src/view/progressModel';

/**
 * 進捗画面の状態送信の差し分（issue #1024）。会話項目側の `stateDelta.test.ts` と対にする。
 */

const turn = (index: number, over: Partial<ProgressTurn> = {}): ProgressTurn => ({
  index,
  instruction: `指示 ${index}`,
  response: '',
  editedFiles: [],
  fileEditCounts: Object.create(null) as Record<string, number>,
  commands: [],
  todoChanges: [],
  ...over,
});

const view = (turns: ProgressTurn[]): ProgressView => ({
  summary: {
    turnCount: turns.length,
    editedFiles: [],
    editedFileGroups: [],
    commandCount: 0,
    todoTotal: 0,
    todoCompleted: 0,
    busy: false,
  },
  checklist: [],
  turns,
});

describe('buildProgressPayload（issue #1024）', () => {
  it('前回が無ければ全量を送る', () => {
    const turns = [turn(0), turn(1)];

    expect(buildProgressPayload(undefined, view(turns)).turns).toEqual({
      mode: 'full',
      turns,
      total: 2,
    });
  });

  it('末尾に増えたターンだけ送る', () => {
    const first = turn(0);
    const second = turn(1);

    const payload = buildProgressPayload(view([first]), view([first, second]));

    expect(payload.turns).toEqual({ mode: 'delta', turns: [second], total: 2 });
  });

  it('中身が変わっていなければ送らない（作り直された別オブジェクトでも）', () => {
    // buildProgress は状態が届くたびにターンを作り直すため、参照では変化を見られない
    const before = [turn(0), turn(1)];
    const after = [turn(0), turn(1)];

    const payload = buildProgressPayload(view(before), view(after));

    expect(payload.turns).toEqual({ mode: 'delta', turns: [], total: 2 });
  });

  it('応答が伸びたターンだけ送る', () => {
    const before = [turn(0, { response: '書きかけ' }), turn(1)];
    const grown = turn(0, { response: '書きかけの続き' });

    const payload = buildProgressPayload(view(before), view([grown, turn(1)]));

    expect(payload.turns).toEqual({ mode: 'delta', turns: [grown], total: 2 });
  });

  it('同じファイルへの書き込み回数が増えたら送る', () => {
    const counts = (value: number): Record<string, number> =>
      Object.assign(Object.create(null) as Record<string, number>, { 'src/a.ts': value });
    const before = turn(0, { editedFiles: ['src/a.ts'], fileEditCounts: counts(1) });
    const after = turn(0, { editedFiles: ['src/a.ts'], fileEditCounts: counts(2) });

    const payload = buildProgressPayload(view([before]), view([after]));

    expect(payload.turns).toEqual({ mode: 'delta', turns: [after], total: 1 });
  });

  it('コマンドが増えたら送る', () => {
    const before = turn(0, { commands: ['npm test'] });
    const after = turn(0, { commands: ['npm test', 'git diff'] });

    expect(buildProgressPayload(view([before]), view([after])).turns.turns).toEqual([after]);
  });

  it('TODOの変化が増えたら送る', () => {
    const before = turn(0);
    const after = turn(0, { todoChanges: [{ content: '実装', kind: 'completed' }] });

    expect(buildProgressPayload(view([before]), view([after])).turns.turns).toEqual([after]);
  });

  it('ターンが減ったら全量へ落とす（巻き戻し・resume）', () => {
    const before = [turn(0), turn(1), turn(2)];
    const after = [turn(0)];

    expect(buildProgressPayload(view(before), view(after)).turns).toEqual({
      mode: 'full',
      turns: after,
      total: 1,
    });
  });

  it('集計とTODO一覧は毎回そのまま送る', () => {
    const next = view([turn(0)]);

    const payload = buildProgressPayload(view([turn(0)]), next);

    expect(payload.summary).toBe(next.summary);
    expect(payload.checklist).toBe(next.checklist);
  });
});

const mergeTurns = new Function(`return (${MERGE_TURNS_SOURCE});`)() as (
  current: ProgressTurn[],
  payload: { mode: string; turns: ProgressTurn[]; total: number },
) => ProgressTurn[] | undefined;

describe('mergeTurns（webview側。issue #1024）', () => {
  it('全量は受け取った並びでそのまま置き換える', () => {
    const turns = [turn(0), turn(1)];

    expect(mergeTurns([turn(9)], { mode: 'full', turns, total: 2 })).toEqual(turns);
  });

  it('差し分は同じindexを差し替え、無いものを末尾へ足す', () => {
    const first = turn(0);
    const grown = turn(0, { response: '続き' });
    const second = turn(1);

    expect(mergeTurns([first], { mode: 'delta', turns: [grown, second], total: 2 })).toEqual([
      grown,
      second,
    ]);
  });

  it('総数が合わなければ undefined を返す（取りこぼしに気付ける）', () => {
    expect(mergeTurns([turn(0)], { mode: 'delta', turns: [], total: 5 })).toBeUndefined();
  });

  it('全量でも総数が合わなければ undefined を返す', () => {
    expect(mergeTurns([], { mode: 'full', turns: [turn(0)], total: 2 })).toBeUndefined();
  });
});
