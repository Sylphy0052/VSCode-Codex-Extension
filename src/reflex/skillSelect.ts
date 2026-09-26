import { normalizeReflexLabel, judge, type ReflexJudgeDeps } from './reflexJudge';
import { sanitizeInlineText } from '../orchestrator/untrustedText';
import type { SkillView } from '../provider/skills';

/**
 * 依頼に合うskillの選択（issue #1451）。
 *
 * CLIは会話の最初にskillの一覧（名前と説明）をモデルへ渡し、使うかどうかをモデルに任せている。
 * skillが増えるほど一覧が長くなり、毎ターンの入力を圧迫する。この機能を有効にすると、
 * 発言のたびにReflex判定で合うskillを1つ選んで読み込ませる。Codexでは一覧もモデルへ渡さない。
 *
 * - Codex: `thread/start`の`config`で一覧を外し、`turn/start`の`input`へskillを足す
 * - Claude Code: 一覧は隠さず、発言を`/<skill名>`で始める（issue #1529）。隠すとモデルが
 *   自分でSkillツールを呼んだときに拒否されるため、一覧を減らす効果は諦める（issue #1531）
 *
 * `vscode`へは依存させず、設定の読み出しと判定の実行手段は呼び出し側（view層）から渡す。
 */

/** `agent.chat.skillSelect.*`の設定値。`config.ts`が読み出し、ここへは値だけを渡す。 */
export interface SkillSelectSettings {
  enabled: boolean;
  /** 選んだskillの確率がこれ以上なら読み込ませる。 */
  threshold: number;
}

// 初期値は仮置き。確率はモデルの自己申告で較正されていないため、使ってから調整する
export const DEFAULT_SKILL_SELECT_THRESHOLD = 0.6;

/** 判定へ渡す候補の上限。多すぎると判定の入力が長くなり、選択肢の確率も読みにくくなる。 */
export const SKILL_SELECT_CANDIDATE_LIMIT = 40;

const REQUEST_MAX_LENGTH = 4000;
const DESCRIPTION_MAX_LENGTH = 200;

/** 「どれも合わない」の選択肢。skill名として使えない文字（全角）なので名前と重ならない。 */
const SKILL_NONE = 'なし';

/**
 * skill名として受け付ける形。名前は選択肢として判定器へ渡し、Claudeではスラッシュコマンドにするため、
 * 空白・約物・制御文字を含むものは候補から外す。プラグイン由来の`plugin:skill`は通す。
 */
const SKILL_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/u;

export interface SkillCandidate {
  name: string;
  description: string;
  /** Codexで`turn/start`へ渡すSKILL.mdのパス。Claude Codeでは使わない。 */
  path?: string;
}

export type SkillSelectResult =
  | { readonly kind: 'selected'; readonly skill: SkillCandidate; readonly probability: number }
  /** 合うskillが無い、または確率が閾値に届かなかった。 */
  | { readonly kind: 'none' }
  /** 判定が失敗した（時間切れ・読み取れない応答など）。 */
  | { readonly kind: 'unavailable' };

/**
 * 判定にかける依頼か。空の依頼と、`/`で始まる依頼（利用者がコマンドやskillを自分で選んでいる）は
 * 対象外。
 */
export function shouldSelectSkill(text: string): boolean {
  const trimmed = text.trim();
  return trimmed !== '' && !trimmed.startsWith('/');
}

/**
 * skill一覧を候補へ変換する。無効なもの・名前の形が合わないもの・名前が重なるものを外し、
 * `SKILL_SELECT_CANDIDATE_LIMIT`件までにする。
 *
 * @param withPath Codexのように、`SkillView.key`をパスとして候補へ持たせるか
 */
export function toSkillCandidates(
  skills: readonly SkillView[],
  withPath: boolean,
): SkillCandidate[] {
  const seen = new Set<string>([normalizeReflexLabel(SKILL_NONE)]);
  const candidates: SkillCandidate[] = [];
  for (const s of skills) {
    if (!s.enabled || !SKILL_NAME_PATTERN.test(s.name)) {
      continue;
    }
    const label = normalizeReflexLabel(s.name);
    if (seen.has(label)) {
      continue;
    }
    seen.add(label);
    candidates.push(
      withPath
        ? { name: s.name, description: s.description, path: s.key }
        : { name: s.name, description: s.description },
    );
    if (candidates.length >= SKILL_SELECT_CANDIDATE_LIMIT) {
      break;
    }
  }
  return candidates;
}

export function buildSkillSelectState(text: string, candidates: readonly SkillCandidate[]): string {
  const request = text.length > REQUEST_MAX_LENGTH ? `${text.slice(0, REQUEST_MAX_LENGTH)}…` : text;
  const lines = candidates.map((c) => {
    const description = sanitizeInlineText(
      c.description.replace(/\s+/gu, ' ').trim(),
      DESCRIPTION_MAX_LENGTH,
    );
    return `- ${c.name}: ${description === '' ? '（説明なし）' : description}`;
  });
  return ['### 利用者の依頼', '', request, '', '### skillの候補', '', ...lines].join('\n');
}

/**
 * 依頼に合うskillを1つ選ぶ。`deps.signal`でプロセスを止められる。
 */
export async function selectSkill(
  deps: ReflexJudgeDeps,
  text: string,
  candidates: readonly SkillCandidate[],
  threshold: number,
): Promise<SkillSelectResult> {
  if (candidates.length === 0) {
    return { kind: 'none' };
  }
  const answers = await judge(deps, {
    situation: [
      'AIエージェントに利用者の依頼を渡す前に、依頼に合うskill（エージェントが読み込む手順書）を選びたい。',
      '読み込ませたskillの手順にエージェントは従うため、依頼の内容に明らかに合うものだけを選ぶ。',
      '依頼に関係する語が説明に出てくるだけのものは選ばない。',
    ].join(''),
    state: buildSkillSelectState(text, candidates),
    questions: [
      {
        kind: 'choice',
        question: `この依頼に最も合うskillはどれか。明らかに合うものが無ければ「${SKILL_NONE}」。`,
        options: [...candidates.map((c) => c.name), SKILL_NONE],
      },
    ],
  });
  if (answers === undefined) {
    return { kind: 'unavailable' };
  }
  const answer = answers[0];
  if (answer?.kind !== 'choice') {
    return { kind: 'unavailable' };
  }
  const skill = candidates.find((c) => c.name === answer.best);
  const probability = answer.probabilities[answer.best] ?? 0;
  if (skill === undefined || probability < threshold) {
    return { kind: 'none' };
  }
  return { kind: 'selected', skill, probability };
}

/**
 * Claude Codeへ送る本文。`/<skill名> <依頼>`にして、CLIにskillを展開させる。依頼はskillの
 * 引数として渡る。埋め込むのは`SKILL_NAME_PATTERN`を通った名前だけ。
 */
export function buildClaudeSkillPrompt(skillName: string, text: string): string {
  return `/${skillName} ${text}`;
}

/** 会話へ残す1行。選んだときだけ残す。 */
export function describeSkillSelect(result: SkillSelectResult): string | undefined {
  if (result.kind !== 'selected') {
    return undefined;
  }
  return `Reflex判定（skill選択）: ${result.skill.name} ${result.probability.toFixed(2)} のため読み込ませます`;
}
