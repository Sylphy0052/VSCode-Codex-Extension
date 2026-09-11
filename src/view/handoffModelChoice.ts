import * as vscode from 'vscode';
import {
  readAutoHandoffEffort,
  readAutoHandoffModel,
  readAutoHandoffRouterEnabled,
} from '../config';
import { effortsFor, type ModelInfo } from '../codex/modelCatalog';
import type { HeadlessProvider } from '../loop/headlessCli';
import type { SessionModelSettings } from '../sessionModelSettings';
import { classifyHandoff, type HandoffClassifierInput } from './handoffClassifier';
import { resolveProfile } from './handoffRouter';

/**
 * 引き継ぎ先セッションのmodel / effortを決め、**引き継ぐ前に人へ確認する**（Issue #1082）。
 *
 * 決め方の優先順位は上から順に、明示設定（`agent.autoHandoff.model` / `.effort`）、分類器
 * の見立てからの解決、引き継ぎ元の値。上位で決まったものを下位で上書きしない。
 *
 * 決まった値は確認ダイアログに出し、人が「引き継ぐ」を選んだときだけ先へ進む。手動でも
 * 自動（コンテキスト逼迫）でも同じ。自動で最上位のモデルが選ばれたまま黙って走り出すのを
 * 防ぐためで、ダイアログでは選び直し（モデルとeffortを一覧から選ぶ）と再判定（分類器を
 * もう一度呼ぶ）もできる。閉じたときは引き継ぎ自体を中止する。
 *
 * ここは設定を読みダイアログを出すためvscodeに依存する。分類は `handoffClassifier.ts`、
 * 見立てからmodel / effortへの解決は `handoffRouter.ts` に分けてある。
 */

export interface HandoffModelChoiceDeps {
  /** 引き継ぎ元が会話しているCLI。分類も同じCLIで走らせる。 */
  provider: HeadlessProvider;
  /** 分類に使うCLIの実行ファイル。 */
  executable: string;
  models: readonly ModelInfo[];
  /** カタログからeffort一覧を取れないときの退避先（Claude Codeは `CLAUDE_EFFORTS`）。 */
  fallbackEfforts?: readonly string[];
  logWarn?: (message: string) => void;
}

export interface HandoffModelChoice {
  settings: SessionModelSettings;
  /** そうなった理由。ポインタファイルとログへ出す。 */
  reasons: string[];
}

const PROCEED = '引き継ぐ';
const REPICK = 'モデルを選び直す';
const RECLASSIFY = '再判定';

function label(value: string): string {
  return value === '' ? '既定' : value;
}

function allowedEfforts(deps: HandoffModelChoiceDeps, model: string): string[] {
  return deps.fallbackEfforts === undefined
    ? effortsFor([...deps.models], model)
    : effortsFor([...deps.models], model, deps.fallbackEfforts);
}

/**
 * 分類と設定から候補を1つ作る。ダイアログは出さない。
 *
 * 分類に失敗したときは引き継ぎ元をそのまま持ち越す。グローバル設定へ戻すと、引き継ぎ元で
 * わざわざ変えた設定を分類の失敗だけで捨てることになる。
 */
export async function proposeHandoffModelSettings(
  current: SessionModelSettings,
  input: HandoffClassifierInput,
  deps: HandoffModelChoiceDeps,
): Promise<HandoffModelChoice> {
  const settings: SessionModelSettings = { model: current.model, effort: current.effort };
  const reasons: string[] = [];

  if (readAutoHandoffRouterEnabled()) {
    const assessment = await classifyHandoff(
      {
        provider: deps.provider,
        executable: deps.executable,
        ...(deps.logWarn === undefined ? {} : { logWarn: deps.logWarn }),
      },
      input,
    );
    if (assessment === undefined) {
      reasons.push('作業の分類に失敗したため引き継ぎ元を踏襲');
    } else {
      const resolved = resolveProfile(
        assessment,
        { turnFailed: input.turnFailed },
        deps.models,
        current,
        deps.fallbackEfforts,
      );
      settings.model = resolved.model;
      settings.effort = resolved.effort;
      reasons.push(...resolved.reasons);
      if (assessment.reasons.length > 0) {
        reasons.push(`分類器: ${assessment.reasons.join('、')}`);
      }
      reasons.push(`confidence=${assessment.confidence.toFixed(2)}`);
    }
  } else {
    reasons.push('作業の分類は無効（引き継ぎ元を踏襲）');
  }

  const explicitModel = readAutoHandoffModel();
  if (explicitModel !== '') {
    settings.model = explicitModel;
    reasons.push(`設定 agent.autoHandoff.model=${explicitModel}`);
    // モデルが変わるとeffortの選べる値も変わる。解決が前のモデル向けに選んだ値がそのまま
    // 残ると、非対応のeffortをCLIへ渡すことになる
    if (settings.effort !== '' && !allowedEfforts(deps, explicitModel).includes(settings.effort)) {
      settings.effort = '';
      reasons.push('effortは指定モデルで非対応のため未指定に戻した');
    }
  }

  const explicitEffort = readAutoHandoffEffort();
  if (explicitEffort !== '') {
    settings.effort = explicitEffort;
    reasons.push(`設定 agent.autoHandoff.effort=${explicitEffort}`);
  }

  return { settings, reasons };
}

