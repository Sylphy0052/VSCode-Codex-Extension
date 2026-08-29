/**
 * セカンドオピニオン（Issue #894 / #926）の起動導線。
 *
 * 依頼先・追加資料・依頼文を人に選ばせ、起動時点の成果物を固定してから、独立した
 * Codexセッションへ1ターンだけ送り、結果を元の会話へ差し込む。CodexとClaude Codeの
 * どちらの画面から押しても**Codexのセッションを開く**（この機能の値打ちはモデルの
 * 多様性ではなく評価主体の分離にあるため。Issue #894 の決定3）。
 *
 * 画面ごとに違うのは「どの会話へ差し込むか」「直近の応答は何か」だけで、それらは
 * {@link SecondOpinionPanelPort} として呼び出し側（`chatView.ts` / `claudeChatView.ts`）が
 * 渡す。ここは `vscode` のUI（QuickPick / InputBox）と進行の面倒だけを見る。
 */

import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import {
  currentWorkspaceFolder,
  readSecondOpinionConfig,
  type SecondOpinionConfig,
} from '../config';
import { FALLBACK_EFFORTS } from '../codex/modelCatalog';
import type { Logger } from '../log';
import type { TaskSessionHost } from '../orchestrator/taskSession';
import { nodeGitCommandRunner, type GitCommandRunner } from '../orchestrator/worktree';
import type { SecondOpinionCandidate } from '../secondOpinion/candidates';
import {
  ASK_GPT_MAX_ATTEMPTS,
  buildAskGptRequestInstruction,
  buildAskGptRetryInstruction,
  DEFAULT_ASK_GPT_TEMPLATE,
  summarizeInvalidAskGptText,
  validateAskGptRequestText,
  type RequestGenerationResult,
  type SecondOpinionMode,
} from '../secondOpinion/askGpt';
import {
  AdvisorSession,
  AdvisorSessionStore,
  type AdvisorCloseReason,
  type AdvisorMaterialWriter,
} from '../secondOpinion/advisorSession';
import { parseHandoffDraft, type HandoffDraft } from '../secondOpinion/handoff';
import {
  describeRedaction,
  mergeRedactionCounts,
  redactCredentials,
} from '../secondOpinion/redact';
import {
  cancelledAskGptDisplay,
  cancelledPartialAskGptDisplay,
  cancelledFollowUpDisplay,
  cancelledHandoffDisplay,
  cancelledMaterialUpdateDisplay,
  cancelledPartialSecondOpinionDisplay,
  cancelledSecondOpinionDisplay,
  failedAskGptDisplay,
  draftedHandoffDisplay,
  failedFollowUpDisplay,
  failedHandoffDisplay,
  failedMaterialUpdateDisplay,
  failedSecondOpinionDisplay,
  finishedAskGptDisplay,
  finishedFollowUpDisplay,
  finishedMaterialUpdateDisplay,
  finishedSecondOpinionDisplay,
  partialAskGptDisplay,
  partialSecondOpinionDisplay,
  pendingAskGptDisplay,
  pendingFollowUpDisplay,
  pendingHandoffDisplay,
  pendingMaterialUpdateDisplay,
  pendingSecondOpinionDisplay,
  queuedSecondOpinionDisplay,
  type SecondOpinionDisplay,
  type SecondOpinionSummaryStatus,
} from '../secondOpinion/display';
import {
  ARTIFACT_KIND_LABELS,
  buildAdvisorFollowUpPrompt,
  buildHandoffDraftPrompt,
  SECOND_OPINION_ARTIFACT_KINDS,
  type ConversationBackgroundKind,
  type SecondOpinionArtifact,
  type SecondOpinionArtifactKind,
} from '../secondOpinion/prompt';
import {
  runSecondOpinion,
  SecondOpinionRegistry,
  type SecondOpinionResult,
} from '../secondOpinion/run';
import {
  appendReviewBundleRevision,
  createEmptyReviewBundle,
  createReviewBundle,
  defaultReviewBundleRoot,
  type ReviewBundle,
} from '../secondOpinion/reviewBundle';
import { captureWorkspaceSnapshot, type ReviewMaterial } from '../secondOpinion/snapshot';
import { summarizeConversation } from '../secondOpinion/summary';
import type { SummaryRolloutDeps } from '../secondOpinion/summaryRollout';
import { waitForParentIdle, type SecondOpinionParentPort } from '../secondOpinion/wait';

/**
 * 画面1つ分の差し込み口。`ChatPanel` / `ClaudePanel` の違いをここへ閉じ込める。
 *
 * **契約: `note()` / `setRunning()` は例外を投げてはならない。** パネルが破棄済みの場合は
 * no-opで返すこと。選択UI（QuickPick 2回 + InputBox）を人が触っている最中にタブを閉じられる
 * ため、破棄済みpanelへ書き込む経路は現実に踏む。ここで投げられると実行中フラグが
 * `SecondOpinionRegistry` に残り、以後その会話ではセカンドオピニオンを起動できなくなる
 * （Issue #926 B）。呼び出し側でも try/finally で守っているが、二重の保険とする。
 */
