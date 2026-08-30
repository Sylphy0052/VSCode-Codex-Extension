/**
 * パスの末尾要素だけを取り出す。`node:path` の `basename` は環境のセパレータに依存するため、
 * ここでは常に `/` 区切りとして扱う（セッションの `cwd` はロールアウト/トランスクリプトへ
 * 書かれたPOSIXパス前提。design.md 既存実装 `sessionTreeProvider.ts` の踏襲）。
 */
export function basenameOf(p: string): string {
  const trimmed = p.endsWith('/') ? p.slice(0, -1) : p;
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/**
 * ワークスペースの所属判定（Issue #1019）。
 *
 * 会話の作業ディレクトリ（`cwd`）は、CLIが書いたセッション履歴から拾った値がそのまま
 * 渡ってくる（`sessionStore.ts`が`meta.cwd`を素通しし、`extension.ts`が`openThread`へ
 * 渡し、`chatManagerBase.ts`の`managedSessions()`まで届く）。この経路に`path.resolve`
 * 相当の正規化は無く、`..`を含む値もそのまま来うる。文字列の前方一致だけで判定すると
 * `/work/repo/../secret`が`/work/repo`の配下と見なされ、別のワークスペースの会話が
 * 混ざる（誤包含）。
 *
 * 判定はもともと`sessionKanbanModel.ts`と`sessionStore.ts`に別々の実装があり、直せる
 * 範囲が食い違っていた（前者は区切りの向きを揃えるが`..`を解決せず、後者はどちらも
 * しない）。ここに1つだけ置く。
 */
export interface WorkspacePathOptions {
  /**
   * 大小文字を無視するか。既定はパスの形で決める（ドライブ絶対パスとUNCなら真）。
   *
   * `Uri.fsPath`はドライブレターの大小が揺れうるため、Windowsのパスで区別すると同じ
   * 場所を別扱いにして会話を取りこぼす。一方POSIXでは`/a`と`/A`は別のディレクトリなので、
   * 一律に無視すると別のワークスペースを取り込む。
   *
   * 判定材料を`process.platform`ではなく文字列そのものにしているのは、リモート開発では
   * 動いている場所とパスの流儀が食い違うため。Windows上の拡張がLinuxリモートのPOSIX
   * パスを扱うとき、ホストを見て畳むと`/repo/Foo`と`/repo/foo`を同じ場所と見なす。
   */
  caseInsensitive?: boolean;
}

/** ドライブ絶対パス（`C:/...`）かUNC（`//server/...`）か。大小文字の既定に使う */
function looksWindowsPath(normalized: string): boolean {
  return normalized.startsWith('//') || /^[A-Za-z]:/u.test(normalized);
}

interface PathRoot {
  /** 畳んだ後の先頭に戻す部分。`/`、`C:/`、`//`、`C:`、空のいずれか */
  prefix: string;
  /** `..`で削れない先頭のセグメント数。UNCのサーバ名と共有名を守る */
  pinned: number;
  /** ルートより上へ出られないか */
  isAbsolute: boolean;
  /** 先頭部分を取り除いた残り */
  rest: string;
}

/**
 * 先頭の特別な部分を切り出す。`..`を畳む前にここを退避しないと、`C:/../x`でドライブが
 * 消えて相対パスに化けたり、`//server/share/..`でサーバ名が最上位のディレクトリに
 * なったりする。
 */
function splitRoot(slashed: string): PathRoot {
  if (slashed.startsWith('//')) {
    // UNCはサーバ名と共有名までが場所の識別子。`..`で共有をまたがせない
    return { prefix: '//', pinned: 2, isAbsolute: true, rest: slashed.slice(2) };
  }
  if (/^[A-Za-z]:/u.test(slashed)) {
    const drive = slashed.slice(0, 2);
    const after = slashed.slice(2);
    if (after.startsWith('/')) {
      return { prefix: `${drive}/`, pinned: 0, isAbsolute: true, rest: after };
    }
    // `C:foo`はドライブ相対。行き先が分からないので絶対パス扱いにしない
    return { prefix: drive, pinned: 0, isAbsolute: false, rest: after };
  }
  if (slashed.startsWith('/')) {
    return { prefix: '/', pinned: 0, isAbsolute: true, rest: slashed };
  }
  return { prefix: '', pinned: 0, isAbsolute: false, rest: slashed };
}

/**
 * 比較できる形へ揃える。区切りを`/`にし、`.`と`..`を畳み、重複した区切りと末尾の
 * 区切りを落とす。
 *
 * ルートより上へ出る`..`は行き先が無いので捨てる（`/a/../..`は`/`、`C:/a/../..`は
 * `C:/`）。相対パスの先頭に残った`..`だけは、基準が分からないのでそのまま残す。
 */
export function normalizeWorkspacePath(path: string): string {
  const slashed = path.replace(/\\/gu, '/');
  const { prefix, pinned, isAbsolute, rest } = splitRoot(slashed);
  const segments: string[] = [];
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      const last = segments[segments.length - 1];
      if (segments.length > pinned && last !== undefined && last !== '..') {
        segments.pop();
      } else if (!isAbsolute) {
        // 相対パスでは行き先が分からないので`..`を残す。絶対パスならルート止まり
        segments.push('..');
      }
      continue;
    }
    segments.push(segment);
  }
  return prefix + segments.join('/');
}

/** `cwd`が`root`と同じか、その配下か（Issue #1019）。 */
export function isWithinRoot(
  cwd: string,
  root: string,
  options: WorkspacePathOptions = {},
): boolean {
  const normalizedRoot = normalizeWorkspacePath(root);
  const normalizedCwd = normalizeWorkspacePath(cwd);
  const { caseInsensitive = looksWindowsPath(normalizedRoot) && looksWindowsPath(normalizedCwd) } =
    options;
  const fold = (value: string) => (caseInsensitive ? value.toLowerCase() : value);
  const foldedRoot = fold(normalizedRoot);
  const foldedCwd = fold(normalizedCwd);
  if (foldedRoot === '') {
    // ルートが空。旧実装は絶対パスをすべて配下としていたが、絞り込みが全開になる方向の
    // 緩さなので閉じる側へ倒す（Issue #1019）
    return false;
  }
  if (foldedRoot.endsWith('/')) {
    // `/`や`C:/`のような先頭部分だけのルート。その流儀の絶対パスはすべて配下
    return foldedCwd.startsWith(foldedRoot);
  }
  // 区切りを付けて比べる。`repo`と`repo-2`のような前方一致だけの別ディレクトリを弾く
  return foldedCwd === foldedRoot || foldedCwd.startsWith(`${foldedRoot}/`);
}

/** `cwd`がいずれかのルートの配下か（Issue #1019）。ルートが空なら常に偽。 */
export function isWithinAnyRoot(
  cwd: string,
  roots: readonly string[],
  options: WorkspacePathOptions = {},
): boolean {
  return roots.some((root) => isWithinRoot(cwd, root, options));
}
