import { mkdtemp, readdir, rm, stat, utimes, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensure: vi.fn(),
  connect: vi.fn(),
  evaluate: vi.fn(),
  readdirFail: false,
}));
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    readdir: ((...args: Parameters<typeof actual.readdir>) =>
      mocks.readdirFail
        ? Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
        : (actual.readdir as (...a: unknown[]) => unknown)(...args)) as typeof actual.readdir,
  };
});

vi.mock('../../src/webGpt/browser', () => ({ ensureWebGptBrowser: mocks.ensure }));
vi.mock('../../src/webGpt/cdp', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/webGpt/cdp')>('../../src/webGpt/cdp');
  return {
    ...actual,
    CdpBrowser: { connect: mocks.connect },
    evaluateInPage: mocks.evaluate,
  };
});
// 待ち時間を実際には待たず即時に解決する。偽の時計が有効なテストでは、その分だけ時計を進める
vi.mock('node:timers/promises', () => ({
  setTimeout: (ms: number, _v: unknown, opts?: { signal?: AbortSignal }) => {
    if (opts?.signal?.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    }
    if (vi.isFakeTimers()) vi.setSystemTime(Date.now() + ms);
    return Promise.resolve();
  },
}));

import { CdpClosedError } from '../../src/webGpt/cdp';
import {
  generateImage,
  IMAGE_PROMPT_MAX_LENGTH,
  IMAGE_RETENTION_MS,
  parseGenerateImageArgs,
  pruneOldImages,
} from '../../src/webGpt/imageGeneration';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const URL1 = 'https://chatgpt.com/c/abc-123';
const BLOB = 'blob:https://chatgpt.com/uuid';

interface Script {
  composer?: unknown[] | ((n: number) => unknown);
  send?: unknown;
  click?: unknown[];
  answer?: unknown[] | ((n: number) => unknown);
  fetch?: unknown;
}

let outDir: string;
let browser: {
  send: Mock<(method: string, ...args: unknown[]) => Promise<unknown>>;
  close: ReturnType<typeof vi.fn>;
};
let navigate: Record<string, unknown>;

function setScript(s: Script): void {
  const counters = { composer: 0, click: 0, answer: 0 };
  const pick = (
    v: unknown[] | ((n: number) => unknown) | undefined,
    key: keyof typeof counters,
  ) => {
    const n = counters[key]++;
    if (typeof v === 'function') return v(n);
    const arr = v ?? [];
    return arr[Math.min(n, arr.length - 1)];
  };
  mocks.evaluate.mockImplementation(async (_b: unknown, _s: unknown, expr: string) => {
    if (expr.includes('loadError')) {
      const r = pick(s.composer ?? [{ composer: true, turns: 1 }], 'composer');
      if (r instanceof Error) throw r;
      return r;
    }
    if (expr.includes('__codexExtSeenImages =')) return s.send ?? 'ready';
    if (expr.includes("'missing'")) return pick(s.click ?? ['clicked'], 'click');
    if (expr.includes('location.pathname')) {
      const r = pick(s.answer, 'answer');
      if (r instanceof Error) throw r;
      return r;
    }
    if (expr.includes('FileReader')) return s.fetch ?? [PNG];
    return undefined;
  });
}

const done = (images: string[] = [BLOB], extra: Record<string, unknown> = {}) => ({
  path: '/c/abc-123',
  turns: 1,
  state: 'complete',
  images,
  text: 'text',
  ...extra,
});

beforeEach(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'imgen-'));
  navigate = {};
  browser = {
    send: vi.fn(async (method: string) => {
      if (method === 'Target.createTarget') return { targetId: 't1' };
      if (method === 'Target.attachToTarget') return { sessionId: 's1' };
      if (method === 'Page.navigate') return navigate;
      return {};
    }),
    close: vi.fn(),
  };
  mocks.ensure.mockReset().mockResolvedValue(undefined);
  mocks.connect.mockReset().mockResolvedValue(browser);
  mocks.evaluate.mockReset();
  mocks.readdirFail = false;
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(outDir, { recursive: true, force: true });
});

