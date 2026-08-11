/**
 * `child_process.spawn` した子プロセスの `stdin` まわりの安全策（issue #155）。
 *
 * `proc.on('error')` はプロセスの**起動失敗**しか拾わない。起動には成功したが相手が
 * 既に終了した状態へ書き込むと、`EPIPE` は `proc.stdin` の `error` イベントとして飛ぶ。
 * ここを誰も購読していないとNodeの未捕捉例外になり、拡張機能ホストごと落ちる。
 *
 * `stdin` を使う9箇所（`AppServerConnection` / `AppServerClient` / `ClaudeStreamSession` /
 * 各 `*Probe` / `CommandRunner`）で同じ購読・生存判定を書くと保守が崩れるため、ここへ
 * 切り出す。
 *
 * `canWriteStdin` による生存判定は書き込み前の目安に過ぎず、判定と書き込みの間に相手が
 * 終了する競合までは防げない。`guardStdinErrors` の購読と必ず併用すること。
 */

export interface StdinLike {
  readonly destroyed: boolean;
  readonly writable: boolean;
  write(chunk: string): boolean;
  on(event: 'error', listener: (error: Error) => void): void;
}

export interface StdinProcessLike {
  readonly killed: boolean;
  readonly stdin: StdinLike;
}

/** 書き込み前に相手が生きているかを見る（生存判定）。 */
export function canWriteStdin(proc: StdinProcessLike): boolean {
  return !proc.killed && !proc.stdin.destroyed && proc.stdin.writable;
}

/**
 * 生存判定を通ったときだけ `stdin` へ書き込む。
 *
 * 判定と書き込みの間の競合（判定直後に相手が終了する）までは防げないため、書き込みが
 * 実際に成功したかどうかは戻り値では分からない。失敗時の捕捉は `guardStdinErrors` に任せる。
 */
export function safeWriteStdin(proc: StdinProcessLike, chunk: string): boolean {
  if (!canWriteStdin(proc)) {
    return false;
  }
  proc.stdin.write(chunk);
  return true;
}

/**
 * `proc.stdin` の `error` を購読する。
 *
 * 呼び出し側は握り潰さず、`onError` で理由を出力パネルへ残すこと（「黙って何も起きない
 * 状態を作らない」の原則）。
 */
export function guardStdinErrors(proc: StdinProcessLike, onError: (error: Error) => void): void {
  proc.stdin.on('error', onError);
}
