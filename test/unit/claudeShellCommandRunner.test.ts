import { describe, expect, it } from 'vitest';
import { createNodeShellCommandRunner, nodeShellCommandRunner } from '../../src/process/shellCommandRunner';

/**
 * `nodeShellCommandRunner` は実際に子プロセスを起動する（`worktree.test.ts` が
 * `nodeGitCommandRunner` で実gitを叩くのと同じ流儀）。cwdは常にこのファイル自身の
 * ディレクトリを使う（実在することが保証されているため）。
 */
const CWD = __dirname;

describe('nodeShellCommandRunner', () => {
  it('標準出力を読み取り、終了コード0で返す', async () => {
    const result = await nodeShellCommandRunner.run(
      'node -e "process.stdout.write(\'hello\')"',
      CWD,
      5000,
    );
    expect(result.stdout).toBe('hello');
    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.spawnError).toBeUndefined();
    expect(result.truncated).toBe(false);
  });

  it('パイプ・リダイレクトが効く（shell経由で実行している）', async () => {
    const result = await nodeShellCommandRunner.run(
      'node -e "console.log(1);console.log(2)" | node -e "process.exit(0)"',
      CWD,
      5000,
    );
    expect(result.code).toBe(0);
  });

  it('標準エラーと非ゼロの終了コードを返す', async () => {
    const result = await nodeShellCommandRunner.run(
      'node -e "process.stderr.write(\'bad\');process.exit(2)"',
      CWD,
      5000,
    );
    expect(result.stderr).toBe('bad');
    expect(result.code).toBe(2);
  });

  it('タイムアウトを超えたら打ち切り、timedOut: true を返す', async () => {
    const result = await nodeShellCommandRunner.run(
      'node -e "setTimeout(() => {}, 5000)"',
      CWD,
      200,
    );
    expect(result.timedOut).toBe(true);
  }, 10_000);

  it('起動できない場合はspawnErrorを返す（cwdが存在しない）', async () => {
    const result = await nodeShellCommandRunner.run('echo hi', '/no/such/directory/xyz', 5000);
    expect(result.spawnError).toBeDefined();
    expect(result.code).toBeNull();
  });

  it('出力が上限を超えたら先頭を切り詰め、truncated: true を返す', async () => {
    // 1MBの上限に対して、余裕を持って2MB分出力させる
    const result = await nodeShellCommandRunner.run(
      'node -e "process.stdout.write(\'x\'.repeat(2 * 1024 * 1024))"',
      CWD,
      5000,
    );
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThan(2 * 1024 * 1024);
  }, 10_000);

  it('AbortSignalで中断すると、実行中のプロセスを打ち切りaborted: trueを返す（Issue #5）', async () => {
    const controller = new AbortController();
    const promise = nodeShellCommandRunner.run(
      'node -e "setTimeout(() => {}, 5000)"',
      CWD,
      5000,
      controller.signal,
    );
    controller.abort();
    const result = await promise;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
  }, 10_000);

  it('既にabortされたsignalを渡すと、起動せずaborted: trueを返す', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await nodeShellCommandRunner.run('echo hi', CWD, 5000, controller.signal);
    expect(result.aborted).toBe(true);
    expect(result.code).toBeNull();
  });

  it('signalを渡さなければabortedは常にfalse', async () => {
    const result = await nodeShellCommandRunner.run('echo hi', CWD, 5000);
    expect(result.aborted).toBe(false);
  });

  it(
    'SIGTERMを無視するコマンドはSIGKILLへエスカレーションして打ち切る（レビュー指摘: ' +
      'trap \'\' TERM; sleep 30 にSIGTERMを送ってもcloseが4秒後まで発火しないことを実プロセスで確認済み）',
    async () => {
      // 猶予をテスト用に短くして、テスト全体が遅くなりすぎないようにする
      const runner = createNodeShellCommandRunner(300);
      const result = await runner.run("trap '' TERM; sleep 30", CWD, 200);
      expect(result.timedOut).toBe(true);
      expect(result.aborted).toBe(false);
    },
    10_000,
  );
});
