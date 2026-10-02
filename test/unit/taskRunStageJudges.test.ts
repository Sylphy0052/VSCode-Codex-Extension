import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __mock } from '../mocks/vscode';

vi.mock('../../src/orchestrator/roadmapQuestionMcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/orchestrator/roadmapQuestionMcp')>()),
  judgeRoadmapQuestion: vi.fn(),
}));
vi.mock('../../src/reflex/answererJudge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/reflex/answererJudge')>()),
  judgeQuestionAnswerer: vi.fn(),
}));

import { judgeRoadmapQuestion } from '../../src/orchestrator/roadmapQuestionMcp';
import type { GateJudgeQuestion } from '../../src/orchestrator/taskRunGates';
import {
  ANSWERER_USER_FALLBACK,
  judgeQuestionAnswerer,
  type AnswererQuestion,
} from '../../src/reflex/answererJudge';
import type { ReflexJudgeDeps } from '../../src/reflex/reflexJudge';
import { createStageReflexJudges } from '../../src/view/taskRunStageJudges';

const REFLEX_DEPS: ReflexJudgeDeps = {
  provider: 'claude',
  executable: 'claude',
  logWarn: () => undefined,
};

const GATE_QUESTION: GateJudgeQuestion = {
  question: '次の工程へ進めてよいか',
  reason: '検証が済んだ',
  options: ['進める', 'やり直す'],
  recommended: undefined,
  evidence: undefined,
};

const ANSWERER_QUESTION: AnswererQuestion = {
  source: 'stageSession',
  route: 'stageQuestion',
  question: 'どちらの実装にするか',
};

/** `agent`節の設定を置く。`chat.reflex.enabled`がグローバルの親スイッチ。 */
function setAgentConfig(values: Record<string, unknown>): void {
  __mock.setConfig('agent', values);
}

function makeJudges(canDecide = true) {
  const reflexDeps = vi.fn(() => REFLEX_DEPS);
  const judges = createStageReflexJudges({ reflexDeps, canDecide: () => canDecide });
  return { ...judges, reflexDeps };
}

beforeEach(() => {
  __mock.reset();
  vi.mocked(judgeRoadmapQuestion).mockReset();
  vi.mocked(judgeRoadmapQuestion).mockResolvedValue({
    kind: 'answer',
    answer: '進める',
    summary: 'Reflexの判定',
  });
  vi.mocked(judgeQuestionAnswerer).mockReset();
  vi.mocked(judgeQuestionAnswerer).mockResolvedValue({
    kind: 'orchestrator',
    summary: 'Reflexの判定',
  });
});

describe('judgeByReflex（Issue #1731）', () => {
  it('タブのReflexが無効なら、全体設定が有効でも人へ回しReflexを呼ばない', async () => {
    setAgentConfig({ 'chat.reflex.enabled': true, 'chat.autoReply.reflex.enabled': true });
    const { judgeByReflex, reflexDeps } = makeJudges();

    await expect(judgeByReflex('claude', GATE_QUESTION, false)).resolves.toEqual({
      kind: 'human',
      summary: undefined,
    });
    expect(judgeRoadmapQuestion).not.toHaveBeenCalled();
    expect(reflexDeps).not.toHaveBeenCalled();
  });

  it('タブの上書きが無ければ、全体設定が有効ならReflexで判定する', async () => {
    setAgentConfig({
      'chat.reflex.enabled': true,
      'chat.autoReply.reflex.answerThreshold': 0.7,
    });
    const { judgeByReflex, reflexDeps } = makeJudges();

    await expect(judgeByReflex('codex', GATE_QUESTION, undefined)).resolves.toEqual({
      kind: 'answer',
      answer: '進める',
      summary: 'Reflexの判定',
    });
    expect(reflexDeps).toHaveBeenCalledWith('codex');
    expect(judgeRoadmapQuestion).toHaveBeenCalledWith(REFLEX_DEPS, GATE_QUESTION, 0.7);
  });

  it('タブの上書きが無ければ、全体設定が無効なら人へ回す', async () => {
    setAgentConfig({ 'chat.reflex.enabled': false });
    const { judgeByReflex } = makeJudges();

    await expect(judgeByReflex('claude', GATE_QUESTION, undefined)).resolves.toEqual({
      kind: 'human',
      summary: undefined,
    });
    expect(judgeRoadmapQuestion).not.toHaveBeenCalled();
  });

  it('タブのReflexが有効なら、全体設定が無効でもReflexで判定する', async () => {
    setAgentConfig({ 'chat.reflex.enabled': false });
    const { judgeByReflex } = makeJudges();

    await judgeByReflex('claude', GATE_QUESTION, true);
    expect(judgeRoadmapQuestion).toHaveBeenCalledTimes(1);
  });

  it('タブのReflexが有効でも、agent.chat.autoReply.reflex.enabledが無効なら人へ回す', async () => {
    setAgentConfig({ 'chat.reflex.enabled': true, 'chat.autoReply.reflex.enabled': false });
    const { judgeByReflex } = makeJudges();

    await expect(judgeByReflex('claude', GATE_QUESTION, true)).resolves.toEqual({
      kind: 'human',
      summary: undefined,
    });
    expect(judgeRoadmapQuestion).not.toHaveBeenCalled();
  });
});

