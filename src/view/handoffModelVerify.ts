import type { ChatState, ObservedModel, ObservedModelSource } from '../appserver/chatState';
import { CLAUDE_MODEL_ALIASES } from '../claude/types';
import type { SessionModelSettings } from '../sessionModelSettings';
import type { DestinationResponseOutcome, HandoffTurnWatch } from './handoff';

/**
 * 引き継ぎ先のセッションが、指定したmodel/effortで実際に動いているかを確かめる（Issue #2016）。
 *
 * 判定は消費の少ない順に行う。
 * 1. 起動前: CLIへ渡す値（Claudeのargv、Codexの`turn/start`の設定）
 * 2. CLIの通知: Codexの`thread/start`応答・`model/rerouted`、Claudeの`system/init`・`message_start`
 * 3. 事後: 初回応答の後にCLIの会話ログ（transcript / rollout）。effortはここにしか残らない
 *
 * ズレていたら、旧セッションを止める前に新セッションを作り直す。作り直しは
 * `MAX_HANDOFF_MODEL_REBUILDS`回までで、それでもズレたら通知して止まる。
 */

/** ズレを見つけた段。`launch`は起動前（CLIへ渡す値）。 */
export type ModelMismatchSource = ObservedModelSource | 'launch';

export interface ModelMismatch {
  source: ModelMismatchSource;
  expected: SessionModelSettings;
  observed: { model?: string | undefined; effort?: string | undefined };
  rerouted?: { fromModel: string; reason: string } | undefined;
}

/** 作り直しの上限。サーバ側の振替は作り直しても再び起きることがあり、無限に繰り返さない。 */
export const MAX_HANDOFF_MODEL_REBUILDS = 1;

/**
 * 設定値のmodelと、CLIが使ったmodelが同じかどうか。
 *
 * Claude Codeの別名（`opus`など）は、CLIが完全なID（`claude-opus-5-5`など）へ解決して
 * 返すため、IDの区切りの中に別名があれば同じとみなす。完全なIDどうしは、末尾の日付
 * （`-20261001`など）の有無だけを吸収する。照合できない別名（`default`など）は、
 * 誤った作り直しを避けるため同じとみなす。どちらかが空なら比べない。
 */
export function modelMatches(expected: string, actual: string): boolean {
  const want = normalizeModel(expected);
  const got = normalizeModel(actual);
  if (want === '' || got === '' || want === got) {
    return true;
  }
  if ((CLAUDE_MODEL_ALIASES as readonly string[]).includes(want)) {
    return got.split(/[-_.]/).includes(want);
  }
  if (!/[-\d]/.test(want)) {
    return true;
  }
  return got.startsWith(`${want}-`) && /^\d{8}$/.test(got.slice(want.length + 1));
}

/** effortは値をそのまま比べる。設定側が未指定（CLIの既定に任せる）か、実測が無ければ比べない。 */
export function effortMatches(expected: string, actual: string | undefined): boolean {
  const want = expected.trim().toLowerCase();
  const got = (actual ?? '').trim().toLowerCase();
  return want === '' || got === '' || want === got;
}

/** CLIが通知した・ログに残ったmodel/effortを設定値と比べ、ズレていればその内容を返す。 */
export function findModelMismatch(
  expected: SessionModelSettings,
  observed: ObservedModel | undefined,
): ModelMismatch | undefined {
  if (observed === undefined) {
    return undefined;
  }
  // サーバ側の振替は、振替先が何であれ指定どおりではない
  const isMismatch =
    observed.source === 'rerouted' ||
    !modelMatches(expected.model, observed.model ?? '') ||
    !effortMatches(expected.effort, observed.effort);
  if (!isMismatch) {
    return undefined;
  }
  return {
    source: observed.source,
    expected,
    observed: { model: observed.model, effort: observed.effort },
    rerouted: observed.rerouted,
  };
}

/**
 * 起動前の検証。CLIへ渡す値（`launched`）が設定値と違えば、拡張機能側の取り違えとして返す。
 * どちらも設定値そのものなので、別名の吸収はせずに文字列で比べる。
 */
export function findLaunchMismatch(
  expected: SessionModelSettings,
  launched: { model: string; effort: string } | undefined,
): ModelMismatch | undefined {
  if (launched === undefined) {
    return undefined;
  }
  const modelDiffers = expected.model !== '' && expected.model !== launched.model;
  const effortDiffers = expected.effort !== '' && expected.effort !== launched.effort;
  if (!modelDiffers && !effortDiffers) {
    return undefined;
  }
  return { source: 'launch', expected, observed: { ...launched } };
}

/** 入力欄の下に出す実測値（Issue #2016）。`mismatch`は設定値と違うときに`true`。 */
export interface ObservedModelView {
  model: string | undefined;
  effort: string | undefined;
  mismatch: boolean;
}

/** 画面へ送る実測値。CLIの通知がまだ無ければ`undefined`（設定値だけを出す）。 */
export function observedModelView(
  settings: SessionModelSettings,
  observed: ObservedModel | undefined,
): ObservedModelView | undefined {
  if (observed === undefined) {
    return undefined;
  }
  return {
    model: observed.model,
    effort: observed.effort,
    mismatch: findModelMismatch(settings, observed) !== undefined,
  };
}

