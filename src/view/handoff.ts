import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ChatItem, ChatState } from '../appserver/chatState';

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

/**
 * 引き継ぎが始まった契機。ポインタファイルへ事実として1行残す。
 *
 * `threshold` / `compactBoundary` は区切りを待たずに発火する（残量が尽きる方が損失が大きい）。
 * `softThreshold` / `profileChanged` は安全な区切り（`passesSafeBoundaryGate` と分類器の
 * `switchSafe`）が成立したときだけ発火する（Issue #1090）。`assistantSuggested`
 * （Issue #1097）は前段の `passesSafeBoundaryGate` だけを要求し、`switchSafe` は見ない
 * ——提案した側が既に「いま切り替えてよい」と判断しているため。
 *
 * `assistantSuggested` の根拠は2通りある（Issue #1150）。地の文での提案は分類器の
 * `handoff_suggested` で判定し、handoffプロンプトそのものの出力は
 * `containsHandoffPrompt` が書式から決定論的に拾う。後者は分類器を経由しない。
 */
export type HandoffTrigger =
  | { kind: 'manual' }
  | { kind: 'threshold'; remainingPercent: number }
  | { kind: 'compactBoundary' }
  | { kind: 'softThreshold'; remainingPercent: number; switchReason: string }
  | { kind: 'assistantSuggested'; switchReason: string; suggestReason: string }
  | { kind: 'profileChanged'; model: string; effort: string; switchReason: string }
  | { kind: 'milestone'; milestone: HandoffMilestone; command: string };

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
  /**
   * 引き継ぎ元のアシスタントがユーザーへ質問して終わっていたか（Issue #1191）。
   *
   * 区切り待ちの契機ではそもそも引き継がないが、残量の閾値・自動圧縮では回答待ちのまま
   * 引き継ぐ。そのときに「申し送り」として書かれた質問を承諾済みと読まれないよう、状態の
   * 節へ明示する。
   */
  awaitingUserAnswer?: boolean;
  /** 直近のユーザー指示（新しい順ではなく会話順。呼び出し側で件数を絞る）。 */
  recentUserMessages: readonly string[];
  /**
   * 引き継ぎ元のアシスタントの最終応答（Issue #1097）。**要約しない**。
   *
   * 「次はこれをやる」「この決定は再議論しない」といった申し送りは応答の側に書かれる。
   * 新セッションが抽出コマンドで自分で読み取るのは確実でない（長い応答は分類器でも抽出でも
   * 切り詰められる）ため、ポインタファイルへそのまま載せる。無ければ節ごと出さない。
   */
  nextSteps?: string;
  /** 直前のターンで編集したファイル。ターン単位でリセットされるため「全部」ではない。 */
  turnEditedFiles: readonly string[];
  /**
   * 引き継ぎ先のmodel / effortをどう決めたか（Issue #1082。`handoffRouter.ts`）。
   *
   * ルータが判定しなかった（材料が無い・設定でOFF）ときは省略する。後からルータを調整
   * できるよう、結論だけでなく加点の内訳をそのまま残す。
   */
  routerReasons?: readonly string[];
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
/**
 * 引き継ぎの契機を人が読める1文にする。
 *
 * ポインタファイルの「引き継いだ契機」と、統括ページの保留カード（Issue #1280）の
 * 両方が同じ文を使う。
 */
