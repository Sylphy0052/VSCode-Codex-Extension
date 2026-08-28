import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ClaudeConfig } from './claude/types';
import type { CodexConfig } from './codex/types';
import { hasGitSegment } from './orchestrator/escalation';
import {
  normalizeFinalMergeConfig,
  normalizeForgeHostConfig,
  normalizePullRequestLayerConfig,
  type FinalMergeConfig,
  type ForgeHostConfig,
  type PullRequestLayerConfig,
} from './orchestrator/forge';
import { DEFAULT_REPLY_TIMEOUT_SEC } from './orchestrator/messaging';
import { DEFAULT_MERGE_APPROVAL_TIMEOUT_SEC } from './orchestrator/runnerMerge';
import { DEFAULT_TASK_APPROVAL_TIMEOUT_SEC } from './orchestrator/runnerApproval';
import { DEFAULT_FINAL_MERGE_DECISION_TIMEOUT_SEC } from './orchestrator/runner';
import { normalizeChatDensity, type ChatDensity } from './view/density';
import {
  DEFAULT_CI_WAIT_TIMEOUT_SEC,
  DEFAULT_CI_UPDATE_BRANCH_MAX_RETRIES,
  DEFAULT_REVIEW_COMMENT_POLL_INTERVAL_SEC,
} from './orchestrator/forge';
import {
  DEFAULT_STALL_REPEAT_COUNT,
  MIN_STALL_REPEAT_COUNT,
  MAX_STALL_REPEAT_COUNT,
} from './loop/stallDetector';
import {
  DEFAULT_MAX_ASK_USER_PER_RUN,
  MIN_MAX_ASK_USER_PER_RUN,
  MAX_MAX_ASK_USER_PER_RUN,
} from './orchestrator/orchestratorSession';
import {
  DEFAULT_AUTO_RESUME,
  DEFAULT_MAX_AUTO_RESUME_ATTEMPTS,
  MIN_MAX_AUTO_RESUME_ATTEMPTS,
  MAX_MAX_AUTO_RESUME_ATTEMPTS,
} from './orchestrator/runnerRestore';
import { DEFAULT_PSEUDO_WORKTREE_EXCLUDE } from './orchestrator/pseudoWorktree';
import { sanitizeForLog } from './orchestrator/sanitize';
import { normalizeBranchNaming, type BranchNaming } from './orchestrator/worktree';
import type { HistoryScope } from './session/sessionStore';
import { normalizeComposerButtons, type ComposerButtonsResult } from './view/composerButtons';
import {
  normalizeSecondOpinionCandidates,
  type SecondOpinionCandidate,
} from './secondOpinion/candidates';
import { DEFAULT_SECOND_OPINION_TEMPLATE } from './secondOpinion/prompt';
import { DEFAULT_SECOND_OPINION_TIMEOUT_MS } from './secondOpinion/run';
import { DEFAULT_TURN_SUMMARY_INSTRUCTION, type TurnSummaryConfig } from './view/turnSummary';
import { normalizeSendOn, type SendOnMode } from './view/sendKey';
import type { HistoryGroupBy } from './util/sessionGrouping';
import { parseSessionPresets, type SessionPreset } from './sessionPresets';

export interface ExtensionConfig {
  executablePath: string;
  codexHome: string;
  codex: CodexConfig;
  historyScope: HistoryScope;
  historyMaxEntries: number;
  historyGroupBy: HistoryGroupBy;
}

/** 日報/週報へ流す作業記録の設定。プロバイダを跨ぐため `agent.*` 名前空間に置く。 */
export interface ActivityLogConfig {
  enabled: boolean;
  /** 空なら `DAILY_BUFFER_DIR` → `~/workspace/dairy/.buffer`（activityLogger が解決）。 */
  dir: string;
}

const str = (c: vscode.WorkspaceConfiguration, key: string, fallback = ''): string => {
  const v = c.get<string>(key);
  return typeof v === 'string' ? v : fallback;
};

const num = (c: vscode.WorkspaceConfiguration, key: string, fallback: number): number => {
  const v = c.get<number>(key);
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
};

/**
 * 実行経路と権限に関わるキーは package.json 側で machine スコープに固定してある。
 * リポジトリの .vscode/settings.json から差し替えられないことが前提（設計書 §7・§8）。
 */
export function readConfig(): ExtensionConfig {
  const c = vscode.workspace.getConfiguration('codex');
  const additional = c.get<unknown>('additionalArgs');
  const writableRoots = c.get<unknown>('sandboxWritableRoots');

  return {
    executablePath: str(c, 'executablePath', 'codex'),
    codexHome: str(c, 'codexHome'),
    codex: {
      model: str(c, 'model'),
      reasoningEffort: str(c, 'reasoningEffort'),
      profile: str(c, 'profile'),
      sandbox: str(c, 'sandbox'),
      sandboxWritableRoots: Array.isArray(writableRoots)
        ? writableRoots.filter((r): r is string => typeof r === 'string')
        : [],
      sandboxNetworkAccess: c.get<boolean>('sandboxNetworkAccess') === true,
      approvalMode: str(c, 'approvalMode'),
      approvalsReviewer: str(c, 'approvalsReviewer'),
      bypassApprovalsAndSandbox: c.get<boolean>('bypassApprovalsAndSandbox') === true,
      additionalArgs: Array.isArray(additional)
        ? additional.filter((a): a is string => typeof a === 'string')
        : [],
    },
    historyScope: c.get<string>('history.scope') === 'all' ? 'all' : 'workspace',
    historyMaxEntries: num(c, 'history.maxEntries', 200),
    historyGroupBy: normalizeHistoryGroupBy(c.get<string>('history.groupBy')),
  };
}

