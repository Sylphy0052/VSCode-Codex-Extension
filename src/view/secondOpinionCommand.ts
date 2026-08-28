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
import type { Logger } from '../log';
import type { TaskSessionHost } from '../orchestrator/taskSession';
import { nodeGitCommandRunner, type GitCommandRunner } from '../orchestrator/worktree';
import type { SecondOpinionCandidate } from '../secondOpinion/candidates';
import {
  failedSecondOpinionDisplay,
  finishedSecondOpinionDisplay,
  partialSecondOpinionDisplay,
  pendingSecondOpinionDisplay,
  type SecondOpinionDisplay,
  type SecondOpinionSummaryStatus,
} from '../secondOpinion/display';
import {
  ARTIFACT_KIND_LABELS,
  SECOND_OPINION_ARTIFACT_KINDS,
  type SecondOpinionArtifact,
  type SecondOpinionArtifactKind,
} from '../secondOpinion/prompt';
import {
  runSecondOpinion,
  SecondOpinionRegistry,
  type SecondOpinionResult,
} from '../secondOpinion/run';
import { captureWorkspaceSnapshot } from '../secondOpinion/snapshot';
import { summarizeConversation } from '../secondOpinion/summary';

/**
 * 画面1つ分の差し込み口。`ChatPanel` / `ClaudePanel` の違いをここへ閉じ込める。
 *
 * **契約: `note()` / `setRunning()` は例外を投げてはならない。** パネルが破棄済みの場合は
 * no-opで返すこと。選択UI（QuickPick 2回 + InputBox）を人が触っている最中にタブを閉じられる
 * ため、破棄済みpanelへ書き込む経路は現実に踏む。ここで投げられると実行中フラグが
 * `SecondOpinionRegistry` に残り、以後その会話ではセカンドオピニオンを起動できなくなる
 * （Issue #926 B）。呼び出し側でも try/finally で守っているが、二重の保険とする。
 */
export interface SecondOpinionPanelPort {
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
  /** 会話へ1項目として残す/更新する。 */
  note(id: string, display: SecondOpinionDisplay): void;
  /** webviewのボタンの押下可否を切り替える。 */
  setRunning(running: boolean): void;
}

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
async function captureArtifact(
  kind: SecondOpinionArtifactKind,
  cwd: string,
  port: SecondOpinionPanelPort,
  git: GitCommandRunner,
): Promise<SecondOpinionArtifact | undefined> {
  if (kind === 'none') {
    return { kind: 'none' };
  }
  if (kind === 'lastAssistantResponse') {
    const response = port.lastAssistantResponse().trim();
    if (response === '') {
      void vscode.window.showErrorMessage(
        'この会話にはまだエージェントの応答がないため、資料として渡せません',
      );
      return undefined;
    }
    return { kind: 'lastAssistantResponse', response };
  }
  const captured = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: '変更のスナップショットを取得しています…' },
    () => captureWorkspaceSnapshot(cwd, git),
  );
  if (!captured.ok) {
    void vscode.window.showErrorMessage(`セカンドオピニオン: ${captured.reason}`);
    return undefined;
  }
  return { kind: 'workspaceChanges', snapshot: captured.snapshot };
}

/**
 * 会話の要約（Issue #903）を作る。
 *
 * 要約は**別セッション**が作る（作業した本人に要約させると、その解釈が圧縮されて渡り、
 * 独立した意見としての値打ちが落ちるため。`summary.ts` 参照）。設定で切っている場合と、
 * 要約に失敗した場合は本文を返さない。どちらでもセカンドオピニオン本体は続行し、
 * 背景の区画が無いプロンプトで走る。
 */
async function buildConversationSummary(
  port: SecondOpinionPanelPort,
  host: TaskSessionHost,
  config: SecondOpinionConfig,
  cwd: string,
  log: Logger,
): Promise<{ text: string | undefined; failure: string | undefined }> {
  if (!config.summary.enabled) {
    return { text: undefined, failure: undefined };
  }
  const conversation = port.conversationTranscript();
  if (conversation.trim() === '') {
    return { text: undefined, failure: undefined };
  }
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: '会話の要約を作成しています…' },
    () =>
      summarizeConversation(
        host,
        {
          cwd,
          model: config.summary.model,
          effort: config.summary.effort,
          conversation,
        },
        log,
      ),
  );
  return result.ok
    ? { text: result.summary, failure: undefined }
    : { text: undefined, failure: result.reason };
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

  const candidate = await pickCandidate(config.candidates);
  if (candidate === undefined) {
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
  const artifact = await captureArtifact(artifactKind, cwd, port, git);
  if (artifact === undefined) {
    return;
  }

  if (!registry.begin(port.parentSessionId)) {
    // 選択している間に別経路から起動された場合。二重に走らせない
    void vscode.window.showInformationMessage('この会話のセカンドオピニオンは既に実行中です');
    return;
  }
  // `begin()` の成功直後から `try` を始める。`setRunning()` / `note()` が投げると
  // `finally` へ入らず、`registry` にidが残って以後その会話では二度と起動できなくなる
  // （選択UIを触っている最中にタブを閉じられる経路で実際に踏みうる。Issue #926 B）
  try {
    const id = `secondOpinion:${randomUUID()}`;
    port.setRunning(true);
    port.note(id, pendingSecondOpinionDisplay(candidate, artifactKind, request));
    // 要約は本体より先に作る（本体のプロンプトへ載せるため）。失敗しても本体は続ける
    const summary = await buildConversationSummary(port, host, config, cwd, log);
    if (summary.failure !== undefined) {
      log.warn(`[secondOpinion] 会話の要約を作れませんでした: ${summary.failure}`);
    }
    const result = await runSecondOpinion(
      host,
      {
        cwd,
        candidate,
        request,
        artifact,
        headless: config.headless,
        timeoutMs: config.timeoutMs,
        conversationSummary: summary.text,
      },
      log,
    );
    const summaryStatus: SecondOpinionSummaryStatus =
      summary.text !== undefined ? 'attached' : summary.failure === undefined ? 'off' : 'failed';
    port.note(id, resultDisplay(candidate, artifactKind, request, result, summaryStatus));
    if (!result.ok) {
      log.warn(`[secondOpinion] 失敗しました: ${result.reason}`);
    }
  } finally {
    registry.end(port.parentSessionId);
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
    return failedSecondOpinionDisplay(candidate, artifactKind, request, result.reason);
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
