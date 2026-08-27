import type { AskUserQuestionItem } from '../claude/askUserQuestion';
import type { Attachment } from '../provider/attachments';
import { NO_IMAGES, readUserInputImages, type ChatImage } from '../provider/imageRefs';
import { readAutoApprovalReview } from './autoApprovalReview';
import type { PendingPrompt } from './prompts';

/**
 * Claude CodeのEditツールが渡す置換前後の生の文字列（issue #310）。
 *
 * `diff`（表示用のテキスト、`MAX_DIFF_LINES` で切り詰められうる）とは別に持つ。
 * 復元（`src/util/diffRestore.ts` の `reverseApplyEditReplace`）は現在のファイル内容から
 * `newString` を検索する必要があり、切り詰められたテキストからの再構成では一致判定が
 * 壊れるため、切り詰め前の値をそのまま保持する。
 */
export interface EditReplace {
  oldString: string;
  newString: string;
}

/**
 * ファイル変更の種類（`FileUpdateChange` の `type`）。
 *
 * スキーマ由来の語彙だが、内側でunionとして宣言する（Issue #649）。`normalizeDiffBody`が
 * `add` / `delete` を名指しで見て差分の行頭記号を決めているため、綴りが食い違うと
 * **記号が付かないまま黙って通る**。unionにしておけばtscが落とす。
 *
 * `FileDiff.kind` 自体は `string` のまま置く。app-serverから届いた値をそのまま持つ
 * フィールドで、未知の種類が来ても捨てない方針（`normalizeItem` と同じ）のため。
 */
export type FileDiffKind = 'add' | 'delete' | 'update';

/** 1ファイル分の変更。app-server の `FileUpdateChange` に対応する。 */
export interface FileDiff {
  path: string;
  /** `add` / `delete` / `update`。未知の種類も捨てずに保持するため `string` にしてある。 */
  kind: string;
  /** 移動先。`update` で移動を伴う場合だけ入る。 */
  movePath: string | undefined;
  /**
   * unified diff。CLIが組み立てたものをそのまま持つ。ただし `add` / `delete` で
   * ファイルの中身がそのまま届いたときは行頭に + / - を補う（`normalizeDiffBody`）。
   */
  diff: string;
  /**
   * Claude CodeのEditツール由来の `update` のときだけ入る置換前後の生の文字列（issue #310）。
   * Codex側・Claude CodeのWrite/NotebookEdit由来では常に `undefined`。
   */
  editReplace: EditReplace | undefined;
}

/**
 * Web検索結果1件（issue #18）。
 *
 * `title` `url` の両方が空でない文字列として読めた要素だけをここへ積む
 * （`readWebSearchResults` を参照）。URLは全部見せる方針（design.md）のため、
 * 短縮・省略はしない。
 */
export interface WebSearchResult {
  title: string;
  url: string;
}

/** Web検索結果を持たない項目のための空配列。 */
export const NO_SEARCH_RESULTS: WebSearchResult[] = [];

export interface ChatItem {
  id: string;
  /** app-server の ThreadItem の種類。未知の種類も捨てずに保持する。 */
  kind: string;
  /** 本文。agentMessage はデルタで伸びる。 */
  text: string;
  /** コマンド行やファイル名など、種類ごとの補足。 */
  detail: string;
  status: string | undefined;
  /** このitemが属するターン。会話内から分岐する際の `lastTurnId` になる。 */
  turnId: string | undefined;
  /** ファイル変更の差分。他の種類では空。 */
  diffs: FileDiff[];
  /** 本文の先頭を捨てたか。コマンド出力が上限を超えたときだけ立つ。 */
  truncated?: boolean | undefined;
  /** 会話に出す画像。持たない項目では空。 */
  images?: ChatImage[] | undefined;
  /**
   * Web検索の結果（issue #18）。`webSearch` の項目でのみ使う。
   *
   * 結果が取れない・app-server/Claude Codeから届かないときは未設定のまま
   * （表示側は空配列と同じに扱い、クエリだけを出す従来の表示に留める。壊さない）。
   */
  searchResults?: WebSearchResult[] | undefined;
  /**
   * 思考の全文（reasoningのみ）。
   *
   * `text` は要約として使う。CodexのReasoningThreadItemは要約(`summary`)と全文(`content`)を
   * 別々の配列で持つため、両方あるときだけここに全文を入れる。片方しか無い・両方無いときは
   * undefined（表示側はその場合 `text` だけを行数で畳む。issue #19）。
   */
  reasoningFull?: string | undefined;
  /**
   * 作業ディレクトリ。`commandExecution` のみ持つ（issue #33、design.md §14.23）。
   * バックグラウンドターミナルの一覧に出す以外では使わない。
   */
  cwd?: string | undefined;
  /**
   * 中断した時点で実行中だったコマンド（issue #246）。`commandExecution` のみ。
   *
   * `turn/interrupt` はターンを終わらせるが、実行中のコマンドの子プロセスは残る（実測）。
   * この印が立っている項目は、画面上は止まって見えてもCLI側でまだ動いている可能性がある。
   */
  interruptedWhileRunning?: boolean | undefined;
  /**
   * 実行中のPTYプロセスの識別子。`commandExecution` が `status: inProgress` の間だけ、
   * 実測で分かる場合がある（issue #33）。
   *
   * **停止には使えない**。`command/exec/terminate` はクライアント自身が `command/exec` で
   * 起動したプロセスにしか使えず、この値を渡すと `no active command/exec for process id`
   * で拒否されることを実測で確認した（design.md §14.23）。表示にのみ使う。
   */
  processId?: string | undefined;
}

/**
 * 1項目の本文として保持する上限。
 *
 * コマンドの出力は際限なく伸びうる（`find /` など）。全部持つと状態の受け渡しと
 * 描画が重くなるため、**末尾を残して先頭を捨てる**。TUIも古い行から流れて消える。
 */
export const MAX_OUTPUT_CHARS = 200_000;

/**
 * デルタの追記中に切り詰めを走らせる閾値（issue #246）。
 *
 * デルタが届くたびに `capOutput` を通すと、上限に達して以降は毎回 `MAX_OUTPUT_CHARS` 分の
 * 連結とコピーが走る（実測: `item/commandExecution/outputDelta` 2万件で4.6秒。1件0.23ms）。
 * `find / -type f` のような巨大な出力の最中はこれがイベントループを埋め、`turn/interrupt`
 * の応答を読むところまで手が回らなくなる（120秒の要求タイムアウトに達する）。
 *
 * そこで上限を超えてもすぐには切らず、この値を超えたときだけ末尾 `MAX_OUTPUT_CHARS` へ
 * 切る。保持する本文は `MAX_OUTPUT_CHARS` から `OUTPUT_SOFT_CAP_CHARS` の間で揺れる。
 */
export const OUTPUT_SOFT_CAP_CHARS = MAX_OUTPUT_CHARS + MAX_OUTPUT_CHARS / 4;

/** 画像生成に失敗したときの理由をそのまま出す上限。base64が紛れても画面を埋めない長さにする。 */
export const MAX_IMAGE_RESULT_CHARS = 2_000;

/**
 * 画像生成の本文（issue #247）。
 *
 * `result` は生成した画像そのもののbase64で、2MBを超えることがある（Codex CLI 0.147.0で実測）。
 * 保存先があるならサムネイルと修正後のプロンプトで足りるため、本文には出さない。
 * 保存先が無い（失敗した）ときだけ理由として出し、長すぎるものは切り詰める。
 */
export function imageGenerationText(result: string, savedPath: string): string {
  if (savedPath !== '') {
    return '';
  }
  return result.length <= MAX_IMAGE_RESULT_CHARS
    ? result
    : `${result.slice(0, MAX_IMAGE_RESULT_CHARS)}…`;
}

/**
 * コマンド出力を上限まで切り詰める。
 *
 * 印（「省略」など）は本文へ混ぜない。混ぜると「コピー」がそのまま使えなくなるため、
 * 捨てたかどうかは `truncated` で持ち、表示側が注記する。
 */
export function capOutput(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) {
    return { text, truncated: false };
  }
  return { text: text.slice(text.length - MAX_OUTPUT_CHARS), truncated: true };
}

/**
 * 追記の途中で使う切り詰め（issue #246）。`OUTPUT_SOFT_CAP_CHARS` を超えたときだけ切る。
 *
 * 切る回数を減らすためのもので、切ったあとの長さは `capOutput` と同じ `MAX_OUTPUT_CHARS`。
 * まだ切っていない（上限を少し超えているだけの）間は `truncated` を立てない。実際に
 * 捨てていないものを「先頭は省略」と出さないため。
 */
function capOutputDuringAppend(text: string): { text: string; truncated: boolean } {
  if (text.length <= OUTPUT_SOFT_CAP_CHARS) {
    return { text, truncated: false };
  }
  return { text: text.slice(text.length - MAX_OUTPUT_CHARS), truncated: true };
}

