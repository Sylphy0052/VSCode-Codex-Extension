import type { ChatItem, ChatState } from '../appserver/chatState';
import { lastNonEmptyAgentMessageText } from '../appserver/chatState';

/**
 * ゴール駆動ループ（issue #892）の型と、会話から証拠を拾う処理。
 *
 * このループの中核は責務の分離にある。**Worker（会話しているエージェント）は証拠を作る側、
 * Evaluator（別セッションの評価役）は止める側、`LoopController`は継続/停止と次ターンの
 * 指示文を組み立てる側**として、完了判定の所有権をWorkerから取り上げる。作業している
 * エージェント自身に「終わったか」を判定させると自己申告になり、根拠を確かめようがない。
 *
 * `loopEngineering.ts`（issue #891）と同じく`vscode`には依存しない。Evaluatorの実際の
 * 呼び出し（プロセス起動）は`goalEvaluatorProcess.ts`が持ち、ここには型だけを置く。
 */

/** 利用者が決める「目的」と「ゴール」。ループ開始時に固定し、以後は書き換えない。 */
export interface GoalDefinition {
  /** 何のためにやるか。 */
  purpose: string;
  /** 何をもって達成とするか（受入基準）。 */
  acceptanceCriteria: string;
  /** 守ってほしい制約。省略可。 */
  constraints?: string;
}

/**
 * Evaluatorの判定。**4値であることに意味がある。**
 *
 * `indeterminate`（証拠不足で判定できない）を`continue`（未達）と混ぜないこと。前者は
 * 「測れていない」、後者は「測ったうえで足りていない」であり、対処が違う。混ぜると
 * 証拠が全く取れていないループを「まだ未達」として黙って回し続けることになる。
 */
export type GoalVerdict = 'achieved' | 'continue' | 'escalate' | 'indeterminate';

/**
 * Evaluatorの出力。**自由文の指示（次ターンのユーザープロンプトそのもの）は含めない。**
 *
 * 次ターンの指示文の組み立ては`LoopController`側の責務（`buildNextTurnPrompt`）。
 * Evaluatorへ完全なプロンプト生成権限を渡さないことで、Evaluatorの暴走・元のゴールからの
 * ドリフト・Evaluatorが勝手に新しい要件を足す事故・会話に紛れ込んだ指示文の素通し
 * （prompt injection）をまとめて減らす。
 */
export interface GoalEvaluation {
  verdict: GoalVerdict;
  /** 判定の理由。 */
  reason: string;
  /** 判定の根拠にした証拠。 */
  evidence: string[];
  /** 達成まで残っていること。 */
  gaps: string[];
  /** 次のターンで集中すべきこと。 */
  nextFocus: string;
}

/**
 * Evaluatorへ渡す証拠の1件。
 *
 * `status`が`unknown`の項目は「機械で測れていない」ことを表す。エージェントの言葉だけを
 * 根拠にした主張（`worker-report`）と、終了コードのような機械で測れた事実を同じ欄に
 * 混ぜないため、種別と状態を分けて持つ。
 */
export interface GoalEvidence {
  kind: 'test' | 'build' | 'lint' | 'git' | 'worker-report';
  /** 実行したコマンド行など、証拠の出どころ。 */
  source: string;
  status: 'pass' | 'fail' | 'unknown';
  /** 終了コードや出力の抜粋。 */
  detail: string;
  /** 何回目のターンで得た証拠か。 */
  iteration: number;
}

/** Evaluatorへ渡す入力一式。 */
export interface GoalEvaluatorInput {
  goal: GoalDefinition;
  /** 圧縮しない証拠。 */
  evidence: readonly GoalEvidence[];
  /** 圧縮した現在の状況（直近の応答の1行要約）。 */
  summary: string;
  /** 直近の応答本文（新しい順ではなく古い順）。 */
  recentTurns: readonly string[];
  /** 何回目のターンの評価か。 */
  iteration: number;
}

/** Evaluatorの呼び出し。失敗時も例外を投げず`indeterminate`を返す実装を期待する。 */
export type GoalEvaluator = (input: GoalEvaluatorInput) => Promise<GoalEvaluation>;

/** 既定で許す`indeterminate`の連続回数。これを超えたら人へ渡す（`escalated`で止める）。 */
export const DEFAULT_MAX_INDETERMINATE = 3;

/** `LoopPlan`へ載せるゴールループの設定。 */
export interface GoalLoopConfig {
  definition: GoalDefinition;
  evaluate: GoalEvaluator;
  /** `indeterminate`が続くのを許す回数。省略時は`DEFAULT_MAX_INDETERMINATE`。 */
  maxIndeterminate?: number;
}

/** 証拠として保持する上限件数。古いものから捨てる。 */
export const MAX_EVIDENCE_ITEMS = 40;

/** Evaluatorへ渡す証拠1件の本文の上限。 */
export const MAX_EVIDENCE_DETAIL_LENGTH = 800;

/** Evaluatorへ渡す直近ターン本文の件数と、1件あたりの上限。 */
export const MAX_RECENT_TURNS = 3;
export const MAX_RECENT_TURN_LENGTH = 2_000;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * 画面から届いたゴールの入力を正規化する。
 *
 * 目的と受入基準の**両方**が入っているときだけゴールループとして扱う。片方だけでは
 * 「何をもって達成か」か「何のためか」のどちらかが欠け、Evaluatorが判定できない。
 * 揃っていなければ`undefined`を返し、呼び出し側は従来の繰り返しループとして扱う。
 */
