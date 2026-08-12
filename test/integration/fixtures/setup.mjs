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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const fixturesRoot = join(repoRoot, '.vscode-test', 'fixtures');

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
  git('add', 'README.md');
  git('commit', '--no-verify', '-m', 'chore: 統合テスト用の初期コミット');
}

export function prepareFixtures() {
  // 前回の実行分を消してから作り直す（idempotent）。
  rmSync(fixturesRoot, { recursive: true, force: true });

  const workspaceFolder = join(fixturesRoot, 'workspace');
  const outsideWorkspace = join(fixturesRoot, 'outside-workspace');
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
  initGitRepo(workspaceFolder);

  const manifest = {
    workspaceFolder,
    workflow: { defPath: workflowDefPath },
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
