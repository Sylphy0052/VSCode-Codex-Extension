/**
 * レビュー材料の実体化（Issue #926 E）。
 *
 * これまでAdvisorのセッションは、親セッションと同じ作業ディレクトリで開いていた。
 * プロンプトでは「押下時点のスナップショットを正本として扱え」と伝えていたが、`cwd` には
 * **実行中に人が書き換え続けている作業ツリー**がそのまま見えていた。read-onlyサンドボックスは
 * Advisor自身の書き込みを止めるだけで、読むことは止めない。文面での約束と、そこに置いてある
 * ものが食い違っていた。
 *
 * ここでは、押下時点で固定した材料だけを一時ディレクトリへ書き出し、Advisorのセッションを
 * **その中で**開く。中身は次の2つ。
 *
 * - `changes.diff` — 押下時点の差分の全量（プロンプトへ載せる分は上限で切られるが、これは切らない）
 * - `base/<パス>` — 変更対象ファイルの `baseCommit` 時点の内容
 *
 * `afterTree` を渡した場合はこれに `after/` が加わる（Issue #1047 条件C-repo）。押下時点の
 * リポジトリ全体の写しで、差分が触っていないファイルもここから読める。**既定では作らない。**
 *
 * **保証できることとできないこと**（design.md §14.80 に同じ内容を残す）。
 *
 * - 保証する: 既定でAdvisorの目に入るのは、押下時点で固定した材料だけである
 * - 保証しない: 絶対パスや `..` で作業ツリーへ到達することは止められない。codex-cli 0.148.0 の
 *   `read-only` サンドボックスには読み取り先を限定する指定が無く、CLI側にファイル読み取りを
 *   禁じる手段も無い。「見せない」ではなく「既定で目に入る場所を材料だけにする」対策である
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Logger } from '../log';
import type { GitCommandRunner } from '../orchestrator/worktree';

import { createFrozenAfterTree } from './afterTree';
import { isInsideRoot, type UntrackedFile, type UntrackedOmission } from './untracked';
import { redactCredentials } from './redact';

/** 一時ディレクトリ名の接頭辞。取り残しの掃除は、この接頭辞を持つものだけを対象にする。 */
export const REVIEW_BUNDLE_PREFIX = 'review-bundle-';

/** 差分の全量を置くファイル名。プロンプトの固定指示から名指しする。 */
export const REVIEW_BUNDLE_DIFF_FILE = 'changes.diff';

/** ベース側の内容を置くディレクトリ名。プロンプトの固定指示から名指しする。 */
export const REVIEW_BUNDLE_BASE_DIR = 'base';

/**
 * 未追跡ファイルの内容を置くディレクトリ名（Issue #1322）。
 *
 * `changes.diff` には未追跡ファイルが含まれない（`git diff` が出力しない）。差分を目次へ
 * 置き換えたときに未追跡ファイルだけ本文へ貼り続けると、最大100KBがそのまま残る。参照先を
 * 作るためにここへ書き出す。
 *
 * `after/` とは別に置く。あちらは設定で切れるうえ、資格情報を見つけたときは丸ごと作られない
 * （Issue #1171）。プロンプトが名指しする参照先が、設定と押下時の内容で消えたり残ったり
 * するのは避ける。
 */
export const REVIEW_BUNDLE_UNTRACKED_DIR = 'untracked';

/**
 * 押下時点のリポジトリ全体の写しを置くディレクトリ名（Issue #1047 条件C-repo）。
 *
 * {@link CreateReviewBundleRequest.afterTree} を渡したときだけ実体化する。**拡張本体は既定で
 * 渡す**（設定 `agent.secondOpinion.afterTree`、Issue #1062）。Issue #1060 の実測で、条件Aの
 * 材料からは到達できなかった正解ラベル4件のうち3件をこの写しが拾ったため。評価ハーネス
 * （`test/bench/secondOpinionEval/`）は条件ごとに渡す・渡さないを切り替える。
 */
export const REVIEW_BUNDLE_AFTER_DIR = 'after';

/**
 * 2世代目以降の材料を置くディレクトリ名（Issue #975）。
 *
 * 相談の途中で材料を最新へ更新しても、Advisorのセッションの作業ディレクトリは
 * 開いた時点で固定されており、後から差し替えられない。そこで**同じbundleの中へ
 * 世代を積む**形にする。`updates/<世代>/changes.diff` と `updates/<世代>/base/` は、
 * 1世代目の `changes.diff` / `base/` と同じ構造である。
 *
 * 古い世代を消さないのは、更新の前後で何が変わったのかをAdvisor自身が読めるように
 * するためである。まとめて消えるのはbundleを `dispose()` するときで、経路は
 * 1世代しか無かったときと変わらない。
 */
