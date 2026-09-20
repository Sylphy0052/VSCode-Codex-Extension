/**
 * CLIへ送る本文のトークン量を測るための計測（Issue #1320）。
 *
 * 目的は「実行契約（`formatTaskExecutionContract`）がターンごとに積み上がるのか」を
 * 実測で確かめること。`setPromptTransform` は毎ターン1個の契約を前置するだけなので、
 * 送信本文だけを見ても常に1個にしかならない。判定に要るのは、CLI側の会話履歴に契約入りの
 * メッセージが残るかどうかで、それはセッションの記録ファイル（Codexのrollout、Claude Code
 * のtranscript）に契約が何個あるかで分かる。そのため
 *
 * - このターンで送った本文（`measurePromptText`）
 * - セッション記録ファイル全体（`countContractOccurrences`）
 *
 * の両方を同じ関数で数えられるようにしてある。
 *
 * 計測は既定で無効（`agent.orchestrator.promptMetrics.enabled`）。有効にしても送信内容は
 * 変えない。数えるだけで、本文へ何も足さない。
 */

/** 実行契約ブロックの見出し。`formatTaskExecutionContract` が必ず先頭へ置く。 */
const CONTRACT_HEADING = '## 実行契約';

/** 実行契約の直後に置かれる見出し。`composeTaskExecutionContract` が付ける。 */
const INSTRUCTION_HEADING = '## 今回の指示';

export interface PromptMetrics {
  /** 送信本文の総文字数。 */
  totalChars: number;
  /** 本文に含まれる実行契約ブロックの数。 */
  contractCount: number;
  /** 実行契約ブロックが占める文字数の合計。 */
  contractChars: number;
}

/**
 * テキストに実行契約が何個あるかを数える。
 *
 * 見出しが行頭にあるものだけを数える。本文中に引用として現れた場合（利用者の指示が
 * 契約の文面を引用している等）を拾わないため、行単位で一致を見る。
 */
export function countContractOccurrences(text: string): number {
  let count = 0;
  for (const line of text.split('\n')) {
    if (line === CONTRACT_HEADING) {
      count += 1;
    }
  }
  return count;
}

/**
 * 送信本文を測る。
 *
 * 契約ブロックの範囲は「`## 実行契約` の行から、次の `## 今回の指示` の行の手前まで」と
 * する。`composeTaskExecutionContract` がこの順で組み立てるため、両者は必ず対になる。
 * 対にならない場合（`## 今回の指示` が見つからない）は、本文の末尾までを契約とみなす。
 */
export function measurePromptText(text: string): PromptMetrics {
  const lines = text.split('\n');
  let contractCount = 0;
  let contractChars = 0;
  let inContract = false;

  for (const line of lines) {
    if (line === CONTRACT_HEADING) {
      contractCount += 1;
      inContract = true;
      contractChars += line.length + 1;
      continue;
    }
    if (inContract && line === INSTRUCTION_HEADING) {
      inContract = false;
      continue;
    }
    if (inContract) {
      contractChars += line.length + 1;
    }
  }

  return { totalChars: text.length, contractCount, contractChars };
}

/**
 * セッションの記録ファイル（JSONL）に残っている実行契約の数を数える。
 *
 * Codexのrolloutも Claude Codeのtranscriptも1行1レコードのJSONで、本文は文字列の値として
 * 入っている。レコードの形はCLIごと・バージョンごとに違うため、構造を決め打ちせず、
 * パースした値に含まれる文字列をすべて走査して数える。読めない行は飛ばす（記録の途中で
 * 切れている最終行が普通にあるため）。
 *
 * ここで数えたいのは「CLI側の会話履歴に契約入りのメッセージが積み上がるか」なので、
 * 利用者の送信・アシスタントの応答といったレコード種別では絞り込まない。契約の文面が
 * 記録に何個残っているかがそのまま答えになる。
 */
export function countContractsInSessionRecord(jsonl: string): number {
  let count = 0;
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    count += countContractsInValue(parsed, 0);
  }
  return count;
}

/** JSONの値を再帰的に辿り、文字列に含まれる契約を数える。 */
function countContractsInValue(value: unknown, depth: number): number {
  // 記録のレコードはたかだか数段の入れ子。深さを切っても取りこぼさず、
  // 壊れた・循環した入力で止まらなくなることも防げる
  if (depth > 12) {
    return 0;
  }
  if (typeof value === 'string') {
    return countContractOccurrences(value);
  }
  if (Array.isArray(value)) {
    let count = 0;
    for (const item of value) {
      count += countContractsInValue(item, depth + 1);
    }
    return count;
  }
  if (typeof value === 'object' && value !== null) {
    let count = 0;
    for (const item of Object.values(value)) {
      count += countContractsInValue(item, depth + 1);
    }
    return count;
  }
  return 0;
}

export interface PromptMetricsLogInput {
  runId: string;
  taskId: string;
  /** そのタスクで何回目の送信か（1始まり）。 */
  turn: number;
  metrics: PromptMetrics;
  /** そのタスクで送った契約文字数の累計。 */
  cumulativeContractChars: number;
  /** セッション記録ファイルに残っている契約の数。読めなかった場合は `undefined`。 */
  contractsInHistory: number | undefined;
  /** そのターンの入力トークン数。取得できない場合は `undefined`。 */
  inputTokens: number | undefined;
  /** そのターンのキャッシュ読み取り分。取得できない場合は `undefined`。 */
  cachedInputTokens: number | undefined;
}

/**
 * 出力パネルへ出す1行を組み立てる。
 *
 * 1ターン1行に収める。3ターン続けたときに `history=1,2,3` と増えるのか `history=1` の
 * ままなのかを、パネルを眺めるだけで判定できるようにするため。
 */
export function formatPromptMetricsLine(input: PromptMetricsLogInput): string {
  const { metrics } = input;
  const parts = [
    `[promptMetrics ${input.runId}/${input.taskId}]`,
    `turn=${input.turn}`,
    `total=${metrics.totalChars}`,
    `contract=${metrics.contractCount}`,
    `contractChars=${metrics.contractChars}`,
    `contractCharsTotal=${input.cumulativeContractChars}`,
    `history=${input.contractsInHistory ?? '-'}`,
    `input=${input.inputTokens ?? '-'}`,
    `cached=${input.cachedInputTokens ?? '-'}`,
  ];
  return parts.join(' ');
}
