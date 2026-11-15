import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunMetrics } from '../../src/orchestrator/runMetrics';
import type { LessonRecord } from '../../src/orchestrator/runNotes';
import type { RemainingRecord } from '../../src/orchestrator/runRemaining';
import {
  buildProposal,
  compareVersions,
  evaluateImprovement,
  findBlockingTombstone,
  improvementKey,
  RunRetrospective,
  SELF_IMPROVE_RUN_TITLE_PREFIX,
  type ImprovementSpec,
  type MergeState,
  type RetrospectiveForge,
} from '../../src/orchestrator/runRetrospective';
import { withFileLock } from '../../src/orchestrator/selfImproveBudget';
import { createTaskRun, type TaskRun } from '../../src/orchestrator/taskRunState';

const LESSON_ID = '11111111-2222-4333-8444-555555555555';
const DAY = 24 * 60 * 60_000;
const T0 = Date.parse('2026-11-01T00:00:00.000Z');

function metrics(
  runId: string,
  startMs: number,
  version: string,
  sendBacks: number,
  promptHash = 'p1',
): RunMetrics {
  return {
    schemaVersion: 1,
    runId,
    startedAt: new Date(startMs).toISOString(),
    finishedAt: new Date(startMs + 60_000).toISOString(),
    childIssues: 1,
    sendBacks,
    autoRetries: 0,
    maxReached: 0,
    questions: 0,
    gatesResolved: { reflex: 0, orchestrator: 0, user: 0 },
    msPerChildIssue: 60_000,
    keys: {
      extensionVersion: version,
      promptHash,
      limitsHash: 'l1',
      pluginHash: undefined,
      pluginCommits: {},
    },
  };
}

function lesson(runId: string, source: LessonRecord['source'] = 'repoArtifact'): LessonRecord {
  return {
    v: 1,
    kind: 'lesson',
    id: LESSON_ID,
    recordedAt: '2026-11-15T00:00:00.000Z',
    runId,
    runKind: 'taskRun',
    observation: '差し戻しの原因が受入基準の読み落とし',
    evidence: ['T1のreviewで差し戻し'],
    instruction: '受入基準を先に読む',
    ...(source === undefined ? {} : { source }),
  };
}

interface FakeForge extends RetrospectiveForge {
  created: { title: string; body: string; labels: readonly string[] }[];
  protectedPaths: string[];
  merge: MergeState;
}

function fakeForge(): FakeForge {
  const forge: FakeForge = {
    created: [],
    protectedPaths: ['src/orchestrator/taskRunGates.ts'],
    merge: { state: 'open' },
    isGithub: async () => true,
    repoInfo: async () => ({ nameWithOwner: 'owner/repo', visibility: 'public' }),
    listSelfImproveIssueNumbers: async () => [],
    findIssueByKey: async (_root, key) => {
      const i = forge.created.findIndex((c) => c.body.includes(`\`${key}\``));
      return i < 0 ? undefined : 100 + i;
    },
    ensureLabel: async () => undefined,
    createIssue: async (_root, issue) => {
      forge.created.push(issue);
      return { ok: true, issueNumber: 100 + forge.created.length - 1 };
    },
    readMergeState: async () => forge.merge,
    readProtectedPaths: async () => forge.protectedPaths,
    readIssueInfo: async () => ({ open: true, labels: ['self-improve'], title: 't' }),
  };
  return forge;
}

