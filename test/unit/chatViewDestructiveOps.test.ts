import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscodeMock from '../mocks/vscode';
import { __mock } from '../mocks/vscode';
import {
  addAttachment,
  confirmRevertDiff,
  confirmRewindFiles,
  confirmRunShellCommand,
  handleOpenDiffEditor,
  handleOpenDiffFile,
  handleRevertDiff,
  postFileMentions,
  postImageData,
} from '../../src/view/chatShared';
import type { ChatItem, FileDiff } from '../../src/appserver/chatState';
import type { FileSystemPort } from '../../src/session/ports';
import {
  sameFileIdentity,
  type FileIdentity,
  type RevertFilePort,
  type RewriteDecision,
  type RewriteOutcome,
} from '../../src/util/revertFile';
import { AttachmentBox } from '../../src/provider/attachments';
import { FileMentionCatalog, type FileScanPort } from '../../src/provider/fileMentions';

/**
 * `test/mocks/vscode.ts` は既存テストの共有インフラであり、issue #359では実装だけでなく
 * 共有モックにも手を入れない（テストの追加だけに留める）方針のため変更しない。
 *
 * `handleRevertDiff` / `handleOpenDiffFile` / `handleOpenDiffEditor` が使う
 * `vscode.workspace.fs.delete` / `vscode.Position` / `vscode.Selection` / `vscode.Range` /
 * `vscode.TextEditorRevealType` は共有モックに無いため、このファイルの中だけで
 * ランタイムに追加する（モジュールの実体を書き換えるのではなく、importした
 * オブジェクトへプロパティを足すだけ。他のテストファイルはvitestの既定
 * （ファイルごとに別モジュールインスタンス）により影響を受けない）。
 */
interface DeletedFile {
  path: string;
  useTrash: boolean;
}
const deletedFiles: DeletedFile[] = [];

interface RevealedRange {
  startLine: number;
  revealType: unknown;
}
const revealedRanges: RevealedRange[] = [];

class FakePosition {
  constructor(
    public readonly line: number,
    public readonly character: number,
  ) {}
}
class FakeSelection {
  constructor(
    public readonly anchor: FakePosition,
    public readonly active: FakePosition,
  ) {}
}
class FakeRange {
  constructor(
    public readonly start: FakePosition,
    public readonly end: FakePosition,
  ) {}
}

/** `existingContentForDeleteRevert` が `code === 'FileNotFound'` で見分ける例外の最小フェイク。 */
class FakeFileSystemError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

type WritableVscodeMock = typeof vscodeMock & {
  Position: typeof FakePosition;
  Selection: typeof FakeSelection;
  Range: typeof FakeRange;
  TextEditorRevealType: { InCenter: number };
  FileSystemError: typeof FakeFileSystemError;
};
const writableMock = vscodeMock as WritableVscodeMock;
writableMock.Position = FakePosition;
writableMock.Selection = FakeSelection;
writableMock.Range = FakeRange;
writableMock.TextEditorRevealType = { InCenter: 2 };
writableMock.FileSystemError = FakeFileSystemError;
// `delete` の戻し（再作成）は `workspace.fs.stat` で「無い」ことを確かめる。共有モックに無いため、
// このファイルの中だけ常に FileNotFound で reject させる（対象は存在しない前提のテストだけ）
(
  vscodeMock.workspace.fs as unknown as { stat: (uri: { fsPath: string }) => Promise<unknown> }
).stat = () => Promise.reject(new FakeFileSystemError('FileNotFound'));
(
  vscodeMock.workspace.fs as unknown as {
    delete: (uri: { fsPath: string }, opts: { useTrash: boolean }) => Promise<void>;
  }
).delete = (uri, opts) => {
  deletedFiles.push({ path: uri.fsPath, useTrash: opts.useTrash });
  return Promise.resolve();
};

/**
 * 共有モックの `workspace.openTextDocument` は実ファイルパス（`Uri.file`）しか
 * 想定しておらず、`lineCount` も持たない。`handleOpenDiffFile` の行ジャンプ計算
 * （`doc.lineCount`）と、`handleOpenDiffEditor` が使う仮想ドキュメント形式
 * （`{content, language}`）の両方をこのファイル内だけで補う。
 */
