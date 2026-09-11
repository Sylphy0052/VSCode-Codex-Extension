import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ChatState } from '../appserver/chatState';

/**
 * セッションの引き継ぎ（issue #694、ポインタファイル方式はissue #1079）。
 *
 * 旧セッションの会話そのものは新セッションへ渡さない。拡張機能が「どこに何があるか」
 * だけを書いたMarkdown（ポインタファイル）を1枚書き出し、新セッションの初回プロンプトは
 * そのパスを指すだけにする。要約はモデルに作らせない（情報の欠落とコストの両方を避ける）。
 *
 * 全情報は旧セッションのtranscript（Claude Codeのjsonl、Codexのrollout）にそのまま
 * 残っており、ポインタファイルはその在処と読み方だけを持つ。読み方は「必要な部分だけを
 * 取り出すコマンド」として埋め込み、新セッションが全文を読み込まないようにする。
 */

/** どちらのCLIのtranscriptか。抽出コマンドの形が全く違うため分ける。 */
export type HandoffProvider = 'claude' | 'codex';

/** 引き継ぎが始まった契機。ポインタファイルへ事実として1行残す。 */
export type HandoffTrigger =
  | { kind: 'manual' }
  | { kind: 'threshold'; remainingPercent: number }
  | { kind: 'compactBoundary' };

/** ポインタファイルの材料。すべて拡張機能が既に持っている値だけで構成する。 */
export interface HandoffPointerInput {
  provider: HandoffProvider;
  /** 旧セッションのID（Claude CodeのsessionId / CodexのthreadId）。 */
  sessionId: string;
  /** 旧セッションのtranscriptの絶対パス。 */
  transcriptPath: string;
  /** 作業ディレクトリ。復元したパネルなど、拡張機能側が持っていない場合がある。 */
  cwd: string | undefined;
  gitBranch: string | undefined;
  model: string | undefined;
  trigger: HandoffTrigger;
  /** 直前のターンが失敗して終わったか。 */
  turnFailed: boolean;
  /** 引き継ぎ時点でターンが走っていたか（自動引き継ぎでは常にfalseになる）。 */
  busy: boolean;
  /** 直近のユーザー指示（新しい順ではなく会話順。呼び出し側で件数を絞る）。 */
  recentUserMessages: readonly string[];
  /** 直前のターンで編集したファイル。ターン単位でリセットされるため「全部」ではない。 */
  turnEditedFiles: readonly string[];
  createdAt: Date;
}

/** 抽出コマンド1件。見出しはポインタファイルの小見出しにそのまま出す。 */
export interface HandoffExtractCommand {
  title: string;
  /** `{{TRANSCRIPT}}` を実際のパスへ差し替えて使う。 */
  command: string;
  /** そのコマンドを何のために打つのか。無ければ出さない。 */
  note?: string;
}

/** コマンド中でtranscriptのパスへ差し替えるトークン。 */
const TRANSCRIPT_TOKEN = '{{TRANSCRIPT}}';

/**
 * Claude Codeのtranscript（`~/.claude/projects/<slug>/<sessionId>.jsonl`）からの抽出。
 *
 * 式はローカルの実ファイル（最大16MB / 6964行）で確定させた。`type=="user"` には
 * ツール結果の戻り（`toolUseResult`）・システム注入（`isMeta`）・自動圧縮の要約
 * （`isCompactSummary`）が混ざるため、素朴に拾うと会話にならない。さらに `isMeta` が
 * 付かない注入（`<task-notification>` など）もあり、実測では160件のうち151件がこれだった。
 * 除外条件はその実測に対応する。陽性対照・陰性対照は `handoffExtract.test.ts` で押さえる
 * （全件0件は正常な結果と見分けが付かないため、式を変えるときは必ずそちらも通す）。
 */
