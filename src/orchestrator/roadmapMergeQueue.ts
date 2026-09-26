/**
 * ロードマップ実行（Issue #1465 分割案7）のmergeの列。`ready_for_merge`でmerge待ちになった
 * ノードを、リポジトリ（`workspaceRoot`）ごとに1本の列で順にmergeし、後片付けまで進める。
 *
 * 1ノードの手順:
 * 1. merge中にする。PRが既にmerge済みなら後片付けへ飛ぶ
 * 2. worktreeで`origin/main`を取り込む。衝突が`package.json`・`package-lock.json`の
 *    `"version"`行だけなら`origin/main`側を採って自動で解く。それ以外の衝突は取り込みを
 *    取り消し、修復用の実行回（`mergeRepair`）へ差し戻す
 * 3. 検証コマンド（`agent.roadmapRun.merge.verifyCommands`）を流す。失敗したら差し戻す
 * 4. 版上げコマンド（`agent.roadmapRun.merge.versionBumpCommand`）を流してcommitする。
 *    検証より後に置くのは、差し戻しで版番号を空けないため
 * 5. pushし、CIの完了を待ってmergeする（`runFinalMergeWithCiGate`）。CIの失敗は差し戻す
 * 6. mergeをリモートで確かめ、リモートのブランチ・worktree・ローカルのブランチを消して終了にする
 *
 * 差し戻せない失敗（push・mergeの拒否、許可されなかった等）はノードを失敗（要対応）にする。
 * 人が「実行」を押すと`requeueMerge`で列へ戻る。コマンドの実行はrunごとに1回、利用者の
 * 許可を取る（信頼されていないワークスペースでは実行しない）。
 */

import * as path from 'node:path';

import { runFinalMergeWithCiGate, type CliCommandRunner, type ForgeHost } from './forge';
import type { MergeRepairRequest, StartIssueOutcome } from './roadmapIssueRunner';
import {
  getIssue,
  markIssueDone,
  markMergeCleanup,
  markMergeFailed,
  markMerging,
  type RoadmapIssueExecution,
  type RoadmapRun,
} from './roadmapRunState';
import { verifyCommandsDigest, type VerifyCommandEntry } from './runnerVerifyCommands';
import { SerialQueue } from './serialQueue';
import type { GitCommandRunner, WorktreeCreationQueue, WorktreeFileSystemPort } from './worktree';
import { runVerifyCommand, type VerifyCommandResult } from '../verification/commandRunner';

/** 検証の出力として修復の指示へ渡す上限（末尾から）。 */
const VERIFY_OUTPUT_TAIL_LENGTH = 4000;
/**
 * merge後、リモートでmerge済みになったかを確かめる回数と間隔（Issue #1487）。
 * mergeコマンド自体は成功しており、GitHub/GitLab側のAPI反映が遅いだけの可能性があるため、
 * 間隔を指数的に伸ばして合計で1〜2分程度は確かめ続ける（伸ばしても、待つのはこのノードの
 * confirmだけで、同じリポジトリの次のノードは次のmergeへ進む前に改めて`git fetch`するため
 * 順番待ちの意味は壊れない）。それでも確かめられなければ要対応にする（再開時、`merge()`冒頭の
 * `isPullRequestMerged`確認で自己回復する）。
 */
const MERGE_CONFIRM_ATTEMPTS = 7;
const MERGE_CONFIRM_BASE_INTERVAL_MS = 3_000;
const MERGE_CONFIRM_MAX_INTERVAL_MS = 30_000;
/** 版の衝突を自動で解いてよいファイル（worktreeの直下）。 */
const VERSION_FILES: ReadonlySet<string> = new Set(['package.json', 'package-lock.json']);
const VERSION_LINE = /^\s*"version":\s*"[^"\\]*",?\s*$/;
/** commitメッセージへ入れてよい版の形。 */
const SAFE_VERSION = /^[0-9A-Za-z.+-]{1,64}$/;
const SAFE_BRANCH = /^[A-Za-z0-9._/-]+$/;

export interface RoadmapMergeSettings {
  /** 空なら版上げしない。 */
  versionBumpCommand: string;
  verifyCommands: readonly string[];
}

export interface RoadmapMergeConsentRequest {
  roadmapIssueNumber: number;
  workspaceRoot: string;
  /** 実行するコマンド。空でもmerge・後片付けの許可は取る。 */
  commands: readonly VerifyCommandEntry[];
}

