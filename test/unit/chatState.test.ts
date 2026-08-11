import { describe, expect, it } from 'vitest';
import {
  MAX_OUTPUT_CHARS,
  addApproval,
  appendNotice,
  applyEvent,
  buildContextUsage,
  capOutput,
  deriveReviewing,
  initialChatState,
  isOpenableSearchUrl,
  normalizeItem,
  readWebSearchResults,
  removeApproval,
  summarizeTurn,
  type ChatState,
} from '../../src/appserver/chatState';

const TURN = '019fd88d-723d-73f2-9100-212a63eb6069';

const feed = (state: ChatState, events: Array<[string, Record<string, unknown>]>): ChatState =>
  events.reduce((s, [method, params]) => applyEvent(s, method, params), state);

describe('normalizeItem', () => {
  it('userMessage の content からテキストを取り出す', () => {
    const item = normalizeItem({
      type: 'userMessage',
      id: 'u1',
      content: [{ type: 'text', text: 'こんにちは' }],
    });
    expect(item).toMatchObject({ id: 'u1', kind: 'userMessage', text: 'こんにちは' });
  });

  it('agentMessage の text を読む', () => {
    expect(normalizeItem({ type: 'agentMessage', id: 'a1', text: 'OK' })?.text).toBe('OK');
  });

  it('commandExecution はコマンドと終了コードを出す', () => {
    const item = normalizeItem({
      type: 'commandExecution',
      id: 'c1',
      command: 'ls -la',
      aggregatedOutput: 'total 0',
      exitCode: 0,
      status: 'completed',
    });
    expect(item).toMatchObject({ detail: 'ls -la', text: 'total 0', status: 'exit 0' });
  });

  it('fileChange は変更したパスを並べる', () => {
    const item = normalizeItem({
      type: 'fileChange',
      id: 'f1',
      changes: [{ path: '/a.ts' }, { path: '/b.ts' }],
    });
    expect(item?.detail).toBe('/a.ts, /b.ts');
  });

  it('fileChange はファイルごとの差分を保持する', () => {
    const item = normalizeItem({
      type: 'fileChange',
      id: 'f1',
      status: 'completed',
      changes: [
        { path: '/a.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+new\n' },
        { path: '/b.ts', kind: { type: 'add' }, diff: '@@ -0,0 +1 @@\n+added\n' },
      ],
    });
    expect(item?.diffs).toEqual([
      { path: '/a.ts', kind: 'update', movePath: undefined, diff: '@@ -1 +1 @@\n-old\n+new\n' },
      { path: '/b.ts', kind: 'add', movePath: undefined, diff: '@@ -0,0 +1 @@\n+added\n' },
    ]);
  });

  it('ファイルの移動先も保持する', () => {
    const item = normalizeItem({
      type: 'fileChange',
      id: 'f1',
      changes: [
        { path: '/a.ts', kind: { type: 'update', move_path: '/moved.ts' }, diff: '@@ @@\n' },
      ],
    });
    expect(item?.diffs[0]).toMatchObject({ kind: 'update', movePath: '/moved.ts' });
  });

  it('差分の無い項目は空の配列を持つ', () => {
    expect(normalizeItem({ type: 'agentMessage', id: 'a1', text: 'OK' })?.diffs).toEqual([]);
    expect(
      normalizeItem({ type: 'fileChange', id: 'f1', changes: [{ path: '/a.ts' }] })?.diffs,
    ).toEqual([]);
  });

  it('未知の種類でも捨てずに保持する（プロトコル追加で壊れないため）', () => {
    const item = normalizeItem({ type: 'somethingNew', id: 'x1' });
    expect(item).toMatchObject({ id: 'x1', kind: 'somethingNew' });
  });

  it('idや種類が無ければundefined', () => {
    expect(normalizeItem({ type: 'agentMessage' })).toBeUndefined();
    expect(normalizeItem({ id: 'x' })).toBeUndefined();
    expect(normalizeItem(null)).toBeUndefined();
  });

  it('enteredReviewMode / exitedReviewMode は review を detail として持つ', () => {
    expect(
      normalizeItem({ type: 'enteredReviewMode', id: 'r1', review: '未コミットの変更' }),
    ).toMatchObject({ id: 'r1', kind: 'enteredReviewMode', detail: '未コミットの変更' });
    expect(
      normalizeItem({ type: 'exitedReviewMode', id: 'r2', review: '未コミットの変更' }),
    ).toMatchObject({ id: 'r2', kind: 'exitedReviewMode', detail: '未コミットの変更' });
  });

  // reasoning の summary/content は ReasoningThreadItem のスキーマ上 string[]（実測でも一致）。
  // 要約(text)と全文(reasoningFull)は別に持ち、UI側で要約/全文の切り替えに使う（issue #19）。
  describe('reasoning', () => {
    it('summary と content が両方あれば要約と全文を別に持つ', () => {
      const item = normalizeItem({
        type: 'reasoning',
        id: 'rs_1',
        summary: ['要約その1', '要約その2'],
        content: ['全文その1', '全文その2'],
      });
      expect(item).toMatchObject({
        id: 'rs_1',
        kind: 'reasoning',
        text: '要約その1\n\n要約その2',
        reasoningFull: '全文その1\n\n全文その2',
      });
    });

    it('summary しか無ければ全文は持たない', () => {
      const item = normalizeItem({ type: 'reasoning', id: 'rs_2', summary: ['要約のみ'] });
      expect(item).toMatchObject({ text: '要約のみ' });
      expect(item?.reasoningFull).toBeUndefined();
    });

    it('content しか無ければ全文側にだけ入る（要約は空）', () => {
      const item = normalizeItem({ type: 'reasoning', id: 'rs_3', content: ['本文のみ'] });
      expect(item).toMatchObject({ text: '', reasoningFull: '本文のみ' });
    });

    it('どちらも無ければ空のまま', () => {
      const item = normalizeItem({ type: 'reasoning', id: 'rs_4', summary: [], content: [] });
      expect(item?.text).toBe('');
      expect(item?.reasoningFull).toBeUndefined();
    });
  });

  // Web検索の結果（issue #18）。実測（本issueで実際にWeb検索を伴うターンを回して確認）した
  // WebSearchThreadItemの `results` は `{type:'text_result', title, url, domain, snippet,
  // ref_id}` の形。スキーマ上は不透明なJSON（`items: true`）なので、形が違っても壊れないことも
  // あわせて確かめる。
  describe('webSearch', () => {
    it('query を detail として持ち、結果のタイトルとURLを searchResults に積む', () => {
      const item = normalizeItem({
        type: 'webSearch',
        id: 'ws_1',
        query: 'TypeScript release',
        action: { type: 'search', query: 'TypeScript release' },
        results: [
          {
            type: 'text_result',
            title: 'Releases · microsoft/TypeScript',
            url: 'https://github.com/microsoft/TypeScript/releases',
            domain: 'github.com',
            snippet: '...',
            ref_id: 'turn0search0',
          },
        ],
      });
      expect(item).toMatchObject({
        id: 'ws_1',
        kind: 'webSearch',
        detail: 'TypeScript release',
        searchResults: [
          {
            title: 'Releases · microsoft/TypeScript',
            url: 'https://github.com/microsoft/TypeScript/releases',
          },
        ],
      });
    });

    it('results が無い・itemStartedのnullでは searchResults が空のまま（従来どおりクエリだけ）', () => {
      expect(
        normalizeItem({ type: 'webSearch', id: 'ws_2', query: 'q', action: null, results: null }),
      ).toMatchObject({ detail: 'q', searchResults: [] });
      expect(normalizeItem({ type: 'webSearch', id: 'ws_3', query: 'q' })?.searchResults).toEqual(
        [],
      );
    });

    it('title か url が欠けた結果は黙って捨てる（他の結果は残す）', () => {
      const item = normalizeItem({
        type: 'webSearch',
        id: 'ws_4',
        query: 'q',
        results: [
          { title: 'タイトルのみ' },
          { url: 'https://example.com' },
          { title: '両方あり', url: 'https://example.com/ok' },
        ],
      });
      expect(item?.searchResults).toEqual([{ title: '両方あり', url: 'https://example.com/ok' }]);
    });

    it('危険なスキームのURLは弾く（javascript:等）', () => {
      const item = normalizeItem({
        type: 'webSearch',
        id: 'ws_5',
        query: 'q',
        results: [
          { title: '危険', url: 'javascript:alert(1)' },
          { title: '安全', url: 'https://example.com' },
        ],
      });
      expect(item?.searchResults).toEqual([{ title: '安全', url: 'https://example.com' }]);
    });

    it('resultsが配列でない（形が想定外）ときも壊れず空になる', () => {
      const item = normalizeItem({
        type: 'webSearch',
        id: 'ws_6',
        query: 'q',
        results: 'not-an-array',
      });
      expect(item?.searchResults).toEqual([]);
    });
  });
});