const CLAUDE_COMMANDS: readonly HandoffExtractCommand[] = [
  {
    title: '自動圧縮の要約（あれば最初にこれを読む）',
    command: String.raw`jq -r 'select(.isCompactSummary==true) | .message.content' {{TRANSCRIPT}} | tail -1`,
    note: '何も出なければ、このセッションでは自動圧縮が走っていない。次のユーザー指示の方を見る',
  },
  {
    title: 'ユーザー指示（末尾20件）',
    command: String.raw`jq -r 'select(.type=="user" and .isSidechain!=true and .isMeta!=true and .isCompactSummary!=true and (has("toolUseResult")|not))
| (if (.message.content|type)=="string" then .message.content else (.message.content|map(select(.type=="text").text)|join("")) end | gsub("^\\s+";"")) as $s
| select($s|test("^<(task-notification|local-command|command-name|command-message|command-args|event|ide_|system-reminder|content>)")|not)
| select($s|length>0)
| "[" + (.timestamp//"?") + "] " + ($s[0:300]|gsub("\\s+";" "))' {{TRANSCRIPT}} | tail -20`,
    note: '1件を1行へ畳み、先頭に時刻を付けて区切りが判るようにしてある。本文は300字で切っている',
  },
  {
    title: '直前のアシスタント応答（末尾3件）',
    command: String.raw`jq -r 'select(.type=="assistant")
| (.message.content|map(select(.type=="text").text)|join("")|gsub("^\\s+";"")) as $s
| select($s|length>0) | $s' {{TRANSCRIPT}} | tail -3`,
  },
  {
    title: '編集したファイル',
    command: String.raw`jq -r 'select(.type=="file-history-snapshot") | .snapshot.trackedFileBackups | keys[]?' {{TRANSCRIPT}} | sort -u`,
    note: 'Bash中心で作業したセッションでは空になりうる。空を「編集していない」と解釈しない',
  },
];

/**
 * Codexのrollout（`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`）からの抽出。
 *
 * 最上位キーは全行 `timestamp,ordinal,type,payload` で固定。ユーザー発言は
 * `payload.role=="user"` の `message` で、注入（`<environment_context>` 始まりと
 * `# AGENTS.md instructions` + `<INSTRUCTIONS>` 始まり）が同じroleに混ざる。
 * 8ファイルで除外の前後を数えて確認した式をそのまま使う。
 *
 * 編集したファイルの一覧は取らない。Codexのツール呼び出しは `custom_tool_call` の
 * `name` が実測で全て `exec` で、編集は `input` のシェル文字列中の `apply_patch` として
 * 現れる。パスの抽出にシェル文字列のパースが要り、確実な式を書けない。
 */
const CODEX_COMMANDS: readonly HandoffExtractCommand[] = [
  {
    title: '自動圧縮が走ったか',
    command: String.raw`jq -c 'select(.type=="compacted") | .payload | {window_number, first_window_id, previous_window_id, window_id}' {{TRANSCRIPT}}`,
    note: '行が出れば圧縮済み。出なければ圧縮は走っていない',
  },
  {
    title: 'ユーザー指示（末尾20件）',
    command: String.raw`jq -r 'select(.type=="response_item" and .payload.type=="message" and .payload.role=="user")
| (.payload.content|map(.text//.input_text//"")|join("")|gsub("^\\s+";"")) as $s
| select($s|test("^(<environment_context>|<user_instructions>|# AGENTS.md instructions|<INSTRUCTIONS>)")|not)
| select($s|length>0)
| "[" + (.timestamp//"?") + "] " + ($s[0:300]|gsub("\\s+";" "))' {{TRANSCRIPT}} | tail -20`,
    note: '1件を1行へ畳み、先頭に時刻を付けてある。本文は300字で切っている',
  },
  {
    title: '直前のアシスタント応答（末尾2件）',
    command: String.raw`jq -r 'select(.type=="response_item" and .payload.type=="message" and .payload.role=="assistant")
| (.payload.content|map(.text//.output_text//"")|join("")|gsub("^\\s+";"")) as $s
| select($s|length>0) | $s' {{TRANSCRIPT}} | tail -2`,
  },
  {
    title: 'セッションのメタ情報',
    command: String.raw`jq -c 'select(.type=="turn_context") | .payload | {cwd, model, effort, summary}' {{TRANSCRIPT}} | tail -1`,
    note: 'session_meta の payload に git のキーは無い（実測）。ブランチはこのファイルの先頭に書いてある値を使う',
  },
];

/** provider別の抽出コマンド。`{{TRANSCRIPT}}` は差し替え前のまま返す。 */
export function handoffExtractCommands(
  provider: HandoffProvider,
): readonly HandoffExtractCommand[] {
  return provider === 'claude' ? CLAUDE_COMMANDS : CODEX_COMMANDS;
}

/**
 * シェルの単一引用符で包む。パスに空白・記号が含まれても壊れないようにする。
 * 単一引用符そのものは `'\''` で閉じ直す（POSIXシェルの定石）。
 */
export function shellQuote(value: string): string {
  return `'${value.split(`'`).join(`'\\''`)}'`;
}