export interface SecondOpinionPanelPort extends SecondOpinionParentPort {
  /** 重複起動の判定キー（親セッションのid）。 */
  parentSessionId: string;
  /** 親セッションの作業ディレクトリ。未設定ならワークスペースを使う。 */
  cwd: string | undefined;
  /** 直近のエージェント応答（`lastAssistantResponse` を選んだときだけ使う）。 */
  lastAssistantResponse(): string;
  /**
   * 会話の記録（Issue #903）。要約セッションへの入力になる。
   *
   * 親セッションへ問い合わせるのではなく、画面が持っている `ChatState.items` から
   * 組み立てたものを読むだけ（親のターンを1つも使わない。受入基準3）。
   */
  conversationTranscript(): string;
  /**
   * 要約セッションのrolloutを消すための口（Issue #942）。
   *
   * 要約セッションは親会話の複製をディスクへ残すが、その複製は一時ディレクトリのcwdを
   * 持つため拡張の履歴一覧に出ない。渡されたときだけ後始末する（未設定なら何もしない）。
   */
  summaryRollout?: SummaryRolloutDeps | undefined;
  /** 会話へ1項目として残す/更新する。 */
  note(id: string, display: SecondOpinionDisplay): void;
  /** webviewのボタンの押下可否を切り替える。 */
  setRunning(running: boolean): void;
  /**
   * 親の会話が既に破棄されているか（Issue #929）。
   *
   * 相談を続けるためにAdvisorセッションを保持する経路で要る。実行中にタブを閉じられると、
   * 保持する相手（会話）が無いのにセッションだけが残る。破棄は `note()` / `setRunning()`
   * が no-op になるだけなので、結果からは判別できない。
   *
   * 省略した呼び出し側は「破棄されていない」として扱う（保持しない設定・テスト用）。
   */
  isParentDisposed?(): boolean;
  /**
   * 相談を続けられる状態になったことを画面へ伝える（Issue #929）。
   *
   * 会話のどの項目に「追加で相談」「メインAIへの指示を作る」を出すかを、拡張機能側から
   * webviewへ知らせるための口。`itemId` が `undefined` のときは、どの項目にもボタンを
   * 出さない（相談が終わった・保持しない設定）。
   *
   * `options.canUpdateMaterial` は「材料を最新にする」を出してよいか（Issue #975）。
   * 資料に作業ツリーの変更を選ばなかった相談では更新できないため、押せば断られるだけの
   * ボタンを出さない。
   */
  setAdvisorItem?(itemId: string | undefined, options?: { canUpdateMaterial: boolean }): void;
  /**
   * 下書きが1件できたことを画面へ伝える（Issue #929 Handoff）。
   *
   * ここで渡すのは**承認の対象そのもの**である。承認と送信の経路が、表示に使った文字列では
   * なくこの値を見るようにするために、画面側が保持する。`undefined` は下書きが無い状態
   * （相談へ戻った・送った・閉じた）を表す。
   */
  setHandoffDraft?(draft: HandoffDraft | undefined): void;
  /**
   * 承認された指示を作業中のAIへ送る（Issue #929）。**この機能で唯一の送信経路。**
   *
   * 任意の文字列を送れる汎用の口（`sendToMain(text)` のようなもの）を置かないのは、置いた
   * 時点で「承認を通っていない文を送る」経路がAPIとして生えるためである。ここは
   * `approveSecondOpinionHandoff` からしか呼ばれず、その関数は `markApproved()` が
   * 通ったときにしか呼ばない。
   *
   * 戻り値は送信できたか待機列へ入ったか。親がターン中なら待たせる（既存の指示と同じ扱い）。
   */
  sendApprovedInstruction?(text: string): Promise<'sent' | 'queued'>;
  /**
   * 親の文脈を継いだforkで質問文を生成する（Issue #947）。
   *
   * 実装はCodexが `thread/fork`（`ephemeral: true`）、Claudeが `-r <id> --fork-session`。
   * どちらもタブを開かず、親の本流の会話には何も残さない。
   *
   * `signal` は利用者の停止（Issue #940）。生成は本体と同じだけ待つことがあるため、
   * 待っている間に止められる必要がある。
   */
  generateRequestText(
    instruction: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<RequestGenerationResult>;
}

/**
 * これ未満の長さの会話は、要約せずに記録そのものを背景として渡す（Issue #944）。
 *
 * 要約セッションの目標長（`summary.ts` の `SUMMARY_TARGET_CHARS`、2,000文字）と同じ桁に
 * 置く。これより短い会話を要約しても、縮む量より、本体の前に1往復ぶん待たされる損の方が大きい。
 */
const SUMMARY_SKIP_THRESHOLD_CHARS = 4_000;

const ARTIFACT_KIND_DETAILS: Record<SecondOpinionArtifactKind, string> = {
  workspaceChanges: '押した時点の変更を固定して渡します（実行中の変更は含みません）',
  lastAssistantResponse: 'この会話の直近の応答を渡します（そのAIのフレーミングが混じります）',
  none: '資料は渡しません（設計の相談・方針の判断などに使います）',
};

async function pickCandidate(
  candidates: readonly SecondOpinionCandidate[],
): Promise<SecondOpinionCandidate | undefined> {
  const first = candidates[0];
  if (first !== undefined && candidates.length === 1) {
    // 候補が1件だけなら選ばせない（毎回同じ選択を押させない。受入基準2）
    return first;
  }
  const picked = await vscode.window.showQuickPick(
    candidates.map((candidate) => ({
      label: candidate.name,
      description: `${candidate.model} / ${candidate.effort}`,
      candidate,
    })),
    { title: 'セカンドオピニオンの依頼先', placeHolder: '独立したCodexセッションのモデル' },
  );
  return picked?.candidate;
}

/**
 * 今回だけのeffortを選ばせる（Issue #944）。
 *
 * 候補（設定）が持つeffortが既定で、その場だけ軽い設定へ落とせるようにする。速さと
 * 判断の質はここで直接効くうえ、どちらを取るかは「急いで一言ほしい」「腰を据えて見てほしい」
 * という**その場の事情**で決まるため、設定ではなく実行時に選ばせる。
 *
 * 選択肢はモデルが受け付ける値の一覧（`listEfforts`）から作る。既定値がその一覧に無い場合も
 * 必ず先頭へ出す（設定した値を選べないUIにしない）。
 */
async function pickEffort(
  candidate: SecondOpinionCandidate,
  listEfforts: (model: string) => readonly string[],
): Promise<string | undefined> {
  const available = listEfforts(candidate.model);
  const ordered = [candidate.effort, ...available.filter((e) => e !== candidate.effort)];
  if (ordered.length === 1) {
    // 選べる値が1つしか無い（effortを持たないモデルなど）なら選ばせない。
    // 依頼先が1件のときにQuickPickを出さないのと同じ扱い（受入基準2）
    return candidate.effort;
  }
  const picked = await vscode.window.showQuickPick(
    ordered.map((effort) =>
      effort === candidate.effort
        ? { label: effort, description: '既定（設定の候補が持つ値）', effort }
        : {
            label: effort,
            detail: '軽くするほど速く返るが、指摘の深さは落ちる（重くするほどその逆）',
            effort,
          },
    ),
    {
      title: `セカンドオピニオンの思考の深さ（${candidate.model}）`,
      placeHolder: '今回だけの指定。設定の候補は変わらない',
    },
  );
  return picked?.effort;
}

async function pickArtifactKind(
  summaryEnabled: boolean,
): Promise<SecondOpinionArtifactKind | undefined> {
  const picked = await vscode.window.showQuickPick(
    SECOND_OPINION_ARTIFACT_KINDS.map((kind) => ({
      label: ARTIFACT_KIND_LABELS[kind],
      detail: ARTIFACT_KIND_DETAILS[kind],
      // `kind` は QuickPickItem の予約フィールド（区切り行の指定）なので別名で持つ
      artifactKind: kind,
    })),
    {
      title: '今回とくに見てほしい資料',
      // 何を選んでも会話そのものは渡らない。要約の有無で「背景が届くか」が変わるため書き分ける
      placeHolder: summaryEnabled
        ? 'この会話そのものは、どれを選んでも渡りません（背景は別セッションが作った要約で届きます）'
        : 'この会話の内容は、どれを選んでも渡りません',
    },
  );
  return picked?.artifactKind;
}

/**
 * 追加資料を、押下時の状態で固定する。
 *
 * `read-only` サンドボックスは相手側の書き込みしか止められないため、実行中に親セッションが
 * 作業ツリーを書き換えると、どの時点にも存在しなかった状態を見せることになる。
 * ここで内容を確定させることが受入基準5の実体。
 */
interface CapturedArtifact {
  artifact: SecondOpinionArtifact;
  /**
   * bundleへ書き出す材料（Issue #926 E）。`workspaceChanges` のときだけ入る。
   * それ以外の資料は本文の中で完結しており、作業ディレクトリへ置くものが無い。
   */
  material?: ReviewMaterial | undefined;
}

async function captureArtifact(
  kind: SecondOpinionArtifactKind,
  cwd: string,
  port: SecondOpinionPanelPort,
  git: GitCommandRunner,
): Promise<CapturedArtifact | undefined> {
  if (kind === 'none') {
    return { artifact: { kind: 'none' } };
  }
  if (kind === 'lastAssistantResponse') {
    const response = port.lastAssistantResponse().trim();
    if (response === '') {
      void vscode.window.showErrorMessage(
        'この会話にはまだエージェントの応答がないため、資料として渡せません',
      );
      return undefined;
    }
    return { artifact: { kind: 'lastAssistantResponse', response } };
  }
  const captured = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: '変更のスナップショットを取得しています…' },
    () => captureWorkspaceSnapshot(cwd, git),
  );
  if (!captured.ok) {
    void vscode.window.showErrorMessage(`セカンドオピニオン: ${captured.reason}`);
    return undefined;
  }
  return {
    artifact: { kind: 'workspaceChanges', snapshot: captured.snapshot },
    material: captured.material,
  };
}

/**
 * 会話の要約（Issue #903）を作る。
 *
 * 要約は**別セッション**が作る（作業した本人に要約させると、その解釈が圧縮されて渡り、
 * 独立した意見としての値打ちが落ちるため。`summary.ts` 参照）。設定で切っている場合と、
 * 要約に失敗した場合は本文を返さない。どちらでもセカンドオピニオン本体は続行し、
 * 背景の区画が無いプロンプトで走る。
 *
 * 会話が {@link SUMMARY_SKIP_THRESHOLD_CHARS} 未満なら要約セッションを開かず、記録を
 * そのまま背景として渡す（Issue #944）。要約セッションは本体の**前に直列で**走るため、
 * 圧縮する必要が無い長さの会話にまでその1往復を払うと、待ち時間だけが増える。
 */
