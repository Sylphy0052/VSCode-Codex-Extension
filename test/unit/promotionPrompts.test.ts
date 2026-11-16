import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { appendChatPromotedGuidance, CHAT_PROMOTED_GUIDANCE } from '../../src/chat/chatPrompts';
import {
  composeTaskExecutionContract,
  composeTaskExecutionContractReference,
  formatTaskExecutionContract,
} from '../../src/orchestrator/runner';
import {
  hashChatPrompts,
  hashPromptsForKind,
  hashStagePrompts,
  hashWorkflowPrompts,
} from '../../src/orchestrator/runMetricsStore';
import {
  PROMOTION_TARGET_FILE,
  PROMOTION_TARGET_FILES,
  promotionTargetFile,
} from '../../src/orchestrator/runRetrospective';
import { parseProtectedPaths, findProtectedTouches } from '../../src/orchestrator/selfImproveGuard';
import { parseWorkflowYaml } from '../../src/orchestrator/workflow';
import {
  formatWorkflowPromotedGuidance,
  WORKFLOW_PROMOTED_GUIDANCE,
} from '../../src/orchestrator/workflowPrompts';
import { appendManualSendInstructions } from '../../src/view/prosCons';

/**
 * Issue #2121: 共通プロンプトを定型文ファイルへ切り出す前後で、ワークフローのノード・通常チャットへ
 * 渡る文字列が変わらないことを、切り出し前の文字列をリテラルで持って確かめる。
 */

const ROOT = path.resolve(__dirname, '../..');

function workflow(withIssue: boolean) {
  return parseWorkflowYaml(
    [
      'version: 1',
      'name: テスト',
      'goal: 全体のゴール',
      'acceptance:',
      '  - 受入1',
      'tasks:',
      '  - id: T1',
      '    prompt: 作業する',
      '    outcome: 成果1',
      '    outputs:',
      '      - out1',
      ...(withIssue ? ['    issue: 42'] : []),
      '  - id: T2',
      '    prompt: 続きをする',
      '    dependsOn: [T1]',
      '',
    ].join('\n'),
  );
}

// 切り出し前（runner.tsに直書きだった頃）の文字列
const CONTRACT_WITH_ISSUE = [
  '## 実行契約',
  '### 全体ゴール',
  '全体のゴール',
  '',
  '### 全体の受入条件',
  '- 受入1',
  '',
  '### Issueを正本にした開発手順',
  '- Issue #42の本文（受入条件・実装計画）を、このタスクのSpecの正本として扱う。',
  '- 実装の完了を宣言する前に、Issueの受入条件と実装計画に照らして成果を確認する。',
  '- このタスクは実装・検証結果を報告して完了する。runnerが設定済みのPR/MR作成、独立レビュー、修正・再レビュー、マージ、cleanupを後続処理として実行する。',
  '- runnerの後続処理の対象外となる工程（sharedタスク、またはPR/MR・レビューが無効な設定）は省略せず、このタスクが既存の開発手順に従って実施結果を報告する。',
  '- Issueの作成・更新とロードマップ改訂は実行タスクでは扱わない。必要な変更はオーケストレーターへ報告し、runnerがcleanup結果をオーケストレーターへ渡す。',
  '',
  '### このタスクの成果',
  '成果1',
  '',
  '### 成果物',
  '- out1',
].join('\n');

const REFERENCE_PREFIX = ['## 実行契約（参照）', 'Contract: T1 / sha256:'].join('\n');
const REFERENCE_SENTENCE =
  'このスレッドの最初の指示に全文を載せた実行契約は変わっていない。全体ゴール・受入条件・前提・対象外・成果物・依存タスクから受け取る成果は、その全文のとおりに守って続行する。';