/** コマンドのtranscriptトークンを実際のパス（引用符つき）へ差し替える。 */
export function fillTranscriptPath(command: string, transcriptPath: string): string {
  return command.split(TRANSCRIPT_TOKEN).join(shellQuote(transcriptPath));
}

/**
 * 全文読み込みを止めるための指示。ポインタファイルの読み方の節に置く。
 *
 * transcriptは数MBから十数MBあり、開いた時点で新セッションのコンテキストが埋まる。
 * 引き継ぎの目的と逆方向に働くため、禁止を先に書き、次に「代わりに打つコマンド」を出す。
 */
const READING_RULES = [
  'transcriptを全文読み込みしない。数MBから十数MBあり、読んだ時点でこのセッションのコンテキストが埋まる。',
  'まず下の「抽出コマンド」を上から順に打ち、出力だけを読む。',
  '自動圧縮の要約が出たら、それが圧縮前の全履歴の代わりになる。最初にそれを読む。出なければユーザー指示の末尾から遡る。',
  '上の出力だけで判らないことが出てきたときに限り、grep で語を絞ってから該当行の前後だけを読む。「念のため」で遡らない。',
] as const;

/** 契機の日本語表記。 */
function triggerLabel(trigger: HandoffTrigger): string {
  if (trigger.kind === 'threshold') {
    return `コンテキスト残量が閾値を下回った（残り${trigger.remainingPercent}%）`;
  }
  if (trigger.kind === 'compactBoundary') {
    return '自動圧縮の直後';
  }
  return '手動操作';
}

const PROVIDER_LABEL: Record<HandoffProvider, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

const TRANSCRIPT_LABEL: Record<HandoffProvider, string> = {
  claude: 'transcript（jsonl）',
  codex: 'rollout（jsonl）',
};

/** 1件の指示を箇条書き1行へ畳む。改行を含む指示で行数が崩れないようにする。 */
function foldToLine(text: string, maxChars: number): string {
  const folded = text.replace(/\s+/gu, ' ').trim();
  return folded.length > maxChars ? `${folded.slice(0, maxChars)}…` : folded;
}

/** ポインタファイルの本文を組み立てる。モデル呼び出しは行わない。 */
export function buildHandoffPointerMarkdown(input: HandoffPointerInput): string {
  const lines: string[] = [];

  lines.push('# セッション引き継ぎ');
  lines.push('');
  lines.push(
    'これは前のセッションの続きです。会話の中身はこのファイルには入っていません。下のtranscriptに全部残っているので、必要な分だけ取り出して読んでください。',
  );
  lines.push('');
  lines.push('## 引き継ぎ元');
  lines.push('');
  lines.push(`- CLI: ${PROVIDER_LABEL[input.provider]}`);
  lines.push(`- セッションID: ${input.sessionId}`);
  lines.push(`- ${TRANSCRIPT_LABEL[input.provider]}: ${input.transcriptPath}`);
  lines.push(`- 作業ディレクトリ: ${input.cwd ?? '不明'}`);
  lines.push(`- gitブランチ: ${input.gitBranch ?? '不明'}`);
  lines.push(`- モデル: ${input.model === undefined || input.model === '' ? '既定' : input.model}`);
  lines.push(`- 引き継いだ契機: ${triggerLabel(input.trigger)}`);
  lines.push(`- 生成時刻: ${input.createdAt.toISOString()}`);
  lines.push('');
  lines.push('## 引き継ぎ時点の状態');
  lines.push('');
  lines.push(
    input.turnFailed
      ? '- 直前のターンは**失敗して終わっている**。同じ指示をやり直す前に、何が失敗したかをtranscriptで確かめる。'
      : '- 直前のターンは失敗していない。',
  );
  lines.push(
    input.busy
      ? '- 引き継いだ時点でターンが実行中だった。**途中で切れた作業が残っている可能性がある**。'
      : '- 引き継いだ時点でターンは実行中ではなかった。',
  );
  lines.push('');
  lines.push('## 読み方（先に守ること）');
  lines.push('');
  for (const rule of READING_RULES) {
    lines.push(`- ${rule}`);
  }
  lines.push('');
  lines.push('## 直近のユーザー指示（拡張機能が保持していた分）');
  lines.push('');
  if (input.recentUserMessages.length === 0) {
    lines.push('（拡張機能側には残っていない。下の抽出コマンドでtranscriptから取り出す）');
  } else {
    for (const message of input.recentUserMessages) {
      const folded = foldToLine(message, 300);
      if (folded !== '') {
        lines.push(`- ${folded}`);
      }
    }
    lines.push('');
    lines.push('末尾が切れている場合がある。全文は下の抽出コマンドで取り出す。');
  }
  lines.push('');
  lines.push('## 直前のターンで編集したファイル');
  lines.push('');
  if (input.turnEditedFiles.length === 0) {
    lines.push(
      '（直前のターンでは記録されていない。**これは「編集していない」ではない**。セッション全体の一覧は下の抽出コマンドで取る）',
    );
  } else {
    for (const file of input.turnEditedFiles) {
      lines.push(`- ${file}`);
    }
    lines.push('');
    lines.push('これは直前のターンの分だけ。セッション全体の一覧は下の抽出コマンドで取る。');
  }
  lines.push('');
  lines.push('## 抽出コマンド');
  lines.push('');
  lines.push('そのまま実行できる。パスは埋め込み済み。');
  for (const entry of handoffExtractCommands(input.provider)) {
    lines.push('');
    lines.push(`### ${entry.title}`);
    lines.push('');
    lines.push('```bash');
    lines.push(fillTranscriptPath(entry.command, input.transcriptPath));
    lines.push('```');
    if (entry.note !== undefined) {
      lines.push('');
      lines.push(entry.note);
    }
  }
  lines.push('');

  return lines.join('\n');
}

