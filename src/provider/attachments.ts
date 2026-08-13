/**
 * 発言に添える画像。
 *
 * **一時ファイルは使わない**。CodexもClaude Codeも中身をそのまま受け取れることを
 * 実測で確かめてある（Codexは `image` のデータURL、Claude Codeは `image` ブロックの
 * base64。どちらも32pxの赤い画像を送って「赤」と答えた）。パスを渡す形
 * （Codexの `localImage`）も通るが、貼り付けた画像には実体が無いので一度ファイルへ
 * 書くことになり、消す責任と、再開したセッションからパスが切れる問題を抱える。
 * 中身を直接渡せば、貼付・ドロップ・ファイル選択が全部同じ経路になる。
 *
 * 代わりに履歴（Codexのrollout、Claude Codeのtranscript）へbase64がそのまま残るため、
 * 枚数と大きさに上限を設けて膨らみを抑える。
 */

export interface Attachment {
  /** 画面で見分けるためのid。取り消しの指定にも使う。 */
  id: string;
  /** 表示名。ファイル名か、貼り付けたものなら既定の名前。 */
  name: string;
  /** `image/png` など。 */
  mediaType: string;
  /** 中身のbase64（データURLの接頭辞を含まない）。 */
  data: string;
  /** 元データのバイト数。 */
  bytes: number;
}

/** 受け付ける形式。ここに無いものは弾く。 */
export const SUPPORTED_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

/**
 * ドロップを受け取れなかったときに画面へ出す理由（issue #241）。
 *
 * Webviewから届く種類だけを文言に変える。**知らない値では何も返さない**
 * （Webviewは信用できない入力元なので、通知の文言をあちら側に作らせない）。
 *
 * 理由を出すこと自体に切り分けの意味もある。ドロップがWebviewまで届いていれば
 * どれかが出るため、何も出ないときはVS Code本体が横取りしていると分かる。
 */
export function dropRejectionReason(kind: unknown): string | undefined {
  if (kind === 'notImage') {
    return 'ドロップされたファイルに画像がありませんでした';
  }
  if (kind === 'pathOnly') {
    // ホストは会話に出てきたパスしか読まない（imageRefs.ts）。VS Codeのエクスプローラーや
    // 他のツリーからのドラッグはパスだけを載せてくるため、この経路では受け取れない
    return 'VS Code内からのドラッグには対応していません。「画像」ボタンかCtrl+Vで添えてください';
  }
  if (kind === 'empty') {
    return 'ドロップされた内容にファイルがありませんでした';
  }
  return undefined;
}

/** 1枚の上限。 */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** 1回の送信に添えられる合計。 */
export const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
/** 1回の送信に添えられる枚数。 */
export const MAX_ATTACHMENTS = 5;

/**
 * データURLを添付にする。
 *
 * 受け付けられないものは理由を返す。**画面へ出すのは理由のほうで、黙って捨てない**
 * （貼ったのに何も起きない状態を作らないため）。
 */
export function parseDataUrl(
  id: string,
  name: string,
  dataUrl: string,
): { attachment: Attachment } | { reason: string } {
  const matched = /^data:([^;,]+);base64,(.*)$/su.exec(dataUrl);
  const mediaType = matched?.[1];
  const data = matched?.[2];
  if (mediaType === undefined || data === undefined || data === '') {
    return { reason: '画像として読み取れませんでした' };
  }
  if (!isSupported(mediaType)) {
    return { reason: `${mediaType} は送れません（png / jpeg / gif / webp のみ）` };
  }
  const bytes = base64Bytes(data);
  if (bytes > MAX_ATTACHMENT_BYTES) {
    return {
      reason: `1枚あたり ${formatSize(MAX_ATTACHMENT_BYTES)} までです（${formatSize(bytes)}）`,
    };
  }
  return { attachment: { id, name, mediaType, data, bytes } };
}

