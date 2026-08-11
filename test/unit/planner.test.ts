import { describe, expect, it } from 'vitest';
import {
  initialChatState,
  type ChatState,
  type PendingApproval,
} from '../../src/appserver/chatState';
import {
  LOOP_ITERATION_LIMIT,
  type LoopPlan,
  type LoopStopReason,
} from '../../src/loop/loopController';
import type { Logger } from '../../src/log';
import type { ExtensionSafetyBaseline } from '../../src/orchestrator/taskConfig';
import type {
  ApprovalHandler,
  TaskSession,
  TaskSessionHost,
  TaskSessionInput,
} from '../../src/orchestrator/taskSession';
import {
  buildPlannerPrompt,
  buildWorkspaceSummary,
  detectSecurityWarnings,
  extractYamlFromResponse,
  locateSecurityWarningLine,
  planWorkflow,
  resolveUniqueFileName,
  slugifyGoal,
  type PlannerWorkspacePort,
} from '../../src/orchestrator/planner';
import {
  CLEANUP_MODES,
  DEFAULT_AUTO_APPROVE,
  DEFAULT_CLEANUP,
  DEFAULT_CONTINUE_PROMPT,
  DEFAULT_ISOLATION,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MAX_PARALLEL,
  DEFAULT_PROVIDER,
  ISOLATIONS,
  MAX_PARALLEL_MAX,
  MAX_PARALLEL_MIN,
  MAX_PROMPT_LENGTH,
  MAX_RETRIES,
  MAX_TASK_COUNT,
  PROVIDERS,
  TASK_ID_PATTERN,
  TEMPLATE_FIELDS,
  parseWorkflowYaml,
  validateWorkflow,
} from '../../src/orchestrator/workflow';

/**
 * `planner.ts`（design.md §16.9）のテスト。
 *
 * セッションは`TaskSessionHost`のフェイクに差し替え、実際のCLIは一切起動しない。
 */

const fakeLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  show: () => undefined,
};

const baseline: ExtensionSafetyBaseline = {
  codexSandbox: 'workspace-write',
  codexApprovalMode: 'on-request',
  claudePermissionMode: 'acceptEdits',
  allowAutoApprove: false,
};

const VALID_YAML = [
  'version: 1',
  'name: サンプル',
  'tasks:',
  '  - id: T1',
  '    prompt: 何かする',
  '    done: 終わっている',
].join('\n');

const INVALID_YAML = [
  'version: 1',
  'name: サンプル',
  'tasks:',
  '  - id: T1',
  '    prompt: 何かする',
].join('\n');

class FakePlannerSession implements TaskSession {
  readonly sessionId = 'planner-fake-session';
  approvalHandler: ApprovalHandler | undefined;
  runLoopCalls: LoopPlan[] = [];
  openCalls: Array<{ preserveFocus: boolean }> = [];
  disposed = false;
  private finishedListener: ((reason: LoopStopReason, state: ChatState) => void) | undefined;

  constructor(private readonly responseText: string) {}

  runLoop(plan: LoopPlan): void {
    this.runLoopCalls.push(plan);
    // フェイクなのでCLIは起動しない。登録済みのリスナーへ即座に1ターン分の応答を返す
    this.finishedListener?.('maxReached', {
      ...initialChatState,
      turnResultText: this.responseText,
    });
  }
  setPromptTransform(): void {}
  onFinished(listener: (reason: LoopStopReason, state: ChatState) => void): void {
    this.finishedListener = listener;
  }
  onStateChanged(): void {}
  setApprovalHandler(handler: ApprovalHandler): void {
    this.approvalHandler = handler;
  }
  onApprovalResolved(): void {}
  async interrupt(): Promise<void> {}
  stopLoop(): void {}
  decideApproval(): void {}
  reveal(): void {}
  open(options: { preserveFocus: boolean }): void {
    this.openCalls.push(options);
  }
  dispose(): void {
    this.disposed = true;
  }
}

class FakePlannerHost implements TaskSessionHost {
  openCalls: TaskSessionInput[] = [];
  sessions: FakePlannerSession[] = [];
  private index = 0;
  constructor(private readonly responses: readonly string[]) {}

  async openTaskSession(input: TaskSessionInput): Promise<TaskSession> {
    this.openCalls.push(input);
    const text = this.responses[this.index] ?? this.responses[this.responses.length - 1] ?? '';
    this.index += 1;
    const session = new FakePlannerSession(text);
    this.sessions.push(session);
    return session;
  }
}

