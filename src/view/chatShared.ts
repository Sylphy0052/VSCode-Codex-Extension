import { randomBytes } from 'node:crypto';
import { realpath as fsRealpath } from 'node:fs/promises';
import * as vscode from 'vscode';
import { type ChatItem, type ChatState, type FileDiff } from '../appserver/chatState';
import {
  buildTranscriptMarkdown,
  defaultTranscriptFileName,
} from '../appserver/transcriptMarkdown';
import type { ActivityKind } from '../activity/record';
import { currentWorkspaceFolder, workspaceFolderPaths } from '../config';
import type { FileSystemPort, SymlinkResolution } from '../session/ports';
import {
  APPROVAL_LEVELS,
  APPROVAL_LEVEL_LABELS,
  approvalLevelMeta,
} from '../provider/approvalLevel';
import type { ProviderId } from '../provider/id';
import { DEFAULT_CHAT_DENSITY, densityBodyClass, type ChatDensity } from './density';
import { AttachmentBox, dropRejectionReason } from '../provider/attachments';
import { buildImageReply } from '../provider/imageRefs';
import { FileMentionCatalog, filterFiles } from '../provider/fileMentions';
import { buildMemoryAppendConfirmation } from '../provider/inputModes';
import { computeDiffContents, planDiffActions } from '../util/diffRestore';
import {
  resolveWithinWorkspace,
  verifyRealPathWithinWorkspace,
  type DiffPathResolution,
} from '../util/diffWorkspacePath';
import { chatCsp } from './chatCsp';
import { chatScript, type ReviewButtonConfig } from './chatScript';
import { chatStyles } from './chatStyles';
import {
  DEFAULT_COMPOSER_BUTTONS,
  overflowComposerButtons,
  type ComposerButtonId,
} from './composerButtons';
import { DEFAULT_SEND_ON, type SendOnMode } from './sendKey';

/**
 * `chatView.ts`（Codex画面）・`claudeChatView.ts`（Claude Code画面）の両方が使う、
 * プロバイダ非依存の共有ヘルパー（issue #403）。
 *
 * 元はchatView.tsに全て置かれており、claudeChatView.tsがそこから輸入する非対称な
 * 構造だった（Codex用ファイルがCodex固有機能と共有ユーティリティ集を兼ねていた）。
 * このモジュールを中立の置き場所とし、両画面ファイルがここから輸入する形にする。
 *
 * 挙動は変えていない。中身は`chatView.ts`からの単純な移動（純粋な移動と再輸出）。
 * `chatView.ts`は後方互換のため、ここから再輸出している既存のシンボルを保つ。
 */
/**
 * 画面へ状態を送る最短間隔（issue #246）。
 *
 * 巨大なコマンド出力の最中に届くデルタ1件ごとに状態全体を送ると、拡張ホストが直列化で
 * 埋まり、`turn/interrupt` の応答すら読めなくなる。人の目には連続に見える程度に短く、
 * かつ送信回数を2桁減らせる長さとして50msを採る（毎秒最大20回）。
 */
export const STATE_POST_INTERVAL_MS = 50;

/** 拡張機能から実行したセッションを日報バッファへ記録するための通知。 */
export interface ChatActivity {
  sessionId: string;
  cwd: string;
  kind: ActivityKind;
  /** `kind: 'prompt'` は発言そのもの、`kind: 'result'` はターンの最終応答テキスト。 */
  text: string;
  /** `kind: 'result'` のときだけ使う。そのターンで編集したファイルパス。 */
  editedFiles?: readonly string[];
}

/**
 * 貼られた画像を受け取る。Codex画面・Claude Code画面の両方で共有する。
 *
 * 受け付けられなかったときは**理由を画面に出す**。黙って捨てると、貼ったのに
 * サムネイルが出ない理由が分からない。
 */
export function addAttachment(box: AttachmentBox, name: unknown, dataUrl: unknown): void {
  if (typeof dataUrl !== 'string') {
    return;
  }
  const label = typeof name === 'string' && name !== '' ? name : '貼り付けた画像';
  const added = box.add(label, dataUrl);
  if ('reason' in added) {
    void vscode.window.showWarningMessage(`画像を添えられません: ${added.reason}`);
  }
}

/**
 * 画像を取れなかったドロップを知らせる（issue #241）。Codex画面・Claude Code画面で共有する。
 *
 * `addAttachment` と同じ考え方で、受け取れなかったときは黙って捨てずに理由を出す。
 */
export function noteDropRejected(kind: unknown): void {
  const reason = dropRejectionReason(kind);
  if (reason === undefined) {
    return;
  }
  void vscode.window.showWarningMessage(`画像を添えられません: ${reason}`);
}

/**
 * 圧縮してよいか確かめる。Codex画面・Claude Code画面の両方で共有する。
 *
 * 圧縮は会話の内容を要約へ置き換える。元には戻せないため、必ず確認を通す。
 */
export async function confirmCompact(): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    'これまでの会話を要約に置き換えます。元の内容には戻せません。',
    { modal: true },
    '圧縮する',
  );
  return choice === '圧縮する';
}

/**
 * 他エージェント（Codex／Gemini）の設定インポートを送ってよいか確かめる
 * （issue #200、design.md TP-88。Claude Code画面のみ）。
 *
 * Codex側（issue #36）は取り込み対象を一覧から選ばせてから確認するが、Claude Code側は
 * control protocolに構造化された一覧取得手段が無く（`streamSession.ts` の
 * `importConfig` 参照）、`/import` をそのまま会話へ送ってCLI自身のプレビュー応答に
 * 委ねるほかない。そのため「何を・どこから・どこへ」をこの確認ダイアログで明示してから
 * 送る。ここで送るのはプレビュー要求のみで、実際の書き込みにはCLIが返すダイジェスト付き
 * 確認コマンドをユーザーがもう一度送る必要がある（二段階確認）。
 */
export async function confirmClaudeImport(): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    'CodexまたはGeminiのローカル設定（MCPサーバー・AGENTS.md・カスタムコマンドなど）を' +
      'このClaude Codeへ取り込む準備をします。\n\n' +
      '送るのは確認（プレビュー）の要求だけで、ここでは何も書き換えません。' +
      'CLIが会話内に取り込み対象と確認コマンドを提示するので、実際に取り込むかどうかは' +
      'その応答を見てから改めて判断してください。',
    { modal: true },
    '確認を送る',
  );
  return choice === '確認を送る';
}

/**
 * 追加クレジット（usage credits）の設定・管理者への要求を送ってよいか確かめる
 * （issue #204、design.md §14.38。Claude Code画面のみ）。
 *
 * 実測（`streamSession.ts` の `requestUsageCredits` 参照）では、この拡張機能の
 * 非対話セッションから送ると常に管理ページのURLを返すだけの固定文になり、組織の
 * 管理者への通知はCLIの対話セッションでしか起きないと見られる。ただしこれは1状態
 * （追加クレジット無効）だけの実測で、有効時や他の理由で挙動が変わらない保証は無い。
 * `/usage-credits`というコマンド自体がCLIの語彙で「管理者への要求」を明言している
 * ため、`confirmClaudeImport`と同じく安全側に倒して必ず確認を挟む。
 */
export async function confirmUsageCreditsRequest(): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    '追加クレジットの設定・管理者への要求（/usage-credits）を送ります。\n\n' +
      'この拡張機能からの送信は対話操作ができないため、実際には管理ページを開くための' +
      'リンクが会話に返るだけの見込みです。ただし将来のCLIの更新やアカウントの状態に' +
      'よっては、この操作が組織の管理者に通知される可能性があります。',
    { modal: true },
    '送る',
  );
  return choice === '送る';
}

