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
  /**
   * 何が問題だったか。採点者はこの記述と回答を突き合わせる。
   *
   * **根本原因と、そこから観測できる症状で書く。修正箇所で書かない。** pilot（#1027）で、
   * 「予約idの判定が case-sensitive」と修正箇所で書いた正解ラベルが割れた。回答はどれも
   * 「taskId と slug が大小文字を保ったままファイル名になるので、大小文字を区別しない
   * ファイルシステムでは別名義で上書きできる」——同じ現象を、より広い原因で指摘していた。
   * 実際に入った修正は予約idの比較だけを直すものだったため、「拾った」とも「拾っていない」
   * とも読め、同じ回答の recall が 1.000 と 0.000 の両方になった。
   */
  finding: string;
  /**
   * 回答のどこまで書いてあれば「拾った」と数えるか。**すべて満たしたときだけ数える。**
   *
   * {@link finding} と分けてあるのは、**採点の判定条件を実験の前に固定するため**である。
   * ここが無いと、回答を読んでから「これは拾ったうちに入るか」を決めることになり、主指標の
   * recall が採点者の解釈で動く。修正案が実際に入ったものと違っていても、ここに書いた条件を
   * 満たすなら拾ったと数える（何を直すべきかの判断は、指摘できているかとは別の問題である）。
   *
   * 自由文1本ではなく2〜4個に割る。1本にすると、広く書けば何でも拾ったことになり、狭く書けば
   * 言い換えを落とす。書くのは**最小の因果鎖**で、次の3つを揃える。
   *
   * 1. 発生条件（いつ起きるか）
   * 2. 破れる性質・観測できる症状（何が壊れるか）
   * 3. 重要度を決める範囲（別の主体をまたぐか、など）
   *
   * 特定の関数名・実際に入ったパッチ・実装方法は要求しない。それらは「何を直すべきか」の話で
   * あって、「問題を指摘できているか」とは別である。
   *
   * 例（#1027）:
   *
   * ```
   * ["大小文字を区別しないファイルシステムで、異なる文字列が同じパスへ写像されること",
   *  "論理的には別の主体・別の識別子が、その写像によって同じファイルを指すこと",
   *  "その結果として上書き、または別主体になりすませることを述べていること"]
   * ```
   */
  recallCriteria: string[];
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
   *
   * **空でよい。** 「見るべき問題が無かった変更」を混ぜないと、存在しない問題を指摘する量を
   * 測れない。空の案件では recall は出さず（分母が0）、指摘の中身だけを見る。
   */
  knownImportantFindings: KnownFinding[];
  /**
   * 変更してはいけない制約・既に決まっている方針。誤認数の採点に使う。
   *
   * **材料（bundleへ入るファイル）の中だけで確かめられる事実に限る。** 材料に無いファイルを
   * 根拠に制約違反を数えると、回答が知りようのない事実で減点することになる。pilot（#1027）で
   * 実際にこれをやってしまった。制約は「一般task同士の大小文字違いは別の関数で既に禁止済み」
   * だったが、その関数があるファイルを材料へ入れていなかった。回答はどれも「その判定がどう
   * なっているかは資料から確認できない」と正しく留保しており、減点する理由が無かった。
   *
   * 材料の外にある事実を前提にしたいなら、そのファイルを材料へ入れる。入れられないなら、
   * その制約は書かない。
   */
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
  /**
   * そのうち `critical` / `warning` の件数（severity 別 recall の分母）。
   *
   * 総 recall だけを見ると、**細かい問題を全部拾って critical だけ落とした回答**が、
   * 逆の回答と同じ値になる。件数が多いのは warning のほうなので、総 recall は warning に
   * 引っ張られる。分母を分けて別々に出す。
   */
  knownCriticalTotal: number;
  knownWarningTotal: number;
  /**
   * 依頼文が最後に現れた位置から、プロンプト末尾までのバイト数。
   *
   * 条件 `B-pos`（依頼を末尾へ移す）が効くとすれば、それは「依頼から読み終わりまでが遠いほど
   * 問いが埋もれる」からである。だとすると効果を左右する独立変数はこの距離であって、
   * プロンプト全体の長さではない。案件の種類だけを揃えても、この距離が偏っていれば
   * 「B-pos は効かなかった」の意味が変わる（短い案件ばかりなら、そもそも埋もれていない）。
   *
   * 依頼文が見つからなかった場合は `undefined`。
   */
  bytesAfterRequest: number | undefined;
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
