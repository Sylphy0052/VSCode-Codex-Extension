import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, lstat, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';

/**
 * 拡張機能が管理するskillディレクトリ（Issue #1820）。
 *
 * `~/.codex/skills`・`~/.claude/skills`には書き込まず、拡張機能の持ち物のディレクトリを
 * 起動するCLIへ「そのセッションだけ」読み込ませる。1つのディレクトリを両方のCLIが読める
 * （2026-10-02実測。codex-cli 0.159.3・Claude Code 2.1.286）:
 *
 * ```text
 * <root>/
 *   .claude-plugin/plugin.json   {"name": "<プラグイン名>"}
 *   skills/<skill名>/SKILL.md
 * ```
 *
 * - Codex: app-serverへ`skills/extraRoots/set {extraRoots: ["<root>/skills"]}`を送る。
 *   一覧には`<プラグイン名>:<skill名>`が`scope:"user"`で出るため、出どころはパスで見分ける
 * - Claude Code: `--plugin-dir <root>`で起動する。一覧には`<プラグイン名>:<skill名>`が出る
 *
 * 置き場所は2つ。同梱skillはVSIX内の`resources/skills-plugin/`、利用者skillは
 * globalStorage配下の`skills-plugin/`。呼び出し名が衝突しないようプラグイン名を分ける。
 */

/** 同梱skillのプラグイン名。呼び出し名は`codex-ext:<skill名>`になる。 */
export const BUNDLED_SKILLS_PLUGIN = 'codex-ext';
/** 利用者skillのプラグイン名。呼び出し名は`codex-ext-user:<skill名>`になる。 */
export const USER_SKILLS_PLUGIN = 'codex-ext-user';

/** 一覧で「拡張機能」由来と判定するプラグイン名。 */
export const EXTENSION_SKILL_PLUGINS: readonly string[] = [
  BUNDLED_SKILLS_PLUGIN,
  USER_SKILLS_PLUGIN,
];

/** 拡張機能が持つ2つのプラグインディレクトリ。 */
export interface ExtensionSkillLayout {
  /** VSIX内の同梱skill（`<extensionPath>/resources/skills-plugin`）。 */
  bundledRoot: string;
  /** 利用者skill（`<globalStorage>/skills-plugin`）。 */
  userRoot: string;
}

/**
 * CLIへ渡すプラグインディレクトリを決める。
 *
 * `plugin.json`が無いディレクトリは渡さない。利用者skillは1件も追加していなければ
 * ディレクトリ自体が無く、空のプラグインを読ませる意味が無い。
 * 同梱skillは`agent.bundledSkills.enabled`が`false`なら渡さない。
 */
export function resolvePluginRoots(
  layout: ExtensionSkillLayout,
  bundledEnabled: boolean,
  exists: (path: string) => boolean = existsSync,
): string[] {
  const roots: string[] = [];
  if (bundledEnabled && exists(pluginManifestPath(layout.bundledRoot))) {
    roots.push(layout.bundledRoot);
  }
  if (exists(pluginManifestPath(layout.userRoot))) {
    roots.push(layout.userRoot);
  }
  return roots;
}

function pluginManifestPath(root: string): string {
  return join(root, '.claude-plugin', 'plugin.json');
}

let rootsProvider: () => string[] = () => [];
const changeListeners = new Set<() => void>();

/**
 * 起動時に1回だけ配線する。CLIを起こす経路（会話・設定パネルの一覧取得）は多く、
 * どれもVS Codeの設定とglobalStorageの場所を知らないため、ここから引けるようにする。
 * 配線前（単体テスト等）は空を返し、何も読み込ませない。
 */
export function configureExtensionSkillRoots(provider: () => string[]): void {
  rootsProvider = provider;
}

/** いまCLIへ渡すプラグインディレクトリ。 */
export function extensionPluginRoots(): string[] {
  return rootsProvider();
}

/**
 * Claude Codeへ渡す引数。ディレクトリ1つにつき`--plugin-dir <dir>`を1組。
 * 絶対パスでないものは渡さない（`-`始まりの値をオプションと取り違えさせない）。
 */
export function claudePluginDirArgs(roots: readonly string[] = extensionPluginRoots()): string[] {
  return roots.filter((root) => isAbsolute(root)).flatMap((root) => ['--plugin-dir', root]);
}