const fakeApproval: PendingApproval = {
  requestId: 1,
  kind: 'command',
  title: 'rm -rf /',
  detail: '',
  itemId: undefined,
};

describe('buildPlannerPrompt（design.md §16.9）', () => {
  it('ゴール・ワークスペース情報・スキーマの説明を含む', () => {
    const prompt = buildPlannerPrompt({
      goal: '認証機能を追加してテストとレビューまで終える',
      workspaceSummary: {
        topLevelEntries: ['src/', 'package.json'],
        hasAgentsMd: true,
        hasClaudeMd: false,
      },
    });

    expect(prompt).toContain('認証機能を追加してテストとレビューまで終える');
    expect(prompt).toContain('src/');
    expect(prompt).toContain('AGENTS.md: あり');
    expect(prompt).toContain('CLAUDE.md: なし');
    expect(prompt).toContain('出力はYAMLのみ');

    // 必須フィールド名（手で書いた表の記載漏れを検出する）
    for (const field of ['id', 'prompt', 'done', 'dependsOn', 'autoApprove', 'allow']) {
      expect(prompt).toContain(field);
    }

    // workflow.tsの定数から生成している部分。定数側が変わっても、同じ定数を
    // importしているこのテストは追従するため、ここでは「値そのもの」ではなく
    // 「今のworkflow.tsの値が含まれているか」を確認する（二重管理を避ける設計の検証）
    for (const p of PROVIDERS) expect(prompt).toContain(p);
    for (const iso of ISOLATIONS) expect(prompt).toContain(iso);
    for (const c of CLEANUP_MODES) expect(prompt).toContain(c);
    for (const f of TEMPLATE_FIELDS) expect(prompt).toContain(f);
    expect(prompt).toContain(String(MAX_TASK_COUNT));
    expect(prompt).toContain(String(MAX_PROMPT_LENGTH));
    expect(prompt).toContain(String(MAX_RETRIES));
    expect(prompt).toContain(String(LOOP_ITERATION_LIMIT));
    expect(prompt).toContain(String(MAX_PARALLEL_MIN));
    expect(prompt).toContain(String(MAX_PARALLEL_MAX));
    expect(prompt).toContain(DEFAULT_PROVIDER);
    expect(prompt).toContain(DEFAULT_ISOLATION);
    expect(prompt).toContain(DEFAULT_CLEANUP);
    expect(prompt).toContain(DEFAULT_CONTINUE_PROMPT);
    expect(prompt).toContain(String(DEFAULT_MAX_PARALLEL));
    expect(prompt).toContain(String(DEFAULT_MAX_ITERATIONS));
    expect(prompt).toContain(String(DEFAULT_AUTO_APPROVE));
    expect(prompt).toContain(TASK_ID_PATTERN.source);
  });

  it('ワークスペース情報が空でも組み立てられる', () => {
    const prompt = buildPlannerPrompt({
      goal: 'ゴール',
      workspaceSummary: { topLevelEntries: [], hasAgentsMd: false, hasClaudeMd: false },
    });
    expect(prompt).toContain('取得できませんでした');
  });
});

describe('buildWorkspaceSummary', () => {
  it('列挙とAGENTS.md/CLAUDE.mdの有無をまとめる', async () => {
    const port: PlannerWorkspacePort = {
      listTopLevelEntries: async () => ['src/', 'package.json'],
      fileExists: async (p) => p.endsWith('AGENTS.md'),
    };
    const summary = await buildWorkspaceSummary('/repo', port);
    expect(summary.topLevelEntries).toEqual(['src/', 'package.json']);
    expect(summary.hasAgentsMd).toBe(true);
    expect(summary.hasClaudeMd).toBe(false);
  });
});

describe('extractYamlFromResponse（design.md §16.9「剥がしてからパーサへ渡す」）', () => {
  it('コードフェンス付きの応答から中身だけを取り出せる', () => {
    const response = ['はい、以下がワークフロー定義です。', '', '```yaml', VALID_YAML, '```'].join(
      '\n',
    );
    expect(extractYamlFromResponse(response)).toBe(VALID_YAML);
  });

  it('言語指定の無いコードフェンスからも取り出せる', () => {
    const response = ['```', VALID_YAML, '```'].join('\n');
    expect(extractYamlFromResponse(response)).toBe(VALID_YAML);
  });

  it('前置きが付いた素のYAML（コードフェンス無し）から取り出せる', () => {
    const response = ['ワークフロー定義を作成しました。', '', VALID_YAML].join('\n');
    expect(extractYamlFromResponse(response)).toBe(VALID_YAML);
  });

  it('素のYAMLのみの応答はそのまま返す', () => {
    expect(extractYamlFromResponse(VALID_YAML)).toBe(VALID_YAML);
  });
});

