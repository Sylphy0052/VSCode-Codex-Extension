import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __mock } from '../mocks/vscode';
import type { ModelInfo } from '../../src/codex/modelCatalog';
import {
  chooseHandoffModelSettings,
  probeSafeBoundary,
  proposeHandoffModelSettings,
} from '../../src/view/handoffModelChoice';
import * as classifier from '../../src/view/handoffClassifier';
import type { TaskAssessment } from '../../src/view/handoffRouter';

function model(slug: string, efforts: readonly string[]): ModelInfo {
  return {
    slug,
    displayName: slug,
    description: undefined,
    defaultEffort: undefined,
    supportsEffort: efforts.length > 0,
    efforts: efforts.map((effort) => ({ effort, description: undefined })),
  };
}

const FIVE = ['low', 'medium', 'high', 'xhigh', 'max'];
const models = [
  model('gpt-5.6-terra', FIVE),
  model('gpt-5.6-sol', FIVE),
  model('gpt-5.6-astra', FIVE),
];

const current = { model: 'gpt-5.6-sol', effort: 'medium' };
const input = {
  recentUserMessages: ['続きをやって'],
  recentAssistantMessages: [],
  turnFailed: false,
  cwd: '/workspace/root',
  gitBranch: 'main',
  turnEditedFiles: [],
};

function deps() {
  return { provider: 'codex' as const, executable: 'codex', models };
}

function assess(over: Partial<TaskAssessment> = {}): TaskAssessment {
  return {
    taskType: 'implementation',
    difficulty: 0,
    scope: 0,
    ambiguity: 0,
    risk: 0,
    autonomy: 0,
    confidence: 0.9,
    reasons: [],
    switchSafe: true,
    switchReason: '',
    handoffSuggested: false,
    handoffSuggestReason: '',
    awaitingUserAnswer: false,
    awaitingUserAnswerReason: '',
    ...over,
  };
}

/** 分類を固定値で返させる。実CLIは起動しない。 */
function stubClassifier(assessment: TaskAssessment | undefined): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(classifier, 'classifyHandoff').mockResolvedValue(assessment);
}

describe('proposeHandoffModelSettings', () => {
  beforeEach(() => {
    __mock.reset();
    vi.restoreAllMocks();
  });

  it('分類が返ればその見立てで決まる', async () => {
    stubClassifier(
      assess({ difficulty: 2, scope: 2, ambiguity: 2, risk: 2, autonomy: 2, reasons: ['広い'] }),
    );
    const { settings, reasons } = await proposeHandoffModelSettings(current, input, deps());
    expect(settings).toEqual({ model: 'gpt-5.6-astra', effort: 'xhigh' });
    expect(reasons.some((r) => r.startsWith('implementation difficulty=2'))).toBe(true);
    expect(reasons).toContain('分類器: 広い');
    expect(reasons).toContain('confidence=0.90');
  });

  it('コスト方針=low なら最上位モデルもxhighも選ばない（Issue #1214）', async () => {
    stubClassifier(assess({ difficulty: 2, scope: 2, ambiguity: 2, risk: 2, autonomy: 2 }));
    __mock.setConfig('agent', { 'autoHandoff.costPreset': 'low' });
    const { settings, reasons } = await proposeHandoffModelSettings(current, input, deps());
    expect(settings).toEqual({ model: 'gpt-5.6-sol', effort: 'high' });
    expect(reasons).toContain('コスト方針=low: モデルのティアを1へ制限');
  });

  it('コスト方針より明示設定が優先する（Issue #1214）', async () => {
    stubClassifier(assess());
    __mock.setConfig('agent', {
      'autoHandoff.costPreset': 'low',
      'autoHandoff.model': 'gpt-5.6-astra',
      'autoHandoff.effort': 'xhigh',
    });
    const { settings } = await proposeHandoffModelSettings(current, input, deps());
    expect(settings).toEqual({ model: 'gpt-5.6-astra', effort: 'xhigh' });
  });

  it('分類に失敗したら引き継ぎ元を踏襲する（グローバル設定へ戻さない）', async () => {
    stubClassifier(undefined);
    const { settings, reasons } = await proposeHandoffModelSettings(current, input, deps());
    expect(settings).toEqual(current);
    expect(reasons).toContain('作業の分類に失敗したため引き継ぎ元を踏襲');
  });

  it('routerがOFFなら分類を呼ばず引き継ぎ元を踏襲する', async () => {
    __mock.setConfig('agent', { 'autoHandoff.router': false });
    const spy = vi.spyOn(classifier, 'classifyHandoff');
    const { settings, reasons } = await proposeHandoffModelSettings(current, input, deps());
    expect(spy).not.toHaveBeenCalled();
    expect(settings).toEqual(current);
    expect(reasons).toContain('作業の分類は無効（引き継ぎ元を踏襲）');
  });

  it('明示設定は分類より優先する', async () => {
    stubClassifier(assess());
    __mock.setConfig('agent', {
      'autoHandoff.model': 'gpt-5.6-astra',
      'autoHandoff.effort': 'xhigh',
    });
    const { settings } = await proposeHandoffModelSettings(current, input, deps());
    expect(settings).toEqual({ model: 'gpt-5.6-astra', effort: 'xhigh' });
  });

  it('明示モデルで非対応のeffortは未指定へ戻す', async () => {
    stubClassifier(assess({ difficulty: 2 })); // xhigh を選ばせる
    __mock.setConfig('agent', { 'autoHandoff.model': 'legacy-model' });
    const withLegacy = [...models, model('legacy-model', ['low'])];
    const { settings, reasons } = await proposeHandoffModelSettings(current, input, {
      ...deps(),
      models: withLegacy,
    });
    expect(settings).toEqual({ model: 'legacy-model', effort: '' });
    expect(reasons).toContain('effortは指定モデルで非対応のため未指定に戻した');
  });

  it('会話しているCLIと同じプロバイダで分類させ、直前の失敗を補正へ渡す', async () => {
    const spy = stubClassifier(assess({ difficulty: 1 }));
    const { settings } = await proposeHandoffModelSettings(
      current,
      { ...input, turnFailed: true },
      { provider: 'claude', executable: '/usr/bin/claude', models },
    );
    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      provider: 'claude',
      executable: '/usr/bin/claude',
    });
    // difficulty 1 → 失敗で2 → xhigh
    expect(settings.effort).toBe('xhigh');
  });
});

