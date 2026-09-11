import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialChatState, type ChatItem, type ChatState } from '../../src/appserver/chatState';
import {
  buildHandoffPointerMarkdown,
  buildHandoffPrompt,
  countCompactions,
  decideAutoHandoff,
  handoffPointerFileName,
  passesSafeBoundaryGate,
  safeBoundaryProbeKey,
  recentUserMessages,
  shellQuote,
  waitForFirstTurn,
  writeHandoffPointer,
  type HandoffPointerInput,
} from '../../src/view/handoff';

function baseInput(overrides: Partial<HandoffPointerInput> = {}): HandoffPointerInput {
  return {
    provider: 'claude',
    sessionId: 'session-1',
    transcriptPath: '/home/user/.claude/projects/repo/session-1.jsonl',
    cwd: '/repo',
    gitBranch: 'feat/1079/auto-handoff-pointer',
    model: 'claude-opus-5',
    trigger: { kind: 'manual' },
    turnFailed: false,
    busy: false,
    recentUserMessages: [],
    turnEditedFiles: [],
    createdAt: new Date('2026-09-11T05:06:07.089Z'),
    ...overrides,
  };
}

function item(kind: string, text = ''): ChatItem {
  return {
    id: `${kind}-${text}-${Math.random()}`,
    kind,
    text,
    detail: '',
    status: undefined,
    turnId: undefined,
    diffs: [],
    searchResults: [],
  };
}

describe('ポインタファイルの本文', () => {
  it('transcriptの在処・作業ディレクトリ・ブランチ・モデル・契機を載せる', () => {
    const md = buildHandoffPointerMarkdown(
      baseInput({ trigger: { kind: 'threshold', remainingPercent: 12 } }),
    );

    expect(md).toContain('/home/user/.claude/projects/repo/session-1.jsonl');
    expect(md).toContain('作業ディレクトリ: /repo');
    expect(md).toContain('gitブランチ: feat/1079/auto-handoff-pointer');
    expect(md).toContain('モデル: claude-opus-5');
    expect(md).toContain('残り12%');
  });

  it('契機ごとに表記が変わる', () => {
    expect(buildHandoffPointerMarkdown(baseInput())).toContain('引き継いだ契機: 手動操作');
    expect(
      buildHandoffPointerMarkdown(baseInput({ trigger: { kind: 'compactBoundary' } })),
    ).toContain('引き継いだ契機: 自動圧縮の直後');
    expect(
      buildHandoffPointerMarkdown(
        baseInput({
          trigger: {
            kind: 'softThreshold',
            remainingPercent: 38,
            switchReason: 'PRがマージされた',
          },
        }),
      ),
    ).toContain(
      '引き継いだ契機: コンテキスト残量が緩い閾値を下回り、安全な区切りが来た（残り38%。PRがマージされた）',
    );
    expect(
      buildHandoffPointerMarkdown(
        baseInput({
          trigger: {
            kind: 'profileChanged',
            model: 'opus',
            effort: 'medium',
            switchReason: '設計が終わり次は実装',
          },
        }),
      ),
    ).toContain(
      '引き継いだ契機: 安全な区切りで、次の作業に合うmodel/effortが変わった（opus / medium。設計が終わり次は実装）',
    );
  });

  it('全文読み込みの禁止と、読む順序を書く', () => {
    const md = buildHandoffPointerMarkdown(baseInput());
    expect(md).toContain('全文読み込みしない');
    expect(md).toContain('自動圧縮の要約が出たら');
  });

  it('編集ファイルが空でも「編集していない」と読ませない', () => {
    const md = buildHandoffPointerMarkdown(baseInput({ turnEditedFiles: [] }));
    expect(md).toContain('これは「編集していない」ではない');
  });

  it('直近のユーザー指示は1行へ畳んで載せる', () => {
    const md = buildHandoffPointerMarkdown(
      baseInput({ recentUserMessages: ['前半\n\n後半も同じ行にする'] }),
    );
    expect(md).toContain('- 前半 後半も同じ行にする');
  });

  it('provider別に抽出コマンドを埋め込む', () => {
    const claude = buildHandoffPointerMarkdown(baseInput());
    expect(claude).toContain('isCompactSummary');
    expect(claude).toContain('file-history-snapshot');
    expect(claude).not.toContain('response_item');

    const codex = buildHandoffPointerMarkdown(
      baseInput({ provider: 'codex', transcriptPath: '/home/user/.codex/rollout-x.jsonl' }),
    );
    expect(codex).toContain('response_item');
    expect(codex).toContain('compacted');
    // Codexのツール呼び出しからは編集ファイルを確実に取れないため式を載せない
    expect(codex).not.toContain('file-history-snapshot');
  });

  it('埋め込むコマンドは読み過ぎないよう件数と文字数で切ってある', () => {
    const md = buildHandoffPointerMarkdown(baseInput());
    expect(md).toContain('tail -20');
    expect(md).toContain('[0:300]');
  });

  it('transcriptのパスは引用符で包んで埋め込む', () => {
    const md = buildHandoffPointerMarkdown(baseInput({ transcriptPath: "/tmp/a b/it's.jsonl" }));
    expect(md).toContain(`'/tmp/a b/it'\\''s.jsonl'`);
  });

  it('直前のターンが失敗していたらそう書く', () => {
    expect(buildHandoffPointerMarkdown(baseInput({ turnFailed: true }))).toContain(
      '失敗して終わっている',
    );
    expect(buildHandoffPointerMarkdown(baseInput({ turnFailed: false }))).toContain(
      '直前のターンは失敗していない',
    );
  });

  it('作業ディレクトリとブランチが不明でも組み立てられる', () => {
    const md = buildHandoffPointerMarkdown(baseInput({ cwd: undefined, gitBranch: undefined }));
    expect(md).toContain('作業ディレクトリ: 不明');
    expect(md).toContain('gitブランチ: 不明');
  });
});