/**
 * `/debug`（CLI側のデバッグログをモデルに読ませて診断させる要求）を送ってよいか確かめる
 * （issue #205、design.md §14.39。Claude Code画面のみ）。
 *
 * 本体の事前実測（issue #205のコメント、CLI 2.1.227）によれば、`/debug`は`/usage-credits`
 * よりさらに重い操作で、**実モデル（`claude-opus-5`）が動きBashツールで`ls`・`cat`を
 * 実行**してログを読む。課金される（実測: `total_cost_usd: 0.3824885`）うえ、承認が
 * 要る構成では承認カードも出る。ログの中身を見るだけなら「デバッグログを開く」
 * （`openDebugLog`、CLIへは何も送らず無償）のほうが軽いため、その旨も文面に含めて
 * 誤って高コストな方を選ばないようにする。
 */
export async function confirmDebugCommand(): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    'デバッグログの診断（/debug）を送ります。\n\n' +
      '実測（CLI 2.1.227）では実モデルが起動し、Bashツールでログファイルを読んで要約' +
      'します（実測時のコストはUSD 0.38ほど）。承認が必要な設定では承認カードが出ます。' +
      'ログ自体は既に~/.claude/debug/配下に常時出ているため、内容を直接確認したい' +
      'だけなら「デバッグログを開く」のほうが低コストです。',
    { modal: true },
    '送る',
  );
  return choice === '送る';
}

/**
 * バックグラウンドタスクを止めてよいか確かめる（issue #33、design.md §14.23、
 * Claude Code画面のみ。Codexには停止する確定した経路が無い）。
 *
 * 実行中の処理を打ち切る破壊的な操作のため、`confirmCompact` / `confirmUninstallPlugin` と
 * 同じく必ず確認を挟む。
 */
export async function confirmStopBackgroundTask(command: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    `バックグラウンドで実行中のタスクを停止します: ${command}`,
    { modal: true },
    '停止する',
  );
  return choice === '停止する';
}

/**
 * 行頭が `!` の入力（issue #5、design.md §14.29）をターミナルへ入力してよいか確かめる。
 *
 * **自動実行はしない**（`openLoginTerminal` と同じ流儀。統合ターミナルへ文字を入力するだけで、
 * 実行するかどうかは開いたターミナルでユーザーが自分でEnterを押して決める）。それでも
 * 何を入力するかは事前にここで確認させる。
 */
export async function confirmRunShellCommand(command: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    `次のコマンドを統合ターミナルへ入力します（自動実行はしません。実行するかはターミナル側でEnterを押して決められます）:\n\n${command}`,
    { modal: true },
    '入力する',
  );
  return choice === '入力する';
}

/**
 * 行頭が `#` の入力（issue #6、design.md §14.29）をメモリへ追記してよいか確かめる。
 *
 * ファイルへの書き込みは元に戻せないため（gitで管理されていない環境もある）、
 * 追記先と内容の両方を確認させてから書く（issue #6の受入基準）。
 *
 * `symlink` は追記先のシンボリックリンク判別結果。本文の組み立ては
 * `buildMemoryAppendConfirmation`（純粋関数）に切り出してある（issue #144。実体パスを
 * 見せずに書き込みが実行されると、実際にどのファイルが書き換わるか分からないため。
 * 実体パスが特定できない場合も警告として出す）。
 */
export async function confirmMemoryAppend(
  content: string,
  path: string,
  symlink: SymlinkResolution,
): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    buildMemoryAppendConfirmation(content, path, symlink),
    { modal: true },
    '追記する',
  );
  return choice === '追記する';
}

/** 確認ダイアログに列挙するファイル数の上限。超えた分は件数だけ示す。 */
const REWIND_FILE_LIST_LIMIT = 10;

/**
 * ファイルの巻き戻し（Claude Code画面のみ）を実行してよいか確かめる。
 *
 * **会話の履歴には触れず、ファイルだけを戻す**。取り違えると作業が失われるため、
 * 対象ファイルを列挙したうえで「会話は変わらない」ことを明記する
 * （design.md「Claude Codeの巻き戻し」・Issue #21の受入基準）。
 */
export async function confirmRewindFiles(files: readonly string[]): Promise<boolean> {
  const shown =
    files.length > REWIND_FILE_LIST_LIMIT
      ? [...files.slice(0, REWIND_FILE_LIST_LIMIT), `他 ${files.length - REWIND_FILE_LIST_LIMIT}件`]
      : files;
  const choice = await vscode.window.showWarningMessage(
    `次のファイルを、この発言を送る前の状態に戻します。会話の履歴は変わりません。元には戻せません。\n\n${shown.join('\n')}`,
    { modal: true },
    'ファイルを戻す',
  );
  return choice === 'ファイルを戻す';
}

/**
 * ターン完了時の成果を作業記録へ通知する。Codex画面・Claude Code画面の両方で共有する。
 * 応答テキストと編集ファイルの両方が空なら何もしない。
 */
export function reportTurnResult(
  onActivity: (activity: ChatActivity) => void,
  sessionId: string | undefined,
  cwd: string | undefined,
  state: ChatState,
): void {
  if (sessionId === undefined || cwd === undefined) {
    return;
  }
  if (state.turnResultText === '' && state.turnEditedFiles.length === 0) {
    return;
  }
  onActivity({
    sessionId,
    cwd,
    kind: 'result',
    text: state.turnResultText,
    editedFiles: state.turnEditedFiles,
  });
}

/**
 * 会話全体の取り出し（issue #25・design.md §14.23）で選ばせる操作。
 * `runReview` の対象選択と同じQuickPickの流儀に揃える。
 */
const TRANSCRIPT_EXPORT_ITEMS: (vscode.QuickPickItem & { mode: 'copy' | 'save' | 'raw' })[] = [
  { mode: 'copy', label: 'クリップボードへコピー', detail: '会話全体をMarkdownでコピーします' },
  { mode: 'save', label: 'ファイルへ保存', detail: 'Markdownファイルとして保存します' },
  {
    mode: 'raw',
    label: '生テキストで開く',
    detail: '装飾を落として新しいタブに開きます。コピー・検索・保存もそのままできます',
  },
];

/**
 * 会話全体をMarkdownとして取り出す。Codex画面・Claude Code画面の両方で共有する。
 *
 * Markdownの組み立ては純粋関数（`buildTranscriptMarkdown`）に任せ、ここでは
 * 「何をするか」をQuickPickで選ばせてから実行するだけにする。**外部へ送る機能は作らない**
 * （クリップボード・ローカルファイル・エディタタブの3つに留める。issue #25の仕様）。
 *
 * 生テキストで開く操作は、ワークフロー生成が検証エラー時にやっている
 * `vscode.workspace.openTextDocument({content, language})` と同じ手（`extension.ts`
 * の `handlePlanFailure` 参照）で、通常のエディタとして開けばコピー・検索・保存が
 * VSCode標準の操作でできる。
 */
