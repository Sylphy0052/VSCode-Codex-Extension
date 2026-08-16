/**
 * チャット応答本文のMarkdown軽量パーサ（issue #290）。
 *
 * `vscode` に依存しない純粋関数として置き、`test/unit/markdown.test.ts` から直接
 * テストできるようにしている。外部ライブラリ（marked等）は使わない方針のため、
 * 見出し・箇条書き・強調・インラインコード・コードフェンス・リンクだけを扱う
 * 最小限のトークナイザとして書く。ネストした強調（太字の中の斜体等）は扱わない。
 *
 * 出力はテキストの集合（トークン列）であり、HTML文字列は一切組み立てない。
 * DOMへ入れる側（`chatScript.ts`）が各トークンをテキストノードとして差し込む前提
 * のため、ここでのHTMLエスケープ処理は不要（そもそもHTML文字列を作らない）。
 */

export type InlineToken =
  | { type: 'text'; value: string }
  | { type: 'bold'; value: string }
  | { type: 'italic'; value: string }
  | { type: 'code'; value: string }
  | { type: 'link'; value: string; url: string };

export type BlockToken =
  | { type: 'heading'; level: number; inline: InlineToken[] }
  | { type: 'paragraph'; lines: InlineToken[][] }
  | { type: 'list'; ordered: boolean; items: InlineToken[][] }
  | { type: 'codeblock'; lang: string; code: string; closed: boolean };

/**
 * 行内の強調・コード・リンクを拾う。
 *
 * 前方の選択肢から順に試すのが正規表現の交互(|)の評価順そのものなので、
 * `**太字**` を `*斜体*` より先に置く（先に置かないと `**x**` の最初の `*` が
 * 斜体側に食われる）。閉じ側が見つからない記法（ストリーミング中の未完な強調等）は
 * どの選択肢にもマッチしないため、そのまま地の文として残る＝描画は壊れない。
 */
const INLINE_RE =
  /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_/g;

export function parseInline(line: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let lastIndex = 0;
  INLINE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_RE.exec(line)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: 'text', value: line.slice(lastIndex, match.index) });
    }
    if (match[1] !== undefined) {
      tokens.push({ type: 'code', value: match[1] });
    } else if (match[2] !== undefined) {
      tokens.push({ type: 'link', value: match[2], url: match[3] ?? '' });
    } else if (match[4] !== undefined) {
      tokens.push({ type: 'bold', value: match[4] });
    } else if (match[5] !== undefined) {
      tokens.push({ type: 'bold', value: match[5] });
    } else if (match[6] !== undefined) {
      tokens.push({ type: 'italic', value: match[6] });
    } else if (match[7] !== undefined) {
      tokens.push({ type: 'italic', value: match[7] });
    }
    lastIndex = INLINE_RE.lastIndex;
  }
  if (lastIndex < line.length) {
    tokens.push({ type: 'text', value: line.slice(lastIndex) });
  }
  return tokens;
}

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})\s*(\S*)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const ORDERED_RE = /^\s{0,3}\d+\.\s+(.*)$/;
const UNORDERED_RE = /^\s{0,3}[-*+]\s+(.*)$/;

/**
 * テキストをブロックトークン列へ変換する。
 *
 * ストリーミング中の部分的な入力を毎回そのまま渡す前提（`renderBody` が現在の
 * 全文をそのつど渡す）。閉じていないコードフェンスは最後まで `codeblock`
 * （`closed: false`）として扱い、閉じるフェンスが届いたら次回の呼び出しで
 * `closed: true` になって描き直される。
 */
