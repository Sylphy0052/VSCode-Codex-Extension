import { beforeEach, describe, expect, it } from 'vitest';
import { OPEN_LOG_ACTION, warnWithLogLink } from '../../src/extension';
import { __mock } from '../mocks/vscode';
import type { Logger } from '../../src/log';

/**
 * Issue #524: 「詳しくはログ」と書いてある警告通知から、ログ（出力チャネル）へ
 * 辿れなかった。`warnWithLogLink`はボタンを付けて通知を出し、押されたときだけ
 * `log.show()`を呼ぶ。
 *
 * 呼び出し側（`extension.ts`の8箇所）がこのヘルパを通っていることは、ここでは
 * 検証できない（`runRoadmap`等はexportされておらず、実VSCodeのコマンド経由でしか
 * 呼べない）。8箇所の置き換え自体はgrepで担保する（PR本文に記録）。
 */
describe('warnWithLogLink（Issue #524）', () => {
  function createLog(): { log: Logger; shown: () => number } {
    let count = 0;
    return {
      log: {
        info: () => {},
        warn: () => {},
        error: () => {},
        show: () => {
          count += 1;
        },
      },
      shown: () => count,
    };
  }

  beforeEach(() => {
    __mock.reset();
  });

  it('メッセージとボタンを付けて警告通知を出す', async () => {
    const { log } = createLog();
    await warnWithLogLink(log, 'テスト用の警告（詳しくはログ）');
    expect(__mock.messages.warnings).toEqual(['テスト用の警告（詳しくはログ）']);
  });

  it('ボタンを渡している（モックの既定は渡されたボタンを自動で選ぶ）', async () => {
    const { log, shown } = createLog();
    await warnWithLogLink(log, 'テスト用の警告');
    expect(shown()).toBe(1);
  });

  it('ボタンが押されたらログを開く', async () => {
    const { log, shown } = createLog();
    __mock.showWarningMessageAnswer = OPEN_LOG_ACTION;
    await warnWithLogLink(log, 'テスト用の警告');
    expect(shown()).toBe(1);
  });

  it('通知を閉じただけならログを開かない', async () => {
    const { log, shown } = createLog();
    __mock.showWarningMessageAnswer = undefined;
    await warnWithLogLink(log, 'テスト用の警告');
    expect(shown()).toBe(0);
  });

  it('別のボタン文言が返ってきたらログを開かない', async () => {
    const { log, shown } = createLog();
    __mock.showWarningMessageAnswer = '別のボタン';
    await warnWithLogLink(log, 'テスト用の警告');
    expect(shown()).toBe(0);
  });
});
