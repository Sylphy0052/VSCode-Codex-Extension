import { describe, expect, it } from 'vitest';
import {
  firstUserMessage,
  isUserThread,
  parseSessionMeta,
  sessionIdFromRolloutName,
} from '../../src/codex/sessionMeta';

const ID = '019fd7a6-d25e-7bd2-b181-751e467277f3';

/** 実際のロールアウト1行目を模したもの。base_instructions等の巨大フィールドは省略。 */
const realLine = JSON.stringify({
  timestamp: '2026-08-06T15:17:50.012Z',
  type: 'session_meta',
  payload: {
    session_id: ID,
    id: ID,
    timestamp: '2026-08-06T15:17:42.112Z',
    cwd: '/home/user/workspace/novel-writer',
    originator: 'codex_vscode',
    cli_version: '0.146.0',
    source: 'vscode',
    thread_source: 'user',
  },
});

describe('parseSessionMeta', () => {
  it('実データ形式から必要なフィールドを取り出す', () => {
    const meta = parseSessionMeta(realLine);
    expect(meta).toBeDefined();
    expect(meta?.sessionId).toBe(ID);
    expect(meta?.cwd).toBe('/home/user/workspace/novel-writer');
    expect(meta?.originator).toBe('codex_vscode');
    expect(meta?.threadSource).toBe('user');
  });

  it('originator の上書き値を読める（紐付けの根拠）', () => {
    const line = JSON.stringify({
      type: 'session_meta',
      payload: {
        session_id: ID,
        cwd: '/w',
        timestamp: '2026-08-06T16:10:45.498Z',
        originator: 'vscode-1234',
        source: 'exec',
        thread_source: 'user',
      },
    });
    expect(parseSessionMeta(line)?.originator).toBe('vscode-1234');
  });

  it('source がオブジェクトのsubagentセッションも落ちずに読める', () => {
    const line = JSON.stringify({
      type: 'session_meta',
      payload: {
        session_id: ID,
        cwd: '/w',
        timestamp: '2026-08-06T15:57:16Z',
        originator: 'codex_vscode',
        source: { subagent: { other: 'guardian' } },
        thread_source: 'subagent',
      },
    });
    const meta = parseSessionMeta(line);
    expect(meta?.source).toEqual({ subagent: { other: 'guardian' } });
    expect(isUserThread(meta!)).toBe(false);
  });

  it('type が session_meta でない行は受け付けない', () => {
    const line = JSON.stringify({ type: 'response_item', payload: { session_id: ID } });
    expect(parseSessionMeta(line)).toBeUndefined();
  });

  it('壊れたJSON・必須フィールド欠損はundefinedを返す', () => {
    expect(parseSessionMeta('{"type":"session_meta"')).toBeUndefined();
    expect(parseSessionMeta('')).toBeUndefined();
    expect(parseSessionMeta('null')).toBeUndefined();
    expect(parseSessionMeta(JSON.stringify({ type: 'session_meta', payload: {} }))).toBeUndefined();
  });
});

describe('sessionIdFromRolloutName', () => {
  it('実ファイル名からidを取り出す', () => {
    expect(sessionIdFromRolloutName(`rollout-2026-08-07T00-17-42-${ID}.jsonl`)).toBe(ID);
  });

  it('形式が違うファイル名はundefined', () => {
    expect(sessionIdFromRolloutName('rollout-2026-08-07.jsonl')).toBeUndefined();
    expect(sessionIdFromRolloutName(`other-${ID}.jsonl`)).toBeUndefined();
    expect(sessionIdFromRolloutName(`rollout-x-${ID}.jsonl.tmp`)).toBeUndefined();
  });
});

describe('isUserThread', () => {
  it('ユーザー起点の対話セッションは真', () => {
    expect(isUserThread(parseSessionMeta(realLine)!)).toBe(true);
  });

  it('thread_source が無い session_meta も真（codex-cli 0.148.0 では書かれない。issue #943）', () => {
    const line = JSON.stringify({
      type: 'session_meta',
      payload: {
        session_id: ID,
        id: ID,
        timestamp: '2026-08-29T06:50:41.000Z',
        cwd: '/home/user/workspace/novel-writer',
        originator: 'codex_vscode',
        cli_version: '0.148.0',
        source: 'vscode',
      },
    });
    const meta = parseSessionMeta(line);
    expect(meta?.threadSource).toBeUndefined();
    expect(isUserThread(meta!)).toBe(true);
  });

  it('thread_source が subagent の派生スレッドは偽', () => {
    const line = JSON.stringify({
      type: 'session_meta',
      payload: {
        session_id: ID,
        cwd: '/w',
        timestamp: '2026-08-06T15:57:16Z',
        originator: 'codex_vscode',
        thread_source: 'subagent',
      },
    });
    expect(isUserThread(parseSessionMeta(line)!)).toBe(false);
  });
});

describe('firstUserMessage', () => {
  const line = (o: unknown) => JSON.stringify(o);
  const userEvent = (message: string) =>
    line({ type: 'event_msg', payload: { type: 'user_message', message } });
  const turnContext = () => line({ type: 'turn_context', payload: { turn_id: 't1' } });
  const userItem = (...texts: string[]) =>
    line({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: texts.map((text) => ({ type: 'input_text', text })),
      },
    });

  it('TUI形式の user_message を拾う', () => {
    expect(firstUserMessage([turnContext(), userEvent('数えて')])).toBe('数えて');
  });

  it('チャット画面の形式では turn_context 以降の user を拾う', () => {
    // 画面経由のセッションには user_message が無く、response_item だけが残る
    const lines = [
      userItem('# AGENTS.md instructions', '環境の説明'),
      turnContext(),
      userItem('test4.txtを作って'),
    ];
    expect(firstUserMessage(lines)).toBe('test4.txtを作って');
  });

  it('turn_context より前の user は前置きなので無視する', () => {
    expect(firstUserMessage([userItem('# AGENTS.md instructions')])).toBeUndefined();
  });

  it('該当が無ければ undefined', () => {
    expect(firstUserMessage([turnContext(), 'not json', ''])).toBeUndefined();
  });
});