export const REVIEW_BUNDLE_UPDATES_DIR = 'updates';

/** 1世代目の世代番号。書き出しのたびに1つ増える。 */
export const FIRST_REVIEW_BUNDLE_REVISION = 1;

/**
 * 1つのbundleへ書き出せる世代の上限（Issue #975）。
 *
 * 1世代あたり `changes.diff` と `base/` で最大8MiB強を使う。相談は無操作30分で閉じるが、
 * 押し続ければ世代は増え続けるため、一時領域を使い切る前に断る。上限に達したら古い世代を
 * 黙って消すのではなく更新を断る——消すと、Advisorが既に読んだ材料が会話の途中で
 * 消えることになる。
 */
export const MAX_REVIEW_BUNDLE_REVISIONS = 10;

/**
 * `base/` へ書き出す1ファイルの上限。
 *
 * 超えるものは置かない。差分そのものは `changes.diff` に全量あるため、ベース側の全文が
 * 無くても判断はできる。巨大な自動生成ファイルのために一時領域を使い切る方が害が大きい。
 */
export const MAX_BASE_FILE_BYTES = 512 * 1024;

/** `base/` 全体の上限。 */
export const MAX_BASE_TOTAL_BYTES = 8 * 1024 * 1024;

/**
 * 取り残しを消すまでの時間（24時間）。
 *
 * 拡張機能が異常終了すると `dispose()` が走らず、一時ディレクトリが残る。次回の起動時に、
 * 十分に古いものだけを消す。走っている別ウィンドウのbundleを巻き込まないよう、時間で切る。
 */
export const STALE_REVIEW_BUNDLE_MS = 24 * 60 * 60_000;

/** 実体化した材料。**受け取った側が {@link dispose} の責任を持つ。** */
export interface ReviewBundle {
  /** Advisorのセッションを開く作業ディレクトリ。 */
  readonly dir: string;
  /**
   * 写しの説明ファイルの、写しのルートからの相対名（Issue #1103）。写しを作らなかったときは
   * `undefined`。
   *
   * 同じ名前がリポジトリにcommitされていると既定の名前が使えないため、プロンプトで名指し
   * する側はこの値を使う（`afterTree.ts`）。
   */
  readonly afterTreeNoticeFile?: string | undefined;
  /**
   * 写しを頼まれたのに作らなかった理由（Issue #1171）。`credentials` は、写しの材料
   * （`applyDiff`・未追跡ファイル）に資格情報らしき値があったため。写しは伏せるとパッチが
   * 当たらず再現性が壊れるので、伏せる代わりに作らない。作ったときと頼まれていないときは
   * `undefined`。
   */
  readonly afterTreeOmitted?: 'credentials' | undefined;
  /** 中身ごと消す。冪等。 */
  dispose(): Promise<void>;
}

/**
 * 1世代ぶんの材料の中身。1世代目も2世代目以降も同じものを書き出す。
 */
export interface ReviewMaterialSource {
  /** 親セッションの作業ディレクトリ。`git show` をここで実行する。 */
  cwd: string;
  git: GitCommandRunner;
  /** 取得時に解決したコミット。ここから読む内容は不変である。 */
  baseCommit: string;
  /** 取得時点の差分の全量（上限で切る前のもの）。 */
  fullDiff: string;
  /** 変更対象のパス一覧（workspace rootからの相対）。 */
  changedPaths: readonly string[];
  /**
   * 押下時に読み終えた未追跡ファイル（Issue #1322）。`untracked/<パス>` へ書き出す。
   *
   * 渡さなければ `untracked/` を作らない。差分を本文へ全文貼る設定（`inline` 固定）では
   * 参照先が要らないため、呼び出し側は渡さなくてよい。
   */
  untrackedFiles?: readonly UntrackedFile[] | undefined;
  log?: Logger | undefined;
}

/**
 * 押下時点のリポジトリ全体の写しを、bundleの中へ足すための材料（Issue #1047 条件C-repo）。
 *
 * `changes.diff` と同じ押下時点の材料から組み立てる。ここで `git diff` を打ち直さないのは、
 * 打ち直した時点の作業ツリーが混ざると、写しと `changes.diff` が別の時点を指すためである。
 */
