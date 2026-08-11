import { describe, expect, it } from 'vitest';
import type { ChatItem } from '../../src/appserver/chatState';
import { MAX_IMAGE_BYTES, buildImageReply } from '../../src/provider/imageRefs';

const item = (images: ChatItem['images']): ChatItem => ({
  id: 'i1',
  kind: 'imageView',
  text: '',
  detail: '',
  status: undefined,
  turnId: undefined,
  diffs: [],
  images,
});

const items = [
  item([{ dataUrl: undefined, path: '/tmp/shot.png', alt: '/tmp/shot.png' }]),
  item([{ dataUrl: 'data:image/png;base64,AAAA', path: undefined, alt: '送った画像' }]),
];

const readable = async (filePath: string, maxBytes: number): Promise<string | undefined> =>
  filePath === '/tmp/shot.png' && maxBytes === MAX_IMAGE_BYTES ? 'QUJD' : undefined;

describe('buildImageReply', () => {
  it('会話に出てきたパスを読んでデータURLにする', async () => {
    expect(await buildImageReply(items, '/tmp/shot.png', readable)).toEqual({
      path: '/tmp/shot.png',
      dataUrl: 'data:image/png;base64,QUJD',
      error: undefined,
    });
  });

  it('会話に無いパスは読まない', async () => {
    // Webviewからの要求で任意のファイルを読めるようにしない
    expect(await buildImageReply(items, '/etc/passwd', readable)).toBeUndefined();
    expect(await buildImageReply(items, '', readable)).toBeUndefined();
  });

  it('対応しない拡張子は読まずに理由を返す', async () => {
    const withSvg = [item([{ dataUrl: undefined, path: '/tmp/a.svg', alt: '/tmp/a.svg' }])];
    expect(await buildImageReply(withSvg, '/tmp/a.svg', readable)).toEqual({
      path: '/tmp/a.svg',
      dataUrl: undefined,
      error: '対応しない形式です',
    });
  });

  it('読めなければ理由を返す（黙って欠けさせない）', async () => {
    const missing = [item([{ dataUrl: undefined, path: '/tmp/gone.png', alt: '/tmp/gone.png' }])];
    expect(await buildImageReply(missing, '/tmp/gone.png', readable)).toEqual({
      path: '/tmp/gone.png',
      dataUrl: undefined,
      error: '画像を読み込めませんでした',
    });
  });
});
