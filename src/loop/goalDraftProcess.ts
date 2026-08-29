import { describeRedaction, redactCredentials } from '../secondOpinion/redact';
import type { GoalDefinition } from './goalLoop';
import { buildGoalDraftPrompt, parseGoalDraft } from './goalDraft';
import {
  runHeadlessPrompt,
  type HeadlessProvider,
  type HeadlessProviderSetting,
} from './headlessCli';

/**
 * 一文からゴール定義の下書きを作る準備ターン（issue #958）を、CLIのヘッドレス実行として呼ぶ。
 *
 * 起動条件はEvaluator（§14.81）・Advisor（§14.95）と同じ。ツールを渡さず（claudeは
 * `--tools ""`、codexは`--sandbox read-only`）、利用者の設定も読ませない。**準備役は
 * 作業をしない**——ここでファイルを触られると、ゴールが決まる前に作業が始まってしまう。
 */

/** 設定 `agent.chat.loop.autoGoal.provider` の値。 */
export type GoalDraftProviderSetting = HeadlessProviderSetting;

/** 実際に起動するCLI。 */
export type GoalDraftProvider = HeadlessProvider;

export interface GoalDraftSettings {
  enabled: boolean;
  /** 下書きを人が確認してから始めるか。**既定`true`。** */
  confirm: boolean;
  provider: GoalDraftProviderSetting;
  model: string;
  timeoutSeconds: number;
}

export interface GoalDraftDeps {
  provider: GoalDraftProvider;
  executable: string;
  model: string;
  timeoutMs: number;
  /** 失敗の記録先。**プロンプトと応答の本文は出さない。** */
  logWarn?: (message: string) => void;
  logInfo?: (message: string) => void;
}

/**
 * 下書きの出所（issue #962）。
 *
 * `buildGoalDraftPrompt`はIssue本文を囲って渡すが、モデルがJSONを返した時点で「外部の
 * Issueに由来する」という情報は消える。囲いはモデルが従う保証のある仕組みではないので、
 * **1回AIを通しただけで信頼済みへ昇格させない**ために出所を持ち回る。
 *
 * - `user-only`: 材料が利用者の書いた一文だけ
 * - `external-issue`: 外部（GitHubのIssue本文）を材料に含む
 */
export type GoalDraftProvenance = 'user-only' | 'external-issue';

/** 準備ターンの結果。失敗の理由を画面へそのまま出せるようにしておく。 */
export type GoalDraftResult =
  | { ok: true; goal: GoalDefinition; provenance: GoalDraftProvenance }
  | { ok: false; message: string };

/**
 * 準備ターンのプロンプトを組み立て、資格情報らしき文字列を伏せる。
 *
 * 材料には一文とIssue本文が入る。どちらも利用者の環境の外（モデルサービス）へ渡るため、
 * §14.80と同じ扱いにする。送信経路と切り離してexportしてあるのは、伏せていることを
 * 単体テストで固定するため。
 */
export function redactGoalDraftPrompt(
  request: string,
  issueBody?: string,
): ReturnType<typeof redactCredentials> {
  return redactCredentials(buildGoalDraftPrompt(request, issueBody));
}

/**
 * 準備ターンを1回だけ呼ぶ関数を作る。
 *
 * **失敗しても例外を投げない。** CLIが落ちた・タイムアウトした・JSONが読めない・目的か
 * 受入基準が空のいずれも`ok: false`で返し、呼び出し側は3欄を空のまま残してループを
 * 始めない。中途半端な下書きで走り出すと、外れたゴールのまま何十周も回ることになる。
 */
export function createGoalDraftPlanner(
  deps: GoalDraftDeps,
): (request: string, issueBody?: string) => Promise<GoalDraftResult> {
  return async (request: string, issueBody?: string): Promise<GoalDraftResult> => {
    const redaction = redactGoalDraftPrompt(request, issueBody);
    const note = describeRedaction(redaction);
    if (note !== undefined) {
      deps.logInfo?.(`ゴールの下書きを頼む前に伏せました: ${note}`);
    }
    try {
      const raw = await runHeadlessPrompt(deps, redaction.text);
      if (raw === undefined) {
        deps.logWarn?.('ゴールの下書きの生成に失敗しました（応答なし）');
        return { ok: false, message: 'ゴールの下書きを作れませんでした（応答がありません）' };
      }
      const goal = parseGoalDraft(raw);
      if (goal === undefined) {
        deps.logWarn?.('ゴールの下書きの応答を読めませんでした');
        return {
          ok: false,
          message: 'ゴールの下書きを読み取れませんでした。目的と受入基準を手で入力してください',
        };
      }
      return {
        ok: true,
        goal,
        provenance: issueBody === undefined ? 'user-only' : 'external-issue',
      };
    } catch (e) {
      deps.logWarn?.(`ゴールの下書きの生成で例外が出ました: ${errorMessage(e)}`);
      return { ok: false, message: 'ゴールの下書きの生成に失敗しました' };
    }
  };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
