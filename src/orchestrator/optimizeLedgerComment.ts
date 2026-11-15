import type { OptimizeDecisionOutcome, OptimizeTrialRecord } from './optimizeLedger';

/**
 * 最適化の台帳をPRのコメントの本文にする（Issue #2108）。本文は拡張が台帳から組み立て、LLMには
 * 書かせない（LLMに書かせると自己申告に戻る）。仮説・方式・変更の要約・反証の理由のように
 * LLMが書いた部分は「LLMが書いた」と分かる形で載せ、インラインコードに入れてリンク・メンション・
 * 画像として描画されないようにする。
 */

/** 同じ台帳を2回投稿しないための印。本文の1行目に置く。 */
export function ledgerCommentMarker(loopId: string, trials: number, bestCommit: string): string {
  return `<!-- optimize-ledger:${loopId}:${trials}:${bestCommit} -->`;
}

/** LLMが書いた欄1つあたりの上限（文字数）。 */
const COMMENT_LLM_MAX_LENGTH = 300;

/** コメントの本文の上限（文字数）。GitHubの上限（65536）より小さくする。 */
export const LEDGER_COMMENT_MAX_LENGTH = 60_000;

const OUTCOME_LABELS: Record<OptimizeDecisionOutcome, string> = {
  adopted: '採用',
  rejected: '不採用',
  invalid: '無効',
};

const REFUTATION_LABELS = {
  holds: '反証できなかった',
  refuted: '反証できた',
  inconclusive: '判定できなかった',
} as const;

/** 1行にし、上限で切る。表のセルを壊す`|`も置き換える。 */
function oneLine(text: string, max: number): string {
  const flat = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\|/g, '｜')
    .trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

/**
 * LLMが書いた文を、描画されないインラインコードにする。バッククォートは似た字へ置き換え、
 * コードの囲いを閉じさせない。
 */
function llmText(text: string): string {
  return codeText(text, COMMENT_LLM_MAX_LENGTH);
}

function formatNumber(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? '-' : String(value);
}

function trialRow(record: OptimizeTrialRecord): string {
  const refutation =
    record.refutation === undefined ? '-' : REFUTATION_LABELS[record.refutation.verdict];
  const metric =
    record.metric.samples === 0
      ? '-'
      : `${formatNumber(record.metric.median)}（±${formatNumber(record.metric.spread)}、${record.metric.samples}回）`;
  return `| ${record.trial} | ${OUTCOME_LABELS[record.decision.outcome]} | ${metric} | ${record.correctness.passed ? '通過' : '不通過'} | ${refutation} |`;
}

/**
 * 描画されないインラインコードにする。拡張が書いた文でもコマンドの出力など外から来た断片を
 * 含むので、同じ扱いにする。
 */
function codeText(text: string, max: number): string {
  const flat = oneLine(text, max).replace(/`/g, 'ˋ');
  return flat === '' ? '（空）' : `\`${flat}\``;
}

function trialDetail(record: OptimizeTrialRecord): string[] {
  const r = record.refutation;
  // 反証役が反証した理由はLLMが書いた文なので、採否の理由には混ぜず反証の行へ分けて載せる
  const reason =
    r?.verdict === 'refuted' && r.remeasured === undefined
      ? '反証役が反証した（理由は反証の行）'
      : codeText(record.decision.reason, 500);
  const lines = [
    `#### 試行 #${record.trial}（${OUTCOME_LABELS[record.decision.outcome]}）`,
    '',
    `- 仮説（LLMが書いた）: ${llmText(record.llm.hypothesis)}`,
    `- 予測（LLMが書いた）: ${llmText(record.llm.prediction)}`,
    `- 方式（LLMが書いた）: ${llmText(record.llm.approach)}`,
    `- 変更の要約（LLMが書いた）: ${llmText(record.llm.changeSummary)}`,
    `- 採否の理由（拡張が判定）: ${reason}`,
  ];
  if (r !== undefined) {
    const engine = r.engine === undefined ? '' : `、${r.engine === 'claude' ? 'Claude' : 'Codex'}`;
    lines.push(
      `- 反証（${REFUTATION_LABELS[r.verdict]}${engine}）: ${r.verdict === 'inconclusive' ? codeText(r.detail, 500) : `${llmText(r.detail)}（LLMが書いた）`}`,
    );
    if (r.remeasured !== undefined) {
      lines.push(
        `- 測り直し: 計測の回数を${r.remeasured.fromRuns}回から${r.remeasured.toRuns}回に増やした`,
      );
    }
    if (r.fallback !== undefined) {
      lines.push(`- 反証役のエンジンの切り替え: ${oneLine(r.fallback, 300)}`);
    }
  }
  lines.push('');
  return lines;
}

export interface LedgerCommentInput {
  loopId: string;
  records: readonly OptimizeTrialRecord[];
  baseline?: number;
  best?: { metric: number; trial: number; commit: string };
  /** 止めた理由（人が読む文）。 */
  stopReason?: string;
}

/** 台帳のコメントの本文。長すぎるときは古い試行の詳細から落とし、表は全試行を残す。 */
export function buildLedgerComment(input: LedgerCommentInput): string {
  const { records } = input;
  const bestCommit = input.best?.commit ?? '-';
  const head = [
    ledgerCommentMarker(input.loopId, records.length, bestCommit),
    '## 最適化の台帳',
    '',
    'この台帳は拡張機能が記録から組み立てた。仮説・予測・方式・反証の理由のうち「LLMが書いた」と付けた部分はLLMの自己申告で、検証済みの事実ではない。',
    '',
    `- 基準値: ${formatNumber(input.baseline)}`,
    input.best === undefined
      ? '- 最良値: 基準より良い候補は無かった'
      : `- 最良値: ${formatNumber(input.best.metric)}（試行 #${input.best.trial}、commit ${input.best.commit}）`,
    `- 試行: ${records.length}回（採用 ${records.filter((r) => r.decision.outcome === 'adopted').length}回）`,
    ...(input.stopReason === undefined ? [] : [`- 止めた理由: ${input.stopReason}`]),
    '',
    '| # | 採否 | 指標の中央値 | 正しさ | 反証 |',
    '| --- | --- | --- | --- | --- |',
    ...records.map(trialRow),
    '',
    '### 試行ごとの記録',
    '',
  ];
  const details = records.map(trialDetail);
  let omitted = 0;
  const body = (): string =>
    [
      ...head,
      ...(omitted === 0 ? [] : [`（古い試行${omitted}件の詳細は長さの上限のため省いた）`, '']),
      ...details.slice(omitted).flat(),
    ].join('\n');
  let text = body();
  while (Array.from(text).length > LEDGER_COMMENT_MAX_LENGTH && omitted < details.length) {
    omitted += 1;
    text = body();
  }
  return text;
}
