/**
 * 1案件ぶんの材料を、条件をまたいで使い回せる形で用意する（Issue #1044）。
 *
 * **材料は案件ごとに1度だけ取る。** 条件ごとに取り直すと、`git diff` を打ち直した時点で
 * 作業ツリーが変わっていた場合に条件間で材料が変わり、差の原因が「介入」なのか「材料」なのか
 * 分からなくなる。Issue #1044 の実験条件「全条件で同一のsnapshotを使う」はここで担保する。
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { nodeGitCommandRunner } from '../../../src/orchestrator/worktree';
import type { SecondOpinionInput, WorkspaceSnapshot } from '../../../src/secondOpinion/prompt';
import { createReviewBundle, type ReviewBundle } from '../../../src/secondOpinion/reviewBundle';
import { captureWorkspaceSnapshot } from '../../../src/secondOpinion/snapshot';
import type { EvalCase } from './types';

/** 1案件ぶんの、条件をまたいで共有する材料。**使い終わったら {@link dispose} を呼ぶこと。** */
export interface CaseMaterial {
  /** 全条件へ渡す共通の入力。条件はこれを書き換えて使う。 */
  input: SecondOpinionInput;
  /** Advisorのセッションを開く作業ディレクトリ。 */
  cwd: string;
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
export async function prepareCaseMaterial(evalCase: EvalCase): Promise<PrepareMaterialResult> {
  const captured = await captureWorkspaceSnapshot(evalCase.repoPath, nodeGitCommandRunner, {
    baseCommit: evalCase.baseCommit,
  });
  if (!captured.ok) {
    return { ok: false, reason: captured.reason };
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'second-opinion-eval-'));
  let bundle: ReviewBundle;
  try {
    bundle = await createReviewBundle({
      root,
      cwd: evalCase.repoPath,
      git: nodeGitCommandRunner,
      baseCommit: captured.snapshot.baseCommit,
      fullDiff: captured.material.fullDiff,
      changedPaths: captured.material.changedPaths,
    });
  } catch (e) {
    await fs.rm(root, { recursive: true, force: true });
    return {
      ok: false,
      reason: `レビュー材料を書き出せませんでした: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  return {
    ok: true,
    material: {
      input: buildInput(evalCase, captured.snapshot),
      cwd: bundle.dir,
      baseCommit: captured.snapshot.baseCommit,
      async dispose(): Promise<void> {
        await bundle.dispose();
        await fs.rm(root, { recursive: true, force: true });
      },
    },
  };
}

/**
 * 共通の入力を組み立てる。
 *
 * 背景は案件が持つ本文をそのまま渡し、要約セッションは開かない（{@link EvalCase.summarize} の
 * 既定が `false` である理由と同じで、要約の揺らぎを条件間の差へ混ぜないため）。`summarize` を
 * `true` にする条件は後続Issueで足す。ここでは受け取っていない指定を黙って無視せず、明示的に
 * 未対応として落とす。
 */
function buildInput(evalCase: EvalCase, snapshot: WorkspaceSnapshot): SecondOpinionInput {
  if (evalCase.summarize === true) {
    throw new Error(
      `案件 ${evalCase.id} は summarize: true だが、要約セッション経由の実行は未実装（Issue #1044 の条件E）`,
    );
  }
  const conversation = evalCase.conversation.trim();
  return {
    userRequest: evalCase.userRequest,
    artifact: { kind: 'workspaceChanges', snapshot },
    ...(conversation === ''
      ? {}
      : {
          conversationSummary: conversation,
          // 要約セッションを通していないため、`summary` と名乗らせない。見出しと注意書きが
          // 「別のセッションが作った圧縮」になり、渡していないものを渡したことにしてしまう
          conversationBackgroundKind: 'transcript' as const,
        }),
  };
}
