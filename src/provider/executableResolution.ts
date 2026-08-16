import type { LocateResult } from '../codex/cliLocator';
import type { AgentProvider } from './types';

/** `LocateResult`のうち解決に失敗した側だけを取り出した型。 */
export type LocateFailure = Extract<LocateResult, { ok: false }>;

/**
 * 解決結果からspawnへ渡す実行ファイル文字列を決める（issue #305）。
 *
 * 失敗時は`attempted`（明示指定が壊れていた場合はそのパス、指定が無くPATH探索が
 * 空振りした場合はその名前）をそのまま返す。**別のバイナリへ黙ってすり替えない**のが
 * 狙いで、明示指定のパスはスラッシュを含むため`spawn`に渡ると文字通りそのパスとして
 * 扱われ、PATH検索は行われない（Node.jsの`child_process.spawn`の仕様）。結果として
 * 誤った絶対パスの指定は、別のバイナリの起動ではなく`ENOENT`などの明確な失敗になる。
 * 指定が無い場合は、従来通りその名前（既定は`codex`/`claude`）をspawn自身のPATH解決に
 * 委ねる（この関数はその名前を返すだけで、実際のPATH検索はspawnが行う）。
 */
export function resolveSpawnPath(located: LocateResult): string {
  return located.ok ? located.path : located.attempted;
}

/**
 * 解決に失敗したときに利用者へ見せる文言。
 *
 * 含めるのは設定キー・プロバイダ名・「解決を試みたパスや名前」だけに絞る
 * （PATH全体や環境変数の中身など、無関係な環境情報は含めない）。
 */
export function formatResolutionFailureMessage(
  provider: Pick<AgentProvider, 'executableSettingKey' | 'label'>,
  located: LocateFailure,
): string {
  return located.reason === 'setting-not-executable'
    ? `${provider.executableSettingKey} が実行できません: ${located.attempted}`
    : `${located.attempted} コマンドが見つかりません。${provider.label} を導入するか ${provider.executableSettingKey} を設定してください`;
}

/**
 * 同じ失敗を重複して通知しないための識別キー。
 * 原因（`reason`）とパス/名前（`attempted`）の組が変わらない限り同じキーになる。
 */
export function resolutionFailureKey(located: LocateFailure): string {
  return `${located.reason}:${located.attempted}`;
}

/**
 * 「直前に通知した失敗と同じか」を覚えておくトラッカー（issue #305）。
 *
 * 実行ファイルのパスを解決する関数（`codexPath()` / `claudePath()`）は、CLIを呼ぶ操作の
 * たびに呼ばれる。対策が無いと同じ設定ミスについて操作ごとに通知が出て煩わしくなるため、
 * 直前に通知した失敗（原因+パス）と同じ間は再通知しない。設定が変わって別の失敗になった
 * とき、または一度解決に成功したあとに再び失敗したときは、あらためて通知する。
 */
export class ResolutionNotificationTracker {
  private lastKey: string | undefined;

  /**
   * 通知すべきなら`true`を返す。返した側は必ず通知したうえで呼び出すこと
   * （このメソッドは呼ばれた時点で「今回分は通知する/しない」を確定させる）。
   */
  shouldNotify(located: LocateResult): boolean {
    if (located.ok) {
      this.lastKey = undefined;
      return false;
    }

    const key = resolutionFailureKey(located);
    if (key === this.lastKey) {
      return false;
    }
    this.lastKey = key;
    return true;
  }
}
