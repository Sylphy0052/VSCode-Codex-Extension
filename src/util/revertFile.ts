import * as fs from 'node:fs/promises';

/**
 * 「この変更を戻す」（issue #291）の書き込み口（Issue #1170）。
 *
 * 確認モーダルの応答待ちは不定長で、その間に対象の親ディレクトリがワークスペース外への
 * symlinkへ差し替わると、同じ絶対パス文字列が別の実体を指す。パスで検査してパスで開き直す
 * 形では、検査した対象と書く対象が別物になりうる（`secondOpinion/untracked.ts` の読み取り側と
 * 同じ穴）。ここでは、検査した時点の実体の識別子（`dev`/`ino`）を控え、開いたfdの `fstat` と
 * 一致したときだけ、**そのfdから読み、そのfdへ書く**。
 *
 * `vscode` には依存しない。テストではフェイクを差し替える。
 */

/** 実体の識別子。同じデバイス上で同じinodeなら同じ実体。 */
export interface FileIdentity {
  dev: number;
  ino: number;
}

export function sameFileIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/** `rewrite` に渡す判断。現在の内容を見て、書く内容を返すか理由付きで断る。 */
export type RewriteDecision = { ok: true; content: string } | { ok: false; reason: string };

export type RewriteOutcome =
  /** 同じ実体だったので、`next` が返した内容を書いた。 */
  | { kind: 'written' }
  /** 開いた実体が検査時と違う（差し替え）。何も書いていない。 */
  | { kind: 'changed' }
  /** 開いた実体が通常ファイルではない。何も書いていない。 */
  | { kind: 'not-a-file' }
  /** `next` が断った（内容が想定と違う等）。何も書いていない。 */
  | { kind: 'aborted'; reason: string };

export interface RevertFilePort {
  /** 実体の識別子。存在しなければ `undefined`。 */
  identify(absolutePath: string): Promise<FileIdentity | undefined>;
  /**
   * 開いた実体が `expected` と同じときだけ、現在の内容を `next` に渡し、返った内容で
   * 同じfdの中身を置き換える。`next` が断れば何も書かない。開けなければ投げる。
   */
  rewrite(
    absolutePath: string,
    expected: FileIdentity,
    next: (current: string) => RewriteDecision,
  ): Promise<RewriteOutcome>;
  /** 無いときだけ作る（`wx`）。既にあれば投げる。 */
  createNew(absolutePath: string, content: string): Promise<void>;
}

/**
 * 実ファイルシステム向けの実装。
 *
 * `open` は最後の要素がsymlinkならたどるが、その場合 `fstat` の `dev`/`ino` は控えた実体と
 * 一致しないため `changed` になる。親ディレクトリの差し替えも同じ理由で捕まえられる。
 * `open` と `fstat` の間には差し替えの余地が無い（fdは開いた実体に固定される）。
 */
export const nodeRevertFilePort: RevertFilePort = {
  async identify(absolutePath) {
    try {
      const stat = await fs.lstat(absolutePath);
      return { dev: stat.dev, ino: stat.ino };
    } catch {
      return undefined;
    }
  },

  async rewrite(absolutePath, expected, next) {
    const handle = await fs.open(absolutePath, 'r+');
    try {
      const stat = await handle.stat();
      if (!sameFileIdentity({ dev: stat.dev, ino: stat.ino }, expected)) {
        return { kind: 'changed' };
      }
      if (!stat.isFile()) {
        return { kind: 'not-a-file' };
      }
      const decided = next(await handle.readFile('utf8'));
      if (!decided.ok) {
        return { kind: 'aborted', reason: decided.reason };
      }
      await handle.truncate(0);
      const buffer = Buffer.from(decided.content, 'utf8');
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, offset);
        offset += bytesWritten;
      }
      return { kind: 'written' };
    } finally {
      await handle.close();
    }
  },

  async createNew(absolutePath, content) {
    await fs.writeFile(absolutePath, content, { encoding: 'utf8', flag: 'wx' });
  },
};