export interface ReviewBundleAfterTreeSource {
  /**
   * `git apply` へ通せる形の差分（`ReviewMaterial.applyDiff`）。
   *
   * {@link ReviewMaterialSource.fullDiff} とは別に受け取る。`fullDiff` は表示・保存用で、
   * binaryのhunkや `diff.noprefix` の設定次第でそのままでは当たらない（Issue #1047 で実測）。
   */
  applyDiff: string;
  /** 押下時に読み終えた未追跡ファイル。 */
  untrackedFiles?: readonly UntrackedFile[];
  /** 押下時に内容を読めなかった未追跡ファイル。写しには置けないので欠落として記録する。 */
  untrackedOmissions?: readonly UntrackedOmission[];
}

export interface CreateReviewBundleRequest extends ReviewMaterialSource {
  /** bundleを作る親ディレクトリ（拡張機能のstorage配下）。無ければ作る。 */
  root: string;
  /**
   * 渡すと `after/` へ押下時点のリポジトリ全体の写しを作る（Issue #1047 条件C-repo）。
   *
   * 省略時は何も作らない。**渡した場合、写しの構築に失敗したらbundleごと作らない。**
   * 半端な写しは「baseのままの箇所」と「afterになった箇所」が混ざり、どちらなのかAdvisorにも
   * 人にも区別できない（`afterTree.ts`）。呼び出し側は写し無しでやり直すか、相談自体をやめる
   * かを選ぶ。
   */
  afterTree?: ReviewBundleAfterTreeSource | undefined;
}

const LOG_PREFIX = '[secondOpinion]';

/**
 * bundleを置く既定の親ディレクトリ。
 *
 * OSの一時領域の下に専用の名前で1段掘る。掃除（{@link removeStaleReviewBundles}）が
 * 一時領域そのものを走査しないようにするためで、走査対象を自分が作ったものだけに閉じる。
 */
export function defaultReviewBundleRoot(): string {
  return path.join(os.tmpdir(), 'vscode-codex-review-bundles');
}

/**
 * 材料を置かない空のbundleを作る。
 *
 * 追加資料が「作業ツリーの変更」以外のときに使う。材料はプロンプトの中で完結しており、
 * 作業ディレクトリに置くものは無い——が、**親セッションの作業ツリーを `cwd` にしない**という
 * 一点のためだけに、空のディレクトリを作る意味がある。
 */
export async function createEmptyReviewBundle(root: string): Promise<ReviewBundle> {
  const dir = await makeBundleDir(root);
  return bundleAt(dir);
}

/**
 * 押下時点の材料を一時ディレクトリへ書き出す。
 *
 * `git show <baseCommit>:<path>` はコミット済みの内容を読むため、実行が遅れても内容は
 * 変わらない（作業ツリーを読む `git diff` と違い、ここに時間の競合は無い）。
 *
 * ベース側を書けなかったファイルは黙って飛ばす。新規追加ファイルには `baseCommit` 時点の
 * 内容が存在せず、これは異常ではない。差分は `changes.diff` に全量あるため、ベース側が
 * 欠けていてもレビューは成立する。
 */
export async function createReviewBundle(
  request: CreateReviewBundleRequest,
): Promise<ReviewBundle> {
  const dir = await makeBundleDir(request.root);
  const bundle = bundleAt(dir);
  try {
    await writeMaterialInto(dir, request);
    if (request.afterTree !== undefined) {
      const hits = afterTreeCredentialHits(request.afterTree);
      if (hits > 0) {
        // 写しは `git apply` と未追跡ファイルの実体化でできており、伏せるとパッチが当たらない。
        // 伏せられないものは相談先へ見せない（Issue #1171）。差分とベース側は伏せて置いてある
        request.log?.warn(
          `${LOG_PREFIX} 押下時点の写しに資格情報らしき値が${hits}件あるため、写しを作りません（差分とベース側だけで続けます）`,
        );
        return { ...bundle, afterTreeOmitted: 'credentials' };
      }
      // 写しの `dispose` は持ち回らない。bundleの `dispose` がディレクトリごと消すので、
      // 別に持つと同じ場所を二度消すことになる
      const tree = await createFrozenAfterTree({
        dir: path.join(dir, REVIEW_BUNDLE_AFTER_DIR),
        cwd: request.cwd,
        git: request.git,
        baseCommit: request.baseCommit,
        applyDiff: request.afterTree.applyDiff,
        ...(request.afterTree.untrackedFiles === undefined
          ? {}
          : { untrackedFiles: request.afterTree.untrackedFiles }),
        ...(request.afterTree.untrackedOmissions === undefined
          ? {}
          : { untrackedOmissions: request.afterTree.untrackedOmissions }),
        log: request.log,
      });
      return { ...bundle, afterTreeNoticeFile: tree.noticeFile };
    }
    return bundle;
  } catch (e) {
    // 途中まで書いたディレクトリを残さない
    await bundle.dispose();
    throw e;
  }
}