export interface RoadmapMergeQueueDeps {
  git: GitCommandRunner;
  cli: CliCommandRunner;
  fs: WorktreeFileSystemPort;
  writeTextFile(target: string, text: string): Promise<void>;
  worktreeQueue: WorktreeCreationQueue;
  detectHost(repoRoot: string): Promise<ForgeHost | undefined>;
  isPullRequestMerged(repoRoot: string, pullRequestNumber: number): Promise<boolean | undefined>;
  readSettings(repoRoot: string): RoadmapMergeSettings;
  isWorkspaceTrusted(): boolean;
  /** merge・後片付けとコマンドの実行を許可してもらう（モーダル）。 */
  confirm(request: RoadmapMergeConsentRequest): Promise<boolean>;
  /** `agent.workflows.ciWaitTimeoutSec`をミリ秒で。 */
  ciWaitTimeoutMs(): number;
  getRun(runId: string): RoadmapRun | undefined;
  /** Controller経由で状態を進める（`handleRunChanged`まで通す）。 */
  updateRun(runId: string, fn: (run: RoadmapRun) => RoadmapRun): Promise<RoadmapRun | undefined>;
  startMergeRepair(
    runId: string,
    issueNumber: number,
    request: MergeRepairRequest,
  ): Promise<StartIssueOutcome>;
  warn(runId: string, issueNumber: number, message: string): void;
  log(message: string): void;
  runCommand?: (command: string, cwd: string, signal: AbortSignal) => Promise<VerifyCommandResult>;
  now?: () => Date;
  wait?: (ms: number) => Promise<void>;
}

type StepOutcome =
  | { kind: 'merged' }
  | { kind: 'repair'; request: MergeRepairRequest }
  | { kind: 'failed'; message: string };

/**
 * 衝突マーカーの塊がどれも`"version"`行だけなら、`origin/main`側（取り込んだ側）を採った
 * 本文を返す。ほかの行を含む塊や、形の崩れたマーカーがあれば`undefined`。diff3形式の
 * 共通祖先（`|||||||`）の区画も`"version"`行だけのときに限り受け付ける。
 */
export function resolveVersionOnlyConflicts(text: string): string | undefined {
  const out: string[] = [];
  let section: 'none' | 'ours' | 'base' | 'theirs' = 'none';
  let sides: { ours: string[]; base: string[]; theirs: string[] } = { ours: [], base: [], theirs: [] };
  let found = false;
  const isVersionOnly = (lines: readonly string[]): boolean =>
    lines.every((line) => VERSION_LINE.test(line.replace(/\r$/, '')));
  for (const line of text.split('\n')) {
    if (line.startsWith('<<<<<<<')) {
      if (section !== 'none') {
        return undefined;
      }
      section = 'ours';
      sides = { ours: [], base: [], theirs: [] };
    } else if (line.startsWith('|||||||') && section === 'ours') {
      section = 'base';
    } else if (line.startsWith('=======') && (section === 'ours' || section === 'base')) {
      section = 'theirs';
    } else if (line.startsWith('>>>>>>>') && section === 'theirs') {
      if (
        sides.ours.length === 0 ||
        sides.theirs.length === 0 ||
        !isVersionOnly(sides.ours) ||
        !isVersionOnly(sides.base) ||
        !isVersionOnly(sides.theirs)
      ) {
        return undefined;
      }
      out.push(...sides.theirs);
      section = 'none';
      found = true;
    } else if (section === 'none') {
      out.push(line);
    } else {
      sides[section].push(line);
    }
  }
  return found && section === 'none' ? out.join('\n') : undefined;
}

function parseVersion(text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const version =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { version?: unknown }).version
        : undefined;
    return typeof version === 'string' && SAFE_VERSION.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

function describeFailure(result: VerifyCommandResult): string {
  if (result.timedOut) {
    return '時間切れ';
  }
  if (result.aborted) {
    return '中断';
  }
  return result.error ?? `終了コード ${String(result.exitCode)}`;
}

function abortFailedMessage(reason: string, abortMessage: string): string {
  return `${reason}。取り込みを取り消せず、worktreeが取り込みの途中のまま残っています。手で git merge --abort してから再開してください: ${abortMessage}`;
}

