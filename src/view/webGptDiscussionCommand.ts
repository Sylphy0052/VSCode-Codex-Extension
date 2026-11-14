import * as vscode from 'vscode';
import { ensureWebGptBrowser } from '../webGpt/browser';
import {
  DEFAULT_CDP_ENDPOINT,
  parseCdpEndpoint,
  parseConversationUrls,
  WEB_GPT_DEFAULT_MAX_SENDS,
  WEB_GPT_MAX_SENDS_LIMIT,
} from '../webGpt/discussion';
/** 議題の文字数上限。入力欄とエージェントからの依頼（Issue #2051）で共通にする。 */
const WEB_GPT_TOPIC_MAX_LENGTH = 12000;

/**
 * エージェントが渡す議題の文字数上限（Issue #2051）。入力欄の前のモーダルで全文を読める
 * 長さに抑える。利用者が入力欄で書き足す分は`WEB_GPT_TOPIC_MAX_LENGTH`まで受け付ける。
 */
const WEB_GPT_TOOL_TOPIC_MAX_LENGTH = 2000;

/** エージェントが`start_webgpt_discussion`で渡した入力欄の初期値（Issue #2051）。 */
export interface WebGptDiscussionInitialValues {
  topic?: string | undefined;
  urls?: readonly string[] | undefined;
  maxSends?: number | undefined;
}

export interface PrepareWebGptDiscussionOptions {
  /** 入力欄の初期値。利用者は確認して書き換えられる。 */
  initial?: WebGptDiscussionInitialValues | undefined;
  /** 入力待ちを打ち切る。エージェントのツール呼び出しから開いたときに渡す。 */
  token?: vscode.CancellationToken | undefined;
  /** 入力欄の見出しへ添える依頼元（会話のタイトル）。 */
  requester?: string | undefined;
  /**
   * 質問ファイルの本文など、確定済みの議題（Issue #2057）。渡すと議題の入力欄を出さず、
   * 本文をそのまま使う。送信は会話URLと送信上限の確認のあとで、確認前には送らない。
   */
  fixedTopic?: string | undefined;
}

/**
 * エージェントが渡した初期値を、入力欄と同じ基準で確かめる（Issue #2051）。問題があれば
 * 理由を返す。入力欄を開く前に弾き、ツールの結果としてエージェントへ返すために使う。
 */
export function validateWebGptDiscussionInitial(
  initial: WebGptDiscussionInitialValues,
): string | undefined {
  if (initial.topic !== undefined && initial.topic.length > WEB_GPT_TOOL_TOPIC_MAX_LENGTH) {
    return `議題は${WEB_GPT_TOOL_TOPIC_MAX_LENGTH}文字以内で指定してください`;
  }
  if (initial.urls !== undefined) {
    try {
      parseConversationUrls(initial.urls.join(' '));
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  if (
    initial.maxSends !== undefined &&
    (!Number.isInteger(initial.maxSends) ||
      initial.maxSends < 1 ||
      initial.maxSends > WEB_GPT_MAX_SENDS_LIMIT)
  ) {
    return `送信上限は1〜${WEB_GPT_MAX_SENDS_LIMIT}の整数で指定してください`;
  }
  return undefined;
}

/** 現在の会話で使う場合も、Chromeの準備と入力は共通にする。 */
export async function prepareWebGptDiscussion(
  useCurrentContext = false,
  options: PrepareWebGptDiscussionOptions = {},
): Promise<{ endpoint: string; topic: string; urls: string[]; maxSends: number } | undefined> {
  const { initial, token, requester, fixedTopic } = options;
  const titleSuffix = requester === undefined ? '' : `（${requester}からの依頼）`;
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
  if (token?.isCancellationRequested === true) return;
  const rawUrls = await vscode.window.showInputBox(
    {
      title: `WebGPTと議論：会話URL${titleSuffix}`,
      value: initial?.urls?.join(' '),
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
    },
    token,
  );
  if (rawUrls === undefined) return;
  const urls = parseConversationUrls(rawUrls);
  const topic =
    fixedTopic ??
    (await vscode.window.showInputBox(
      {
        title: `WebGPTと議論：議題${titleSuffix}`,
        value: initial?.topic,
        prompt: useCurrentContext
          ? '空欄なら現在の会話から議題を選びます。議題に必要な論点を要約してChatGPTへ送ります'
          : 'この議題と議論中の回答・批評を対象のChatGPT会話（URL空欄なら新規）へ送信します',
        ignoreFocusOut: true,
        validateInput: (value) =>
          (!useCurrentContext && value.trim().length === 0) ||
          value.length > WEB_GPT_TOPIC_MAX_LENGTH
            ? useCurrentContext
              ? `議題は${WEB_GPT_TOPIC_MAX_LENGTH}文字以内で入力してください`
              : `議題は1〜${WEB_GPT_TOPIC_MAX_LENGTH}文字で入力してください`
            : undefined,
      },
      token,
    ));
  if (topic === undefined) return;
  // 初期値（無ければ既定）を先頭に置き、残りを1回から上限まで並べる
  const first = initial?.maxSends ?? WEB_GPT_DEFAULT_MAX_SENDS;
  const counts = [
    first,
    ...Array.from({ length: WEB_GPT_MAX_SENDS_LIMIT }, (_, i) => i + 1).filter(
      (count) => count !== first,
    ),
  ];
  const limit = await vscode.window.showQuickPick(
    counts.map((count) => ({
      label: `${count}回${count === WEB_GPT_DEFAULT_MAX_SENDS ? '（既定）' : ''}${count === initial?.maxSends ? '（依頼の値）' : ''}`,
      description:
        count === 1 ? '初回回答を集めてまとめる' : '合意するまで、初回質問と追加の批評・質問を送る',
      count,
    })),
    {
      title: `WebGPTと議論：各会話への送信上限${titleSuffix}`,
      placeHolder: '選ぶと議論を開始します。初回はnpxがPlaywrightを取得します',
      ignoreFocusOut: true,
    },
    token,
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
  };
}

export function reportDiscussionError(error: unknown): void {
  void vscode.window.showErrorMessage(
    `WebGPTとの議論を開始できませんでした: ${error instanceof Error ? error.message : String(error)}`,
  );
}