export function normalizeGoalDefinition(raw: unknown): GoalDefinition | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const value = raw as Record<string, unknown>;
  const purpose = str(value['purpose']).trim();
  const acceptanceCriteria = str(value['acceptanceCriteria']).trim();
  if (purpose === '' || acceptanceCriteria === '') {
    return undefined;
  }
  const constraints = str(value['constraints']).trim();
  return {
    purpose,
    acceptanceCriteria,
    ...(constraints === '' ? {} : { constraints }),
  };
}

/**
 * 会話の項目から、まだ拾っていないコマンド実行を証拠として取り出す（増分）。
 *
 * `ChatState.items`は会話全体を持ち続けるため、毎ターン全件を作り直すと同じ証拠が
 * 何度も積まれ、どのターンで得た証拠かも失われる。既に見たidを`seen`で持ち回り、
 * 増えた分だけを返す。`seen`は**呼び出し側で更新する**（この関数は副作用を持たない）。
 */
export function collectCommandEvidence(
  items: readonly ChatItem[],
  seen: ReadonlySet<string>,
  iteration: number,
): GoalEvidence[] {
  const collected: GoalEvidence[] = [];
  for (const item of items) {
    if (item.kind !== 'commandExecution' || seen.has(item.id)) {
      continue;
    }
    const exitCode = readExitCode(item.status);
    if (exitCode === undefined) {
      // まだ実行中。終了コードが出てから証拠にする（次のターンで拾われる）
      continue;
    }
    collected.push({
      kind: classifyCommand(item.detail),
      source: truncate(item.detail, 200),
      status: exitCode === 0 ? 'pass' : 'fail',
      detail: `exit ${exitCode}\n${tailOf(item.text, MAX_EVIDENCE_DETAIL_LENGTH)}`.trimEnd(),
      iteration,
    });
  }
  return collected;
}

/**
 * 直近の応答を「機械では測れていない申告」として1件の証拠にする。
 *
 * コマンドの終了コードのように確かめようがないため、`status`は常に`unknown`。
 * Evaluatorにはこの区別を明示したうえで渡す（`goalPrompt.ts`）。
 */
export function buildWorkerReportEvidence(
  state: ChatState,
  iteration: number,
): GoalEvidence | undefined {
  const text = lastNonEmptyAgentMessageText(state.items).trim();
  if (text === '') {
    return undefined;
  }
  return {
    kind: 'worker-report',
    source: `turn ${iteration}`,
    status: 'unknown',
    detail: tailOf(text, MAX_EVIDENCE_DETAIL_LENGTH),
    iteration,
  };
}

/** 証拠のledgerへ追記し、上限を超えた古い分を落とす。元の配列は変更しない。 */
export function appendEvidence(
  ledger: readonly GoalEvidence[],
  added: readonly GoalEvidence[],
): GoalEvidence[] {
  const merged = [...ledger, ...added];
  return merged.length <= MAX_EVIDENCE_ITEMS
    ? merged
    : merged.slice(merged.length - MAX_EVIDENCE_ITEMS);
}

/** 実行したコマンド行から証拠の種別を当てる。当たらなければ`worker-report`ではなく`build`に寄せない。 */
function classifyCommand(command: string): GoalEvidence['kind'] {
  const lower = command.toLowerCase();
  if (/\b(test|pytest|jest|vitest|mocha|go test|cargo test)\b/u.test(lower)) {
    return 'test';
  }
  if (/\b(lint|eslint|ruff|flake8|clippy|prettier)\b/u.test(lower)) {
    return 'lint';
  }
  if (/\bgit\b/u.test(lower)) {
    return 'git';
  }
  return 'build';
}

/**
 * 証拠として確定した（終了コードを読める）コマンド実行の項目か。
 *
 * `collectCommandEvidence`がその項目を拾う条件と同じ判定を、呼び出し側からも使えるように
 * する。`LoopController`が「拾ったid」を記録するときに実行中のものまで含めてしまうと、
 * 終了コードが出た次のターンで拾い直せなくなる（issue #909）。
 */
export function isSettledCommandItem(item: ChatItem): boolean {
  return item.kind === 'commandExecution' && readExitCode(item.status) !== undefined;
}

/** `exit 0` の形をした`status`から終了コードを読む。読めなければ`undefined`。 */
function readExitCode(status: string | undefined): number | undefined {
  if (status === undefined) {
    return undefined;
  }
  const matched = /^exit (-?\d+)$/u.exec(status.trim());
  if (matched?.[1] === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(matched[1], 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * 長い出力は**末尾**を残す。コマンドの結果（エラー行・要約行）は末尾に出るため、
 * 先頭を残すと肝心の失敗理由が落ちる（`chatState.ts`の`capOutput`と同じ考え方）。
 */
function tailOf(text: string, max: number): string {
  const codePoints = Array.from(text);
  return codePoints.length <= max ? text : codePoints.slice(codePoints.length - max).join('');
}

/** 先頭を残す切り詰め。コマンド行のように先頭に意味があるものへ使う。 */
function truncate(text: string, max: number): string {
  const codePoints = Array.from(text);
  return codePoints.length <= max ? text : codePoints.slice(0, max).join('');
}

/** Evaluatorへ渡す「直近ターンの本文」。新しいものから探し、古い順に並べて返す。 */
export function collectRecentTurns(items: readonly ChatItem[]): string[] {
  const found: string[] = [];
  for (let i = items.length - 1; i >= 0 && found.length < MAX_RECENT_TURNS; i -= 1) {
    const item = items[i];
    if (item?.kind === 'agentMessage' && item.text.trim() !== '') {
      found.push(tailOf(item.text.trim(), MAX_RECENT_TURN_LENGTH));
    }
  }
  return found.reverse();
}