/** 差分を持たない項目のための空配列。 */
export const NO_DIFFS: FileDiff[] = [];

/**
 * 直近の空でない `agentMessage` の本文。無ければ空文字（design.md §16.27、Issue #336）。
 *
 * `orchestrator/taskSummary.ts` の `buildResponseSummary`（1行要約・表示用）と
 * `loop/stallDetector.ts` の停滞判定の両方がここを起点にする。`loop/` は `orchestrator/`
 * より下位の層（`orchestrator/taskSession.ts` が `loop/loopController.ts` を使う向き）
 * のため、両者が依存してよい共通の置き場としてこの層（`appserver/chatState.ts`）に置く。
 * vscode APIには依存しない。
 */
export function lastNonEmptyAgentMessageText(items: readonly ChatItem[]): string {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item !== undefined && item.kind === 'agentMessage' && item.text.trim() !== '') {
      return item.text;
    }
  }
  return '';
}

/**
 * TODO一覧の1件。Claude Codeの `TodoWrite` ツールの入力から作る
 * （`src/claude/transcript.ts` の `normalizeTodos` を参照）。
 */
export interface TodoItem {
  /** 完了形の説明（例: 「Aを準備する」）。既定の表示に使う。 */
  content: string;
  /** `pending` / `in_progress` / `completed`。CLIの語彙をそのまま持つ（実測で確認）。 */
  status: string;
  /** 進行中の表現（例: 「Aを準備中」）。`in_progress` のときに使う。 */
  activeForm: string;
}

/** TODOを持たない項目のための空配列。 */
export const NO_TODOS: TodoItem[] = [];

/**
 * TODO一覧が書き換わった時点の記録（issue #721）。進捗画面のタイムラインで
 * 「どのターンで何が終わったか」を出すために使う。
 *
 * `ChatState.todos` は最後に呼ばれた `TodoWrite` の内容で毎回上書きされるため、
 * それだけでは経過が辿れない。書き換わるたびにここへ積む。
 *
 * 時刻は持たない。ライブ（`src/claude/streamJson.ts`）も復元（`src/claude/transcript.ts`）も
 * 状態の畳み込みで、時計を持ち込むと同じ入力から同じ状態を作れなくなる。代わりに
 * 「何ターン目の出来事か」を `turnIndex` で持ち、これで表示位置が決まる。
 */
export interface TodoSnapshot {
  /** 書き換わった直後の一覧まるごと。`TodoWrite` は毎回全件を送ってくる（実測）。 */
  todos: TodoItem[];
  /**
   * その時点で何ターン目だったか（0起点）。会話項目のうち `userMessage` を数えた値から
   * 1を引いたもの。ユーザーの発言より前に書き換わった場合は 0 に丸める。
   */
  turnIndex: number;
}

/** TODOの書き換えが一度も起きていない状態のための空配列。 */
export const NO_TODO_HISTORY: TodoSnapshot[] = [];

/**
 * 会話項目の並びから「いま何ターン目か」を数える（0起点、issue #721）。
 *
 * ターンの境界はユーザーの発言（`userMessage`）に置く。Claude Codeの項目は
 * `turnId` を持たない（`src/claude/streamJson.ts` が常に `undefined` で積む）ため、
 * `ChatItem.turnId` ではプロバイダをまたいで同じ数え方ができない。
 *
 * ユーザーの発言がまだ1件も無い状態（起動直後、`/`コマンドだけを送った直後など）は
 * 0を返す。「0ターン目」と「1ターン目より前」を区別する必要がある呼び出し元は無い。
 */
export function currentTurnIndex(items: readonly ChatItem[]): number {
  let count = 0;
  for (const item of items) {
    if (item.kind === 'userMessage') {
      count += 1;
    }
  }
  return count === 0 ? 0 : count - 1;
}

/**
 * バックグラウンドで走っているプロセスの一覧（issue #33、design.md §14.23、Codex `/ps` 相当）。
 *
 * CodexとClaude Codeで持つ情報も停止できるかどうかも違う（実測で確認した非対称。
 * design.md参照）ため、フィールドの一部はCLIごとに常に `undefined` のまま残る。
 *
 * - Codex: `commandExecution` ThreadItemのうち `status: inProgress` のものから作る
 *   （`deriveCodexBackgroundTerminals` を参照）。**停止する確定した経路が無い**
 *   （実測: `command/exec/terminate` は「no active command/exec for process id」で拒否される）。
 * - Claude Code: `background_tasks_changed` 通知から作る（`src/claude/streamJson.ts` を参照）。
 *   `stop_task` control requestで実際に止められることを実測で確認した。
 */
export interface BackgroundTerminalItem {
  /** 一覧の識別・停止操作に使うキー。Codexはitem id、Claude Codeはtask_id。 */
  id: string;
  /** 実行しているコマンド、またはその説明。 */
  command: string;
  /** 生のステータス文字列。CLIごとに語彙が違うため、表示側でラベルに変換する。 */
  status: string;
  /** 作業ディレクトリ。Codexのみ（実測。Claude Codeの通知には無い）。 */
  cwd: string | undefined;
  /** 実行中のPTYプロセスの識別子。Codexのみ、実測で分かる場合がある。表示にのみ使う（停止には使えない）。 */
  processId: string | undefined;
  /** タスクの種別（Claude Codeのみ。実測: `local_bash`）。 */
  taskType: string | undefined;
  /**
   * 停止操作を出せるか。Claude Codeは `stop_task` が実測で機能したため常にtrue、
   * Codexは確定した停止経路が無いため常にfalse（design.md §14.23）。
   */
  stoppable: boolean;
}

/** バックグラウンドターミナルを持たない状態のための空配列。 */
export const NO_BACKGROUND_TERMINALS: BackgroundTerminalItem[] = [];

/** 待ち行列の1件。応答中に送られた指示を、添えた画像ごと保つ。 */
export interface QueuedMessage {
  text: string;
  attachments: Attachment[];
}

export interface PendingApproval {
  /** JSON-RPCの要求id。応答を返すときに使う。 */
  requestId: number | string;
  /**
   * 要求の種類。応答の形がこれで決まる。
   * `applyPatch` と `execCommand` は旧形式で、decisionの語彙が他と違う。
   * `askUserQuestion`（issue #685）はCLIからの選択式の問い合わせで、`decide()`の
   * 4値では応答を表現できないため専用の`questions`/`answerAskUserQuestion()`経路を使う。
   */
  kind: 'command' | 'fileChange' | 'permissions' | 'applyPatch' | 'execCommand' | 'askUserQuestion';
  title: string;
  detail: string;
  /**
   * 対応する項目のid。
   *
   * ファイル変更の要求は差分を持たず、同じidの項目（`fileChange`）側に入っている。
   * 差分は要求より後に `item/fileChange/patchUpdated` で届くこともあるため、
   * 値を写さずidだけを持ち、表示のたびに項目から引く。
   */
  itemId: string | undefined;
  /** `kind === 'askUserQuestion'` のときだけ入る、選択UIを組むための質問一覧。 */
  questions?: AskUserQuestionItem[] | undefined;
}

export interface ChatUsage {
  /** Codex。レート制限の消費率 */
  usedPercent: number | undefined;
  /** 制限がリセットされる時刻（epoch秒）。Claude Codeは割合を返さないためこちらで示す */
  resetsAt: number | undefined;
  /** 制限の種類の表示名（`5時間` など） */
  limitLabel: string | undefined;
  /** 制限に到達しているか */
  limited: boolean | undefined;
}

/**
 * コンテキストの使用量。レート制限の消費率（`ChatUsage`）とは別物なので混ぜない。
 *
 * Codexは `thread/tokenUsage/updated` の `last`、Claude Codeは control protocol の
 * `get_context_usage` から得る。どちらも「いまコンテキストに載っている量」を表す。
 */
export interface ContextUsage {
  /** いまコンテキストに載っているトークン数。 */
  usedTokens: number;
  /** コンテキスト上限。CLIが返さないことがあるため無い場合を許す。 */
  contextWindow: number | undefined;
  /** 残りの割合（0-100の整数）。上限が判らなければ undefined。 */
  remainingPercent: number | undefined;
}

/**
 * 使用量と上限から表示用の値を作る。
 *
 * 上限が無い・0以下・使用量が負といった信用できない値では割合を出さない。
 * 誤った残量を出すくらいなら何も出さないほうがよい。
 */