export class RoadmapMergeQueue {
  /** リポジトリごとの列。同じリポジトリのmergeは別runでも直列にする。 */
  private readonly lanes = new Map<string, SerialQueue>();
  /** 列に並んでいる・処理中のノード（`runId#N`）。 */
  private readonly queued = new Set<string>();
  /** runごとの許可（コマンド一覧のdigest）。メモリだけに持ち、再読み込み後は聞き直す。 */
  private readonly consents = new Map<string, string>();
  private readonly abort = new AbortController();
  private disposed = false;

  constructor(private readonly deps: RoadmapMergeQueueDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private wait(ms: number): Promise<void> {
    return this.deps.wait?.(ms) ?? new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** runの状態を見て、merge待ち・後片付け中のノードを列へ並べる。 */
  sync(run: RoadmapRun): void {
    if (this.disposed || run.haltedByUser || run.finishedAt !== undefined) {
      return;
    }
    for (const issue of Object.values(run.issues)) {
      if (
        issue.progress === 'running' &&
        issue.attention === 'none' &&
        (issue.phase === 'awaitingMerge' || issue.phase === 'cleanup')
      ) {
        this.enqueue(run.runId, run.workspaceRoot, issue.issueNumber);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.abort.abort();
  }

  private enqueue(runId: string, workspaceRoot: string, issueNumber: number): void {
    const key = `${runId}#${String(issueNumber)}`;
    if (this.queued.has(key)) {
      return;
    }
    this.queued.add(key);
    let lane = this.lanes.get(workspaceRoot);
    if (lane === undefined) {
      lane = new SerialQueue();
      this.lanes.set(workspaceRoot, lane);
    }
    void lane
      .enqueue(async () => {
        try {
          return await this.process(runId, issueNumber);
        } finally {
          this.queued.delete(key);
        }
      })
      .then(
        (repair) => {
          // 修復のセッションは列の鍵を放してから起こす（修復の間も他のノードのmergeを進める）
          if (repair !== undefined && !this.disposed) {
            void this.startRepair(runId, issueNumber, repair);
          }
        },
        (error: unknown) => {
          this.deps.log(`[roadmap run] #${String(issueNumber)}のmergeで例外: ${String(error)}`);
        },
      );
  }

  private async startRepair(
    runId: string,
    issueNumber: number,
    request: MergeRepairRequest,
  ): Promise<void> {
    const outcome = await this.deps.startMergeRepair(runId, issueNumber, request);
    if (!outcome.ok) {
      await this.fail(runId, issueNumber, `修復を始められませんでした: ${outcome.message}`);
    }
  }

  private async fail(runId: string, issueNumber: number, message: string): Promise<void> {
    this.deps.log(`[roadmap run] #${String(issueNumber)}: ${message}`);
    await this.deps.updateRun(runId, (r) => markMergeFailed(r, issueNumber, message, this.now()));
  }

  /** 1ノードを進める。修復へ差し戻すときだけ依頼を返す。 */
  private async process(runId: string, issueNumber: number): Promise<MergeRepairRequest | undefined> {
    const run = this.deps.getRun(runId);
    const issue = run === undefined ? undefined : getIssue(run, issueNumber);
    if (
      this.disposed ||
      run === undefined ||
      issue === undefined ||
      run.haltedByUser ||
      run.finishedAt !== undefined ||
      issue.progress !== 'running' ||
      issue.attention !== 'none'
    ) {
      return undefined;
    }
    try {
      if (issue.phase === 'cleanup') {
        await this.cleanup(run, issue);
        return undefined;
      }
      if (issue.phase !== 'awaitingMerge') {
        return undefined;
      }
      const outcome = await this.merge(run, issue);
      if (outcome.kind === 'failed') {
        await this.fail(runId, issueNumber, outcome.message);
        return undefined;
      }
      if (outcome.kind === 'repair') {
        return outcome.request;
      }
      const cleaned = await this.deps.updateRun(runId, (r) =>
        markMergeCleanup(r, issueNumber, this.now()),
      );
      const next = cleaned === undefined ? undefined : getIssue(cleaned, issueNumber);
      if (cleaned !== undefined && next?.phase === 'cleanup') {
        await this.cleanup(cleaned, next);
      }
      return undefined;
    } catch (error) {
      await this.fail(
        runId,
        issueNumber,
        `mergeの手順が例外で止まりました: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  /** runごとに1回、merge・後片付けとコマンドの実行を許可してもらう。 */
  private async ensureConsent(
    run: RoadmapRun,
    settings: RoadmapMergeSettings,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const commands: VerifyCommandEntry[] = [
      ...settings.verifyCommands.map((command) => ({ taskId: '検証', command })),
      ...(settings.versionBumpCommand === ''
        ? []
        : [{ taskId: '版上げ', command: settings.versionBumpCommand }]),
    ];
    if (commands.length > 0 && !this.deps.isWorkspaceTrusted()) {
      return {
        ok: false,
        message: '信頼されていないワークスペースでは、mergeの検証・版上げコマンドを実行しません',
      };
    }
    const digest = verifyCommandsDigest(commands);
    if (this.consents.get(run.runId) === digest) {
      return { ok: true };
    }
    const allowed = await this.deps.confirm({
      roadmapIssueNumber: run.roadmapIssueNumber,
      workspaceRoot: run.workspaceRoot,
      commands,
    });
    if (!allowed) {
      this.consents.delete(run.runId);
      return { ok: false, message: 'mergeを許可しませんでした' };
    }
    this.consents.set(run.runId, digest);
    return { ok: true };
  }

  private async git(args: readonly string[], cwd: string): Promise<{ ok: boolean; stdout: string; message: string }> {
    const result = await this.deps.git.run(args, cwd);
    const detail = result.stderr.trim() !== '' ? result.stderr.trim() : result.stdout.trim();
    return {
      ok: result.code === 0,
      stdout: result.stdout,
      message: `git ${args.join(' ')} に失敗しました（終了コード ${String(result.code)}）: ${detail}`,
    };
  }

  private runCommand(command: string, cwd: string): Promise<VerifyCommandResult> {
    return (
      this.deps.runCommand?.(command, cwd, this.abort.signal) ??
      runVerifyCommand({ command, cwd, signal: this.abort.signal })
    );
  }

  private async merge(run: RoadmapRun, issue: RoadmapIssueExecution): Promise<StepOutcome> {
    const n = issue.issueNumber;
    const { pullRequest, worktreePath: cwd, branch } = issue;
    if (pullRequest === undefined || cwd === undefined || branch === undefined) {
      return { kind: 'failed', message: 'PR・worktree・ブランチの記録が揃っていません' };
    }
    if (!SAFE_BRANCH.test(branch) || branch.startsWith('-')) {
      return { kind: 'failed', message: `扱えないブランチ名です: ${branch}` };
    }
    const settings = this.deps.readSettings(run.workspaceRoot);
    const consent = await this.ensureConsent(run, settings);
    if (!consent.ok) {
      return { kind: 'failed', message: consent.message };
    }
    const merging = await this.deps.updateRun(run.runId, (r) => markMerging(r, n, this.now()));
    if (merging === undefined || getIssue(merging, n)?.phase !== 'merging') {
      return { kind: 'failed', message: 'merge中へ進められませんでした' };
    }

    const host = await this.deps.detectHost(run.workspaceRoot);
    if (host === undefined) {
      return { kind: 'failed', message: 'originのホスティング（GitHub/GitLab）を判定できません' };
    }
    if ((await this.deps.isPullRequestMerged(run.workspaceRoot, pullRequest.number)) === true) {
      return { kind: 'merged' };
    }
    if (!(await this.deps.fs.pathExists(cwd))) {
      return { kind: 'failed', message: `worktreeが見つかりません: ${cwd}` };
    }

    const integrated = await this.integrateMain(cwd);
    if (integrated.kind !== 'ok') {
      return integrated;
    }
    const mainVersion = integrated.mainVersion;

    for (const command of settings.verifyCommands) {
      const result = await this.runCommand(command, cwd);
      if (result.exitCode !== 0) {
        if (result.aborted || this.disposed) {
          return { kind: 'failed', message: '拡張機能の終了で検証を中断しました' };
        }
        this.deps.log(`[roadmap run] #${String(n)}: 検証に失敗（${describeFailure(result)}）`);
        return {
          kind: 'repair',
          request: {
            mainVersion,
            conflictedFiles: [],
            failedVerification: {
              command,
              exitCode: result.exitCode,
              outputTail: result.output.slice(-VERIFY_OUTPUT_TAIL_LENGTH),
            },
          },
        };
      }
    }
    const dirty = await this.git(['status', '--porcelain', '--untracked-files=no'], cwd);
    if (!dirty.ok || dirty.stdout.trim() !== '') {
      return {
        kind: 'failed',
        message: await this.discardTrackedChanges(cwd, '検証コマンドが追跡中のファイルを書き換えました'),
      };
    }

    const bumped = await this.bumpVersion(cwd, settings.versionBumpCommand);
    if (!bumped.ok) {
      return { kind: 'failed', message: await this.discardTrackedChanges(cwd, bumped.message) };
    }

    const pushed = await this.git(['push', 'origin', `HEAD:refs/heads/${branch}`], cwd);
    if (!pushed.ok) {
      return { kind: 'failed', message: pushed.message };
    }
    const merged = await runFinalMergeWithCiGate(this.deps.cli, host, cwd, pullRequest.number, {
      waitTimeoutMs: this.deps.ciWaitTimeoutMs(),
      maxUpdateBranchRetries: 0,
      isCancelled: () => this.disposed || this.deps.getRun(run.runId)?.haltedByUser !== false,
    });
    if (!merged.ok) {
      if (merged.reason === 'ciFailed') {
        return {
          kind: 'repair',
          request: {
            mainVersion,
            conflictedFiles: [],
            failedVerification: { command: 'CI', exitCode: undefined, outputTail: merged.message },
          },
        };
      }
      return {
        kind: 'failed',
        message:
          merged.reason === 'cancelled' ? 'run全体の停止でmergeを中断しました' : merged.message,
      };
    }
    for (let i = 0; i < MERGE_CONFIRM_ATTEMPTS; i += 1) {
      if ((await this.deps.isPullRequestMerged(run.workspaceRoot, pullRequest.number)) === true) {
        return { kind: 'merged' };
      }
      if (i < MERGE_CONFIRM_ATTEMPTS - 1) {
        const interval = Math.min(
          MERGE_CONFIRM_BASE_INTERVAL_MS * 2 ** i,
          MERGE_CONFIRM_MAX_INTERVAL_MS,
        );
        await this.wait(interval);
      }
    }
    return { kind: 'failed', message: `PR #${String(pullRequest.number)}のmergeを確かめられませんでした` };
  }

  /** worktreeへ`origin/main`を取り込む。版の行だけの衝突は自動で解く。 */
  private async integrateMain(
    cwd: string,
  ): Promise<{ kind: 'ok'; mainVersion: string | undefined } | Exclude<StepOutcome, { kind: 'merged' }>> {
    const status = await this.git(['status', '--porcelain'], cwd);
    if (!status.ok) {
      return { kind: 'failed', message: status.message };
    }
    if (status.stdout.trim() !== '') {
      return { kind: 'failed', message: 'worktreeに未commitの変更があります' };
    }
    // `--prune`は付けない。取り込みの経路によってはorigin/mainが消える
    const fetched = await this.git(['fetch', 'origin'], cwd);
    if (!fetched.ok) {
      return { kind: 'failed', message: fetched.message };
    }
    const shown = await this.git(['show', 'origin/main:package.json'], cwd);
    const mainVersion = shown.ok ? parseVersion(shown.stdout) : undefined;
    const merge = await this.git(['merge', '--no-edit', 'origin/main'], cwd);
    if (merge.ok) {
      return { kind: 'ok', mainVersion };
    }
    const listed = await this.git(['diff', '--name-only', '--diff-filter=U'], cwd);
    const conflicted = listed.ok
      ? listed.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '')
      : [];
    if (conflicted.length === 0) {
      return { kind: 'failed', message: await this.abortMerge(cwd, merge.message) };
    }
    const remaining: string[] = [];
    for (const file of conflicted) {
      if (!VERSION_FILES.has(file) || !(await this.resolveVersionFile(cwd, file))) {
        remaining.push(file);
      }
    }
    if (remaining.length > 0) {
      const aborted = await this.git(['merge', '--abort'], cwd);
      if (!aborted.ok) {
        return { kind: 'failed', message: abortFailedMessage(merge.message, aborted.message) };
      }
      return { kind: 'repair', request: { mainVersion, conflictedFiles: remaining } };
    }
    const committed = await this.git(['commit', '--no-edit'], cwd);
    if (!committed.ok) {
      return { kind: 'failed', message: await this.abortMerge(cwd, committed.message) };
    }
    return { kind: 'ok', mainVersion };
  }

  /** 取り込みを取り消す。取り消せなければ、worktreeを手で戻す必要があることを理由へ足す。 */
  private async abortMerge(cwd: string, reason: string): Promise<string> {
    const aborted = await this.git(['merge', '--abort'], cwd);
    return aborted.ok ? reason : abortFailedMessage(reason, aborted.message);
  }

  /**
   * 検証・版上げのコマンドが書き換えた追跡中のファイルをHEADへ戻す。取り込みの前に未commitの
   * 変更が無いことを確かめているので、ここで消えるのはコマンドの書き換えだけ。戻さないと次の
   * 取り込みが冒頭の検査で同じ理由のまま失敗し続ける。
   */
  private async discardTrackedChanges(cwd: string, reason: string): Promise<string> {
    const reset = await this.git(['reset', '--hard', 'HEAD'], cwd);
    return reset.ok ? reason : `${reason}。書き換えを戻せませんでした: ${reset.message}`;
  }

  private async resolveVersionFile(cwd: string, file: string): Promise<boolean> {
    const target = path.join(cwd, file);
    const text = await this.deps.fs.readTextFile(target);
    const resolved = text === undefined ? undefined : resolveVersionOnlyConflicts(text);
    if (resolved === undefined) {
      return false;
    }
    await this.deps.writeTextFile(target, resolved);
    return (await this.git(['add', '--', file], cwd)).ok;
  }

  private async bumpVersion(
    cwd: string,
    command: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    if (command === '') {
      return { ok: true };
    }
    const result = await this.runCommand(command, cwd);
    if (result.exitCode !== 0) {
      return { ok: false, message: `版上げコマンドに失敗しました（${describeFailure(result)}）` };
    }
    const status = await this.git(['status', '--porcelain', '--untracked-files=no'], cwd);
    if (!status.ok) {
      return { ok: false, message: status.message };
    }
    if (status.stdout.trim() === '') {
      return { ok: true };
    }
    const version = parseVersion(await this.deps.fs.readTextFile(path.join(cwd, 'package.json')));
    const message =
      version === undefined ? 'chore: バージョンを上げる' : `chore: バージョンを${version}にする`;
    const committed = await this.git(['commit', '-am', message], cwd);
    return committed.ok ? { ok: true } : { ok: false, message: committed.message };
  }

  /** リモートのブランチ・worktree・ローカルのブランチを消してノードを終了にする。 */
  private async cleanup(run: RoadmapRun, issue: RoadmapIssueExecution): Promise<void> {
    const root = run.workspaceRoot;
    const n = issue.issueNumber;
    const branch = issue.branch;
    const safeBranch = branch !== undefined && SAFE_BRANCH.test(branch) && !branch.startsWith('-');
    if (safeBranch) {
      const ref = `refs/heads/${branch}`;
      const remote = await this.git(['ls-remote', '--heads', 'origin', ref], root);
      if (remote.ok && remote.stdout.trim() !== '') {
        const deleted = await this.git(['push', 'origin', '--delete', ref], root);
        if (!deleted.ok) {
          this.deps.warn(run.runId, n, `リモートのブランチを消せませんでした: ${deleted.message}`);
        }
      }
    }
    if (issue.worktreePath !== undefined && (await this.deps.fs.pathExists(issue.worktreePath))) {
      const removed = await this.deps.worktreeQueue.remove(
        root,
        run.runId,
        `issue-${String(n)}`,
        undefined,
        this.deps.git,
        this.deps.fs,
      );
      if (!removed.ok) {
        await this.fail(run.runId, n, `worktreeを撤去できませんでした: ${removed.message}`);
        return;
      }
    }
    if (safeBranch) {
      const local = await this.git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], root);
      if (local.ok) {
        const deleted = await this.git(['branch', '-D', branch], root);
        if (!deleted.ok) {
          this.deps.warn(run.runId, n, `ローカルのブランチを消せませんでした: ${deleted.message}`);
        }
      }
    }
    await this.deps.updateRun(run.runId, (r) => markIssueDone(r, n, this.now()));
  }
}
