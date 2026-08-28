/**
 * セカンドオピニオン（Issue #894）の依頼先候補の検証。
 *
 * `agent.secondOpinion.candidates` の生値を受け取り、起動に使える形へ丸める。
 * 検証の流儀は `sessionPresets.ts` の `parseSessionPresets` に合わせる（型違い・
 * 未知の形は理由を `warnings` へ積んで捨て、呼び出し側が通知・ログへ出す）。
 *
 * `vscode` には依存しない。設定の読み出しは `config.ts`、表示は view 層の責務。
 */

import { isEffortToken } from '../codex/modelCatalog';

/** 依頼先の候補1件。 */
export interface SecondOpinionCandidate {
  /** 選択UIの表示名。空文字は不可。 */
  name: string;
  /** Codexのモデルslug。 */
  model: string;
  /** `model_reasoning_effort` に渡す値。 */
  effort: string;
}

/**
 * 既定の候補。Issue #894 で決めた「セカンドオピニオン本体は Sol / high」をそのまま持つ。
 *
 * 候補が0件になると機能そのものが起動できなくなるため、設定が壊れているときは
 * 必ずここへ丸める（受入基準13）。
 */
export const DEFAULT_SECOND_OPINION_CANDIDATES: readonly SecondOpinionCandidate[] = [
  { name: 'Sol (high)', model: 'gpt-5.6-sol', effort: 'high' },
];

export interface ParsedSecondOpinionCandidates {
  candidates: SecondOpinionCandidate[];
  /** 捨てた項目の理由。呼び出し側がログ・通知へ出す。 */
  warnings: string[];
}

/**
 * モデルslugとして受け付ける形。CLIへ引数として渡るため、引数注入の余地を残さない
 * （`modelCatalog.ts` の `isEffortToken` と同じ考え方で、英数字と `.` `_` `-` だけに絞る）。
 */
const MODEL_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function readRequiredString(
  entry: Record<string, unknown>,
  key: string,
  label: string,
  warnings: string[],
): string | undefined {
  const value = entry[key];
  if (typeof value !== 'string' || value === '') {
    warnings.push(
      `セカンドオピニオンの候補「${label}」の ${key} が空でない文字列ではないため無視しました: ${JSON.stringify(value)}`,
    );
    return undefined;
  }
  return value;
}

/**
 * `agent.secondOpinion.candidates` の生値を検証する。
 *
 * 配列でなければ丸ごと既定へ丸める。要素単位の不正（型違い・空文字・受け付けない
 * モデルslug／effort）はその要素だけを捨てる（1件の書き間違いで全部の候補が消えると、
 * 直すべき箇所が分からなくなるため）。結果が0件になった場合も既定へ丸める。
 */
export function normalizeSecondOpinionCandidates(value: unknown): ParsedSecondOpinionCandidates {
  if (value === undefined) {
    return { candidates: [...DEFAULT_SECOND_OPINION_CANDIDATES], warnings: [] };
  }
  if (!Array.isArray(value)) {
    return {
      candidates: [...DEFAULT_SECOND_OPINION_CANDIDATES],
      warnings: [
        `agent.secondOpinion.candidates が配列ではないため既定へ戻しました: ${JSON.stringify(value)}`,
      ],
    };
  }

  const warnings: string[] = [];
  const candidates: SecondOpinionCandidate[] = [];
  const seenNames = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      warnings.push(
        `セカンドオピニオンの候補${index + 1}件目がオブジェクトではないため無視しました: ${JSON.stringify(entry)}`,
      );
      continue;
    }
    const record = entry as Record<string, unknown>;
    const label = typeof record['name'] === 'string' ? record['name'] : `${index + 1}件目`;
    const name = readRequiredString(record, 'name', label, warnings);
    const model = readRequiredString(record, 'model', label, warnings);
    const effort = readRequiredString(record, 'effort', label, warnings);
    if (name === undefined || model === undefined || effort === undefined) {
      continue;
    }
    if (!MODEL_SLUG_RE.test(model)) {
      warnings.push(
        `セカンドオピニオンの候補「${label}」の model が受け付けない形のため無視しました: ${JSON.stringify(model)}`,
      );
      continue;
    }
    if (!isEffortToken(effort)) {
      warnings.push(
        `セカンドオピニオンの候補「${label}」の effort が受け付けない形のため無視しました: ${JSON.stringify(effort)}`,
      );
      continue;
    }
    if (seenNames.has(name)) {
      warnings.push(`セカンドオピニオンの候補名が重複しているため後の方を無視しました: ${name}`);
      continue;
    }
    seenNames.add(name);
    candidates.push({ name, model, effort });
  }

  if (candidates.length === 0) {
    warnings.push('セカンドオピニオンの候補が1件も残らなかったため既定へ戻しました');
    return { candidates: [...DEFAULT_SECOND_OPINION_CANDIDATES], warnings };
  }
  return { candidates, warnings };
}

