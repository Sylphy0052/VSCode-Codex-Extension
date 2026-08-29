/**
 * Advisorへ送る直前の credential redaction（Issue #947 受入基準12）。
 *
 * askGptモードは親セッションに「関連コードは原則全文」「エラーは生ログ原文」「環境は設定
 * ファイルから実測」を求める。既定の `direct` モードが渡す差分より広い範囲を能動的に集める
 * ため、`.env`・ログ・設定ファイル・fixtureに含まれる認証情報を拾う可能性がその分だけ高い。
 *
 * Advisorのセッションはローカルプロセスだが、モデルサービスへ送信するクライアントである。
 * 「同じマシンの中だから外へ出ない」はプロセス境界の話であって、データ境界の話ではない。
 * 親への生成指示でも「貼らないでください」と書いてあるが、指示は守られる保証が無い。ここは
 * 送信経路の最後で機械的にかける最終防護であり、指示との二重化に意味がある。
 *
 * 伏せるのは credential だけで、proprietary code は伏せない。コードを伏せるとAdvisorが
 * 判断できなくなるうえ、そもそもコードを渡すことはこの機能の前提である（credential と
 * proprietary code は別の問題として扱う）。
 *
 * `vscode` にも CLI にも依存しない純粋な文字列処理。
 */

/** 伏せた箇所へ入れる印。何が起きたかが読み手（Advisor・利用者）に分かる文字列にする。 */
export const REDACTION_MARK = '<MASKED>';

export interface RedactionResult {
  text: string;
  /** ルール名ごとの置換件数。0件のルールは含めない。 */
  counts: Record<string, number>;
  /** 置換の総件数。0なら何も伏せていない。 */
  total: number;
}

interface RedactionRule {
  /** 利用者への報告に出る名前。 */
  name: string;
  pattern: RegExp;
  /** マッチ全体をどう書き換えるか。前後の文脈（キー名・スキーム）は残して値だけ伏せる。 */
  replace: (...groups: string[]) => string;
}

/**
 * 値が伏せるに値するかの判定。
 *
 * プレースホルダや環境変数の参照まで伏せると、コードの意味だけが壊れて安全性は上がらない。
 * `API_KEY=process.env.FOO` を伏せても守るものが無く、Advisorには「何か伏せられた」という
 * 誤った合図だけが残る。
 */