/**
 * 写しの材料に含まれる、資格情報らしき値の件数（Issue #1171）。
 *
 * 写しに入るのは `applyDiff` を当てた結果と未追跡ファイルの中身。`baseCommit` 時点の追跡
 * ファイル全体（`git checkout-index` で出す）は走査しない——コミット済みの内容であり、本流の
 * セッションも同じものを読む。
 */
export function afterTreeCredentialHits(afterTree: ReviewBundleAfterTreeSource): number {
  const untracked = afterTree.untrackedFiles ?? [];
  return untracked.reduce(
    (total, file) => total + redactCredentials(file.content).total,
    redactCredentials(afterTree.applyDiff).total,
  );
}

/**
 * 相談の途中で、新しい世代の材料を同じbundleへ書き足す（Issue #975）。
 *
 * 書き出し先は `updates/<revision>/` で、中身の構造は1世代目と同じである。Advisorの
 * セッションは開いた時点の作業ディレクトリから動かせないため、材料の差し替えではなく
 * **同じ場所への追加**という形にしている。
 *
 * 同じ世代番号で二度呼ばれたときは、先に置いてあったものを消してから書く。前回の書き出しが
 * 途中で失敗して呼び直された場合に、古い断片と新しい内容が混ざったディレクトリを残さない。
 *
 * 失敗したらその世代のディレクトリごと消して投げる。**半端な世代をAdvisorへ見せない。**
 * 1世代目と違い、ここで失敗してもbundle自体は生き続ける（相談は続けられる）。
 *
 * @returns 書き出したディレクトリの、bundleのルートからの相対パス（プロンプトで名指しする）
 */
export async function appendReviewBundleRevision(
  bundleDir: string,
  revision: number,
  source: ReviewMaterialSource,
): Promise<string> {
  if (!Number.isSafeInteger(revision) || revision <= FIRST_REVIEW_BUNDLE_REVISION) {
    // 呼び出し側が採番するが、`updates/<revision>` はそのままパスになる。整数以外や
    // 1世代目以下を受け取ったまま組み立てない
    throw new Error(`世代の番号が不正です（revision=${revision}）`);
  }
  const relative = reviewBundleRevisionPath(revision);
  const dir = path.join(bundleDir, REVIEW_BUNDLE_UPDATES_DIR, String(revision));
  if (!isInsideRoot(dir, bundleDir)) {
    // 世代番号は内部で採番するため通常は起こらないが、パスの組み立てがbundleの外を
    // 指したまま書き込む経路を残さない
    throw new Error(`世代の書き出し先がレビュー材料の外を指しています（revision=${revision}）`);
  }
  try {
    // 世代番号は再利用しないので、通常ここに既存のディレクトリは無い。それでも消してから
    // 作るのは、異常終了で番号だけ進まなかった場合に古い断片が残るのを防ぐため
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    await writeMaterialInto(dir, source);
    return relative;
  } catch (e) {
    // `mkdir` が途中まで作ってから失敗した場合も含めて消す（try の外に置くと拾えない）
    await fs.rm(dir, { recursive: true, force: true });
    throw e;
  }
}

/** 世代の材料を置くディレクトリの、bundleのルートからの相対パス。 */
export function reviewBundleRevisionPath(revision: number): string {
  return `${REVIEW_BUNDLE_UPDATES_DIR}/${revision}`;
}

/**
 * 材料の中身を1つのディレクトリへ書き出す。
 *
 * ベース側を書けなかったファイルは黙って飛ばす。新規追加ファイルには `baseCommit` 時点の
 * 内容が存在せず、これは異常ではない。差分は `changes.diff` に全量あるため、ベース側が
 * 欠けていてもレビューは成立する。
 */
