import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Logger } from '../log';
import { killWithEscalation, type KillableProcess } from '../process/childProcess';
import { inspectReadOnlyCwd, type ReadOnlyCwdInspection } from './sandboxReadDeny';

/**
 * Claude CLIのsandbox（Issue #1541）。オーケストレータモードとロードマップ実行のセッションに限り、
 * Bashの書き込み先をOSのsandbox（Linux・WSL2はbubblewrap）で制限し、その内側で済むコマンドを
 * 承認ダイアログなしで通す。コマンド文字列を解析して読み取り専用かを判定する方式（#1536）は、
 * 作業ディレクトリの設定ファイルを経由した書き込みや実行を閉じきれず取り消した（#1537）。
 *
 * - `read-only`: 作業ディレクトリへの書き込みも塞ぐ（Orchestrator、worktreeを持たない工程）
 * - `workspace-write`: 作業ディレクトリ（worktree）への書き込みを許す（worktreeで動く工程）
 */
export type ClaudeSandboxMode = 'read-only' | 'workspace-write';

/**
 * sandboxの外（通常の承認フロー）へ回すコマンド。ネットワークを要するコマンドを想定する。
 *
 * sandbox内のネットワークは`strictAllowlist`で全て拒否するため、ここに無いコマンドは
 * sandbox内で接続に失敗する。ここに載ったコマンドはsandbox外で走り、従来どおり
 * `can_use_tool`で拡張機能の承認判定（mergeとリモートブランチの削除を人へ回す判定を含む）を
 * 通る。載せても自動で通るようにはならず、承認へ回る範囲が広がるだけなので、安全側の一覧になる。
 *
 * 一致の判定はCLIの内部実装（パターンをコマンド文字列全体に当てるのか、分解した各コマンドに
 * 当てるのか）に依存する。`bash -c "gh pr merge 1"`のような合成コマンドは`gh *`に一致せず、
 * sandbox内で走る可能性がある（Issue #1545）。その場合も`network.strictAllowlist`が接続を
 * 拒否するため、mergeやリモートブランチの削除が承認を経ずに成功することはない（fail-closed）。
 *
 * CLIの版を上げたときは、sandbox付きのセッション（オーケストレータモード）で次を確かめる。
 * 1. `bash -c "gh pr view <番号>"`と`sh -c "git push --dry-run origin HEAD"`を実行させる
 * 2. どちらも承認の確認が届く（sandbox外へ回った）か、承認なしで接続に失敗して終わる
 *    （sandbox内で拒否された）ことを確かめる。承認なしで接続に成功したら、sandboxの外へ
 *    漏れているので、この一覧と`network`の設定を見直すまでその版を使わない
 *
 * 一致しない形（連結、`git -C <dir> push`など）で打たれたものは、実行前に
 * `sandboxBashGuard.ts`が拒否して打ち直させる（Issue #1668）。
 */
export const EXCLUDED_COMMANDS: readonly string[] = [
  'gh *',
  'glab *',
  'git push *',
  'git fetch *',
  'git pull *',
  'git ls-remote *',
  'git clone *',
  'curl *',
  'wget *',
  'npm install *',
  'npm ci *',
  'pip install *',
  // sandboxと両立しない（公式ドキュメントのトラブルシューティング）
  'docker *',
];

/** bubblewrapの試し起動の時間上限。名前空間を作れないときは即座に失敗するので短くてよい。 */
const BWRAP_TIMEOUT_MS = 10_000;

/** sandbox付きでCLIを空起動する確認の時間上限。実測1.4秒（CLI 2.1.280、`--bare`）。 */
const CLI_PREFLIGHT_TIMEOUT_MS = 30_000;

/** ログへ残す失敗理由の長さの上限。 */
const MAX_REASON_LENGTH = 300;

/** 空起動のstderrを溜める上限。空白を詰めてから{@link MAX_REASON_LENGTH}で切るため、多めに持つ。 */
const MAX_STDERR_LENGTH = MAX_REASON_LENGTH * 4;

