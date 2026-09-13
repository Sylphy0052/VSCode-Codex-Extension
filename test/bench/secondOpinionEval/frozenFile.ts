/**
 * 一度凍結したファイルを、後から静かに置き換えられないようにする（Issue #1046）。
 *
 * ハッシュを記録しても、同じパスへ書き直せるなら凍結したことにならない。母集団や判定を作り
 * 直したくなったら、版を上げて別のファイルにし、前の版は残す。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * まだ無いときだけ書く。
 *
 * 既にあって中身が同じなら、書かずに `unchanged` を返す（同じ入力から作り直して確かめる、
 * という使い方を塞がないため）。**1バイトでも違えば書かずに投げる。**
 */
export async function writeFrozen(
  outPath: string,
  contents: string,
): Promise<'created' | 'unchanged'> {
  if (await exists(outPath)) {
    const current = await fs.readFile(outPath, 'utf8');
    if (current === contents) {
      return 'unchanged';
    }
    throw new Error(
      `${outPath} は既にあり、中身が違います。凍結済みの版は上書きしません。版を上げて別のパスへ書いてください`,
    );
  }
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await fs.writeFile(outPath, contents, 'utf8');
  return 'created';
}

/** 一度取ったら取り直さないファイル（母集団の素など）を作る前の確認。 */
export async function refuseIfExists(outPath: string, what: string): Promise<void> {
  if (await exists(outPath)) {
    throw new Error(
      `${outPath} は既にあります。${what}は取り直しません。作り直すなら別の版のパスを指定し、この版は残してください`,
    );
  }
}