describe('parseGenerateImageArgs', () => {
  it('rejects bad prompts', () => {
    for (const raw of [null, 'x', {}, { prompt: 1 }, { prompt: '  ' }]) {
      expect(parseGenerateImageArgs(raw).ok).toBe(false);
    }
    expect(parseGenerateImageArgs({ prompt: 'a'.repeat(IMAGE_PROMPT_MAX_LENGTH + 1) }).ok).toBe(
      false,
    );
  });

  it('accepts prompt without url', () => {
    expect(parseGenerateImageArgs({ prompt: 'p' })).toEqual({ ok: true, request: { prompt: 'p' } });
    expect(parseGenerateImageArgs({ prompt: 'p', conversationUrl: '' }).ok).toBe(true);
  });

  it('validates conversationUrl', () => {
    expect(parseGenerateImageArgs({ prompt: 'p', conversationUrl: 3 }).ok).toBe(false);
    const ok = parseGenerateImageArgs({ prompt: 'p', conversationUrl: URL1 });
    expect(ok).toEqual({ ok: true, request: { prompt: 'p', conversationUrl: URL1 } });
    expect(parseGenerateImageArgs({ prompt: 'p', conversationUrl: `${URL1}, ${URL1}` }).ok).toBe(
      false,
    );
    expect(parseGenerateImageArgs({ prompt: 'p', conversationUrl: 'not a url' }).ok).toBe(false);
  });
});

