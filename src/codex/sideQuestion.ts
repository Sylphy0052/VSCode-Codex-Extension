/**
 * 脇道の質問（issue #24、design.md TP-42、Codex TUIの `/btw` 相当）用の
 * `thread/fork` パラメータの組み立て。
 *
 * `codex app-server generate-json-schema`（CLI 0.147.0）の `ThreadForkParams` /
 * `Thread` に `ephemeral: boolean` がある。実際に `codex app-server` を起動して
 * 確かめたところ（実測）、`ephemeral: true` で `thread/fork` すると次の性質を持つ
 * スレッドができる。
 *
 * - `Thread.path` が `null` になる（通常のスレッドは `~/.codex/sessions/**` の
 *   ロールアウトファイルのパスが入る）
 * - 実際にロールアウトファイルは作られない（作成前後のディレクトリ差分で確認）
 * - `thread/list` の応答に含まれない
 * - 会話そのものは通常のスレッドと同じにできる（`turn/start` で発言・ツール呼び出し
 *   まで通ることを実測済み）
 * - 一方で `thread/resume` では読み直せない（`no rollout found for thread id ...`
 *   でエラーになる。ロールアウトが無いため。`chatSession.ts` の `loadForkedThread`
 *   参照）
 *
 * この性質（ディスクに残らず、履歴一覧にも出ない）が、Codexバイナリの説明
 * "start a side conversation in an ephemeral fork" と一致する。
 *
 * 既存の「分岐」（`forkFromTurn` / `chatView.ts` の `forkFrom`）との違いはここにある。
 * 分岐は `ephemeral` を渡さない、**永続化される**新しいスレッドを作る操作で、
 * `thread/list` にも残り続ける。脇道の質問は逆に、跡を一切残さずに本流から離れて
 * 一往復だけ聞きたいときに使う。
 *
 * `lastTurnId` は指定しない。分岐（過去の特定ターンへ戻る）と違い、脇道の質問は
 * 「いま話している内容を踏まえて、ちょっと聞く」ものなので、その時点までの会話
 * 全体を引き継ぐ。
 */
export function buildSideQuestionForkParams(threadId: string): Record<string, unknown> {
  return { threadId, ephemeral: true };
}