describe('chooseHandoffModelSettings（引き継ぎ前の確認）', () => {
  beforeEach(() => {
    __mock.reset();
    vi.restoreAllMocks();
  });

  it('「引き継ぐ」で提案をそのまま返す', async () => {
    stubClassifier(assess({ difficulty: 1, scope: 1 }));
    __mock.showInformationMessageAnswer = '引き継ぐ';
    const choice = await chooseHandoffModelSettings(current, input, deps());
    expect(choice?.settings).toEqual({ model: 'gpt-5.6-terra', effort: 'high' });
    expect(__mock.messages.infos[0]).toContain('Model: gpt-5.6-terra / Effort: high');
  });

  it('ダイアログを閉じたら undefined（引き継ぎを中止）', async () => {
    stubClassifier(assess());
    __mock.showInformationMessageAnswer = undefined;
    expect(await chooseHandoffModelSettings(current, input, deps())).toBeUndefined();
  });

  it('「モデルを選び直す」で一覧から選んだ値を返し、理由に提案を残す', async () => {
    stubClassifier(assess());
    __mock.showInformationMessageAnswer = 'モデルを選び直す';
    __mock.showQuickPickAnswer = (items) => {
      const list = items as { label: string; slug?: string; effort?: string }[];
      return list.find((i) => i.slug === 'gpt-5.6-astra') ?? list.find((i) => i.effort === 'high');
    };
    const choice = await chooseHandoffModelSettings(current, input, deps());
    expect(choice?.settings).toEqual({ model: 'gpt-5.6-astra', effort: 'high' });
    expect(choice?.reasons[0]).toContain('手動で指定（提案は gpt-5.6-terra / medium）');
  });

  it('一覧を閉じただけなら確認へ戻る', async () => {
    stubClassifier(assess());
    const answers = ['モデルを選び直す', '引き継ぐ'];
    const original = __mock.showInformationMessageAnswer;
    // 1回目は選び直し、2回目は承認
    __mock.showInformationMessageAnswer = answers[0];
    __mock.showQuickPickAnswer = () => {
      __mock.showInformationMessageAnswer = answers[1];
      return undefined;
    };
    const choice = await chooseHandoffModelSettings(current, input, deps());
    expect(choice?.settings).toEqual({ model: 'gpt-5.6-terra', effort: 'medium' });
    expect(__mock.messages.infos).toHaveLength(2);
    __mock.showInformationMessageAnswer = original;
  });

  it('「再判定」で分類をもう一度呼ぶ', async () => {
    __mock.showInformationMessageAnswer = '再判定';
    let asked = 0;
    // 1回目のダイアログで再判定、2回目で承認する
    const originalInfo = __mock.showInformationMessageAnswer;
    const spy = vi.spyOn(classifier, 'classifyHandoff').mockImplementation(async () => {
      asked += 1;
      if (asked === 2) {
        __mock.showInformationMessageAnswer = '引き継ぐ';
        return assess({ difficulty: 2, scope: 2, ambiguity: 2, risk: 2, autonomy: 2 });
      }
      return assess();
    });
    const choice = await chooseHandoffModelSettings(current, input, deps());
    expect(spy).toHaveBeenCalledTimes(2);
    expect(choice?.settings).toEqual({ model: 'gpt-5.6-astra', effort: 'xhigh' });
    __mock.showInformationMessageAnswer = originalInfo;
  });

  it('routerがOFFなら「再判定」ボタンを出さない', async () => {
    __mock.setConfig('agent', { 'autoHandoff.router': false });
    __mock.showInformationMessageAnswer = '引き継ぐ';
    const choice = await chooseHandoffModelSettings(current, input, deps());
    expect(choice?.settings).toEqual(current);
    // ボタンの並びは直接は取れないため、OFFでも承認経路が通ることだけを見る
    expect(__mock.messages.infos).toHaveLength(1);
  });
});

