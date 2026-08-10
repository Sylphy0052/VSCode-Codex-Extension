import { describe, expect, it } from 'vitest';
import { CommandCatalog } from '../../src/provider/commandCatalog';
import type { FileSystemPort } from '../../src/session/ports';

const files: Record<string, string> = {
  '/home/.codex/prompts/doc.md': '---\ndescription: ドキュメントを書く\n---\n本文',
  '/home/.codex/prompts/commit.md': '---\ndescription: コミットする\n---',
  '/home/.claude/skills/daily-report/SKILL.md':
    '---\nname: daily-report\ndescription: 日報を書く\n---',
  '/home/.claude/commands/deploy.md': '---\ndescription: デプロイする\n---',
  '/home/.codex/skills/gitlab-commit/SKILL.md':
    '---\nname: gitlab-commit\ndescription: コミットする\n---',
  '/work/.claude/skills/local-skill/SKILL.md': '---\ndescription: この作業用\n---',
  '/work/.codex/prompts/local-prompt.md': '---\ndescription: この作業用のプロンプト\n---',
  // スキルの参照ファイル。候補に出してはいけない
  '/home/.codex/skills/slides-maker/SKILL.md': '---\ndescription: スライドを作る\n---',
  '/home/.codex/skills/slides-maker/design-guidelines.md': '# 配色の指針',
  '/home/.claude/commands/nested/deep.md': '---\ndescription: 深すぎる\n---',
};

const fs = {
  async readTextFile(filePath: string) {
    return files[filePath];
  },
  async listMarkdown(dir: string) {
    return Object.keys(files).filter((p) => p.startsWith(`${dir}/`));
  },
} as unknown as FileSystemPort;

describe('CommandCatalog', () => {
  it('Codexのカスタムプロンプトを集める', async () => {
    const commands = await new CommandCatalog(fs).forCodex('/home/.codex', []);
    expect(commands.map((c) => c.name)).toEqual(expect.arrayContaining(['doc', 'commit']));
  });

  it('Codexのスキルも集める', async () => {
    const commands = await new CommandCatalog(fs).forCodex('/home/.codex', []);
    expect(commands.map((c) => c.name)).toContain('gitlab-commit');
  });

  it('Codexもワークスペース側を混ぜる', async () => {
    const commands = await new CommandCatalog(fs).forCodex('/home/.codex', ['/work']);
    expect(commands.map((c) => c.name)).toContain('local-prompt');
  });

  it('Claude Codeのスキルとコマンドを集める', async () => {
    const commands = await new CommandCatalog(fs).forClaude('/home/.claude', []);
    expect(commands.map((c) => c.name)).toEqual(expect.arrayContaining(['daily-report', 'deploy']));
  });

  it('ワークスペース側のスキルも混ぜる', async () => {
    const commands = await new CommandCatalog(fs).forClaude('/home/.claude', ['/work']);
    expect(commands.map((c) => c.name)).toContain('local-skill');
  });

  it('SKILL.md はディレクトリ名を既定の名前にする', async () => {
    const commands = await new CommandCatalog(fs).forClaude('/home/.claude', ['/work']);
    expect(commands.find((c) => c.name === 'local-skill')?.description).toBe('この作業用');
  });

  it('スキルの参照ファイルは候補にしない', async () => {
    // SKILL.md の隣に置かれた資料まで拾うと、候補が使えないもので埋まる
    const commands = await new CommandCatalog(fs).forCodex('/home/.codex', []);
    expect(commands.map((c) => c.name)).toContain('slides-maker');
    expect(commands.map((c) => c.name)).not.toContain('design-guidelines');
  });

  it('commands配下の入れ子は拾わない', async () => {
    const commands = await new CommandCatalog(fs).forClaude('/home/.claude', []);
    expect(commands.map((c) => c.name)).not.toContain('deep');
  });

  it('組込コマンドを先に並べる', async () => {
    const commands = await new CommandCatalog(fs).forCodex('/home/.codex', []);
    const builtinAt = commands.findIndex((c) => c.name === 'review');
    const customAt = commands.findIndex((c) => c.name === 'doc');
    expect(builtinAt).toBeGreaterThanOrEqual(0);
    expect(builtinAt).toBeLessThan(customAt);
  });

  it('同じ名前は後から見つけたものを捨てる', async () => {
    const commands = await new CommandCatalog(fs).forClaude('/home/.claude', ['/work']);
    expect(commands.filter((c) => c.name === 'daily-report')).toHaveLength(1);
  });

  it('読めないディレクトリでも落ちない', async () => {
    const empty = {
      async readTextFile() {
        return undefined;
      },
      async listMarkdown() {
        return [];
      },
    } as unknown as FileSystemPort;
    const commands = await new CommandCatalog(empty).forCodex('/nowhere', []);
    expect(commands.every((c) => c.description !== undefined)).toBe(true);
  });
});