describe('shellQuote', () => {
  it('単一引用符を閉じ直す', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it('空白をそのまま包む', () => {
    expect(shellQuote('/a b/c')).toBe(`'/a b/c'`);
  });
});

describe('ポインタファイルの書き出し', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'handoff-pointer-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('globalStorage配下のhandoff/へ書き、本文と一致する', async () => {
    const input = baseInput();
    const path = await writeHandoffPointer(dir, input);

    expect(path.startsWith(join(dir, 'handoff'))).toBe(true);
    expect(await readFile(path, 'utf8')).toBe(buildHandoffPointerMarkdown(input));
  });

  it('同じセッションを2回引き継いでもファイル名が衝突しない', () => {
    const a = handoffPointerFileName('s1', new Date('2026-09-11T05:06:07.089Z'));
    const b = handoffPointerFileName('s1', new Date('2026-09-11T05:06:08.089Z'));
    expect(a).not.toBe(b);
    expect(a.endsWith('.md')).toBe(true);
  });

  it('セッションIDにパス区切りが混ざっても別ディレクトリへ書かない', () => {
    expect(handoffPointerFileName('../../etc/passwd', new Date())).not.toContain('/');
  });
});

describe('新セッションへ送る初回プロンプト', () => {
  it('ポインタファイルのパスを指し、全文読み込みを止める', () => {
    const prompt = buildHandoffPrompt('/storage/handoff/s1.md');
    expect(prompt).toContain('/storage/handoff/s1.md');
    expect(prompt).toContain('全文読み込まないこと');
    // 短く保つ（読ませる手順はポインタファイル側にある）
    expect(prompt.length).toBeLessThan(120);
  });
});

