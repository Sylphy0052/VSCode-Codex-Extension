import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ApprovalDecision } from '../appserver/approvals';
import {
  addApproval,
  appendNotice,
  appendSecondOpinion,
  appendSideQuestion,
  enqueue,
  NO_BACKGROUND_TERMINALS,
  popLastQueued,
  removeApproval,
  removeQueued,
  restoreQueued,
  takeQueuedAt,
  type ChatState,
  type PendingApproval,
  type QueuedMessage,
} from '../appserver/chatState';
import type { LaunchTarget } from '../codex/types';
import type { Logger } from '../log';
import type { ApprovalHandlerResult } from '../orchestrator/taskSession';
import { killWithEscalation, MAX_LINE_BUFFER_BYTES } from '../process/childProcess';
import { guardStdinErrors, safeWriteStdin } from '../process/stdinSafety';
import { consumeNdjson } from '../util/ndjson';
import { buildAskUserQuestionDenyResponse, buildAskUserQuestionResponse } from './askUserQuestion';
import type { AskUserQuestionSelections } from './askUserQuestion';
import { buildClaudeStreamArgs } from './argvBuilder';
import {
  buildCanUseToolResponse,
  defaultDenyControlResponse,
  buildContextUsageRequest,
  buildControlRequest,
  buildControlResponse,
  buildMcpStatusRequest,
  buildReloadSkillsRequest,
  buildRenameSessionRequest,
  buildRewindConversationRequest,
  buildRewindFilesRequest,
  buildSessionCostRequest,
  buildSetEffortRequest,
  buildSetModelRequest,
  buildSetPermissionModeRequest,
  buildSideQuestionRequest,
  buildStopTaskRequest,
  buildUserMessage,
  describeCanUseTool,
  readCommandList,
  readFastModeState,
  readCommandsChanged,
  readContextUsage,
  readCurrentPermissionMode,
  readControlRequest,
  readControlRequestProgress,
  readControlResponse,
  readExtraUsage,
  readMcpServersList,
  readRewindConversationResult,
  readRewindFilesResult,
  readSessionCost,
  readSideQuestionResult,
  type ControlResponse,
  type ControlRequestProgress,
  type IncomingControlRequest,
  type RewindConversationResult,
  type RewindFilesResult,
  type SideQuestionHistoryEntry,
  type SideQuestionResult,
} from './control';
import { forkFromTurn, type ForkFromTurnResult } from './forkFromTurn';
import type { Attachment } from '../provider/attachments';
import type { McpServerView } from '../provider/mcpServers';
import type { SkillsSnapshot } from '../provider/skills';
import type { SlashCommand } from '../provider/slashCommands';
import { buildSkillsSnapshot } from './skillsList';
import { applyStreamEvent, initialClaudeState } from './streamJson';
import type { ClaudeConfig } from './types';

interface WaitingApproval {
  approval: PendingApproval;
  input: Record<string, unknown>;
}

export interface ClaudeStreamOptions {
  cwd: string;
  target: LaunchTarget;
  /** 新規セッションのid。呼び出し側で採番して渡す。 */
  sessionId: string | undefined;
  config: ClaudeConfig;
  /** 過去の会話。resume時にtranscriptから読んだものを初期表示に使う。 */
  initialItems?: ChatState['items'];
  /** 過去の会話に含まれていた最後のTODO一覧。resume時にtranscriptから読んだものを使う。 */
  initialTodos?: ChatState['todos'];
  /**
   * 過去の会話に含まれていたTODOの書き換え履歴（issue #721）。resume時にtranscriptから
   * 読んだものを使う。進捗画面のタイムラインだけが読む。
   */
  initialTodoHistory?: ChatState['todoHistory'];
  /**
   * 人が付けた会話名（issue #199）。`ClaudeSessionStore.getName()` を呼び出し側
   * （`claudeChatView.ts`）が読み、既に付いていれば開いた時点からタブ名に反映する。
   */
  initialName?: string | undefined;
}

/**
 * `claude` プロセスの起動（統合テストの差し替え口。Issue #186）。
 *
 * stream-json の組み立てとcontrol protocolの往復は `ClaudeStreamSession` 自身の責務なので、
 * 差し替えるのは**プロセスを起こす一点だけ**にする。フェイクは `stdin` へ書かれた内容を
 * そのまま観測でき、`stdout` から応答を流し込める。
 */
export type ClaudeSpawnPort = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams;

/**
 * `claude --print --input-format stream-json` を1会話につき1つ常駐させる。
 *
 * Codexのapp-serverと違い1プロセス1セッションなので、画面ごとにプロセスを持つ。
 * プロセスは使い回し、発言のたびに起動し直さない（文脈が切れるため）。
 */
export class ClaudeStreamSession {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private buffer = '';
  private state: ChatState = initialClaudeState;
  private nextControlId = 1;
  private readonly waiting = new Map<string, WaitingApproval>();
  /** こちらから出した要求の用途。応答は種類ごとに形が違うため、idで引く。 */
  private readonly outgoing = new Map<string, Outgoing>();
  /** 承認要求が一度でも届いたか。届かない構成を利用者へ知らせるために見る。 */
  private sawApprovalRequest = false;
  private handshakeDone = false;
  /** CLIが持っている使えるコマンド。取れるまでは空。 */
  private commandList: SlashCommand[] = [];
  /** `rewind_files` の応答待ち。requestIdごとに解決関数を覚える（design.md「Claude Codeの巻き戻し」）。 */
  private readonly rewindWaiting = new Map<string, (result: RewindFilesResult) => void>();
  /**
   * `rewind_conversation` の応答待ち（issue #333、design.md §14.61）。
   * `rewindWaiting` と同じ形（requestIdごとに解決関数を覚える）。
   */
  private readonly rewindConversationWaiting = new Map<
    string,
    (result: RewindConversationResult) => void
  >();
  /**
   * `side_question` の応答待ち（issue #334、design.md §14.62）。
   * `rewindConversationWaiting` と同じ形に、進捗通知（`control_request_progress`。
   * `api_retry`時にユーザーへ「なぜ待たされているか」を伝えるために使う）を都度渡す
   * `onProgress` を添える。
   */
  private readonly sideQuestionWaiting = new Map<
    string,
    {
      resolve: (result: SideQuestionResult) => void;
      onProgress: (progress: ControlRequestProgress) => void;
    }
  >();
  /**
   * このセッションが `--fork-session` で開いたものか（issue #333、design.md §14.61）。
   *
   * `rewind_conversation` はforkしていないセッション（`-r` のみのresume）へ送ると
   * 元セッションのtranscriptを壊す（`control.ts` の `buildRewindConversationRequest`
   * 参照）。`start()` の `target.kind` で確定し、以後このプロセスが生きている間ずっと
   * 変わらない。
   */
  private isForkSession = false;
  /**
   * `mcp_status` の応答待ち（design.md §16.21「ツールの可視性の確認」）。
   * `rewindWaiting` と同じ形（requestIdごとに解決関数を覚える）。
   */
  private readonly mcpStatusWaiting = new Map<
    string,
    (servers: McpServerView[] | undefined) => void
  >();
  /**
   * `reload_skills` の応答待ち（issue #202、design.md TP-90）。
   * `mcpStatusWaiting` と同じ形。プロセスが無ければ`undefined`で即解決する
   * （`checkMcpStatus`と同じ「見えない」側への倒し方）。
   */
  private readonly skillsWaiting = new Map<
    string,
    (snapshot: SkillsSnapshot | undefined) => void
  >();

  constructor(
    private readonly claudePath: () => string,
    private readonly log: Logger,
    private readonly onChange: (state: ChatState) => void,
    /** 承認要求を扱えないと判った時に一度だけ呼ぶ。 */
    private readonly onApprovalUnavailable: () => void = () => undefined,
    /** 使えるコマンドが判った時と、途中で増減した時に呼ぶ。 */
    private readonly onCommands: (commands: readonly SlashCommand[]) => void = () => undefined,
    /**
     * 承認要求を、承認カードを出す前に自動判定へ回す（design.md §16.10の6）。
     *
     * 既定は常に `ask`（従来通り必ず承認カードを出す）。タスク管理下のセッションだけ
     * `ClaudeChatViewManager` が実際の判定へ差し替える。判定そのもの
     * （`classifyApprovalRequest`）を呼ぶのは runner.ts の責務で、ここは口を通すだけ。
     *
     * 第2引数は `can_use_tool` 要求の生payload（`tool_name` / `input` を含む）。
     * `PendingApproval`（表示用に文字列結合済み）だけでは判定に使う `command` /
     * 変更対象パスを取り出せないため渡す（design.md §16.7）。
     */
    private readonly interceptApproval: (
      approval: PendingApproval,
      rawParams: Record<string, unknown>,
    ) => Promise<ApprovalHandlerResult> = () => Promise.resolve({ kind: 'ask' }),
    /**
     * プロセスの起こし方（Issue #186）。既定は実際に `claude` を起動する。統合テストだけが
     * ここをフェイクへ差し替え、stdin へ書かれたcontrol_requestを観測する。
     */
    private readonly spawnProcess: ClaudeSpawnPort = (command, args, options) =>
      spawn(command, [...args], { ...options, stdio: ['pipe', 'pipe', 'pipe'] }),
  ) {}