describe('isOpenableSearchUrl', () => {
  it('http/httpsは開ける', () => {
    expect(isOpenableSearchUrl('https://example.com')).toBe(true);
    expect(isOpenableSearchUrl('http://example.com')).toBe(true);
  });

  it('javascript: 等の危険なスキームは開けない', () => {
    expect(isOpenableSearchUrl('javascript:alert(1)')).toBe(false);
    expect(isOpenableSearchUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isOpenableSearchUrl('file:///etc/passwd')).toBe(false);
    expect(isOpenableSearchUrl('vbscript:msgbox(1)')).toBe(false);
    expect(isOpenableSearchUrl('')).toBe(false);
  });
});

describe('readWebSearchResults', () => {
  it('title/urlの両方が読める要素だけを残す', () => {
    expect(
      readWebSearchResults([
        { title: 'A', url: 'https://a.example' },
        { title: '', url: 'https://b.example' },
        { title: 'C', url: '' },
        { title: 'D', url: 'https://d.example' },
      ]),
    ).toEqual([
      { title: 'A', url: 'https://a.example' },
      { title: 'D', url: 'https://d.example' },
    ]);
  });

  it('配列でない入力は空配列を返す', () => {
    expect(readWebSearchResults(undefined)).toEqual([]);
    expect(readWebSearchResults(null)).toEqual([]);
    expect(readWebSearchResults('x')).toEqual([]);
  });
});

