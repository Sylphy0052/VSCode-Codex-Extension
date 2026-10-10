import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  UserSkillStore,
  claudePluginDirArgs,
  isExtensionSkillPath,
  omitDuplicatedBundledRoot,
} from '../../src/provider/extensionSkills';

let work: string;
let userRoot: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'ext-skills-'));
  userRoot = join(work, 'user');
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

async function makeSkill(name: string, extra: Record<string, string> = {}): Promise<string> {
  const dir = join(work, 'src', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n`);
  for (const [file, body] of Object.entries(extra)) {
    await writeFile(join(dir, file), body);
  }
  return dir;
}

describe('UserSkillStore（issue #1825）', () => {
  it('追加して一覧に出し、削除できる', async () => {
    const store = new UserSkillStore(userRoot);
    expect(await store.add(await makeSkill('alpha'))).toEqual({ ok: true, name: 'alpha' });
    expect(await store.list()).toEqual(['alpha']);
    expect(await store.remove('alpha')).toEqual({ ok: true, name: 'alpha' });
    expect(await store.list()).toEqual([]);
    expect((await store.remove('alpha')).ok).toBe(false);
  });

  it('同名は断り、既存の写しを消さない', async () => {
    const store = new UserSkillStore(userRoot);
    await store.add(await makeSkill('alpha', { 'a.txt': '1' }));
    const result = await store.add(await makeSkill('alpha', { 'b.txt': '2' }));
    expect(result.ok).toBe(false);
    expect(await readdir(join(userRoot, 'skills', 'alpha'))).toContain('a.txt');
  });

  it('同名の同時追加は1件だけ成功し、先発の写しが残る', async () => {
    const store = new UserSkillStore(userRoot);
    const first = await makeSkill('alpha', { 'first.txt': '1' });
    const second = join(work, 'src2', 'alpha');
    await mkdir(second, { recursive: true });
    await writeFile(join(second, 'SKILL.md'), 'x');
    await writeFile(join(second, 'second.txt'), '2');
    const results = await Promise.all([store.add(first), store.add(second)]);
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(await readdir(join(userRoot, 'skills', 'alpha'))).toContain('first.txt');
  });

  it('シンボリックリンクは写さない', async () => {
    const dir = await makeSkill('alpha');
    await writeFile(join(work, 'outside.txt'), 'secret');
    await symlink(join(work, 'outside.txt'), join(dir, 'link.txt'));
    const store = new UserSkillStore(userRoot);
    await store.add(dir);
    expect(await readdir(join(userRoot, 'skills', 'alpha'))).not.toContain('link.txt');
  });

  it('SKILL.mdがリンクのフォルダは断り、一時コピーを残さない', async () => {
    const dir = join(work, 'src', 'beta');
    await mkdir(dir, { recursive: true });
    await writeFile(join(work, 'real.md'), 'x');
    await symlink(join(work, 'real.md'), join(dir, 'SKILL.md'));
    const store = new UserSkillStore(userRoot);
    expect((await store.add(dir)).ok).toBe(false);
    expect((await readdir(userRoot)).filter((n) => n.startsWith('.staging-'))).toEqual([]);
  });

  it('不正なフォルダ名とSKILL.md無しは断る', async () => {
    const store = new UserSkillStore(userRoot);
    const bad = join(work, 'src', 'bad name');
    await mkdir(bad, { recursive: true });
    expect((await store.add(bad)).ok).toBe(false);
    const empty = join(work, 'src', 'empty');
    await mkdir(empty, { recursive: true });
    expect((await store.add(empty)).ok).toBe(false);
  });

  it('ファイル数の上限を超えるフォルダは断る', async () => {
    const dir = await makeSkill('big');
    await Promise.all(
      Array.from({ length: 1001 }, (_, i) => writeFile(join(dir, `f${i}.txt`), '')),
    );
    const result = await new UserSkillStore(userRoot).add(dir);
    expect(result.ok).toBe(false);
  });

  it('addの冒頭で、古い一時コピーだけを片付ける', async () => {
    await mkdir(join(userRoot, '.staging-old'), { recursive: true });
    await mkdir(join(userRoot, '.staging-new'), { recursive: true });
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(join(userRoot, '.staging-old'), old, old);
    await new UserSkillStore(userRoot).add(await makeSkill('alpha'));
    const names = await readdir(userRoot);
    expect(names).not.toContain('.staging-old');
    expect(names).toContain('.staging-new');
  });
});

describe('isExtensionSkillPath（issue #1825）', () => {
  it('プラグインのskills配下だけを拡張機能のものとみなす', () => {
    const roots = ['/ext/plugin'];
    expect(isExtensionSkillPath('/ext/plugin/skills/a/SKILL.md', roots)).toBe(true);
    expect(isExtensionSkillPath('/ext/plugin/other/a/SKILL.md', roots)).toBe(false);
    expect(isExtensionSkillPath('/ext/plugin/skillsX/a/SKILL.md', roots)).toBe(false);
  });

  it('Windows区切りのパスも同じ場所として扱う', () => {
    expect(isExtensionSkillPath('C:\\ext\\plugin\\skills\\a\\SKILL.md', ['C:\\ext\\plugin'])).toBe(
      true,
    );
  });
});

describe('omitDuplicatedBundledRoot（Claudeへ重複する同梱pluginを渡さない）', () => {
  let bundled: string;
  let home: string;

  beforeEach(async () => {
    bundled = join(work, 'bundled');
    home = join(work, 'claude-home');
    await mkdir(join(bundled, '.claude-plugin'), { recursive: true });
    await writeFile(join(bundled, '.claude-plugin', 'plugin.json'), '{"name":"codex-ext"}');
    await mkdir(join(bundled, 'skills', 'sk1'), { recursive: true });
    await writeFile(join(bundled, 'skills', 'sk1', 'SKILL.md'), 'x');
    await mkdir(join(bundled, 'agents'), { recursive: true });
    await writeFile(join(bundled, 'agents', 'ag1.md'), 'x');
    await mkdir(join(userRoot, '.claude-plugin'), { recursive: true });
    await writeFile(join(userRoot, '.claude-plugin', 'plugin.json'), '{"name":"codex-ext-user"}');
  });

  async function installUser(skill: boolean, agent: boolean): Promise<void> {
    if (skill) {
      await mkdir(join(home, 'skills', 'sk1'), { recursive: true });
      await writeFile(join(home, 'skills', 'sk1', 'SKILL.md'), 'x');
    }
    if (agent) {
      await mkdir(join(home, 'agents'), { recursive: true });
      await writeFile(join(home, 'agents', 'ag1.md'), 'x');
    }
  }

  it('skillもagentも揃っていれば同梱rootだけ外し、userRootは残す', async () => {
    await installUser(true, true);
    expect(omitDuplicatedBundledRoot([bundled, userRoot], home)).toEqual([userRoot]);
    expect(claudePluginDirArgs([bundled, userRoot], home)).toEqual(['--plugin-dir', userRoot]);
  });

  it('agentが欠けていれば同梱rootを残す', async () => {
    await installUser(true, false);
    expect(omitDuplicatedBundledRoot([bundled, userRoot], home)).toEqual([bundled, userRoot]);
  });

  it('skillが欠けていれば同梱rootを残す', async () => {
    await installUser(false, true);
    expect(omitDuplicatedBundledRoot([bundled], home)).toEqual([bundled]);
  });

  it('skillとagent以外の構成要素があれば、揃っていても同梱rootを残す', async () => {
    await installUser(true, true);
    await mkdir(join(bundled, 'commands'), { recursive: true });
    expect(omitDuplicatedBundledRoot([bundled], home)).toEqual([bundled]);
  });

  it('設定ディレクトリが無ければ同梱rootを残す', () => {
    expect(omitDuplicatedBundledRoot([bundled], join(work, 'missing'))).toEqual([bundled]);
  });

  it('比べるskillもagentも無ければ同梱rootを残す', async () => {
    await rm(join(bundled, 'skills'), { recursive: true });
    await rm(join(bundled, 'agents'), { recursive: true });
    expect(omitDuplicatedBundledRoot([bundled], home)).toEqual([bundled]);
  });
});