export async function runExportTranscript(
  items: readonly ChatItem[],
  agentLabel: string,
): Promise<void> {
  if (items.length === 0) {
    void vscode.window.showInformationMessage('会話がまだ無いため取り出せません');
    return;
  }

  const choice = await vscode.window.showQuickPick(TRANSCRIPT_EXPORT_ITEMS, {
    title: '会話を取り出す',
    placeHolder: '何をしますか',
  });
  if (choice === undefined) {
    return;
  }

  const markdown = buildTranscriptMarkdown(items, agentLabel);

  if (choice.mode === 'copy') {
    await vscode.env.clipboard.writeText(markdown);
    void vscode.window.showInformationMessage('会話をMarkdownでコピーしました');
    return;
  }

  if (choice.mode === 'save') {
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(defaultTranscriptFileName(new Date())),
      filters: { Markdown: ['md'] },
    });
    if (uri === undefined) {
      return;
    }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(markdown, 'utf8'));
    void vscode.window.showInformationMessage(`会話を保存しました: ${uri.fsPath}`);
    return;
  }

  const doc = await vscode.workspace.openTextDocument({ content: markdown, language: 'markdown' });
  await vscode.window.showTextDocument(doc, { preview: false });
}

/**
 * コードブロックの言語表記からVSCodeの言語IDへの雑な対応表（issue #290）。
 * Markdown内の言語表記（```ts など）はCommonMarkの決まりが無く自由記法のため、
 * よく出るものだけ変換し、当てはまらないものはそのまま言語IDとして渡す
 * （VSCodeは未知の言語IDでもプレーンテキストとして開くだけで落ちない）。
 */
const CODE_FENCE_LANGUAGE_IDS: Readonly<Record<string, string>> = {
  js: 'javascript',
  jsx: 'javascriptreact',
  ts: 'typescript',
  tsx: 'typescriptreact',
  py: 'python',
  rb: 'ruby',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  yml: 'yaml',
  md: 'markdown',
  html: 'html',
  cs: 'csharp',
  cpp: 'cpp',
  rs: 'rust',
  kt: 'kotlin',
};

function codeFenceLanguageId(lang: string): string {
  const trimmed = lang.trim().toLowerCase();
  if (trimmed === '') {
    return 'plaintext';
  }
  return CODE_FENCE_LANGUAGE_IDS[trimmed] ?? trimmed;
}

/**
 * コードブロックの「エディタへ挿入」（issue #290）。
 *
 * Webviewから直接エディタへは書き込めないため、`vscode.postMessage` でホスト側へ
 * 要求を送り（`chatScript.ts` の `insertCode`）、ここで実際のアクティブエディタへ
 * 差し込む。開いているエディタが無ければ何もできないので、その旨を伝えて終わる。
 */
export async function insertCodeIntoEditor(code: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined) {
    void vscode.window.showInformationMessage('挿入先のエディタが開かれていません');
    return;
  }
  await editor.edit((builder) => {
    for (const selection of editor.selections) {
      builder.replace(selection, code);
    }
  });
}

/**
 * コードブロックの「新規ファイルで開く」（issue #290）。
 *
 * `runExportTranscript` の「生テキストで開く」と同じ手（`vscode.workspace.openTextDocument`
 * に保存前のコンテンツを渡すだけ）で、保存前の未タイトルタブとして開く。
 */
export async function openCodeInNewFile(code: string, lang: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({
    content: code,
    language: codeFenceLanguageId(lang),
  });
  await vscode.window.showTextDocument(doc, { preview: false });
}

/**
 * Webviewから届いた差分の操作要求（`itemId` + `diffIndex`）を、会話が実際に持つ差分へ
 * 引き当てる（issue #291）。
 *
 * Webviewが送ってくる可能性のある path・diff本文・種類をそのまま信用せず、会話状態
 * （`entry.session.getState().items`）から引き直す。転写された内容（エージェントの
 * 出力に由来する文字列）を経路の判断にそのまま使わない、というこのリポジトリの方針に
 * 沿う（`buildImageReply` が画像パスを会話の中身から引き当てるのと同じ考え方）。
 */
function resolveDiffTarget(
  items: readonly ChatItem[],
  itemId: unknown,
  diffIndex: unknown,
): FileDiff | undefined {
  if (typeof itemId !== 'string' || typeof diffIndex !== 'number') {
    return undefined;
  }
  const item = items.find((i) => i.id === itemId);
  return item?.diffs[diffIndex];
}

/**
 * 差分の対象パス（`movePath` があればそちら）をワークスペース内へ解決する（issue #291）。
 *
 * 文字列だけの境界判定（`resolveWithinWorkspace`）のあと、実ファイルシステムに触れて
 * シンボリックリンクによる脱出も無いかを確かめる（`verifyRealPathWithinWorkspace`。
 * issue #144の追記処理と同じ考え方）。Webview側（`chatScript.ts`）にも簡易な判定を
 * 置いてボタンの出し分けに使うが、ここが最終判定であり、Webview側の結果は信用しない。
 */
async function resolveDiffFileForAction(diff: FileDiff): Promise<DiffPathResolution> {
  const targetPath = diff.movePath ?? diff.path;
  const roots = workspaceFolderPaths();
  const staticCheck = resolveWithinWorkspace(targetPath, roots);
  if (!staticCheck.ok) {
    return staticCheck;
  }
  return verifyRealPathWithinWorkspace(staticCheck.absolutePath, roots, fsRealpath);
}

/**
 * 差分の見出し行「エディタで開く」（issue #291）。
 *
 * 対象ファイルを開き、可能ならハンクの最初の行（`planDiffActions` の `jumpToLine`）へ
 * カーソルを移す。`delete` の差分はファイルが既に無い前提のため、`planDiffActions` が
 * `openEditor: false` を返し、ここへは到達しない（呼び出し側で弾く）。
 */
export async function handleOpenDiffFile(
  items: readonly ChatItem[],
  itemId: unknown,
  diffIndex: unknown,
): Promise<void> {
  const diff = resolveDiffTarget(items, itemId, diffIndex);
  if (diff === undefined) {
    return;
  }
  const plan = planDiffActions(diff);
  if (!plan.openEditor) {
    void vscode.window.showInformationMessage(
      `このファイルは開けません（削除された変更、または未対応の種類です）: ${diff.path}`,
    );
    return;
  }
  const resolved = await resolveDiffFileForAction(diff);
  if (!resolved.ok) {
    void vscode.window.showWarningMessage(resolved.error);
    return;
  }
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved.absolutePath));
  } catch (e) {
    void vscode.window.showWarningMessage(
      `ファイルを開けませんでした: ${resolved.absolutePath}（${e instanceof Error ? e.message : String(e)}）`,
    );
    return;
  }
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  if (plan.jumpToLine !== undefined && editor !== undefined) {
    const line = Math.min(Math.max(plan.jumpToLine - 1, 0), Math.max(doc.lineCount - 1, 0));
    const pos = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }
}

/**
 * 差分の対象ファイルの、現在の実際の内容を読む（無ければ `undefined`）。
 *
 * `delete` の差分は「ファイルは既に無い」ことを前提に再作成する。ここで読みに行かず
 * 常に `undefined` を返してしまうと、`computeDiffContents` の delete 分岐にある
 * 「ファイルが既に存在します」の検査が構造的に一度も真にならず、差分を取ったあとに
 * 同じパスへ作り直された別のファイルを、確認だけ通して無条件に上書きしてしまう
 * （`vscode.workspace.fs.writeFile` はゴミ箱を経由しないため復旧もできない）。
 *
 * 存在の判定に `FileSystemPort.readTextFile` を使わないのは、あれが「読めなければ無い扱い」
 * であり、ENOENT以外（EACCES/EISDIR等）でも `undefined` を返すため（`src/session/ports.ts`
 * のissue #144のメモ参照）。実在するのに読めないファイルを「無い」と誤認すると、まさに
 * 上書きしてはいけない場面で上書きしてしまう。`stat` はENOENTを他の失敗と区別できるので、
 * 判断が付かないときは「在る」側（＝戻す操作を止める側）へ倒す。
 */
