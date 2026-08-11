import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { activateExtension, type SessionSummaryLike } from './helpers/extension';
import { readManifest } from './helpers/manifest';
import { waitFor } from './helpers/waitFor';

/**
 * docs/manual-test.md のH群（履歴・復元）のうち、実CLIプロセスなしで確認できる範囲を
 * 狙って書いたテスト。**現状は全件 `test.skip` にしてあり、実行されない。**
 *
 * 履歴一覧（TreeView）は `ProviderRegistry.available()`（src/provider/registry.ts）が
 * `locate()` で実行ファイルを解決できたプロバイダしか対象にしないため、実CLIを一切
 * 呼ばせない（`codex.executablePath` / `claude.executablePath` を存在しないパスへ
 * 固定する）方針のままだと一覧が常に空になる。「解決はできるが呼んでも即失敗する」
 * 無害なスタブへ差し替える案も試したが、`AppServerClient` が書き込み中に相手プロセスが
 * 既に終了しており `EPIPE` の非捕捉例外で拡張機能ホストごと巻き込み、無関係な他のテスト
 * まで道連れに失敗する形で実測された（2026-08-12、xvfb-run環境）。
 *
 * このファイルのテストコード自体は「fixtureさえ揃えばTreeViewの中身をどう検証するか」
 * の実装例として残す。再挑戦する場合は、`AppServerClient` 側で書き込み時のEPIPEを
 * 捕捉してから `test.skip` を `test` に戻すこと。H-08（thread/list接続時）はそもそも
 * 実際のCodex CLIが要るため引き続き対象外。
 */
suite('履歴一覧（docs/manual-test.md H群、現状skip・下部の説明参照）', () => {
  test.skip('H-00: session_index.jsonlに載っていないセッションも最初の発言から名前が付いて出る', async () => {
    const api = await activateExtension();
    const manifest = readManifest();
    await api.sessionTree.setScope('workspace');

    const children = await api.sessionTree.getChildren();
    const unnamed = children.find((s) => s.id === manifest.codex.unnamed.id);
    assert.ok(unnamed, 'session_index.jsonlに載っていないセッションが一覧から漏れている');
    assert.equal(unnamed?.threadName, manifest.codex.unnamed.firstMessage);
  });

  test.skip('H-01: CodexとClaude Codeのセッションが1つの一覧にマージされ、区別できる', async () => {
    const api = await activateExtension();
    const manifest = readManifest();
    await api.sessionTree.setScope('workspace');

    const children = await api.sessionTree.getChildren();
    const codexItem = children.find((s) => s.id === manifest.codex.named.id);
    const claudeItem = children.find((s) => s.id === manifest.claude.inScope.id);
    assert.ok(codexItem, 'Codexのセッションが一覧から漏れている');
    assert.ok(claudeItem, 'Claude Codeのセッションが一覧から漏れている');

    const codexIcon = api.sessionTree.getTreeItem(codexItem as SessionSummaryLike).iconPath;
    const claudeIcon = api.sessionTree.getTreeItem(claudeItem as SessionSummaryLike).iconPath;
    assert.ok(codexIcon instanceof vscode.ThemeIcon, 'Codexセッションのアイコンが無い');
    assert.ok(claudeIcon instanceof vscode.ThemeIcon, 'Claude Codeセッションのアイコンが無い');
    assert.notEqual(
      (codexIcon as vscode.ThemeIcon).id,
      (claudeIcon as vscode.ThemeIcon).id,
      'プロバイダが違うのにアイコンが同じで見分けが付かない',
    );

    // 更新時刻の降順であること。ファイルmtime依存のセッションは実行環境で誤差が出るため、
    // session_index.jsonlに明示的な時刻を持つ2件（1分前 / 2分前）の相対順だけを見る。
    const namedIndex = children.findIndex((s) => s.id === manifest.codex.named.id);
    const archivedIndex = children.findIndex((s) => s.id === manifest.codex.archived.id);
    assert.ok(namedIndex >= 0 && archivedIndex >= 0);
    assert.ok(namedIndex < archivedIndex, '更新時刻の新しい順に並んでいない');
  });

  test.skip('H-02: 右クリックメニューの出し分けに使うcontextValueがプロバイダ・archived状態で変わる', async () => {
    const api = await activateExtension();
    const manifest = readManifest();
    await api.sessionTree.setScope('workspace');

    const children = await api.sessionTree.getChildren();
    const codexActive = children.find((s) => s.id === manifest.codex.named.id);
    const codexArchived = children.find((s) => s.id === manifest.codex.archived.id);
    const claudeItem = children.find((s) => s.id === manifest.claude.inScope.id);
    assert.ok(codexActive && codexArchived && claudeItem);

    assert.equal(
      api.sessionTree.getTreeItem(codexActive as SessionSummaryLike).contextValue,
      'codexSession.codex',
    );
    assert.equal(
      api.sessionTree.getTreeItem(codexArchived as SessionSummaryLike).contextValue,
      'codexSession.codex.archived',
    );
    assert.equal(
      api.sessionTree.getTreeItem(claudeItem as SessionSummaryLike).contextValue,
      'codexSession.claude',
      // archive/unarchive/delete/セッション名を変更/会話を開いて分岐する、が出ないことは
      // package.json側のwhen句がこの値で出し分けている（design.md §6 TreeView）
    );
  });

  test.skip('H-03: 表示範囲の切り替えでワークスペース外のセッションが出入りする', async () => {
    const api = await activateExtension();
    const manifest = readManifest();

    await vscode.commands.executeCommand('codex.showWorkspaceSessions');
    const workspaceOnly = await api.sessionTree.getChildren();
    assert.ok(
      !workspaceOnly.some((s) => s.id === manifest.claude.outOfScope.id),
      'workspaceスコープなのにワークスペース外のセッションが出ている',
    );

    await vscode.commands.executeCommand('codex.showAllSessions');
    const all = await api.sessionTree.getChildren();
    assert.ok(
      all.some((s) => s.id === manifest.claude.outOfScope.id),
      '全ワークスペース表示に切り替えてもワークスペース外のセッションが出てこない',
    );

    // 後始末。他のテストの前提（既定はworkspaceスコープ）を崩さない
    await vscode.commands.executeCommand('codex.showWorkspaceSessions');
  });

  test.skip('H-07 / H-09: 外部でロールアウトが作られると一覧に追従し、thread/list不通でも一覧は失われない', async () => {
    const api = await activateExtension();
    const manifest = readManifest();
    await api.sessionTree.setScope('workspace');

    const before = await api.sessionTree.getChildren();
    // ここまでの一覧はすべてファイル読みの経路（thread/listは実行ファイルが存在せず
    // 必ず失敗する）を通っている。それでも空にならないこと自体がH-09の狙いの確認になる
    assert.ok(before.length > 0, 'thread/listが使えないだけで一覧が空になっている');

    const newId = 'ffffffff-0000-0000-0000-000000000000';
    const rolloutPath = path.join(
      manifest.codexHome,
      'sessions',
      `rollout-20260811-${newId}.jsonl`,
    );
    const line = JSON.stringify({
      type: 'session_meta',
      payload: {
        session_id: newId,
        cwd: manifest.workspaceFolder,
        timestamp: new Date().toISOString(),
        thread_source: 'user',
      },
    });
    fs.writeFileSync(rolloutPath, `${line}\n`, 'utf8');

    try {
      await waitFor(
        () => api.sessionTree.getChildren(),
        (list) => list.some((s) => s.id === newId),
        { timeoutMs: 8000, intervalMs: 200 },
      );
    } finally {
      fs.rmSync(rolloutPath, { force: true });
    }
  });
});
