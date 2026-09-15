import * as vscode from 'vscode';
import { ensureWebGptBrowser } from '../webGpt/browser';
import {
  buildWebGptDiscussionPrompt,
  DEFAULT_CDP_ENDPOINT,
  parseCdpEndpoint,
  parseConversationUrls,
} from '../webGpt/discussion';
/** 現在の会話で使う場合も、Chromeの準備と入力は共通にする。 */
export async function prepareWebGptDiscussion(
  useCurrentContext = false,
): Promise<
  { prompt: string; endpoint: string; topic: string; urls: string[]; maxSends: number } | undefined
> {
  if (!vscode.workspace.isTrusted) {
    throw new Error('WebGPTとの議論には信頼済みワークスペースが必要です');
  }
  const endpoint = parseCdpEndpoint(
    vscode.workspace
      .getConfiguration('agent.webGpt')
      .get<string>('cdpEndpoint', DEFAULT_CDP_ENDPOINT),
  );
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'WebGPT用Chromeへ接続しています（未起動なら起動します）',
    },
    () => ensureWebGptBrowser(endpoint),
  );
  const rawUrls = await vscode.window.showInputBox({
    title: 'WebGPTと議論：会話URL',
    prompt:
      '開いたChromeで必要ならログインし、URLは空欄で新規会話を作成、既存会話は1〜3件を空白かカンマで区切って入力',
    placeHolder: '空欄で新規会話、またはhttps://chatgpt.com/c/…',
    ignoreFocusOut: true,
    validateInput: (value) => {
      try {
        parseConversationUrls(value);
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  });
  if (rawUrls === undefined) return;
  const urls = parseConversationUrls(rawUrls);
  const topic = await vscode.window.showInputBox({
    title: 'WebGPTと議論：議題',
    prompt: useCurrentContext
      ? '空欄なら現在の会話から議題を選びます。議題に必要な論点を要約してChatGPTへ送ります'
      : 'この議題と議論中の回答・批評を対象のChatGPT会話（URL空欄なら新規）へ送信します',
    ignoreFocusOut: true,
    validateInput: (value) =>
      (!useCurrentContext && value.trim().length === 0) || value.length > 12000
        ? useCurrentContext
          ? '議題は12000文字以内で入力してください'
          : '議題は1〜12000文字で入力してください'
        : undefined,
  });
  if (topic === undefined) return;
  const limit = await vscode.window.showQuickPick(
    [2, 1, 3, 4, 5].map((count) => ({
      label: `${count}回${count === 2 ? '（既定）' : ''}`,
      description: count === 1 ? '初回回答を集めてまとめる' : '初回質問と追加の批評・質問を含む',
      count,
    })),
    {
      title: 'WebGPTと議論：各会話への送信上限',
      placeHolder: '選ぶと議論を開始します。初回はnpxがPlaywrightを取得します',
      ignoreFocusOut: true,
    },
  );
  if (limit === undefined) return;
  const resolvedTopic =
    useCurrentContext && topic.trim() === ''
      ? '現在の会話の目的・決定事項・未解決点を踏まえて、議論すべき論点を自分で選んでください'
      : topic;
  return {
    endpoint,
    topic: resolvedTopic,
    urls,
    maxSends: limit.count,
    prompt: buildWebGptDiscussionPrompt(resolvedTopic, urls, limit.count, useCurrentContext),
  };
}

export function reportDiscussionError(error: unknown): void {
  void vscode.window.showErrorMessage(
    `WebGPTとの議論を開始できませんでした: ${error instanceof Error ? error.message : String(error)}`,
  );
}
