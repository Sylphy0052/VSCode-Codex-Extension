import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../../src/codex/types';
import '../mocks/vscode';
import {
  SESSION_DECORATIONS,
  SESSION_URI_SCHEME,
  SessionDecorationProvider,
  decorationStateOf,
  parseSessionUri,
  sessionUri,
  type SessionDecorationSource,
  type SessionDecorationState,
} from '../../src/view/sessionDecorations';

function session(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    provider: 'codex',
    id: 'abc',
    threadName: 'テスト',
    updatedAt: 0,
    cwd: '/tmp',
    ...over,
  } as SessionSummary;
}

describe('sessionUri / parseSessionUri', () => {
  it('往復して同じprovider・idに戻る', () => {
    const uri = sessionUri({ provider: 'claude', id: 'x-1' });
    expect(uri.scheme).toBe(SESSION_URI_SCHEME);
    expect(parseSessionUri(uri)).toEqual({ provider: 'claude', id: 'x-1' });
  });

  it('idにスラッシュが入っても壊れない', () => {
    const uri = sessionUri({ provider: 'codex', id: 'a/b' });
    expect(parseSessionUri(uri)).toEqual({ provider: 'codex', id: 'a/b' });
  });

  it('実ファイルは指さない（他のUIへ装飾が波及しないため）', () => {
    // 実パス（rolloutのjsonl）を指すと、同じファイルを開いているエクスプローラ等にも
    // バッジが出る。スキームで隔離していることを固定する
    expect(sessionUri({ provider: 'codex', id: 'abc' }).scheme).not.toBe('file');
  });

  it('別スキーム・形の違うURIはundefinedを返す', () => {
    expect(parseSessionUri({ scheme: 'file', path: '/codex/abc' })).toBeUndefined();
    expect(parseSessionUri({ scheme: SESSION_URI_SCHEME, path: '/codex' })).toBeUndefined();
    expect(parseSessionUri({ scheme: SESSION_URI_SCHEME, path: '/codex/' })).toBeUndefined();
    expect(parseSessionUri({ scheme: SESSION_URI_SCHEME, path: '//abc' })).toBeUndefined();
  });
});

describe('decorationStateOf', () => {
  it('承認待ち・実行中はアーカイブ済みより優先する', () => {
    // アーカイブ済みのセッションを開き直して動かしている最中に「アーカイブ済み」だけが
    // 出ると、動いていることが読めなくなる
    expect(decorationStateOf(session({ archived: true }), 'approvalPending')).toBe(
      'approvalPending',
    );
    expect(decorationStateOf(session({ archived: true }), 'running')).toBe('running');
  });

  it('承認待ち・実行中でなければアーカイブ済みだけを見る', () => {
    expect(decorationStateOf(session({ archived: true }), 'idle')).toBe('archived');
    expect(decorationStateOf(session({ archived: true }), undefined)).toBe('archived');
  });

  it('通常のセッションには何も出さない', () => {
    // 一覧のほとんどはこれ。ここにバッジを付けると「付いていること」が合図でなくなる
    expect(decorationStateOf(session(), undefined)).toBeUndefined();
    expect(decorationStateOf(session(), 'idle')).toBeUndefined();
  });
});

describe('SESSION_DECORATIONS', () => {
  it('バッジはVS Codeの上限（2文字）に収まる', () => {
    for (const [state, spec] of Object.entries(SESSION_DECORATIONS)) {
      if (spec.badge === undefined) continue;
      expect([...spec.badge].length, `${state} のバッジが長い`).toBeLessThanOrEqual(2);
    }
  });

  it('すべての状態に色と説明がある', () => {
    // 母数は型ではなくオブジェクトのキー。状態を足したときに、ここだけ書き忘れることを防ぐ
    const states = Object.keys(SESSION_DECORATIONS);
    expect(states.length).toBeGreaterThan(0);
    for (const state of states) {
      const spec = SESSION_DECORATIONS[state as SessionDecorationState];
      expect(spec.color, `${state} に色が無い`).toBeTruthy();
      expect(spec.tooltip, `${state} に説明が無い`).toBeTruthy();
    }
  });

  it('アーカイブ済みにはバッジを付けない（色だけ落とす）', () => {
    // 承認待ち・実行中と違い「今すぐ見るべき」合図ではない
    expect(SESSION_DECORATIONS.archived.badge).toBeUndefined();
    expect(SESSION_DECORATIONS.approvalPending.badge).toBeTruthy();
    expect(SESSION_DECORATIONS.running.badge).toBeTruthy();
  });
});

/** `SessionDecorationSource` の最小フェイク。ツリーの更新イベントを手で発火できる。 */
function fakeSource(state: SessionDecorationState | undefined): {
  source: SessionDecorationSource;
  fireTreeChange: () => void;
  setState: (next: SessionDecorationState | undefined) => void;
  askedFor: string[];
} {
  const listeners: Array<() => void> = [];
  const askedFor: string[] = [];
  let current = state;
  return {
    source: {
      onDidChangeTreeData: ((listener: () => void) => {
        listeners.push(listener);
        return { dispose: () => undefined };
      }) as SessionDecorationSource['onDidChangeTreeData'],
      decorationStateFor: (uri) => {
        askedFor.push(uri.path);
        return current;
      },
    },
    fireTreeChange: () => {
      for (const l of listeners) l();
    },
    setState: (next) => {
      current = next;
    },
    askedFor,
  };
}

describe('SessionDecorationProvider', () => {
  it('状態があればバッジ・色・説明を返す', () => {
    const { source } = fakeSource('approvalPending');
    const provider = new SessionDecorationProvider(source);

    const decoration = provider.provideFileDecoration(sessionUri({ provider: 'codex', id: 'a' }));

    expect(decoration?.badge).toBe(SESSION_DECORATIONS.approvalPending.badge);
    expect(decoration?.color?.id).toBe(SESSION_DECORATIONS.approvalPending.color);
    expect(decoration?.tooltip).toBe(SESSION_DECORATIONS.approvalPending.tooltip);
  });

  it('状態が無ければ何も返さない', () => {
    const { source } = fakeSource(undefined);
    const provider = new SessionDecorationProvider(source);
    expect(
      provider.provideFileDecoration(sessionUri({ provider: 'codex', id: 'a' })),
    ).toBeUndefined();
  });

  it('毎回ツリーへ引き直す（古いバッジを残さない）', () => {
    const { source, setState } = fakeSource('running');
    const provider = new SessionDecorationProvider(source);
    const uri = sessionUri({ provider: 'codex', id: 'a' });

    expect(provider.provideFileDecoration(uri)?.badge).toBe(SESSION_DECORATIONS.running.badge);
    setState(undefined);
    expect(provider.provideFileDecoration(uri)).toBeUndefined();
  });

  it('ツリーが更新されたら装飾の引き直しを促す', () => {
    const { source, fireTreeChange } = fakeSource('running');
    const provider = new SessionDecorationProvider(source);
    const fired: Array<unknown> = [];
    provider.onDidChangeFileDecorations((e) => fired.push(e));

    fireTreeChange();

    // どの行が変わったかはツリー側も持っていないため、URIを絞らず全体を無効化する
    expect(fired).toEqual([undefined]);
  });

  it('disposeするとツリーの購読を外す', () => {
    const { source, fireTreeChange } = fakeSource('running');
    const provider = new SessionDecorationProvider(source);
    const fired: Array<unknown> = [];
    provider.onDidChangeFileDecorations((e) => fired.push(e));

    provider.dispose();
    fireTreeChange();

    expect(fired).toEqual([]);
  });
});
