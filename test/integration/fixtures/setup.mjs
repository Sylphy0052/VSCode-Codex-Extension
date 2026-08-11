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
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const fixturesRoot = join(repoRoot, '.vscode-test', 'fixtures');

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
  // 履歴一覧（TreeView）が常に空になる。「解決はできるが呼んでも即失敗する」無害な
  // スタブ（`exit 1` するだけのシェルスクリプト）へ差し替える案も試したが、
  // `AppServerClient` がまだ書き込み中に相手プロセスが終了し `EPIPE` の非捕捉例外で
  // 拡張機能ホストごと巻き込む形で複数テストが道連れに失敗した（2026-08-12に実測）。
  // そのため履歴一覧まわり（`sessionHistory.test.ts`）は現状 `test.skip` にしてある。
  // 再挑戦するなら、拡張機能側で書き込み時のEPIPEを捕捉する対応が先に要る。
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

  return { workspaceFolder, userDataDir, codexHome, claudeHome, manifest };
}
