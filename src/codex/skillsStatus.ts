import type { SkillOrigin, SkillView } from '../provider/skills';

/**
 * Codexの `skills/list` の応答からskill一覧を組み立てる（issue #35、design.md TP-56）。
 *
 * 実測（codex-cli 0.147.0。このリポジトリで`codex app-server`を起動し、`cwds`にこの
 * ワークスペースを指定して呼び出し、実際の応答を確認した）:
 * `{data: [{cwd, skills: [SkillMetadata], errors: [{message, path}]}]}`。
 * `SkillMetadata`は`{name, description, path, scope, enabled, interface?, shortDescription?,
 * dependencies?}`（`codex app-server generate-json-schema --out`のスキーマも一致）。
 *
 * `scope`は`user` `repo` `system` `admin`の4種（スキーマ根拠）。次の3つは実測で確認済み:
 * - `user`: `~/.codex/skills/` 配下
 * - `repo`: cwd配下の `.codex/skills/`（実測: 調査用の一時ディレクトリに`.codex/skills`を
 *   作って確認した。このリポジトリや`~/.codex`の設定は変更していない）
 * - `system`: CLIに同梱（`~/.codex/skills/.system/` 配下。実測）
 *
 * `admin`（組織管理者が配布したもの）はこの環境に対象が無く実測できていない
 * （スキーマの`SkillScope`列挙にあることのみが根拠）。
 */
const SCOPE_TO_ORIGIN: Record<string, SkillOrigin> = {
  user: 'user',
  repo: 'project',
  system: 'system',
  admin: 'admin',
};

export function parseSkillsList(raw: unknown): { skills: SkillView[]; warnings: string[] } {
  const data = rec(raw)?.['data'];
  if (!Array.isArray(data)) {
    return { skills: [], warnings: [] };
  }

  const skills: SkillView[] = [];
  const warnings: string[] = [];
  const seenKeys = new Set<string>();

  for (const rawEntry of data) {
    const entry = rec(rawEntry);
    if (entry === undefined) {
      continue;
    }

    for (const rawError of arrayOf(entry['errors'])) {
      const error = rec(rawError);
      const message = str(error?.['message']);
      if (message === '') {
        continue;
      }
      const path = str(error?.['path']);
      warnings.push(path === '' ? message : `${message} (${path})`);
    }

    for (const rawSkill of arrayOf(entry['skills'])) {
      const skill = parseSkillMetadata(rawSkill);
      if (skill === undefined || seenKeys.has(skill.key)) {
        continue;
      }
      seenKeys.add(skill.key);
      skills.push(skill);
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  return { skills, warnings };
}

function parseSkillMetadata(rawSkill: unknown): SkillView | undefined {
  const skill = rec(rawSkill);
  const name = str(skill?.['name']);
  const path = str(skill?.['path']);
  if (skill === undefined || name === '' || path === '') {
    return undefined;
  }

  return {
    key: path,
    name,
    description: str(skill['description']),
    origin: SCOPE_TO_ORIGIN[str(skill['scope'])] ?? 'unknown',
    originDetail: path,
    // 明示的な false だけを無効とする（`enabled`を持たない古い応答でも失わないため。
    // `src/codex/skillsList.ts`の`readSkillsList`と同じ考え方）
    enabled: skill['enabled'] !== false,
    toggleable: true,
  };
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const arrayOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const rec = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
