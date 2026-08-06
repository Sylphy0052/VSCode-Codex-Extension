import { describe, expect, it } from 'vitest';
import { extractDefaults, parseTopLevelStrings } from '../../src/codex/configToml';

/** 実際の ~/.codex/config.toml を模したもの。 */
const realConfig = `# 共有可能な最小設定。
hide_agent_reasoning = true
sandbox_mode = "workspace-write"
approval_policy = "on-request"
model = "gpt-5.6-terra"
model_reasoning_effort = "medium"
personality = "pragmatic"

[features]
skills = true

[mcp_servers.playwright]
command = "npx"

[projects."/home/kfuruhashi/workspace"]
trust_level = "trusted"
`;

describe('extractDefaults', () => {
  it('実データから既定値を取り出す', () => {
    expect(extractDefaults(realConfig)).toEqual({
      model: 'gpt-5.6-terra',
      reasoningEffort: 'medium',
      approvalMode: 'on-request',
      sandbox: 'workspace-write',
    });
  });

  it('未設定のキーはundefinedになる', () => {
    expect(extractDefaults('model = "gpt-5.5"')).toEqual({
      model: 'gpt-5.5',
      reasoningEffort: undefined,
      approvalMode: undefined,
      sandbox: undefined,
    });
  });

  it('ファイルが空でも落ちない', () => {
    expect(extractDefaults('').model).toBeUndefined();
  });
});

describe('parseTopLevelStrings', () => {
  it('テーブルヘッダ以降を読まない（TOMLの意味論に一致させる）', () => {
    const content = 'model = "top"\n\n[profile.work]\nmodel = "inner"\n';
    expect(parseTopLevelStrings(content)['model']).toBe('top');
  });

  it('テーブル内の同名キーで上書きされない', () => {
    const content = '[features]\nmodel = "inner"\n';
    expect(parseTopLevelStrings(content)['model']).toBeUndefined();
  });

  it('行コメントと行末コメントを落とす', () => {
    const content = '# 説明\nmodel = "gpt-5.5"  # 使うモデル\n';
    expect(parseTopLevelStrings(content)['model']).toBe('gpt-5.5');
  });

  it('文字列中の # をコメントと誤認しない', () => {
    expect(parseTopLevelStrings('note = "a # b"')['note']).toBe('a # b');
  });

  it('シングルクォートと引用符なしを扱う', () => {
    const values = parseTopLevelStrings("a = 'x'\nb = 42\nc = true\n");
    expect(values['a']).toBe('x');
    expect(values['b']).toBe('42');
    expect(values['c']).toBe('true');
  });

  it('= を含む値を壊さない', () => {
    expect(parseTopLevelStrings('url = "https://x/y?a=b"')['url']).toBe('https://x/y?a=b');
  });

  it('壊れた行を無視する', () => {
    const values = parseTopLevelStrings('= 値だけ\nkey\n\nmodel = "ok"\n');
    expect(values).toEqual({ model: 'ok' });
  });
});
