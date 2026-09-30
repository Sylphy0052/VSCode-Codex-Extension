import * as vscode from 'vscode';

/**
 * 背面で開く子セッションのタブが、人の見ていたタブを隠さないようにする（Issue #1699）。
 *
 * `createWebviewPanel`は`preserveFocus: true`でもフォーカスを移さないだけで、作ったタブを
 * そのグループで表示中にする。VS Code APIにはwebviewパネルを表示せずに作る手段が無いため、
 * 作成前に対象グループで表示中のタブを記録し、作成直後にフォーカスを移さず表示し直す。
 * 表示し直す手段の無いタブ（他の拡張のwebview、エディタ領域のターミナルなど）が表示中なら、
 * 子タブを隣のグループへ開いて人の見ているグループに触れない。
 * どちらの場合も新しいグループは作らない。人が選んだ列数を子タブが増やさない（Issue #1774）。
 */
export interface BackgroundOpenPlan {
  /** 子タブを開く列。表示し直せないタブを避けるときだけ呼び出し側の指定から変わる。 */
  readonly viewColumn: vscode.ViewColumn | undefined;
  /** 子タブを作った直後に呼び、見ていたタブを表示し直す。隠れるタブが無ければ`undefined`。 */
  readonly restore: (() => Thenable<unknown>) | undefined;
}

/**
 * 表示し直しに使う本拡張のwebviewパネル（チャットとKanban）。Codex版とClaude版の管理クラスは
 * 別々にパネルを持つため、どのタブが見られていても引けるようモジュールで共有する。
 */
const chatPanels = new Set<vscode.WebviewPanel>();

/** webviewパネルを表示し直しの対象に加える。パネルが破棄されたら外す。 */
export function trackChatPanel(panel: vscode.WebviewPanel): void {
  chatPanels.add(panel);
  panel.onDidDispose(() => chatPanels.delete(panel));
}

/**
 * 表示し直している最中のグループと、その表示し直し（列番号がキー）。
 *
 * 並列のタスクが続けて子タブを開くと、2つ目を開く時点ではグループの表示中タブが
 * 1つ目の子タブに変わっていることがある。それを表示し直すと人の見ていたタブが隠れるため、
 * 表示し直しが終わるまでは、同じグループへの後続も最初に記録したタブを表示し直す。
 * 記録は表示し直しを始めたときに行う（子タブの作成が失敗して呼ばれなかった段取りを残さない）。
 */
const pendingRestores = new Map<
  vscode.ViewColumn,
  { readonly restore: () => Thenable<unknown>; inFlight: number }
>();

function trackPending(
  viewColumn: vscode.ViewColumn,
  restoreOnce: () => Thenable<unknown>,
): () => Thenable<unknown> {
  const restore = (): Thenable<unknown> => {
    let pending = pendingRestores.get(viewColumn);
    if (pending?.restore !== restore) {
      pending = { restore, inFlight: 0 };
      pendingRestores.set(viewColumn, pending);
    }
    const current = pending;
    current.inFlight += 1;
    // 破棄済みパネルの`reveal`など同期で投げる失敗も、拒否されたPromiseとして返す
    return new Promise<unknown>((resolve) => resolve(restoreOnce())).finally(() => {
      current.inFlight -= 1;
      if (current.inFlight === 0 && pendingRestores.get(viewColumn) === current) {
        pendingRestores.delete(viewColumn);
      }
    });
  };
  return restore;
}

/**
 * 子タブを`targetViewColumn`へ背面で開くときの段取りを決める。タブを作る直前に呼ぶ。
 * 指定の列のグループがまだ無ければ、既存の最も右のグループへ寄せる。
 * 対象グループが空なら、隠れるタブが無いので指定どおりに開く。
 */
