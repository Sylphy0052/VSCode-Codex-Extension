/**
 * 未追跡ファイルの一覧と、その安全な読み取り（Issue #926 F）。
 *
 * `git diff` の結果だけをAdvisorへ渡していたため、まだgitに登録していない新規ファイルが
 * まるごと落ちていた。新機能の開発では主要な実装が全部新規ファイルであることが普通にあり、
 * その場合Advisorは既存ファイルの数行しか見ないまま意見を返すことになる。
 *
 * `git add -N` は使わない。親セッションが作業している最中にindexを触るのは危険で、
 * 一覧（`git ls-files --others --exclude-standard`）も内容の読み取りも、作業ツリーと
 * indexを一切書き換えずに済む。
 *
 * **`.gitignore` は秘密情報を守る境界ではない。** 一覧を通過したパスをそのまま読んでは
 * いけない。`fs.readFile()` はsymlinkを追うため、リポジトリ外の資格情報ファイルを指す
 * symlinkが未追跡ファイルとして置かれていれば、その中身をそのまま外部のセッションへ
 * 送ることになる。読む前に必ず次を確かめる。
 *
 * 1. `realpath` で解決したパスがworkspace rootの配下にあること
 * 2. 開いた**fd自身**が通常ファイルであること（`fstat`）
 * 3. 読むのは**そのfd**からであること
 *
 * 3が要るのは、`lstat` とroot確認の後にファイルを差し替えられるため（TOCTOU）。パスを
 * 検査してからパスで開き直すと、検査した対象と読む対象が別物になりうる。
 *
 * `vscode` には依存しない。実際のファイル操作は呼び出し側が渡す（{@link UntrackedFileReader}）。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** プロンプトへ載せた未追跡ファイル1件。 */
export interface UntrackedFile {
  /** workspace rootからの相対パス（`git ls-files` が返す形）。 */
  path: string;
  /** ファイルの中身。 */
  content: string;
  /** UTF-8のbyte数。`string.length` とは一致しないため、単位を揃えて持つ。 */
  bytes: number;
}

/** 内容を載せなかった理由。 */
export type UntrackedOmissionReason =
  /** NULを含む（バイナリ）。 */
  | 'binary'
  /** 通常ファイルではない（symlink / fifo / socket / device）。 */
  | 'unsafe-file-type'
  /** 解決後のパスがworkspace rootの外を指す。 */
  | 'outside-workspace'
  /** 1ファイルあたりの上限を超える。 */
  | 'per-file-budget'
  /** 全体の予算を使い切った。 */
  | 'total-budget'
  /** 読み取りそのものに失敗した（権限・I/O）。 */
  | 'read-error';

/** 内容を載せなかったファイル1件。パスとサイズだけをプロンプトへ載せる。 */
export interface UntrackedOmission {
  path: string;
  /** 分かっている場合のbyte数。開く前に弾いた場合は `undefined`。 */
  bytes?: number | undefined;
  reason: UntrackedOmissionReason;
}

/** {@link UntrackedFileReader.read} の結果。 */
export type UntrackedReadResult =
  | { kind: 'file'; bytes: number; content: string }
  | { kind: 'skipped'; reason: UntrackedOmissionReason; bytes?: number | undefined };

export interface UntrackedFileReader {
  /**
   * 未追跡ファイルを1件読む。上のドキュメントの1〜3をこの中で守ること。
   *
   * @param absPath 読む対象の絶対パス
   * @param root workspace rootの絶対パス。解決後のパスがこの配下に無ければ読まない
   * @param maxBytes 1ファイルあたりの上限。超えるものは内容を読まない
   */
  read(absPath: string, root: string, maxBytes: number): Promise<UntrackedReadResult>;
}

/**
 * 1ファイルあたりの上限（Issue #926 F）。
 *
 * 1つの巨大な自動生成ファイルで全体の予算を使い切ると、その後ろの新規ファイルが
 * まるごと落ちる。ファイル単位で先に切っておく。
 */
export const MAX_UNTRACKED_FILE_BYTES = 64 * 1024;

/**
 * `git ls-files --others --exclude-standard -z` の出力を相対パスの配列にする。
 *
 * `-z` を使うのは、改行を含むファイル名でも壊れない形で受け取るため。末尾のNULで
 * 空要素が出るので落とす。
 */
export function parseUntrackedList(stdout: string): string[] {
  return stdout.split('\0').filter((entry) => entry !== '');
}

/**
 * 解決後のパスがworkspace rootの配下にあるか。
 *
 * `root` そのものは対象にしない（ファイルであることはありえない）。`startsWith` だけで
 * 見ると `/repo` に対する `/repo-secrets` が通ってしまうため、区切り文字まで含めて見る。
 */
