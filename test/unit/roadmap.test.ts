import { describe, expect, it } from 'vitest';
import { initialChatState, type ChatState } from '../../src/appserver/chatState';
import type { LoopPlan, LoopStopReason } from '../../src/loop/loopController';
import type { Logger } from '../../src/log';
import {
  applyRunCompletion,
  applyRunCompletionToFile,
  buildRoadmapPlanGoal,
  buildRoadmapPrompt,
  createCliIssueListPort,
  createTaskSessionRoadmapGenerationPort,
  detectRoadmapMaterialMismatches,
  formatRoadmapMaterial,
  generateRoadmap,
  parseRoadmapMarkdown,
  planWorkflowFromRoadmapPhase,
  resolveRoadmapOutputPath,
  selectNextRoadmapPhase,
  selectRoadmapPhaseItems,
  slugifyGoal,
  stripMarkdownCodeFence,
  validateRoadmap,
  type GenerateRoadmapDeps,
  type IssueListPort,
  type RoadmapFileSystemPort,
  type RoadmapGenerationPort,
  type RoadmapMaterialItem,
} from '../../src/orchestrator/roadmap';
import type { ExtensionSafetyBaseline } from '../../src/orchestrator/taskConfig';
import { parseWorkflowYaml } from '../../src/orchestrator/workflow';
import type { CliCommandRunner } from '../../src/orchestrator/forge';
import type {
  ApprovalHandler,
  TaskSession,
  TaskSessionHost,
  TaskSessionInput,
} from '../../src/orchestrator/taskSession';
import type { GitCommandRunner } from '../../src/orchestrator/worktree';

/** `planner.test.ts`のフェイクと同じ形。1ターンで応答を返し、承認要求は全拒否する。 */
class FakeRoadmapSession implements TaskSession {
  readonly sessionId = 'roadmap-fake-session';
  approvalHandler: ApprovalHandler | undefined;
  runLoopCalls: LoopPlan[] = [];
  disposed = false;
  private finishedListener: ((reason: LoopStopReason, state: ChatState) => void) | undefined;

  constructor(
    private readonly responseText: string,
    private readonly shouldFail: boolean,
  ) {}

