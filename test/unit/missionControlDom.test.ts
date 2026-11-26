import { buildSync } from 'esbuild';
import { JSDOM, type DOMWindow } from 'jsdom';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPOSER_KEY_HELP, KEY_HELP } from '../../src/webview/missionControl/keys';
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

  it('使ったskillをカードに直近2件、詳細ペインに時刻つきで全件出す（Issue #2173）', async () => {
    const { window, deliver } = boot();
    await tick();
    const base = snapshot([]);
    const at = (h: number, m: number): number => new Date(2026, 10, 26, h, m).getTime();
    deliver({
      type: 'snapshot',
      snapshot: {
        ...base,
        now: at(12, 0),
        sessions: [
          {
            key: 's1',
            windowId: 'w2',
            threadId: 't9',
            provider: 'claude',
            isCurrentWindow: false,
            repoKey: '/w/app',
            title: '会話',
            activity: 'idle',
            activitySince: 0,
            cwdLabel: 'app',
            cwdFull: '/w/app',
            pendingCount: 0,
            skills: [
              { name: 'gitlab-issue', at: at(9, 1) },
              { name: '<b>evil</b>', at: at(10, 2) },
              { name: 'gitlab-review', at: at(11, 3) },
            ],
          },
        ],
      },
    });
    await tick();
    const card = window.document.querySelector('.row-skills');
    expect(card?.textContent).toBe('skill: gitlab-review ← <b>evil</b>');
    const lines = [...window.document.querySelectorAll('.detail-skills li')].map(
      (li) => li.textContent,
    );
    expect(lines).toEqual(['09:01 gitlab-issue', '10:02 <b>evil</b>', '11:03 gitlab-review']);
    // 外部由来のskill名はテキストとして出す
    expect(window.document.querySelector('b')).toBeNull();
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

  it('送信キューは一覧の外から↓で先頭へ入り、先頭が送られて繰り上がってもフォーカスが残る（Issue #2158のレビュー）', async () => {
    const { window, posted, deliver } = boot();
    await tick();
    deliver({ type: 'snapshot', snapshot: { ...snapshot([]), sessions: [runningSession] } });
    await tick();
    const doc = window.document;
    const keydown = (target: EventTarget, init: KeyboardEventInit): void => {
      target.dispatchEvent(
        new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
      );
    };
    const answer = (queued: string[]): void => {
      const request = posted.filter((m) => m.action === 'queuedMessages').at(-1);
      deliver({
        type: 'controlResult',
        seq: request?.seq,
        ok: true,
        queued: queued.map((text) => ({
          id: `id-${text}`,
          text,
          truncated: false,
          attachments: 0,
        })),
      });
    };
    keydown(doc.body, { key: 'Q', shiftKey: true });
    await tick();
    answer(['一', '二', '三']);
    await tick();
    // 開いた直後は一覧のコンテナにフォーカスがある。↓は2件目ではなく先頭へ入る
    keydown(doc.querySelector('.composer-queue') as HTMLElement, { key: 'ArrowDown' });
    await tick();
    expect(doc.activeElement?.textContent).toContain('一');
    // 先頭が送られて繰り上がる（2秒ごとの読み直し）。フォーカスはbodyへ落ちない
    keydown(doc.activeElement as HTMLElement, { key: 'ArrowDown' });
    await vi.advanceTimersByTimeAsync(2_000);
    answer(['二', '三']);
    await tick();
    expect(doc.activeElement?.textContent).toContain('二');
    expect(doc.activeElement?.tagName).toBe('BUTTON');
  });

  it('送信したあとに遅れて届いた@の候補で、空になった指示欄へ候補を出さない（Issue #2158のレビュー）', async () => {
    const { window, posted, deliver } = boot();
    await tick();
    deliver({ type: 'snapshot', snapshot: { ...snapshot([]), sessions: [runningSession] } });
    await tick();
    const doc = window.document;
    const input = doc.querySelector('textarea.composer-input') as HTMLTextAreaElement;
    input.focus();
    input.value = '見て @sr';
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await tick();
    // 候補の取り寄せ（150ms待ち）が走る前に送る
    input.dispatchEvent(
      new window.KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await tick();
    const send = posted.find((m) => m.action === 'send');
    deliver({ type: 'controlResult', seq: send?.seq, ok: true });
    await tick();
    // 保留していた取り寄せが走っても応答しても、送った後の指示欄に候補を出さない
    await vi.advanceTimersByTimeAsync(300);
    const files = posted.filter((m) => m.action === 'fileCandidates').at(-1);
    if (files !== undefined) {
      deliver({ type: 'controlResult', seq: files.seq, ok: true, files: ['src/a.ts'] });
    }
    await tick();
    expect(input.value).toBe('');
    expect(doc.querySelector('.composer-candidates')).toBeNull();
  });

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

  describe('キーボードだけで操作する（Issue #2152）', () => {
    const press = (window: DOMWindow, k: string, init: Partial<KeyboardEventInit> = {}): void => {
      const target = window.document.activeElement ?? window.document.body;
      target.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, ...init }));
    };
    const focusedPane = (window: DOMWindow): string | undefined =>
      window.document.querySelector<HTMLElement>('.pane-focused')?.dataset['pane'];

    it('Tab / Shift+Tabでペインを移り、フォーカスのあるペインに枠が付く。repo一覧はj / kで選ぶ', async () => {
      const { window, deliver } = boot();
      await tick();
      deliver({ type: 'snapshot', snapshot: { ...snapshot([]), sessions: [runningSession] } });
      await tick();
      expect(focusedPane(window)).toBe('list');
      press(window, 'Tab');
      await tick();
      expect(focusedPane(window)).toBe('detail');
      expect(window.document.activeElement?.getAttribute('data-pane')).toBe('detail');
      press(window, 'Tab', { shiftKey: true });
      await tick();
      press(window, 'ArrowLeft');
      await tick();
      expect(focusedPane(window)).toBe('rail');
      press(window, 'j');
      await tick();
      expect(window.document.querySelector('.rail-item.active')?.textContent).toContain('app');
      press(window, 'k');
      await tick();
      expect(window.document.querySelector('.rail-item.active')?.textContent).toContain('すべて');
    });

    it(':のパレットで操作を名前で絞り込み、Enterで実行する', async () => {
      const { window, deliver } = boot();
      await tick();
      deliver({ type: 'snapshot', snapshot: { ...snapshot([]), sessions: [runningSession] } });
      await tick();
      press(window, ':');
      await tick();
      const input = window.document.querySelector(
        '[aria-label="コマンドパレット"] input',
      ) as HTMLInputElement;
      expect(window.document.activeElement).toBe(input);
      // 選んでいるセッションに効く操作（閉じるなど）が上に出る
      const first = window.document.querySelector('.palette-item')?.textContent ?? '';
      expect(first).not.toContain('検索');
      input.value = '履歴';
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      await tick();
      press(window, 'Enter');
      await tick();
      expect(window.document.querySelector('[aria-label="コマンドパレット"]')).toBeNull();
      expect(window.document.querySelector('[role="dialog"][aria-label="履歴"]')).not.toBeNull();
    });

    it('パレットから許可リストの拡張コマンドをキーだけで実行し、送るのはidと宛先だけ（Issue #2161）', async () => {
      const { window, posted, deliver } = boot();
      await tick();
      deliver({ type: 'snapshot', snapshot: { ...snapshot([]), sessions: [runningSession] } });
      await tick();
      const runFromPalette = async (query: string): Promise<Record<string, unknown>> => {
        press(window, ':');
        await tick();
        const input = window.document.querySelector(
          '[aria-label="コマンドパレット"] input',
        ) as HTMLInputElement;
        input.value = query;
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        await tick();
        press(window, 'Enter');
        await vi.waitFor(() => expect(posted.at(-1)?.type).toBe('runCommand'));
        return posted.pop() as Record<string, unknown>;
      };
      // 引数を取らないコマンドはidだけを送る
      const usage = await runFromPalette('使用量を表示');
      expect(Object.keys(usage).sort()).toEqual(['command', 'seq', 'type']);
      expect(usage.command).toBe('codex.showUsage');
      // providerを渡すコマンドは選択中のセッションの宛先だけを添える
      const forge = await runFromPalette('Forge Hub');
      expect(forge).toEqual({
        type: 'runCommand',
        seq: forge.seq,
        command: 'agent.forgeHub',
        windowId: runningSession.windowId,
        provider: runningSession.provider,
        threadId: runningSession.threadId,
      });
    });

    it('詳細ペインのボタンにアクセスキーを振り、その英字で押せる。全体のキーの英字は振らない', async () => {
      const { window, posted, deliver } = boot();
      await tick();
      deliver({ type: 'snapshot', snapshot: { ...snapshot([]), sessions: [runningSession] } });
      await tick();
      const detail = window.document.querySelector('[data-pane="detail"]') as HTMLElement;
      const keyed = [...detail.querySelectorAll<HTMLElement>('[data-akey]')];
      expect(keyed.length).toBeGreaterThan(0);
      for (const element of keyed) {
        expect('jkadrnxceht').not.toContain(element.dataset['akey']);
      }
      // 全体のキーと同じ意味のボタンには振らず、そのキーを表示する
      const close = [...detail.querySelectorAll<HTMLElement>('button')].find(
        (b) => b.getAttribute('data-key-label') === 'c',
      );
      expect(close?.hasAttribute('data-akey')).toBe(false);
      const button = keyed.find((element) => element instanceof window.HTMLButtonElement);
      expect(button).toBeDefined();
      let clicked = false;
      button?.addEventListener('click', () => {
        clicked = true;
      });
      press(window, button?.dataset['akey'] ?? '');
      await tick();
      expect(clicked).toBe(true);
      // .でキーの表示を切り替える
      expect(window.document.querySelector('.mc')?.classList.contains('akeys')).toBe(true);
      press(window, '.');
      await tick();
      expect(window.document.querySelector('.mc')?.classList.contains('akeys')).toBe(false);
      expect(posted.length).toBeGreaterThan(0);
    });

    it('?のヘルプはキーの表の全行を出す', async () => {
      const { window, deliver } = boot();
      await tick();
      deliver({ type: 'snapshot', snapshot: snapshot([]) });
      await tick();
      press(window, '?');
      await tick();
      const rows = window.document.querySelectorAll('[aria-label="キー操作"] tr');
      // キーの表と、指示欄の中のキー（Issue #2158）の表
      expect(rows.length).toBe(KEY_HELP.length + COMPOSER_KEY_HELP.length);
    });

    it('新規起動のダイアログはTabが外へ抜けず、Ctrl+Enterで起動する', async () => {
      const { window, posted, deliver } = boot();
      await tick();
      deliver({ type: 'snapshot', snapshot: snapshot([]) });
      await tick();
      press(window, 'n');
      await tick();
      const options = posted.find((m) => m.type === 'launchOptions');
      deliver({
        type: 'reply',
        seq: options?.seq,
        ok: true,
        repos: [{ path: '/w/app', key: '/w/app', label: 'app', source: 'session' }],
      });
      await tick();
      const dialog = window.document.querySelector('[role="dialog"]') as HTMLElement;
      const focusables = [
        ...dialog.querySelectorAll<HTMLElement>('button, select, textarea, input'),
      ];
      const last = focusables.filter((e) => !(e as HTMLButtonElement).disabled).at(-1);
      last?.focus();
      press(window, 'Tab');
      expect(dialog.contains(window.document.activeElement)).toBe(true);
      const textarea = dialog.querySelector('textarea') as HTMLTextAreaElement;
      textarea.focus();
      press(window, 'Enter', { ctrlKey: true });
      await tick();
      expect(posted.find((m) => m.type === 'launch')).toMatchObject({ cwd: '/w/app' });
    });

    it('チェックボックスをアクセスキーで押した後も、次のアクセスキーが効く', async () => {
      const { window, posted, deliver } = boot();
      await tick();
      deliver({ type: 'snapshot', snapshot: snapshot([]) });
      await tick();
      press(window, 'n');
      await tick();
      const options = posted.find((m) => m.type === 'launchOptions');
      deliver({
        type: 'reply',
        seq: options?.seq,
        ok: true,
        repos: [{ path: '/w/app', key: '/w/app', label: 'app', source: 'session' }],
      });
      await tick();
      const dialog = window.document.querySelector('[role="dialog"]') as HTMLElement;
      // 開いた直後はrepoの選択欄にフォーカスがあり、英字は選択欄の文字入力になる。Escで出る
      press(window, 'Escape');
      await tick();
      const checkbox = dialog.querySelector('input[type="checkbox"]') as HTMLInputElement;
      const before = checkbox.checked;
      press(window, checkbox.dataset['akey'] ?? '');
      await tick();
      expect(checkbox.checked).toBe(!before);
      const textarea = dialog.querySelector('textarea') as HTMLTextAreaElement;
      press(window, textarea.dataset['akey'] ?? '');
      await tick();
      expect(window.document.activeElement).toBe(textarea);
    });
  });

  it('IMEで変換している途中のCtrl+Enterでは、全体のキー処理から送信しない（Issue #2152）', async () => {
    const { window, posted, deliver } = boot();
    await tick();
    deliver({ type: 'snapshot', snapshot: { ...snapshot([]), sessions: [runningSession] } });
    await tick();
    const input = window.document.querySelector('textarea.composer-input') as HTMLTextAreaElement;
    input.value = '変換中';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await tick();
    const button = window.document.querySelector(
      'form.composer button[type="submit"]',
    ) as HTMLButtonElement;
    const press = (init: KeyboardEventInit & { keyCode?: number }): void => {
      button.dispatchEvent(
        new window.KeyboardEvent('keydown', {
          key: 'Enter',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
          ...init,
        }),
      );
    };
    press({ isComposing: true });
    press({ keyCode: 229 });
    await tick();
    expect(posted.filter((m) => m.action === 'send')).toHaveLength(0);
    press({});
    await tick();
    expect(posted.filter((m) => m.action === 'send')).toHaveLength(1);
  });

  it('詳細の会話を先頭まで遡り、会話内を検索して一致へ移り、ツール / diffをキーで開閉する（Issue #2157）', async () => {
    const { window, posted, deliver } = boot();
    // JSDOMにはscrollIntoViewが無い
    window.HTMLElement.prototype.scrollIntoView = () => undefined;
    const shiftKey = (k: string): void => {
      window.document.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: k, shiftKey: true, bubbles: true }),
      );
    };
    const page = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, i) =>
        from + i === 100
          ? { role: 'tool', text: '出力に needle', title: '$ npm test', truncated: false }
          : {
              role: 'user',
              text: `発言${from + i}${from + i === 5 ? ' needle' : ''}`,
              truncated: false,
            },
      );
    const answer = (before: number | undefined, from: number) => {
      const request = posted.filter((m) => m.action === 'recentTurns').at(-1);
      expect(request?.before).toBe(before);
      deliver({
        type: 'controlResult',
        seq: request?.seq,
        ok: true,
        turns: page(from, before ?? 130),
        turnStart: from,
        turnTotal: 130,
      });
    };
    await tick();
    deliver({ type: 'snapshot', snapshot: { ...snapshot([]), sessions: [runningSession] } });
    await tick();
    answer(undefined, 80);
    await tick();
    const doc = window.document;
    expect(doc.querySelectorAll('.turn-log .turn')).toHaveLength(50);
    expect(doc.body.textContent).toContain('あと80件');
    // ツール呼び出しは閉じて出し、Shift+Eで開く・もう一度で閉じる
    expect(doc.querySelector('.turn.tool .turn-output')).toBeNull();
    shiftKey('E');
    await tick();
    expect(doc.querySelector('.turn.tool .turn-output')?.textContent).toContain('出力に needle');
    shiftKey('E');
    await tick();
    expect(doc.querySelector('.turn.tool .turn-output')).toBeNull();
    // Shift+Oで古いやり取りを読み足す
    shiftKey('O');
    await tick();
    answer(80, 30);
    await tick();
    expect(doc.querySelectorAll('.turn-log .turn')).toHaveLength(100);
    // Shift+Sで検索欄へ移り、語を入れると先頭まで読み込んでから探す
    shiftKey('S');
    await tick();
    const search = doc.querySelector('.turn-search-input') as HTMLInputElement;
    expect(doc.activeElement).toBe(search);
    search.value = 'needle';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    await tick();
    answer(30, 0);
    await tick();
    expect(doc.querySelectorAll('.turn-log .turn')).toHaveLength(130);
    expect(doc.body.textContent).toContain('会話の先頭');
    expect(doc.querySelector('.turn-search-count')?.textContent).toBe('1 / 2件');
    expect(doc.querySelector('.turn-match.current')?.closest('.turn')?.textContent).toContain(
      '発言5',
    );
    // 入力欄から出て、Shift+Nで次の一致へ。閉じていたツールの出力は開いて見せる
    search.blur();
    shiftKey('N');
    await tick();
    expect(doc.querySelector('.turn-search-count')?.textContent).toBe('2 / 2件');
    expect(doc.querySelector('.turn-match.current')?.closest('.turn-output')).not.toBeNull();
    shiftKey('P');
    await tick();
    expect(doc.querySelector('.turn-search-count')?.textContent).toBe('1 / 2件');
  });

  describe('履歴の検索結果から詳細を開く（Issue #2178の受入基準3）', () => {
    const historyItem = (overrides: Record<string, unknown>) => ({
      provider: 'codex',
      threadId: 't1',
      title: '無関係な見出し',
      repoKey: '/w/app',
      repoLabel: 'app',
      cwdFull: '/w/app',
      updatedAt: 1,
      archived: false,
      ...overrides,
    });
    const openHistory = async () => {
      const env = boot();
      env.window.HTMLElement.prototype.scrollIntoView = () => undefined;
      await tick();
      env.deliver({ type: 'snapshot', snapshot: snapshot([]) });
      await tick();
      env.key('h');
      await tick();
      const request = env.posted.find((m) => m.type === 'history');
      expect(request).toBeDefined();
      return { ...env, request };
    };
    const enter = (window: DOMWindow): void => {
      // 履歴のEnterは、ダイアログの中（検索欄）から上がってくるキーで受ける
      window.document
        .querySelector('.history-filter input[type=search]')
        ?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    };

    it('件数の上限で載せなかった古いセッションがあれば、その数と台帳の案内を出す', async () => {
      const { window, deliver, request } = await openHistory();
      deliver({
        type: 'reply',
        seq: request?.seq,
        ok: true,
        history: [historyItem({ threadId: 't1' })],
        historyOmitted: 42,
      });
      await tick();
      const text = window.document.body.textContent ?? '';
      expect(text).toContain('古い42件のセッションは履歴に載せていません');
      expect(text).toContain('handoff台帳（l）');
    });

    it('会話記録が残るセッションは、検索語で絞って開くと選ばれ、会話内検索へ語が入る', async () => {
      const { window, posted, deliver, request } = await openHistory();
      deliver({
        type: 'reply',
        seq: request?.seq,
        ok: true,
        history: [
          historyItem({ threadId: 't1', firstPrompt: '古いバグを直して' }),
          historyItem({ threadId: 't2', firstPrompt: '別の依頼' }),
        ],
      });
      await tick();
      const doc = window.document;
      expect(doc.querySelectorAll('[data-history]')).toHaveLength(2);
      const input = doc.querySelector('.history-filter input[type=search]') as HTMLInputElement;
      input.value = '古いバグ';
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      await tick();
      expect(doc.querySelectorAll('[data-history]')).toHaveLength(1);
      expect(doc.querySelector('[data-history]')?.textContent).toContain('古いバグを直して');
      enter(window);
      await tick();
      const open = posted.find((m) => m.type === 'historyOpen');
      expect(open).toMatchObject({ provider: 'codex', threadId: 't1' });
      deliver({ type: 'reply', seq: open?.seq, ok: true });
      await tick();
      deliver({ type: 'snapshot', snapshot: { ...snapshot([]), sessions: [runningSession] } });
      await tick();
      const turns = posted.filter((m) => m.action === 'recentTurns').at(-1);
      expect(turns).toBeDefined();
      deliver({
        type: 'controlResult',
        seq: turns?.seq,
        ok: true,
        turns: [{ role: 'user', text: '古いバグを直して', truncated: false }],
        turnStart: 0,
        turnTotal: 1,
      });
      await tick();
      const search = doc.querySelector('.turn-search-input') as HTMLInputElement | null;
      expect(search?.value).toBe('古いバグ');
    });

    it('会話記録が消えたセッションは、Enterでhandoff台帳が開き、台帳の条件にセッションidが入る', async () => {
      const { window, posted, deliver, request } = await openHistory();
      deliver({
        type: 'reply',
        seq: request?.seq,
        ok: true,
        history: [
          historyItem({
            threadId: 'gone-1',
            firstPrompt: '消えた会話',
            transcriptMissing: true,
            handoffCount: 2,
          }),
        ],
      });
      await tick();
      enter(window);
      await tick();
      expect(posted.some((m) => m.type === 'historyOpen')).toBe(false);
      // 台帳の要求は入力の落ち着き待ち（300ms）の後に出る
      await vi.advanceTimersByTimeAsync(400);
      const ledger = posted.find((m) => m.type === 'handoffLedger');
      expect(ledger).toBeDefined();
      expect((ledger?.query as { session: string }).session).toBe('gone-1');
    });
  });

  describe('詳細の会話（Issue #2157）', () => {
    const userPage = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, i) => ({
        role: 'user',
        text: `発言${from + i}`,
        truncated: false,
      }));
    const setup = async () => {
      const env = boot();
      const scrolled: string[] = [];
      env.window.HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
        scrolled.push(this.textContent ?? '');
      };
      const shiftKey = (k: string): void => {
        env.window.document.dispatchEvent(
          new env.window.KeyboardEvent('keydown', { key: k, shiftKey: true, bubbles: true }),
        );
      };
      const lastRequest = () => env.posted.filter((m) => m.action === 'recentTurns').at(-1);
      const reply = (seq: unknown, turns: unknown[], start: number, total: number) => {
        env.deliver({
          type: 'controlResult',
          seq,
          ok: true,
          turns,
          turnStart: start,
          turnTotal: total,
        });
      };
      await tick();
      env.deliver({ type: 'snapshot', snapshot: { ...snapshot([]), sessions: [runningSession] } });
      await tick();
      return { ...env, scrolled, shiftKey, lastRequest, reply };
    };

    it('検索語を変えると同じやり取りの別位置へスクロールし直す', async () => {
      const { window, scrolled, lastRequest, reply } = await setup();
      const long = `aaa${'x'.repeat(5000)}bbb`;
      reply(lastRequest()?.seq, [{ role: 'agent', text: long, truncated: false }], 0, 1);
      await tick();
      const search = window.document.querySelector('.turn-search-input') as HTMLInputElement;
      search.value = 'aaa';
      search.dispatchEvent(new window.Event('input', { bubbles: true }));
      await tick();
      search.value = 'bbb';
      search.dispatchEvent(new window.Event('input', { bubbles: true }));
      await tick();
      expect(scrolled).toEqual(['aaa', 'bbb']);
    });

    it('読み足し中に再読込して末尾が先へ進んでも、遅れて届いた古い応答で末尾を消さない', async () => {
      const { window, posted, shiftKey, lastRequest, reply } = await setup();
      reply(lastRequest()?.seq, userPage(80, 130), 80, 130);
      await tick();
      shiftKey('O');
      await tick();
      const olderSeq = lastRequest()?.seq;
      expect(lastRequest()?.before).toBe(80);
      (
        Array.from(window.document.querySelectorAll('button')).find(
          (b) => b.textContent === '再読込',
        ) as HTMLButtonElement
      ).click();
      await tick();
      const reloadSeq = lastRequest()?.seq;
      expect(reloadSeq).not.toBe(olderSeq);
      reply(reloadSeq, userPage(90, 140), 90, 140);
      await tick();
      reply(olderSeq, userPage(30, 80), 30, 130);
      await tick();
      const texts = Array.from(window.document.querySelectorAll('.turn-log .turn')).map(
        (e) => e.textContent,
      );
      // 遅れて届いた古い範囲で、取り直した末尾（発言139）を消さない
      expect(texts).toHaveLength(50);
      expect(texts.at(-1)).toContain('発言139');
      // 取り直した後の古い応答では続きを取らない
      expect(posted.filter((m) => m.action === 'recentTurns').at(-1)?.seq).toBe(reloadSeq);
    });

    it('上端までスクロールすると古いやり取りを要求し、Shift+Oを繰り返して先頭まで届く', async () => {
      const { window, shiftKey, lastRequest, reply } = await setup();
      reply(lastRequest()?.seq, userPage(80, 130), 80, 130);
      await tick();
      const log = window.document.querySelector('.turn-log') as HTMLElement;
      log.scrollTop = 0;
      log.dispatchEvent(new window.Event('scroll'));
      await tick();
      expect(lastRequest()?.before).toBe(80);
      reply(lastRequest()?.seq, userPage(30, 80), 30, 130);
      await tick();
      shiftKey('O');
      await tick();
      expect(lastRequest()?.before).toBe(30);
      reply(lastRequest()?.seq, userPage(0, 30), 0, 130);
      await tick();
      const turns = window.document.querySelectorAll('.turn-log .turn');
      expect(turns).toHaveLength(130);
      expect(turns[0]?.textContent).toContain('発言0');
      expect(window.document.body.textContent).toContain('会話の先頭');
    });

    it('入力欄のEnter / Shift+Enterで移動、一致なし表示、パレットとヘルプに載る', async () => {
      const { window, key, lastRequest, reply } = await setup();
      reply(
        lastRequest()?.seq,
        [
          { role: 'user', text: 'foo one', truncated: false },
          { role: 'agent', text: 'foo two foo three', truncated: false },
        ],
        0,
        2,
      );
      await tick();
      const doc = window.document;
      const search = doc.querySelector('.turn-search-input') as HTMLInputElement;
      search.value = 'foo';
      search.dispatchEvent(new window.Event('input', { bubbles: true }));
      await tick();
      const count = () => doc.querySelector('.turn-search-count')?.textContent;
      expect(count()).toBe('1 / 3件');
      search.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await tick();
      expect(count()).toBe('2 / 3件');
      search.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await tick();
      search.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await tick();
      expect(count()).toBe('1 / 3件');
      search.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }),
      );
      await tick();
      expect(count()).toBe('3 / 3件');
      search.value = 'zzz';
      search.dispatchEvent(new window.Event('input', { bubbles: true }));
      await tick();
      expect(count()).toBe('一致なし');
      search.blur();
      key(':');
      await tick();
      const palette = doc.body.textContent ?? '';
      for (const label of [
        '会話内を検索',
        '会話内の次の一致へ',
        '会話内の前の一致へ',
        'まとめて開く',
        '古いやり取りを読み足す',
      ]) {
        expect(palette).toContain(label);
      }
      const help = JSON.stringify(KEY_HELP);
      for (const k of ['Shift+s', 'Shift+n', 'Shift+p', 'Shift+e', 'Shift+o']) {
        expect(help.toLowerCase()).toContain(k.toLowerCase());
      }
    });

    it('クリックで1件ずつ開閉、Shift+Eでまとめて開閉（diffも）', async () => {
      const { window, shiftKey, lastRequest, reply } = await setup();
      reply(
        lastRequest()?.seq,
        [
          { role: 'tool', text: 'out1', title: '$ ls', truncated: false },
          { role: 'diff', text: '+a', title: 'update a.ts', truncated: false },
        ],
        0,
        2,
      );
      await tick();
      const doc = window.document;
      const outputs = () => doc.querySelectorAll('.turn-output').length;
      expect(outputs()).toBe(0);
      (doc.querySelector('.turn.diff .turn-fold') as HTMLButtonElement).click();
      await tick();
      expect(doc.querySelector('.turn.diff .turn-output')?.textContent).toContain('+a');
      expect(outputs()).toBe(1);
      shiftKey('E');
      await tick();
      expect(outputs()).toBe(2);
      shiftKey('E');
      await tick();
      expect(outputs()).toBe(0);
    });
  });

  describe('選んだセッションへの操作（Issue #2160）', () => {
    const otherWindowClaude = {
      ...runningSession,
      key: 's2',
      windowId: 'w2',
      threadId: 'c-2',
      provider: 'claude' as const,
      isCurrentWindow: false,
      title: '別ウィンドウの会話',
      activity: 'idle' as const,
    };
    const setup = async (sessions: Array<typeof runningSession | typeof otherWindowClaude>) => {
      const env = boot();
      env.window.HTMLElement.prototype.scrollIntoView = () => undefined;
      const shiftKey = (k: string): void => {
        env.window.document.dispatchEvent(
          new env.window.KeyboardEvent('keydown', { key: k, shiftKey: true, bubbles: true }),
        );
      };
      const reply = (action: string, result: Record<string, unknown>): void => {
        const request = env.posted.filter((m) => m.action === action).at(-1);
        env.deliver({ type: 'controlResult', seq: request?.seq, ok: true, ...result });
      };
      await tick();
      env.deliver({ type: 'snapshot', snapshot: { ...snapshot([]), sessions } });
      await tick();
      return { ...env, shiftKey, reply };
    };
    const ops = (posted: Array<Record<string, unknown>>) =>
      posted.filter(
        (m) =>
          m.type === 'control' &&
          [
            'rename',
            'clear',
            'rewindPreview',
            'rewind',
            'fork',
            'handoff',
            'pin',
            'unpin',
          ].includes(String(m.action)),
      );

    it('名前の変更は別ウィンドウの選んだセッションの宛先で送る', async () => {
      const { window, posted, shiftKey } = await setup([otherWindowClaude]);
      shiftKey('R');
      await tick();
      const input = window.document.querySelector('[aria-label="新しい名前"]') as HTMLInputElement;
      expect(input).not.toBeNull();
      input.value = '  新しい名前  ';
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      await tick();
      (input.closest('form') as HTMLFormElement).requestSubmit();
      await tick();
      expect(ops(posted)).toEqual([
        expect.objectContaining({
          action: 'rename',
          name: '新しい名前',
          windowId: 'w2',
          provider: 'claude',
          threadId: 'c-2',
        }),
      ]);
    });

    it('クリアは確認を出し、押すまで送らない。Escで閉じれば送らない', async () => {
      const { window, posted, shiftKey } = await setup([otherWindowClaude]);
      shiftKey('C');
      await tick();
      const dialog = window.document.querySelector('[aria-label="会話のクリア"]');
      expect(dialog?.textContent).toContain('進行中のターンは中断されます');
      expect(ops(posted)).toHaveLength(0);
      window.document.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      await tick();
      expect(window.document.querySelector('[aria-label="会話のクリア"]')).toBeNull();
      expect(ops(posted)).toHaveLength(0);
      shiftKey('C');
      await tick();
      (
        window.document.querySelector('[aria-label="会話のクリア"] [data-submit]') as HTMLElement
      ).click();
      await tick();
      expect(ops(posted)).toEqual([
        expect.objectContaining({ action: 'clear', windowId: 'w2', threadId: 'c-2' }),
      ]);
    });

    it('分岐・ピン留め・引き継ぎは、j / kで選び直したセッションへ送る', async () => {
      const { posted, shiftKey, key } = await setup([
        runningSession,
        { ...otherWindowClaude, pinned: true } as typeof otherWindowClaude,
      ]);
      const focusedThread = (): unknown => {
        shiftKey('B');
        return ops(posted).at(-1)?.threadId;
      };
      const first = focusedThread();
      await tick();
      key('j');
      await tick();
      const second = focusedThread();
      await tick();
      expect(new Set([first, second])).toEqual(new Set(['t1', 'c-2']));
      // 今選んでいるのはsecond。ピン留め済みのClaudeならunpin、Codexならpinを送る
      shiftKey('I');
      shiftKey('H');
      await tick();
      const last = ops(posted).slice(-2);
      expect(last.map((m) => m.threadId)).toEqual([second, second]);
      expect(last[0]?.action).toBe(second === 'c-2' ? 'unpin' : 'pin');
      expect(last[1]?.action).toBe('handoff');
    });

    it('Codexのセッションでは巻き戻しを出さない', async () => {
      const { window, posted, shiftKey } = await setup([runningSession]);
      shiftKey('Z');
      await tick();
      expect(window.document.querySelector('[aria-label="巻き戻し"]')).toBeNull();
      expect(window.document.querySelector('.toast')?.textContent).toContain('Claude');
      expect(ops(posted)).toHaveLength(0);
    });

    it('巻き戻しは発言の固定のidで確かめ、ファイルが無ければ巻き戻すボタンを出さない', async () => {
      const { window, posted, shiftKey, reply } = await setup([otherWindowClaude]);
      shiftKey('Z');
      await tick();
      reply('recentTurns', {
        turns: [
          { role: 'user', text: '古い発言', truncated: false, id: 'u-old' },
          { role: 'agent', text: '応答', truncated: false },
          { role: 'user', text: '新しい発言', truncated: false, id: 'u-new' },
        ],
      });
      await tick();
      const dialog = (): Element | null => window.document.querySelector('[aria-label="巻き戻し"]');
      expect(dialog()?.textContent).toContain('会話の履歴は変わりません');
      // 新しい順に並ぶ。↓で古い発言へ移ってEnterで確かめる
      const list = dialog()?.querySelector('[role="listbox"]') as HTMLElement;
      list.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await tick();
      list.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await tick();
      expect(ops(posted).at(-1)).toMatchObject({
        action: 'rewindPreview',
        messageId: 'u-old',
        threadId: 'c-2',
      });
      reply('rewindPreview', { rewindFiles: [] });
      await tick();
      expect(dialog()?.textContent).toContain('戻すファイルの変更はありません');
      expect(dialog()?.querySelector('[data-submit]')).toBeNull();
      // 選び直して、ファイルがある発言なら確認を経て送る
      (
        Array.from(dialog()?.querySelectorAll('button') ?? []).find(
          (b) => b.textContent === '選び直す',
        ) as HTMLElement
      ).click();
      await tick();
      (dialog()?.querySelector('[role="listbox"]') as HTMLElement).dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
      await tick();
      reply('rewindPreview', { rewindFiles: ['src/a.ts'] });
      await tick();
      expect(dialog()?.textContent).toContain('src/a.ts');
      expect(ops(posted).filter((m) => m.action === 'rewind')).toHaveLength(0);
      (dialog()?.querySelector('[data-submit]') as HTMLElement).click();
      await tick();
      expect(ops(posted).at(-1)).toMatchObject({
        action: 'rewind',
        messageId: ops(posted)
          .filter((m) => m.action === 'rewindPreview')
          .at(-1)?.messageId,
        windowId: 'w2',
        threadId: 'c-2',
      });
    });
  });

  describe('作業履歴カレンダー（Issue #2179）', () => {
    const pad = (n: number): string => String(n).padStart(2, '0');
    const dayKey = (d: Date): string =>
      `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const calendarSession = (threadId: string, title: string) => ({
      provider: 'claude' as const,
      threadId,
      title,
      issue: undefined,
      branch: undefined,
      firstAt: 0,
      lastAt: 0,
      ended: threadId === 'c2',
      turns: 1,
      skills: [],
      costUsd: undefined,
      tokens: undefined,
    });

    it('ダイアログ内のh / l / k / j / t / n / p / [ / ]は日・月・セッションの移動にだけ使い、全体のキー（h=履歴、l=台帳、t=タブ）を発火させない', async () => {
      const { window, posted, deliver, key } = boot();
      window.HTMLElement.prototype.scrollIntoView = () => undefined;
      await tick();
      deliver({ type: 'snapshot', snapshot: snapshot([]) });
      await tick();
      key('m');
      await tick();
      const doc = window.document;
      const request = posted.filter((m) => m.type === 'workCalendar').at(-1);
      const now = new Date();
      expect(request).toMatchObject({ year: now.getFullYear(), month: now.getMonth() + 1 });
      deliver({
        type: 'reply',
        seq: request?.seq,
        ok: true,
        calendar: {
          year: now.getFullYear(),
          month: now.getMonth() + 1,
          days: [
            {
              day: dayKey(now),
              sessionCount: 2,
              units: [],
              skills: [],
              costUsd: undefined,
              tokens: undefined,
              usage: [],
              sessions: [calendarSession('c1', '一つ目'), calendarSession('c2', '二つ目')],
            },
          ],
        },
      });
      await tick();
      const dialog = (): HTMLElement =>
        doc.querySelector('[aria-label="作業履歴カレンダー"]') as HTMLElement;
      const box = dialog().querySelector('.calendar-box') as HTMLElement;
      expect(doc.activeElement).toBe(box);
      const heading = (): string => dialog().querySelector('h3')?.textContent ?? '';
      const press = (k: string): void => {
        (doc.activeElement ?? doc.body).dispatchEvent(
          new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }),
        );
      };
      const before = posted.length;
      expect(heading()).toBe(`${String(now.getMonth() + 1)}月${String(now.getDate())}日`);
      expect(dialog().querySelectorAll('[role="option"]')).toHaveLength(2);
      // 月表示のマスに日ごとの作業量（セッション数と塗りの段階）が出る
      const todayCell = dialog().querySelector('.calendar-cell.today');
      expect(todayCell?.textContent).toContain('2件');
      expect(todayCell?.classList.contains('level-4')).toBe(true);
      expect(dialog().querySelectorAll('.calendar-cell.level-0').length).toBeGreaterThan(0);
      // 閉じたセッションも並ぶ
      expect(dialog().querySelector('[data-calendar-session="1"]')?.textContent).toContain(
        '閉じた',
      );
      // n / pでその日のセッションを選ぶ
      press('n');
      await tick();
      expect(
        dialog().querySelector('[role="option"][aria-selected="true"]')?.textContent,
      ).toContain('二つ目');
      press('p');
      await tick();
      expect(
        dialog().querySelector('[role="option"][aria-selected="true"]')?.textContent,
      ).toContain('一つ目');
      // h / lで前後の日、k / jで前後の週、tで今日
      const shifted = (delta: number): string => {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + delta);
        return `${String(d.getMonth() + 1)}月${String(d.getDate())}日`;
      };
      press('h');
      await tick();
      expect(heading()).toBe(shifted(-1));
      // キーは1つずつ別のタスクで届く（同じタスクで続けて送ると描画前の日から数える）
      press('l');
      await tick();
      press('l');
      await tick();
      expect(heading()).toBe(shifted(1));
      press('t');
      await tick();
      expect(heading()).toBe(shifted(0));
      press('k');
      await tick();
      expect(heading()).toBe(shifted(-7));
      press('j');
      await tick();
      expect(heading()).toBe(shifted(0));
      // [ / ]は月を替えて取り寄せ直す（全体の[ / ]の操作は走らない）
      press(']');
      await tick();
      press('[');
      await tick();
      expect(heading()).toBe(shifted(0));
      // 履歴・台帳・タブの切替は起きず、ダイアログはカレンダーの1つだけ
      const sent = posted.slice(before).map((m) => m.type ?? m.action);
      expect(sent).toEqual(['workCalendar', 'workCalendar']);
      expect(doc.querySelectorAll('[role="dialog"]')).toHaveLength(1);
      expect(dialog()).not.toBeNull();
      // フォーカスがダイアログの外へ出ていても、hとlで履歴・台帳は開かない
      box.blur();
      key('h');
      key('l');
      key('t');
      await tick();
      expect(posted.slice(before).map((m) => m.type ?? m.action)).toEqual([
        'workCalendar',
        'workCalendar',
      ]);
      expect(doc.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    });
  });
});
