import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Logger } from '../log';
import type { SessionActivityState } from './sessionActivity';

/**
 * このPCで開いている全VS Codeウィンドウのセッションを1画面で統括する
 * （Issue #1244）。ウィンドウごとの拡張ホストは別プロセスで、`globalState`は
 * ウィンドウ間で変更通知が飛ばないため、共有ファイル＋監視で集約する。
 *
 * 共有ディレクトリは拡張機能の`globalStorageUri`配下に置く。`~/.codex` /
 * `~/.claude`とは別にすることで、CLI側の領域を汚さない（確認点1への回答）。
 */

/** 1ウィンドウ分の、共有ファイルへ書き出すセッション情報。会話本文は含めない（タイトルとcwdまで）。 */
export interface SharedSession {
  threadId: string;
  title: string;
  cwd: string | undefined;
  provider: 'codex' | 'claude';
  activity: SessionActivityState;
}

interface SharedSessionFile {
  windowId: string;
  updatedAt: number;
  sessions: SharedSession[];
}

/** 読み込み側が扱う、他ウィンドウ1つ分のスナップショット。 */
export interface SharedWindowSessions {
  windowId: string;
  updatedAt: number;
  sessions: SharedSession[];
}

/** heartbeatの間隔。状態変化時はこれを待たず都度書く。 */
const HEARTBEAT_MS = 15_000;
/** これを超えて`updatedAt`が更新されていないウィンドウは、落ちたものとして除外する。 */
const STALE_MS = 30_000;

export function generateWindowId(): string {
  return randomUUID();
}

export function sessionHubRoot(globalStorageDir: string): string {
  return path.join(globalStorageDir, 'session-hub');
}

function sessionsDir(root: string): string {
  return path.join(root, 'sessions');
}

function requestsDir(root: string): string {
  return path.join(root, 'requests');
}

/** 書き込みは常に一時ファイル→`rename`で行う。読み手が書きかけの内容を拾わないようにする。 */
async function writeAtomic(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, filePath);
}

/** 自ウィンドウのセッション一覧を共有ファイルへ書く。 */
export class SessionHubWriter {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly filePath: string;

  constructor(
    private readonly root: string,
    private readonly windowId: string,
    private readonly getSessions: () => readonly SharedSession[],
    private readonly log: Logger,
  ) {
    this.filePath = path.join(sessionsDir(this.root), `${this.windowId}.json`);
  }

  start(): void {
    void this.write();
    this.timer = setInterval(() => void this.write(), HEARTBEAT_MS);
  }

  async write(): Promise<void> {
    const payload: SharedSessionFile = {
      windowId: this.windowId,
      updatedAt: Date.now(),
      sessions: [...this.getSessions()],
    };
    try {
      await mkdir(sessionsDir(this.root), { recursive: true });
      await writeAtomic(this.filePath, JSON.stringify(payload));
    } catch (e) {
      this.log.warn(`セッション統括: 共有ファイルの書き込みに失敗しました: ${String(e)}`);
    }
  }

  /** 拡張機能の終了時（`deactivate`）に呼ぶ。消せなくてもheartbeat失効で自然に除外される。 */
  async dispose(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    try {
      await unlink(this.filePath);
    } catch {
      // 既に無い・消せない場合もheartbeat失効に委ねる
    }
  }
}

