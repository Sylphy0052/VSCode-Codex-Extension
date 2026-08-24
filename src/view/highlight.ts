/**
 * コードブロックの構文強調（issue #717）。
 *
 * webviewのCSPは `default-src 'none'` で外部からのライブラリ読み込みができず、
 * スクリプトも `chatScript.ts` が1つの文字列として組み立てて埋め込む方式のため、
 * highlight.js等をそのまま持ち込むにはバンドル構成の変更が要る。ここでは対象言語と
 * 分類を絞った自前のトークナイザを置く（issue本文の実装案1）。
 *
 * 分類は plain / comment / string / keyword / number の5つだけ。エディタ本体の
 * 色分けを再現するのではなく、長いコードの中で文字列とコメントとキーワードの塊が
 * 目で分かればよい、という水準に留める。既知でない言語は分類せず、全体を1つの
 * plain として返す（従来どおりの無着色表示になる）。
 *
 * `markdown.ts` の `MARKDOWN_PARSE_SOURCE` と違い、TypeScript版の実装を別に持たない。
 * あちらはホスト側にも同じ処理が要る前提で二重に持ち、乖離をテストで検知しているが、
 * こちらの利用者はwebviewだけなので、写しを作れば乖離の元を増やすだけになる。
 * `test/unit/highlight.test.ts` がこの文字列を評価して振る舞いを直接確かめる。
 */

/** 強調の分類。CSSのクラス名（`tok-<type>`）と1対1で対応する。 */
export type CodeTokenType = 'plain' | 'comment' | 'string' | 'keyword' | 'number';

/** 分類の一覧。スタイル側に色の定義が揃っているかをテストで突き合わせるために持つ。 */
export const CODE_TOKEN_TYPES: readonly CodeTokenType[] = [
  'plain',
  'comment',
  'string',
  'keyword',
  'number',
];

/**
 * webviewへ埋め込むトークナイザ。
 *
 * テンプレートリテラルの中身なので、バッククォート・バックスラッシュ・改行・引用符を
 * リテラルとして書くと、この文字列を組み立てる時点で消費されてしまう。文字が要る所は
 * すべて `String.fromCharCode` 越しに扱う（`markdown.ts` と同じ迂回）。
 */