async function readCurrentDiffContent(
  fs: FileSystemPort,
  diff: FileDiff,
  absolutePath: string,
): Promise<string | undefined> {
  if (diff.kind === 'delete') {
    return existingContentForDeleteRevert(fs, absolutePath);
  }
  return fs.readTextFile(absolutePath);
}

/**
 * `delete` の「戻す」の前に、対象パスに今なにか在るかを確かめる。
 *
 * 戻り値は `computeDiffContents` の delete 分岐が見る「`undefined` か否か」だけが意味を持つ。
 * 在ることが分かった場合・判断が付かない場合は、中身を読めなくても文字列を返して
 * 「状況が変わっている」と扱わせる。
 */
async function existingContentForDeleteRevert(
  fs: FileSystemPort,
  absolutePath: string,
): Promise<string | undefined> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(absolutePath));
  } catch (e) {
    if (e instanceof vscode.FileSystemError && e.code === 'FileNotFound') {
      return undefined;
    }
    // ENOENT以外で確かめられなかった場合は安全側（＝在る扱い）へ倒す
    return '';
  }
  return (await fs.readTextFile(absolutePath)) ?? '';
}

/**
 * 実ファイルが存在すれば、その言語IDを借りる（差分エディタの左右で構文の色付けを揃える）。
 * 読めなければ既定（プレーンテキスト相当）のまま返す。あくまで見た目のための best effort で、
 * 失敗しても操作自体は続ける。
 */
async function guessDiffLanguageId(absolutePath: string): Promise<string | undefined> {
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath));
    return doc.languageId;
  } catch {
    return undefined;
  }
}

/**
 * 保存前の仮想ドキュメントを開く（差分エディタの片側に使う）。`language` が
 * `undefined` のときはキー自体を渡さない（`exactOptionalPropertyTypes` のため。
 * `{ language: undefined }` は許されない）。
 */
async function openVirtualDiffDocument(
  content: string,
  language: string | undefined,
): Promise<vscode.TextDocument> {
  return vscode.workspace.openTextDocument(
    language === undefined ? { content } : { content, language },
  );
}

/**
 * 差分の見出し行「差分を開く」（issue #291）。
 *
 * 変更前の内容の作り方は design.md §14.52 の設計判断を参照。要約すると、gitの索引とは
 * 比較せず、会話に届いた unified diff 自身から復元する（`computeDiffContents`）。
 * 復元の過程で現在の実ファイルの内容と突き合わせ、差分を取ったときから変わっていれば
 * 開かずに理由を返す（issue #291の受入基準）。
 *
 * 変更前はその場で組み立てた保存前ドキュメント（`openTextDocument({content, language})`）、
 * 変更後は原則として実ファイルそのもの（そのまま編集・保存もできる）を使う。`delete` の
 * 差分だけは実ファイルが既に無いため、変更後側も空文字の保存前ドキュメントにする。
 */
export async function handleOpenDiffEditor(
  fs: FileSystemPort,
  items: readonly ChatItem[],
  itemId: unknown,
  diffIndex: unknown,
): Promise<void> {
  const diff = resolveDiffTarget(items, itemId, diffIndex);
  if (diff === undefined) {
    return;
  }
  const plan = planDiffActions(diff);
  if (!plan.openDiff) {
    void vscode.window.showWarningMessage(
      `この差分は復元できないため開けません（ハンク見出しが無い、またはコンテキストが足りない可能性があります）: ${diff.path}`,
    );
    return;
  }
  const resolved = await resolveDiffFileForAction(diff);
  if (!resolved.ok) {
    void vscode.window.showWarningMessage(resolved.error);
    return;
  }
  const currentContent = await readCurrentDiffContent(fs, diff, resolved.absolutePath);
  const computed = computeDiffContents(diff, currentContent);
  if (!computed.ok) {
    void vscode.window.showWarningMessage(`差分を開けません: ${computed.error}`);
    return;
  }
  const language = await guessDiffLanguageId(resolved.absolutePath);
  const beforeDoc = await openVirtualDiffDocument(computed.before, language);
  const afterUri =
    diff.kind === 'delete'
      ? (await openVirtualDiffDocument(computed.after, language)).uri
      : vscode.Uri.file(resolved.absolutePath);
  await vscode.commands.executeCommand(
    'vscode.diff',
    beforeDoc.uri,
    afterUri,
    `${diff.path}（変更前 ↔ 変更後）`,
  );
}

/**
 * 「この変更を戻す」を実行してよいか確かめる（issue #291）。
 *
 * 破壊的な操作（`add`ならファイルを削除、`delete`なら再作成、`update`なら内容の上書き）
 * のため、既存の破壊的操作（`confirmRewindFiles`・`confirmStopBackgroundTask`）と同じく
 * 必ずモーダルで確認する。
 */
export async function confirmRevertDiff(diff: FileDiff): Promise<boolean> {
  const detail =
    diff.kind === 'add'
      ? `ファイルを削除します: ${diff.path}`
      : diff.kind === 'delete'
        ? `ファイルを元の内容で復元します: ${diff.path}`
        : `ファイルの内容を、この変更を適用する前の状態へ戻します: ${diff.path}`;
  const choice = await vscode.window.showWarningMessage(
    `この差分の変更を戻します。元には戻せません。\n\n${detail}`,
    { modal: true },
    '戻す',
  );
  return choice === '戻す';
}

/**
 * 差分の見出し行「この変更を戻す」（issue #291）。
 *
 * 確認モーダル（`confirmRevertDiff`）の前後2回、現在の内容を読み直して差分の想定と
 * 突き合わせる。1回目は確認を出す価値があるかどうかの事前チェック、2回目はTOCTOU対策
 * （ユーザーの応答待ちは不定長で、その間に内容が変わりうる。issue #144のメモリ追記と
 * 同じ考え方）。`add`の取り消しはファイルの削除（ゴミ箱へ）、それ以外は内容の書き込みで行う。
 */
