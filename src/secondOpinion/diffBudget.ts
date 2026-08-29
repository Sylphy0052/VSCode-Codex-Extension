/**
 * 差分の切り詰め（Issue #926 H）。
 *
 * これまでは `diff.slice(0, maxDiffChars)` で先頭から生の文字列として切っていた。黙って
 * 切らない方針（`truncated` をプロンプトへ出す）は守れていたが、切り方に4つの問題があった。
 *
 * - hunk・ファイルの途中で切れる。読み手は途中で終わった変更を見せられる
 * - `git diff` の出力順（おおむねパス順）で後ろのファイルが必ず落ちる。パスの並びは
 *   変更の重要度と関係が無い
 * - 巨大な自動生成ファイル1つで予算を使い切る
 * - **何を落としたかがプロンプトに無い**。落とした事実だけが `truncated` で伝わり、
 *   どのファイルを見ていないのかは伝わらない
 *
 * ここではファイル単位に予算を配分し、切るのはhunkの境界だけにする。落としたものは
 * パス・サイズ・理由の一覧として返し、プロンプトへ載せる。
 *
 * **予算の単位はUTF-8のbyte数である**（`string.length` ではない）。日本語のコメントや
 * 識別子を含む差分では、文字数で測ると実際に送る量の3倍近くずれる。
 *
 * `vscode` にも CLI にも依存しない純粋な文字列処理。
 */

/** 差分1ファイル分。 */
export interface DiffFileSection {
  /** 表示に使うパス（後像側。削除されたファイルは前像側）。 */
  path: string;
  /** `diff --git` から最初のhunkの直前まで。ファイルを残す限り必ず入れる。 */
  header: string;
  /** `@@` で始まる区画。1件も無いことがある（モード変更・リネームのみなど）。 */
  hunks: string[];
  /** このファイル分のUTF-8 byte数（header + 全hunk）。 */
  bytes: number;
  /** バイナリの差分か。 */
  binary: boolean;
  /** 自動生成とみなすパスか。 */
  generated: boolean;
}

/** 内容を落とした理由。 */
export type DiffOmissionReason =
  /** バイナリのため本文を載せない。 */
  | 'binary'
  /** 自動生成とみなして落とした。 */
  | 'generated';

/** 落としたファイル1件。 */
export interface DiffOmission {
  path: string;
  /** 元の差分でこのファイルが占めていたUTF-8 byte数。 */
  bytes: number;
  reason: DiffOmissionReason;
}

/** ファイルは残したが、一部のhunkを落としたもの。 */
export interface DiffPartialFile {
  path: string;
  /** 落としたhunkの数。 */
  omittedHunks: number;
  /** 元のhunkの総数。 */
  totalHunks: number;
}

export interface DiffBudgetResult {
  /** 組み立て直した差分。 */
  diff: string;
  /** 何かを落としたか。 */
  truncated: boolean;
  /** 丸ごと落としたファイル。 */
  omissions: DiffOmission[];
  /** 一部のhunkだけ落としたファイル。 */
  partials: DiffPartialFile[];
}

/**
 * 自動生成とみなすパス。
 *
 * 予算が足りないときに**最初に落とす候補**であって、常に落とすわけではない。予算に
 * 収まるなら渡す（ロックファイルの差分から依存の追加に気付くことはある）。
 */
const GENERATED_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/,
  /(^|\/)(Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum)$/,
  /(^|\/)(dist|build|out|vendor|node_modules|__generated__)\//,
  /\.min\.(js|css)$/,
  /\.(map|snap)$/,
  /\.generated\./,
  /(^|\/)[^/]*_pb\.(js|ts|go|py)$/,
];

/** 省略の一覧へ載せる最大件数。超えた分は件数だけを伝える。 */
export const MAX_DIFF_OMISSION_ENTRIES = 50;

