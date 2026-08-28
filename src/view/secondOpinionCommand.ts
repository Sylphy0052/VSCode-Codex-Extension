/**
 * セカンドオピニオン（Issue #894）の起動導線。
 *
 * 依頼先・レビュー対象・依頼文を人に選ばせ、起動時点の成果物を固定してから、独立した
 * Codexセッションへ1ターンだけ送り、結果を元の会話へ差し込む。CodexとClaude Codeの
 * どちらの画面から押しても**Codexのセッションを開く**（この機能の値打ちはモデルの
 * 多様性ではなくコンテキストの分離にあるため。Issue #894 の決定3）。
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
  CONTEXT_KIND_LABELS,
  SECOND_OPINION_CONTEXT_KINDS,
  type SecondOpinionContext,
  type SecondOpinionContextKind,
} from '../secondOpinion/prompt';
import {
  runSecondOpinion,
  SecondOpinionRegistry,
  type SecondOpinionResult,
} from '../secondOpinion/run';
import { captureWorkspaceSnapshot } from '../secondOpinion/snapshot';
import { summarizeConversation } from '../secondOpinion/summary';

/** 画面1つ分の差し込み口。`ChatPanel` / `ClaudePanel` の違いをここへ閉じ込める。 */
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

const CONTEXT_KIND_DETAILS: Record<SecondOpinionContextKind, string> = {
  workspaceSnapshot: '押した時点の git diff HEAD を固定して渡します（実行中の変更は含みません）',
  lastAssistantResponse: 'この会話の直近の応答だけを渡します（独立性は下がります）',
  none: '依頼文だけを渡します',
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

async function pickContextKind(): Promise<SecondOpinionContextKind | undefined> {
  const picked = await vscode.window.showQuickPick(
    SECOND_OPINION_CONTEXT_KINDS.map((kind) => ({
      label: CONTEXT_KIND_LABELS[kind],
      detail: CONTEXT_KIND_DETAILS[kind],
      // `kind` は QuickPickItem の予約フィールド（区切り行の指定）なので別名で持つ
      contextKind: kind,
    })),
    { title: 'レビュー対象', placeHolder: 'この会話の内容は、どれを選んでも渡しません' },
  );
  return picked?.contextKind;
}

/**
 * レビュー対象を、押下時の状態で固定する。
 *
 * `read-only` サンドボックスは相手側の書き込みしか止められないため、実行中に親セッションが
 * 作業ツリーを書き換えると、どの時点にも存在しなかった状態をレビューすることになる。
 * ここで内容を確定させることが受入基準5の実体。
 */
async function captureContext(
  kind: SecondOpinionContextKind,
  cwd: string,
  port: SecondOpinionPanelPort,
  git: GitCommandRunner,
): Promise<SecondOpinionContext | undefined> {
  if (kind === 'none') {
    return { kind: 'none' };
  }
  if (kind === 'lastAssistantResponse') {
    const response = port.lastAssistantResponse().trim();
    if (response === '') {
      void vscode.window.showErrorMessage(
        'この会話にはまだエージェントの応答がないため、レビュー対象にできません',
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
  return { kind: 'workspaceSnapshot', snapshot: captured.snapshot };
}

/**
 * 会話の要約（Issue #903）を作る。
 *
 * 要約は**別セッション**が作る（作業した本人に要約させると、その解釈が圧縮されて渡り、
 * 独立レビューとしての値打ちが落ちるため。`summary.ts` 参照）。設定で切っている場合と、
 * 要約に失敗した場合は本文を返さない。どちらでもセカンドオピニオン本体は続行し、
 * 要約なしのプロンプト（Issue #894時点と同じ）で走る。
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
  const contextKind = await pickContextKind();
  if (contextKind === undefined) {
    return;
  }
  const request = await vscode.window.showInputBox({
    title: 'セカンドオピニオンへの依頼',
    // 要約を添える設定では「会話の内容は渡らない」は事実と食い違う。何が渡るかを正しく出す
    prompt: config.summary.enabled
      ? 'この会話そのものは渡らず、別セッションが作った要約だけが渡ります。依頼したいことを書いてください'
      : 'この会話の内容は渡りません。依頼したいことだけを書いてください',
    value: config.template,
  });
  if (request === undefined || request.trim() === '') {
    return;
  }
  const context = await captureContext(contextKind, cwd, port, git);
  if (context === undefined) {
    return;
  }

  if (!registry.begin(port.parentSessionId)) {
    // 選択している間に別経路から起動された場合。二重に走らせない
    void vscode.window.showInformationMessage('この会話のセカンドオピニオンは既に実行中です');
    return;
  }
  const id = `secondOpinion:${randomUUID()}`;
  port.setRunning(true);
  port.note(id, pendingSecondOpinionDisplay(candidate, contextKind, request));
  try {
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
        context,
        headless: config.headless,
        timeoutMs: config.timeoutMs,
        conversationSummary: summary.text,
      },
      log,
    );
    const summaryStatus: SecondOpinionSummaryStatus =
      summary.text !== undefined ? 'attached' : summary.failure === undefined ? 'off' : 'failed';
    port.note(id, resultDisplay(candidate, contextKind, request, result, summaryStatus));
    if (!result.ok) {
      log.warn(`[secondOpinion] 失敗しました: ${result.reason}`);
    }
  } finally {
    registry.end(port.parentSessionId);
    port.setRunning(false);
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
  contextKind: SecondOpinionContextKind,
  request: string,
  result: SecondOpinionResult,
  summaryStatus: SecondOpinionSummaryStatus,
): SecondOpinionDisplay {
  if (!result.ok) {
    return failedSecondOpinionDisplay(candidate, contextKind, request, result.reason);
  }
  if (result.partialReason !== undefined) {
    return partialSecondOpinionDisplay(
      candidate,
      contextKind,
      request,
      result.response,
      result.partialReason,
      summaryStatus,
    );
  }
  return finishedSecondOpinionDisplay(
    candidate,
    contextKind,
    request,
    result.response,
    summaryStatus,
  );
}
