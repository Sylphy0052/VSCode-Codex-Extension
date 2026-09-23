import * as path from 'node:path';
import type { GitCommandRunner } from '../orchestrator/worktree';

/**
 * ワークスペースフォルダが属するリポジトリのルートを集める（Issue #1406）。
 *
 * 「後で実施」ビューを開いているリポジトリのセッションだけに絞るために使う。判定はセッションの
 * `cwd`がここで返したルートの配下かどうかで行う（`isWithinAnyRoot`）。セッション側でgitを
 * 呼ばないのは、撤去済みのworktreeなど`cwd`が既に無いセッションも多いため。
 *
 * - gitの作業ツリーなら`--show-toplevel`を入れる。サブディレクトリやリポジトリ内のworktree
 *   （`.worktree/`など）で起動したセッションも配下として拾える
 * - ワークスペース自身がworktreeのときは、`--git-common-dir`（本体の`.git`）の親も入れる。
 *   本体や、兄弟のworktreeで起動したセッションを取りこぼさないため
 * - gitでない、またはgitの呼び出しに失敗したフォルダは、フォルダ自身をルートにする
 */
export async function resolveRepoRoots(
  folders: readonly string[],
  git: GitCommandRunner,
): Promise<string[]> {
  const roots = new Set<string>();
  for (const folder of folders) {
    const result = await git.run(['rev-parse', '--show-toplevel', '--git-common-dir'], folder);
    const [toplevel, commonDir] = result.stdout.trim().split(/\r?\n/u);
    if (result.code !== 0 || toplevel === undefined || toplevel === '') {
      roots.add(folder);
      continue;
    }
    roots.add(toplevel);
    if (commonDir !== undefined && commonDir !== '') {
      const absolute = path.resolve(folder, commonDir);
      // 本体の`.git`ディレクトリのときだけ親をルートにする。ベアリポジトリなど別の形は
      // 親が作業ツリーとは限らないので足さない
      if (path.basename(absolute) === '.git') {
        roots.add(path.dirname(absolute));
      }
    }
  }
  return [...roots];
}
