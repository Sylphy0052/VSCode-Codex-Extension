import type { SlashCommand } from './slashCommands';

/**
 * 拡張機能側の機能へ割り当てたスラッシュコマンド。
 *
 * Codexの組込コマンドはTUI層の機能で、app-serverには存在しない。`turn/start` へ
 * `/status` のようなテキストを送っても**ただの文章としてモデルに渡る**（実測で確認）。
 * 候補に出るのに何も起きない状態を避けるため、組込コマンドは候補から外し、
 * 拡張機能側で同じことができるものだけをここへ載せる。
 *
 * 対応する機能が実装されたら、そのIssueの作業でここへ足す。判定表は
 * `docs/slash-commands.md` にある。
 */

/** 擬似コマンドが起こす動作。 */
export type PseudoAction = 'compact';

export interface PseudoCommand extends SlashCommand {
  action: PseudoAction;
}

/** 送信テキストを擬似コマンドとして解釈した結果。 */
export interface PseudoCommandCall {
  /** 打たれたコマンド名。ログに残すために持つ。 */
  name: string;
  action: PseudoAction;
  /** コマンド名より後ろの文字列。受け取れない動作もある。 */
  args: string;
}

export const CODEX_PSEUDO_COMMANDS: readonly PseudoCommand[] = [
  {
    name: 'compact',
    description: '会話を要約して圧縮する（この画面の機能で実行します）',
    argumentHint: '',
    action: 'compact',
  },
];

/**
 * 送信テキストが擬似コマンドかどうか調べる。
 *
 * 1行目だけを見る。`/compact` に続けて本文を書いた場合は、コマンドではなく
 * 普通の発言として扱いたいため、コマンド行だけのときに限って引き受ける。
 */
export function routePseudoCommand(
  commands: readonly PseudoCommand[],
  text: string,
): PseudoCommandCall | undefined {
  const line = text.trim();
  if (line.includes('\n')) {
    return undefined;
  }
  const matched = /^\/([\w-]+)(?:\s+(.*))?$/u.exec(line);
  const name = matched?.[1];
  if (matched === null || name === undefined) {
    return undefined;
  }
  const command = commands.find((c) => c.name === name);
  return command === undefined
    ? undefined
    : { name: command.name, action: command.action, args: matched[2] ?? '' };
}

/**
 * 候補の先頭へ擬似コマンドを置く。
 *
 * 同じ名前がCLI由来やファイル由来にあっても擬似コマンドを優先する。送信時の
 * 振り替えは名前で決まるため、説明だけ別のものが出ると食い違うため。
 */
export function withPseudoCommands(
  pseudo: readonly PseudoCommand[],
  commands: readonly SlashCommand[],
): SlashCommand[] {
  const names = new Set(pseudo.map((c) => c.name));
  return [...pseudo, ...commands.filter((c) => !names.has(c.name))];
}