export function planBackgroundOpen(
  requestedViewColumn: vscode.ViewColumn | undefined,
): BackgroundOpenPlan {
  const targetViewColumn = clampToExistingColumn(requestedViewColumn);
  const group = findTargetGroup(targetViewColumn);
  if (group === undefined) {
    return { viewColumn: targetViewColumn, restore: undefined };
  }
  const pending = pendingRestores.get(group.viewColumn);
  if (pending !== undefined) {
    return { viewColumn: targetViewColumn, restore: pending.restore };
  }
  const tab = group.activeTab;
  if (tab === undefined) {
    return { viewColumn: targetViewColumn, restore: undefined };
  }
  const restoreOnce = restoreTab(tab, group.viewColumn);
  if (restoreOnce !== undefined) {
    return { viewColumn: targetViewColumn, restore: trackPending(group.viewColumn, restoreOnce) };
  }
  // 隣の列のグループが無ければ、隠れるタブがあっても指定の列へ開く（列を増やさない方を優先する）
  const next = group.viewColumn + 1;
  const hasNextGroup = vscode.window.tabGroups.all.some((g) => g.viewColumn === next);
  return { viewColumn: hasNextGroup ? next : targetViewColumn, restore: undefined };
}

/**
 * 列番号の指定が、まだ無いグループを指していれば既存の最も右の列に置き換える。
 * `createWebviewPanel`は無い列を指定されるとグループを新しく作るため。
 */
function clampToExistingColumn(
  viewColumn: vscode.ViewColumn | undefined,
): vscode.ViewColumn | undefined {
  if (viewColumn === undefined || viewColumn <= 0) {
    // `Active`（-1）と`Beside`（-2）はそのまま（`Beside`を使う呼び出し元は列を増やす意図）
    return viewColumn;
  }
  const columns = vscode.window.tabGroups.all.map((g) => g.viewColumn);
  if (columns.length === 0 || columns.includes(viewColumn)) {
    return viewColumn;
  }
  return Math.max(...columns);
}

function findTargetGroup(
  targetViewColumn: vscode.ViewColumn | undefined,
): vscode.TabGroup | undefined {
  const { tabGroups } = vscode.window;
  if (targetViewColumn === undefined || targetViewColumn === vscode.ViewColumn.Active) {
    return tabGroups.activeTabGroup;
  }
  if (targetViewColumn === vscode.ViewColumn.Beside) {
    // 開く先は作ってみるまで決まらない。人が見ているグループ（アクティブ）とは別になる
    return undefined;
  }
  return tabGroups.all.find((g) => g.viewColumn === targetViewColumn);
}

function restoreTab(
  tab: vscode.Tab,
  viewColumn: vscode.ViewColumn,
): (() => Thenable<unknown>) | undefined {
  const input = tab.input;
  // プレビューだったタブはプレビューのまま戻す（固定タブにすると人のタブ運用が変わる）
  const options: vscode.TextDocumentShowOptions = {
    viewColumn,
    preserveFocus: true,
    preview: tab.isPreview,
  };
  if (input instanceof vscode.TabInputText) {
    return () => vscode.commands.executeCommand('vscode.open', input.uri, options);
  }
  if (input instanceof vscode.TabInputTextDiff) {
    return () =>
      vscode.commands.executeCommand(
        'vscode.diff',
        input.original,
        input.modified,
        tab.label,
        options,
      );
  }
  if (input instanceof vscode.TabInputCustom) {
    return () =>
      vscode.commands.executeCommand('vscode.openWith', input.uri, input.viewType, options);
  }
  if (input instanceof vscode.TabInputNotebook) {
    return () =>
      vscode.commands.executeCommand('vscode.openWith', input.uri, input.notebookType, options);
  }
  if (input instanceof vscode.TabInputWebview) {
    // 1つのグループで表示中のタブは1つだけなので、同じ列で見えているチャットパネルが当のタブ
    const panel = [...chatPanels].find((p) => p.visible && p.viewColumn === viewColumn);
    if (panel !== undefined) {
      return () => {
        panel.reveal(viewColumn, true);
        return Promise.resolve();
      };
    }
  }
  return undefined;
}