function looksLikeRealSecret(value: string): boolean {
  const trimmed = value.trim().replace(/^['"`]|['"`]$/g, '');
  if (trimmed.length < 8) {
    return false;
  }
  if (trimmed === REDACTION_MARK) {
    return false;
  }
  // 環境変数の参照・テンプレート展開・明らかなプレースホルダ
  if (/^(process\.env\.|import\.meta\.env\.|os\.environ|\$\{|\$[A-Z_]+$|<|\.\.\.)/.test(trimmed)) {
    return false;
  }
  if (/^[xX*.\-_]+$/.test(trimmed)) {
    return false;
  }
  if (/^(your|my|example|sample|dummy|test|fake|changeme|placeholder)[-_a-z0-9]*$/i.test(trimmed)) {
    return false;
  }
  return true;
}

/**
 * 適用するルール。
 *
 * 並びが意味を持つ。範囲の広いもの（秘密鍵ブロック）を先に処理し、後続のルールが
 * その内部を二重に走査しないようにする。
 */
const RULES: readonly RedactionRule[] = [
  {
    // PEM形式の秘密鍵。ブロックごと落とす（1行だけ伏せても鍵は復元されうる）
    name: '秘密鍵',
    pattern: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
    replace: () => `-----BEGIN PRIVATE KEY-----\n${REDACTION_MARK}\n-----END PRIVATE KEY-----`,
  },
  {
    // URLに埋め込まれた認証情報。ホストは残す（どこへ繋いでいるかは判断に要る）
    name: 'URL埋め込みの認証情報',
    pattern: /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/g,
    replace: (_all, scheme, user) => `${scheme}${user}:${REDACTION_MARK}@`,
  },
  {
    name: 'Authorizationヘッダ',
    pattern: /\b(Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{8,})/g,
    replace: (all, scheme, value) =>
      looksLikeRealSecret(value) ? `${scheme} ${REDACTION_MARK}` : all,
  },
  {
    // 既知の発行元が持つ接頭辞。キー名が無くても値だけで判別できる
    name: '既知の形式のトークン',
    pattern:
      /\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{35})\b/g,
    replace: () => REDACTION_MARK,
  },
  {
    // `API_KEY = "..."` / `password: '...'` 形式の代入。キー名は残して値だけ伏せる
    name: '認証情報の代入',
    pattern:
      /\b([A-Za-z0-9_-]*(?:api[-_]?key|secret|token|password|passwd|pwd|access[-_]?key|client[-_]?secret|private[-_]?key|credentials?)[A-Za-z0-9_-]*)(\s*[:=]\s*)(['"`]?)([^\s'"`,;)\]}]+)(['"`]?)/gi,
    replace: (all, key, sep, openQuote, value, closeQuote) =>
      looksLikeRealSecret(value) ? `${key}${sep}${openQuote}${REDACTION_MARK}${closeQuote}` : all,
  },
];

/**
 * 既知のsecret形式を伏せる。
 *
 * 完全な検出は原理的にできない（任意の文字列が秘密になりうる）。ここが担うのは「よくある形の
 * ものは必ず落ちる」ところまでで、社外・外部サービスへ出してよい内容かの最終判断は利用者が行う。
 * 検出しきれない前提で、伏せた件数を必ず呼び出し側へ返し、会話へ残せるようにする。
 */
export function redactCredentials(text: string): RedactionResult {
  const counts: Record<string, number> = {};
  let out = text;
  for (const rule of RULES) {
    let hits = 0;
    out = out.replace(rule.pattern, (...args: unknown[]) => {
      // `String.replace` は末尾に offset と入力全体（named groupsがあればその後にも）を渡す。
      // ルール側はキャプチャだけを見るため、文字列の引数だけを取り出して渡す
      const groups = args.filter((a): a is string => typeof a === 'string');
      const replaced = rule.replace(...groups);
      if (replaced !== groups[0]) {
        hits += 1;
      }
      return replaced;
    });
    if (hits > 0) {
      counts[rule.name] = hits;
    }
  }
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return { text: out, counts, total };
}

/**
 * 複数回の伏せ字化の件数を1つにまとめる（Issue #954）。
 *
 * askGptモードでは、利用者の依頼文と親が組み立てた質問文を別々に伏せてから送る。会話へ残す
 * 件数を別々に出すと、利用者は2つの数を足して読むことになる。送ったのは1本のテキストなので、
 * 件数も1つに見せる。`text` は持たない——結合した本文はここでは作れないし、作る意味も無い。
 */
export function mergeRedactionCounts(
  ...results: ReadonlyArray<Pick<RedactionResult, 'counts' | 'total'>>
): Pick<RedactionResult, 'counts' | 'total'> {
  const counts: Record<string, number> = {};
  for (const result of results) {
    for (const [name, count] of Object.entries(result.counts)) {
      counts[name] = (counts[name] ?? 0) + count;
    }
  }
  return { counts, total: results.reduce((sum, r) => sum + r.total, 0) };
}

/** 置換の内訳を1行の日本語にする（会話へ残す用）。0件なら `undefined`。 */
export function describeRedaction(
  result: Pick<RedactionResult, 'counts' | 'total'>,
): string | undefined {
  if (result.total === 0) {
    return undefined;
  }
  const detail = Object.entries(result.counts)
    .map(([name, count]) => `${name}${count}件`)
    .join(' / ');
  return `送信前に認証情報とみられる箇所を伏せました（${detail}）`;
}
