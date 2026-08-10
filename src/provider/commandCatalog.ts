import type { FileSystemPort } from '../session/ports';
import { parseCommandFile, type SlashCommand } from './slashCommands';

/**
 * CLIに組み込まれているコマンド。
 *
 * 一覧を返すAPIが無いため、ここに持つ。使えるかどうかはCLIが判断して返すので
 * （`isn't available in this environment` など）、こちらでは可否を決めない。
 */
const CODEX_BUILTINS: SlashCommand[] = [
  { name: 'review', description: 'コードをレビューする', argumentHint: '' },
  { name: 'compact', description: '会話を要約して圧縮する', argumentHint: '' },
  { name: 'init', description: 'AGENTS.md を作る', argumentHint: '' },
  { name: 'status', description: '現在の設定と使用量を表示する', argumentHint: '' },
  { name: 'diff', description: '未コミットの差分を見る', argumentHint: '' },
  { name: 'plan', description: '計画を立ててから進める', argumentHint: '' },
  { name: 'skills', description: '使えるスキルを一覧する', argumentHint: '' },
];

const CLAUDE_BUILTINS: SlashCommand[] = [
  { name: 'compact', description: '会話を要約して圧縮する', argumentHint: '' },
  { name: 'review', description: 'コードをレビューする', argumentHint: '' },
  { name: 'init', description: 'CLAUDE.md を作る', argumentHint: '' },
  { name: 'context', description: 'コンテキストの使用量を見る', argumentHint: '' },
  { name: 'cost', description: '課金額を見る', argumentHint: '' },
  { name: 'security-review', description: 'セキュリティレビューを行う', argumentHint: '' },
];

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const dirname = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf('/')));

/**
 * 入力欄の候補を集める。
 *
 * 送信は `/name` をそのまま渡すだけで済む（Codexはカスタムプロンプトを展開し、
 * Claude Codeはコマンドとして解釈する）。ここでは「何が使えるか」だけを作る。
 */
export class CommandCatalog {
  constructor(private readonly fs: FileSystemPort) {}

  /**
   * Codex: `~/.codex` の prompts と skills。
   * ワークスペース側の `.codex` にも同じ形で置けるため合わせて読む。
   */
  async forCodex(codexHome: string, workspaceFolders: string[]): Promise<SlashCommand[]> {
    const roots = [codexHome, ...workspaceFolders.map((folder) => `${folder}/.codex`)];
    return dedupe([...CODEX_BUILTINS, ...(await this.collectFrom(roots))]);
  }

  /**
   * Claude Code: `~/.claude` の skills と commands。
   * ワークスペース側の `.claude` も同じ形で置かれるため合わせて読む。
   */
  async forClaude(claudeHome: string, workspaceFolders: string[]): Promise<SlashCommand[]> {
    const roots = [claudeHome, ...workspaceFolders.map((folder) => `${folder}/.claude`)];
    return dedupe([...CLAUDE_BUILTINS, ...(await this.collectFrom(roots))]);
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
