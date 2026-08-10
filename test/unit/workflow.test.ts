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