const originalOpenTextDocument = vscodeMock.workspace.openTextDocument;
let virtualDocCounter = 0;
(
  vscodeMock.workspace as unknown as {
    openTextDocument: (arg: unknown) => Promise<{ uri: { fsPath: string }; lineCount: number }>;
  }
).openTextDocument = async (arg: unknown) => {
  if (arg !== null && typeof arg === 'object' && 'content' in (arg as Record<string, unknown>)) {
    virtualDocCounter += 1;
    const content = (arg as { content: string }).content;
    return {
      uri: { fsPath: `untitled:virtual-${virtualDocCounter}` },
      lineCount: content === '' ? 1 : content.split('\n').length,
    };
  }
  const doc = await originalOpenTextDocument(arg as Parameters<typeof originalOpenTextDocument>[0]);
  return { ...doc, lineCount: 5 };
};

/** `openTextDocument` が返す `TextDocument` の最小フェイク。行番号ジャンプの検査に使う。 */
interface FakeTextEditor {
  selection: FakeSelection | undefined;
  revealedRanges: unknown[];
  revealRange(range: unknown, type: unknown): void;
}
function patchShowTextDocumentForEditorFake(): FakeTextEditor {
  const editor: FakeTextEditor = {
    selection: undefined,
    revealedRanges: [],
    revealRange(range: unknown, type: unknown) {
      editor.revealedRanges.push(range);
      revealedRanges.push({
        startLine: (range as { start: FakePosition }).start.line,
        revealType: type,
      });
    },
  };
  (
    vscodeMock.window as unknown as { showTextDocument: (doc: unknown) => Promise<FakeTextEditor> }
  ).showTextDocument = (doc: unknown) => {
    const fsPath = (doc as { uri: { fsPath: string } }).uri.fsPath;
    __mock.openedTextDocumentPaths.push(fsPath);
    return Promise.resolve(editor);
  };
  return editor;
}

/**
 * `FileSystemPort` のフェイク。`readTextFile` の呼び出し回数を数えられるようにし、
 * 「確認モーダルの前後で読み直す」（TOCTOU対策）を検査できるようにする。
 */
class FakeFs implements FileSystemPort {
  readTextFileCalls = 0;
  /** 呼び出し回数ごとに違う内容を返したいテスト用（TOCTOU検査）。指定が無ければ `content` を返す。 */
  contentByCall: (string | undefined)[] | undefined;

  constructor(private content: string | undefined) {}

  async readTextFile(filePath: string): Promise<string | undefined> {
    this.readTextFileCalls += 1;
    if (this.contentByCall !== undefined) {
      const idx = Math.min(this.readTextFileCalls - 1, this.contentByCall.length - 1);
      return this.contentByCall[idx];
    }
    void filePath;
    return this.content;
  }
  async readFirstLine(): Promise<string | undefined> {
    throw new Error('not used');
  }
  async readTail(): Promise<string | undefined> {
    throw new Error('not used');
  }
  async mtimeMs(): Promise<number | undefined> {
    throw new Error('not used');
  }
  async listRollouts(): Promise<string[]> {
    throw new Error('not used');
  }
  async listJsonl(): Promise<string[]> {
    throw new Error('not used');
  }
  async listMarkdown(): Promise<string[]> {
    throw new Error('not used');
  }
  async readHead(): Promise<string[]> {
    throw new Error('not used');
  }
  async readBase64File(filePath: string, maxBytes: number): Promise<string | undefined> {
    void filePath;
    void maxBytes;
    if (this.content === undefined) {
      return undefined;
    }
    return Buffer.from(this.content).toString('base64');
  }
}

/**
 * `update` 種別の差分。1行を書き換える最小のunified diff（ハンク見出しあり）。
 * `computeDiffContents` が変更前後を復元できる形にしてある。
 */
function updateDiff(overrides: Partial<FileDiff> = {}): FileDiff {
  return {
    path: 'src/a.txt',
    kind: 'update',
    movePath: undefined,
    diff: '@@ -1,1 +1,1 @@\n-old\n+new\n',
    editReplace: undefined,
    ...overrides,
  };
}

/** `add` 種別の差分（新規ファイル。戻す＝削除）。 */
function addDiff(overrides: Partial<FileDiff> = {}): FileDiff {
  return {
    path: 'src/new.txt',
    kind: 'add',
    movePath: undefined,
    diff: '+created\n',
    editReplace: undefined,
    ...overrides,
  };
}

/**
 * `RevertFilePort` のフェイク（Issue #1170）。実体の識別子と、fdから読んだことにする内容を
 * テスト側で決められるようにし、「確認後に実体が変わっていたら書かない」を検査する。
 */
class FakeRevertPort implements RevertFilePort {
  /** `identify` の呼び出しごとに返す識別子。末尾を超えたら最後の値を返し続ける。 */
  identities: (FileIdentity | undefined)[] = [{ dev: 1, ino: 100 }];
  /** `rewrite` が開いた実体の識別子。未設定なら期待どおり（同じ実体）。 */
  openedIdentity: FileIdentity | undefined;
  identifyCalls = 0;
  written: { path: string; content: string }[] = [];
  created: { path: string; content: string }[] = [];