/** ファイル名に使えない文字を潰す。セッションIDは通常UUIDだが、値を信用しない。 */
function sanitizeForFileName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/gu, '-');
  return cleaned === '' ? 'session' : cleaned.slice(0, 64);
}

/** `<sessionId>-<timestamp>.md`。同じセッションを複数回引き継いでも衝突しない。 */
export function handoffPointerFileName(sessionId: string, createdAt: Date): string {
  const stamp = createdAt.toISOString().replace(/[:.]/gu, '-').replace(/Z$/u, '');
  return `${sanitizeForFileName(sessionId)}-${stamp}.md`;
}

/**
 * ポインタファイルを書き出し、絶対パスを返す。
 *
 * `baseDir` には `ExtensionContext.globalStorageUri` 配下を渡す。リポジトリ内には置かない
 * （push事故とworking treeの汚れを避けるため）。
 */
export async function writeHandoffPointer(
  baseDir: string,
  input: HandoffPointerInput,
): Promise<string> {
  const dir = join(baseDir, 'handoff');
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, handoffPointerFileName(input.sessionId, input.createdAt));
  await writeFile(filePath, buildHandoffPointerMarkdown(input), 'utf8');
  return filePath;
}

/**
 * 新セッションへ送る初回プロンプト。ポインタファイルのパスを指すだけにする。
 *
 * transcriptのパスを直接渡していた頃（issue #694）は「transcriptを読んで要約し」という
 * 文言だったため、新セッションが冒頭で全文を読み込んでいた。読む順序と読まないものは
 * ポインタファイル側に書いてあるので、プロンプトは短く保つ。
 */
export function buildHandoffPrompt(pointerPath: string): string {
  return `前セッションの続き。${pointerPath} を読んで、そこに書かれた手順で状況を把握してから作業を続けて。前セッションのtranscriptは全文読み込まないこと。`;
}

/**
 * いまのブランチ名を取る。
 *
 * 取れなければ `undefined`。ポインタファイルの1行が埋まらないだけで引き継ぎ自体は
 * 成立するため、失敗を呼び出し側へ投げない。detached HEADでは `HEAD` という文字列が
 * 返り、ブランチ名ではないため `undefined` に倒す。
 */
export function resolveGitBranch(
  cwd: string | undefined,
  timeoutMs = 2_000,
): Promise<string | undefined> {
  if (cwd === undefined) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    execFile(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd, timeout: timeoutMs },
      (error, stdout) => {
        if (error !== null) {
          resolve(undefined);
          return;
        }
        const branch = stdout.trim();
        resolve(branch === '' || branch === 'HEAD' ? undefined : branch);
      },
    );
  });
}

/** ポインタファイルへ載せるユーザー指示の件数。 */
const RECENT_USER_MESSAGE_LIMIT = 5;

/** 直近のユーザー指示を会話順で返す。全文ではなく末尾数件だけを載せる。 */
export function recentUserMessages(
  state: ChatState,
  limit = RECENT_USER_MESSAGE_LIMIT,
): readonly string[] {
  return state.items
    .filter((item) => item.kind === 'userMessage' && item.text.trim() !== '')
    .slice(-limit)
    .map((item) => item.text);
}

