import { describe, expect, it } from 'vitest';
import { chatScript } from '../../src/view/chatScript';

/**
 * ゴールの下書きを3欄へ入れる部分の振る舞い（issue #958、#961）。
 *
 * `chatScript`はテンプレートリテラルの中のプレーンJavaScriptで、型検査もlintも効かない。
 * `webviewScript.test.ts`は構文解析までしか行っていないが、ここで確かめたいのは
 * **利用者が書いた文を消さないこと**であり、文字列の一致では固定できない。
 *
 * そこで下書きまわりの関数群だけを生成結果から切り出し、`el`と`vscode`の最小の代役を
 * 与えて実際に動かす。切り出す範囲は目印の2行で挟んだ区間なので、実装が動けば
 * ここも一緒に壊れて気付ける（黙って対象を外さない）。
 */

const START = '  let goalDraftRequest = undefined;';
const END = '  // 1回のスクロールで、最下部への移動と発言間の移動の両方を更新する。';

interface Harness {
  fields: Record<string, string>;
  notice: () => string;
  startDisabled: () => boolean;
  posted: Array<Record<string, unknown>>;
  clicks: number;
  requestGoalDraft: (initialPrompt: string) => void;
  applyGoalDraft: (data: Record<string, unknown>) => void;
  goalFieldsEmpty: (goal: Record<string, string>) => boolean;
}

/** 生成されたスクリプトから下書きまわりの区間を切り出す。 */
function extractGoalDraftBlock(): string {
  const source = chatScript('Codex', { mode: 'quickPick' });
  const from = source.indexOf(START);
  const to = source.indexOf(END);
  if (from < 0 || to < 0 || to <= from) {
    throw new Error('ゴール下書きの区間を切り出せない（目印が変わった可能性）');
  }
  return source.slice(from, to);
}

function harness(initial: Partial<Record<string, string>> = {}): Harness {
  const fields: Record<string, string> = {
    loopInitial: '',
    loopGoalPurpose: '',
    loopGoalCriteria: '',
    loopGoalConstraints: '',
    loopGoalNotice: '',
    ...initial,
  };
  const state = { noticeHidden: true, startDisabled: false, clicks: 0 };
  const posted: Array<Record<string, unknown>> = [];
  const nodes: Record<string, Record<string, unknown>> = {};
  const el = (id: string): Record<string, unknown> => {
    nodes[id] ??= {
      get value(): string {
        return fields[id] ?? '';
      },
      set value(v: string) {
        fields[id] = v;
      },
      get textContent(): string {
        return fields[id] ?? '';
      },
      set textContent(v: string) {
        fields[id] = v;
      },
      get hidden(): boolean {
        return state.noticeHidden;
      },
      set hidden(v: boolean) {
        state.noticeHidden = v;
      },
      get disabled(): boolean {
        return state.startDisabled;
      },
      set disabled(v: boolean) {
        state.startDisabled = v;
      },
      focus: () => undefined,
      click: () => {
        state.clicks += 1;
      },
    };
    return nodes[id] as Record<string, unknown>;
  };
  const vscode = { postMessage: (m: Record<string, unknown>) => posted.push(m) };
  const factory = new Function(
    'el',
    'vscode',
    `${extractGoalDraftBlock()}
     return { requestGoalDraft, applyGoalDraft, goalFieldsEmpty };`,
  ) as (
    elFn: typeof el,
    vscodeApi: typeof vscode,
  ) => Pick<Harness, 'requestGoalDraft' | 'applyGoalDraft' | 'goalFieldsEmpty'>;
  const api = factory(el, vscode);
  return {
    fields,
    notice: () => fields['loopGoalNotice'] ?? '',
    startDisabled: () => state.startDisabled,
    posted,
    get clicks(): number {
      return state.clicks;
    },
    ...api,
  } as Harness;
}

