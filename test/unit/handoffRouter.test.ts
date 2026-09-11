import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '../../src/codex/modelCatalog';
import { decideHandoffModel, type HandoffRouterInput } from '../../src/view/handoffRouter';

/** Codex側のカタログを模した一覧。effortは5段階。 */
function codexModels(): ModelInfo[] {
  const efforts = ['low', 'medium', 'high', 'xhigh', 'max'].map((effort) => ({
    effort,
    description: undefined,
  }));
  return [
    {
      slug: 'gpt-5.6-luna',
      displayName: 'luna',
      description: undefined,
      defaultEffort: 'medium',
      supportsEffort: true,
      efforts,
    },
    {
      slug: 'gpt-5.6-terra',
      displayName: 'terra',
      description: undefined,
      defaultEffort: 'medium',
      supportsEffort: true,
      efforts,
    },
    {
      slug: 'gpt-5.6-sol',
      displayName: 'sol',
      description: undefined,
      defaultEffort: 'medium',
      supportsEffort: true,
      efforts,
    },
  ];
}

/** effortの概念を持たないモデルだけの一覧（Claude Codeの haiku 相当）。 */
function noEffortModels(): ModelInfo[] {
  return [
    {
      slug: 'haiku',
      displayName: 'haiku',
      description: undefined,
      defaultEffort: undefined,
      supportsEffort: false,
      efforts: [],
    },
  ];
}

function input(over: Partial<HandoffRouterInput> = {}): HandoffRouterInput {
  return {
    trigger: { kind: 'manual' },
    turnFailed: false,
    recentUserMessages: [],
    cwd: '/home/me/work/app',
    gitBranch: 'main',
    turnEditedFiles: [],
    ...over,
  };
}

const current = { model: 'gpt-5.6-terra', effort: 'medium' };

describe('decideHandoffModel: 判定材料が無いとき', () => {
  it('陰性対照: 指示が空・失敗なし・パス該当なしでは判定しない', () => {
    expect(decideHandoffModel(input(), codexModels(), current)).toBeUndefined();
  });

  it('陰性対照: どのキーワードにも当たらない指示だけでは判定しない', () => {
    const decision = decideHandoffModel(
      input({ recentUserMessages: ['READMEの誤字を直して', 'ありがとう'] }),
      codexModels(),
      current,
    );
    expect(decision).toBeUndefined();
  });

  it('陽性対照: キーワードが1つでもあれば判定する', () => {
    const decision = decideHandoffModel(
      input({ recentUserMessages: ['この関数をリファクタして'] }),
      codexModels(),
      current,
    );
    expect(decision).toBeDefined();
    expect(decision?.reasons).toContain('+1 refactor');
  });
});

describe('decideHandoffModel: 加点とレベル', () => {
  it('加点1件（score=2）はL1', () => {
    const decision = decideHandoffModel(
      input({ recentUserMessages: ['パフォーマンスが悪いので直したい'] }),
      codexModels(),
      current,
    );
    expect(decision?.level).toBe(1);
  });

  it('turnFailedはレベルを1段上げる（加点ではない）', () => {
    const base = decideHandoffModel(
      input({ recentUserMessages: ['リファクタして'] }),
      codexModels(),
      current,
    );
    const withFailure = decideHandoffModel(
      input({ recentUserMessages: ['リファクタして'], turnFailed: true }),
      codexModels(),
      current,
    );
    expect(base?.level).toBe(1);
    expect(withFailure?.level).toBe(2);
    expect(withFailure?.reasons).toContain('+1 level -> L2 (previous attempt failed)');
  });

  it('turnFailedだけでも判定材料として扱う', () => {
    const decision = decideHandoffModel(input({ turnFailed: true }), codexModels(), current);
    expect(decision?.level).toBe(1);
  });

  it('分類のfloorが加点結果を上回るときは引き上げる', () => {
    // securityのキーワード1つだけならscore=2（L1）だが、floorでL4へ
    const decision = decideHandoffModel(
      input({ recentUserMessages: ['認証まわりを直したい'] }),
      codexModels(),
      current,
    );
    expect(decision?.level).toBe(4);
    expect(decision?.reasons).toContain('floor security -> L4');
  });

  it('パスから分類を拾う（加点はせずfloorだけ効く）', () => {
    const decision = decideHandoffModel(
      input({ turnEditedFiles: ['db/migrations/0001_init.sql'] }),
      codexModels(),
      current,
    );
    expect(decision?.level).toBe(3);
    expect(decision?.reasons).toContain('floor path:migration');
  });

  it('Windows形式のパス区切りでも分類を拾う', () => {
    const decision = decideHandoffModel(
      input({ turnEditedFiles: ['src\\auth\\login.ts'] }),
      codexModels(),
      current,
    );
    expect(decision?.level).toBe(4);
  });
});