  /**
   * 使えるスラッシュコマンド。
   *
   * 組込コマンドをこちらで並べるのはやめた（手で並べた一覧は実在しないものを含んでいた）。
   * CLIが `initialize` の応答で返し、増減は `commands_changed` で届く。
   */
  get commands(): readonly SlashCommand[] {
    return this.commandList;
  }

  get threadId(): string | undefined {
    return this.state.threadId;
  }

  getState(): ChatState {
    return this.state;
  }

  /**
   * CLIとはやり取りせず、拡張機能側だけで完結した出来事を会話に1行残す
   * （issue #6のメモリ追記など）。プロセスが生きていなくても呼べる
   * （会話を閉じた後の操作を弾く理由が無いため）。
   */
  noteLocalEvent(id: string, text: string): void {
    this.update(appendNotice(this.state, id, text));
  }

  /**
   * 脇道の質問（issue #334、design.md §14.62）を会話へ1項目として残す/更新する。
   * `noteLocalEvent`と同じくCLIとのやり取り（transcript）には一切乗らない、
   * この画面だけの表示。同じidで呼び直すと上書きする（`appendSideQuestion`参照）。
   */
  noteSideQuestion(id: string, display: { status: string; text: string; detail: string }): void {
    this.update(appendSideQuestion(this.state, id, display));
  }

  /**
   * セカンドオピニオン（Issue #894）を会話へ1項目として残す/更新する。
   * `noteSideQuestion` と同じくCLIとのやり取り（transcript）には乗らない画面だけの表示。
   */
  noteSecondOpinion(id: string, display: { status: string; text: string; detail: string }): void {
    this.update(appendSecondOpinion(this.state, id, display));
  }

