/**
 * チャット応答本文のMarkdown軽量パーサ（issue #290、拡張issue #332）。
 *
 * `vscode` に依存しない純粋関数として置き、`test/unit/markdown.test.ts` から直接
 * テストできるようにしている。外部ライブラリ（marked等）は使わない方針のため、
 * 見出し・箇条書き（ネスト・タスクリスト付き）・表・引用・水平線・強調・打消し線・
 * インラインコード・コードフェンス・リンクだけを扱う軽量なトークナイザとして書く。
 * ネストした強調（太字の中の斜体等）は扱わない。
 *
 * 出力はテキストの集合（トークン列）であり、HTML文字列は一切組み立てない。
 * DOMへ入れる側（`chatScript.ts`）が各トークンをテキストノードとして差し込む前提
 * のため、ここでのHTMLエスケープ処理は不要（そもそもHTML文字列を作らない）。
 */

export type InlineToken =
  | { type: 'text'; value: string }
  | { type: 'bold'; value: string }
  | { type: 'italic'; value: string }
  | { type: 'strike'; value: string }
  | { type: 'code'; value: string }
  | { type: 'link'; value: string; url: string };

export type TableAlign = 'left' | 'center' | 'right' | undefined;

/**
 * 箇条書きの1項目。`depth`はネストの階層（0始まり）、`checked`はタスクリスト
 * （`- [ ]`/`- [x]`）のときだけ持つ（通常項目では省略する）。
 */
export type ListItem = {
  inline: InlineToken[];
  depth: number;
  checked?: boolean;
};

export type BlockToken =
  | { type: 'heading'; level: number; inline: InlineToken[] }
  | { type: 'paragraph'; lines: InlineToken[][] }
  | { type: 'list'; ordered: boolean; items: ListItem[] }
  | { type: 'codeblock'; lang: string; code: string; closed: boolean }
  | { type: 'table'; align: TableAlign[]; header: InlineToken[][]; rows: InlineToken[][][] }
  | { type: 'quote'; lines: InlineToken[][] }
  | { type: 'hr' };

/**
 * 行内の強調・打消し線・コード・リンクを拾う。
 *
 * 前方の選択肢から順に試すのが正規表現の交互(|)の評価順そのものなので、
 * `**太字**` を `*斜体*` より先に置く（先に置かないと `**x**` の最初の `*` が
 * 斜体側に食われる）。閉じ側が見つからない記法（ストリーミング中の未完な強調等）は
 * どの選択肢にもマッチしないため、そのまま地の文として残る＝描画は壊れない。
 */
const INLINE_RE =
  /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|~~([^~]+)~~|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_/g;

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
      tokens.push({ type: 'strike', value: match[4] });
    } else if (match[5] !== undefined) {
      tokens.push({ type: 'bold', value: match[5] });
    } else if (match[6] !== undefined) {
      tokens.push({ type: 'bold', value: match[6] });
    } else if (match[7] !== undefined) {
      tokens.push({ type: 'italic', value: match[7] });
    } else if (match[8] !== undefined) {
      tokens.push({ type: 'italic', value: match[8] });
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
const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const ORDERED_RE = /^( *)\d+\.\s+(.*)$/;
const UNORDERED_RE = /^( *)[-*+]\s+(.*)$/;
const TASK_RE = /^\[([ xX])\]\s+(.*)$/;
const QUOTE_RE = /^ {0,3}>[ \t]?(.*)$/;
const TABLE_DELIM_CELL_RE = /^:?-+:?$/;

/** `| a | b |` のような1行をセル文字列の配列へ割る。エスケープされたパイプ（`\|`）は非対応。 */
function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) {
    trimmed = trimmed.slice(1);
  }
  if (trimmed.endsWith('|')) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed.split('|').map((cell) => cell.trim());
}

/** ヘッダの次行が表の区切り行（`---`や`:--:`等のセルだけの行）かどうかを判定し、列ごとの寄せを返す。 */
function parseTableAlignRow(line: string): TableAlign[] | undefined {
  if (!line.includes('-') || !line.includes('|')) {
    if (!TABLE_DELIM_CELL_RE.test(line.trim())) {
      return undefined;
    }
  }
  const cells = splitTableRow(line);
  if (cells.length === 0) {
    return undefined;
  }
  const aligns: TableAlign[] = [];
  for (const cell of cells) {
    if (!TABLE_DELIM_CELL_RE.test(cell)) {
      return undefined;
    }
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : undefined);
  }
  return aligns;
}

type ListBufferItem = { content: string; depth: number; checked: boolean | undefined };
type ListBuffer = { ordered: boolean; items: ListBufferItem[]; prevDepth: number };

