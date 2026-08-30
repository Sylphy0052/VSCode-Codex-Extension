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
 * 「重要だった」と後から確定した問題1件。
 *
 * 文字列だけにしないのは、**自分の事後の印象を正解にしないため**である。何を根拠に重要だと
 * 言えるのかを一緒に持たせ、根拠の強さ（{@link provenance}）まで書かせる。recall の分母は
 * ここに並べた件数なので、根拠の弱い項目を足すほど分母が水増しされる。
 */
export interface KnownFinding {
  /** 何が問題だったか。採点者はこの記述と回答を突き合わせる。 */
  finding: string;
  /** そう言える根拠。テストのID、Issue番号、実測値など、後から辿れるもの。 */
  evidence: string;
  severity: 'critical' | 'warning';
  /**
   * 根拠の出所。強い順に `test` > `measured` > `issue` > `review` > `retrospective`。
   *
   * `retrospective`（後から自分でそう思った）だけの項目は、集計時に区別できるようにしておく。
   * これを混ぜたまま recall を出すと、後知恵の量だけ分母が動く。
   */
  provenance: 'test' | 'measured' | 'issue' | 'review' | 'retrospective';
}

/**
 * 評価に使う1案件。
 *
 * 「過去に結論が確定している実案件」を指す。材料の取得地点は {@link baseCommit} と
 * {@link targetCommit} の**両方**で固定する。片側だけでは固定にならない（`git diff <base>` の
 * 右辺は実行時の作業ツリーなので、翌日に作業ツリーが変われば同じ `baseCommit` でも別の材料に
 * なる）。
 */
export interface EvalCase {
  /** 案件の識別子。結果ファイル名と突き合わせに使う。案件一覧の中で重複してはならない。 */
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
  /**
   * 差分の右辺にするコミット。
   *
   * **必須にしてある。** ここを省いて作業ツリーを右辺にすると、同じ案件を後日流し直したときに
   * 別の材料になり、実験の再現ができない。ハーネスはこのコミットで一時worktreeを作り、そこから
   * 材料を取る。
   */
  targetCommit: string;
  /** 利用者の依頼文。実際にその案件で使った（または使うはずだった）もの。 */
  userRequest: string;
  /**
   * 背景として渡す本文。空文字なら背景を渡さない。
   *
   * 実行のたびに要約セッションを開くと、要約の揺らぎが条件間の差へ混ざる。ここへは
   * **確定済みの背景本文**を入れ、要約セッションは開かない。
   */
  conversation: string;
  /**
   * {@link conversation} が何であるか。
   *
   * 本番では長い会話は要約セッションを通り、`summary` として渡る。ここへ会話記録をそのまま
   * 入れて `transcript` として流すと、それは**本番の再現ではない**。本番経路で一度作った要約を
   * 貼って `summary` を指定すれば、本番の材料を保ったまま要約の揺らぎだけを排除できる。
   * どちらであるかを案件ごとに明示させる。
   */
  conversationKind: 'summary' | 'transcript';
  /**
   * 後から本当に重要だったと分かっている問題。recall の採点と、その分母に使う。
   *
   * **実験の実施前に確定させること。** 回答を見てから足したり削ったりすると、その回答に有利な
   * 採点になる。案件一覧を固定した時点のコミットを実行記録へ残す（`manifest.json`）。
   */
  knownImportantFindings: KnownFinding[];
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
  /** 条件名（`A` / `B-pos` / `B-repeat` …）。採点時は伏せる。 */
  id: string;
  /** 何を変えた条件かの説明。結果ファイルへ残す。 */
  description: string;
  /** 入力の書き換え。条件A（現行）は何もしない。 */
  apply: (input: SecondOpinionInput) => SecondOpinionInput;
}

/** 1回の実行の記録。採点はこのファイルだけを見て行う。 */
export interface EvalRunRecord {
  /** この実行がどのrunに属するか。別のrunの結果が同じディレクトリへ混ざるのを弾くために使う。 */
  runId: string;
  caseId: string;
  caseKind: EvalCase['kind'];
  conditionId: string;
  /** 同じ条件を複数回流したときの通し番号（出力のばらつきを見るため）。 */
  attempt: number;
  /**
   * この案件の中で何番目に実行した条件か（1始まり）。
   *
   * 条件の実行順は案件ごとに入れ替える。モデル側の一時的な調子（混雑・時刻・バックエンドの
   * 入れ替え）が特定の条件へ偏って乗るのを防ぐためで、偏りが残っていないことを後から検査
   * できるように順番も記録する。
   */
  conditionOrder: number;
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
  targetCommit: string;
  /**
   * この案件の重要問題の総数（recall の分母）。
   *
   * 集計側で案件ファイルを読み直さずに済むよう、実行記録へ焼き込む。分母を持たないと
   * 「8件拾った」が 8/10 なのか 8/20 なのか区別できない。
   */
  knownImportantTotal: number;
  /** 失敗した場合の理由。成功なら `undefined`。 */
  error?: string;
}

/** run全体の素性。結果ディレクトリへ1つ置く。 */
export interface EvalRunManifest {
  runId: string;
  /** ハーネス側のコミット。どのコードで測ったかを後から特定するために要る。 */
  harnessCommit: string;
  /** 案件ファイルの内容ハッシュ。実験の途中で正解ラベルが変わっていないことの担保。 */
  casesSha256: string;
  casesPath: string;
  model: string;
  effort: string;
  conditionIds: string[];
  attempts: number;
  caseCount: number;
  /** 実行開始時刻（ISO 8601）。 */
  startedAt: string;
}