/** 会話の要約（Issue #903）を作るセッションの設定。 */
export interface SecondOpinionSummarySettings {
  /** 要約を添えるか。`false` ならセッションを開かない。 */
  enabled: boolean;
  model: string;
  effort: string;
}

/**
 * 要約の既定。
 *
 * effortを既定の候補（`high`）より下げてあるのは、要約に求めるのが判断ではなく事実の圧縮で、
 * ここへ時間と費用を掛けても独立した意見の質は上がらないため。
 */
export const DEFAULT_SECOND_OPINION_SUMMARY: SecondOpinionSummarySettings = {
  enabled: true,
  model: 'gpt-5.6-sol',
  effort: 'low',
};

export interface ParsedSecondOpinionSummary {
  summary: SecondOpinionSummarySettings;
  warnings: string[];
}

/**
 * `agent.secondOpinion.summary` の生値を検証する。
 *
 * 候補（`normalizeSecondOpinionCandidates`）と違い1件しか無い設定なので、項目ごとに
 * 既定へ落とす（`model` だけ書き間違えても `enabled` の指定は生かす）。
 */
export function normalizeSecondOpinionSummary(value: unknown): ParsedSecondOpinionSummary {
  if (value === undefined) {
    return { summary: { ...DEFAULT_SECOND_OPINION_SUMMARY }, warnings: [] };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      summary: { ...DEFAULT_SECOND_OPINION_SUMMARY },
      warnings: [
        `agent.secondOpinion.summary がオブジェクトではないため既定へ戻しました: ${JSON.stringify(value)}`,
      ],
    };
  }
  const record = value as Record<string, unknown>;
  const warnings: string[] = [];

  const rawEnabled = record['enabled'];
  let enabled = DEFAULT_SECOND_OPINION_SUMMARY.enabled;
  if (typeof rawEnabled === 'boolean') {
    enabled = rawEnabled;
  } else if (rawEnabled !== undefined) {
    warnings.push(
      `agent.secondOpinion.summary.enabled が真偽値ではないため既定を使います: ${JSON.stringify(rawEnabled)}`,
    );
  }

  const rawModel = record['model'];
  let model = DEFAULT_SECOND_OPINION_SUMMARY.model;
  if (typeof rawModel === 'string' && MODEL_SLUG_RE.test(rawModel)) {
    model = rawModel;
  } else if (rawModel !== undefined) {
    warnings.push(
      `agent.secondOpinion.summary.model が受け付けない形のため既定を使います: ${JSON.stringify(rawModel)}`,
    );
  }

  const rawEffort = record['effort'];
  let effort = DEFAULT_SECOND_OPINION_SUMMARY.effort;
  if (typeof rawEffort === 'string' && isEffortToken(rawEffort)) {
    effort = rawEffort;
  } else if (rawEffort !== undefined) {
    warnings.push(
      `agent.secondOpinion.summary.effort が受け付けない形のため既定を使います: ${JSON.stringify(rawEffort)}`,
    );
  }

  return { summary: { enabled, model, effort }, warnings };
}
