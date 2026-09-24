import { describe, expect, it } from 'vitest';
import type { ChatItem } from '../../src/appserver/chatState';
import type { HeadlessCliDeps, HeadlessOutcome } from '../../src/loop/headlessCli';
import type { MementoLike } from '../../src/util/memento';
import {
  buildAutoSessionName,
  hasWorkReference,
  ManuallyNamedSessionStore,
  MANUALLY_NAMED_SESSIONS_KEY,
  parseAutoNameResponse,
  SerialRerun,
  shouldAutoName,
  SLUG_MAX,
  splitTurns,
  summarizeSessionName,
  truncateSlug,
} from '../../src/view/sessionAutoName';

const user = (text: string): ChatItem => ({ kind: 'userMessage', text }) as unknown as ChatItem;
const agent = (text: string): ChatItem => ({ kind: 'agentMessage', text }) as unknown as ChatItem;
const other = (): ChatItem => ({ kind: 'commandExecution' }) as unknown as ChatItem;

function fakeMemento(): MementoLike & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: <T>(key: string, defaultValue: T): T =>
      data.has(key) ? (data.get(key) as T) : defaultValue,
    update: (key: string, value: unknown): Promise<void> => {
      data.set(key, value);
      return Promise.resolve();
    },
  };
}

describe('splitTurns', () => {
  it('ユーザー発言で区切り、応答は改行でつなぐ', () => {
    expect(
      splitTurns([user('一'), agent('a'), other(), agent('b'), user('二'), agent('c')]),
    ).toEqual([
      { user: '一', assistant: 'a\nb' },
      { user: '二', assistant: 'c' },
    ]);
  });

  it('最初のユーザー発言より前の応答と空の発言は無視する', () => {
    expect(splitTurns([agent('前置き'), user('  '), user('本題'), agent('  ')])).toEqual([
      { user: '本題', assistant: '' },
    ]);
  });
});

describe('hasWorkReference', () => {
  it.each(['Issue #12', 'issueを見て', 'MR!3', 'mr102', 'PRを作る', 'pr#5', 'GitLabのMR'])(
    '%s は契機になる',
    (text) => {
      expect(hasWorkReference(text)).toBe(true);
    },
  );

  it.each(['PRDを書く', 'promptを直す', 'issues', 'Mrs', 'express'])(
    '%s は契機にならない',
    (text) => {
      expect(hasWorkReference(text)).toBe(false);
    },
  );
});

describe('shouldAutoName', () => {
  it('会話が無ければ付け直さない', () => {
    expect(shouldAutoName([])).toBe(false);
  });

  it('最初のターンは語が無くても付け直す', () => {
    expect(shouldAutoName([user('こんにちは'), agent('はい')])).toBe(true);
  });

  it('2ターン目以降は最新ターンに語があるときだけ付け直す', () => {
    const base = [user('Issue #1 を見て'), agent('はい')];
    expect(shouldAutoName([...base, user('続けて'), agent('了解')])).toBe(false);
    expect(shouldAutoName([...base, user('続けて'), agent('PRを作りました')])).toBe(true);
    expect(shouldAutoName([...base, user('MRを見て'), agent('了解')])).toBe(true);
  });
});