describe('自動引き継ぎの発火判定', () => {
  const base = {
    enabled: true,
    busy: false,
    alreadyStarted: false,
    remainingPercent: 50 as number | undefined,
    compacted: false,
    thresholdPercent: 20,
  };

  it('トグルがOFFなら、残量が閾値を下回っていても発火しない', () => {
    expect(decideAutoHandoff({ ...base, enabled: false, remainingPercent: 5 })).toBeUndefined();
  });

  it('ターン実行中は発火しない（安全な区切りまで待つ）', () => {
    expect(decideAutoHandoff({ ...base, busy: true, remainingPercent: 5 })).toBeUndefined();
  });

  it('既に引き継ぎ済みなら、もう一度は発火しない', () => {
    expect(
      decideAutoHandoff({ ...base, alreadyStarted: true, remainingPercent: 5 }),
    ).toBeUndefined();
  });

  it('残量が閾値以下なら閾値契機', () => {
    expect(decideAutoHandoff({ ...base, remainingPercent: 20 })).toEqual({
      kind: 'threshold',
      remainingPercent: 20,
    });
  });

  it('残量が閾値より多ければ発火しない', () => {
    expect(decideAutoHandoff({ ...base, remainingPercent: 21 })).toBeUndefined();
  });

  it('残量が判らなくても、圧縮が走れば発火する', () => {
    expect(decideAutoHandoff({ ...base, remainingPercent: undefined, compacted: true })).toEqual({
      kind: 'compactBoundary',
    });
  });

  it('残量が判らず圧縮も無ければ発火しない', () => {
    expect(
      decideAutoHandoff({ ...base, remainingPercent: undefined, compacted: false }),
    ).toBeUndefined();
  });

  it('圧縮しても残量が足りないときは閾値契機を名乗る（二重には発火しない）', () => {
    expect(decideAutoHandoff({ ...base, remainingPercent: 5, compacted: true })).toEqual({
      kind: 'threshold',
      remainingPercent: 5,
    });
  });

  it('安全な区切りが成立していなければ、緩い閾値以下でも発火しない（Issue #1090）', () => {
    expect(
      decideAutoHandoff({
        ...base,
        remainingPercent: 35,
        softThresholdPercent: 40,
        safeBoundary: false,
        profileChanged: true,
      }),
    ).toBeUndefined();
  });

  it('安全な区切りで残量が緩い閾値以下なら softThreshold 契機（Issue #1090）', () => {
    expect(
      decideAutoHandoff({
        ...base,
        remainingPercent: 40,
        softThresholdPercent: 40,
        safeBoundary: true,
        switchReason: 'PRがマージされた',
      }),
    ).toEqual({ kind: 'softThreshold', remainingPercent: 40, switchReason: 'PRがマージされた' });
  });

  it('残量が十分でも、model/effortが変わるなら profileChanged 契機（Issue #1090）', () => {
    expect(
      decideAutoHandoff({
        ...base,
        remainingPercent: 90,
        softThresholdPercent: 40,
        safeBoundary: true,
        profileChanged: true,
        profile: { model: 'opus', effort: 'medium' },
        switchReason: '設計が終わり次は実装',
      }),
    ).toEqual({
      kind: 'profileChanged',
      model: 'opus',
      effort: 'medium',
      switchReason: '設計が終わり次は実装',
    });
  });

  it('安全な区切りでも、緩い閾値超えでプロファイルが同じなら発火しない（Issue #1090）', () => {
    expect(
      decideAutoHandoff({
        ...base,
        remainingPercent: 90,
        softThresholdPercent: 40,
        safeBoundary: true,
        profileChanged: false,
      }),
    ).toBeUndefined();
  });

  it('残量が厳しい閾値以下なら、安全な区切りを待たずに threshold が優先する（Issue #1090）', () => {
    expect(
      decideAutoHandoff({
        ...base,
        remainingPercent: 10,
        softThresholdPercent: 40,
        safeBoundary: true,
        profileChanged: true,
      }),
    ).toEqual({ kind: 'threshold', remainingPercent: 10 });
  });
});

