/**
 * 会話に出てくる画像の参照。
 *
 * **Webviewへ渡してよいのはデータURLだけ**（CSPが `img-src data:` しか許さない。
 * `localResourceRoots` を広げると任意のファイルをWebviewから読めるようになるため、
 * そちらへは寄せない）。ローカルのパスで届いた画像は、ホスト側が読んでデータURLへ
 * 変えてから渡す。
 */

import { SUPPORTED_MEDIA_TYPES } from './attachments';

export interface ChatImage {
  /** そのまま `<img src>` に入れられる値。無ければ `path` を読んで埋める。 */
  dataUrl: string | undefined;
  /** ローカルの絶対パス。読めるかどうかはホスト側が決める。 */
  path: string | undefined;
  /** 代替テキスト。読めなかったときの表示にも使う。 */
  alt: string;
}

/** 画像を持たない項目のための空配列。 */
export const NO_IMAGES: ChatImage[] = [];

const DATA_IMAGE_RE = /^data:image\/([a-z+]+);base64,/u;

/** Webviewでそのまま表示できるデータURLか。 */
export function isDataImageUrl(url: string): boolean {
  const matched = DATA_IMAGE_RE.exec(url);
  return matched !== null && isSupportedMediaType(`image/${matched[1] ?? ''}`);
}

/** 拡張子から種類を決める。対応しない拡張子では `undefined`。 */
export function mediaTypeForPath(filePath: string): string | undefined {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) {
    return undefined;
  }
  const ext = filePath.slice(dot + 1).toLowerCase();
  const mediaType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
  return isSupportedMediaType(mediaType) ? mediaType : undefined;
}

/**
 * Codexの `userMessage.content` から画像を取り出す。
 *
 * 実測した形（`codex-cli 0.147.0`）: `{type:'image', detail:null, url:'data:image/png;base64,...'}`。
 * 送った画像は会話にそのまま残るため、再開したセッションでも同じものが読める。
 */
export function readUserInputImages(content: unknown): ChatImage[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const images: ChatImage[] = [];
  for (const raw of content) {
    const part = asRecord(raw);
    const type = str(part?.['type']);
    if (part === undefined) {
      continue;
    }
    if (type === 'image') {
      const url = str(part['url']);
      images.push(
        isDataImageUrl(url)
          ? { dataUrl: url, path: undefined, alt: '送った画像' }
          : // 黙って欠けさせず、表示できないことを画面に出す
            { dataUrl: undefined, path: undefined, alt: `表示できない画像 (${url})` },
      );
      continue;
    }
    if (type === 'localImage') {
      const filePath = str(part['path']);
      if (filePath !== '') {
        images.push({ dataUrl: undefined, path: filePath, alt: filePath });
      }
    }
  }
  return images;
}

/**
 * Claude Codeのcontent配列（`tool_result` / ユーザーメッセージ共通）から画像を取り出す。
 *
 * 実測した形（CLI 2.1.227、`Read` でpngを読ませた）:
 * `{type:'image', source:{type:'base64', media_type:'image/png', data:'...'}}`。
 * ユーザーが送った画像も同じMessages API形式で来る（stream-jsonはAPI形式をそのまま出す）。
 */
export function readClaudeResultImages(content: unknown, alt = 'ツールが読んだ画像'): ChatImage[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const images: ChatImage[] = [];
  for (const raw of content) {
    const part = asRecord(raw);
    if (part === undefined || str(part['type']) !== 'image') {
      continue;
    }
    const source = asRecord(part['source']);
    const mediaType = str(source?.['media_type']);
    const data = str(source?.['data']);
    if (str(source?.['type']) !== 'base64' || data === '' || !isSupportedMediaType(mediaType)) {
      continue;
    }
    images.push({
      dataUrl: `data:${mediaType};base64,${data}`,
      path: undefined,
      alt,
    });
  }
  return images;
}

/** 会話へ出す画像1枚の上限。これを超えるものは読まない。 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Webviewへ返す画像1件。読めなかった場合は `error` に理由が入る。 */
export interface ImageReply {
  path: string;
  dataUrl: string | undefined;
  error: string | undefined;
}

/**
 * Webviewからの画像要求に答える。
 *
 * **会話に出てきたパスしか読まない。** Webview側は信用できない入力元なので、
 * 任意のファイルを読み出せる口にしてはいけない。
 *
 * 読めなかったときも必ず理由を返す（黙って欠けた画像を残さない）。
 */
export async function buildImageReply(
  items: readonly { images?: ChatImage[] | undefined }[],
  requested: unknown,
  readBase64File: (filePath: string, maxBytes: number) => Promise<string | undefined>,
): Promise<ImageReply | undefined> {
  if (typeof requested !== 'string' || requested === '') {
    return undefined;
  }
  const known = items.some((item) => (item.images ?? []).some((img) => img.path === requested));
  if (!known) {
    return undefined;
  }

  const mediaType = mediaTypeForPath(requested);
  if (mediaType === undefined) {
    return { path: requested, dataUrl: undefined, error: '対応しない形式です' };
  }

  const data = await readBase64File(requested, MAX_IMAGE_BYTES);
  if (data === undefined || data === '') {
    return { path: requested, dataUrl: undefined, error: '画像を読み込めませんでした' };
  }
  return { path: requested, dataUrl: `data:${mediaType};base64,${data}`, error: undefined };
}

function isSupportedMediaType(mediaType: string): boolean {
  return (SUPPORTED_MEDIA_TYPES as readonly string[]).includes(mediaType);
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
