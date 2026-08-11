/**
 * skillsの一覧表示（TP-56、issue #35）で共有する型。
 *
 * CodexとClaude Codeでプロトコルの形はまったく違うが（`src/codex/skillsStatus.ts` /
 * `src/claude/skillsList.ts` を参照）、画面へ渡す最終形はここへ揃える。
 * 設定パネル（`src/view/controlPanelScript.ts`）はこの形だけを見ればよい。
 *
 * skillはモデルへ渡す指示（プロンプト）そのものなので、どこ由来かを必ず示す
 * （hooks・issue #28と同じ考え方。design.md参照）。プロジェクト側で定義されたskillは
 * リポジトリをcloneしただけで効きうる。
 */

/**
 * どこで定義されたか。
 *
 * - `user`: ホームディレクトリ配下（`~/.codex/skills` / `~/.claude/skills`）
 * - `project`: ワークスペース配下（`<repo>/.codex/skills` / `<repo>/.claude/skills`）。
 *   cloneしただけで効きうるため、一覧の中で最も注意すべき区分
 * - `plugin`: プラグイン由来（Claude Codeのみ実測で確認できた。Codex側のプラグイン製
 *   skillは`system`スコープで返り、この一覧では区別できない。`skillsStatus.ts`参照）
 * - `system`: CLIに同梱されたもの（Codexの`scope:"system"`。実測）
 * - `admin`: 組織管理者が配布したもの（Codexの`scope:"admin"`。スキーマ根拠のみで実測なし）
 * - `unknown`: 上記のどれとも判別できなかったもの
 */
export type SkillOrigin = 'user' | 'project' | 'plugin' | 'system' | 'admin' | 'unknown';

export interface SkillView {
  /** 一覧の識別・有効/無効切替に使うキー。Codexはファイルパス、Claude Codeは名前。 */
  key: string;
  name: string;
  description: string;
  origin: SkillOrigin;
  /** originの補足。Codexはファイルパス、Claude Codeはプラグインidのみ持つ。それ以外はundefined。 */
  originDetail: string | undefined;
  enabled: boolean;
  /**
   * 有効/無効を切り替えられるか。
   * CodexはCLI側に書き込み経路がある（`skills/config/write`）。Claude Codeには無い
   * （実測。`reload_skills`の応答に`enabled`フィールド自体が無い。`claude/skillsList.ts`参照）。
   */
  toggleable: boolean;
}

/**
 * 一覧を取得できたかどうかを型で分ける。
 *
 * 空配列（0件）と「取得に失敗した」を区別しないと、CLIが古い・app-serverが起動しない
 * といった状況で「skillは設定されていません」と誤って出してしまう
 * （design.md の「黙って何も起きない状態を作らない」に反する）。
 */
export type SkillsSnapshot =
  | { ok: true; skills: SkillView[]; warnings: string[] }
  | { ok: false; reason: string };

/**
 * Codexの `skills/config/write` へ渡すpath選択子として妥当か。
 *
 * `skills/list` が返す絶対パスをそのまま渡す前提のごく単純な形の確認。
 * 相対パスや空文字は、選んだ覚えのないskillを誤って切り替える経路になりうるため拒否する。
 */
export function isValidSkillPath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/');
}