/** Codexの`skills/extraRoots/set`へ渡す値。skill本体が並ぶ`skills/`を指す。 */
export function codexSkillExtraRoots(roots: readonly string[] = extensionPluginRoots()): string[] {
  return roots.map((root) => join(root, 'skills'));
}

/** `path`（`skills/list`が返すSKILL.mdのパス）が拡張機能のプラグイン配下か。 */
export function isExtensionSkillPath(path: string, roots: readonly string[]): boolean {
  // Windowsでは`join`が`\`区切りを返し、CLIが返すパスと区切りが揃わないことがある
  const target = comparablePath(path);
  return codexSkillExtraRoots(roots).some((dir) => target.startsWith(`${comparablePath(dir)}/`));
}

function comparablePath(path: string): string {
  const slashed = path.replace(/\\/g, '/');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
}

/**
 * 読み込ませるディレクトリが変わったときに呼ばれる。常駐しているCodexのapp-serverへ
 * 送り直すために使う（Claude Codeは起動のたびに引数を組むため購読しない）。
 * 戻り値の関数を呼ぶと購読をやめる。
 */
export function onExtensionSkillRootsChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

/** 設定の変更や利用者skillの追加・削除の後に呼ぶ。 */
export function notifyExtensionSkillRootsChanged(): void {
  for (const listener of changeListeners) {
    // 1つが投げても残りの接続へは送り直す
    try {
      listener();
    } catch {
      // 送り直しの失敗は各listenerがログへ回す。ここでは止めない
    }
  }
}

/** JSON-RPCの1往復。`AppServerConnection`と`AppServerClient`の両方の形に合わせる。 */
type RpcRequest = (
  method: string,
  params: unknown,
) => Promise<{ error?: { message: string } | undefined }>;

/**
 * Codexのapp-serverへ`skills/extraRoots/set`を送る。失敗したら理由を返す。
 *
 * 失敗しても会話は止めない（CLIの古い版にはこのメソッドが無い）。呼び出し側で
 * ログか一覧の注記に回す。
 */