export interface ClaudeSandboxEnvironment {
  /**
   * `sandbox.enableWeakerNestedSandbox`を付けるか。コンテナ内では`/proc`を新しくmountできず
   * （`Can't mount proc on /newroot/proc`）、付けないとsandbox内のコマンドが全て失敗する。
   * 外側のコンテナが隔離を担う前提で弱めるため、コンテナ内と判定できたときだけ付ける。
   */
  weakerNested: boolean;
}

export type ClaudeSandboxAvailability =
  | { ok: true; environment: ClaudeSandboxEnvironment }
  | { ok: false; reason: string };

/**
 * `--settings`へ渡すsandboxの設定を組み立てる。
 *
 * `failIfUnavailable`は、確認後に依存が消えた場合などに黙ってsandbox無しで走らせないため。
 * `allowUnsandboxedCommands: false`で、sandboxで失敗したコマンドをCLIがsandbox外で
 * 再実行する経路（`dangerouslyDisableSandbox`）を閉じる。
 */
export function buildClaudeSandboxSettings(
  mode: ClaudeSandboxMode,
  cwd: string,
  environment: ClaudeSandboxEnvironment,
): Record<string, unknown> {
  return {
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      excludedCommands: [...EXCLUDED_COMMANDS],
      // 既定では許可されていない接続先へ繋ぐたびに承認（`SandboxNetworkAccess`）が届く。
      // これは接続先のホストしか持たず、コマンドの中身（`gh pr merge`など）を見る承認判定を
      // 素通りさせるため、sandbox内の接続は全て拒否し、ネットワークを要するコマンドは
      // `excludedCommands`経由で通常の承認へ回す
      network: { strictAllowlist: true, allowedDomains: [] },
      // 作業ディレクトリは既定で書き込めるため、読み取り専用のセッションでは明示的に塞ぐ
      // （CLI 2.1.280で、denyWriteが既定の書き込み許可より優先されることを実測）。
      // 作業ディレクトリ配下にRead denyへ一致するディレクトリがあるとBashが全て失敗するため、
      // その場合は起動前に`ClaudeSandboxProbe.checkCwd`がsandboxを外す（Issue #1630）
      ...(mode === 'read-only' ? { filesystem: { denyWrite: [cwd] } } : {}),
      ...(environment.weakerNested ? { enableWeakerNestedSandbox: true } : {}),
    },
  };
}

/**
 * sandbox付きのセッションへ`--append-system-prompt`で伝える指示（Issue #1610）。
 *
 * `excludedCommands`は単独のコマンドにしか一致せず、`gh issue view 1 2>&1; echo ---`のように
 * 連結するとsandbox内で走る。sandbox内では利用者のRead denyがdenyReadへ反映されて認証情報を
 * 読めず、ネットワークも拒否されるため、`gh auth login`を促す未認証エラーで失敗する。
 * 認証情報をsandboxへ渡すと承認なしのコマンドから読み出せてしまうので、連結させない側で塞ぐ。
 *
 * 一致はコマンドの先頭で見るため、`git -C <dir> push`も`git push *`に一致せずsandbox内で走る
 * （Issue #1666）。`git -C *`を除外へ足すとローカルのgit操作まで承認へ回るので、指示で塞ぐ。
 * 指示が守られなかった場合は、`sandboxBashGuard.ts`のPreToolUse hookが実行前に拒否する（Issue #1668）。
 *
 * 引数のコマンド置換（`--description "$(cat <<'EOF' …)"`）も、CLIが置換を別のコマンドとして
 * 扱うため除外に一致しない（Issue #1672）。本文はファイル経由で渡させる。
 */
