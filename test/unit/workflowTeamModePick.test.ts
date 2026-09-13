import { beforeEach, describe, expect, it } from 'vitest';
import { __mock } from '../mocks/vscode';
import { pickWorkflowTeamMode } from '../../src/extension';

/**
 * ロードマップ経路の生成モード選択（Issue #1034、design.md §16.19・§16.44）。
 *
 * 受入基準のうち「通常モードが既定」「チームモードを選べる」「キャンセルではYAMLを作らない」を
 * ここで担保する。キャンセルは`undefined`として呼び出し側へ返り、呼び出し側はそこで`return`する。
 */
describe('pickWorkflowTeamMode', () => {
  beforeEach(() => {
    __mock.reset();
  });

  it('通常モードを選ぶとteam: falseになる', async () => {
    __mock.showQuickPickAnswer = (items) => items[0];

    await expect(pickWorkflowTeamMode()).resolves.toBe(false);
  });

  it('チームモードを選ぶとteam: trueになる', async () => {
    __mock.showQuickPickAnswer = (items) => items[1];

    await expect(pickWorkflowTeamMode()).resolves.toBe(true);
  });

  it('通常モードを先頭に置き、既存の挙動を既定にする', async () => {
    let labels: readonly string[] = [];
    __mock.showQuickPickAnswer = (items) => {
      labels = (items as readonly { label: string }[]).map((item) => item.label);
      return items[0];
    };

    await pickWorkflowTeamMode();

    expect(labels).toEqual(['通常モード', 'チームモード']);
  });

  it('キャンセル（Escape）ではundefinedを返す。呼び出し側はここでYAMLを作らずに戻る', async () => {
    // 既定のモックはキャンセル扱い。選択との区別が付かないとEscapeで生成が走る
    __mock.showQuickPickAnswer = undefined;

    await expect(pickWorkflowTeamMode()).resolves.toBeUndefined();
  });
});
