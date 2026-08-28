import { describe, expect, it } from 'vitest';
import { initialChatState, type ChatItem, type ChatState } from '../../src/appserver/chatState';
import {
  appendLoopEngineeringInstruction,
  declaresEscalate,
  defaultLoopEngineeringConfig,
  DEFAULT_LOOP_ENGINEERING_CONTINUE_INSTRUCTION,
  DEFAULT_LOOP_ENGINEERING_INITIAL_INSTRUCTION,
  LOOP_ESCALATE_TOKEN,
  type LoopEngineeringConfig,
} from '../../src/loop/loopEngineering';

const config = (overrides: Partial<LoopEngineeringConfig> = {}): LoopEngineeringConfig => ({
  ...defaultLoopEngineeringConfig,
  enabled: true,
  ...overrides,
});

const agentMessage = (text: string): ChatItem => ({
  id: 'a1',
  kind: 'agentMessage',
  text,
  detail: '',
  status: undefined,
  turnId: undefined,
  diffs: [],
});

const state = (items: ChatItem[]): ChatState => ({ ...initialChatState, items });

describe('appendLoopEngineeringInstruction', () => {
  it('無効なら本文を一字一句変えない', () => {
    const text = '次へ';
    expect(appendLoopEngineeringInstruction(text, config({ enabled: false }), 'initial')).toBe(
      text,
    );
  });

  it('設定そのものが無ければ本文を変えない', () => {
    expect(appendLoopEngineeringInstruction('次へ', undefined, 'continue')).toBe('次へ');
  });

  it('1回目は方針文を、2回目以降は継続用の短い文を空行区切りで連結する', () => {
    expect(appendLoopEngineeringInstruction('次へ', config(), 'initial')).toBe(
      `次へ\n\n${DEFAULT_LOOP_ENGINEERING_INITIAL_INSTRUCTION}`,
    );
    expect(appendLoopEngineeringInstruction('次へ', config(), 'continue')).toBe(
      `次へ\n\n${DEFAULT_LOOP_ENGINEERING_CONTINUE_INSTRUCTION}`,
    );
  });

  it('継続用の指示は方針文より短い（同じ長文を毎回送り直さない）', () => {
    expect(DEFAULT_LOOP_ENGINEERING_CONTINUE_INSTRUCTION.length).toBeLessThan(
      DEFAULT_LOOP_ENGINEERING_INITIAL_INSTRUCTION.length,
    );
  });

  it('その回に使う指示文が空なら連結しない（実質的な無効化）', () => {
    expect(
      appendLoopEngineeringInstruction('次へ', config({ initialInstruction: '' }), 'initial'),
    ).toBe('次へ');
    expect(
      appendLoopEngineeringInstruction('次へ', config({ continueInstruction: '   ' }), 'continue'),
    ).toBe('次へ');
  });

  it('本文が空なら指示文だけを本文にしない', () => {
    expect(appendLoopEngineeringInstruction('   ', config(), 'initial')).toBe('   ');
  });

  it('本文末尾の空白を畳んでから空行を入れる', () => {
    expect(appendLoopEngineeringInstruction('次へ\n\n\n', config(), 'continue')).toBe(
      `次へ\n\n${DEFAULT_LOOP_ENGINEERING_CONTINUE_INSTRUCTION}`,
    );
  });
});

describe('declaresEscalate', () => {
  it('最終行が合図と完全一致していれば成立する', () => {
    expect(declaresEscalate(state([agentMessage(`手が尽きた。\n${LOOP_ESCALATE_TOKEN}`)]))).toBe(
      true,
    );
  });

  it('前後の空白は無視する', () => {
    expect(declaresEscalate(state([agentMessage(`  ${LOOP_ESCALATE_TOKEN}  \n\n`)]))).toBe(true);
  });

  it('本文の途中に説明として現れただけでは成立しない', () => {
    // 指示文そのものが会話にこの綴りを含むため、includes判定だと誤停止する
    expect(
      declaresEscalate(
        state([agentMessage(`必要なら ${LOOP_ESCALATE_TOKEN} を返します。作業を続けます。`)]),
      ),
    ).toBe(false);
  });

  it('最終行に合図以外の文字が混ざっていれば成立しない', () => {
    expect(declaresEscalate(state([agentMessage(`${LOOP_ESCALATE_TOKEN} 理由: 権限がない`)]))).toBe(
      false,
    );
  });

  it('直近のエージェント発言だけを見る（古い発言の合図では成立しない）', () => {
    expect(
      declaresEscalate(state([agentMessage(LOOP_ESCALATE_TOKEN), agentMessage('続けます')])),
    ).toBe(false);
  });

  it('エージェントの発言が無ければ成立しない', () => {
    expect(declaresEscalate(state([]))).toBe(false);
  });
});