export async function handleRevertDiff(
  fs: FileSystemPort,
  items: readonly ChatItem[],
  itemId: unknown,
  diffIndex: unknown,
): Promise<void> {
  const diff = resolveDiffTarget(items, itemId, diffIndex);
  if (diff === undefined) {
    return;
  }
  const plan = planDiffActions(diff);
  if (!plan.revert) {
    void vscode.window.showWarningMessage(
      `この変更は戻せません（移動を伴う変更、または差分を復元できない形式です）: ${diff.path}`,
    );
    return;
  }
  const resolved = await resolveDiffFileForAction(diff);
  if (!resolved.ok) {
    void vscode.window.showWarningMessage(resolved.error);
    return;
  }
  const beforeConfirm = await readCurrentDiffContent(fs, diff, resolved.absolutePath);
  const precheck = computeDiffContents(diff, beforeConfirm);
  if (!precheck.ok) {
    void vscode.window.showWarningMessage(`変更を戻せません: ${precheck.error}`);
    return;
  }
  if (!(await confirmRevertDiff(diff))) {
    return;
  }
  // TOCTOU対策: 確認モーダル（ユーザー応答待ちで不定長）の間に内容が変わりうるため、
  // 書き込み・削除の直前にもう一度読み直して確かめる（issue #144のメモリ追記と同じ考え方）
  const atRevert = await readCurrentDiffContent(fs, diff, resolved.absolutePath);
  const recomputed = computeDiffContents(diff, atRevert);
  if (!recomputed.ok) {
    void vscode.window.showWarningMessage(`変更を戻せませんでした: ${recomputed.error}`);
    return;
  }
  try {
    if (diff.kind === 'add') {
      await vscode.workspace.fs.delete(vscode.Uri.file(resolved.absolutePath), {
        useTrash: true,
      });
    } else {
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(resolved.absolutePath),
        Buffer.from(recomputed.before, 'utf8'),
      );
    }
  } catch (e) {
    void vscode.window.showErrorMessage(
      `変更を戻せませんでした: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }
  void vscode.window.showInformationMessage(`変更を戻しました: ${diff.path}`);
}

/**
 * 会話に出てきた画像をWebviewへ返す。Codex画面・Claude Code画面の両方で共有する。
 *
 * 画像はデータURLにして送る。`localResourceRoots` を広げて `asWebviewUri` で参照させると、
 * その範囲のファイルをWebviewから自由に読めるようになるため、そちらへは寄せない。
 * 読めるのは**会話に出てきたパスだけ**（判定は `buildImageReply`）。
 */
export async function postImageData(
  panel: vscode.WebviewPanel,
  fs: FileSystemPort,
  items: readonly ChatItem[],
  requested: unknown,
): Promise<void> {
  const reply = await buildImageReply(items, requested, (filePath, maxBytes) =>
    fs.readBase64File(filePath, maxBytes),
  );
  if (reply !== undefined) {
    void panel.webview.postMessage({ type: 'imageData', ...reply });
  }
}

/** `@` の候補として返す最大件数。画面に収まる範囲に留める。 */
const MENTION_LIMIT = 50;

/**
 * `@` のファイル候補をWebviewへ返す。
 *
 * **絞り込みはホスト側で行う。** 同じ規則をWebviewにも書くと、片方だけ直したときに
 * 「候補に出たのに違うものが入る」状態になる。走査を間引くのはカタログの責務。
 */
export async function postFileMentions(
  panel: vscode.WebviewPanel,
  mentions: FileMentionCatalog,
  cwd: string | undefined,
  query: unknown,
): Promise<void> {
  if (typeof query !== 'string') {
    return;
  }
  // 復元されたCodex画面はcwdを持たない。そのときはこのウィンドウのフォルダを充てる
  const folder = cwd ?? currentWorkspaceFolder()?.uri.fsPath;
  if (folder === undefined) {
    return;
  }
  const files = filterFiles(await mentions.list(folder), query, MENTION_LIMIT);
  void panel.webview.postMessage({ type: 'files', query, files });
}

export interface ChatShellOptions {
  /** 画面に出すCLIの名前。発言の見出しと入力欄の案内に使う。 */
  agentLabel: string;
  /**
   * この画面のプロバイダ。承認レベル（3段階）が実際にどの値へ展開されるかの
   * 出し分けに使う（Codexは承認方法とサンドボックスの2軸、Claude Codeは1軸）。
   */
  provider: ProviderId;
  /** 承認方法の選択肢。プロバイダごとに異なる（承認の詳細に出す生の値）。 */
  approvalModes: readonly string[];
  /**
   * Shift+Tabで回す承認レベルの並び（issue #13）。渡さなければキー操作を効かせない。
   */
  approvalCycle?: readonly string[];
  /**
   * サンドボックスの選択肢。渡さなければセレクタ自体を出さない。
   *
   * Claude Codeにサンドボックスの概念は無く、権限は `--permission-mode` に集約される。
   */
  sandboxModes?: readonly string[];
  /** モデル・effort・承認のプルダウンを出すか（Codex画面のみ）。 */
  showSettings: boolean;
  /**
   * エージェントのプルダウンを出すか（Claude Code画面のみ）。
   *
   * Codexにエージェントの概念は無い。選択肢はモデル・effortと同じく空のまま描画し、
   * `state.settings.agents` を受け取ってから `applySettings` が埋める（`fillSelect`）。
   */
  showAgentSelector?: boolean;
  /** レビューボタンの動作。Codexは常に出し、Claude Codeはコマンド一覧にあるときだけ出す。 */
  review: ReviewButtonConfig;
  /**
   * 設定行の下に出す但し書き。
   *
   * 変更がいつから効くかはプロバイダで違う。書かないと「変えたのに効かない」に見える。
   */
  settingsNote?: string;
  /**
   * 発言ごとに「ここまで戻す」ボタンを出すか（Claude Code画面のみ）。
   *
   * Codexには会話の途中から**分岐**する導線（「ここから分岐」）が既にあり、巻き戻しは
   * 実装しない（design.md「Claude Codeの巻き戻し」。thread/rollbackはdeprecatedかつ
   * ファイルを戻さない）。Claude Codeは`rewind_files`でファイルだけを戻せる。
   */
  showRewind?: boolean;
  /**
   * 発言ごとに「ここから分岐」ボタンを出すか（issue #333、design.md §14.61）。
   *
   * Codex画面は常にtrue相当（`showTurnFork`を渡さなくても、対象は「直前の発言の
   * `turnId`」として既定で計算される）。Claude Code画面はこれをtrueにして渡し、対象を
   * 「発言自身のuuid（`item.id`）」に切り替える。`rewind_conversation`（会話の途中の
   * ターンから分岐）はfork対象の発言自身を戻り先として指定する仕様のため、Codexの
   * `thread/fork`（対象は「引き継ぐ最後のターン」＝直前の発言）とは向きが違う
   * （`chatScript.ts` の `turnForkTarget` 参照）。
   */
  showTurnFork?: boolean;
  /**
   * 入力欄の下に `!`/`#` 始まりの案内を出すか（Claude Code画面のみ、issue #5/#6、
   * design.md §14.29）。CodexのTUIにこの挙動は無い。
   */
  showInputModeHints?: boolean;
  /**
   * 「他エージェントから設定をインポート」ボタンを出すか。
   *
   * 押したときの動きはプロバイダごとに違う。Claude Code（issue #200、design.md §14.34、
   * TP-88）は`/import` のプレビューを会話へ送る。Codex（issue #227、design.md §14.42）は
   * 同じ機能を既にコントロールパネルの一覧UI（issue #36）で持っているため、二重実装は
   * せず、設定パネルを表示して「他エージェントからの設定インポート」のセクションを
   * 展開するだけに留める。動きが違う以上ボタンの`aria-label`・`title`も揃えられないため、
   * `true`（Claude Codeの既定文言のまま出す）か、文言を差し替えるオブジェクトかを選べる
   * ようにしている。
   */
  showImport?: boolean | { ariaLabel: string; title: string };
  /**
   * 「会話の1行要約」ボタンを出すか（Claude Code画面: issue #203、design.md §14.36。
   * Codex画面: issue #228、design.md §14.41）。
   *
   * ボタンを出すかどうかの意味は両画面で共通だが、**押したときに送る中身はプロバイダごとに
   * 違う**。Claude CodeはTUI由来のローカルコマンド`/recap`を発言として送る
   * （`ClaudeStreamSession.recap()`）。Codexにこの概念は無いため、要約を依頼する指示文
   * （`RECAP_INSTRUCTION`）を通常のターンとして送る（`ChatSession.recap()`）。どちらも
   * 応答は会話に残るが、Claude Code側は`<synthetic>`表示、Codex側は通常のモデル応答という
   * 見え方の違いがある（design.md §14.41の対比表参照）。
   */
  showRecap?: boolean;
  /**
   * 自動圧縮の窓サイズの確認・変更欄を出すか（Claude Code画面のみ、issue #201、
   * design.md §14.37）。
   *
   * `/autocompact` はTUI由来のローカルコマンドで、Codexに対応する設定は無い
   * （issue本文の前提どおり）。二重導線を避けるためCodex画面には出さない。
   */
  showAutocompact?: boolean;
  /**
   * CLI側のデバッグログを扱う導線（「デバッグログを開く」「/debugで診断」）を
   * 設定行へ出すか（Claude Code画面のみ、issue #205、design.md §14.39）。
   *
   * どちらもTUI由来の概念（CLIのデバッグログ・`/debug`コマンド）で、Codexに対応する
   * ものは無いため、二重導線を避けてClaude Code画面にだけ出す。常用の操作ではない
   * ため、送信ボタンが並ぶ入力欄ではなく設定行（`#settings`、普段は開かない場所）に
   * 置く（issue本文の「常用の操作と混ざらない置き場」）。
   */
  showDebug?: boolean;
  /**
   * 応答本文をMarkdownとして描画するか（設定 `agent.chat.renderMarkdown`、既定 `true`、
   * issue #290）。両画面共通の設定で、`false` なら旧来の `textContent` +
   * `white-space: pre-wrap` の生テキスト表示へ戻る（`chatScript.ts` の
   * `RENDER_MARKDOWN` 参照）。
   */
  renderMarkdown?: boolean;
  /**
   * 会話画面の表示密度（設定 `agent.chat.density`、既定 `comfortable`、issue #718）。
   * 変換は `density.ts` の `densityBodyClass` が行い、ここでは `body` のクラスにするだけ。
   * 寸法そのものは `chatStyles.ts` のカスタムプロパティが持つ。両画面共通の設定で、
   * `renderMarkdown` / `sendOn` と同じく双方の `attachPanel` から渡す。
   */
  density?: ChatDensity;
  /**
   * 入力欄でEnterを送信に使うか（設定 `agent.chat.sendOn`、既定 `ctrlEnter`、issue #288）。
   *
   * `ctrlEnter`はCtrl+Enter / Cmd+Enterで送信しEnterは改行のまま（従来の挙動）。`enter`は
   * Enterで送信しShift+Enterで改行に回す（Ctrl+Enterでも送信は維持する）。省略時は
   * `ctrlEnter`扱い（`chatScript`のデフォルト引数と`DEFAULT_SEND_ON`が一致することを
   * `sendKey.ts`で保証する）。判定の純粋関数は`sendKey.ts`の`decideSendKeyAction`、
   * webview側の実装は`chatScript.ts`の`SEND_ON`/`SEND_KEY_SOURCE`参照。
   *
   * `renderMarkdown`（issue #290）と同じく、Codex（本ファイル）・Claude Code
   * （`claudeChatView.ts`）双方の`attachPanel`から`readChatSendOnConfig()`を呼んで
   * 渡している（design.md §14.49）。
   */
  sendOn?: SendOnMode;
  /**
   * 入力欄アイコン列（`#composerIconRow`）の表に直接出すボタン（設定`agent.chat.
   * composerButtons`、既定は`DEFAULT_COMPOSER_BUTTONS`＝変更前の並びの先頭4つ、
   * issue #296）。それ以外の既存ボタンは正準の並び（`COMPOSER_BUTTON_IDS`）のまま
   * 「…」メニュー（`#composerOverflowMenu`）へ畳む。**畳んだ後もボタン要素そのものは
   * 移動するだけで、`id`・`hidden`条件・イベント配線は一切変えない**
   * （`composerButtonMarkup`参照）。表・メニューのどちらにあっても`chatScript.ts`が
   * `el(id)`で同じ要素を触るため、`showRecap` / `showImportButton` /
   * `options.review.mode`や、応答中の状態更新（`fastToggle`等）による`hidden`の
   * 出し入れはそのまま効く。省略時は`DEFAULT_COMPOSER_BUTTONS`。
   */
  composerButtons?: readonly ComposerButtonId[];
}

/** 設定から来る文字列をHTMLへ埋め込む前に無害化する。 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

/**
 * `#composer` で送信以外のボタンに使うアイコン（issue #226）。
 *
 * codiconのwebfontは使わない。webviewのCSPは `default-src 'none'` で `font-src` を
 * 開けておらず（`chatCsp.ts`）、未指定のdirectiveは `default-src` に落ちて塞がれるため、
 * フォント読み込みには新しい許可とアセット同梱が要る。外部CDNも使えない。インライン
 * `<svg>` はCSPが制御する「読み込み」に当たらずそのまま描画できるため、これで代える。
 * `currentColor` を使い、通常時／トグルON時のボタン文字色（`chatStyles.ts`の
 * `button`・`button.toggled`）にそのまま追従させる。押した後の挙動はどれも変えない。
 */
const COMPOSER_ICONS = {
  attach:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><circle cx="5.5" cy="6" r="1.1" fill="currentColor" stroke="none"/><path d="M2 12l4-4 3 3 2-2 4 4"/></svg>',
  stop: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><rect x="3" y="3" width="10" height="10" rx="1" fill="currentColor"/></svg>',
  loop: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12.7 4.6A5.5 5.5 0 1 0 13.6 9.2"/><path d="M9.6 2.1l3.3.4-.4 3.3"/></svg>',
  compact:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 2.5l4 4M2.5 2.5v3.3M2.5 2.5h3.3"/><path d="M13.5 13.5l-4-4M13.5 13.5v-3.3M13.5 13.5h-3.3"/></svg>',
  import:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v7M5 6.3l3 2.7 3-2.7"/><path d="M2.5 11v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2"/></svg>',
  recap:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M3 4h10M3 8h10M3 12h6"/></svg>',
  plan: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="2.5" width="10" height="11.5" rx="1"/><path d="M6 1.5h4v1.6H6z" fill="currentColor" stroke="none"/><path d="M5.5 7.2l1.3 1.3L9.6 5.7M5.5 10.8h5"/></svg>',
  fast: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M8.6 1.3 3 9h4l-.9 5.7L13 7H9z" fill="currentColor"/></svg>',
  review:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="6.8" cy="6.8" r="4.3"/><path d="M10.1 10.1 14 14"/></svg>',
  export:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M8 9V2M5.3 4.7 8 2l2.7 2.7"/><path d="M2.5 11v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2"/></svg>',
  workflow:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="3.2" r="1.9"/><circle cx="3.6" cy="12.8" r="1.9"/><circle cx="12.4" cy="12.8" r="1.9"/><path d="M7.2 4.9 4.4 11.1M8.8 4.9l2.8 6.2"/></svg>',
  workflowView:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2.5" width="12" height="11" rx="1.2"/><path d="M5 6h6M5 9h6M5 12h3"/></svg>',
  progress:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="2" width="11" height="12" rx="1.2"/><path d="m5 6 1.2 1.2L8.5 5M9.5 6h1.5M5 10l1.2 1.2L8.5 9M9.5 10h1.5"/></svg>',
  handoff:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8h8M8.5 4.5 12 8l-3.5 3.5"/><path d="M2.5 3.5v9"/></svg>',
  scrollToBottom:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v9M5.3 8.3 8 11l2.7-2.7"/><path d="M3.5 13.5h9"/></svg>',
} as const satisfies Record<string, string>;

/** Claude Code画面の既定のインポートボタン文言（`showImport: true` のときに使う）。 */
const DEFAULT_IMPORT_BUTTON_COPY = {
  ariaLabel: 'インポート',
  title: 'Codex／Geminiの設定をClaude Codeへ取り込む準備をします',
} as const;

/**
 * `composerButtonSpec`が呼び出しごとに参照する、`renderShell`のオプションから決まる
 * 出し分け条件（issue #296）。表に出すか「…」メニューに畳むかで内容を変えない
 * （変えるのは置き場所だけ）ための唯一の入力。
 */
interface ComposerButtonContext {
  importCopy: { ariaLabel: string; title: string };
  showImportButton: boolean;
  showRecap: boolean;
  reviewMode: ReviewButtonConfig['mode'];
}

/** `composerButtonSpec`が返す、id1つ分のaria-label・title・hidden条件・アイコン。 */
interface ComposerButtonSpec {
  ariaLabel: string;
  title: string;
  hidden: boolean;
  /** トグルボタン（計画・高速）だけ`aria-pressed="false"`を持つ。 */
  pressed: boolean;
  icon: string;
}

/**
 * 14個のボタンの元の仕様（aria-label・title・hidden条件・アイコン）を1か所にまとめる
 * （issue #296）。表・「…」メニューのどちらへ描画するかは`renderComposerButton`が
 * 決め、ここでは条件を変えない。**この関数を触るだけで置き場所に関わらず両方へ効く**
 * ことが、受入基準「畳んだ後も同じ条件で出入りする」の実装上の担保。
 */
function composerButtonSpec(id: ComposerButtonId, ctx: ComposerButtonContext): ComposerButtonSpec {
  switch (id) {
    case 'attach':
      return {
        ariaLabel: '画像',
        title: '画像を選んで添えます。貼り付け（Ctrl+V）とドラッグ&ドロップもできます',
        hidden: false,
        pressed: false,
        icon: COMPOSER_ICONS.attach,
      };
    case 'loopToggle':
      return {
        ariaLabel: 'ループ',
        title: '同じ指示を条件成立まで繰り返します',
        hidden: false,
        pressed: false,
        icon: COMPOSER_ICONS.loop,
      };
    case 'compact':
      return {
        ariaLabel: '圧縮',
        title: 'これまでの会話を要約に置き換えてコンテキストを空けます',
        hidden: false,
        pressed: false,
        icon: COMPOSER_ICONS.compact,
      };
    case 'claudeImport':
      return {
        ariaLabel: ctx.importCopy.ariaLabel,
        title: ctx.importCopy.title,
        hidden: !ctx.showImportButton,
        pressed: false,
        icon: COMPOSER_ICONS.import,
      };
    case 'recap':
      return {
        ariaLabel: '要約',
        title: '会話の1行要約をいま作ります（要約は会話に残ります）',
        hidden: !ctx.showRecap,
        pressed: false,
        icon: COMPOSER_ICONS.recap,
      };
    case 'planToggle':
      return {
        ariaLabel: '計画',
        title: '読み取りだけに絞って計画を立てさせます。ファイルは変更されません',
        hidden: false,
        pressed: true,
        icon: COMPOSER_ICONS.plan,
      };
    case 'fastToggle':
      return {
        ariaLabel: '高速',
        title: '応答を速くします（Fast mode）',
        // 応答中の高速切替可否はJS側のstateで制御するため、初期描画では既定でhidden
        // （`chatScript.ts`の`applyFastMode`参照）。表・メニューどちらでも同じ
        hidden: true,
        pressed: true,
        icon: COMPOSER_ICONS.fast,
      };
    case 'review':
      return {
        ariaLabel: 'レビュー',
        title: 'コードレビューを実行します',
        hidden: ctx.reviewMode === 'command',
        pressed: false,
        icon: COMPOSER_ICONS.review,
      };
    case 'exportTranscript':
      return {
        ariaLabel: 'エクスポート',
        title: '会話全体をMarkdownとして取り出します（コピー・ファイル保存・生テキスト表示）',
        hidden: false,
        pressed: false,
        icon: COMPOSER_ICONS.export,
      };
    case 'workflowMenu':
      return {
        ariaLabel: 'ワークフロー',
        title: 'ワークフロー（複数タスクの並列実行）の実行・View・生成・停止を選びます',
        hidden: false,
        pressed: false,
        icon: COMPOSER_ICONS.workflow,
      };
    case 'teamWorkflow':
      return {
        ariaLabel: 'チームモードを開始',
        title: 'ゴールを役割ごとのセッションへ分けたワークフローを作成します',
        hidden: false,
        pressed: false,
        icon: COMPOSER_ICONS.workflow,
      };
    case 'workflowView':
      return {
        ariaLabel: 'ワークフローViewを開く',
        title: 'ワークフローの定義と進行状況を表示します',
        hidden: false,
        pressed: false,
        icon: COMPOSER_ICONS.workflowView,
      };
    case 'openProgress':
      return {
        ariaLabel: '進捗を表示',
        title: 'このセッションの進捗を別タブで表示します',
        hidden: false,
        pressed: false,
        icon: COMPOSER_ICONS.progress,
      };
    case 'handoffToNewSession':
      return {
        ariaLabel: '新セッションへ引き継ぐ',
        title: 'この会話の内容を新しいセッションへ引き継ぎます',
        hidden: false,
        pressed: false,
        icon: COMPOSER_ICONS.handoff,
      };
  }
}

/**
 * ボタン1個分のHTMLを組み立てる（issue #296）。`variant: 'toolbar'`は表
 * （`#composerIconRow`直下）向けで従来と同じアイコンのみの見た目、`'menu'`は「…」
 * メニュー（`#composerOverflowMenu`）向けで`role="menuitem"`と可読のラベル文字列を
 * 添える（tooltipを読まなくても区別できるように。アイコン化そのものが今回の課題の
 * 発端だったため、畳んだ先でまで同じ問題を繰り返さない判断）。`id`・aria-label・
 * title・hidden条件は`composerButtonSpec`の一箇所だけを見るため、置き場所によって
 * 条件がずれることがない。
 */
function renderComposerButton(
  id: ComposerButtonId,
  ctx: ComposerButtonContext,
  variant: 'toolbar' | 'menu',
): string {
  const spec = composerButtonSpec(id, ctx);
  const ariaLabel = escapeHtml(spec.ariaLabel);
  const title = escapeHtml(spec.title);
  const pressedAttr = spec.pressed ? ' aria-pressed="false"' : '';
  const roleAttr = variant === 'menu' ? ' role="menuitem"' : '';
  const label = variant === 'menu' ? `<span class="composerOverflowLabel">${ariaLabel}</span>` : '';
  const hiddenAttr = spec.hidden ? ' hidden' : '';
  return `<button id="${id}" type="button" class="secondary"${pressedAttr} aria-label="${ariaLabel}" title="${title}"${roleAttr}${hiddenAttr}>${spec.icon}${label}</button>`;
}

/**
 * チャット画面のHTMLを組み立てる。CodexとClaude Codeで共有する。
 * 描画するのは `ChatState` だけなので、プロバイダごとの差はここでは扱わない。
 */
export function renderShell(webview: vscode.Webview, options: ChatShellOptions): string {
  const nonce = randomBytes(16).toString('base64');
  const csp = chatCsp(webview.cspSource, nonce);
  const showImportButton = options.showImport === true || typeof options.showImport === 'object';
  const importCopy =
    typeof options.showImport === 'object' ? options.showImport : DEFAULT_IMPORT_BUTTON_COPY;
  const sendOn = options.sendOn ?? DEFAULT_SEND_ON;
  // 入力欄の案内文を設定に追随させる（issue #288）。既定（ctrlEnter）は従来と同じ文言。
  const sendKeyHint = sendOn === 'enter' ? 'Enterで送信、Shift+Enterで改行' : 'Ctrl+Enterで送信';
  // 表に直接出すボタン（設定 agent.chat.composerButtons、issue #296）。それ以外は
  // 正準の並び（COMPOSER_BUTTON_IDS）のまま「…」メニューへ畳む
  // （overflowComposerButtons）。読み込み・検証は呼び出し側（chatView.ts /
  // claudeChatView.tsのattachPanel）の責務で、ここでは既に検証済みの配列を受け取るだけ
  const primaryComposerButtons = options.composerButtons ?? DEFAULT_COMPOSER_BUTTONS;
  const overflowButtons = overflowComposerButtons(primaryComposerButtons);
  const composerButtonCtx: ComposerButtonContext = {
    importCopy,
    showImportButton,
    showRecap: options.showRecap === true,
    reviewMode: options.review.mode,
  };

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
${chatStyles()}
</style>
</head>
<body class="${densityBodyClass(options.density ?? DEFAULT_CHAT_DENSITY)}">
  <div id="logWrap">
    <div id="log"></div>
    <button id="scrollToBottom" type="button" aria-label="会話の一番下へ移動" title="会話の一番下へ移動します" hidden>${COMPOSER_ICONS.scrollToBottom}</button>
  </div>
  <div id="approvals"></div>
  <div id="prompts"></div>
  <div id="queue" hidden>
    <div class="head">
      <span id="queueLabel"></span>
      <button id="flushQueue" type="button" class="secondary">今すぐ送る</button>
    </div>
    <ol id="queueList"></ol>
  </div>
  <div id="status"></div>
  <div id="todos" hidden>
    <div class="head">TODO一覧</div>
    <ul id="todosList"></ul>
  </div>
  <details id="backgroundTerminals" hidden>
    <summary title="バックグラウンドで実行中の処理を開閉します"><span class="label">バックグラウンドで実行中</span><span id="backgroundTerminalsSummary"></span></summary>
    <ul id="backgroundTerminalsList"></ul>
  </details>
  <div id="loopBar" hidden>
    <span id="loopProgress"></span>
    <button id="loopStop" type="button" class="secondary" hidden>ループ停止</button>
  </div>
  <div id="attachments" hidden></div>
  <div id="argumentHint" hidden></div>
  <div id="inputModeHint" hidden></div>
  <div id="composer">
    <div id="commands" hidden></div>
    <div id="composerInputRow">
      <textarea id="input" placeholder="${options.agentLabel}への指示を入力（${sendKeyHint}、画像はCtrl+Vで貼り付け）"></textarea>
      <button id="send" type="button">送信</button>
      <button id="stop" type="button" class="secondary" aria-label="中断" title="Escでも中断できます" hidden>${COMPOSER_ICONS.stop}</button>
    </div>
    <div id="composerIconRow">
      <input id="filePicker" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden>
      ${primaryComposerButtons
        .map((id) => renderComposerButton(id, composerButtonCtx, 'toolbar'))
        .join('\n      ')}
      <div id="composerOverflow"${overflowButtons.length === 0 ? ' hidden' : ''}>
        <button id="composerOverflowToggle" type="button" class="secondary" aria-haspopup="true" aria-expanded="false" aria-label="その他" title="その他の操作を開きます">...</button>
        <div id="composerOverflowMenu" role="menu" hidden>
          ${overflowButtons
            .map((id) => renderComposerButton(id, composerButtonCtx, 'menu'))
            .join('\n          ')}
        </div>
      </div>
    </div>
  </div>
  <div id="loop" hidden>
    <label>初回指示（空なら継続指示から始めます）
      <textarea id="loopInitial" placeholder="例: 第1話を執筆してください"></textarea>
    </label>
    <label>継続指示（2回目以降に繰り返します）
      <textarea id="loopContinue" placeholder="例: 次へ"></textarea>
    </label>
    <div class="line">
      <label>最大回数
        <input id="loopMax" type="number" min="1" max="200" value="20">
      </label>
      <label class="grow">終了条件（空なら回数だけで終わります）
        <input id="loopCondition" type="text" placeholder="例: 20話の執筆が完了している">
      </label>
      <button id="loopStart" type="button">ループ開始</button>
    </div>
  </div>
  <details id="settingsBox"${options.showSettings ? '' : ' hidden'}>
    <summary title="モデル・承認などの設定を開閉します"><span class="label">設定</span><span id="settingsSummary"></span></summary>
    <div id="settings">
    <label>モデル <select id="model"></select></label>
    <label>Effort <select id="reasoningEffort"></select></label>
    <label>承認 <select id="approvalLevel">
      ${APPROVAL_LEVELS.map((l) => `<option value="${l}">${APPROVAL_LEVEL_LABELS[l]}</option>`).join('')}
    </select></label>
    <details id="approvalDetails">
    <summary title="承認方法・サンドボックスを個別に指定します"><span class="label">承認の詳細</span></summary>
    <div class="detailBody">
    <label>承認方法 <select id="approvalMode">
      <option value="">既定</option>
      ${options.approvalModes.map((m) => `<option value="${m}">${m}</option>`).join('')}
    </select></label>
    ${
      options.sandboxModes === undefined
        ? ''
        : `<label>Sandbox <select id="sandbox">
      <option value="">既定</option>
      ${options.sandboxModes.map((m) => `<option value="${m}">${m}</option>`).join('')}
    </select></label>`
    }
    ${
      options.showAgentSelector === true
        ? '<label>エージェント <select id="agent"></select></label>'
        : ''
    }
    </div>
    </details>
    ${
      options.showAutocompact === true
        ? `<label>自動圧縮 <input id="autocompactInput" type="text" placeholder="autoまたは100k~1M" title="空欄のまま「自動圧縮」を押すと現在値を確認します。'auto'または100k~1Mトークンの数値（例: 500k, 200000, 200）を入れると変更します"></label>
    <button id="autocompactApply" type="button" class="secondary" title="自動圧縮の窓サイズを確認・変更します（応答は会話に残ります）">自動圧縮</button>`
        : ''
    }
    ${
      options.showDebug === true
        ? `<button id="openDebugLog" type="button" class="secondary" title="このセッションのCLIデバッグログ（~/.claude/debug/配下）をエディタで開きます。CLIへは何も送らず、課金もありません">デバッグログを開く</button>
    <button id="sendDebugCommand" type="button" class="secondary" title="/debugを送り、実モデルにログを読ませて診断させます。実測ではモデルが動き課金されます（送信前に確認します）">/debugで診断</button>`
        : ''
    }
    ${options.settingsNote === undefined ? '' : `<p class="note">${escapeHtml(options.settingsNote)}</p>`}
    </div>
  </details>

<script nonce="${nonce}">
${chatScript(options.agentLabel, options.review, options.showRewind === true, options.approvalCycle ?? [], options.showInputModeHints === true, options.renderMarkdown !== false, sendOn, JSON.stringify(approvalLevelMeta()), options.provider, options.showTurnFork === true)}
</script>
</body>
</html>`;
}