describe('deriveReviewing', () => {
  const base = { text: '', detail: '', status: undefined, turnId: undefined, diffs: [] };
  const entered = { ...base, id: 'r1', kind: 'enteredReviewMode' };
  const exited = { ...base, id: 'r2', kind: 'exitedReviewMode' };
  const message = { ...base, id: 'm1', kind: 'agentMessage', text: 'OK' };

  it('enteredReviewModeが最後ならレビュー中', () => {
    expect(deriveReviewing([message, entered])).toBe(true);
  });

  it('exitedReviewModeが最後ならレビュー中ではない', () => {
    expect(deriveReviewing([entered, message, exited])).toBe(false);
  });

  it('どちらも現れていなければレビュー中ではない', () => {
    expect(deriveReviewing([])).toBe(false);
    expect(deriveReviewing([message])).toBe(false);
  });

  it('2回目のレビューが始まれば再びレビュー中になる', () => {
    expect(deriveReviewing([entered, exited, entered])).toBe(true);
  });
});

describe('applyEvent', () => {
  it('turn/started で応答中になり、turn/completed で戻る', () => {
    const busy = applyEvent(initialChatState, 'turn/started', {});
    expect(busy.busy).toBe(true);
    expect(applyEvent(busy, 'turn/completed', {}).busy).toBe(false);
  });

  it('turn/started の turn.id を保持し、終了で手放す', () => {
    // turnIdはトップレベルではなく turn オブジェクトの中にある
    const started = applyEvent(initialChatState, 'turn/started', {
      threadId: 'th-1',
      turn: { id: 't-1', status: 'inProgress' },
    });
    expect(started.turnId).toBe('t-1');
    expect(applyEvent(started, 'turn/completed', {}).turnId).toBeUndefined();
    expect(applyEvent(started, 'turn/failed', {}).turnId).toBeUndefined();
  });

  it('turn/failed だけを失敗として残し、次のターンで消す', () => {
    const started = applyEvent(initialChatState, 'turn/started', {});
    expect(applyEvent(started, 'turn/completed', {}).turnFailed).toBe(false);

    const failed = applyEvent(started, 'turn/failed', {});
    expect(failed.turnFailed).toBe(true);
    expect(applyEvent(failed, 'turn/started', {}).turnFailed).toBe(false);
  });

  it('turnが無い turn/started でも落ちない', () => {
    expect(applyEvent(initialChatState, 'turn/started', {}).turnId).toBeUndefined();
  });

  it('item通知の turnId でも補える', () => {
    // turn/started を取り逃しても中断できるようにする
    const state = applyEvent(initialChatState, 'item/started', {
      item: { type: 'userMessage', id: 'u1', content: [] },
      turnId: 't-2',
    });
    expect(state.turnId).toBe('t-2');
  });

  it('thread/status/changed の active を反映する', () => {
    const state = applyEvent(initialChatState, 'thread/status/changed', {
      status: { type: 'active' },
    });
    expect(state.busy).toBe(true);
    expect(applyEvent(state, 'thread/status/changed', { status: { type: 'idle' } }).busy).toBe(
      false,
    );
  });

  it('item/started と item/completed で同じidを二重に積まない', () => {
    const state = feed(initialChatState, [
      ['item/started', { item: { type: 'agentMessage', id: 'a1', text: '' }, turnId: TURN }],
      ['item/completed', { item: { type: 'agentMessage', id: 'a1', text: 'OK' }, turnId: TURN }],
    ]);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]?.text).toBe('OK');
  });

  it('デルタを積み上げる', () => {
    const state = feed(initialChatState, [
      ['item/started', { item: { type: 'agentMessage', id: 'a1', text: '' } }],
      ['item/agentMessage/delta', { itemId: 'a1', delta: 'こん' }],
      ['item/agentMessage/delta', { itemId: 'a1', delta: 'にちは' }],
    ]);
    expect(state.items[0]?.text).toBe('こんにちは');
  });

  it('本文が空のcompletedでデルタの内容を消さない', () => {
    const state = feed(initialChatState, [
      ['item/agentMessage/delta', { itemId: 'a1', delta: '積んだ本文' }],
      ['item/completed', { item: { type: 'agentMessage', id: 'a1', text: '' } }],
    ]);
    expect(state.items[0]?.text).toBe('積んだ本文');
  });

  it('turnIdを保持し、後から空で上書きされない', () => {
    const state = feed(initialChatState, [
      ['item/started', { item: { type: 'userMessage', id: 'u1', content: [] }, turnId: TURN }],
      ['item/completed', { item: { type: 'userMessage', id: 'u1', content: [] } }],
    ]);
    expect(state.items[0]?.turnId).toBe(TURN);
  });

  it('レート制限を取り込む', () => {
    const state = feed(initialChatState, [
      ['account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 91 } } }],
    ]);
    expect(state.usage).toEqual({ usedPercent: 91 });
  });

  it('Codexが付けた名前を取り込む', () => {
    const state = applyEvent(initialChatState, 'thread/name/updated', {
      threadId: 't1',
      threadName: '設計の相談',
    });
    expect(state.name).toBe('設計の相談');
  });

  it('名前がnullや空なら未設定に戻す', () => {
    const named = applyEvent(initialChatState, 'thread/name/updated', { threadName: 'x' });
    expect(applyEvent(named, 'thread/name/updated', { threadName: null }).name).toBeUndefined();
    expect(applyEvent(named, 'thread/name/updated', { threadName: '' }).name).toBeUndefined();
  });

  it('未知の通知では状態を変えない（同一参照を返す）', () => {
    const state = applyEvent(initialChatState, 'mcpServer/startupStatus/updated', {});
    expect(state).toBe(initialChatState);
  });

  it('元の状態を破壊しない', () => {
    const next = applyEvent(initialChatState, 'turn/started', {});
    expect(initialChatState.busy).toBe(false);
    expect(next).not.toBe(initialChatState);
  });

  it('turn/completedで作業記録用の成果（応答テキスト・編集ファイル）を作る', () => {
    const state = feed(initialChatState, [
      ['turn/started', { turn: { id: TURN } }],
      [
        'item/completed',
        { item: { type: 'agentMessage', id: 'a1', text: '直しました' }, turnId: TURN },
      ],
      [
        'item/completed',
        { item: { type: 'fileChange', id: 'f1', changes: [{ path: '/a.ts' }] }, turnId: TURN },
      ],
      ['turn/completed', {}],
    ]);
    expect(state.turnResultText).toBe('直しました');
    expect(state.turnEditedFiles).toEqual(['/a.ts']);
  });

  it('turn/failedでも成果を作る（失敗しても応答・編集が残ることがあるため）', () => {
    const state = feed(initialChatState, [
      ['turn/started', { turn: { id: TURN } }],
      [
        'item/completed',
        { item: { type: 'agentMessage', id: 'a1', text: '途中まで' }, turnId: TURN },
      ],
      ['turn/failed', {}],
    ]);
    expect(state.turnResultText).toBe('途中まで');
  });

  it('turn/startedで前のターンの成果をリセットする', () => {
    const finished = feed(initialChatState, [
      ['turn/started', { turn: { id: TURN } }],
      [
        'item/completed',
        { item: { type: 'agentMessage', id: 'a1', text: '前回の応答' }, turnId: TURN },
      ],
      ['turn/completed', {}],
    ]);
    expect(finished.turnResultText).toBe('前回の応答');

    const restarted = applyEvent(finished, 'turn/started', { turn: { id: 't-next' } });
    expect(restarted.turnResultText).toBe('');
    expect(restarted.turnEditedFiles).toEqual([]);
  });

  it('enteredReviewModeが届くとreviewingになり、exitedReviewModeで戻る', () => {
    const entered = applyEvent(initialChatState, 'item/started', {
      item: { type: 'enteredReviewMode', id: 'r1', review: '未コミットの変更' },
      turnId: TURN,
    });
    expect(entered.reviewing).toBe(true);

    const exited = applyEvent(entered, 'item/completed', {
      item: { type: 'exitedReviewMode', id: 'r2', review: '未コミットの変更' },
      turnId: TURN,
    });
    expect(exited.reviewing).toBe(false);
  });
});

