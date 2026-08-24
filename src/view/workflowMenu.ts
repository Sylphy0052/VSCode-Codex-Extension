/**
 * ワークフローの導線（issue #250、design.md §16.22）で出すQuickPickの中身。
 *
 * サイドパネル（`view/title` のアイコン）とチャット画面（`#composer` のアイコン）の
 * どちらから押しても同じメニューを出すため、項目の組み立てをここへ一本化する。
 * `vscode` に依存しない純粋関数にしてあり、`extension.ts` が `QuickPickItem` へ載せ替える。
 */

/** QuickPickの1項目。`command` は選んだときに実行するコマンドID。 */
export interface WorkflowMenuEntry {
  label: string;
  description: string;
  command: string;
}

const RUN: WorkflowMenuEntry = {
  label: '$(play) ワークフローを実行…',
  description: 'YAMLの定義を選んで開始します',
  command: 'agent.workflows.run',
};

const VIEW: WorkflowMenuEntry = {
  label: '$(graph) ワークフローViewを開く',
  description: '定義と進行を1枚で見ます',
  command: 'agent.workflows.view',
};

const PLAN: WorkflowMenuEntry = {
  label: '$(sparkle) ゴール文からワークフローを生成…',
  description: 'ゴールからYAMLを作ります（自動では実行しません）',
  command: 'agent.workflows.plan',
};

/**
 * チームモード（design.md §16.44、issue #693）。
 *
 * 中身は「ゴール文からワークフローを生成」と同じ経路だが、役割ごとのセッションへ
 * 分けさせる点だけが違う。導線を分けているのは、役割を書かせるとタスクごとのmodel/effortが
 * 役割のプリセットで決まるため（`rolePresets.ts`）で、ふつうの生成と混ぜたくないから。
 */
const TEAM: WorkflowMenuEntry = {
  label: '$(organization) チームモードを開始…',
  description: 'ゴールを役割ごとのセッションへ分けたYAMLを作ります（自動では実行しません）',
  command: 'agent.workflows.team',
};

const ROADMAP: WorkflowMenuEntry = {
  label: '$(list-ordered) ロードマップを生成…',
  description: 'ゴールからフェーズ分けのMarkdownを作ります',
  command: 'agent.workflows.roadmap',
};

const STOP: WorkflowMenuEntry = {
  label: '$(debug-stop) ワークフローを停止…',
  description: '実行中のワークフローを選んで止めます',
  command: 'agent.workflows.stop',
};

/**
 * メニューに並べる項目を返す。
 *
 * - 実行中のrunがあるときは「Viewを開く」を先頭へ出し、件数を `description` に添える。
 *   走っている最中にアイコンを押す動機はまず進行を見ることなので、先頭に来ていないと二度手間になる
 * - 実行中のrunが無いときは「停止…」を出さない。選んでも「実行中のワークフローはありません」しか
 *   出ず、選択肢として残す意味が無いため
 */
export function buildWorkflowMenuEntries(runningCount: number): WorkflowMenuEntry[] {
  if (runningCount <= 0) {
    return [RUN, VIEW, PLAN, TEAM, ROADMAP];
  }
  return [
    { ...VIEW, description: `実行中 ${runningCount}件 — ${VIEW.description}` },
    RUN,
    PLAN,
    TEAM,
    ROADMAP,
    STOP,
  ];
}
