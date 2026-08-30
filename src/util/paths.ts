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
   * 大小文字を無視するか。既定はWindowsのときだけ真。
   *
   * `Uri.fsPath`はドライブレターの大小が揺れうるため、Windowsで区別すると同じ場所を
   * 別扱いにして会話を取りこぼす。一方POSIXでは`/a`と`/A`は別のディレクトリなので、
   * 一律に無視すると別のワークスペースを取り込む。テストからは明示して両方を確かめる。
   */
  caseInsensitive?: boolean;
}

/**
 * 比較できる形へ揃える。区切りを`/`にし、`.`と`..`を畳み、重複した区切りと末尾の
 * 区切りを落とす。
 *
 * UNC（`\\server\share\...`）の先頭の`//`だけは残す。落とすとサーバ名が最上位の
 * ディレクトリに化けて、別の共有と一致しうる。ルートより上へ出る`..`は、行き先が
 * 無いので捨てる（`/a/../..`は`/`）。
 */
export function normalizeWorkspacePath(path: string): string {
  const slashed = path.replace(/\\/gu, '/');
  const isUnc = slashed.startsWith('//');
  const isAbsolute = slashed.startsWith('/');
  const segments: string[] = [];
  for (const segment of slashed.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      const last = segments[segments.length - 1];
      if (last !== undefined && last !== '..') {
        segments.pop();
      } else if (!isAbsolute) {
        // 相対パスでは行き先が分からないので`..`を残す。絶対パスならルート止まり
        segments.push('..');
      }
      continue;
    }
    segments.push(segment);
  }
  const joined = segments.join('/');
  if (isUnc) {
    return `//${joined}`;
  }
  if (isAbsolute) {
    return `/${joined}`;
  }
  return joined;
}

/** `cwd`が`root`と同じか、その配下か（Issue #1019）。 */
export function isWithinRoot(
  cwd: string,
  root: string,
  options: WorkspacePathOptions = {},
): boolean {
  const { caseInsensitive = process.platform === 'win32' } = options;
  const fold = (value: string) => (caseInsensitive ? value.toLowerCase() : value);
  const normalizedRoot = fold(normalizeWorkspacePath(root));
  const normalizedCwd = fold(normalizeWorkspacePath(cwd));
  if (normalizedRoot === '/' || normalizedRoot === '') {
    // ルート直下を指定されたら、絶対パスはすべて配下
    return normalizedCwd.startsWith('/');
  }
  // 区切りを付けて比べる。`repo`と`repo-2`のような前方一致だけの別ディレクトリを弾く
  return normalizedCwd === normalizedRoot || normalizedCwd.startsWith(`${normalizedRoot}/`);
}

/** `cwd`がいずれかのルートの配下か（Issue #1019）。ルートが空なら常に偽。 */
export function isWithinAnyRoot(
  cwd: string,
  roots: readonly string[],
  options: WorkspacePathOptions = {},
): boolean {
  return roots.some((root) => isWithinRoot(cwd, root, options));
}