describe('summarizeTurn', () => {
  const items: ChatState['items'] = [
    {
      id: 'u1',
      kind: 'userMessage',
      text: '直して',
      detail: '',
      status: undefined,
      turnId: TURN,
      diffs: [],
    },
    {
      id: 'a1',
      kind: 'agentMessage',
      text: '直しました',
      detail: '',
      status: undefined,
      turnId: TURN,
      diffs: [],
    },
    {
      id: 'f1',
      kind: 'fileChange',
      text: '',
      detail: '/a.ts, /b.ts',
      status: undefined,
      turnId: TURN,
      diffs: [],
    },
    {
      id: 'a2',
      kind: 'agentMessage',
      text: '別のターンの応答',
      detail: '',
      status: undefined,
      turnId: 'other-turn',
      diffs: [],
    },
  ];

  it('turnIdが一致する項目だけから応答テキストと編集ファイルを作る', () => {
    expect(summarizeTurn(items, TURN)).toEqual({
      text: '直しました',
      editedFiles: ['/a.ts', '/b.ts'],
    });
  });

  it('複数のagentMessageは改行で連結する', () => {
    const multi: ChatState['items'] = [
      {
        id: 'a1',
        kind: 'agentMessage',
        text: '一つ目',
        detail: '',
        status: undefined,
        turnId: TURN,
        diffs: [],
      },
      {
        id: 'a2',
        kind: 'agentMessage',
        text: '二つ目',
        detail: '',
        status: undefined,
        turnId: TURN,
        diffs: [],
      },
    ];
    expect(summarizeTurn(multi, TURN).text).toBe('一つ目\n二つ目');
  });

  it('同じファイルへの複数回の編集は1件にまとめる', () => {
    const repeated: ChatState['items'] = [
      {
        id: 'f1',
        kind: 'fileChange',
        text: '',
        detail: '/a.ts',
        status: undefined,
        turnId: TURN,
        diffs: [],
      },
      {
        id: 'f2',
        kind: 'fileChange',
        text: '',
        detail: '/a.ts',
        status: undefined,
        turnId: TURN,
        diffs: [],
      },
    ];
    expect(summarizeTurn(repeated, TURN).editedFiles).toEqual(['/a.ts']);
  });

  it('turnIdが判らなければ何も返さない', () => {
    expect(summarizeTurn(items, undefined)).toEqual({ text: '', editedFiles: [] });
  });
});