describe('安全な区切りの前段（Issue #1090）', () => {
  const gate = {
    busy: false,
    turnFailed: false,
    pendingApprovals: 0,
    pendingPrompts: 0,
    queued: 0,
    loopRunning: false,
    taskManaged: false,
  };

  it('全部成立していれば通す', () => {
    expect(passesSafeBoundaryGate(gate)).toBe(true);
  });

  it.each([
    ['ターン実行中', { busy: true }],
    ['直前のターンが失敗', { turnFailed: true }],
    ['承認待ち', { pendingApprovals: 1 }],
    ['入力待ち', { pendingPrompts: 1 }],
    ['送信待ちの指示', { queued: 1 }],
    ['ループ実行中', { loopRunning: true }],
    ['タスク用セッション', { taskManaged: true }],
  ])('%s なら通さない', (_name, over) => {
    expect(passesSafeBoundaryGate({ ...gate, ...over })).toBe(false);
  });

  it('同じ指示の並びなら同じ鍵になる（分類器を繰り返し起動しない）', () => {
    expect(safeBoundaryProbeKey(['a', 'b'])).toBe(safeBoundaryProbeKey(['a', 'b']));
    expect(safeBoundaryProbeKey(['a', 'b'])).not.toBe(safeBoundaryProbeKey(['a', 'b', 'c']));
  });
});

describe('圧縮回数の数え方', () => {
  it('contextCompaction の件数を数える', () => {
    const state: ChatState = {
      ...initialChatState,
      items: [
        item('userMessage', 'a'),
        item('contextCompaction'),
        item('contextCompactionStarted'),
        item('contextCompaction'),
      ],
    };
    expect(countCompactions(state)).toBe(2);
  });
});

describe('直近のユーザー指示', () => {
  it('末尾から指定件数だけを会話順で返し、空文は落とす', () => {
    const state: ChatState = {
      ...initialChatState,
      items: [
        item('userMessage', '1件目'),
        item('assistantMessage', '応答'),
        item('userMessage', '   '),
        item('userMessage', '2件目'),
        item('userMessage', '3件目'),
      ],
    };
    expect(recentUserMessages(state, 2)).toEqual(['2件目', '3件目']);
  });
});

describe('新セッションの初回応答を待つ', () => {
  function watcher(initial: ChatState): {
    session: { getState: () => ChatState };
    stateListeners: Array<(state: ChatState) => void>;
    emit: (state: ChatState) => void;
  } {
    let current = initial;
    const stateListeners: Array<(state: ChatState) => void> = [];
    return {
      session: { getState: () => current },
      stateListeners,
      emit: (state) => {
        current = state;
        for (const listener of [...stateListeners]) {
          listener(state);
        }
      },
    };
  }

  it('ターンが成功して終われば true を返し、listenerを外す', async () => {
    const w = watcher({ ...initialChatState, turnCompletionSeq: 3 });
    const done = waitForFirstTurn(w);
    expect(w.stateListeners).toHaveLength(1);

    w.emit({ ...initialChatState, turnCompletionSeq: 4, turnFailed: false });

    expect(await done).toBe(true);
    expect(w.stateListeners).toHaveLength(0);
  });

  it('ターンが失敗して終われば false を返す（旧セッションを残す）', async () => {
    const w = watcher({ ...initialChatState, turnCompletionSeq: 0 });
    const done = waitForFirstTurn(w);

    w.emit({ ...initialChatState, turnCompletionSeq: 1, turnFailed: true });

    expect(await done).toBe(false);
  });

  it('時間切れなら false を返す', async () => {
    const w = watcher({ ...initialChatState, turnCompletionSeq: 0 });
    expect(await waitForFirstTurn(w, 1)).toBe(false);
    expect(w.stateListeners).toHaveLength(0);
  });

  it('ターンが終わる前の状態更新では決めない', async () => {
    const w = watcher({ ...initialChatState, turnCompletionSeq: 0 });
    const done = waitForFirstTurn(w, 50);

    // busyになっただけ（完了していない）
    w.emit({ ...initialChatState, turnCompletionSeq: 0, busy: true });
    expect(w.stateListeners).toHaveLength(1);

    expect(await done).toBe(false);
  });
});