export function parseMarkdown(text: string): BlockToken[] {
  const lines = text.split('\n');
  const tokens: BlockToken[] = [];
  let paragraphBuf: string[] = [];
  let listBuf: { ordered: boolean; items: string[] } | undefined;

  const flushParagraph = (): void => {
    if (paragraphBuf.length > 0) {
      tokens.push({ type: 'paragraph', lines: paragraphBuf.map(parseInline) });
      paragraphBuf = [];
    }
  };
  const flushList = (): void => {
    if (listBuf !== undefined) {
      tokens.push({
        type: 'list',
        ordered: listBuf.ordered,
        items: listBuf.items.map(parseInline),
      });
      listBuf = undefined;
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';

    const fenceMatch = FENCE_OPEN_RE.exec(line);
    if (fenceMatch) {
      flushParagraph();
      flushList();
      const marker = fenceMatch[1] ?? '```';
      const fenceChar = marker.charAt(0);
      const fenceLen = marker.length;
      const lang = fenceMatch[2] ?? '';
      const codeLines: string[] = [];
      i += 1;
      let closed = false;
      while (i < lines.length) {
        const current = lines[i] ?? '';
        const closeMatch = new RegExp(`^ {0,3}([${fenceChar}]{${fenceLen},})\\s*$`).exec(current);
        if (closeMatch) {
          closed = true;
          i += 1;
          break;
        }
        codeLines.push(current);
        i += 1;
      }
      tokens.push({ type: 'codeblock', lang, code: codeLines.join('\n'), closed });
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      flushList();
      i += 1;
      continue;
    }

    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      flushParagraph();
      flushList();
      const hashes = headingMatch[1] ?? '#';
      tokens.push({
        type: 'heading',
        level: hashes.length,
        inline: parseInline((headingMatch[2] ?? '').trim()),
      });
      i += 1;
      continue;
    }

    const orderedMatch = ORDERED_RE.exec(line);
    const unorderedMatch = orderedMatch ? null : UNORDERED_RE.exec(line);
    if (orderedMatch || unorderedMatch) {
      flushParagraph();
      const ordered = orderedMatch !== null;
      const content = (orderedMatch ?? unorderedMatch)?.[1] ?? '';
      if (listBuf !== undefined && listBuf.ordered === ordered) {
        listBuf.items.push(content);
      } else {
        flushList();
        listBuf = { ordered, items: [content] };
      }
      i += 1;
      continue;
    }

    flushList();
    paragraphBuf.push(line);
    i += 1;
  }
  flushParagraph();
  flushList();
  return tokens;
}

/**
 * webviewへ埋め込む同等実装（issue #290）。
 *
 * webview側のスクリプトはテンプレートリテラルの中身で型検査もlintも効かないため、
 * `stateDelta.ts` の `MERGE_ITEMS_SOURCE` と同じ流儀で、ソースをここに文字列として
 * 持ち `chatScript.ts` から差し込む。実装をここ1か所に書いて両側へコピーしないと
 * 片方だけ直したときに黙ってずれるが、テンプレートリテラルの中はTypeScriptとして
 * 実行できないため、上のTS実装とは別に同じロジックをJSソースとして持つほかない。
 * `test/unit/markdown.test.ts` がこの文字列を評価し、上のTS実装と同じ入力に対して
 * 同じ結果になることを確かめている（乖離の検知）。
 */