/** `codex.history.groupBy` の生値を安全な値へ丸める。未知の値は既定の `date` に倒す。 */
function normalizeHistoryGroupBy(value: string | undefined): HistoryGroupBy {
  return value === 'folder' || value === 'none' ? value : 'date';
}

export interface ClaudeExtensionConfig {
  executablePath: string;
  configDir: string;
  claude: ClaudeConfig;
}

export function readClaudeConfig(): ClaudeExtensionConfig {
  const c = vscode.workspace.getConfiguration('claude');
  const additional = c.get<unknown>('additionalArgs');

  return {
    executablePath: str(c, 'executablePath', 'claude'),
    configDir: str(c, 'configDir'),
    claude: {
      model: str(c, 'model'),
      effort: str(c, 'effort'),
      permissionMode: str(c, 'permissionMode'),
      agent: str(c, 'agent'),
      additionalArgs: Array.isArray(additional)
        ? additional.filter((a): a is string => typeof a === 'string')
        : [],
    },
  };
}

export function readActivityLogConfig(): ActivityLogConfig {
  const c = vscode.workspace.getConfiguration('agent');
  return {
    enabled: c.get<boolean>('activityLog.enabled') ?? true,
    dir: str(c, 'activityLog.dir'),
  };
}

/**
 * チャット応答本文をMarkdownとして描画するか（issue #290）。既定は `true`。
 * `false` にすると `textContent` + `white-space: pre-wrap` の従来表示に戻る
 * （`chatScript.ts` の `RENDER_MARKDOWN` へそのまま渡る）。
 */
export function readChatRenderMarkdownConfig(): boolean {
  const c = vscode.workspace.getConfiguration('agent');
  return c.get<boolean>('chat.renderMarkdown') ?? true;
}

/**
 * 会話画面の表示密度（`agent.chat.density`、既定 `comfortable`、issue #718）。
 * `compact` にすると項目の間隔・本文の余白・行間が詰まる。丸めは
 * `normalizeChatDensity`（`vscode`に依存しない純粋関数）が行い、ここでは生値を
 * 渡すだけ。`renderMarkdown` / `sendOn`と同じ`agent.chat.*`名前空間・`window`
 * スコープ（見た目の好みであって権限には関わらないため）。
 */
export function readChatDensityConfig(): ChatDensity {
  const c = vscode.workspace.getConfiguration('agent');
  return normalizeChatDensity(c.get<unknown>('chat.density'));
}

/**
 * チャット入力欄の送信キー（`agent.chat.sendOn`、既定 `ctrlEnter`、issue #288）。
 * `enter` にするとEnterで送信・Shift+Enterで改行になる（`chatScript.ts` の
 * `decideSendKeyAction` / `SEND_ON` へそのまま渡る）。未知の値は `normalizeSendOn` が
 * 既定へ丸める。Codex（`chatView.ts`）・Claude Code（`claudeChatView.ts`）両画面の
 * `attachPanel`から呼ばれる（design.md §14.49）。
 */
export function readChatSendOnConfig(): SendOnMode {
  const c = vscode.workspace.getConfiguration('agent');
  return normalizeSendOn(c.get<string>('chat.sendOn'));
}

/**
 * 入力欄アイコン列（`#composerIconRow`）の表に直接出すボタン（`agent.chat.
 * composerButtons`、既定は変更前の並びの先頭4つ、issue #296）。それ以外は「…」
 * メニューへ畳む（`chatView.ts`の`renderShell`参照）。検証・既定への丸めは
 * `normalizeComposerButtons`（`vscode`に依存しない純粋関数）が行い、ここでは生値を
 * 渡すだけ。`renderMarkdown` / `sendOn`と同じ`agent.chat.*`名前空間・`window`スコープ
 * （`package.json`）。
 */
export function readChatComposerButtonsConfig(): ComposerButtonsResult {
  const c = vscode.workspace.getConfiguration('agent');
  return normalizeComposerButtons(c.get<unknown>('chat.composerButtons'));
}

/** セカンドオピニオン（Issue #894）の設定。 */
export interface SecondOpinionConfig {
  /** 依頼先の候補。必ず1件以上ある（壊れた設定は既定へ丸める）。 */
  candidates: SecondOpinionCandidate[];
  /** 候補の検証で捨てた項目の理由。呼び出し側がログへ出す。 */
  candidateWarnings: string[];
  /** タブを開かずに走らせるか。既定は `true`。 */
  headless: boolean;
  timeoutMs: number;
  /** 依頼文の既定値。 */
  template: string;
}

/**
 * セカンドオピニオン（Issue #894。`agent.secondOpinion.*`）。
 *
 * 候補の検証は `normalizeSecondOpinionCandidates`（`vscode`に依存しない純粋関数）が
 * 行い、ここでは生値を渡すだけ。`sandbox` / `approvalMode` は設定にしない（読み取り
 * 専用・承認は全拒否で固定する。`secondOpinion/run.ts`参照）。
 */
export function readSecondOpinionConfig(): SecondOpinionConfig {
  const c = vscode.workspace.getConfiguration('agent');
  const parsed = normalizeSecondOpinionCandidates(c.get<unknown>('secondOpinion.candidates'));
  const rawTemplate = str(c, 'secondOpinion.template', DEFAULT_SECOND_OPINION_TEMPLATE);
  return {
    candidates: parsed.candidates,
    candidateWarnings: parsed.warnings,
    headless: c.get<boolean>('secondOpinion.headless') ?? true,
    timeoutMs: normalizeSecondOpinionTimeoutMs(c.get<unknown>('secondOpinion.timeoutMs')),
    template: rawTemplate.trim() === '' ? DEFAULT_SECOND_OPINION_TEMPLATE : rawTemplate,
  };
}

/**
 * `agent.secondOpinion.timeoutMs` の検証。
 *
 * 数値でなければ既定へ戻し、極端な値は10秒〜60分へ収める。0や負値をそのまま渡すと
 * 起動直後に必ず打ち切られ、「動かない」としか見えない状態になるため。
 */
function normalizeSecondOpinionTimeoutMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_SECOND_OPINION_TIMEOUT_MS;
  }
  return Math.min(60 * 60_000, Math.max(10_000, Math.round(value)));
}

/**
 * 手動で送る発言の末尾へ付ける要約指示（`agent.chat.turnSummary.*`、issue #709）。
 * 既定は無効で、有効にするまで送信テキストは一字一句変わらない。連結の判断と実体は
 * `src/view/turnSummary.ts`（`vscode`をimportしないロジック層）が持ち、ここでは
 * 生値を渡すだけ。`renderMarkdown` / `sendOn`と同じ`agent.chat.*`名前空間・`window`
 * スコープにしてある（応答の書き方の好みであって権限には関わらないため）。
 */
export function readChatTurnSummaryConfig(): TurnSummaryConfig {
  const c = vscode.workspace.getConfiguration('agent');
  const instruction = c.get<string>('chat.turnSummary.instruction');
  return {
    enabled: c.get<boolean>('chat.turnSummary.enabled') ?? false,
    instruction: typeof instruction === 'string' ? instruction : DEFAULT_TURN_SUMMARY_INSTRUCTION,
  };
}

/** 手動送信時にターン要約の指示を付けるかを、ユーザー設定へ保存する。 */
export async function setChatTurnSummaryEnabled(enabled: boolean): Promise<void> {
  await vscode.workspace
    .getConfiguration('agent')
    .update('chat.turnSummary.enabled', enabled, vscode.ConfigurationTarget.Global);
}

/** ターンの完了・承認待ちの通知（issue #286、design.md §14.55）。 */
export interface NotificationsConfig {
  /** 承認待ちになった直後、タブが見えていなければ通知を出すか（既定 `true`）。 */
  approvalPending: boolean;
  /** ターンが完了した直後、タブが見えていなければ通知を出すか（既定 `false`）。 */
  turnComplete: boolean;
}

/**
 * `agent.notifications.*` を読む（issue #286）。
 *
 * 通知の出し方の好みであり権限には関わらないため、`agent.chat.renderMarkdown` /
 * `agent.chat.sendOn`と同じ`window`スコープにしてある（`.vscode/settings.json`から
 * リポジトリ側が強制することはできないが、User設定・Workspace設定としては変えられる。
 * `machine`系スコープが必要なのは実行経路・権限に関わる設定だけで、通知はそれに
 * 当たらない）。
 */
export function readNotificationsConfig(): NotificationsConfig {
  const c = vscode.workspace.getConfiguration('agent');
  return {
    approvalPending: c.get<boolean>('notifications.approvalPending') ?? true,
    turnComplete: c.get<boolean>('notifications.turnComplete') ?? false,
  };
}

export interface SessionPresetsConfig {
  presets: SessionPreset[];
  /** 検証で無視した項目の理由。呼び出し側（`extension.ts`）がログ・通知へ出す。 */
  warnings: string[];
}

/**
 * 名前付きセッションプリセット（`agent.sessionPresets`、issue #295、design.md §14.56）。
 *
 * `resource`スコープ（`.vscode/settings.json`から与えられる）のままにしてある。プリセット
 * 自体は権限を緩められない（`buildEffectivePresetConfig`が拡張機能側の現在の設定より
 * 緩い方向のapprovalMode/sandboxを無視する）ため、machineスコープに固定する必要が無い。
 *
 * 検証・クランプの実体は `src/sessionPresets.ts`（vscodeをimportしないロジック層）に
 * 切り出してあり、ここでは生値を渡すだけ。
 */
export function readSessionPresetsConfig(): SessionPresetsConfig {
  const c = vscode.workspace.getConfiguration('agent');
  const { presets, warnings } = parseSessionPresets(c.get<unknown>('sessionPresets'));
  return { presets, warnings };
}

