import { describe, expect, it } from 'vitest';
import {
  AttachmentBox,
  buildClaudeContent,
  buildCodexInput,
  checkRoom,
  dropRejectionReason,
  formatSize,
  MAX_ATTACHMENTS,
  parseDataUrl,
  toDataUrl,
  type Attachment,
} from '../../src/provider/attachments';

/** base64は4文字で3バイト。長さから大きさを作る。 */
const base64Of = (bytes: number): string => 'A'.repeat(Math.ceil(bytes / 3) * 4);
const pngUrl = (bytes = 300): string => `data:image/png;base64,${base64Of(bytes)}`;

const attachment = (id: string, bytes: number): Attachment => ({
  id,
  name: `${id}.png`,
  mediaType: 'image/png',
  data: base64Of(bytes),
  bytes,
});

describe('parseDataUrl', () => {
  it('データURLから形式と中身を取り出す', () => {
    const parsed = parseDataUrl('a1', 'shot.png', 'data:image/png;base64,QUJD');
    expect(parsed).toEqual({
      attachment: { id: 'a1', name: 'shot.png', mediaType: 'image/png', data: 'QUJD', bytes: 3 },
    });
  });

  it('パディングを引いて大きさを出す', () => {
    // "QQ==" は1バイト
    expect(parseDataUrl('a1', 'x.png', 'data:image/png;base64,QQ==')).toMatchObject({
      attachment: { bytes: 1 },
    });
  });

  it('対応しない形式は理由を返す', () => {
    const parsed = parseDataUrl('a1', 'x.svg', 'data:image/svg+xml;base64,QUJD');
    expect(parsed).toMatchObject({ reason: expect.stringContaining('image/svg+xml') });
  });

  it('データURLでないものは理由を返す', () => {
    expect(parseDataUrl('a1', 'x', 'なにか')).toMatchObject({ reason: expect.any(String) });
    expect(parseDataUrl('a1', 'x', 'data:image/png;base64,')).toMatchObject({
      reason: expect.any(String),
    });
  });

  it('1枚の上限を超えたら理由を返す', () => {
    const parsed = parseDataUrl('a1', 'big.png', pngUrl(6 * 1024 * 1024));
    expect(parsed).toMatchObject({ reason: expect.stringContaining('1枚あたり') });
  });
});

describe('checkRoom', () => {
  it('枚数の上限を超えたら理由を返す', () => {
    const existing = Array.from({ length: MAX_ATTACHMENTS }, (_, i) => attachment(`a${i}`, 10));
    expect(checkRoom(existing, attachment('next', 10))).toContain(`${MAX_ATTACHMENTS} 枚`);
  });

  it('合計の上限を超えたら理由を返す', () => {
    const existing = [attachment('a1', 5 * 1024 * 1024), attachment('a2', 4 * 1024 * 1024)];
    expect(checkRoom(existing, attachment('a3', 2 * 1024 * 1024))).toContain('合計');
  });

  it('収まるなら何も返さない', () => {
    expect(checkRoom([attachment('a1', 100)], attachment('a2', 100))).toBeUndefined();
  });
});

describe('buildCodexInput', () => {
  it('画像をデータURLで載せ、本文を最後に置く', () => {
    // 画像を見てから指示を読ませたいので、テキストは末尾
    expect(buildCodexInput('これ直して', [attachment('a1', 3)])).toEqual([
      { type: 'image', url: `data:image/png;base64,${base64Of(3)}` },
      { type: 'text', text: 'これ直して' },
    ]);
  });

  it('添付が無ければテキストだけになる', () => {
    expect(buildCodexInput('やって', [])).toEqual([{ type: 'text', text: 'やって' }]);
  });
});

describe('buildClaudeContent', () => {
  it('base64の画像ブロックにする', () => {
    expect(buildClaudeContent('これ直して', [attachment('a1', 3)])).toEqual([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: base64Of(3) },
      },
      { type: 'text', text: 'これ直して' },
    ]);
  });

  it('添付が無ければテキストだけになる', () => {
    expect(buildClaudeContent('やって', [])).toEqual([{ type: 'text', text: 'やって' }]);
  });
});

