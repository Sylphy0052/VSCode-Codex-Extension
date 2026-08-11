import { describe, expect, it } from 'vitest';
import { normalizeItem } from '../../src/appserver/chatState';
import {
  isDataImageUrl,
  mediaTypeForPath,
  readClaudeResultImages,
  readUserInputImages,
} from '../../src/provider/imageRefs';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

describe('isDataImageUrl', () => {
  it('画像のデータURLだけ通す', () => {
    expect(isDataImageUrl(PNG)).toBe(true);
    expect(isDataImageUrl('data:image/webp;base64,AAAA')).toBe(true);
  });

  it('表示できないURLは通さない', () => {
    // CSPが img-src data: しか許さないため、http は読み込まれずに黙って欠ける
    expect(isDataImageUrl('https://example.com/a.png')).toBe(false);
    expect(isDataImageUrl('data:text/plain;base64,AAAA')).toBe(false);
    expect(isDataImageUrl('')).toBe(false);
  });
});

describe('mediaTypeForPath', () => {
  it('拡張子から種類を決める', () => {
    expect(mediaTypeForPath('/tmp/a.png')).toBe('image/png');
    expect(mediaTypeForPath('/tmp/a.JPG')).toBe('image/jpeg');
    expect(mediaTypeForPath('/tmp/a.jpeg')).toBe('image/jpeg');
    expect(mediaTypeForPath('/tmp/a.gif')).toBe('image/gif');
    expect(mediaTypeForPath('/tmp/a.webp')).toBe('image/webp');
  });

  it('対応しない拡張子では何も返さない', () => {
    expect(mediaTypeForPath('/tmp/a.svg')).toBeUndefined();
    expect(mediaTypeForPath('/tmp/a')).toBeUndefined();
  });
});

describe('readUserInputImages', () => {
  it('データURLの画像を取り出す（実測した userMessage の形）', () => {
    const images = readUserInputImages([
      { type: 'image', detail: null, url: PNG },
      { type: 'text', text: 'これは何色', text_elements: [] },
    ]);
    expect(images).toEqual([{ dataUrl: PNG, path: undefined, alt: '送った画像' }]);
  });

  it('パス指定の画像はパスとして持つ', () => {
    expect(readUserInputImages([{ type: 'localImage', path: '/tmp/a.png' }])).toEqual([
      { dataUrl: undefined, path: '/tmp/a.png', alt: '/tmp/a.png' },
    ]);
  });

  it('表示できないURLは読み込ませずに断る', () => {
    expect(readUserInputImages([{ type: 'image', url: 'https://example.com/a.png' }])).toEqual([
      { dataUrl: undefined, path: undefined, alt: '表示できない画像 (https://example.com/a.png)' },
    ]);
  });

  it('画像が無ければ空', () => {
    expect(readUserInputImages([{ type: 'text', text: 'やあ' }])).toEqual([]);
    expect(readUserInputImages(undefined)).toEqual([]);
  });
});

describe('normalizeItem / 画像', () => {
  it('userMessage の画像を項目に持たせる', () => {
    const item = normalizeItem({
      id: 'u1',
      type: 'userMessage',
      content: [
        { type: 'image', url: PNG },
        { type: 'text', text: 'これは何色' },
      ],
    });
    expect(item?.text).toBe('これは何色');
    expect(item?.images).toEqual([{ dataUrl: PNG, path: undefined, alt: '送った画像' }]);
  });

  it('imageView をパスの画像にする', () => {
    const item = normalizeItem({ id: 'v1', type: 'imageView', path: '/tmp/shot.png' });
    expect(item?.kind).toBe('imageView');
    expect(item?.detail).toBe('/tmp/shot.png');
    expect(item?.images).toEqual([
      { dataUrl: undefined, path: '/tmp/shot.png', alt: '/tmp/shot.png' },
    ]);
  });

  it('imageGeneration の保存先を画像にする', () => {
    const item = normalizeItem({
      id: 'g1',
      type: 'imageGeneration',
      status: 'completed',
      result: 'ok',
      savedPath: '/tmp/out.png',
      revisedPrompt: '青い猫',
    });
    expect(item?.detail).toBe('青い猫');
    expect(item?.status).toBe('completed');
    expect(item?.images).toEqual([
      { dataUrl: undefined, path: '/tmp/out.png', alt: '生成した画像' },
    ]);
  });

  it('生成に失敗した場合は画像を持たない', () => {
    const item = normalizeItem({
      id: 'g2',
      type: 'imageGeneration',
      status: 'failed',
      result: 'Image generation failed',
    });
    expect(item?.images).toEqual([]);
    expect(item?.text).toBe('Image generation failed');
  });

  it('画像を持たない項目では空のまま', () => {
    const item = normalizeItem({ id: 'a1', type: 'agentMessage', text: 'やあ' });
    expect(item?.images).toEqual([]);
  });
});

describe('readClaudeResultImages', () => {
  it('tool_result の base64 画像をデータURLにする（実測した形）', () => {
    const images = readClaudeResultImages([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0K' } },
      { type: 'text', text: '読みました' },
    ]);
    expect(images).toEqual([
      { dataUrl: 'data:image/png;base64,iVBORw0K', path: undefined, alt: 'ツールが読んだ画像' },
    ]);
  });

  it('対応しない形式や壊れた中身は捨てる', () => {
    expect(
      readClaudeResultImages([
        { type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: 'x' } },
        { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
        { type: 'image' },
      ]),
    ).toEqual([]);
  });

  it('文字列の結果では空', () => {
    expect(readClaudeResultImages('ただのテキスト')).toEqual([]);
  });
});