describe('承認の出し入れ', () => {
  const approval = {
    requestId: 7,
    kind: 'command' as const,
    title: 'コマンドの実行を許可しますか',
    detail: 'ls',
    itemId: undefined,
  };

  it('追加して取り除ける', () => {
    const added = addApproval(initialChatState, approval);
    expect(added.approvals).toHaveLength(1);
    expect(removeApproval(added, 7).approvals).toEqual([]);
  });

  it('該当しないidでは何も消えない', () => {
    const added = addApproval(initialChatState, approval);
    expect(removeApproval(added, 99).approvals).toHaveLength(1);
  });

  it('patchUpdated で差分だけを差し替える', () => {
    const state = feed(initialChatState, [
      [
        'item/started',
        {
          item: { type: 'fileChange', id: 'f1', status: 'inProgress', changes: [] },
          turnId: TURN,
          diffs: [],
        },
      ],
      [
        'item/fileChange/patchUpdated',
        {
          itemId: 'f1',
          turnId: TURN,
          diffs: [],
          changes: [{ path: '/a.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n+x\n' }],
        },
      ],
    ]);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]?.diffs).toHaveLength(1);
    expect(state.items[0]?.detail).toBe('/a.ts');
  });

  it('知らない項目の patchUpdated は無視する', () => {
    const state = applyEvent(initialChatState, 'item/fileChange/patchUpdated', {
      itemId: 'none',
      changes: [{ path: '/a.ts', kind: { type: 'add' }, diff: '@@ @@\n' }],
    });
    expect(state).toBe(initialChatState);
  });

  it('別の経路で解決された承認は取り下げる', () => {
    const added = addApproval(initialChatState, approval);
    const resolved = applyEvent(added, 'serverRequest/resolved', {
      requestId: 7,
      threadId: 't1',
    });
    expect(resolved.approvals).toEqual([]);
  });

  it('保留していない要求の解決が来ても壊れない', () => {
    const added = addApproval(initialChatState, approval);
    const resolved = applyEvent(added, 'serverRequest/resolved', {
      requestId: 99,
      threadId: 't1',
    });
    expect(resolved.approvals).toHaveLength(1);
    expect(applyEvent(initialChatState, 'serverRequest/resolved', {})).toBe(initialChatState);
  });
});