export function buildClaudeSandboxPrompt(): string {
  const commands = EXCLUDED_COMMANDS.map((pattern) => pattern.replace(/ \*$/, '')).join(' / ');
  return [
    'Bashのコマンドはsandbox内で走り、ネットワークと認証情報を使えない。',
    `次のコマンドは、単独で実行したときだけsandboxの外で走る: ${commands}。`,
    'これらは1回のBash呼び出しに1つだけ書き、;、&&、||、パイプで他のコマンドと連結しない。',
    '前にcdも付けず、git -C <dir> pushのようにgitとサブコマンドの間へ引数も挟まない。作業ディレクトリでそのまま打つ。',
    '引数にコマンド置換（$(…)、バッククォート、"$(cat <<EOF …)"）も使わない。PR/MRやIssueの本文は先にWriteツールでファイルへ書き、gh ... --body-file <path>、glab api ... --field description=@<path>のようにファイルから渡す。',
    'これらが認証やネットワークのエラーで失敗したら、使えないと判断する前に単独で打ち直す。',
  ].join('\n');
}

/**
 * `ClaudeConfig.additionalArgs`へ足す引数。
 *
 * `--append-system-prompt`は複数渡すと最後の1つだけが効く（CLI 2.1.280で実測）。タスク
 * セッションの`additionalArgs`は拡張機能だけが組むため（`toClaudeConfig`）、ここで1回だけ渡す。
 */
export function claudeSandboxArgs(
  mode: ClaudeSandboxMode,
  cwd: string,
  environment: ClaudeSandboxEnvironment,
): string[] {
  return [
    '--settings',
    JSON.stringify(buildClaudeSandboxSettings(mode, cwd, environment)),
    '--append-system-prompt',
    buildClaudeSandboxPrompt(),
  ];
}

/** 外部コマンドの実行結果。テストから差し替える。 */
export interface SandboxCommandResult {
  ok: boolean;
  /** 失敗時の説明（stderrの先頭、または起動エラー）。 */
  detail: string;
}

export interface ClaudeSandboxProbePorts {
  platform: NodeJS.Platform;
  /** コンテナ内で動いているか。 */
  inContainer: () => boolean;
  /**
   * bubblewrapを試し起動する。`withProc`が偽なら`/proc`をmountしない。
   * `signal`が中止されたら、起動した子プロセスを止める（以下同じ）。
   */
  tryBwrap: (withProc: boolean, signal: AbortSignal) => Promise<SandboxCommandResult>;
  /** sandboxの設定を付けてCLIを空起動し、正常に終わるかを見る。 */
  tryCli: (settingsJson: string, signal: AbortSignal) => Promise<SandboxCommandResult>;
  /** 読み取り専用のsandboxを`cwd`へ付けられるかを見る（Issue #1630）。 */
  inspectReadOnlyCwd: (cwd: string, signal: AbortSignal) => Promise<ReadOnlyCwdInspection>;
}

/** 確認を中止したときの理由。 */
const ABORTED_REASON = '拡張機能の終了により確認を中止しました';

/**
 * `signal`の中止で子プロセスを止める（Issue #1545）。戻り値は購読を外す関数で、子プロセスが
 * 終わったら呼ぶ。
 */
function stopOnAbort(proc: KillableProcess, signal: AbortSignal): () => void {
  const stop = (): void => {
    killWithEscalation(proc);
  };
  if (signal.aborted) {
    stop();
    return () => undefined;
  }
  signal.addEventListener('abort', stop, { once: true });
  return () => {
    signal.removeEventListener('abort', stop);
  };
}

function truncateReason(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > MAX_REASON_LENGTH ? `${trimmed.slice(0, MAX_REASON_LENGTH)}…` : trimmed;
}

/** Docker・Podman・devcontainerが置く目印で判定する。 */
export function detectContainer(): boolean {
  return (
    existsSync('/.dockerenv') ||
    existsSync('/run/.containerenv') ||
    (process.env['container'] ?? '') !== '' ||
    (process.env['REMOTE_CONTAINERS'] ?? '') !== ''
  );
}

function tryBwrap(withProc: boolean, signal: AbortSignal): Promise<SandboxCommandResult> {
  // CLIが組むsandboxと同じく全ての名前空間を分ける。パッケージがあっても、seccompや
  // AppArmorの既定プロファイルで名前空間を作れない環境がある（#1541の実機確認）
  const args = [
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    ...(withProc ? ['--proc', '/proc'] : []),
    '--unshare-all',
    '--die-with-parent',
    'true',
  ];
  return new Promise((resolve) => {
    const proc = execFile('bwrap', args, { timeout: BWRAP_TIMEOUT_MS }, (error, _stdout, stderr) => {
      release();
      resolve(
        error === null ? { ok: true, detail: '' } : { ok: false, detail: stderr || error.message },
      );
    });
    const release = stopOnAbort(proc, signal);
  });
}

