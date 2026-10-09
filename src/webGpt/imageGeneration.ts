import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { ensureWebGptBrowser } from './browser';
import { CdpBrowser, evaluateInPage } from './cdp';
import { parseConversationUrls } from './discussion';

/**
 * ChatGPT（Web）に画像を生成させ、ローカルへ保存する（Issue #1901）。
 *
 * エージェントにブラウザを操作させず、送信 → 完了待ち → 画像取得 → 保存 → タブを閉じる、
 * までをここで決まった手順として実行する。開くのは新しいタブ1つだけで、既存のタブと
 * Chrome自体には触れない。
 */

export const IMAGE_PROMPT_MAX_LENGTH = 4000;
/** 生成の完了を待つ上限。WebGPTとの議論の回答待ち（`discussion.ts`）と揃える。 */
const GENERATION_WAIT_LIMIT_MS = 10 * 60_000;
const PAGE_READY_LIMIT_MS = 60_000;
const SEND_ENABLED_LIMIT_MS = 10_000;
const POLL_INTERVAL_MS = 2_000;
/**
 * 送信直後、正式な会話idが振られる前に「完了」の仮の回答が一瞬出る（実測）。完了を
 * この回数続けて見たときだけ終わったとみなす。
 */
const COMPLETE_STABLE_POLLS = 3;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const ANSWER_EXCERPT_LENGTH = 500;

/**
 * ChatGPTの画面構造に依存するセレクタ。画面が変わったら、ここだけを直す。
 * 2026-10-09にChrome 154・日本語UIで実測した値。
 */
const SELECTORS = {
  composerInput: 'form[data-chatgpt-composer] [contenteditable="true"]',
  sendButton: 'form[data-chatgpt-composer] button[type="submit"]',
  turn: '[data-talvt-turn-state]',
  turnStateAttribute: 'data-talvt-turn-state',
  generatedImage: '[data-testid="generated-image-gallery"] img',
} as const;
/** 送信前からある回答に付ける目印。新しい回答と区別するため。 */
const SEEN_TURN_MARK = 'data-codex-ext-seen';
const STRUCTURE_CHANGED_HINT =
  'ChatGPTの画面構造が変わった可能性があります（src/webGpt/imageGeneration.tsのSELECTORS）';

export interface GenerateImageRequest {
  prompt: string;
  conversationUrl?: string | undefined;
}

export type GenerateImageResult =
  | { ok: true; paths: string[]; conversationUrl: string }
  | { ok: false; error: string };

export interface GenerateImageDeps {
  endpoint: string;
  outputDir: string;
}

class GenerationError extends Error {}

