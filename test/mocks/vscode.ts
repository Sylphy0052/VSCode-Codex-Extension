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
import type { Uri } from 'vscode';

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
}

export interface FakeWebview {
  html: string;
  options: { enableScripts?: boolean };
  readonly cspSource: string;
  readonly onDidReceiveMessage: (listener: (message: unknown) => void) => Disposable;
  postMessage(message: unknown): Promise<boolean>;
  asWebviewUri(uri: Uri): Uri;
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
    asWebviewUri: (uri: Uri) => uri,
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

interface MockState {
  configs: Map<string, Record<string, unknown>>;
  workspaceFolders: Array<{ uri: { fsPath: string }; name: string; index: number }> | undefined;
  activeTextEditorFolderPath: string | undefined;
  createdPanels: FakeWebviewPanel[];
  messages: { warnings: string[]; errors: string[]; infos: string[] };
  /** `window.showInputBox` が返す値。テストごとに設定する（既定はキャンセル扱いの`undefined`）。 */
  showInputBoxAnswer: string | undefined;
  /**
   * `window.showQuickPick` が返す値。渡された選択肢配列のインデックスで指定する
   * （`undefined` はキャンセル扱い。既定はキャンセル）。
   */
  showQuickPickAnswerIndex: number | undefined;
  /**
   * `window.showWarningMessage` が返す値の上書き。未設定（`set: false`）なら従来通り
   * 渡されたボタン文字列のうち最初の1件を自動で選ぶ（＝確認ダイアログを自動承認する）。
   * `set: true` にすると `value`（`undefined` を含む）をそのまま返す（キャンセルを模擬できる）。
   */
  showWarningMessageOverride: { set: boolean; value: string | undefined };
  /** `vscode.commands.executeCommand` の呼び出し履歴。 */
  executedCommands: { command: string; args: unknown[] }[];
}

const state: MockState = {
  configs: new Map(),
  workspaceFolders: undefined,
  activeTextEditorFolderPath: undefined,
  createdPanels: [],
  messages: { warnings: [], errors: [], infos: [] },
  showInputBoxAnswer: undefined,
  showQuickPickAnswerIndex: undefined,
  showWarningMessageOverride: { set: false, value: undefined },
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
    state.showQuickPickAnswerIndex = undefined;
    state.showWarningMessageOverride = { set: false, value: undefined };
    state.executedCommands = [];
  },
  set showInputBoxAnswer(value: string | undefined) {
    state.showInputBoxAnswer = value;
  },
  get showInputBoxAnswer(): string | undefined {
    return state.showInputBoxAnswer;
  },
  set showQuickPickAnswerIndex(value: number | undefined) {
    state.showQuickPickAnswerIndex = value;
  },
  get showQuickPickAnswerIndex(): number | undefined {
    return state.showQuickPickAnswerIndex;
  },
  /** 以後の `showWarningMessage` 呼び出しが返す値を固定する（`undefined` でキャンセルを模擬）。 */
  setShowWarningMessageAnswer(value: string | undefined): void {
    state.showWarningMessageOverride = { set: true, value };
  },
  get executedCommands(): { command: string; args: unknown[] }[] {
    return state.executedCommands;
  },
  setConfig(section: string, values: Record<string, unknown>): void {
    state.configs.set(section, values);
  },
  setWorkspaceFolder(fsPath: string): void {
    state.workspaceFolders = [{ uri: { fsPath }, name: fsPath, index: 0 }];
    state.activeTextEditorFolderPath = fsPath;
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
    if (state.showWarningMessageOverride.set) {
      return Promise.resolve(state.showWarningMessageOverride.value);
    }
    const choice = items.find((i): i is string => typeof i === 'string');
    return Promise.resolve(choice);
  },
  showInformationMessage: (message: string, ...items: string[]): Promise<string | undefined> => {
    state.messages.infos.push(message);
    return Promise.resolve(items[0]);
  },
  showInputBox: (_options?: unknown): Promise<string | undefined> =>
    Promise.resolve(state.showInputBoxAnswer),
  /**
   * `state.showQuickPickAnswerIndex` に設定したインデックスの要素を返す
   * （未設定・範囲外・非配列は `undefined` = キャンセル扱い）。
   */
  showQuickPick: (items: unknown, _options?: unknown): Promise<unknown> => {
    const index = state.showQuickPickAnswerIndex;
    if (index === undefined || !Array.isArray(items)) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(items[index]);
  },
  withProgress: async <T>(
    _options: unknown,
    task: (progress: { report: () => void }) => Thenable<T>,
  ): Promise<T> => task({ report: () => undefined }),
};

/** `vscode.commands`。呼び出し履歴は `__mock.executedCommands` から確認する。 */
export const commands = {
  executeCommand: (command: string, ...args: unknown[]): Promise<unknown> => {
    state.executedCommands.push({ command, args });
    return Promise.resolve(undefined);
  },
};

export type WebviewPanel = FakeWebviewPanel;
export type Webview = FakeWebview;
export type WorkspaceConfiguration = ReturnType<typeof makeWorkspaceConfiguration>;
export type WorkspaceFolder = NonNullable<MockState['workspaceFolders']>[number];
export type OutputChannel = {
  appendLine(value: string): void;
  show(): void;
};
