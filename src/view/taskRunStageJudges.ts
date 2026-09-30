import { readAnswererJudgeConfig, readAutoReplyReflexConfig, readReflexEnabled } from '../config';
import {
  judgeRoadmapQuestion,
  type RoadmapQuestionVerdict,
} from '../orchestrator/roadmapQuestionMcp';
import type { GateJudgeQuestion } from '../orchestrator/taskRunGates';
import type { TaskRunEngine } from '../orchestrator/taskRunState';
import {
  ANSWERER_USER_FALLBACK,
  judgeQuestionAnswerer,
  type AnswererQuestion,
  type AnswererVerdict,
} from '../reflex/answererJudge';
import type { ReflexJudgeDeps } from '../reflex/reflexJudge';

export interface StageReflexJudgeDeps {
  /** 判定に使うCLIの依存。判定しないときは呼ばない。 */
  reflexDeps: (engine: TaskRunEngine) => ReflexJudgeDeps;
  /** runのOrchestratorが回答を引き受けられるか。 */
  canDecide: (runId: string) => boolean;
}

export interface StageReflexJudges {
  judgeByReflex: (
    engine: TaskRunEngine,
    question: GateJudgeQuestion,
    reflexEnabled: boolean | undefined,
  ) => Promise<RoadmapQuestionVerdict>;
  judgeAnswerer: (
    runId: string,
    engine: TaskRunEngine,
    question: AnswererQuestion,
    reflexEnabled: boolean | undefined,
  ) => Promise<AnswererVerdict>;
}

/**
 * 工程セッションの質問・関門を判定する口を作る。`setupTaskRun`から切り出し、タブのReflex設定で
 * 人へ回す分岐を単体テストできるようにした（Issue #1731）。
 */
export function createStageReflexJudges(deps: StageReflexJudgeDeps): StageReflexJudges {
  return {
    // 工程の質問・関門の自動回答。工程セッションのタブのReflex（`reflexEnabled`。`undefined`なら
    // グローバル設定）と`agent.chat.autoReply.reflex.enabled`のどちらかが無効ならユーザーへ回す（Issue #1727）
    judgeByReflex: async (engine, question, reflexEnabled) => {
      const settings = readAutoReplyReflexConfig(reflexEnabled ?? readReflexEnabled());
      return settings.enabled
        ? judgeRoadmapQuestion(deps.reflexDeps(engine), question, settings.answerThreshold)
        : { kind: 'human', summary: undefined };
    },
    // 回答者判定（Issue #1708）。無効、またはOrchestratorへ任せられないならすべてユーザーへ回す。
    // 工程セッションからの問いなので、そのタブのReflexに従う（Issue #1727）
    judgeAnswerer: async (runId, engine, question, reflexEnabled) => {
      const settings = readAnswererJudgeConfig(reflexEnabled ?? readReflexEnabled());
      return settings.enabled && deps.canDecide(runId)
        ? judgeQuestionAnswerer(deps.reflexDeps(engine), question, settings.threshold)
        : ANSWERER_USER_FALLBACK;
    },
  };
}
