/**
 * 自律改善の保護パス（Issue #2082）。
 *
 * 指標（差し戻し・質問数・maxReached）はガードを緩めるほど良い値になる。自己改善のPRが
 * ガード・上限・承認判定・指標の計算・この保護自体を書き換えられないよう、保護パスの一覧
 * （`SELF_IMPROVE_PROTECTED_PATHS_FILE`）に触れる自己改善PRのmergeを拒否する。
 * 同じ検査をCI（`scripts/check-self-improve-protected.mjs`）でも行う。
 */

/** 保護パスの一覧のrepo内の場所。 */
export const SELF_IMPROVE_PROTECTED_PATHS_FILE = '.github/self-improve-protected-paths';

/** 自己改善のPRを判別するラベル。 */
export const SELF_IMPROVE_LABEL = 'self-improve';

/**
 * 一覧の本文を読む。1行1パターンで、空行と`#`始まりの行は無視する。
 * パターンは`/`区切りのパスで、`*`は`/`を除く任意の文字列、`**`は`/`を含む任意の文字列、
 * 末尾`/`はそのディレクトリ以下すべてを表す。
 */
export function parseProtectedPaths(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

function patternToRegExp(pattern: string): RegExp {
  const body = pattern.endsWith('/') ? `${pattern}**` : pattern;
  let source = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body.charAt(i);
    if (ch === '*') {
      if (body.charAt(i + 1) === '*') {
        source += '.*';
        i += 1;
      } else {
        source += '[^/]*';
      }
    } else {
      source += ch.replace(/[.+?^${}()|[\]\\]/gu, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 'u');
}

/** 変更ファイルのうち、保護パスに当たるもの。 */
export function findProtectedTouches(
  files: readonly string[],
  patterns: readonly string[],
): string[] {
  const regexps = patterns.map(patternToRegExp);
  return files.filter((f) => regexps.some((re) => re.test(f)));
}

/**
 * PRのmergeを拒否する理由。自己改善ラベルが無ければ、保護パスに触れていてもすべて許す
 * （人の依頼の通常の実装は従来どおり）。拒否しなくてよければ`undefined`。
 */
export function selfImproveMergeDenial(
  labels: readonly string[],
  files: readonly string[],
  patterns: readonly string[],
): string | undefined {
  if (!labels.includes(SELF_IMPROVE_LABEL)) {
    return undefined;
  }
  const touched = findProtectedTouches(files, patterns);
  if (touched.length === 0) {
    return undefined;
  }
  return (
    `自己改善PR（ラベル${SELF_IMPROVE_LABEL}）が保護パスに触れているためmergeできない: ` +
    `${touched.slice(0, 10).join(', ')}${touched.length > 10 ? ' ほか' : ''}。` +
    '保護パスの変更は自律では作らず、調査Issueのチェックリストへ提案として残す。'
  );
}