export function buildContextUsage(
  usedTokens: number,
  contextWindow: number | undefined,
): ContextUsage | undefined {
  if (!Number.isFinite(usedTokens) || usedTokens < 0) {
    return undefined;
  }
  const window =
    contextWindow !== undefined && Number.isFinite(contextWindow) && contextWindow > 0
      ? contextWindow
      : undefined;
  if (window === undefined) {
    return { usedTokens, contextWindow: undefined, remainingPercent: undefined };
  }
  const remaining = Math.max(0, Math.min(100, Math.round(((window - usedTokens) / window) * 100)));
  return { usedTokens, contextWindow: window, remainingPercent: remaining };
}

/**
 * 自動圧縮の窓サイズ（issue #201、design.md §14.37）。Claude Codeのみが持つ概念。
 *
 * control protocolに問い合わせ手段が無く（`initialize` / `get_settings` のどちらの応答にも
 * 現れないことを実測済み。design.md参照）、`/autocompact` をローカルコマンドとして送った
 * ときの応答（`model:"<synthetic>"` の固定書式テキスト）から読む
 * （`src/claude/autocompactText.ts` の `parseAutocompactReport` を参照）。CLIの文言が
 * 変われば読めなくなるため、値そのものが `ChatState.autocompactWindow` ごと `undefined`
 * になりうる。
 */
export interface AutocompactWindowView {
  /** `'auto'`（CLI既定・モデルに応じた自動選定）か `'fixed'`（数値で固定）か。 */
  mode: 'auto' | 'fixed';
  /** `mode: 'fixed'` のときの窓サイズ（トークン数）。`'auto'` のときは undefined。 */
  tokens: number | undefined;
}

/**
 * セッションのコスト（issue #37、design.md TP-60）。Claude Codeのみが持つ概念で、
 * レート制限の消費率（`ChatUsage`）ともコンテキストの使用量（`ContextUsage`）とも別物。
 *
 * `get_usage` control requestの応答から作る（`src/claude/costText.ts` の `parseSessionCost`
 * を参照）。CLIはこの値を読んだ時刻を返さないため、`capturedAt` は呼び出し側の
 * wall clockで埋める。
 */
export interface SessionCostView {
  /** このセッションで使った推定コスト（USD）。サブスクリプションでは実際の請求額ではなく、
   * API料金換算の見積もり（`subscriptionType` が入っているときはその旨を表示側で注記する）。 */
  totalCostUsd: number;
  totalLinesAdded: number;
  totalLinesRemoved: number;
  /** サブスクリプションの種別（例: 'max'）。APIキー利用など無い場合は undefined。 */
  subscriptionType: string | undefined;
  /** この値を読み取った時刻（epoch ms、クライアント側のwall clock）。 */
  capturedAt: number;
}

/**
 * 追加クレジット（usage credits）の状態（issue #204、design.md §14.38）。Claude Codeのみが
 * 持つ概念。基本プランのレート制限（`ChatUsage`）を使い切ったときに、追加で使える有償
 * クレジットの設定・消費状況を表す。
 *
 * `sessionCost`と同じ`get_usage` control requestの応答（`rate_limits.extra_usage`）から
 * 作る（`src/claude/control.ts` の `readExtraUsage` を参照）。組織が対応しない・古いCLIでは
 * `rate_limits.extra_usage` 自体が応答に無く、その場合は `ChatState.extraUsage` ごと
 * `undefined` になる（画面は表示・導線ごと出さない。「無効」と決め付けない）。
 */
export interface ExtraUsageView {
  /** 追加クレジットが有効か。 */
  isEnabled: boolean;
  /**
   * 月次の上限額（`currency`建ての実額。応答の`decimal_places`で割った値）。
   * 上限が読めない場合は `undefined`（0円と決め付けない）。
   */
  monthlyLimit: number | undefined;
  /** 今月使った額（`monthlyLimit`と同じ単位）。読めない場合は0扱い（`totalLinesAdded`等と同じ丸め方）。 */
  usedCredits: number;
  /** 消費率（0-100の整数）。CLIが返さない場合は `undefined`。 */
  utilization: number | undefined;
  /** 通貨コード（例: `'USD'`）。 */
  currency: string | undefined;
  /**
   * 無効になっている理由（例: `'out_of_credits'`）。CLIの語彙をそのまま持ち、
   * 訳語は表示側（`chatScript.ts`）で当てる。
   */
  disabledReason: string | undefined;
  /** 月次の上限に達しているか。フッターの導線を出す条件の一つ（issue #204の受入基準）。 */
  spendLimitReached: boolean;
}

export interface ChatState {
  threadId: string | undefined;
  /**
   * VS Codeの再読み込みで復元された会話本文の状態。
   *
   * `thread/resume` は会話全体を返すため、復元直後に自動実行すると大きなロールアウトが
   * app-server接続全体を圧迫する。復元タブだけは人が読み込みを選ぶまで待たせる。
   */
  restore?: { state: 'deferred' | 'loading' | 'failed'; message: string | undefined } | undefined;
  /** Codexが会話内容から付ける要約名。ユーザーが変更することもできる。 */
  name: string | undefined;
  /** Codexが応答中かどうか。入力欄の活性制御に使う。 */
  busy: boolean;
  /** 進行中のターン。`turn/interrupt` が要求するため保持する。 */
  turnId: string | undefined;
  /**
   * 直前のターンが失敗して終わったか。
   *
   * 完了と失敗はどちらも `busy` を落とすため、それだけでは区別できない。
   * ループ実行が壊れた状態で回り続けないよう、失敗を別に持つ。
   */
  turnFailed: boolean;
  /**
   * ストリーミング中のメッセージid（Claude Codeのみ）。
   *
   * 断片の通知には message.id が入らないため、`message_start` で得た値を覚えておき、
   * 完成メッセージと同じ項目に積む。Codexは通知ごとにitemIdが来るので使わない。
   */
  streamingMessageId: string | undefined;
  /**
   * 応答中に送られた指示。ターンが終わってから順に送る。
   *
   * CLIは応答中の指示を受け取れないため、捨てずにここへ積む。
   */
  queued: QueuedMessage[];
  items: ChatItem[];
  approvals: PendingApproval[];
  /** ユーザーへの問い合わせ（ツールの質問・MCPサーバのフォーム）。 */
  prompts: PendingPrompt[];
  usage: ChatUsage | undefined;
  /** コンテキストの使用量。まだ判らない間は undefined（数字を出さない）。 */
  context: ContextUsage | undefined;
  /**
   * セッションのコスト（Claude Codeのみ）。まだ判らない間・Codexのセッションでは undefined。
   */
  sessionCost: SessionCostView | undefined;
  /**
   * セッション累計のトークン数（Codexのみ、issue #294）。
   *
   * `thread/tokenUsage/updated` の `tokenUsage.total.totalTokens`（スレッド全体の累計）から得る。
   * `context.usedTokens`（`last.totalTokens`、いまコンテキストに載っている量）とは別物で、
   * 圧縮しても減らない（design.md §14.9で実測: `total` は圧縮の前後で変わらない）。
   *
   * Codexには金額（コスト）を取得する経路が無い（design.md §14.17で確認済み。
   * `account/usage/read` は金額を持たず、しかもアカウント全体・全期間の値でセッション単位の
   * コストではない）。そのためClaude Codeの `sessionCost`（金額）に相当する表示として、
   * こちらはトークン数を出す。まだ届いていない間は undefined（0や-を出さない。issue #294の
   * 受入基準）。Claude Codeのセッションでは常に undefined のまま。
   */
  sessionTokens: number | undefined;
  /**
   * 追加クレジット（usage credits）の状態（Claude Codeのみ、issue #204、design.md §14.38）。
   *
   * `sessionCost`と同じく`get_usage`の応答から作る（同じ要求への同じ応答なので、追加の
   * control requestは要らない）。対応しない・まだ問い合わせていない間・Codexのセッション
   * では `undefined` で、画面は追加クレジットの表示・導線ごと出さない。
   */
  extraUsage?: ExtraUsageView | undefined;
  /**
   * Plan mode（読み取りだけに絞って計画を立てる状態）か。
   *
   * Codexはこちらで持つ（app-serverに状態を返す口が無いため）。Claude Codeは
   * `permissionMode` が `plan` かどうかで、CLIからの通知を正として決める。
   */
  planMode: boolean;
  /**
   * Fast mode（Claude Codeの `/fast`。Issue #198）の現在値。
   *
   * `initialize` の応答の `fast_mode_state` 由来。**Claude Code側にしか無い**概念で、
   * Codexでは常に `undefined`。対応しない版・そもそも情報が来ない場合も `undefined` に
   * なり、画面はトグル自体を出さない（`planMode` と違って三値を区別する）。
   */
  fastMode?: boolean | undefined;
  /**
   * 自動圧縮の窓サイズの現在値（Claude Codeのみ、issue #201、design.md §14.37）。
   *
   * `fastMode` と同じく、対応しない・まだ問い合わせていない間は `undefined` のままで、
   * 画面は表示自体を出さない（「自動」だと決め付けない）。`/autocompact` を送るたびに
   * 応答から読み直す（`streamJson.ts` の `applyAssistant` 参照）。Codexのセッションでは
   * 常に `undefined`。
   */
  autocompactWindow?: AutocompactWindowView | undefined;
  /**
   * Codexのレビュー中か（`review/start` で開始したターン）。
   *
   * app-serverの `NonSteerableTurnKind` に `review` があり、レビュー中のターンへは
   * `turn/steer` を受け付けないと分かる（スキーマが根拠。実機は未確認）。`routeSend` は
   * このフラグを見て、応答中の指示を割り込みではなく待ち行列へ回す。
   * Claude Codeには対応する概念が無く、常にfalseのまま。
   */
  reviewing: boolean;
  /**
   * 直前に完了/失敗したターンの応答テキスト。作業記録の成果行（`kind: 'result'`）に使う。
   * ターンが終わるたびに上書きする。
   */
  turnResultText: string;
  /**
   * 直前に完了/失敗したターンで編集したファイルパス。
   * Codexは items を turnId で辿って作るため、ここは常に turn/completed・turn/failed 時点で埋める。
   * Claude Codeは tool_use（Edit/Write/NotebookEdit）から都度積み、ターン開始時にリセットする。
   */
  turnEditedFiles: string[];
  /**
   * TODO一覧（Claude Codeのみ）。`TodoWrite` を使わないセッションでは空のまま。
   *
   * Codexは `plan`（`turn/plan/updated`）で同種の情報を会話内の項目として持つため、
   * この一覧は使わない（既存の表示で足りているため。詳細はdocs/design.mdを参照）。
   */
  todos: TodoItem[];
  /**
   * TODO一覧が書き換わった履歴（issue #721）。進捗画面だけが読む。
   *
   * Claude Codeの `TodoWrite` からのみ積まれる。Codexには対応する概念が無いため
   * （`src/codex/` にTODOを読む処理が無い）、Codexのセッションでは常に空のまま。
   */
  todoHistory: TodoSnapshot[];
  /**
   * バックグラウンドで走っているプロセスの一覧（issue #33、design.md §14.23）。
   * `BackgroundTerminalItem` のJSDocを参照。走っているものが無い間は空のまま。
   */
  backgroundTerminals: BackgroundTerminalItem[];
}

