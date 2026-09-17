/**
 * 通知音の再生（issue #1242）。
 *
 * VSCodeの拡張APIには音を鳴らす口が無い。webviewを常駐させてWeb Audioで鳴らす案もあるが、
 * 音が要るのはタブが隠れている場面であり、`retainContextWhenHidden`付きのwebviewを
 * 常駐させる負担に見合わない。そのため拡張ホストのOSの再生コマンドを子プロセスとして
 * 起動する方式を採る。
 *
 * コマンドは1つに決め打ちしない。WSL2（WSLg）では`paplay`/`aplay`/`pw-play`がいずれも
 * 無く`ffplay`だけがある、という実測（2026-09-17）があり、環境によって入っているものが
 * 違う。候補を順に探して最初に見つかったものを使う。
 *
 * ここは`vscode`をimportしないロジック層（CONTRIBUTINGのレイヤ制約）。設定の読み取りと
 * 音源パスの解決は`src/view/notificationSound.ts`が担い、ここはコマンドの組み立てと
 * 起動だけを引き受ける。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/** 起動する再生コマンドと引数。`args`に音源の実パスが埋まった状態で返る。 */
export interface ResolvedPlayCommand {
  command: string;
  args: readonly string[];
}

/** 候補1件。`args`は音源の実パスを受け取って引数列を返す。 */
interface PlayCommandCandidate {
  command: string;
  args: (file: string) => string[];
}

/**
 * Linuxの候補。PulseAudio（`paplay`）→ PipeWire（`pw-play`）→ ALSA（`aplay`）→ ffmpeg同梱の
 * `ffplay`の順に見る。前の3つは音声サーバへ直接繋ぐ専用コマンドで起動が軽く、`ffplay`は
 * 汎用プレイヤのため最後に回す（WSLgではこれしか無いことがある）。
 */
const LINUX_CANDIDATES: readonly PlayCommandCandidate[] = [
  { command: 'paplay', args: (file) => [file] },
  { command: 'pw-play', args: (file) => [file] },
  { command: 'aplay', args: (file) => ['-q', file] },
  // `-nodisp`が無いとウィンドウが開き、`-autoexit`が無いと再生後も残る
  { command: 'ffplay', args: (file) => ['-nodisp', '-autoexit', '-loglevel', 'error', file] },
];

const MACOS_CANDIDATES: readonly PlayCommandCandidate[] = [
  { command: 'afplay', args: (file) => [file] },
];

/**
 * Windowsの候補。`System.Media.SoundPlayer`はWAV（PCM）しか再生できないが、同梱している
 * 音源はWAVであり、設定で差し替える場合もWAVを前提とする（READMEに明記する）。
 *
 * `PlaySync()`を使う。`Play()`は非同期再生のため、PowerShellのプロセスが先に終わって
 * 音が出ないまま打ち切られる。
 */