/** ワークフロー実行（design.md §16）の設定。 */
export interface WorkflowsConfig {
  /** 定義ファイルの置き場。ワークスペースフォルダ配下の相対パス（既定 `.agents/workflows`）。 */
  dir: string;
  /**
   * `autoApprove: true` を有効化できるか（machineスコープ）。無効なら、YAMLの指定に
   * 関わらず全ての承認を人へ回す（design.md §16.16）。`clampAutoApprove` の基準値。
   */
  allowAutoApprove: boolean;
  /**
   * `claude.permissionMode` が `bypassPermissions` のとき、ワークフローのClaudeタスクも
   * その設定のまま実行するか（machineスコープ、既定 false）。有効にすると `can_use_tool` が
   * 一切発行されず、危険判定（§16.7）が全て無効になる。無効なら `acceptEdits` へ読み替える
   * （design.md §16.16、issue #271・#278）。
   */
  allowClaudeBypassPermissions: boolean;
  /**
   * ロードマップ（design.md §16.19）の出力先ディレクトリ。ワークスペースフォルダからの
   * 相対パス（既定 `docs/roadmap`）。`agent.workflows.dir` と同じく `machine-overridable`
   * （§16.16「成果の統合まわりの設定」）。出力先のパス自体であって実行するコマンドの選択には
   * 関わらないため、`agent.workflows.forge` / `finalMerge` ほど強い制限（`machine`固定）は要らない。
   */
  roadmapDir: string;
  /**
   * 疑似worktree（design.md §16.20）の複製から除外するディレクトリ名（`agent.workflows.
   * pseudoWorktreeExclude`。`machine-overridable`）。`package.json`の`contributes.
   * configuration`が定義を持ち、既定値は`pseudoWorktree.ts`の`DEFAULT_PSEUDO_WORKTREE_EXCLUDE`
   * とリテラルで一致させてある（値を変える場合は両方合わせて直すこと。同ファイルの
   * JSDoc参照）。
   */
  pseudoWorktreeExclude: readonly string[];
  /**
   * `pseudoWorktreeExclude` の検証で既定値へ丸めた理由（Issue #446）。丸めた事実を黙って
   * 落とさないための説明で、`readWorkflowsConfig` が警告通知も出す。呼び出し側が
   * ログへ流したい場合に使う（`readSessionPresetsConfig` の `warnings` と同じ役割）。
   * 問題が無ければ空配列。
   */
  pseudoWorktreeExcludeWarnings: readonly string[];
  /**
   * ホスト連携（design.md §16.18）で使うCLIの選択。`machine`スコープ（§16.16「成果の統合
   * まわりの設定」）。実行するコマンド（`gh` / `glab`）の選択にあたるため、`.vscode/settings.json`
   * からは変えられない。
   */
  forge: ForgeHostConfig;
  /**
   * 作るPR/MRの層（design.md §16.18）。`machine-overridable`。権限には関わらないため
   * `forge` / `finalMerge` ほど強い制限は要らない。
   */
  pullRequest: PullRequestLayerConfig;
  /**
   * 統合→mainのPR/MRを無人でマージするか（design.md §16.18・§16.26）。`machine`スコープ。
   * mainを書き換えるかどうかを決めるため、`.vscode/settings.json`からは変えられない。
   * 既定は`orchestrator`（統合PR/MR作成後、マージするかどうかをオーケストレーターへ問う）。
   */
  finalMerge: FinalMergeConfig;
  /**
   * タスク間メッセージング（design.md §16.21）の返信待ちの上限秒数
   * （`agent.workflows.replyTimeoutSec`、既定300秒、`machine-overridable`）。権限には
   * 関わらないため`forge`/`finalMerge`ほど強い制限は要らない。
   */
  replyTimeoutSec: number;
  /**
   * 衝突解決セッション（design.md §16.17「コンフリクト」）が承認待ちのまま止まってよい
   * 時間の上限秒数（`agent.workflows.mergeApprovalTimeoutSec`、既定3600秒、
   * `machine-overridable`、Issue #413 PR5）。権限には関わらないため`forge`/`finalMerge`
   * ほど強い制限は要らない。
   */
  mergeApprovalTimeoutSec: number;
  /**
   * 通常タスク（`live.tasks`）の承認待ち（`waitingApproval`）が止まってよい時間の
   * 上限秒数（`agent.workflows.taskApprovalTimeoutSec`、既定3600秒、
   * `machine-overridable`、Issue #579、design.md §16.39）。**`mergeApprovalTimeoutSec`
   * とは別のキー。** こちらは通常タスクが対象で、超えたら`failed`（理由:
   * `taskApprovalTimedOut`）にする（`mergeApprovalTimeoutSec`は衝突解決セッションが
   * 対象で`blocked`にする）。権限には関わらないため`forge`/`finalMerge`ほど強い
   * 制限は要らない。
   */
  taskApprovalTimeoutSec: number;
  /**
   * 最終マージ（`finalMerge: orchestrator`）で、統合PR/MR作成後にオーケストレーターが
   * `decide_final_merge`で応答するのを待つ時間の上限秒数（`agent.workflows.
   * finalMergeDecisionTimeoutSec`、既定900秒、`machine-overridable`、design.md §16.26）。
   * 超えたら応答が無かったものとして自動的に`hold`へ倒す（判断を待って無限に止まらない。
   * design.md §16.26の受入基準）。`finalMerge: confirm`（人の承認待ち）には効かない
   * （人はいつ確認するか分からないため、待ち時間の上限を切って自動`hold`にする理由が無い）。
   * 権限には関わらないため`forge`/`finalMerge`ほど強い制限は要らない。
   */
  finalMergeDecisionTimeoutSec: number;
  /**
   * CIチェックの完了を待つ時間の上限秒数（`agent.workflows.ciWaitTimeoutSec`、既定1800秒、
   * `machine-overridable`、design.md §16.36）。統合PR/MRをマージする前にCIの完了を待ち、
   * 超えたら赤（CI失敗）と同じ扱いでタスクを失敗として確定する。CIが1件も設定されていない
   * リポジトリでは待たずに即マージする（チェックが0件なのと赤なのを取り違えない）。
   */
  ciWaitTimeoutSec: number;
  /**
   * マージが「baseの最新でない」ことで拒否されたときの取り込み直し（`gh pr update-branch` /
   * `glab mr rebase`）の最大リトライ回数（`agent.workflows.ciUpdateBranchMaxRetries`、
   * 既定2、`machine-overridable`、design.md §16.36）。取り込み直すたびにCIの完了を
   * 待ち直してから再度マージを試みる。上限を超えたら失敗として確定する。
   */
  ciUpdateBranchMaxRetries: number;
  /**
   * 統合PR/MRのレビューコメントを取得する間隔（秒）（`agent.workflows.
   * reviewCommentPollIntervalSec`、既定600秒、`machine-overridable`、design.md §16.30、
   * roadmap W5、Issue #339）。統合PR/MRを作成できた実行だけが対象。0にすると取得しない
   * （既定は控えめに置き、APIを叩き続けない設計判断。Issue #339）。権限には関わらないため
   * `forge`/`finalMerge`ほど強い制限は要らない。
   */
  reviewCommentPollIntervalSec: number;
  /**
   * オーケストレーターが`ask_user`（design.md §16.33、Issue #583）を1つのrunで呼べる回数の
   * 上限（`agent.workflows.maxAskUserPerRun`、既定3、`machine-overridable`）。方針1
   * 「確認は最低限」を仕組みで担保する唯一の機械的な手段。上限に達した以降の`ask_user`は
   * 拒否される（`OrchestratorControlPort.askUser`）。権限には関わらないため
   * `forge`/`finalMerge`ほど強い制限は要らない。
   */
  maxAskUserPerRun: number;
  /**
   * リロード・WSL再起動等からの復元後、条件を満たせば自動的に再開するか
   * （`agent.workflows.autoResume`、既定`true`、`machine-overridable`、design.md §16.35、
   * roadmap W10、Issue #584）。`false`にすると従来どおり人がViewから手動で再実行するまで
   * 再開しない。権限には関わらず、既に人が承認済み・実行中だった作業を続けるだけの
   * 挙動のため`forge`/`finalMerge`ほど強い制限は要らない。
   */
  autoResume: boolean;
  /**
   * 自動再開を試みる回数の上限（`agent.workflows.maxAutoResumeAttempts`、既定3、
   * `machine-overridable`、design.md §16.35、roadmap W10、Issue #584）。同じrunが
   * クラッシュと自動再開を繰り返し続けるのを止めるための値で、`maxAskUserPerRun`と
   * 同じく権限には関わらない調整値のため強い制限は要らない。
   */
  maxAutoResumeAttempts: number;
  /**
   * タスクブランチの命名方式（design.md §16.6「ブランチの命名方式」）。`machine-overridable`。
   * ブランチ名の形を決めるだけで、push先も権限も変えないため`forge`/`finalMerge`ほど
   * 強い制限は要らない。
   */
  branchNaming: BranchNaming;
  /**
   * ループの停滞判定（design.md §16.27、Issue #336）で「同じ応答が連続したら停滞とみなす」
   * しきい値（`agent.workflows.stallRepeatCount`、既定4、`machine-overridable`）。
   * 権限には関わらず、大きくするほど検知が遅く（誤検知しにくく）なるだけの調整値のため
   * `forge`/`finalMerge`ほど強い制限は要らない。`loop/loopController.ts`はvscodeに
   * 依存しないため、この値は`LoopController`を組み立てる`view/chatView.ts` /
   * `view/claudeChatView.ts`側で読み、コンストラクタへ渡す。
   */
  stallRepeatCount: number;
  /**
   * PR/MRをDraftとして作り、統合ブランチへのマージが済んでからreadyへ切り替えるか
   * （design.md §16.18「Draftとして作る」）。`machine-overridable`。有効にするほうが
   * 「人の確認を挟む」側へ倒れるため、`forge`/`finalMerge`ほど強い制限は要らない。
   */
  draftPullRequest: boolean;
  /**
   * タスクの開始時にIssueを起票し、PR本文から参照するか（`agent.workflows.createTaskIssue`、
   * design.md §16.31、roadmap W6、Issue #596）。既定`false`（既存の`per-task`の挙動を
   * 変えないため）。`pullRequest`が`per-task`のときだけ効く（`none`/`integration`では
   * タスクのPR/MR自体を作らないため起票もしない）。`machine-overridable`。起票に使う
   * コマンド（`gh`/`glab`）自体の選択は`forge`（machine固定）が既に縛っているため、
   * この設定自体はmachine固定にしなくてよい。
   */
  createTaskIssue: boolean;
  /**
   * タスクのPR/MRを作った後、ローカルマージの前に読み取り専用の別セッションでレビューさせ
   * るか（`agent.workflows.reviewTaskPullRequest`、design.md §16.31、roadmap W6、
   * Issue #596）。既定`false`。forgeの「人のレビューを待つ」方式ではなく、
   * `reviewWorkflowPlan`（design.md §16.28）と同じ「別のエージェントセッションを立てて
   * 読み取り専用でレビューさせる」方式を採る。結果は警告として記録するだけでマージは
   * ブロックしない。`createTaskIssue`と同じく`pullRequest`が`per-task`のときだけ効く。
   * `machine-overridable`。
   */
  reviewTaskPullRequest: boolean;
}

