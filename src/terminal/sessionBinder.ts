import { sessionIdFromRolloutName } from '../codex/sessionMeta';
import type { SessionMeta } from '../codex/types';

export interface BindSuccess {
  tag: string;
  sessionId: string;
  cwd: string;
}

/**
 * 起動した端末と session_id を確定的に紐付ける。
 *
 * 起動時に一意タグを `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` として渡してあるため、
 * ロールアウト1行目の `originator` がそのタグと一致するかを見るだけでよい。
 * 時刻やcwdによる推測を行わないので誤紐付けが起きず、複数タブの同時起動も安全。
 *
 * 待ち時間に上限は設けない。CodexのTUIはプロセス起動時ではなく
 * **最初のユーザー発言時**にロールアウトを作るため（実機検証で確認）、
 * ユーザーが話しかけるまで何分でも紐付かないのが正常な状態。
 * 待ちの寿命は端末の寿命に一致させ、端末が閉じたら cancel() で取り下げる。
 */
export class SessionBinder {
  private readonly pending = new Set<string>();

  /** 端末を起動した直後に呼ぶ。 */
  register(tag: string): void {
    this.pending.add(tag);
  }

  /** 紐付けを待つのをやめる（端末が閉じられた等）。 */
  cancel(tag: string): void {
    this.pending.delete(tag);
  }

  pendingTags(): string[] {
    return [...this.pending];
  }

  /**
   * ロールアウトファイルの新規作成を受け取り、自分が起動したものなら紐付けを確定する。
   * 自分のタグでなければ undefined を返す（他プロセスのセッションを掴まない）。
   */
  onRolloutCreated(fileName: string, meta: SessionMeta | undefined): BindSuccess | undefined {
    if (meta?.originator === undefined || !this.pending.has(meta.originator)) {
      return undefined;
    }

    // ファイル名のidと session_meta のidは一致するはず。食い違う場合は信用しない。
    const idFromName = sessionIdFromRolloutName(fileName);
    if (idFromName !== undefined && idFromName !== meta.sessionId) {
      return undefined;
    }

    const tag = meta.originator;
    this.pending.delete(tag);
    return { tag, sessionId: meta.sessionId, cwd: meta.cwd };
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
