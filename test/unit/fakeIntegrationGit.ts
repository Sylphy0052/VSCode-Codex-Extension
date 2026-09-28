import { createHash } from 'node:crypto';

/**
 * 統合worktree（`.../<runId>/_integration`）でのgit操作を、commitの親子関係まで含めて模す
 * テスト用のモデル（Issue #1678）。`integration.ts`の統合経路が使うコマンド
 * （`show-ref`・`symbolic-ref`・`checkout`・`merge`・`rev-list --parents`・`update-ref`・
 * `merge-base --is-ancestor`）だけを扱い、それ以外は`handle`が`undefined`を返す
 * （呼び出し側のfakeが従来どおり応答する）。
 *
 * 統合ブランチ`wf/<runId>/integration`の先頭は既定で`'a'.repeat(40)`。タスクブランチの
 * 先頭はブランチ名から決まるSHAで、その親は既定の先頭とみなす。
 */

export interface FakeGitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface IntegrationGitModelOptions {
  /** `git merge --no-ff`のたびに呼ばれ、`true`ならその回を衝突として扱う。 */
  shouldConflict?: () => boolean;
  /** `git merge --no-ff`を常に（衝突ではない）失敗させる。 */
  failMerge?: boolean;
  /** `git merge --abort`を常に失敗させる（未解決の衝突は残ったまま）。 */
  failMergeAbort?: boolean;
}

export const INITIAL_TIP = 'a'.repeat(40);
const FULL_SHA = /^[0-9a-f]{40}$/u;
const INTEGRATION_REF = /^(?:refs\/heads\/)?(wf\/[^/]+\/integration)$/u;

const ok = (stdout = ''): FakeGitResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr = ''): FakeGitResult => ({ code: 1, stdout: '', stderr });

function shaOf(seed: string): string {
  return createHash('sha1').update(seed).digest('hex');
}

/** モデル上のタスクブランチの先頭SHA（統合経路は`git merge`へブランチ名ではなくこれを渡す）。 */
export function branchShaOf(branch: string): string {
  return shaOf(`branch:${branch.replace(/^refs\/heads\//u, '')}`);
}

function isIntegrationCwd(cwd: string): boolean {
  return /[/\\]_integration$/u.test(cwd);
}

function integrationBranchOf(cwd: string): string {
  const parts = cwd.split(/[/\\]/u);
  return `wf/${parts[parts.length - 2] ?? ''}/integration`;
}

export class IntegrationGitModel {
  private readonly parents = new Map<string, string[]>([[INITIAL_TIP, []]]);
  private readonly tips = new Map<string, string>();
  private readonly detached = new Map<string, string>();
  private commitCount = 0;
  private unresolved = false;
  private merging: { cwd: string; source: string } | undefined;

  constructor(private readonly options: IntegrationGitModelOptions = {}) {}

  /** 衝突を「解決してコミットした」状態にする（候補のmerge commitを作る）。 */
  resolveConflict(): void {
    this.unresolved = false;
    if (this.merging !== undefined) {
      const { cwd, source } = this.merging;
      this.merging = undefined;
      this.setHead(cwd, this.commit([this.headOf(cwd), source]));
    }
  }

  /** `git merge --abort`や`git reset`でマージを取り消した状態を模す（候補は作らない）。 */
  abandonConflict(): void {
    this.unresolved = false;
    this.merging = undefined;
  }

  /** 統合ブランチの先頭。 */
  tipOf(branch: string): string {
    return this.tips.get(branch) ?? INITIAL_TIP;
  }

  /** 統合ブランチの先頭を外から動かす（ref更新の直前に先頭が動く競合の再現用）。 */
  advanceTip(branch: string): string {
    const next = this.commit([this.tipOf(branch)]);
    this.tips.set(branch, next);
    return next;
  }

  isDetached(cwd: string): boolean {
    return this.detached.has(cwd);
  }

