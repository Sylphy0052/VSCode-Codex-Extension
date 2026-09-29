import * as vscode from 'vscode';

/**
 * 背面で開く子セッションのタブが、人の見ていたタブを隠さないようにする（Issue #1699）。
 *
 * `createWebviewPanel`は`preserveFocus: true`でもフォーカスを移さないだけで、作ったタブを
 * そのグループで表示中にする。VS Code APIにはwebviewパネルを表示せずに作る手段が無いため、
 * 作成前に対象グループで表示中のタブを記録し、作成直後にフォーカスを移さず表示し直す。
 * 表示し直す手段の無いタブ（他の拡張のwebview、エディタ領域のターミナルなど）が表示中なら、
 * 子タブを隣のグループへ開いて人の見ているグループに触れない。
 */
export interface BackgroundOpenPlan {
  /** 子タブを開く列。表示し直せないタブを避けるときだけ呼び出し側の指定から変わる。 */
  readonly viewColumn: vscode.ViewColumn | undefined;
  /** 子タブを作った直後に呼び、見ていたタブを表示し直す。隠れるタブが無ければ`undefined`。 */
  readonly restore: (() => Thenable<unknown>) | undefined;
}

/**
 * 表示し直しに使う本拡張のチャットパネル。Codex版とClaude版の管理クラスは別々に
 * パネルを持つため、どちらのタブが見られていても引けるようモジュールで共有する。
 */
const chatPanels = new Set<vscode.WebviewPanel>();

/** チャットパネルを表示し直しの対象に加える。パネルが破棄されたら外す。 */
export function trackChatPanel(panel: vscode.WebviewPanel): void {
  chatPanels.add(panel);
  panel.onDidDispose(() => chatPanels.delete(panel));
}

/** 最大の列番号。これより右へは列番号で開けない。 */
const MAX_VIEW_COLUMN = 9;

/**
 * 子タブを`targetViewColumn`へ背面で開くときの段取りを決める。タブを作る直前に呼ぶ。
 * 対象グループがまだ無いか空なら、隠れるタブが無いので指定どおりに開く。
 */
export function planBackgroundOpen(
  targetViewColumn: vscode.ViewColumn | undefined,
): BackgroundOpenPlan {
  const group = findTargetGroup(targetViewColumn);
  const tab = group?.activeTab;
  if (group === undefined || tab === undefined) {
    return { viewColumn: targetViewColumn, restore: undefined };
  }
  const restore = restoreTab(tab, group.viewColumn);
  if (restore !== undefined) {
    return { viewColumn: targetViewColumn, restore };
  }
  const next = group.viewColumn + 1;
  return {
    viewColumn: next <= MAX_VIEW_COLUMN ? next : vscode.ViewColumn.Beside,
    restore: undefined,
  };
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