const DEFAULT_WORKFLOWS_DIR = '.agents/workflows';
const DEFAULT_ROADMAP_DIR = 'docs/roadmap';

/**
 * `agent.workflows.dir` の値として安全か。絶対パス、または `..` セグメントを含む値は拒否する。
 *
 * このキーは `resource` スコープ（`.vscode/settings.json` から上書きできる）のままにしてある。
 * マルチルートで「ワークスペースフォルダごとに置き場を変えたい」需要が自然にあり、
 * `machine` へ固定するとその用途を潰すため。ただし `resource` スコープはリポジトリ側の
 * 設定ファイルから差し替えられる以上、`..` を含む値でワークスペースフォルダの外を
 * 探索対象に混ぜられる余地は塞ぐ（レビュー指摘: warning）。
 */
function isSafeRelativeDir(value: string): boolean {
  if (value.trim() === '') {
    return false;
  }
  if (path.isAbsolute(value)) {
    return false;
  }
  return !value.split(/[\\/]/u).includes('..');
}

/** 設定キーの表示名。警告文へそのまま埋める。 */
const PSEUDO_WORKTREE_EXCLUDE_KEY = 'agent.workflows.pseudoWorktreeExclude';

/**
 * `pseudoWorktreeExclude` の要素として受け付けられない値なら、その理由を返す（Issue #446）。
 *
 * `isExcludedPath`（`pseudoWorktree.ts`）は「相対パスのどこかのセグメントが `exclude` の
 * いずれかと一致すれば除外」で判定する。つまりここへ入れた名前は、複製・一覧・スナップショット
 * （`cloneWorkspace` / `listFiles` / `takeSnapshot`）の全経路で「無かったこと」になる。
 * このキーは `machine-overridable` でワークスペースの `.vscode/settings.json` から
 * 上書きできるため、値の中身を検証しないと走査の対象範囲をリポジトリ側の設定から
 * 静かに変えられる。
 *
 * 拒否するのは2種類。
 *
 * 1. `.git` をセグメントとして含む値。gitの実体を走査から外させないため。判定は
 *    `escalation.ts` の `hasGitSegment` を共有し（`.GIT` 等の亜種も同じ扱い）、
 *    `.git` 判定のロジックをここへ複製しない。
 * 2. パス区切りを含む値・絶対パス。`isExcludedPath` はセグメント単位の完全一致なので、
 *    区切りを含む値はそもそもどのセグメントとも一致しえない（＝設定として無意味）。
 *    黙って効かないままにせず拒否して知らせる。
 * 3. `..`・`.` 自体。`isSafeRelativeDir` が `..` セグメントを明示的に拒否しているのと
 *    非対称にしないための姉妹ガード（`listFiles` が返すセグメントに現状 `..` / `.` は
 *    現れないため実害は無いが、バリデーションとしての体裁は揃えておく）。
 */