describe('detectSecurityWarnings（design.md §16.9「強調して知らせる」）', () => {
  it('autoApprove: trueを検出する', () => {
    const def = parseWorkflowYaml(
      [
        'version: 1',
        'name: x',
        'tasks:',
        '  - id: T1',
        '    prompt: p',
        '    done: d',
        '    autoApprove: true',
      ].join('\n'),
    );
    const warnings = detectSecurityWarnings(def, baseline);
    expect(warnings.some((w) => w.taskId === 'T1' && w.kind === 'autoApprove')).toBe(true);
  });

  it('非空のallowを検出する', () => {
    const def = parseWorkflowYaml(
      [
        'version: 1',
        'name: x',
        'tasks:',
        '  - id: T1',
        '    prompt: p',
        '    done: d',
        '    allow: ["rm -rf"]',
      ].join('\n'),
    );
    const warnings = detectSecurityWarnings(def, baseline);
    expect(warnings.some((w) => w.taskId === 'T1' && w.kind === 'allow')).toBe(true);
  });

  it('拡張機能の設定より緩いsandboxの指定を検出する', () => {
    const def = parseWorkflowYaml(
      [
        'version: 1',
        'name: x',
        'tasks:',
        '  - id: T1',
        '    prompt: p',
        '    done: d',
        '    sandbox: danger-full-access',
      ].join('\n'),
    );
    const warnings = detectSecurityWarnings(def, baseline);
    expect(warnings.some((w) => w.taskId === 'T1' && w.kind === 'sandbox')).toBe(true);
  });

  it('拡張機能の設定より緩いapprovalModeの指定を検出する', () => {
    const def = parseWorkflowYaml(
      [
        'version: 1',
        'name: x',
        'tasks:',
        '  - id: T1',
        '    prompt: p',
        '    done: d',
        '    approvalMode: never',
      ].join('\n'),
    );
    const warnings = detectSecurityWarnings(def, baseline);
    expect(warnings.some((w) => w.taskId === 'T1' && w.kind === 'approvalMode')).toBe(true);
  });

  it('通常のタスク（既定を上書きしない）では警告が出ない', () => {
    const def = parseWorkflowYaml(VALID_YAML);
    expect(detectSecurityWarnings(def, baseline)).toEqual([]);
  });
});

describe('locateSecurityWarningLine', () => {
  it('該当タスクの該当フィールドの行番号を返す', () => {
    const yaml = [
      'version: 1',
      'name: x',
      'tasks:',
      '  - id: T1',
      '    prompt: p',
      '    done: d',
      '  - id: T2',
      '    prompt: p',
      '    done: d',
      '    autoApprove: true',
    ].join('\n');
    expect(locateSecurityWarningLine(yaml, 'T2', 'autoApprove')).toBe(10);
  });

  it('見つからないタスクにはundefinedを返す', () => {
    expect(locateSecurityWarningLine(VALID_YAML, 'NOPE', 'autoApprove')).toBeUndefined();
  });
});

describe('slugifyGoal / resolveUniqueFileName（design.md §16.9「ゴール文から作った短いスラッグ」）', () => {
  it('英数字のゴール文から素直なスラッグを作る', () => {
    expect(slugifyGoal('Add Auth Feature')).toBe('Add-Auth-Feature');
  });

  it('ファイル名に使えない文字を取り除く', () => {
    expect(slugifyGoal('fix: a/b*c?d')).toBe('fix-a-b-c-d');
  });

  it('日本語のゴール文はローマ字化せずそのまま使う', () => {
    expect(slugifyGoal('認証機能を追加する')).toBe('認証機能を追加する');
  });

  it('不正な文字しか無いときはworkflowへ落とす', () => {
    expect(slugifyGoal('???')).toBe('workflow');
  });

  it('同名が無ければそのまま使う', () => {
    expect(resolveUniqueFileName('add-auth', new Set())).toBe('add-auth');
  });

  it('同名があれば連番を足す', () => {
    expect(resolveUniqueFileName('add-auth', new Set(['add-auth']))).toBe('add-auth-2');
    expect(resolveUniqueFileName('add-auth', new Set(['add-auth', 'add-auth-2']))).toBe(
      'add-auth-3',
    );
  });
});