describe('切り出しとクリック処理の結び付き（issue #961）', () => {
  it('切り出した区間に、確かめたい関数が入っている', () => {
    // 目印がずれて別の区間を掴んでいないことの陽性対照。ここが空振りすると、
    // 以降のテストは「実装を確かめずに通る」状態になる
    const block = extractGoalDraftBlock();
    expect(block).toContain('function applyGoalDraft(');
    expect(block).toContain('function goalFieldsEmpty(');
    expect(block).toContain('function requestGoalDraft(');
  });

  it('開始ボタンの処理が発動条件に goalFieldsEmpty を使う', () => {
    // 3欄すべてを見る判定は関数側にあるため、呼び出し側が旧条件へ戻ると
    // 上のテストは通ったまま制約の上書きが復活する
    const source = chatScript('Codex', { mode: 'quickPick' });
    expect(source).toContain('const goalEmpty = goalFieldsEmpty(plan.goal);');
    expect(source).not.toContain(
      'const goalEmpty = !plan.goal.purpose.trim() && !plan.goal.acceptanceCriteria.trim();',
    );
  });
});

describe('goalFieldsEmpty（issue #961）', () => {
  it('3欄すべて空なら空とみなす', () => {
    const h = harness();
    expect(h.goalFieldsEmpty({ purpose: '', acceptanceCriteria: '', constraints: '' })).toBe(true);
  });

  it('制約だけ書かれていても空とみなさない', () => {
    // これが false にならないと、利用者が書いた制約を下書きが上書きする
    const h = harness();
    expect(
      h.goalFieldsEmpty({ purpose: '', acceptanceCriteria: '', constraints: '公開APIを変えない' }),
    ).toBe(false);
  });

  it('目的だけ、受入基準だけの場合も空とみなさない', () => {
    const h = harness();
    expect(h.goalFieldsEmpty({ purpose: '直す', acceptanceCriteria: '', constraints: '' })).toBe(
      false,
    );
    expect(h.goalFieldsEmpty({ purpose: '', acceptanceCriteria: '緑', constraints: '' })).toBe(
      false,
    );
  });

  it('空白だけの入力は空とみなす', () => {
    const h = harness();
    expect(h.goalFieldsEmpty({ purpose: ' ', acceptanceCriteria: '\n', constraints: '  ' })).toBe(
      true,
    );
  });
});

describe('下書きの要求（issue #961）', () => {
  it('要求すると開始ボタンを無効化し、通し番号を添えて送る', () => {
    const h = harness({ loopInitial: 'Issue #1に着手' });
    h.requestGoalDraft('Issue #1に着手');
    expect(h.startDisabled()).toBe(true);
    expect(h.posted[0]).toMatchObject({
      type: 'loop/planGoal',
      text: 'Issue #1に着手',
      id: 1,
    });
  });

  it('通し番号は要求ごとに増える', () => {
    const h = harness();
    h.requestGoalDraft('a');
    h.applyGoalDraft({ id: 1, ok: false, message: 'だめ' });
    h.requestGoalDraft('b');
    expect(h.posted[1]?.['id']).toBe(2);
  });
});