/** ログ・通知に出す一文。 */
export function describeModelMismatch(mismatch: ModelMismatch): string {
  const show = (value: string | undefined): string =>
    value === undefined || value === '' ? '未取得' : value;
  const expected = `${show(mismatch.expected.model)} / ${show(mismatch.expected.effort)}`;
  const observed = `${show(mismatch.observed.model)} / ${show(mismatch.observed.effort)}`;
  const rerouted =
    mismatch.rerouted === undefined
      ? ''
      : `（サーバ側の振替: ${mismatch.rerouted.fromModel} → ${show(mismatch.observed.model)}、理由: ${mismatch.rerouted.reason}）`;
  return `設定 ${expected} に対し、実際は ${observed}（${SOURCE_LABELS[mismatch.source]}）${rerouted}`;
}

const SOURCE_LABELS: Record<ModelMismatchSource, string> = {
  launch: '起動時の引数',
  systemInit: 'system/init',
  messageStart: 'message_start',
  threadStart: 'thread/start',
  rerouted: 'model/rerouted',
  transcript: 'transcript',
  rollout: 'rollout',
};

/**
 * 引き継ぎ先の初回ターンを見張り、ズレを見つけたらその内容を、最後までズレが無ければ
 * `undefined`を返す。
 *
 * CLIの通知（`state.observedModel`）は届いた時点で比べる。初回応答が成功したら、
 * `readLogged`で会話ログを読んで最後に比べる。初回応答が失敗したときは比べずに返す
 * （旧セッションを残す判断は呼び出し側の通常の流れに任せる）。
 */
export function watchDestinationModel(
  entry: HandoffTurnWatch,
  expected: SessionModelSettings,
  firstResponse: Promise<DestinationResponseOutcome>,
  readLogged: () => Promise<ObservedModel | undefined>,
): Promise<ModelMismatch | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (mismatch: ModelMismatch | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      const index = entry.stateListeners.indexOf(listener);
      if (index >= 0) {
        entry.stateListeners.splice(index, 1);
      }
      resolve(mismatch);
    };
    const listener = (state: ChatState): void => {
      const mismatch = findModelMismatch(expected, state.observedModel);
      if (mismatch !== undefined) {
        finish(mismatch);
      }
    };
    entry.stateListeners.push(listener);
    // Codexの`thread/start`の応答は、見張りを張る前に状態へ入っている
    listener(entry.session.getState());
    firstResponse
      .then(async (outcome) => {
        if (settled) {
          return;
        }
        if (!outcome.succeeded) {
          finish(undefined);
          return;
        }
        finish(findModelMismatch(expected, await readLogged()));
      })
      .catch(() => finish(undefined));
  });
}

/** 引き継ぎ先として開いて初回プロンプトを送ったセッション。 */
export interface HandoffDestination<E> {
  entry: E;
  firstResponse: Promise<DestinationResponseOutcome>;
  /** 初回応答の監視を打ち切る。捨てるときに呼ぶ。 */
  abandon(): void;
  /** 送信前に見つけたズレ。あれば初回プロンプトは送っていない。 */
  preSendMismatch?: ModelMismatch | undefined;
}

export interface SettleHandoffDestinationDeps<E> {
  expected: SessionModelSettings;
  readLogged(entry: E): Promise<ObservedModel | undefined>;
  /** ズレたセッションを止めて閉じる。捨てたセッションのIDと実測値はここで記録する。 */
  discard(destination: HandoffDestination<E>, mismatch: ModelMismatch): void;
  /**
   * 同じ引き継ぎ内容で開き直して送る。`canRebuildAgain`が`false`なら、送信前にズレを
   * 見つけても送る（もう作り直さないため、送らないと引き継ぎが届かない）。開けなければ
   * `undefined`。
   */
  relaunch(canRebuildAgain: boolean): Promise<HandoffDestination<E> | undefined>;
  /** 上限まで作り直してもズレたときの通知。 */
  giveUp(mismatch: ModelMismatch): void;
}

/**
 * ズレていれば作り直し、旧セッションを止めてよい引き継ぎ先を返す。作り直しで開けなかった
 * ときは`undefined`を返し、呼び出し側は旧セッションを残す。上限まで作り直してもズレた
 * ときは通知し、最後の引き継ぎ先を返す（旧セッションの停止は通常どおり行う）。
 */
export async function settleHandoffDestination<E extends HandoffTurnWatch>(
  first: HandoffDestination<E>,
  deps: SettleHandoffDestinationDeps<E>,
): Promise<HandoffDestination<E> | undefined> {
  let current = first;
  for (let rebuilds = 0; ; rebuilds++) {
    const destination = current;
    const mismatch =
      destination.preSendMismatch ??
      (await watchDestinationModel(
        destination.entry,
        deps.expected,
        destination.firstResponse,
        () => deps.readLogged(destination.entry),
      ));
    if (mismatch === undefined) {
      return destination;
    }
    if (rebuilds >= MAX_HANDOFF_MODEL_REBUILDS) {
      deps.giveUp(mismatch);
      return destination;
    }
    deps.discard(destination, mismatch);
    const next = await deps.relaunch(rebuilds + 1 < MAX_HANDOFF_MODEL_REBUILDS);
    if (next === undefined) {
      return undefined;
    }
    current = next;
  }
}

function normalizeModel(model: string): string {
  // `sonnet[1m]`のようなコンテキスト長の指定は、modelの同一性に関係しない
  return model
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, '');
}
