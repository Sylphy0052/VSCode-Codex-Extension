import { buildSync } from 'esbuild';
import { JSDOM } from 'jsdom';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

/**
 * 描画とeffectを60ms分進める。PreactのeffectはrequestAnimationFrame（無ければ35msのsetTimeout）の
 * 後に走り、スナップショット→選択のeffect→取り寄せのeffectのように2段続く所がある。実時間で60ms
 * 待つと、CIの負荷でNodeのtimerが遅れたとき2段目が間に合わず落ちていた（Issue #2145）。JSDOMの
 * timerとanimation frameはNodeのglobalのsetTimeout/setIntervalで動くので、偽のtimerで進めれば
 * 実時間の遅れに左右されない。
 */
const tick = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(60);
};

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
    stallMs: 300_000,
    pending,
  };
}

describe('Mission Controlのwebview（Issue #2136）', () => {
  // JSDOMは`boot()`の中で作るので、その前に偽のtimerへ替える。戻すときに前のテストの
  // window（TICK_MSの間隔timerなど）の予定も捨てられる
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

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
  it('選択中の項目が消えたら選択を外し、遅れて押したaを別の項目へ送らない（段階2のレビュー）', async () => {
    const { posted, deliver, key } = boot();
    await tick();
    const q = (id: string) =>
      item({ id, kind: 'taskRunQuestion', answer: 'text', options: ['案A'] });
    deliver({ type: 'snapshot', snapshot: snapshot([q('taskRun:r:T1:q'), q('taskRun:r:T2:q')]) });
    await tick();
    // 先頭が選ばれている。回答済みで消えた後のスナップショットを受ける
    deliver({ type: 'snapshot', snapshot: snapshot([q('taskRun:r:T2:q')]) });
    await tick();
    key('1');
    await tick();
    key('a');
    await tick();
    expect(posted.find((m) => m.action === 'answerTaskRunQuestion')).toBeUndefined();
  });

  it('セッションを選ぶとライブtailを頼み、composerから指示を送る（Issue #2137）', async () => {
    const { window, posted, deliver } = boot();
    await tick();
    const base = snapshot([]);
    deliver({
      type: 'snapshot',
      snapshot: {
        ...base,
        // 出力から10分経っている（停滞の既定は5分）
        now: 600_000,
        sessions: [
          {
            key: 's1',
            windowId: 'w2',
            threadId: 't9',
            provider: 'claude',
            isCurrentWindow: false,
            repoKey: '/w/app',
            title: '会話',
            activity: 'running',
            activitySince: 0,
            cwdLabel: 'app',
            cwdFull: '/w/app',
            pendingCount: 0,
            lastOutput: '<b>build</b>',
            lastOutputAt: 0,
          },
        ],
      },
    });
    await tick();
    expect(posted.filter((m) => m.type === 'watch').at(-1)).toMatchObject({
      target: { windowId: 'w2', provider: 'claude', threadId: 't9' },
    });
    // 外部由来の最終出力はテキストとして出し、出力が止まっていれば停滞になる
    expect(window.document.querySelector('b')).toBeNull();
    expect(window.document.body.textContent).toContain('<b>build</b>');
    expect(window.document.querySelector('.pill.stalled')).not.toBeNull();
    deliver({
      type: 'liveTurns',
      target: { windowId: 'w2', provider: 'claude', threadId: 't9' },
      ok: true,
      turns: [{ role: 'agent', text: 'ライブの出力', truncated: false }],
    });
    await tick();
    expect(window.document.body.textContent).toContain('ライブの出力');
    const input = window.document.querySelector('textarea.composer-input') as HTMLTextAreaElement;
    input.value = '続けて';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await tick();
    (window.document.querySelector('form.composer') as HTMLFormElement).requestSubmit();
    await tick();
    expect(posted.find((m) => m.action === 'send')).toMatchObject({
      windowId: 'w2',
      threadId: 't9',
      text: '続けて',
    });
  });

  const runningSession = {
    key: 's1',
    windowId: 'w1',
    threadId: 't1',
    provider: 'codex' as const,
    isCurrentWindow: true,
    repoKey: '/w/app',
    title: '会話',
    activity: 'running' as const,
    activitySince: 0,
    cwdLabel: 'app',
    cwdFull: '/w/app',
    pendingCount: 0,
  };

  it('composerは送信中に二重送信させず、失敗したら入力を残して理由を出す（Issue #2137）', async () => {
    const { window, posted, deliver } = boot();
    await tick();
    deliver({ type: 'snapshot', snapshot: { ...snapshot([]), sessions: [runningSession] } });
    await tick();
    const input = window.document.querySelector('textarea.composer-input') as HTMLTextAreaElement;
    input.value = '続けて';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await tick();
    const form = window.document.querySelector('form.composer') as HTMLFormElement;
    form.requestSubmit();
    await tick();
    const button = form.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(button.textContent).toBe('送信中…');
    expect(button.disabled).toBe(true);
    form.requestSubmit();
    await tick();
    const sends = posted.filter((m) => m.action === 'send');
    expect(sends).toHaveLength(1);
    deliver({
      type: 'controlResult',
      seq: sends[0]?.seq,
      ok: false,
      error: '会話が見つかりません',
    });
    await tick();
    expect(form.querySelector('[role="alert"]')?.textContent).toBe('会話が見つかりません');
    expect(
      (window.document.querySelector('textarea.composer-input') as HTMLTextAreaElement).value,
    ).toBe('続けて');
    expect(button.textContent).toBe('送信');
  });

  it('同じrepoでセッションが開いていれば、新規起動のworktreeを既定ONにして警告を出す（Issue #2137）', async () => {
    const { window, posted, deliver, key } = boot();
    await tick();
    deliver({ type: 'snapshot', snapshot: { ...snapshot([]), sessions: [runningSession] } });
    await tick();
    key('n');
    await tick();
    const options = posted.find((m) => m.type === 'launchOptions');
    expect(options).toBeDefined();
    deliver({
      type: 'reply',
      seq: options?.seq,
      ok: true,
      repos: [
        { path: '/w/app', key: '/w/app', label: 'app', source: 'session' },
        { path: '/w/other', key: '/w/other', label: 'other', source: 'history' },
      ],
    });
    await tick();
    const dialog = window.document.querySelector('[role="dialog"]') as HTMLElement;
    const check = dialog.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(check.checked).toBe(true);
    expect(dialog.querySelector('.warn')?.textContent).toContain('既に1');
    // 別のrepoへ替えると既定はOFFに戻り、警告も消える
    const select = dialog.querySelector('select') as HTMLSelectElement;
    select.value = '/w/other';
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
    await tick();
    expect((dialog.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(
      false,
    );
    expect(dialog.querySelector('.warn')).toBeNull();
    select.value = '/w/app';
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
    await tick();
    (dialog.querySelector('form') as HTMLFormElement).requestSubmit();
    await tick();
    expect(posted.find((m) => m.type === 'launch')).toMatchObject({
      cwd: '/w/app',
      provider: 'codex',
      worktree: true,
    });
  });
});