async function buildConversationSummary(
  port: SecondOpinionPanelPort,
  host: TaskSessionHost,
  config: SecondOpinionConfig,
  log: Logger,
  signal: AbortSignal,
): Promise<{
  text: string | undefined;
  kind: ConversationBackgroundKind;
  failure: string | undefined;
  /** 利用者が止めた結果か（Issue #940）。真なら呼び出し側は本体を開始しない。 */
  cancelledByUser: boolean;
}> {
  if (!config.summary.enabled) {
    return { text: undefined, kind: 'summary', failure: undefined, cancelledByUser: false };
  }
  const conversation = port.conversationTranscript();
  if (conversation.trim() === '') {
    return { text: undefined, kind: 'summary', failure: undefined, cancelledByUser: false };
  }
  if (conversation.length < SUMMARY_SKIP_THRESHOLD_CHARS) {
    log.info(
      `[secondOpinion] 会話が短いため要約セッションを開きません（${conversation.length}文字）`,
    );
    return { text: conversation, kind: 'transcript', failure: undefined, cancelledByUser: false };
  }
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: '会話の要約を作成しています…' },
    () =>
      summarizeConversation(
        host,
        {
          model: config.summary.model,
          effort: config.summary.effort,
          conversation,
          // 要約中に止められることがある（Issue #940）。本体より前の直列区間なので、
          // 待ち時間としてはここが一番長くなることもある
          signal,
          rollout: port.summaryRollout,
        },
        log,
      ),
  );
  if (result.ok) {
    return { text: result.summary, kind: 'summary', failure: undefined, cancelledByUser: false };
  }
  return {
    text: undefined,
    kind: 'summary',
    failure: result.reason,
    cancelledByUser: result.cancelledByUser === true,
  };
}

/**
 * セカンドオピニオンを起動する。
 *
 * 途中で人が取り消した場合は何も起こさずに戻る（会話にも残さない）。起動した後は、
 * 成功・失敗・打ち切りのいずれでも必ず会話へ1項目を残す（タブを開かない設定でも、
 * 結果がどこにも出ないという状態を作らない。受入基準10）。
 */