describe('toDataUrl / formatSize', () => {
  it('データURLへ戻せる', () => {
    expect(toDataUrl(attachment('a1', 3))).toBe(`data:image/png;base64,${base64Of(3)}`);
  });

  it('大きさを読める形にする', () => {
    expect(formatSize(500)).toBe('500B');
    expect(formatSize(2048)).toBe('2KB');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0MB');
  });
});

describe('AttachmentBox', () => {
  it('足すとidが振られ、一覧に並ぶ', () => {
    const box = new AttachmentBox();
    box.add('one.png', pngUrl(30));
    box.add('two.png', pngUrl(30));
    expect(box.snapshot().map((a) => a.name)).toEqual(['one.png', 'two.png']);
    expect(new Set(box.snapshot().map((a) => a.id)).size).toBe(2);
  });

  it('受け付けられないものは足さずに理由を返す', () => {
    const box = new AttachmentBox();
    expect(box.add('x.svg', 'data:image/svg+xml;base64,QUJD')).toMatchObject({
      reason: expect.any(String),
    });
    expect(box.list).toHaveLength(0);
  });

  it('上限を超えたものは足さない', () => {
    const box = new AttachmentBox();
    for (let i = 0; i < MAX_ATTACHMENTS; i += 1) {
      box.add(`${i}.png`, pngUrl(30));
    }
    expect(box.add('over.png', pngUrl(30))).toMatchObject({ reason: expect.any(String) });
    expect(box.list).toHaveLength(MAX_ATTACHMENTS);
  });

  it('idで取り消せる', () => {
    const box = new AttachmentBox();
    box.add('one.png', pngUrl(30));
    box.add('two.png', pngUrl(30));
    const [first] = box.snapshot();
    box.remove(first?.id ?? '');
    expect(box.snapshot().map((a) => a.name)).toEqual(['two.png']);
  });

  it('取り出すと空になる', () => {
    const box = new AttachmentBox();
    box.add('one.png', pngUrl(30));
    expect(box.take()).toHaveLength(1);
    expect(box.list).toHaveLength(0);
  });

  it('送信に失敗したものを戻せる', () => {
    // 取り出したまま失うと、貼り直しを強いることになる
    const box = new AttachmentBox();
    box.add('one.png', pngUrl(30));
    const taken = box.take();
    box.restore(taken);
    expect(box.snapshot().map((a) => a.name)).toEqual(['one.png']);
  });

  it('サムネイル用のデータURLと大きさを渡す', () => {
    const box = new AttachmentBox();
    box.add('one.png', pngUrl(30));
    expect(box.snapshot()[0]).toMatchObject({
      name: 'one.png',
      size: '30B',
      dataUrl: expect.stringContaining('data:image/png;base64,'),
    });
  });
});

describe('dropRejectionReason', () => {
  it('画像が1枚も無かったドロップの理由を返す', () => {
    expect(dropRejectionReason('notImage')).toBe('ドロップされたファイルに画像がありませんでした');
    expect(dropRejectionReason('empty')).toBe('ドロップされた内容にファイルがありませんでした');
  });

  it('VS Code内からのドラッグは対応していないことを理由に出す', () => {
    // ホストは会話に出てきたパスしか読まない（imageRefs.ts）。パスだけが載ったドロップは
    // 受け取れないため、代わりの経路を案内する
    expect(dropRejectionReason('pathOnly')).toBe(
      'VS Code内からのドラッグには対応していません。「画像」ボタンかCtrl+Vで添えてください',
    );
  });

  it('知らない種類では何も出さない', () => {
    // Webviewからの値は信用しない。想定外は黙って捨て、通知の文言を作らせない
    expect(dropRejectionReason('other')).toBeUndefined();
    expect(dropRejectionReason(undefined)).toBeUndefined();
    expect(dropRejectionReason(42)).toBeUndefined();
  });
});
