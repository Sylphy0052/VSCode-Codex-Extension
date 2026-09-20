import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { ApprovalDecision } from '../appserver/approvals';
import type { ChatState, PendingApproval } from '../appserver/chatState';
import { readNotificationsConfig } from '../config';
import type { LoopController } from '../loop/loopController';
import type { ApprovalOutcome } from '../orchestrator/taskSession';
import { nextActivePanelSequence, type ActiveComposerTarget } from './activePanelSequence';
import {
  needsAttentionAfterHandoff,
  triggerLabel,
  type HandoffTrigger,
  type OldTabKeptReason,
} from './handoff';
import { PendingHandoffChoice } from './handoffPending';
import { playNotificationSound } from './notificationSound';
import type {
  SessionApprovalDetail,
  SessionHandoffDetail,
  SessionRecentTurn,
  SessionSideQuestion,
  SharedApprovalDecision,
  SharedHandoffDecision,
} from './sessionHub';
import {
  decoratePanelTitle,
  deriveSessionActivityState,
  sanitizeForNotification,
  type SessionActivityState,
} from './sessionActivity';

/**
 * `ChatSession`（chatView.ts）と`ClaudeStreamSession`（claudeChatView.ts）が
 * 共に持つ、この基底クラスが実際に使う最小の口（issue #410）。
 *
 * 両クラスは構造的にこれを満たすため、`ChatPanel.session` / `ClaudePanel.session`は
 * 追加のラップ無しでそのまま代入できる。
 */
export interface ChatSessionLike {
  readonly threadId: string | undefined;
  getState(): ChatState;
  dispose(): void;
  decide(requestId: number | string, decision: ApprovalDecision): void;
}

/**
 * `ChatViewManager`（chatView.ts）と`ClaudeChatViewManager`（claudeChatView.ts）が
 * 共に持つパネルエントリの最小集合（issue #410）。両ファイルの`ChatPanel`/`ClaudePanel`は
 * これを含む形で拡張して定義する。
 *
 * 各フィールドの詳しい説明は、issue #420で`ChatPanel`/`ClaudePanel`側の重複宣言を
 * 消したときにここへ移設したもの（元は両サブクラスがほぼ同文のJSDocを重複して持っていた）。
 */
export interface BaseChatPanel {
  /**
   * 今そのタブが開いているか。`undefined` はタブが閉じられている状態を表す。
   *
   * タスク管理下のセッション（`taskManaged: true`）は、タブを閉じてもこのエントリ自体は
   * `panels` に残り続ける（design.md §16.10「セッションの寿命をパネルから切り離す」）。
   * `reveal()` / `open()` はこの値が `undefined` ならパネルを作り直す。
   */
  panel: vscode.WebviewPanel | undefined;
  /**
   * 最後に見えていた列。`panel.viewColumn` はタブが非表示（背面）のとき`undefined`に
   * なるため、自動引き継ぎ（背面タブでも発火する）が新パネルの列を決めるときの
   * フォールバックに使う。`attachPanel`の`onDidChangeViewState`で更新する。
   */
  lastKnownViewColumn: vscode.ViewColumn | undefined;
  /** セッションを開始した作業ディレクトリ。カンバンのワークスペース絞り込みに使う。 */
  cwd: string | undefined;
  session: ChatSessionLike;
  /** この画面で走らせているループ。走っていなければ待機状態のまま。 */
  loop: LoopController;
  /**
   * 破棄済みか。
   *
   * 保留中の承認を解放すると、その結果の通知が破棄後に届くことがある。破棄済みの
   * セッションへ送るとVSCodeが例外を投げるため、ここで止める。`panel === undefined`
   * とは別の概念（タスク管理下のセッションはタブが閉じても破棄されない）。
   */
  disposed: boolean;
  /** パネルの見出し。タブが閉じている間もタイトルを見失わないよう、パネルとは別に保持する。 */
  title: string;
  /**
   * オーケストレータが指定したタブ名（Issue #599）。`openTaskSession`が
   * `buildSessionPanelTitle`で組み立てた値をそのまま持ち、**CLI側の要約名より優先する**
   * （`deriveTitle`の第2引数）。人が手で開いた画面では`undefined`。
   *
   * **`ChatState`ではなくここに持つ。**`ChatState`はapp-serverからの通知でまるごと
   * 組み替わる状態で、そこへ置くと「`thread/name/updated`はこの値を触らない」という
   * 禁止を規約で守ることになる。`ChatPanel`にはapp-serverから触れる経路が無いため、
   * 同じことを構造で守れる。
   *
   * **揮発してよい。**リロード後、タスク管理下のスレッドは`restorePanel`が拾わず
   * （`isTaskManagedThread`）、`runner.ts`が`openTaskSession`で開き直すため
   * （design.md §16.10の7）、この値も同じ経路で再び渡る。
   */
  pinnedName: string | undefined;
  /**
   * タスク（オーケストレータ）管理下のセッションか。
   *
   * `true` の場合だけタブを閉じてもセッションを維持する（design.md §16.10の4）。
   * 人が手で開いた画面（`false`）は従来通りタブを閉じたらセッションも終わる。
   */
  taskManaged: boolean;
  /** `TaskSession.onApprovalResolved` のリスナー。 */
  approvalResolvedListeners: Array<(outcome: ApprovalOutcome) => void>;
  /**
   * 通知を出した承認要求の`requestId`（issue #286）。`String(requestId)`で持つ
   * （requestIdは`number | string`のどちらも来るため、Setのキーとして安定させる）。
   *
   * 一度でも通知の要否を判定した`requestId`はここへ積み、二度と判定し直さない
   * （タブの表示・非表示が何度切り替わっても、同じ承認要求で通知を重複させない）。
   * 「見えているか」は通知するかどうかを決めた**その瞬間**の`entry.panel?.visible`
   * だけを見る。後から可視性が変わっても、既に判定済みの要求を再評価しない
   * （`notifyNewApprovals`参照）。
   */
  notifiedApprovalRequestIds: Set<string>;
  /**
   * 引き継ぎ元として残されたときの理由（Issue #1165）。残っていなければ`undefined`。
   *
   * 引き継ぎ後に旧タブを閉じられなかったことは、これまでOutputへ1行出るだけで、
   * タブが増えていく側の人には見えなかった。Attention Indexへ投影するための印として
   * ここに持つ（`needsAttentionAfterHandoff`が対象を絞る）。
   *
   * 人が自分でタブを閉じればエントリごと消えるため、解除の操作は要らない。
   */
  handoffKept?: OldTabKeptReason | undefined;
  /**
   * `handoffKept`を立てた時点でのユーザー発言の数（Issue #1165）。
   *
   * 人がこのタブへ何か送ったら「気づいて使い始めた」ので、印を下げる判定に使う。
   * 印が立っていない間は`undefined`。
   */
  handoffKeptUserMessages?: number | undefined;
  /**
   * 保留中の引き継ぎ確認（Issue #1280）。確認待ちでなければ`undefined`。
   *
   * 引き継ぎ先のmodel / effortの確認は人が答えるまで進まない。`ChatState`には現れない
   * 状態なので、セッションの活動状態（`handoffPending`）の判定材料としてここに持つ。
   */
  pendingHandoff?: PendingHandoffChoice | undefined;
  /** 状態送信の間引き（issue #246）。予約中のタイマー。 */
  postTimer?: ReturnType<typeof setTimeout> | undefined;
}

