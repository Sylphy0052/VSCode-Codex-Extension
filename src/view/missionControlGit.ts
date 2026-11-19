import type { GitCommandRunner } from '../orchestrator/worktree';

/**
 * MCが裏で走らせるgitの先頭へ付ける設定。信頼できないrepoの`.git/config`にある
 * `core.fsmonitor`（任意のコマンド）や`core.hooksPath`で、状態を読むだけのgitが
 * コマンドを走らせないようにする。
 */
export const SAFE_GIT_CONFIG_ARGS: readonly string[] = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
];

/** 全呼び出しの引数の先頭へ{@link SAFE_GIT_CONFIG_ARGS}を付けたrunnerを返す。 */
export function withSafeGitConfig(git: GitCommandRunner): GitCommandRunner {
  return {
    run: (args, cwd, options) => git.run([...SAFE_GIT_CONFIG_ARGS, ...args], cwd, options),
  };
}
