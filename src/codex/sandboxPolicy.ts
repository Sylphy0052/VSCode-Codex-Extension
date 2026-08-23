import { isAbsolute } from 'node:path';
import { SANDBOX_MODES } from './types';

/**
 * `turn/start` へ載せるサンドボックスの指定。
 *
 * `thread/start` は文字列（`read-only` など）を取るが、ターン単位の指定は
 * `SandboxPolicy` というタグ付きunionのオブジェクトになる。形が違うだけで、
 * 指定できる内容は同じ（app-serverのスキーマで確認）。
 */

/** `workspaceWrite` にだけ効く追加指定。 */
export interface SandboxOptions {
  /** 作業フォルダの外で書き込みを許す場所。絶対パスのみ。 */
  writableRoots: readonly string[];
  /** ネットワークへ出られるか。 */
  networkAccess: boolean;
}

/**
 * VSCode設定の文字列を `SandboxPolicy` に変換する。
 *
 * 空文字と知らない値では `undefined` を返す。呼び出し側は `turn/start` に載せず、
 * スレッド開始時（= CLIのconfig.toml）の指定をそのまま効かせること。
 *
 * 省略した項目はapp-server側の既定になる（`writableRoots: []` / `networkAccess: false` /
 * `excludeSlashTmp: false` / `excludeTmpdirEnvVar: false`）。これは `thread/start` に
 * `sandbox: 'workspace-write'` を渡したときの実効値と同じ形。
 */
export function sandboxPolicyFor(
  sandbox: string,
  options?: SandboxOptions,
): Record<string, unknown> | undefined {
  switch (sandbox) {
    case 'read-only':
      return { type: 'readOnly' };
    case 'danger-full-access':
      return { type: 'dangerFullAccess' };
    case 'workspace-write': {
      const policy: Record<string, unknown> = { type: 'workspaceWrite' };
      // 相対パスはapp-serverが受け付けない（AbsolutePathBuf）。黙って落とす
      const roots = (options?.writableRoots ?? []).filter(
        (root) => root !== '' && isAbsolute(root),
      );
      if (roots.length > 0) {
        policy['writableRoots'] = [...roots];
      }
      if (options?.networkAccess === true) {
        policy['networkAccess'] = true;
      }
      return policy;
    }
    default:
      return undefined;
  }
}

/**
 * サンドボックスを張らない指定（issue #222）。
 *
 * `--dangerously-bypass-approvals-and-sandbox` のサンドボックス側にあたる。CLIのヘルプが
 * 言う「外側で隔離済みの環境向け」が、スキーマ上の `externalSandbox` に対応する
 * （`codex app-server generate-json-schema` の `SandboxPolicy` で実測）。承認側は
 * `approvalPolicy: never` と組にして初めてフラグ1枚と同じ意味になる。
 *
 * `sandboxPolicyFor` からは返さない。設定の文字列（`SANDBOX_MODES`）に対応する値ではなく、
 * 別軸の真偽値から作るものなので、経路を分けて取り違えを防ぐ。
 */
export function bypassSandboxPolicy(): Record<string, unknown> {
  return { type: 'externalSandbox' };
}

/**
 * サンドボックスの変更が権限を**広げる**方向か。
 *
 * `SANDBOX_MODES` の宣言順がそのまま安全順になっている。広げる変更には確認を挟む。
 * 変更後が空文字（CLIへ委譲）の場合は、何が効くかを拡張機能側では決められないため
 * 確認しない。変更前が空文字の場合は、いま何が効いているか判らないので
 * **読み取り専用以外への変更を確認対象にする**（安全側に倒す）。
 */
export function isSandboxRelaxed(from: string, to: string): boolean {
  const toRank = SANDBOX_MODES.indexOf(to as (typeof SANDBOX_MODES)[number]);
  if (toRank === -1) {
    return false;
  }
  const fromRank = SANDBOX_MODES.indexOf(from as (typeof SANDBOX_MODES)[number]);
  return fromRank === -1 ? toRank > 0 : toRank > fromRank;
}