  /** プロセスを起動する。発言はこの後 `send` で流す。 */
  start(options: ClaudeStreamOptions): void {
    // 現状の`claudeChatView.ts`（`openNew`/`openTaskSession`/resume/fork/restore）は
    // いずれも`buildEntry()`で`new ClaudeStreamSession(...)`した直後のインスタンスへ
    // 一度だけ`start()`を呼ぶ経路で、同一インスタンスへ再度`start()`が呼ばれる経路は
    // 現状無い。ただしそれは呼び出し側の運用に依存した前提であり、`ClaudeStreamSession`
    // 自身が「一度きりの前提」を強制してもいない。将来同一インスタンスを使い回す変更が
    // 入った場合や、クラッシュ後の再起動が同一インスタンスへ`start()`し直す形に変わった
    // 場合に備え、前回分の応答待ちを積み残さないよう新しいプロセスを起こす前に必ず
    // 解放しておく。現状の呼び出し方では各Mapは常に空のため、この呼び出しは実質no-op
    // （issue #355のレビュー指摘: 断定していた「複数回呼ばれる」根拠が誤りだったため
    // 訂正）。
    this.releasePendingWaiters();
    this.isForkSession = options.target.kind === 'fork';

    const { args, warnings } = buildClaudeStreamArgs({
      target: options.target,
      sessionId: options.sessionId,
      cwd: options.cwd,
      config: options.config,
    });
    for (const w of warnings) {
      this.log.warn(w);
    }

    const proc = this.spawnProcess(this.claudePath(), args, {
      cwd: options.cwd,
      // `rewind_files`（ファイルの巻き戻し）はこの環境変数を立てないと、非対話
      // （`--print`）環境ではチェックポイントが作られず常に失敗する（実測。CLIバイナリの
      // strings解析で見つけたゲート関数 `QF()` がinteractive判定を見ている。
      // design.md「Claude Codeの巻き戻し」参照）。ドキュメントに無い変数だが、名前
      // （SDK向け）と挙動から拡張機能のような非対話クライアント向けの明示的な入口と判断し、
      // 常に立てる。CLIの更新で消える・形が変わる可能性はあり、その場合は
      // `rewind_files` の応答が失敗として返るだけで、会話自体は影響を受けない。
      env: { ...process.env, CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1' },
    });
    this.proc = proc;

    // `proc.on('error')`は起動失敗しか拾わない。起動後に相手が終了した状態へ書き込むと
    // 飛ぶEPIPE等はここで捕まえないとNodeの未捕捉例外になる（issue #155、design.md
    // §14.31）。常駐セッションなので、既存のexit/errorハンドラと同じ「ターン失敗」の
    // 経路へ寄せる。
    //
    // 以下の5ハンドラは、この`start()`呼び出しでクロージャに捕まえた`proc`（この世代の
    // プロセス）を対象とする。overflow等で`this.proc`を`undefined`へ戻した後、次の
    // `start()`が新しいプロセスを起こし終えてから、古い世代の`exit`/`error`/`stdin`
    // エラーやstdout/stderrの出力が遅れて届くことがある（issue #419、`connection.ts`の
    // CRITICALと同種）。その時点で`this.proc`は既に新しいプロセスを指しているため、
    // 素通りで`this.proc = undefined`にすると新しいターンを巻き込んで壊す。
    // `this.proc !== proc`で世代のずれを検出し、古い世代からの通知は捨てる。
    guardStdinErrors(proc, (e) => {
      if (this.proc !== proc) {
        return;
      }
      this.log.error(`claudeへの書き込みに失敗しました: ${e.message}`);
      this.proc = undefined;
      // exit/errorハンドラと同じ「ターン失敗」の経路なので、承認待ち・各種応答待ちも
      // 同じく解放する。放置するとawaitしている側が永遠に待つ（issue #355）
      this.releasePendingWaiters();
      this.update(this.stateAfterProcessGone());
    });

    proc.stdout.on('data', (chunk: Buffer) => {
      if (this.proc !== proc) {
        return;
      }
      this.receive(chunk.toString('utf8'));
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      if (this.proc !== proc) {
        return;
      }
      const line = chunk.toString('utf8').trim();
      if (line !== '') {
        this.log.info(`[claude] ${line.slice(0, 300)}`);
      }
    });
    proc.on('exit', (code) => {
      if (this.proc !== proc) {
        return;
      }
      this.log.info(`claudeが終了しました (code ${code ?? 'unknown'})`);
      this.proc = undefined;
      // 承認待ち（waiting）・rewind_files/mcp_status/reload_skillsの応答待ちを解放する。
      // 放置するとCLIの異常終了時にawaitしている側が永遠に待つ（issue #355、dispose()と
      // 同じ解放処理を共有）
      this.releasePendingWaiters();
      // 会話の途中でプロセスが消えた形なので、続きは送れない
      this.update(this.stateAfterProcessGone());
    });
    proc.on('error', (e) => {
      if (this.proc !== proc) {
        return;
      }
      this.log.error(`claudeを起動できません: ${e.message}`);
      this.proc = undefined;
      // 起動直後にCLIが異常終了した場合も、exitハンドラと同様に解放する（issue #355）
      this.releasePendingWaiters();
      this.update(this.stateAfterProcessGone());
    });

    const threadId =
      options.target.kind === 'resume' ? options.target.sessionId : options.sessionId;
    this.update({
      ...initialClaudeState,
      threadId,
      items: options.initialItems ?? [],
      todos: options.initialTodos ?? initialClaudeState.todos,
      todoHistory: options.initialTodoHistory ?? initialClaudeState.todoHistory,
      name: options.initialName,
    });

    this.initializeControl();
  }

  /**
   * 承認要求を受け取れることをCLIへ伝える。
   * 応答が返らない/失敗しても会話は続けられるため、握り潰してログに残すだけにする。
   */
  private initializeControl(): void {
    const requestId = this.claim('initialize');
    this.write(buildControlRequest(requestId, { subtype: 'initialize', hooks: {} }));
  }

  /** 要求idを採番し、応答を読むときのために用途を覚える。 */
  private claim(kind: OutgoingKind, subject = '', note = ''): string {
    const requestId = `req_${this.nextControlId++}`;
    this.outgoing.set(requestId, { kind, subject, note });
    return requestId;
  }

  /**
   * 会話中にモデルを変える。次の発言から効く。
   *
   * 起動引数はプロセスが生きている間ずっと固定なので、これが唯一の手段。
   * 「既定」（空文字）は元に戻す手段が無いため送らない。
   */
  setModel(model: string): void {
    if (this.proc === undefined || model === '') {
      return;
    }
    const requestId = this.claim('settings', 'モデル', `モデルを ${model} に変えました`);
    this.write(buildSetModelRequest(requestId, model));
  }

  /**
   * 会話中に承認方法を変える。
   *
   * 変わったことは `system/status` 通知の側で画面に残す。応答の成功だけを信じない
   * （他の経路で変えられた場合も同じ通知で拾える）。
   */
  setPermissionMode(mode: string): void {
    if (this.proc === undefined || mode === '') {
      return;
    }
    this.write(buildSetPermissionModeRequest(this.claim('settings', '承認方法'), mode));
  }

  /**
   * Plan modeを切り替える。
   *
   * Claude Codeでは承認方法そのものなので `set_permission_mode` で足りる。状態は
   * `system/status` 通知を正として更新するため、ここでは要求を出すだけにする。
   *
   * @param fallback 抜けるときに戻す承認方法。設定が空なら `manual`（既定）へ戻す
   */
  setPlanMode(on: boolean, fallback: string): void {
    this.setPermissionMode(on ? 'plan' : fallback === '' ? 'manual' : fallback);
  }

  /**
   * Fast mode（`/fast`）を切り替える（Issue #198）。
   *
   * 専用の制御要求は無い（CLIバイナリから `set_` 系のsubtypeを抽出しても該当が無かった）。
   * `compact` と同じくTUIと同じコマンドを発言として送る。`/fast` はトグルなので、いまの値と
   * 同じ向きへの操作は送らない（送ると意図と逆になる）。
   *
   * 状態は送った時点で反転させる。`fast_mode_state` は `initialize` の応答にしか無く、
   * 切り替えの通知が来ないため、ここで持たないと画面が追従できない。
   */
  setFastMode(on: boolean): void {
    if (
      this.proc === undefined ||
      this.state.fastMode === undefined ||
      this.state.fastMode === on
    ) {
      return;
    }
    this.update({ ...this.state, busy: true, turnFailed: false, fastMode: on });
    this.write(buildUserMessage('/fast'));
  }

  /**
   * 会話中にeffortを変える。
   *
   * 専用の制御要求が無いため `apply_flag_settings` に載せる。**効いたことは観測できない**
   * ので、画面には「送った」までしか出さない（`control.ts` の説明を参照）。
   */
  setEffort(effort: string): void {
    if (this.proc === undefined || effort === '') {
      return;
    }
    const requestId = this.claim(
      'settings',
      'effort',
      `effort を ${effort} で送りました（CLIが結果を返さないため、効いたかどうかは確かめられません）`,
    );
    this.write(buildSetEffortRequest(requestId, effort));
  }

  /**
   * 会話の名前を変える（issue #199）。
   *
   * 表示用の名前は拡張機能側（`ClaudeSessionStore`）を正とする設計のため（理由は
   * `control.ts` の `buildRenameSessionRequest` のJSDoc参照）、CLIの応答を待たず
   * `setFastMode` と同じくここで即座に `state.name` を更新して画面（タブ名・入力欄）へ
   * 反映する。`rename_session` の送信はCLI側との整合を保つためのベストエフォートで、
   * 失敗しても画面上の名前（呼び出し側が保存済み）は変わらない。
   */
  setName(name: string): void {
    if (name === '') {
      return;
    }
    this.update({ ...this.state, name });
    if (this.proc === undefined) {
      return;
    }
    const requestId = this.claim('settings', '会話名', `会話名を「${name}」に変更しました`);
    this.write(buildRenameSessionRequest(requestId, name));
  }

  /**
   * コンテキストの使用量を読み直す。TUIの `/context` と同じ数字が返る。
   *
   * 会話へ `/context` を送ると応答が会話に混ざるため、control protocol で聞く。
   * 応答が返らなくても会話は続けられるので、失敗は黙って見送る。
   */
  refreshContext(): void {
    // 応答を返さないCLIでは要求が返らない。返事待ちを1件までにして積み上がりを防ぐ
    if (
      this.proc === undefined ||
      [...this.outgoing.values()].some((o) => o.kind === 'contextUsage')
    ) {
      return;
    }
    this.write(buildContextUsageRequest(this.claim('contextUsage')));
  }

  /**
   * セッションのコストを読み直す（issue #37、design.md TP-60）。
   *
   * レート制限の消費率（`usage`）ともコンテキストの使用量（`context`）とも別の数字なので、
   * `refreshContext` と同じ作りで別のフィールド（`sessionCost`）へ持つ。会話へ `/cost` を
   * 送ると応答が会話に混ざるため、control protocolで聞く。応答が返らなくても会話は
   * 続けられるので、失敗は黙って見送る。
   *
   * 追加クレジット（`extraUsage`、issue #204）も同じ応答（`rate_limits.extra_usage`）から
   * 読めるため、専用の要求は足さずここに相乗りする（`handleControlResponse`参照）。
   */
  refreshSessionCost(): void {
    // 応答を返さないCLIでは要求が返らない。返事待ちを1件までにして積み上がりを防ぐ
    if (
      this.proc === undefined ||
      [...this.outgoing.values()].some((o) => o.kind === 'sessionCost')
    ) {
      return;
    }
    this.write(buildSessionCostRequest(this.claim('sessionCost')));
  }

  /**
   * 会話を要約して圧縮する。
   *
   * 専用の制御要求が無いため、TUIと同じく `/compact` を発言として送る
   * （`local_command` の制御要求は `Unsupported control request subtype` で失敗する）。
   * 会話の内容を不可逆に変えるため、確認は呼び出し側で済ませてから呼ぶこと。
   */
  compact(): void {
    if (this.proc === undefined) {
      throw new Error('セッションが起動していません');
    }
    this.update({ ...this.state, busy: true, turnFailed: false });
    this.write(buildUserMessage('/compact'));
  }

  /**
   * 他エージェント（Codex／Gemini）のローカル設定をClaude Codeへ取り込む
   * （issue #200、design.md TP-88。CodexのTP-57／issue #36に相当するClaude Code側）。
   *
   * **経路の実測（CLI 2.1.227）**: control protocolに専用の制御要求は無い。
   * `import` `import_config` `import_settings` `run_local_command` `local_command`
   * `invoke_command` `run_command` `run_slash_command`
   * `external_agent_config_detect` `detect_import` `config_migration_detect`
   * `migrate_config` の12候補を総当たりし、いずれも
   * `Unsupported control request subtype: <name>` で拒否されることを確認済み
   * （CodexのJSON-RPCのような `externalAgentConfig/detect` 相当は存在しない）。
   *
   * そのため `compact` / `fast` と同じく、TUIと同じ `/import` をユーザー発言として送る。
   * バイナリの文字列解析で `claude import [codex|gemini] [--dry-run]
   * [--yes[=<digest>]]` というサブコマンド定義と、同名のスラッシュコマンド定義
   * （`type:"local-jsx"` はTTYの対話UI専用、`type:"local"` は
   * `supportsNonInteractive:true` を持ち非対話環境向け）が見つかり、
   * `isEnabled` は機能フラグ `tengu_import` を見ている（未提供環境では一覧に出ない）。
   *
   * 実際にこの環境で `/import` を送って実測した結果: 一覧に `import` コマンドが
   * 存在し（フラグが有効）、送るとCLIが実在する `~/.codex` の設定を実際にスキャンし、
   * 32桁16進のダイジェスト付きプレビュー（何が取り込み可能か・何が自動対応不可か）が
   * 会話内の応答として返ってきた。**ただしこの応答は構造化JSONではなく、モデルが
   * 生成する自然文**（応答の言い回しはユーザー自身のCLAUDE.md等の指示にも影響される）
   * なので、拡張機能側で内容やダイジェストを機械的にパースすることはしない
   * （壊れやすく、design.mdの「実測できないことを実測したふりで書かない」に反する）。
   *
   * 実際に書き込むには、この応答に含まれるダイジェストを付けて
   * `/import --yes=<digest>` をユーザー自身がもう一度送る必要があり（ダイジェストが
   * 現在のスキャンと一致しないと拒否される＝確認後に設定が変わっていたら弾かれる）、
   * 対話ターミナルでの `claude import`（チェックボックスUI）はTTY専用のためこの拡張
   * からは使えない。つまりこの呼び出し自体は**一切書き込まない**（プレビューの要求を
   * 送るだけ）。呼び出し側の確認ダイアログは「何を・どこから」を説明するためのもので、
   * 実際の取り込み可否はCLI自身の二段階確認（本呼び出し→ダイジェスト一致の再送信）に
   * 委ねる。取り込み元はCodexまたはGemini固定（`claude import` の引数説明より。
   * このCLI自身をソースにすることはできない）。
   */
  importConfig(): void {
    if (this.proc === undefined) {
      throw new Error('セッションが起動していません');
    }
    this.update({ ...this.state, busy: true, turnFailed: false });
    this.write(buildUserMessage('/import'));
  }

  /**
   * 追加クレジット（usage credits）の設定・管理者への要求を扱う
   * （issue #204、design.md §14.38）。
   *
   * **経路の実測（CLI 2.1.227）**: 現在値は専用の制御要求を足さなくても取れる
   * （`get_usage`の応答の`rate_limits.extra_usage`。`refreshSessionCost`/`readExtraUsage`
   * 参照）。一方で要求（有効化・上限変更・管理者への要求）を送る専用の制御要求は無く
   * （`^(get|set)_[a-z_]*(credit|usage)[a-z_]*$`に一致するsubtypeは`get_usage`と
   * `get_context_usage`の2つだけ。issue #204のコメントの実測）、`compact` / `import` /
   * `recap`と同じくTUIと同じ`/usage-credits`をユーザー発言として送るのが唯一の経路。
   *
   * バイナリの文字列解析で、この名前のコマンドには**対話専用**（`type:"local-jsx"`、
   * `requires:{ink:true}`）と**非対話対応**（`type:"local"`、
   * `supportsNonInteractive:true`）の2つの定義があると分かった（`/import`と同じ形）。
   * 拡張機能のセッションは常に非対話（TTY無し）なので、実際に使われるのは後者。
   *
   * 実際にこの環境で引数無しの`/usage-credits`を送って実測した結果、CLIは実モデルを
   * 呼ばず（`model`が`"<synthetic>"`、`total_cost_usd`が増えない＝無償）、常に
   * 「Visit https://claude.ai/settings/usage?from=cc_cli_limit_message to manage
   * usage credits.」という**固定の1文**を返した。バイナリ側にも「Requesting usage
   * credits notifies your organization admins. To review and send the request, run
   * /usage-credits in an interactive Claude Code session.」という文字列があり、
   * 実際に管理者へ通知する対話フロー（クレジットの購入・上限変更・管理者への要求の
   * 選択肢を出すink UI）はTTY専用で、非対話のこの拡張機能からは**そもそも到達できない**
   * と読める。つまりこの呼び出しは、いまの状態に関わらず**外部（組織の管理者）への
   * 通知は起こさず**、対話セッションで設定するよう促すURLを返すだけの見込みが高い。
   *
   * ただし実測できたのはこの環境の1状態（追加クレジット無効・`out_of_credits`）だけで、
   * 有効時や他の`disabled_reason`で挙動が変わらない保証はない。応答が固定書式であっても
   * 「管理者への要求を伴いうる操作」として扱い、呼び出し側の確認ダイアログは省かない
   * （design.mdの「実測できないことを実測したふりで書かない」の裏返しとして、安全側に
   * 倒す）。応答は`/import` / `/recap`と同じく会話へそのまま残るテキストで、構造化
   * JSONではないため機械的にはパースしない（この1文自体はURL以外に読み取る値が無く、
   * パースしても得るものが無い）。
   */
  requestUsageCredits(): void {
    if (this.proc === undefined) {
      throw new Error('セッションが起動していません');
    }
    this.update({ ...this.state, busy: true, turnFailed: false });
    this.write(buildUserMessage('/usage-credits'));
  }

  /**
   * CLI側のデバッグログを実モデルに読ませて診断させる（`/debug`、issue #205、
   * design.md §14.39）。
   *
   * **issue本文の前提が実測で覆っている点に注意**: issue #195の再抽出時点の想定は
   * 「セッションのデバッグログを会話中に有効にする」だったが、本体の事前実測
   * （issue #205のコメント、CLI 2.1.227）で次が判った。
   *
   * 1. ログは`/debug`を送る前から常時出ている。`<claudeHome>/debug/<sessionId>.txt`に
   *    セッション開始の時点で既に書かれており（実測: 送信前で5678バイト）、
   *    `<claudeHome>/debug/latest`が最新のログを指すシンボリックリンク。つまり
   *    「有効にする」操作は要らない（`cliLocator.ts`の`debugLogCandidates`／
   *    `claudeChatView.ts`の`openDebugLog`参照。CLIへは何も送らずログを直接
   *    エディタで開ける）
   * 2. `/debug`は「既に出ているログをモデルに読ませて診断させる」コマンド。送ると
   *    `<synthetic>`ではなく`claude-opus-5`の**実モデルが動き**、モデルが**Bashツールで
   *    `ls`・`cat`を実行**してログを読み、内容を要約して返す
   * 3. **課金される**。実測で`num_turns: 3`、`total_cost_usd: 0.3824885`。`Bash`ツールの
   *    実行を伴うため、承認が要る構成では**承認カードが出る**
   *
   * control protocolに専用の経路は無い（`^(get|set|toggle)_[a-z_]*debug[a-z_]*$`に
   * 一致するsubtypeは存在しない。issue #205のコメントの実測）。つまり`compact` /
   * `importConfig` / `recap` / `requestUsageCredits`と同じくTUIと同じ`/debug`を
   * ユーザー発言として送るのが唯一の経路。
   *
   * `/recap`・`/autocompact`と違い実モデルが動いて課金・ツール実行（承認カード）を
   * 伴うため、`/usage-credits`・`/import`と同じく呼び出し側（`chatView.ts`の
   * `confirmDebugCommand`）で必ず確認する。応答はモデルが生成する自然文（構造化JSON
   * ではない）のため、`/import`・`/recap`と同じく機械的にはパースせず、会話へ
   * そのまま残す。
   */
  sendDebugCommand(): void {
    if (this.proc === undefined) {
      throw new Error('セッションが起動していません');
    }
    this.update({ ...this.state, busy: true, turnFailed: false });
    this.write(buildUserMessage('/debug'));
  }

  /**
   * 会話の1行要約をその場で作る（issue #203、design.md §14.36）。
   *
   * **経路の実測（CLI 2.1.227）**: 専用の制御要求は無い。バイナリのstrings解析で拾った
   * `recap_command` `recap.trigger` `recap` `local_command` の4候補を実際に
   * `control_request` として送ったが、いずれも `Unsupported control request subtype: <name>`
   * で拒否されることを確認した。一方で同じ解析から `type:"local"` のスラッシュコマンド
   * 定義（`name:"recap"`、`description:"Generate a one-line session recap now"`）が
   * 見つかっており、`compact` / `fast` / `import` と同じくTUIと同じ `/recap` を
   * ユーザー発言として送るのが唯一の経路。
   *
   * 実際にこの環境で送って実測した結果: 会話を1ターン進めた直後に `/recap` を送ると、
   * CLIは実モデルの応答ストリーム（`stream_event`）を経由せず、`model` が
   * `"<synthetic>"`・`stop_reason` が `"stop_sequence"` の `assistant` 発言を1件返し、
   * それが会話（transcript）にそのまま残った。例: 「1+1を聞かれ、2と答えた。それだけの
   * やり取りで、進行中の作業はない。次の指示待ち。」（会話の言語に揃って日本語で返ってきた）。
   * ただし表示上は同期的でも無償ではなく、`result` の `total_cost_usd` は送信前後で
   * 実際に増えていた（実測: 0.2192235 → 0.241251）。バイナリ側にも
   * 「Recap in under 40 words, 1-2 plain sentences, no markdown」という指示文字列が
   * 見つかっており、内部では軽量なモデル呼び出しで要約を作った上で、それを会話ターンでは
   * なく「その場に差し込む1発言」として`<synthetic>`表示にしていると見られる。
   *
   * **この応答は構造化JSONではなく自然文**（strings解析でも `{type:"text",value:o.text}`
   * という素通しの形が見つかっており、長さや言い回しは会話の内容・言語に引きずられる）。
   * そのため `compact` / `import` と同じ理由で、この文面をタブ名・履歴の表示名
   * （`ClaudeSessionNameStore`）へ機械的に反映することはしない。改行や句読点を含む
   * 可変長の自然文を「短い名前」へ機械的に切り詰める処理は壊れやすく、design.mdの
   * 「実測できないことを実測したふりで書かない」の裏返しとして、ここでは
   * 「安全に変換できる保証が無いのでやらない」を選ぶ。名前を変えたい場合は引き続き
   * issue #199の改名操作（`setName`）を使う。
   */
  recap(): void {
    if (this.proc === undefined) {
      throw new Error('セッションが起動していません');
    }
    this.update({ ...this.state, busy: true, turnFailed: false });
    this.write(buildUserMessage('/recap'));
  }

  /**
   * 自動圧縮の窓サイズを確認・変更する（issue #201、design.md §14.37）。
   *
   * **経路の実測（CLI 2.1.227）**: `get_settings` の応答にも `initialize` の応答にも
   * 現在値は含まれない（未設定時は`effective`に出てこない。実測済み）。専用の制御要求も
   * 無く、`set_autocompact` 等6候補はいずれも `Unsupported control request subtype` で
   * 拒否される。`apply_flag_settings` に `autoCompactWindow` を載せる経路は `success` が
   * 返るが、直後の `get_settings` にも反映が現れず「効いたかどうか確かめられない」
   * （`setEffort` と同じ限界）。そのため `compact` / `recap` と同じく、TUIと同じ
   * `/autocompact` をユーザー発言として送るのが唯一の経路。
   *
   * 引数無し（空文字）で送ると**現在値を問い合わせるだけ**で、CLI側の状態は変わらない。
   * 応答は `<synthetic>` の固定書式テキストで返り（モデル呼び出しを経由しない。実測で
   * コストが増えないことを確認）、`streamJson.ts` の `applyAssistant` が
   * `parseAutocompactReport`（`autocompactText.ts`）で拾って `state.autocompactWindow` へ
   * 反映する。値を渡すと `/autocompact <window>` を送り、CLI側で実際に変更する
   * （`'auto'` または `100k`〜`1M` トークンの数値表現。範囲外・書式不正はCLI自身が
   * `Couldn't parse ...` を返し、値は変わらない）。どちらの応答も会話にそのまま残るため、
   * 変更したことは会話の記録からも分かる（issue #201の受入基準）。
   *
   * 事前バリデーションはしない（CLIの受理を正とする。`compact` / `recap` と同じ流儀）。
   */
  setAutocompactWindow(window: string): void {
    if (this.proc === undefined) {
      throw new Error('セッションが起動していません');
    }
    this.update({ ...this.state, busy: true, turnFailed: false });
    const trimmed = window.trim();
    this.write(buildUserMessage(trimmed === '' ? '/autocompact' : `/autocompact ${trimmed}`));
  }

  /**
   * 指定した発言の直前まで、ファイルだけを戻せるか確かめる（dry_run）。実際には適用しない。
   *
   * **会話の履歴には触れない**。`rewind_files` はファイルだけを対象にする制御要求で、
   * 会話を戻す `rewind` subtype は非対応（`Unsupported control request subtype: rewind` を
   * 実測済み）。呼び出し側は返ってきた `filesChanged` を確認ダイアログで見せてから
   * `applyRewindFiles` を呼ぶこと（design.md「Claude Codeの巻き戻し」）。
   */
  previewRewindFiles(userMessageId: string): Promise<RewindFilesResult> {
    return this.requestRewindFiles(userMessageId, true);
  }

  /**
   * 指定した発言の直前まで、ファイルを実際に戻す。会話の履歴は変わらない。
   * 元には戻せないため、呼び出し側で確認を済ませてから呼ぶこと。
   */
  applyRewindFiles(userMessageId: string): Promise<RewindFilesResult> {
    return this.requestRewindFiles(userMessageId, false);
  }

  /**
   * MCPサーバーの一覧・状態を問い合わせる（design.md §16.21「ツールの可視性の確認」）。
   *
   * `mcp_status` control requestは`ClaudeMcpProbe`（単発起動の設定パネル用問い合わせ）と
   * 同じ要求だが、こちらは**既に会話用に起動しているプロセスへ**そのまま投げる
   * （タスクのセッションを開いた後に確認する。design.md「確認はタスクのセッションを
   * 開いた後に行う」はCodex固有の制約の記述だが、同じ流儀に合わせておく）。
   * プロセスが無い、または応答が来ない場合は`undefined`を返す（呼び出し側は
   * 「見えない」側へ倒す。`ChatViewManager.checkMcpStartupStatus`と対称の判断）。
   */
  checkMcpStatus(): Promise<McpServerView[] | undefined> {
    if (this.proc === undefined) {
      return Promise.resolve(undefined);
    }
    const requestId = this.claim('mcpStatus');
    return new Promise((resolve) => {
      this.mcpStatusWaiting.set(requestId, resolve);
      this.write(buildMcpStatusRequest(requestId));
    });
  }

  /**
   * skillsを読み直す（issue #202、design.md TP-90）。
   *
   * 設定パネルの`ClaudeSkillsProbe`（単発起動の問い合わせ）とは別に、**会話中の
   * このプロセス自身へ**`reload_skills`を送る。単発プロセスへ送っても、既に開いている
   * この会話のプロセスには何も起きない（プロセスごとにディスクを読む独立した状態を
   * 持つため）。CLIの `/reload-skills`（「Pick up skills added or changed on disk during
   * this session」）は元々セッション単位の操作であり、実測（CLI 2.1.227）でも
   * ここへ送って初めてこのプロセスの一覧が更新されることを確認した。
   *
   * 応答には最新のskills一覧が乗る（`reload_skills`は一覧の取得を兼ねる。
   * `skillsList.ts`参照）。あわせて届く`system/commands_changed`通知は`receive()`の
   * 既存の経路（`readCommandsChanged`→`setCommands`→`onCommands`）でそのまま
   * スラッシュコマンドの候補へ反映されるため、ここでは制御要求を送って応答を
   * 読むだけでよい。
   *
   * プロセスが無ければ`undefined`を返す（`checkMcpStatus`と同じ「見えない」側への
   * 倒し方）。呼び出し側（`ClaudeChatViewManager`）はこれを「対象外」として扱い、
   * 通知を出さない。
   */
  reloadSkills(): Promise<SkillsSnapshot | undefined> {
    if (this.proc === undefined) {
      return Promise.resolve(undefined);
    }
    const requestId = this.claim('reloadSkills');
    return new Promise((resolve) => {
      this.skillsWaiting.set(requestId, resolve);
      this.write(buildReloadSkillsRequest(requestId));
    });
  }

  /**
   * 会話の途中のターンから分岐する（issue #333、design.md §14.61）。
   *
   * `--fork-session` で開いたセッションだけに限る。forkしていないセッションへ送ると
   * 元セッションのtranscriptを壊す（`control.ts` の `buildRewindConversationRequest`
   * 参照）ため、呼び出し側の確認を待たずここでガードする。
   *
   * @param userMessageUuids 会話中の全ユーザー発言uuid（古い順）
   * @param targetUuid 分岐したい発言（この発言の手前まで戻す）
   */
  rewindConversationToTurn(
    userMessageUuids: readonly string[],
    targetUuid: string,
  ): Promise<ForkFromTurnResult> {
    if (!this.isForkSession) {
      return Promise.resolve({
        ok: false,
        prefillText: undefined,
        error: {
          message: 'forkしていないセッションへは送れません（元セッションのtranscriptが壊れるため）',
          origin: 'app',
        },
        succeededCount: 0,
      });
    }
    if (this.proc === undefined) {
      return Promise.resolve({
        ok: false,
        prefillText: undefined,
        error: { message: 'セッションが起動していません', origin: 'app' },
        succeededCount: 0,
      });
    }
    return forkFromTurn(userMessageUuids, targetUuid, (uuid) =>
      this.requestRewindConversation(uuid),
    );
  }

  /**
   * `rewind_conversation` を1件送る。`interrupt_if_running` は常にtrueで送る
   * （issue #333の実装指示。走行中のターンがあれば中断してから戻す）。
   */
  private requestRewindConversation(targetUuid: string): Promise<RewindConversationResult> {
    const requestId = this.claim('rewindConversation');
    return new Promise((resolve) => {
      this.rewindConversationWaiting.set(requestId, resolve);
      this.write(buildRewindConversationRequest(requestId, targetUuid, true));
    });
  }

  /**
   * 脇道の質問を送る（issue #334、design.md §14.62、Codexの `/btw` 相当）。
   *
   * Codexの `/btw`（`chatView.ts` の `startSideQuestion`）は `thread/fork` で別スレッドを
   * 作ってから聞くが、Claude Codeの `side_question` は**新しいセッションを作らない**。
   * 今つながっている1本のCLIプロセスへ直接 `control_request` を送り、応答も1往復で返る
   * （design.md §14.62）。そのため戻り値は新しいタブへの案内ではなく、聞いた結果そのもの。
   *
   * 走行中のターンがあっても送れる（実測、design.md §14.62）。`rewind_conversation`の
   * ような「先に確認して弾く」ガードはここには無い（CLI側に制約が無いと分かっているため）。
   *
   * 空文字・空白のみの`question`はCLIへ送らずここで弾く（レビュー指摘・design.md §14.62）。
   * 実測でCLIは`question`の型・空文字を検証せず、省略時は文字列`"undefined"`、オブジェクト
   * なら`"[object Object]"`をそのまま質問文としてモデルへ渡してしまうことが分かっている。
   * 呼び出し元（`claudeChatView.ts`の`runPseudoCommand`）でも`trimmedArgsOrUndefined`で
   * 空文字を弾いているが、境界（`ClaudeStreamSession`の公開API）でも同じ検証を重ねる
   * （呼び出し元の判定漏れや将来の別経路に備えた多層防御）。
   *
   * @param onProgress `control_request_progress`の都度呼ぶ。`api_retry`はモデル呼び出しの
   * 再試行中で、何も出さないと固まって見える（design.md §14.62「600秒」の節参照）。
   */
  askSideQuestion(
    question: string,
    history: readonly SideQuestionHistoryEntry[],
    onProgress: (progress: ControlRequestProgress) => void = () => undefined,
  ): Promise<SideQuestionResult> {
    if (question.trim() === '') {
      return Promise.resolve({
        ok: false,
        response: undefined,
        synthetic: undefined,
        refusalFallback: undefined,
        error: { message: '質問が空です', origin: 'app' },
      });
    }
    if (this.proc === undefined) {
      return Promise.resolve({
        ok: false,
        response: undefined,
        synthetic: undefined,
        refusalFallback: undefined,
        error: { message: 'セッションが起動していません', origin: 'app' },
      });
    }
    const requestId = this.claim('sideQuestion');
    return new Promise((resolve) => {
      this.sideQuestionWaiting.set(requestId, { resolve, onProgress });
      this.write(buildSideQuestionRequest(requestId, question, history));
    });
  }

  private requestRewindFiles(userMessageId: string, dryRun: boolean): Promise<RewindFilesResult> {
    if (this.proc === undefined) {
      return Promise.resolve({
        ok: false,
        filesChanged: [],
        insertions: undefined,
        deletions: undefined,
        error: 'セッションが起動していません',
      });
    }
    const requestId = this.claim('rewindFiles');
    return new Promise<RewindFilesResult>((resolve) => {
      this.rewindWaiting.set(requestId, resolve);
      this.write(buildRewindFilesRequest(requestId, userMessageId, dryRun));
    });
  }

  send(text: string, attachments: readonly Attachment[] = []): void {
    if (this.proc === undefined) {
      throw new Error('セッションが起動していません');
    }
    this.update({ ...this.state, busy: true, turnFailed: false });
    this.write(buildUserMessage(text, attachments));
  }

  /** 発言を送る。応答中なら待ち行列へ積む。 */
  sendOrQueue(text: string, attachments: Attachment[] = []): 'sent' | 'queued' {
    if (this.state.busy) {
      this.update(enqueue(this.state, text, attachments));
      return 'queued';
    }
    this.send(text, attachments);
    return 'sent';
  }

  cancelQueued(index: number): void {
    this.update(removeQueued(this.state, index));
  }

  /**
   * 待機中の末尾の指示を取り出し、入力欄へ書き戻す（Esc）。
   *
   * 常にこの時点の`state.queued`から直接取り出すため、UI側が持つ古いスナップショットとの
   * ずれで別の指示を取り消してしまうことがない（issue #677レビュー指摘）。添付があると
   * 入力欄へ戻せず黙って消えるため、その場合は何もしない。
   */
  popLastQueuedForInput(): QueuedMessage | undefined {
    const last = this.state.queued[this.state.queued.length - 1];
    if (last === undefined || last.attachments.length > 0) {
      return undefined;
    }
    const { next } = popLastQueued(this.state);
    this.update(next);
    return last;
  }

  /** 応答を止めて、待機中の指示をすぐ送る。 */
  flushQueue(): void {
    this.sendQueued(0);
  }

  /** 待機中の指定した指示をすぐ送る。 */
  sendQueued(index: number): void {
    const { message, next } = takeQueuedAt(this.state, index);
    if (message === undefined) {
      return;
    }
    const wasBusy = this.state.busy;
    // interrupt()がbusy=falseを通知すると、Viewの自動送信が残りの先頭を先に取り出す。
    // 選択した項目を先に送る間はbusyを保ったまま、待機列から先に外す。
    this.update(next);
    if (wasBusy) {
      this.interrupt(false);
    }
    try {
      this.send(message.text, message.attachments);
    } catch (e) {
      this.update(restoreQueued(this.state, index, message));
      throw e;
    }
  }

  /** 待機中の先頭を送る。ターンが終わったときに呼ぶ。 */
  sendNextQueued(): void {
    this.sendQueued(0);
  }

  interrupt(updateState = true): void {
    if (this.proc === undefined) {
      return;
    }
    this.write(buildControlRequest(`req_${this.nextControlId++}`, { subtype: 'interrupt' }));
    if (updateState) {
      // 走っていたターンがあったときだけ確定させる（issue #939）。CLIは中断後に`result`を
      // 返さないことがあるためここが確定点になるが、ターンを抱えていない状態で進めると、
      // 直前のターンの成果を作業記録へ二重に残すなど、無かった完了を1つ作ってしまう
      this.update({
        ...this.state,
        busy: false,
        turnCompletionSeq: this.state.busy
          ? this.state.turnCompletionSeq + 1
          : this.state.turnCompletionSeq,
      });
    }
  }

  /**
   * バックグラウンドで走っているタスクを止める（issue #33、design.md §14.23）。
   *
   * `stop_task` の応答は常に空で成否を返さない（`control.ts` の説明を参照）ため、
   * `interrupt` と同じく発行するだけにする。止まったことは後続の `background_tasks_changed`
   * 通知（一覧から消える）で画面に反映される。呼び出し側は破壊的操作として確認を
   * 済ませてから呼ぶこと。
   */
  stopBackgroundTask(taskId: string): void {
    if (this.proc === undefined) {
      return;
    }
    this.write(buildStopTaskRequest(`req_${this.nextControlId++}`, taskId));
  }

  /** ユーザーが承認カードのボタンを押したとき。 */
  decide(requestId: number | string, decision: ApprovalDecision): void {
    const key = String(requestId);
    const waiting = this.waiting.get(key);
    if (waiting === undefined) {
      return;
    }
    this.waiting.delete(key);
    // AskUserQuestion（issue #685）は「選んだ回答」を運べない汎用の4値decisionでは
    // 応答を組めない。ここへ`accept`が誤って渡ってきても（想定外の呼び出し元、または
    // ワークフロー実行系からの汎用accept）、答えの無い`allow`をCLIへ送らないよう
    // 常に拒否で返す。実際に選択肢を送るのは`answerAskUserQuestion()`だけ。
    // `decline`はwebview側の拒否ボタンが意図的に通る正規の経路なので、そこだけ
    // 誤動作を疑わせるログにしない
    if (waiting.approval.kind === 'askUserQuestion') {
      this.write(buildControlResponse(key, buildAskUserQuestionDenyResponse()));
      if (decision === 'decline') {
        this.log.info('承認: askUserQuestion → 拒否');
      } else {
        this.log.info(
          `承認: askUserQuestion → 拒否（${decision}経由、選択肢の送信はanswerAskUserQuestionのみ）`,
        );
      }
      this.update(removeApproval(this.state, requestId));
      return;
    }
    this.write(buildControlResponse(key, buildCanUseToolResponse(decision, waiting.input)));
    this.log.info(`承認: ${waiting.approval.kind} → ${decision}`);
    this.update(removeApproval(this.state, requestId));
  }

  /** ユーザーがAskUserQuestionの選択UIで選んで送信したとき。 */
  answerAskUserQuestion(requestId: number | string, selections: AskUserQuestionSelections): void {
    const key = String(requestId);
    const waiting = this.waiting.get(key);
    if (waiting === undefined || waiting.approval.kind !== 'askUserQuestion') {
      return;
    }
    this.waiting.delete(key);
    this.write(buildControlResponse(key, buildAskUserQuestionResponse(waiting.input, selections)));
    this.log.info('AskUserQuestion回答を送信しました');
    this.update(removeApproval(this.state, requestId));
  }

  /**
   * stdoutの1チャンクを処理する。実際の使い手はプロセスのstdoutリスナーだが、
   * テストからも直接呼べるよう公開する（`start()` は実プロセスを起動するため、
   * 承認まわりの分岐だけを検証したいテストは `start()` を経由せずここへ直接流す）。
   */
  receive(chunk: string): void {
    this.buffer += chunk;
    const { values, rest, overflow } = consumeNdjson(this.buffer);
    this.buffer = rest;

    try {
      // 完成した行（values）は、上限超過の判定より先に処理する（レビュー指摘・MEDIUM）。
      // overflowを先に見て早期returnすると、同じチャンクの中に「正常に完成したイベント」と
      // 「上限超過の未完成行」が同居していた場合、正常に届いていたイベントまで握りつぶして
      // しまう（後続の一括解放で待機自体は解けるが、本来成功していたターンが失敗扱いへ
      // すり替わってしまう）。
      for (const event of values) {
        // コマンドの増減。CLIは差分ではなく一覧を押し付けてくるので入れ替える
        const changed = readCommandsChanged(event);
        if (changed !== undefined) {
          this.setCommands(changed);
        }

        // 脇道の質問の処理経過（issue #334、design.md §14.62）。`control_response`とは
        // 別経路（`type:"system"`）で届くため、control_response読み取りの手前で拾う
        const progress = readControlRequestProgress(event);
        if (progress !== undefined) {
          this.sideQuestionWaiting.get(progress.requestId)?.onProgress(progress);
        }

        const request = readControlRequest(event);
        if (request !== undefined) {
          this.handleControlRequest(request);
          continue;
        }

        const response = readControlResponse(event);
        if (response !== undefined) {
          this.handleControlResponse(response);
          continue;
        }

        const wasBusy = this.state.busy;
        const next = applyStreamEvent(this.state, event);
        if (next !== this.state) {
          this.update(next);
        }
        // ターンが終わるたびに読み直す。圧縮の効果もここで表示へ反映される
        if (wasBusy && !next.busy) {
          this.refreshContext();
          this.refreshSessionCost();
        }
      }
    } finally {
      // `finally`へ置くのは、forループ中のハンドラ（`setCommands`/`update`等、
      // 呼び出し側が渡すコールバックを経由する）が同期的に例外を投げた場合でも、
      // overflow時の後始末（プロセスの打ち切り）を必ず実行するため（レビュー指摘・LOW）。
      // ループを先に処理する形へ入れ替えた際、例外で`if (overflow)`まで到達しない
      // 経路ができていた
      if (overflow) {
        // 改行を含まない出力（診断ログの乱れ・バイナリ混入等）が上限を超えて溜まり続けた
        // （issue #402、1点目）。このまま連結し続けると無制限にメモリを消費するため、
        // プロセスを回収して打ち切る。exit/errorハンドラと同じ「ターン失敗」の経路
        // （`releasePendingWaiters()` + `turnFailed: true`）へ寄せ、続きは送らせない。
        // `this.buffer`を`''`へ戻すため、上のforループで処理済みの`values`とは別に、
        // 上限超過分の`rest`がバッファに残り続けることはない
        this.log.error(
          `claudeからの出力が上限（${MAX_LINE_BUFFER_BYTES}バイト）を超えて改行なしで届いたため、セッションを打ち切ります`,
        );
        if (this.proc !== undefined) {
          killWithEscalation(this.proc);
        }
        this.proc = undefined;
        this.buffer = '';
        this.releasePendingWaiters();
        this.update(this.stateAfterProcessGone());
      }
    }
  }

  private handleControlRequest(request: IncomingControlRequest): void {
    if (request.subtype !== 'can_use_tool') {
      // 未知の要求。応答しないとCLIが待つため、素直に許可も拒否もしない形で返す
      this.write(buildControlResponse(request.requestId, {}));
      return;
    }

    this.sawApprovalRequest = true;
    const approval = describeCanUseTool(request.requestId, request.payload);
    if (approval === undefined) {
      this.write(buildControlResponse(request.requestId, defaultDenyControlResponse()));
      return;
    }

    const input = (request.payload['input'] as Record<string, unknown> | undefined) ?? {};
    void this.resolveApproval(request.requestId, approval, input, request.payload);
  }

  /**
   * 承認要求を自動判定へ回し、`auto` なら承認カードを出さずに応答する。
   * `ask`（既定）なら従来通り承認カードを出して人の判断を待つ。
   */
  private async resolveApproval(
    requestId: string,
    approval: PendingApproval,
    input: Record<string, unknown>,
    rawPayload: Record<string, unknown>,
  ): Promise<void> {
    const result = await this.interceptApproval(approval, rawPayload);
    if (result.kind === 'auto') {
      this.write(buildControlResponse(requestId, buildCanUseToolResponse(result.decision, input)));
      this.log.info(`承認(自動判定): ${approval.kind} → ${result.decision}`);
      return;
    }
    this.waiting.set(requestId, { approval, input });
    this.update(addApproval(this.state, approval));
  }

  private handleControlResponse(response: ControlResponse): void {
    const outgoing = this.outgoing.get(response.requestId);
    this.outgoing.delete(response.requestId);

    if (outgoing?.kind === 'settings') {
      this.noteSettingChange(response, outgoing);
      return;
    }

    if (outgoing?.kind === 'contextUsage') {
      const context = readContextUsage(response.payload);
      if (context !== undefined) {
        this.update({ ...this.state, context });
      }
      return;
    }

    if (outgoing?.kind === 'sessionCost') {
      const sessionCost = readSessionCost(response.payload, Date.now());
      // 追加クレジット（issue #204）も同じ応答（`rate_limits.extra_usage`）から読む。
      // 別の制御要求を足す必要が無いため、`sessionCost`の応答待ちにそのまま相乗りする
      const extraUsage = readExtraUsage(response.payload);
      if (sessionCost !== undefined || extraUsage !== undefined) {
        this.update({
          ...this.state,
          sessionCost: sessionCost ?? this.state.sessionCost,
          extraUsage: extraUsage ?? this.state.extraUsage,
        });
      }
      return;
    }

    if (outgoing?.kind === 'rewindFiles') {
      this.rewindWaiting.get(response.requestId)?.(readRewindFilesResult(response));
      this.rewindWaiting.delete(response.requestId);
      return;
    }

    if (outgoing?.kind === 'rewindConversation') {
      this.rewindConversationWaiting.get(response.requestId)?.(
        readRewindConversationResult(response),
      );
      this.rewindConversationWaiting.delete(response.requestId);
      return;
    }

    if (outgoing?.kind === 'sideQuestion') {
      const result = readSideQuestionResult(response);
      // CLI由来のエラー（origin:'cli'）は画面には汎用文言へ丸めて出す
      // （`sideQuestion.ts`の`describeSideQuestionError`）が、丸めた元の文言はどこにも
      // 残らないと、CLI側の予期しない構造エラーが多発したときに原因調査ができない
      // （セキュリティ監査の指摘、issue #340横断レビュー）。開発者向けの内部ログにだけ
      // 元の文言を残す
      if (result.error?.origin === 'cli') {
        this.log.warn(`side_questionがCLI側のエラーを返しました: ${result.error.message}`);
      }
      this.sideQuestionWaiting.get(response.requestId)?.resolve(result);
      this.sideQuestionWaiting.delete(response.requestId);
      return;
    }

    if (outgoing?.kind === 'mcpStatus') {
      this.mcpStatusWaiting.get(response.requestId)?.(
        response.ok ? readMcpServersList(response.payload) : undefined,
      );
      this.mcpStatusWaiting.delete(response.requestId);
      return;
    }

    if (outgoing?.kind === 'reloadSkills') {
      this.skillsWaiting.get(response.requestId)?.(buildSkillsSnapshot(response));
      this.skillsWaiting.delete(response.requestId);
      return;
    }

    // `initialize` の応答が使えるコマンドを全部返す。一覧のハードコードは要らない
    const commands = readCommandList(response.payload);
    if (commands !== undefined) {
      this.setCommands(commands);
    }

    // 起動引数でPlan modeにした場合、status通知は何かが変わるまで来ない
    const permissionMode = readCurrentPermissionMode(response.payload);
    if (permissionMode !== undefined) {
      this.update({ ...this.state, planMode: permissionMode === 'plan' });
    }

    // Fast mode（Issue #198）。`initialize` の応答だけが現在値を持つ（変更の通知は無い）ため、
    // ここで拾えなければ画面はトグルを出さない
    const fastMode = readFastModeState(response.payload);
    if (fastMode !== undefined) {
      this.update({ ...this.state, fastMode });
    }

    if (this.handshakeDone) {
      return;
    }
    this.handshakeDone = true;
    if (!response.ok) {
      // このCLIでは承認をこちらで受けられない。設定側の権限モードに従う
      this.log.warn(
        `承認要求の受け取りを有効にできませんでした: ${response.error ?? '不明'}。claude.permissionMode の設定に従います`,
      );
      this.onApprovalUnavailable();
      return;
    }
    // 会話を始める前の値を出しておく。ここを逃すと最初のターンが終わるまで空になる
    this.refreshContext();
    this.refreshSessionCost();
  }

  /**
   * 設定変更の結果を画面に残す。
   *
   * 失敗を黙って捨てると「変えたつもりで変わっていない」状態になる。成功の一言は
   * 別の通知で判るもの（承認方法）では出さず、二重に並べない。
   */
  private noteSettingChange(response: ControlResponse, outgoing: Outgoing): void {
    if (!response.ok) {
      const reason = response.error ?? '不明';
      this.log.warn(`${outgoing.subject}を変えられませんでした: ${reason}`);
      this.update(
        appendNotice(
          this.state,
          `settings:${response.requestId}`,
          `${outgoing.subject}を変えられませんでした: ${reason}`,
        ),
      );
      return;
    }
    if (outgoing.note !== '') {
      this.update(appendNotice(this.state, `settings:${response.requestId}`, outgoing.note));
    }
  }

  private setCommands(commands: SlashCommand[]): void {
    this.commandList = commands;
    this.onCommands(commands);
  }

  private update(next: ChatState): void {
    this.state = next;
    this.onChange(next);
  }

  /**
   * 書き込み前に生存判定を行う（issue #155）。判定と書き込みの間の競合までは防げないため、
   * `start()`で購読した`guardStdinErrors`と併用する。
   */
  private write(line: string): void {
    if (this.proc !== undefined) {
      safeWriteStdin(this.proc, line);
    }
  }

  /** 承認要求が一度も来ていないか（劣化検知の補助）。 */
  get approvalsSeen(): boolean {
    return this.sawApprovalRequest;
  }

  /**
   * プロセスが失われたときの状態（issue #897）。
   *
   * `busy`・`turnFailed`に加えてバックグラウンドの一覧も落とす。バックグラウンドのタスク
   * （実測では`local_bash`）はCLIプロセスの子なので、CLIが消えれば一緒に消える。一覧は
   * `background_tasks_changed`通知だけを正としており（`streamJson.ts`）、プロセスが死んだ
   * 後は「消えた」通知も届かない。残したままにすると、走っている処理が何も無いのに
   * チャット画面の外周が黄色（バックグラウンド実行中）のままになる。
   */
  private stateAfterProcessGone(): ChatState {
    return {
      ...this.state,
      busy: false,
      turnFailed: true,
      // 走っていたターンが「失敗として確定した」（issue #939）。`result`を受け取れない
      // まま終わった経路なので、完了の世代はここで進める。**走っていたターンがあるとき
      // だけ**進めるのは、この関数がプロセスの`exit`・`error`（起動失敗を含む）から
      // 呼ばれるため。1ターンも送っていない状態や、`result`を処理し終えたidleの状態で
      // 進めると、無かった完了を1つ作ってしまう
      turnCompletionSeq: this.state.busy
        ? this.state.turnCompletionSeq + 1
        : this.state.turnCompletionSeq,
      backgroundTerminals: NO_BACKGROUND_TERMINALS,
    };
  }

  /**
   * 承認待ち（waiting）・rewind_files/mcp_status/reload_skillsの応答待ちを解放する
   * （issue #355）。
   *
   * `dispose()`（利用者が明示的に会話を閉じる経路）と、`start()`内の`proc.on('exit')` /
   * `proc.on('error')` / `guardStdinErrors`（CLIが自分で終了・クラッシュする経路）の
   * どちらからも呼ばれる共通処理。放置するとこれらの応答をawaitしている側
   * （`requestRewindFiles()` / `checkMcpStatus()` / `reloadSkills()`の呼び出し元）が
   * 永遠に待ち続ける。
   *
   * プロセスの後始末（kill・stdinのend）はここに含めない。異常終了ハンドラが呼ばれる
   * 時点では既にプロセスは終了しており、killし直す意味が無いため、`dispose()`側だけが
   * 担う（「待機の解放」と「プロセスの後始末」を分ける）。
   *
   * 二重呼び出しでも安全: 各Mapは解放後に`clear()`するため、既に空のMapに対して
   * ループしても何もしない。`decide()`も存在しない`requestId`には何もしないため、
   * `waiting`が空になった後の再呼び出しも安全。
   */
  private releasePendingWaiters(): void {
    // 保留中の承認は拒否側で解放する。放置するとCLIが待ち続ける
    for (const [requestId] of this.waiting) {
      this.decide(requestId, 'cancel');
    }
    // rewind_filesの応答待ちも解放する。放置するとawaitしている側が永遠に待つ
    for (const resolve of this.rewindWaiting.values()) {
      resolve({
        ok: false,
        filesChanged: [],
        insertions: undefined,
        deletions: undefined,
        error: 'セッションが終了しました',
      });
    }
    this.rewindWaiting.clear();
    // rewind_conversationの応答待ちも解放する。放置するとawaitしている側が永遠に待つ
    for (const resolve of this.rewindConversationWaiting.values()) {
      resolve({
        rewound: false,
        targetMessageUuid: undefined,
        prefillText: undefined,
        precedingAssistantUuid: undefined,
        error: { message: 'セッションが終了しました', origin: 'app' },
      });
    }
    this.rewindConversationWaiting.clear();
    // side_questionの応答待ちも解放する。放置するとawaitしている側が永遠に待つ
    for (const { resolve } of this.sideQuestionWaiting.values()) {
      resolve({
        ok: false,
        response: undefined,
        synthetic: undefined,
        refusalFallback: undefined,
        error: { message: 'セッションが終了しました', origin: 'app' },
      });
    }
    this.sideQuestionWaiting.clear();
    // mcp_statusの応答待ちも解放する。放置するとawaitしている側が永遠に待つ
    for (const resolve of this.mcpStatusWaiting.values()) {
      resolve(undefined);
    }
    this.mcpStatusWaiting.clear();
    // reload_skillsの応答待ちも解放する。放置するとawaitしている側が永遠に待つ
    for (const resolve of this.skillsWaiting.values()) {
      resolve(undefined);
    }
    this.skillsWaiting.clear();
    this.outgoing.clear();
  }

  dispose(): void {
    this.releasePendingWaiters();
    this.proc?.stdin.end();
    if (this.proc !== undefined) {
      killWithEscalation(this.proc);
    }
    this.proc = undefined;
    this.buffer = '';
  }
}

/** こちらから出した制御要求の用途。 */
type OutgoingKind =
  | 'initialize'
  | 'contextUsage'
  | 'sessionCost'
  | 'settings'
  | 'rewindFiles'
  | 'rewindConversation'
  | 'sideQuestion'
  | 'mcpStatus'
  | 'reloadSkills';

interface Outgoing {
  kind: OutgoingKind;
  /** 何を変えようとしたか。失敗したときの文面に使う。 */
  subject: string;
  /** 成功したとき画面に残す一言。空なら残さない（別の通知で判るとき）。 */
  note: string;
}