/**
 * 直近のやり取りとして返す上限（Issue #1260）。
 *
 * 要求側が件数を指定するが、共有ディレクトリへ書くのは別プロセスなので、受信側で丸める。
 * 大きな値をそのまま通すと、会話全体を1回の応答へ載せることになる。
 */
const MAX_RECENT_TURNS = 20;

/** 1件の本文の上限。カードは流れを掴むためのもので、全文はタブ側で読む。 */
const MAX_RECENT_TURN_CHARS = 600;

/**
 * 脇道の質問の回答を返すときの上限（Issue #1261）。
 *
 * 直近のやり取り（`MAX_RECENT_TURN_CHARS`）より大きくとる。やり取りは流れを掴むための
 * 抜粋だが、回答はそれ自体が読みたいもので、途中で切れると用を成さない。それでも
 * 上限を外さないのは、応答ファイルが共有ディレクトリを経由するため（会話1本ぶんの
 * 長文をそのまま載せない）。
 */
const MAX_SIDE_QUESTION_ANSWER_CHARS = 6_000;

/** 質問文の上限。長文を投げる用途なら本流の会話（`send`）を使う。 */
const MAX_SIDE_QUESTION_CHARS = 2_000;

/**
 * 回答を待つ上限（Issue #1261）。
 *
 * 要求と応答の共通タイムアウト（`sessionHub.ts`の`REPLY_TIMEOUT_MS` = 5秒）とは別物。
 * 脇道の質問はモデルの応答を待つため5秒では終わらず、要求（投げる）と結果の取得を
 * 分けている。これは「投げたきり終わらない質問」を片付けるための上限で、これを過ぎた
 * 質問は`failed`にして画面の待機表示を解く（受入基準「待機表示のまま固まらない」）。
 */
const SIDE_QUESTION_TIMEOUT_MS = 180_000;

/**
 * 終わった質問を保持しておく時間。
 *
 * 統括ページは3秒ごとに結果を取りに来るため、これだけあれば読み切れる。統括ページを
 * 閉じた後に誰も取りに来なかった分も、この時間で消える。
 */
const SIDE_QUESTION_TTL_MS = 300_000;

/** 同時に覚えておく質問の数。超えたら古いものから捨てる。 */
const MAX_SIDE_QUESTIONS = 20;

/** セッション統括ページから1つのセッションへ行える操作（Issue #1258）。 */
export type SessionControlAction =
  | { kind: 'open' }
  | { kind: 'interrupt' }
  | { kind: 'pauseLoop' }
  | { kind: 'resumeLoop' }
  | { kind: 'send'; text: string }
  /** 承認待ちの中身を取り寄せる（Issue #1259）。カードを展開したときだけ送る。 */
  | { kind: 'approvalDetail' }
  /** 取り寄せた中身に対する承認・拒否（Issue #1259）。 */
  | { kind: 'approvalDecision'; approvalRequestId: string; decision: SharedApprovalDecision }
  /** 会話の直近のやり取りを取り寄せる（Issue #1260）。カードを展開している間だけ送る。 */
  | { kind: 'recentTurns'; limit: number }
  /** 脇道の質問を投げる（Issue #1261）。回答を待たず、受け付けたことだけを返す。 */
  | { kind: 'sideQuestion'; text: string }
  /** 投げた脇道の質問の進み具合を取りに行く（Issue #1261）。 */
  | { kind: 'sideQuestionResult'; sideQuestionId: string }
  /** 保留中の引き継ぎ確認の中身を取り寄せる（Issue #1280）。カードを展開したときだけ送る。 */
  | { kind: 'handoffDetail' }
  /**
   * 取り寄せた保留に対する決定（Issue #1280）。
   *
   * `model` / `effort`は`decision === 'repick'`のときだけ意味を持つ。値の妥当性は
   * 保留を持っている側（`PendingHandoffChoice`）が、公開した候補と突き合わせて確かめる。
   */
  | {
      kind: 'handoffDecision';
      handoffRequestId: string;
      decision: SharedHandoffDecision;
      model?: string | undefined;
      effort?: string | undefined;
    };

/** 操作の結果。`error`は統括ページにそのまま出すため、人に読める文にする。 */
export interface SessionControlResult {
  ok: boolean;
  error?: string | undefined;
  /** `kind === 'approvalDetail'`のときだけ入る、承認待ちの中身（Issue #1259）。 */
  approvals?: SessionApprovalDetail[] | undefined;
  /** `kind === 'recentTurns'`のときだけ入る、直近のやり取り（Issue #1260）。 */
  turns?: SessionRecentTurn[] | undefined;
  /** `turns`を作った時刻（Issue #1260）。 */
  capturedAt?: number | undefined;
  /** `kind === 'sideQuestion'` / `'sideQuestionResult'`のときだけ入る（Issue #1261）。 */
  sideQuestion?: SessionSideQuestion | undefined;
  /** `kind === 'handoffDetail'`のときだけ入る、保留中の引き継ぎ確認（Issue #1280）。 */
  handoff?: SessionHandoffDetail | undefined;
}

/**
 * 投げた脇道の質問1件の状態（Issue #1261）。
 *
 * `SessionSideQuestion`（統括ページへ運ぶ形）に、掃除のための`finishedAt`を足したもの。
 */
interface SideQuestionRun extends SessionSideQuestion {
  /** どの会話へ投げた質問か。同じ会話への連投を止める判定に使う。 */
  threadId: string | undefined;
  /** 終わった時刻。走っている間は`undefined`で、掃除の対象にしない。 */
  finishedAt: number | undefined;
  /**
   * 時間切れと管理クラスの破棄を実装側（`runSideQuestion`）へ伝える口。
   *
   * 待つのをやめるだけでは、Codexはforkしたスレッドとエントリが、Claude Codeは
   * 応答待ちが残る。打ち切りをそこまで届かせる。
   */
  abort: AbortController;
}