/** 全ウィンドウの共有ファイルを読み、`fs.watch`で追従する。 */
export class SessionHubReader implements vscode.Disposable {
  private cache: SharedWindowSessions[] = [];
  private watcher: FSWatcher | undefined;
  private readonly emitter = new vscode.EventEmitter<void>();
  /** 他ウィンドウの一覧が変わったとき。呼び出し側は`getOthers()`を読み直して再描画する。 */
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly root: string,
    private readonly selfWindowId: string,
    private readonly log: Logger,
  ) {}

  start(): void {
    void this.reload();
    void mkdir(sessionsDir(this.root), { recursive: true })
      .then(() => {
        this.watcher = watch(sessionsDir(this.root), () => void this.reload());
      })
      .catch((e: unknown) => {
        this.log.warn(`セッション統括: 共有ディレクトリの監視開始に失敗しました: ${String(e)}`);
      });
  }

  /** 直近に読み込んだ、自分以外のウィンドウのセッション一覧（同期・キャッシュ値）。 */
  getOthers(): readonly SharedWindowSessions[] {
    return this.cache;
  }

  private async reload(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(sessionsDir(this.root));
    } catch {
      this.cache = [];
      this.emitter.fire();
      return;
    }
    const now = Date.now();
    const results: SharedWindowSessions[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const windowId = name.slice(0, -'.json'.length);
      if (windowId === this.selfWindowId) {
        continue;
      }
      try {
        const raw = await readFile(path.join(sessionsDir(this.root), name), 'utf8');
        const parsed = JSON.parse(raw) as SharedSessionFile;
        if (now - parsed.updatedAt > STALE_MS) {
          continue;
        }
        results.push(parsed);
      } catch {
        // 書き込み途中・破損したファイルは無視する（次のheartbeatで直る）
        continue;
      }
    }
    this.cache = results;
    this.emitter.fire();
  }

  dispose(): void {
    this.watcher?.close();
    this.emitter.dispose();
  }
}

/** カードのクリックで開くタブの要求。 */
export interface SessionOpenRequest {
  provider: 'codex' | 'claude';
  threadId: string;
}

/** 別ウィンドウへ「このセッションを開け」と要求する送信口。 */
export class SessionHubRequestPort {
  constructor(
    private readonly root: string,
    private readonly log: Logger,
  ) {}

  async send(targetWindowId: string, request: SessionOpenRequest): Promise<void> {
    try {
      await mkdir(requestsDir(this.root), { recursive: true });
      const filePath = path.join(requestsDir(this.root), `${targetWindowId}.json`);
      await writeAtomic(filePath, JSON.stringify(request));
    } catch (e) {
      this.log.warn(`セッション統括: タブを開く要求の送信に失敗しました: ${String(e)}`);
    }
  }
}

/** 自ウィンドウ宛ての要求ファイルを監視し、届いたら`onRequest`へ渡す。 */
export class SessionHubRequestWatcher implements vscode.Disposable {
  private watcher: FSWatcher | undefined;
  private readonly filePath: string;

  constructor(
    private readonly root: string,
    windowId: string,
    private readonly onRequest: (request: SessionOpenRequest) => void,
    private readonly log: Logger,
  ) {
    this.filePath = path.join(requestsDir(this.root), `${windowId}.json`);
  }

  start(): void {
    void mkdir(requestsDir(this.root), { recursive: true })
      .then(() => {
        // 監視を始める前に届いていた分も拾う
        void this.handle();
        this.watcher = watch(requestsDir(this.root), (_event, filename) => {
          // 一部プラットフォームは`filename`を返さない。自分宛てと確証が持てないときは
          // 常に確認する（`handle`自体は該当ファイルが無ければ何もしない）
          if (filename === undefined || filename === path.basename(this.filePath)) {
            void this.handle();
          }
        });
      })
      .catch((e: unknown) => {
        this.log.warn(`セッション統括: 要求の監視開始に失敗しました: ${String(e)}`);
      });
  }

  private async handle(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch {
      return;
    }
    try {
      await unlink(this.filePath);
    } catch {
      // 消せなくても`reveal`は冪等なので、二重処理になっても実害は無い
    }
    try {
      const request = JSON.parse(raw) as SessionOpenRequest;
      if (
        (request.provider === 'codex' || request.provider === 'claude') &&
        typeof request.threadId === 'string'
      ) {
        this.onRequest(request);
      }
    } catch (e) {
      this.log.warn(`セッション統括: 要求の解析に失敗しました: ${String(e)}`);
    }
  }

  dispose(): void {
    this.watcher?.close();
  }
}