const WINDOWS_CANDIDATES: readonly PlayCommandCandidate[] = [
  {
    command: 'powershell.exe',
    args: (file) => [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(New-Object Media.SoundPlayer '${escapePowerShellSingleQuoted(file)}').PlaySync()`,
    ],
  },
];

/** PowerShellの単引用符文字列は`'`を`''`で表す。パスに`'`を含んでも壊れないようにする。 */
function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/gu, "''");
}

export function candidatesFor(platform: NodeJS.Platform): readonly PlayCommandCandidate[] {
  switch (platform) {
    case 'darwin':
      return MACOS_CANDIDATES;
    case 'win32':
      return WINDOWS_CANDIDATES;
    default:
      // Linuxのほか、FreeBSD等でも同じ顔ぶれが入っていることが多い
      return LINUX_CANDIDATES;
  }
}

/**
 * PATH上に実行可能ファイルがあるかを見る。`which`を起動しないのは、判定のたびに
 * 子プロセスを立てるのを避けるため（結果は呼び出し側でキャッシュする）。
 *
 * Windowsでは拡張子を補う必要があるため`PATHEXT`も見る。コマンド名が既に拡張子を
 * 含む場合（`powershell.exe`）はそのままでも見つかる。
 */
export function commandExistsOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (command === '') {
    return false;
  }
  // 絶対パス指定はPATHを見ずにそのまま判定する
  if (isAbsolute(command)) {
    return existsSync(command);
  }
  const rawPath = env['PATH'] ?? env['Path'] ?? '';
  const dirs = rawPath.split(delimiter).filter((dir) => dir !== '');
  const exts =
    platform === 'win32'
      ? ['', ...(env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => e !== '')]
      : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      if (existsSync(join(dir, `${command}${ext}`))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 設定で与えられた再生コマンドのテンプレートを解く（`agent.notifications.sound.playerCommand`）。
 *
 * 空白区切りのトークン列として扱い、`"..."` `'...'` で囲めば空白を含む1トークンにできる。
 * `${file}` を音源の実パスへ置換する。`${file}` がどこにも無ければ末尾へ足す
 * （`afplay` のように引数がパス1つだけのコマンドをコマンド名だけで書けるようにするため）。
 *
 * シェルは介さない（`spawn`の`shell: false`で起動する）。パイプやリダイレクトは使えないが、
 * 設定値がそのままシェルへ渡ることも無い。
 */
export function parsePlayerCommandTemplate(
  template: string,
  file: string,
): ResolvedPlayCommand | undefined {
  const tokens = tokenize(template);
  if (tokens.length === 0) {
    return undefined;
  }
  const replaced = tokens.map((token) => token.replace(/\$\{file\}/gu, file));
  const [command, ...args] = replaced;
  if (command === undefined || command === '') {
    return undefined;
  }
  if (!template.includes('${file}')) {
    return { command, args: [...args, file] };
  }
  return { command, args };
}

/** 空白区切り。`"` と `'` による引用に対応する（エスケープ記法は持たない）。 */
function tokenize(template: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let started = false;
  for (const ch of template) {
    if (quote !== undefined) {
      if (ch === quote) {
        quote = undefined;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/u.test(ch)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) {
    tokens.push(current);
  }
  return tokens;
}

export interface ResolvePlayCommandOptions {
  /** 音源の実パス。 */
  file: string;
  /** 設定による上書き（`agent.notifications.sound.playerCommand`）。空文字なら候補から探す。 */
  template?: string;
  platform?: NodeJS.Platform;
  /** PATH判定。テストから差し替える。 */
  hasCommand?: (command: string) => boolean;
}

/**
 * 実際に起動する再生コマンドを決める。
 *
 * 上書きが与えられていれば、そのコマンドがPATH上に無くてもそのまま返す（利用者が明示した
 * 指定を勝手に握り潰さない。起動に失敗すればログに残る）。上書きが無ければ、プラットフォーム
 * 別の候補のうちPATH上にある最初のものを選ぶ。1つも無ければ`undefined`。
 */
export function resolvePlayCommand(
  options: ResolvePlayCommandOptions,
): ResolvedPlayCommand | undefined {
  const platform = options.platform ?? process.platform;
  const hasCommand = options.hasCommand ?? ((c: string) => commandExistsOnPath(c));
  const template = options.template ?? '';
  if (template.trim() !== '') {
    return parsePlayerCommandTemplate(template, options.file);
  }
  for (const candidate of candidatesFor(platform)) {
    if (hasCommand(candidate.command)) {
      return { command: candidate.command, args: candidate.args(options.file) };
    }
  }
  return undefined;
}

/**
 * 再生コマンドを起動する。待ち合わせない。
 *
 * `detached: true` ＋ `unref()` で、拡張機能の終了が再生プロセスに引きずられないようにする。
 * 標準入出力は捨てる（`ffplay`等が出す診断をVSCodeのプロセスへ流し込まない）。
 *
 * 例外は投げない。音が鳴らないことで会話の処理を止めてはならないため、失敗は戻り値と
 * `onError`で伝える。
 */
export function spawnPlayCommand(
  resolved: ResolvedPlayCommand,
  onError?: (message: string) => void,
): boolean {
  try {
    const child = spawn(resolved.command, [...resolved.args], {
      detached: true,
      stdio: 'ignore',
      shell: false,
    });
    // 起動後に失敗する経路（コマンドが無い等）はイベントで届く。拾わないと
    // unhandled 'error' でプロセスごと落ちる
    child.on('error', (e) => {
      onError?.(e instanceof Error ? e.message : String(e));
    });
    child.unref();
    return true;
  } catch (e) {
    onError?.(e instanceof Error ? e.message : String(e));
    return false;
  }
}