export async function startSecondOpinion(
  port: SecondOpinionPanelPort,
  host: TaskSessionHost,
  registry: SecondOpinionRegistry,
  log: Logger,
  git: GitCommandRunner = nodeGitCommandRunner,
  /**
   * モデルが受け付けるeffortの一覧（Issue #944）。既定はカタログを読めないときの
   * フォールバック（`modelCatalog.ts`）。Codexのカタログを持っている呼び出し側
   * （`ChatViewManager`）はそれを渡す。
   */
  listEfforts: (model: string) => readonly string[] = () => FALLBACK_EFFORTS,
  /**
   * 相談を続けるためにAdvisorセッションを保持する置き場（Issue #929）。
   *
   * 渡さない呼び出しは Issue #894 時点の挙動（1ターンで閉じる）になる。
   */
  advisorStore?: AdvisorSessionStore,
  /**
   * 今回だけモードを固定する（Issue #972）。入力欄のモード固定ボタンから渡す。
   *
   * 渡さない呼び出しは設定 `agent.secondOpinion.mode` に従う（既定の入口の挙動）。
   * ここで上書きしても設定値は書き換えない。引数は末尾に足す（途中へ挿すと既存の
   * 位置引数の対応が崩れる）。
   */
  modeOverride?: SecondOpinionMode,
): Promise<void> {
  if (registry.isRunning(port.parentSessionId)) {
    void vscode.window.showInformationMessage(
      'この会話のセカンドオピニオンは既に実行中です（終わるまで待つか、結果の項目を確認してください）',
    );
    return;
  }
  const cwd = port.cwd ?? currentWorkspaceFolder()?.uri.fsPath;
  if (cwd === undefined) {
    void vscode.window.showErrorMessage(
      'セカンドオピニオンを走らせる作業ディレクトリが分かりません（ワークスペースを開いてください）',
    );
    return;
  }

  const config = readSecondOpinionConfig();
  for (const warning of config.candidateWarnings) {
    log.warn(`[secondOpinion] ${warning}`);
  }

  const picked = await pickCandidate(config.candidates);
  if (picked === undefined) {
    return;
  }
  const effort = await pickEffort(picked, listEfforts);
  if (effort === undefined) {
    return;
  }
  // 今回だけの上書き。設定の候補（`candidates.ts`）は変えない（Issue #944）
  const candidate: SecondOpinionCandidate = { ...picked, effort };
  // 押されたボタンでモードを固定できる（Issue #972）。設定はそのまま残す
  const effectiveMode = modeOverride ?? config.mode;
  if (effectiveMode === 'askGpt') {
    // 追加資料の選択は出さない。何を渡すかは親が質問文の中で決める（Issue #947 受入基準1）
    await startAskGptSecondOpinion(port, host, registry, log, config, cwd, candidate);
    return;
  }
  const artifactKind = await pickArtifactKind(config.summary.enabled);
  if (artifactKind === undefined) {
    return;
  }
  const request = await vscode.window.showInputBox({
    title: 'セカンドオピニオンへの依頼',
    // 要約を添える設定では「会話の内容は渡らない」は事実と食い違う。何が渡るかを正しく出す。
    // 用途はレビューに限らないため、聞けることの幅も文面に出す（Issue #926 P0）
    prompt: config.summary.enabled
      ? 'レビュー・設計判断・案の比較・次の一手など、聞きたいことを書いてください（この会話そのものは渡らず、別セッションが作った背景要約だけが渡ります）'
      : 'レビュー・設計判断・案の比較・次の一手など、聞きたいことを書いてください（この会話の内容は渡りません）',
    value: config.template,
  });
  if (request === undefined || request.trim() === '') {
    return;
  }
  const captured = await captureArtifact(artifactKind, cwd, port, git);
  if (captured === undefined) {
    return;
  }
  const artifact = captured.artifact;

  // 会話へ残す項目のidを、この実行の識別子（`runId`）としても使う（Issue #940）。停止操作は
  // 項目から押されるので、押された項目のidがそのまま「どの実行を止めるか」になる
  const id = `secondOpinion:${randomUUID()}`;
  // 止める単位は個々の `TaskSession` ではなく、この実行1回（会話の要約＋本体）である。
  // 要約中はまだ本体のセッションが無いため、セッションを登録する形では止められない
  const controller = new AbortController();
  if (!registry.begin(port.parentSessionId, id, () => controller.abort())) {
    // 選択している間に別経路から起動された場合。二重に走らせない
    void vscode.window.showInformationMessage('この会話のセカンドオピニオンは既に実行中です');
    return;
  }
  // 材料の一時ディレクトリ（Issue #926 E）。相談を続ける場合は `AdvisorSession` へ渡し、
  // 渡せなかった場合はこの関数の `finally` で必ず消す
  let bundle: ReviewBundle | undefined;
  let bundleHandedOver = false;
  // `begin()` の成功直後から `try` を始める。`setRunning()` / `note()` が投げると
  // `finally` へ入らず、`registry` にidが残って以後その会話では二度と起動できなくなる
  // （選択UIを触っている最中にタブを閉じられる経路で実際に踏みうる。Issue #926 B）
  try {
    port.setRunning(true);
    // Advisorの作業ディレクトリを、押下時点の材料だけを置いた一時ディレクトリにする
    // （Issue #926 E）。作れなかったときは実行しない。親セッションの作業ツリーで開く形へ
    // 戻すのは、この変更で無くしたかった状態そのものである
    bundle = await createBundleFor(cwd, git, captured, log);
    if (bundle === undefined) {
      void vscode.window.showErrorMessage(
        'セカンドオピニオン: レビュー材料を書き出せなかったため実行しません',
      );
      // 止めたわけではないので「停止しました」とは出さない。押した人に理由が届く形で残す
      port.note(
        id,
        failedSecondOpinionDisplay(
          candidate,
          artifactKind,
          request,
          'レビュー材料を書き出せませんでした',
        ),
      );
      return;
    }
    // 親のターンが走っている間は、依頼の内容を固めたところで一旦止まる（Issue #949）。
    // ここまでの選択・入力・スナップショットは待たせずに済ませてあり、待たせるのは
    // この後に開く2つのセッション（会話の要約と本体）だけである
    if (!port.isParentIdle()) {
      port.note(id, queuedSecondOpinionDisplay(candidate, artifactKind, request));
      log.info('[secondOpinion] 親セッションのターンが終わるまで待機します');
    }
    const waited = await waitForParentIdle(port, controller.signal);
    if (waited === 'cancelled') {
      // 待機中に止められた場合。セッションは1つも開いていない
      log.info('[secondOpinion] 待機中に利用者の操作で停止しました（セッションは開いていません）');
      port.note(id, cancelledSecondOpinionDisplay(candidate, artifactKind, request));
      return;
    }
    port.note(id, pendingSecondOpinionDisplay(candidate, artifactKind, request));
    // 要約は本体より先に作る（本体のプロンプトへ載せるため）。失敗しても本体は続ける
    const summary = await buildConversationSummary(port, host, config, log, controller.signal);
    if (summary.failure !== undefined) {
      log.warn(`[secondOpinion] 会話の要約を作れませんでした: ${summary.failure}`);
    }
    // 要約中に止められた場合と、要約が終わってから本体を始めるまでの間に止められた場合
    // （Issue #940）。ここで返さないと「止めたのに本体が走り出す」——要約の失敗は本来
    // 本体を続ける理由になるため、利用者停止をその経路へ流してはならない
    if (summary.cancelledByUser || controller.signal.aborted) {
      log.info('[secondOpinion] 利用者の操作で停止しました（本体は開始していません）');
      port.note(id, cancelledSecondOpinionDisplay(candidate, artifactKind, request));
      return;
    }
    // 相談を続ける設定なら、回答の後もセッションを残す（Issue #929）。残ったセッションは
    // この後 `handOverAdvisorSession` が引き取り、引き取れなければそこで閉じる
    const keepSession = config.advisor.enabled && advisorStore !== undefined;
    const result = await runSecondOpinion(
      host,
      {
        // 実workspaceではなく材料だけを置いた一時ディレクトリで開く（Issue #926 E）
        cwd: bundle.dir,
        candidate,
        request,
        artifact,
        headless: config.headless,
        timeoutMs: config.timeoutMs,
        conversationSummary: summary.text,
        conversationBackgroundKind: summary.kind,
        signal: controller.signal,
        keepSession,
      },
      log,
    );
    const summaryStatus: SecondOpinionSummaryStatus =
      summary.text !== undefined
        ? summary.kind === 'transcript'
          ? 'transcript'
          : 'attached'
        : summary.failure === undefined
          ? 'off'
          : 'failed';
    port.note(id, resultDisplay(candidate, artifactKind, request, result, summaryStatus));
    if (!result.ok && result.cancelledByUser !== true) {
      log.warn(`[secondOpinion] 失敗しました: ${result.reason}`);
    }
    bundleHandedOver = handOverAdvisorSession(
      port,
      advisorStore,
      config,
      candidate,
      result,
      id,
      log,
      bundle,
      // 相談の途中で材料を最新へ更新する手段（Issue #975）。作業ツリーの変更を資料に
      // 選んだときだけ渡す（それ以外の資料には、更新すべき材料が無い）
      materialWriterFor(cwd, git, captured, log),
    );
  } finally {
    registry.end(port.parentSessionId, id);
    // 相談が続かないなら材料は用済み。`AdvisorSession` が引き取った場合は、その `close()` が消す
    if (!bundleHandedOver && bundle !== undefined) {
      try {
        await bundle.dispose();
      } catch (e) {
        log.warn(`[secondOpinion] レビュー材料を消せませんでした: ${errorMessage(e)}`);
      }
    }
    // `setRunning()` は契約上no-opのはずだが、投げても `registry.end()` を巻き添えに
    // しない順（end → setRunning）と、個別のtry/catchの両方で守る
    try {
      port.setRunning(false);
    } catch (e) {
      log.warn(
        `[secondOpinion] 実行中表示の解除に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

/**
 * 残ったセッションを `AdvisorSession` へ引き取らせる（Issue #929）。
 *
 * `runSecondOpinion` は `keepSession` を指定したときだけセッションを返し、返した時点で
 * **閉じる責任はこちらへ移る**。引き取れない条件をここで一箇所に集め、そのすべてで
 * `dispose()` する。取りこぼすと、常駐app-server側のスレッドが誰にも閉じられないまま残る。
 *
 * 引き取れないのは次の場合である。
 *
 * - 保持しない設定・置き場を渡していない呼び出し（`runSecondOpinion` が返してくること自体
 *   は無いが、条件を二重に持たない）
 * - 実行中にタブを閉じられた。相談を続ける相手（会話）がもう無い。破棄は `note()` が
 *   no-opになるだけで結果からは判らないため、`isParentDisposed()` で明示的に確かめる
 */
function handOverAdvisorSession(
  port: SecondOpinionPanelPort,
  store: AdvisorSessionStore | undefined,
  config: SecondOpinionConfig,
  candidate: SecondOpinionCandidate,
  result: SecondOpinionResult,
  itemId: string,
  log: Logger,
  bundle: ReviewBundle | undefined,
  writeMaterial: AdvisorMaterialWriter | undefined,
): boolean {
  if (!result.ok || result.session === undefined) {
    return false;
  }
  const session = result.session;
  if (store === undefined || !config.advisor.enabled || port.isParentDisposed?.() === true) {
    log.info('[secondOpinion] 相談を続けないため、Advisorセッションを閉じます');
    try {
      session.dispose();
    } catch (e) {
      log.warn(`[secondOpinion] Advisorセッションを閉じられませんでした: ${errorMessage(e)}`);
    }
    return false;
  }
  const advisor = new AdvisorSession({
    session,
    parentSessionId: port.parentSessionId,
    candidate,
    timeoutMs: config.timeoutMs,
    idleTimeoutMs: config.advisor.idleTimeoutMs,
    // 相談が続く間は材料も残す。追加の質問で `base/` を読み直しうる（Issue #926 E）
    bundle,
    // 相談の途中で材料を最新へ更新する手段（Issue #975）
    writeMaterial,
    log,
    onClosed: (closed) => {
      store.remove(closed);
      // 閉じた相談の項目に「追加で相談」を残さない
      port.setAdvisorItem?.(undefined);
      // 承認の対象も一緒に捨てる。相談相手がいなくなった後の下書きは送れない
      port.setHandoffDraft?.(undefined);
    },
  });
  // 登録してからボタンを出す。逆にすると、押せる見た目なのに置き場に無い区間ができる
  store.set(advisor);
  port.setAdvisorItem?.(itemId, { canUpdateMaterial: advisor.canUpdateMaterial() });
  return true;
}

/**
 * 相談の途中で材料を最新へ更新する手段を作る（Issue #975）。
 *
 * 更新のたびに**現在の作業ツリーからスナップショットを取り直す**。1ターン目と同じ
 * `captureWorkspaceSnapshot` を使うので、`baseCommit` と差分の組み合わせが食い違わない
 * ことも同じ理屈で守られる（Issue #926 A）。
 *
 * 資料が作業ツリーの変更でない相談には `undefined` を返す。渡す材料が本文の中で完結して
 * おり、作業ディレクトリに更新すべきものが無い。
 *
 * 失敗は投げて呼び出し側（`AdvisorSession.updateMaterial`）へ伝える。半端に成功した
 * 世代をAdvisorへ知らせないため、ここで握り潰さない。
 */
function materialWriterFor(
  cwd: string,
  git: GitCommandRunner,
  captured: CapturedArtifact,
  log: Logger,
): AdvisorMaterialWriter | undefined {
  if (captured.artifact.kind !== 'workspaceChanges' || captured.material === undefined) {
    return undefined;
  }
  // 相談を始めた時点のコミットを固定する（Issue #975）。更新のたびにHEADを取り直すと、
  // 利用者が修正をコミットした時点で `git diff <新HEAD>` が空になり、いちばん見てほしい
  // 修正が材料から丸ごと消える
  const baseCommit = captured.artifact.snapshot.baseCommit;
  return async (bundleDir, revision) => {
    const next = await captureWorkspaceSnapshot(cwd, git, { baseCommit });
    if (!next.ok) {
      throw new Error(next.reason);
    }
    if (next.material === undefined) {
      throw new Error('現在の作業ツリーから材料を取得できませんでした');
    }
    return appendReviewBundleRevision(bundleDir, revision, {
      cwd,
      git,
      // 固定したコミットから読む。`base/` の内容は全世代で同じになるが、Advisorが
      // その世代のディレクトリだけで完結して読めることを優先する
      baseCommit: next.snapshot.baseCommit,
      fullDiff: next.material.fullDiff,
      changedPaths: next.material.changedPaths,
      log,
    });
  };
}

/**
 * Advisorのセッションを開く作業ディレクトリを用意する（Issue #926 E）。
 *
 * 追加資料が作業ツリーの変更なら材料を書き出し、それ以外なら空のディレクトリを作る。
 * 空でも意味がある——親セッションの作業ツリーを `cwd` にしないための場所である。
 *
 * 失敗したら `undefined` を返す。呼び出し側は実行を取りやめる。
 */
async function createBundleFor(
  cwd: string,
  git: GitCommandRunner,
  captured: CapturedArtifact,
  log: Logger,
): Promise<ReviewBundle | undefined> {
  const root = defaultReviewBundleRoot();
  try {
    if (captured.artifact.kind !== 'workspaceChanges' || captured.material === undefined) {
      return await createEmptyReviewBundle(root);
    }
    return await createReviewBundle({
      root,
      cwd,
      git,
      baseCommit: captured.artifact.snapshot.baseCommit,
      fullDiff: captured.material.fullDiff,
      changedPaths: captured.material.changedPaths,
      log,
    });
  } catch (e) {
    log.warn(`[secondOpinion] レビュー材料を書き出せませんでした: ${errorMessage(e)}`);
    return undefined;
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 生成が成立しなかった理由の、人向けの主語。詳細はこの後ろへ繋げる。 */
const GENERATION_FAILURE_LABELS: Record<RequestGenerationResultKind, string> = {
  busy: '作業中のAIが応答中のため、質問文を組み立てられませんでした',
  // 停止は失敗として表示しない（呼び出し側が先に `cancelled` へ分岐する）。到達しないが、
  // 種別の網羅性を型で保つために置く
  cancelled: '質問文の組み立てを停止しました',
  unsupported: 'この会話では質問文を組み立てられませんでした',
  timeout: '質問文の組み立てが時間内に終わりませんでした',
  'provider-error': '質問文の組み立てに失敗しました',
  'invalid-output': '組み立てられた質問文が指定の形式ではありませんでした',
};

type RequestGenerationResultKind = Exclude<RequestGenerationResult, { ok: true }>['kind'];

/**
 * 生成された質問文を人へ見せ、送ってよいかを確かめる（Issue #947 受入基準9）。
 *
 * untitledのMarkdownとして開き、編集できる状態のまま確認ボタンを出す。ボタンをmodalに
 * しないのは、modalダイアログが出ている間はエディタを触れず、「編集してから送る」が
 * できなくなるため。エディタを開いただけ・閉じただけを合図にもしない——開いた直後に読むと
 * 人が編集する前に送ってしまい、閉じるのを待つと「送るつもり」「やめるつもり」「誤って
 * 閉じた」を区別できない。明示的な押下だけを送信の合図とする。
 *
 * 送るのは押下時点のドキュメント本文であり、開いた時点の文字列ではない（編集結果が送信文に
 * なることの実体）。
 */
async function confirmAskGptRequestText(text: string): Promise<string | undefined> {
  const doc = await vscode.workspace.openTextDocument({ content: text, language: 'markdown' });
  await vscode.window.showTextDocument(doc, { preview: false });
  const picked = await vscode.window.showInformationMessage(
    'この質問文でセカンドオピニオンへ送りますか？（開いたタブで編集できます。保存は不要です）',
    '送信',
    'やめる',
  );
  return picked === '送信' ? doc.getText() : undefined;
}

/**
 * askGptモード（Issue #947）を走らせる。
 *
 * 既定モード（`startSecondOpinion` の後半）との違いは材料の作り方だけで、Advisorの権限も
 * 結果の差し込み先も同じ。ここが持つのは「親に質問文を作らせ、検証し、確認を取り、伏せてから
 * 渡す」までの手順である。
 *
 * `registry.begin()` を親の生成より前に取るのが要点。あとから取ると、生成を待っている間に
 * もう一度ボタンを押せてしまい、同じ会話から2本の生成ターンが走る（受入基準11）。
 */
async function startAskGptSecondOpinion(
  port: SecondOpinionPanelPort,
  host: TaskSessionHost,
  registry: SecondOpinionRegistry,
  log: Logger,
  config: SecondOpinionConfig,
  cwd: string,
  candidate: SecondOpinionCandidate,
): Promise<void> {
  const request = await vscode.window.showInputBox({
    title: 'セカンドオピニオンへの依頼',
    prompt:
      '聞きたいことを書いてください。関連コード・環境・経緯は、いま作業しているAIが会話とリポジトリから集めて質問文にまとめます',
    // 既定モードの `agent.secondOpinion.template`（「この変更をレビューしてください」）は
    // 差分を渡す前提の文言で、askGptには合わない。ここは専用の既定文を使う
    value: DEFAULT_ASK_GPT_TEMPLATE,
  });
  if (request === undefined || request.trim() === '') {
    return;
  }

  // 会話へ残す項目のidを、この実行の識別子としても使う（Issue #940。既定モードと同じ）
  const id = `secondOpinion:${randomUUID()}`;
  const controller = new AbortController();
  if (!registry.begin(port.parentSessionId, id, () => controller.abort())) {
    void vscode.window.showInformationMessage('この会話のセカンドオピニオンは既に実行中です');
    return;
  }
  // askGptでも親セッションの作業ツリーでAdvisorを開かない（Issue #926 E）。材料は質問文の
  // 中にあるため中身は空だが、`cwd` を実workspaceにしない意味は既定モードと同じ
  let bundle: ReviewBundle | undefined;
  try {
    port.setRunning(true);
    try {
      bundle = await createEmptyReviewBundle(defaultReviewBundleRoot());
    } catch (e) {
      log.warn(
        `[secondOpinion] レビュー用の作業ディレクトリを作れませんでした: ${errorMessage(e)}`,
      );
      port.note(id, failedAskGptDisplay(candidate, request, '作業ディレクトリを作れませんでした'));
      return;
    }
    // 親のターンが走っている間は、質問文の組み立てを始めずに待つ（Issue #949）。既定モードは
    // 押下時点の差分を固定してから待つが、askGptは親が何を読むかを事前に決められないため、
    // 待つ意味がより強い。走っている最中に読むと、会話は変更前・あるファイルは変更後という、
    // どの時点にも存在しなかった状態を質問文へ書き込みうる
    if (!port.isParentIdle()) {
      port.note(
        id,
        pendingAskGptDisplay(
          candidate,
          request,
          '順番待ち（この会話の応答が終わってから始めます）…',
        ),
      );
      log.info('[secondOpinion] 親セッションのターンが終わるまで待機します');
    }
    if ((await waitForParentIdle(port, controller.signal)) === 'cancelled') {
      log.info('[secondOpinion] 待機中に利用者の操作で停止しました（セッションは開いていません）');
      port.note(id, cancelledAskGptDisplay(candidate, request, '待機中に停止しました'));
      return;
    }

    // 形式検証に落ちたときだけ、失敗理由を添えて1回だけ組み立て直す（Issue #997）。生成そのものの
    // 失敗（timeout・provider-error など）は回し直さない。同じ条件で同じ失敗を繰り返すだけで、
    // 待ち時間が倍になる
    let validatedText: string | undefined;
    let lastInvalidReason: string | undefined;
    for (let attempt = 1; attempt <= ASK_GPT_MAX_ATTEMPTS; attempt += 1) {
      const retrying = lastInvalidReason !== undefined;
      const progressTitle = retrying
        ? 'セカンドオピニオンへ送る質問文を組み立て直しています…'
        : 'セカンドオピニオンへ送る質問文を組み立てています…';
      port.note(
        id,
        pendingAskGptDisplay(
          candidate,
          request,
          retrying
            ? '質問文が形式を満たさなかったため組み立て直しています…'
            : '質問文を組み立てています…',
        ),
      );
      const instruction =
        lastInvalidReason === undefined
          ? buildAskGptRequestInstruction(request)
          : buildAskGptRetryInstruction(request, lastInvalidReason);
      const generated = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: progressTitle },
        () => port.generateRequestText(instruction, config.timeoutMs, controller.signal),
      );
      if (!generated.ok) {
        if (generated.kind === 'cancelled') {
          log.info('[secondOpinion] 質問文の組み立て中に利用者の操作で停止しました');
          port.note(
            id,
            cancelledAskGptDisplay(candidate, request, '質問文の組み立て中に停止しました'),
          );
          return;
        }
        const reason = `${GENERATION_FAILURE_LABELS[generated.kind]}: ${generated.reason}`;
        log.warn(`[secondOpinion] askGptの質問文を組み立てられませんでした: ${generated.kind}`);
        port.note(id, failedAskGptDisplay(candidate, request, reason));
        return;
      }

      const result = validateAskGptRequestText(generated.text);
      if (result.ok) {
        validatedText = result.text;
        break;
      }
      lastInvalidReason = result.reason;
      // 落ちた本文の冒頭を残す。理由だけでは、見出しをどう書いて落ちたのかが後から判らない
      log.warn(
        `[secondOpinion] askGptの質問文が形式を満たしませんでした（${attempt}/${ASK_GPT_MAX_ATTEMPTS}回目）: ` +
          `${result.reason} / 冒頭: ${summarizeInvalidAskGptText(generated.text)}`,
      );
      // 組み立て直しの前に停止されていたら、そこで終える（Issue #940と同じ隙間を作らない）
      if (controller.signal.aborted) {
        log.info('[secondOpinion] 利用者の操作で停止しました（組み立て直しは行いません）');
        port.note(
          id,
          cancelledAskGptDisplay(candidate, request, '質問文の組み立て中に停止しました'),
        );
        return;
      }
    }
    if (validatedText === undefined) {
      const reason =
        `${GENERATION_FAILURE_LABELS['invalid-output']}: ${lastInvalidReason ?? '理由不明'}` +
        `（${ASK_GPT_MAX_ATTEMPTS}回試しました）`;
      port.note(id, failedAskGptDisplay(candidate, request, reason));
      return;
    }

    const confirmed = config.askGpt.confirm
      ? await confirmAskGptRequestText(validatedText)
      : validatedText;
    if (confirmed === undefined || confirmed.trim() === '') {
      // 人がやめた場合。何を止めたのかが会話に残らないと、押した記録だけが宙に浮く
      port.note(id, cancelledAskGptDisplay(candidate, request, '送信を取りやめました'));
      return;
    }
    // 確認を読んでいる間に停止ボタンを押された場合。ここで返さないと「止めたのにAdvisorが
    // 走り出す」（Issue #940で既定モードが塞いだのと同じ隙間）
    if (controller.signal.aborted) {
      log.info('[secondOpinion] 利用者の操作で停止しました（Advisorは開始していません）');
      port.note(id, cancelledAskGptDisplay(candidate, request, '送信前に停止しました'));
      return;
    }

    // 送信経路の最後で伏せる（受入基準12）。Advisorのセッションはローカルプロセスだが、
    // モデルサービスへ送信するクライアントである。
    //
    // 依頼文もAdvisorへ渡る（Issue #954）ので同じ扱いにする。会話へ残す件数は合算する
    // （送ったのは1本のテキストなので、読む側が2つの数を足す形にはしない）
    const redaction = redactCredentials(confirmed);
    const requestRedaction = redactCredentials(request);
    const redactionNote = describeRedaction(mergeRedactionCounts(redaction, requestRedaction));
    if (redactionNote !== undefined) {
      log.info(`[secondOpinion] askGpt ${redactionNote}`);
    }

    port.note(id, pendingAskGptDisplay(candidate, request, '意見を待っています…'));
    const result = await runSecondOpinion(
      host,
      {
        cwd: bundle.dir,
        candidate,
        // 伏せた側を送る。会話へ残す `request` は原文のままで、利用者が自分の書いた文を
        // 読み返せなくなる理由が無い（伏せるのは送信経路だけ）
        request: requestRedaction.text,
        // askGptでは追加資料も背景要約も渡さない。材料は質問文の中にある（受入基準3）
        artifact: { kind: 'none' },
        headless: config.headless,
        timeoutMs: config.timeoutMs,
        askGptRequestText: redaction.text,
        signal: controller.signal,
      },
      log,
    );
    const chars = redaction.text.length;
    if (!result.ok) {
      if (result.cancelledByUser === true) {
        port.note(id, cancelledAskGptDisplay(candidate, request, result.reason));
        return;
      }
      log.warn(`[secondOpinion] 失敗しました: ${result.reason}`);
      port.note(id, failedAskGptDisplay(candidate, request, result.reason));
      return;
    }
    port.note(id, askGptResultDisplay(candidate, request, result, chars, redactionNote));
  } finally {
    registry.end(port.parentSessionId, id);
    // askGptでは相談を続けない（セッションを保持しない）ので、必ずここで消す
    if (bundle !== undefined) {
      try {
        await bundle.dispose();
      } catch (e) {
        log.warn(
          `[secondOpinion] レビュー用の作業ディレクトリを消せませんでした: ${errorMessage(e)}`,
        );
      }
    }
    try {
      port.setRunning(false);
    } catch (e) {
      log.warn(
        `[secondOpinion] 実行中表示の解除に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

/**
 * 実行中のセカンドオピニオンを止める（Issue #940）。
 *
 * 会話に出ている実行中の項目から押される。`headless` の値に関わらずこの経路で止まる
 * （既定ではタブが開かないため、タブ側の操作だけでは足りない）。
 *
 * 止めるのは、押された項目に対応する実行だけ。`runId`（＝項目のid）が今走っている実行と
 * 一致しなければ何もしない。会話には終わった実行の項目も残るため、古い項目から遅れて
 * 届いた停止操作が、後から始めた別の実行を止めてはならない。
 *
 * ここでは会話の項目を更新しない。停止後の表示は、実行側（`startSecondOpinion`）が
 * キャンセルとして決着したときに1回だけ書く。両方が書くと、どちらが最後に走るかで
 * 表示が変わる。
 */
export function stopSecondOpinion(
  parentSessionId: string,
  registry: SecondOpinionRegistry,
  runId: string,
  log: Logger,
): void {
  if (!registry.cancel(parentSessionId, runId)) {
    // 既に終わっている・別の実行が走っている場合。押した側には何も起きない
    log.info(`[secondOpinion] 停止の対象が見つかりませんでした（runId=${runId}）`);
    return;
  }
  log.info(`[secondOpinion] 停止を要求しました（runId=${runId}）`);
}

/**
 * 保持しているAdvisorへ追加の質問を送る（Issue #929 Consult）。
 *
 * **メインセッションへは何も送らない。** 送るのはこの相談相手のセッションだけで、結果は
 * 会話へ新しい項目として残す（何を相談したのかを後から追えるようにする。受入基準3）。
 *
 * 実行中の管理は1ターン目と同じ `SecondOpinionRegistry` を通す。同じ会話から2本の
 * 問い合わせが走らないことと、会話の項目から停止できることを、既存の仕組みのまま効かせる。
 */
export async function continueSecondOpinion(
  port: SecondOpinionPanelPort,
  registry: SecondOpinionRegistry,
  store: AdvisorSessionStore,
  log: Logger,
): Promise<void> {
  const advisor = store.get(port.parentSessionId);
  if (advisor === undefined) {
    void vscode.window.showInformationMessage(
      'この会話で続けられる相談はありません（もう一度セカンドオピニオンを実行してください）',
    );
    port.setAdvisorItem?.(undefined);
    return;
  }
  if (registry.isRunning(port.parentSessionId)) {
    void vscode.window.showInformationMessage('この会話のセカンドオピニオンは既に実行中です');
    return;
  }
  const question = await vscode.window.showInputBox({
    title: 'セカンドオピニオンへの追加の相談',
    prompt:
      '前回までのやり取りを踏まえて聞き直せます（作業中のAIには送りません。回答も自動では反映されません）',
  });
  if (question === undefined || question.trim() === '') {
    return;
  }
  const id = `secondOpinion:${randomUUID()}`;
  const controller = new AbortController();
  if (!registry.begin(port.parentSessionId, id, () => controller.abort())) {
    void vscode.window.showInformationMessage('この会話のセカンドオピニオンは既に実行中です');
    return;
  }
  try {
    port.setRunning(true);
    // 追加の相談は下書きを無効にする（`AdvisorSession.ask` が `consulting` へ戻すのと対）。
    // 古い下書きを承認できる状態のまま残すと、相談の結論と送る文がずれる
    port.setHandoffDraft?.(undefined);
    port.note(id, pendingFollowUpDisplay(advisor.candidate, question));
    const result = await advisor.ask(buildAdvisorFollowUpPrompt(question), controller.signal);
    if (result.ok) {
      port.note(
        id,
        finishedFollowUpDisplay(advisor.candidate, question, result.response, result.partialReason),
      );
      return;
    }
    if (result.kind === 'cancelled') {
      port.note(id, cancelledFollowUpDisplay(advisor.candidate, question));
      return;
    }
    log.warn(`[secondOpinion] 追加の相談に失敗しました: ${result.reason}`);
    port.note(id, failedFollowUpDisplay(advisor.candidate, question, result.reason));
  } finally {
    registry.end(port.parentSessionId, id);
    try {
      port.setRunning(false);
    } catch (e) {
      log.warn(`[secondOpinion] 実行中表示の解除に失敗しました: ${errorMessage(e)}`);
    }
  }
}

/**
 * 相談の途中で、Advisorの見る材料を最新へ更新する（Issue #975）。
 *
 * **利用者が押したときにだけ動く。** 自動更新にしないのは、押していないのにAdvisorの前提が
 * 入れ替わると、同じ問いに同じ答えが返らなくなるためである。何を根拠に答えたのかを利用者が
 * 辿れる状態を保つ。
 *
 * 更新は1ターン使う。書き出した材料の場所をAdvisorへ伝え、そこを正本として扱わせるまでが
 * この操作であり、伝わっていない材料を置いただけでは「更新した」とは言えない。
 *
 * 失敗しても相談は続く。前の世代の材料はそのまま残っており、次の質問はそれを根拠に答えられる。
 */
export async function updateSecondOpinionMaterial(
  port: SecondOpinionPanelPort,
  registry: SecondOpinionRegistry,
  store: AdvisorSessionStore,
  log: Logger,
): Promise<void> {
  const advisor = store.get(port.parentSessionId);
  if (advisor === undefined) {
    void vscode.window.showInformationMessage(
      'この会話で続けられる相談はありません（もう一度セカンドオピニオンを実行してください）',
    );
    port.setAdvisorItem?.(undefined);
    return;
  }
  if (!advisor.canUpdateMaterial()) {
    void vscode.window.showInformationMessage(
      'この相談では材料を更新できません（「作業ツリーの変更」を資料に選んだ相談でのみ使えます）',
    );
    return;
  }
  const id = `secondOpinion:${randomUUID()}`;
  const controller = new AbortController();
  if (!registry.begin(port.parentSessionId, id, () => controller.abort())) {
    void vscode.window.showInformationMessage('この会話のセカンドオピニオンは既に実行中です');
    return;
  }
  try {
    port.setRunning(true);
    // 材料が変われば、それ以前の相談から作った下書きは前提が違う。追加の相談と同じく、
    // 承認できる状態のまま残さない
    port.setHandoffDraft?.(undefined);
    port.note(id, pendingMaterialUpdateDisplay(advisor.candidate));
    const result = await advisor.updateMaterial(controller.signal);
    if (result.ok) {
      port.note(
        id,
        finishedMaterialUpdateDisplay(
          advisor.candidate,
          result.revision,
          result.response,
          result.partialReason,
        ),
      );
      return;
    }
    if (result.kind === 'cancelled') {
      port.note(id, cancelledMaterialUpdateDisplay(advisor.candidate));
      return;
    }
    log.warn(`[secondOpinion] レビュー材料を更新できませんでした: ${result.reason}`);
    port.note(id, failedMaterialUpdateDisplay(advisor.candidate, result.reason));
  } finally {
    registry.end(port.parentSessionId, id);
    try {
      port.setRunning(false);
    } catch (e) {
      log.warn(`[secondOpinion] 実行中表示の解除に失敗しました: ${errorMessage(e)}`);
    }
  }
}

/**
 * メインAIへの指示の下書きを作らせる（Issue #929 Handoff）。
 *
 * **ここでは何も送らない。** 作るのは下書きだけで、作業中のAIへ渡るのは利用者が読み、直し、
 * 承認したときに限る（Human Gate）。押し直せば作り直せる——`draftHandoff` は毎回同じ相談の
 * 続きとして走るので、直前の下書きは新しいもので置き換わる。
 *
 * 形式どおりに読めなかった応答は下書きとして扱わず、失敗として理由を出す（`parseHandoffDraft`）。
 * 読めた場合にだけ `markHandoffDrafted()` で状態を進める。承認できるのは読めた下書きだけ、
 * という不変条件をここで守る。
 */
export async function draftSecondOpinionHandoff(
  port: SecondOpinionPanelPort,
  registry: SecondOpinionRegistry,
  store: AdvisorSessionStore,
  log: Logger,
): Promise<void> {
  const advisor = store.get(port.parentSessionId);
  if (advisor === undefined) {
    void vscode.window.showInformationMessage(
      'この会話で続けられる相談はありません（もう一度セカンドオピニオンを実行してください）',
    );
    port.setAdvisorItem?.(undefined);
    return;
  }
  const id = `secondOpinion:${randomUUID()}`;
  const controller = new AbortController();
  if (!registry.begin(port.parentSessionId, id, () => controller.abort())) {
    void vscode.window.showInformationMessage('この会話のセカンドオピニオンは既に実行中です');
    return;
  }
  try {
    port.setRunning(true);
    port.note(id, pendingHandoffDisplay(advisor.candidate));
    const result = await advisor.draftHandoff(buildHandoffDraftPrompt(), controller.signal);
    if (!result.ok) {
      if (result.kind === 'cancelled') {
        port.note(id, cancelledHandoffDisplay(advisor.candidate));
        return;
      }
      log.warn(`[secondOpinion] 指示の下書きに失敗しました: ${result.reason}`);
      port.note(id, failedHandoffDisplay(advisor.candidate, result.reason));
      return;
    }
    const parsed = parseHandoffDraft(result.response);
    if (!parsed.ok) {
      // 読めない応答は下書きにしない。作り直せるよう、何が読めなかったのかを出す
      log.warn(`[secondOpinion] 指示の下書きを解釈できませんでした: ${parsed.reason}`);
      port.note(
        id,
        failedHandoffDisplay(
          advisor.candidate,
          `下書きの形式を読み取れませんでした（${parsed.reason}）。もう一度お試しください`,
        ),
      );
      return;
    }
    const revision = advisor.markHandoffDrafted();
    if (revision === undefined) {
      // 待っている間に閉じられた。承認できない下書きを出さない
      port.note(id, failedHandoffDisplay(advisor.candidate, 'この相談は既に終了しています'));
      return;
    }
    // 下書きの根拠になった材料の世代を持ち回る（Issue #975）。承認のときに、その後
    // 材料が更新されていないかを見る
    const draft: HandoffDraft = {
      ...parsed.draft,
      revision,
      materialRevision: advisor.currentMaterialRevision(),
    };
    port.setHandoffDraft?.(draft);
    port.note(id, draftedHandoffDisplay(advisor.candidate, draft));
  } finally {
    registry.end(port.parentSessionId, id);
    try {
      port.setRunning(false);
    } catch (e) {
      log.warn(`[secondOpinion] 実行中表示の解除に失敗しました: ${errorMessage(e)}`);
    }
  }
}

/**
 * 承認された指示の頭に必ず付ける断り書き（Issue #929）。
 *
 * 受け取る側（作業中のAI）にとって、この文は**外部の相談相手が書き、利用者が承認したもの**
 * である。それを伏せて渡すと、AIは利用者本人が考えた指示として扱う。出所が判れば、指示の
 * 前提が自分の把握している状況と食い違うときに、そのまま従わず確かめる余地が残る。
 *
 * 編集できる下書き（`mainInstruction`）とは別に、送信時にここで足す。下書きへ埋め込むと、
 * 利用者が消せてしまい「出所を伏せた指示」を作れてしまう。
 */
function provenancePrefix(candidate: SecondOpinionCandidate): string {
  return [
    `以下は、この会話とは独立したセカンドオピニオン（${candidate.model} / ${candidate.effort}）へ相談した結果を、利用者が確認・編集して承認した指示です。`,
    'あなた自身が把握している状況と食い違う前提があれば、そのまま従わずに指摘してください。',
    '',
    '---',
    '',
  ].join('\n');
}

/**
 * 下書きを人が読み、直し、承認して送る（Issue #929 Human Gate）。
 *
 * **この機能で、作業中のAIへ何かが渡る唯一の経路。** 手順は必ず「開く → 人が読む →
 * 明示的に押す → 送る」の順で、途中を飛ばせないようにしてある。
 *
 * 編集を無題のMarkdownドキュメントで行わせるのは、承認の前に**全文を、送られる形のまま**
 * 見せるためである。入力欄（InputBox）は1行しか見えず、長い指示文は読まれないまま承認される。
 * 開くのは指示文だけで、要約は含めない（要約は利用者向けの文であり、送る対象ではない）。
 *
 * 確認の通知を非モーダルにするのは、押す前に本文を直せるようにするため。モーダルにすると
 * 編集がブロックされ、「読んで直してから承認する」ができなくなる。
 *
 * 送った後は相談を閉じる。指示を渡した時点でこの相談は役目を終えており、開いたままにすると
 * 「送った後に続けた相談」が、送った指示とずれたまま次の承認の材料になる。
 */
export async function approveSecondOpinionHandoff(
  port: SecondOpinionPanelPort,
  store: AdvisorSessionStore,
  draft: HandoffDraft | undefined,
  log: Logger,
): Promise<void> {
  const advisor = store.get(port.parentSessionId);
  if (draft === undefined || advisor === undefined) {
    void vscode.window.showInformationMessage(
      '送れる指示の下書きがありません（「メインAIへの指示を作る」から作成してください）',
    );
    return;
  }
  if (port.sendApprovedInstruction === undefined) {
    void vscode.window.showErrorMessage('この画面からは指示を送れません');
    return;
  }
  // 読んでいる間に無操作で閉じられないようにする。長い指示文ほど読む時間は延びる
  advisor.keepAlive();
  // 送られる形のまま全文を見せ、その場で直せるようにする
  const document = await vscode.workspace.openTextDocument({
    content: draft.mainInstruction,
    language: 'markdown',
  });
  await vscode.window.showTextDocument(document, { preview: false });
  // 下書きを作った後に材料が更新されていれば、この指示は更新前の前提に立っている
  // （Issue #975）。送るのは止めない——古いと分かったうえで送りたい場合があり、そこを
  // 塞ぐと下書きを作り直すためだけに1ターン使わせることになる。ただし黙って送らせない
  const staleMaterial = draft.materialRevision < advisor.currentMaterialRevision();
  const choice = await vscode.window.showInformationMessage(
    staleMaterial
      ? `この下書きは、更新前の材料（第${draft.materialRevision}世代）に基づいています。その後レビュー材料を第${advisor.currentMaterialRevision()}世代へ更新しました。内容を確認・編集してから送信してください`
      : '内容を確認・編集してから送信してください。送信するまで作業中のAIには何も渡りません',
    '送る',
    'やめる',
  );
  if (choice !== '送る') {
    return;
  }
  const edited = document.getText().trim();
  if (edited === '') {
    void vscode.window.showWarningMessage('指示が空です。送信しませんでした');
    return;
  }
  // 承認できるのは「下書きができている状態」かつ「いま開いているのが最新の下書き」のとき
  // だけである。世代まで見るのは、承認の画面を開いたまま新しい下書きを作ると、状態は
  // `handoffDrafted` に戻っているので状態だけの判定では通ってしまい、**画面に出ている古い方**
  // が送られるため（Issue #929 の自己レビュー）
  if (!advisor.markApproved(draft.revision)) {
    void vscode.window.showWarningMessage(
      advisor.closedReason() === undefined
        ? '下書きが最新ではありません。もう一度「メインAIへの指示を作る」から作成してください'
        : 'この相談は既に終了しています。もう一度セカンドオピニオンを実行してください',
    );
    return;
  }
  const text = `${provenancePrefix(advisor.candidate)}${edited}`;
  try {
    const outcome = await port.sendApprovedInstruction(text);
    log.info(`[secondOpinion] 承認された指示を送りました（${outcome}）`);
    void vscode.window.showInformationMessage(
      outcome === 'sent'
        ? 'セカンドオピニオンの指示を作業中のAIへ送りました'
        : 'セカンドオピニオンの指示を待機列へ入れました（現在のターンの後に送られます）',
    );
  } catch (e) {
    // 送れなかったときは相談を閉じない。承認も取り消して、同じ下書きをもう一度
    // 承認できる状態へ戻す（送れなかっただけで下書きは古くなっていない）
    advisor.revertApproval();
    log.warn(`[secondOpinion] 承認された指示を送れませんでした: ${errorMessage(e)}`);
    void vscode.window.showErrorMessage(`指示を送れませんでした: ${errorMessage(e)}`);
    return;
  }
  store.closeFor(port.parentSessionId, 'instructionSent');
}

/**
 * 保持しているAdvisorセッションを閉じる（Issue #929）。
 *
 * 会話の「相談を終了」から押される経路と、親の会話が破棄された・拡張機能が終了する経路の
 * 両方から使う。存在しない場合は何もしない（押し直し・二重の後始末で例外にしない）。
 */
export function endSecondOpinionConsult(
  parentSessionId: string,
  store: AdvisorSessionStore,
  reason: AdvisorCloseReason,
): void {
  store.closeFor(parentSessionId, reason);
}

/**
 * askGptモードの、回答が返ったときの表示を3通りへ振り分ける。
 *
 * 最後まで返った／打ち切られた／利用者が止めた、で見せ方が変わる。止めた本人に
 * 「時間切れ」と読ませない（Issue #940の既定モードと同じ扱い）。
 */
function askGptResultDisplay(
  candidate: SecondOpinionCandidate,
  request: string,
  result: SecondOpinionResult & { ok: true },
  requestTextChars: number,
  redactionNote: string | undefined,
): SecondOpinionDisplay {
  if (result.partialReason === undefined) {
    return finishedAskGptDisplay(
      candidate,
      request,
      result.response,
      requestTextChars,
      redactionNote,
    );
  }
  return result.cancelledByUser === true
    ? cancelledPartialAskGptDisplay(
        candidate,
        request,
        result.response,
        requestTextChars,
        redactionNote,
      )
    : partialAskGptDisplay(
        candidate,
        request,
        result.response,
        result.partialReason,
        requestTextChars,
        redactionNote,
      );
}

/**
 * 結果の3通り（全文・打ち切りで途中まで・失敗）を表示へ振り分ける（Issue #907）。
 *
 * 打ち切りでも `ok: true` で返ってくるため、`ok` だけで分けると「途中まで」が全文と
 * 同じ見た目になり、指摘が出ていないのか出せなかったのか読み手に区別できなくなる。
 */
function resultDisplay(
  candidate: SecondOpinionCandidate,
  artifactKind: SecondOpinionArtifactKind,
  request: string,
  result: SecondOpinionResult,
  summaryStatus: SecondOpinionSummaryStatus,
): SecondOpinionDisplay {
  if (!result.ok) {
    // 利用者が止めた結果は失敗ではない（Issue #940）。回答が1件も出ないまま止めた場合が
    // ここに来る。失敗として出すと、押した本人に「動かなかった」と読ませてしまう
    if (result.cancelledByUser === true) {
      return cancelledSecondOpinionDisplay(candidate, artifactKind, request);
    }
    return failedSecondOpinionDisplay(candidate, artifactKind, request, result.reason);
  }
  if (result.partialReason !== undefined && result.cancelledByUser === true) {
    return cancelledPartialSecondOpinionDisplay(
      candidate,
      artifactKind,
      request,
      result.response,
      summaryStatus,
    );
  }
  if (result.partialReason !== undefined) {
    return partialSecondOpinionDisplay(
      candidate,
      artifactKind,
      request,
      result.response,
      result.partialReason,
      summaryStatus,
    );
  }
  return finishedSecondOpinionDisplay(
    candidate,
    artifactKind,
    request,
    result.response,
    summaryStatus,
  );
}