/**
 * `AbortSignal`が発火したら`reject`するだけのPromise（Issue #1261）。
 *
 * 打ち切れない待ち（Claude Codeの`side_question`のように、送った要求を取り消す口が
 * 無いもの）を`Promise.race`で区切るのに使う。相手が後から応答しても、待っていた側は
 * 既に離れているだけで、要求そのものは止まっていない。
 */
export function abortAsRejection(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    const fail = (): void => {
      const reason: unknown = signal.reason;
      reject(reason instanceof Error ? reason : new Error(String(reason)));
    };
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener('abort', fail, { once: true });
  });
}

function toSideQuestionView(run: SideQuestionRun): SessionSideQuestion {
  return {
    id: run.id,
    status: run.status,
    question: run.question,
    answer: run.answer,
    error: run.error,
  };
}

/**
 * 承認待ちの中身を、統括ページへ運べる形にする（Issue #1259）。
 *
 * `fileChange`の要求は変更内容を持たず、同じidの項目側に入っている
 * （`PendingApproval.itemId`のJSDoc）。差分が届く前でもパスだけは`detail`
 * （`describeFileChanges`がカンマ区切りで作る）から引けるため、両方を見る。
 */
function describePendingApprovals(
  state: Pick<ChatState, 'approvals' | 'items'>,
): SessionApprovalDetail[] {
  return state.approvals.map((approval) => ({
    requestId: String(approval.requestId),
    kind: approval.kind,
    title: approval.title,
    detail: approval.detail,
    paths: readApprovalPaths(state, approval),
    // 選択式の問い合わせは4値（accept/acceptForSession/decline/cancel）では答えられない
    decidable: approval.kind !== 'askUserQuestion',
  }));
}

function readApprovalPaths(state: Pick<ChatState, 'items'>, approval: PendingApproval): string[] {
  if (approval.itemId === undefined) {
    return [];
  }
  const item = state.items.find((i) => i.id === approval.itemId);
  if (item === undefined) {
    return [];
  }
  if (item.diffs.length > 0) {
    return item.diffs.map((diff) => diff.path);
  }
  return item.detail
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '');
}

/**
 * 統括ページのカードへ出す、直近のやり取り（Issue #1260）。
 *
 * 人の発言とエージェントの応答だけを新しい順の末尾から拾う。コマンド実行・思考・
 * ファイル変更を混ぜると、カードの高さがターンの中身で決まってしまい、会話の流れを
 * 掴むという用途から外れる（詳細はタブ側で読む）。
 *
 * `ChatItem`は項目ごとの時刻を持たないため、1件ずつの時刻は返せない。呼び出し側が
 * `capturedAt`（いつ時点の内容か）を添える。
 *
 * 件数の丸めと切り詰めの境界を直接試せるよう、純粋関数としてexportする。
 */
export function readRecentTurns(
  state: Pick<ChatState, 'items'>,
  limit: number,
): SessionRecentTurn[] {
  // NaN・Infinityは丸めを素通りして件数の比較を常に偽にする（1件も返らない）。
  // 呼び出し側が形だけ確かめて渡すため、ここで使える値へ倒しておく
  const count = Number.isFinite(limit)
    ? Math.min(Math.max(Math.trunc(limit), 1), MAX_RECENT_TURNS)
    : 1;
  const turns: SessionRecentTurn[] = [];
  // 末尾から必要な分だけ遡る。長い会話で全件を走査しない
  for (let i = state.items.length - 1; i >= 0 && turns.length < count; i -= 1) {
    const item = state.items[i];
    if (item === undefined) {
      continue;
    }
    const role =
      item.kind === 'userMessage' ? 'user' : item.kind === 'agentMessage' ? 'agent' : undefined;
    if (role === undefined || item.text.trim() === '') {
      continue;
    }
    const text = item.text.trim();
    const truncated = text.length > MAX_RECENT_TURN_CHARS;
    turns.push({
      role,
      // 切り詰めは末尾ではなく先頭を残す。発言の書き出しの方が何の話か判りやすい
      text: truncated ? text.slice(0, MAX_RECENT_TURN_CHARS) : text,
      truncated,
    });
  }
  return turns.reverse();
}

/**
 * カードから開いたときにエディタグループを最大化する（Issue #1258）。
 *
 * 統括ページは`ViewColumn.Beside`で開くため、そのままだと開いた会話が半分の幅に
 * 収まってしまう。`workbench.action.toggleMaximizeEditorGroup`はトグルで、最大化中か
 * どうかを取るAPIが無いため、既に最大化されている状態で呼ぶと解除になる。
 * 失敗しても会話は開けているので、警告を出さず黙って諦める。
 */
async function maximizeEditorGroup(): Promise<void> {
  try {
    await vscode.commands.executeCommand('workbench.action.toggleMaximizeEditorGroup');
  } catch {
    // コマンドが無い版・実行できない配置でも、開く操作自体は成立している
  }
}

/** ユーザーが送った発言の数。引き継ぎ元のタブを人が使い直したかの判定に使う。 */
function countUserMessages(state: ChatState): number {
  return state.items.filter((item) => item.kind === 'userMessage').length;
}

/** 状態が変わったことの通知の中身（issue #721）。 */
export interface ChatStateChange {
  threadId: string;
  state: ChatState;
  /**
   * そのときのチャットの表示名（issue #1013）。進捗画面はタブのタイトルへ使う。
   *
   * `open`のときに一度読んだ値を持ち続けると、`deriveTitle`が名前を作り直しても
   * （`chatView.ts`の`onSessionChange`、`claudeChatView.ts`の`applyTitle`）進捗タブだけ
   * 古い名前のまま残る。状態と同じ経路で毎回渡して追随させる。
   */
  title: string;
}

/**
 * 進捗画面を開く対象（issue #721）。`activeSequence`はプロバイダをまたいで
 * 「どちらのタブがより最近アクティブだったか」を比べるためだけに使う
 * （`ActiveComposerTarget`と同じ流儀）。
 */
export interface ProgressTarget {
  threadId: string;
  title: string;
  activeSequence: number;
}

/** 開いている会話の一覧へ公開する最小の状態（Issue #811）。 */
export interface ManagedChatSession {
  threadId: string;
  title: string;
  cwd: string | undefined;
  activity: SessionActivityState;
  /**
   * この画面で走らせているループの状態（Issue #1258）。セッション統括ページが
   * 一時停止と再開のボタンを出し分けるのに使う。
   */
  loop: { running: boolean; paused: boolean };
  /**
   * 引き継ぎ元として残されたときの理由（Issue #1165）。残っていなければ`undefined`。
   * Attention Indexが「引き継いだはずのタブが残っている」項目を作るのに使う。
   */
  handoffKept: OldTabKeptReason | undefined;
}

