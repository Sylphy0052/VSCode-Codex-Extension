import type { SkillOrigin, SkillView, SkillsSnapshot } from '../provider/skills';
import type { ControlResponse } from './control';

/**
 * Claude Codeの `reload_skills` control_requestの応答からskill一覧を組み立てる
 * （issue #35、design.md TP-56）。
 *
 * 実測（CLI 2.1.227）: `subtype: 'reload_skills'` を送ると
 * `{skills: [{name, description, argumentHint}]}` が返る（あわせて`system/commands_changed`
 * 通知も飛ぶが、一覧はこの応答だけで完結する）。専用の一覧取得経路はこれ以外に無い
 * （`skills_list` `list_skills` `get_skills` `skill_list` `skills` の5候補を実測で
 * 総当たりし、いずれも`Unsupported control request subtype`で拒否されることを確認済み）。
 *
 * `initialize` の応答の `commands`（実測90件前後）にはこの一覧に加えて `/agents` 等の
 * 組込コマンドも混ざるため使わない。`reload_skills` はCLI側で既にskillだけへ絞り込んだ
 * 結果を返す（実測: 90件中54件のみがskill）。
 *
 * **`enabled`フィールドが応答に無い**。Claude Codeには有効/無効を切り替える経路も
 * 判別する経路も無い（`skill_toggle` `set_skill_enabled` `toggle_skill` `skill_config` の
 * 4候補も同様に拒否されることを実測済み）。そのため返す一覧は常に `enabled: true` /
 * `toggleable: false` にする（design.mdの「無いなら『無い』と画面に出す」方針。呼び出し側の
 * `ClaudeSkillsProbe`が注記文言を添える）。
 *
 * ## 出どころ(origin)の求め方 — descriptionの文字列から推測する
 *
 * 応答に出どころを示す専用フィールドが無い。実測したところ、`description` に出どころに
 * 応じた注記が付く:
 * - ユーザー定義（`~/.claude/skills/`）: 末尾に ` (user)` が付く
 * - プロジェクト定義（`<cwd>/.claude/skills/`）: 末尾に ` (project)` が付く（実測: 調査用の
 *   一時ディレクトリに`.claude/skills`を作って確認した。本番の設定は変更していない）
 * - プラグイン由来: `name` が `<pluginId>:<skillName>` の形になり、`description` の先頭に
 *   `(<pluginId>) ` が付く（実測: `genshijin` `last30days` プラグインで確認）
 * - Anthropic公式のCLI同梱skill（`dataviz` `artifact-design` `claude-api` 等）: どの注記も
 *   付かない
 *
 * この注記はCLIの表示用の整形にすぎず、正式なAPIフィールドではない。**将来のCLI更新で
 * 形式が変わりうる**ため、判別できなかったものは安全側の `unknown` に倒す。
 */
const USER_SUFFIX = ' (user)';
const PROJECT_SUFFIX = ' (project)';

export function parseClaudeSkillsList(raw: unknown): SkillView[] | undefined {
  const rawSkills = rec(raw)?.['skills'];
  if (!Array.isArray(rawSkills)) {
    return undefined;
  }

  const skills: SkillView[] = [];
  const seenKeys = new Set<string>();
  for (const rawSkill of rawSkills) {
    const skill = rec(rawSkill);
    const name = str(skill?.['name']);
    if (skill === undefined || name === '' || seenKeys.has(name)) {
      continue;
    }
    seenKeys.add(name);

    const { origin, originDetail, description } = inferOrigin(name, str(skill['description']));
    skills.push({
      key: name,
      name,
      description,
      origin,
      originDetail,
      enabled: true,
      toggleable: false,
    });
  }
  return skills;
}

/**
 * Claude Codeには有効/無効を切り替える経路も、判別する経路もない（実測。design.mdの
 * 14.17参照）ことの注記。一覧を返す経路（`ClaudeSkillsProbe.read` と
 * `ClaudeStreamSession.reloadSkills`）のどちらも同じ注記を添えるため、文言を1箇所へ
 * まとめる（issue #202でこの警告が2箇所に出るようになった際にDRYへ寄せた）。
 */
const NO_TOGGLE_WARNING =
  'Claude Codeには有効/無効を切り替える経路も、判別する経路もありません（実測。' +
  'design.mdの14.17参照）。出どころ(ユーザー/プロジェクト/プラグイン)はCLIの表示用' +
  '文字列からの推測です。';

/**
 * `reload_skills` control_requestの応答（`ControlResponse`）を`SkillsSnapshot`へ組み立てる。
 *
 * 設定パネル用の単発問い合わせ（`ClaudeSkillsProbe`）と、会話中のプロセスへ直接送る
 * `ClaudeStreamSession.reloadSkills`（issue #202、design.md TP-90）の両方から使う
 * 共通の正規化ロジック。応答が無い／エラー／形が想定外のいずれも `ok:false` へ倒し、
 * 空配列（0件）とは区別する（design.mdの「黙って何も起きない状態を作らない」方針）。
 */
export function buildSkillsSnapshot(response: ControlResponse | undefined): SkillsSnapshot {
  if (response === undefined) {
    return { ok: false, reason: '応答がありませんでした' };
  }
  if (!response.ok) {
    return { ok: false, reason: response.error ?? '不明なエラー' };
  }
  const skills = parseClaudeSkillsList(response.payload);
  if (skills === undefined) {
    return { ok: false, reason: '応答の形が想定外でした' };
  }
  return { ok: true, skills, warnings: [NO_TOGGLE_WARNING] };
}

interface OriginInference {
  origin: SkillOrigin;
  originDetail: string | undefined;
  description: string;
}

function inferOrigin(name: string, rawDescription: string): OriginInference {
  const colonIndex = name.indexOf(':');
  if (colonIndex > 0) {
    const pluginId = name.slice(0, colonIndex);
    const prefix = `(${pluginId}) `;
    const description = rawDescription.startsWith(prefix)
      ? rawDescription.slice(prefix.length)
      : rawDescription;
    return { origin: 'plugin', originDetail: pluginId, description };
  }
  if (rawDescription.endsWith(USER_SUFFIX)) {
    return {
      origin: 'user',
      originDetail: undefined,
      description: rawDescription.slice(0, -USER_SUFFIX.length),
    };
  }
  if (rawDescription.endsWith(PROJECT_SUFFIX)) {
    return {
      origin: 'project',
      originDetail: undefined,
      description: rawDescription.slice(0, -PROJECT_SUFFIX.length),
    };
  }
  return { origin: 'unknown', originDetail: undefined, description: rawDescription };
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const rec = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
