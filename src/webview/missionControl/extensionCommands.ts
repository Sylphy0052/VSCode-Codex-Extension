/**
 * Mission Controlのパレットから実行できる拡張コマンド（Issue #2161）。
 *
 * webviewは`id`だけを送り、拡張ホストはこの表との完全一致で照合する（前方一致・正規表現は
 * 使わない）。引数は拡張ホストが`arg`に従って決め、webviewからは受け取らない。
 *
 * 入れてよいのは、引数無しで意味を持ち、エディタの選択範囲に依存せず、取り消せない操作
 * （削除・archive・実行中のものの停止など）を含まないコマンドだけ。次は入れない。
 * - `agent.localReview.send` / `agent.sendSelectionToChat`: エディタの選択範囲に依存する
 * - `agent.localReview.start`: 差分を開いて選ぶ手動操作が前提
 * - `codex.deleteSession` / `codex.archiveSession`など: セッションを引数に取り、取り消せない
 *   （MCではライフサイクルの操作として確認付きで別にある）
 * - `agent.workflows.stop`: 実行中のワークフローを止め、取り消せない
 * - `codex.clearChat` / `*.handoffToNewSession` / `*.renameChat`: 最後に操作したチャット画面が
 *   対象で、MCで選んだセッションとずれる（MCには選んだセッション向けの操作が別にある）
 */
export interface McExtensionCommand {
  /** VS Codeのコマンドid。 */
  readonly id: string;
  /** パレットに出す名前。 */
  readonly label: string;
  /**
   * 拡張ホストが渡す引数。
   * - `none`: 引数無しで実行する。宛先を付けて送られたら拒む
   * - `provider`: 選択中のセッションがあれば、そのproviderを渡す（拡張ホストが知っている
   *   セッションに限る）。無ければ引数無しで実行する
   */
  readonly arg: 'none' | 'provider';
}

export const MC_EXTENSION_COMMANDS: readonly McExtensionCommand[] = Object.freeze([
  { id: 'agent.workflows.menu', label: 'ワークフロー…', arg: 'provider' },
  { id: 'agent.workflows.run', label: 'ワークフローを実行…', arg: 'none' },
  { id: 'agent.workflows.view', label: 'ワークフローViewを開く', arg: 'none' },
  { id: 'agent.workflows.plan', label: 'ゴール文からワークフローを生成…', arg: 'provider' },
  { id: 'agent.workflows.team', label: 'チームモードでワークフローを生成…', arg: 'provider' },
  { id: 'agent.workflows.review', label: 'ワークフローをレビュー…', arg: 'none' },
  { id: 'agent.workflows.roadmap', label: 'ロードマップを生成…', arg: 'provider' },
  {
    id: 'agent.workflows.convertRoadmap',
    label: 'ファイルからロードマップを作成…',
    arg: 'provider',
  },
  { id: 'agent.webGpt.discuss', label: 'WebGPTと議論…（最後に操作したチャット画面）', arg: 'none' },
  { id: 'codex.showUsage', label: '使用量を表示', arg: 'none' },
  { id: 'agent.openProgress', label: '進捗を表示', arg: 'none' },
  { id: 'agent.forgeHub', label: 'Forge Hubを開く', arg: 'provider' },
  { id: 'claude.reloadSkills', label: 'skillsを読み直す（Claude Code）', arg: 'none' },
  { id: 'agent.openPresetChat', label: 'プリセットから新しい会話を開く…', arg: 'none' },
  { id: 'agent.taskRun.kanban', label: 'オーケストレータモードのKanbanを開く', arg: 'none' },
  { id: 'agent.taskRun.switch', label: 'オーケストレータモードのrunを切り替える', arg: 'none' },
  {
    id: 'agent.taskRun.startFromRoadmap',
    label: 'ロードマップIssueからオーケストレータモードを開始',
    arg: 'none',
  },
  { id: 'codex.showApprovalPending', label: '承認待ちの会話を開く', arg: 'none' },
  { id: 'codex.showLog', label: 'ログを表示', arg: 'none' },
] as const satisfies readonly McExtensionCommand[]);
