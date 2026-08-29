import { describe, expect, it } from 'vitest';
import {
  AUTO_CLAUDE_MODEL,
  CODEX_CONFIG_OVERRIDES,
  CODEX_DENIED_FEATURES,
  buildClaudeHeadlessArgs,
  buildCodexHeadlessArgs,
} from '../../src/loop/headlessCli';

/**
 * 脇役（Evaluator / Advisor / ゴール下書き）を起動する引数（issue #962）。
 *
 * ここで確かめるのは書き方ではなく**安全契約**そのもの。実測では、禁止の列挙が無い状態の
 * Codexが作業ディレクトリの外・ホーム配下・環境変数を読み、さらに利用者のアカウントに
 * 繋がった外部アプリのツールまで呼べた。引数が1つ欠けるとその状態へ戻るため、
 * 欠落が黙って通らないようにテストで固定する。
 */

/** `--disable X` の X を並び順のまま取り出す。 */
function disabledFeatures(args: readonly string[]): string[] {
  return args.flatMap((arg, index) => (args[index - 1] === '--disable' ? [arg] : []));
}

/** `-c K=V` の K=V を並び順のまま取り出す。 */
function configOverrides(args: readonly string[]): string[] {
  return args.flatMap((arg, index) => (args[index - 1] === '-c' ? [arg] : []));
}

describe('buildCodexHeadlessArgs', () => {
  it('禁止する能力をすべて落とす', () => {
    const args = buildCodexHeadlessArgs('auto', '/tmp/out.txt');
    // 実測で到達を確認した経路。1つでも欠けると読み取りか外部到達が復活する。
    expect(disabledFeatures(args)).toEqual([
      'shell_tool',
      'unified_exec',
      'apps',
      'plugins',
      'browser_use',
      'browser_use_external',
      'browser_use_full_cdp_access',
      'in_app_browser',
      'computer_use',
      'image_generation',
      'multi_agent',
      'view_image',
      'code_mode_host',
    ]);
  });

  it('フラグで落とせない能力を設定値で塞ぐ', () => {
    const args = buildCodexHeadlessArgs('auto', '/tmp/out.txt');
    expect(configOverrides(args)).toEqual([
      'tools.web_search=false',
      'shell_environment_policy.inherit=none',
    ]);
  });

  it('公開している禁止リストと実際の引数が一致する', () => {
    // 定数だけ直して引数の組み立てを直し忘れる、の逆も同じく防ぐ。
    const args = buildCodexHeadlessArgs('auto', '/tmp/out.txt');
    expect(disabledFeatures(args)).toEqual([...CODEX_DENIED_FEATURES]);
    expect(configOverrides(args)).toEqual([...CODEX_CONFIG_OVERRIDES]);
  });

  it('既存の必須引数を残す', () => {
    const args = buildCodexHeadlessArgs('auto', '/tmp/out.txt');
    expect(args[0]).toBe('exec');
    expect(args).toContain('--ephemeral');
    expect(args).toContain('--ignore-user-config');
    expect(args).toContain('--skip-git-repo-check');
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(args[args.indexOf('-o') + 1]).toBe('/tmp/out.txt');
  });

  it('modelの指定によらず禁止の集合が変わらない', () => {
    const auto = buildCodexHeadlessArgs('auto', '/tmp/out.txt');
    const empty = buildCodexHeadlessArgs('', '/tmp/out.txt');
    const explicit = buildCodexHeadlessArgs('gpt-5-codex', '/tmp/out.txt');
    expect(disabledFeatures(empty)).toEqual(disabledFeatures(auto));
    expect(disabledFeatures(explicit)).toEqual(disabledFeatures(auto));
    expect(configOverrides(explicit)).toEqual(configOverrides(auto));
  });

  it('modelは指定したときだけ渡す', () => {
    expect(buildCodexHeadlessArgs('auto', '/tmp/out.txt')).not.toContain('-m');
    expect(buildCodexHeadlessArgs('', '/tmp/out.txt')).not.toContain('-m');
    const explicit = buildCodexHeadlessArgs('gpt-5-codex', '/tmp/out.txt');
    expect(explicit[explicit.indexOf('-m') + 1]).toBe('gpt-5-codex');
  });

  it('禁止リストが空でないこと（テストの陽性対照）', () => {
    // 上の比較はどちらも空なら通ってしまうため、空でないことを別に押さえる。
    expect(CODEX_DENIED_FEATURES.length).toBeGreaterThan(0);
    expect(CODEX_CONFIG_OVERRIDES.length).toBeGreaterThan(0);
  });
});

describe('buildClaudeHeadlessArgs', () => {
  it('ツールと利用者設定を無効化する', () => {
    const args = buildClaudeHeadlessArgs('auto');
    expect(args).toContain('-p');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
    expect(args[args.indexOf('--output-format') + 1]).toBe('json');
  });

  it('modelの既定を補い、指定があれば従う', () => {
    const auto = buildClaudeHeadlessArgs('auto');
    expect(auto[auto.indexOf('--model') + 1]).toBe(AUTO_CLAUDE_MODEL);
    const empty = buildClaudeHeadlessArgs('');
    expect(empty[empty.indexOf('--model') + 1]).toBe(AUTO_CLAUDE_MODEL);
    const explicit = buildClaudeHeadlessArgs('sonnet');
    expect(explicit[explicit.indexOf('--model') + 1]).toBe('sonnet');
  });
});