export function triggerLabel(trigger: HandoffTrigger): string {
  if (trigger.kind === 'threshold') {
    return `コンテキスト残量が閾値を下回った（残り${trigger.remainingPercent}%）`;
  }
  if (trigger.kind === 'compactBoundary') {
    return '自動圧縮の直後';
  }
  if (trigger.kind === 'softThreshold') {
    return `コンテキスト残量が緩い閾値を下回り、安全な区切りが来た（残り${trigger.remainingPercent}%。${trigger.switchReason}）`;
  }
  if (trigger.kind === 'assistantSuggested') {
    return `アシスタント自身が引き継ぎを提案した（${trigger.suggestReason || '提案の根拠は記録されていない'}。${trigger.switchReason}）`;
  }
  if (trigger.kind === 'milestone') {
    return `作業の節目（${MILESTONE_LABEL[trigger.milestone]}）に達した（${trigger.command}）`;
  }
  if (trigger.kind === 'profileChanged') {
    return `安全な区切りで、次の作業に合うmodel/effortが変わった（${trigger.model || '既定'} / ${trigger.effort || '既定'}。${trigger.switchReason}）`;
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

/**
 * 「次にやること」に載せる上限（Issue #1097）。
 *
 * 要約させない代わりに長さで切る。超えた分はtranscriptに残っており、抽出コマンドで読める。
 */
const NEXT_STEPS_LIMIT = 4000;

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
  if (input.routerReasons !== undefined && input.routerReasons.length > 0) {
    lines.push(`- 引き継ぎ先のmodel/effortの判定: ${input.routerReasons.join(' / ')}`);
  }
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
  if (input.awaitingUserAnswer === true) {
    lines.push(
      '- 引き継ぎ元のアシスタントは**ユーザーへ質問して回答を待っていた**。下の申し送りに書かれた方針は承諾されたものではない。実行に移す前にユーザーへ質問し直し、回答を得てから進める。',
    );
  }
  lines.push('');
  const nextSteps = (input.nextSteps ?? '').trim();
  if (nextSteps !== '') {
    lines.push('## 次にやること（引き継ぎ元のアシスタントの申し送り）');
    lines.push('');
    lines.push(
      'これは引き継ぎ元のアシスタントが書いた申し送りであり、**ユーザーの指示ではない**。そのまま実行してよいとは限らないので、破壊的な操作・方針の変更はユーザーへ確認してから進める。',
    );
    lines.push('');
    const truncated = nextSteps.length > NEXT_STEPS_LIMIT;
    lines.push(truncated ? `${nextSteps.slice(0, NEXT_STEPS_LIMIT)}…` : nextSteps);
    if (truncated) {
      lines.push('');
      lines.push(
        'ここで切り詰めてある。続きは下の抽出コマンド（直前のアシスタント応答）でtranscriptから読む。',
      );
    }
    lines.push('');
  }
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
  return `${HANDOFF_PROMPT_HEAD}${pointerPath} を読んで、そこに書かれた手順で状況を把握してから作業を続けて。前セッションのtranscriptは全文読み込まないこと。`;
}

/**
 * 引き継ぎ元がhandoffプロンプトを出力済みのときの初回プロンプト（Issue #1354）。
 *
 * 必要な申し送りはhandoffプロンプトに揃っているので、ポインタファイルを経由させず本文だけを
 * 渡す。ポインタファイルは抽出コマンドでtranscriptを読ませる作りのため、パスを渡すと読みに行く。
 */
export function buildHandoffPromptFromHandoff(handoffPrompt: string): string {
  return `${HANDOFF_PROMPT_HEAD}引き継ぎ元が書いた下のhandoffプロンプトの内容だけを引き継いで作業を続けて。前セッションの会話・transcriptは読まないこと。\n\n${handoffPrompt}`;
}

/**
 * 引き継ぎ先への初回プロンプトを選ぶ（Issue #1354）。引き継ぎ元の最終応答にhandoffプロンプトが
 * あればその本文だけを渡し、無ければポインタファイルを指す。
 */
export function chooseHandoffPrompt(
  pointerPath: string,
  lastAssistantMessage: string | undefined,
): string {
  const handoffPrompt =
    lastAssistantMessage === undefined ? undefined : extractHandoffPrompt(lastAssistantMessage);
  return handoffPrompt === undefined
    ? buildHandoffPrompt(pointerPath)
    : buildHandoffPromptFromHandoff(handoffPrompt);
}

/**
 * 初回プロンプトの書き出し（Issue #1228）。
 *
 * 引き継ぎ先の1件目のユーザー発言がこの手続き由来であることを見分けるための目印として
 * 切り出してある。
 */
const HANDOFF_PROMPT_HEAD = '前セッションの続き。';

/** 引き継ぎ先の名前に付ける世代の印（Issue #1145）。 */
const CONTINUATION_SUFFIX = /^(.*?)\s*\(続き(\d+)\)$/u;

/** 引き継ぎ先の名前の材料（Issue #1255）。引き継ぎ元の表示名だけを使う。 */
export interface HandoffNameInput {
  /**
   * 引き継ぎ元の表示名（`deriveHandoffBaseName`）。名前の本体と世代番号の両方をここから取る。
   */
  previousName?: string;
}

/**
 * 引き継ぎ先セッションの名前（Issue #1145、材料はIssue #1255）。
 *
 * 名前を付けないと、引き継ぎ先の表示名は初回プロンプト（`buildHandoffPrompt`）の
 * 「前セッションの続き。…」になる。自動引き継ぎを重ねるほど同じ名前のタブと履歴が
 * 並び、どれが何の作業か判らなくなる。
 *
 * **本体は引き継ぎ元のタブ名をそのまま継ぎ、世代の印だけを進める（Issue #1255）。**
 * 一時期は引き継ぎのたびに本体を作り直していた（Issue #1228。編集したファイル・分類器の
 * 見立て・直近の指示から組み立てる）が、どの材料も「今の作業」の推測にすぎず、同じ作業を
 * 続けているのに世代ごとに別の名前が並んでタブと履歴の対応が追えなくなった。名前を変える
 * かどうかは人が決められる（タブの付け直し）ので、自動では推測しない。
 *
 * `(続き2)` から始めて引き継ぐたびに1つ増やす（元が1代目なので次が2）。引き継ぎ元の
 * 名前が取れなければ印だけを返す。
 *
 * タブに収まらない長さは切り詰めない。引き継ぎ元のタブに既に出ていた名前をそのまま
 * 継ぐだけなので、表示の省略はVSCode側に任せる。
 */
export function buildHandoffSessionName(input: HandoffNameInput): string {
  const previous = collapse(input.previousName?.replace(PROVIDER_PREFIX, ''));
  const head = previous === undefined ? undefined : stripGeneration(previous);
  const generation = nextGeneration(input.previousName);
  return head === undefined ? `(続き${generation})` : `${head} (続き${generation})`;
}

/** 引き継ぎ元の名前から次の世代番号を読む。印が無ければ引き継ぎ元が1代目なので2。 */
function nextGeneration(previousName: string | undefined): number {
  const matched = CONTINUATION_SUFFIX.exec(collapse(previousName) ?? '');
  if (matched === null) {
    return 2;
  }
  const generation = Number(matched[2]);
  // 桁溢れしたときは増やさずそのまま返す（名前が壊れるより据え置きの方が害がない）
  return Number.isSafeInteger(generation) ? generation + 1 : generation;
}

/** 既に付いている世代の印を落とす。付け直しで `(続き2) (続き3)` にしないため。 */
function stripGeneration(name: string): string | undefined {
  const matched = CONTINUATION_SUFFIX.exec(name);
  if (matched === null) {
    return name;
  }
  const head = matched[1]?.trim() ?? '';
  return head === '' ? undefined : head;
}

/** 空白を1つに畳んで前後を落とす。空になったものは材料として扱わない。 */
function collapse(text: string | undefined): string | undefined {
  const trimmed = (text ?? '').replace(/\s+/gu, ' ').trim();
  return trimmed === '' ? undefined : trimmed;
}

/** タブ名に付くプロバイダの接頭辞。名前の材料にするときは落とす。 */
const PROVIDER_PREFIX = /^(?:Codex|Claude Code|Claude):\s*/u;

/**
 * 引き継ぎ元の表示名（Issue #1145）。`buildHandoffSessionName` の `previousName`——
 * つまり**名前の本体と世代番号の読み取り元**として渡す。
 *
 * 解決順は `deriveTitle`（`chatView.ts` / `claudeChatView.ts`）と同じ
 * 「オーケストレータが指定した名前 > 人やCLIが付けた名前」。タブ名と違い接頭辞は
 * 付けない（引き継ぎ先で `deriveTitle` が改めて付けるため、残すと `Codex: Codex: …`
 * と二重になる）。
 *
 * 最初のユーザー発言へ落ちる分岐は持たない（Issue #1228）。名前の無いセッションで
 * それを拾うと、作業内容と無関係な初代の一言が世代印だけ増やして延々コピーされる。
 * 名前が無いなら `(続き2)` のように印だけを出す方がまだ読める。
 */
export function deriveHandoffBaseName(state: ChatState, pinnedName?: string): string | undefined {
  const pinned = collapse(pinnedName?.replace(PROVIDER_PREFIX, ''));
  if (pinned !== undefined) {
    return pinned;
  }
  return collapse(state.name);
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
 * 分類器へ載せるアシスタント応答の件数（Issue #1097）。
 *
 * ポインタファイルには載せない。分類の材料としてだけ使う。
 */
const RECENT_ASSISTANT_MESSAGE_LIMIT = 2;

/**
 * 直前のアシスタント応答を会話順で返す（Issue #1097）。
 *
 * `recentUserMessages` と同じく `ChatState.items` から取る。切り替わりの宣言
 * （「#782完了。次は新チャットへ引き継ぐ」など）は応答の側に出るため、指示だけでは
 * 分類の材料が足りない。
 */
export function recentAssistantMessages(
  state: ChatState,
  limit = RECENT_ASSISTANT_MESSAGE_LIMIT,
): readonly string[] {
  return state.items
    .filter((item) => item.kind === 'agentMessage' && item.text.trim() !== '')
    .slice(-limit)
    .map((item) => item.text);
}

/**
 * handoffプロンプトを囲むフェンスの開始行（Issue #1150）。
 *
 * `handoff` skillは開始プロンプト全体を4バックティック以上で囲む。中身のMarkdownが3
 * バックティックのコードブロックを含むため、外側は必ず4本以上になる。字下げ3文字までを
 * 許すのはMarkdownのフェンスの規則に合わせるため。
 */
const HANDOFF_PROMPT_FENCE = /^ {0,3}(`{4,})/;

/**
 * handoffプロンプトの見出し行（Issue #1150）。
 *
 * `handoff` skillの出力仕様は、標準モードが `# 継続 <YYYY-MM-DD> <branch>`、Codex版の
 * 詳細モードが `# 継続セッション開始プロンプト`。どちらも `# 継続` で始まるので前方一致で
 * 両方を拾う。`##` 以下の見出しは対象外（`^#` の次に `継続` を要求するため一致しない）。
 */
const HANDOFF_PROMPT_HEADING = /^#[^\S\r\n]*継続/;

/** 決定論検知で発火したときの根拠（`HandoffTrigger.suggestReason`）。 */
export const HANDOFF_PROMPT_DETECTED_REASON = 'アシスタントの応答にhandoffプロンプトが含まれていた';

/**
 * アシスタントの応答がhandoffプロンプトそのものを含むか（Issue #1150）。
 *
 * 「別セッションで続きを」のような**地の文での提案**は言い回しがぶれるため分類器に任せる
 * （`agent.autoHandoff.onAssistantSuggestion` の説明を参照）。一方でhandoffプロンプト
 * そのものは `handoff` skillが書式を固定しているので、ここで決定論的に拾える。分類器が
 * 無効・時間切れ・JSON不正でも発火できる経路をこの関数が受け持つ。
 *
 * フェンスと見出しの**両方**を要求する。見出しだけを見ると、書式を話題にしているだけの
 * 応答で誤爆する。逆にフェンスだけを見ると、subagent用プロンプトなど同じく4バックティック
 * で囲む別物まで拾ってしまう。
 *
 * ストリーミング途中の断片を拾わないのは呼び出し側の責任。前段（`passesSafeBoundaryGate`）
 * が `busy` の間は通さない。
 */
export function containsHandoffPrompt(text: string): boolean {
  return extractHandoffPrompt(text) !== undefined;
}

/**
 * アシスタントの応答からhandoffプロンプトの本文（フェンスの内側）を取り出す（Issue #1354）。
 *
 * 判定は `containsHandoffPrompt` と同じで、見出しを含むフェンスが複数あれば最後のものを返す。
 * 閉じフェンスが無いときは末尾までを本文とする。見つからなければ `undefined`。
 */
export function extractHandoffPrompt(text: string): string | undefined {
  let fenceLength = 0;
  let body: string[] = [];
  let hasHeading = false;
  let found: string | undefined;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const marks = HANDOFF_PROMPT_FENCE.exec(line)?.[1];
    if (fenceLength === 0) {
      if (marks !== undefined) {
        fenceLength = marks.length;
        body = [];
        hasHeading = false;
      }
      continue;
    }
    // 閉じフェンスは開きと同じ長さ以上で、後ろに情報文字列を付けられない（Markdownの規則）。
    // 開き行はバックティックの後ろに言語名が付くため、長さと余分な文字の両方を見て弾く
    if (marks !== undefined && marks.length >= fenceLength && line.trim() === marks) {
      if (hasHeading) {
        found = body.join('\n').trim();
      }
      fenceLength = 0;
      continue;
    }
    body.push(line);
    if (HANDOFF_PROMPT_HEADING.test(line)) {
      hasHeading = true;
    }
  }
  if (fenceLength !== 0 && hasHeading) {
    found = body.join('\n').trim();
  }
  return found;
}

/**
 * 自動引き継ぎを必ず挟む作業の節目（Issue #1351）。
 *
 * - `issueCreated`: Issue起票後（実装に着手する前）
 * - `prCreated`: PR/MR作成後（レビューに入る前）
 * - `merged`: マージ後（次のIssueへ進む前）
 */
export type HandoffMilestone = 'issueCreated' | 'prCreated' | 'merged';

export interface DetectedMilestone {
  milestone: HandoffMilestone;
  /** 根拠にしたコマンド行。ポインタファイルとログへ出す。 */
  command: string;
}

const MILESTONE_LABEL: Record<HandoffMilestone, string> = {
  issueCreated: 'Issue起票後',
  prCreated: 'レビュー前',
  merged: '次のIssueへ進む前',
};

/**
 * 節目の判定規則。工程の後ろのものから並べ、複数当たったときは先頭を採る。
 *
 * `gh` / `glab` の直後に大域オプション（`-R owner/repo` など）が入る書き方もあるため、
 * コマンド名とサブコマンドの間はオプション（とその値）だけを許す。コマンド名はコマンドの先頭（行頭・`;` `&`
 * `|` `(` の直後、Codexが包む `bash -lc '…'` の引数の先頭）にあるものだけを拾う。
 * `echo "gh pr merge"` や `--body "… gh issue create …"` のような引数中の文言で発火させない。
 */
const COMMAND_HEAD = String.raw`(?:^|[;&|(]|-l?c\s+['"]?)\s*`;
/** コマンド名とサブコマンドの間に入る大域オプション（`-R owner/repo` など）。 */
const GLOBAL_OPTIONS = String.raw`(?:\s+-\S+(?:\s+(?!-)[^\s;&|]+)?)*`;

/** `gh <sub>` と `glab <sub>` のどちらかに一致する正規表現を作る。 */
function commandPattern(ghSubcommand: string, glabSubcommand: string): RegExp {
  const gh = String.raw`gh${GLOBAL_OPTIONS}\s+${ghSubcommand}\b`;
  const glab = String.raw`glab${GLOBAL_OPTIONS}\s+${glabSubcommand}\b`;
  return new RegExp(`${COMMAND_HEAD}(?:${gh}|${glab})`, 'mu');
}

const MILESTONE_RULES: ReadonlyArray<{ milestone: HandoffMilestone; pattern: RegExp }> = [
  { milestone: 'merged', pattern: commandPattern(String.raw`pr\s+merge`, String.raw`mr\s+merge`) },
  {
    milestone: 'prCreated',
    pattern: commandPattern(String.raw`pr\s+create`, String.raw`mr\s+create`),
  },
  {
    milestone: 'issueCreated',
    pattern: commandPattern(String.raw`issue\s+create`, String.raw`issue\s+create`),
  },
];

/** コマンドが成功して終わったか。Claude Codeは `completed`、Codexは `exit 0` か `completed`。 */
function isSucceededCommand(status: string | undefined): boolean {
  const value = status?.trim();
  return value === 'completed' || value === 'exit 0';
}

/** コマンド行の上限。ポインタファイルへそのまま出すため長くしない。 */
const MILESTONE_COMMAND_LIMIT = 200;

/**
 * 直前のターン（最後のユーザー指示より後）で成功したコマンドから、作業の節目を拾う（Issue #1351）。
 *
 * 分類器を経由しない決定論的な判定。見つからなければ `undefined`。
 */
export function detectHandoffMilestone(
  items: ReadonlyArray<Pick<ChatItem, 'kind' | 'detail' | 'status'>>,
): DetectedMilestone | undefined {
  let start = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]?.kind === 'userMessage') {
      start = i + 1;
      break;
    }
  }
  const commands = items
    .slice(start)
    .filter((item) => item.kind === 'commandExecution' && isSucceededCommand(item.status))
    .map((item) => item.detail);
  for (const rule of MILESTONE_RULES) {
    // 同じ節目が複数あれば最後のものを根拠にする（`findLast` はES2022のlibに無い）
    const command = [...commands].reverse().find((c) => rule.pattern.test(c));
    if (command !== undefined) {
      const single = command.replace(/\s+/gu, ' ').trim();
      return {
        milestone: rule.milestone,
        command:
          single.length <= MILESTONE_COMMAND_LIMIT
            ? single
            : `${single.slice(0, MILESTONE_COMMAND_LIMIT)}…`,
      };
    }
  }
  return undefined;
}