  runLoop(plan: LoopPlan): void {
    this.runLoopCalls.push(plan);
    this.finishedListener?.(this.shouldFail ? 'failed' : 'maxReached', {
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
  pauseLoop(): void {}
  resumeLoop(): void {}
  async checkMessagingToolVisible(): Promise<boolean> {
    return true;
  }
  stopLoop(): void {}
  decideApproval(): void {}
  reveal(): void {}
  open(): void {}
  dispose(): void {
    this.disposed = true;
  }
}

class FakeRoadmapHost implements TaskSessionHost {
  openCalls: TaskSessionInput[] = [];
  sessions: FakeRoadmapSession[] = [];
  constructor(
    private readonly responseText: string,
    private readonly shouldFail = false,
  ) {}

  async openTaskSession(input: TaskSessionInput): Promise<TaskSession> {
    this.openCalls.push(input);
    const session = new FakeRoadmapSession(this.responseText, this.shouldFail);
    this.sessions.push(session);
    return session;
  }
}

const SAMPLE_ROADMAP = `# 認証機能を追加する

## Phase 1: 設計

- [ ] R1 認証方式を決めて設計を書く
  - 依存: なし
  - Issue: #12
- [ ] R2 API側を実装する
  - 依存: R1
  - Issue: #13
- [ ] R3 UI側を実装する
  - 依存: R1
`;

describe('parseRoadmapMarkdown', () => {
  it('タイトル・フェーズ・項目・依存・Issueを構造化して取り出す', () => {
    const parsed = parseRoadmapMarkdown(SAMPLE_ROADMAP);
    expect(parsed.title).toBe('認証機能を追加する');
    expect(parsed.phases).toHaveLength(1);
    expect(parsed.phases[0]?.name).toBe('Phase 1: 設計');
    expect(parsed.phases[0]?.items).toHaveLength(3);

    const r1 = parsed.phases[0]?.items[0];
    expect(r1?.id).toBe('R1');
    expect(r1?.checked).toBe(false);
    expect(r1?.text).toBe('認証方式を決めて設計を書く');
    expect(r1?.dependsOn).toEqual([]);
    expect(r1?.issue).toBe(12);

    const r2 = parsed.phases[0]?.items[1];
    expect(r2?.dependsOn).toEqual(['R1']);
    expect(r2?.issue).toBe(13);

    const r3 = parsed.phases[0]?.items[2];
    expect(r3?.dependsOn).toEqual(['R1']);
    expect(r3?.issue).toBeUndefined();
  });

  it('チェック済みの項目を読み取る', () => {
    const parsed = parseRoadmapMarkdown('# g\n\n## Phase 1\n\n- [x] R1 done\n  - 依存: なし\n');
    expect(parsed.phases[0]?.items[0]?.checked).toBe(true);
  });

  it('複数フェーズを扱う', () => {
    const md = `# g

## Phase 1: 設計

- [ ] R1 a
  - 依存: なし

## Phase 2: 実装

- [ ] R2 b
  - 依存: R1
`;
    const parsed = parseRoadmapMarkdown(md);
    expect(parsed.phases).toHaveLength(2);
    expect(parsed.phases[1]?.items[0]?.id).toBe('R2');
  });

  it('見出し・チェックボックス以外の行は無視する', () => {
    const md = `# g

自由記述の説明文。

## Phase 1: 設計

補足の一文。

- [ ] R1 a
  - 依存: なし
`;
    const parsed = parseRoadmapMarkdown(md);
    expect(parsed.phases[0]?.items).toHaveLength(1);
  });

  it('依存が複数ある場合はカンマ区切りで読む', () => {
    const md = '# g\n\n## Phase 1\n\n- [ ] R3 c\n  - 依存: R1, R2\n';
    const parsed = parseRoadmapMarkdown(md);
    expect(parsed.phases[0]?.items[0]?.dependsOn).toEqual(['R1', 'R2']);
  });
});

describe('validateRoadmap', () => {
  it('正常なロードマップはエラー無しで通る', () => {
    const parsed = parseRoadmapMarkdown(SAMPLE_ROADMAP);
    const result = validateRoadmap(parsed);
    expect(result.errors).toEqual([]);
  });

  it('項目idの重複をエラーにする', () => {
    const md = `# g

## Phase 1

- [ ] R1 a
  - 依存: なし
- [ ] R1 b
  - 依存: なし
`;
    const result = validateRoadmap(parseRoadmapMarkdown(md));
    expect(result.errors.some((e) => e.message.includes('重複'))).toBe(true);
  });

  it('未定義の依存参照をエラーにする', () => {
    const md = '# g\n\n## Phase 1\n\n- [ ] R1 a\n  - 依存: R99\n';
    const result = validateRoadmap(parseRoadmapMarkdown(md));
    expect(result.errors.some((e) => e.message.includes('未定義'))).toBe(true);
  });

  it('循環依存をエラーにする', () => {
    const md = `# g

## Phase 1

- [ ] R1 a
  - 依存: R2
- [ ] R2 b
  - 依存: R1
`;
    const result = validateRoadmap(parseRoadmapMarkdown(md));
    expect(result.errors.some((e) => e.message.includes('循環'))).toBe(true);
  });

  it('自己参照も循環としてエラーにする', () => {
    const md = '# g\n\n## Phase 1\n\n- [ ] R1 a\n  - 依存: R1\n';
    const result = validateRoadmap(parseRoadmapMarkdown(md));
    expect(result.errors.some((e) => e.message.includes('循環'))).toBe(true);
  });

  it('項目が1件も無い場合はエラーにする', () => {
    const result = validateRoadmap({ title: 'g', phases: [] });
    expect(result.errors.some((e) => e.message.includes('項目が1件も'))).toBe(true);
  });

  it('idの形式が不正な場合はエラーにする', () => {
    const md = '# g\n\n## Phase 1\n\n- [ ] R!1 a\n  - 依存: なし\n';
    const result = validateRoadmap(parseRoadmapMarkdown(md));
    expect(result.errors.some((e) => e.message.includes('id の形式'))).toBe(true);
  });

  it('複数のエラーを1回でまとめて返す', () => {
    const md = `# g

## Phase 1

- [ ] R1 a
  - 依存: R99
- [ ] R1 b
  - 依存: なし
`;
    const result = validateRoadmap(parseRoadmapMarkdown(md));
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});

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

describe('selectNextRoadmapPhase（design.md §16.19 2段目「次のフェーズだけYAMLにする」）', () => {
  it('未チェックの項目を含む最初のフェーズを返す', () => {
    const md = `# g

## Phase 1: 設計

- [x] R1 a
  - 依存: なし

## Phase 2: 実装

- [ ] R2 b
  - 依存: なし
`;
    const parsed = parseRoadmapMarkdown(md);
    expect(selectNextRoadmapPhase(parsed)?.name).toBe('Phase 2: 実装');
  });

  it('全フェーズ完了済みならundefined', () => {
    const md = '# g\n\n## Phase 1\n\n- [x] R1 a\n  - 依存: なし\n';
    expect(selectNextRoadmapPhase(parseRoadmapMarkdown(md))).toBeUndefined();
  });
});

describe('selectRoadmapPhaseItems / formatRoadmapMaterial（design.md §16.19 2段目）', () => {
  it('フェーズの項目をid・依存・issueだけの材料へ変換する', () => {
    const parsed = parseRoadmapMarkdown(SAMPLE_ROADMAP);
    const phase = parsed.phases[0];
    if (phase === undefined) throw new Error('phase not found');
    const items = selectRoadmapPhaseItems(phase);
    expect(items).toEqual([
      { id: 'R1', text: '認証方式を決めて設計を書く', dependsOn: [], issue: 12 },
      { id: 'R2', text: 'API側を実装する', dependsOn: ['R1'], issue: 13 },
      { id: 'R3', text: 'UI側を実装する', dependsOn: ['R1'], issue: undefined },
    ]);
  });

  it('idと依存とIssueをそのまま転記するよう指示する材料テキストを組み立てる', () => {
    const items: RoadmapMaterialItem[] = [
      { id: 'R1', text: '設計する', dependsOn: [], issue: 12 },
      { id: 'R2', text: '実装する', dependsOn: ['R1'], issue: undefined },
    ];
    const material = formatRoadmapMaterial(items);
    expect(material).toContain('id: R1');
    expect(material).toContain('Issue: #12');
    expect(material).toContain('id: R2');
    expect(material).toContain('依存: R1');
    expect(material).toContain('Issue: なし');
    expect(material).toContain('書き換えないこと');
  });
});

describe('buildRoadmapPlanGoal', () => {
  it('ロードマップのタイトルとフェーズ名からゴール文を組み立てる', () => {
    const parsed = parseRoadmapMarkdown(SAMPLE_ROADMAP);
    const phase = parsed.phases[0];
    if (phase === undefined) throw new Error('phase not found');
    const goal = buildRoadmapPlanGoal(parsed.title, phase);
    expect(goal).toContain('認証機能を追加する');
    expect(goal).toContain('Phase 1: 設計');
  });
});

describe('detectRoadmapMaterialMismatches（design.md §16.19 2段目の転記確認）', () => {
  const material: RoadmapMaterialItem[] = [
    { id: 'R1', text: '設計する', dependsOn: [], issue: 12 },
    { id: 'R2', text: '実装する', dependsOn: ['R1'], issue: 13 },
  ];

  it('材料どおりに転記されていれば不一致無し', () => {
    const def = parseWorkflowYaml(
      [
        'version: 1',
        'name: x',
        'tasks:',
        '  - id: R1',
        '    prompt: p',
        '    done: d',
        '    issue: 12',
        '  - id: R2',
        '    dependsOn: [R1]',
        '    prompt: p',
        '    done: d',
        '    issue: 13',
      ].join('\n'),
    );
    expect(detectRoadmapMaterialMismatches(material, def)).toEqual([]);
  });

  it('対応するタスクが無ければmissingを報告する', () => {
    const def = parseWorkflowYaml(
      ['version: 1', 'name: x', 'tasks:', '  - id: R1', '    prompt: p', '    done: d'].join('\n'),
    );
    const mismatches = detectRoadmapMaterialMismatches(material, def);
    expect(mismatches.some((m) => m.itemId === 'R2' && m.kind === 'missing')).toBe(true);
  });

  it('dependsOnが材料と異なればdependsOnMismatchを報告する', () => {
    const def = parseWorkflowYaml(
      [
        'version: 1',
        'name: x',
        'tasks:',
        '  - id: R1',
        '    prompt: p',
        '    done: d',
        '    issue: 12',
        '  - id: R2',
        '    prompt: p',
        '    done: d',
        '    issue: 13',
      ].join('\n'),
    );
    const mismatches = detectRoadmapMaterialMismatches(material, def);
    expect(mismatches.some((m) => m.itemId === 'R2' && m.kind === 'dependsOnMismatch')).toBe(true);
  });

  it('issueが材料と異なればissueMismatchを報告する', () => {
    const def = parseWorkflowYaml(
      [
        'version: 1',
        'name: x',
        'tasks:',
        '  - id: R1',
        '    prompt: p',
        '    done: d',
        '  - id: R2',
        '    dependsOn: [R1]',
        '    prompt: p',
        '    done: d',
        '    issue: 13',
      ].join('\n'),
    );
    const mismatches = detectRoadmapMaterialMismatches(material, def);
    expect(mismatches.some((m) => m.itemId === 'R1' && m.kind === 'issueMismatch')).toBe(true);
  });
});

describe('planWorkflowFromRoadmapPhase（design.md §16.19 2段目）', () => {
  const baseInput = {
    roadmapTitle: '認証機能を追加する',
    workspaceSummary: { topLevelEntries: [], hasAgentsMd: false, hasClaudeMd: false },
    provider: 'codex' as const,
    cwd: '/repo',
    baseline,
    log: fakeLogger,
  };

  it('フェーズの項目を材料として分解セッションへ渡し、生成された定義と不一致の有無を返す', async () => {
    const parsed = parseRoadmapMarkdown(SAMPLE_ROADMAP);
    const phase = parsed.phases[0];
    if (phase === undefined) throw new Error('phase not found');

    const yaml = [
      'version: 1',
      'name: x',
      'tasks:',
      '  - id: R1',
      '    prompt: 認証方式を決めて設計を書く',
      '    done: 設計が終わっている',
      '    issue: 12',
      '  - id: R2',
      '    dependsOn: [R1]',
      '    prompt: API側を実装する',
      '    done: 実装が終わっている',
      '    issue: 13',
      '  - id: R3',
      '    dependsOn: [R1]',
      '    prompt: UI側を実装する',
      '    done: 実装が終わっている',
    ].join('\n');
    const host = new FakeRoadmapHost(yaml);

    const result = await planWorkflowFromRoadmapPhase({ ...baseInput, phase, host });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.roadmapMismatches).toEqual([]);
      expect(result.definition.tasks.map((t) => t.id)).toEqual(['R1', 'R2', 'R3']);
    }
    const sentPrompt = host.sessions[0]?.runLoopCalls[0]?.initialPrompt ?? '';
    expect(sentPrompt).toContain('id: R1');
    expect(sentPrompt).toContain('Issue: #12');
  });

  it('goalを省略すると、ロードマップのタイトルとフェーズ名から組み立てる', async () => {
    const parsed = parseRoadmapMarkdown(SAMPLE_ROADMAP);
    const phase = parsed.phases[0];
    if (phase === undefined) throw new Error('phase not found');
    const host = new FakeRoadmapHost(
      ['version: 1', 'name: x', 'tasks:', '  - id: R1', '    prompt: p', '    done: d'].join('\n'),
    );
    await planWorkflowFromRoadmapPhase({ ...baseInput, phase, host });
    const sentPrompt = host.sessions[0]?.runLoopCalls[0]?.initialPrompt ?? '';
    expect(sentPrompt).toContain('認証機能を追加する');
    expect(sentPrompt).toContain('Phase 1: 設計');
  });

  it('生成が検証を通らなければ、planWorkflowと同じくok: falseを返す', async () => {
    const parsed = parseRoadmapMarkdown(SAMPLE_ROADMAP);
    const phase = parsed.phases[0];
    if (phase === undefined) throw new Error('phase not found');
    const invalidYaml = ['version: 1', 'name: x', 'tasks:', '  - id: R1'].join('\n');
    const host = new FakeRoadmapHost(invalidYaml);
    const result = await planWorkflowFromRoadmapPhase({ ...baseInput, phase, host });
    expect(result.ok).toBe(false);
  });

  it('材料の転記に漏れがあれば、生成自体は成功していてもroadmapMismatchesに残る', async () => {
    const parsed = parseRoadmapMarkdown(SAMPLE_ROADMAP);
    const phase = parsed.phases[0];
    if (phase === undefined) throw new Error('phase not found');
    // R2・R3を作らず、issueも落とした不完全な転記
    const yaml = [
      'version: 1',
      'name: x',
      'tasks:',
      '  - id: R1',
      '    prompt: 認証方式を決めて設計を書く',
      '    done: 設計が終わっている',
    ].join('\n');
    const host = new FakeRoadmapHost(yaml);
    const result = await planWorkflowFromRoadmapPhase({ ...baseInput, phase, host });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.roadmapMismatches.some((m) => m.itemId === 'R1' && m.kind === 'issueMismatch')).toBe(
        true,
      );
      expect(result.roadmapMismatches.some((m) => m.itemId === 'R2' && m.kind === 'missing')).toBe(true);
      expect(result.roadmapMismatches.some((m) => m.itemId === 'R3' && m.kind === 'missing')).toBe(true);
    }
  });
});

describe('applyRunCompletion', () => {
  it('doneになった項目のチェックだけを書き換え、本文は変えない', () => {
    const result = applyRunCompletion(SAMPLE_ROADMAP, new Map([['R1', 'done']]));
    expect(result.updatedItemIds).toEqual(['R1']);
    expect(result.unmatchedTaskIds).toEqual([]);

    const parsed = parseRoadmapMarkdown(result.markdown);
    expect(parsed.phases[0]?.items[0]?.checked).toBe(true);
    expect(parsed.phases[0]?.items[0]?.text).toBe('認証方式を決めて設計を書く');
    expect(parsed.phases[0]?.items[1]?.checked).toBe(false);

    // 変更した行以外は完全に一致する
    const beforeLines = SAMPLE_ROADMAP.split(/\r?\n/u);
    const afterLines = result.markdown.split(/\r?\n/u);
    for (let i = 0; i < beforeLines.length; i += 1) {
      if (i === 4) {
        continue; // R1のチェックボックス行
      }
      expect(afterLines[i]).toBe(beforeLines[i]);
    }
  });

  it('done以外の状態では書き換えない', () => {
    const result = applyRunCompletion(SAMPLE_ROADMAP, new Map([['R1', 'failed']]));
    expect(result.updatedItemIds).toEqual([]);
    expect(result.markdown).toBe(SAMPLE_ROADMAP);
  });

  it('対応が取れない項目（ロードマップに無いid）はエラーにならずログ用の配列へ入る', () => {
    const result = applyRunCompletion(SAMPLE_ROADMAP, new Map([['R404', 'done']]));
    expect(result.unmatchedTaskIds).toEqual(['R404']);
    expect(result.updatedItemIds).toEqual([]);
    expect(result.markdown).toBe(SAMPLE_ROADMAP);
  });

  it('既にチェック済みの項目はそのまま（冪等）', () => {
    const md = '# g\n\n## Phase 1\n\n- [x] R1 a\n  - 依存: なし\n';
    const result = applyRunCompletion(md, new Map([['R1', 'done']]));
    expect(result.updatedItemIds).toEqual([]);
    expect(result.markdown).toBe(md);
  });

  it('複数項目を一度に更新できる', () => {
    const result = applyRunCompletion(
      SAMPLE_ROADMAP,
      new Map([
        ['R1', 'done'],
        ['R2', 'done'],
      ]),
    );
    expect(result.updatedItemIds.sort()).toEqual(['R1', 'R2']);
  });
});

describe('stripMarkdownCodeFence', () => {
  it('コードフェンスに囲まれていれば剥がす', () => {
    expect(stripMarkdownCodeFence('```markdown\n# g\n```')).toBe('# g');
  });

  it('コードフェンスが無ければそのまま返す', () => {
    expect(stripMarkdownCodeFence('# g')).toBe('# g');
  });
});

describe('buildRoadmapPrompt', () => {
  it('ゴール・ワークスペース構成・AGENTS.md/CLAUDE.mdの有無・既存Issueを材料に含める', () => {
    const prompt = buildRoadmapPrompt({
      goal: '認証機能を追加する',
      workspaceSummary: ['src/', 'package.json'],
      hasAgentsFile: true,
      hasClaudeFile: false,
      existingIssues: [{ number: 12, title: '認証方式の検討' }],
    });
    expect(prompt).toContain('認証機能を追加する');
    expect(prompt).toContain('src/');
    expect(prompt).toContain('package.json');
    expect(prompt).toContain('AGENTS.md: あり');
    expect(prompt).toContain('CLAUDE.md: なし');
    expect(prompt).toContain('#12 認証方式の検討');
  });

  it('既存Issueが取得できない場合はその旨を書く', () => {
    const prompt = buildRoadmapPrompt({
      goal: 'g',
      workspaceSummary: [],
      hasAgentsFile: false,
      hasClaudeFile: false,
      existingIssues: undefined,
    });
    expect(prompt).toContain('取得できませんでした');
  });
});

describe('createCliIssueListPort', () => {
  function fakeGit(remoteUrl: string, code = 0): GitCommandRunner {
    return {
      run: async (args) => {
        if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
          return { code, stdout: `${remoteUrl}\n`, stderr: '' };
        }
        return { code: 1, stdout: '', stderr: 'unexpected' };
      },
    };
  }

  it('GitHubなら gh issue list --json を呼びnumber/titleを返す', async () => {
    const calls: { command: string; args: readonly string[] }[] = [];
    const cli: CliCommandRunner = {
      run: async (command, args) => {
        calls.push({ command, args });
        return { code: 0, stdout: JSON.stringify([{ number: 1, title: 'a' }]), stderr: '' };
      },
    };
    const port = createCliIssueListPort(fakeGit('https://github.com/org/repo.git'), cli);
    const issues = await port.listIssues('/repo');
    expect(issues).toEqual([{ number: 1, title: 'a' }]);
    expect(calls[0]?.command).toBe('gh');
    expect(calls[0]?.args).toContain('--json');
  });

  it('GitLabなら glab issue list -O json を呼びiidをnumberとして返す', async () => {
    const calls: { command: string; args: readonly string[] }[] = [];
    const cli: CliCommandRunner = {
      run: async (command, args) => {
        calls.push({ command, args });
        return { code: 0, stdout: JSON.stringify([{ iid: 5, title: 'b' }]), stderr: '' };
      },
    };
    const port = createCliIssueListPort(fakeGit('git@gitlab.example.com:org/repo.git'), cli);
    const issues = await port.listIssues('/repo');
    expect(issues).toEqual([{ number: 5, title: 'b' }]);
    expect(calls[0]?.command).toBe('glab');
  });

  it('originが取れなければundefined', async () => {
    const cli: CliCommandRunner = { run: async () => ({ code: 0, stdout: '[]', stderr: '' }) };
    const port = createCliIssueListPort(fakeGit('', 1), cli);
    expect(await port.listIssues('/repo')).toBeUndefined();
  });

  it('ホストが判定できなければundefined（CLIを呼ばない）', async () => {
    let called = false;
    const cli: CliCommandRunner = {
      run: async () => {
        called = true;
        return { code: 0, stdout: '[]', stderr: '' };
      },
    };
    const port = createCliIssueListPort(fakeGit('https://git.internal.example.com/o/r.git'), cli);
    expect(await port.listIssues('/repo')).toBeUndefined();
    expect(called).toBe(false);
  });

  it('CLIが失敗すればundefined', async () => {
    const cli: CliCommandRunner = {
      run: async () => ({ code: 1, stdout: '', stderr: 'not authenticated' }),
    };
    const port = createCliIssueListPort(fakeGit('https://github.com/org/repo.git'), cli);
    expect(await port.listIssues('/repo')).toBeUndefined();
  });

  it('出力がJSONとして読めなければundefined', async () => {
    const cli: CliCommandRunner = {
      run: async () => ({ code: 0, stdout: 'not json', stderr: '' }),
    };
    const port = createCliIssueListPort(fakeGit('https://github.com/org/repo.git'), cli);
    expect(await port.listIssues('/repo')).toBeUndefined();
  });
});

