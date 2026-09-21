/**
 * 差分の目次と、本文へ載せる量の段階判定（Issue #1322）。
 *
 * セカンドオピニオンは差分の全量を `changes.diff` へ書き出したうえで、同じ差分を
 * プロンプト本文へも貼っていた（`prompt.ts` の `artifactSection`）。コード上は意図的な
 * 二重掲載だが、1回の相談で最大300KB（差分200KB + 未追跡ファイル100KB）を送ることになり、
 * 日本語混在では概算8〜15万トークンになる。
 *
 * ここでは差分の量に応じて本文の載せ方を3段階へ分ける。小さいものは今までどおり全文を
 * 貼り、中〜大は「目次 + ファイルのパス」へ置き換えて全量はファイルから読ませる。
 *
 * **全面的に「パスだけ渡す」形にはしない。** 外部AIとの議論（Issue #1322 の背景）で、
 * パスだけを渡すとモデルがファイルを読まずに答える・一部だけ読んで全体を見た気になる、
 * という失敗が起きると指摘された。小さい差分の inline を残すのはそのためである。
 *
 * `vscode` にも CLI にも依存しない純粋な文字列処理（`diffBudget.ts` と同じ）。
 */

import { parseDiff, utf8Bytes, type DiffFileSection } from './diffBudget';

/** 本文へ差分をどう載せるか。 */
export type DiffPresentationTier =
  /** 今までどおり差分の全文を本文へ貼る。 */
  | 'inline'
  /** 目次 + hunkのheader + `changes.diff` のパス。 */
  | 'digest-hunks'
  /** 目次 + `changes.diff` のパス。 */
  | 'digest';

/** 段階を分ける閾値（トークン概算）。 */
export interface DiffPresentationThresholds {
  /** これ以下なら `inline`。 */
  inlineMaxTokens: number;
  /** これ以下なら `digest-hunks`、超えたら `digest`。 */
  hunkMaxTokens: number;
}

/** 設定の既定値（Issue #1322 受入基準1）。 */
export const DEFAULT_DIFF_PRESENTATION_THRESHOLDS: DiffPresentationThresholds = {
  inlineMaxTokens: 8_000,
  hunkMaxTokens: 20_000,
};

/**
 * トークン数の概算。
 *
 * tokenizerは入れない。ここで欲しいのは「8k相当か20k相当か」という桁の判定だけで、
 * 相談先のモデル（`agent.secondOpinion.candidates` で変わる）ごとに違うtokenizerを
 * 正確に再現しても、閾値そのものが目安である以上は精度が意味を持たない。
 *
 * 係数はASCIIを4文字/トークン、非ASCIIを1.2文字/トークンとする。前者はBPEの一般的な
 * 圧縮率、後者は日本語がほぼ1文字1トークンに割れることによる。`utf8Bytes` をそのまま
 * 使わないのは、日本語が3byte/文字で、byte数では非ASCIIを3倍に数えてしまうためである。
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let wide = 0;
  for (const ch of text) {
    if ((ch.codePointAt(0) ?? 0) < 128) {
      ascii += 1;
    } else {
      wide += 1;
    }
  }
  return Math.ceil(ascii / 4 + wide / 1.2);
}

/** 差分の量から段階を決める。 */
export function chooseDiffPresentationTier(
  diff: string,
  thresholds: DiffPresentationThresholds,
): DiffPresentationTier {
  const tokens = estimateTokens(diff);
  if (tokens <= thresholds.inlineMaxTokens) {
    return 'inline';
  }
  return tokens <= thresholds.hunkMaxTokens ? 'digest-hunks' : 'digest';
}

/** 変更の種類。目次に出す。 */
export type DiffChangeKind = 'add' | 'delete' | 'rename' | 'modify';

/** 目次に出す1ファイル分。 */
export interface DiffIndexEntry {
  /** 表示に使うパス（`diffBudget.ts` の `DiffFileSection.path` と同じ規則）。 */
  path: string;
  /** リネームの前像側のパス。リネーム以外は `undefined`。 */
  renamedFrom?: string | undefined;
  kind: DiffChangeKind;
  /** 追加行数。バイナリは 0。 */
  added: number;
  /** 削除行数。バイナリは 0。 */
  deleted: number;
  /** このファイルが差分の中で占めるUTF-8 byte数。 */
  bytes: number;
  binary: boolean;
  /** hunkのheader行（`@@ ... @@ <文脈>`）。`digest-hunks` でだけ使う。 */
  hunkHeaders: string[];
}

/** 差分の目次（Issue #1322 受入基準2）。 */
export interface DiffIndex {
  entries: DiffIndexEntry[];
  /** 差分全体のUTF-8 byte数。 */
  totalBytes: number;
  totalAdded: number;
  totalDeleted: number;
  hasBinary: boolean;
  hasRename: boolean;
  hasDelete: boolean;
}

/**
 * 目次へ出すファイルの最大件数。超えた分は件数だけを伝える。
 *
 * 目次そのものが予算を食い潰しては本末転倒である（`diffBudget.ts` の
 * `MAX_DIFF_OMISSION_ENTRIES` と同じ考え方）。
 */
export const MAX_DIFF_INDEX_ENTRIES = 200;

/** 1ファイルあたり、本文へ出すhunk headerの最大件数。 */
export const MAX_HUNK_HEADERS_PER_FILE = 20;

/**
 * `git diff` の出力から目次を作る。
 *
 * **切り詰める前の差分を渡すこと。** 目次は `changes.diff`（全量）の案内であり、
 * 本文へ載せるために切り詰めた差分から作ると、落ちたファイルが目次からも消える。
 */
export function buildDiffIndex(diff: string): DiffIndex {
  const { files } = parseDiff(diff);
  const entries = files.map((file) => toEntry(file));
  return {
    entries,
    totalBytes: utf8Bytes(diff),
    totalAdded: entries.reduce((total, entry) => total + entry.added, 0),
    totalDeleted: entries.reduce((total, entry) => total + entry.deleted, 0),
    hasBinary: entries.some((entry) => entry.binary),
    hasRename: entries.some((entry) => entry.kind === 'rename'),
    hasDelete: entries.some((entry) => entry.kind === 'delete'),
  };
}

function toEntry(file: DiffFileSection): DiffIndexEntry {
  let added = 0;
  let deleted = 0;
  const hunkHeaders: string[] = [];
  for (const hunk of file.hunks) {
    const lines = hunk.split('\n');
    if (lines.length > 0 && hunkHeaders.length < MAX_HUNK_HEADERS_PER_FILE) {
      hunkHeaders.push((lines[0] ?? '').trimEnd());
    }
    for (const line of lines) {
      // `+++` / `---` はheader側にあるためここには来ないが、`\ No newline at end of file`
      // のような行を数えないよう、先頭1文字だけで判定する
      if (line.startsWith('+')) {
        added += 1;
      } else if (line.startsWith('-')) {
        deleted += 1;
      }
    }
  }
  const renamedFrom = /^rename from (.*)$/m.exec(file.header)?.[1];
  const kind = changeKind(file.header, renamedFrom !== undefined);
  return {
    path: file.path,
    ...(renamedFrom === undefined ? {} : { renamedFrom }),
    kind,
    added,
    deleted,
    bytes: file.bytes,
    binary: file.binary,
    hunkHeaders,
  };
}

function changeKind(header: string, renamed: boolean): DiffChangeKind {
  if (renamed) {
    return 'rename';
  }
  if (/^new file mode /m.test(header)) {
    return 'add';
  }
  if (/^deleted file mode /m.test(header)) {
    return 'delete';
  }
  return 'modify';
}
