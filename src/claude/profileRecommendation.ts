import { CLAUDE_EFFORTS, CLAUDE_MODEL_ALIASES } from './types';

/**
 * Claudeの応答に出る「推奨: model=opus / effort=xhigh (理由)」の1行を読む（Issue #2056）。
 *
 * この行は個人のClaude Code規約がモデルに出させる。検出するだけで、切り替えは利用者が
 * ボタンを押したときだけ行う。値は既知の集合（`CLAUDE_MODEL_ALIASES`と`fable`、
 * `CLAUDE_EFFORTS`）に含まれるものだけ受け付ける。
 */

export interface ProfileRecommendation {
  model: string;
  effort: string;
}

/** 推奨行のmodelに書いてよい名前。別名3種に、規約が使う`fable`を足す。 */
const KNOWN_MODELS: readonly string[] = [...CLAUDE_MODEL_ALIASES, 'fable'];

const LINE = /^推奨[:：]\s*model=([A-Za-z0-9._-]+)\s*\/\s*effort=([A-Za-z0-9._-]+)\s*(?:[(（].*)?$/;

/**
 * 本文から推奨行を取り出す。複数あれば最後の有効な行を採る。コードブロックの中の行、
 * 既知の集合に無い値の行、行頭で始まらない行は対象にしない。
 */
export function extractProfileRecommendation(text: string): ProfileRecommendation | undefined {
  let found: ProfileRecommendation | undefined;
  let inFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const match = LINE.exec(line);
    if (match === null) {
      continue;
    }
    const model = match[1] ?? '';
    const effort = match[2] ?? '';
    if (KNOWN_MODELS.includes(model) && (CLAUDE_EFFORTS as readonly string[]).includes(effort)) {
      found = { model, effort };
    }
  }
  return found;
}