export async function applyCodexSkillExtraRoots(
  request: RpcRequest,
  roots: readonly string[] = extensionPluginRoots(),
): Promise<string | undefined> {
  try {
    const response = await request('skills/extraRoots/set', {
      extraRoots: codexSkillExtraRoots(roots),
    });
    return response.error?.message;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** 拡張機能のskillを読み込めなかったときに一覧へ添える注記。 */
export function extraRootsWarning(reason: string): string {
  return `拡張機能のskillを読み込めませんでした（CLIが古い可能性があります）: ${reason}`;
}

/** 利用者skillのディレクトリ名として受け付ける形。パス区切りや`..`を通さない。 */
const SKILL_DIR_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isValidSkillDirName(name: string): boolean {
  return SKILL_DIR_RE.test(name);
}

export type UserSkillResult = { ok: true; name: string } | { ok: false; reason: string };

/**
 * 利用者skill（globalStorage配下）の追加・削除・一覧。
 *
 * 書き込むのは`userRoot`の中だけ。追加は選んだフォルダを`skills/<フォルダ名>/`へ写す。
 * 元のフォルダを参照し続けると、後から書き換わった内容が黙って効くため、写しを持つ。
 */
export class UserSkillStore {
  constructor(private readonly userRoot: string) {}

  private get skillsDir(): string {
    return join(this.userRoot, 'skills');
  }

  /** 追加済みのskill（`SKILL.md`を持つディレクトリ）の名前。ディレクトリが無ければ空。 */
  async list(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.skillsDir);
    } catch {
      return [];
    }
    const names: string[] = [];
    for (const name of entries) {
      if (isValidSkillDirName(name) && (await isFile(join(this.skillsDir, name, 'SKILL.md')))) {
        names.push(name);
      }
    }
    return names.sort((a, b) => a.localeCompare(b));
  }

  /** `sourceDir`を写して追加する。同じ名前が既にあれば上書きせず断る。 */
  async add(sourceDir: string): Promise<UserSkillResult> {
    const name = basename(sourceDir);
    if (!isValidSkillDirName(name)) {
      return {
        ok: false,
        reason: `フォルダ名「${name}」はskill名に使えません（英数字・-・_のみ、64文字まで）`,
      };
    }
    if (!(await isFile(join(sourceDir, 'SKILL.md')))) {
      return { ok: false, reason: `${sourceDir} にSKILL.mdがありません` };
    }
    const target = join(this.skillsDir, name);
    if (await isFile(join(target, 'SKILL.md'))) {
      return { ok: false, reason: `「${name}」は既に追加されています。先に削除してください` };
    }
    const tooLarge = await exceedsCopyLimit(sourceDir);
    if (tooLarge !== undefined) {
      return { ok: false, reason: tooLarge };
    }

    // 写し終えるまでは`skills/`の外に置く。途中の状態を会話中のCLIに読ませず、
    // 失敗しても既にある同名skillを巻き込まない
    const staging = join(this.userRoot, `.staging-${randomBytes(6).toString('hex')}`);
    try {
      await this.ensureManifest();
      await cp(sourceDir, staging, {
        recursive: true,
        errorOnExist: true,
        force: false,
        filter: async (src) => copyable(src),
      });
      // 選んだフォルダ自体やSKILL.mdがリンクだと、上の除外で中身が写らない
      if (!(await isFile(join(staging, 'SKILL.md')))) {
        throw new Error('SKILL.mdを写せませんでした（シンボリックリンクは写しません）');
      }
      // SKILL.mdの無い残骸（削除の途中で失敗した等）は一覧に出ず消せないため、ここで片付ける
      await rm(target, { recursive: true, force: true });
      await rename(staging, target);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      try {
        await rm(staging, { recursive: true, force: true });
      } catch (cleanup) {
        const detail = cleanup instanceof Error ? cleanup.message : String(cleanup);
        return {
          ok: false,
          reason: `${reason}（一時コピー ${staging} を消せませんでした: ${detail}）`,
        };
      }
      return { ok: false, reason };
    }
    return { ok: true, name };
  }

  /** 追加したskillを消す。`userRoot`の外は消さない。 */
  async remove(name: string): Promise<UserSkillResult> {
    if (!isValidSkillDirName(name)) {
      return { ok: false, reason: `不正なskill名です: ${name}` };
    }
    const target = join(this.skillsDir, name);
    if (!(await exists(target))) {
      return { ok: false, reason: `「${name}」は見つかりません` };
    }
    try {
      await rm(target, { recursive: true, force: true });
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    return { ok: true, name };
  }

  private async ensureManifest(): Promise<void> {
    const manifest = pluginManifestPath(this.userRoot);
    if (await exists(manifest)) {
      return;
    }
    await mkdir(join(this.userRoot, '.claude-plugin'), { recursive: true });
    await mkdir(this.skillsDir, { recursive: true });
    await writeFile(
      manifest,
      `${JSON.stringify(
        {
          name: USER_SKILLS_PLUGIN,
          version: '0.0.1',
          description: 'VSCode-Codex-Extensionの画面から追加したskill',
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }
}

/** 写さないディレクトリ。skillの中身ではなく、写すと量だけが膨らむ。 */
const SKIPPED_DIRS = new Set(['.git', 'node_modules']);
/** 写す量の上限。誤って大きなフォルダを選んだときにglobalStorageを埋めない。 */
const MAX_COPY_FILES = 1000;
const MAX_COPY_BYTES = 10 * 1024 * 1024;

/**
 * 写す対象か。シンボリックリンクは写さない。リンク先がフォルダの外を指していると、
 * 選んだ覚えのないファイルまでskillの中身として読まれる。
 */
async function copyable(path: string): Promise<boolean> {
  return !SKIPPED_DIRS.has(basename(path)) && !(await lstat(path)).isSymbolicLink();
}

/** `copyable`で写す分が上限を超えるなら理由を返す。 */
async function exceedsCopyLimit(root: string): Promise<string | undefined> {
  let files = 0;
  let bytes = 0;
  const pending = [root];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink() || SKIPPED_DIRS.has(entry.name)) {
        continue;
      }
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      files += 1;
      bytes += (await lstat(path)).size;
      if (files > MAX_COPY_FILES || bytes > MAX_COPY_BYTES) {
        return `フォルダが大きすぎます（ファイル${MAX_COPY_FILES}個・合計${MAX_COPY_BYTES / 1024 / 1024}MBまで。.gitとnode_modulesは数えません）`;
      }
    }
  }
  return undefined;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