/**
 * テキストをブロックトークン列へ変換する。
 *
 * ストリーミング中の部分的な入力を毎回そのまま渡す前提（`renderBody` が現在の
 * 全文をそのつど渡す）。閉じていないコードフェンスは最後まで `codeblock`
 * （`closed: false`）として扱い、閉じるフェンスが届いたら次回の呼び出しで
 * `closed: true` になって描き直される。表・引用・水平線・ネストしたリストも同様に、
 * 閉じ側や継続行が揃うまでは通常の段落・箇条書きとして扱われ、例外を投げたり
 * トークン列が壊れたりしない。
 */
export function parseMarkdown(text: string): BlockToken[] {
  const lines = text.split('\n');
  const tokens: BlockToken[] = [];
  let paragraphBuf: string[] = [];
  let listBuf: ListBuffer | undefined;

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
        items: listBuf.items.map((item) => ({
          inline: parseInline(item.content),
          depth: item.depth,
          ...(item.checked !== undefined ? { checked: item.checked } : {}),
        })),
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

    if (HR_RE.test(line)) {
      flushParagraph();
      flushList();
      tokens.push({ type: 'hr' });
      i += 1;
      continue;
    }

    if (line.includes('|')) {
      const nextLine = lines[i + 1];
      const align = nextLine !== undefined ? parseTableAlignRow(nextLine) : undefined;
      if (align !== undefined) {
        flushParagraph();
        flushList();
        const header = splitTableRow(line).map(parseInline);
        i += 2;
        const rows: InlineToken[][][] = [];
        while (i < lines.length) {
          const rowLine = lines[i] ?? '';
          if (rowLine.trim() === '' || !rowLine.includes('|') || FENCE_OPEN_RE.test(rowLine)) {
            break;
          }
          rows.push(splitTableRow(rowLine).map(parseInline));
          i += 1;
        }
        tokens.push({ type: 'table', align, header, rows });
        continue;
      }
    }

    const quoteMatch = QUOTE_RE.exec(line);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      const quoteLines: string[] = [quoteMatch[1] ?? ''];
      i += 1;
      while (i < lines.length) {
        const nextQuote = QUOTE_RE.exec(lines[i] ?? '');
        if (!nextQuote) {
          break;
        }
        quoteLines.push(nextQuote[1] ?? '');
        i += 1;
      }
      tokens.push({ type: 'quote', lines: quoteLines.map(parseInline) });
      continue;
    }

    const orderedMatch = ORDERED_RE.exec(line);
    const unorderedMatch = orderedMatch ? null : UNORDERED_RE.exec(line);
    if (orderedMatch || unorderedMatch) {
      flushParagraph();
      const isOrdered = orderedMatch !== null;
      const picked = orderedMatch ?? unorderedMatch;
      const indent = picked?.[1] ?? '';
      let content = picked?.[2] ?? '';
      let checked: boolean | undefined;
      if (!isOrdered) {
        const taskMatch = TASK_RE.exec(content);
        if (taskMatch) {
          checked = (taskMatch[1] ?? '').toLowerCase() === 'x';
          content = taskMatch[2] ?? '';
        }
      }
      const rawDepth = Math.floor(indent.length / 2);

      if (listBuf === undefined) {
        listBuf = { ordered: isOrdered, items: [], prevDepth: -1 };
      } else if (rawDepth === 0 && isOrdered !== listBuf.ordered) {
        // 深さ0（インデント無し）での種別切り替えは別リストとして扱う（従来どおり）。
        // ネストしている行（rawDepth > 0）の種別違いはネストの一部として同じリストへ
        // 残す（数字リストの下に箇条書きの補足を書く等、実際の応答でよくある形のため。
        // 種別を厳密に混在管理せずブロック全体で単一のordered値を使う軽量な割り切り）
        flushList();
        listBuf = { ordered: isOrdered, items: [], prevDepth: -1 };
      }
      const depth = Math.max(0, Math.min(rawDepth, listBuf.prevDepth + 1));
      listBuf.prevDepth = depth;
      listBuf.items.push({ content, depth, checked });
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
 * webviewへ埋め込む同等実装（issue #290, #332）。
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
      '|~~([^~]+)~~' +
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
        tokens.push({ type: 'strike', value: match[4] });
      } else if (match[5] !== undefined) {
        tokens.push({ type: 'bold', value: match[5] });
      } else if (match[6] !== undefined) {
        tokens.push({ type: 'bold', value: match[6] });
      } else if (match[7] !== undefined) {
        tokens.push({ type: 'italic', value: match[7] });
      } else if (match[8] !== undefined) {
        tokens.push({ type: 'italic', value: match[8] });
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
  var HR_RE = /^ {0,3}([-*_])(?:[ \\t]*\\1){2,}[ \\t]*$/;
  var ORDERED_RE = /^( *)\\d+\\.\\s+(.*)$/;
  var UNORDERED_RE = /^( *)[-*+]\\s+(.*)$/;
  var TASK_RE = /^\\[([ xX])\\]\\s+(.*)$/;
  var QUOTE_RE = /^ {0,3}>[ \\t]?(.*)$/;
  var TABLE_DELIM_CELL_RE = /^:?-+:?$/;

  function splitTableRow(line) {
    var trimmed = line.trim();
    if (trimmed.charAt(0) === '|') {
      trimmed = trimmed.slice(1);
    }
    if (trimmed.charAt(trimmed.length - 1) === '|') {
      trimmed = trimmed.slice(0, -1);
    }
    return trimmed.split('|').map(function (cell) { return cell.trim(); });
  }

  function parseTableAlignRow(line) {
    var cells = splitTableRow(line);
    if (cells.length === 0) {
      return undefined;
    }
    var aligns = [];
    for (var c = 0; c < cells.length; c += 1) {
      var cell = cells[c];
      if (!TABLE_DELIM_CELL_RE.test(cell)) {
        return undefined;
      }
      var left = cell.charAt(0) === ':';
      var right = cell.charAt(cell.length - 1) === ':';
      aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : undefined);
    }
    return aligns;
  }

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
        var items = listBuf.items.map(function (item) {
          var out = { inline: parseInline(item.content), depth: item.depth };
          if (item.checked !== undefined) {
            out.checked = item.checked;
          }
          return out;
        });
        tokens.push({ type: 'list', ordered: listBuf.ordered, items: items });
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

      if (HR_RE.test(line)) {
        flushParagraph();
        flushList();
        tokens.push({ type: 'hr' });
        i += 1;
        continue;
      }

      if (line.indexOf('|') !== -1) {
        var nextLine = lines[i + 1];
        var align = nextLine !== undefined ? parseTableAlignRow(nextLine) : undefined;
        if (align !== undefined) {
          flushParagraph();
          flushList();
          var header = splitTableRow(line).map(parseInline);
          i += 2;
          var rows = [];
          while (i < lines.length) {
            var rowLine = lines[i] || '';
            if (rowLine.trim() === '' || rowLine.indexOf('|') === -1 || FENCE_OPEN_RE.test(rowLine)) {
              break;
            }
            rows.push(splitTableRow(rowLine).map(parseInline));
            i += 1;
          }
          tokens.push({ type: 'table', align: align, header: header, rows: rows });
          continue;
        }
      }

      var quoteMatch = QUOTE_RE.exec(line);
      if (quoteMatch) {
        flushParagraph();
        flushList();
        var quoteLines = [quoteMatch[1] || ''];
        i += 1;
        while (i < lines.length) {
          var nextQuote = QUOTE_RE.exec(lines[i] || '');
          if (!nextQuote) {
            break;
          }
          quoteLines.push(nextQuote[1] || '');
          i += 1;
        }
        tokens.push({ type: 'quote', lines: quoteLines.map(parseInline) });
        continue;
      }

      var orderedMatch = ORDERED_RE.exec(line);
      var unorderedMatch = orderedMatch ? null : UNORDERED_RE.exec(line);
      if (orderedMatch || unorderedMatch) {
        flushParagraph();
        var isOrdered = orderedMatch !== null;
        var picked = orderedMatch || unorderedMatch;
        var indent = (picked && picked[1]) || '';
        var content = (picked && picked[2]) || '';
        var checked;
        if (!isOrdered) {
          var taskMatch = TASK_RE.exec(content);
          if (taskMatch) {
            checked = (taskMatch[1] || '').toLowerCase() === 'x';
            content = taskMatch[2] || '';
          }
        }
        var rawDepth = Math.floor(indent.length / 2);

        if (listBuf === undefined) {
          listBuf = { ordered: isOrdered, items: [], prevDepth: -1 };
        } else if (rawDepth === 0 && isOrdered !== listBuf.ordered) {
          flushList();
          listBuf = { ordered: isOrdered, items: [], prevDepth: -1 };
        }
        var depth = Math.max(0, Math.min(rawDepth, listBuf.prevDepth + 1));
        listBuf.prevDepth = depth;
        listBuf.items.push({ content: content, depth: depth, checked: checked });
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