/** すでに添えているものへ足せるか。足せないなら理由を返す。 */
export function checkRoom(existing: readonly Attachment[], next: Attachment): string | undefined {
  if (existing.length >= MAX_ATTACHMENTS) {
    return `一度に送れるのは ${MAX_ATTACHMENTS} 枚までです`;
  }
  const total = existing.reduce((sum, a) => sum + a.bytes, 0) + next.bytes;
  if (total > MAX_TOTAL_BYTES) {
    return `合計 ${formatSize(MAX_TOTAL_BYTES)} までです（${formatSize(total)} になります）`;
  }
  return undefined;
}

/**
 * Codexの `turn/start` へ渡す `input`。
 *
 * `UserInput` はタグ付きunionで、画像はデータURLを `url` に入れる形が通る（実測）。
 * テキストは最後に置く。画像を見てから指示を読ませたいため。
 */
export function buildCodexInput(text: string, attachments: readonly Attachment[]): unknown[] {
  const input: unknown[] = attachments.map((a) => ({
    type: 'image',
    url: toDataUrl(a),
  }));
  input.push({ type: 'text', text });
  return input;
}

/**
 * Claude Codeの `user` メッセージへ渡す `content`。
 *
 * 画像ブロックは `{ type: 'image', source: { type: 'base64', media_type, data } }`（実測）。
 */
export function buildClaudeContent(text: string, attachments: readonly Attachment[]): unknown[] {
  const content: unknown[] = attachments.map((a) => ({
    type: 'image',
    source: { type: 'base64', media_type: a.mediaType, data: a.data },
  }));
  content.push({ type: 'text', text });
  return content;
}

/** 画面へ渡す形。base64そのものは重いので、サムネイル用のデータURLだけ作る。 */
export function toDataUrl(attachment: Attachment): string {
  return `data:${attachment.mediaType};base64,${attachment.data}`;
}

/** バイト数を読める形にする。 */
export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)}KB`;
  }
  return `${bytes}B`;
}

/** 画面へ渡す1件。base64はサムネイルの表示に要るのでデータURLで載せる。 */
export interface AttachmentView {
  id: string;
  name: string;
  /** `1.2MB` のような表示用の大きさ。 */
  size: string;
  dataUrl: string;
}

/**
 * 送信前の添付を1画面ぶん抱える。
 *
 * 上限の判定をここ1か所に置く。画面側にも同じ規則を書くと、片方だけ直したときに
 * 「サムネイルは出たのに送れない」状態になる。
 */
export class AttachmentBox {
  private items: Attachment[] = [];
  private nextId = 1;

  /** 受け付けられなければ理由を返す。 */
  add(name: string, dataUrl: string): { attachment: Attachment } | { reason: string } {
    const parsed = parseDataUrl(`att-${this.nextId}`, name, dataUrl);
    if ('reason' in parsed) {
      return parsed;
    }
    const full = checkRoom(this.items, parsed.attachment);
    if (full !== undefined) {
      return { reason: full };
    }
    this.nextId += 1;
    this.items = [...this.items, parsed.attachment];
    return parsed;
  }

  remove(id: string): void {
    this.items = this.items.filter((a) => a.id !== id);
  }

  clear(): void {
    this.items = [];
  }

  get list(): readonly Attachment[] {
    return this.items;
  }

  /** 送信用に取り出して空にする。送ったものが残り続けないようにする。 */
  take(): Attachment[] {
    const taken = this.items;
    this.items = [];
    return taken;
  }

  /** 送信に失敗したものを戻す。取り出したまま失わないようにする。 */
  restore(items: readonly Attachment[]): void {
    this.items = [...items, ...this.items];
  }

  snapshot(): AttachmentView[] {
    return this.items.map((a) => ({
      id: a.id,
      name: a.name,
      size: formatSize(a.bytes),
      dataUrl: toDataUrl(a),
    }));
  }
}

function isSupported(mediaType: string): boolean {
  return (SUPPORTED_MEDIA_TYPES as readonly string[]).includes(mediaType);
}

/** base64の長さから元のバイト数を出す。実データを持たずに大きさを測るため。 */
function base64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}
