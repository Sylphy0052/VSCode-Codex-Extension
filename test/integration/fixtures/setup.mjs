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
  // 既知のトレードオフ: `ProviderRegistry.available()`（src/provider/registry.ts）は
  // `locate()` が解決できないプロバイダを一覧からまるごと除外するため、この設定では
  // 履歴一覧（TreeView）が常に空になる。そのため履歴一覧まわり
  // （`sessionHistory.test.ts`）は現状 `test.skip` にしてある（issue #164）。
  //
  // 「解決はできるが呼んでも即失敗する」無害なスタブ（`exit 1` するだけのシェル
  // スクリプト）へ差し替える案は、`AppServerClient` がまだ書き込み中に相手プロセスが
  // 終了し `EPIPE` の非捕捉例外で拡張機能ホストごと巻き込む形で複数テストが道連れに
  // 失敗したため見送っていた（2026-08-12に実測）。その後 issue #155 で書き込み時の
  // EPIPEを捕捉する対応（`src/process/stdinSafety.ts`）が入ったので、再挑戦できる。
  const settings = {
    'codex.codexHome': codexHome,
    'codex.executablePath': '/nonexistent/codex-must-not-run',
    'claude.configDir': claudeHome,
    'claude.executablePath': '/nonexistent/claude-must-not-run',
    'agent.activityLog.enabled': false,
    'agent.activityLog.dir': activityLogDir,
    'security.workspace.trust.enabled': false,
  };
  mkdirSync(join(userDataDir, 'User'), { recursive: true });
  writeFileSync(
    join(userDataDir, 'User', 'settings.json'),
    JSON.stringify(settings, null, 2),
    'utf8',
  );

  const manifest = {
    workspaceFolder,
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