describe('probeSafeBoundary（Issue #1090）', () => {
  beforeEach(() => {
    __mock.reset();
    vi.restoreAllMocks();
  });

  it('routerがOFFなら分類器を起動せず undefined', async () => {
    __mock.setConfig('agent', { 'autoHandoff.router': false });
    const spy = vi.spyOn(classifier, 'classifyHandoff');
    expect(await probeSafeBoundary(current, input, deps())).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('分類に失敗したら undefined（区切り待ちの契機は発火させない）', async () => {
    vi.spyOn(classifier, 'classifyHandoff').mockResolvedValue(undefined);
    expect(await probeSafeBoundary(current, input, deps())).toBeUndefined();
  });

  it('switch_safe が false なら profileChanged を見ない', async () => {
    vi.spyOn(classifier, 'classifyHandoff').mockResolvedValue(
      assess({
        switchSafe: false,
        switchReason: '議論の途中',
        scope: 2,
        ambiguity: 2,
        risk: 2,
        autonomy: 2,
      }),
    );
    const probe = await probeSafeBoundary(current, input, deps());
    expect(probe).toMatchObject({
      switchSafe: false,
      switchReason: '議論の途中',
      profileChanged: false,
    });
    // 解決自体は行う（ログへ出すため）。`switchSafe` が false でも `profileChanged` は立たない
    expect(probe?.profile).toEqual({ model: 'gpt-5.6-astra', effort: 'high' });
  });

  it('switch_safe が true でモデルが変わるなら profileChanged', async () => {
    vi.spyOn(classifier, 'classifyHandoff').mockResolvedValue(
      assess({
        switchSafe: true,
        switchReason: '設計が終わった',
        scope: 2,
        ambiguity: 2,
        risk: 2,
        autonomy: 2,
      }),
    );
    const probe = await probeSafeBoundary(current, input, deps());
    expect(probe).toMatchObject({
      switchSafe: true,
      profileChanged: true,
      profile: { model: 'gpt-5.6-astra', effort: 'high' },
    });
  });

  it('ユーザー指示が変わらなくてもアシスタントの宣言で profileChanged が立つ（Issue #1097）', async () => {
    const spy = vi.spyOn(classifier, 'classifyHandoff').mockResolvedValue(
      assess({
        switchSafe: true,
        switchReason: '別件へ移ると宣言',
        scope: 2,
        ambiguity: 2,
        risk: 2,
        autonomy: 2,
      }),
    );
    const declared = {
      ...input,
      recentAssistantMessages: ['#782完了。次は新しい機能の設計に取り掛かる'],
    };
    const probe = await probeSafeBoundary(current, declared, deps());
    expect(probe).toMatchObject({ switchSafe: true, profileChanged: true });
    // 宣言が分類器まで届いていること（届かなければ切り替わりを検知できない）
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        recentAssistantMessages: ['#782完了。次は新しい機能の設計に取り掛かる'],
      }),
    );
  });

  it('分類器の handoffSuggested と根拠をそのまま通す（Issue #1097）', async () => {
    vi.spyOn(classifier, 'classifyHandoff').mockResolvedValue(
      assess({
        switchSafe: true,
        handoffSuggested: true,
        handoffSuggestReason: '別セッションでの実装を勧めている',
      }),
    );
    expect(await probeSafeBoundary(current, input, deps())).toMatchObject({
      handoffSuggested: true,
      handoffSuggestReason: '別セッションでの実装を勧めている',
    });
  });

  it('switch_safe が false でも handoffSuggested は通す（Issue #1097）', async () => {
    vi.spyOn(classifier, 'classifyHandoff').mockResolvedValue(
      assess({ switchSafe: false, handoffSuggested: true, handoffSuggestReason: '提案あり' }),
    );
    expect(await probeSafeBoundary(current, input, deps())).toMatchObject({
      switchSafe: false,
      handoffSuggested: true,
      handoffSuggestReason: '提案あり',
      // `profileChanged` の方は従来どおり `switchSafe` を要求する
      profileChanged: false,
    });
  });

  it('解決結果が今と同じなら profileChanged は false', async () => {
    vi.spyOn(classifier, 'classifyHandoff').mockResolvedValue(
      assess({ switchSafe: true, difficulty: 1, scope: 1, ambiguity: 1, risk: 1, autonomy: 1 }),
    );
    const probe = await probeSafeBoundary({ model: 'gpt-5.6-sol', effort: 'high' }, input, deps());
    expect(probe).toMatchObject({ switchSafe: true, profileChanged: false });
  });

  it('分類器は1回しか起動せず、その見立てを引き継ぎ先の決定へ使い回せる', async () => {
    const spy = vi
      .spyOn(classifier, 'classifyHandoff')
      .mockResolvedValue(assess({ switchSafe: true }));
    const probe = await probeSafeBoundary(current, input, deps());
    __mock.showInformationMessageAnswer = '引き継ぐ';
    const choice = await chooseHandoffModelSettings(current, input, deps(), probe?.assessment);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(choice?.settings).toEqual(probe?.profile);
  });
});