export const initialChatState: ChatState = {
  threadId: undefined,
  restore: undefined,
  name: undefined,
  busy: false,
  turnId: undefined,
  turnFailed: false,
  streamingMessageId: undefined,
  queued: [],
  items: [],
  approvals: [],
  prompts: [],
  usage: undefined,
  context: undefined,
  sessionCost: undefined,
  sessionTokens: undefined,
  planMode: false,
  reviewing: false,
  turnResultText: '',
  turnEditedFiles: [],
  todos: NO_TODOS,
  todoHistory: NO_TODO_HISTORY,
  backgroundTerminals: NO_BACKGROUND_TERMINALS,
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrUndefined = (v: unknown): string | undefined => {
  const s = str(v);
  return s === '' ? undefined : s;
};
const numberOf = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const rec = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;

/**
 * reasoning の `summary` / `content` からテキストを取り出す。
 *
 * ReasoningThreadItemのスキーマ（`codex app-server generate-json-schema`で実測・確認）では
 * どちらも文字列の配列（`string[]`）。要約が複数のパートに分かれることがあるため、
 * 空でない要素だけを段落区切り（空行）で繋ぐ。
 */
function readStringArray(value: unknown): string {
  if (!Array.isArray(value)) {
    return '';
  }
  return value.filter((v): v is string => typeof v === 'string' && v !== '').join('\n\n');
}

/**
 * `collabAgentToolCall` の `tool`（`CollabAgentTool`）を日本語にする（issue #34）。
 *
 * `detail` には他の種類（`mcpToolCall` の server/tool 名など）と違って翻訳の通り道が無いため
 * （`status` はチャット画面側の `STATUS_LABEL` を経由する。`chatScript.ts` 参照）、ここで直接
 * 日本語へ変える。未知の値（スキーマ追加）はそのまま出す。
 *
 * キーをunionで閉じるかを検討し、閉じないと決めた（Issue #649）。この語彙を見ているのは
 * すぐ下の索く1行だけで、辞書の外にこの値で分岐するコードが無い
 * （`spawnAgent` などの綴りは `src/` のここ以外に現れない）。unionを足しても
 * tscが守る対象が増えず、読む型だけが増える。`autoApprovalReview.ts` の
 * `AutoApprovalReviewStatus` を閉じたのは、あちらには綴りを名指しで見る
 * `isBlockedByReview` があるため。
 */
const COLLAB_TOOL_LABEL: Record<string, string> = {
  spawnAgent: 'エージェントを起動',
  sendInput: '入力を送信',
  resumeAgent: 'エージェントを再開',
  wait: '完了を待機',
  closeAgent: 'エージェントを終了',
};

/**
 * `agentsStates` 内の `CollabAgentStatus` を日本語にする（issue #34）。未知の値はそのまま出す。
 *
 * `COLLAB_TOOL_LABEL` と同じ理由でunionでは閉じない（Issue #649）。辞書の外にこの語彙で
 * 分岐するコードが無い。
 */
const COLLAB_AGENT_STATUS_LABEL: Record<string, string> = {
  pendingInit: '初期化待ち',
  running: '実行中',
  interrupted: '中断',
  completed: '完了',
  errored: 'エラー',
  shutdown: '終了',
  notFound: '見つかりません',
};

/**
 * サブエージェントを操作するツール呼び出し（`collabAgentToolCall`）の中身を読める形にする
 * （issue #34）。種類名だけでは「何をしているエージェントか」が分からないため、
 * 指示・モデル・reasoning effort・送信先・対象エージェントごとの状態を1行ずつ組み立てる。
 *
 * スキーマ根拠（`codex app-server generate-json-schema`、CollabAgentToolCallThreadItem）:
 * `agentsStates` は `{[threadId]: {status: CollabAgentStatus, message: string | null}}`という
 * 辞書。空・未定義の項目は行を出さない（無いことを無理に表示しない）。
 */
function describeCollabAgentToolCall(item: Record<string, unknown>): {
  detail: string;
  text: string;
} {
  const tool = str(item['tool']);
  const detail = COLLAB_TOOL_LABEL[tool] ?? tool;

  const lines: string[] = [];
  const prompt = strOrUndefined(item['prompt']);
  if (prompt !== undefined) {
    lines.push(`指示: ${prompt}`);
  }
  const model = strOrUndefined(item['model']);
  if (model !== undefined) {
    lines.push(`モデル: ${model}`);
  }
  const effort = strOrUndefined(item['reasoningEffort']);
  if (effort !== undefined) {
    lines.push(`reasoning effort: ${effort}`);
  }
  const receivers = item['receiverThreadIds'];
  if (Array.isArray(receivers)) {
    const ids = receivers.filter((r): r is string => typeof r === 'string' && r !== '');
    if (ids.length > 0) {
      lines.push(`対象スレッド: ${ids.join(', ')}`);
    }
  }
  const states = rec(item['agentsStates']);
  if (states !== undefined) {
    for (const [threadId, raw] of Object.entries(states)) {
      const state = rec(raw);
      const statusValue = str(state?.['status']);
      if (statusValue === '') {
        continue;
      }
      const statusLabel = COLLAB_AGENT_STATUS_LABEL[statusValue] ?? statusValue;
      const message = strOrUndefined(state?.['message']);
      lines.push(`${threadId}: ${statusLabel}${message !== undefined ? `（${message}）` : ''}`);
    }
  }
  return { detail, text: lines.join('\n') };
}

/** userMessage の content 配列からテキストを取り出す。 */
function readContentText(content: unknown): string {
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => {
      const p = rec(part);
      return p?.['type'] === 'text' ? str(p['text']) : '';
    })
    .filter((t) => t !== '')
    .join('\n');
}