/**
 * `ChatViewManager`（Codex、chatView.ts）と`ClaudeChatViewManager`（Claude Code、
 * claudeChatView.ts）の重複を抽出した基底クラス（issue #410）。
 *
 * パネルのライフサイクル管理（表示・アタッチ・破棄）と、承認待ち・ターン完了の通知判定を
 * ここへ集める。`handleMessage`の分岐、`onSessionChange`の中身、`buildTaskSession`、
 * 各種`open*`メソッドはプロバイダごとに大きく異なるため（design.md §16.10）、
 * 引き続き各サブクラスに残す。
 *
 * 挙動差の扱い（自己レビュー、issue #410の指示）:
 * - Codex（`ChatViewManager`）は`AppServerConnection`を全スレッドで共有するため、
 *   接続断（`handleConnectionLost`）と`pendingStarts`（`thread/start`応答待ち）を持つ。
 *   Claude Code（`ClaudeStreamSession`）はセッションごとに別プロセスで、この概念が無い。
 *   この非対称は実装のズレではなく、プロバイダのアーキテクチャそのものの違いなので
 *   基底クラスへは引き上げず、`allPanels()`のオーバーライドと`onTeardown`/`onDispose`
 *   フックだけをCodex側に残す
 * - `settings`はCodex・Claude Codeどちらも`flushState`が毎回載せて送る（issue #420で
 *   揃えた。以前はClaude Code側だけ`refreshSettings`という別経路でしか設定を送れず、
 *   `onLoopStatus`がその別経路を呼ぶことで間引きを迂回していた問題があった）。
 *   残る違いは`refreshSettings`（Claude Codeのみ）が、設定パネルでの変更など人の操作へ
 *   即座に反映したい場面で`postState`の間引きを迂回して即時送信する点だけ。会話項目は
 *   全量を送るが`items`キーを付けないため、webview側の差し分の積み先
 *   （`chatScript.ts`の`mergedItems`）には影響しない（`entry.sentItems`を書き換えては
 *   ならない理由も同じ。`claudeChatView.ts`の`refreshSettings`のJSDoc参照）
 */