describe('buildContextUsage', () => {
  it('上限があれば残りの割合を出す', () => {
    expect(buildContextUsage(21541, 258400)).toEqual({
      usedTokens: 21541,
      contextWindow: 258400,
      remainingPercent: 92,
    });
  });

  it('上限が判らなければ割合を出さない', () => {
    expect(buildContextUsage(21541, undefined)).toEqual({
      usedTokens: 21541,
      contextWindow: undefined,
      remainingPercent: undefined,
    });
  });

  it('上限が0以下なら割合を出さない', () => {
    expect(buildContextUsage(100, 0)?.remainingPercent).toBeUndefined();
  });

  it('上限を超えても残りは0で止まる', () => {
    expect(buildContextUsage(300000, 258400)?.remainingPercent).toBe(0);
  });

  it('信用できない使用量では何も返さない', () => {
    expect(buildContextUsage(-1, 100)).toBeUndefined();
    expect(buildContextUsage(Number.NaN, 100)).toBeUndefined();
  });
});

describe('applyEvent / thread/tokenUsage/updated', () => {
  // 実測した通知の形。`total` はスレッド全体の累計で、コンテキストの占有量は `last`
  const notification = (lastTotal: number, window: number | null) => ({
    threadId: 't1',
    turnId: TURN,
    tokenUsage: {
      total: { totalTokens: 21541, inputTokens: 21536, cachedInputTokens: 6912, outputTokens: 5 },
      last: { totalTokens: lastTotal, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      modelContextWindow: window,
    },
  });

  it('last の合計と上限からコンテキスト使用量を作る', () => {
    const state = applyEvent(
      initialChatState,
      'thread/tokenUsage/updated',
      notification(21541, 258400),
    );
    expect(state.context).toEqual({
      usedTokens: 21541,
      contextWindow: 258400,
      remainingPercent: 92,
    });
  });

  it('圧縮で last だけが下がる', () => {
    const before = applyEvent(
      initialChatState,
      'thread/tokenUsage/updated',
      notification(21541, 258400),
    );
    const after = applyEvent(before, 'thread/tokenUsage/updated', notification(4831, 258400));
    expect(after.context?.usedTokens).toBe(4831);
    expect(after.context?.remainingPercent).toBe(98);
  });

  it('上限がnullなら割合を出さない', () => {
    const state = applyEvent(
      initialChatState,
      'thread/tokenUsage/updated',
      notification(21541, null),
    );
    expect(state.context?.remainingPercent).toBeUndefined();
  });

  it('読めない通知では状態を変えない', () => {
    expect(applyEvent(initialChatState, 'thread/tokenUsage/updated', {})).toBe(initialChatState);
    expect(
      applyEvent(initialChatState, 'thread/tokenUsage/updated', { tokenUsage: { last: {} } }),
    ).toBe(initialChatState);
  });

  it('レート制限の消費率とは別に持つ', () => {
    const withUsage = applyEvent(initialChatState, 'account/rateLimits/updated', {
      rateLimits: { primary: { usedPercent: 42 } },
    });
    const state = applyEvent(withUsage, 'thread/tokenUsage/updated', notification(21541, 258400));
    expect(state.usage?.usedPercent).toBe(42);
    expect(state.context?.usedTokens).toBe(21541);
  });
});

describe('normalizeItem / contextCompaction', () => {
  it('圧縮の項目を種類ごと残す', () => {
    expect(normalizeItem({ type: 'contextCompaction', id: 'c1' })).toMatchObject({
      id: 'c1',
      kind: 'contextCompaction',
    });
  });
});

describe('appendNotice', () => {
  it('会話とは別の一言を項目として残す', () => {
    const state = appendNotice(initialChatState, 'settings:1', 'モデルを sonnet に変えました');
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      id: 'settings:1',
      kind: 'settingsChanged',
      detail: 'モデルを sonnet に変えました',
      text: '',
    });
  });

  it('同じidなら書き換える（増やさない）', () => {
    const once = appendNotice(initialChatState, 'settings:1', '最初');
    const twice = appendNotice(once, 'settings:1', 'あとから');
    expect(twice.items).toHaveLength(1);
    expect(twice.items[0]?.detail).toBe('あとから');
  });

  it('別のidなら並べる', () => {
    const first = appendNotice(initialChatState, 'settings:1', 'モデル');
    expect(appendNotice(first, 'settings:2', '承認方法').items).toHaveLength(2);
  });
});