export function isInsideRoot(resolvedPath: string, root: string): boolean {
  const relative = path.relative(root, resolvedPath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * NULを含むか（バイナリ判定）。
 *
 * 先頭の一定量だけを見る。全体を走査しても判定は変わらないが、上限いっぱいのファイルで
 * 無駄に舐めることになる。
 */
export function looksBinary(buffer: Buffer): boolean {
  const head = buffer.subarray(0, Math.min(buffer.length, 8192));
  return head.includes(0);
}

/**
 * Node実装の{@link UntrackedFileReader}。
 *
 * `open` してから `fstat` で通常ファイルを確かめ、**その fd から読む**。パスで検査して
 * パスで開き直すと、検査と読み取りの間に差し替えられる（TOCTOU）。`realpath` は
 * symlinkを解決するため、リポジトリ外を指すsymlinkはここで弾かれる。
 */
export function createNodeUntrackedFileReader(): UntrackedFileReader {
  return {
    async read(absPath, root, maxBytes) {
      let resolved: string;
      try {
        resolved = await fs.realpath(absPath);
      } catch {
        return { kind: 'skipped', reason: 'read-error' };
      }
      if (!isInsideRoot(resolved, root)) {
        return { kind: 'skipped', reason: 'outside-workspace' };
      }
      let handle: fs.FileHandle | undefined;
      try {
        handle = await fs.open(resolved, 'r');
        const stat = await handle.stat();
        if (!stat.isFile()) {
          return { kind: 'skipped', reason: 'unsafe-file-type' };
        }
        if (stat.size > maxBytes) {
          return { kind: 'skipped', reason: 'per-file-budget', bytes: stat.size };
        }
        const buffer = await handle.readFile();
        if (looksBinary(buffer)) {
          return { kind: 'skipped', reason: 'binary', bytes: buffer.byteLength };
        }
        return { kind: 'file', bytes: buffer.byteLength, content: buffer.toString('utf8') };
      } catch {
        return { kind: 'skipped', reason: 'read-error' };
      } finally {
        await handle?.close().catch(() => undefined);
      }
    },
  };
}

export interface CollectUntrackedRequest {
  /** workspace rootの絶対パス。 */
  root: string;
  /** `git ls-files` が返した相対パスの一覧。 */
  paths: readonly string[];
  /** 未追跡ファイル全体で使えるbyte数。差分と共通の予算から残った分を渡す。 */
  totalBudgetBytes: number;
  /** 1ファイルあたりの上限。 */
  perFileBytes?: number;
  reader: UntrackedFileReader;
}

export interface CollectUntrackedResult {
  files: UntrackedFile[];
  omissions: UntrackedOmission[];
}

/**
 * 未追跡ファイルを、予算の範囲で読めるだけ読む。
 *
 * 落としたものは必ず {@link CollectUntrackedResult.omissions} へ積む。**黙って切らない。**
 * 何を見ていないかがAdvisorへ伝わらないと、「新規ファイルは無い」という前提で読まれる。
 *
 * 予算を使い切っても打ち切らず、残りは `total-budget` として一覧に載せる。何件残って
 * いるかが分かる方が、途中で切れた一覧より判断に使える。
 */
export async function collectUntrackedFiles(
  request: CollectUntrackedRequest,
): Promise<CollectUntrackedResult> {
  const perFileBytes = request.perFileBytes ?? MAX_UNTRACKED_FILE_BYTES;
  const files: UntrackedFile[] = [];
  const omissions: UntrackedOmission[] = [];
  let used = 0;
  for (const relative of request.paths) {
    const absPath = path.resolve(request.root, relative);
    if (used >= request.totalBudgetBytes) {
      omissions.push({ path: relative, reason: 'total-budget' });
      continue;
    }
    const remaining = request.totalBudgetBytes - used;
    const limit = Math.min(perFileBytes, remaining);
    const result = await request.reader.read(absPath, request.root, limit);
    if (result.kind === 'skipped') {
      // 残り予算の都合で切られた場合と、ファイル自体が上限を超える場合を区別する。
      // 前者は「もっと早く実行すれば載った」もので、原因が違う
      const reason =
        result.reason === 'per-file-budget' && (result.bytes ?? 0) <= perFileBytes
          ? 'total-budget'
          : result.reason;
      omissions.push({ path: relative, bytes: result.bytes, reason });
      continue;
    }
    files.push({ path: relative, content: result.content, bytes: result.bytes });
    used += result.bytes;
  }
  return { files, omissions };
}
