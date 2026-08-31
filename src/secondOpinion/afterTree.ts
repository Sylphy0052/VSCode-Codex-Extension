/**
 * 凍結した after-tree の構築（Issue #1047 受入基準1・2・3）。
 *
 * 条件A（`reviewBundle.ts`）がAdvisorへ渡すのは `changes.diff` と `base/<変更対象ファイル>` だけで、
 * **そのPRが触っていないファイルは既定で目に入らない**。#1044 のscreeningでは、primaryと判定した
 * 9件のうち4件が「壊した場所が差分の外」で、条件Aの材料からは到達できなかった。条件C-repoは、
 * そこへ「押下時点の作業ツリーと同じ内容を持つ、書き換わらない木」を足して、Codex自身の探索能力で
 * 依存先・型・設定・既存テストまで辿れるようにする。
 *
 * **本番には `targetCommit` が無い。** `snapshot.ts` が固定するのは `baseCommit` と、そこからの
 * 差分だけで、after側は未コミットの作業ツリーである。コミットとして存在しないので、評価ハーネス
 * （`test/bench/secondOpinionEval/materials.ts`）のように `git worktree add --detach <targetCommit>`
 * で作ることはできない。押下時点の材料から**組み立てる**必要がある。
 *
 * ## 構築方式の比較（実測。design.md「凍結after-treeの構築（Issue #1047）」に同じ表がある）
 *
 * `git archive` / 一時index / detached worktree / `cat-file` の4系統を、このリポジトリ
 * （583ファイル・11.2MB）と、binary・symlink・実行bitを含む使い捨てリポジトリで実測した。
 *
 * | 方式 | 時間 | `.git`混入 | objectDBへの書込 | 追加依存 |
 * | --- | --- | --- | --- | --- |
 * | A `git archive` + tar展開 + `git apply` | 0.53s | 無し | 0 | **tar展開器とbinary stdout** |
 * | B 一時index + `apply --cached` + `write-tree` + `checkout-index` | 0.36s | 無し | **blob+tree** | 無し |
 * | B' 一時index + `checkout-index` + 展開先で `git apply` | **0.20s** | 無し | **0** | 無し |
 * | C detached worktree + `apply` + `.git`除外コピー | 0.59s | **要除外** | 0 | 無し |
 *
 * **採ったのはB'。** 決め手は次の2つ。
 *
 * - **Aは実装できない。** `GitCommandRunner` は `stdout` を文字列で返す。tarをここに通すと
 *   binaryが壊れる。binary対応の実行系とtar展開器（`package.json` の実行時依存は `yaml` だけ）を
 *   両方足すことになる。`checkout-index --prefix` はgitが直接ファイルを書くので、どちらも要らない
 * - **B/EはユーザーのobjectDBへ書く。** `apply --cached` と `add -A` は after 側の内容をblobとして
 *   書き出す（使い捨てリポジトリで実測: それぞれ +2 object）。`git add -N` を避けた `untracked.ts` と
 *   同じ理由で、人が作業している最中のリポジトリへ書き込む経路は作らない。B' の書込は **0**
 *
 * Bの利点だった「`write-tree` が返す tree SHA で凍結を検証できる」は、objectDBへ書く代償に
 * 見合わないと判断した。B'では代わりに、ベースコミット・ファイル数・欠落を `.frozen-after-tree.txt` に残す。
 *
 * 一時indexは `GIT_INDEX_FILE` でしか指定できないため、`GitCommandRunner` に環境変数の口を足した
 * （`GitCommandOptions`）。**本物のindexも作業ツリーも書き換えない**ことは実測で確かめてある。
 *
 * ## live workspace を参照しない（受入基準2）
 *
 * この関数が読むのは次の3つだけで、いずれも押下時点で固定済みである。
 *
 * - `baseCommit` — 不変のコミット。`read-tree` / `checkout-index` はここからしか読まない
 * - `applyDiff` — 押下時に取った差分の文字列。**引数として受け取る**（ここで `git diff` を打ち直さない）
 * - `untrackedFiles` — 押下時に `untracked.ts` の安全確認を通して読み終えた内容
 *
 * 実行時に作業ツリーを読むgitコマンドは無い。`git apply` の実行場所は展開先で、`--3way` を
 * 使わないので `cwd` 側のリポジトリを見ることもない。
 *
 * ## fail-open しない（受入基準3）
 *
 * 差分の適用に失敗したら**途中まで実体化した木を返さない**。半端な木は「baseのままの箇所」と
 * 「afterになった箇所」が混ざり、どちらなのかAdvisorにも人にも区別できない。失敗したら
 * ディレクトリごと消して投げ、呼び出し側は条件Aの材料だけで進むか、相談自体をやめるかを選ぶ。
 *
 * 未追跡ファイルは押下時点で既に予算・型・パスの検査を通っており、そこで落ちたものは
 * 内容が手元に無い。**落ちたことを黙って飲まない**ために、実体化できなかったパスは
 * {@link FrozenAfterTree.omissions} で返し、木の中の `.frozen-after-tree.txt` にも書く。
 * Advisorが木を「押下時点の全部」と読むことを防ぐのが目的である。
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Logger } from '../log';
import type { GitCommandRunner } from '../orchestrator/worktree';
import { isInsideRoot, type UntrackedFile, type UntrackedOmission } from './untracked';

/** 木の中に置く説明ファイル。Advisorがこの木の性質と欠落を読めるようにする。 */
export const FROZEN_AFTER_TREE_NOTICE_FILE = '.frozen-after-tree.txt';

