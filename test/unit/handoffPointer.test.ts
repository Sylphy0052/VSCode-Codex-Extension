import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialChatState, type ChatItem, type ChatState } from '../../src/appserver/chatState';
import {
  advanceCompactionCount,
  buildHandoffPointerMarkdown,
  buildHandoffPrompt,
  countCompactions,
  decideAutoHandoff,
  handoffPointerFileName,
  passesSafeBoundaryGate,
  safeBoundaryProbeKey,
  recentUserMessages,
  recentAssistantMessages,
  shellQuote,
  waitForFirstTurn,
  decideOldTabAfterHandoff,
  oldTabKeptMessage,
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
    expect(
      buildHandoffPointerMarkdown(
        baseInput({
          trigger: {
            kind: 'assistantSuggested',
            switchReason: '実装が一段落した',
            suggestReason: '応答が「実装は別セッション推奨」と述べている',
          },
        }),
      ),
    ).toContain(
      '引き継いだ契機: アシスタント自身が引き継ぎを提案した（応答が「実装は別セッション推奨」と述べている。実装が一段落した）',
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

describe('次にやること（申し送り。Issue #1097）', () => {
  it('nextSteps を渡すと節が現れ、ユーザー指示ではない旨を添える', () => {
    const md = buildHandoffPointerMarkdown(
      baseInput({ nextSteps: '#1098の実装へ進む。squash mergeは使わない。' }),
    );
    expect(md).toContain('## 次にやること（引き継ぎ元のアシスタントの申し送り）');
    expect(md).toContain('#1098の実装へ進む。squash mergeは使わない。');
    expect(md).toContain('**ユーザーの指示ではない**');
    // 新セッションが最初に読む位置（状態の直後・読み方の前）に置く
    expect(md.indexOf('## 引き継ぎ時点の状態')).toBeLessThan(
      md.indexOf('## 次にやること（引き継ぎ元のアシスタントの申し送り）'),
    );
    expect(md.indexOf('## 次にやること（引き継ぎ元のアシスタントの申し送り）')).toBeLessThan(
      md.indexOf('## 読み方（先に守ること）'),
    );
  });

  it('nextSteps が無い・空白だけなら節ごと出さない', () => {
    expect(buildHandoffPointerMarkdown(baseInput())).not.toContain('## 次にやること');
    expect(buildHandoffPointerMarkdown(baseInput({ nextSteps: '   \n ' }))).not.toContain(
      '## 次にやること',
    );
  });

  it('上限を超えたら切り詰め、続きの読み方を1行添える', () => {
    const long = 'あ'.repeat(5000);
    const md = buildHandoffPointerMarkdown(baseInput({ nextSteps: long }));
    expect(md).not.toContain(long);
    expect(md).toContain('あ'.repeat(4000));
    expect(md).toContain('ここで切り詰めてある');
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

  it('残量が十分でプロファイルが同じでも、アシスタントの提案があれば発火する（Issue #1097）', () => {
    expect(
      decideAutoHandoff({
        ...base,
        remainingPercent: 90,
        softThresholdPercent: 40,
        safeBoundary: true,
        profileChanged: false,
        handoffSuggested: true,
        handoffSuggestReason: '応答が「別セッションで実装を」と提案している',
        switchReason: '実装が一段落した',
      }),
    ).toEqual({
      kind: 'assistantSuggested',
      switchReason: '実装が一段落した',
      suggestReason: '応答が「別セッションで実装を」と提案している',
    });
  });

  it('switchSafe が false でも、提案があれば assistantSuggested が立つ（Issue #1097）', () => {
    expect(
      decideAutoHandoff({
        ...base,
        remainingPercent: 90,
        softThresholdPercent: 40,
        boundaryGatePassed: true,
        safeBoundary: false,
        handoffSuggested: true,
        handoffSuggestReason: '応答が引き継ぎを提案している',
        switchReason: 'MRは作成済みだが未マージ',
      }),
    ).toEqual({
      kind: 'assistantSuggested',
      switchReason: 'MRは作成済みだが未マージ',
      suggestReason: '応答が引き継ぎを提案している',
    });
  });

  it('switchSafe が false で提案も無ければ、softThreshold も profileChanged も立たない（Issue #1097）', () => {
    expect(
      decideAutoHandoff({
        ...base,
        remainingPercent: 30,
        softThresholdPercent: 40,
        boundaryGatePassed: true,
        safeBoundary: false,
        handoffSuggested: false,
        profileChanged: true,
        profile: { model: 'opus', effort: 'medium' },
      }),
    ).toBeUndefined();
  });

  it('提案が無ければ、同じ状況で発火しない（Issue #1097）', () => {
    expect(
      decideAutoHandoff({
        ...base,
        remainingPercent: 90,
        softThresholdPercent: 40,
        safeBoundary: true,
        profileChanged: false,
        handoffSuggested: false,
      }),
    ).toBeUndefined();
  });

  it('安全な区切りが成立していなければ、提案があっても発火しない（Issue #1097）', () => {
    // `loopRunning` / `taskManaged` は前段で落ちるため `safeBoundary` が立たない
    for (const over of [{ loopRunning: true }, { taskManaged: true }]) {
      const gate = {
        busy: false,
        turnFailed: false,
        pendingApprovals: 0,
        pendingPrompts: 0,
        queued: 0,
        loopRunning: false,
        taskManaged: false,
        ...over,
      };
      expect(passesSafeBoundaryGate(gate)).toBe(false);
      expect(
        decideAutoHandoff({
          ...base,
          remainingPercent: 90,
          softThresholdPercent: 40,
          safeBoundary: passesSafeBoundaryGate(gate),
          handoffSuggested: true,
          handoffSuggestReason: '応答が引き継ぎを提案している',
        }),
      ).toBeUndefined();
    }
  });

  it('残量が緩い閾値以下なら、提案より softThreshold が先に成立する（Issue #1097）', () => {
    expect(
      decideAutoHandoff({
        ...base,
        remainingPercent: 30,
        softThresholdPercent: 40,
        safeBoundary: true,
        handoffSuggested: true,
        switchReason: '実装が一段落した',
      }),
    ).toEqual({ kind: 'softThreshold', remainingPercent: 30, switchReason: '実装が一段落した' });
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

  it('ターンが完了して応答が増えれば鍵が変わる（Issue #1097）', () => {
    const messages = ['直しておいて'];
    expect(safeBoundaryProbeKey(messages, ['直した'])).not.toBe(
      safeBoundaryProbeKey(messages, ['直した', '次は別件へ移る']),
    );
  });

  it('同一ターン内でstateが更新されても材料が同じなら鍵は変わらない（Issue #1097）', () => {
    const messages = ['直しておいて'];
    const replies = ['直した'];
    expect(safeBoundaryProbeKey(messages, replies)).toBe(
      safeBoundaryProbeKey([...messages], [...replies]),
    );
  });

  it('指示と応答の境目が動いただけの並びを同じ鍵にしない（Issue #1097）', () => {
    expect(safeBoundaryProbeKey(['a', 'b'], ['c'])).not.toBe(
      safeBoundaryProbeKey(['a'], ['b', 'c']),
    );
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

describe('圧縮契機の材料の進め方（Issue #1101）', () => {
  it('最初の同期では圧縮が走ったことにしない', () => {
    // 復元や履歴からの再開では、最初の同期で過去の圧縮がまとめて届く
    expect(advanceCompactionCount(undefined, 21)).toEqual({
      compacted: false,
      lastCompactionCount: 21,
    });
  });

  it('最初の同期で件数が0でも基準だけ作る', () => {
    expect(advanceCompactionCount(undefined, 0)).toEqual({
      compacted: false,
      lastCompactionCount: 0,
    });
  });

  it('基準ができた後に件数が増えたら圧縮が走ったとする', () => {
    expect(advanceCompactionCount(21, 22)).toEqual({
      compacted: true,
      lastCompactionCount: 22,
    });
  });

  it('件数が変わらなければ圧縮は走っていない', () => {
    expect(advanceCompactionCount(21, 21)).toEqual({
      compacted: false,
      lastCompactionCount: 21,
    });
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

describe('直前のアシスタント応答（Issue #1097）', () => {
  it('末尾から指定件数だけを会話順で返し、空文と他の種類は落とす', () => {
    const state: ChatState = {
      ...initialChatState,
      items: [
        item('agentMessage', '1件目'),
        item('userMessage', '指示'),
        item('agentMessage', '   '),
        item('reasoning', '考えている'),
        item('agentMessage', '2件目'),
        item('agentMessage', '3件目'),
      ],
    };
    expect(recentAssistantMessages(state, 2)).toEqual(['2件目', '3件目']);
  });

  it('応答がまだ無ければ空', () => {
    const state: ChatState = { ...initialChatState, items: [item('userMessage', '指示')] };
    expect(recentAssistantMessages(state)).toEqual([]);
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

  it('ターンが成功して終われば succeeded:true を返し、listenerを外す', async () => {
    const w = watcher({ ...initialChatState, turnCompletionSeq: 3 });
    const done = waitForFirstTurn(w);
    expect(w.stateListeners).toHaveLength(1);

    w.emit({ ...initialChatState, turnCompletionSeq: 4, turnFailed: false });

    expect(await done).toEqual({ succeeded: true });
    expect(w.stateListeners).toHaveLength(0);
  });

  it('ターンが失敗して終われば reason:turnFailed を返す（旧セッションを残す）', async () => {
    const w = watcher({ ...initialChatState, turnCompletionSeq: 0 });
    const done = waitForFirstTurn(w);

    w.emit({ ...initialChatState, turnCompletionSeq: 1, turnFailed: true });

    expect(await done).toEqual({ succeeded: false, reason: 'turnFailed' });
  });

  it('時間切れなら reason:timeout を返す', async () => {
    const w = watcher({ ...initialChatState, turnCompletionSeq: 0 });
    expect(await waitForFirstTurn(w, 1)).toEqual({ succeeded: false, reason: 'timeout' });
    expect(w.stateListeners).toHaveLength(0);
  });

  it('呼んだ時点でbaselineとlistenerが確定する（送信前に張れば取りこぼさない。Issue #1162）', async () => {
    const w = watcher({ ...initialChatState, turnCompletionSeq: 7 });

    // 初回プロンプトの送信より前に監視を張る想定。awaitを一度も挟まずに登録が終わる
    const done = waitForFirstTurn(w, 50);
    expect(w.stateListeners).toHaveLength(1);

    // 送信の完了を待っている間にターンが終わってしまっても、baselineは呼び出し時点の
    // 7 のままなので完了を拾える
    w.emit({ ...initialChatState, turnCompletionSeq: 8, turnFailed: false });

    expect(await done).toEqual({ succeeded: true });
  });

  it('ターンが終わる前の状態更新では決めない', async () => {
    const w = watcher({ ...initialChatState, turnCompletionSeq: 0 });
    const done = waitForFirstTurn(w, 50);

    // busyになっただけ（完了していない）
    w.emit({ ...initialChatState, turnCompletionSeq: 0, busy: true });
    expect(w.stateListeners).toHaveLength(1);

    expect(await done).toEqual({ succeeded: false, reason: 'timeout' });
  });
});

describe('引き継ぎ後に旧タブを閉じるかの判定（Issue #1158 / #1162）', () => {
  function input(overrides: Partial<Parameters<typeof decideOldTabAfterHandoff>[0]> = {}) {
    return {
      outcome: { succeeded: true } as const,
      oldDisposed: false,
      oldBusy: false,
      closeOldTab: true,
      ...overrides,
    };
  }

  it('初回ターンが成功していて旧が空いていれば閉じる', () => {
    expect(decideOldTabAfterHandoff(input())).toEqual({ action: 'close' });
  });

  it('初回ターンが時間切れなら、closeOldTabが有効でも残す', () => {
    expect(
      decideOldTabAfterHandoff(input({ outcome: { succeeded: false, reason: 'timeout' } })),
    ).toEqual({ action: 'keep', reason: 'timeout' });
  });

  it('初回ターンが失敗したら、closeOldTabが有効でも残す', () => {
    expect(
      decideOldTabAfterHandoff(input({ outcome: { succeeded: false, reason: 'turnFailed' } })),
    ).toEqual({ action: 'keep', reason: 'turnFailed' });
  });

  it('旧タブが既に破棄済みなら後片付けは要らない', () => {
    expect(decideOldTabAfterHandoff(input({ oldDisposed: true }))).toEqual({
      action: 'keep',
      reason: 'disposed',
    });
  });

  it('旧セッションがターン実行中なら閉じない', () => {
    expect(decideOldTabAfterHandoff(input({ oldBusy: true }))).toEqual({
      action: 'keep',
      reason: 'oldBusy',
    });
  });

  it('closeOldTabが無効なら人に聞く', () => {
    expect(decideOldTabAfterHandoff(input({ closeOldTab: false }))).toEqual({
      action: 'confirm',
    });
  });

  it('closeOldTabが無効でも、初回ターンが失敗していれば聞かずに残す', () => {
    expect(
      decideOldTabAfterHandoff(
        input({ closeOldTab: false, outcome: { succeeded: false, reason: 'turnFailed' } }),
      ),
    ).toEqual({ action: 'keep', reason: 'turnFailed' });
  });

  it('closeOldTabが無効でも、旧が破棄済みなら聞かない', () => {
    expect(decideOldTabAfterHandoff(input({ closeOldTab: false, oldDisposed: true }))).toEqual({
      action: 'keep',
      reason: 'disposed',
    });
  });

  it('残した理由はreason付きの1行になる', () => {
    expect(oldTabKeptMessage('timeout')).toContain('reason=timeout');
    expect(oldTabKeptMessage('turnFailed')).toContain('reason=turnFailed');
    expect(oldTabKeptMessage('disposed')).toContain('reason=disposed');
    expect(oldTabKeptMessage('oldBusy')).toContain('reason=oldBusy');
    expect(oldTabKeptMessage('userDismissed')).toContain('reason=userDismissed');
  });
});