  /** @param current `rewrite` がfdから読んだことにする現在の内容 */
  constructor(private readonly current: string | undefined) {}

  async identify(): Promise<FileIdentity | undefined> {
    const idx = Math.min(this.identifyCalls, this.identities.length - 1);
    this.identifyCalls += 1;
    return this.identities[idx];
  }

  async rewrite(
    absolutePath: string,
    expected: FileIdentity,
    next: (current: string) => RewriteDecision,
  ): Promise<RewriteOutcome> {
    const opened = this.openedIdentity ?? expected;
    if (!sameFileIdentity(opened, expected)) {
      return { kind: 'changed' };
    }
    if (this.current === undefined) {
      throw new Error('ENOENT');
    }
    const decided = next(this.current);
    if (!decided.ok) {
      return { kind: 'aborted', reason: decided.reason };
    }
    this.written.push({ path: absolutePath, content: decided.content });
    return { kind: 'written' };
  }

  async createNew(absolutePath: string, content: string): Promise<void> {
    this.created.push({ path: absolutePath, content });
  }
}

/** `delete` 種別の差分（削除されたファイル。戻す＝元の内容で再作成）。 */
function deleteDiff(overrides: Partial<FileDiff> = {}): FileDiff {
  return {
    path: 'src/gone.txt',
    kind: 'delete',
    movePath: undefined,
    diff: '-was here\n',
    editReplace: undefined,
    ...overrides,
  };
}

function itemWithDiff(diff: FileDiff): ChatItem {
  return {
    id: 'item-1',
    kind: 'fileChange',
    text: '',
    detail: diff.path,
    status: undefined,
    turnId: undefined,
    diffs: [diff],
  };
}

/** 一時ディレクトリを実ワークスペースとして使う。実ファイルシステムへ書き込むのはこのtmpディレクトリの存在確認（realpath）だけで、中身のファイルは一切作らない。 */
let workspaceRoot: string;