describe('slugifyGoal', () => {
  it('空白・パス区切り文字をハイフンへ置き換える', () => {
    expect(slugifyGoal('認証 機能/を追加')).toBe('認証-機能-を追加');
  });

  it('前後の空白は取り除く', () => {
    expect(slugifyGoal('  ゴール  ')).toBe('ゴール');
  });

  it('空文字になる場合はroadmapへ倒す', () => {
    expect(slugifyGoal('   ')).toBe('roadmap');
  });

  it('Windowsの予約デバイス名になる場合はroadmapへ倒す', () => {
    expect(slugifyGoal('CON')).toBe('roadmap');
  });

  it('長すぎる場合は切り詰める', () => {
    const long = 'a'.repeat(200);
    expect(slugifyGoal(long).length).toBeLessThanOrEqual(60);
  });
});

describe('resolveRoadmapOutputPath', () => {
  it('ワークスペース配下なら解決できる', () => {
    const result = resolveRoadmapOutputPath('/repo', 'docs/roadmap', 'goal');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe('/repo/docs/roadmap/goal.md');
    }
  });

  it('..でワークスペースの外へ出る指定はエラーにする', () => {
    const result = resolveRoadmapOutputPath('/repo', '../outside', 'goal');
    expect(result.ok).toBe(false);
  });

  it('絶対パスでワークスペースの外を指す指定はエラーにする', () => {
    const result = resolveRoadmapOutputPath('/repo', '/etc', 'goal');
    expect(result.ok).toBe(false);
  });
});