/** UTF-8のbyte数。予算の判定はすべてこれで行う。 */
export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function isGeneratedPath(path: string): boolean {
  return GENERATED_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

/**
 * `+++ b/<path>` からパスを読む。
 *
 * `diff --git a/X b/Y` を直接読まないのは、空白を含むパスで `a/` と `b/` の境界が
 * 一意に決まらないため。削除されたファイルは `+++ /dev/null` になるので、その場合だけ
 * `--- a/<path>` を見る。どちらも読めなければ `diff --git` の行をそのまま名前にする
 * （名前が読めないことを理由に、そのファイルを落とすことはしない）。
 */
function readPath(header: string): string {
  const post = /^\+\+\+ (?:b\/)?(.*)$/m.exec(header);
  if (post !== null && post[1] !== undefined && post[1] !== '/dev/null') {
    return post[1];
  }
  const pre = /^--- (?:a\/)?(.*)$/m.exec(header);
  if (pre !== null && pre[1] !== undefined && pre[1] !== '/dev/null') {
    return pre[1];
  }
  const first = header.split('\n')[0] ?? '';
  return first.replace(/^diff --git /, '');
}

/**
 * `git diff` の出力をファイル単位・hunk単位へ分ける。
 *
 * 分割は行頭の `diff --git ` と `@@ ` だけを手掛かりにする（`git` の出力形式に
 * 深く踏み込まない）。改行はそのまま保たれるため、落とさなければ元の差分と一致する。
 */
export function parseDiff(diff: string): { preamble: string; files: DiffFileSection[] } {
  if (diff === '') {
    return { preamble: '', files: [] };
  }
  const chunks = diff.split(/^(?=diff --git )/m);
  // `diff --git` より前にある出力（通常は空）。落とさずそのまま先頭へ戻す
  const preamble = chunks[0]?.startsWith('diff --git ') === true ? '' : (chunks.shift() ?? '');
  const files: DiffFileSection[] = [];
  for (const chunk of chunks) {
    if (chunk === '') {
      continue;
    }
    const parts = chunk.split(/^(?=@@ )/m);
    const header = parts[0] ?? '';
    const hunks = parts.slice(1);
    const path = readPath(header);
    files.push({
      path,
      header,
      hunks,
      bytes: utf8Bytes(chunk),
      // `Binary files ... differ` と `GIT binary patch` の両方。前者は数十byteだが、
      // 後者はbase85で本文がまるごと入り、読ませても判断には使えない
      binary: /^(Binary files |GIT binary patch)/m.test(header),
      generated: isGeneratedPath(path),
    });
  }
  return { preamble, files };
}

/**
 * 予算に収まるよう差分を組み立て直す。
 *
 * **予算に収まっていれば何もしない**（受入基準: 上限以下なら渡す内容がこれまでと
 * 変わらない）。超えたときだけ、次の順で削る。
 *
 * 1. バイナリと自動生成ファイルを落とす。それで収まればここで確定する
 * 2. まだ超えるなら、残ったファイルへ予算を配分し、hunkの境界で切る
 *
 * 配分は小さいファイルから順に「残り予算 ÷ 残りファイル数」を割り当て、使い切らなかった
 * 分を次のファイルへ回す。先頭から詰めると `git diff` の出力順（おおむねパス順）で
 * 後ろのファイルが必ず落ちるが、パスの並びは変更の重要度と関係が無い。
 *
 * ファイルのheaderは予算を超えても必ず入れる。予算がhunk 1件分も無い場合、そのファイルは
 * 「hunkを全部省略した」形で残る——**ファイルの存在自体は消さない**。変更の中心が巨大な
 * ファイルであることは普通にあり、そこで消えると最も見てほしいものが伝わらない。
 */
export function applyDiffBudget(diff: string, maxBytes: number): DiffBudgetResult {
  if (utf8Bytes(diff) <= maxBytes) {
    return { diff, truncated: false, omissions: [], partials: [] };
  }
  const { preamble, files } = parseDiff(diff);
  const omissions: DiffOmission[] = [];
  const partials: DiffPartialFile[] = [];

  if (files.length === 0) {
    // `diff --git` が1つも無い形。実際の `git diff` の出力では起きないが、起きたときに
    // 「予算を超えたまま黙って全部渡す」のが一番まずい。行の境界で切り、切ったことを残す
    return { diff: cutAtLineBoundary(preamble, maxBytes), truncated: true, omissions, partials };
  }

  const kept: DiffFileSection[] = [];
  for (const file of files) {
    if (file.binary) {
      omissions.push({ path: file.path, bytes: file.bytes, reason: 'binary' });
      continue;
    }
    kept.push(file);
  }
  let budget = maxBytes - utf8Bytes(preamble);
  const keptBytes = (list: readonly DiffFileSection[]): number =>
    list.reduce((total, file) => total + file.bytes, 0);

  if (keptBytes(kept) > budget) {
    // 自動生成を大きい順に落とす。小さいものまで巻き込むと、収まるのに落とすことになる
    const generated = kept
      .filter((file) => file.generated)
      .sort((left, right) => right.bytes - left.bytes);
    for (const file of generated) {
      if (keptBytes(kept) <= budget) {
        break;
      }
      kept.splice(kept.indexOf(file), 1);
      omissions.push({ path: file.path, bytes: file.bytes, reason: 'generated' });
    }
  }

  // パスではなく区画そのものを鍵にする。同じパスに対する区画が2つ出る形（モード変更と
  // 内容変更が別々に出るなど）で、片方の描画がもう片方を上書きしないようにする
  const rendered = new Map<DiffFileSection, string>();
  if (keptBytes(kept) > budget) {
    // 小さいファイルから配る。使い切らなかった分が大きいファイルへ回る
    const order = [...kept].sort((left, right) => left.bytes - right.bytes);
    let index = 0;
    for (const file of order) {
      const share = Math.floor(budget / (order.length - index));
      index += 1;
      let used = utf8Bytes(file.header);
      const takenHunks: string[] = [];
      for (const hunk of file.hunks) {
        const size = utf8Bytes(hunk);
        if (used + size > share) {
          break;
        }
        takenHunks.push(hunk);
        used += size;
      }
      const omittedHunks = file.hunks.length - takenHunks.length;
      let body = file.header + takenHunks.join('');
      if (omittedHunks > 0) {
        const notice = hunkOmissionNotice(omittedHunks, file.hunks.length);
        body = ensureTrailingNewline(body) + notice;
        used += utf8Bytes(notice);
        partials.push({ path: file.path, omittedHunks, totalHunks: file.hunks.length });
      }
      rendered.set(file, body);
      budget -= used;
    }
  }

  const keptSet = new Set(kept);
  const body = files
    .filter((file) => keptSet.has(file))
    .map((file) => rendered.get(file) ?? file.header + file.hunks.join(''))
    .join('');
  return {
    diff: preamble + body,
    truncated: omissions.length > 0 || partials.length > 0,
    omissions,
    partials,
  };
}

/**
 * 落としたhunkを差分の中に明記する行。
 *
 * 一覧（`omissions` / `partials`）とは別に、差分そのものへも書く。読み手が差分を上から
 * 読んでいる最中に「ここから先は無い」と分かる必要がある。差分としては不正な行だが、
 * これを読むのは `git apply` ではなくモデルである。
 */
function hunkOmissionNotice(omitted: number, total: number): string {
  return `# 省略: このファイルの残り ${omitted}/${total} hunk は上限のため渡していません\n`;
}

/**
 * 予算に収まる最後の行の境界で切る。
 *
 * hunkの境界で切れない形（{@link parseDiff} がファイルを1つも見つけられなかった場合）
 * のための最後の手段。行の途中で切ると、その行が元から短かったのか切られたのかを
 * 読み手が区別できない。
 */
function cutAtLineBoundary(value: string, maxBytes: number): string {
  const lines = value.split('\n');
  const taken: string[] = [];
  let used = 0;
  for (const line of lines) {
    const size = utf8Bytes(line) + 1;
    if (used + size > maxBytes) {
      break;
    }
    taken.push(line);
    used += size;
  }
  return taken.length === 0 ? '' : `${taken.join('\n')}\n`;
}

function ensureTrailingNewline(value: string): string {
  return value === '' || value.endsWith('\n') ? value : `${value}\n`;
}
