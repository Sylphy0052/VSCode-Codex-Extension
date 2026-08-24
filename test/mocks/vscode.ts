/**
 * `vscode` モジュールの最小モック。
 *
 * 実物の `vscode` は拡張機能ホスト内でしか解決できず、vitestからは読み込めない
 * （`node_modules/vscode` が存在しない。型だけ `@types/vscode` にある）。
 * `vitest.config.ts` の `resolve.alias` で `vscode` をこのファイルへ差し替えることで、
 * `chatView.ts` / `claudeChatView.ts` / `config.ts` を実クラスのまま読み込める。
 *
 * ここに無いAPIを実装コードが新しく使い始めたら、このモックにも追加すること
 * （さもないと `Cannot read properties of undefined` のような形で壊れる）。
 *
 * `import type` は型情報だけを読み、コンパイル後に消える。`@types/vscode` は
 * パッケージとして入っているため、実行時の解決なしに型だけ借りられる
 * （テストコードが `vscode.WebviewPanel` などの実型へ構造的に適合しているかを
 * tscで確かめるために使う。tscはvitestのalias設定を知らないため、実型で検査される）。
 */
import type { Uri as VscodeUri } from 'vscode';

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
}

export enum ProgressLocation {
  Notification = 15,
}

export class Disposable {
  constructor(private readonly callOnDispose: () => void) {}
  dispose(): void {
    this.callOnDispose();
  }
}

class Emitter<T> {
  private readonly listeners: Array<(e: T) => void> = [];
  readonly event = (listener: (e: T) => void): Disposable => {
    this.listeners.push(listener);
    return new Disposable(() => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) {
        this.listeners.splice(i, 1);
      }
    });
  };
  fire(value: T): void {
    // 発火中に登録が変わっても影響しないようコピーを回す
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }
  /** 本物の`vscode.EventEmitter`と同じく、破棄後は誰にも届かない。 */
  dispose(): void {
    this.listeners.length = 0;
  }
}

export interface FakeWebview {
  html: string;
  options: { enableScripts?: boolean };
  readonly cspSource: string;
  readonly onDidReceiveMessage: (listener: (message: unknown) => void) => Disposable;
  postMessage(message: unknown): Promise<boolean>;
  asWebviewUri(uri: VscodeUri): VscodeUri;
  /** テスト用: webview側（クライアントJS）からの発言を模擬する。 */
  simulateMessage(message: unknown): void;
  /** テスト用: `postMessage` で拡張機能側から送られたメッセージの履歴。 */
  readonly sent: unknown[];
}

export interface FakeWebviewPanel {
  readonly viewType: string;
  title: string;
  readonly webview: FakeWebview;
  readonly options: Record<string, unknown>;
  readonly viewColumn: number | undefined;
  active: boolean;
  visible: boolean;
  readonly onDidChangeViewState: (
    listener: (e: { webviewPanel: FakeWebviewPanel }) => void,
  ) => Disposable;
  readonly onDidDispose: (listener: () => void) => Disposable;
  reveal(viewColumn?: number, preserveFocus?: boolean): void;
  dispose(): void;
  readonly disposed: boolean;
  /** テスト用: `createWebviewPanel` に渡された `preserveFocus` の履歴。 */
  readonly preserveFocusHistory: boolean[];
  /** テスト用: `reveal()` が呼ばれた回数。 */
  readonly revealCount: number;
  /**
   * テスト用（issue #286）: パネルを破棄せずに可視性だけを変える。
   *
   * 実VSCodeでは、背面タブへ切り替わると `visible` は `false` になるが `dispose` は
   * 呼ばれない（タブ自体は残る）。実物の `dispose()` は `visible` も `false` にするが
   * 同時にパネルを閉じてしまうため、「タブは開いたまま背面にある」状態を再現できない。
   * `active`（フォーカスの有無）とは独立に変えられるようにしてある
   * （`WebviewPanel.visible` と `active` は別物、design.md §14.55参照）。
   */
  simulateVisibilityChange(visible: boolean): void;
}

