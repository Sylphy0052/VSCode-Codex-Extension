import type { SlashCommand } from '../provider/slashCommands';

/**
 * `skills/list` の応答からスキルの候補を作る。
 *
 * ファイルを直接走査するより正確。`enabled` で無効化されたものを除け、cwdを渡せば
 * プロジェクト側のスキルも含めてCodexが解決してくれる。
 *
 * 応答の形: `{ data: [{ cwd, skills: [{ name, description, path, scope, enabled }] }] }`
 */
export function readSkillsList(result: unknown): SlashCommand[] {
  const data = asObject(result)?.['data'];
  if (!Array.isArray(data)) {
    return [];
  }

  const commands: SlashCommand[] = [];
  for (const entry of data) {
    const skills = asObject(entry)?.['skills'];
    if (!Array.isArray(skills)) {
      continue;
    }
    for (const raw of skills) {
      const skill = asObject(raw);
      const name = skill?.['name'];
      if (typeof name !== 'string' || name === '') {
        continue;
      }
      // enabled を持たない版でも候補を失わないよう、明示的な false だけを除く
      if (skill?.['enabled'] === false) {
        continue;
      }
      const description = skill?.['description'];
      commands.push({
        name,
        description: typeof description === 'string' ? description : '',
        argumentHint: '',
      });
    }
  }
  return commands;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