/**
 * 自動圧縮が走った回数。
 *
 * `ChatState` に圧縮の専用フィールドを足さずに済ませるため、会話項目を数える。
 * `contextCompaction` はCodex（app-serverの `ThreadItem`）とClaude Code
 * （`compact_boundary`）の双方が同じ種類名で積むため、providerを問わず数えられる。
 */
export function countCompactions(state: ChatState): number {
  return state.items.filter((item) => item.kind === 'contextCompaction').length;
}

/** 自動引き継ぎを始めてよいかの判断材料。すべて呼び出し側が既に持っている値。 */
export interface AutoHandoffDecisionInput {
  /** このセッションで自動引き継ぎがONか（`ChatState.autoHandoff`）。 */
  enabled: boolean;
  /** ターン実行中か。実行中は安全な区切りではないので待つ。 */
  busy: boolean;
  /** このセッションで既に引き継ぎを始めたか。1セッションにつき1回だけにする。 */
  alreadyStarted: boolean;
  /** コンテキストの残量。上限が判らないCLI・版では `undefined`。 */
  remainingPercent: number | undefined;
  /** 直前の状態から自動圧縮が走ったか。 */
  compacted: boolean;
  thresholdPercent: number;
}

/**
 * 自動引き継ぎの契機を決める。始めないなら `undefined`。
 *
 * 閾値と自動圧縮のどちらを優先するかは決め打ちしない（Issue #1079の確認点2）。先に成立
 * した方で1回だけ引き継ぎ、`alreadyStarted` で二重発火を止める。両方が同時に成立した
 * ときだけ閾値を名乗る。圧縮の直後に残量が閾値を下回ったままなら、「圧縮しても足りな
 * かった」ほうが引き継ぎの理由として正確なため。
 */
export function decideAutoHandoff(input: AutoHandoffDecisionInput): HandoffTrigger | undefined {
  if (!input.enabled || input.busy || input.alreadyStarted) {
    return undefined;
  }
  if (input.remainingPercent !== undefined && input.remainingPercent <= input.thresholdPercent) {
    return { kind: 'threshold', remainingPercent: input.remainingPercent };
  }
  if (input.compacted) {
    return { kind: 'compactBoundary' };
  }
  return undefined;
}

/** `waitForFirstTurn` が必要とする最小の形。Codex/Claude Codeのパネルはどちらも満たす。 */
export interface HandoffTurnWatch {
  session: { getState(): ChatState };
  stateListeners: Array<(state: ChatState) => void>;
}

/** 初回応答を待つ上限。これを過ぎたら「成功を確かめられなかった」として扱う。 */
const FIRST_TURN_TIMEOUT_MS = 15 * 60_000;

/**
 * 新セッションの最初のターンが終わるのを待ち、成功したかを返す。
 *
 * 旧セッションを止めてよいかの判断に使う。時間切れ・失敗のときは `false` を返し、
 * 呼び出し側は旧セッションを残す。`turnCompletionSeq` の変化を境目にするのは
 * `busy` の立ち下がりより取りこぼしが無いため（`onSessionChange` と同じ流儀）。
 */
export function waitForFirstTurn(
  entry: HandoffTurnWatch,
  timeoutMs = FIRST_TURN_TIMEOUT_MS,
): Promise<boolean> {
  const baseline = entry.session.getState().turnCompletionSeq;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (succeeded: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const index = entry.stateListeners.indexOf(listener);
      if (index >= 0) {
        entry.stateListeners.splice(index, 1);
      }
      resolve(succeeded);
    };
    const listener = (state: ChatState): void => {
      if (state.turnCompletionSeq !== baseline) {
        finish(!state.turnFailed);
      }
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    entry.stateListeners.push(listener);
  });
}

/**
 * transcriptファイルの解決を短時間リトライする。
 *
 * セッション開始直後はCLIがまだtranscriptを書き出していないことがあるため、
 * 即失敗にせず数回だけ間隔を空けて再試行する。
 */
export async function resolveWithRetry<T>(
  resolve: () => Promise<T | undefined>,
  retries = 3,
  delayMs = 500,
): Promise<T | undefined> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const found = await resolve();
    if (found !== undefined) {
      return found;
    }
    if (attempt < retries) {
      await new Promise((resolveTimer) => setTimeout(resolveTimer, delayMs));
    }
  }
  return undefined;
}