/** 一時indexとパッチを置く作業ディレクトリの接頭辞。**after-treeの中には置かない**。 */
const WORK_DIR_PREFIX = 'after-tree-work-';

const LOG_PREFIX = '[secondOpinion]';

/** 実体化できなかったもの1件。 */
export interface FrozenAfterTreeOmission {
  /** workspace rootからの相対パス。 */
  path: string;
  /**
   * 落ちた理由。
   *
   * - `untracked-not-captured`: 押下時点で内容を読めていない（binary・予算超過・型・権限）。
   *   `untracked.ts` の判定理由を {@link detail} へそのまま持つ
   * - `unsafe-path`: 書き出し先が木の外を指した
   */
  reason: 'untracked-not-captured' | 'unsafe-path';
  detail?: string | undefined;
}

/** 実体化した after-tree。**受け取った側が {@link dispose} の責任を持つ。** */
export interface FrozenAfterTree {
  /** 木のルート。中身はリポジトリのルートと同じ並びになる。 */
  readonly dir: string;
  /** 実体化できなかったもの。空とは限らない。 */
  readonly omissions: readonly FrozenAfterTreeOmission[];
  /** 実体化したファイル数（未追跡ぶんを含む）。 */
  readonly fileCount: number;
  /** 中身ごと消す。冪等。 */
  dispose(): Promise<void>;
}

export interface CreateFrozenAfterTreeRequest {
  /**
   * 木を作る場所（絶対パス）。無ければ作る。
   *
   * **既に中身があるときは断る。** 呼び出し側が決めるパスをこちらが中身も見ずに消すと、
   * 渡し間違いがそのままデータの消失になる。
   */
  dir: string;
  /** gitコマンドを実行する場所（親セッションのworkspace root）。読むのは `baseCommit` だけ。 */
  cwd: string;
  git: GitCommandRunner;
  /** 押下時に解決したコミット。 */
  baseCommit: string;
  /**
   * 押下時に取った差分。**`--binary` 付きで取ったものを渡すこと。**
   *
   * `git diff` の既定はbinaryの中身を出さず `Binary files a/x and b/x differ` の1行になり、
   * これを `git apply` へ渡すと `cannot apply binary patch to 'x' without full index line` で
   * 失敗する（実測）。`snapshot.ts` の `ReviewMaterial.applyDiff` がこの形で取る。
   */
  applyDiff: string;
  /** 押下時に読み終えた未追跡ファイル。 */
  untrackedFiles?: readonly UntrackedFile[];
  /** 押下時に内容を読めなかった未追跡ファイル。木には置けないので欠落として記録する。 */
  untrackedOmissions?: readonly UntrackedOmission[];
  log?: Logger | undefined;
}

/** 構築に失敗した理由を、呼び出し側がログへ出せる形で持つ。 */
export class FrozenAfterTreeError extends Error {
  constructor(
    message: string,
    readonly step: 'read-tree' | 'checkout-index' | 'apply' | 'write',
    readonly gitStderr?: string,
  ) {
    super(message);
    this.name = 'FrozenAfterTreeError';
  }
}

/**
 * 押下時点の材料から、凍結した after-tree を実体化する。
 *
 * 失敗したら {@link FrozenAfterTreeError} を投げ、作りかけのディレクトリは残さない。
 */
