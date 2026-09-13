/**
 * 1案件ぶんの材料を、条件をまたいで使い回せる形で用意する（Issue #1044）。
 *
 * **材料は案件ごとに1度だけ取る。** 条件ごとに取り直すと、`git diff` を打ち直した時点で
 * 作業ツリーが変わっていた場合に条件間で材料が変わり、差の原因が「介入」なのか「材料」なのか
 * 分からなくなる。Issue #1044 の実験条件「全条件で同一のsnapshotを使う」はここで担保する。
 *
 * **材料は run をまたいでも同じになる。** `baseCommit` だけを指定して作業ツリーを右辺にすると、
 * 同じ案件を後日流し直したときに別の材料になる。ここでは `targetCommit` で detached worktree を
 * 作り、その中で snapshot を取る。作業ツリーの状態に依存しない。
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { nodeGitCommandRunner } from '../../../src/orchestrator/worktree';
import type { SecondOpinionInput, WorkspaceSnapshot } from '../../../src/secondOpinion/prompt';
import { createReviewBundle, type ReviewBundle } from '../../../src/secondOpinion/reviewBundle';
import { captureWorkspaceSnapshot } from '../../../src/secondOpinion/snapshot';
import type { EvalCase, EvalCondition } from './types';

/** 1案件ぶんの、条件をまたいで共有する材料。**使い終わったら {@link dispose} を呼ぶこと。** */
export interface CaseMaterial {
  /** 全条件へ渡す共通の入力。条件はこれを書き換えて使う。 */
  input: SecondOpinionInput;
  /** `after/` を要求しない条件（A / B-pos / B-repeat）の作業ディレクトリ。 */
  cwd: string;
  /**
   * その条件でAdvisorのセッションを開く作業ディレクトリ（Issue #1047）。
   *
   * `EvalCondition.needsAfterTree` の条件だけ、`after/` を持つ別のbundleを返す。**同じbundleを
   * 使い回さない。** 写しを1つのbundleへ置くと、固定指示が名指ししていない条件Aでも `ls` で
   * 見つけられてしまい、条件Aが「差分だけを見た場合」の測定でなくなる。
   */
  cwdFor(condition: EvalCondition): string;
  /** 実際に使われたベースコミット。記録用。 */
  baseCommit: string;
  dispose(): Promise<void>;
}

export type PrepareMaterialResult =
  { ok: true; material: CaseMaterial } | { ok: false; reason: string };

/**
 * 案件から材料を作る。
 *
 * 本体（`secondOpinionCommand.ts`）と同じ関数を呼ぶ。ここでsnapshotの取り方やbundleの構造を
 * 書き直すと、測定対象が本体からずれる。
 */
