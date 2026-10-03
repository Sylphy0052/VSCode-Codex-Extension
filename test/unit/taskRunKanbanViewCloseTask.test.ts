import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/log';
import { MAX_CLOSE_REASON_LENGTH } from '../../src/orchestrator/taskRunState';
import {
  TaskRunKanbanViewManager,
  type TaskRunKanbanViewDeps,
} from '../../src/view/taskRunKanbanView';
import { __mock, type FakeWebviewPanel } from '../mocks/vscode';

/**
 * Kanbanの「mergeせずに完了にする」（Issue #1851）の入力検証と受け渡し（Issue #1856）。
 *
 * 理由の長さの検証はController側にはなく、`showInputBox`の`validateInput`だけが持つ。
 * webviewの`closeTask`メッセージを経由して、入力欄の検証・取消・整形・失敗通知を確かめる。
 */

const fakeLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  show: () => undefined,
};

type ValidateInput = (value: string) => string | undefined | null;

interface Harness {
  view: TaskRunKanbanViewManager;
  panel: FakeWebviewPanel;
  closeTask: ReturnType<typeof vi.fn>;
  showInputBox: ReturnType<typeof vi.spyOn>;
  /** webviewのcloseTaskメッセージの処理（入力欄の取消・controller呼出・通知）が終わるまで待つ */
  settled: () => Promise<void>;
}

function open(
  options: {
    inputAnswer?: string | undefined;
    closeResult?: { ok: boolean; message: string };
  } = {},
): Harness {
  const closeTask = vi.fn(() => Promise.resolve(options.closeResult ?? { ok: true, message: '' }));
  const deps = {
    controller: { closeTask },
    orchestrator: {},
    log: fakeLogger,
  } as unknown as TaskRunKanbanViewDeps;
  const showInputBox = vi
    .spyOn(vscode.window, 'showInputBox')
    .mockResolvedValue(options.inputAnswer);
  const view = new TaskRunKanbanViewManager(deps);
  // 実装は素通しで、処理が終わったことを正の条件で待てるよう戻り値のPromiseだけ捕まえる
  const handler = vi.spyOn(view as unknown as { closeTask: () => Promise<void> }, 'closeTask');
  const settled = async (): Promise<void> => {
    await Promise.all(handler.mock.results.map((r) => r.value as Promise<void>));
  };
  view.show('run-1');
  const panel = __mock.lastCreatedPanel();
  if (panel === undefined) {
    throw new Error('パネルが作られていない');
  }
  return { view, panel, closeTask, showInputBox, settled };
}

/** webviewの「mergeせずに完了にする」ボタンが送るメッセージ */
function sendCloseTask(h: Harness): void {
  h.panel.webview.simulateMessage({ type: 'closeTask', runId: 'run-1', taskId: 'T3' });
}

/** `showInputBox`へ渡された`validateInput`を取り出す */
async function capturedValidator(h: Harness): Promise<ValidateInput> {
  sendCloseTask(h);
  await vi.waitFor(() => expect(h.showInputBox).toHaveBeenCalledTimes(1));
  const options = h.showInputBox.mock.calls[0]?.[0] as
    { validateInput?: ValidateInput } | undefined;
  if (options?.validateInput === undefined) {
    throw new Error('validateInputが渡されていない');
  }
  return options.validateInput;
}

describe('TaskRunKanbanViewManager: closeTask', () => {
  let h: Harness | undefined;

  beforeEach(() => {
    __mock.reset();
  });

  afterEach(() => {
    h?.view.dispose();
    h = undefined;
    vi.restoreAllMocks();
  });

  describe('validateInput', () => {
    it('空文字・空白だけ・上限超過はエラー文字列を返す', async () => {
      h = open();
      const validate = await capturedValidator(h);
      const message = `1〜${String(MAX_CLOSE_REASON_LENGTH)}文字で入力してください`;
      expect(validate('')).toBe(message);
      expect(validate('   ')).toBe(message);
      expect(validate('\n\t ')).toBe(message);
      expect(validate('a'.repeat(MAX_CLOSE_REASON_LENGTH + 1))).toBe(message);
    });

    it('1文字と上限ちょうどはundefined（受理）を返す', async () => {
      h = open();
      const validate = await capturedValidator(h);
      expect(validate('a')).toBeUndefined();
      expect(validate('a'.repeat(MAX_CLOSE_REASON_LENGTH))).toBeUndefined();
    });

    it('上限は300文字である', () => {
      expect(MAX_CLOSE_REASON_LENGTH).toBe(300);
    });
  });

  it('入力を取り消したらcontroller.closeTaskを呼ばない', async () => {
    h = open({ inputAnswer: undefined });
    sendCloseTask(h);
    await vi.waitFor(() => expect(h?.showInputBox).toHaveBeenCalledTimes(1));
    // 取消後の後続処理が走り切るのを、処理のPromiseの完了で待つ
    await h.settled();
    expect(h.closeTask).not.toHaveBeenCalled();
    expect(__mock.messages.infos).toEqual([]);
  });

  it('入力した理由は改行が1行化されてcontroller.closeTaskへ渡る', async () => {
    h = open({ inputAnswer: '重複\nのため\r\n取り下げ' });
    sendCloseTask(h);
    await vi.waitFor(() => expect(h?.closeTask).toHaveBeenCalledTimes(1));
    const reason = h.closeTask.mock.calls[0]?.[2] as string;
    // 改行の置き換え方（空白の個数）はsanitizeInlineTextの仕様で、ここでは1行になることだけを見る
    expect(reason).not.toMatch(/[\r\n]/);
    expect(reason.split(/\s+/)).toEqual(['重複', 'のため', '取り下げ']);
  });

  // validateInputが300文字超を拒否するため通常は届かない。届いた場合も上限で切ることの確認
  it('上限を超える理由は切り詰められて渡る', async () => {
    h = open({ inputAnswer: 'a'.repeat(MAX_CLOSE_REASON_LENGTH + 50) });
    sendCloseTask(h);
    await vi.waitFor(() => expect(h?.closeTask).toHaveBeenCalledTimes(1));
    const reason = h.closeTask.mock.calls[0]?.[2] as string;
    expect(reason).toBe(`${'a'.repeat(MAX_CLOSE_REASON_LENGTH)}…`);
  });

  it('controller.closeTaskがok:falseを返すとメッセージを出す', async () => {
    h = open({ inputAnswer: '重複', closeResult: { ok: false, message: '工程が動いています' } });
    sendCloseTask(h);
    await vi.waitFor(() => expect(__mock.messages.infos).toHaveLength(1));
    expect(__mock.messages.infos[0]).toBe('T3: 工程が動いています');
  });

  it('controller.closeTaskがok:trueならメッセージを出さない', async () => {
    h = open({ inputAnswer: '重複' });
    sendCloseTask(h);
    await vi.waitFor(() => expect(h?.closeTask).toHaveBeenCalledTimes(1));
    await h.settled();
    expect(__mock.messages.infos).toEqual([]);
  });
});