describe('generateImage', () => {
  it('saves images on success', async () => {
    setScript({ answer: [done()] });
    const r = await generateImage({ prompt: 'cat' }, { endpoint: 'e', outputDir: outDir });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.conversationUrl).toBe(URL1);
      expect(r.paths).toHaveLength(1);
      expect((await stat(r.paths[0] as string)).size).toBeGreaterThan(0);
    }
    expect(browser.send).toHaveBeenCalledWith('Target.closeTarget', { targetId: 't1' });
    expect(browser.close).toHaveBeenCalled();
  });

  it('saves jpeg and webp with extensions, existing conversation', async () => {
    setScript({
      answer: [done(['https://x.oaiusercontent.com/a', 'https://chatgpt.com/b'])],
      fetch: ['data:image/jpeg;base64,AAAA', 'data:image/webp;base64,AAAA'],
    });
    const r = await generateImage(
      { prompt: 'cat', conversationUrl: URL1 },
      { endpoint: 'e', outputDir: join(outDir, 'sub') },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.paths.map((p) => p.split('.').pop())).toEqual(['jpg', 'webp']);
  });

  it('fails when chrome unavailable', async () => {
    mocks.ensure.mockRejectedValue(new Error('down'));
    const r = await generateImage({ prompt: 'p' }, { endpoint: 'e', outputDir: outDir });
    expect(r).toMatchObject({ ok: false });
    mocks.ensure.mockRejectedValue('str');
    expect((await generateImage({ prompt: 'p' }, { endpoint: 'e', outputDir: outDir })).ok).toBe(
      false,
    );
  });

  it('fails when cdp connect fails', async () => {
    mocks.connect.mockRejectedValue(new Error('nocdp'));
    const r = await generateImage({ prompt: 'p' }, { endpoint: 'e', outputDir: outDir });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('nocdp') });
  });

  it('fails when createTarget lacks targetId, without closing', async () => {
    browser.send.mockResolvedValue({});
    const r = await generateImage({ prompt: 'p' }, { endpoint: 'e', outputDir: outDir });
    expect(r.ok).toBe(false);
    expect(browser.close).toHaveBeenCalled();
  });

  it('warns when closeTarget fails', async () => {
    setScript({ answer: [done()] });
    const base = browser.send.getMockImplementation() as (m: string) => Promise<unknown>;
    browser.send.mockImplementation(async (m: string, ...rest: unknown[]) => {
      if (m === 'Target.closeTarget') throw new Error('closefail');
      return base(m, ...(rest as []));
    });
    const logWarn = vi.fn();
    const r = await generateImage({ prompt: 'p' }, { endpoint: 'e', outputDir: outDir, logWarn });
    expect(r.ok).toBe(true);
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('closefail'));
    // no logWarn supplied
    expect((await generateImage({ prompt: 'p' }, { endpoint: 'e', outputDir: outDir })).ok).toBe(
      true,
    );
  });

  it('reports navigation error', async () => {
    navigate = { errorText: 'net::ERR' };
    setScript({});
    const r = await generateImage({ prompt: 'p' }, { endpoint: 'e', outputDir: outDir });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('net::ERR') });
  });

  it('reports composer problems', async () => {
    setScript({ composer: [{ login: true }] });
    let r = await generateImage({ prompt: 'p' }, { endpoint: 'e', outputDir: outDir });
    expect(r).toMatchObject({ error: expect.stringContaining('ログイン') });

    setScript({ composer: [{ loadError: true }] });
    r = await generateImage(
      { prompt: 'p', conversationUrl: URL1 },
      { endpoint: 'e', outputDir: outDir },
    );
    expect(r).toMatchObject({ error: expect.stringContaining('読み込めませんでした') });
  });

  it('waits for composer and turns, retries on page errors', async () => {
    setScript({
      composer: [
        new Error('ctx'),
        'junk',
        { composer: true, turns: 0 },
        { composer: true, turns: 2 },
      ],
      answer: [done()],
    });
    const r = await generateImage(
      { prompt: 'p', conversationUrl: URL1 },
      { endpoint: 'e', outputDir: outDir },
    );
    expect(r.ok).toBe(true);
  });

  it('rethrows closed/abort errors while waiting for composer', async () => {
    setScript({ composer: [new CdpClosedError('closed')] });
    let r = await generateImage({ prompt: 'p' }, { endpoint: 'e', outputDir: outDir });
    expect(r.ok).toBe(false);
    setScript({ composer: () => 'x' });
    mocks.evaluate.mockRejectedValueOnce('non-error');
    r = await generateImage({ prompt: 'p' }, { endpoint: 'e', outputDir: outDir });
    expect(r.ok).toBe(false);
    const abort = new Error('a');
    abort.name = 'AbortError';
    setScript({ composer: [abort] });
    r = await generateImage({ prompt: 'p' }, { endpoint: 'e', outputDir: outDir });
    expect(r.ok).toBe(false);
  });

  it('times out waiting for composer', async () => {
    setScript({ composer: [{ composer: false }] });
    vi.useFakeTimers({ toFake: ['Date'] });
    const r = await generateImage({ prompt: 'p' }, { endpoint: 'e', outputDir: outDir });
    expect(r).toMatchObject({ error: expect.stringContaining('入力欄') });
  });

  it('throws page error after composer deadline', async () => {
    setScript({ composer: [new Error('ctx')] });
    vi.useFakeTimers({ toFake: ['Date'] });
    const r = await generateImage({ prompt: 'p' }, { endpoint: 'e', outputDir: outDir });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('ctx') });
  });

  it('reports send failures', async () => {
    setScript({ send: 'no-input' });
    let r = await generateImage({ prompt: 'p' }, { endpoint: 'e', outputDir: outDir });
    expect(r).toMatchObject({ error: expect.stringContaining('入力欄に指示') });
    setScript({ send: 'weird' });
    r = await generateImage({ prompt: 'p' }, { endpoint: 'e', outputDir: outDir });
    expect(r).toMatchObject({ error: expect.stringContaining('読み取れません') });
  });

  it('click: missing, never enabled, eventually enabled', async () => {
    setScript({ click: ['missing'] });
    let r = await generateImage({ prompt: 'p' }, { endpoint: 'e', outputDir: outDir });
    expect(r).toMatchObject({ error: expect.stringContaining('見つかりません') });

    setScript({ click: ['disabled'] });
    vi.useFakeTimers({ toFake: ['Date'] });
    r = await generateImage({ prompt: 'p' }, { endpoint: 'e', outputDir: outDir });
    expect(r).toMatchObject({ error: expect.stringContaining('有効になりません') });
    vi.useRealTimers();

    setScript({ click: ['disabled', 'clicked'], answer: [done()] });
    r = await generateImage({ prompt: 'p' }, { endpoint: 'e', outputDir: outDir });
    expect(r.ok).toBe(true);
  });

  it('waits for stable completion, resets on change and non-complete', async () => {
    setScript({
      answer: [
        { path: '/', turns: 0, state: null, images: 'x', text: 5 },
        done([BLOB, 5 as unknown as string]),
        done([BLOB, 'blob:https://chatgpt.com/other']),
        done([BLOB]),
        done([BLOB]),
        done([BLOB]),
      ],
    });
    const r = await generateImage({ prompt: 'p' }, { endpoint: 'e', outputDir: outDir });
    expect(r.ok).toBe(true);
    // 途中の変化と未完了で数え直したため、6回の状態取得をすべて使い切って完了した
    const answerPolls = mocks.evaluate.mock.calls.filter(([, , expr]) =>
      String(expr).includes('location.pathname'),
    );
    expect(answerPolls).toHaveLength(6);
  });

  it('times out waiting for answer, with and without path', async () => {
    for (const path of ['', '/c/abc']) {
      setScript({ answer: [{ path, turns: 0, state: 'running', images: [] }] });
      vi.useFakeTimers({ toFake: ['Date'] });
      const r = await generateImage({ prompt: 'p' }, { endpoint: 'e', outputDir: outDir });
      expect(r).toMatchObject({ error: expect.stringContaining('分以内') });
      if (path !== '') expect((r as { error: string }).error).toContain(path);
      vi.useRealTimers();
    }
  });

  it('reports when answer is in a different conversation', async () => {
    setScript({ answer: [done([BLOB], { path: '/c/other' })] });
    const r = await generateImage(
      { prompt: 'p', conversationUrl: URL1 },
      { endpoint: 'e', outputDir: outDir },
    );
    expect(r).toMatchObject({
      ok: false,
      conversationUrl: 'https://chatgpt.com/c/other',
      error: expect.stringContaining('別の会話'),
    });
  });

  it('reports no images, with and without text', async () => {
    setScript({ answer: [done([], { text: 'sorry' })] });
    let r = await generateImage({ prompt: 'p' }, { endpoint: 'e', outputDir: outDir });
    expect(r).toMatchObject({
      ok: false,
      conversationUrl: URL1,
      error: expect.stringContaining('sorry'),
    });
    setScript({ answer: [done([], { text: '' })] });
    r = await generateImage({ prompt: 'p' }, { endpoint: 'e', outputDir: outDir });
    expect(r).toMatchObject({ ok: false, conversationUrl: URL1 });
  });

  it('rejects disallowed image sources', async () => {
    for (const src of [
      'https://evil.example/a.png',
      'blob:https://evil.example/x',
      'not a url',
      'http://chatgpt.com/a',
    ]) {
      setScript({ answer: [done([src])] });
      const r = await generateImage({ prompt: 'p' }, { endpoint: 'e', outputDir: outDir });
      expect(r).toMatchObject({ ok: false, error: expect.stringContaining('取得元') });
    }
  });

  it('handles bad fetch results', async () => {
    const cases: [unknown, string][] = [
      ['size', '大きさ'],
      [[], '読み出せません'],
      ['nope', '読み出せません'],
      [['data:text/plain;base64,AAAA'], '形式'],
      [[5], '形式'],
      [['data:image/png;base64,===='], '大きさ'],
    ];
    for (const [fetch, msg] of cases) {
      setScript({ answer: [done()], fetch });
      const r = await generateImage({ prompt: 'p' }, { endpoint: 'e', outputDir: outDir });
      expect(r).toMatchObject({ ok: false, error: expect.stringContaining(msg) });
    }
  });

  it('includes conversation url in post-send failure and aborts', async () => {
    const ac = new AbortController();
    setScript({ answer: [done()] });
    ac.abort();
    const r = await generateImage(
      { prompt: 'p' },
      { endpoint: 'e', outputDir: outDir, signal: ac.signal },
    );
    expect(r.ok).toBe(false);

    // failure after send with an existing conversation url appends it
    setScript({ answer: [new Error('boom')] });
    const r2 = await generateImage(
      { prompt: 'p', conversationUrl: URL1 },
      { endpoint: 'e', outputDir: outDir },
    );
    expect(r2).toMatchObject({
      ok: false,
      conversationUrl: URL1,
      error: expect.stringContaining('boom'),
    });
    // and without it
    setScript({ answer: [new Error('boom')] });
    const r4 = await generateImage({ prompt: 'p' }, { endpoint: 'e', outputDir: outDir });
    expect(r4.ok).toBe(false);
    expect('conversationUrl' in r4).toBe(false);
  });

  it('ignores prune failures', async () => {
    mocks.readdirFail = true;
    setScript({ answer: [done()] });
    const r = await generateImage({ prompt: 'p' }, { endpoint: 'e', outputDir: outDir });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.paths).toHaveLength(1);
    await expect(pruneOldImages(outDir)).rejects.toThrow('EACCES');
  });
});

describe('pruneOldImages', () => {
  it('returns 0 for missing dir and rethrows other errors', async () => {
    expect(await pruneOldImages(join(outDir, 'none'))).toBe(0);
    const file = join(outDir, 'f');
    await writeFile(file, 'x');
    await expect(pruneOldImages(file)).rejects.toThrow();
  });

  it('removes only old saved-name files', async () => {
    const old = join(outDir, '20200101-000000-000-1.png');
    const fresh = join(outDir, '20991231-000000-000-1.png');
    const other = join(outDir, 'keep.png');
    const dir = join(outDir, '20200101-000000-000-2.png');
    await writeFile(old, 'x');
    await writeFile(fresh, 'x');
    await writeFile(other, 'x');
    await mkdir(dir);
    const past = new Date(Date.now() - IMAGE_RETENTION_MS - 60_000);
    await utimes(old, past, past);
    await utimes(other, past, past);
    await utimes(dir, past, past);
    expect(await pruneOldImages(outDir)).toBe(1);
    expect((await readdir(outDir)).sort()).toEqual(
      ['20200101-000000-000-2.png', '20991231-000000-000-1.png', 'keep.png'].sort(),
    );
  });
});