/**
 * 回答待ちで終わったと判定する末尾の形（Issue #1191）。
 *
 * 疑問符だけでは足りない。日本語の問いかけは「この方針で進めてよいか。」のように疑問符を
 * 付けずに終わることが多く、実際に引き継ぎが誤発火した応答も疑問符が無かった。
 *
 * 逆に広げすぎると、通常の完了報告で引き継ぎが止まる（誤爆の損の方が大きい）。文末の
 * 「か」は「〜したか。」「〜だろうか。」のような問いに限られ、平叙文の文末には出にくいため
 * 採用する。「ください」は回答・判断を求める依頼（「どちらか選んでください」）を拾う。
 */
const QUESTION_TAIL_PATTERNS: readonly RegExp[] = [
  /[?？]$/u,
  /か[。．]?$/u,
  /(?:ください|下さい)[。．]?$/u,
  /(?:でよい|で良い|していい|してよい|でいい)[。．]?$/u,
];

/** 行頭の箇条書き記号・引用符・見出し・強調。末尾の形を見る前に落とす。 */
const DECORATION_PREFIX = /^\s*(?:[-*+>]\s+|#{1,6}\s+|\d+[.)]\s+)/u;
const DECORATION_SUFFIX = /(?:\*+|_+|`+)$/u;

/** コードブロックのフェンス（3文字以上のバックティックかチルダ）。 */
const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * アシスタントの応答がユーザーへの質問で終わっているか（Issue #1191）。
 *
 * 「この方針で実装してよいか？」と尋ねて終わったターンは**安全な区切りではない**。ここで
 * 引き継ぐと、新セッションはその質問を申し送りとして読み、ユーザーが断るつもりだった案を
 * そのまま実行し始める。
 *
 * 見るのは**フェンスの外にある最後の非空行だけ**。応答の途中に出てくる疑問文（検討の過程で
 * 自問しているもの）まで拾うと、通常の完了報告が軒並み回答待ち扱いになる。質問した後さらに
 * 説明を続けて終わる応答は取りこぼすが、その分は分類器の `awaiting_user_answer` が拾う。
 */
export function endsWithUserQuestion(text: string): boolean {
  let fence: string | undefined;
  let last = '';
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const marks = CODE_FENCE.exec(line)?.[1];
    if (fence === undefined) {
      if (marks !== undefined) {
        fence = marks;
        continue;
      }
    } else {
      // 閉じフェンスは開きと同じ種類で同じ長さ以上、かつ後ろに情報文字列を付けられない
      if (marks !== undefined && marks[0] === fence[0] && marks.length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    const trimmed = line.replace(DECORATION_PREFIX, '').replace(DECORATION_SUFFIX, '').trim();
    if (trimmed !== '') {
      last = trimmed;
    }
  }
  return last !== '' && QUESTION_TAIL_PATTERNS.some((pattern) => pattern.test(last));
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

/** `advanceCompactionCount` の結果。次に控える件数と、圧縮が走ったかの判定。 */
export interface CompactionAdvance {
  /** 直前の同期から圧縮が走ったか。最初の同期では必ず `false`。 */
  compacted: boolean;
  /** 次の比較の基準として控える件数。 */
  lastCompactionCount: number;
}

/**
 * 圧縮契機の判定材料を1段進める。
 *
 * 最初の同期（`previous` が `undefined`）では基準を作るだけで `compacted` を立てない。
 * 復元や履歴からの再開では、最初の同期で過去の圧縮がまとめて届く。`0` を基準にすると
 * 実際には起きていない圧縮で引き継ぎが発火する（Issue #1101）。
 */
export function advanceCompactionCount(
  previous: number | undefined,
  current: number,
): CompactionAdvance {
  return {
    compacted: previous !== undefined && current > previous,
    lastCompactionCount: current,
  };
}

/** 自動引き継ぎを始めてよいかの判断材料。すべて呼び出し側が既に持っている値。 */
export interface AutoHandoffDecisionInput {
  /** このセッションで自動引き継ぎがONか（`ChatState.autoHandoff`）。 */
  enabled: boolean;
  /** ターン実行中か。実行中は安全な区切りではないので待つ。 */
  busy: boolean;
  /** このセッションで既に引き継ぎを始めたか。1セッションにつき1回だけにする。 */
  alreadyStarted: boolean;
  /**
   * バックグラウンドで走っているプロセスがあるか（Issue #1315）。
   *
   * 真の間はどの契機でも始めない。区切り待ちの契機は前段（`passesSafeBoundaryGate` の
   * `backgroundRunning`、Issue #1307）が既に止めているが、残量の閾値（`threshold`）と
   * 自動圧縮（`compactBoundary`）は前段を通らないため、ここでも見る必要がある。
   *
   * `alreadyStarted` は立てないため、これは取り消しではなく延期にあたる。走っていた
   * プロセスが終われば`ChatState`が更新され、その時点で改めて判定が走る。
   */
  backgroundRunning?: boolean;
  /** コンテキストの残量。上限が判らないCLI・版では `undefined`。 */
  remainingPercent: number | undefined;
  /** 直前の状態から自動圧縮が走ったか。 */
  compacted: boolean;
  thresholdPercent: number;
  /**
   * 区切りを待つ契機で使う緩い閾値（Issue #1090）。`thresholdPercent` より大きい値。
   *
   * 省略したときは区切り待ちの閾値契機（`softThreshold`）を使わない。
   */
  softThresholdPercent?: number;
  /**
   * 今が安全な区切りか（`passesSafeBoundaryGate` の前段と分類器の `switchSafe` の両方）。
   *
   * 判定には分類器の起動を伴うため、ここでは結果だけを受け取る。前段を通っていないとき・
   * 分類器を呼んでいないときは `false`。
   */
  safeBoundary?: boolean;
  /**
   * 前段（`passesSafeBoundaryGate`）だけを通ったか（Issue #1097）。
   *
   * `assistantSuggested` は分類器の `switchSafe` を要求しない。提案した側が既に
   * 「いま切り替えてよい」と判断しているところへ `switchSafe` を重ねると、「MRは作成済み
   * だが未マージ」のような状態を「失うものがある」と読んで false になり、宣言があっても
   * 発火しない（実測）。前段の決定論的な条件だけは満たしていることをここで確かめる。
   */
  boundaryGatePassed?: boolean;
  /**
   * 安全な区切りで、アシスタント自身が引き継ぎを提案したか（Issue #1097）。
   *
   * 残量にも `isProfileChange` にも依存しない。同種の作業が続く場合（#782の実装 → #783の
   * 実装）はmodel/effortが変わらず `profileChanged` が立たないため、提案を独立の契機にする。
   */
  handoffSuggested?: boolean;
  /** `handoffSuggested` の根拠として分類器が返した1文。 */
  handoffSuggestReason?: string;
  /** 安全な区切りで、次の作業に合うmodel/effortが今の値と違うか（Issue #1090）。 */
  profileChanged?: boolean;
  /** `profileChanged` の根拠として残す、解決したmodel/effortと分類器の1文。 */
  profile?: { model: string; effort: string };
  /** 分類器が返した「切り替えてよい理由」。ポインタファイルへそのまま出す。 */
  switchReason?: string;
  /**
   * アシスタントがユーザーへ質問して回答を待っているか（Issue #1191）。
   *
   * 真のときは区切り待ちの契機を**すべて**止める。`assistantSuggested` も止めるのは、
   * 「この方針で進めてよいか。よければ新セッションで実装する」のように提案と質問が同じ
   * 応答に並ぶためで、提案だけを見て発火すると回答を待たずに実装が始まる。
   *
   * 残量の閾値（`threshold`）と自動圧縮（`compactBoundary`）は止めない。残量が尽きる方が
   * 損失が大きく、その場合はポインタファイルへ回答待ちである旨を書いて引き継ぐ。
   */
  awaitingUserAnswer?: boolean;
  /**
   * 直前のターンで作業の節目に当たるコマンドが成功したか（Issue #1351）。
   *
   * 残量・model/effort・分類器の結果に関係なく発火する。前段（`boundaryGatePassed`）と
   * 回答待ちの判定には従う。
   */
  milestone?: DetectedMilestone;
}

/** 安全な区切りの前段（決定論的・コストゼロ）の判断材料。すべて呼び出し側が持っている値。 */
export interface SafeBoundaryGateInput {
  /** ターン実行中か。 */
  busy: boolean;
  /** 直前のターンが失敗して終わったか。失敗直後は「区切り」ではなく「中断」。 */
  turnFailed: boolean;
  /** 未応答の承認要求の件数。 */
  pendingApprovals: number;
  /** 未応答の問い合わせ（`ask_user` 等）の件数。 */
  pendingPrompts: number;
  /**
   * アシスタントがユーザーへ質問して回答を待っているか（Issue #1191）。
   *
   * `pendingPrompts` が数えるのは `ask_user` のような**構造化された**問い合わせだけで、
   * 地の文での「この方針で進めてよいか」は数に入らない。回答待ちのまま引き継ぐと、新
   * セッションが質問を申し送りと読んで勝手に実行する。判定は `endsWithUserQuestion`。
   */
  awaitingUserAnswer: boolean;
  /** 送信待ちで積まれている指示の件数。 */
  queued: number;
  /** ゴール駆動ループが走っているか。 */
  loopRunning: boolean;
  /** タスク用セッションか。無人で走るため人の区切りとは無関係。 */
  taskManaged: boolean;
  /**
   * バックグラウンドで走っているプロセスがあるか（Issue #1307）。
   *
   * バックグラウンド実行はターンが終わっても走り続け、完了したときに元のセッションを再び
   * 動かす。`busy` はターンの実行中しか true にならないため、これを見ないと「走っている
   * 最中に引き継いだうえ、引き継ぎ元も作業を続ける」状態になる。判定は
   * `ChatState.backgroundTerminals` が空かどうか。
   */
  backgroundRunning: boolean;
}

/**
 * 安全な区切りの前段（Issue #1090）。
 *
 * ここを通ったときだけ分類器（LLM・CLI起動）を呼ぶ。全部が決定論的な条件で、どれか1つでも
 * 崩れていれば「今は切り替えられない」ことがコスト無しに判る。
 */
export function passesSafeBoundaryGate(input: SafeBoundaryGateInput): boolean {
  return (
    !input.busy &&
    !input.turnFailed &&
    input.pendingApprovals === 0 &&
    input.pendingPrompts === 0 &&
    !input.awaitingUserAnswer &&
    input.queued === 0 &&
    !input.loopRunning &&
    !input.taskManaged &&
    !input.backgroundRunning
  );
}

/**
 * 分類器を起動してよいかを絞る鍵（Issue #1090の確認点1）。
 *
 * 前回の判定から材料が変わっていなければ、同じ結論が出るだけのため呼ばない。
 *
 * 材料に直前のアシスタント応答を含めるのは、再評価をターン完了単位にするため（Issue #1097）。
 * ユーザー指示だけを鍵にしていた頃は、次の指示が来るまで鍵が変わらず、作業が一段落しても
 * 再評価が走らなかった。応答の本文はターンが完了するたびに変わり、同一ターン内のstate更新
 * （トークン使用量の更新など）では変わらない。ストリーミング途中の断片で起動しないのは、
 * 前段（`passesSafeBoundaryGate`）が `busy` の間は通さないため。
 */
export function safeBoundaryProbeKey(
  recentUserMessages: readonly string[],
  recentAssistantMessages: readonly string[] = [],
): string {
  // 指示と応答の境目には別の区切り文字を使う。同じ区切りだと、片方の末尾と他方の先頭が
  // 入れ替わっただけの並びが同じ鍵になる
  return [recentUserMessages.join('\u0000'), recentAssistantMessages.join('\u0000')].join('\u0001');
}

/**
 * 自動引き継ぎの契機を決める。始めないなら `undefined`。
 *
 * 閾値と自動圧縮のどちらを優先するかは決め打ちしない（Issue #1079の確認点2）。先に成立
 * した方で1回だけ引き継ぎ、`alreadyStarted` で二重発火を止める。両方が同時に成立した
 * ときだけ閾値を名乗る。圧縮の直後に残量が閾値を下回ったままなら、「圧縮しても足りな
 * かった」ほうが引き継ぎの理由として正確なため。
 *
 * 区切り待ちの契機は `softThreshold` → `assistantSuggested` → `profileChanged` の順に見る
 * （Issue #1097）。残量が理由になるならそれが最も正確で、次に「アシスタントが自分で
 * 提案した」、最後に「model/effortが変わる」という順で理由が具体的でなくなる。
 *
 * 3つのうち `assistantSuggested` だけは分類器の `switchSafe` を要求せず、前段
 * （`boundaryGatePassed`）と `handoffSuggested` だけで成立する。他の2つは宣言が無いため、
 * 切り替えてよいかの判断を分類器に頼る必要がある。
 *
 * バックグラウンド実行中（`backgroundRunning`）はどの契機でも始めない（Issue #1315）。
 * 残量の閾値と自動圧縮は「残量が尽きる方が損失が大きい」として区切りを待たずに発火する
 * 作りだが、裏で走っているプロセスは完了時に引き継ぎ元を再び動かすため、そこで引き継ぐと
 * 引き継ぎ先と引き継ぎ元が同じ作業を並行して進めることになる。
 */
export function decideAutoHandoff(input: AutoHandoffDecisionInput): HandoffTrigger | undefined {
  if (!input.enabled || input.busy || input.alreadyStarted) {
    return undefined;
  }
  // 契機の判定より先に見る。残量の閾値・自動圧縮もここで止める（Issue #1315）
  if (input.backgroundRunning === true) {
    return undefined;
  }
  if (input.remainingPercent !== undefined && input.remainingPercent <= input.thresholdPercent) {
    return { kind: 'threshold', remainingPercent: input.remainingPercent };
  }
  if (input.compacted) {
    return { kind: 'compactBoundary' };
  }
  // 前段（決定論的な条件）はどの区切り契機にも必須。ここを通っていなければ何も発火しない
  if (input.boundaryGatePassed !== true && input.safeBoundary !== true) {
    return undefined;
  }
  // 回答待ちは区切りではない（Issue #1191）。前段の検知をすり抜けて分類器が拾った場合も
  // ここで止める
  if (input.awaitingUserAnswer === true) {
    return undefined;
  }
  if (input.milestone !== undefined) {
    return { kind: 'milestone', ...input.milestone };
  }
  const switchReason = input.switchReason ?? '';
  if (
    input.safeBoundary === true &&
    input.softThresholdPercent !== undefined &&
    input.remainingPercent !== undefined &&
    input.remainingPercent <= input.softThresholdPercent
  ) {
    return { kind: 'softThreshold', remainingPercent: input.remainingPercent, switchReason };
  }
  // `switchSafe` は要求しない（Issue #1097）
  if (input.handoffSuggested === true) {
    return {
      kind: 'assistantSuggested',
      switchReason,
      suggestReason: input.handoffSuggestReason ?? '',
    };
  }
  if (input.safeBoundary === true && input.profileChanged === true) {
    return {
      kind: 'profileChanged',
      model: input.profile?.model ?? '',
      effort: input.profile?.effort ?? '',
      switchReason,
    };
  }
  return undefined;
}

/**
 * `waitForDestinationResponse` が必要とする最小の形。Codex/Claude Codeのパネルは
 * どちらも満たす。
 */
export interface HandoffTurnWatch {
  session: { getState(): ChatState };
  stateListeners: Array<(state: ChatState) => void>;
}

/**
 * 引き継ぎ先が応答を始めるのを待つ上限（Issue #1165）。
 *
 * 2026-09-16に実測したログ103件では、引き継ぎ先の最初のレコードは0.7〜12.2秒で現れた。
 * 60秒はその最大値に対する余裕で、CLIの起動が遅れた場合まで含めて拾う。
 */
const FIRST_RESPONSE_TIMEOUT_MS = 60_000;

/**
 * 引き継ぎ先からの応答とみなさない項目の種類。
 *
 * `userMessage` / `skillContext` は送る側（人・拡張機能）が積むもの。初回プロンプトを
 * 送った瞬間に`items`は増えるため、外さないと送信そのものを応答と取り違える。
 *
 * `settingsChanged` は承認方法の変更・フックの警告など、モデルの出力ではない横からの
 * 通知（`appendNotice`）である。起動直後の`status`通知でも積まれるため、これを応答と
 * 数えるとCLIが立ち上がっただけで「プロンプトを受け取って答え始めた」と誤認する。
 */
const NON_RESPONSE_ITEM_KINDS: ReadonlySet<string> = new Set([
  'userMessage',
  'skillContext',
  'settingsChanged',
]);

/** CLIが返した項目の数。増えていれば引き継ぎ先は応答を始めている。 */
function responseItemCount(state: ChatState): number {
  return state.items.filter((item) => !NON_RESPONSE_ITEM_KINDS.has(item.kind)).length;
}

/**
 * `waitForDestinationResponse` の結果。旧タブを閉じなかった理由をログへ残すため、
 * 失敗時は `succeeded: false` だけでなく理由を区別する（Issue #1158）。`abandoned` は初回
 * プロンプトを送れずに監視を打ち切ったとき（Issue #1162）。
 */
export type DestinationResponseOutcome =
  { succeeded: true } | { succeeded: false; reason: 'noResponse' | 'turnFailed' | 'abandoned' };

/**
 * 引き継ぎ先が初回プロンプトに応答を始めるのを待ち、始めたかどうかを返す。
 *
 * 旧セッションを止めてよいかの判断に使う。応答が来ない・失敗したときは `succeeded: false`
 * を返し、呼び出し側は旧セッションを残す。
 *
 * **待つのは「初回ターンの完了」ではなく「応答の開始」である（Issue #1165）。** 引き継ぎ先の
 * 初回ターンは引き継いだ作業そのものなので、完了を待つと旧タブが作業の終わりまで残る。
 * 2026-09-16の実測では、完了まで15分〜2時間39分かかったターンが9件あり、15分の上限では
 * どれも間に合わなかった。一方で「CLIが起動して応答を返し始めたか」は0.7〜12.2秒で確定し、
 * これは「引き継ぎ先が使い物になるか」の判断には十分である。
 *
 * **baselineの取得とlistenerの登録は、この関数を呼んだ時点で同期的に終わる**（Promiseの
 * executorは同期実行されるため）。初回プロンプトの送信より前に呼んでおけば、送信が完了
 * まで返らない実装でも最初の応答を取りこぼさない（Issue #1162）。この同期性は
 * 呼び出し側との約束なので、`async` 化したり `await` を挟んだりしてはならない。
 *
 * 送信より前に張る以上、送信そのものが失敗したときに監視だけが残る。`giveUp` を渡して
 * `abort()` すれば、上限を待たずに listener を外して `abandoned` で決着させられる。
 */
export function waitForDestinationResponse(
  entry: HandoffTurnWatch,
  timeoutMs = FIRST_RESPONSE_TIMEOUT_MS,
  giveUp?: AbortSignal,
): Promise<DestinationResponseOutcome> {
  const baseline = entry.session.getState();
  const baselineItems = responseItemCount(baseline);
  const baselineSeq = baseline.turnCompletionSeq;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: DestinationResponseOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      giveUp?.removeEventListener('abort', onGiveUp);
      const index = entry.stateListeners.indexOf(listener);
      if (index >= 0) {
        entry.stateListeners.splice(index, 1);
      }
      resolve(outcome);
    };
    const onGiveUp = (): void => finish({ succeeded: false, reason: 'abandoned' });
    const listener = (state: ChatState): void => {
      if (responseItemCount(state) > baselineItems) {
        finish({ succeeded: true });
        return;
      }
      // 応答を1件も返さないままターンが終わったなら、引き継ぎ先は使い物になっていない。
      // 成功・失敗のどちらで終わっても同じ扱いにする（応答が無い以上、続きを託せない）
      if (state.turnCompletionSeq !== baselineSeq) {
        finish({ succeeded: false, reason: 'turnFailed' });
      }
    };
    const timer = setTimeout(() => finish({ succeeded: false, reason: 'noResponse' }), timeoutMs);
    entry.stateListeners.push(listener);
    if (giveUp?.aborted === true) {
      onGiveUp();
      return;
    }
    giveUp?.addEventListener('abort', onGiveUp);
  });
}

/** 引き継ぎ後に旧タブを残したときの理由（ログの `reason=` に出る値）。 */
export type OldTabKeptReason =
  'noResponse' | 'turnFailed' | 'abandoned' | 'disposed' | 'oldBusy' | 'userDismissed';

/**
 * 引き継ぎ後に旧タブをどう扱うかの決定。
 *
 * `confirm` は「人に聞く」で、`agent.autoHandoff.closeOldTab` が無効なときだけ返る。
 * 聞いた結果は非同期に決まるため、ここでは扱いを決めきらない。
 */
export type OldTabDecision =
  { action: 'close' } | { action: 'confirm' } | { action: 'keep'; reason: OldTabKeptReason };

/** `decideOldTabAfterHandoff` に渡す、判断に要る事実だけ。VSCodeには依存しない。 */
export interface OldTabDecisionInput {
  /** 引き継ぎ先が応答を始めたかどうか（`waitForDestinationResponse` の戻り値）。 */
  outcome: DestinationResponseOutcome;
  /** 引き継ぎ元のパネルが既に破棄済みか。 */
  oldDisposed: boolean;
  /** 引き継ぎ元のセッションがターン実行中か。 */
  oldBusy: boolean;
  /** `agent.autoHandoff.closeOldTab` の値。 */
  closeOldTab: boolean;
}

/**
 * 引き継ぎ後に旧タブを閉じてよいかを決める（Issue #1158 / #1162）。
 *
 * 判断そのものはVSCodeに依存しないため、ここへ切り出して単体テストの対象にする。
 * 呼び出し側（`chatView.ts` / `claudeChatView.ts` の `confirmStopAfterFirstResponse`）は
 * 結果に従って停止・後片付け・確認ダイアログを行うだけにする。
 *
 * 引き継ぎ先が応答を始めなかったときは、`closeOldTab` の値にかかわらず残す。引き継ぎ先が
 * 使い物にならないまま引き継ぎ元を失うのを防ぐため。
 */
export function decideOldTabAfterHandoff(input: OldTabDecisionInput): OldTabDecision {
  if (!input.outcome.succeeded) {
    return { action: 'keep', reason: input.outcome.reason };
  }
  if (input.oldDisposed) {
    return { action: 'keep', reason: 'disposed' };
  }
  if (!input.closeOldTab) {
    return { action: 'confirm' };
  }
  // 引き継いだ後に旧タブで新しいターンが走り出していたら閉じない（進行中の作業を切らない）
  if (input.oldBusy) {
    return { action: 'keep', reason: 'oldBusy' };
  }
  return { action: 'close' };
}

/** 旧タブを残した理由を、Outputへ1行で出すための説明にする。 */
export function oldTabKeptMessage(reason: OldTabKeptReason): string {
  const detail: Record<OldTabKeptReason, string> = {
    noResponse: '引き継ぎ先が既定時間内に応答を始めなかったため、旧タブを残します',
    turnFailed: '引き継ぎ先が応答を返さないままターンを終えたため、旧タブを残します',
    abandoned: '引き継ぎ先へ初回プロンプトを送れず監視を打ち切ったため、旧タブを残します',
    disposed: '引き継ぎ元セッションは既に破棄済みのため、旧タブの後片付けは不要です',
    oldBusy: '引き継ぎ元のセッションがターン実行中のため、タブを閉じずに残します',
    userDismissed: '引き継ぎ元セッションの停止確認で継続を選ばなかったため、タブを残します',
  };
  return `${detail[reason]}（reason=${reason}）`;
}

/**
 * 旧タブが残ったことを人へ見せるべき理由か（Issue #1165）。
 *
 * `disposed` は旧タブがもう無いので見せる相手がいない。`userDismissed` は人が自分で
 * 「残す」を選んだ結果なので、改めて知らせても新しい情報にならない。それ以外は
 * 「引き継いだはずのタブが残っている」状態で、人が閉じるか再開するかを決める必要がある。
 */
export function needsAttentionAfterHandoff(reason: OldTabKeptReason): boolean {
  return reason !== 'disposed' && reason !== 'userDismissed';
}

/** Attention Indexの一覧に出す、旧タブが残った理由の短い説明（Issue #1165）。 */
export function oldTabKeptLabel(reason: OldTabKeptReason): string {
  const label: Record<OldTabKeptReason, string> = {
    noResponse: '引き継ぎ元が残存・引き継ぎ先が無応答',
    turnFailed: '引き継ぎ元が残存・引き継ぎ先が応答なしで終了',
    abandoned: '引き継ぎ元が残存・初回プロンプトを送れず',
    disposed: '引き継ぎ元が残存',
    oldBusy: '引き継ぎ元が残存・実行中のため閉じず',
    userDismissed: '引き継ぎ元が残存',
  };
  return label[reason];
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
