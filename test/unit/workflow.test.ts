import { describe, expect, it } from 'vitest';
import {
  clampAutoApprove,
  clampClaudePermissionMode,
  clampCodexApprovalMode,
  clampSandbox,
  expandTemplate,
  parseWorkflowYaml,
  validateWorkflow,
  type TaskResult,
  type WorkflowTask,
} from '../../src/orchestrator/workflow';

/** テストで頻出する最小構成のタスク。 */
const task = (overrides: Partial<WorkflowTask> = {}): WorkflowTask => ({
  id: 'T1',
  prompt: '作業する',
  done: '作業が終わっている',
  dependsOn: [],
  continuePrompt: '続けてください',
  maxIterations: 20,
  provider: 'codex',
  isolation: 'worktree',
  cwd: undefined,
  model: undefined,
  effort: undefined,
  approvalMode: undefined,
  sandbox: undefined,
  autoApprove: false,
  escalate: [],
  allow: [],
  retries: 0,
  cleanup: 'keep',
  parseErrors: [],
  parseWarnings: [],
  ...overrides,
});

describe('parseWorkflowYaml', () => {
  it('正常な定義を読み、既定値が解決された内部表現が得られる', () => {
    const yaml = `
version: 1
name: 認証機能の追加

defaults:
  provider: codex
  maxParallel: 3
  isolation: worktree
  autoApprove: true
  maxIterations: 20

tasks:
  - id: T1
    prompt: 設計する
    done: 設計が終わっている

  - id: T2
    dependsOn: [T1]
    provider: claude
    prompt: |
      設計に従い実装する。
      {{T1.result}}
    done: 実装が終わっている
`;
    const def = parseWorkflowYaml(yaml);
    expect(def.name).toBe('認証機能の追加');
    expect(def.maxParallel).toBe(3);
    expect(def.tasks).toHaveLength(2);

    const t1 = def.tasks[0];
    expect(t1?.id).toBe('T1');
    // defaultsが解決済みでタスクへ畳み込まれている（呼び出し側がdefaultsを見なくて済む）
    expect(t1?.provider).toBe('codex');
    expect(t1?.isolation).toBe('worktree');
    expect(t1?.maxIterations).toBe(20);
    expect(t1?.autoApprove).toBe(true);
    expect(t1?.continuePrompt).toBe('続けてください');
    expect(t1?.dependsOn).toEqual([]);

    const t2 = def.tasks[1];
    expect(t2?.provider).toBe('claude');
    expect(t2?.dependsOn).toEqual(['T1']);
    expect(t2?.prompt).toContain('{{T1.result}}');
  });

  it('未知のフィールドを含む定義が、エラーにならずに読める', () => {
    const yaml = `
version: 1
name: テスト
future: 未来のトップレベル項目

defaults:
  provider: codex
  futureDefault: 未来の既定項目

tasks:
  - id: T1
    prompt: 作業する
    done: 終わっている
    futureTaskField: 未来のタスク項目
`;
    expect(() => parseWorkflowYaml(yaml)).not.toThrow();
    const def = parseWorkflowYaml(yaml);
    expect(def.tasks).toHaveLength(1);
    expect(def.tasks[0]?.id).toBe('T1');
  });

  it('defaultsが省略されていれば組み込みの既定値を使う', () => {
    const yaml = `
version: 1
name: テスト
tasks:
  - id: T1
    prompt: 作業する
    done: 終わっている
`;
    const def = parseWorkflowYaml(yaml);
    expect(def.maxParallel).toBe(3);
    expect(def.tasks[0]?.provider).toBe('codex');
    expect(def.tasks[0]?.isolation).toBe('worktree');
    expect(def.tasks[0]?.cleanup).toBe('keep');
  });

  it('壊れたYAMLは例外を投げる', () => {
    expect(() => parseWorkflowYaml('invalid: [')).toThrow();
  });
});

