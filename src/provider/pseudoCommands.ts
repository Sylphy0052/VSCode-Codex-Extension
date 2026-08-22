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
export type PseudoAction = 'compact' | 'generateAgentsFile' | 'sideQuestion';

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
  {
    name: 'init',
    description:
      'AGENTS.mdを生成する（この画面の機能で実行します。既存があれば確認してから上書きします）',
    argumentHint: '',
    action: 'generateAgentsFile',
  },
  {
    name: 'btw',
    description: '脇道の質問を送る（本流を汚さない使い捨てのスレッドで聞く。issue #24）',
    argumentHint: '<質問>',
    action: 'sideQuestion',
  },
];

/**
 * Claude Code画面向けの擬似コマンド（issue #334、design.md §14.62）。
 *
 * `/btw`（脇道の質問）だけを`CODEX_PSEUDO_COMMANDS`から抜き出したもの。`/compact`と
 * `/init`はClaude Code側では扱わない（`/compact`はCLI組込コマンド・画面のボタンの
 * 両方で既に完結しており、`/init`に相当する専用の導線も無い）。ここへ`CODEX_PSEUDO_COMMANDS`
 * をそのまま流用すると、Claude Code画面で`/compact`や`/init`と打ったときに「拡張機能側の
 * 機能」として静かに素通しされ、Codex専用の後始末（`runGenerateAgentsFile`等）が無いまま
 * 何も起きない状態になる（Codex側の挙動は変えない、という制約とは別に、Claude Code側の
 * 既存の`/compact`ボタンの経路とも重複してしまう）。
 */
export const CLAUDE_PSEUDO_COMMANDS: readonly PseudoCommand[] = CODEX_PSEUDO_COMMANDS.filter(
  (command) => command.action === 'sideQuestion',
);

/**
 * 擬似コマンドの引数を仕上げる。前後の空白を落とし、空なら「引数が無い」を表す
 * `undefined` を返す。`/btw` のように引数（質問文）が必須の擬似コマンドで使う。
 */
export function trimmedArgsOrUndefined(args: string): string | undefined {
  const trimmed = args.trim();
  return trimmed === '' ? undefined : trimmed;
}

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

/**
 * `/init` 擬似コマンド（AGENTS.mdの生成）で送る指示文を組み立てる。
 *
 * CodexのTUIが持つ組込 `/init` はTUI層の機能でapp-serverには存在せず、実行できるのは
 * モデルへの指示として送ることだけ（`codex app-server generate-json-schema` の95メソッドを
 * 全数確認済み、docs/slash-commands.md）。既存ファイルの有無で文面を変え、上書きのときは
 * 「踏まえて更新」、新規のときは「新規に作成」と伝える（黙って中身を捨てさせない）。
 */
export function buildInitInstructionText(agentsFileExists: boolean): string {
  const action = agentsFileExists
    ? '既存のAGENTS.mdの内容を踏まえて、最新の状態に更新してください'
    : 'AGENTS.mdを新規に作成してください';
  return `${action}。プロジェクトの構成・ビルド方法・テスト方法・作業時の注意点など、次にこのリポジトリを触るエージェントが最初に知っておくべき情報をまとめてください。`;
}
