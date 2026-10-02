import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * VSIXに同梱するskill（`resources/skills-plugin/`）の静的検査（Issue #1821）。
 * リポジトリはGitHubで公開しているため、社内・個人の設定が混ざっていないこと、
 * skill同士・subagentへの参照が同梱した範囲で解決することを確かめる。
 */

const root = path.resolve(__dirname, '../../resources/skills-plugin');
const skillsDir = path.join(root, 'skills');
const agentsDir = path.join(root, 'agents');

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

const files = listFiles(root).filter((f) => !f.endsWith('.gitkeep'));
const skillNames = readdirSync(skillsDir).filter((n) =>
  statSync(path.join(skillsDir, n)).isDirectory(),
);
const agentNames = readdirSync(agentsDir)
  .filter((n) => n.endsWith('.md'))
  .map((n) => n.slice(0, -'.md'.length));

describe('同梱skill', () => {
  it('Forge Hubが呼ぶ3本と、そこから呼ばれるskill・subagentを持つ', () => {
    expect(skillNames.sort()).toEqual([
      'gitlab-cleanup',
      'gitlab-commit',
      'gitlab-develop',
      'gitlab-init',
      'gitlab-issue',
      'gitlab-review',
      'gitlab-roadmap',
      'gitlab-screenshot',
    ]);
    expect(agentNames.sort()).toEqual([
      'review-robust',
      'review-spec',
      'review-style',
      'security-auditor',
    ]);
  });

  it('各skillのSKILL.mdのnameがディレクトリ名と一致する', () => {
    for (const name of skillNames) {
      const text = readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8');
      expect(text.match(/^name:\s*(\S+)/m)?.[1], name).toBe(name);
    }
  });

  it('社内のホスト名・個人のパス・個人の規約ファイルへの参照を含まない', () => {
    const forbidden = [
      /heroz/i,
      /kfuruhashi/i,
      /\/home\//,
      /~\/\.claude/,
      /~\/\.codex/,
      /\$HOME\/\.claude/,
      /\$HOME\/\.codex/,
      /gitlab-auto-cycle/,
      /gitlab-wiki-maintain/,
    ];
    // メールアドレスは例示用ドメイン（example.com・.example等）と、SSH形式のremote（git@host:...）だけを許す
    const email = /[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/g;
    const hits: string[] = [];
    for (const file of files) {
      const rel = path.relative(root, file);
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const re of forbidden) if (re.test(line)) hits.push(`${rel}:${i + 1}: ${re}`);
          for (const m of line.matchAll(email)) {
            if (m[0].startsWith('git@') || /(^|\.)example(\.(com|org|net))?$/.test(m[1])) continue;
            hits.push(`${rel}:${i + 1}: ${m[0]}`);
          }
        });
    }
    expect(hits).toEqual([]);
  });

  it('codex-ext:<名前>の参照が同梱したskillかsubagentへ解決する', () => {
    const known = new Set([...skillNames, ...agentNames]);
    const unresolved: string[] = [];
    for (const file of files) {
      // `codex-ext:gitlab-*`のような総称の書き方は参照ではないので数えない
      for (const m of readFileSync(file, 'utf8').matchAll(
        /codex-ext:([a-z0-9-]+)(?![a-z0-9*-])/g,
      )) {
        if (!known.has(m[1])) unresolved.push(`${path.relative(root, file)}: ${m[0]}`);
      }
    }
    expect(unresolved).toEqual([]);
  });

  it('Markdownの相対リンクが同梱した範囲のファイルへ解決する', () => {
    const broken: string[] = [];
    for (const file of files.filter((f) => f.endsWith('.md'))) {
      // コードブロックとインラインコードの中は記法の例なので、リンクとして扱わない
      const text = readFileSync(file, 'utf8')
        .replace(/^```[\s\S]*?^```/gm, '')
        .replace(/`[^`\n]*`/g, '');
      for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1].split('#')[0];
        if (!target || /^[a-z]+:/i.test(target)) continue;
        const resolved = path.resolve(path.dirname(file), target);
        if (!resolved.startsWith(root + path.sep) || !existsSync(resolved)) {
          broken.push(`${path.relative(root, file)}: ${m[1]}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});