/** モデルとeffortを一覧から選ばせる。途中で閉じたら `undefined`。 */
async function pickManually(
  current: SessionModelSettings,
  deps: HandoffModelChoiceDeps,
): Promise<SessionModelSettings | undefined> {
  const modelItems: (vscode.QuickPickItem & { slug: string })[] = [
    {
      label: `$(arrow-right) 引き継ぎ元のまま（${label(current.model)}）`,
      slug: current.model,
    },
    ...deps.models.map((m) => ({
      label: m.displayName,
      ...(m.description === undefined ? {} : { description: m.description }),
      ...(m.slug === m.displayName ? {} : { detail: m.slug }),
      slug: m.slug,
    })),
  ];
  const pickedModel = await vscode.window.showQuickPick(modelItems, {
    title: '引き継ぎ先のモデル',
    placeHolder: '引き継ぎ先のセッションで使うモデルを選ぶ',
  });
  if (pickedModel === undefined) {
    return undefined;
  }

  const efforts = allowedEfforts(deps, pickedModel.slug);
  if (efforts.length === 0) {
    return { model: pickedModel.slug, effort: '' };
  }
  const effortItems: (vscode.QuickPickItem & { effort: string })[] = [
    { label: '既定', description: 'CLIの既定に任せる', effort: '' },
    ...efforts.map((e) => ({ label: e, effort: e })),
  ];
  const pickedEffort = await vscode.window.showQuickPick(effortItems, {
    title: '引き継ぎ先のeffort',
    placeHolder: `${pickedModel.label} で使うeffortを選ぶ`,
  });
  if (pickedEffort === undefined) {
    return undefined;
  }
  return { model: pickedModel.slug, effort: pickedEffort.effort };
}

/**
 * 候補を人へ見せ、承認・選び直し・再判定のいずれかを受ける。
 *
 * @returns 承認された設定。ダイアログを閉じたときは `undefined`（引き継ぎを中止する）
 */
export async function chooseHandoffModelSettings(
  current: SessionModelSettings,
  input: HandoffClassifierInput,
  deps: HandoffModelChoiceDeps,
): Promise<HandoffModelChoice | undefined> {
  let proposal = await proposeHandoffModelSettings(current, input, deps);
  const canReclassify = readAutoHandoffRouterEnabled();

  for (;;) {
    const buttons = canReclassify ? [PROCEED, REPICK, RECLASSIFY] : [PROCEED, REPICK];
    const answer = await vscode.window.showInformationMessage(
      `この設定で引き継ぎますか？\nModel: ${label(proposal.settings.model)} / Effort: ${label(proposal.settings.effort)}`,
      { modal: true, detail: proposal.reasons.join('\n') },
      ...buttons,
    );
    if (answer === PROCEED) {
      return proposal;
    }
    if (answer === REPICK) {
      const picked = await pickManually(current, deps);
      if (picked !== undefined) {
        return {
          settings: picked,
          reasons: [
            `手動で指定（提案は ${label(proposal.settings.model)} / ${label(proposal.settings.effort)}）`,
          ],
        };
      }
      // 一覧を閉じただけなら確認へ戻る。引き継ぎ自体を中止したい意思ではない
      continue;
    }
    if (answer === RECLASSIFY) {
      proposal = await proposeHandoffModelSettings(current, input, deps);
      continue;
    }
    return undefined;
  }
}