describe('純関数', () => {
  it('版を数として比べる', () => {
    expect(compareVersions('2026.1115.22', '2026.1115.3')).toBeGreaterThan(0);
    expect(compareVersions('2026.1115.3', '2026.1115.3')).toBe(0);
    expect(compareVersions('unknown', '2026.1.1')).toBeUndefined();
  });

  it('出典が外部由来の教訓からは改善案を作らない', () => {
    const current = metrics('r', T0, '1.0.0', 1);
    expect(
      buildProposal({ runId: 'r', lessons: [lesson('r', 'external')], current, history: [] }),
    ).toBeUndefined();
    expect(
      buildProposal({ runId: 'r', lessons: [lesson('other')], current, history: [] }),
    ).toBeUndefined();
    const p = buildProposal({ runId: 'r', lessons: [lesson('r')], current, history: [] });
    expect(p?.spec).toMatchObject({ metric: 'sendBacks', minRuns: 5, thresholdPct: 20 });
  });

  const spec: ImprovementSpec = {
    v: 1,
    key: 'si-x',
    target: 't',
    files: [],
    metric: 'sendBacks',
    expected: 'decrease',
    thresholdPct: 20,
    minAbsDelta: 0.2,
    minRuns: 5,
    evidence: [LESSON_ID],
  };
  const mergedAt = T0 + 10 * DAY;
  const before = [1, 2, 3, 4, 5].map((i) => metrics(`b${i}`, T0 + i * DAY, '1.0.0', 0));

  it('最小run数に満たないうちは保留する', () => {
    const after = [1, 2, 3, 4].map((i) => metrics(`a${i}`, mergedAt + i * DAY, '1.0.1', 1));
    expect(
      evaluateImprovement({ spec, mergedAt, version: '1.0.1' }, [...before, ...after]),
    ).toEqual({ kind: 'hold', have: 4, need: 5 });
  });

  it('プロンプトのハッシュが違うrunは評価に使わない', () => {
    const after = [1, 2, 3, 4].map((i) => metrics(`a${i}`, mergedAt + i * DAY, '1.0.1', 1));
    const other = metrics('x', mergedAt + 9 * DAY, '1.0.1', 1, 'p2');
    expect(
      evaluateImprovement({ spec, mergedAt, version: '1.0.1' }, [...before, ...after, other]).kind,
    ).toBe('hold');
  });

  it('閾値を超えて増えたら悪化、そうでなければ維持', () => {
    const worse = [1, 2, 3, 4, 5].map((i) => metrics(`a${i}`, mergedAt + i * DAY, '1.0.1', 1));
    expect(
      evaluateImprovement({ spec, mergedAt, version: '1.0.1' }, [...before, ...worse]).kind,
    ).toBe('worsened');
    const same = [1, 2, 3, 4, 5].map((i) => metrics(`a${i}`, mergedAt + i * DAY, '1.0.1', 0));
    expect(
      evaluateImprovement({ spec, mergedAt, version: '1.0.1' }, [...before, ...same]).kind,
    ).toBe('kept');
  });

  it('墓標と同じ対象・指標で新しい根拠が無ければ拒否する', () => {
    const tomb = {
      target: 't',
      metric: 'sendBacks' as const,
      evidence: [LESSON_ID],
      improvementIssue: 1,
      revertIssue: 2,
      at: 0,
    };
    expect(findBlockingTombstone([tomb], spec)).toBe(tomb);
    expect(findBlockingTombstone([tomb], { ...spec, evidence: [LESSON_ID, 'new'] })).toBe(
      undefined,
    );
    expect(findBlockingTombstone([tomb], { ...spec, metric: 'questions' })).toBe(undefined);
  });
});

