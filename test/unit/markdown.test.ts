import { describe, expect, it } from 'vitest';
import { MARKDOWN_PARSE_SOURCE, parseInline, parseMarkdown } from '../../src/view/markdown';

describe('parseInline', () => {
  it('地の文だけならtextトークン1つになる', () => {
    expect(parseInline('こんにちは')).toEqual([{ type: 'text', value: 'こんにちは' }]);
  });

  it('太字（**）を拾う', () => {
    expect(parseInline('これは**重要**です')).toEqual([
      { type: 'text', value: 'これは' },
      { type: 'bold', value: '重要' },
      { type: 'text', value: 'です' },
    ]);
  });

  it('太字（__）を拾う', () => {
    expect(parseInline('__重要__')).toEqual([{ type: 'bold', value: '重要' }]);
  });

  it('斜体（*）を拾う', () => {
    expect(parseInline('*強調*')).toEqual([{ type: 'italic', value: '強調' }]);
  });

  it('斜体（_）を拾う', () => {
    expect(parseInline('_強調_')).toEqual([{ type: 'italic', value: '強調' }]);
  });

  it('インラインコードを拾う', () => {
    expect(parseInline('`const x = 1`を実行')).toEqual([
      { type: 'code', value: 'const x = 1' },
      { type: 'text', value: 'を実行' },
    ]);
  });

  it('リンクを拾う', () => {
    expect(parseInline('[docs](https://example.com/a)を見る')).toEqual([
      { type: 'link', value: 'docs', url: 'https://example.com/a' },
      { type: 'text', value: 'を見る' },
    ]);
  });

  it('閉じていない太字は地の文のまま残る（ストリーミング途中でも壊れない）', () => {
    expect(parseInline('これは**まだ閉じていない強調')).toEqual([
      { type: 'text', value: 'これは**まだ閉じていない強調' },
    ]);
  });

  it('閉じていないインラインコードは地の文のまま残る', () => {
    expect(parseInline('途中で切れた`コード')).toEqual([
      { type: 'text', value: '途中で切れた`コード' },
    ]);
  });

  it('HTMLに見える文字列をタグとして解釈せずそのままtextトークンへ残す', () => {
    expect(parseInline('<img src=x onerror="alert(1)">')).toEqual([
      { type: 'text', value: '<img src=x onerror="alert(1)">' },
    ]);
  });
});