export const HIGHLIGHT_SOURCE = `
  var HL_SQ = String.fromCharCode(39);
  var HL_DQ = String.fromCharCode(34);
  var HL_BACKTICK = String.fromCharCode(96);
  var HL_ESC = String.fromCharCode(92);
  var HL_NL = String.fromCharCode(10);
  var HL_DOLLAR = String.fromCharCode(36);

  /*
   * 1ブロックあたりの上限。これを超えたら分類せずそのまま返す。ストリーミング中は
   * 本文が伸びるたびに描画し直すため、長大なログの貼り付けで毎回走らせない。
   */
  var HL_MAX_LENGTH = 20000;

  var HL_KEYWORDS = {
    js:
      'abstract as async await break case catch class const continue debugger default delete do ' +
      'else enum export extends false finally for from function get if implements import in ' +
      'instanceof interface let new null of private protected public readonly return satisfies ' +
      'set static super switch this throw true try type typeof undefined var void while yield',
    python:
      'and as assert async await break class continue def del elif else except False finally for ' +
      'from global if import in is lambda None nonlocal not or pass raise return True try while ' +
      'with yield',
    bash:
      'alias case declare do done elif else esac exit export fi for function if in local return ' +
      'readonly shift source then trap unset until while',
    json: 'true false null',
    yaml: 'true false null yes no on off',
    css: '',
  };

  /*
   * 言語ごとの規則。line/block はコメントの記号、quotes は文字列の囲み文字、
   * triple はPythonの三重引用符を許すか。
   */
  var HL_PROFILES = {
    js: {
      line: '//',
      block: ['/*', '*/'],
      quotes: HL_SQ + HL_DQ + HL_BACKTICK,
      triple: false,
      keywords: HL_KEYWORDS.js,
    },
    python: {
      line: '#',
      block: null,
      quotes: HL_SQ + HL_DQ,
      triple: true,
      keywords: HL_KEYWORDS.python,
    },
    bash: {
      line: '#',
      block: null,
      quotes: HL_SQ + HL_DQ,
      triple: false,
      keywords: HL_KEYWORDS.bash,
    },
    json: { line: null, block: null, quotes: HL_DQ, triple: false, keywords: HL_KEYWORDS.json },
    yaml: {
      line: '#',
      block: null,
      quotes: HL_SQ + HL_DQ,
      triple: false,
      keywords: HL_KEYWORDS.yaml,
    },
    css: {
      line: null,
      block: ['/*', '*/'],
      quotes: HL_SQ + HL_DQ,
      triple: false,
      keywords: HL_KEYWORDS.css,
    },
  };

  /* コードフェンスに書かれる言語名の揺れを規則へ寄せる。ここに無い名前は無着色。 */
  var HL_ALIAS = {
    js: 'js',
    jsx: 'js',
    mjs: 'js',
    cjs: 'js',
    javascript: 'js',
    ts: 'js',
    tsx: 'js',
    typescript: 'js',
    py: 'python',
    python: 'python',
    sh: 'bash',
    bash: 'bash',
    shell: 'bash',
    zsh: 'bash',
    console: 'bash',
    json: 'json',
    jsonc: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    css: 'css',
    scss: 'css',
    less: 'css',
  };

  function hlIsDigit(ch) {
    return ch >= '0' && ch <= '9';
  }

  function hlIsIdentStart(ch) {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === HL_DOLLAR;
  }

  function hlIsIdentPart(ch) {
    return hlIsIdentStart(ch) || hlIsDigit(ch);
  }

  /*
   * キーワードの集合。Object.create(null) で作る。素のオブジェクトだと
   * 'constructor' や 'toString' がprototype越しに真になり、キーワードでない語を
   * キーワードとして着色してしまう。
   */
  function hlKeywordSet(words) {
    var set = Object.create(null);
    var list = words ? words.split(' ') : [];
    for (var k = 0; k < list.length; k += 1) {
      if (list[k]) set[list[k]] = true;
    }
    return set;
  }

  for (var hlKey in HL_PROFILES) {
    HL_PROFILES[hlKey].set = hlKeywordSet(HL_PROFILES[hlKey].keywords);
  }

  /*
   * 文字列の終わりを探して、その次の位置を返す。閉じないまま行が終わったら行末で
   * 打ち切る（ストリーミング途中の欠けたコードで、以降が全部文字列に見えるのを防ぐ）。
   */
  function hlScanString(code, start, quote, allowTriple) {
    var triple = allowTriple && code.startsWith(quote + quote + quote, start);
    var mark = triple ? quote + quote + quote : quote;
    var i = start + mark.length;
    while (i < code.length) {
      var ch = code.charAt(i);
      if (ch === HL_ESC) {
        i += 2;
        continue;
      }
      if (!triple && ch === HL_NL) return i;
      if (code.startsWith(mark, i)) return i + mark.length;
      i += 1;
    }
    return code.length;
  }

  /*
   * コードを分類済みの断片へ切る。連続する地の文は1つにまとめる。
   * 返す断片の value をつなぐと必ず元のコードに戻る（コピーの内容は着色前と同じ）。
   */
  function highlightCode(lang, code) {
    var text = code || '';
    var key = HL_ALIAS[String(lang || '').toLowerCase()];
    var profile = key ? HL_PROFILES[key] : undefined;
    if (!profile || !text || text.length > HL_MAX_LENGTH) {
      return [{ type: 'plain', value: text }];
    }

    var out = [];
    var plain = '';
    function flush() {
      if (plain) {
        out.push({ type: 'plain', value: plain });
        plain = '';
      }
    }
    function push(type, value) {
      flush();
      out.push({ type: type, value: value });
    }

    var i = 0;
    while (i < text.length) {
      var ch = text.charAt(i);

      if (profile.line && text.startsWith(profile.line, i)) {
        var lineEnd = text.indexOf(HL_NL, i);
        if (lineEnd < 0) lineEnd = text.length;
        push('comment', text.slice(i, lineEnd));
        i = lineEnd;
        continue;
      }

      if (profile.block && text.startsWith(profile.block[0], i)) {
        var closeAt = text.indexOf(profile.block[1], i + profile.block[0].length);
        var blockEnd = closeAt < 0 ? text.length : closeAt + profile.block[1].length;
        push('comment', text.slice(i, blockEnd));
        i = blockEnd;
        continue;
      }

      if (profile.quotes.indexOf(ch) >= 0) {
        var strEnd = hlScanString(text, i, ch, profile.triple);
        push('string', text.slice(i, strEnd));
        i = strEnd;
        continue;
      }

      /* 識別子の途中の数字（value2 など）は数値として切らない */
      if (hlIsDigit(ch) && !(i > 0 && hlIsIdentPart(text.charAt(i - 1)))) {
        var numEnd = i;
        while (
          numEnd < text.length &&
          (hlIsIdentPart(text.charAt(numEnd)) || text.charAt(numEnd) === '.')
        ) {
          numEnd += 1;
        }
        push('number', text.slice(i, numEnd));
        i = numEnd;
        continue;
      }

      if (hlIsIdentStart(ch)) {
        var wordEnd = i;
        while (wordEnd < text.length && hlIsIdentPart(text.charAt(wordEnd))) {
          wordEnd += 1;
        }
        var word = text.slice(i, wordEnd);
        if (profile.set[word]) {
          push('keyword', word);
        } else {
          plain += word;
        }
        i = wordEnd;
        continue;
      }

      plain += ch;
      i += 1;
    }
    flush();
    return out;
  }
`;