describe('applyGoalDraft（issue #958、#961）', () => {
  const draft = {
    id: 1,
    ok: true,
    goal: { purpose: '直す', acceptanceCriteria: '緑になる', constraints: '弱めない' },
  };

  it('入力が変わっていなければ3欄へ入れる', () => {
    const h = harness({ loopInitial: '着手' });
    h.requestGoalDraft('着手');
    h.applyGoalDraft(draft);
    expect(h.fields['loopGoalPurpose']).toBe('直す');
    expect(h.fields['loopGoalCriteria']).toBe('緑になる');
    expect(h.fields['loopGoalConstraints']).toBe('弱めない');
    expect(h.startDisabled()).toBe(false);
  });

  it('入れるだけでループは始めない', () => {
    const h = harness({ loopInitial: '着手' });
    h.requestGoalDraft('着手');
    h.applyGoalDraft(draft);
    expect(h.clicks).toBe(0);
  });

  it('start が立っているときだけ開始まで進む', () => {
    const h = harness({ loopInitial: '着手' });
    h.requestGoalDraft('着手');
    h.applyGoalDraft({ ...draft, start: true });
    expect(h.clicks).toBe(1);
  });

  it('外部Issueが材料だと、確認を促す文言を出す（issue #962）', () => {
    const h = harness({ loopInitial: 'Issue #1に着手' });
    h.requestGoalDraft('Issue #1に着手');
    h.applyGoalDraft({ ...draft, provenance: 'external-issue' });
    expect(h.notice()).toContain('Issue本文を材料にした');
    expect(h.clicks).toBe(0);
  });

  it('待っている間にゴールを書かれていたら反映しない', () => {
    const h = harness({ loopInitial: '着手' });
    h.requestGoalDraft('着手');
    h.fields['loopGoalPurpose'] = '自分で書いた目的';
    h.applyGoalDraft(draft);
    expect(h.fields['loopGoalPurpose']).toBe('自分で書いた目的');
    expect(h.fields['loopGoalCriteria']).toBe('');
    expect(h.notice()).toContain('反映しませんでした');
  });

  it('待っている間に1回目の指示を書き換えられていたら反映しない', () => {
    // 古い一文から作ったゴールと、今の指示文の組み合わせで走り出さないため
    const h = harness({ loopInitial: 'Issue #1に着手' });
    h.requestGoalDraft('Issue #1に着手');
    h.fields['loopInitial'] = 'Issue #2に着手';
    h.applyGoalDraft(draft);
    expect(h.fields['loopGoalPurpose']).toBe('');
  });

  it('入力が変わっていれば start が立っていても始めない', () => {
    const h = harness({ loopInitial: '着手' });
    h.requestGoalDraft('着手');
    h.fields['loopGoalPurpose'] = '自分で書いた目的';
    h.applyGoalDraft({ ...draft, start: true });
    expect(h.clicks).toBe(0);
  });

  it('入力が変わっていても開始ボタンは戻す', () => {
    const h = harness({ loopInitial: '着手' });
    h.requestGoalDraft('着手');
    h.fields['loopGoalPurpose'] = '自分で書いた目的';
    h.applyGoalDraft(draft);
    expect(h.startDisabled()).toBe(false);
  });

  it('別の通し番号の応答は捨てる', () => {
    const h = harness({ loopInitial: '着手' });
    h.requestGoalDraft('着手');
    h.applyGoalDraft({ ...draft, id: 99 });
    expect(h.fields['loopGoalPurpose']).toBe('');
    // 捨てた応答でボタンを戻すと、本来の応答を待っている状態が崩れる
    expect(h.startDisabled()).toBe(true);
  });

  it('要求していないのに届いた応答は捨てる', () => {
    const h = harness();
    h.applyGoalDraft(draft);
    expect(h.fields['loopGoalPurpose']).toBe('');
  });

  it('同じ応答が2回届いても2回目は無視する', () => {
    const h = harness({ loopInitial: '着手' });
    h.requestGoalDraft('着手');
    h.applyGoalDraft(draft);
    h.fields['loopGoalPurpose'] = '手で直した目的';
    h.applyGoalDraft(draft);
    expect(h.fields['loopGoalPurpose']).toBe('手で直した目的');
  });

  it('失敗の応答は理由を出し、3欄を空のまま残す', () => {
    const h = harness({ loopInitial: '着手' });
    h.requestGoalDraft('着手');
    h.applyGoalDraft({ id: 1, ok: false, message: '応答がありません' });
    expect(h.notice()).toBe('応答がありません');
    expect(h.fields['loopGoalPurpose']).toBe('');
    expect(h.startDisabled()).toBe(false);
  });

  it('失敗の応答に理由が無くても操作可能へ戻す', () => {
    const h = harness({ loopInitial: '着手' });
    h.requestGoalDraft('着手');
    h.applyGoalDraft({ id: 1, ok: false });
    expect(h.startDisabled()).toBe(false);
    expect(h.notice()).not.toBe('');
  });

  it('制約が空の下書きでも欠けた欄を空にする（前回の残りを混ぜない）', () => {
    const h = harness({ loopInitial: '着手' });
    h.requestGoalDraft('着手');
    h.applyGoalDraft({ id: 1, ok: true, goal: { purpose: '直す', acceptanceCriteria: '緑' } });
    expect(h.fields['loopGoalConstraints']).toBe('');
  });
});