/** 生の ThreadItem を表示用に正規化する。未知の種類は種類名だけ残す。 */
export function normalizeItem(raw: unknown): ChatItem | undefined {
  const item = rec(raw);
  const id = item?.['id'];
  const kind = item?.['type'];
  if (item === undefined || typeof id !== 'string' || typeof kind !== 'string') {
    return undefined;
  }

  const base: ChatItem = {
    id,
    kind,
    text: '',
    detail: '',
    status: undefined,
    turnId: undefined,
    diffs: NO_DIFFS,
    images: NO_IMAGES,
    searchResults: NO_SEARCH_RESULTS,
  };
  const status = item['status'];
  if (typeof status === 'string') {
    base.status = status;
  }

  switch (kind) {
    case 'userMessage':
      return {
        ...base,
        text: readContentText(item['content']),
        images: readUserInputImages(item['content']),
      };
    case 'agentMessage':
    case 'plan':
      return { ...base, text: str(item['text']) };
    case 'reasoning': {
      // summaryとcontentは別々のstring[]（実測・スキーマとも確認）。両方あるときだけ
      // reasoningFullへ全文を持たせ、表示側で要約↔全文の切り替えに使う（issue #19）。
      const summary = readStringArray(item['summary']);
      const content = readStringArray(item['content']);
      return { ...base, text: summary, reasoningFull: content === '' ? undefined : content };
    }
    case 'commandExecution': {
      const exitCode = item['exitCode'];
      const output = capOutput(str(item['aggregatedOutput']));
      return {
        ...base,
        text: output.text,
        truncated: output.truncated,
        detail: str(item['command']),
        status: typeof exitCode === 'number' ? `exit ${exitCode}` : base.status,
        cwd: strOrUndefined(item['cwd']),
        processId: strOrUndefined(item['processId']),
      };
    }
    case 'fileChange':
      return {
        ...base,
        detail: describeFileChanges(item['changes']),
        diffs: readFileDiffs(item['changes']),
      };
    case 'mcpToolCall':
      return { ...base, detail: `${str(item['server'])} / ${str(item['tool'])}` };
    case 'webSearch':
      // `results` はapp-server側で意図的に不透明なJSON（スキーマ上 `items: true`）として
      // 扱われている。実測（本issueで実際にWeb検索を伴うターンを回して確認）した形は
      // `{type:'text_result', title, url, domain, snippet, ref_id}` だが、スキーマの
      // 説明文どおり将来別の結果種別が増えても壊れないよう、形は決め打ちしない
      return {
        ...base,
        detail: str(item['query']),
        searchResults: readWebSearchResults(item['results']),
      };
    // レビューの開始/終了。`review` フィールドは対象の説明（不透明な文字列として扱う）
    case 'enteredReviewMode':
    case 'exitedReviewMode':
      return { ...base, detail: str(item['review']) };
    /**
     * サブエージェントの活動（issue #34）。`agentPath` がどのエージェントか、`kind`
     * （`SubAgentActivityKind`: started/interacted/interrupted）がstatusとして
     * チャット画面の`STATUS_LABEL`（`chatScript.ts`）を通って日本語になる。
     * `agentThreadId` は履歴には出ないため、本文へ1行残す。
     */
    case 'subAgentActivity': {
      const kind = str(item['kind']);
      const agentThreadId = str(item['agentThreadId']);
      return {
        ...base,
        detail: str(item['agentPath']),
        status: kind === '' ? base.status : kind,
        text: agentThreadId === '' ? '' : `エージェントスレッド: ${agentThreadId}`,
      };
    }
    // サブエージェントを操作するツール呼び出し（issue #34）。中身は describeCollabAgentToolCall参照
    case 'collabAgentToolCall': {
      const described = describeCollabAgentToolCall(item);
      return { ...base, detail: described.detail, text: described.text };
    }
    // モデルが見た画像。パスだけが届くので、読むのはホスト側の役目
    case 'imageView': {
      const filePath = str(item['path']);
      return {
        ...base,
        detail: filePath,
        images:
          filePath === '' ? NO_IMAGES : [{ dataUrl: undefined, path: filePath, alt: filePath }],
      };
    }
    // モデルが生成した画像。失敗したターンでは savedPath が無い
    case 'imageGeneration': {
      const savedPath = str(item['savedPath']);
      return {
        ...base,
        text: imageGenerationText(str(item['result']), savedPath),
        detail: str(item['revisedPrompt']),
        images:
          savedPath === ''
            ? NO_IMAGES
            : [{ dataUrl: undefined, path: savedPath, alt: '生成した画像' }],
      };
    }
    default:
      return base;
  }
}

/** unified diff かどうかの判定に使う。ハンク見出しの行が1つでもあれば unified とみなす。 */
const HUNK_HEADER = /^@@/m;

/**
 * 差分の本文を整える（issue #244）。
 *
 * app-server は `add` / `delete` のとき `diff` にファイルの中身をそのまま入れてくる
 * （Codex CLI 0.147.0で実測）。行頭に + / - が無いため、画面では追加行にも削除行にも
 * 見えず素のテキストとして出てしまう。ここで行頭の印を補う。
 *
 * unified diff が届いているときは触らない。CLIの版によってどちらで来るか変わりうるため、
 * 形式で見分けて必要なときだけ整える。
 */
export function normalizeDiffBody(diff: string, kind: string): string {
  if (HUNK_HEADER.test(diff)) {
    return diff;
  }
  // satisfiesで綴りをFileDiffKindに突き合わせる。型注釈付きの変数を挟むより、
  // 「この2つはFileDiffKindの値である」という主張がその場に残る
  const marker =
    kind === ('add' satisfies FileDiffKind)
      ? '+'
      : kind === ('delete' satisfies FileDiffKind)
        ? '-'
        : undefined;
  if (marker === undefined) {
    return diff;
  }
  const lines = diff.split('\n');
  // 末尾の改行で生まれる空要素は落とす。印だけの行が増えるのを避ける。
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.map((line) => marker + line).join('\n');
}

/**
 * 変更の差分を取り出す。
 *
 * `diff` を持たない要素は落とす。パスだけの一覧は `describeFileChanges` が担うため、
 * ここで空の差分を残すと「開いても何も無い」表示になる。
 */
export function readFileDiffs(changes: unknown): FileDiff[] {
  if (!Array.isArray(changes)) {
    return NO_DIFFS;
  }
  const diffs: FileDiff[] = [];
  for (const raw of changes) {
    const change = rec(raw);
    const diff = str(change?.['diff']);
    const path = str(change?.['path']);
    if (change === undefined || diff === '' || path === '') {
      continue;
    }
    const kind = rec(change['kind']);
    const movePath = str(kind?.['move_path']);
    const kindName = str(kind?.['type']);
    diffs.push({
      path,
      kind: kindName,
      movePath: movePath === '' ? undefined : movePath,
      diff: normalizeDiffBody(diff, kindName),
      // Codex側は old_string/new_string を持たないため常に undefined（issue #310）
      editReplace: undefined,
    });
  }
  return diffs.length === 0 ? NO_DIFFS : diffs;
}

/**
 * 外部ブラウザで開いてよいURLか。
 *
 * `http:` / `https:` 以外（`javascript:` `data:` `file:` 等）は弾く。Web検索の結果は
 * 外部から届く文字列で、`href` やホストへの要求へそのまま渡す前にここで一度絞る
 * （design.md §9.9の `url` モードと同じ「行き先は全部見せるが、危険なスキームは開かせない」
 * 考え方）。
 */
export function isOpenableSearchUrl(url: string): boolean {
  return /^https?:\/\//iu.test(url);
}

/**
 * Web検索結果の配列を正規化する（issue #18）。
 *
 * `title` `url` の両方が空でない文字列として読める要素だけを拾い、それ以外
 * （形が違う・スキームが安全でない）は黙って捨てる。CodexとClaude Codeで結果の
 * 届き方（生の配列か、ネストした構造から取り出した配列か）が違うため、どちらも
 * 「`{title, url}` らしき要素の配列」まで揃えてからここへ渡す（Codex: `normalizeItem`、
 * Claude Code: `src/claude/transcript.ts`）。
 */
export function readWebSearchResults(results: unknown): WebSearchResult[] {
  if (!Array.isArray(results)) {
    return NO_SEARCH_RESULTS;
  }
  const items: WebSearchResult[] = [];
  for (const raw of results) {
    const entry = rec(raw);
    const title = str(entry?.['title']);
    const url = str(entry?.['url']);
    if (title === '' || url === '' || !isOpenableSearchUrl(url)) {
      continue;
    }
    items.push({ title, url });
  }
  return items.length === 0 ? NO_SEARCH_RESULTS : items;
}

/**
 * 計画の進捗記号。絵文字は使わない（環境で欠けるため）。
 *
 * `COLLAB_TOOL_LABEL` と同じ理由でunionでは閉じない（Issue #649）。辞書の外にこの語彙で
 * 分岐するコードが無い。**`chatScript.ts` の `TODO_MARK` とは別の語彙である**——
 * あちらはClaude Codeの `TodoWrite`（`in_progress`。区切りが`_`）、こちらはCodexの
 * `turn/plan/updated`（`inProgress`）で、記号が同じでも由来が違う。
 */
const PLAN_MARK: Record<string, string> = {
  pending: '[ ]',
  inProgress: '[~]',
  completed: '[x]',
};

/**
 * 計画のステップを1つのテキストにする。
 *
 * `turn/plan/updated` は進むたびに計画の全体を送ってくるので、そのまま置き換える。
 * 未知の状態はCLIの表記のまま出す（種類が増えても行が消えないように）。
 */
