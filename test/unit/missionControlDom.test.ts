import { buildSync } from 'esbuild';
import { JSDOM } from 'jsdom';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { McPendingItem, McSnapshot } from '../../src/webview/missionControl/protocol';

/**
 * Mission Control（Issue #2136）のwebviewを、配布物と同じ手順でbundleしてJSDOMの上で動かす。
 * 受入基準「キーボードだけで、Inboxの先頭項目の選択と回答ができる」を確かめる。
 * DOMの型を拡張ホスト側へ入れないため、`progressDom.test.ts`と同じくJSDOMを直接組み立てる。
 */
const bundle = buildSync({
  entryPoints: [path.resolve(__dirname, '../../src/webview/missionControl/main.tsx')],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  jsx: 'automatic',
  jsxImportSource: 'preact',
}).outputFiles[0]?.text;

function boot() {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
    runScripts: 'outside-only',
    url: 'https://mc.test/',
    // Preactのeffectは描画後（requestAnimationFrame）に走る
    pretendToBeVisual: true,
  });
  const window = dom.window;
  const posted: Array<Record<string, unknown>> = [];
  (window as unknown as Record<string, unknown>)['acquireVsCodeApi'] = () => ({
    postMessage: (m: Record<string, unknown>) => posted.push(m),
    getState: () => undefined,
    setState: () => undefined,
  });
  window.eval(bundle ?? '');
  const deliver = (data: unknown): void => {
    window.dispatchEvent(new window.MessageEvent('message', { data }));
  };
  const key = (k: string): void => {
    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true }));
  };
  return { window, posted, deliver, key };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 60));

function item(overrides: Partial<McPendingItem>): McPendingItem {
  return {
    id: 'p1',
    kind: 'toolApproval',
    windowId: 'w2',
    threadId: 't1',
    provider: 'codex',
    isCurrentWindow: false,
    repoKey: '/w/app',
    title: '<img src=x onerror=alert(1)>',
    summary: 'npm test',
    createdAt: 0,
    answer: 'decision',
    requestId: '9',
    ...overrides,
  };
}

function snapshot(pending: McPendingItem[]): McSnapshot {
  return {
    now: 1_000,
    windowId: 'w1',
    repos: [{ key: '/w/app', label: 'app', full: '/w/app', sessionCount: 0, pendingCount: 1 }],
    sessions: [],
    pending,
  };
}

describe('Mission Controlのwebview（Issue #2136）', () => {
  it('ツール承認をキーボードだけで承認でき、外部由来の文字列はテキストとして出す', async () => {
    const { window, posted, deliver, key } = boot();
    await tick();
    expect(posted[0]).toEqual({ type: 'ready' });
    deliver({ type: 'snapshot', snapshot: snapshot([item({})]) });
    await tick();
    expect(window.document.querySelector('img')).toBeNull();
    expect(window.document.body.textContent).toContain('<img src=x onerror=alert(1)>');
    // 先頭項目が選ばれ、全文の取り寄せが走る
    const detail = posted.find((m) => m.action === 'approvalDetail');
    expect(detail).toMatchObject({ windowId: 'w2', provider: 'codex', threadId: 't1' });
    deliver({
      type: 'controlResult',
      seq: detail?.seq,
      ok: true,
      approvals: [
        {
          requestId: '9',
          kind: 'commandExecution',
          title: 't',
          detail: 'npm test',
          paths: [],
          decidable: true,
        },
      ],
    });
    await tick();
    key('a');
    await tick();
    expect(posted.find((m) => m.action === 'approvalDecision')).toMatchObject({
      windowId: 'w2',
      approvalRequestId: '9',
      decision: 'accept',
    });
  });

  it('task runの質問は数字で選択肢を選び、aで送る', async () => {
    const { posted, deliver, key } = boot();
    await tick();
    deliver({
      type: 'snapshot',
      snapshot: snapshot([
        item({
          id: 'taskRun:r:T1:q',
          kind: 'taskRunQuestion',
          answer: 'text',
          options: ['案A', '案B'],
        }),
      ]),
    });
    await tick();
    key('2');
    await tick();
    key('a');
    await tick();
    expect(posted.find((m) => m.action === 'answerTaskRunQuestion')).toMatchObject({
      pendingId: 'taskRun:r:T1:q',
      text: '案B',
    });
  });
});
