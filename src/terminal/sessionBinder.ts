import { sessionIdFromRolloutName } from '../codex/sessionMeta';
import type { SessionMeta } from '../codex/types';
import type { Clock } from '../util/clock';

export interface BindSuccess {
  tag: string;
  sessionId: string;
  cwd: string;
}

export interface PendingLaunch {
  tag: string;
  startedAt: number;
}

/** タイムアウト既定値。起動失敗をいつまでも待たないための上限（設計書 §9.1）。 */
export const DEFAULT_BIND_TIMEOUT_MS = 15_000;

/**
 * 起動した端末と session_id を確定的に紐付ける。
 *
 * 起動時に一意タグを `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` として渡してあるため、
 * ロールアウト1行目の `originator` がそのタグと一致するかを見るだけでよい。
 * 時刻やcwdによる推測を行わないので誤紐付けが起きず、複数タブの同時起動も安全。
 */
export class SessionBinder {
  private readonly pending = new Map<string, PendingLaunch>();

  constructor(
    private readonly clock: Clock,
    private readonly timeoutMs: number = DEFAULT_BIND_TIMEOUT_MS,
  ) {}

  /** 端末を起動した直後に呼ぶ。 */
  register(tag: string): void {
    this.pending.set(tag, { tag, startedAt: this.clock.now() });
  }

  /** 紐付けを待つのをやめる（端末が閉じられた等）。 */
  cancel(tag: string): void {
    this.pending.delete(tag);
  }

  pendingTags(): string[] {
    return [...this.pending.keys()];
  }

  /**
   * ロールアウトファイルの新規作成を受け取り、自分が起動したものなら紐付けを確定する。
   * 自分のタグでなければ undefined を返す（他プロセスのセッションを掴まない）。
   */
  onRolloutCreated(fileName: string, meta: SessionMeta | undefined): BindSuccess | undefined {
    if (meta?.originator === undefined) {
      return undefined;
    }

    const pending = this.pending.get(meta.originator);
    if (pending === undefined) {
      return undefined;
    }

    // ファイル名のidと session_meta のidは一致するはず。食い違う場合は信用しない。
    const idFromName = sessionIdFromRolloutName(fileName);
    if (idFromName !== undefined && idFromName !== meta.sessionId) {
      return undefined;
    }

    this.pending.delete(pending.tag);
    return { tag: pending.tag, sessionId: meta.sessionId, cwd: meta.cwd };
  }

  /**
   * 期限切れの待ちを回収する。返ったタグの端末は「未追跡」として扱い、
   * 復元対象から外す（誤ったIDを記憶するより安全）。
   */
  sweep(): string[] {
    const now = this.clock.now();
    const expired: string[] = [];
    for (const [tag, launch] of this.pending) {
      if (now - launch.startedAt >= this.timeoutMs) {
        expired.push(tag);
      }
    }
    for (const tag of expired) {
      this.pending.delete(tag);
    }
    return expired;
  }
}

let counter = 0;

/**
 * 起動タグを作る。プロセス内で一意であれば足りるため乱数には依存しない
 * （テストの再現性を保つ）。
 */
export function createLaunchTag(prefix = 'vscode-codex'): string {
  counter += 1;
  return `${prefix}-${process.pid}-${counter}`;
}