describe('capOutput', () => {
  it('上限までなら手を付けない', () => {
    expect(capOutput('abc')).toEqual({ text: 'abc', truncated: false });
  });

  it('上限を超えたら末尾を残して先頭を捨てる', () => {
    const text = 'x'.repeat(MAX_OUTPUT_CHARS) + 'tail';
    const capped = capOutput(text);
    expect(capped.truncated).toBe(true);
    expect(capped.text).toHaveLength(MAX_OUTPUT_CHARS);
    expect(capped.text.endsWith('tail')).toBe(true);
  });

  it('切り詰めても印を本文へ混ぜない（コピーがそのまま使える）', () => {
    const capped = capOutput('y'.repeat(MAX_OUTPUT_CHARS + 10));
    expect(capped.text).toMatch(/^y+$/);
  });
});

describe('applyEvent / item/commandExecution/outputDelta', () => {
  const started = (): ChatState =>
    applyEvent(initialChatState, 'item/started', {
      turnId: TURN,
      item: { id: 'cmd_1', type: 'commandExecution', command: 'ls -R /', status: 'inProgress' },
    });

  it('出力を追記して伸ばす', () => {
    const state = feed(started(), [
      ['item/commandExecution/outputDelta', { itemId: 'cmd_1', delta: 'one\n' }],
      ['item/commandExecution/outputDelta', { itemId: 'cmd_1', delta: 'two\n' }],
    ]);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]?.text).toBe('one\ntwo\n');
    expect(state.items[0]?.detail).toBe('ls -R /');
  });

  it('itemが先に無くてもコマンドの項目として作る', () => {
    const state = applyEvent(initialChatState, 'item/commandExecution/outputDelta', {
      itemId: 'cmd_9',
      delta: 'hello',
    });
    expect(state.items[0]).toMatchObject({ id: 'cmd_9', kind: 'commandExecution', text: 'hello' });
  });

  it('itemIdやdeltaが欠けていれば何もしない', () => {
    const state = started();
    expect(applyEvent(state, 'item/commandExecution/outputDelta', { delta: 'x' })).toBe(state);
    expect(applyEvent(state, 'item/commandExecution/outputDelta', { itemId: 'cmd_1' })).toBe(state);
  });

  it('上限を超えた出力は末尾を残して切り詰める', () => {
    const state = applyEvent(started(), 'item/commandExecution/outputDelta', {
      itemId: 'cmd_1',
      delta: 'z'.repeat(MAX_OUTPUT_CHARS + 100),
    });
    expect(state.items[0]?.text).toHaveLength(MAX_OUTPUT_CHARS);
    expect(state.items[0]?.truncated).toBe(true);
  });

  it('完了通知の aggregatedOutput でデルタの本文を消さない', () => {
    const withDelta = applyEvent(started(), 'item/commandExecution/outputDelta', {
      itemId: 'cmd_1',
      delta: '流れてきた出力',
    });
    const completed = applyEvent(withDelta, 'item/completed', {
      turnId: TURN,
      item: { id: 'cmd_1', type: 'commandExecution', command: 'ls -R /', exitCode: 0 },
    });
    expect(completed.items[0]?.text).toBe('流れてきた出力');
    expect(completed.items[0]?.status).toBe('exit 0');
  });
});

