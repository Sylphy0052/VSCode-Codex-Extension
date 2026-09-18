import * as vscode from 'vscode';
import {
  readAutoHandoffCostPreset,
  readAutoHandoffEffort,
  readAutoHandoffModel,
  readAutoHandoffRouterEnabled,
  setAutoHandoffCostPreset,
  type HandoffCostPresetAgent,
} from '../config';
import { effortsFor, type ModelInfo } from '../codex/modelCatalog';
import type { HeadlessProvider } from '../loop/headlessCli';
import type { SessionModelSettings } from '../sessionModelSettings';
import { classifyHandoff, type HandoffClassifierInput } from './handoffClassifier';
import type { SessionHandoffModelOption } from './sessionHub';
import {
  isProfileChange,
  resolveProfile,
  type CostPreset,
  type TaskAssessment,
} from './handoffRouter';

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
  /** 分類の待ち時間（Issue #1097）。省略時は `CLASSIFIER_TIMEOUT_MS`。 */
  timeoutMs?: number;
  logWarn?: (message: string) => void;
}

export interface HandoffModelChoice {
  settings: SessionModelSettings;
  /** そうなった理由。ポインタファイルとログへ出す。 */
  reasons: string[];
}

/**
 * 確認への答え（Issue #1280）。モーダルのボタンと統括ページのボタンで同じ型を使う。
 */
export type HandoffDecision =
  | { kind: 'proceed' }
  | { kind: 'repick'; settings: SessionModelSettings }
  | { kind: 'reclassify' }
  | { kind: 'cancel' };

/** 保留を画面へ出すために必要な、提案そのもの以外の情報（Issue #1280）。 */
export interface HandoffPendingPresentation {
  canReclassify: boolean;
  models: SessionHandoffModelOption[];
}

/**
 * 保留中の引き継ぎ確認を、セッションの状態として外（統括ページ）へ公開する口
 * （Issue #1280）。
 *
 * 実装は`handoffPending.ts`。ここはモーダルとの競争だけを見る。
 */
