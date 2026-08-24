import { describe, expect, it } from 'vitest';
import { CODE_TOKEN_TYPES, HIGHLIGHT_SOURCE } from '../../src/view/highlight';

/**
 * 構文強調のトークナイザ（issue #717）。実装はwebviewへ埋め込むJSソース1本だけで、
 * TypeScript版の写しを持たない（highlight.ts の冒頭に理由）。ここで文字列を評価して
 * 振る舞いを直接確かめる。
 */
type CodeToken = { type: string; value: string };

const highlightCode = new Function(`${HIGHLIGHT_SOURCE}\nreturn highlightCode;`)() as (
  lang: string,
  code: string,
) => CodeToken[];

/** 分類のうち、実際に出たものを並べる。 */
const typesOf = (tokens: CodeToken[]): string[] => tokens.map((t) => t.type);

/** 特定の分類になった文字列を取り出す。 */
const valuesOf = (tokens: CodeToken[], type: string): string[] =>
  tokens.filter((t) => t.type === type).map((t) => t.value);

const BACKSLASH = String.fromCharCode(92);

describe('HIGHLIGHT_SOURCE（webview埋め込み用ソース）', () => {
  it('構文として成立している', () => {
    expect(() => new Function(HIGHLIGHT_SOURCE)).not.toThrow();
  });

  it('テンプレートリテラルを壊す文字を含まない', () => {
    // chatScript.ts のテンプレートリテラルへ差し込むため、閉じる文字と展開の記法は書けない
    expect(HIGHLIGHT_SOURCE.includes(String.fromCharCode(96))).toBe(false);
    expect(HIGHLIGHT_SOURCE.includes(String.fromCharCode(36) + '{')).toBe(false);
  });
});

describe('highlightCode', () => {
  it('知らない言語は分類せずそのまま返す', () => {
    const tokens = highlightCode('brainfuck', 'const x = 1; // c');
    expect(tokens).toEqual([{ type: 'plain', value: 'const x = 1; // c' }]);
  });

  it('言語名が無いときも分類しない', () => {
    expect(highlightCode('', 'const x = 1;')).toEqual([{ type: 'plain', value: 'const x = 1;' }]);
  });

  it('空のコードでも壊れない', () => {
    expect(highlightCode('ts', '')).toEqual([{ type: 'plain', value: '' }]);
  });

  it('TypeScriptのキーワード・文字列・数値・コメントを分ける', () => {
    const tokens = highlightCode('ts', 'const n = 42; // メモ');
    expect(valuesOf(tokens, 'keyword')).toEqual(['const']);
    expect(valuesOf(tokens, 'number')).toEqual(['42']);
    expect(valuesOf(tokens, 'comment')).toEqual(['// メモ']);
  });

  it('ブロックコメントを閉じまで1つにまとめる', () => {
    const tokens = highlightCode('ts', 'a /* x\ny */ b');
    expect(valuesOf(tokens, 'comment')).toEqual(['/* x\ny */']);
  });

  it('閉じないブロックコメントは末尾まで飲み込む', () => {
    // ストリーミング途中でコードが欠けていても描画が壊れないこと
    const tokens = highlightCode('ts', 'a /* x');
    expect(valuesOf(tokens, 'comment')).toEqual(['/* x']);
  });

  it('エスケープした引用符で文字列を閉じない', () => {
    const code = 'const s = "a' + BACKSLASH + '"b";';
    expect(valuesOf(highlightCode('ts', code), 'string')).toEqual(['"a' + BACKSLASH + '"b"']);
  });

  it('閉じない文字列は行末で打ち切る', () => {
    // 打ち切らないと、以降のコード全部が文字列として着色される
    const tokens = highlightCode('ts', 'const s = "abc\nconst n = 1;');
    expect(valuesOf(tokens, 'string')).toEqual(['"abc']);
    expect(valuesOf(tokens, 'keyword')).toEqual(['const', 'const']);
  });

  it('Pythonの三重引用符をまたいで1つの文字列にする', () => {
    const q = String.fromCharCode(34).repeat(3);
    const tokens = highlightCode('python', 'x = ' + q + 'a\nb' + q + '\ndef f(): pass');
    expect(valuesOf(tokens, 'string')).toEqual([q + 'a\nb' + q]);
    expect(valuesOf(tokens, 'keyword')).toEqual(['def', 'pass']);
  });

  it('JSONの真偽値・null をキーワードとして扱う', () => {
    const tokens = highlightCode('json', '{"a": true, "b": null, "c": 1.5}');
    expect(valuesOf(tokens, 'keyword')).toEqual(['true', 'null']);
    expect(valuesOf(tokens, 'number')).toEqual(['1.5']);
  });

  it('言語名の揺れを吸収する', () => {
    // 既知の言語として扱われていれば分類が起きる（未知なら plain 1つで返る）
    expect(typesOf(highlightCode('TypeScript', 'const'))).toEqual(['keyword']);
    expect(typesOf(highlightCode('tsx', 'const'))).toEqual(['keyword']);
    expect(typesOf(highlightCode('JS', 'const'))).toEqual(['keyword']);
    expect(typesOf(highlightCode('zsh', 'done'))).toEqual(['keyword']);
    expect(typesOf(highlightCode('YML', 'true'))).toEqual(['keyword']);
    expect(typesOf(highlightCode('SCSS', '/* c */'))).toEqual(['comment']);
  });

  it('識別子の途中の数字を数値として切らない', () => {
    expect(typesOf(highlightCode('ts', 'value2'))).toEqual(['plain']);
  });

  it('prototype由来の名前をキーワードにしない', () => {
    // キーワード集合を素のオブジェクトで作ると constructor / toString が真になる
    for (const word of ['constructor', 'toString', 'hasOwnProperty']) {
      expect(typesOf(highlightCode('ts', word)), word).toEqual(['plain']);
    }
  });

  it('長すぎるコードは分類しない', () => {
    // ストリーミング中は本文が伸びるたびに描画し直すため、上限を超えたら素通しする
    const long = 'const x = 1;\n'.repeat(2000);
    expect(long.length).toBeGreaterThan(20000);
    expect(highlightCode('ts', long)).toEqual([{ type: 'plain', value: long }]);
  });

  it('分類した断片をつなぐと元のコードに戻る', () => {
    // コピー・エディタへ挿入が渡す文字列と、画面に出る文字列が食い違わないこと
    const samples: Array<[string, string]> = [
      ['ts', 'const s = "a b"; /* c */ let n = 0x1f; // 末尾'],
      ['python', 'def f(x):\n    # ここ\n    return {"k": 1}'],
      ['bash', 'if [ -n "$X" ]; then\n  echo 1 # メモ\nfi'],
      ['json', '{"a": [1, 2, {"b": false}]}'],
      ['yaml', 'key: value # メモ\nlist:\n  - 1\n  - true'],
      ['css', '.a { color: #fff; /* c */ width: 12px; }'],
    ];
    for (const [lang, code] of samples) {
      const joined = highlightCode(lang, code)
        .map((t) => t.value)
        .join('');
      expect(joined, lang + ' で元のコードに戻らない').toBe(code);
    }
  });

  it('地の文が連続したときは1つの断片にまとめる', () => {
    expect(highlightCode('ts', 'a b c')).toEqual([{ type: 'plain', value: 'a b c' }]);
  });

  it('返す分類は CODE_TOKEN_TYPES の中に収まる', () => {
    const tokens = highlightCode('ts', 'const s = "a"; // c\nlet n = 1;');
    for (const token of tokens) {
      expect(CODE_TOKEN_TYPES).toContain(token.type);
    }
  });
});