function makeFakeWebview(): FakeWebview {
  const onDidReceiveMessageEmitter = new Emitter<unknown>();
  const sent: unknown[] = [];
  return {
    html: '',
    options: {},
    cspSource: 'https://fake-webview.test',
    onDidReceiveMessage: onDidReceiveMessageEmitter.event,
    postMessage: (message: unknown) => {
      sent.push(message);
      return Promise.resolve(true);
    },
    asWebviewUri: (uri: VscodeUri) => uri,
    simulateMessage: (message: unknown) => onDidReceiveMessageEmitter.fire(message),
    sent,
  };
}

function makeFakeWebviewPanel(
  viewType: string,
  title: string,
  preserveFocus: boolean,
): FakeWebviewPanel {
  const onDidChangeViewStateEmitter = new Emitter<{ webviewPanel: FakeWebviewPanel }>();
  const onDidDisposeEmitter = new Emitter<void>();
  const preserveFocusHistory: boolean[] = [preserveFocus];
  let revealCount = 0;
  let disposed = false;

  const panel: FakeWebviewPanel = {
    viewType,
    title,
    webview: makeFakeWebview(),
    options: {},
    viewColumn: undefined,
    active: !preserveFocus,
    visible: true,
    onDidChangeViewState: onDidChangeViewStateEmitter.event,
    onDidDispose: onDidDisposeEmitter.event,
    reveal: (_viewColumn?: number, revealPreserveFocus?: boolean) => {
      revealCount += 1;
      preserveFocusHistory.push(revealPreserveFocus === true);
      panel.active = revealPreserveFocus !== true;
      onDidChangeViewStateEmitter.fire({ webviewPanel: panel });
    },
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      panel.active = false;
      panel.visible = false;
      onDidDisposeEmitter.fire(undefined);
    },
    simulateVisibilityChange: (visible: boolean) => {
      panel.visible = visible;
      if (!visible) {
        // 見えていないタブはフォーカスも持ちえない
        panel.active = false;
      }
      onDidChangeViewStateEmitter.fire({ webviewPanel: panel });
    },
    get disposed() {
      return disposed;
    },
    get preserveFocusHistory() {
      return preserveFocusHistory;
    },
    get revealCount() {
      return revealCount;
    },
  };
  return panel;
}

/** テスト用: `vscode.Uri` の最小フェイク。`fsPath` しか実装コードは使わない。 */
export interface FakeUri {
  readonly fsPath: string;
}

/**
 * `showWarningMessage` の既定の振る舞い（渡されたボタン文字列を自動で選ぶ＝常に確認する）を
 * 表す印。`__mock.showWarningMessageAnswer` を設定していないテストは全てこれに依存しているため、
 * 既定値として使う（確認ダイアログをキャンセルする経路だけ、明示的に上書きさせる）。
 */
const AUTO_CONFIRM = Symbol('auto-confirm');

/** テスト用: `vscode.workspace.fs.writeFile` に渡された内容の履歴1件。 */
export interface WrittenFile {
  path: string;
  content: string;
}

