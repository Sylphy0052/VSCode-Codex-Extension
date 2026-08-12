import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * PR/MRの作成順序（design.md §16.18、Issue #172）の統合テスト用に、**ローカルのbare
 * リポジトリを `origin` に持つ作業ツリー**を1件作る。
 *
 * この経路は実際に `git push origin <branch>:<branch>` が走る。push先をローカルの
 * ファイルパスにすることで、本番と同じ手順（push→push→PR/MR作成→マージ）を通しつつ、
 * ネットワーク越しのホストへ到達しないことを構造として保証する（Issue #178）。
 */
export interface ForgeRepo {
  /** ワークフローの実行の起点（`WorkflowRunner.start` の `repoRoot`）。 */
  workspace: string;
  /** `origin` が指すローカルのbareリポジトリのパス。 */
  originPath: string;
  /** 起点へコピーしたワークフロー定義。 */
  defPath: string;
  /** bareリポジトリ側に存在するブランチ名の一覧。 */
  remoteBranches(): string[];
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * `origin` がローカルのファイルパスを指しており、かつそのパスがこのリポジトリの外に
 * あることを確かめる（Issue #178の「テストの実行はリモートへ到達しない」を、remoteを
 * 持たせるこのケースでも保てるようにする）。
 */
export function assertLocalOnlyRemote(workspace: string): void {
  const url = git(workspace, 'remote', 'get-url', 'origin').trim();
  assert.ok(
    path.isAbsolute(url),
    `originがローカルの絶対パスではない（リモートへ到達しうる）: ${url}`,
  );
  assert.ok(fs.existsSync(url), `originが指すローカルのリポジトリが無い: ${url}`);
  const insideThisRepo = path.relative(path.join(__dirname, '..', '..', '..'), url);
  assert.ok(
    insideThisRepo.startsWith('..') || path.isAbsolute(insideThisRepo),
    `originがこのリポジトリの中を指している: ${url}`,
  );
}

/**
 * `root/<name>` の下に bare リポジトリと作業ツリーを作り、定義ファイルを置く。
 *
 * 作業ツリーは `initGitRepo`（`fixtures/setup.mjs`）と同じく、ユーザーのgit設定に依存
 * しない最小限の設定だけを自分の中へ書く。`main` を bare へ push しておくのは、統合層の
 * PR/MRのbase（実行開始時のHEADブランチ）が origin 上にある状態を本番と揃えるため。
 */
export function createForgeRepo(root: string, name: string, defTemplate: string): ForgeRepo {
  const base = path.join(root, name);
  const originPath = path.join(base, 'origin.git');
  const workspace = path.join(base, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });

  execFileSync('git', ['init', '--bare', '--initial-branch=main', originPath], { stdio: 'pipe' });

  git(workspace, 'init', '--initial-branch=main');
  git(workspace, 'config', 'user.email', 'integration-test@example.invalid');
  git(workspace, 'config', 'user.name', 'Integration Test');
  git(workspace, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(workspace, 'README.md'), 'PR/MRの順序検証用\n', 'utf8');

  const defDir = path.join(workspace, '.agents', 'workflows');
  fs.mkdirSync(defDir, { recursive: true });
  const defPath = path.join(defDir, 'forge.yaml');
  fs.copyFileSync(defTemplate, defPath);

  git(workspace, 'add', '.');
  git(workspace, 'commit', '--no-verify', '-m', 'chore: 初期コミット');
  git(workspace, 'remote', 'add', 'origin', originPath);
  git(workspace, 'push', 'origin', 'main:main');

  assertLocalOnlyRemote(workspace);

  return {
    workspace,
    originPath,
    defPath,
    remoteBranches: () =>
      git(originPath, 'branch', '--format=%(refname:short)')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== ''),
  };
}