describe('parseMarkdown（ブロック）', () => {
  it('見出しをレベル別に拾う', () => {
    expect(parseMarkdown('# 大見出し\n## 中見出し')).toEqual([
      { type: 'heading', level: 1, inline: [{ type: 'text', value: '大見出し' }] },
      { type: 'heading', level: 2, inline: [{ type: 'text', value: '中見出し' }] },
    ]);
  });

  it('箇条書き（-）をひとつのlistトークンへまとめる', () => {
    expect(parseMarkdown('- 1つ目\n- 2つ目')).toEqual([
      {
        type: 'list',
        ordered: false,
        items: [[{ type: 'text', value: '1つ目' }], [{ type: 'text', value: '2つ目' }]],
      },
    ]);
  });

  it('番号付き箇条書きをordered: trueで拾う', () => {
    const result = parseMarkdown('1. 1つ目\n2. 2つ目');
    expect(result).toEqual([
      {
        type: 'list',
        ordered: true,
        items: [[{ type: 'text', value: '1つ目' }], [{ type: 'text', value: '2つ目' }]],
      },
    ]);
  });

  it('段落は行ごとのinlineトークン配列を保つ（改行を保存する）', () => {
    expect(parseMarkdown('1行目\n2行目')).toEqual([
      {
        type: 'paragraph',
        lines: [[{ type: 'text', value: '1行目' }], [{ type: 'text', value: '2行目' }]],
      },
    ]);
  });

  it('空行で段落が区切られる', () => {
    const result = parseMarkdown('段落A\n\n段落B');
    expect(result).toEqual([
      { type: 'paragraph', lines: [[{ type: 'text', value: '段落A' }]] },
      { type: 'paragraph', lines: [[{ type: 'text', value: '段落B' }]] },
    ]);
  });

  it('閉じたコードフェンスをclosed: trueで拾う', () => {
    expect(parseMarkdown('```ts\nconst x = 1;\n```')).toEqual([
      { type: 'codeblock', lang: 'ts', code: 'const x = 1;', closed: true },
    ]);
  });

  it('言語指定の無いコードフェンスはlangが空文字になる', () => {
    expect(parseMarkdown('```\nplain\n```')).toEqual([
      { type: 'codeblock', lang: '', code: 'plain', closed: true },
    ]);
  });

  it('閉じていないコードフェンスはclosed: falseのまま最後まで取り込む（ストリーミング中）', () => {
    expect(parseMarkdown('```ts\nconst x = 1;\nconst y')).toEqual([
      { type: 'codeblock', lang: 'ts', code: 'const x = 1;\nconst y', closed: false },
    ]);
  });

  it('コードフェンスの中身はMarkdownとして解釈されない（見出し記号もそのまま）', () => {
    expect(parseMarkdown('```\n# not a heading\n- not a list\n```')).toEqual([
      { type: 'codeblock', lang: '', code: '# not a heading\n- not a list', closed: true },
    ]);
  });

  it('見出し・段落・コードブロックが混在しても順番どおりに拾う', () => {
    const result = parseMarkdown('# タイトル\n本文です\n```js\nconsole.log(1)\n```\n- 箇条書き');
    expect(result).toEqual([
      { type: 'heading', level: 1, inline: [{ type: 'text', value: 'タイトル' }] },
      { type: 'paragraph', lines: [[{ type: 'text', value: '本文です' }]] },
      { type: 'codeblock', lang: 'js', code: 'console.log(1)', closed: true },
      { type: 'list', ordered: false, items: [[{ type: 'text', value: '箇条書き' }]] },
    ]);
  });

  it('HTMLに見える文字列がブロック側でもそのままtextトークンに残る', () => {
    const result = parseMarkdown('<script>alert(1)</script>');
    expect(result).toEqual([
      {
        type: 'paragraph',
        lines: [[{ type: 'text', value: '<script>alert(1)</script>' }]],
      },
    ]);
  });

  it('空文字列は空のトークン列になる', () => {
    expect(parseMarkdown('')).toEqual([]);
  });
});

/**
 * webviewへ埋め込むJSソース（`MARKDOWN_PARSE_SOURCE`）が、上のTS実装
 * （`parseMarkdown`/`parseInline`）と同じ結果を返すことを確かめる。
 * テンプレートリテラルの中はTypeScriptとして実行できないため実装を2重に持たざるを
 * 得ないが（`stateDelta.ts`の`MERGE_ITEMS_SOURCE`と同じ事情）、ここで乖離を検知する。
 */
const evalSource = new Function(
  `${MARKDOWN_PARSE_SOURCE}\nreturn { parseMarkdown: parseMarkdown, parseInline: parseInline };`,
)() as {
  parseMarkdown: (text: string) => unknown;
  parseInline: (line: string) => unknown;
};

describe('MARKDOWN_PARSE_SOURCE（webview埋め込み用ソース）', () => {
  it('構文として成立している', () => {
    expect(() => new Function(MARKDOWN_PARSE_SOURCE)).not.toThrow();
  });

  const fixtures = [
    '# 見出し\n本文\n\n- 箇条書き1\n- 箇条書き2\n\n```ts\nconst x = 1;\n```\n[link](https://example.com)',
    'これは**太字**と*斜体*と`code`です',
    '```\n閉じていないフェンス',
    '<img src=x onerror="alert(1)">',
    '1. 番号1\n2. 番号2',
  ];

  for (const fixture of fixtures) {
    it(`TS実装と同じ結果になる: ${JSON.stringify(fixture.slice(0, 20))}...`, () => {
      expect(evalSource.parseMarkdown(fixture)).toEqual(parseMarkdown(fixture));
    });
  }

  it('parseInline単体でもTS実装と同じ結果になる', () => {
    expect(evalSource.parseInline('**太字**と`code`と[link](https://example.com)')).toEqual(
      parseInline('**太字**と`code`と[link](https://example.com)'),
    );
  });
});