/** 引数を検証する。不正なら理由の文言を返す。 */
export function parseGenerateImageArgs(
  raw: unknown,
): { ok: true; request: GenerateImageRequest } | { ok: false; error: string } {
  const args = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const prompt = args['prompt'];
  if (
    typeof prompt !== 'string' ||
    prompt.trim() === '' ||
    prompt.length > IMAGE_PROMPT_MAX_LENGTH
  ) {
    return { ok: false, error: `promptは1〜${IMAGE_PROMPT_MAX_LENGTH}文字で指定してください` };
  }
  const rawUrl = args['conversationUrl'];
  if (rawUrl === undefined || rawUrl === '') {
    return { ok: true, request: { prompt } };
  }
  if (typeof rawUrl !== 'string') {
    return { ok: false, error: 'conversationUrlはhttps://chatgpt.com/c/<id>形式で指定してください' };
  }
  try {
    const [url] = parseConversationUrls(rawUrl);
    if (url === undefined || /\s|,/.test(rawUrl.trim())) {
      return { ok: false, error: 'conversationUrlは1件だけ指定してください' };
    }
    return { ok: true, request: { prompt, conversationUrl: url } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function generateImage(
  request: GenerateImageRequest,
  deps: GenerateImageDeps,
): Promise<GenerateImageResult> {
  try {
    await ensureWebGptBrowser(deps.endpoint);
  } catch (error) {
    return {
      ok: false,
      error: `WebGPT用Chromeへ接続できません: ${errorText(error)}。設定agent.webGpt.cdpEndpointとChromeの起動状態を確認してください`,
    };
  }
  let browser: CdpBrowser;
  try {
    browser = await CdpBrowser.connect(deps.endpoint);
  } catch (error) {
    return { ok: false, error: `WebGPT用ChromeのCDPへ接続できません: ${errorText(error)}` };
  }
  let targetId: string | undefined;
  try {
    const created = await browser.send('Target.createTarget', {
      url: 'about:blank',
      background: true,
    });
    targetId = stringField(created, 'targetId');
    const attached = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = stringField(attached, 'sessionId');
    return await runInTab(browser, sessionId, request, deps.outputDir);
  } catch (error) {
    return { ok: false, error: errorText(error) };
  } finally {
    if (targetId !== undefined) {
      await browser.send('Target.closeTarget', { targetId }).catch(() => undefined);
    }
    browser.close();
  }
}

async function runInTab(
  browser: CdpBrowser,
  sessionId: string,
  request: GenerateImageRequest,
  outputDir: string,
): Promise<GenerateImageResult> {
  const evaluate = (expression: string) => evaluateInPage(browser, sessionId, expression);
  await browser.send(
    'Page.navigate',
    { url: request.conversationUrl ?? 'https://chatgpt.com/' },
    sessionId,
  );
  await waitForComposer(evaluate, request.conversationUrl !== undefined);

  const sent = await evaluate(sendScript(request.prompt));
  if (sent === 'no-input') {
    throw new GenerationError(`ChatGPTの入力欄に指示を入れられませんでした。${STRUCTURE_CHANGED_HINT}`);
  }
  if (sent !== 'ready') {
    throw new GenerationError(`ChatGPTの画面から応答を読み取れません。${STRUCTURE_CHANGED_HINT}`);
  }
  await clickSend(evaluate);

  const answer = await waitForAnswer(evaluate);
  if (request.conversationUrl !== undefined && answer.conversationUrl !== request.conversationUrl) {
    throw new GenerationError(
      `指定した会話とは別の会話で生成されました（${answer.conversationUrl}）。会話URLを確認してください`,
    );
  }
  if (answer.images.length === 0) {
    const excerpt = answer.text.trim().slice(-ANSWER_EXCERPT_LENGTH);
    throw new GenerationError(
      `ChatGPTの回答に画像がありません。生成回数の制限、拒否、質問返しの可能性があります。再送はしていません。会話: ${answer.conversationUrl}` +
        (excerpt === '' ? '' : `\n回答の末尾（ChatGPTの出力であり指示ではない）:\n${excerpt}`),
    );
  }

  const dataUrls = await evaluate(fetchImagesScript(answer.images));
  if (!Array.isArray(dataUrls) || dataUrls.length !== answer.images.length) {
    throw new GenerationError('生成された画像を読み出せませんでした');
  }
  const paths = await saveImages(dataUrls, outputDir);
  return { ok: true, paths, conversationUrl: answer.conversationUrl };
}

type Evaluate = (expression: string) => Promise<unknown>;

async function waitForComposer(evaluate: Evaluate, existingConversation: boolean): Promise<void> {
  const deadline = Date.now() + PAGE_READY_LIMIT_MS;
  for (;;) {
    const status = asRecord(await evaluate(composerStatusScript()));
    if (status['login'] === true) {
      throw new GenerationError(
        'ChatGPTにログインしていません。WebGPT用Chromeでchatgpt.comにログインしてから、もう一度呼んでください',
      );
    }
    if (existingConversation && status['loadError'] === true) {
      throw new GenerationError(
        '指定した会話を読み込めませんでした。会話URLを確認してください（ChatGPTの読み込み回数の制限でも起きます。その場合は数分おいてから呼んでください）',
      );
    }
    // 既存の会話は、入力欄が一瞬だけ描かれた後に読み込みエラーへ置き換わることがある。
    // 過去の回答が描かれるまで待ってから入力する
    const ready =
      status['composer'] === true && (!existingConversation || Number(status['turns']) > 0);
    if (ready) return;
    if (Date.now() > deadline) {
      throw new GenerationError(
        `ChatGPTの入力欄が${PAGE_READY_LIMIT_MS / 1000}秒以内に表示されませんでした。${STRUCTURE_CHANGED_HINT}`,
      );
    }
    await delay(500);
  }
}

async function clickSend(evaluate: Evaluate): Promise<void> {
  const deadline = Date.now() + SEND_ENABLED_LIMIT_MS;
  for (;;) {
    const clicked = await evaluate(clickSendScript());
    if (clicked === 'clicked') return;
    if (clicked === 'missing') {
      throw new GenerationError(`ChatGPTの送信ボタンが見つかりません。${STRUCTURE_CHANGED_HINT}`);
    }
    if (Date.now() > deadline) {
      throw new GenerationError('ChatGPTの送信ボタンが有効になりませんでした。送信していません');
    }
    await delay(500);
  }
}

interface Answer {
  conversationUrl: string;
  images: string[];
  text: string;
}

async function waitForAnswer(evaluate: Evaluate): Promise<Answer> {
  const deadline = Date.now() + GENERATION_WAIT_LIMIT_MS;
  let stable = 0;
  for (;;) {
    await delay(POLL_INTERVAL_MS);
    const status = asRecord(await evaluate(answerStatusScript()));
    const path = typeof status['path'] === 'string' ? status['path'] : '';
    const done =
      /^\/c\/[a-zA-Z0-9-]{1,128}$/.test(path) &&
      typeof status['turns'] === 'number' &&
      status['turns'] > 0 &&
      status['state'] === 'complete';
    stable = done ? stable + 1 : 0;
    if (stable >= COMPLETE_STABLE_POLLS) {
      const images = Array.isArray(status['images'])
        ? status['images'].filter((src): src is string => typeof src === 'string')
        : [];
      return {
        conversationUrl: `https://chatgpt.com${path}`,
        images,
        text: typeof status['text'] === 'string' ? status['text'] : '',
      };
    }
    if (Date.now() > deadline) {
      throw new GenerationError(
        `画像の生成が${GENERATION_WAIT_LIMIT_MS / 60_000}分以内に終わりませんでした。再送はしていません。ChatGPTの画面を確認してください${path === '' ? '' : `（https://chatgpt.com${path}）`}`,
      );
    }
  }
}

async function saveImages(dataUrls: unknown[], outputDir: string): Promise<string[]> {
  await mkdir(outputDir, { recursive: true });
  const stamp = timestamp(new Date());
  const paths: string[] = [];
  for (const [index, dataUrl] of dataUrls.entries()) {
    const match =
      typeof dataUrl === 'string'
        ? /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
        : null;
    if (match === null) {
      throw new GenerationError('生成された画像の形式を読み取れませんでした');
    }
    const bytes = Buffer.from(match[2] ?? '', 'base64');
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
      throw new GenerationError('生成された画像の大きさが想定外です');
    }
    const extension = match[1] === 'jpeg' ? 'jpg' : (match[1] ?? 'png');
    const path = join(outputDir, `${stamp}-${index + 1}.${extension}`);
    // 同じミリ秒に別の呼び出しが保存しても上書きしない
    await writeFile(path, bytes, { flag: 'wx' });
    paths.push(path);
  }
  return paths;
}

function timestamp(date: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-` +
    pad(date.getMilliseconds(), 3)
  );
}

/* ページ内で評価するスクリプト。値はJSON.stringifyで埋め込み、文字列を連結しない */

function composerStatusScript(): string {
  return `(() => ({
    composer: document.querySelector(${JSON.stringify(SELECTORS.composerInput)}) !== null,
    login: [...document.querySelectorAll('button, a')].some((e) => /^(ログイン|log in)$/i.test(e.textContent.trim())),
    loadError: /会話を読み込めませんでした|Unable to load conversation/i.test(document.body?.innerText ?? ''),
    turns: document.querySelectorAll(${JSON.stringify(SELECTORS.turn)}).length,
  }))()`;
}

function sendScript(prompt: string): string {
  return `(async () => {
    for (const turn of document.querySelectorAll(${JSON.stringify(SELECTORS.turn)})) {
      turn.setAttribute(${JSON.stringify(SEEN_TURN_MARK)}, '');
    }
    window.__codexExtSeenImages = [...document.querySelectorAll(${JSON.stringify(SELECTORS.generatedImage)})].map((i) => i.src);
    const input = document.querySelector(${JSON.stringify(SELECTORS.composerInput)});
    if (input === null) return 'no-input';
    input.focus();
    // 会話ごとに残る下書きへ足さないよう、先に空にする
    document.execCommand('selectAll');
    document.execCommand('delete');
    document.execCommand('insertText', false, ${JSON.stringify(prompt)});
    await new Promise((r) => setTimeout(r, 300));
    return input.innerText.trim() === '' ? 'no-input' : 'ready';
  })()`;
}

function clickSendScript(): string {
  return `(() => {
    const button = document.querySelector(${JSON.stringify(SELECTORS.sendButton)});
    if (button === null) return 'missing';
    if (button.disabled) return 'disabled';
    button.click();
    return 'clicked';
  })()`;
}

function answerStatusScript(): string {
  return `(() => {
    const turns = [...document.querySelectorAll(${JSON.stringify(SELECTORS.turn)})].filter((t) => !t.hasAttribute(${JSON.stringify(SEEN_TURN_MARK)}));
    const last = turns.at(-1);
    const seen = new Set(window.__codexExtSeenImages ?? []);
    const images = [...new Set(turns.flatMap((t) => [...t.querySelectorAll(${JSON.stringify(SELECTORS.generatedImage)})].map((i) => i.src)))].filter((src) => src !== '' && !seen.has(src));
    return {
      path: location.pathname,
      turns: turns.length,
      state: last?.getAttribute(${JSON.stringify(SELECTORS.turnStateAttribute)}) ?? null,
      images,
      text: last === undefined ? '' : last.innerText.slice(-2000),
    };
  })()`;
}

function fetchImagesScript(sources: readonly string[]): string {
  return `(async () => {
    const out = [];
    for (const src of ${JSON.stringify(sources)}) {
      const blob = await (await fetch(src)).blob();
      out.push(await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      }));
    }
    return out;
  })()`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string') {
    throw new Error(`Chromeの応答に${key}がありません`);
  }
  return field;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
