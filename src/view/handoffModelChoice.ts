import {
  readAutoHandoffEffort,
  readAutoHandoffModel,
  readAutoHandoffRouterEnabled,
} from '../config';
import { effortsFor, type ModelInfo } from '../codex/modelCatalog';
import type { HeadlessProvider } from '../loop/headlessCli';
import type { SessionModelSettings } from '../sessionModelSettings';
import { judgeHandoffLevel, type HandoffJudgeInput } from './handoffLevelJudge';
import { resolveLevelSettings } from './handoffRouter';

/**
 * 引き継ぎ先セッションのmodel / effortを決める（Issue #1082）。
 *
 * 優先順位は上から順に、明示設定（`agent.autoHandoff.model` / `.effort`）、CLIのヘッドレス
 * 実行による判定、引き継ぎ元の値。上位で決まったものを下位で上書きしない。ここは設定を
 * 読むためvscodeに依存する。判定そのものは `handoffLevelJudge.ts`、レベルからmodel /
 * effortへの解決は `handoffRouter.ts` に分けてある。
 */

export interface HandoffModelChoiceDeps {
  /** 引き継ぎ元が会話しているCLI。判定も同じCLIで走らせる。 */
  provider: HeadlessProvider;
  /** 判定に使うCLIの実行ファイル。 */
  executable: string;
  models: readonly ModelInfo[];
  /** カタログからeffort一覧を取れないときの退避先（Claude Codeは `CLAUDE_EFFORTS`）。 */
  fallbackEfforts?: readonly string[];
  logWarn?: (message: string) => void;
}

/**
 * @param current 引き継ぎ元のmodel / effort
 * @returns 決まった設定と、そうなった理由（ポインタファイルとログへ出す）
 */
export async function resolveHandoffModelSettings(
  current: SessionModelSettings,
  input: HandoffJudgeInput,
  deps: HandoffModelChoiceDeps,
): Promise<{ settings: SessionModelSettings; reasons: string[] }> {
  const settings: SessionModelSettings = { model: current.model, effort: current.effort };
  const reasons: string[] = [];

  if (readAutoHandoffRouterEnabled()) {
    const judgement = await judgeHandoffLevel(
      {
        provider: deps.provider,
        executable: deps.executable,
        ...(deps.logWarn === undefined ? {} : { logWarn: deps.logWarn }),
      },
      input,
    );
    if (judgement === undefined) {
      // 判定できなかったときは引き継ぎ元をそのまま持ち越す。グローバル設定へ戻すと、
      // 引き継ぎ元でわざわざ変えた設定を判定の失敗だけで捨てることになる
      reasons.push('レベル判定に失敗したため引き継ぎ元を踏襲');
    } else {
      const resolved = resolveLevelSettings(
        judgement.level,
        deps.models,
        current,
        deps.fallbackEfforts,
      );
      settings.model = resolved.model;
      settings.effort = resolved.effort;
      reasons.push(`L${judgement.level}: ${judgement.reason}`);
    }
  } else {
    reasons.push('レベル判定は無効（引き継ぎ元を踏襲）');
  }

  const explicitModel = readAutoHandoffModel();
  if (explicitModel !== '') {
    settings.model = explicitModel;
    reasons.push(`設定 agent.autoHandoff.model=${explicitModel}`);
    // モデルが変わるとeffortの選べる値も変わる。判定が前のモデル向けに選んだ値がそのまま
    // 残ると、非対応のeffortをCLIへ渡すことになる
    if (settings.effort !== '') {
      const allowed =
        deps.fallbackEfforts === undefined
          ? effortsFor([...deps.models], explicitModel)
          : effortsFor([...deps.models], explicitModel, deps.fallbackEfforts);
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