describe('validateWorkflow', () => {
  it('idの重複がエラーになる', () => {
    const def = {
      version: 1,
      name: 'テスト',
      maxParallel: 3,
      tasks: [task({ id: 'T1' }), task({ id: 'T1' })],
    };
    const { errors } = validateWorkflow(def);
    expect(errors.some((e) => e.message.includes('重複') && e.taskIds.includes('T1'))).toBe(true);
  });

  it('dependsOnの未定義参照がエラーになる', () => {
    const def = {
      version: 1,
      name: 'テスト',
      maxParallel: 3,
      tasks: [task({ id: 'T1', dependsOn: ['存在しない'] })],
    };
    const { errors } = validateWorkflow(def);
    expect(errors.some((e) => e.message.includes('未定義') && e.taskIds.includes('T1'))).toBe(true);
  });

  it('doneの欠落がエラーになる', () => {
    const def = {
      version: 1,
      name: 'テスト',
      maxParallel: 3,
      tasks: [task({ id: 'T1', done: '' })],
    };
    const { errors } = validateWorkflow(def);
    expect(errors.some((e) => e.message.includes('done') && e.taskIds.includes('T1'))).toBe(true);
  });

  it('promptの欠落がエラーになる', () => {
    const def = {
      version: 1,
      name: 'テスト',
      maxParallel: 3,
      tasks: [task({ id: 'T1', prompt: '' })],
    };
    const { errors } = validateWorkflow(def);
    expect(errors.some((e) => e.message.includes('prompt') && e.taskIds.includes('T1'))).toBe(true);
  });

  it('maxParallel: 0 がエラーになる', () => {
    const def = { version: 1, name: 'テスト', maxParallel: 0, tasks: [task()] };
    const { errors } = validateWorkflow(def);
    expect(errors.some((e) => e.message.includes('maxParallel'))).toBe(true);
  });

  it('maxParallelが10を超えるとエラーになる', () => {
    const def = { version: 1, name: 'テスト', maxParallel: 11, tasks: [task()] };
    const { errors } = validateWorkflow(def);
    expect(errors.some((e) => e.message.includes('maxParallel'))).toBe(true);
  });

  it('上記の異常系が1回の呼び出しで全件まとめて返る', () => {
    const def = {
      version: 1,
      name: 'テスト',
      maxParallel: 0,
      tasks: [
        task({ id: 'T1' }),
        task({ id: 'T1' }), // 重複
        task({ id: 'T2', dependsOn: ['存在しない'] }), // 未定義参照
        task({ id: 'T3', done: '' }), // done欠落
      ],
    };
    const { errors } = validateWorkflow(def);
    expect(errors.length).toBeGreaterThanOrEqual(4);
    expect(errors.some((e) => e.message.includes('maxParallel'))).toBe(true);
    expect(errors.some((e) => e.message.includes('重複'))).toBe(true);
    expect(errors.some((e) => e.message.includes('未定義'))).toBe(true);
    expect(errors.some((e) => e.message.includes('done'))).toBe(true);
  });

  it('T1 → T2 → T1 の循環が、循環に含まれるidを示すエラーになる', () => {
    const def = {
      version: 1,
      name: 'テスト',
      maxParallel: 3,
      tasks: [task({ id: 'T1', dependsOn: ['T2'] }), task({ id: 'T2', dependsOn: ['T1'] })],
    };
    const { errors } = validateWorkflow(def);
    const cycleError = errors.find((e) => e.message.includes('循環'));
    expect(cycleError).toBeDefined();
    expect(cycleError?.taskIds).toEqual(expect.arrayContaining(['T1', 'T2']));
  });

  it('循環に無関係な下流タスクは循環エラーのidに含めない', () => {
    const def = {
      version: 1,
      name: 'テスト',
      maxParallel: 3,
      tasks: [
        task({ id: 'T1', dependsOn: ['T2'] }),
        task({ id: 'T2', dependsOn: ['T1'] }),
        task({ id: 'T3', dependsOn: ['T2'] }),
      ],
    };
    const { errors } = validateWorkflow(def);
    const cycleError = errors.find((e) => e.message.includes('循環'));
    expect(cycleError?.taskIds).not.toContain('T3');
  });

  it('依存に挙げていないタスクを参照した{{T3.result}}がエラーになる', () => {
    const def = {
      version: 1,
      name: 'テスト',
      maxParallel: 3,
      tasks: [
        task({ id: 'T1' }),
        task({ id: 'T2' }),
        task({ id: 'T3', dependsOn: ['T1'], prompt: '{{T2.result}}' }),
      ],
    };
    const { errors } = validateWorkflow(def);
    expect(errors.some((e) => e.taskIds.includes('T3') && e.message.includes('dependsOn'))).toBe(
      true,
    );
  });

  it('未定義のタスクを参照したテンプレート変数がエラーになる', () => {
    const def = {
      version: 1,
      name: 'テスト',
      maxParallel: 3,
      tasks: [task({ id: 'T1', prompt: '{{T9.result}}' })],
    };
    const { errors } = validateWorkflow(def);
    expect(errors.some((e) => e.taskIds.includes('T1') && e.message.includes('未定義'))).toBe(true);
  });

  it('未知のテンプレート変数フィールドがエラーになる', () => {
    const def = {
      version: 1,
      name: 'テスト',
      maxParallel: 3,
      tasks: [task({ id: 'T1' }), task({ id: 'T2', dependsOn: ['T1'], prompt: '{{T1.unknown}}' })],
    };
    const { errors } = validateWorkflow(def);
    expect(errors.some((e) => e.taskIds.includes('T2'))).toBe(true);
  });

  it.each(['../evil', '-x', 'a/b', 'あ', ''])('idが字種違反(%s)だとエラーになる', (badId) => {
    const def = { version: 1, name: 'テスト', maxParallel: 3, tasks: [task({ id: badId })] };
    const { errors } = validateWorkflow(def);
    expect(errors.some((e) => e.message.includes('id') && e.taskIds.includes(badId))).toBe(true);
  });

  it('idが51文字を超えるとエラーになる', () => {
    const badId = 'a'.repeat(51);
    const def = { version: 1, name: 'テスト', maxParallel: 3, tasks: [task({ id: badId })] };
    const { errors } = validateWorkflow(def);
    expect(errors.some((e) => e.taskIds.includes(badId))).toBe(true);
  });

  it('タスク総数が50を超えるとエラーになる', () => {
    const tasks = Array.from({ length: 51 }, (_, i) => task({ id: `T${i}` }));
    const def = { version: 1, name: 'テスト', maxParallel: 3, tasks };
    const { errors } = validateWorkflow(def);
    expect(errors.some((e) => e.message.includes('タスクの総数'))).toBe(true);
  });

  it('タスク総数が50以下ならエラーにならない', () => {
    const tasks = Array.from({ length: 50 }, (_, i) => task({ id: `T${i}` }));
    const def = { version: 1, name: 'テスト', maxParallel: 3, tasks };
    const { errors } = validateWorkflow(def);
    expect(errors.some((e) => e.message.includes('タスクの総数'))).toBe(false);
  });

  it('isolation: shared同士が依存関係の上で同時に走りうる場合は警告になる', () => {
    const def = {
      version: 1,
      name: 'テスト',
      maxParallel: 3,
      tasks: [task({ id: 'T1', isolation: 'shared' }), task({ id: 'T2', isolation: 'shared' })],
    };
    const { warnings, errors } = validateWorkflow(def);
    expect(errors).toEqual([]);
    expect(
      warnings.some(
        (w) => w.taskIds.includes('T1') && w.taskIds.includes('T2') && w.message.includes('shared'),
      ),
    ).toBe(true);
  });

  it('依存関係で順序が確定しているsharedタスク同士は警告にならない', () => {
    const def = {
      version: 1,
      name: 'テスト',
      maxParallel: 3,
      tasks: [
        task({ id: 'T1', isolation: 'shared' }),
        task({ id: 'T2', isolation: 'shared', dependsOn: ['T1'] }),
      ],
    };
    const { warnings } = validateWorkflow(def);
    expect(warnings).toEqual([]);
  });

  it('cwdを明示したsharedタスクは警告の対象から外れる', () => {
    const def = {
      version: 1,
      name: 'テスト',
      maxParallel: 3,
      tasks: [
        task({ id: 'T1', isolation: 'shared', cwd: '/repo/a' }),
        task({ id: 'T2', isolation: 'shared', cwd: '/repo/b' }),
      ],
    };
    const { warnings } = validateWorkflow(def);
    expect(warnings).toEqual([]);
  });

  it('正常な定義はエラーも警告も無い', () => {
    const def = {
      version: 1,
      name: 'テスト',
      maxParallel: 3,
      tasks: [task({ id: 'T1' }), task({ id: 'T2', dependsOn: ['T1'], prompt: '{{T1.result}}' })],
    };
    const { errors, warnings } = validateWorkflow(def);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('T1がT1自身に依存する自己参照の循環がエラーになる', () => {
    const def = {
      version: 1,
      name: 'テスト',
      maxParallel: 3,
      tasks: [task({ id: 'T1', dependsOn: ['T1'] })],
    };
    const { errors } = validateWorkflow(def);
    const cycleError = errors.find((e) => e.message.includes('循環'));
    expect(cycleError?.taskIds).toEqual(['T1']);
  });

  it('独立した2つの循環(A<->B, C<->D)が2件のエラーとして返る', () => {
    const def = {
      version: 1,
      name: 'テスト',
      maxParallel: 3,
      tasks: [
        task({ id: 'A', dependsOn: ['B'] }),
        task({ id: 'B', dependsOn: ['A'] }),
        task({ id: 'C', dependsOn: ['D'] }),
        task({ id: 'D', dependsOn: ['C'] }),
      ],
    };
    const { errors } = validateWorkflow(def);
    const cycleErrors = errors.filter((e) => e.message.includes('循環'));
    expect(cycleErrors).toHaveLength(2);
    expect(cycleErrors.some((e) => e.taskIds.includes('A') && e.taskIds.includes('B'))).toBe(true);
    expect(cycleErrors.some((e) => e.taskIds.includes('C') && e.taskIds.includes('D'))).toBe(true);
  });

  it('maxParallelが1でもエラーにならない', () => {
    const def = { version: 1, name: 'テスト', maxParallel: 1, tasks: [task()] };
    const { errors } = validateWorkflow(def);
    expect(errors.some((e) => e.message.includes('maxParallel'))).toBe(false);
  });

  it('maxParallelが10でもエラーにならない', () => {
    const def = { version: 1, name: 'テスト', maxParallel: 10, tasks: [task()] };
    const { errors } = validateWorkflow(def);
    expect(errors.some((e) => e.message.includes('maxParallel'))).toBe(false);
  });

  it('idがちょうど50文字ならエラーにならない', () => {
    const id = 'a'.repeat(50);
    const def = { version: 1, name: 'テスト', maxParallel: 3, tasks: [task({ id })] };
    const { errors } = validateWorkflow(def);
    expect(errors.some((e) => e.taskIds.includes(id))).toBe(false);
  });

  it('依存関係が3段以上でもsharedの警告が出ない', () => {
    const def = {
      version: 1,
      name: 'テスト',
      maxParallel: 3,
      tasks: [
        task({ id: 'T1', isolation: 'shared' }),
        task({ id: 'T2', isolation: 'shared', dependsOn: ['T1'] }),
        task({ id: 'T3', isolation: 'shared', dependsOn: ['T2'] }),
      ],
    };
    const { warnings } = validateWorkflow(def);
    expect(warnings).toEqual([]);
  });

  it('tasksが0件だとエラーになる', () => {
    const def = { version: 1, name: 'テスト', maxParallel: 3, tasks: [] };
    const { errors } = validateWorkflow(def);
    expect(errors.some((e) => e.message.includes('tasks'))).toBe(true);
  });

  it('tasksが配列でない定義は0件扱いでエラーになる', () => {
    const yaml = `
version: 1
name: テスト
tasks: 配列ではない値
`;
    const def = parseWorkflowYaml(yaml);
    const { errors } = validateWorkflow(def);
    expect(errors.some((e) => e.message.includes('tasks'))).toBe(true);
  });

  it('dependsOnが配列でない(書き忘れ)場合はエラーになる', () => {
    const yaml = `
version: 1
name: テスト
tasks:
  - id: T1
    prompt: 作業する
    done: 終わっている
  - id: T2
    dependsOn: T1
    prompt: 作業する
    done: 終わっている
`;
    const def = parseWorkflowYaml(yaml);
    const { errors } = validateWorkflow(def);
    expect(errors.some((e) => e.taskIds.includes('T2') && e.message.includes('dependsOn'))).toBe(
      true,
    );
  });

  it('idの大文字小文字だけが違う重複がエラーになる', () => {
    const def = {
      version: 1,
      name: 'テスト',
      maxParallel: 3,
      tasks: [task({ id: 'T1' }), task({ id: 't1' })],
    };
    const { errors } = validateWorkflow(def);
    expect(
      errors.some(
        (e) =>
          e.message.includes('大文字小文字') &&
          e.taskIds.includes('T1') &&
          e.taskIds.includes('t1'),
      ),
    ).toBe(true);
  });

  it('retriesが上限(10)を超えるとエラーになる', () => {
    const def = { version: 1, name: 'テスト', maxParallel: 3, tasks: [task({ retries: 11 })] };
    const { errors } = validateWorkflow(def);
    expect(errors.some((e) => e.message.includes('retries') && e.taskIds.includes('T1'))).toBe(
      true,
    );
  });

  it.each([0, 201])('maxIterationsが範囲外(%i)だとエラーになる', (maxIterations) => {
    const def = { version: 1, name: 'テスト', maxParallel: 3, tasks: [task({ maxIterations })] };
    const { errors } = validateWorkflow(def);
    expect(
      errors.some((e) => e.message.includes('maxIterations') && e.taskIds.includes('T1')),
    ).toBe(true);
  });

  it('Claudeタスクのapproval Modeがbypass Permissionsだとエラーになる', () => {
    const def = {
      version: 1,
      name: 'テスト',
      maxParallel: 3,
      tasks: [task({ provider: 'claude', approvalMode: 'bypassPermissions' })],
    };
    const { errors } = validateWorkflow(def);
    expect(
      errors.some((e) => e.message.includes('bypassPermissions') && e.taskIds.includes('T1')),
    ).toBe(true);
  });

  it.each(['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'com9', 'LPT1', 'lpt9'])(
    'idがWindowsの予約デバイス名(%s)だとエラーになる',
    (badId) => {
      const def = { version: 1, name: 'テスト', maxParallel: 3, tasks: [task({ id: badId })] };
      const { errors } = validateWorkflow(def);
      expect(errors.some((e) => e.taskIds.includes(badId))).toBe(true);
    },
  );

  it('idが"-retry<数字>"で終わっているとエラーになる', () => {
    const def = { version: 1, name: 'テスト', maxParallel: 3, tasks: [task({ id: 'T1-retry2' })] };
    const { errors } = validateWorkflow(def);
    expect(errors.some((e) => e.taskIds.includes('T1-retry2') && e.message.includes('retry'))).toBe(
      true,
    );
  });

  it.each(['prompt', 'done', 'continuePrompt'] as const)('%sが長すぎるとエラーになる', (field) => {
    const tooLong = 'a'.repeat(20001);
    const def = {
      version: 1,
      name: 'テスト',
      maxParallel: 3,
      tasks: [task({ [field]: tooLong })],
    };
    const { errors } = validateWorkflow(def);
    expect(errors.some((e) => e.message.includes(field) && e.taskIds.includes('T1'))).toBe(true);
  });

  it('providerに未知の値が指定されていると警告になる', () => {
    const yaml = `
version: 1
name: テスト
tasks:
  - id: T1
    provider: unknown-provider
    prompt: 作業する
    done: 終わっている
`;
    const def = parseWorkflowYaml(yaml);
    const { warnings } = validateWorkflow(def);
    expect(warnings.some((w) => w.taskIds.includes('T1') && w.message.includes('provider'))).toBe(
      true,
    );
  });

  it('isolationに未知の値が指定されていると警告になる', () => {
    const yaml = `
version: 1
name: テスト
tasks:
  - id: T1
    isolation: Worktree-Strict
    prompt: 作業する
    done: 終わっている
`;
    const def = parseWorkflowYaml(yaml);
    const { warnings } = validateWorkflow(def);
    expect(warnings.some((w) => w.taskIds.includes('T1') && w.message.includes('isolation'))).toBe(
      true,
    );
  });

  it('defaults.cleanupに未知の値が指定されていると警告になる', () => {
    const yaml = `
version: 1
name: テスト
defaults:
  cleanup: totally-invalid
tasks:
  - id: T1
    prompt: 作業する
    done: 終わっている
`;
    const def = parseWorkflowYaml(yaml);
    const { warnings } = validateWorkflow(def);
    expect(warnings.some((w) => w.message.includes('cleanup'))).toBe(true);
  });

  it('provider/isolationが未指定(空文字)なら警告にならない', () => {
    const yaml = `
version: 1
name: テスト
tasks:
  - id: T1
    prompt: 作業する
    done: 終わっている
`;
    const def = parseWorkflowYaml(yaml);
    const { warnings } = validateWorkflow(def);
    expect(warnings).toEqual([]);
  });

  it('escalateに文字列でない要素が混ざっていると警告になる', () => {
    const yaml = `
version: 1
name: テスト
tasks:
  - id: T1
    prompt: 作業する
    done: 終わっている
    escalate: ["git push", 123]
`;
    const def = parseWorkflowYaml(yaml);
    const { warnings } = validateWorkflow(def);
    expect(warnings.some((w) => w.taskIds.includes('T1') && w.message.includes('escalate'))).toBe(
      true,
    );
  });

  it('dependsOnに文字列でない要素が混ざっていると警告になる', () => {
    const yaml = `
version: 1
name: テスト
tasks:
  - id: T1
    prompt: 作業する
    done: 終わっている
  - id: T2
    dependsOn: [T1, 456]
    prompt: 作業する
    done: 終わっている
`;
    const def = parseWorkflowYaml(yaml);
    const { warnings } = validateWorkflow(def);
    expect(warnings.some((w) => w.taskIds.includes('T2') && w.message.includes('dependsOn'))).toBe(
      true,
    );
  });

  it('allowに文字列でない要素が混ざっていると警告になる', () => {
    const yaml = `
version: 1
name: テスト
tasks:
  - id: T1
    prompt: 作業する
    done: 終わっている
    allow: [true, "npm test"]
`;
    const def = parseWorkflowYaml(yaml);
    const { warnings } = validateWorkflow(def);
    expect(warnings.some((w) => w.taskIds.includes('T1') && w.message.includes('allow'))).toBe(
      true,
    );
  });
});

describe('expandTemplate', () => {
  const results = new Map<string, TaskResult>([
    [
      'T1',
      { result: '設計を書いた', cwd: '/repo/wt/T1', branch: 'wf/run1/T1', files: ['a.md', 'b.md'] },
    ],
    ['T2', { result: '', cwd: '/repo/wt/T2', branch: '', files: [] }],
  ]);

  it('値のあるものだけを差し替え、他の文字列を壊さない', () => {
    const text = '前置き {{T1.result}} 後書き。パス: {{T1.cwd}}';
    expect(expandTemplate(text, results)).toBe('前置き 設計を書いた 後書き。パス: /repo/wt/T1');
  });

  it('branchとfilesも展開する', () => {
    expect(expandTemplate('{{T1.branch}}', results)).toBe('wf/run1/T1');
    expect(expandTemplate('{{T1.files}}', results)).toBe('a.md\nb.md');
  });

  it('値が空文字のタスクは空文字を差し込む', () => {
    expect(expandTemplate('結果: [{{T2.result}}]', results)).toBe('結果: []');
  });

  it('未完了（対応表に無い）タスクの参照は空文字を差し込む', () => {
    expect(expandTemplate('[{{T3.result}}]', results)).toBe('[]');
  });

  it('波括弧2つで囲まれていない文字列は変えない', () => {
    const text = '{T1.result} と {{{T1.result}}} と単なる{文字列}';
    expect(expandTemplate(text, results)).toBe('{T1.result} と {設計を書いた} と単なる{文字列}');
  });

  it('テンプレート変数以外の内容を壊さない', () => {
    const text = 'JSONっぽい文字列: {"key": "value"} は変わらない';
    expect(expandTemplate(text, results)).toBe(text);
  });
});

describe('clampSandbox', () => {
  it('拡張機能の設定より緩める指定は無視され警告が出る', () => {
    const result = clampSandbox('workspace-write', 'danger-full-access');
    expect(result.value).toBe('workspace-write');
    expect(result.warning).toBeDefined();
  });

  it('拡張機能の設定より絞る指定は通る', () => {
    const result = clampSandbox('workspace-write', 'read-only');
    expect(result.value).toBe('read-only');
    expect(result.warning).toBeUndefined();
  });

  it('YAML側が未指定なら拡張機能側をそのまま使う', () => {
    const result = clampSandbox('workspace-write', '');
    expect(result.value).toBe('workspace-write');
    expect(result.warning).toBeUndefined();
  });

  it('拡張機能とYAMLが同じ値なら警告が出ない', () => {
    const result = clampSandbox('workspace-write', 'workspace-write');
    expect(result.value).toBe('workspace-write');
    expect(result.warning).toBeUndefined();
  });
});

describe('clampCodexApprovalMode', () => {
  it('拡張機能がon-requestのときYAMLのneverはon-requestに留める', () => {
    const result = clampCodexApprovalMode('on-request', 'never');
    expect(result.value).toBe('on-request');
    expect(result.warning).toBeDefined();
  });

  it('拡張機能がon-requestのときYAMLのuntrustedは通る', () => {
    const result = clampCodexApprovalMode('on-request', 'untrusted');
    expect(result.value).toBe('untrusted');
    expect(result.warning).toBeUndefined();
  });
});

describe('clampClaudePermissionMode', () => {
  it('拡張機能がmanualのときYAMLのbypassPermissionsは無視される', () => {
    const result = clampClaudePermissionMode('manual', 'bypassPermissions');
    expect(result.value).toBe('manual');
    expect(result.warning).toBeDefined();
  });

  it('拡張機能がmanualのときYAMLのplanは通る', () => {
    const result = clampClaudePermissionMode('manual', 'plan');
    expect(result.value).toBe('plan');
    expect(result.warning).toBeUndefined();
  });

  it('拡張機能がdontAskのときYAMLのacceptEditsはdontAskのまま維持され警告が出る', () => {
    // dontAskは安全順序表に含めていない（他のモードと一次元で比較できないため）。
    // 拡張機能側がdontAskのとき、YAML側の値は安全性を判定できないものとして無視し、
    // 拡張機能側の値(dontAsk)をそのまま維持する。
    const result = clampClaudePermissionMode('dontAsk', 'acceptEdits');
    expect(result.value).toBe('dontAsk');
    expect(result.warning).toBeDefined();
  });

  it('拡張機能がmanualのときYAMLのdontAskはmanualのまま維持され警告が出る', () => {
    const result = clampClaudePermissionMode('manual', 'dontAsk');
    expect(result.value).toBe('manual');
    expect(result.warning).toBeDefined();
  });
});

describe('clampAutoApprove', () => {
  it('allowAutoApproveが有効ならtrueを維持する', () => {
    const result = clampAutoApprove(true, true);
    expect(result.value).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  it('autoApprove: trueがallowAutoApprove: falseのとき無効化される', () => {
    const result = clampAutoApprove(true, false);
    expect(result.value).toBe(false);
    expect(result.warning).toBeDefined();
  });

  it('falseの指定はallowAutoApproveに関わらずそのまま通る', () => {
    const result = clampAutoApprove(false, false);
    expect(result.value).toBe(false);
    expect(result.warning).toBeUndefined();
  });
});
