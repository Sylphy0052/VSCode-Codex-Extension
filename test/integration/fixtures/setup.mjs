// 統合テスト（@vscode/test-electron）が使うVSCodeプロファイル・履歴データの下ごしらえ。
//
// `.vscode-test.mjs` から一度だけ呼ばれ、`.vscode-test/fixtures/` 配下に使い捨ての
// ディレクトリ一式を作る。ユーザーの実環境（~/.codex・~/.claude・実際のVSCodeユーザー設定）
// には一切触れない。`codex.codexHome` / `claude.configDir` をここで作った一時ディレクトリへ
// 向けることで、拡張機能本体には手を入れずに履歴データを差し替える。
//
// 生成した内容（セッションid・cwdなど）はテスト側からも要るため、ワークスペース直下に
// `.fixture-manifest.json` として書き出す。テストは `vscode.workspace.workspaceFolders`
// 経由でこのファイルを読み直す（このプロセスと拡張機能ホストのプロセスは別なので、
// メモリ越しの受け渡しはできない）。
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const fixturesRoot = join(repoRoot, '.vscode-test', 'fixtures');

/**
 * このリポジトリ（拡張機能自身）の作業ツリーの根。シンボリックリンクを解決した実体で持つ。
 * `os.tmpdir()` はmacOSでは `/var` → `/private/var` のリンクなので、パスの前後関係を
 * 比べる前に両側を実体へ揃える必要がある。
 */
const thisRepoRoot = realpathSync(repoRoot);

/** `git rev-parse --show-toplevel` の結果を実体パスで返す。作業ツリーでなければ undefined。 */
function gitToplevelOf(dir) {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    return out === '' ? undefined : realpathSync(out);
  } catch {
    return undefined;
  }
}

/** `dir` が `parent` 自身、またはその配下にあるか。 */
function isInside(parent, dir) {
  const rel = relative(parent, dir);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * ワークフローの実行の起点が、このリポジトリの作業ツリーを掴んでいないことを実行前に確かめる
 * （Issue #178）。
 *
 * #168の実装中、統合テストの実行がこのリポジトリ自身にworktreeとブランチを作り、`origin` へ
 * pushまで到達した。`isGitWorkingTree` は `git rev-parse` で**親ディレクトリを遡って**判定する
 * ため、起点を `.vscode-test/` の下（＝このリポジトリの作業ツリーの中）へ置くと、`.gitignore`
 * 済みかどうかに関わらず「このリポジトリが実行対象」として扱われてしまう。
 *
 * 起点の置き場を間違えた場合に、テストが1件も始まらないまま失敗するようにする。ここで throw
 * すると `.vscode-test.mjs` の読み込みが失敗し、VSCodeの起動より前に落ちる。
 */
export function assertOutsideThisRepository(label, dir) {
  const resolved = realpathSync(dir);
  if (isInside(thisRepoRoot, resolved)) {
    throw new Error(
      `統合テストの起点（${label}）がこのリポジトリの作業ツリーの中にあります: ${resolved}\n` +
        `このまま実行するとワークフローがこのリポジトリ自身へworktree・ブランチを作り、` +
        `origin へpushしうるため中止します（Issue #178）。os.tmpdir() の下へ置いてください。`,
    );
  }
  const toplevel = gitToplevelOf(resolved);
  if (toplevel !== undefined && isInside(thisRepoRoot, toplevel)) {
    throw new Error(
      `統合テストの起点（${label}）がこのリポジトリの作業ツリーとして解決されます: ` +
        `${resolved} -> ${toplevel}（Issue #178）`,
    );
  }
}

/**
 * テスト用ワークスペースが、このリポジトリとは無関係な独立したgitリポジトリであり、かつ
 * pushする先を持たないことを確かめる（Issue #178）。
 *
 * `workspaceFolder` は `.vscode-test/fixtures/` の下（＝このリポジトリの作業ツリーの中）に
 * あるが、`initGitRepo` で自分自身を根とするリポジトリにしてある。`git rev-parse` は最も近い
 * `.git` を見つけるため、この初期化が済んでいれば親のこのリポジトリまでは遡らない。初期化の
 * 失敗や順序の入れ替わりでこの前提が崩れたときに気づけるよう、実行前に確かめる。
 */
export function assertIsolatedGitRepo(label, dir) {
  const resolved = realpathSync(dir);
  const toplevel = gitToplevelOf(resolved);
  if (toplevel !== resolved) {
    throw new Error(
      `統合テスト用のワークスペース（${label}）が独立したgitリポジトリになっていません: ` +
        `${resolved}（git的な根は ${toplevel ?? 'なし'}）。このまま実行すると` +
        `このリポジトリ自身が実行対象になりうるため中止します（Issue #178）。`,
    );
  }
  const remotes = execFileSync('git', ['remote'], {
    cwd: resolved,
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
  }).trim();
  if (remotes !== '') {
    throw new Error(
      `統合テスト用のワークスペース（${label}）にremoteが設定されています: ${remotes}。` +
        `テストの実行がリモートを書き換えうるため中止します（Issue #178）。`,
    );
  }
}

/**
 * VSCodeへ渡す `XDG_RUNTIME_DIR` を用意する（issue #163）。
 *
 * VSCodeは単一インスタンス判定のためのIPCソケットを `XDG_RUNTIME_DIR` の下へ作る。
 * このディレクトリが実在しないと、ソケットを作れないまま起動が終わらず、テストは
 * 1件も始まらないまま止まる。WSL2ではsystemd-logindのユーザーセッションが終わると
 * `/run/user/<uid>` ごと消えるため、環境変数だけが残ってディレクトリが無い状態に
 * なりうる（未設定時のフォールバックも働かない）。
 *
 * ユーザーの `/run/user/<uid>` には触らず、使い捨てのディレクトリを毎回作って渡す。
 * 置き場所を `.vscode-test/` 配下ではなく `os.tmpdir()` の直下にしているのは、
 * UNIXドメインソケットのパス長制限（107文字）に収めるため。リポジトリが深い場所に
 * あると `<repo>/.vscode-test/fixtures/... /vscode-xxxxxxxx-1.13-main.sock` が上限を
 * 超え、`listen EINVAL` で起動に失敗する。
 */
function createRuntimeDir() {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'vscode-it-'));
  // ベストエフォートの後始末。SIGKILLで落とされた場合は残るが、中身はソケット1つ。
  process.on('exit', () => {
    rmSync(runtimeDir, { recursive: true, force: true });
  });
  return runtimeDir;
}

