import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ApprovalDecision } from '../appserver/approvals';
import {
  addApproval,
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
  buildControlRequest,
  buildControlResponse,
  buildUserMessage,
  describeCanUseTool,
  readControlRequest,
  readControlResponse,
  type IncomingControlRequest,
} from './control';
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
  /** 承認要求が一度でも届いたか。届かない構成を利用者へ知らせるために見る。 */
  private sawApprovalRequest = false;
  private handshakeDone = false;

  constructor(
    private readonly claudePath: () => string,
    private readonly log: Logger,
    private readonly onChange: (state: ChatState) => void,
    /** 承認要求を扱えないと判った時に一度だけ呼ぶ。 */
    private readonly onApprovalUnavailable: () => void = () => undefined,
  ) {}

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
    });

    this.initializeControl();
  }

  /**
   * 承認要求を受け取れることをCLIへ伝える。
   * 応答が返らない/失敗しても会話は続けられるため、握り潰してログに残すだけにする。
   */
  private initializeControl(): void {
    const requestId = `req_${this.nextControlId++}`;
    this.write(buildControlRequest(requestId, { subtype: 'initialize', hooks: {} }));
  }

  send(text: string): void {
    if (this.proc === undefined) {
      throw new Error('セッションが起動していません');
    }
    this.update({ ...this.state, busy: true, turnFailed: false });
    this.write(buildUserMessage(text));
  }

  /** 発言を送る。応答中なら待ち行列へ積む。 */
  sendOrQueue(text: string): 'sent' | 'queued' {
    if (this.state.busy) {
      this.update(enqueue(this.state, text));
      return 'queued';
    }
    this.send(text);
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
    const { text, next } = takeQueued(this.state);
    if (text === undefined) {
      return;
    }
    this.update(next);
    this.send(text);
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

      const next = applyStreamEvent(this.state, event);
      if (next !== this.state) {
        this.update(next);
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

  private handleControlResponse(response: ControlResponseLike): void {
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
    }
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
    this.proc?.stdin.end();
    this.proc?.kill();
    this.proc = undefined;
    this.buffer = '';
  }
}

interface ControlResponseLike {
  ok: boolean;
  error: string | undefined;
}