describe('ワークフローのノードへ渡る文字列（Issue #2121）', () => {
  it('昇格した教訓が空のうちは、実行契約が切り出し前と一字一句同じ', () => {
    expect(WORKFLOW_PROMOTED_GUIDANCE).toEqual([]);
    const def = workflow(true);
    const task = def.tasks[0]!;
    expect(formatTaskExecutionContract(def, task)).toBe(CONTRACT_WITH_ISSUE);
    expect(composeTaskExecutionContract(def, task, '作業する')).toBe(
      `${CONTRACT_WITH_ISSUE}\n\n## 今回の指示\n作業する`,
    );
  });

  it('依存タスクのある契約も切り出し前と同じ', () => {
    const def = workflow(false);
    const t2 = def.tasks[1]!;
    expect(formatTaskExecutionContract(def, t2)).toBe(
      [
        '## 実行契約',
        '### 全体ゴール',
        '全体のゴール',
        '',
        '### 全体の受入条件',
        '- 受入1',
        '',
        '### 依存タスクから受け取る成果',
        '- T1: 成果1',
        '  - 成果物: out1',
      ].join('\n'),
    );
  });

  it('継続ターンの参照文も切り出し前と同じ', () => {
    expect(composeTaskExecutionContractReference('T1', 'abc', '続ける')).toBe(
      `${REFERENCE_PREFIX}abc\n${REFERENCE_SENTENCE}\n\n## 今回の指示\n続ける`,
    );
  });

  it('昇格した教訓があれば、実行契約の末尾へ定型の指示として足す', () => {
    expect(formatWorkflowPromotedGuidance(['文1', '文2'])).toEqual([
      '### 定型の指示',
      '- 文1',
      '- 文2',
      '',
    ]);
    expect(formatWorkflowPromotedGuidance()).toEqual([]);
  });
});

describe('通常チャットへ渡る文字列（Issue #2121）', () => {
  const off = { enabled: false, instruction: 'x' };
  const on = (instruction: string) => ({ enabled: true, instruction });

  it('昇格した教訓が空のうちは、手動送信の文字列が切り出し前と同じ', () => {
    expect(CHAT_PROMOTED_GUIDANCE).toEqual([]);
    expect(appendManualSendInstructions('本文', off, off)).toBe('本文');
    expect(appendManualSendInstructions('本文\n', on('メリデメ'), on('要約'))).toBe(
      '本文\n\nメリデメ\n\n要約',
    );
    expect(appendManualSendInstructions('  ', on('メリデメ'), on('要約'))).toBe('  ');
  });

  it('昇格した教訓は本文の直後に足し、空の発言には足さない', () => {
    expect(appendChatPromotedGuidance('本文\n', ['文1', '文2'])).toBe('本文\n\n文1\n文2');
    expect(appendChatPromotedGuidance(' ', ['文1'])).toBe(' ');
    expect(appendChatPromotedGuidance('本文\n')).toBe('本文\n');
  });
});

describe('プロンプトのハッシュ（Issue #2121）', () => {
  it('定型文が同じなら同じ値、定型文が変われば別の値', () => {
    expect(hashWorkflowPrompts()).toBe(hashWorkflowPrompts([]));
    expect(hashWorkflowPrompts(['文1'])).not.toBe(hashWorkflowPrompts());
    expect(hashChatPrompts()).toBe(hashChatPrompts([]));
    expect(hashChatPrompts(['文1'])).not.toBe(hashChatPrompts());
  });

  it('種別ごとにハッシュを引ける。taskは工程プロンプトのハッシュのまま', () => {
    expect(hashPromptsForKind('task')).toBe(hashStagePrompts());
    expect(hashPromptsForKind('workflow')).toBe(hashWorkflowPrompts());
    expect(hashPromptsForKind('chat')).toBe(hashChatPrompts());
    expect(new Set([hashStagePrompts(), hashWorkflowPrompts(), hashChatPrompts()]).size).toBe(3);
  });
});

describe('昇格先と保護パス（Issue #2121）', () => {
  it('種別ごとの昇格先が引け、taskは今のtaskStagePrompts.tsのまま', () => {
    expect(PROMOTION_TARGET_FILE).toBe('src/orchestrator/taskStagePrompts.ts');
    expect(promotionTargetFile('task')).toBe('src/orchestrator/taskStagePrompts.ts');
    expect(promotionTargetFile('workflow')).toBe('src/orchestrator/workflowPrompts.ts');
    expect(promotionTargetFile('chat')).toBe('src/chat/chatPrompts.ts');
  });

  it('昇格先は保護パスに入らず、ハッシュ関数を置くファイルは保護パスに入る', () => {
    const patterns = parseProtectedPaths(
      readFileSync(path.join(ROOT, '.github/self-improve-protected-paths'), 'utf8'),
    );
    const targets = Object.values(PROMOTION_TARGET_FILES);
    for (const file of targets) {
      expect(readFileSync(path.join(ROOT, file), 'utf8').length).toBeGreaterThan(0);
    }
    expect(findProtectedTouches(targets, patterns)).toEqual([]);
    expect(findProtectedTouches(['src/orchestrator/runMetricsStore.ts'], patterns)).toEqual([
      'src/orchestrator/runMetricsStore.ts',
    ]);
  });
});