function tryCli(
  claudePath: string,
  settingsJson: string,
  signal: AbortSignal,
): Promise<SandboxCommandResult> {
  // 入力を与えずに起動すると、sandboxの確認を済ませた後にAPIを呼ばず終了する。依存が
  // 足りなければ`failIfUnavailable`で非0終了する（CLI 2.1.280で実測）。`--bare`は利用者の
  // hookを走らせないため、`--no-session-persistence`はtranscriptを残さないため
  const args = [
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--bare',
    '--no-session-persistence',
    '--settings',
    settingsJson,
  ];
  return new Promise((resolve) => {
    let stderr = '';
    let settled = false;
    // 作業ディレクトリに依らない確認なので、拡張ホストのcwd（`/`になりうる）ではなく一時領域で起動する
    const proc = spawn(claudePath, args, { cwd: tmpdir(), stdio: ['ignore', 'ignore', 'pipe'] });
    const release = stopOnAbort(proc, signal);
    const finish = (result: SandboxCommandResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      release();
      resolve(result);
    };
    const timer = setTimeout(() => {
      killWithEscalation(proc);
      finish({ ok: false, detail: `${String(CLI_PREFLIGHT_TIMEOUT_MS)}ms以内に終了しませんでした` });
    }, CLI_PREFLIGHT_TIMEOUT_MS);
    // 確認の途中でも拡張ホストの終了を引き留めない
    timer.unref();
    proc.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_LENGTH) {
        stderr += chunk.toString('utf8');
      }
    });
    proc.on('error', (e) => {
      finish({ ok: false, detail: e.message });
    });
    proc.on('exit', (code) => {
      finish(
        code === 0
          ? { ok: true, detail: '' }
          : { ok: false, detail: stderr || `exit code ${String(code)}` },
      );
    });
  });
}

export function nodeSandboxProbePorts(claudePath: () => string): ClaudeSandboxProbePorts {
  return {
    platform: process.platform,
    inContainer: detectContainer,
    tryBwrap,
    tryCli: (settingsJson, signal) => tryCli(claudePath(), settingsJson, signal),
    inspectReadOnlyCwd: (cwd, signal) => inspectReadOnlyCwd(claudePath(), cwd, signal),
  };
}

/**
 * sandboxを使えるかを確かめる。
 *
 * 1. Linuxではbubblewrapを試し起動する。`/proc`付きで失敗し、コンテナ内で`/proc`無しなら
 *    通る場合は`enableWeakerNestedSandbox`を付ける
 * 2. sandboxの設定を付けてCLIを空起動する。`socat`の欠如など、CLI自身が見る依存の不足は
 *    ここで`failIfUnavailable`により失敗する
 *
 * 2.は「`failIfUnavailable`で起動に失敗したら、sandbox無しで起動し直す」を、セッションを
 * 起動する前に済ませる形にしたもの。起動後に失敗を拾って起動し直すと、最初の発言が
 * 失われたセッションの後始末が要る。
 *
 * `signal`が中止されたら、次の段の子プロセスを起動せずに打ち切る。
 */