export async function createFrozenAfterTree(
  request: CreateFrozenAfterTreeRequest,
): Promise<FrozenAfterTree> {
  const { dir, cwd, git, baseCommit, applyDiff } = request;
  // 相対パスだと `checkout-index --prefix` と `GIT_CEILING_DIRECTORIES` の両方が
  // 意図した場所を指さない（後者は絶対パス以外を黙って無視する）
  if (!path.isAbsolute(dir)) {
    throw new FrozenAfterTreeError(`after-treeの作成先が絶対パスではありません（${dir}）`, 'write');
  }
  // 一時indexとパッチはOSの一時領域へ置く。木の中へ置くと、Advisorが材料として読んでしまう
  const work = await fs.mkdtemp(path.join(os.tmpdir(), WORK_DIR_PREFIX));
  const removeWork = async (): Promise<void> => {
    await fs.rm(work, { recursive: true, force: true });
  };
  const removeTree = async (): Promise<void> => {
    await fs.rm(dir, { recursive: true, force: true });
  };

  // 既存のディレクトリを消してから作る、はしない。`dir` は呼び出し側が決めるパスで、
  // 中身を見ずに消す経路を作ると、渡し間違いがそのままデータの消失になる。空でなければ断り、
  // **断った場合はこの関数が消しに行かない**（下の `catch` は空だと確かめた後だけ動く）
  await fs.mkdir(dir, { recursive: true });
  if ((await fs.readdir(dir)).length > 0) {
    await removeWork();
    throw new FrozenAfterTreeError(`after-treeの作成先が空ではありません（${dir}）`, 'write');
  }

  try {
    const indexFile = path.join(work, 'index');
    // `GIT_DIR` / `GIT_WORK_TREE` は消す。gitのhookなどから拡張機能が起動された場合、
    // 親プロセスにこれらが残っていると `cwd` ではない別のリポジトリを触る
    const indexEnv = {
      GIT_INDEX_FILE: indexFile,
      GIT_DIR: undefined,
      GIT_WORK_TREE: undefined,
    };

    // 改行の変換を止める（`core.autocrlf` はWindowsのgitで既定が `true`）。`git diff` の出力は
    // blobの内容（LF）を基準にするのに対し、`checkout-index` は変換して書くため、変換したまま
    // だと当てる側と当てられる側で改行が食い違い、Windowsでだけ `git apply` が必ず落ちる。
    // ここで作るのは読ませるための写しであって、人が編集する作業ツリーではない
    const noEolConversion = ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf'];

    const readTree = await git.run([...noEolConversion, 'read-tree', `${baseCommit}^{tree}`], cwd, {
      env: indexEnv,
    });
    if (readTree.code !== 0) {
      throw new FrozenAfterTreeError(
        `after-treeのベース（${baseCommit.slice(0, 8)}）を読めませんでした`,
        'read-tree',
        readTree.stderr.trim(),
      );
    }

    // `--prefix` は末尾の区切りまで含めて連結される。区切りは `/` に揃える
    // （Windowsのgitも `/` を受け付ける。`\` は接頭辞としてそのまま連結されて壊れる）
    const prefix = `${dir.replace(/\\/gu, '/')}/`;
    const checkout = await git.run(
      [...noEolConversion, 'checkout-index', '-a', '-f', '--prefix', prefix],
      cwd,
      { env: indexEnv },
    );
    if (checkout.code !== 0) {
      throw new FrozenAfterTreeError(
        'after-treeのベース側を書き出せませんでした',
        'checkout-index',
        checkout.stderr.trim(),
      );
    }

    await applyPinnedDiff(dir, work, git, applyDiff);

    const omissions = await writeUntracked(dir, request);
    const fileCount = await countFiles(dir);
    await writeNotice(dir, request, omissions, fileCount);

    request.log?.info(
      `${LOG_PREFIX} frozen after-tree built base=${baseCommit.slice(0, 8)} ` +
        `files=${fileCount} omissions=${omissions.length}`,
    );

    return {
      dir,
      omissions,
      fileCount,
      async dispose(): Promise<void> {
        await removeTree();
      },
    };
  } catch (e) {
    // 半端な木を残さない。呼び出し側は「木が無い」ことだけを見て条件Aへ落とせる
    await removeTree();
    throw e;
  } finally {
    await removeWork();
  }
}