export interface HandoffPendingPort {
  /** 保留を公開する。提案が差し替わる（再判定）たびに呼び直す。 */
  publish(proposal: HandoffModelChoice, presentation: HandoffPendingPresentation): void;
  /** 外から決定が来るのを待つ。`publish`した提案1つに対する1回分。 */
  external(): Promise<HandoffDecision>;
  /**
   * モーダル側の答えでこの保留を決着させてよいか確かめ、よければ確保する。
   *
   * 外からの決定が先に届いていれば`false`。二重に決着させないためのもの。
   */
  claim(): boolean;
  /** 保留を取り下げる。決着したら必ず呼ぶ。 */
  clear(): void;
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
 *
 * @param preassessed 既に取ってある見立て（Issue #1090の区切り判定で1回起動している）。
 *   渡されたときは分類器を起動し直さない。1回の引き継ぎでCLIを2回起動しないため
 */
export async function proposeHandoffModelSettings(
  current: SessionModelSettings,
  input: HandoffClassifierInput,
  deps: HandoffModelChoiceDeps,
  preassessed?: TaskAssessment,
): Promise<HandoffModelChoice> {
  const settings: SessionModelSettings = { model: current.model, effort: current.effort };
  const reasons: string[] = [];

  if (readAutoHandoffRouterEnabled()) {
    const assessment =
      preassessed ??
      (await classifyHandoff(
        {
          provider: deps.provider,
          executable: deps.executable,
          ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
          ...(deps.logWarn === undefined ? {} : { logWarn: deps.logWarn }),
        },
        input,
      ));
    if (assessment === undefined) {
      reasons.push('作業の分類に失敗したため引き継ぎ元を踏襲');
    } else {
      const resolved = resolveProfile(
        assessment,
        { turnFailed: input.turnFailed },
        deps.models,
        current,
        deps.fallbackEfforts,
        readAutoHandoffCostPreset(deps.provider),
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

/**
 * コスト方針（Issue #1214）を3択で選ばせ、選んだらグローバル設定へ保存する。
 *
 * 入力欄の「…」メニューから呼ぶ。会話単位ではなくグローバルに保存するのは、この設定が
 * 「いま使用量の上限がどれだけ近いか」という会話の外側の事情で決まるため。タブごとに
 * 別々の方針を持たせると、上限が近づいたときに開いている会話の数だけ切り替えることになる。
 *
 * Codex / Claude Codeで使用量の上限が別のため、方針もCLIごとに別々に持つ（Issue #1216）。
 *
 * @returns 選んだ方針。閉じたときは `undefined`（設定は変えない）
 */
export async function pickHandoffCostPreset(
  agent: HandoffCostPresetAgent,
): Promise<CostPreset | undefined> {
  const current = readAutoHandoffCostPreset(agent);
  type PresetItem = vscode.QuickPickItem & { preset: CostPreset };
  const choices: PresetItem[] = [
    {
      label: '低（コスト優先）',
      description: '最上位モデルとxhighを使わない',
      detail: '使用量の上限が近いときに選ぶ。モデルはopus / solまで、effortはhighまで',
      preset: 'low',
    },
    {
      label: '中（常用）',
      description: '最上位モデルは必要最低限',
      detail:
        '最上位モデル（fable / astra）は、広さ・曖昧さ・リスク・自律性がすべて最大のときだけ。effortの制限は無い',
      preset: 'balanced',
    },
    {
      label: '高（最適優先）',
      description: '制限なし',
      detail: '作業の見立てだけでmodel / effortを決める',
      preset: 'full',
    },
  ];
  // いま選ばれているものに印を付ける（QuickPickは初期選択を持たないため、印が無いと
  // 「今どれか」を確かめるためだけに設定を開くことになる）
  const items = choices.map((item) =>
    item.preset === current ? { ...item, label: `$(check) ${item.label}` } : item,
  );

  const agentLabel = agent === 'codex' ? 'Codex' : 'Claude Code';
  const picked = await vscode.window.showQuickPick(items, {
    title: `${agentLabel}の自動引き継ぎのコスト方針`,
    placeHolder: '引き継ぎ先のmodel / effortにどこまでコストを掛けるか',
  });
  if (picked === undefined) {
    return undefined;
  }
  await setAutoHandoffCostPreset(agent, picked.preset);
  return picked.preset;
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

/** 選び直しの候補（Issue #1280）。先頭は引き継ぎ元のまま続けるという選択肢。 */
function modelOptions(
  current: SessionModelSettings,
  deps: HandoffModelChoiceDeps,
): SessionHandoffModelOption[] {
  const options: SessionHandoffModelOption[] = [
    {
      slug: current.model,
      label: `引き継ぎ元のまま（${label(current.model)}）`,
      efforts: allowedEfforts(deps, current.model),
    },
  ];
  for (const model of deps.models) {
    if (model.slug === current.model) {
      continue;
    }
    options.push({
      slug: model.slug,
      label: model.displayName,
      efforts: allowedEfforts(deps, model.slug),
    });
  }
  return options;
}

/** 手で指定したときの理由。モーダルからでも統括ページからでも同じ形にする。 */
function manualReasons(proposal: HandoffModelChoice, where: string): string[] {
  return [
    `${where}で指定（提案は ${label(proposal.settings.model)} / ${label(proposal.settings.effort)}）`,
  ];
}

/** モーダルの答えと、外（統括ページ）からの決定のどちらが先に来たか。 */
type Answered =
  | { source: 'modal'; answer: string | undefined }
  | { source: 'external'; decision: HandoffDecision };

function showConfirmModal(
  proposal: HandoffModelChoice,
  canReclassify: boolean,
): Thenable<string | undefined> {
  const buttons = canReclassify ? [PROCEED, REPICK, RECLASSIFY] : [PROCEED, REPICK];
  // 本文は1行にし、値と理由は `detail` へ。modalの本文に改行を入れるとOSによって潰れる
  return vscode.window.showInformationMessage(
    `この設定で引き継ぎますか？（Model: ${label(proposal.settings.model)} / Effort: ${label(proposal.settings.effort)}）`,
    {
      modal: true,
      detail: [
        `Model: ${label(proposal.settings.model)}`,
        `Effort: ${label(proposal.settings.effort)}`,
        '',
        ...proposal.reasons,
      ].join('\n'),
    },
    ...buttons,
  );
}

/**
 * 候補を人へ見せ、承認・選び直し・再判定・中止のいずれかを受ける。
 *
 * 確認の受け口は2つある（Issue #1280）。このウィンドウのモーダルと、セッション統括ページ
 * （別ウィンドウからも操作できる）に出る保留カードで、先に答えた方が決着させる。
 *
 * **表示済みのモーダルを閉じるAPIはVS Codeに無い**。そのため統括ページ側で決着したときは、
 * 残ったモーダルへの答えを捨てる（`port.claim()`が`false`を返す）。加えて、一度でも外から
 * 決定が来た後はモーダルを出し直さない——出し直すと古い値のダイアログの上に新しい
 * ダイアログが重なるため、以後の確認は統括ページ側だけで行う。
 *
 * @returns 承認された設定。ダイアログを閉じた・統括ページで中止したときは `undefined`
 *   （引き継ぎを中止する）
 * @param preassessed 区切り判定で既に取ってある見立て（Issue #1090）。初回の提案にだけ使い、
 *   「再判定」を押されたときは新たに分類器を起動する
 * @param pending 保留を統括ページへ公開する口（Issue #1280）。省略するとモーダルだけになる
 */
export async function chooseHandoffModelSettings(
  current: SessionModelSettings,
  input: HandoffClassifierInput,
  deps: HandoffModelChoiceDeps,
  preassessed?: TaskAssessment,
  pending?: HandoffPendingPort,
): Promise<HandoffModelChoice | undefined> {
  const canReclassify = readAutoHandoffRouterEnabled();
  const presentation: HandoffPendingPresentation = {
    canReclassify,
    models: modelOptions(current, deps),
  };
  // 統括ページから決定が来た後はモーダルを出さない（上のJSDoc参照）。
  // `pending`が無ければ決定も来ないので、ここが立つことはない
  let modalDisowned = false;

  try {
    // 分類器の起動もこの中に入れる。失敗して抜けたときも保留を取り下げるため
    let proposal = await proposeHandoffModelSettings(current, input, deps, preassessed);
    // 提案が変わったときだけ公開し直す。保留のidは提案ごとに振り直すため、
    // ここで毎回publishすると、取り寄せ済みのidが理由も無く古くなる
    pending?.publish(proposal, presentation);
    for (;;) {
      const answered = await nextAnswer(proposal, canReclassify, modalDisowned, pending);
      if (answered.source === 'external') {
        modalDisowned = true;
        const decision = answered.decision;
        if (decision.kind === 'proceed') {
          return proposal;
        }
        if (decision.kind === 'repick') {
          return {
            settings: decision.settings,
            reasons: manualReasons(proposal, 'セッション統括'),
          };
        }
        if (decision.kind === 'cancel') {
          return undefined;
        }
        proposal = await proposeHandoffModelSettings(current, input, deps);
        pending?.publish(proposal, presentation);
        continue;
      }
      const answer = answered.answer;
      if (answer === REPICK) {
        const picked = await pickManually(current, deps);
        if (picked === undefined) {
          // 一覧を閉じただけなら確認へ戻る。引き継ぎ自体を中止したい意思ではない
          continue;
        }
        if (pending !== undefined && !pending.claim()) {
          // 選んでいる間に統括ページ側で決着していた。次の周回でその決定を拾う
          modalDisowned = true;
          continue;
        }
        return { settings: picked, reasons: manualReasons(proposal, '手動') };
      }
      if (pending !== undefined && !pending.claim()) {
        modalDisowned = true;
        continue;
      }
      if (answer === PROCEED) {
        return proposal;
      }
      if (answer === RECLASSIFY) {
        proposal = await proposeHandoffModelSettings(current, input, deps);
        pending?.publish(proposal, presentation);
        continue;
      }
      return undefined;
    }
  } finally {
    pending?.clear();
  }
}

/** モーダルと統括ページの両方を待ち、先に答えが来た方を返す。 */
async function nextAnswer(
  proposal: HandoffModelChoice,
  canReclassify: boolean,
  modalDisowned: boolean,
  pending: HandoffPendingPort | undefined,
): Promise<Answered> {
  const external =
    pending === undefined
      ? undefined
      : pending.external().then((decision): Answered => ({ source: 'external', decision }));
  if (modalDisowned && external !== undefined) {
    return external;
  }
  const modal = Promise.resolve(showConfirmModal(proposal, canReclassify)).then(
    (answer): Answered => ({ source: 'modal', answer }),
  );
  return external === undefined ? modal : Promise.race([modal, external]);
}

/** 安全な区切りの後段（分類器）の結果（Issue #1090）。 */
export interface SafeBoundaryProbe {
  assessment: TaskAssessment;
  /** いま新しいセッションへ切り替えても失うものが無いか。 */
  switchSafe: boolean;
  /** その根拠を1文で。ポインタファイルとログへ出す。 */
  switchReason: string;
  /**
   * アシスタント自身が引き継ぎを提案したか（Issue #1097。`switchSafe` が真のときだけ
   * 意味を持つ）。
   */
  handoffSuggested: boolean;
  /** `handoffSuggested` の根拠を1文で。提案が無ければ空。 */
  handoffSuggestReason: string;
  /**
   * アシスタントがユーザーへ質問して回答を待っているか（Issue #1191）。
   *
   * 真のときは区切り待ちの契機をすべて止める（`handoffSuggested` が真でも止める）。
   */
  awaitingUserAnswer: boolean;
  /** `awaitingUserAnswer` の根拠を1文で。回答待ちでなければ空。 */
  awaitingUserAnswerReason: string;
  /** 解決したmodel/effortが今の値と実質的に違うか（`switchSafe` が真のときだけ意味を持つ）。 */
  profileChanged: boolean;
  /** 解決したmodel/effort。確認ダイアログへ出す値と同じ。 */
  profile: SessionModelSettings;
}

/**
 * 安全な区切りの後段を実行する（Issue #1090）。前段（`passesSafeBoundaryGate`）を通った
 * ときだけ呼ぶ。
 *
 * ここで起動した分類器の見立ては、そのまま `chooseHandoffModelSettings` の `preassessed`
 * へ渡して使い回す。区切りの判定と引き継ぎ先の決定でCLIを2回起動しないため。
 *
 * 分類器が無効（`agent.autoHandoff.router` がOFF）・起動できない・応答を読めないときは
 * `undefined`。「切り替えてよいか」を確かめられていない以上、区切り待ちの契機は発火させない
 * （残量が尽きたときの `threshold` は分類器に依らず従来どおり発火する）。
 */
export async function probeSafeBoundary(
  current: SessionModelSettings,
  input: HandoffClassifierInput,
  deps: HandoffModelChoiceDeps,
): Promise<SafeBoundaryProbe | undefined> {
  if (!readAutoHandoffRouterEnabled()) {
    return undefined;
  }
  const assessment = await classifyHandoff(
    {
      provider: deps.provider,
      executable: deps.executable,
      ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
      ...(deps.logWarn === undefined ? {} : { logWarn: deps.logWarn }),
    },
    input,
  );
  if (assessment === undefined) {
    return undefined;
  }
  // 明示設定（`agent.autoHandoff.model` / `.effort`）まで含めた最終的な提案と比べる。
  // 解決結果だけで比べると、設定で固定している人のところで毎回「変わった」ことになる
  const proposal = await proposeHandoffModelSettings(current, input, deps, assessment);
  return {
    assessment,
    switchSafe: assessment.switchSafe,
    switchReason: assessment.switchReason,
    // `handoffSuggested` は `switchSafe` と独立に通す（Issue #1097）。提案した側が既に
    // 「いま切り替えてよい」と判断しており、そこへ分類器の `switchSafe` を重ねると
    // 「MRは作成済みだが未マージ」のような状態で宣言を握り潰すことになる
    handoffSuggested: assessment.handoffSuggested,
    handoffSuggestReason: assessment.handoffSuggestReason,
    awaitingUserAnswer: assessment.awaitingUserAnswer,
    awaitingUserAnswerReason: assessment.awaitingUserAnswerReason,
    // `profileChanged` の方は従来どおり `switchSafe` を要求する
    profileChanged: assessment.switchSafe && isProfileChange(current, proposal.settings),
    profile: proposal.settings,
  };
}