export async function probeClaudeSandbox(
  ports: ClaudeSandboxProbePorts,
  signal: AbortSignal = new AbortController().signal,
): Promise<ClaudeSandboxAvailability> {
  if (ports.platform === 'win32') {
    return { ok: false, reason: 'Windowsではsandboxを使えません' };
  }
  const aborted: ClaudeSandboxAvailability = { ok: false, reason: ABORTED_REASON };
  let weakerNested = false;
  if (ports.platform === 'linux') {
    if (signal.aborted) {
      return aborted;
    }
    const full = await ports.tryBwrap(true, signal);
    if (!full.ok) {
      if (signal.aborted) {
        return aborted;
      }
      if (!ports.inContainer()) {
        return { ok: false, reason: `bubblewrapを起動できません: ${truncateReason(full.detail)}` };
      }
      const nested = await ports.tryBwrap(false, signal);
      if (!nested.ok) {
        return {
          ok: false,
          reason: `bubblewrapを起動できません（コンテナ内）: ${truncateReason(nested.detail)}`,
        };
      }
      weakerNested = true;
    }
  }
  const environment: ClaudeSandboxEnvironment = { weakerNested };
  // 依存の確認に作業ディレクトリは関わらないため、書き込みを塞がない形で確かめる。
  // `read-only`だけが足す`filesystem.denyWrite`（絶対パス1つ）は、CLI 2.1.280で受理される
  // ことを実測済みで、ここで確かめなくても起動を妨げない。作業ディレクトリの中身次第で
  // 失敗する場合は`ClaudeSandboxProbe.checkCwd`が別に確かめる（Issue #1630）
  const settings = JSON.stringify(buildClaudeSandboxSettings('workspace-write', '', environment));
  if (signal.aborted) {
    return aborted;
  }
  const cli = await ports.tryCli(settings, signal);
  if (signal.aborted) {
    return aborted;
  }
  if (!cli.ok) {
    return { ok: false, reason: `sandbox付きでclaudeを起動できません: ${truncateReason(cli.detail)}` };
  }
  return { ok: true, environment };
}

/**
 * 確認結果を拡張ホストの間だけ覚える。使えると判った結果は使い回し、使えなかった結果は
 * 覚えない（`socat`を入れた後に開いたセッションから効くようにする）。同時に開いた
 * セッションは実行中の確認を共有する。
 */
export class ClaudeSandboxProbe {
  private available: ClaudeSandboxEnvironment | undefined;
  private inflight: Promise<ClaudeSandboxAvailability> | undefined;
  private readonly abort = new AbortController();

  constructor(
    private readonly ports: ClaudeSandboxProbePorts,
    private readonly log: Logger,
  ) {}

  async check(): Promise<ClaudeSandboxAvailability> {
    if (this.abort.signal.aborted) {
      return { ok: false, reason: ABORTED_REASON };
    }
    if (this.available !== undefined) {
      return { ok: true, environment: this.available };
    }
    if (this.inflight === undefined) {
      this.inflight = probeClaudeSandbox(this.ports, this.abort.signal)
        .catch(
          (e: unknown): ClaudeSandboxAvailability => ({
            ok: false,
            reason: `sandboxの確認に失敗しました: ${String(e)}`,
          }),
        )
        .then((result) => {
          this.inflight = undefined;
          if (result.ok) {
            this.available = result.environment;
            this.log.info(
              `[claude sandbox] 使用可能${result.environment.weakerNested ? '（コンテナ内のためenableWeakerNestedSandboxを付ける）' : ''}`,
            );
          }
          return result;
        });
    }
    return this.inflight;
  }

  /**
   * `check()`が通った後に、作業ディレクトリごとの事情でsandboxを付けられないかを見る
   * （Issue #1630）。作業ディレクトリの中身は変わりうるため覚えない。
   */
  async checkCwd(mode: ClaudeSandboxMode, cwd: string): Promise<ReadOnlyCwdInspection> {
    if (mode === 'workspace-write') {
      return { ok: true };
    }
    if (this.abort.signal.aborted) {
      return { ok: false, reason: ABORTED_REASON };
    }
    try {
      const result = await this.ports.inspectReadOnlyCwd(cwd, this.abort.signal);
      return result.ok ? result : { ok: false, reason: truncateReason(result.reason) };
    } catch (e: unknown) {
      return { ok: false, reason: `作業ディレクトリの確認に失敗しました: ${String(e)}` };
    }
  }

  /**
   * 拡張機能の終了時に呼ぶ（Issue #1545）。進行中の確認の子プロセス（bubblewrapの試し起動、
   * CLIの空起動、Read denyルールの取得）を止め、以後は確認を始めない。止めないと、各時間上限まで子プロセスが残りうる。
   */
  dispose(): void {
    this.abort.abort();
  }
}
