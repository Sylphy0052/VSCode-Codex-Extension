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
import { consumeNdjson } from '../util/ndjson';
import { buildClaudeStreamArgs } from './argvBuilder';
import {
  buildCanUseToolResponse,
  defaultDenyControlResponse,
  buildContextUsageRequest,
  buildControlRequest,
  buildControlResponse,
  buildSetEffortRequest,
  buildSetModelRequest,
  buildSetPermissionModeRequest,
  buildUserMessage,
  describeCanUseTool,
  readCommandList,
  readCommandsChanged,
  readContextUsage,
  readCurrentPermissionMode,
  readControlRequest,
  readControlResponse,
  type ControlResponse,
  type IncomingControlRequest,
} from './control';
import type { Attachment } from '../provider/attachments';
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

  constructor(
    private readonly claudePath: () => string,
    private readonly log: Logger,
    private readonly onChange: (state: ChatState) => void,
    /** 承認要求を扱えないと判った時に一度だけ呼ぶ。 */
    private readonly onApprovalUnavailable: () => void = () => undefined,
    /** 使えるコマンドが判った時と、途中で増減した時に呼ぶ。 */
    private readonly onCommands: (commands: readonly SlashCommand[]) => void = () => undefined,
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

    const proc = spawn(this.claudePath(), args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;

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

  private receive(chunk: string): void {
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

    this.waiting.set(request.requestId, {
      approval,
      input: (request.payload['input'] as Record<string, unknown> | undefined) ?? {},
    });
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

  private write(line: string): void {
    this.proc?.stdin.write(line);
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
    this.outgoing.clear();
    this.proc?.stdin.end();
    this.proc?.kill();
    this.proc = undefined;
    this.buffer = '';
  }
}

/** こちらから出した制御要求の用途。 */
type OutgoingKind = 'initialize' | 'contextUsage' | 'settings';

interface Outgoing {
  kind: OutgoingKind;
  /** 何を変えようとしたか。失敗したときの文面に使う。 */
  subject: string;
  /** 成功したとき画面に残す一言。空なら残さない（別の通知で判るとき）。 */
  note: string;
}