beforeEach(() => {
  __mock.reset();
  deletedFiles.length = 0;
  revealedRanges.length = 0;
  workspaceRoot = mkdtempSync(path.join(tmpdir(), 'chatview-destructive-'));
  __mock.setWorkspaceFolder(workspaceRoot);
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('confirmRunShellCommand（issue #359: 確認ダイアログを経ずに実行されないか）', () => {
  it('コマンド文字列をモーダルの本文に含めて確認する', async () => {
    __mock.showWarningMessageAnswer = '入力する';
    const result = await confirmRunShellCommand('rm -rf /tmp/x');

    expect(result).toBe(true);
    expect(__mock.messages.warnings).toHaveLength(1);
    expect(__mock.messages.warnings[0]).toContain('rm -rf /tmp/x');
    // モーダルであること（`{ modal: true }` を渡していること）自体は戻り値からは見えないため、
    // 「確認せず素通りしない」ことを、キャンセル時にfalseへ倒れることで検査する（下のテスト）
  });

  it('キャンセルすると false を返す（自動実行に倒れない）', async () => {
    __mock.showWarningMessageAnswer = undefined;
    const result = await confirmRunShellCommand('rm -rf /tmp/x');
    expect(result).toBe(false);
  });

  it('別のボタン文言（他のダイアログの残り等）が来ても true にはならない', async () => {
    // ボタン文字列の完全一致だけを見ていることの検査。近い文言に釣られないか
    __mock.showWarningMessageAnswer = '入力';
    const result = await confirmRunShellCommand('echo hi');
    expect(result).toBe(false);
  });
});

describe('confirmRevertDiff（issue #359: 差分を戻す前の確認）', () => {
  it('add種別では「削除します」の文言を出す', async () => {
    __mock.showWarningMessageAnswer = '戻す';
    const result = await confirmRevertDiff(addDiff());
    expect(result).toBe(true);
    expect(__mock.messages.warnings[0]).toContain('削除します');
    expect(__mock.messages.warnings[0]).toContain('src/new.txt');
  });

  it('delete種別では「復元します」の文言を出す', async () => {
    const result = await confirmRevertDiff({
      path: 'src/gone.txt',
      kind: 'delete',
      movePath: undefined,
      diff: '-was here\n',
      editReplace: undefined,
    });
    expect(result).toBe(true);
    expect(__mock.messages.warnings[0]).toContain('復元します');
  });

  it('update種別では「元の状態へ戻します」の文言を出す', async () => {
    const result = await confirmRevertDiff(updateDiff());
    expect(result).toBe(true);
    expect(__mock.messages.warnings[0]).toContain('この変更を適用する前の状態へ戻します');
  });

  it('キャンセルすると false（実行側は書き込まない前提を支える）', async () => {
    __mock.showWarningMessageAnswer = undefined;
    const result = await confirmRevertDiff(updateDiff());
    expect(result).toBe(false);
  });
});

describe('confirmRewindFiles（issue #359: ファイル巻き戻しの確認）', () => {
  it('対象ファイルを列挙し、会話は変わらない旨を明記する', async () => {
    __mock.showWarningMessageAnswer = 'ファイルを戻す';
    const result = await confirmRewindFiles(['a.ts', 'b.ts']);
    expect(result).toBe(true);
    const msg = __mock.messages.warnings[0];
    expect(msg).toContain('a.ts');
    expect(msg).toContain('b.ts');
    expect(msg).toContain('会話の履歴は変わりません');
  });

  it('件数が上限を超えると残りは件数だけ表示する', async () => {
    const files = Array.from({ length: 12 }, (_, i) => `f${i}.ts`);
    await confirmRewindFiles(files);
    const msg = __mock.messages.warnings[0];
    expect(msg).toContain('f0.ts');
    expect(msg).toContain('f9.ts');
    expect(msg).not.toContain('f10.ts');
    expect(msg).toContain('他 2件');
  });

  it('キャンセルすると false', async () => {
    __mock.showWarningMessageAnswer = undefined;
    const result = await confirmRewindFiles(['a.ts']);
    expect(result).toBe(false);
  });
});

describe('handleRevertDiff（issue #359: 実ファイルを書き換える最も破壊的な入口）', () => {
  it('update種別: 確認後に、確認前と同じ実体のfdへ復元後の内容を書き込む', async () => {
    const fs = new FakeFs('new');
    const port = new FakeRevertPort('new');
    __mock.showWarningMessageAnswer = '戻す';
    const diff = updateDiff();

    await handleRevertDiff(fs, [itemWithDiff(diff)], 'item-1', 0, port);

    expect(port.written).toHaveLength(1);
    expect(port.written[0]?.path).toBe(path.join(workspaceRoot, 'src/a.txt'));
    // 「呼ばれたことだけ」ではなく、書き込まれた中身が復元後の値と一致することまで見る
    expect(port.written[0]?.content).toBe('old');
    // パス文字列で開き直す `workspace.fs.writeFile` は使わない（Issue #1170）
    expect(__mock.writtenFiles).toHaveLength(0);
    expect(deletedFiles).toHaveLength(0);
    expect(__mock.messages.infos[0]).toContain('変更を戻しました');
  });

  it('add種別: 確認後にファイルをゴミ箱経由で削除する（書き込みはしない）', async () => {
    const fs = new FakeFs('created');
    const port = new FakeRevertPort('created');
    __mock.showWarningMessageAnswer = '戻す';

    await handleRevertDiff(fs, [itemWithDiff(addDiff())], 'item-1', 0, port);

    expect(deletedFiles).toHaveLength(1);
    expect(deletedFiles[0]?.path).toBe(path.join(workspaceRoot, 'src/new.txt'));
    expect(deletedFiles[0]?.useTrash).toBe(true);
    expect(__mock.writtenFiles).toHaveLength(0);
    expect(port.written).toHaveLength(0);
  });

  // Claude CodeのWrite由来で、新規作成と確認できていない追加（issue #1176）。
  // そのまま削除すると、既存ファイルを上書きしただけだった場合に消してしまう
  it('add種別: 新規作成と確認できていなければ削除せず理由を出す', async () => {
    const fs = new FakeFs('created');
    const port = new FakeRevertPort('created');
    __mock.showWarningMessageAnswer = '戻す';

    await handleRevertDiff(
      fs,
      [itemWithDiff(addDiff({ createUnverified: true }))],
      'item-1',
      0,
      port,
    );

    expect(deletedFiles).toHaveLength(0);
    expect(__mock.writtenFiles).toHaveLength(0);
    expect(port.written).toHaveLength(0);
    expect(__mock.messages.warnings[0]).toContain('上書きかを実行結果から確認できない');
  });

  // 上書きと判った Write は update + editReplace へ組み直されている（issue #1176）。
  // 削除ではなく、上書き前の内容が復元されることまで見る
  it('上書きと判ったWrite由来のupdateは、削除ではなく上書き前の内容へ戻す', async () => {
    const fs = new FakeFs('new1');
    const port = new FakeRevertPort('new1');
    __mock.showWarningMessageAnswer = '戻す';
    const diff = updateDiff({
      path: 'src/new.txt',
      diff: '-old1\n+new1',
      editReplace: { oldString: 'old1', newString: 'new1' },
    });

    await handleRevertDiff(fs, [itemWithDiff(diff)], 'item-1', 0, port);

    expect(deletedFiles).toHaveLength(0);
    expect(port.written).toHaveLength(1);
    expect(port.written[0]?.content).toBe('old1');
  });

  it('delete種別: 確認後に、無いときだけ作る口で元の内容を再作成する', async () => {
    const fs = new FakeFs(undefined);
    const port = new FakeRevertPort(undefined);
    __mock.showWarningMessageAnswer = '戻す';

    await handleRevertDiff(fs, [itemWithDiff(deleteDiff())], 'item-1', 0, port);

    expect(port.created).toHaveLength(1);
    expect(port.created[0]?.path).toBe(path.join(workspaceRoot, 'src/gone.txt'));
    expect(port.created[0]?.content).toBe('was here');
    expect(__mock.writtenFiles).toHaveLength(0);
    expect(__mock.messages.infos[0]).toContain('変更を戻しました');
  });

  it('確認ダイアログでキャンセルすると何も書き込まない', async () => {
    const fs = new FakeFs('new');
    const port = new FakeRevertPort('new');
    __mock.showWarningMessageAnswer = undefined;

    await handleRevertDiff(fs, [itemWithDiff(updateDiff())], 'item-1', 0, port);

    expect(port.written).toHaveLength(0);
    expect(__mock.writtenFiles).toHaveLength(0);
    expect(deletedFiles).toHaveLength(0);
  });

  it('ワークスペース外を指すパスは書き込まずに警告だけ出す', async () => {
    const fs = new FakeFs('new');
    const port = new FakeRevertPort('new');
    __mock.showWarningMessageAnswer = '戻す';
    const diff = updateDiff({ path: '../outside.txt' });

    await handleRevertDiff(fs, [itemWithDiff(diff)], 'item-1', 0, port);

    expect(port.written).toHaveLength(0);
    expect(__mock.writtenFiles).toHaveLength(0);
    expect(deletedFiles).toHaveLength(0);
    expect(__mock.messages.warnings.some((m) => m.includes('ワークスペースの外'))).toBe(true);
  });

  it('確認モーダルの間に内容が変わっていた場合（TOCTOU）は書き込まずに中止する', async () => {
    // 事前チェックは復元できる内容、確認直後にfdから読み直した内容は既に想定と食い違っている、
    // という状況を模す
    const fs = new FakeFs('new');
    const port = new FakeRevertPort('unexpected-content-changed-elsewhere');
    __mock.showWarningMessageAnswer = '戻す';

    await handleRevertDiff(fs, [itemWithDiff(updateDiff())], 'item-1', 0, port);

    expect(port.written).toHaveLength(0);
    expect(__mock.writtenFiles).toHaveLength(0);
    expect(__mock.messages.warnings.some((m) => m.includes('変更を戻せませんでした'))).toBe(true);
  });

  it('差分を取ったときから既に内容が変わっている場合は確認モーダル自体を出さない', async () => {
    // 事前チェックの時点で precheck が失敗するため、確認ダイアログより前に止まるはず
    const fs = new FakeFs('already different');
    const port = new FakeRevertPort('already different');
    __mock.showWarningMessageAnswer = '戻す';

    await handleRevertDiff(fs, [itemWithDiff(updateDiff())], 'item-1', 0, port);

    expect(__mock.messages.warnings).toHaveLength(1);
    expect(__mock.messages.warnings[0]).toContain('変更を戻せません');
    expect(port.written).toHaveLength(0);
    expect(port.identifyCalls).toBe(0);
  });

  it('存在しないitemId/diffIndexでは何もしない', async () => {
    const fs = new FakeFs('new');
    const port = new FakeRevertPort('new');
    await handleRevertDiff(fs, [itemWithDiff(updateDiff())], 'missing-item', 0, port);

    expect(port.written).toHaveLength(0);
    expect(__mock.messages.warnings).toHaveLength(0);
  });

  it('movePathを伴うupdateは戻せない（revert:falseの警告のみ）', async () => {
    const fs = new FakeFs('new');
    const port = new FakeRevertPort('new');
    const diff = updateDiff({ movePath: 'src/moved.txt' });

    await handleRevertDiff(fs, [itemWithDiff(diff)], 'item-1', 0, port);

    expect(port.written).toHaveLength(0);
    expect(__mock.messages.warnings[0]).toContain('戻せません');
  });

  describe('確認中に対象の場所・実体が変わる（Issue #1170）', () => {
    let outsideRoot: string;
    const originalShowWarningMessage = vscodeMock.window.showWarningMessage;

    beforeEach(() => {
      outsideRoot = mkdtempSync(path.join(tmpdir(), 'chatview-outside-'));
    });

    afterEach(() => {
      (vscodeMock.window as { showWarningMessage: unknown }).showWarningMessage =
        originalShowWarningMessage;
      rmSync(outsideRoot, { recursive: true, force: true });
    });

    /**
     * 確認モーダルが開いた瞬間に、対象の親 `src` をワークスペース外へのsymlinkへ差し替える。
     * 事前チェックの `realpath` は差し替え前、確認後の再検査は差し替え後を見ることになる。
     */
    function swapParentToOutsideDuringModal(): void {
      (vscodeMock.window as { showWarningMessage: unknown }).showWarningMessage = (
        message: string,
        ...items: unknown[]
      ): Promise<string | undefined> => {
        if (message.includes('この差分の変更を戻します')) {
          symlinkSync(outsideRoot, path.join(workspaceRoot, 'src'));
        }
        return originalShowWarningMessage(message, ...items);
      };
    }

    it('update: 親がワークスペース外へのsymlinkに差し替わると、同じ本文でも書き込まない', async () => {
      const fs = new FakeFs('new');
      const port = new FakeRevertPort('new');
      swapParentToOutsideDuringModal();

      await handleRevertDiff(fs, [itemWithDiff(updateDiff())], 'item-1', 0, port);

      expect(port.written).toHaveLength(0);
      expect(__mock.writtenFiles).toHaveLength(0);
      expect(__mock.messages.warnings.some((m) => m.includes('対象の場所が変わりました'))).toBe(
        true,
      );
    });

    it('add: 親が差し替わると削除しない', async () => {
      const fs = new FakeFs('created');
      const port = new FakeRevertPort('created');
      swapParentToOutsideDuringModal();

      await handleRevertDiff(fs, [itemWithDiff(addDiff())], 'item-1', 0, port);

      expect(deletedFiles).toHaveLength(0);
      expect(__mock.messages.warnings.some((m) => m.includes('対象の場所が変わりました'))).toBe(
        true,
      );
    });

    it('delete: 親が差し替わると再作成しない', async () => {
      const fs = new FakeFs(undefined);
      const port = new FakeRevertPort(undefined);
      swapParentToOutsideDuringModal();

      await handleRevertDiff(fs, [itemWithDiff(deleteDiff())], 'item-1', 0, port);

      expect(port.created).toHaveLength(0);
      expect(__mock.messages.warnings.some((m) => m.includes('対象の場所が変わりました'))).toBe(
        true,
      );
    });

    it('update: 実体パスは同じでも、開いたfdの dev/ino が確認前と違えば書き込まない', async () => {
      const fs = new FakeFs('new');
      const port = new FakeRevertPort('new');
      port.openedIdentity = { dev: 1, ino: 999 };

      await handleRevertDiff(fs, [itemWithDiff(updateDiff())], 'item-1', 0, port);

      expect(port.written).toHaveLength(0);
      expect(__mock.messages.warnings.some((m) => m.includes('差し替えられました'))).toBe(true);
    });

    it('add: 確認後の実体が確認前と違えば削除しない', async () => {
      const fs = new FakeFs('created');
      const port = new FakeRevertPort('created');
      port.identities = [
        { dev: 1, ino: 100 },
        { dev: 1, ino: 101 },
      ];

      await handleRevertDiff(fs, [itemWithDiff(addDiff())], 'item-1', 0, port);

      expect(deletedFiles).toHaveLength(0);
      expect(__mock.messages.warnings.some((m) => m.includes('差し替えられました'))).toBe(true);
    });
  });
});

describe('handleOpenDiffFile（issue #359: 差分見出しの「エディタで開く」）', () => {
  it('delete種別は開かず案内を出す', async () => {
    const diff: FileDiff = {
      path: 'src/gone.txt',
      kind: 'delete',
      movePath: undefined,
      diff: '-was here\n',
      editReplace: undefined,
    };
    await handleOpenDiffFile([itemWithDiff(diff)], 'item-1', 0);

    expect(__mock.messages.infos.some((m) => m.includes('開けません'))).toBe(true);
    expect(__mock.openedTextDocumentPaths).toHaveLength(0);
  });

  it('ワークスペース外のパスは警告して開かない', async () => {
    const diff = updateDiff({ path: '../outside.txt' });
    await handleOpenDiffFile([itemWithDiff(diff)], 'item-1', 0);

    expect(__mock.openedTextDocumentPaths).toHaveLength(0);
    expect(__mock.messages.warnings.some((m) => m.includes('ワークスペースの外'))).toBe(true);
  });

  it('addの新規ファイルは1行目へジャンプしてエディタで開く', async () => {
    const editor = patchShowTextDocumentForEditorFake();
    __mock.setExistingTextDocumentPaths([path.join(workspaceRoot, 'src/new.txt')]);

    await handleOpenDiffFile([itemWithDiff(addDiff())], 'item-1', 0);

    expect(__mock.openedTextDocumentPaths).toEqual([path.join(workspaceRoot, 'src/new.txt')]);
    expect(revealedRanges).toHaveLength(1);
    expect(revealedRanges[0]?.startLine).toBe(0);
    expect(revealedRanges[0]?.revealType).toBe(2);
    expect(editor.selection).toBeDefined();
  });

  it('対象ファイルを開けない（存在しない）場合は警告してエディタは開かない', async () => {
    // `__mock.setExistingTextDocumentPaths` を呼ばないため openTextDocument は reject する
    await handleOpenDiffFile([itemWithDiff(addDiff())], 'item-1', 0);

    expect(__mock.openedTextDocumentPaths).toHaveLength(0);
    expect(__mock.messages.warnings.some((m) => m.includes('ファイルを開けませんでした'))).toBe(
      true,
    );
  });
});

describe('handleOpenDiffEditor（issue #359: 差分見出しの「差分を開く」）', () => {
  it('復元できない差分（ハンク見出し無し）は警告して `vscode.diff` を呼ばない', async () => {
    const fs = new FakeFs('current');
    const diff = updateDiff({ diff: 'not a unified diff at all' });

    await handleOpenDiffEditor(fs, [itemWithDiff(diff)], 'item-1', 0);

    expect(__mock.executedCommands).toHaveLength(0);
    expect(__mock.messages.warnings.some((m) => m.includes('開けません'))).toBe(true);
  });

  it('ワークスペース外のパスは警告して `vscode.diff` を呼ばない', async () => {
    const fs = new FakeFs('current');
    const diff = updateDiff({ path: '../outside.txt' });

    await handleOpenDiffEditor(fs, [itemWithDiff(diff)], 'item-1', 0);

    expect(__mock.executedCommands).toHaveLength(0);
    expect(__mock.messages.warnings.some((m) => m.includes('ワークスペースの外'))).toBe(true);
  });

  it('現在の内容が差分の想定と食い違う場合は警告して `vscode.diff` を呼ばない', async () => {
    // updateDiff() は `old` -> `new` の差分。現在の内容が両方と一致しない状況を作る
    const fs = new FakeFs('totally different content');
    const diff = updateDiff();

    await handleOpenDiffEditor(fs, [itemWithDiff(diff)], 'item-1', 0);

    expect(__mock.executedCommands).toHaveLength(0);
    expect(__mock.messages.warnings.some((m) => m.includes('差分を開けません'))).toBe(true);
  });

  it('復元できる差分は `vscode.diff` を実ファイルパスで呼ぶ', async () => {
    const fs = new FakeFs('new');
    const diff = updateDiff();

    await handleOpenDiffEditor(fs, [itemWithDiff(diff)], 'item-1', 0);

    expect(__mock.executedCommands).toEqual(['vscode.diff']);
    expect(__mock.messages.warnings).toHaveLength(0);
  });
});

describe('postImageData（issue #359: 会話に出てきた画像だけを返す）', () => {
  const panelStub = (): {
    webview: { postMessage: (m: unknown) => Promise<boolean>; sent: unknown[] };
  } => {
    const sent: unknown[] = [];
    return {
      webview: {
        postMessage: (m: unknown) => {
          sent.push(m);
          return Promise.resolve(true);
        },
        sent,
      },
    };
  };

  it('会話に出てきたパスなら画像データを返す', async () => {
    const panel = panelStub();
    const fs = new FakeFs('binarydata');
    const items: ChatItem[] = [
      {
        id: 'i1',
        kind: 'imageView',
        text: '',
        detail: '/tmp/shot.png',
        status: undefined,
        turnId: undefined,
        diffs: [],
        images: [{ dataUrl: undefined, path: '/tmp/shot.png', alt: '/tmp/shot.png' }],
      },
    ];

    await postImageData(panel as never, fs, items, '/tmp/shot.png');

    expect(panel.webview.sent).toHaveLength(1);
    const message = panel.webview.sent[0] as { type: string; path: string; dataUrl?: string };
    expect(message.type).toBe('imageData');
    expect(message.path).toBe('/tmp/shot.png');
    expect(message.dataUrl).toBe(
      `data:image/png;base64,${Buffer.from('binarydata').toString('base64')}`,
    );
  });

  it('会話に出てきていないパスは何も送らない（Webviewが要求するパスを信用しない）', async () => {
    const panel = panelStub();
    const fs = new FakeFs('binarydata');
    const items: ChatItem[] = [
      {
        id: 'i1',
        kind: 'imageView',
        text: '',
        detail: '/tmp/shot.png',
        status: undefined,
        turnId: undefined,
        diffs: [],
        images: [{ dataUrl: undefined, path: '/tmp/shot.png', alt: '/tmp/shot.png' }],
      },
    ];

    await postImageData(panel as never, fs, items, '/etc/passwd');

    expect(panel.webview.sent).toHaveLength(0);
  });
});

describe('postFileMentions（issue #359: `@`候補の絞り込み）', () => {
  const panelStub = (): {
    webview: { postMessage: (m: unknown) => Promise<boolean>; sent: unknown[] };
  } => {
    const sent: unknown[] = [];
    return {
      webview: {
        postMessage: (m: unknown) => {
          sent.push(m);
          return Promise.resolve(true);
        },
        sent,
      },
    };
  };

  function fakeScan(files: string[]): FileScanPort {
    return {
      async scan(): Promise<string[]> {
        return files;
      },
      async readText(): Promise<string | undefined> {
        return undefined;
      },
    };
  }

  it('cwdを絞り込みに使い、一致するファイルだけ返す', async () => {
    const panel = panelStub();
    const catalog = new FileMentionCatalog(fakeScan(['apple.ts', 'banana.ts', 'grape.md']));

    await postFileMentions(panel as never, catalog, '/work', 'apple');

    const message = panel.webview.sent[0] as { type: string; query: string; files: string[] };
    expect(message.type).toBe('files');
    expect(message.query).toBe('apple');
    expect(message.files).toEqual(['apple.ts']);
  });

  it('query が文字列でなければ何も送らない', async () => {
    const panel = panelStub();
    const catalog = new FileMentionCatalog(fakeScan(['src/a.ts']));

    await postFileMentions(panel as never, catalog, '/work', 42);

    expect(panel.webview.sent).toHaveLength(0);
  });

  it('cwdが無くワークスペースフォルダも無ければ何も送らない', async () => {
    __mock.clearWorkspaceFolder();
    const panel = panelStub();
    const catalog = new FileMentionCatalog(fakeScan(['src/a.ts']));

    await postFileMentions(panel as never, catalog, undefined, 'a');

    expect(panel.webview.sent).toHaveLength(0);
  });
});

describe('addAttachment（issue #359: 貼り付け画像の受け入れ）', () => {
  const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

  it('対応形式なら箱に追加され、警告は出ない', () => {
    const box = new AttachmentBox();
    addAttachment(box, '猫.png', PNG_DATA_URL);

    expect(box.list).toHaveLength(1);
    expect(box.list[0]?.name).toBe('猫.png');
    expect(__mock.messages.warnings).toHaveLength(0);
  });

  it('名前が無ければ既定名になる', () => {
    const box = new AttachmentBox();
    addAttachment(box, undefined, PNG_DATA_URL);

    expect(box.list[0]?.name).toBe('貼り付けた画像');
  });

  it('dataUrlが文字列でなければ何もしない', () => {
    const box = new AttachmentBox();
    addAttachment(box, 'x.png', 12345);

    expect(box.list).toHaveLength(0);
    expect(__mock.messages.warnings).toHaveLength(0);
  });

  it('対応しない形式は箱に追加されず、理由を警告する', () => {
    const box = new AttachmentBox();
    addAttachment(box, 'x.svg', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=');

    expect(box.list).toHaveLength(0);
    expect(__mock.messages.warnings).toHaveLength(1);
  });

  it('上限（5枚）を超えると追加されず理由を警告する', () => {
    const box = new AttachmentBox();
    for (let i = 0; i < 5; i++) {
      addAttachment(box, `${i}.png`, PNG_DATA_URL);
    }
    __mock.reset(); // 上限までの警告履歴をクリアし、6枚目だけを見る
    addAttachment(box, '6.png', PNG_DATA_URL);

    expect(box.list).toHaveLength(5);
    expect(__mock.messages.warnings).toHaveLength(1);
    expect(__mock.messages.warnings[0]).toContain('5 枚まで');
  });
});