function pseudoWorktreeExcludeRejection(entry: string): string | undefined {
  if (hasGitSegment(entry)) {
    return '`.git` を指す値は走査の対象範囲を変えるため';
  }
  if (path.isAbsolute(entry) || /[\\/]/u.test(entry)) {
    return 'パス区切り・絶対パスを含む値はセグメント名と一致しえず設定として効かないため';
  }
  if (entry === '..' || entry === '.') {
    return '`..`・`.` はディレクトリ名として意味を持たないため';
  }
  return undefined;
}

interface PseudoWorktreeExcludeResult {
  exclude: readonly string[];
  /** 既定値へ丸めた理由（丸めていなければ空配列）。 */
  warnings: readonly string[];
}

/**
 * `agent.workflows.pseudoWorktreeExclude` の生値を安全な配列へ丸める。文字列の配列でない、
 * 空文字を含む要素がある、または `pseudoWorktreeExcludeRejection` が拒否する要素を1つでも
 * 含むなら、既定値（`DEFAULT_PSEUDO_WORKTREE_EXCLUDE`）へ丸ごと戻す
 * （`isSafeRelativeDir`と同じ「壊れた設定値は既定へ丸める」方針。一部の要素だけ落とすと
 * 「半分だけ効いている」中途半端な状態になり、利用者が気づきにくいため）。
 *
 * 丸めたときは理由を `warnings` へ入れて返す。黙って落とすと設定が無視されたことに
 * 気づけない（Issue #380 の「黙って0件成功にすると気づけない」と同じ教訓）。
 */
function normalizePseudoWorktreeExclude(value: unknown): PseudoWorktreeExcludeResult {
  const fallback = (warnings: readonly string[] = []): PseudoWorktreeExcludeResult => ({
    exclude: DEFAULT_PSEUDO_WORKTREE_EXCLUDE,
    warnings,
  });
  // 未設定（`package.json` の既定が引かれない経路。テストの設定モックなど）は
  // 「壊れた設定」ではないため警告を出さずに既定値を使う
  if (value === undefined || value === null) {
    return fallback();
  }
  if (!Array.isArray(value)) {
    return fallback([
      `${PSEUDO_WORKTREE_EXCLUDE_KEY} が文字列の配列でないため既定値へ戻しました。`,
    ]);
  }
  // 空判定だけでなく格納する値もトリムする。トリムせず生の値を残すと、前後に空白が
  // 付いた値（例 " .git "）が `hasGitSegment` の完全一致にも区切り文字判定にも掛からず
  // 素通りしてしまう（レビュー指摘: low）。
  const entries = value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter((v) => v !== '');
  if (entries.length !== value.length || entries.length === 0) {
    return fallback([
      `${PSEUDO_WORKTREE_EXCLUDE_KEY} に文字列でない要素・空文字が含まれる、または空配列のため既定値へ戻しました。`,
    ]);
  }
  const warnings = entries.flatMap((entry) => {
    const reason = pseudoWorktreeExcludeRejection(entry);
    return reason === undefined
      ? []
      : [
          `${PSEUDO_WORKTREE_EXCLUDE_KEY} の値 "${sanitizeForLog(entry)}" は使えないため、設定全体を既定値へ戻しました（${reason}）。`,
        ];
  });
  return warnings.length > 0 ? fallback(warnings) : { exclude: entries, warnings: [] };
}

/**
 * 直前に通知した `pseudoWorktreeExclude` の警告文。`readWorkflowsConfig` は設定を読むたびに
 * 呼ばれるため、同じ内容の通知を繰り返さないための重複除け。設定を直せば `undefined` へ戻り、
 * 再び壊れた値を入れれば改めて通知される。
 */
let lastPseudoWorktreeExcludeWarning: string | undefined;

/**
 * テスト専用: `lastPseudoWorktreeExcludeWarning` をリセットする。
 *
 * モジュールスコープの状態のためテストから直接書き換えられず、リセットしないと
 * 「同じ不正値を検証するテストが2つあると、後勝ちの1つは重複除けで警告0件になる」
 * という実行順依存が生まれる（レビュー指摘: medium）。`test/unit/config.test.ts` の
 * `beforeEach` から呼ぶ。本体コードから呼んではならない。
 */
export function __resetPseudoWorktreeExcludeWarningForTestOnly(): void {
  lastPseudoWorktreeExcludeWarning = undefined;
}

/** 検証で弾いた設定を人へ見せる（通知＝設定を書いた本人が気づける唯一の場所）。 */
function notifyPseudoWorktreeExcludeWarnings(warnings: readonly string[]): void {
  const message = warnings.join(' / ');
  if (message === '') {
    lastPseudoWorktreeExcludeWarning = undefined;
    return;
  }
  if (message === lastPseudoWorktreeExcludeWarning) {
    return;
  }
  lastPseudoWorktreeExcludeWarning = message;
  void vscode.window.showWarningMessage(message);
}