describe('decideHandoffModel: L5の扱い', () => {
  const heavy = [
    'セキュリティの設計を見直す',
    '並行処理の競合が原因のバグを追う',
    'マイグレーションのリファクタ',
    '性能が遅い',
  ];

  it('直前のターンが失敗していなければ、全分類に当たってもL4に留まる', () => {
    const decision = decideHandoffModel(
      input({ recentUserMessages: heavy }),
      codexModels(),
      current,
    );
    // キーワードの加点はscore最大9（＝L4）で、失敗していない限りL5へは届かない
    expect(decision?.level).toBe(4);
    expect(decision?.effort).toBe('xhigh');
  });

  it('直前のターンが失敗していればL5に届く', () => {
    const decision = decideHandoffModel(
      input({ recentUserMessages: heavy, turnFailed: true }),
      codexModels(),
      current,
    );
    expect(decision?.level).toBe(5);
    expect(decision?.effort).toBe('max');
  });
});

describe('decideHandoffModel: model / effortの解決', () => {
  it('L0/L1は低ティア、L2/L3は中ティア、L4以上は高ティアのモデルを選ぶ', () => {
    const low = decideHandoffModel(
      input({ recentUserMessages: ['リファクタして'] }),
      codexModels(),
      current,
    );
    expect(low?.model).toBe('gpt-5.6-luna');

    const high = decideHandoffModel(
      input({ recentUserMessages: ['セキュリティを見たい'] }),
      codexModels(),
      current,
    );
    expect(high?.model).toBe('gpt-5.6-sol');
  });

  it('ティアに合うモデルがカタログに無ければ引き継ぎ元のモデルを据え置く', () => {
    const onlyMid: ModelInfo[] = codexModels().filter((m) => m.slug.includes('terra'));
    const decision = decideHandoffModel(
      input({ recentUserMessages: ['セキュリティを見たい'] }),
      onlyMid,
      current,
    );
    expect(decision?.model).toBe(current.model);
  });

  it('effortはカタログの一覧の中の相対位置で決まる（L0=最下位、L5=最上位）', () => {
    const l0 = decideHandoffModel(
      input({ turnEditedFiles: [], recentUserMessages: [], turnFailed: false }),
      codexModels(),
      current,
    );
    expect(l0).toBeUndefined(); // 材料が無いので判定しない

    const l1 = decideHandoffModel(
      input({ recentUserMessages: ['リファクタして'] }),
      codexModels(),
      current,
    );
    expect(l1?.effort).toBe('medium');

    const l4 = decideHandoffModel(
      input({ recentUserMessages: ['設計を見直したい'] }),
      codexModels(),
      current,
    );
    expect(l4?.effort).toBe('xhigh');
  });

  it('effort非対応のモデルにはeffortを渡さない', () => {
    const decision = decideHandoffModel(
      input({ recentUserMessages: ['リファクタして'] }),
      noEffortModels(),
      { model: 'haiku', effort: '' },
    );
    expect(decision?.model).toBe('haiku');
    expect(decision?.effort).toBe('');
  });

  it('カタログが空でもfallbackのeffort一覧から選ぶ', () => {
    const decision = decideHandoffModel(
      input({ recentUserMessages: ['セキュリティを見たい'] }),
      [],
      current,
      ['low', 'medium', 'high', 'xhigh', 'max'],
    );
    expect(decision?.model).toBe(current.model);
    expect(decision?.effort).toBe('xhigh');
  });
});

describe('decideHandoffModel: 判定理由', () => {
  it('先頭にレベルとスコアを置き、加点の内訳を続ける', () => {
    const decision = decideHandoffModel(
      input({ recentUserMessages: ['リファクタして'], turnFailed: true }),
      codexModels(),
      current,
    );
    expect(decision?.reasons[0]).toBe('L2 (score=2)');
    expect(decision?.reasons).toContain('+1 refactor');
  });
});