export function describePlan(plan: unknown): string {
  if (!Array.isArray(plan)) {
    return '';
  }
  return plan
    .map((raw) => {
      const entry = rec(raw);
      const step = str(entry?.['step']);
      if (step === '') {
        return '';
      }
      const status = str(entry?.['status']);
      return `${PLAN_MARK[status] ?? `[${status}]`} ${step}`;
    })
    .filter((line) => line !== '')
    .join('\n');
}

function describeFileChanges(changes: unknown): string {
  if (!Array.isArray(changes)) {
    return '';
  }
  const paths = changes
    .map((c) => {
      const change = rec(c);
      return str(change?.['path']) || str(change?.['file']);
    })
    .filter((p) => p !== '');
  return paths.join(', ');
}

/**
 * 完了したターンの応答テキストと編集ファイルを items から集める。
 * turnId が判らないと items 全体（他ターン分を含む）を拾ってしまうため、
 * その場合は何も返さない。
 */
export function summarizeTurn(
  items: readonly ChatItem[],
  turnId: string | undefined,
): { text: string; editedFiles: string[] } {
  if (turnId === undefined) {
    return { text: '', editedFiles: [] };
  }

  const turnItems = items.filter((i) => i.turnId === turnId);
  const text = turnItems
    .filter((i) => i.kind === 'agentMessage')
    .map((i) => i.text)
    .join('\n');
  const editedFiles = uniqueOrdered(
    turnItems
      .filter((i) => i.kind === 'fileChange')
      .flatMap((i) => i.detail.split(', '))
      .map((p) => p.trim())
      .filter((p) => p !== ''),
  );
  return { text, editedFiles };
}

function uniqueOrdered(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * レビュー中かどうかを items から求める。
 *
 * `enteredReviewMode` / `exitedReviewMode` はレビューの開始と終了を示す項目で、
 * より後に現れたほうが現在の状態を表す。どちらも現れていなければレビュー中ではない。
 */
export function deriveReviewing(items: readonly ChatItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const kind = items[i]?.kind;
    if (kind === 'enteredReviewMode') {
      return true;
    }
    if (kind === 'exitedReviewMode') {
      return false;
    }
  }
  return false;
}

/**
 * Codexのバックグラウンドターミナル一覧をitemsから求める（issue #33、design.md §14.23）。
 *
 * `commandExecution` のうち `status: inProgress` のものだけを拾う。実測（本issueの調査）:
 * シェルの `&` で明示的にバックグラウンド化したコマンドは、`command/exec`
 * の呼び出し自体がすぐ完了扱いになり（`status: completed` へ即座に遷移）、この一覧には
 * 一瞬しか載らない。長く動き続けるコマンド（ビルド・テスト等）は `inProgress` のまま残り、
 * ここに載り続ける。停止は確定した経路が無いため常に `stoppable: false`（`command/exec/terminate`
 * を実際のprocessIdに対して呼び、「no active command/exec for process id」で拒否されることを
 * 実測で確認した）。
 */
export function deriveCodexBackgroundTerminals(
  items: readonly ChatItem[],
): BackgroundTerminalItem[] {
  const result: BackgroundTerminalItem[] = [];
  for (const item of items) {
    if (item.kind !== 'commandExecution' || item.status !== 'inProgress') {
      continue;
    }
    result.push({
      id: item.id,
      command: item.detail,
      status: item.status,
      cwd: item.cwd,
      processId: item.processId,
      taskType: undefined,
      stoppable: false,
    });
  }
  return result;
}

function upsertItem(items: readonly ChatItem[], item: ChatItem): ChatItem[] {
  const index = items.findIndex((i) => i.id === item.id);
  if (index === -1) {
    return [...items, item];
  }
  const existing = items[index];
  const next = [...items];
  next[index] = {
    ...item,
    // デルタで積んだ本文を、本文が空の completed で消さない
    text: item.text === '' && existing !== undefined ? existing.text : item.text,
    truncated: item.text === '' && existing !== undefined ? existing.truncated : item.truncated,
    // reasoningの全文も同様。completedのcontentが空配列で届いてもデルタの蓄積を消さない
    reasoningFull:
      item.reasoningFull === undefined && existing !== undefined
        ? existing.reasoningFull
        : item.reasoningFull,
    // turnIdは後続の通知で判ることがあるため、一度得た値を保持する
    turnId: item.turnId ?? existing?.turnId,
    // 差分は patchUpdated が先に届くことがある。空で上書きしない
    diffs: item.diffs.length === 0 && existing !== undefined ? existing.diffs : item.diffs,
    // 中断の印は通知には乗らないので、こちらで引き継ぐ（issue #246）
    interruptedWhileRunning:
      existing?.interruptedWhileRunning === true && keepsInterruptedMark(item) ? true : undefined,
  };
  return next;
}

/**
 * デルタ通知を本文へ追記する。
 *
 * まだ項目が無い場合（`item/started` を取り逃した、通知の順序が入れ替わった）は
 * `kind` で作る。コマンド出力だけは上限を超えた分の先頭を捨てる。
 */
function appendDelta(
  items: readonly ChatItem[],
  itemId: string,
  delta: string,
  kind: string,
): ChatItem[] {
  const cap = (text: string): { text: string; truncated: boolean } =>
    kind === 'commandExecution' ? capOutputDuringAppend(text) : { text, truncated: false };

  const index = items.findIndex((i) => i.id === itemId);
  if (index === -1) {
    const created = cap(delta);
    return [
      ...items,
      {
        id: itemId,
        kind,
        text: created.text,
        detail: '',
        status: undefined,
        turnId: undefined,
        diffs: NO_DIFFS,
        truncated: created.truncated,
      },
    ];
  }
  const next = [...items];
  const existing = next[index];
  if (existing !== undefined) {
    const appended = cap(existing.text + delta);
    next[index] = {
      ...existing,
      text: appended.text,
      // 一度でも捨てたら、その後の追記で上限を下回っても捨てた事実は残る
      truncated: existing.truncated === true || appended.truncated,
    };
  }
  return next;
}

/**
 * reasoningのデルタ通知を要約(summary)/全文(content)のどちらかへ追記する。
 *
 * `item/started` を取り逃した場合は`kind: 'reasoning'`で作る。上限は設けない
 * （コマンド出力と違って際限なく伸びる性質のものではないため。issue #19のスコープ外）。
 */
function appendReasoningDelta(
  items: readonly ChatItem[],
  itemId: string,
  target: 'summary' | 'content',
  delta: string,
): ChatItem[] {
  const index = items.findIndex((i) => i.id === itemId);
  if (index === -1) {
    const created: ChatItem = {
      id: itemId,
      kind: 'reasoning',
      text: target === 'summary' ? delta : '',
      detail: '',
      status: undefined,
      turnId: undefined,
      diffs: NO_DIFFS,
      reasoningFull: target === 'content' ? delta : undefined,
    };
    return [...items, created];
  }
  const next = [...items];
  const existing = next[index];
  if (existing === undefined) {
    return next;
  }
  next[index] =
    target === 'summary'
      ? { ...existing, text: existing.text + delta }
      : { ...existing, reasoningFull: (existing.reasoningFull ?? '') + delta };
  return next;
}

/**
 * app-serverの通知を状態に畳み込む。
 *
 * 扱うのは `item/*` `turn/*` `thread/status/changed` と使用量のみ。
 * 未知の通知は状態を変えずに素通しする（プロトコルの追加で壊れないようにするため）。
 */
