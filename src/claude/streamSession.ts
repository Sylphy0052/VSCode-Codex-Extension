import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ApprovalDecision } from '../appserver/approvals';
import {
  addApproval,
  appendNotice,
  enqueue,
  removeApproval,
  removeQueued,
  takeQueued,
  type ChatState,
  type PendingApproval,
} from '../appserver/chatState';
import type { LaunchTarget } from '../codex/types';
import type { Logger } from '../log';
import type { ApprovalHandlerResult } from '../orchestrator/taskSession';
import { guardStdinErrors, safeWriteStdin } from '../process/stdinSafety';
import { consumeNdjson } from '../util/ndjson';
import { buildClaudeStreamArgs } from './argvBuilder';
import {
  buildCanUseToolResponse,
  defaultDenyControlResponse,
  buildContextUsageRequest,
  buildControlRequest,
  buildControlResponse,
  buildMcpStatusRequest,
  buildRewindFilesRequest,
  buildSessionCostRequest,
  buildSetEffortRequest,
  buildSetModelRequest,
  buildSetPermissionModeRequest,
  buildStopTaskRequest,
  buildUserMessage,
  describeCanUseTool,
  readCommandList,
  readCommandsChanged,
  readContextUsage,
  readCurrentPermissionMode,
  readControlRequest,
  readControlResponse,
  readMcpServersList,
  readRewindFilesResult,
  readSessionCost,
  type ControlResponse,
  type IncomingControlRequest,
  type RewindFilesResult,
} from './control';
import type { Attachment } from '../provider/attachments';
import type { McpServerView } from '../provider/mcpServers';
import type { SlashCommand } from '../provider/slashCommands';
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
}

/**
 * `claude --print --input-format stream-json` を1会話につき1つ常駐させる。
 *
 * Codexのapp-serverと違い1プロセス1セッションなので、画面ごとにプロセスを持つ。
 * プロセスは使い回し、発言のたびに起動し直さない（文脈が切れるため）。
 */
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
   * `mcp_status` の応答待ち（design.md §16.21「ツールの可視性の確認」）。
   * `rewindWaiting` と同じ形（requestIdごとに解決関数を覚える）。
   */
  private readonly mcpStatusWaiting = new Map<
    string,
    (servers: McpServerView[] | undefined) => void
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

  /** プロセスを起動する。発言はこの後 `send` で流す。 */
  start(options: ClaudeStreamOptions): void {
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
    guardStdinErrors(proc, (e) => {
      this.log.error(`claudeへの書き込みに失敗しました: ${e.message}`);
      this.proc = undefined;
      this.update({ ...this.state, busy: false, turnFailed: true });
    });

    proc.stdout.on('data', (chunk: Buffer) => this.receive(chunk.toString('utf8')));
    proc.stderr.on('data', (chunk: Buffer) => {
      const line = chunk.toString('utf8').trim();
      if (line !== '') {
        this.log.info(`[claude] ${line.slice(0, 300)}`);
      }
    });
    proc.on('exit', (code) => {
      this.log.info(`claudeが終了しました (code ${code ?? 'unknown'})`);
      this.proc = undefined;
      // 会話の途中でプロセスが消えた形なので、続きは送れない
      this.update({ ...this.state, busy: false, turnFailed: true });
    });
    proc.on('error', (e) => {
      this.log.error(`claudeを起動できません: ${e.message}`);
      this.proc = undefined;
      this.update({ ...this.state, busy: false, turnFailed: true });
    });

    const threadId =
      options.target.kind === 'resume' ? options.target.sessionId : options.sessionId;
    this.update({
      ...initialClaudeState,
      threadId,
      items: options.initialItems ?? [],
      todos: options.initialTodos ?? initialClaudeState.todos,
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

  /** 応答を止めて、待機中の指示をすぐ送る。 */
  flushQueue(): void {
    if (this.state.queued.length === 0) {
      return;
    }
    if (this.state.busy) {
      this.interrupt();
    }
    this.sendNextQueued();
  }

  /** 待機中の先頭を送る。ターンが終わったときに呼ぶ。 */
  sendNextQueued(): void {
    const { message, next } = takeQueued(this.state);
    if (message === undefined) {
      return;
    }
    this.update(next);
    this.send(message.text, message.attachments);
  }

  interrupt(): void {
    if (this.proc === undefined) {
      return;
    }
    this.write(buildControlRequest(`req_${this.nextControlId++}`, { subtype: 'interrupt' }));
    this.update({ ...this.state, busy: false });
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
    this.write(buildControlResponse(key, buildCanUseToolResponse(decision, waiting.input)));
    this.log.info(`承認: ${waiting.approval.kind} → ${decision}`);
    this.update(removeApproval(this.state, requestId));
  }

  /**
   * stdoutの1チャンクを処理する。実際の使い手はプロセスのstdoutリスナーだが、
   * テストからも直接呼べるよう公開する（`start()` は実プロセスを起動するため、
   * 承認まわりの分岐だけを検証したいテストは `start()` を経由せずここへ直接流す）。
   */
  receive(chunk: string): void {
    this.buffer += chunk;
    const { values, rest } = consumeNdjson(this.buffer);
    this.buffer = rest;

    for (const event of values) {
      // コマンドの増減。CLIは差分ではなく一覧を押し付けてくるので入れ替える
      const changed = readCommandsChanged(event);
      if (changed !== undefined) {
        this.setCommands(changed);
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
      if (sessionCost !== undefined) {
        this.update({ ...this.state, sessionCost });
      }
      return;
    }

    if (outgoing?.kind === 'rewindFiles') {
      this.rewindWaiting.get(response.requestId)?.(readRewindFilesResult(response));
      this.rewindWaiting.delete(response.requestId);
      return;
    }

    if (outgoing?.kind === 'mcpStatus') {
      this.mcpStatusWaiting
        .get(response.requestId)
        ?.(response.ok ? readMcpServersList(response.payload) : undefined);
      this.mcpStatusWaiting.delete(response.requestId);
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

  dispose(): void {
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
    // mcp_statusの応答待ちも解放する。放置するとawaitしている側が永遠に待つ
    for (const resolve of this.mcpStatusWaiting.values()) {
      resolve(undefined);
    }
    this.mcpStatusWaiting.clear();
    this.outgoing.clear();
    this.proc?.stdin.end();
    this.proc?.kill();
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
  | 'mcpStatus';

interface Outgoing {
  kind: OutgoingKind;
  /** 何を変えようとしたか。失敗したときの文面に使う。 */
  subject: string;
  /** 成功したとき画面に残す一言。空なら残さない（別の通知で判るとき）。 */
  note: string;
}