export abstract class BaseChatViewManager<TPanel extends BaseChatPanel>
  implements vscode.Disposable
{
  protected readonly panels = new Map<string, TPanel>();
  /**
   * 統括ページから投げられた脇道の質問（Issue #1261）。
   *
   * 回答は本流の会話に残さないため、届いた回答をここで預かり、要求元が
   * `sideQuestionResult`で取りに来るまで持つ。会話（`panels`）ではなくこの管理クラスが
   * 持つのは、質問を投げたタブが閉じた後でも投げた側が結果を読めるようにするため。
   */
  private readonly sideQuestions = new Map<string, SideQuestionRun>();
  /** 名前変更・クリア・エディタ選択範囲挿入の対象。最後にアクティブだった画面。 */
  protected active: TPanel | undefined;
  /**
   * `active` が（再）設定されるたびに進む採番（issue #292）。プロバイダをまたいだ比較に
   * 使う（`getActiveComposerTarget` 参照）。
   */
  protected activeSequence = 0;

  /**
   * 状態が変わったことの通知（issue #721）。進捗画面がこれを購読して描き直す。
   *
   * 発火するのは各サブクラスの`postState`（間引き済みの経路）からで、webviewへ送るのと
   * 同じ頻度になる。生の状態変化ごとに投げると、応答中は毎デルタで発火してしまう。
   */
  protected readonly stateChanged = new vscode.EventEmitter<ChatStateChange>();
  readonly onDidChangeState = this.stateChanged.event;
  private readonly panelsChanged = new vscode.EventEmitter<void>();
  /**
   * 開いているセッションの集合が変わった（issue #734）。
   *
   * `teardown`は`onDidChangeState`を出さない（`entry.disposed`を先に立ててから
   * `session.dispose()`で保留中の承認を解放するため、`onSessionChange`が
   * `entry.disposed`の早期returnで止まる）。承認待ちのままタブを閉じた分を
   * 数え直す契機が他に無いので、集合の変化として別に出す。
   */
  readonly onDidChangePanels = this.panelsChanged.event;

  /**
   * 進捗画面（issue #721）が開く対象。表に出ているチャットが無い・スレッドがまだ
   * 始まっていない（`thread/start`の応答待ち）ときは`undefined`。
   */
  getActiveProgressTarget(): ProgressTarget | undefined {
    const entry = this.active;
    if (entry === undefined || entry.disposed) {
      return undefined;
    }
    const threadId = entry.session.threadId;
    if (threadId === undefined) {
      return undefined;
    }
    return { threadId, title: entry.title, activeSequence: this.activeSequence };
  }

  /**
   * 指定したスレッドの現在の状態（issue #721）。進捗画面が開いた直後の初期表示に使う。
   * 既に閉じられているスレッドでは`undefined`。
   */
  getChatState(threadId: string): ChatState | undefined {
    const entry = this.panels.get(threadId);
    return entry === undefined || entry.disposed ? undefined : entry.session.getState();
  }

  /** この拡張機能が現在管理している会話だけを返す。履歴だけの会話は含めない。 */
  managedSessions(): ManagedChatSession[] {
    const sessions: ManagedChatSession[] = [];
    for (const entry of this.allPanels()) {
      const threadId = entry.session.threadId;
      if (entry.disposed || threadId === undefined) {
        continue;
      }
      sessions.push({
        threadId,
        title: entry.title,
        cwd: entry.cwd,
        activity: this.activityStateOf(entry),
        loop: { running: entry.loop.running, paused: entry.loop.isPaused },
        handoffKept: entry.handoffKept,
      });
    }
    return sessions;
  }

  /** サブクラスの`postState`から呼ぶ。webviewへ送るのと同じ内容を進捗画面へも配る。 */
  protected fireStateChanged(entry: TPanel, state: ChatState): void {
    this.clearHandoffKeptIfReused(entry, state);
    const threadId = entry.session.threadId;
    if (threadId === undefined) {
      return;
    }
    this.stateChanged.fire({ threadId, state, title: entry.title });
  }

  /**
   * 引き継ぎ元として残ったタブへ人が何か送ったら、Attention Indexの印を下げる（Issue #1165）。
   *
   * 残っていること自体が問題なのではなく、残っていることに気づかれないのが問題なので、
   * 人が使い始めた時点で役目が終わる。ターンの実行や完了では下げない——引き継ぎの時点で
   * 既に走っていたターン（`oldBusy`）が終わっただけでは、人が気づいた証拠にならない。
   */
  private clearHandoffKeptIfReused(entry: TPanel, state: ChatState): void {
    if (entry.handoffKept === undefined) {
      return;
    }
    if (countUserMessages(state) <= (entry.handoffKeptUserMessages ?? 0)) {
      return;
    }
    entry.handoffKept = undefined;
    entry.handoffKeptUserMessages = undefined;
    this.panelsChanged.fire();
  }

  /**
   * 開いている（開始待ちも含む）全パネル。既定は`panels`の値のみ。Codex側は
   * `pendingStarts`（`thread/start`応答待ち）も含めてオーバーライドする。
   */
  protected allPanels(): TPanel[] {
    return [...this.panels.values()];
  }

  /**
   * 実際のwebviewパネルを新規作成する。viewTypeとパネルオプションはプロバイダごとに異なる。
   *
   * `targetViewColumn`が未指定なら`ViewColumn.Active`にフォールバックする（従来通り）。
   */
  protected abstract createWebviewPanel(
    entry: TPanel,
    preserveFocus: boolean,
    targetViewColumn: vscode.ViewColumn | undefined,
  ): vscode.WebviewPanel;

  /** webviewへ渡すHTML本体を組み立てる。`renderShell`へ渡すオプションはプロバイダごとに異なる。 */
  protected abstract renderPanelHtml(entry: TPanel, panel: vscode.WebviewPanel): string;

  /** webviewから届いたメッセージを実際に処理する（`handleMessage`）。 */
  protected abstract dispatchMessage(entry: TPanel, message: unknown): void;

  /**
   * パネルを表に出す。既にタブがあれば `reveal`、閉じていれば作り直す
   * （design.md §16.10の4「reveal()でパネルを作り直し、ChatStateから会話を描き直す」）。
   * 会話の再描画は、webview起動時の `ready` 通知への応答（`postState`）に任せる。
   */
  protected showPanel(
    entry: TPanel,
    preserveFocus: boolean,
    targetViewColumn?: vscode.ViewColumn,
  ): void {
    if (entry.disposed) {
      return;
    }
    if (entry.panel !== undefined) {
      entry.panel.reveal(undefined, preserveFocus);
      if (!preserveFocus) {
        this.active = entry;
        this.activeSequence = nextActivePanelSequence();
      }
      return;
    }
    const panel = this.createWebviewPanel(entry, preserveFocus, targetViewColumn);
    this.attachPanel(entry, panel);
  }

  /**
   * 実際のパネルへ表示を結び付け、イベントを配線する。
   *
   * `panel.webview.options`（`enableScripts`等）はここで入れ直すが、`enableFindWidget`
   * （design.md §14.48、issue #287）は`WebviewPanel.options`側の値で読み取り専用のため、
   * ここから再設定する手段が無い。`restorePanel`経由（タブ復元）で渡ってくるパネルは
   * VSCode本体が新規に構築したもので、`enableFindWidget`を含む`WebviewPanelOptions`は
   * 生成時にしか指定できない。
   */
  protected attachPanel(entry: TPanel, panel: vscode.WebviewPanel): void {
    entry.panel = panel;
    if (panel.visible) {
      entry.lastKnownViewColumn = panel.viewColumn;
    }
    panel.title = entry.title;
    panel.webview.options = { enableScripts: true };
    panel.webview.html = this.renderPanelHtml(entry, panel);
    panel.webview.onDidReceiveMessage((message: unknown) => this.dispatchMessage(entry, message));
    panel.onDidChangeViewState(() => {
      if (panel.visible) {
        entry.lastKnownViewColumn = panel.viewColumn;
      }
      if (panel.active) {
        this.active = entry;
        this.activeSequence = nextActivePanelSequence();
      }
    });
    panel.onDidDispose(() => {
      entry.panel = undefined;
      if (!entry.taskManaged) {
        // 人が手で開いた画面は、これまで通りタブを閉じたらセッションも終わる
        this.teardown(entry);
        return;
      }
      if (this.active === entry) {
        this.active = undefined;
      }
    });
    // showPanelのreveal分岐（既存タブ）はpreserveFocusを見てactiveを更新するのに、
    // 新規作成のこの分岐だけ無条件にactiveを奪っていた（レビュー指摘: critical 2）。
    // タスクは必ずpreserveFocus: trueで背面に開く（design.md §16.10の2）ため、
    // 無条件のままだと背面のタスクが「名前変更」等の対象を奪ってしまう。
    // 実際にフォーカスが当たっているか（panel.active）を見て決める
    if (panel.active) {
      this.active = entry;
      this.activeSequence = nextActivePanelSequence();
    }
  }

  /**
   * そのセッションの活動状態（issue #286、design.md §14.55）。
   *
   * 開いていなければ`undefined`（履歴ツリーの印に使う。タスク管理下のセッションは
   * タブを閉じても`panels`に残り続けるため、タブが閉じていても実行中のタスクは
   * `undefined`にならない）。
   */
  getActivityState(id: string): SessionActivityState | undefined {
    const entry = this.panels.get(id);
    return entry === undefined ? undefined : this.activityStateOf(entry);
  }

  /**
   * 1つの画面の活動状態。`ChatState`に現れない引き継ぎ確認待ち（Issue #1280）を含める。
   *
   * タブ名の印・履歴ツリー・統括ページが同じ判定を通るよう、状態を引く口をここへ揃える。
   */
  protected activityStateOf(entry: TPanel): SessionActivityState {
    return deriveSessionActivityState(
      entry.session.getState(),
      entry.pendingHandoff?.active === true,
    );
  }

  /**
   * 引き継ぎ確認の保留を作り、この画面の状態として公開する（Issue #1280）。
   *
   * 保留の有無が変わるたびにタブ名の印を付け直し、`onDidChangePanels`で統括ページと
   * 履歴ツリーを数え直させる。`onDidChangeState`は確認待ちの間`ChatState`が動かない
   * ため出ない（引き継ぎ元として残ったタブの印（Issue #1165）と同じ事情）。
   *
   * 音もここで鳴らす（Issue #1313）。引き継ぎが確定した後ではなく、確認で止まった
   * 時点が人に気付いてほしい瞬間であるため。手動の引き継ぎは利用者自身の操作なので
   * 鳴らさない（Issue #1246からの引き継ぎ）。
   */
  protected beginPendingHandoff(entry: TPanel, trigger: HandoffTrigger): PendingHandoffChoice {
    let wasActive = false;
    const pending = new PendingHandoffChoice(triggerLabel(trigger), () => {
      // 触るのは自分がこの画面の保留でいる間だけ。引き継ぎを続けて始めたとき（手動と
      // 自動が重なる等）に、先に始まった方の再判定や後始末が、後から始まった保留を
      // 追い出したり消したりしないようにする
      if (entry.pendingHandoff !== undefined && entry.pendingHandoff !== pending) {
        return;
      }
      const nowActive = pending.active;
      // 確認待ちが立ち上がった1回だけ鳴らす。「再判定」で提案が差し替わる間は保留が
      // 立ったままなので、ここは通らない（連打にならない）
      if (nowActive && !wasActive && trigger.kind !== 'manual') {
        playNotificationSound('handoff', entry.panel?.visible === true);
      }
      wasActive = nowActive;
      entry.pendingHandoff = nowActive ? pending : undefined;
      this.refreshPanelTitle(entry);
      this.panelsChanged.fire();
    });
    entry.pendingHandoff = pending;
    return pending;
  }

  /** タブ名の印を今の活動状態で付け直す（Issue #1280）。 */
  protected refreshPanelTitle(entry: TPanel): void {
    if (entry.panel !== undefined && !entry.disposed) {
      entry.panel.title = decoratePanelTitle(entry.title, this.activityStateOf(entry));
    }
  }

  /**
   * 承認待ちのセッション（issue #734・#755）。バッジの件数とステータスバーから開く先の
   * 両方がこれを母数にする。
   *
   * 母数は`getActivityState`と同じ`panels`にする（`allPanels()`ではない）。
   * `allPanels()`が追加で含むCodex側の`pendingStarts`は`thread/start`の応答待ちで、
   * まだセッションが無く承認要求も出ないため、含めても結果は変わらないが、
   * 履歴ツリーの印（`getActivityState`）と母数がずれる分だけ食い違いの元になる。
   */
  approvalPendingSessions(): Array<{ threadId: string; title: string }> {
    const pending: Array<{ threadId: string; title: string }> = [];
    for (const [threadId, entry] of this.panels) {
      if (deriveSessionActivityState(entry.session.getState()) === 'approvalPending') {
        pending.push({ threadId, title: entry.title });
      }
    }
    return pending;
  }

  /**
   * 開いているセッションを表に出す（issue #755）。ステータスバーから承認待ちの画面へ
   * 戻るのに使う。既に閉じられていれば何もせず`false`を返す。
   *
   * タブを閉じたタスク管理下のセッション（`panel === undefined`）も対象で、
   * `showPanel`がパネルを作り直す（design.md §16.10の4）。
   */
  revealSession(threadId: string): boolean {
    const entry = this.panels.get(threadId);
    if (entry === undefined || entry.disposed) {
      return false;
    }
    this.showPanel(entry, false);
    return true;
  }

  /**
   * セッション統括ページ（`sessionKanbanView.ts`）からの操作（Issue #1258）。
   *
   * 自ウィンドウのカードからも、別ウィンドウから要求ファイルで届いた分
   * （`extension.ts`の`SessionHubRequestWatcher`）からも、同じここを通す。
   *
   * 中断と送信は`dispatchMessage`（webviewの操作と同じ入口）へ流す。ループへの割り込み
   * 扱い・上限による自動再開の抑止・擬似コマンドの扱いは各サブクラスの`send` /
   * `interrupt`の分岐が持っているため、ここで作り直すと画面からの操作と挙動がずれる。
   */
  controlSession(threadId: string, action: SessionControlAction): SessionControlResult {
    // 結果の取得だけは会話の有無より先に見る（Issue #1261）。回答が返る前にタブが
    // 閉じても、投げた側は結果を読めるようにする（預かっているのはこの管理クラス）
    if (action.kind === 'sideQuestionResult') {
      const run = this.sideQuestions.get(action.sideQuestionId);
      return run === undefined
        ? { ok: false, error: 'この脇道の質問は見つかりませんでした' }
        : { ok: true, sideQuestion: toSideQuestionView(run) };
    }
    const entry = this.panels.get(threadId);
    if (entry === undefined || entry.disposed) {
      return { ok: false, error: 'この会話は既に閉じられています' };
    }
    switch (action.kind) {
      case 'open':
        this.showPanel(entry, false);
        void maximizeEditorGroup();
        return { ok: true };
      case 'interrupt':
        this.dispatchMessage(entry, { type: 'interrupt' });
        return { ok: true };
      case 'send':
        if (action.text.trim() === '') {
          return { ok: false, error: '送る内容がありません' };
        }
        this.dispatchMessage(entry, { type: 'send', text: action.text });
        return { ok: true };
      case 'pauseLoop':
        if (!entry.loop.running || entry.loop.isPaused) {
          return { ok: false, error: '一時停止できるループが走っていません' };
        }
        entry.loop.pause();
        return { ok: true };
      case 'resumeLoop':
        if (!entry.loop.running || !entry.loop.isPaused) {
          return { ok: false, error: '再開できる一時停止中のループがありません' };
        }
        entry.loop.resume();
        return { ok: true };
      case 'sideQuestion': {
        const question = action.text.trim();
        if (question === '') {
          return { ok: false, error: '質問の内容がありません' };
        }
        if (question.length > MAX_SIDE_QUESTION_CHARS) {
          return { ok: false, error: '質問が長すぎます（会話のタブから送ってください）' };
        }
        // 同じ会話へ重ねて投げさせない。1件ごとにCodexはforkスレッド、Claude Codeは
        // 制御要求を1本使うため、連打でいくらでも並行に走らせられる形にしない
        if (this.hasRunningSideQuestion(threadId)) {
          return { ok: false, error: 'この会話は前の脇道の質問の回答待ちです' };
        }
        return {
          ok: true,
          sideQuestion: toSideQuestionView(this.beginSideQuestionRun(entry, question)),
        };
      }
      case 'approvalDetail':
        return { ok: true, approvals: describePendingApprovals(entry.session.getState()) };
      case 'recentTurns':
        return {
          ok: true,
          turns: readRecentTurns(entry.session.getState(), action.limit),
          capturedAt: Date.now(),
        };
      case 'approvalDecision': {
        const state = entry.session.getState();
        // 取り寄せてから押すまでの間に、タブ側やTUIで解決されていることがある。
        // 残っている要求だけを対象にし、消えていれば失敗として返す（黙って握りつぶさない）
        const approval = state.approvals.find(
          (a) => String(a.requestId) === action.approvalRequestId,
        );
        if (approval === undefined) {
          return { ok: false, error: 'この承認要求は既に解決されています' };
        }
        if (approval.kind === 'askUserQuestion') {
          return { ok: false, error: 'この問い合わせは会話のタブ側で答えてください' };
        }
        this.resolveApproval(entry, approval.requestId, action.decision);
        return { ok: true };
      }
      case 'handoffDetail': {
        const handoff = entry.pendingHandoff?.detail();
        return handoff === undefined
          ? { ok: false, error: 'この会話は引き継ぎの確認待ちではありません' }
          : { ok: true, handoff };
      }
      case 'handoffDecision': {
        const pending = entry.pendingHandoff;
        if (pending === undefined) {
          return { ok: false, error: 'この引き継ぎ確認は既に解決されています' };
        }
        const settings =
          action.model === undefined
            ? undefined
            : { model: action.model, effort: action.effort ?? '' };
        return pending.decide(action.handoffRequestId, action.decision, settings);
      }
    }
  }

  /**
   * 脇道の質問を投げ、回答を預かる（Issue #1261）。
   *
   * 回答は待たずに戻る。統括ページは`sessionHubRequestPort`の5秒のタイムアウトの中で
   * 「受け付けた」ことだけを受け取り、以降は`sideQuestionResult`で進み具合を取りに来る。
   *
   * 回答は`sideQuestions`にだけ置く。`runSideQuestion`の実装（Codexはephemeralな
   * forkスレッド、Claude Codeは`side_question`の制御要求）はどちらも本流の会話
   * （`entry.session`の`items`）へ項目を積まないため、統括ページから投げた質問と回答は
   * 会話のタブ側には現れない（受入基準）。
   */
  private beginSideQuestionRun(entry: TPanel, question: string): SideQuestionRun {
    this.sweepSideQuestions();
    const abort = new AbortController();
    const run: SideQuestionRun = {
      id: randomUUID(),
      threadId: entry.session.threadId,
      question,
      status: 'running',
      answer: undefined,
      error: undefined,
      finishedAt: undefined,
      abort,
    };
    this.sideQuestions.set(run.id, run);
    // 時間切れは表示だけの問題ではない。Codexはforkしたスレッドとエントリを、
    // Claude Codeは応答待ちを抱えたままになるため、`signal`で実装側にも知らせて
    // 後始末（中断・破棄）まで届かせる
    const timer = setTimeout(
      () => abort.abort(new Error('回答が返ってきませんでした（時間切れ）')),
      SIDE_QUESTION_TIMEOUT_MS,
    );
    void this.runSideQuestion(entry, question, abort.signal)
      .finally(() => {
        clearTimeout(timer);
      })
      .then(
        (answer) => {
          run.status = 'done';
          run.answer =
            answer.length > MAX_SIDE_QUESTION_ANSWER_CHARS
              ? answer.slice(0, MAX_SIDE_QUESTION_ANSWER_CHARS)
              : answer;
          run.finishedAt = Date.now();
        },
        (e: unknown) => {
          run.status = 'failed';
          run.error = e instanceof Error ? e.message : String(e);
          run.finishedAt = Date.now();
        },
      );
    return run;
  }

  /** その会話に回答待ちの質問が残っているか。連投を止めるのに使う。 */
  private hasRunningSideQuestion(threadId: string): boolean {
    for (const run of this.sideQuestions.values()) {
      if (run.status === 'running' && run.threadId === threadId) {
        return true;
      }
    }
    return false;
  }

  /**
   * 終わってから時間が経った質問と、溢れた古い質問を捨てる。
   *
   * 走っている質問（`finishedAt`が無い）は件数の溢れでも消さない。消すと、その質問の
   * 結果を取りに来た統括ページが「見つかりません」を受け取ったまま待ち続ける。
   */
  private sweepSideQuestions(): void {
    const now = Date.now();
    for (const [id, run] of this.sideQuestions) {
      if (run.finishedAt !== undefined && now - run.finishedAt > SIDE_QUESTION_TTL_MS) {
        this.sideQuestions.delete(id);
      }
    }
    // `Map`は挿入順に回るため、先頭が最も古い
    for (const [id, run] of this.sideQuestions) {
      if (this.sideQuestions.size <= MAX_SIDE_QUESTIONS) {
        break;
      }
      if (run.finishedAt !== undefined) {
        this.sideQuestions.delete(id);
      }
    }
  }

  /**
   * 脇道の質問を実際に投げて、回答本文を返す（Issue #1261）。
   *
   * Codexは`thread/fork`（ephemeral）、Claude Codeは`side_question`の制御要求と、
   * 経路がまるごと違うためサブクラスが持つ。どちらも本流の会話へ項目を積まないこと、
   * 失敗は`throw`で伝えること（画面へそのまま出る文言にする）を約束とする。
   *
   * `signal`は時間切れ（`SIDE_QUESTION_TIMEOUT_MS`）と管理クラスの破棄で発火する。
   * これを受けたら待つのをやめるだけでなく、確保した資源（Codexのforkスレッドと
   * エントリ）をそこで手放すところまで行う。放っておくと、応答を返さない相手ほど
   * 積み上がっていく。
   */
  protected abstract runSideQuestion(
    entry: TPanel,
    question: string,
    signal: AbortSignal,
  ): Promise<string>;

  /**
   * エディタの選択範囲（issue #292）を送る先。最後にアクティブだった画面を返す
   * （`this.active`。名前変更・クリアと同じ対象）。開いているタブが無ければ`undefined`。
   *
   * Codex/Claude Codeそれぞれの`activeSequence`を比べて、呼び出し側（`extension.ts`）が
   * どちらへ挿すかを決める。ここではプロバイダ内の判定だけを行い、実際の送り先の決定・
   * パスの組み立て・0件時の新規会話は行わない。
   */
  getActiveComposerTarget(): ActiveComposerTarget | undefined {
    const entry = this.active;
    if (entry === undefined || entry.panel === undefined) {
      return undefined;
    }
    return {
      activeSequence: this.activeSequence,
      insert: (text: string) => {
        if (entry.panel === undefined) {
          return;
        }
        void entry.panel.webview.postMessage({ type: 'insertComposerText', text });
        this.showPanel(entry, false);
      },
    };
  }

  /**
   * 承認要求を決定する。webviewの承認カード（`approve`メッセージ）とワークフローViewの
   * 「承認」操作（`TaskSession.decideApproval`）の両方から呼ばれる共通経路にしておくことで、
   * どちらの入口から決定しても `onApprovalResolved` のリスナーへ同じ通知が届く。
   */
  protected resolveApproval(
    entry: TPanel,
    requestId: number | string,
    decision: ApprovalDecision,
  ): void {
    entry.session.decide(requestId, decision);
    for (const listener of entry.approvalResolvedListeners) {
      listener({ requestId, decision });
    }
  }

  /**
   * 承認待ちの通知（issue #286、design.md §14.55）。
   *
   * `state.approvals`に新しく現れた要求ごとに1回だけ判定する。`entry.notifiedApprovalRequestIds`
   * へ積んだ要求は、設定で無効・タブが見えている等の理由で通知を出さなかった場合も含めて
   * 二度と判定し直さない（同じ要求で通知を重複させないため）。
   */
  protected notifyNewApprovals(entry: TPanel, state: ChatState): void {
    let firstNew: PendingApproval | undefined;
    for (const approval of state.approvals) {
      const key = String(approval.requestId);
      if (entry.notifiedApprovalRequestIds.has(key)) {
        continue;
      }
      entry.notifiedApprovalRequestIds.add(key);
      firstNew ??= approval;
      this.notifyApprovalPending(entry, approval);
    }
    // 音は1回だけ（issue #1242）。1ターンで複数の承認要求が同時に現れることがあり、
    // 要求ごとに鳴らすと連打になる。通知の可否（設定・可視性）とは独立に判定する
    if (firstNew !== undefined) {
      playNotificationSound('approvalPending', entry.panel?.visible === true);
    }
  }

  /**
   * 承認待ちの通知を実際に出す。
   *
   * 「見えているか」は`WebviewPanel.visible`で判定する（`active`＝フォーカスが
   * 当たっているかとは別物。分割表示やSide-by-Sideで前面に見えていればフォーカスが
   * 無くても通知を出す必要は無い、という判断）。判定は呼び出された瞬間の一度きりで、
   * 後から可視性が変わっても再評価しない（`notifyNewApprovals`のJSDoc参照）。
   */
  protected notifyApprovalPending(entry: TPanel, approval: PendingApproval): void {
    if (!readNotificationsConfig().approvalPending) {
      return;
    }
    if (entry.panel !== undefined && entry.panel.visible) {
      return;
    }
    const sessionLabel = sanitizeForNotification(entry.title);
    const approvalLabel = sanitizeForNotification(approval.title);
    void vscode.window
      .showInformationMessage(`${sessionLabel} が承認待ちです（${approvalLabel}）`, '開く')
      .then((choice) => {
        if (choice === '開く') {
          this.showPanel(entry, false);
        }
      });
  }

  /**
   * ターン完了の通知（issue #286、design.md §14.55、既定オフ）。
   *
   * 承認待ちの通知と違い`requestId`のような一意な識別子が無いが、呼び出し元
   * （各サブクラスの`onSessionChange`）が`busy`の立ち下がり（`true→false`）を検知した
   * 1回だけ呼ぶ作りにより、同じターンで重複して呼ばれることは無い。
   *
   * @param state ターンが確定した時点の会話の状態。音を鳴らすかの判定にだけ使う
   */
  protected notifyTurnComplete(entry: TPanel, state: ChatState): void {
    // 音は通知（`agent.notifications.turnComplete`、既定オフ）とは別の設定で判定する
    // （issue #1242）。通知を出さずに音だけ鳴らしたい場合があるため、先に鳴らす。
    // ただしバックグラウンド実行だけが残る状態（会話画面の外周が黄枠、issue #905）では
    // 鳴らさない（Issue #1313）。裏の作業はまだ続いており、区切りとして知らせる意味が
    // 薄いため。判定材料は黄枠・`deriveSessionActivityState`と同じ`backgroundTerminals`
    if (state.backgroundTerminals.length === 0) {
      playNotificationSound('turnComplete', entry.panel?.visible === true);
    }
    if (!readNotificationsConfig().turnComplete) {
      return;
    }
    if (entry.panel !== undefined && entry.panel.visible) {
      return;
    }
    const sessionLabel = sanitizeForNotification(entry.title);
    void vscode.window
      .showInformationMessage(`${sessionLabel} の応答が終わりました`, '開く')
      .then((choice) => {
        if (choice === '開く') {
          this.showPanel(entry, false);
        }
      });
  }

  /**
   * エントリを完全に破棄する。ループを止め、セッションを解放し（保留中の承認は拒否される）、
   * パネルが開いていれば閉じ、全ての管理表から取り除く。
   *
   * 二重に呼んでも安全（`disposed` で早期return）。タブを閉じたことによる破棄と、
   * 明示的な `dispose()` 呼び出しの両方から通る。
   *
   * `entry.disposed` を先に立ててから `session.dispose()` を呼ぶため、そこで解放される
   * 保留中の承認は `onSessionChange`（`entry.disposed` で早期return）に届かず、
   * `onDidChangeState` も出ない。承認待ちを数えている側（issue #734）が取り残されないよう、
   * 管理表から取り除いた後に `onDidChangePanels` を出す。
   */
  protected teardown(entry: TPanel): void {
    if (entry.disposed) {
      return;
    }
    entry.disposed = true;
    if (entry.postTimer !== undefined) {
      clearTimeout(entry.postTimer);
      entry.postTimer = undefined;
    }
    entry.loop.stop('manual');
    // 引き継ぎの確認待ちのままタブを閉じた分を中止する（Issue #1280）。放っておくと
    // 誰も答えない確認を`chooseHandoffModelSettings`が待ち続ける
    entry.pendingHandoff?.cancelForTeardown();
    entry.session.dispose();
    entry.panel?.dispose();
    entry.panel = undefined;
    if (this.active === entry) {
      this.active = undefined;
    }
    this.onTeardown(entry);
    for (const [id, value] of this.panels) {
      if (value === entry) {
        this.panels.delete(id);
      }
    }
    this.panelsChanged.fire();
  }

  /**
   * 引き継ぎ元として残ったことを記録し、Attention Indexへ反映させる（Issue #1165）。
   *
   * 人へ見せない理由（`disposed` / `userDismissed`）は印を付けない。
   * `onDidChangeState`は旧セッションが idle のまま残るときに出ないため、集合の変化と
   * 同じ経路（`onDidChangePanels`）で一覧を数え直させる。
   */
  protected markHandoffKept(entry: TPanel, reason: OldTabKeptReason): void {
    if (!needsAttentionAfterHandoff(reason)) {
      return;
    }
    entry.handoffKept = reason;
    entry.handoffKeptUserMessages = countUserMessages(entry.session.getState());
    this.panelsChanged.fire();
  }

  /**
   * `teardown`の拡張フック。管理表からの削除の直前に呼ぶ。既定は何もしない。
   * Codex側は`pendingStarts`（`thread/start`応答待ち登録）からの除去に使う。
   */
  protected onTeardown(_entry: TPanel): void {
    // 既定では何もしない
  }

  dispose(): void {
    // 走っている脇道の質問も打ち切る（Issue #1261）。待ち続けている実装側へ伝えないと、
    // forkしたスレッドや応答待ちが解けないまま残る
    for (const run of this.sideQuestions.values()) {
      run.abort.abort(new Error('拡張機能が終了しました'));
    }
    this.sideQuestions.clear();
    for (const entry of this.allPanels()) {
      this.teardown(entry);
    }
    this.panels.clear();
    this.stateChanged.dispose();
    this.panelsChanged.dispose();
    this.onDispose();
  }

  /**
   * `dispose()`の拡張フック。既定は何もしない。Codex側は全スレッドで共有する
   * `AppServerConnection`の解放に使う。
   */
  protected onDispose(): void {
    // 既定では何もしない
  }
}