/**
 * 押下時点の差分を展開先へ当てる。
 *
 * `cwd` は展開先である。`git apply` はリポジトリの外でも動くが、展開先の**上位**に
 * リポジトリがあると、そちらを見つけてindexやattributesを参照しうる。
 * `GIT_CEILING_DIRECTORIES` で探索を展開先の親で止め、`GIT_DIR` 等も落とす。
 *
 * `--3way` は使わない。フォールバックでbaseのblobを探しに行く経路が増え、
 * 「当たらなかった」ことが「別の当て方で通った」に化ける。**当たらないなら失敗させる。**
 */
async function applyPinnedDiff(
  dir: string,
  work: string,
  git: GitCommandRunner,
  applyDiff: string,
): Promise<void> {
  if (applyDiff.trim() === '') {
    // 差分が無いのはbaseそのものが after である場合で、異常ではない
    return;
  }
  const patch = path.join(work, 'changes.patch');
  await fs.writeFile(patch, applyDiff, 'utf8');
  const applied = await git.run(['apply', '--whitespace=nowarn', patch], dir, {
    env: {
      GIT_CEILING_DIRECTORIES: path.dirname(dir),
      GIT_DIR: undefined,
      GIT_WORK_TREE: undefined,
      GIT_INDEX_FILE: undefined,
    },
  });
  if (applied.code !== 0) {
    throw new FrozenAfterTreeError(
      '押下時点の差分をafter-treeへ当てられませんでした',
      'apply',
      applied.stderr.trim(),
    );
  }
}

/**
 * 押下時に読み終えた未追跡ファイルを木へ置く。
 *
 * 内容は既に手元にあるので、ここで作業ツリーを読み直さない（受入基準2）。押下時に
 * 落ちたものは内容が無いため置けない——**それを欠落として返す**。
 */
async function writeUntracked(
  dir: string,
  request: CreateFrozenAfterTreeRequest,
): Promise<FrozenAfterTreeOmission[]> {
  const omissions: FrozenAfterTreeOmission[] = [];
  for (const file of request.untrackedFiles ?? []) {
    const target = path.resolve(dir, file.path);
    // `git` や押下時の一覧が出したパスでも、書き出し先が木の外を指さないことは自分で確かめる
    if (!isInsideRoot(target, dir)) {
      omissions.push({ path: file.path, reason: 'unsafe-path' });
      continue;
    }
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.content, 'utf8');
    } catch (e) {
      throw new FrozenAfterTreeError(
        `未追跡ファイルをafter-treeへ書けませんでした: ${file.path}`,
        'write',
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  for (const omitted of request.untrackedOmissions ?? []) {
    omissions.push({
      path: omitted.path,
      reason: 'untracked-not-captured',
      detail: omitted.reason,
    });
  }
  return omissions;
}

/**
 * 木の性質と欠落を、木の中の1ファイルへ書く。
 *
 * 欠落が無くても書く。「凍結した写しであって、いま動いているリポジトリではない」ことは
 * 欠落の有無にかかわらず伝える必要がある。
 */
async function writeNotice(
  dir: string,
  request: CreateFrozenAfterTreeRequest,
  omissions: readonly FrozenAfterTreeOmission[],
  fileCount: number,
): Promise<void> {
  const lines = [
    'このディレクトリは、セカンドオピニオンの依頼を押した時点のリポジトリの写しです。',
    '読み取り専用の材料であり、いま動いている作業ツリーではありません。実行しても、',
    'ここに無い依存やビルド結果は解決しません。',
    '',
    `ベースコミット: ${request.baseCommit}`,
    `実体化したファイル数: ${fileCount}`,
    '',
  ];
  if (omissions.length === 0) {
    lines.push('この写しに含めなかったファイルはありません。');
  } else {
    lines.push(
      'この写しに含めなかったファイルがあります。以下は「存在しない」のではなく',
      '「押下時点で内容を取得できなかった」ものです。無いものとして判断しないでください。',
      '',
    );
    for (const omission of omissions) {
      const detail = omission.detail === undefined ? '' : `（${omission.detail}）`;
      lines.push(`- ${omission.path}: ${omission.reason}${detail}`);
    }
  }
  await fs.writeFile(
    path.join(dir, FROZEN_AFTER_TREE_NOTICE_FILE),
    `${lines.join('\n')}\n`,
    'utf8',
  );
}

/** 木の中の通常ファイル数を数える。説明ファイル自身は書く前に数えるので入らない。 */
async function countFiles(dir: string): Promise<number> {
  let count = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (entry.isFile()) {
      count += 1;
    }
  }
  return count;
}
