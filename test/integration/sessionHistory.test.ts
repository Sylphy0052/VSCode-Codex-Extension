import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { activateExtension } from './helpers/extension';
import { readManifest } from './helpers/manifest';
import { flattenSessions, isGroupNode } from './helpers/sessionTree';
import { waitFor } from './helpers/waitFor';

/**
 * docs/manual-test.md のH群（履歴・復元）のうち、実CLIプロセスなしで確認できる範囲を
 * 狙って書いたテスト。
 *
 * 実CLIを一切呼ばせないため、`codex.executablePath` / `claude.executablePath` は存在
 * しない絶対パスに固定してある（fixtures/setup.mjs）。この状態でも履歴一覧が出ること
 * 自体がH-09の確認になる。一覧の構築は `SessionStore.list()` のファイル読みだけで完結
 * するのに、以前は `ProviderRegistry.available()` が `locate()` できないプロバイダを
 * 一覧からまるごと除外していたため、5件とも「一覧が空」で失敗していた（issue #164）。
 * 実装側を直した（実行ファイルの解決可否で一覧を絞らない）ので、前提はそのままでよい。
 *
 * #147では、`locate()` は通るが呼ぶと即失敗するスタブへ差し替えた状態で、`AppServerClient`
 * が書き込み中に相手プロセスが既に終了しており `EPIPE` の非捕捉例外で拡張機能ホストごと
 * 巻き込み、無関係な他のテストまで道連れに失敗することが実測された（issue #155、対策は
 * `src/process/stdinSafety.ts` / design.md §14.31）。実装を直した今はスタブ自体が不要に
 * なったため、この経路には踏み込まない。
 *
 * 一時期「skipを外すとテストが完了しないまま止まる」と記録していたが、これは誤り。
 * 実行環境の `XDG_RUNTIME_DIR`（`/run/user/<uid>`）が消えており、VSCodeがIPCソケットを
 * 作れずに起動しきっていなかっただけで、skipの有無とは無関係だった（issue #163で対策済み）。
 *
 * H-08（thread/list接続時）はそもそも実際のCodex CLIが要るため引き続き対象外。
 */
suite('履歴一覧（docs/manual-test.md H群）', () => {
  test('H-00: session_index.jsonlに載っていないセッションも最初の発言から名前が付いて出る', async () => {
    const api = await activateExtension();
    const manifest = readManifest();
    await api.sessionTree.setScope('workspace');

    const children = await flattenSessions(api.sessionTree);
    const unnamed = children.find((s) => s.id === manifest.codex.unnamed.id);
    assert.ok(unnamed, 'session_index.jsonlに載っていないセッションが一覧から漏れている');
    assert.equal(unnamed?.threadName, manifest.codex.unnamed.firstMessage);
  });

  test('H-01: CodexとClaude Codeのセッションが1つの一覧にマージされ、区別できる', async () => {
    const api = await activateExtension();
    const manifest = readManifest();
    await api.sessionTree.setScope('workspace');

    const children = await flattenSessions(api.sessionTree);
    const codexItem = children.find((s) => s.id === manifest.codex.named.id);
    const claudeItem = children.find((s) => s.id === manifest.claude.inScope.id);
    assert.ok(codexItem, 'Codexのセッションが一覧から漏れている');
    assert.ok(claudeItem, 'Claude Codeのセッションが一覧から漏れている');

    const codexIcon = api.sessionTree.getTreeItem(codexItem).iconPath;
    const claudeIcon = api.sessionTree.getTreeItem(claudeItem).iconPath;
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

  test('H-02: 右クリックメニューの出し分けに使うcontextValueがプロバイダ・archived状態で変わる', async () => {
    const api = await activateExtension();
    const manifest = readManifest();
    await api.sessionTree.setScope('workspace');

    const children = await flattenSessions(api.sessionTree);
    const codexActive = children.find((s) => s.id === manifest.codex.named.id);
    const codexArchived = children.find((s) => s.id === manifest.codex.archived.id);
    const claudeItem = children.find((s) => s.id === manifest.claude.inScope.id);
    assert.ok(codexActive && codexArchived && claudeItem);

    assert.equal(api.sessionTree.getTreeItem(codexActive).contextValue, 'codexSession.codex');
    assert.equal(
      api.sessionTree.getTreeItem(codexArchived).contextValue,
      'codexSession.codex.archived',
    );
    assert.equal(
      api.sessionTree.getTreeItem(claudeItem).contextValue,
      'codexSession.claude',
      // archive/unarchive/delete/セッション名を変更/会話を開いて分岐する、が出ないことは
      // package.json側のwhen句がこの値で出し分けている（design.md §6 TreeView）
    );
  });

  test('H-03: 表示範囲の切り替えでワークスペース外のセッションが出入りする', async () => {
    const api = await activateExtension();
    const manifest = readManifest();

    await vscode.commands.executeCommand('codex.showWorkspaceSessions');
    const workspaceOnly = await flattenSessions(api.sessionTree);
    assert.ok(
      !workspaceOnly.some((s) => s.id === manifest.claude.outOfScope.id),
      'workspaceスコープなのにワークスペース外のセッションが出ている',
    );

    await vscode.commands.executeCommand('codex.showAllSessions');
    const all = await flattenSessions(api.sessionTree);
    assert.ok(
      all.some((s) => s.id === manifest.claude.outOfScope.id),
      '全ワークスペース表示に切り替えてもワークスペース外のセッションが出てこない',
    );

    // 後始末。他のテストの前提（既定はworkspaceスコープ）を崩さない
    await vscode.commands.executeCommand('codex.showWorkspaceSessions');
  });

  test('H-07 / H-09: 外部でロールアウトが作られると一覧に追従し、thread/list不通でも一覧は失われない', async () => {
    const api = await activateExtension();
    const manifest = readManifest();
    await api.sessionTree.setScope('workspace');

    const before = await flattenSessions(api.sessionTree);
    // ここまでの一覧はすべてファイル読みの経路を通っている。`codex.executablePath` は
    // 存在しない絶対パス（fixtures/setup.mjs）で、app-serverへは一度も繋がらないため
    // `thread/list` は使えない。それでも一覧が空にならないことがH-09の狙いの確認になる
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
        () => flattenSessions(api.sessionTree),
        (list) => list.some((s) => s.id === newId),
        { timeoutMs: 8000, intervalMs: 200 },
      );
    } finally {
      fs.rmSync(rolloutPath, { force: true });
    }
  });
});