export function readWorkflowsConfig(): WorkflowsConfig {
  const c = vscode.workspace.getConfiguration('agent');
  const rawDir = str(c, 'workflows.dir', DEFAULT_WORKFLOWS_DIR);
  const rawRoadmapDir = str(c, 'workflows.roadmapDir', DEFAULT_ROADMAP_DIR);
  const pseudoWorktreeExclude = normalizePseudoWorktreeExclude(
    c.get<unknown>('workflows.pseudoWorktreeExclude'),
  );
  notifyPseudoWorktreeExcludeWarnings(pseudoWorktreeExclude.warnings);
  return {
    dir: isSafeRelativeDir(rawDir) ? rawDir : DEFAULT_WORKFLOWS_DIR,
    allowAutoApprove: c.get<boolean>('workflows.allowAutoApprove') ?? false,
    allowClaudeBypassPermissions: c.get<boolean>('workflows.allowClaudeBypassPermissions') ?? false,
    roadmapDir: isSafeRelativeDir(rawRoadmapDir) ? rawRoadmapDir : DEFAULT_ROADMAP_DIR,
    pseudoWorktreeExclude: pseudoWorktreeExclude.exclude,
    pseudoWorktreeExcludeWarnings: pseudoWorktreeExclude.warnings,
    forge: normalizeForgeHostConfig(str(c, 'workflows.forge', 'auto')),
    pullRequest: normalizePullRequestLayerConfig(str(c, 'workflows.pullRequest', 'per-task')),
    finalMerge: normalizeFinalMergeConfig(str(c, 'workflows.finalMerge', 'orchestrator')),
    replyTimeoutSec: normalizeReplyTimeoutSec(c.get<unknown>('workflows.replyTimeoutSec')),
    mergeApprovalTimeoutSec: normalizeMergeApprovalTimeoutSec(
      c.get<unknown>('workflows.mergeApprovalTimeoutSec'),
    ),
    taskApprovalTimeoutSec: normalizeTaskApprovalTimeoutSec(
      c.get<unknown>('workflows.taskApprovalTimeoutSec'),
    ),
    finalMergeDecisionTimeoutSec: normalizeFinalMergeDecisionTimeoutSec(
      c.get<unknown>('workflows.finalMergeDecisionTimeoutSec'),
    ),
    branchNaming: normalizeBranchNaming(str(c, 'workflows.branchNaming', 'wf')),
    draftPullRequest: c.get<boolean>('workflows.draftPullRequest') ?? false,
    createTaskIssue: c.get<boolean>('workflows.createTaskIssue') ?? false,
    reviewTaskPullRequest: c.get<boolean>('workflows.reviewTaskPullRequest') ?? false,
    stallRepeatCount: normalizeStallRepeatCount(c.get<unknown>('workflows.stallRepeatCount')),
    ciWaitTimeoutSec: normalizeCiWaitTimeoutSec(c.get<unknown>('workflows.ciWaitTimeoutSec')),
    ciUpdateBranchMaxRetries: normalizeCiUpdateBranchMaxRetries(
      c.get<unknown>('workflows.ciUpdateBranchMaxRetries'),
    ),
    reviewCommentPollIntervalSec: normalizeReviewCommentPollIntervalSec(
      c.get<unknown>('workflows.reviewCommentPollIntervalSec'),
    ),
    maxAskUserPerRun: normalizeMaxAskUserPerRun(c.get<unknown>('workflows.maxAskUserPerRun')),
    autoResume: c.get<boolean>('workflows.autoResume') ?? DEFAULT_AUTO_RESUME,
    maxAutoResumeAttempts: normalizeMaxAutoResumeAttempts(
      c.get<unknown>('workflows.maxAutoResumeAttempts'),
    ),
  };
}

/**
 * 秒単位のタイムアウト設定として許容する最大値。Node.jsの`setTimeout`は遅延が
 * 32bit符号付き整数の上限（2147483647ms、約24.8日）を超えると1msへ丸めて
 * 即座に発火する仕様のため、ms換算で32bit上限に収まる`2147483`秒
 * （約24.8日）を上限とする。これを超える値を許すと「実質無効化したい」意図で
 * 大きな値を設定した利用者が、承認待ち・返信待ちに入った直後に即時停止される
 * という正反対の挙動になる（`package.json`の`maximum`と揃える）。
 */
const MAX_TIMEOUT_SEC = 2147483;

/**
 * `agent.workflows.replyTimeoutSec` の生値を安全な秒数へ丸める。`package.json`の
 * `minimum: 1` / `maximum: 2147483` を実行時にも守る（設定ファイルを直接書き換えた
 * 場合など、VSCode側のバリデーションを経由しない値が渡りうるため）。数値でない、
 * 1未満、または`MAX_TIMEOUT_SEC`を超える値は既定値（`DEFAULT_REPLY_TIMEOUT_SEC`）へ
 * 丸める（`isSafeRelativeDir`と同じ「壊れた設定値は既定へ丸める」方針。上限超過も
 * 下限割れと同じ「範囲外は既定へ」で揃え、`MAX_TIMEOUT_SEC`へのクランプはしない。
 * クランプすると`setTimeout`の丸め挙動を知らない利用者には「指定値のまま動いている」
 * ように見えてしまうため）。
 */
function normalizeReplyTimeoutSec(value: unknown): number {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 1 &&
    value <= MAX_TIMEOUT_SEC
    ? Math.floor(value)
    : DEFAULT_REPLY_TIMEOUT_SEC;
}

/**
 * `agent.workflows.mergeApprovalTimeoutSec` の生値を安全な秒数へ丸める
 * （`normalizeReplyTimeoutSec` と同じ方針。Issue #413 PR5・PR6）。
 */
function normalizeMergeApprovalTimeoutSec(value: unknown): number {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 1 &&
    value <= MAX_TIMEOUT_SEC
    ? Math.floor(value)
    : DEFAULT_MERGE_APPROVAL_TIMEOUT_SEC;
}