describe('RunRetrospective', () => {
  let dir: string;
  let forge: FakeForge;
  let usage: number | undefined;
  let now: number;
  let lessons: LessonRecord[];
  let logs: string[];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'retro-'));
    forge = fakeForge();
    usage = 10;
    now = T0 + 30 * DAY;
    lessons = [];
    logs = [];
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const createdAt = (i: number) => {
    const c = forge.created[i];
    if (c === undefined) {
      throw new Error(`起票${String(i)}件目が無い`);
    }
    return c;
  };
  const metricsDir = () => path.join(dir, 'run-metrics');
  const stateDir = () => path.join(dir, 'self-improve');

  function retro(): RunRetrospective {
    return new RunRetrospective({
      stateDir: stateDir(),
      metricsDir: metricsDir(),
      runNotes: {
        listLessons: async () => lessons,
        listRemaining: async () => [] as RemainingRecord[],
      },
      forge,
      ownRepo: 'Owner/Repo',
      budgetConfig: () => ({ maxPerWeek: 3, weeklyUsageThresholdPct: 80 }),
      weeklyUsagePct: async () => usage,
      now: () => now,
      log: (m) => logs.push(m),
    });
  }

  async function writeMetrics(m: RunMetrics): Promise<void> {
    await fs.mkdir(metricsDir(), { recursive: true });
    await fs.writeFile(path.join(metricsDir(), `${m.runId}.json`), JSON.stringify(m));
  }

  function run(runId: string, title?: string): TaskRun {
    return createTaskRun({
      workspaceRoot: '/repo',
      engine: 'claude',
      maxParallel: 1,
      runId,
      now: new Date(now),
      ...(title === undefined ? {} : { title }),
    });
  }

  async function finishedRun(runId: string): Promise<TaskRun> {
    await writeMetrics(metrics(runId, now - DAY, '1.0.0', 1));
    lessons = [lesson(runId)];
    return run(runId);
  }

  it('予算内なら改善Issueを起票し、指標と閾値を事前登録する', async () => {
    await retro().onRunFinished(await finishedRun('r1'));
    expect(forge.created).toHaveLength(1);
    const issue = createdAt(0);
    expect(issue.labels).toEqual(['self-improve']);
    expect(issue.body).toContain('"metric":"sendBacks"');
    expect(issue.body).toContain('"thresholdPct":20');
    expect(issue.body).toContain('"minRuns":5');
    const key = improvementKey('promoteLesson:src/orchestrator/taskStagePrompts.ts', 'sendBacks', [
      LESSON_ID,
    ]);
    expect(issue.body).toContain(`\`${key}\``);
    const ledger = JSON.parse(await fs.readFile(path.join(stateDir(), 'budget.json'), 'utf8'));
    expect(ledger.entries).toHaveLength(1);
    // 同じ改善は二度起票しない
    await retro().onRunFinished(run('r1'));
    expect(forge.created).toHaveLength(1);
  });

  it('この拡張自身のリポジトリでないrunからは起票しない', async () => {
    forge.repoInfo = async () => ({ nameWithOwner: 'someone/else', visibility: 'public' });
    await retro().onRunFinished(await finishedRun('r1'));
    expect(forge.created).toHaveLength(0);
    expect(logs.join('\n')).toContain('この拡張自身のリポジトリでない');
  });

  it('保護パスに触れる案は調査Issueへ回る', async () => {
    forge.protectedPaths = ['src/orchestrator/taskStagePrompts.ts'];
    await retro().onRunFinished(await finishedRun('r1'));
    expect(forge.created).toHaveLength(1);
    expect(createdAt(0).labels).toEqual(['research']);
  });

  it('plugin向けの教訓はpluginのロードマップへ起票し、同期の状態を記録に残す', async () => {
    const created: string[] = [];
    let roadmap = '## READY\n- [ ] #1 a\n\n## DONE\n';
    const r = new RunRetrospective({
      stateDir: stateDir(),
      metricsDir: metricsDir(),
      runNotes: {
        listLessons: async () => [
          { ...lesson('r1'), instruction: 'skills/foo/SKILL.mdの手順を直す' },
        ],
        listRemaining: async () => [] as RemainingRecord[],
      },
      forge,
      plugin: () => ({
        repo: 'me/plugin',
        forge: {
          repoVisibility: async () => 'public',
          readRoadmap: async () => ({ issueNumber: 10, body: roadmap }),
          readResearch: async () => ({ issueNumber: 11, body: '## 提案\n' }),
          findIssueByKey: async () => undefined,
          createIssue: async (_r, issue) => {
            created.push(issue.title);
            return { ok: true, issueNumber: 50 };
          },
          createResearchIssue: async () => ({ ok: true, issueNumber: 11 }),
          updateIssueBody: async (_r, _n, body) => {
            roadmap = body;
            return true;
          },
          readHeadCommit: async () => 'abc',
        },
        installedCommit: async () => 'def',
      }),
      ownRepo: 'Owner/Repo',
      budgetConfig: () => ({ maxPerWeek: 3, weeklyUsageThresholdPct: 80 }),
      weeklyUsagePct: async () => usage,
      now: () => now,
      log: (m) => logs.push(m),
    });
    await r.onRunFinished(await finishedRun('r1'));
    expect(created).toHaveLength(1);
    expect(roadmap).toContain('#50');
    const log = await fs.readFile(path.join(stateDir(), 'retrospective-log.jsonl'), 'utf8');
    expect(log).toContain('"event":"pluginRoadmap"');
    expect(log).toContain('不一致');
  });

  it('週次使用率が閾値以上なら振り返りを止め、記録に残す', async () => {
    usage = 85;
    await retro().onRunFinished(await finishedRun('r1'));
    expect(forge.created).toHaveLength(0);
    const log = await fs.readFile(path.join(stateDir(), 'retrospective-log.jsonl'), 'utf8');
    expect(log).toContain('"event":"stopped"');
    expect(log).toContain('週次使用率85%');
  });

  it('週次使用率が分からないときは起票せず、理由を記録に残す', async () => {
    usage = undefined;
    await retro().onRunFinished(await finishedRun('r1'));
    expect(forge.created).toHaveLength(0);
    const log = await fs.readFile(path.join(stateDir(), 'retrospective-log.jsonl'), 'utf8');
    expect(log).toContain('"event":"stopped"');
    expect(log).toContain('週次使用率が分からない');
  });

  it('古いロックを同時に外そうとしても、同時に入るのは1プロセスだけ', async () => {
    // 起動を数msずらさないと、全員が同時に古さを見て修正前でも通る。修正前は最大3同時になる。
    let maxInside = 0;
    for (let round = 0; round < 20; round++) {
      const lock = path.join(dir, `race${round}.lock`);
      await fs.writeFile(lock, '1');
      const old = new Date(Date.now() - 60_000);
      await fs.utimes(lock, old, old);
      let inside = 0;
      const run = async (i: number) => {
        await new Promise((r) => setTimeout(r, i % 3));
        await withFileLock(
          lock,
          async () => {
            inside += 1;
            maxInside = Math.max(maxInside, inside);
            await new Promise((r) => setTimeout(r, 15));
            inside -= 1;
          },
          { staleMs: 30_000 },
        );
      };
      await Promise.all(Array.from({ length: 8 }, (_, i) => run(i)));
    }
    expect(maxInside).toBe(1);
  }, 60_000);

  it('自己改善のrunの終了時は改善案を出さない', async () => {
    await writeMetrics(metrics('r1', now - DAY, '1.0.0', 1));
    lessons = [lesson('r1')];
    await retro().onRunFinished(run('r1', `${SELF_IMPROVE_RUN_TITLE_PREFIX}5`));
    expect(forge.created).toHaveLength(0);
    expect(logs.join('\n')).toContain('自己改善のrunは振り返りで改善案を出さない');
  });

  it('ledgerが壊れていたら予算を0件へ戻さずに止める', async () => {
    await fs.mkdir(stateDir(), { recursive: true });
    await fs.writeFile(path.join(stateDir(), 'budget.json'), '{broken');
    await retro().onRunFinished(await finishedRun('r1'));
    expect(forge.created).toHaveLength(0);
    expect(logs.join('\n')).toContain('ledgerがJSONとして読めない');
  });

  it('悪化した改善はrevert Issueを1件だけ起票し、墓標で同じ再提案を拒否する', async () => {
    // 改善を起票（#100）
    await retro().onRunFinished(await finishedRun('r0'));
    expect(forge.created).toHaveLength(1);
    const mergedAt = now + DAY;
    forge.merge = {
      state: 'merged',
      mergedAt,
      version: '1.0.1',
      pullRequestNumber: 7,
      mergeCommit: 'abc',
    };
    // 改善前5本（0回）、改善後4本（1回）→ 保留
    for (const i of [1, 2, 3, 4, 5]) {
      await writeMetrics(metrics(`b${i}`, now - (10 - i) * DAY, '1.0.0', 0));
    }
    for (const i of [1, 2, 3, 4]) {
      await writeMetrics(metrics(`a${i}`, mergedAt + i * DAY, '1.0.1', 1));
    }
    now = mergedAt + 10 * DAY;
    lessons = [];
    await retro().onRunFinished(run('a4'));
    expect(forge.created).toHaveLength(1);
    expect(logs.join('\n')).toContain('4/5本のため判定を保留する');
    // 5本目で悪化と判定 → revertを1件
    await writeMetrics(metrics('a5', mergedAt + 5 * DAY, '1.0.1', 1));
    await retro().onRunFinished(run('a5'));
    await retro().onRunFinished(run('a5'));
    const reverts = forge.created.filter((c) => c.title.includes('revert'));
    expect(reverts).toHaveLength(1);
    expect(reverts[0]?.labels).toEqual(['self-improve']);
    const state = JSON.parse(
      await fs.readFile(path.join(stateDir(), 'retrospective.json'), 'utf8'),
    );
    expect(state.tombstones).toHaveLength(1);
    expect(state.improvements[0].verdict).toBe('reverted');
    // 同じ教訓からの再提案は、冪等キーとは別に墓標で拒否される
    state.improvements = [];
    await fs.writeFile(path.join(stateDir(), 'retrospective.json'), JSON.stringify(state));
    forge.created = forge.created.filter((c) => c.title.includes('revert'));
    await writeMetrics(metrics('r9', now - DAY, '1.0.1', 0));
    lessons = [lesson('r9')];
    await retro().onRunFinished(run('r9'));
    expect(forge.created).toHaveLength(1);
    expect(logs.join('\n')).toContain('墓標');
  });

  it('評価中の改善があるときと週次使用率が高いときは着手しない', async () => {
    await retro().onRunFinished(await finishedRun('r0'));
    forge.merge = {
      state: 'merged',
      mergedAt: now,
      version: '1.0.1',
      pullRequestNumber: 7,
      mergeCommit: 'abc',
    };
    let started = 0;
    const start = async () => {
      started++;
      return { ok: true as const, runId: 'n', message: 'ok' };
    };
    const input = {
      workspaceRoot: '/repo',
      engine: 'claude' as const,
      issueNumber: 101,
      runsInFolder: () => [],
      start,
    };
    const evaluating = await retro().startSelfImprove(input);
    expect(evaluating.ok).toBe(false);
    expect(evaluating.message).toContain('評価中の自己改善（#100）');
    forge.merge = { state: 'closedWithoutMerge' };
    // 改善を記録し直さず、別の状態で試すため作り直す
    await fs.rm(stateDir(), { recursive: true, force: true });
    usage = 90;
    const busy = await retro().startSelfImprove(input);
    expect(busy.ok).toBe(false);
    expect(busy.message).toContain('週次使用率90%');
    usage = undefined;
    const unknown = await retro().startSelfImprove(input);
    expect(unknown.ok).toBe(false);
    expect(unknown.message).toContain('週次使用率が分からない');
    usage = 10;
    const serial = await retro().startSelfImprove({
      ...input,
      runsInFolder: () => [run('s', `${SELF_IMPROVE_RUN_TITLE_PREFIX}9`)],
    });
    expect(serial.ok).toBe(false);
    const ok = await retro().startSelfImprove(input);
    expect(ok.ok).toBe(true);
    expect(started).toBe(1);
  });
});
