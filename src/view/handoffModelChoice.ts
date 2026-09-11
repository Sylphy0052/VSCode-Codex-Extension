import {
  readAutoHandoffEffort,
  readAutoHandoffModel,
  readAutoHandoffRouterEnabled,
} from '../config';
import { effortsFor, type ModelInfo } from '../codex/modelCatalog';
import type { SessionModelSettings } from '../sessionModelSettings';
import { decideHandoffModel, type HandoffRouterInput } from './handoffRouter';

/**
 * 引き継ぎ先セッションのmodel / effortを決める（Issue #1082）。
 *
 * 優先順位は上から順に、明示設定（`agent.autoHandoff.model` / `.effort`）、ルータの判定、
 * 引き継ぎ元の値。上位で決まったものを下位で上書きしない。ここは設定を読むためvscodeに
 * 依存する。判定そのものは `handoffRouter.ts` の純関数に閉じてある。
 *
 * @param current 引き継ぎ元のmodel / effort
 * @param fallbackEfforts カタログからeffort一覧を取れないときの退避先（Claude Codeは `CLAUDE_EFFORTS`）
 */
export function resolveHandoffModelSettings(
  current: SessionModelSettings,
  models: readonly ModelInfo[],
  input: HandoffRouterInput,
  fallbackEfforts?: readonly string[],
): { settings: SessionModelSettings; reasons: string[] } {
  const settings: SessionModelSettings = { model: current.model, effort: current.effort };
  const reasons: string[] = [];

  if (readAutoHandoffRouterEnabled()) {
    const decision = decideHandoffModel(input, models, current, fallbackEfforts);
    if (decision === undefined) {
      reasons.push('ルータは判定材料を得られず引き継ぎ元を踏襲');
    } else {
      settings.model = decision.model;
      settings.effort = decision.effort;
      reasons.push(...decision.reasons);
    }
  } else {
    reasons.push('ルータは無効（引き継ぎ元を踏襲）');
  }

  const explicitModel = readAutoHandoffModel();
  if (explicitModel !== '') {
    settings.model = explicitModel;
    reasons.push(`設定 agent.autoHandoff.model=${explicitModel}`);
    // モデルが変わるとeffortの選べる値も変わる。ルータが前のモデル向けに選んだ値が
    // そのまま残ると、非対応のeffortをCLIへ渡すことになる
    if (settings.effort !== '') {
      const allowed =
        fallbackEfforts === undefined
          ? effortsFor([...models], explicitModel)
          : effortsFor([...models], explicitModel, fallbackEfforts);
      if (!allowed.includes(settings.effort)) {
        settings.effort = '';
        reasons.push('effortは指定モデルで非対応のため未指定に戻した');
      }
    }
  }

  const explicitEffort = readAutoHandoffEffort();
  if (explicitEffort !== '') {
    settings.effort = explicitEffort;
    reasons.push(`設定 agent.autoHandoff.effort=${explicitEffort}`);
  }

  return { settings, reasons };
}
