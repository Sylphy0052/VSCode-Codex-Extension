import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { OutputOffloadPort } from '../appserver/outputOffload';

/**
 * 退避したツール出力の置き場（issue #1325）。
 *
 * `baseDir` には `ExtensionContext.globalStorageUri` 配下を渡す。リポジトリ内にも
 * `~/.codex` / `~/.claude` にも置かない（push事故を避ける・CLI側の領域を汚さない）。
 */
const OFFLOAD_DIR_NAME = 'tool-output';

/**
 * 残っている退避ファイルを消す目安（ミリ秒）。
 *
 * 退避した本文はセッションが生きている間だけの控えで、VSCodeを閉じれば参照元
 * （`ChatState`）ごと消える。`dispose()` で消すが、拡張機能が異常終了した場合は残る。
 * 起動時に古いものを掃除して、ディスク上の伸び続けを止める。1日空けるのは、複数の
 * VSCodeウィンドウが同じ `globalStorage` を共有するため——動いている別ウィンドウの
 * 控えを消さないようにする。
 */
const STALE_OFFLOAD_MS = 24 * 60 * 60 * 1_000;

/**
 * ディスクへ退避する {@link OutputOffloadPort} の実体。
 *
 * ファイル名は**内部の連番**で決め、`itemId` はMapの鍵としてしか使わない。`itemId` は
 * CLIから届く値（webviewからも同じ値で要求が来る）なので、パスの組み立てへ混ぜない。
 *
 * ディレクトリはセッションごとに分ける。同じウィンドウで複数の会話が動き、どれが
 * 終わっても他の控えを消さないようにするため。
 */
export function createNodeOutputOffload(
  baseDir: string,
  onError?: (message: string) => void,
): OutputOffloadPort {
  const dir = join(baseDir, OFFLOAD_DIR_NAME, randomUUID());
  const paths = new Map<string, string>();
  let count = 0;
  let ready: Promise<void> | undefined;

  const ensureDir = async (): Promise<void> => {
    ready ??= mkdir(dir, { recursive: true }).then(() => undefined);
    return ready;
  };

  return {
    async save(itemId: string, text: string): Promise<boolean> {
      try {
        await ensureDir();
        count += 1;
        const filePath = join(dir, `${count}.txt`);
        await writeFile(filePath, text, 'utf8');
        paths.set(itemId, filePath);
        return true;
      } catch (e) {
        // 書けなければ退避しない（呼び出し側は本文をメモリに残したままにする）。
        // 次回の見直しで再試行されるため、ここで諦めても本文は失われない
        onError?.(`ツール出力を退避できませんでした: ${String(e)}`);
        ready = undefined;
        return false;
      }
    },

    async load(itemId: string): Promise<string | undefined> {
      const filePath = paths.get(itemId);
      if (filePath === undefined) {
        return undefined;
      }
      try {
        return await readFile(filePath, 'utf8');
      } catch (e) {
        onError?.(`退避したツール出力を読めませんでした: ${String(e)}`);
        return undefined;
      }
    },

    dispose(): void {
      paths.clear();
      // 消すのは自分が作ったディレクトリだけ。後始末は待たない（セッションを閉じる
      // 経路を止めないため）
      void rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/**
 * 前回の実行が残した退避ファイルを掃除する。起動時に1回だけ、結果を待たずに呼ぶ。
 *
 * 消すのは {@link STALE_OFFLOAD_MS} より古いディレクトリだけ。読めないもの・消せない
 * ものは黙って飛ばす（掃除に失敗しても機能は動く）。
 */
export async function purgeStaleOutputOffload(baseDir: string, now = Date.now()): Promise<void> {
  const root = join(baseDir, OFFLOAD_DIR_NAME);
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return;
  }
  for (const name of names) {
    const target = join(root, name);
    try {
      const info = await stat(target);
      if (now - info.mtimeMs >= STALE_OFFLOAD_MS) {
        await rm(target, { recursive: true, force: true });
      }
    } catch {
      continue;
    }
  }
}