export function applyEvent(
  state: ChatState,
  method: string,
  params: Record<string, unknown>,
): ChatState {
  switch (method) {
    case 'turn/started': {
      // turnIdはトップレベルではなく turn オブジェクトの中にある（実機で確認）
      const turnId = str(rec(params['turn'])?.['id']);
      return {
        ...state,
        busy: true,
        turnId: turnId === '' ? undefined : turnId,
        turnFailed: false,
        // 前のターンの成果を次のターンへ持ち越さない
        turnResultText: '',
        turnEditedFiles: [],
      };
    }

    case 'turn/completed': {
      const summary = summarizeTurn(state.items, state.turnId);
      return {
        ...state,
        busy: false,
        turnId: undefined,
        turnFailed: false,
        turnResultText: summary.text,
        turnEditedFiles: summary.editedFiles,
      };
    }

    case 'turn/failed': {
      const summary = summarizeTurn(state.items, state.turnId);
      return {
        ...state,
        busy: false,
        turnId: undefined,
        turnFailed: true,
        turnResultText: summary.text,
        turnEditedFiles: summary.editedFiles,
      };
    }

    case 'thread/name/updated': {
      const name = params['threadName'];
      return { ...state, name: typeof name === 'string' && name !== '' ? name : undefined };
    }

    case 'thread/status/changed': {
      const status = rec(params['status']);
      return { ...state, busy: str(status?.['type']) === 'active' };
    }

    case 'item/started':
    case 'item/updated':
    case 'item/completed': {
      const item = normalizeItem(params['item']);
      if (item === undefined) {
        return state;
      }
      const turnId = str(params['turnId']);
      const withTurn = turnId === '' ? item : { ...item, turnId };
      const items = upsertItem(state.items, withTurn);
      return {
        ...state,
        // turn/started を取り逃しても中断できるよう、item側の値でも補う
        turnId: turnId === '' ? state.turnId : turnId,
        items,
        reviewing: deriveReviewing(items),
        backgroundTerminals: deriveCodexBackgroundTerminals(items),
      };
    }

    case 'item/agentMessage/delta': {
      const itemId = str(params['itemId']);
      const delta = str(params['delta']);
      if (itemId === '' || delta === '') {
        return state;
      }
      return { ...state, items: appendDelta(state.items, itemId, delta, 'agentMessage') };
    }

    /**
     * コマンド出力の逐次表示。
     *
     * これを見ないと `item/completed` の `aggregatedOutput` まで何も出ず、長いコマンドは
     * 進んでいるのかどうかが画面から分からない。
     */
    case 'item/commandExecution/outputDelta': {
      const itemId = str(params['itemId']);
      const delta = str(params['delta']);
      if (itemId === '' || delta === '') {
        return state;
      }
      return { ...state, items: appendDelta(state.items, itemId, delta, 'commandExecution') };
    }

    /**
     * 思考の要約・全文の逐次表示（issue #19）。
     *
     * Phase 0の実測では `item/completed` の `reasoning` は `summary` / `content` が
     * どちらも空配列で届いた。中身はこの3つのデルタ通知でしか来ていない可能性が高いため、
     * 逐次で積む。`item/reasoning/summaryPartAdded` は本文を持たず、新しい段落の開始を
     * 知らせるだけなので、既にある要約の続きへ区切り（空行）を挟む合図として使う。
     */
    case 'item/reasoning/summaryTextDelta': {
      const itemId = str(params['itemId']);
      const delta = str(params['delta']);
      if (itemId === '' || delta === '') {
        return state;
      }
      return { ...state, items: appendReasoningDelta(state.items, itemId, 'summary', delta) };
    }

    case 'item/reasoning/summaryPartAdded': {
      const itemId = str(params['itemId']);
      const existing = state.items.find((i) => i.id === itemId);
      if (itemId === '' || existing === undefined || existing.text === '') {
        return state;
      }
      return { ...state, items: appendReasoningDelta(state.items, itemId, 'summary', '\n\n') };
    }

    case 'item/reasoning/textDelta': {
      const itemId = str(params['itemId']);
      const delta = str(params['delta']);
      if (itemId === '' || delta === '') {
        return state;
      }
      return { ...state, items: appendReasoningDelta(state.items, itemId, 'content', delta) };
    }

    case 'account/rateLimits/updated': {
      const primary = rec(rec(params['rateLimits'])?.['primary']);
      const usedPercent = primary?.['usedPercent'];
      return {
        ...state,
        usage: {
          usedPercent: typeof usedPercent === 'number' ? usedPercent : state.usage?.usedPercent,
          resetsAt: state.usage?.resetsAt,
          limitLabel: state.usage?.limitLabel,
          limited: state.usage?.limited,
        },
      };
    }

    case 'thread/tokenUsage/updated': {
      // `total` はスレッド全体の累計。コンテキストの占有量は `last` 側で、
      // 圧縮すると（実測で 21541 → 4831 のように）そちらだけが下がる
      const tokenUsage = rec(params['tokenUsage']);
      const usedTokens = numberOf(rec(tokenUsage?.['last'])?.['totalTokens']);
      if (tokenUsage === undefined || usedTokens === undefined) {
        return state;
      }
      const context = buildContextUsage(usedTokens, numberOf(tokenUsage['modelContextWindow']));
      if (context === undefined) {
        return state;
      }
      // セッション累計のトークン数（issue #294）。読めない更新では前の値を保つ
      // （`account/rateLimits/updated` の usedPercent と同じ倒し方）
      const sessionTokens = numberOf(rec(tokenUsage['total'])?.['totalTokens']);
      return { ...state, context, sessionTokens: sessionTokens ?? state.sessionTokens };
    }

    case 'turn/plan/updated': {
      // 計画は進むたびに全体が届く。1件の項目を書き換えて、増やさない
      const text = describePlan(params['plan']);
      if (text === '') {
        return state;
      }
      const turnId = str(params['turnId']);
      return {
        ...state,
        items: upsertItem(state.items, {
          id: `plan:${turnId}`,
          kind: 'plan',
          text,
          detail: str(params['explanation']),
          status: undefined,
          turnId: turnId === '' ? undefined : turnId,
          diffs: NO_DIFFS,
        }),
      };
    }

    case 'item/fileChange/patchUpdated': {
      // 差分だけが後から届く。項目そのものは item/* で作られている
      const itemId = str(params['itemId']);
      const index = state.items.findIndex((i) => i.id === itemId);
      const existing = state.items[index];
      if (index === -1 || existing === undefined) {
        return state;
      }
      const diffs = readFileDiffs(params['changes']);
      if (diffs.length === 0) {
        return state;
      }
      const items = [...state.items];
      items[index] = { ...existing, diffs, detail: diffs.map((d) => d.path).join(', ') };
      return { ...state, items };
    }

    /**
     * 承認要求の自動レビュー（`approvalsReviewer: auto_review`）。
     *
     * 開始と完了が同じ `reviewId` で届く。1件の項目として状態が進むように見せる
     * （増やすと、判定中と結果が二重に並ぶ）。人が押していない承認が裏で進むため、
     * **何が審査され、どう判定されたかは必ず会話へ残す。**
     */
    case 'item/autoApprovalReview/started':
    case 'item/autoApprovalReview/completed': {
      const review = readAutoApprovalReview(params);
      if (review === undefined) {
        return state;
      }
      return {
        ...state,
        items: upsertItem(state.items, {
          id: `autoReview:${review.reviewId}`,
          kind: 'autoApprovalReview',
          text: review.action,
          detail: review.outcome,
          status: review.status === '' ? undefined : review.status,
          turnId: review.turnId,
          diffs: NO_DIFFS,
        }),
      };
    }

    /** 自動レビューからの警告。判定そのものではないため、一言だけ残す。 */
    case 'guardianWarning': {
      const message = str(params['message']);
      return message === ''
        ? state
        : appendNotice(state, `guardianWarning:${message}`, `自動レビュー: ${message}`);
    }

    case 'serverRequest/resolved': {
      // 別のウィンドウやTUIで承認された。こちらのカードは用済み
      const requestId = params['requestId'];
      if (typeof requestId !== 'number' && typeof requestId !== 'string') {
        return state;
      }
      const next = removeApproval(state, requestId);
      return next.approvals.length === state.approvals.length ? state : next;
    }

    /**
     * hookの実行結果（issue #28）。
     *
     * app-serverのプロトコルには「hookを信頼してください」という要求そのものが無い
     * （`ServerRequest` の10種、`ServerNotification` の全種を実測・スキーマ双方で確認したが
     * hook信頼専用のものは存在しない）。`HookRunStatus` には `blocked` という値があり、
     * 信頼していないhookが動くタイミングでそれを伴う `hook/completed` が届くことを期待していた。
     *
     * ただし Codex CLI 0.147.0 の実機では、未信頼のhookに対して `hook/started` も
     * `hook/completed` も届かない（issue #249で実測。hookのコマンド自体も実行されない）。
     * つまりこの分岐は現状のCLIでは発火しない。将来CLI側がブロックを通知するように
     * なったときに効くよう、ハンドラはそのまま残してある。
     *
     * 未信頼のhookに気づく手立ては設定パネルのhooks一覧の「未信頼」バッジが担う
     * （会話画面から気づかせる案は issue #249 で「取らない」と判断済み。design.md §14.15）。
     */
    case 'hook/completed': {
      const run = rec(params['run']);
      if (str(run?.['status']) !== 'blocked') {
        return state;
      }
      const eventName = str(run?.['eventName']) || '不明なイベント';
      const sourcePath = str(run?.['sourcePath']);
      const detail =
        `hookがブロックされました（信頼されていないため実行されませんでした）: ${eventName}` +
        (sourcePath === '' ? '' : ` (${sourcePath})`) +
        '。設定パネルのhooks一覧で内容を確認してから信頼してください。';
      return appendNotice(state, `hookBlocked:${str(run?.['id'])}`, detail);
    }

    default:
      return state;
  }
}

/** 指示の送り先。 */
export type SendRoute =
  /** 新しいターンを始める。 */
  | 'start'
  /** 進行中のターンへ割り込む。 */
  | 'steer'
  /** 送れないので待ち行列へ積む。 */
  | 'queue';

