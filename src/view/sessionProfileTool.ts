import { effortsFor, type ModelInfo } from '../codex/modelCatalog';
import { sanitizeInlineText } from '../orchestrator/untrustedText';

import type { SessionProfileToolArgs, SessionProfileToolResult } from '../orchestrator/messaging';

/** 会話に残す理由の上限。1行で読める長さに切る。 */
const MAX_REASON_LENGTH = 200;

/** 今の会話のmodel/effort。空文字は「既定」。 */
export interface SessionProfile {
  model: string;
  effort: string;
}

/** 検証を通った変更。`effortReset`はmodelの変更でeffortを既定へ戻したとき`true`。 */
export interface ResolvedSessionProfile {
  next: SessionProfile;
  modelChanged: boolean;
  effortChanged: boolean;
  effortReset: boolean;
}

const listOf = (values: readonly string[]): string =>
  values.length === 0 ? '（なし）' : values.join(', ');

/**
 * `set_session_profile`（Issue #2053）の値をモデル一覧で検証し、変更後の値を決める。
 *
 * effortの補正はUIで変えたときと同じにする（変更後のmodelで今のeffortが使えなければ既定へ戻す）。
 * 不正な値は、使える値の一覧を付けた理由を返す。
 */
export function resolveSessionProfile(
  models: ModelInfo[],
  current: SessionProfile,
  args: Pick<SessionProfileToolArgs, 'model' | 'effort'>,
  fallbackEfforts?: readonly string[],
): { ok: true; value: ResolvedSessionProfile } | { ok: false; reason: string } {
  if (args.model !== undefined) {
    if (models.length === 0) {
      return { ok: false, reason: 'モデル一覧をまだ取得できていないため、modelを変えられません' };
    }
    if (!models.some((m) => m.slug === args.model)) {
      return {
        ok: false,
        reason: `model「${args.model}」は一覧にありません。使える値: ${listOf(models.map((m) => m.slug))}`,
      };
    }
  }
  const model = args.model ?? current.model;
  const allowed = effortsFor(models, model, fallbackEfforts);
  let effort = current.effort;
  let effortReset = false;
  if (args.effort !== undefined) {
    if (!allowed.includes(args.effort)) {
      return {
        ok: false,
        reason: `effort「${args.effort}」は model「${model === '' ? '既定' : model}」で使えません。使える値: ${listOf(allowed)}`,
      };
    }
    effort = args.effort;
  } else if (effort !== '' && !allowed.includes(effort)) {
    effort = '';
    effortReset = true;
  }
  return {
    ok: true,
    value: {
      next: { model, effort },
      modelChanged: model !== current.model,
      effortChanged: effort !== current.effort,
      effortReset,
    },
  };
}

/** ビューごとの反映先。UIで変えたときと同じ経路を渡す。 */
export interface SessionProfileHost {
  current(): SessionProfile;
  models(): ModelInfo[];
  /** effortsForのfallback（Claudeは`CLAUDE_EFFORTS`）。 */
  fallbackEfforts?: readonly string[];
  /** 変わった値だけを反映する（永続化・実セッション・表示まで）。 */
  apply(resolved: ResolvedSessionProfile): Promise<void>;
  /** 会話に1行残す。 */
  note(text: string): void;
  /** 作業ログへ残す。 */
  log(text: string): void;
  /** effortの反映を確かめられないか（Claude。`streamSession.ts`の`setEffort`）。 */
  effortUnverified?: boolean;
  /**
   * 変更がいつから効くかの説明。Claudeは制御要求を即座に受け、同じターンの次のAPI呼び出しから
   * 新しいmodelで動く（Issue #2053で実測）。Codexは次の`turn/start`から。
   */
  effectiveFrom: string;
}

const show = (value: string): string => (value === '' ? '既定' : value);

/** `set_session_profile`の呼び出しを検証し、反映して結果を返す。 */
export async function applySessionProfileTool(
  host: SessionProfileHost,
  args: SessionProfileToolArgs,
): Promise<SessionProfileToolResult> {
  const current = host.current();
  const resolved = resolveSessionProfile(host.models(), current, args, host.fallbackEfforts);
  if (!resolved.ok) {
    return { applied: false, message: `${resolved.reason}。設定は変えていません` };
  }
  const { next, modelChanged, effortChanged, effortReset } = resolved.value;
  if (!modelChanged && !effortChanged) {
    return {
      applied: true,
      message: `既に model=${show(next.model)} / effort=${show(next.effort)} のため、何も変えていません`,
    };
  }
  await host.apply(resolved.value);

  const changes: string[] = [];
  if (modelChanged) changes.push(`model ${show(current.model)} → ${show(next.model)}`);
  if (effortChanged) changes.push(`effort ${show(current.effort)} → ${show(next.effort)}`);
  const reason = sanitizeInlineText(args.reason.replace(/\s+/g, ' ').trim(), MAX_REASON_LENGTH);
  const summary = changes.join('、');
  host.note(`エージェントがmodel/effortを変更: ${summary}（理由: ${reason}）`);
  host.log(`set_session_profile: ${summary}（理由: ${reason}）`);

  const notes = [`${summary} に変えました。${host.effectiveFrom}`];
  if (effortReset) {
    notes.push(
      `effort ${current.effort} は model ${show(next.model)} で使えないため既定へ戻しました`,
    );
  }
  if (effortChanged && !effortReset && host.effortUnverified === true) {
    notes.push('effortは変更の要求を送りましたが、効いたかどうかは確かめられません');
  }
  return { applied: true, message: notes.join('。') };
}