interface MockState {
  configs: Map<string, Record<string, unknown>>;
  workspaceFolders: Array<{ uri: { fsPath: string }; name: string; index: number }> | undefined;
  activeTextEditorFolderPath: string | undefined;
  createdPanels: FakeWebviewPanel[];
  messages: { warnings: string[]; errors: string[]; infos: string[] };
  /** `window.showInputBox` が返す値。テストごとに設定する（既定はキャンセル扱いの`undefined`）。 */
  showInputBoxAnswer: string | undefined;
  /**
   * `window.showQuickPick` の選び方。渡された `items` を見て選ぶ関数として設定する
   * （項目がテストごとに動的に組み立てられるため、`showInputBoxAnswer` のような静的な値では
   * 表せない）。既定は`undefined`（キャンセル扱い＝Escapeを押した状態）。
   */
  showQuickPickAnswer: ((items: readonly unknown[]) => unknown) | undefined;
  /** `workspace.fs.writeFile` に渡された内容の履歴。 */
  writtenFiles: WrittenFile[];
  /** 設定すると `workspace.fs.writeFile` がこの例外で reject する（書き込み失敗のテスト用）。 */
  writeFileError: Error | undefined;
  /**
   * `window.showWarningMessage` が返す値。既定は `AUTO_CONFIRM`（渡されたボタン文字列を
   * 自動で選ぶ）。確認ダイアログをキャンセルする経路をテストするときだけ、
   * `__mock.showWarningMessageAnswer = undefined`（Escapeで閉じた扱い）等に上書きする。
   */
  showWarningMessageAnswer: string | undefined | typeof AUTO_CONFIRM;
  /**
   * `window.showInformationMessage` が返す値（issue #286）。既定は `AUTO_CONFIRM`
   * （渡されたボタン文字列を自動で選ぶ＝常にクリックされた扱い）。通知を閉じただけ
   * （ボタンを押していない）経路をテストするときだけ
   * `__mock.showInformationMessageAnswer = undefined` に上書きする。
   */
  showInformationMessageAnswer: string | undefined | typeof AUTO_CONFIRM;
  /**
   * `workspace.openTextDocument` が「存在する」と扱うパスの集合（issue #205のデバッグ
   * ログを開く導線で使う）。既定は空集合＝常に `ENOENT` で reject する（実物の
   * `vscode.workspace.openTextDocument` がファイルの無いパスに対して行う挙動を模す）。
   */
  existingTextDocumentPaths: Set<string>;
  /**
   * `openTextDocument` に続けて `window.showTextDocument` まで実際に呼ばれた
   * （＝エディタに表示された）パスの履歴（issue #205）。
   */
  openedTextDocumentPaths: string[];
  /** `commands.executeCommand` に渡されたコマンドIDの履歴（issue #250）。 */
  executedCommands: string[];
}

const state: MockState = {
  configs: new Map(),
  workspaceFolders: undefined,
  activeTextEditorFolderPath: undefined,
  createdPanels: [],
  messages: { warnings: [], errors: [], infos: [] },
  showInputBoxAnswer: undefined,
  showQuickPickAnswer: undefined,
  writtenFiles: [],
  writeFileError: undefined,
  showWarningMessageAnswer: AUTO_CONFIRM,
  showInformationMessageAnswer: AUTO_CONFIRM,
  existingTextDocumentPaths: new Set(),
  openedTextDocumentPaths: [],
  executedCommands: [],
};

