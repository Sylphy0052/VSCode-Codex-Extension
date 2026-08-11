/**
 * Codexの `review/start` に渡す `ReviewTarget` の組み立てと検証。
 *
 * 形は `codex app-server generate-json-schema` の `ReviewStartParams` / `ReviewStartResponse`
 * （CLI 0.147.0）で確認した。以下は**スキーマが根拠**で、実機での動作確認はしていない
 * （`docs/manual-test.md` の未実施ケースとして残す）。
 *
 * - `target` は4種のタグ付きunion。`baseBranch` / `commit` / `custom` は対応する
 *   フィールドが必須（`sha` / `branch` / `instructions`）
 * - `delivery` は省略時 `inline`（元のスレッドで続ける）。`detached` を指定すると
 *   新しいスレッドで動き、応答の `reviewThreadId` にそのidが入る
 * - レビュー中のターンは `NonSteerableTurnKind` に `review` があることから
 *   `turn/steer` を受け付けないと分かる（Codexバイナリの文字列
 *   "Steer messages aren't supported during /review." とも整合する）
 */

export type ReviewTargetKind = 'uncommittedChanges' | 'baseBranch' | 'commit' | 'custom';

export type ReviewDelivery = 'inline' | 'detached';

/** app-serverの `ReviewTarget` をそのまま持つ。 */
export type ReviewTarget =
  | { type: 'uncommittedChanges' }
  | { type: 'baseBranch'; branch: string }
  | { type: 'commit'; sha: string }
  | { type: 'custom'; instructions: string };

/**
 * ユーザーの入力から `ReviewTarget` を組み立てる。
 *
 * `baseBranch` / `commit` / `custom` は該当する入力が空（trim後）だと `undefined` を返す。
 * 空文字のままapp-serverへ送るとサーバ側のバリデーション任せになり、何が起きたか
 * 画面から分からなくなるため、ここで弾く。
 */
export function buildReviewTarget(kind: ReviewTargetKind, input: string): ReviewTarget | undefined {
  const trimmed = input.trim();
  switch (kind) {
    case 'uncommittedChanges':
      return { type: 'uncommittedChanges' };
    case 'baseBranch':
      return trimmed === '' ? undefined : { type: 'baseBranch', branch: trimmed };
    case 'commit':
      return trimmed === '' ? undefined : { type: 'commit', sha: trimmed };
    case 'custom':
      return trimmed === '' ? undefined : { type: 'custom', instructions: trimmed };
    default:
      return undefined;
  }
}

/**
 * `review/start` へ渡すパラメータ。
 *
 * `delivery` は既定（`inline`）のときは載せない。他の設定と同じく「空＝フラグを渡さない」
 * を徹底し、app-server側の既定値との二重管理を避けるため。
 */
export function buildReviewStartParams(
  threadId: string,
  target: ReviewTarget,
  delivery: ReviewDelivery,
): Record<string, unknown> {
  const params: Record<string, unknown> = { threadId, target };
  if (delivery === 'detached') {
    params['delivery'] = 'detached';
  }
  return params;
}

/** `review/start` の応答から `reviewThreadId` を読む。 */
export function readReviewThreadId(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) {
    return undefined;
  }
  const id = (result as Record<string, unknown>)['reviewThreadId'];
  return typeof id === 'string' && id !== '' ? id : undefined;
}