/**
 * 応答中の指示をどう送るか決める。
 *
 * `turn/steer` は割り込む先のターンidを要求する。idが判らない場合だけ待ち行列へ回す。
 */
export function routeSend(state: ChatState): SendRoute {
  if (!state.busy) {
    return 'start';
  }
  if (state.reviewing) {
    // app-serverはレビュー中のターンへの turn/steer を受け付けない（スキーマ根拠）
    return 'queue';
  }
  return state.turnId === undefined ? 'queue' : 'steer';
}

/**
 * 応答中の指示を待ち行列の末尾へ積む。
 *
 * 添えた画像も一緒に積む。テキストだけ積むと、応答中に貼った画像が黙って消える。
 */
export function enqueue(state: ChatState, text: string, attachments: Attachment[] = []): ChatState {
  if (text.trim() === '' && attachments.length === 0) {
    return state;
  }
  return { ...state, queued: [...state.queued, { text, attachments }] };
}

/** 先頭の指示を取り出す。空なら取り出さない。 */
export function takeQueued(state: ChatState): {
  message: QueuedMessage | undefined;
  next: ChatState;
} {
  return takeQueuedAt(state, 0);
}

/** 指定した位置の指示を取り出す。空または範囲外なら取り出さない。 */
export function takeQueuedAt(
  state: ChatState,
  index: number,
): {
  message: QueuedMessage | undefined;
  next: ChatState;
} {
  const message = state.queued[index];
  if (message === undefined) {
    return { message: undefined, next: state };
  }
  return { message, next: { ...state, queued: state.queued.filter((_, i) => i !== index) } };
}

/** 送信失敗で取り出した指示を元の位置へ戻す。 */
export function restoreQueued(state: ChatState, index: number, message: QueuedMessage): ChatState {
  const insertionIndex = Math.max(0, Math.min(index, state.queued.length));
  return {
    ...state,
    queued: [
      ...state.queued.slice(0, insertionIndex),
      message,
      ...state.queued.slice(insertionIndex),
    ],
  };
}

/** 末尾の指示を取り出す。空なら取り出さない。入力欄への書き戻し（Esc）に使う。 */
export function popLastQueued(state: ChatState): {
  message: QueuedMessage | undefined;
  next: ChatState;
} {
  const last = state.queued[state.queued.length - 1];
  if (last === undefined) {
    return { message: undefined, next: state };
  }
  return { message: last, next: { ...state, queued: state.queued.slice(0, -1) } };
}

/** 待機中の指示を1件取り消す。 */
export function removeQueued(state: ChatState, index: number): ChatState {
  if (index < 0 || index >= state.queued.length) {
    return state;
  }
  return { ...state, queued: state.queued.filter((_, i) => i !== index) };
}

export function clearQueue(state: ChatState): ChatState {
  return state.queued.length === 0 ? state : { ...state, queued: [] };
}

/**
 * 会話とは別に起きたことを1行残す。設定の変更のように、CLIとのやり取りの結果を
 * 見せる用途に使う。同じidで呼び直すと上書きする。
 */
export function appendNotice(state: ChatState, id: string, text: string): ChatState {
  return {
    ...state,
    items: upsertItem(state.items, {
      id,
      kind: 'settingsChanged',
      text: '',
      detail: text,
      status: undefined,
      turnId: undefined,
      diffs: NO_DIFFS,
    }),
  };
}

/**
 * 脇道の質問（issue #334、design.md §14.62、Codex TUIの `/btw` 相当）を会話へ1項目として
 * 残す/更新する。
 *
 * `appendNotice`と同じく「同じidで呼び直すと上書きする」形にする。送信中→（リトライ中）
 * →完了/失敗、と状態が進むたびに同じ項目を書き換え、新しい項目を積み増さない。
 * 表示の中身（`text`/`detail`/`status`）は`vscode`を持ち込まない純粋なロジック層
 * （`src/claude/sideQuestion.ts`）が組み立てたものをそのまま入れる。
 */
export function appendSideQuestion(
  state: ChatState,
  id: string,
  display: { status: string; text: string; detail: string },
): ChatState {
  return {
    ...state,
    items: upsertItem(state.items, {
      id,
      kind: 'sideQuestion',
      text: display.text,
      detail: display.detail,
      status: display.status,
      turnId: undefined,
      diffs: NO_DIFFS,
    }),
  };
}

/**
 * 中断の注記のid（issue #258）。
 *
 * ターンごとに別のidにする。中断はターンを終わらせるので、1回の中断につき1行になり、
 * 同じターンで呼び直しても増えない。会話画面は新しい項目を末尾へ足すだけで既存の並びを
 * 変えないため（`chatScript.ts` の `syncItems`）、固定idのままだと2回目以降の注記が
 * 1回目の位置に留まってしまう。ターンごとに別のidにすることで、そのときの末尾に出る。
 *
 * ターンが判らないときは固定のidへ落とす。`ChatSession.interrupt` は進行中のターンが
 * 無ければ何もしないので、そこから来る限りこの分岐には入らない（想定外の呼び方への保険）。
 */
export function interruptedCommandsNoticeId(turnId: string | undefined): string {
  return turnId === undefined || turnId === ''
    ? 'interruptedCommands'
    : `interruptedCommands:${turnId}`;
}

/**
 * 中断の要求そのものが失敗したときの注記のid（issue #261）。
 *
 * `interruptedCommandsNoticeId` と同じくターンごとに分ける。中断できたときの注記とは
 * 別のidにする（伝える内容が逆であり、上書きし合うと最後に起きたことしか残らない）。
 */
export function interruptFailedNoticeId(turnId: string | undefined): string {
  return turnId === undefined || turnId === '' ? 'interruptFailed' : `interruptFailed:${turnId}`;
}

/** 中断の対象になりうる（実行中の）コマンドか。CodexはinProgress、Claude Codeはrunning。 */
function isRunningCommand(item: ChatItem): boolean {
  return (
    item.kind === 'commandExecution' && (item.status === 'inProgress' || item.status === 'running')
  );
}

/**
 * 中断の印（`interruptedWhileRunning`）を後続の通知でも残すか（issue #246）。
 *
 * 判断の材料は通知の種類ではなく、届いた項目の `status`。終わったと読めたときだけ落とす。
 * `status` が読めない更新で落とすと「中断が効かない」ようにしか見えない元の問題へ戻るため、
 * 分からないうちは残す側に倒す。
 */
function keepsInterruptedMark(item: ChatItem): boolean {
  if (item.kind !== 'commandExecution') {
    return false;
  }
  return item.status === undefined || item.status === '' || isRunningCommand(item);
}

/**
 * 中断した時点で実行中だったコマンドに印を付け、会話へ1行残す（issue #246）。
 *
 * `turn/interrupt` は即座に成功を返してターンを終わらせるが、実行中のコマンドの子プロセスは
 * 残り、`item/commandExecution/outputDelta` が届き続ける（実測。design.md §9.6）。
 * 画面がそれを伝えないと「中断が効かない」としか見えないため、対象のカードに印を付けたうえで
 * 注記を1行出す。実行中のコマンドが無ければ何もしない（余計な行を残さない）。
 *
 * 注記は `turnId` ごとに1行にする（issue #258）。中断の要求を投げる前に捕まえた値を
 * 渡すこと。`state.turnId` を読むと、応答を待つ間に中断がもう一度呼ばれたときに値が
 * 落ちていて、同じ中断に対して別idの注記がもう1行出てしまう。渡し忘れを型で捕まえたいので
 * 既定値は置かない。
 */
export function markInterruptedCommands(state: ChatState, turnId: string | undefined): ChatState {
  if (!state.items.some(isRunningCommand)) {
    return state;
  }
  const items = state.items.map((item) =>
    isRunningCommand(item) ? { ...item, interruptedWhileRunning: true } : item,
  );
  return appendNotice(
    { ...state, items },
    interruptedCommandsNoticeId(turnId),
    'ターンを中断しました。実行中だったコマンドはCLI側で走り続けることがあります' +
      '（中断はターンを終わらせますが、コマンドの子プロセスは残ります）。' +
      '止めるにはターミナルでそのプロセスを終わらせてください。',
  );
}

export function addApproval(state: ChatState, approval: PendingApproval): ChatState {
  return { ...state, approvals: [...state.approvals, approval] };
}

export function removeApproval(state: ChatState, requestId: number | string): ChatState {
  return { ...state, approvals: state.approvals.filter((a) => a.requestId !== requestId) };
}

export function addPrompt(state: ChatState, prompt: PendingPrompt): ChatState {
  return { ...state, prompts: [...state.prompts, prompt] };
}

export function removePrompt(state: ChatState, requestId: number | string): ChatState {
  return { ...state, prompts: state.prompts.filter((p) => p.requestId !== requestId) };
}