describe('planWorkflow（design.md §16.9）', () => {
  const baseInput = {
    goal: 'ゴール',
    workspaceSummary: { topLevelEntries: [], hasAgentsMd: false, hasClaudeMd: false },
    provider: 'codex' as const,
    cwd: '/repo',
    baseline,
    log: fakeLogger,
  };

  it('1回目の応答が検証を通れば、そのまま生成できたと返す', async () => {
    const host = new FakePlannerHost([VALID_YAML]);
    const result = await planWorkflow({ ...baseInput, host });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attempts).toBe(1);
      expect(result.definition.tasks.map((t) => t.id)).toEqual(['T1']);
      expect(validateWorkflow(result.definition).errors).toEqual([]);
    }
    expect(host.openCalls).toHaveLength(1);
  });

  it('コードフェンス付きの応答からでも生成できる', async () => {
    const fenced = ['```yaml', VALID_YAML, '```'].join('\n');
    const host = new FakePlannerHost([fenced]);
    const result = await planWorkflow({ ...baseInput, host });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.yaml).toBe(VALID_YAML);
    }
  });

  it('1回目が検証を通らなければ、エラーを添えてもう1度だけ投げ直す', async () => {
    const host = new FakePlannerHost([INVALID_YAML, VALID_YAML]);
    const result = await planWorkflow({ ...baseInput, host });

    expect(host.openCalls).toHaveLength(2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attempts).toBe(2);
    }

    // 2回目のプロンプトには、1回目のYAMLと検証エラーの内容が含まれている
    const secondPrompt = host.sessions[1]?.runLoopCalls[0]?.initialPrompt ?? '';
    expect(secondPrompt).toContain('T1');
    expect(secondPrompt).toContain('done');
  });

  it('2回目も検証を通らなければ、2回目の生の応答をok: falseで返す（3回目は投げない）', async () => {
    const secondRawResponse = `前置き\n${INVALID_YAML}`;
    const host = new FakePlannerHost([INVALID_YAML, secondRawResponse]);
    const result = await planWorkflow({ ...baseInput, host });

    expect(host.openCalls).toHaveLength(2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rawResponse).toBe(secondRawResponse);
      expect(result.attempts).toBe(2);
      expect(result.lastErrors.length).toBeGreaterThan(0);
    }
  });

  it('生成に使ったセッションは1ターンだけ送って閉じる（実行のループは回さない）', async () => {
    const host = new FakePlannerHost([VALID_YAML]);
    await planWorkflow({ ...baseInput, host });
    const session = host.sessions[0];
    expect(session?.runLoopCalls).toHaveLength(1);
    expect(session?.runLoopCalls[0]).toMatchObject({ maxIterations: 1, condition: '' });
    expect(session?.disposed).toBe(true);
  });

  it('分解セッションはsandbox: read-only相当・最も安全なapprovalModeで起動する', async () => {
    const host = new FakePlannerHost([VALID_YAML]);
    await planWorkflow({ ...baseInput, host, provider: 'codex' });
    expect(host.openCalls[0]?.sandbox).toBe('read-only');
    expect(host.openCalls[0]?.config.approvalMode).toBe('untrusted');
  });

  it('Claudeプロバイダでも最も安全なapprovalMode（permissionMode）で起動する', async () => {
    const host = new FakePlannerHost([VALID_YAML]);
    await planWorkflow({ ...baseInput, host, provider: 'claude' });
    expect(host.openCalls[0]?.config.approvalMode).toBe('plan');
  });

  it('承認要求は理由を問わず全て拒否する', async () => {
    const host = new FakePlannerHost([VALID_YAML]);
    await planWorkflow({ ...baseInput, host });
    const session = host.sessions[0];
    const decision = await session?.approvalHandler?.(fakeApproval, {
      command: 'git push --force',
    });
    expect(decision).toEqual({ kind: 'auto', decision: 'decline' });
  });

  it('生成物にautoApprove/allowが含まれる場合、securityWarningsとして返す', async () => {
    const yamlWithConcerns = [
      'version: 1',
      'name: x',
      'tasks:',
      '  - id: T1',
      '    prompt: p',
      '    done: d',
      '    autoApprove: true',
      '    allow: ["rm -rf"]',
    ].join('\n');
    const host = new FakePlannerHost([yamlWithConcerns]);
    const result = await planWorkflow({ ...baseInput, host });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.securityWarnings.some((w) => w.kind === 'autoApprove')).toBe(true);
      expect(result.securityWarnings.some((w) => w.kind === 'allow')).toBe(true);
    }
  });
});
