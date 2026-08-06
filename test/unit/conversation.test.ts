import { describe, expect, it } from 'vitest';
import { parseConversation, summarize } from '../../src/codex/conversation';

const TURN_A = '019fd858-271e-7502-ad36-fb8cdeb972c2';
const TURN_B = '019fd859-ec78-7fd2-af4a-68742874cd76';

const taskStarted = (turnId: string) =>
  JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } });

const turnContext = (turnId: string, timestamp = '2026-08-07T00:00:00Z') =>
  JSON.stringify({ timestamp, type: 'turn_context', payload: { turn_id: turnId, model: 'x' } });

const userMessage = (message: string) =>
  JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message } });

const agentMessage = (message: string) =>
  JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message } });

const toolCall = (name: string) =>
  JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name } });

const taskComplete = (turnId: string) =>
  JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } });

/** 実データの並び: task_started → turn_context → user_message → 応答 → task_complete */
const rollout = [
  JSON.stringify({ type: 'session_meta', payload: { session_id: 'x', cwd: '/w' } }),
  taskStarted(TURN_A),
  turnContext(TURN_A, '2026-08-07T01:00:00Z'),
  userMessage('設計して'),
  agentMessage('了解しました'),
  toolCall('exec'),
  toolCall('exec'),
  taskComplete(TURN_A),
  taskStarted(TURN_B),
  turnContext(TURN_B, '2026-08-07T02:00:00Z'),
  userMessage('実装して'),
  agentMessage('実装します'),
  agentMessage('完了しました'),
  toolCall('apply_patch'),
  taskComplete(TURN_B),
].join('\n');

describe('parseConversation', () => {
  it('ターンごとに指示・応答・ツールをまとめる', () => {
    const turns = parseConversation(rollout);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toEqual({
      turnId: TURN_A,
      timestamp: '2026-08-07T01:00:00Z',
      userMessage: '設計して',
      agentMessages: ['了解しました'],
      toolNames: ['exec', 'exec'],
    });
  });

  it('複数の応答を順に保持する', () => {
    expect(parseConversation(rollout)[1]?.agentMessages).toEqual(['実装します', '完了しました']);
  });

  it('turn_idと指示が1対1で対応する', () => {
    expect(parseConversation(rollout).map((t) => t.turnId)).toEqual([TURN_A, TURN_B]);
  });

  it('ユーザーの指示が無いターンは分岐点にならないので除く', () => {
    const content = [turnContext(TURN_A), agentMessage('自発的な発言'), taskComplete(TURN_A)].join(
      '\n',
    );
    expect(parseConversation(content)).toEqual([]);
  });

  it('turn_context より前のイベントを無視する', () => {
    const content = [userMessage('迷子'), turnContext(TURN_A), userMessage('本命')].join('\n');
    expect(parseConversation(content)[0]?.userMessage).toBe('本命');
  });

  it('同一ターンの2つ目以降のuser_messageで上書きしない', () => {
    const content = [turnContext(TURN_A), userMessage('最初'), userMessage('後続')].join('\n');
    expect(parseConversation(content)[0]?.userMessage).toBe('最初');
  });

  it('壊れた行や空行を読み飛ばす', () => {
    const content = ['{"type":', '', turnContext(TURN_A), userMessage('ok'), 'null'].join('\n');
    expect(parseConversation(content)).toHaveLength(1);
  });

  it('空のファイルでも落ちない', () => {
    expect(parseConversation('')).toEqual([]);
  });
});

describe('summarize', () => {
  it('改行と連続空白を潰す', () => {
    expect(summarize('a\n\n  b\tc')).toBe('a b c');
  });

  it('長い文を省略する', () => {
    expect(summarize('あ'.repeat(200), 10)).toBe(`${'あ'.repeat(9)}…`);
  });

  it('上限以下ならそのまま返す', () => {
    expect(summarize('短い', 10)).toBe('短い');
  });
});