async function writeMaterialInto(dir: string, source: ReviewMaterialSource): Promise<void> {
  // 相談先が読める資料には、送信本文と同じ伏せ字を掛けてから置く（Issue #1171）。`changes.diff`
  // は読む用であり `git apply` には使わないため、伏せても成立する
  const diffRedaction = redactCredentials(source.fullDiff);
  let redacted = diffRedaction.total;
  await fs.writeFile(path.join(dir, REVIEW_BUNDLE_DIFF_FILE), diffRedaction.text, 'utf8');
  const baseDir = path.join(dir, REVIEW_BUNDLE_BASE_DIR);
  await fs.mkdir(baseDir, { recursive: true });
  let used = 0;
  let written = 0;
  for (const relative of source.changedPaths) {
    if (used >= MAX_BASE_TOTAL_BYTES) {
      break;
    }
    const target = path.resolve(baseDir, relative);
    // `git` の出したパスであっても、書き出し先が `base/` の外を指さないことは自分で
    // 確かめる。ここを信用すると、パスの解釈の食い違いがそのまま任意の場所への書き込みになる
    if (!isInsideRoot(target, baseDir)) {
      continue;
    }
    const shown = await source.git.run(['show', `${source.baseCommit}:${relative}`], source.cwd);
    if (shown.code !== 0) {
      continue;
    }
    const content = shown.stdout;
    if (content.includes('\0')) {
      // バイナリは `git show` の時点で文字列として壊れている。壊れた写しを置くより
      // 置かない方がよい
      continue;
    }
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_BASE_FILE_BYTES || used + bytes > MAX_BASE_TOTAL_BYTES) {
      continue;
    }
    const baseRedaction = redactCredentials(content);
    redacted += baseRedaction.total;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, baseRedaction.text, 'utf8');
    used += bytes;
    written += 1;
  }
  const untracked = await writeUntrackedInto(dir, source);
  redacted += untracked.redacted;
  source.log?.info(
    `${LOG_PREFIX} bundle material written baseFiles=${written}/${source.changedPaths.length} ` +
      `untrackedFiles=${untracked.written}/${source.untrackedFiles?.length ?? 0} ` +
      `diffChars=${source.fullDiff.length} redacted=${redacted}`,
  );
}

/**
 * 未追跡ファイルの中身を `untracked/<パス>` へ書き出す（Issue #1322）。
 *
 * 中身は押下時に読み終えたものをそのまま使う。ここで読み直さないのは、`base/` と違って
 * 作業ツリーのファイルであり、読み直した時点の内容はスナップショットと別物になりうるため。
 *
 * 書けなかったファイルは黙って飛ばす。プロンプトの一覧には載るので、読みに行って無ければ
 * Advisorには「取得できなかった」と分かる。ここで失敗を投げると、参照先が1件書けないだけで
 * 相談そのものが立ち上がらなくなる。
 */
async function writeUntrackedInto(
  dir: string,
  source: ReviewMaterialSource,
): Promise<{ written: number; redacted: number }> {
  const files = source.untrackedFiles ?? [];
  if (files.length === 0) {
    return { written: 0, redacted: 0 };
  }
  const root = path.join(dir, REVIEW_BUNDLE_UNTRACKED_DIR);
  await fs.mkdir(root, { recursive: true });
  let written = 0;
  let redacted = 0;
  for (const file of files) {
    const target = path.resolve(root, file.path);
    // `base/` と同じ理由で、書き出し先が `untracked/` の外を指さないことを自分で確かめる
    if (!isInsideRoot(target, root)) {
      continue;
    }
    // 相談先が読める資料には送信本文と同じ伏せ字を掛ける（Issue #1171）
    const redaction = redactCredentials(file.content);
    redacted += redaction.total;
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, redaction.text, 'utf8');
      written += 1;
    } catch (e) {
      source.log?.warn(
        `${LOG_PREFIX} 未追跡ファイルを材料へ書き出せませんでした（${file.path}）: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return { written, redacted };
}

/**
 * 取り残したbundleを消す（拡張機能の起動時に1度）。
 *
 * 異常終了で `dispose()` が走らなかった分を回収する。**接頭辞が一致し、かつ十分に古い**
 * ものだけを消す。別ウィンドウで今まさに使われているbundleを消してはならない。
 */
export async function removeStaleReviewBundles(
  root: string,
  now: number,
  maxAgeMs: number = STALE_REVIEW_BUNDLE_MS,
  log?: Logger,
): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    // まだ1度も作っていない
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(REVIEW_BUNDLE_PREFIX)) {
      continue;
    }
    const dir = path.join(root, name);
    try {
      const stat = await fs.stat(dir);
      if (!stat.isDirectory() || now - stat.mtimeMs < maxAgeMs) {
        continue;
      }
      await fs.rm(dir, { recursive: true, force: true });
      log?.info(`${LOG_PREFIX} stale bundle removed`);
    } catch (e) {
      log?.warn(
        `${LOG_PREFIX} 取り残したレビュー材料を消せませんでした: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
}

async function makeBundleDir(root: string): Promise<string> {
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(path.join(root, REVIEW_BUNDLE_PREFIX));
}

function bundleAt(dir: string): ReviewBundle {
  let disposed = false;
  return {
    dir,
    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
