import * as path from 'node:path';

/**
 * 会話の差分（issue #291）を実ファイルへ結び付けてよいかの判定結果。
 *
 * `ok: false` の `error` は、そのままユーザー向けの通知（`vscode.window.showWarningMessage`
 * 等）に渡せる日本語文にしてある。
 */
export type DiffPathResolution =
  | { ok: true; absolutePath: string }
  | { ok: false; error: string };

/**
 * 文字列だけでの境界判定（issue #291）。
 *
 * 会話に出るファイルパス（`FileDiff.path` / `movePath`）はCLI（Codex/Claude）が組み立てた
 * 値で、その中身は会話の内容（モデルの出力）に由来する。ワークスペースの外を指す値が
 * 混ざっても操作を出さないよう、2段で守る。
 *
 * 1. `..` セグメントを含む文字列はどう解決されようと拒む。`a/../a/file.txt` のように
 *    打ち消し合って結果的にはルート内へ収まる形も含めて拒む（受入基準に明記された
 *    基準そのものを機械的に満たすため。曖昧さを残さない）
 * 2. 絶対パスとして与えられた場合・相対パスをrootへ結合した場合のどちらも、正規化した
 *    結果が root の配下に収まっているかを確認する
 *
 * **シンボリックリンクによる脱出はここでは判定できない**（文字列だけの判定のため）。
 * 実際にファイルへ触れる直前、`verifyRealPathWithinWorkspace` で別途確認すること。
 *
 * Webview側（`chatScript.ts`）にも同じ考え方の簡易版（文字列だけの判定）を置いて
 * ボタンの出し分けに使うが、こちらがホスト側の最終判定であり、Webview側の判定結果は
 * 信用しない（エージェントの出力に由来する文字列を信用しない、というこのリポジトリの方針）。
 */
export function resolveWithinWorkspace(
  requestedPath: string,
  workspaceRoots: readonly string[],
): DiffPathResolution {
  if (requestedPath === '') {
    return { ok: false, error: 'パスが空です' };
  }
  if (containsParentSegment(requestedPath)) {
    return { ok: false, error: `ワークスペースの外を指すパスです: ${requestedPath}` };
  }
  for (const root of workspaceRoots) {
    const normalizedRoot = path.resolve(root);
    const candidate = path.isAbsolute(requestedPath)
      ? path.resolve(requestedPath)
      : path.resolve(normalizedRoot, requestedPath);
    const rel = path.relative(normalizedRoot, candidate);
    // rel === '' はroot自身（ファイルではない）。空でなく、`..`で始まらず、絶対パスでもなければ
    // root配下に収まっている
    if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return { ok: true, absolutePath: candidate };
    }
  }
  return { ok: false, error: `ワークスペース内へ解決できないパスです: ${requestedPath}` };
}

function containsParentSegment(p: string): boolean {
  return p.split(/[\\/]/).some((seg) => seg === '..');
}

/**
 * 実ファイルシステムに触れて、シンボリックリンクによる脱出が無いかを確かめる
 * （issue #291、issue #144の追記処理と同じ考え方）。
 *
 * `absolutePath` から実在する直近の祖先まで遡って `realpath` を取り、そこから先
 * （まだ存在しない末尾部分）を結合したうえで、workspaceRootsのいずれかの実体パス配下に
 * 収まっているかを確認する。対象自身が存在しない場合（削除された変更を戻す・移動前の
 * パスへ書き戻す等）でも判定できるようにするための遡りで、`fs.realpath` は存在しない
 * パスに対して例外を投げるため必要になる。
 *
 * `realpath` は呼び出し側（ホスト層）から注入する。実体は `node:fs/promises` の
 * `realpath` を渡す想定だが、ここではvscodeは一切importしないため、テストではフェイクの
 * 関数を差し替えるだけで確かめられる。
 */
export async function verifyRealPathWithinWorkspace(
  absolutePath: string,
  workspaceRoots: readonly string[],
  realpath: (p: string) => Promise<string>,
): Promise<DiffPathResolution> {
  const realRoots = await resolveRealRoots(workspaceRoots, realpath);
  if (realRoots.length === 0) {
    return { ok: false, error: 'ワークスペースの場所を確認できません' };
  }

  let target = absolutePath;
  let suffix = '';
  // パスの深さ以上には遡らない（循環・異常な入力での無限ループを避ける保険）
  for (let i = 0; i < MAX_ANCESTOR_LOOKUPS; i++) {
    let real: string | undefined;
    try {
      real = await realpath(target);
    } catch {
      real = undefined;
    }
    if (real !== undefined) {
      const combined = suffix === '' ? real : path.join(real, suffix);
      const inside = realRoots.some((root) => isWithin(root, combined));
      return inside
        ? { ok: true, absolutePath: combined }
        : {
            ok: false,
            error: `ワークスペースの外を指しています（シンボリックリンク経由の可能性があります）: ${absolutePath}`,
          };
    }
    const parent = path.dirname(target);
    if (parent === target) {
      return { ok: false, error: `対象の場所を確認できません: ${absolutePath}` };
    }
    suffix = suffix === '' ? path.basename(target) : path.join(path.basename(target), suffix);
    target = parent;
  }
  return { ok: false, error: `対象の場所を確認できません: ${absolutePath}` };
}

const MAX_ANCESTOR_LOOKUPS = 64;

async function resolveRealRoots(
  workspaceRoots: readonly string[],
  realpath: (p: string) => Promise<string>,
): Promise<string[]> {
  const result: string[] = [];
  for (const root of workspaceRoots) {
    try {
      result.push(await realpath(root));
    } catch {
      // ルート自体が読めない（マウント外れ等）。そのルートは対象から外す
    }
  }
  return result;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