/**
 * 疑似worktree（design.md §16.20、Issue #168）の実行の起点を用意する。
 *
 * `isGitWorkingTree` は `git rev-parse --is-inside-work-tree` で判定するため、
 * **親ディレクトリを遡って**gitの作業ツリーを見つける。`.vscode-test/` の下は
 * このリポジトリの作業ツリーの中なので、そこへ置くと「gitリポジトリである」と判定され、
 * 疑似worktreeではなくgitのworktree経路へ流れてしまう（`.gitignore` 済みかどうかは
 * 関係ない）。`os.tmpdir()` の直下へ逃がして、gitの作業ツリーの外であることを保証する。
 *
 * `createRuntimeDir` と同じくベストエフォートで後始末する。
 */
function createNonGitRoot() {
  const root = mkdtempSync(join(tmpdir(), 'agent-pseudo-'));
  // 置き場を間違えたときに、テストが始まる前に落とす（Issue #178）。
  assertOutsideThisRepository('疑似worktreeの起点', root);
  process.on('exit', () => {
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

/**
 * PR/MRの作成順序（Issue #172）の統合テストが使う起点の親ディレクトリを用意する。
 *
 * このテストは**実際に `git push` が走る**経路を通すため、テスト側がケースごとに
 * 「ローカルのbareリポジトリを `origin` に持つ作業ツリー」を掘る（`helpers/forgeRepo.ts`）。
 * push先がローカルのファイルパスなので、実行がネットワーク越しのホストへ到達することはない。
 * 親ディレクトリを `os.tmpdir()` の下へ置く理由は `createNonGitRoot` と同じ。
 */
function createForgeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'agent-forge-'));
  assertOutsideThisRepository('PR/MR検証用の起点', root);
  process.on('exit', () => {
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function writeJsonl(filePath, lines) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');
}

/**
 * ワークフローの統合テスト（Issue #158）が使う定義。#51の受入基準そのもの
 * （`T1 → (T2 || T3) → T4`）を最小の形で書いたもの。プロンプトと終了条件は
 * フェイクの `TaskSessionHost` が受け取るだけで、CLIへは渡らない。
 */
const WORKFLOW_DIAMOND_YAML = `version: 1
name: integration-diamond
defaults:
  provider: codex
  maxParallel: 3
tasks:
  - id: T1
    prompt: T1のプロンプト
    done: T1の終了条件
  - id: T2
    dependsOn: [T1]
    prompt: T2のプロンプト
    done: T2の終了条件
  - id: T3
    dependsOn: [T1]
    prompt: T3のプロンプト
    done: T3の終了条件
  - id: T4
    dependsOn: [T2, T3]
    prompt: T4のプロンプト
    done: T4の終了条件
`;

/**
 * 疑似worktree（design.md §16.20、Issue #168）の統合テストが使う定義。
 *
 * gitの作業ツリーでないワークスペースで走らせるため、`isolation` は既定（`worktree`）の
 * まま。`decideWorkingDirectory` が `sharedFallback` へ倒し、`resolveWorkingDirectory`
 * から疑似worktreeの複製が使われる経路を通す。T1のあとT2とT3が並列で走る形は
 * `WORKFLOW_DIAMOND_YAML` と同じで、T4を持たないぶんだけ短い。
 */
const WORKFLOW_PSEUDO_YAML = `version: 1
name: integration-pseudo
defaults:
  provider: codex
  maxParallel: 3
tasks:
  - id: T1
    prompt: T1のプロンプト
    done: T1の終了条件
  - id: T2
    dependsOn: [T1]
    prompt: T2のプロンプト
    done: T2の終了条件
  - id: T3
    dependsOn: [T1]
    prompt: T3のプロンプト
    done: T3の終了条件
`;

/**
 * `isolation: worktree-strict` を含む定義（旧W-07）。gitの作業ツリーでない
 * ワークスペースでは、実行開始前の検証（`resolveStartGitContext`）が1タスクも
 * 開始しないまま拒否する。
 */
const WORKFLOW_PSEUDO_STRICT_YAML = `version: 1
name: integration-pseudo-strict
defaults:
  provider: codex
tasks:
  - id: T1
    isolation: worktree-strict
    prompt: T1のプロンプト
    done: T1の終了条件
`;

/**
 * 統合の衝突と自動解決（design.md §16.17、Issue #170）の統合テストが使う定義。
 *
 * T1とT2は依存が無く並列に走り、テスト側が**同じファイルの同じ行**を書き換えてコミット
 * するため、後からマージする側で必ず衝突する。T3はT2に依存し（衝突が解けなかったとき
 * `skipped` になる後続）、T4はどちらにも依存しない（独立した枝が最後まで走ることの確認）。
 */
const WORKFLOW_MERGE_CONFLICT_YAML = `version: 1
name: integration-merge-conflict
defaults:
  provider: codex
  maxParallel: 3
tasks:
  - id: T1
    prompt: T1のプロンプト（共有ファイルの1行目を書き換える）
    done: T1の終了条件
  - id: T2
    prompt: T2のプロンプト（同じ行を別の内容へ書き換える）
    done: T2の終了条件
  - id: T3
    dependsOn: [T2]
    prompt: T3のプロンプト
    done: T3の終了条件
  - id: T4
    prompt: T4のプロンプト
    done: T4の終了条件
`;

/**
 * PR/MRの作成順序（design.md §16.18、Issue #172）の統合テストが使う定義。
 *
 * 順序（タスクブランチのpush→統合ブランチのpush→PR/MR作成→統合worktreeでのマージ）は
 * タスク1本で確かめられる。並列のタスクを混ぜると、記録した呼び出し列にどのタスクの手順か
 * を判じる手間が増えるだけで、確かめたい順序そのものは変わらない。
 */
const WORKFLOW_FORGE_YAML = `version: 1
name: integration-forge
defaults:
  provider: codex
  maxParallel: 1
tasks:
  - id: T1
    prompt: T1のプロンプト
    done: T1の終了条件
`;

/**
 * テスト用ワークスペースを空のgitリポジトリにする。
 *
 * worktreeによる隔離（design.md §16.3）を実物で確かめるため、`git worktree add` が
 * 通る状態（HEADのある作業ツリー）まで用意する。ユーザーのgit設定に依存しないよう、
 * ここで作るリポジトリの中だけへ最小限の設定を書く。
 */
function initGitRepo(dir) {
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'integration-test@example.invalid');
  git('config', 'user.name', 'Integration Test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), '統合テスト用の使い捨てリポジトリ\n', 'utf8');
  // 統合の衝突（Issue #170）で2つの並列タスクが同じ行を書き換えるファイル。共通の祖先に
  // 置いておくことで、add/addではなくmodify/modifyの衝突（実運用で起きる形）になる。
  writeFileSync(join(dir, 'shared.md'), '共有ファイルの初期内容\n', 'utf8');
  git('add', '.');
  git('commit', '--no-verify', '-m', 'chore: 統合テスト用の初期コミット');
}

export function prepareFixtures() {
  // 前回の実行分を消してから作り直す（idempotent）。
  rmSync(fixturesRoot, { recursive: true, force: true });

  const workspaceFolder = join(fixturesRoot, 'workspace');
  const outsideWorkspace = join(fixturesRoot, 'outside-workspace');
  // 疑似worktree（Issue #168）用。**gitの作業ツリーの外**に置くことがこのフォルダの役割。
  // VSCodeが開くワークスペースは `workspaceFolder` のままで、こちらは
  // `WorkflowRunner.start(defPath, repoRoot)` の `repoRoot` として渡す
  // （実行の起点はワークスペースフォルダである必要がない）。
  //
  // `.vscode-test/` の下に置いてはいけない。`isGitWorkingTree` は `git rev-parse` で
  // **親ディレクトリを遡って**判定するため、このリポジトリの作業ツリーの中にあると
  // 「gitリポジトリである」と判定され、疑似worktreeではなくgitのworktree経路へ流れる
  // （`.gitignore` 済みかどうかは関係ない）。`os.tmpdir()` の下へ逃がす。
  const nonGitWorkspace = createNonGitRoot();
  // PR/MRの作成順序（Issue #172）用。ケースごとの作業ツリーはテスト側が掘る。
  const forgeRoot = createForgeRoot();
  const codexHome = join(fixturesRoot, 'codex-home');
  const claudeHome = join(fixturesRoot, 'claude-home');
  const userDataDir = join(fixturesRoot, 'user-data');
  const activityLogDir = join(fixturesRoot, 'activity-log');
  const runtimeDir = createRuntimeDir();

  mkdirSync(workspaceFolder, { recursive: true });
  mkdirSync(outsideWorkspace, { recursive: true });
  mkdirSync(activityLogDir, { recursive: true });

  const now = Date.now();
  const iso = (offsetMs) => new Date(now + offsetMs).toISOString();

  // --- Codex ---------------------------------------------------------
  // 名前確定済み（session_index.jsonlに載る、H-01・H-02向け）
  const codexNamedId = randomUUID();
  // アーカイブ済み（archived_sessions/配下、H-02向け）
  const codexArchivedId = randomUUID();
  // 名前未確定（session_index.jsonlに載らない。最初の発言から名前を作る、H-00向け）
  const codexUnnamedId = randomUUID();

  const codexNamedName = '名前確定済みのCodexセッション';
  const codexArchivedName = 'アーカイブ済みのCodexセッション';
  const codexUnnamedFirstMessage = '最初の指示だけがある、まだ要約名の付いていないセッション';

  writeJsonl(join(codexHome, 'sessions', `rollout-20260811-${codexNamedId}.jsonl`), [
    {
      type: 'session_meta',
      payload: {
        session_id: codexNamedId,
        cwd: workspaceFolder,
        timestamp: iso(-60_000),
        thread_source: 'user',
      },
    },
  ]);

  writeJsonl(join(codexHome, 'archived_sessions', `rollout-20260810-${codexArchivedId}.jsonl`), [
    {
      type: 'session_meta',
      payload: {
        session_id: codexArchivedId,
        cwd: workspaceFolder,
        timestamp: iso(-120_000),
        thread_source: 'user',
      },
    },
  ]);

  // 名前未確定セッションはindexに載らないぶん、ファイルのmtimeが一覧の並び順に使われる。
  // 他の2件より後に書いて「最新」側に来るようにする。
  writeJsonl(join(codexHome, 'sessions', `rollout-20260811-${codexUnnamedId}.jsonl`), [
    {
      type: 'session_meta',
      payload: {
        session_id: codexUnnamedId,
        cwd: workspaceFolder,
        timestamp: iso(-30_000),
        thread_source: 'user',
      },
    },
    { type: 'turn_context', payload: {} },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: codexUnnamedFirstMessage }],
      },
    },
  ]);

  writeJsonl(join(codexHome, 'session_index.jsonl'), [
    { id: codexNamedId, thread_name: codexNamedName, updated_at: iso(-60_000) },
    { id: codexArchivedId, thread_name: codexArchivedName, updated_at: iso(-120_000) },
  ]);

  // --- Claude Code -----------------------------------------------------
  const claudeInScopeId = randomUUID();
  const claudeOutOfScopeId = randomUUID();
  const claudeInScopeFirstMessage = 'ワークスペース内で始めたClaude Codeセッション';
  const claudeOutOfScopeFirstMessage = 'ワークスペース外で始めたClaude Codeセッション';

  writeJsonl(join(claudeHome, 'projects', 'fixture-project', `${claudeInScopeId}.jsonl`), [
    {
      type: 'user',
      sessionId: claudeInScopeId,
      cwd: workspaceFolder,
      timestamp: iso(-45_000),
      message: { role: 'user', content: [{ type: 'text', text: claudeInScopeFirstMessage }] },
    },
  ]);

  writeJsonl(join(claudeHome, 'projects', 'fixture-project', `${claudeOutOfScopeId}.jsonl`), [
    {
      type: 'user',
      sessionId: claudeOutOfScopeId,
      cwd: outsideWorkspace,
      timestamp: iso(-90_000),
      message: {
        role: 'user',
        content: [{ type: 'text', text: claudeOutOfScopeFirstMessage }],
      },
    },
  ]);

  // --- 実行ファイルパスの方針 ---------------------------------------
  // 実CLI（codex/claude）を絶対に呼ばせないため、実行ファイルパスは存在しない絶対パスに
  // 固定する（PATH経由の解決も `/` を含む指定なので働かない。cliLocator.ts参照）。
  //
  // この設定は履歴一覧（TreeView）の前提でもある。CLIが起動できない環境でも
  // ファイル読みだけで一覧が出ることが `sessionHistory.test.ts` のH-09の狙いで、
  // `ProviderRegistry` は実行ファイルの解決可否で一覧を絞らない（issue #164）。
  //
  // 「解決はできるが呼んでも即失敗する」スタブ（`exit 1` するだけのシェルスクリプト）へ
  // 差し替える案は採らない。`AppServerClient` がまだ書き込み中に相手プロセスが終了し
  // `EPIPE` の非捕捉例外で拡張機能ホストごと巻き込む形で複数テストが道連れに失敗した
  // 実績があり（issue #155、対策は `src/process/stdinSafety.ts`）、実CLIを呼ばせない
  // 目的にはスタブ自体が不要なため。
  const settings = {
    'codex.codexHome': codexHome,
    'codex.executablePath': '/nonexistent/codex-must-not-run',
    'claude.configDir': claudeHome,
    'claude.executablePath': '/nonexistent/claude-must-not-run',
    'agent.activityLog.enabled': false,
    'agent.activityLog.dir': activityLogDir,
    'security.workspace.trust.enabled': false,
    // ワークフローの統合テスト（Issue #158）。危険判定の確認は別途行うため、ここでは
    // 既定（自動承認あり）のまま走らせる。定義の置き場も既定値を明示しておく。
    'agent.workflows.dir': '.agents/workflows',
    // PR/MRの作成と、それに伴う `git push` を設定の側でも封じる（Issue #178）。統合テストは
    // ローカルのブランチ操作・マージまでしか確かめない。フィクスチャ側のガード
    // （`assertOutsideThisRepository` / `assertIsolatedGitRepo`）と二重の防御にして、
    // 起点の置き場を間違えても被害がローカルで止まるようにする。
    'agent.workflows.forge': 'none',
    'agent.workflows.pullRequest': 'none',
    'agent.workflows.finalMerge': 'pr-only',
  };
  mkdirSync(join(userDataDir, 'User'), { recursive: true });
  writeFileSync(
    join(userDataDir, 'User', 'settings.json'),
    JSON.stringify(settings, null, 2),
    'utf8',
  );

  // ワークフロー（Issue #158）。定義を置いてからgitリポジトリ化する。
  const workflowDir = join(workspaceFolder, '.agents', 'workflows');
  mkdirSync(workflowDir, { recursive: true });
  const workflowDefPath = join(workflowDir, 'diamond.yaml');
  writeFileSync(workflowDefPath, WORKFLOW_DIAMOND_YAML, 'utf8');
  // 統合の衝突（Issue #170）。定義はワークスペース側に置き、実行の起点も同じワークスペース
  // （remoteを持たない独立したgitリポジトリ）を使う。
  const workflowConflictDefPath = join(workflowDir, 'merge-conflict.yaml');
  writeFileSync(workflowConflictDefPath, WORKFLOW_MERGE_CONFLICT_YAML, 'utf8');
  initGitRepo(workspaceFolder);
  // 初期化が済んだ状態で、このリポジトリとは無関係な独立リポジトリになっていることを確かめる
  // （Issue #178）。
  assertIsolatedGitRepo('テスト用ワークスペース', workspaceFolder);

  // 疑似worktree（Issue #168）。ケースごとに使い捨てのワークスペースを作らせるため、
  // ここでは**親ディレクトリと定義のひな形だけ**を用意する。runの終了時に統合結果が
  // ワークスペースへ反映される（design.md §16.20）ので、1つのフォルダを使い回すと
  // 前のケースが書いたファイルが次のケースのスナップショットへ混ざる。
  mkdirSync(nonGitWorkspace, { recursive: true });
  const pseudoTemplateDir = join(nonGitWorkspace, '_templates');
  mkdirSync(pseudoTemplateDir, { recursive: true });
  const pseudoDefTemplate = join(pseudoTemplateDir, 'pseudo.yaml');
  const pseudoStrictDefTemplate = join(pseudoTemplateDir, 'pseudo-strict.yaml');
  writeFileSync(pseudoDefTemplate, WORKFLOW_PSEUDO_YAML, 'utf8');
  writeFileSync(pseudoStrictDefTemplate, WORKFLOW_PSEUDO_STRICT_YAML, 'utf8');

  // PR/MRの作成順序（Issue #172）。定義のひな形だけを置く。
  const forgeTemplateDir = join(forgeRoot, '_templates');
  mkdirSync(forgeTemplateDir, { recursive: true });
  const forgeDefTemplate = join(forgeTemplateDir, 'forge.yaml');
  writeFileSync(forgeDefTemplate, WORKFLOW_FORGE_YAML, 'utf8');

  const manifest = {
    workspaceFolder,
    workflow: { defPath: workflowDefPath, conflictDefPath: workflowConflictDefPath },
    // gitリポジトリにしていない親ディレクトリ。テストは `<root>/<ケース名>` を掘って使う。
    pseudoWorktree: {
      root: nonGitWorkspace,
      defTemplate: pseudoDefTemplate,
      strictDefTemplate: pseudoStrictDefTemplate,
    },
    // PR/MRの作成順序（Issue #172）。テストは `<root>/<ケース名>` を掘り、その中に
    // bareリポジトリと作業ツリーを作る。
    forge: {
      root: forgeRoot,
      defTemplate: forgeDefTemplate,
    },
    outsideWorkspace,
    codexHome,
    claudeHome,
    codex: {
      named: { id: codexNamedId, threadName: codexNamedName },
      archived: { id: codexArchivedId, threadName: codexArchivedName },
      unnamed: { id: codexUnnamedId, firstMessage: codexUnnamedFirstMessage },
    },
    claude: {
      inScope: { id: claudeInScopeId, firstMessage: claudeInScopeFirstMessage },
      outOfScope: { id: claudeOutOfScopeId, firstMessage: claudeOutOfScopeFirstMessage },
    },
  };
  writeFileSync(
    join(workspaceFolder, '.fixture-manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  );

  return { workspaceFolder, userDataDir, runtimeDir, codexHome, claudeHome, manifest };
}