describe('judgeAnswerer（Issue #1731）', () => {
  it('タブのReflexが無効なら、全体設定が有効でもユーザーへ回しReflexを呼ばない', async () => {
    setAgentConfig({ 'chat.reflex.enabled': true, 'chat.answererJudge.enabled': true });
    const { judgeAnswerer, reflexDeps } = makeJudges();

    await expect(judgeAnswerer('run-1', 'claude', ANSWERER_QUESTION, false)).resolves.toEqual(
      ANSWERER_USER_FALLBACK,
    );
    expect(judgeQuestionAnswerer).not.toHaveBeenCalled();
    expect(reflexDeps).not.toHaveBeenCalled();
  });

  it('タブの上書きが無ければ、全体設定に従う', async () => {
    setAgentConfig({ 'chat.reflex.enabled': true, 'chat.answererJudge.threshold': 0.6 });
    const { judgeAnswerer } = makeJudges();

    await expect(judgeAnswerer('run-1', 'codex', ANSWERER_QUESTION, undefined)).resolves.toEqual({
      kind: 'orchestrator',
      summary: 'Reflexの判定',
    });
    expect(judgeQuestionAnswerer).toHaveBeenCalledWith(
      REFLEX_DEPS,
      ANSWERER_QUESTION,
      0.6,
      undefined,
    );

    vi.mocked(judgeQuestionAnswerer).mockClear();
    setAgentConfig({ 'chat.reflex.enabled': false });
    await expect(judgeAnswerer('run-1', 'codex', ANSWERER_QUESTION, undefined)).resolves.toEqual(
      ANSWERER_USER_FALLBACK,
    );
    expect(judgeQuestionAnswerer).not.toHaveBeenCalled();
  });

  it('タブのReflexが有効でも、agent.chat.answererJudge.enabledが無効ならユーザーへ回す', async () => {
    setAgentConfig({ 'chat.reflex.enabled': true, 'chat.answererJudge.enabled': false });
    const { judgeAnswerer } = makeJudges();

    await expect(judgeAnswerer('run-1', 'claude', ANSWERER_QUESTION, true)).resolves.toEqual(
      ANSWERER_USER_FALLBACK,
    );
    expect(judgeQuestionAnswerer).not.toHaveBeenCalled();
  });

  it('Orchestratorへ任せられないrunなら、Reflexが有効でもユーザーへ回す', async () => {
    setAgentConfig({ 'chat.reflex.enabled': true });
    const { judgeAnswerer } = makeJudges(false);

    await expect(judgeAnswerer('run-1', 'claude', ANSWERER_QUESTION, true)).resolves.toEqual(
      ANSWERER_USER_FALLBACK,
    );
    expect(judgeQuestionAnswerer).not.toHaveBeenCalled();
  });
});
