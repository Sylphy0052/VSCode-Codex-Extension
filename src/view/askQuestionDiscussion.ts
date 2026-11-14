import * as vscode from 'vscode';
import type { ChatItem } from '../appserver/chatState';
import { readAskQuestionTopic } from '../webGpt/askQuestionFile';
import type { PrepareWebGptDiscussionOptions } from './webGptDiscussionCommand';

/**
 * 「この質問をChatGPTで議論する」ボタン（Issue #2057）から、議論の入力欄へ渡す設定を作る。
 *
 * Webviewから届くのは会話項目のidだけで、パスは項目の差分（Write由来の`add`）から取る。
 * 質問ファイルでない・読めない・12000文字を超えるときは理由を出して`undefined`を返し、
 * 議論は起動しない。本文は確認のためエディタにプレビューで開く（フォーカスは奪わない）。
 */
export async function prepareAskQuestionDiscussion(
  items: readonly ChatItem[],
  itemId: unknown,
  roots: readonly string[],
): Promise<PrepareWebGptDiscussionOptions | undefined> {
  const item = typeof itemId === 'string' ? items.find((i) => i.id === itemId) : undefined;
  const diff = item?.kind === 'fileChange' ? item.diffs.find((d) => d.kind === 'add') : undefined;
  if (diff === undefined) {
    void vscode.window.showWarningMessage('質問ファイルの作成が見つかりませんでした');
    return undefined;
  }
  const read = await readAskQuestionTopic(roots, diff.path);
  if (!read.ok) {
    void vscode.window.showWarningMessage(`ChatGPTでの議論を始められません: ${read.message}`);
    return undefined;
  }
  void vscode.window.showTextDocument(vscode.Uri.file(read.absolutePath), {
    preview: true,
    preserveFocus: true,
  });
  return { fixedTopic: read.topic };
}