/** テストコードから内部状態を操作・観測するための入口。実装コードからは使わない。 */
export const __mock = {
  reset(): void {
    state.configs.clear();
    state.workspaceFolders = undefined;
    state.activeTextEditorFolderPath = undefined;
    state.createdPanels = [];
    state.messages = { warnings: [], errors: [], infos: [] };
    state.showInputBoxAnswer = undefined;
    state.showQuickPickAnswer = undefined;
    state.writtenFiles = [];
    state.writeFileError = undefined;
    state.showWarningMessageAnswer = AUTO_CONFIRM;
    state.showInformationMessageAnswer = AUTO_CONFIRM;
    state.existingTextDocumentPaths = new Set();
    state.openedTextDocumentPaths = [];
    state.executedCommands = [];
  },
  /** `commands.executeCommand` が呼ばれたコマンドIDの履歴（issue #250）。 */
  get executedCommands(): string[] {
    return state.executedCommands;
  },
  set showInputBoxAnswer(value: string | undefined) {
    state.showInputBoxAnswer = value;
  },
  get showInputBoxAnswer(): string | undefined {
    return state.showInputBoxAnswer;
  },
  set showQuickPickAnswer(value: ((items: readonly unknown[]) => unknown) | undefined) {
    state.showQuickPickAnswer = value;
  },
  get showQuickPickAnswer(): ((items: readonly unknown[]) => unknown) | undefined {
    return state.showQuickPickAnswer;
  },
  get writtenFiles(): WrittenFile[] {
    return state.writtenFiles;
  },
  set writeFileError(value: Error | undefined) {
    state.writeFileError = value;
  },
  /** 確認ダイアログ（`showWarningMessage`）をキャンセルさせたいときだけ設定する。 */
  set showWarningMessageAnswer(value: string | undefined) {
    state.showWarningMessageAnswer = value;
  },
  /** 通知（`showInformationMessage`）を閉じただけの経路をテストしたいときだけ設定する（issue #286）。 */
  set showInformationMessageAnswer(value: string | undefined) {
    state.showInformationMessageAnswer = value;
  },
  setConfig(section: string, values: Record<string, unknown>): void {
    state.configs.set(section, values);
  },
  setWorkspaceFolder(fsPath: string): void {
    state.workspaceFolders = [{ uri: { fsPath }, name: fsPath, index: 0 }];
    state.activeTextEditorFolderPath = fsPath;
  },
  /** マルチルートワークスペース用: 複数フォルダを一括設定する（issue #144の統合テスト）。 */
  setWorkspaceFolders(folders: ReadonlyArray<{ fsPath: string; name: string }>): void {
    state.workspaceFolders = folders.map((f, index) => ({
      uri: { fsPath: f.fsPath },
      name: f.name,
      index,
    }));
    state.activeTextEditorFolderPath = folders[0]?.fsPath;
  },
  clearWorkspaceFolder(): void {
    state.workspaceFolders = undefined;
    state.activeTextEditorFolderPath = undefined;
  },
  get createdPanels(): FakeWebviewPanel[] {
    return state.createdPanels;
  },
  lastCreatedPanel(): FakeWebviewPanel | undefined {
    return state.createdPanels[state.createdPanels.length - 1];
  },
  get messages(): { warnings: string[]; errors: string[]; infos: string[] } {
    return state.messages;
  },
  /**
   * `workspace.openTextDocument` を成功させる（＝ファイルが存在する扱いにする）パスを
   * 指定する（issue #205）。指定しないパスへの `openTextDocument` は reject する。
   */
  setExistingTextDocumentPaths(paths: readonly string[]): void {
    state.existingTextDocumentPaths = new Set(paths);
  },
  /** `showTextDocument` まで実際に呼ばれた（＝エディタに表示された）パスの履歴（issue #205）。 */
  get openedTextDocumentPaths(): string[] {
    return state.openedTextDocumentPaths;
  },
};