describe('parseAutoNameResponse', () => {
  const source = 'Issue #1426 と MR !88、PR #7 の話。123件';

  it('材料に出ている番号だけを残す', () => {
    expect(
      parseAutoNameResponse(
        '{"issue": 1426, "mr": "88", "pr": 7, "slug": "タブ名の自動付け直し"}',
        source,
      ),
    ).toEqual({ issue: 1426, mr: 88, pr: 7, slug: 'タブ名の自動付け直し' });
  });

  it('材料に無い番号は捨てる', () => {
    expect(
      parseAutoNameResponse('{"issue": 999, "mr": null, "pr": null, "slug": "x"}', source),
    ).toMatchObject({ issue: undefined, mr: undefined, pr: undefined });
  });

  it('別の数字の一部としてしか出ていない番号は捨てる', () => {
    expect(parseAutoNameResponse('{"issue": 12, "slug": "x"}', source)?.issue).toBeUndefined();
    expect(parseAutoNameResponse('{"issue": 23, "slug": "x"}', source)?.issue).toBeUndefined();
    expect(parseAutoNameResponse('{"issue": 123, "slug": "x"}', source)?.issue).toBe(123);
  });

  it('正の整数でない番号は捨てる', () => {
    expect(
      parseAutoNameResponse('{"issue": 0, "mr": -88, "pr": 7.5, "slug": "x"}', 'x 0 88 7.5'),
    ).toMatchObject({ issue: undefined, mr: undefined, pr: undefined });
  });

  it('前後に余計な文字やコードブロックがあっても読む', () => {
    expect(
      parseAutoNameResponse('```json\n{"issue": 1426, "slug": "名前"}\n```', source),
    ).toMatchObject({ issue: 1426, slug: '名前' });
  });

  it('JSONとして読めなければundefined', () => {
    expect(parseAutoNameResponse('名前は分かりません', source)).toBeUndefined();
    expect(parseAutoNameResponse('{issue: 1}', source)).toBeUndefined();
    expect(parseAutoNameResponse('[1, 2]', source)).toBeUndefined();
  });

  it('slugが文字列でなければ空にする', () => {
    expect(parseAutoNameResponse('{"issue": 1426, "slug": 3}', source)?.slug).toBe('');
  });
});

describe('truncateSlug', () => {
  it('改行と連続空白を1つに畳む', () => {
    expect(truncateSlug('  タブ名\n  の  付け直し ')).toBe('タブ名 の 付け直し');
  });

  it(`${SLUG_MAX}コードポイントで切る（サロゲートペアを割らない）`, () => {
    const long = '𩸽'.repeat(SLUG_MAX + 5);
    const cut = truncateSlug(long);
    expect([...cut]).toHaveLength(SLUG_MAX);
    expect(cut).toBe('𩸽'.repeat(SLUG_MAX));
    expect(truncateSlug('あ'.repeat(SLUG_MAX))).toBe('あ'.repeat(SLUG_MAX));
  });
});

describe('buildAutoSessionName', () => {
  it('Issue・MR・PR・slugの順に並べる', () => {
    expect(
      buildAutoSessionName({ issue: 1426, mr: 88, pr: 7, slug: 'タブ名の付け直し' }, undefined),
    ).toBe('#1426 !88 PR#7 タブ名の付け直し');
  });

  it('取れた要素だけを並べる', () => {
    expect(
      buildAutoSessionName({ issue: undefined, mr: undefined, pr: 7, slug: 'x' }, undefined),
    ).toBe('PR#7 x');
    expect(
      buildAutoSessionName({ issue: 3, mr: undefined, pr: undefined, slug: '' }, undefined),
    ).toBe('#3');
  });

  it('今の名前の世代の印を残す', () => {
    expect(
      buildAutoSessionName({ issue: 1, mr: undefined, pr: undefined, slug: 'x' }, '旧名 (続き3)'),
    ).toBe('#1 x (続き3)');
  });

  it('何も無ければundefined', () => {
    expect(
      buildAutoSessionName({ issue: undefined, mr: undefined, pr: undefined, slug: '' }, '旧名'),
    ).toBeUndefined();
  });
});