// Phase 0（issue #19）の実測: item/completed の reasoning は summary/content が
// どちらも空配列で届き、中身はデルタ通知でしか来ない。要約と全文を別々に積む。
describe('applyEvent / item/reasoning/*', () => {
  it('summaryTextDelta で要約を積む', () => {
    const state = feed(initialChatState, [
      ['item/reasoning/summaryTextDelta', { itemId: 'rs_1', delta: '考え中' }],
      ['item/reasoning/summaryTextDelta', { itemId: 'rs_1', delta: 'です' }],
    ]);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ id: 'rs_1', kind: 'reasoning', text: '考え中です' });
    expect(state.items[0]?.reasoningFull).toBeUndefined();
  });

  it('textDelta で全文を積む（要約とは別枠）', () => {
    const state = feed(initialChatState, [
      ['item/reasoning/textDelta', { itemId: 'rs_1', delta: '本文の' }],
      ['item/reasoning/textDelta', { itemId: 'rs_1', delta: '続き' }],
    ]);
    expect(state.items[0]).toMatchObject({ id: 'rs_1', kind: 'reasoning', text: '' });
    expect(state.items[0]?.reasoningFull).toBe('本文の続き');
  });

  it('要約と全文を両方積める', () => {
    const state = feed(initialChatState, [
      ['item/reasoning/summaryTextDelta', { itemId: 'rs_1', delta: '要約' }],
      ['item/reasoning/textDelta', { itemId: 'rs_1', delta: '全文' }],
    ]);
    expect(state.items[0]).toMatchObject({ text: '要約', reasoningFull: '全文' });
  });

  it('summaryPartAdded は既存の要約が空でなければ区切りを挟む', () => {
    const state = feed(initialChatState, [
      ['item/reasoning/summaryTextDelta', { itemId: 'rs_1', delta: '一段落目' }],
      ['item/reasoning/summaryPartAdded', { itemId: 'rs_1' }],
      ['item/reasoning/summaryTextDelta', { itemId: 'rs_1', delta: '二段落目' }],
    ]);
    expect(state.items[0]?.text).toBe('一段落目\n\n二段落目');
  });

  it('summaryPartAdded は要約がまだ無ければ何もしない（先頭に空行を作らない）', () => {
    const state = applyEvent(initialChatState, 'item/reasoning/summaryPartAdded', {
      itemId: 'rs_1',
    });
    expect(state).toBe(initialChatState);
  });

  it('itemIdやdeltaが欠けていれば何もしない', () => {
    expect(
      applyEvent(initialChatState, 'item/reasoning/summaryTextDelta', { delta: 'x' }),
    ).toBe(initialChatState);
    expect(
      applyEvent(initialChatState, 'item/reasoning/textDelta', { itemId: 'rs_1' }),
    ).toBe(initialChatState);
  });

  it('完了通知が空配列でも、デルタで積んだ要約・全文を消さない', () => {
    const withDelta = feed(initialChatState, [
      ['item/reasoning/summaryTextDelta', { itemId: 'rs_1', delta: '要約' }],
      ['item/reasoning/textDelta', { itemId: 'rs_1', delta: '全文' }],
    ]);
    const completed = applyEvent(withDelta, 'item/completed', {
      turnId: TURN,
      item: { id: 'rs_1', type: 'reasoning', summary: [], content: [] },
    });
    expect(completed.items[0]).toMatchObject({ text: '要約', reasoningFull: '全文' });
  });
});

describe('applyEvent / hook/completed', () => {
  // app-serverにはhookの信頼を求める専用の要求が無い（ServerRequest/ServerNotificationの
  // 全種をスキーマで確認済み）。信頼していないhookが動くと status: 'blocked' の
  // hook/completed が届くのが唯一の合図なので、これを会話への注記に変換する（issue #28）。
  it('信頼されていないhookがブロックされたら会話に注記を残す', () => {
    const state = applyEvent(initialChatState, 'hook/completed', {
      threadId: 'th-1',
      run: {
        id: 'run-1',
        eventName: 'preToolUse',
        sourcePath: '/workspace/repo/.codex/config.toml',
        status: 'blocked',
      },
    });
    expect(state.items).toHaveLength(1);
    expect(state.items[0]?.detail).toContain('preToolUse');
    expect(state.items[0]?.detail).toContain('/workspace/repo/.codex/config.toml');
    expect(state.items[0]?.detail).toContain('信頼されていない');
  });

  it('blocked以外のstatusでは何もしない', () => {
    const state = applyEvent(initialChatState, 'hook/completed', {
      run: { id: 'run-2', eventName: 'preToolUse', status: 'completed' },
    });
    expect(state).toBe(initialChatState);
  });

  it('同じrunのidを二重に積まない', () => {
    const once = applyEvent(initialChatState, 'hook/completed', {
      run: { id: 'run-3', eventName: 'preToolUse', status: 'blocked' },
    });
    const twice = applyEvent(once, 'hook/completed', {
      run: { id: 'run-3', eventName: 'preToolUse', status: 'blocked' },
    });
    expect(twice.items).toHaveLength(1);
  });
});

describe('normalizeItem / commandExecution の切り詰め', () => {
  it('aggregatedOutput が長すぎる場合も末尾を残す', () => {
    const item = normalizeItem({
      id: 'cmd_2',
      type: 'commandExecution',
      command: 'cat big.log',
      aggregatedOutput: 'a'.repeat(MAX_OUTPUT_CHARS + 1),
    });
    expect(item?.text).toHaveLength(MAX_OUTPUT_CHARS);
    expect(item?.truncated).toBe(true);
  });
});