function getNested(values: Record<string, unknown>, key: string): unknown {
  if (key in values) {
    return values[key];
  }
  const parts = key.split('.');
  let cursor: unknown = values;
  for (const part of parts) {
    if (typeof cursor !== 'object' || cursor === null) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function makeWorkspaceConfiguration(section: string): {
  get<T>(key: string, defaultValue?: T): T | undefined;
} {
  return {
    get<T>(key: string, defaultValue?: T): T | undefined {
      const values = state.configs.get(section) ?? {};
      const value = getNested(values, key);
      return (value === undefined ? defaultValue : value) as T | undefined;
    },
  };
}

export const workspace = {
  getConfiguration(section: string): ReturnType<typeof makeWorkspaceConfiguration> {
    return makeWorkspaceConfiguration(section);
  },
  get workspaceFolders(): MockState['workspaceFolders'] {
    return state.workspaceFolders;
  },
  getWorkspaceFolder(
    _uri: unknown,
  ): MockState['workspaceFolders'] extends (infer U)[] | undefined ? U | undefined : never {
    return state.workspaceFolders?.[0] as never;
  },
  fs: {
    /** テスト用: 実ディスクへは書かず、内容を `__mock.writtenFiles` へ記録するだけ。 */
    writeFile: (uri: FakeUri, content: Uint8Array): Promise<void> => {
      if (state.writeFileError !== undefined) {
        return Promise.reject(state.writeFileError);
      }
      state.writtenFiles.push({ path: uri.fsPath, content: Buffer.from(content).toString('utf8') });
      return Promise.resolve();
    },
  },
  /**
   * テスト用: `__mock.setExistingTextDocumentPaths` で指定したパスだけ成功する
   * （issue #205のデバッグログを開く導線。候補が複数ある実装のフォールバックを
   * テストできるよう、実物と同じく無いパスは reject する）。
   */
  openTextDocument: (uri: FakeUri): Promise<{ uri: FakeUri }> => {
    if (!state.existingTextDocumentPaths.has(uri.fsPath)) {
      return Promise.reject(new Error(`ENOENT: no such file, open '${uri.fsPath}'`));
    }
    return Promise.resolve({ uri });
  },
};

/**
 * テスト用: `vscode.Uri` の最小フェイク。
 *
 * `Uri.file` に加えて `Uri.from`（履歴ツリーの仮想URI、issue #735）を持つ。
 * `from` が返す値は `scheme` / `path` を持ち、`fsPath` は本物と同じく path 相当を返す。
 */
export const Uri = {
  file: (fsPath: string): FakeUri => ({ fsPath }),
  from: ({ scheme, path }: { scheme: string; path?: string }): FakeSchemeUri => ({
    scheme,
    path: path ?? '',
    fsPath: path ?? '',
  }),
};

/** テスト用: スキーム付きURIの最小フェイク（issue #735）。 */
export interface FakeSchemeUri {
  readonly scheme: string;
  readonly path: string;
  readonly fsPath: string;
}

/**
 * テスト用: `vscode.commands` の最小フェイク（issue #250）。
 *
 * チャット画面のワークフローボタンは `agent.workflows.menu` を呼ぶだけで、実体は
 * `extension.ts` 側にある。ここでは実行を模さず、呼ばれたコマンドIDを記録するに留める。
 */
export const commands = {
  executeCommand: (command: string, ..._args: unknown[]): Promise<undefined> => {
    state.executedCommands.push(command);
    return Promise.resolve(undefined);
  },
};

export const window = {
  get activeTextEditor(): { document: { uri: unknown } } | undefined {
    if (state.activeTextEditorFolderPath === undefined) {
      return undefined;
    }
    return { document: { uri: { fsPath: state.activeTextEditorFolderPath } } };
  },
  createWebviewPanel(
    viewType: string,
    title: string,
    showOptions: number | { viewColumn: number; preserveFocus?: boolean },
    _options?: unknown,
  ): FakeWebviewPanel {
    const preserveFocus =
      typeof showOptions === 'object' && showOptions !== null
        ? showOptions.preserveFocus === true
        : false;
    const panel = makeFakeWebviewPanel(viewType, title, preserveFocus);
    state.createdPanels.push(panel);
    return panel;
  },
  showErrorMessage: (message: string, ...items: string[]): Promise<string | undefined> => {
    state.messages.errors.push(message);
    return Promise.resolve(items[0]);
  },
  showWarningMessage: (message: string, ...items: unknown[]): Promise<string | undefined> => {
    state.messages.warnings.push(message);
    if (state.showWarningMessageAnswer !== AUTO_CONFIRM) {
      return Promise.resolve(state.showWarningMessageAnswer);
    }
    const choice = items.find((i): i is string => typeof i === 'string');
    return Promise.resolve(choice);
  },
  showInformationMessage: (message: string, ...items: string[]): Promise<string | undefined> => {
    state.messages.infos.push(message);
    if (state.showInformationMessageAnswer !== AUTO_CONFIRM) {
      return Promise.resolve(state.showInformationMessageAnswer);
    }
    return Promise.resolve(items[0]);
  },
  showInputBox: (_options?: unknown): Promise<string | undefined> =>
    Promise.resolve(state.showInputBoxAnswer),
  /**
   * テスト用: 実際にエディタへ表示はせず、渡された文書のパスを
   * `__mock.openedTextDocumentPaths` へ記録するだけ（issue #205）。
   */
  showTextDocument: (doc: { uri: FakeUri }, _options?: unknown): Promise<void> => {
    state.openedTextDocumentPaths.push(doc.uri.fsPath);
    return Promise.resolve(undefined);
  },
  showQuickPick: (items: readonly unknown[], _options?: unknown): Promise<unknown> =>
    Promise.resolve(state.showQuickPickAnswer?.(items)),
  withProgress: async <T>(
    _options: unknown,
    task: (progress: { report: () => void }) => Thenable<T>,
  ): Promise<T> => task({ report: () => undefined }),
  /** テスト用: 表示はせず、状態を持つだけの項目を返す（issue #755）。 */
  createStatusBarItem: (alignment: StatusBarAlignment, priority?: number): FakeStatusBarItem =>
    new FakeStatusBarItem(alignment, priority),
};

/** `vscode.StatusBarAlignment` の代わり。実物と同じ値にする。 */
export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

/**
 * `vscode.StatusBarItem` の代わり（issue #755）。`show()` / `hide()` は
 * 見えているかどうかを `visible` に記録するだけ。
 */
export class FakeStatusBarItem {
  text = '';
  name: string | undefined;
  command: string | undefined;
  tooltip: MarkdownString | string | undefined;
  backgroundColor: ThemeColor | undefined;
  visible = false;
  disposed = false;

  constructor(
    readonly alignment: StatusBarAlignment,
    readonly priority: number | undefined,
  ) {}

  show(): void {
    this.visible = true;
  }

  hide(): void {
    this.visible = false;
  }

  dispose(): void {
    this.disposed = true;
  }
}

export type StatusBarItem = FakeStatusBarItem;

export type WebviewPanel = FakeWebviewPanel;
export type Webview = FakeWebview;
export type WorkspaceConfiguration = ReturnType<typeof makeWorkspaceConfiguration>;
export type WorkspaceFolder = NonNullable<MockState['workspaceFolders']>[number];
export type OutputChannel = {
  appendLine(value: string): void;
  show(): void;
};

/**
 * ツリービュー関連の最小モック（`SessionTreeProvider` のテスト用）。
 * 実物と同じく、生成後にプロパティを代入して組み立てる形にする。
 */
export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

/** `vscode.ThemeColor` の代わり。色IDを持つだけ（issue #733）。 */
export class ThemeColor {
  constructor(readonly id: string) {}
}

/**
 * `vscode.FileDecoration` の代わり（issue #735）。
 * バッジ・ツールチップ・色を持つだけ。
 */
export class FileDecoration {
  constructor(
    readonly badge?: string,
    readonly tooltip?: string,
    readonly color?: ThemeColor,
  ) {}
}

export class ThemeIcon {
  constructor(
    readonly id: string,
    readonly color?: ThemeColor,
  ) {}
}

export class MarkdownString {
  constructor(public value = '') {}
}

export class TreeItem {
  id?: string;
  description?: string;
  /** issue #735: 行末デコレーションを効かせるための仮想URI。 */
  resourceUri?: FakeSchemeUri;
  tooltip?: MarkdownString | string;
  iconPath?: ThemeIcon;
  contextValue?: string;
  command?: { command: string; title: string; arguments?: unknown[] };

  constructor(
    public label: string,
    public collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None,
  ) {}
}

/** `vscode.EventEmitter` の代わり。上で定義済みの `Emitter` をそのまま公開する。 */
export { Emitter as EventEmitter };
