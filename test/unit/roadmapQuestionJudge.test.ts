import { describe, expect, it } from 'vitest';
import { ASK_USER_QUESTION_NONE_OPTION } from '../../src/chat/autoReplyReflex';
import {
  findQuestionDangers,
  judgeRoadmapQuestion,
  needsUserDecision,
  type RoadmapAskArgs,
} from '../../src/orchestrator/roadmapQuestionMcp';
import { REFLEX_PROCESS_ERROR, REFLEX_TIMEOUT, reflexAnswers, reflexStub } from '../helpers/reflexStub';

/**
 * Issue #1717: 質問の判定（`judgeRoadmapQuestion`）の判定結果ごとの分岐と、Reflexを通さずに
 * 人へ回す質問の検査（Issue #1712）。
 */

const THRESHOLD = 0.8;
const A = '案Aで進める';
const B = '案Bで進める';

const QUESTION: Pick<RoadmapAskArgs, 'question' | 'reason' | 'options' | 'recommended' | 'evidence'> = {
  question: 'どちらの案で進めるか',
  reason: '仕様が2通りに読める',
  options: [A, B],
  recommended: undefined,
  evidence: undefined,
};

function probs(a: number, b: number, none: number) {
  return { probs: { [A]: a, [B]: b, [ASK_USER_QUESTION_NONE_OPTION]: none } };
}

describe('judgeRoadmapQuestion', () => {
  it('最上位の選択肢が閾値以上ならその選択肢で答える', async () => {
    const stub = reflexStub(reflexAnswers(probs(0.1, 0.85, 0.05)));
    await expect(judgeRoadmapQuestion(stub.deps, QUESTION, THRESHOLD)).resolves.toEqual({
      kind: 'answer',
      answer: B,
      summary: `質問1: ${B} 0.85`,
    });
  });

  it('最上位の選択肢が閾値未満なら人へ回す', async () => {
    const stub = reflexStub(reflexAnswers(probs(0.6, 0.3, 0.1)));
    await expect(judgeRoadmapQuestion(stub.deps, QUESTION, THRESHOLD)).resolves.toEqual({
      kind: 'human',
      summary: `質問1: ${A} 0.60`,
    });
  });

  it('「どれでもない」が最上位なら閾値以上でも人へ回す', async () => {
    const stub = reflexStub(reflexAnswers(probs(0.05, 0.05, 0.9)));
    await expect(judgeRoadmapQuestion(stub.deps, QUESTION, THRESHOLD)).resolves.toEqual({
      kind: 'human',
      summary: `質問1: ${ASK_USER_QUESTION_NONE_OPTION} 0.90`,
    });
  });

  it('確率の合計が幅の中なら1へ割り直して閾値と比べる（Issue #1715）', async () => {
    // 合計0.94。割り直すとA=0.77/0.94≒0.82で閾値を超える
    const stub = reflexStub(reflexAnswers(probs(0.77, 0.12, 0.05)));
    await expect(judgeRoadmapQuestion(stub.deps, QUESTION, THRESHOLD)).resolves.toEqual({
      kind: 'answer',
      answer: A,
      summary: `質問1: ${A} 0.82`,
    });
  });

  it.each([
    ['時間切れ', REFLEX_TIMEOUT],
    ['CLIの失敗', REFLEX_PROCESS_ERROR],
    ['不正なJSON', { ok: true as const, text: '{' }],
    // 割り直すとA=0.91で閾値を超えてしまう答え
    ['確率の合計が1から大きく外れた答え（Issue #1715）', reflexAnswers(probs(0.5, 0.05, 0))],
  ])('%sは人へ回す', async (_label, outcome) => {
    const stub = reflexStub(outcome);
    await expect(judgeRoadmapQuestion(stub.deps, QUESTION, THRESHOLD)).resolves.toEqual({
      kind: 'human',
      summary: 'Reflexで判定できなかった',
    });
  });

  it('CLIの呼び出しが例外を投げても人へ回す', async () => {
    const stub = reflexStub(new Error('spawn failed'));
    await expect(judgeRoadmapQuestion(stub.deps, QUESTION, THRESHOLD)).resolves.toEqual({
      kind: 'human',
      summary: 'Reflexで判定できなかった',
    });
  });

  it('推奨はその選択肢の説明として渡し、理由と材料を文脈へ入れる', async () => {
    const stub = reflexStub(reflexAnswers(probs(0.9, 0.05, 0.05)));
    await judgeRoadmapQuestion(stub.deps, { ...QUESTION, recommended: A, evidence: '設計メモ' }, THRESHOLD);
    const prompt = stub.prompts[0] ?? '';
    expect(prompt).toContain(`${A}: Orchestratorの推奨`);
    expect(prompt).not.toContain(`${B}: Orchestratorの推奨`);
    expect(prompt).toContain('判断が必要になった理由: 仕様が2通りに読める');
    expect(prompt).toContain('判断の材料: 設計メモ');
  });
});

describe('findQuestionDangers・needsUserDecision（Issue #1712・#1771）', () => {
  const safe: Pick<RoadmapAskArgs, 'question' | 'reason' | 'options' | 'evidence' | 'escalation'> = {
    ...QUESTION,
    escalation: [],
  };

  it('危険語もescalationも無く選択肢があればReflexへ回す', () => {
    expect(findQuestionDangers(safe)).toEqual({ userOnly: [], caution: [] });
    expect(needsUserDecision(safe)).toBe(false);
  });

  it('escalationが付いていれば人へ回す', () => {
    expect(needsUserDecision({ ...safe, escalation: ['specConflict'] })).toBe(true);
  });

  it('選択肢が無ければ人へ回す', () => {
    expect(needsUserDecision({ ...safe, options: [] })).toBe(true);
  });

  it.each([
    ['質問文', { question: 'mainへforce pushしてよいか' }, 'userOnly', 'リモートへの強制push'],
    ['理由', { reason: '本番のDBを触る' }, 'caution', '本番環境'],
    ['選択肢', { options: [A, 'リモートのブランチを削除する'] }, 'userOnly', 'ブランチ・タグの削除'],
    ['材料', { evidence: 'APIキーを.envへ書く' }, 'userOnly', 'secrets'],
    ['全角の英字', { question: 'ｆｏｒｃｅ ｐｕｓｈしてよいか' }, 'userOnly', 'リモートへの強制push'],
  ] as const)('%sの危険語でReflexに選ばせない', (_label, patch, side, expected) => {
    const args = { ...safe, ...patch };
    expect(findQuestionDangers(args)[side]).toContain(expected);
    expect(needsUserDecision(args)).toBe(true);
  });

  it('同じ危険が複数の欄に出ても1件にまとめる', () => {
    expect(
      findQuestionDangers({ ...safe, question: 'force pushするか', evidence: 'git push --force origin main' }),
    ).toEqual({ userOnly: ['リモートへの強制push'], caution: [] });
  });
});
