import type { FileSystemPort } from '../session/ports';
import { parseCommandFile, type SlashCommand } from './slashCommands';

/**
 * CLIの組込コマンドはここに持たない。
 *
 * 以前は名前を手で並べていたが、実測の結果どちらのCLIでも誤りだった。
 * Codexの組込コマンドはTUI層の機能で、app-serverへ送ってもただの文章になる。
 * Claude Codeは組込コマンドが効くが、一覧はCLI（`initialize` の応答）が持っており、
 * 手で並べた7件のうち `review` と `cost` は実在しなかった。
 *
 * 現在の出どころ:
 * - Codex: 拡張機能側の擬似コマンド（`pseudoCommands.ts`）+ `skills/list` + このファイル
 * - Claude Code: `initialize` の応答 + `commands_changed` 通知。取れないときだけこのファイル
 *
 * 判定の根拠は `docs/slash-commands.md`。
 */

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const dirname = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf('/')));

/**
 * ファイルに置かれた候補を集める。
 *
 * カスタムプロンプト・スキル・コマンドファイルのみを扱う。これらは `/name` を
 * そのまま送れば効く（Codexは展開し、Claude Codeはコマンドとして解釈する）。
 */
export class CommandCatalog {
  constructor(private readonly fs: FileSystemPort) {}

  /**
   * Codex: `~/.codex` の prompts と skills。
   * ワークスペース側の `.codex` にも同じ形で置けるため合わせて読む。
   */
  async forCodex(codexHome: string, workspaceFolders: string[]): Promise<SlashCommand[]> {
    const roots = [codexHome, ...workspaceFolders.map((folder) => `${folder}/.codex`)];
    return dedupe(await this.collectFrom(roots));
  }

  /**
   * Claude Code: `~/.claude` の skills と commands。
   * ワークスペース側の `.claude` も同じ形で置かれるため合わせて読む。
   */
  async forClaude(claudeHome: string, workspaceFolders: string[]): Promise<SlashCommand[]> {
    const roots = [claudeHome, ...workspaceFolders.map((folder) => `${folder}/.claude`)];
    return dedupe(await this.collectFrom(roots));
  }

  /** どちらのCLIも prompts / skills / commands の3か所に置ける。 */
  private async collectFrom(roots: string[]): Promise<SlashCommand[]> {
    const found: SlashCommand[] = [];
    for (const root of roots) {
      // スキルは <name>/SKILL.md、プロンプトとコマンドは直下の .md だけを見る。
      // 隣に置かれた資料まで拾うと、候補が使えないもので埋まる
      found.push(...(await this.collect(`${root}/skills`, isSkillEntry)));
      found.push(...(await this.collect(`${root}/prompts`, directChild(`${root}/prompts`))));
      found.push(...(await this.collect(`${root}/commands`, directChild(`${root}/commands`))));
    }
    return found;
  }

  private async collect(
    dir: string,
    accepts: (filePath: string) => boolean,
  ): Promise<SlashCommand[]> {
    const files = (await this.fs.listMarkdown(dir)).filter(accepts);
    const commands: SlashCommand[] = [];

    for (const filePath of files) {
      const content = await this.fs.readTextFile(filePath);
      if (content === undefined) {
        continue;
      }
      const command = parseCommandFile(defaultName(filePath), content);
      if (command !== undefined && command.name !== '') {
        commands.push(command);
      }
    }
    return commands;
  }
}

/** スキルの本体か。参照用に置かれた資料を弾く。 */
function isSkillEntry(filePath: string): boolean {
  return basename(filePath) === 'SKILL.md';
}

/** そのディレクトリの直下にあるか。入れ子の資料を弾く。 */
function directChild(dir: string): (filePath: string) => boolean {
  return (filePath) => dirname(filePath) === dir;
}

/**
 * ファイル名から作る既定の名前。
 * スキルは `<name>/SKILL.md` に置かれるため、その場合は親ディレクトリ名を使う。
 */
function defaultName(filePath: string): string {
  const file = basename(filePath).replace(/\.md$/, '');
  return file === 'SKILL' ? basename(dirname(filePath)) : file;
}

/** 同じ名前は先に見つけたものを残す。組込とワークスペースの重複を吸収する。 */
function dedupe(commands: SlashCommand[]): SlashCommand[] {
  const seen = new Set<string>();
  return commands.filter((command) => {
    if (seen.has(command.name)) {
      return false;
    }
    seen.add(command.name);
    return true;
  });
}
