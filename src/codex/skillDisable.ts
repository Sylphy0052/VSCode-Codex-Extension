/**
 * Advisorセッションにskillを提示させないための `thread/start` オーバーレイ（Issue #1061）。
 *
 * Codex CLIは、システムプロンプトへ利用可能なskillの一覧（`~/.codex/skills/` と plugin 由来）を
 * 自動で載せ、「使うと決めたらまず `SKILL.md` を最後まで読む」よう指示する。セカンドオピニオンの
 * 固定指示は「この作業ディレクトリの外を読みに行かないでください」だが、Advisorはこの提示を見て
 * 1つ目のコマンドで `~/.codex/skills/<name>/SKILL.md` を読みに行く（Issue #1047 のprobeで、
 * 条件A・条件C-repoの両方に出た）。
 *
 * レビュー材料は「差分と変更対象ファイルだけを置いた隔離ディレクトリ」として設計されている。
 * bundleの外を読めるなら、その前提が崩れるうえ、費用の測定（`toolCalls` の条件間の差）にも
 * 材料と無関係な読み取りとその失敗が混ざる。
 *
 * 無効化のキーは実測で選んである（codex-cli 0.148.0）:
 *
 * - `features.skills=false` … 効かない。一覧はそのまま提示される
 * - `skills.enabled=false` … 効かない（設定としては受理されるが一覧は残る）
 * - `skills.include_instructions=false` … **効く**。skillの提示そのものが消える
 *
 * グローバルな `~/.codex/AGENTS.md` はここでは消せない（`project_doc_max_bytes=0` /
 * `instructions` / `user_instructions` のいずれでも残ることを実測で確認）。ただしこちらは
 * プロンプトへ注入されるだけでコマンドの実行を伴わないため、`toolCalls` には現れず、条件間で
 * 一定である。消すには `CODEX_HOME` ごと差し替えるしかなく、認証情報の置き場も巻き込む。
 */

/** `thread/start` の `config` へ重ねる、skillを提示させない指定。 */
export const SKILLS_DISABLED_CONFIG_OVERLAY: Record<string, unknown> = {
  skills: { include_instructions: false },
};