/**
 * `agent.workflows.taskApprovalTimeoutSec` の生値を安全な秒数へ丸める
 * （`normalizeMergeApprovalTimeoutSec` と同じ方針。Issue #579、design.md §16.39）。
 */
function normalizeTaskApprovalTimeoutSec(value: unknown): number {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 1 &&
    value <= MAX_TIMEOUT_SEC
    ? Math.floor(value)
    : DEFAULT_TASK_APPROVAL_TIMEOUT_SEC;
}

/**
 * `agent.workflows.finalMergeDecisionTimeoutSec` の生値を安全な秒数へ丸める
 * （`normalizeMergeApprovalTimeoutSec` と同じ方針。design.md §16.26）。
 */
function normalizeFinalMergeDecisionTimeoutSec(value: unknown): number {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 1 &&
    value <= MAX_TIMEOUT_SEC
    ? Math.floor(value)
    : DEFAULT_FINAL_MERGE_DECISION_TIMEOUT_SEC;
}

/**
 * `agent.workflows.ciWaitTimeoutSec` の生値を安全な秒数へ丸める
 * （`normalizeFinalMergeDecisionTimeoutSec` と同じ方針。design.md §16.36）。
 */
function normalizeCiWaitTimeoutSec(value: unknown): number {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 1 &&
    value <= MAX_TIMEOUT_SEC
    ? Math.floor(value)
    : DEFAULT_CI_WAIT_TIMEOUT_SEC;
}

/**
 * `agent.workflows.ciUpdateBranchMaxRetries` の生値を安全な回数へ丸める。0以上の整数のみ
 * 受け付ける（0は「取り込み直しをしない＝初回のマージ失敗を即座に失敗として確定する」の意で
 * 有効な値。既定値へ丸めるのは非数値・負値・非整数のときだけ）。上限は`PUSH_BRANCH_MAX_ATTEMPTS`
 * のような小さな回数を想定する処理系のため、際限なく大きい値でリトライが無限に近くなるのを
 * 防ぐ目安として100を上限にする。
 */
function normalizeCiUpdateBranchMaxRetries(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100
    ? value
    : DEFAULT_CI_UPDATE_BRANCH_MAX_RETRIES;
}

/**
 * `agent.workflows.reviewCommentPollIntervalSec` の生値を安全な秒数へ丸める（design.md
 * §16.30、Issue #339）。`normalizeCiUpdateBranchMaxRetries`と同じく0を有効な値として許す
 * （0は「取得しない」の意）。`normalizeCiWaitTimeoutSec`等と異なり下限を1にしないのは、
 * 0が「無効化」という積極的な意味を持つ値のため（`ciUpdateBranchMaxRetries`と同じ理由）。
 * 非数値・非整数・負値・`MAX_TIMEOUT_SEC`超過はいずれも既定値
 * （`DEFAULT_REVIEW_COMMENT_POLL_INTERVAL_SEC`）へ丸める。
 */
function normalizeReviewCommentPollIntervalSec(value: unknown): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_TIMEOUT_SEC
    ? value
    : DEFAULT_REVIEW_COMMENT_POLL_INTERVAL_SEC;
}

/**
 * `agent.workflows.stallRepeatCount` の生値を安全なしきい値へ丸める（design.md §16.27）。
 * 整数でない・`MIN_STALL_REPEAT_COUNT`未満・`MAX_STALL_REPEAT_COUNT`超過はいずれも
 * 既定値（`DEFAULT_STALL_REPEAT_COUNT`）へ丸める（`normalizeCiUpdateBranchMaxRetries`と
 * 同じ「範囲外は既定へ」方針）。
 */
function normalizeStallRepeatCount(value: unknown): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_STALL_REPEAT_COUNT &&
    value <= MAX_STALL_REPEAT_COUNT
    ? value
    : DEFAULT_STALL_REPEAT_COUNT;
}

/**
 * `agent.workflows.maxAskUserPerRun` の生値を安全な回数へ丸める（design.md §16.33、
 * Issue #583）。`normalizeStallRepeatCount` と同じ「範囲外は既定へ」方針。整数でない・
 * `MIN_MAX_ASK_USER_PER_RUN`未満・`MAX_MAX_ASK_USER_PER_RUN`超過はいずれも既定値
 * （`DEFAULT_MAX_ASK_USER_PER_RUN`）へ丸める。
 */
function normalizeMaxAskUserPerRun(value: unknown): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_MAX_ASK_USER_PER_RUN &&
    value <= MAX_MAX_ASK_USER_PER_RUN
    ? value
    : DEFAULT_MAX_ASK_USER_PER_RUN;
}

/**
 * `agent.workflows.maxAutoResumeAttempts` の生値を安全な回数へ丸める（design.md §16.35、
 * roadmap W10、Issue #584）。`normalizeMaxAskUserPerRun`と同じ「範囲外は既定へ」方針。
 * 整数でない・`MIN_MAX_AUTO_RESUME_ATTEMPTS`未満・`MAX_MAX_AUTO_RESUME_ATTEMPTS`超過は
 * いずれも既定値（`DEFAULT_MAX_AUTO_RESUME_ATTEMPTS`）へ丸める。
 */
function normalizeMaxAutoResumeAttempts(value: unknown): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_MAX_AUTO_RESUME_ATTEMPTS &&
    value <= MAX_MAX_AUTO_RESUME_ATTEMPTS
    ? value
    : DEFAULT_MAX_AUTO_RESUME_ATTEMPTS;
}

/** アクティブエディタが属するワークスペースフォルダ。無ければ先頭（設計書 §10）。 */
export function currentWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active !== undefined) {
    const owner = vscode.workspace.getWorkspaceFolder(active);
    if (owner !== undefined) {
      return owner;
    }
  }
  return vscode.workspace.workspaceFolders?.[0];
}

export function workspaceFolderPaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}
