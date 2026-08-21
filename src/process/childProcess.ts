/**
 * 子プロセスの生死管理として複数モジュールが必要とする共通処理をまとめる（issue #419、3点目）。
 *
 * `killWithEscalation` と `MAX_LINE_BUFFER_BYTES` は元々 `src/codex/jsonRpc.ts` にあったが、
 * `src/claude/streamSession.ts`（Claude CLIのストリーム層）も同じ処理をそのまま必要としており、
 * Codex専用のJSON-RPCコーデックへ依存させるのは筋が違う。一方で `src/util/ndjson.ts` は
 * 「`util/` を特定ドメイン（`codex/`）へ依存させない」ために `MAX_LINE_BUFFER_BYTES` を
 * 独自に複製していたが、二重定義のため片方だけ値を変えても気付けない状態になっていた。
 *
 * プロセスの生死を扱う汎用ヘルパーとして `stdinSafety.ts` の隣（`process/`）へ集約し、
 * `codex/jsonRpc.ts` / `util/ndjson.ts` / `claude/streamSession.ts` / `appserver/connection.ts`
 * はここから輸入する（再輸出はしない。輸入元をここへ付け替える）。
 */

/**
 * 改行を含まない1行分のバッファ上限（issue #402、1点目）。
 *
 * app-server/CLIは改行までbufferへ無制限に連結し続けるため、改行を含まない巨大な
 * 非JSON出力（診断ログの乱れ・バイナリ混入等）を吐き続けると際限なくメモリを消費する。
 * 一方で正常な1メッセージ（大きめの差分やbase64画像を含むツール結果など）を誤って
 * 切り捨てたくない。
 *
 * このリポジトリでは同種の「1個の塊」の上限をいずれも10MBに揃えている
 * （`src/orchestrator/worktree.ts` の `GIT_MAX_BUFFER_BYTES`、
 * `src/orchestrator/forge.ts` の `CLI_MAX_BUFFER_BYTES`、
 * `src/provider/imageRefs.ts` の `MAX_IMAGE_BYTES`、
 * `src/provider/attachments.ts` の `MAX_TOTAL_BYTES`）。1メッセージの中に
 * 最大10MBの画像が1枚含まれていても壊れないよう、同じ10MBを踏襲する。
 */
export const MAX_LINE_BUFFER_BYTES = 10 * 1024 * 1024;

/**
 * `kill()`（既定SIGTERM）を送ってからSIGKILLへエスカレーションするまでの猶予（issue #402、2点目）。
 *
 * 短すぎると正常終了処理中のプロセスも巻き込みかねず、長すぎるとハングしたプロセスの
 * 回収が遅れる。他の要求系タイムアウト（`REQUEST_TIMEOUT_MS`=120秒等）よりずっと短くてよい
 * （SIGTERM後の後始末は一瞬で終わるはずで、応答を待つ種類の待ち時間ではないため）。
 */
export const KILL_ESCALATION_DELAY_MS = 3_000;

/**
 * `kill()`/`once('exit', ...)`を持つ、子プロセスの最小限の形。
 *
 * `ChildProcessWithoutNullStreams`はこれを満たすため、実装側は何も変えずそのまま渡せる。
 * テストでは`EventEmitter`ベースのフェイクをそのまま使える。
 */
export interface KillableProcess {
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

/**
 * プロセスをSIGTERMで止め、一定時間内に`exit`が発火しなければSIGKILLへエスカレーション
 * する共通処理（issue #402、2点目）。
 *
 * 子プロセスを`spawn()`する全モジュール（`appserver/connection.ts` / `claude/streamSession.ts` /
 * `codex/appServerClient.ts` / `process/commandRunner.ts` / `claude/*Probe.ts`各種）の
 * 全`proc.kill()`呼び出しがここを経由する。ハングした子プロセス（SIGTERMに応答しない）を
 * 回収するためのもので、正常に`exit`したプロセスにはSIGKILLを送らない。
 *
 * タイマーは`unref()`し、`exit`が先に届いたら`clearTimeout`する。これによりプロセスが
 * 正常終了した後にタイマーだけがイベントループに残ることはない（自己レビュー: SIGKILL
 * タイマーの残留確認）。
 *
 * 注意: Node.jsの`ChildProcess#killed`は「シグナル送信に成功したか」を表すフラグで、
 * `kill()`を呼んだ時点で真になる（実際にexitしたかどうかは表さない）。そのため
 * ここでは`killed`を見ず、`exit`イベント自体で終了を判定する。
 *
 * タイマーの実体は`proc.once('exit', ...)`の購読より前に用意する（issue #419、2点目）。
 * `const timer = setTimeout(...)`を`proc.kill()`の後に置いたまま`once`ハンドラの
 * クロージャに`timer`を閉じ込めると、`kill()`が同期的に`exit`を発火させる実装
 * （テストのフェイクや、一部環境の即時終了）でTDZ（Temporal Dead Zone）の
 * `ReferenceError`を踏む。かといって`let timer`で先に宣言してから後で代入する形は、
 * ESLintの`prefer-const`が（TDZ回避の意図を読めず）「一度しか代入していないので
 * `const`にまとめられる」と誤検知する。オブジェクトのプロパティとして先に確保して
 * おけば、`state`自体は`const`のまま、`state.timer`だけを後から埋められる。
 */
export function killWithEscalation(proc: KillableProcess): void {
  let exited = false;
  const state: { timer: ReturnType<typeof setTimeout> | undefined } = { timer: undefined };
  proc.once('exit', () => {
    exited = true;
    if (state.timer !== undefined) {
      clearTimeout(state.timer);
    }
  });
  proc.kill();
  if (exited) {
    // `kill()`が同期的に`exit`を発火させた（上のハンドラが既に走った）場合、
    // エスカレーション用のタイマーはそもそも不要なので作らない。
    return;
  }
  state.timer = setTimeout(() => {
    if (!exited) {
      proc.kill('SIGKILL');
    }
  }, KILL_ESCALATION_DELAY_MS);
  state.timer.unref();
}