export const MARKDOWN_PARSE_SOURCE = `
  // chatScript.ts の出力（webviewへ渡すJSソース全体）にバッククォート文字そのものを
  // 直接書かないための迂回。chatScript.ts側に「テンプレートリテラルを閉じる文字が
  // 混ざっていない」ことを機械的に確かめるテストがあり（webviewScript.test.ts）、
  // このソース文字列もその対象に含まれる。コードフェンス・インラインコードの記法自体が
  // バッククォートを使うため、文字コードから作った変数越しに扱う。
  var BACKTICK = String.fromCharCode(96);
  var INLINE_RE = new RegExp(
    BACKTICK + '([^' + BACKTICK + ']+)' + BACKTICK +
      '|\\\\[([^\\\\]]+)\\\\]\\\\(([^)\\\\s]+)\\\\)' +
      '|\\\\*\\\\*([^*]+)\\\\*\\\\*' +
      '|__([^_]+)__' +
      '|\\\\*([^*]+)\\\\*' +
      '|_([^_]+)_',
    'g',
  );

  function parseInline(line) {
    var tokens = [];
    var lastIndex = 0;
    INLINE_RE.lastIndex = 0;
    var match;
    while ((match = INLINE_RE.exec(line)) !== null) {
      if (match.index > lastIndex) {
        tokens.push({ type: 'text', value: line.slice(lastIndex, match.index) });
      }
      if (match[1] !== undefined) {
        tokens.push({ type: 'code', value: match[1] });
      } else if (match[2] !== undefined) {
        tokens.push({ type: 'link', value: match[2], url: match[3] || '' });
      } else if (match[4] !== undefined) {
        tokens.push({ type: 'bold', value: match[4] });
      } else if (match[5] !== undefined) {
        tokens.push({ type: 'bold', value: match[5] });
      } else if (match[6] !== undefined) {
        tokens.push({ type: 'italic', value: match[6] });
      } else if (match[7] !== undefined) {
        tokens.push({ type: 'italic', value: match[7] });
      }
      lastIndex = INLINE_RE.lastIndex;
    }
    if (lastIndex < line.length) {
      tokens.push({ type: 'text', value: line.slice(lastIndex) });
    }
    return tokens;
  }

  var FENCE_OPEN_RE = new RegExp('^ {0,3}(' + BACKTICK + '{3,}|~{3,})\\\\s*(\\\\S*)\\\\s*$');
  var HEADING_RE = /^(#{1,6})\\s+(.*)$/;
  var ORDERED_RE = /^\\s{0,3}\\d+\\.\\s+(.*)$/;
  var UNORDERED_RE = /^\\s{0,3}[-*+]\\s+(.*)$/;

  function parseMarkdown(text) {
    var lines = text.split('\\n');
    var tokens = [];
    var paragraphBuf = [];
    var listBuf;

    function flushParagraph() {
      if (paragraphBuf.length > 0) {
        tokens.push({ type: 'paragraph', lines: paragraphBuf.map(parseInline) });
        paragraphBuf = [];
      }
    }
    function flushList() {
      if (listBuf !== undefined) {
        tokens.push({ type: 'list', ordered: listBuf.ordered, items: listBuf.items.map(parseInline) });
        listBuf = undefined;
      }
    }

    var i = 0;
    while (i < lines.length) {
      var line = lines[i] || '';

      var fenceMatch = FENCE_OPEN_RE.exec(line);
      if (fenceMatch) {
        flushParagraph();
        flushList();
        var marker = fenceMatch[1] || BACKTICK + BACKTICK + BACKTICK;
        var fenceChar = marker.charAt(0);
        var fenceLen = marker.length;
        var lang = fenceMatch[2] || '';
        var codeLines = [];
        i += 1;
        var closed = false;
        while (i < lines.length) {
          var current = lines[i] || '';
          var closeMatch = new RegExp('^ {0,3}([' + fenceChar + ']{' + fenceLen + ',})\\\\s*$').exec(current);
          if (closeMatch) {
            closed = true;
            i += 1;
            break;
          }
          codeLines.push(current);
          i += 1;
        }
        tokens.push({ type: 'codeblock', lang: lang, code: codeLines.join('\\n'), closed: closed });
        continue;
      }

      if (line.trim() === '') {
        flushParagraph();
        flushList();
        i += 1;
        continue;
      }

      var headingMatch = HEADING_RE.exec(line);
      if (headingMatch) {
        flushParagraph();
        flushList();
        var hashes = headingMatch[1] || '#';
        tokens.push({ type: 'heading', level: hashes.length, inline: parseInline((headingMatch[2] || '').trim()) });
        i += 1;
        continue;
      }

      var orderedMatch = ORDERED_RE.exec(line);
      var unorderedMatch = orderedMatch ? null : UNORDERED_RE.exec(line);
      if (orderedMatch || unorderedMatch) {
        flushParagraph();
        var ordered = orderedMatch !== null;
        var picked = orderedMatch || unorderedMatch;
        var content = (picked && picked[1]) || '';
        if (listBuf !== undefined && listBuf.ordered === ordered) {
          listBuf.items.push(content);
        } else {
          flushList();
          listBuf = { ordered: ordered, items: [content] };
        }
        i += 1;
        continue;
      }

      flushList();
      paragraphBuf.push(line);
      i += 1;
    }
    flushParagraph();
    flushList();
    return tokens;
  }
`;