/**
 * docs/manual-test.md のU群（issue #293）のうち、実CLIプロセスなしで確認できる範囲。
 *
 * `SessionTreeProvider.getChildren()` は`codex.history.groupBy`の既定値（`date`）では
 * ルートへグループノードを返す（`src/view/sessionTreeProvider.ts`）。他のH群のテストは
 * `flattenSessions`（`helpers/sessionTree.ts`）でこの段を吸収しているが、ここではグループ化
 * そのものが起きていること・`none`で従来どおりフラットに戻ることを直接確かめる。
 */
suite('履歴のグループ化（docs/manual-test.md U群、issue #293）', () => {
  test('U-16: 既定（groupBy: date）ではルートがグループノードになり、groupBy: noneでは平坦になる', async () => {
    const api = await activateExtension();
    const manifest = readManifest();
    await api.sessionTree.setScope('workspace');

    const config = vscode.workspace.getConfiguration('codex');
    const originalGroupBy = config.get<string>('history.groupBy');

    try {
      await config.update('history.groupBy', 'date', vscode.ConfigurationTarget.Workspace);
      const grouped = await api.sessionTree.getChildren();
      assert.ok(grouped.length > 0, 'グループが1つも無い');
      assert.ok(
        grouped.every((element) => isGroupNode(element)),
        'groupBy: dateなのにルートへセッションが直接出ている',
      );

      const flattened = await flattenSessions(api.sessionTree);
      assert.ok(
        flattened.some((s) => s.id === manifest.codex.named.id),
        'グループを辿ってもセッションが見つからない',
      );

      await config.update('history.groupBy', 'none', vscode.ConfigurationTarget.Workspace);
      const flat = await api.sessionTree.getChildren();
      assert.ok(flat.length > 0, 'groupBy: noneなのに一覧が空');
      assert.ok(
        flat.every((element) => !isGroupNode(element)),
        'groupBy: noneなのにグループノードが出ている',
      );
      assert.ok(
        flat.some((element) => !isGroupNode(element) && element.id === manifest.codex.named.id),
        'groupBy: noneで既存のセッションが一覧から消えている',
      );
    } finally {
      await config.update('history.groupBy', originalGroupBy, vscode.ConfigurationTarget.Workspace);
    }
  });
});