  handle(args: readonly string[], cwd: string): FakeGitResult | undefined {
    const [cmd, sub] = args;
    if (cmd === 'show-ref' && args.includes('--verify')) {
      const ref = args[args.length - 1] ?? '';
      return ok(`${this.resolve(ref, cwd)}\n`);
    }
    if (cmd === 'merge-base' && sub === '--is-ancestor') {
      const ancestor = this.resolve(args[2] ?? '', cwd);
      const descendant = this.resolve(args[3] ?? '', cwd);
      return this.reachable(ancestor, descendant) ? ok() : fail();
    }
    if (cmd === 'rev-parse' && args.includes('MERGE_HEAD')) {
      // `-q --verify`は不在のとき何も出力しない（`isMergeResolutionComplete`はstderrのある
      // 非0を「不明」として扱う）
      return this.unresolved ? ok(`${this.merging?.source ?? INITIAL_TIP}\n`) : fail();
    }
    if (cmd === 'diff' && args.includes('--diff-filter=U')) {
      return ok(this.unresolved ? 'CONFLICT.txt\n' : '');
    }
    if (cmd === 'merge' && sub === '--abort') {
      if (this.options.failMergeAbort === true) {
        return fail('fatal: fake merge --abort failure');
      }
      this.abandonConflict();
      return ok();
    }
    if (!isIntegrationCwd(cwd)) {
      return undefined;
    }
    if (cmd === 'rev-parse' && sub === 'HEAD') {
      return ok(`${this.headOf(cwd)}\n`);
    }
    if (cmd === 'symbolic-ref') {
      return this.detached.has(cwd) ? fail() : ok(`refs/heads/${integrationBranchOf(cwd)}\n`);
    }
    if (cmd === 'checkout' && sub === '--detach') {
      this.detached.set(cwd, this.resolve(args[2] ?? 'HEAD', cwd));
      return ok();
    }
    if (cmd === 'checkout' && sub === integrationBranchOf(cwd)) {
      this.detached.delete(cwd);
      return ok();
    }
    if (cmd === 'rev-list' && sub === '--parents') {
      const head = this.headOf(cwd);
      return ok(`${[head, ...(this.parents.get(head) ?? [])].join(' ')}\n`);
    }
    if (cmd === 'update-ref') {
      const branch = INTEGRATION_REF.exec(sub ?? '')?.[1];
      if (branch === undefined) {
        return fail(`fatal: unexpected ref ${sub ?? ''}`);
      }
      if (this.tipOf(branch) !== args[3]) {
        return fail(`fatal: cannot lock ref 'refs/heads/${branch}': is at ${this.tipOf(branch)}`);
      }
      this.tips.set(branch, args[2] ?? '');
      return ok();
    }
    if (cmd === 'merge' && sub === '--no-ff') {
      const source = this.resolve(args[args.length - 1] ?? '', cwd);
      if (this.options.shouldConflict?.() === true) {
        this.unresolved = true;
        this.merging = { cwd, source };
        return fail('CONFLICT (content): fake conflict');
      }
      if (this.options.failMerge === true) {
        return fail('fatal: fake merge failure');
      }
      this.setHead(cwd, this.commit([this.headOf(cwd), source]));
      return ok();
    }
    return undefined;
  }

  private resolve(name: string, cwd: string): string {
    if (FULL_SHA.test(name)) {
      return name;
    }
    if (name === 'HEAD') {
      return isIntegrationCwd(cwd) ? this.headOf(cwd) : INITIAL_TIP;
    }
    const integration = INTEGRATION_REF.exec(name)?.[1];
    if (integration !== undefined) {
      return this.tipOf(integration);
    }
    const sha = branchShaOf(name);
    if (!this.parents.has(sha)) {
      this.parents.set(sha, [INITIAL_TIP]);
    }
    return sha;
  }

  private headOf(cwd: string): string {
    return this.detached.get(cwd) ?? this.tipOf(integrationBranchOf(cwd));
  }

  private setHead(cwd: string, sha: string): void {
    if (this.detached.has(cwd)) {
      this.detached.set(cwd, sha);
    } else {
      this.tips.set(integrationBranchOf(cwd), sha);
    }
  }

  private commit(parents: string[]): string {
    this.commitCount += 1;
    const sha = shaOf(`commit:${this.commitCount}`);
    this.parents.set(sha, parents);
    return sha;
  }

  private reachable(ancestor: string, descendant: string): boolean {
    const stack = [descendant];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (sha === ancestor) {
        return true;
      }
      if (!seen.has(sha)) {
        seen.add(sha);
        stack.push(...(this.parents.get(sha) ?? []));
      }
    }
    return false;
  }
}
