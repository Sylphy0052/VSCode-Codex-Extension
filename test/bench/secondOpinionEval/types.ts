/**
 * セカンドオピニオンの精度測定ハーネスの型（Issue #1044）。
 *
 * 目的は「どの介入がどれだけ効いたか」を切り分けられるようにすることであり、精度改善そのものは
 * ここでは行わない。介入は {@link EvalCondition} として1つずつ独立にON/OFFでき、条件を足しても
 * 既存の条件の結果が変わらない形にしてある。
 *
 * `vscode` には依存しない。実行は素のNodeプロセスから行う（`test/external-cli/` と同じ流儀で、
 * VSCodeを起動せずに実物の `codex app-server` を叩く）。
 */

import type { ContextUsage } from '../../../src/appserver/chatState';
import type { SecondOpinionInput } from '../../../src/secondOpinion/prompt';

/**
 * 評価に使う1案件。
 *
 * 「過去に結論が確定している実案件」を指す。`repoPath` と `baseCommit` で材料の取得地点を
 * 固定するため、同じ案件を何度流しても Advisor が見る材料は同じになる（測定の前提）。
 */
export interface EvalCase {
  /** 案件の識別子。結果ファイル名と突き合わせに使う。 */
  id: string;
  /**
   * 案件の種類。
   *
   * コードレビューに偏った測定になっていないことを集計時に検査できるよう、内訳を持たせる
   * （Issue #1044 の実験条件）。
   */
  kind: 'codeReview' | 'designDecision' | 'rootCause' | 'choice';
  /** 材料を取るリポジトリの絶対パス。 */
  repoPath: string;
  /**
   * 差分のベースにするコミット。
   *
   * **必須にしてある。** 省略してHEADから取ると、リポジトリの状態が変わるたびに材料が変わり、
   * 条件間の比較が成立しなくなる。
   */
  baseCommit: string;
  /** 利用者の依頼文。実際にその案件で使った（または使うはずだった）もの。 */
  userRequest: string;
  /**
   * 背景として渡す本文。空文字なら背景を渡さない。
   *
   * 実行のたびに要約セッションを開くと、要約の揺らぎが条件間の差へ混ざる。既定ではここへ
   * **確定済みの背景本文**を入れ、要約セッションを開かない（{@link summarize} を参照）。
   */
  conversation: string;
  /**
   * 会話から要約セッションを開いて背景を作り直すか。既定は `false`。
   *
   * `true` にすると本番と同じ経路（要約セッション経由）になるが、要約が実行のたびに変わる。
   * 要約の作り方そのものを比べる条件（Issue #1044 の条件E）でだけ `true` にする。
   */
  summarize?: boolean;
  /**
   * 後から本当に重要だったと分かっている問題。recall の採点に使う。
   *
   * **実験の実施前に確定させること。** 回答を見てから足すと、その回答に有利な採点になる。
   */
  knownImportantFindings: string[];
  /** 変更してはいけない制約・既に決まっている方針。誤認数の採点に使う。 */
  knownConstraints: string[];
}

/**
 * 1つの介入。
 *
 * `apply` は `buildSecondOpinionPrompt` へ渡す入力を書き換える。プロンプトの組み立てそのものは
 * 本体（`src/secondOpinion/prompt.ts`）を使う。ハーネス側へプロンプトを複製すると、本体を
 * 直したときに測定対象がずれる。
 */
export interface EvalCondition {
  /** 条件名（`A` / `B` …）。採点時は伏せる。 */
  id: string;
  /** 何を変えた条件かの説明。結果ファイルへ残す。 */
  description: string;
  /** 入力の書き換え。条件A（現行）は何もしない。 */
  apply: (input: SecondOpinionInput) => SecondOpinionInput;
}

/** 1回の実行の記録。採点はこのファイルだけを見て行う。 */
export interface EvalRunRecord {
  caseId: string;
  caseKind: EvalCase['kind'];
  conditionId: string;
  /** 同じ条件を複数回流したときの通し番号（出力のばらつきを見るため）。 */
  attempt: number;
  /** Advisorへ実際に送った本文の全文。 */
  prompt: string;
  /** Advisorの回答の全文。 */
  response: string;
  /** `turn/start` を送ってから回答が確定するまで（ミリ秒）。 */
  latencyMs: number;
  /**
   * スレッド累計のトークン数（`thread/tokenUsage/updated` の `tokenUsage.total.totalTokens`）。
   * 通知が届かなかった場合は `undefined`。
   *
   * ハーネスは1スレッド1ターンで使い捨てるため、この累計はそのままこのターンの使用量になる。
   */
  sessionTokens: number | undefined;
  /** いまコンテキストに載っていた量。入力側の規模を見るために残す。 */
  contextUsage: ContextUsage | undefined;
  /** プロンプトのUTF-8バイト数。トークンが取れなかったときの代理指標。 */
  promptBytes: number;
  /** 実行に使ったモデルとeffort。全条件で同じであったことを後から検査するために残す。 */
  model: string;
  effort: string;
  /** 材料の取得地点。条件間で同じであったことを後から検査するために残す。 */
  baseCommit: string;
  /** 失敗した場合の理由。成功なら `undefined`。 */
  error?: string;
}
