import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { computeRunMetrics, type RunMetrics, type RunMetricsKeys } from './runMetrics';
import { buildStagePrompt } from './taskStagePrompts';
import {
  TASK_STAGES,
  type OrchestratedTask,
  type StageReportRef,
  type TaskRun,
  type TaskStageRecord,
} from './taskRunState';

/**
 * runごとの指標（Issue #2081）の記録と、群分けの鍵の収集。1 runにつき1ファイル
 * （`<runId>.json`）で、ローカルに置きgitへ載せない。runIdごとに別ファイルなので、別ウィンドウが
 * 別のrunを同時に書いても消し合わない。
 */

/** `<globalStorage>`の下に作る置き場の名前。 */
export const RUN_METRICS_DIR_NAME = 'run-metrics';

/** 鍵に含める`~/.claude`の下の対象（plugin由来のファイルが載る場所）。 */
const PLUGIN_HASH_TARGETS = ['CLAUDE.md', 'rules', 'skills', 'agents', 'hooks'];
const MAX_HASHED_FILES = 2000;
const MAX_HASHED_FILE_BYTES = 1024 * 1024;

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function safeFileName(runId: string): string {
  return runId.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * 記録する。同じrunIdで`finishedAt`が同じ記録が既にあれば書かない（1回だけ）。再開して終わり直した
 * runは`finishedAt`が変わるので、同じファイルを置き換える（二重に記録しない）。
 * 一時ファイルへ書いてから改名するので、途中の内容は読まれない。
 */
export async function writeRunMetrics(
  dir: string,
  metrics: RunMetrics,
): Promise<'written' | 'skipped'> {
  const file = path.join(dir, `${safeFileName(metrics.runId)}.json`);
  await fs.mkdir(dir, { recursive: true });
  try {
    const existing = JSON.parse(await fs.readFile(file, 'utf8')) as { finishedAt?: unknown };
    if (existing.finishedAt === metrics.finishedAt) {
      return 'skipped';
    }
  } catch {
    // 無い、または壊れている。書き直す
  }
  const tmp = `${file}.${String(process.pid)}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(metrics, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
  return 'written';
}

function dummyStageRecord(): TaskStageRecord {
  return {
    status: 'notStarted',
    attempts: [],
    pendingDecision: undefined,
    completedAt: undefined,
  };
}

function dummyTask(): OrchestratedTask {
  return {
    taskId: 'T0',
    title: 'title',
    summary: 'summary',
    acceptanceCriteria: ['criteria'],
    dependsOn: [],
    existingIssueNumber: 1,
    executionId: 'execution',
    stages: {
      issuePlan: dummyStageRecord(),
      issueCreate: dummyStageRecord(),
      implement: dummyStageRecord(),
      review: dummyStageRecord(),
      mergeCleanup: dummyStageRecord(),
    },
    currentAttemptId: undefined,
    attention: 'none',
    failure: undefined,
    issueDraft: { title: 'draft', body: 'draft' },
    issueNumber: 1,
    worktreePath: undefined,
    branch: 'branch',
    pullRequest: { number: 1, url: 'https://example.invalid/pull/1' },
    review: undefined,
    updatedAt: '1970-01-01T00:00:00.000Z',
  };
}

/** 固定の入力で組んだ工程プロンプトのハッシュ。雛形が変われば変わる。 */
export function hashStagePrompts(): string {
  const task = dummyTask();
  const parts = TASK_STAGES.map((stage) => {
    const ref: StageReportRef = {
      taskId: task.taskId,
      executionId: 'execution',
      stage,
      attemptId: 'attempt',
    };
    try {
      return buildStagePrompt({ task, ref, instruction: 'instruction', cwd: '/cwd' }, 'nonce');
    } catch {
      return `unbuildable:${stage}`;
    }
  });
  return sha256(parts.join('\n---\n'));
}

async function collectFiles(root: string, budget: { left: number }): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const result: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (budget.left <= 0) {
      break;
    }
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await collectFiles(full, budget)));
    } else if (entry.isFile()) {
      budget.left -= 1;
      result.push(full);
    }
  }
  return result;
}

/** `~/.claude`のplugin由来ファイルの内容のハッシュ。1つも読めなければ`undefined`。 */
export async function hashPluginFiles(claudeHome: string): Promise<string | undefined> {
  const budget = { left: MAX_HASHED_FILES };
  const files: string[] = [];
  for (const target of PLUGIN_HASH_TARGETS) {
    const full = path.join(claudeHome, target);
    const stat = await fs.stat(full).catch(() => undefined);
    if (stat?.isFile() === true) {
      files.push(full);
    } else if (stat?.isDirectory() === true) {
      files.push(...(await collectFiles(full, budget)));
    }
  }
  if (files.length === 0) {
    return undefined;
  }
  const hash = createHash('sha256');
  for (const file of files) {
    try {
      const stat = await fs.stat(file);
      if (stat.size > MAX_HASHED_FILE_BYTES) {
        hash.update(`${path.relative(claudeHome, file)}\0size:${String(stat.size)}\n`);
        continue;
      }
      hash.update(`${path.relative(claudeHome, file)}\0`);
      hash.update(await fs.readFile(file));
      hash.update('\n');
    } catch {
      hash.update(`${path.relative(claudeHome, file)}\0unreadable\n`);
    }
  }
  return hash.digest('hex');
}

/** `installed_plugins.json`から、pluginごとの同期元のcommit SHAを取る。取れた分だけ返す。 */
export async function readPluginCommits(claudeHome: string): Promise<Record<string, string>> {
  try {
    const raw = JSON.parse(
      await fs.readFile(path.join(claudeHome, 'plugins', 'installed_plugins.json'), 'utf8'),
    ) as { plugins?: Record<string, readonly { gitCommitSha?: unknown }[]> };
    const result: Record<string, string> = {};
    for (const [name, installs] of Object.entries(raw.plugins ?? {})) {
      const sha = installs[0]?.gitCommitSha;
      if (typeof sha === 'string' && /^[0-9a-f]{7,64}$/.test(sha)) {
        result[name] = sha;
      }
    }
    return result;
  } catch {
    return {};
  }
}

export interface RunMetricsKeySources {
  extensionVersion: string;
  /** 工程の上限値（送信回数・差し戻し・自動やり直し・関門の保持数など）。 */
  limits: Readonly<Record<string, number>>;
  claudeHome: string;
}

export async function collectRunMetricsKeys(src: RunMetricsKeySources): Promise<RunMetricsKeys> {
  const limits = Object.entries(src.limits).sort(([a], [b]) => a.localeCompare(b));
  return {
    extensionVersion: src.extensionVersion,
    promptHash: hashStagePrompts(),
    limitsHash: sha256(JSON.stringify(limits)),
    pluginHash: await hashPluginFiles(src.claudeHome),
    pluginCommits: await readPluginCommits(src.claudeHome),
  };
}

export interface RunMetricsRecorderDeps extends RunMetricsKeySources {
  dir: string;
  log(message: string): void;
}

/**
 * runが終わったときに呼ぶ記録器。失敗してもrunの進行は止めず、ログへ残す。
 * 同じrunIdの記録は直列にして、同時の呼び出しが同じファイルを競わないようにする。
 */
export function createRunMetricsRecorder(
  deps: RunMetricsRecorderDeps,
): (run: TaskRun) => Promise<void> {
  const chains = new Map<string, Promise<void>>();
  return (run) => {
    const task = (chains.get(run.runId) ?? Promise.resolve()).then(async () => {
      try {
        const keys = await collectRunMetricsKeys(deps);
        const metrics = computeRunMetrics(run, keys);
        if (metrics !== undefined) {
          await writeRunMetrics(deps.dir, metrics);
        }
      } catch (e) {
        deps.log(
          `[run metrics] 指標を記録できませんでした（${run.runId}）: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    });
    chains.set(run.runId, task);
    return task;
  };
}