describe('summarizeSessionName', () => {
  function fakeRun(outcome: HeadlessOutcome) {
    const calls: { deps: HeadlessCliDeps; prompt: string }[] = [];
    const run = (deps: HeadlessCliDeps, prompt: string): Promise<HeadlessOutcome> => {
      calls.push({ deps, prompt });
      return Promise.resolve(outcome);
    };
    return { calls, run };
  }

  const items = [user('Issue #1426 を実装して'), agent('はい、始めます')];

  it('成功すれば名前を返し、判定用のモデルでCLIを呼ぶ', async () => {
    const { calls, run } = fakeRun({
      ok: true,
      text: '{"issue": 1426, "mr": null, "pr": null, "slug": "タブ名の自動付け直し"}',
    } as HeadlessOutcome);
    const name = await summarizeSessionName(
      { provider: 'claude', executable: 'claude', run },
      { items, currentName: '旧名 (続き2)', gitBranch: 'feat/1426/session-auto-name' },
    );
    expect(name).toBe('#1426 タブ名の自動付け直し (続き2)');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.deps.provider).toBe('claude');
    expect(calls[0]?.prompt).toContain('Issue #1426 を実装して');
    expect(calls[0]?.prompt).toContain('feat/1426/session-auto-name');
  });

  it('世代の印の数字は番号として使わせない', async () => {
    const { run } = fakeRun({
      ok: true,
      text: '{"issue": 21, "slug": "名前"}',
    } as HeadlessOutcome);
    const name = await summarizeSessionName(
      { provider: 'codex', executable: 'codex', run },
      {
        items: [user('作業して'), agent('はい')],
        currentName: '旧名 (続き21)',
        gitBranch: undefined,
      },
    );
    expect(name).toBe('名前 (続き21)');
  });

  it('時間切れならundefinedでログを出す', async () => {
    const warns: string[] = [];
    const { run } = fakeRun({ ok: false, reason: 'timeout' } as HeadlessOutcome);
    const name = await summarizeSessionName(
      { provider: 'claude', executable: 'claude', run, logWarn: (m) => warns.push(m) },
      { items, currentName: undefined, gitBranch: undefined },
    );
    expect(name).toBeUndefined();
    expect(warns.join('\n')).toContain('時間切れ');
  });

  it('JSONが不正ならundefinedでログを出す', async () => {
    const warns: string[] = [];
    const { run } = fakeRun({ ok: true, text: '分かりません' } as HeadlessOutcome);
    const name = await summarizeSessionName(
      { provider: 'claude', executable: 'claude', run, logWarn: (m) => warns.push(m) },
      { items, currentName: undefined, gitBranch: undefined },
    );
    expect(name).toBeUndefined();
    expect(warns.join('\n')).toContain('JSON');
  });

  it('実行が例外を投げてもundefinedを返す', async () => {
    const warns: string[] = [];
    const name = await summarizeSessionName(
      {
        provider: 'claude',
        executable: 'claude',
        run: () => Promise.reject(new Error('boom')),
        logWarn: (m) => warns.push(m),
      },
      { items, currentName: undefined, gitBranch: undefined },
    );
    expect(name).toBeUndefined();
    expect(warns.join('\n')).toContain('boom');
  });

  it('会話が無ければCLIを呼ばない', async () => {
    const { calls, run } = fakeRun({ ok: true, text: '{}' } as HeadlessOutcome);
    const name = await summarizeSessionName(
      { provider: 'claude', executable: 'claude', run },
      { items: [], currentName: undefined, gitBranch: undefined },
    );
    expect(name).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

describe('SerialRerun', () => {
  it('実行中の契機は終了後に1回だけ走らせ直す', async () => {
    const releases: (() => void)[] = [];
    let runs = 0;
    const serial = new SerialRerun(() => {
      runs += 1;
      return new Promise<void>((resolve) => releases.push(resolve));
    });
    serial.request();
    serial.request();
    serial.request();
    expect(runs).toBe(1);
    releases[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runs).toBe(2);
    releases[1]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runs).toBe(2);
    serial.request();
    expect(runs).toBe(3);
    releases[2]?.();
  });

  it('jobが失敗しても次の契機で走る', async () => {
    let runs = 0;
    const serial = new SerialRerun(() => {
      runs += 1;
      return Promise.reject(new Error('失敗'));
    });
    serial.request();
    await new Promise((resolve) => setTimeout(resolve, 0));
    serial.request();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runs).toBe(2);
  });
});

describe('ManuallyNamedSessionStore', () => {
  it('印を保存先に持ち、作り直しても残る', async () => {
    const memento = fakeMemento();
    const store = new ManuallyNamedSessionStore(memento);
    expect(store.has('claude:a')).toBe(false);
    await store.add('claude:a');
    await store.add('claude:a');
    expect(memento.data.get(MANUALLY_NAMED_SESSIONS_KEY)).toEqual(['claude:a']);
    const reloaded = new ManuallyNamedSessionStore(memento);
    expect(reloaded.has('claude:a')).toBe(true);
    expect(reloaded.has('codex:a')).toBe(false);
  });
});
