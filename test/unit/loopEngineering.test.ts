import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatItem } from '../../src/appserver/chatState';
import {
  appendLoopEngineeringInstruction,
  declaresEscalate,
  defaultLoopEngineeringConfig,
  DEFAULT_LOOP_ENGINEERING_CONTINUE_INSTRUCTION,
  DEFAULT_LOOP_ENGINEERING_INITIAL_INSTRUCTION,
  agentMessageFinalLine,
  lastAgentMessage,
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
    expect(declaresEscalate(agentMessage(`手が尽きた。\n${LOOP_ESCALATE_TOKEN}`))).toBe(true);
  });

  it('前後の空白は無視する', () => {
    expect(declaresEscalate(agentMessage(`  ${LOOP_ESCALATE_TOKEN}  \n\n`))).toBe(true);
  });

  it('本文の途中に説明として現れただけでは成立しない', () => {
    // 指示文そのものが会話にこの綴りを含むため、includes判定だと誤停止する
    expect(
      declaresEscalate(
        agentMessage(`必要なら ${LOOP_ESCALATE_TOKEN} を返します。作業を続けます。`),
      ),
    ).toBe(false);
  });

  it('最終行に合図以外の文字が混ざっていれば成立しない', () => {
    expect(declaresEscalate(agentMessage(`${LOOP_ESCALATE_TOKEN} 理由: 権限がない`))).toBe(false);
  });

  it('本文が空なら成立しない', () => {
    expect(declaresEscalate(agentMessage('   '))).toBe(false);
  });

  it('エージェントの発言以外を渡されても成立しない（issue #937）', () => {
    const command: ChatItem = {
      ...agentMessage(LOOP_ESCALATE_TOKEN),
      id: 'c1',
      kind: 'commandExecution',
    };
    expect(declaresEscalate(command)).toBe(false);
  });
});

describe('agentMessageFinalLine', () => {
  it('最後の非空行を前後の空白を除いて返す', () => {
    expect(agentMessageFinalLine(agentMessage('1行目\n  結び  \n\n'))).toBe('結び');
  });

  it('本文が空白だけならundefined', () => {
    expect(agentMessageFinalLine(agentMessage('  \n\n'))).toBeUndefined();
  });

  it('エージェントの発言以外はundefined', () => {
    expect(
      agentMessageFinalLine({ ...agentMessage('結び'), id: 'c1', kind: 'commandExecution' }),
    ).toBeUndefined();
  });
});

describe('lastAgentMessage', () => {
  it('末尾から数えて最初のエージェント発言を返す', () => {
    expect(
      lastAgentMessage([agentMessage('古い'), { ...agentMessage('新しい'), id: 'a2' }])?.text,
    ).toBe('新しい');
  });

  it('応答の後ろにコマンド実行の項目が並んでいても、その応答を返す（issue #914）', () => {
    // 見るのは配列の最後の項目ではなく、最後の`agentMessage`
    const command: ChatItem = {
      ...agentMessage(''),
      id: 'c1',
      kind: 'commandExecution',
      detail: 'npm test',
    };
    expect(lastAgentMessage([agentMessage(LOOP_ESCALATE_TOKEN), command])?.text).toBe(
      LOOP_ESCALATE_TOKEN,
    );
  });

  it('エージェントの発言が無ければundefined', () => {
    expect(lastAgentMessage([])).toBeUndefined();
  });
});

describe('既定の指示文', () => {
  /**
   * 既定値は`package.json`の`contributes.configuration`とこのモジュールの定数の
   * 両方にリテラルで持っている。**実際に使われるのは`package.json`側**
   * （`workspace.getConfiguration().get()`が返すのはそちら）で、モジュール側の定数は
   * 設定を読めなかったときのフォールバックとテストの期待値になる。片方だけ直すと
   * 「テストは通るのに実際に送られる文面が違う」が起きるため、機械的に突き合わせる。
   */
  const configuredDefault = (key: string): unknown => {
    const raw = readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8');
    const parsed = JSON.parse(raw) as {
      contributes: { configuration: { properties: Record<string, { default?: unknown }> } };
    };
    return parsed.contributes.configuration.properties[key]?.default;
  };

  it('package.jsonの既定値とモジュールの定数が一致する', () => {
    expect(configuredDefault('agent.chat.loopEngineering.initialInstruction')).toBe(
      DEFAULT_LOOP_ENGINEERING_INITIAL_INSTRUCTION,
    );
    expect(configuredDefault('agent.chat.loopEngineering.continueInstruction')).toBe(
      DEFAULT_LOOP_ENGINEERING_CONTINUE_INSTRUCTION,
    );
  });

  it('モードの既定は無効', () => {
    expect(configuredDefault('agent.chat.loopEngineering.enabled')).toBe(false);
    expect(defaultLoopEngineeringConfig.enabled).toBe(false);
  });

  it('既定の指示文はどちらも撤退の合図を含む', () => {
    // 合図を教えるのは指示文だけなので、文面から落ちるとescalateが起きなくなる
    expect(DEFAULT_LOOP_ENGINEERING_INITIAL_INSTRUCTION).toContain(LOOP_ESCALATE_TOKEN);
    expect(DEFAULT_LOOP_ENGINEERING_CONTINUE_INSTRUCTION).toContain(LOOP_ESCALATE_TOKEN);
  });
});