export async function prepareCaseMaterial(
  evalCase: EvalCase,
  conditions: readonly EvalCondition[] = [],
): Promise<PrepareMaterialResult> {
  // 後片付けを1か所へ集める。途中で失敗した場合も、それまでに作ったものを逆順で片付ける
  const cleanups: (() => Promise<void>)[] = [];
  const cleanup = async (): Promise<void> => {
    for (const dispose of [...cleanups].reverse()) {
      await dispose();
    }
  };
  const fail = async (reason: string): Promise<PrepareMaterialResult> => {
    await cleanup();
    return { ok: false, reason };
  };

  const checkout = await createDetachedWorktree(evalCase);
  if (!checkout.ok) {
    return { ok: false, reason: checkout.reason };
  }
  cleanups.push(checkout.dispose);

  const captured = await captureWorkspaceSnapshot(checkout.dir, nodeGitCommandRunner, {
    baseCommit: evalCase.baseCommit,
  });
  if (!captured.ok) {
    return await fail(captured.reason);
  }

  const input = buildInput(evalCase, captured.snapshot);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'second-opinion-eval-'));
  cleanups.push(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const common = {
    root,
    cwd: checkout.dir,
    git: nodeGitCommandRunner,
    baseCommit: captured.snapshot.baseCommit,
    fullDiff: captured.material.fullDiff,
    changedPaths: captured.material.changedPaths,
  };

  let bundle: ReviewBundle;
  try {
    bundle = await createReviewBundle(common);
  } catch (e) {
    return await fail(
      `レビュー材料を書き出せませんでした: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  cleanups.push(() => bundle.dispose());

  let afterTreeBundle: ReviewBundle | undefined;
  if (conditions.some((condition) => condition.needsAfterTree === true)) {
    const applyDiff = captured.material.applyDiff;
    if (applyDiff === undefined) {
      // 空文字列（未追跡だけの変更）とは区別する。取得に失敗したまま空として扱うと、
      // 中身がbaseと同じ木を「押下時点の写し」として渡すことになる
      return await fail('`git apply` へ通せる差分を取れなかったため、`after/` を作れません');
    }
    try {
      afterTreeBundle = await createReviewBundle({ ...common, afterTree: { applyDiff } });
    } catch (e) {
      // 写しの構築は fail-close（`afterTree.ts`）。半端な木で条件C-repoを流すと、
      // 「baseのままの箇所」と「afterになった箇所」が混ざった材料を測ることになる
      return await fail(
        `押下時点の写し（after/）を作れませんでした: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    cleanups.push(() => afterTreeBundle?.dispose() ?? Promise.resolve());
  }

  return {
    ok: true,
    material: {
      input,
      cwd: bundle.dir,
      cwdFor(condition: EvalCondition): string {
        if (condition.needsAfterTree !== true) {
          return bundle.dir;
        }
        if (afterTreeBundle === undefined) {
          // 条件一覧を渡さずに呼ばれた場合。写しの無いbundleを黙って返すと、Advisorは
          // 名指しされたディレクトリを探しに行って空振りし、その結果が条件C-repoとして残る
          throw new Error(
            `条件 ${condition.id} は after/ を要求しますが、材料の用意時に渡されていません`,
          );
        }
        return afterTreeBundle.dir;
      },
      baseCommit: captured.snapshot.baseCommit,
      dispose: cleanup,
    },
  };
}

type WorktreeResult =
  { ok: true; dir: string; dispose: () => Promise<void> } | { ok: false; reason: string };

/**
 * `targetCommit` の detached worktree を作る。
 *
 * 案件のリポジトリそのものでは snapshot を取らない。`git diff <base>` の右辺は作業ツリーなので、
 * 実行時点の未コミットの変更やブランチの切り替えがそのまま材料へ混ざる。測定を後日やり直したとき
 * に同じ材料へならないと、条件間の差以前に run 間の比較が成立しない。
 */
async function createDetachedWorktree(evalCase: EvalCase): Promise<WorktreeResult> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'second-opinion-eval-src-'));
  const removeDir = async (): Promise<void> => {
    await fs.rm(dir, { recursive: true, force: true });
  };
  const added = await nodeGitCommandRunner.run(
    ['worktree', 'add', '--detach', dir, evalCase.targetCommit],
    evalCase.repoPath,
  );
  if (added.code !== 0) {
    await removeDir();
    return {
      ok: false,
      reason:
        `${evalCase.targetCommit} のworktreeを作れませんでした` +
        `（${evalCase.repoPath}）: ${added.stderr.trim() || added.stdout.trim()}`,
    };
  }
  return {
    ok: true,
    dir,
    async dispose(): Promise<void> {
      // `--force` を付けるのは、bundle生成などで作業ツリーへ何か書かれていても撤去するため。
      // 撤去に失敗すると `git worktree list` へ残り続け、次のrunで同じパスが使えなくなる
      await nodeGitCommandRunner.run(['worktree', 'remove', '--force', dir], evalCase.repoPath);
      await removeDir();
    },
  };
}

/**
 * 共通の入力を組み立てる。
 *
 * 背景は案件が持つ本文をそのまま渡し、要約セッションは開かない。実行のたびに要約を作り直すと、
 * 要約の揺らぎが条件間の差へ混ざるためである。**そのぶん、この条件Aは「本番そのまま」ではない**。
 * 本番では長い会話は要約セッションを通るので、本番相当にしたい案件は、本番経路で一度作った要約を
 * `conversation` へ貼り `conversationKind: 'summary'` を指定する（案件側の責任）。
 */
function buildInput(evalCase: EvalCase, snapshot: WorkspaceSnapshot): SecondOpinionInput {
  const conversation = evalCase.conversation.trim();
  return {
    userRequest: evalCase.userRequest,
    artifact: { kind: 'workspaceChanges', snapshot },
    ...(conversation === ''
      ? {}
      : {
          conversationSummary: conversation,
          conversationBackgroundKind: evalCase.conversationKind,
        }),
  };
}
