import { effortsFor, findModel, type ModelInfo } from '../codex/modelCatalog';
import type { HandoffClassifierInput } from '../view/handoffClassifier';
import { STAGE_LABELS } from './taskStagePrompts';
import type { OrchestratedTask, TaskRun, TaskStage } from './taskRunState';

/**
 * オーケストレータモード（Issue #1505）の工程セッションのModel/Effort。
 *
 * 推奨値は引き継ぎ用の判定（`proposeHandoffModelSettings`）を、工程の種類とタスクの内容を
 * 入力にして流用する。ここでは判定の入力を組むだけで、判定の呼び出しは依存で受ける
 * （判定はvscodeの設定を読むため）。Orchestratorが選んだ値はエンジンのモデル一覧と照合する。
 */

export interface StageSettingsRecommendation {
  model: string;
  effort: string;
  reasons: readonly string[];
}

const MAX_MODEL_LENGTH = 100;
const MAX_EFFORT_LENGTH = 32;
const MODEL_PATTERN = /^[A-Za-z0-9._:/[\]-]+$/;
const EFFORT_PATTERN = /^[A-Za-z0-9_-]*$/;
/** 拒否の理由に並べるモデルの上限。 */
const MAX_LISTED_MODELS = 20;
const CLASSIFIER_TEXT_LIMIT = 1500;

/** 工程ごとの作業の説明。分類器が作業の重さを見立てる材料にする。 */
const STAGE_WORK: Record<TaskStage, string> = {
  issuePlan:
    'コードを読み、Issueのタイトルと本文（Spec、受入基準、分割）を設計する。ファイルは書かない',
  issueCreate: '決まった本文でforgeにIssueを起票し、番号を報告するだけの機械的な作業',
  implement: 'タスク専用のworktreeで実装し、commitしてpushし、PRを作る',
  review: 'PRの差分をレビューし、high・mediumの指摘を直してpushする',
  mergeCleanup:
    '最新のmainを取り込み、merge直前の手順（版上げ等）を行ってmergeし、リモートブランチを消す。手順が決まった機械的な作業',
};

function clip(text: string): string {
  return [...text].length > CLASSIFIER_TEXT_LIMIT
    ? `${[...text].slice(0, CLASSIFIER_TEXT_LIMIT).join('')}…`
    : text;
}

/** 前の工程までの成果の要約。 */
function priorOutputs(task: OrchestratedTask): string[] {
  const lines: string[] = [];
  if (task.issueDraft !== undefined) {
    lines.push(`Issue本文の案: ${clip(task.issueDraft.body)}`);
  }
  if (task.issueNumber !== undefined) {
    lines.push(`Issue: #${String(task.issueNumber)}`);
  }
  if (task.pullRequest !== undefined) {
    lines.push(`PR: #${String(task.pullRequest.number)}`);
  }
  if (task.review !== undefined) {
    lines.push(
      `レビュー: ${task.review.passed ? '通過' : '指摘あり'} 残した指摘${String(task.review.remainingFindings.length)}件`,
    );
  }
  return lines;
}

/** 工程の推奨値を判定する入力を組む。 */
export function buildStageClassifierInput(
  run: TaskRun,
  task: OrchestratedTask,
  stage: TaskStage,
): HandoffClassifierInput {
  const request = [
    `工程: ${STAGE_LABELS[stage]}（${STAGE_WORK[stage]}）`,
    `タスク: ${task.title}`,
    `目的: ${clip(task.summary)}`,
    `受入基準: ${clip(task.acceptanceCriteria.join(' / '))}`,
  ].join('\n');
  return {
    recentUserMessages: [request],
    recentAssistantMessages: priorOutputs(task),
    turnFailed: task.stages[stage].attempts.length > 0,
    cwd: task.worktreePath ?? run.workspaceRoot,
    gitBranch: task.branch,
    turnEditedFiles: [],
  };
}

export type StageSettingsCheck =
  | { ok: true; model: string; effort: string }
  | { ok: false; message: string };

/**
 * OrchestratorのModel/Effortを検証する。モデル一覧が取れていればその一覧と照合し、取れて
 * いなければ文字種と長さだけを見る（一覧が無いだけで工程を始められなくしない）。
 * effortの空文字はCLIの既定に任せる意味で受け付ける。
 */
export function checkStageSettings(
  models: readonly ModelInfo[],
  fallbackEfforts: readonly string[],
  rawModel: string,
  rawEffort: string,
): StageSettingsCheck {
  const model = rawModel.trim();
  const effort = rawEffort.trim();
  if (model === '' || model.length > MAX_MODEL_LENGTH || !MODEL_PATTERN.test(model)) {
    return { ok: false, message: 'modelが不正（英数字と._:/[]-の1〜100文字）' };
  }
  if (effort.length > MAX_EFFORT_LENGTH || !EFFORT_PATTERN.test(effort)) {
    return { ok: false, message: 'effortが不正（英数字と_-の32文字以内）' };
  }
  if (models.length === 0) {
    return { ok: true, model, effort };
  }
  if (findModel([...models], model) === undefined) {
    const listed = models
      .slice(0, MAX_LISTED_MODELS)
      .map((m) => m.slug)
      .join(', ');
    return { ok: false, message: `このエンジンで使えないmodel: ${model}（使える値: ${listed}）` };
  }
  const efforts = effortsFor([...models], model, fallbackEfforts);
  if (effort !== '' && !efforts.includes(effort)) {
    return {
      ok: false,
      message:
        efforts.length === 0
          ? `${model}はeffortを指定できない。effortは空文字にする`
          : `${model}で使えないeffort: ${effort}（使える値: ${efforts.join(', ')}）`,
    };
  }
  return { ok: true, model, effort };
}