describe('generateRoadmap', () => {
  function deps(overrides: Partial<GenerateRoadmapDeps> = {}): GenerateRoadmapDeps {
    const written = new Map<string, string>();
    const fs: RoadmapFileSystemPort = {
      writeTextFile: async (target, content) => {
        written.set(target, content);
      },
      readTextFile: async (target) => written.get(target),
    };
    const issues: IssueListPort = { listIssues: async () => [{ number: 1, title: 'x' }] };
    const generation: RoadmapGenerationPort = {
      generate: async () => ({ ok: true, text: SAMPLE_ROADMAP }),
    };
    return { generation, issues, fs, ...overrides };
  }

  it('生成されたロードマップを検証し、設定した置き場へ保存する', async () => {
    const d = deps();
    const result = await generateRoadmap(d, {
      goal: '認証機能を追加する',
      workspaceRoot: '/repo',
      roadmapDir: 'docs/roadmap',
      workspaceSummary: ['src/'],
      hasAgentsFile: false,
      hasClaudeFile: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe('/repo/docs/roadmap/認証機能を追加する.md');
      expect(result.validation.errors).toEqual([]);
      expect(await d.fs.readTextFile(result.path)).toBe(stripMarkdownCodeFence(SAMPLE_ROADMAP));
    }
  });

  it('出力先がワークスペースの外なら生成セッションを呼ばずエラーにする', async () => {
    let called = false;
    const d = deps({
      generation: {
        generate: async () => {
          called = true;
          return { ok: true, text: SAMPLE_ROADMAP };
        },
      },
    });
    const result = await generateRoadmap(d, {
      goal: 'g',
      workspaceRoot: '/repo',
      roadmapDir: '../outside',
      workspaceSummary: [],
      hasAgentsFile: false,
      hasClaudeFile: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('pathOutsideWorkspace');
    }
    expect(called).toBe(false);
  });

  it('生成に失敗すればそのままエラーを返す', async () => {
    const d = deps({ generation: { generate: async () => ({ ok: false, message: 'timeout' }) } });
    const result = await generateRoadmap(d, {
      goal: 'g',
      workspaceRoot: '/repo',
      roadmapDir: 'docs/roadmap',
      workspaceSummary: [],
      hasAgentsFile: false,
      hasClaudeFile: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('generationFailed');
      expect(result.message).toBe('timeout');
    }
  });
});

describe('applyRunCompletionToFile', () => {
  it('ファイルを読み、更新があれば書き戻す', async () => {
    const written = new Map<string, string>([['/repo/docs/roadmap/g.md', SAMPLE_ROADMAP]]);
    const fs: RoadmapFileSystemPort = {
      writeTextFile: async (target, content) => {
        written.set(target, content);
      },
      readTextFile: async (target) => written.get(target),
    };
    const outcome = await applyRunCompletionToFile(
      { fs },
      '/repo/docs/roadmap/g.md',
      new Map([['R1', 'done']]),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.updatedItemIds).toEqual(['R1']);
    }
    const parsed = parseRoadmapMarkdown(written.get('/repo/docs/roadmap/g.md') ?? '');
    expect(parsed.phases[0]?.items[0]?.checked).toBe(true);
  });

  it('更新が無ければ書き込まない', async () => {
    let writeCount = 0;
    const fs: RoadmapFileSystemPort = {
      writeTextFile: async () => {
        writeCount += 1;
      },
      readTextFile: async () => SAMPLE_ROADMAP,
    };
    await applyRunCompletionToFile({ fs }, '/repo/docs/roadmap/g.md', new Map([['R404', 'done']]));
    expect(writeCount).toBe(0);
  });

  it('ファイルが読めなければエラーを返す', async () => {
    const fs: RoadmapFileSystemPort = {
      writeTextFile: async () => undefined,
      readTextFile: async () => undefined,
    };
    const outcome = await applyRunCompletionToFile({ fs }, '/repo/missing.md', new Map());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('readFailed');
    }
  });
});

describe('createTaskSessionRoadmapGenerationPort', () => {
  it('read-only相当・承認全拒否のセッションを1つ開き、応答テキストを返して閉じる（design.md §16.19）', async () => {
    const host = new FakeRoadmapHost('# ゴール\n\n## Phase 1: a\n\n- [ ] R1 やる\n  - 依存: なし');
    const port = createTaskSessionRoadmapGenerationPort(host, 'codex', '/repo');

    const result = await port.generate({ prompt: 'ロードマップを作って' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain('R1 やる');
    }
    expect(host.openCalls).toHaveLength(1);
    // sandbox: read-only相当（`planner.ts`のbuildPlannerSessionInputが組み立てる最安全値）
    expect(host.openCalls[0]?.sandbox).toBe('read-only');
    expect(host.openCalls[0]?.cwd).toBe('/repo');

    const session = host.sessions[0];
    expect(session).toBeDefined();
    // 承認要求は全て拒否する（design.md §16.9・§16.19）
    const decision = await session?.approvalHandler?.(
      { requestId: 1, kind: 'command', title: 'rm -rf /', detail: '', itemId: undefined },
      {},
    );
    expect(decision).toEqual({ kind: 'auto', decision: 'decline' });
    // 生成が終わったらセッションを閉じる（design.md §16.19）
    expect(session?.disposed).toBe(true);
  });

  it('セッションのターンが失敗したら ok: false を返す', async () => {
    const host = new FakeRoadmapHost('', true);
    const port = createTaskSessionRoadmapGenerationPort(host, 'codex', '/repo');

    const result = await port.generate({ prompt: 'ロードマップを作って' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('ロードマップ生成セッションが失敗しました');
    }
  });
});
