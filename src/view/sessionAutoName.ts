import type { ChatItem } from '../appserver/chatState';
import {
  runHeadlessPromptDetailed,
  type HeadlessCliDeps,
  type HeadlessOutcome,
  type HeadlessProvider,
} from '../loop/headlessCli';
import type { MementoLike } from '../util/memento';
import { generationMarkOf, stripGeneration } from './handoff';
import { CLASSIFIER_MODELS, CLASSIFIER_TIMEOUT_MS } from './handoffClassifier';

/**
 * タブ名の自動付け直し（Issue #1426）。
 *
 * 会話をヘッドレスCLIに要約させ、名前の本体を `#<Issue> !<MR> <日本語slug>` にする。
 * 引き継ぎ先の名前（#1410）はhandoffプロンプトとcwdのブランチからしか材料を取らず、
 * ポインタ方式の引き継ぎでは何も取れなかった。会話そのものを材料にすれば、引き継ぎかどうかに
 * 関係なく同じ仕組みで名前を付けられる。
 */

/** slugの上限（コードポイント数）。超えて返ってきたら切る。 */
export const SLUG_MAX = 30;

/** 1件あたりの上限。長い発言をそのまま積むとプロンプトが膨らみ、要約も遅くなる。 */
const USER_MESSAGE_LIMIT = 600;
const ASSISTANT_MESSAGE_LIMIT = 800;

/**
 * 付け直しの契機になる語（Issue #1426）。
 *
 * 前後が英字でないことを単語境界とみなす。`\b` だと `MR102` のように番号が続く書き方を
 * 拾えず、`PRD` や `prompt` は英字が続くので除外したい。
 *
 * `Issue` は大文字小文字を区別しない。`MR` / `PR` は大文字で書かれたときか、直後に
 * `#` / `!` / 数字が続くときだけ拾う。大小を無視すると英文の敬称 `Mr.` でも反応する（Issue #1428）。
 */
const ISSUE_REFERENCE = /(?<![A-Za-z])issue(?![A-Za-z])/iu;
const UPPER_MR_PR_REFERENCE = /(?<![A-Za-z])(?:MR|PR)(?![A-Za-z])/u;
const NUMBERED_MR_PR_REFERENCE = /(?<![A-Za-z])(?:mr|pr)\s?[#!\d]/iu;

/** 1ターン分の発言。応答が複数に分かれていれば改行でつなぐ。 */
export interface AutoNameTurn {
  user: string;
  assistant: string;
}

/** 会話を、ユーザー発言を区切りにしたターンの並びにする。 */
export function splitTurns(items: readonly ChatItem[]): AutoNameTurn[] {
  const turns: AutoNameTurn[] = [];
  for (const item of items) {
    if (item.kind === 'userMessage' && item.text.trim() !== '') {
      turns.push({ user: item.text, assistant: '' });
      continue;
    }
    const current = turns.at(-1);
    if (current !== undefined && item.kind === 'agentMessage' && item.text.trim() !== '') {
      current.assistant =
        current.assistant === '' ? item.text : `${current.assistant}\n${item.text}`;
    }
  }
  return turns;
}

/** 発言に `Issue` / `MR` / `PR` の語が出ているか。 */
export function hasWorkReference(text: string): boolean {
  return (
    ISSUE_REFERENCE.test(text) ||
    UPPER_MR_PR_REFERENCE.test(text) ||
    NUMBERED_MR_PR_REFERENCE.test(text)
  );
}

/**
 * ターン完了時に付け直すか（Issue #1426の契機）。
 *
 * 最初のターンなら必ず付け直す。以降は、そのターンのユーザー発言か応答に `Issue` / `MR` /
 * `PR` の語が出たときだけにする。毎ターン呼ぶとCLIの使用量がかさむため。
 */
export function shouldAutoName(items: readonly ChatItem[]): boolean {
  const turns = splitTurns(items);
  const latest = turns.at(-1);
  if (latest === undefined) {
    return false;
  }
  return turns.length === 1 || hasWorkReference(`${latest.user}\n${latest.assistant}`);
}

/** 要約の材料。 */
export interface SessionAutoNameInput {
  items: readonly ChatItem[];
  /** 今の名前（接頭辞なし）。世代の印は材料から外し、付け直した名前へ残す。 */
  currentName: string | undefined;
  gitBranch: string | undefined;
}

/** CLIへ渡す材料。番号の検証にも同じ文字列を使う。 */
interface AutoNameMaterial {
  firstUser: string;
  firstAssistant: string;
  latest: AutoNameTurn | undefined;
  currentName: string | undefined;
  gitBranch: string | undefined;
}

function fold(text: string, limit: number): string {
  const single = text.replace(/\s+/gu, ' ').trim();
  return single.length <= limit ? single : `${single.slice(0, limit)}…`;
}

/** 先頭と末尾を残して真ん中を落とす。応答は結論が末尾に来やすい。 */
function foldEnds(text: string, limit: number): string {
  const single = text.replace(/\s+/gu, ' ').trim();
  if (single.length <= limit) {
    return single;
  }
  const head = Math.floor(limit / 2);
  return `${single.slice(0, head)}…（中略）…${single.slice(single.length - (limit - head))}`;
}

function buildMaterial(input: SessionAutoNameInput): AutoNameMaterial | undefined {
  const turns = splitTurns(input.items);
  const first = turns[0];
  if (first === undefined) {
    return undefined;
  }
  const last = turns.length > 1 ? turns.at(-1) : undefined;
  const current = input.currentName === undefined ? undefined : stripGeneration(input.currentName);
  return {
    firstUser: fold(first.user, USER_MESSAGE_LIMIT),
    firstAssistant: foldEnds(first.assistant, ASSISTANT_MESSAGE_LIMIT),
    latest:
      last === undefined
        ? undefined
        : {
            user: fold(last.user, USER_MESSAGE_LIMIT),
            assistant: foldEnds(last.assistant, ASSISTANT_MESSAGE_LIMIT),
          },
    currentName: current?.trim() === '' ? undefined : current?.trim(),
    gitBranch: input.gitBranch,
  };
}

/** 番号の検証に使う、CLIへ渡した材料の全文。 */
function materialText(material: AutoNameMaterial): string {
  return [
    material.firstUser,
    material.firstAssistant,
    material.latest?.user ?? '',
    material.latest?.assistant ?? '',
    material.currentName ?? '',
    material.gitBranch ?? '',
  ].join('\n');
}

function orNone(text: string): string {
  return text === '' ? '（無し）' : text;
}

/** 要約を頼むプロンプトを組み立てる。 */
function buildPrompt(material: AutoNameMaterial): string {
  const lines: string[] = [];
  lines.push(
    'あなたはコーディング支援の会話セッションに短い名前を付ける係です。下の会話から、作業の対象になっているIssue番号・GitLabのMR番号・GitHubのPR番号と、作業内容を表す日本語の短い名前（slug）を返してください。',
  );
  lines.push('');
  lines.push('会話の作業そのものは行わないでください。名前を付けるだけです。');
  lines.push('');
  lines.push('## 規則');
  lines.push('');
  lines.push(
    '- 番号は下の材料に書かれているものだけを使う。書かれていなければnullにする。推測で番号を作らない',
  );
  lines.push(
    '- 複数の番号が出てくるときは、いま作業の対象になっているものを選ぶ。直近のターンの話題を優先する',
  );
  lines.push('- GitLabのマージリクエストはmr、GitHubのプルリクエストはprに入れる');
  lines.push(
    '- slugは日本語で20字前後、30字以内。作業の中身が分かる名詞句にする（例: タブ名の自動付け直し）。番号・記号・「Issue」「MR」「PR」の語は含めない',
  );
  lines.push('- 今の名前が作業を正しく表していれば、同じ内容を返してよい');
  lines.push('');
  lines.push('## 材料');
  lines.push('');
  lines.push(`- 今の名前: ${material.currentName ?? '（無し）'}`);
  lines.push(`- gitブランチ: ${material.gitBranch ?? '不明'}`);
  lines.push('');
  lines.push('### 最初のユーザー発言');
  lines.push('');
  lines.push(orNone(material.firstUser));
  lines.push('');
  lines.push('### 最初の応答');
  lines.push('');
  lines.push(orNone(material.firstAssistant));
  if (material.latest !== undefined) {
    lines.push('');
    lines.push('### 直近のユーザー発言');
    lines.push('');
    lines.push(orNone(material.latest.user));
    lines.push('');
    lines.push('### 直近の応答');
    lines.push('');
    lines.push(orNone(material.latest.assistant));
  }
  lines.push('');
  lines.push('## 出力');
  lines.push('');
  lines.push(
    'JSONオブジェクトを1つだけ出力してください。前後に説明・コードブロックの記号・その他の文字を付けないこと。',
  );
  lines.push('');
  lines.push('{"issue": null, "mr": null, "pr": null, "slug": "<日本語の短い名前>"}');
  return lines.join('\n');
}

/** 要約の結果。番号は材料に現れたものだけが残る。 */
export interface SessionAutoNameResult {
  issue: number | undefined;
  mr: number | undefined;
  pr: number | undefined;
  slug: string;
}

/** slugを1行に畳み、`SLUG_MAX` 字（コードポイント単位）で切る。 */
export function truncateSlug(slug: string): string {
  const single = slug.replace(/\s+/gu, ' ').trim();
  return [...single].slice(0, SLUG_MAX).join('').trim();
}

/**
 * 番号を読む。正の整数で、かつ材料のテキストに数字の並びとして現れるものだけを受け付ける
 * （捏造の防止）。`12` は `123` の一部としては数えない。
 */
function readNumber(value: unknown, source: string): number | undefined {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/u.test(value.trim())
        ? Number(value.trim())
        : undefined;
  if (number === undefined || !Number.isSafeInteger(number) || number <= 0) {
    return undefined;
  }
  return new RegExp(`(?<!\\d)${number}(?!\\d)`, 'u').test(source) ? number : undefined;
}

/**
 * CLIの応答を読む。JSONとして読めなければ `undefined`。
 *
 * `source` は材料の全文で、ここに現れない番号は捨てる。
 */
export function parseAutoNameResponse(
  raw: string,
  source: string,
): SessionAutoNameResult | undefined {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end < start) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const slug = record['slug'];
  return {
    issue: readNumber(record['issue'], source),
    mr: readNumber(record['mr'], source),
    pr: readNumber(record['pr'], source),
    slug: typeof slug === 'string' ? truncateSlug(slug) : '',
  };
}

/**
 * 名前を組み立てる。取れた要素だけを並べ、今の名前の世代の印 `(続きN)` を末尾に残す。
 * 番号もslugも無ければ `undefined`（付け直さない）。
 */
export function buildAutoSessionName(
  result: SessionAutoNameResult,
  currentName: string | undefined,
): string | undefined {
  const parts = [
    result.issue === undefined ? undefined : `#${result.issue}`,
    result.mr === undefined ? undefined : `!${result.mr}`,
    result.pr === undefined ? undefined : `PR#${result.pr}`,
    result.slug === '' ? undefined : result.slug,
  ].filter((part): part is string => part !== undefined);
  if (parts.length === 0) {
    return undefined;
  }
  const mark = generationMarkOf(currentName);
  return mark === undefined ? parts.join(' ') : `${parts.join(' ')} ${mark}`;
}

export interface SessionAutoNameDeps {
  /** 会話しているCLI。 */
  provider: HeadlessProvider;
  executable: string;
  logWarn?: (message: string) => void;
  timeoutMs?: number;
  /** テストから差し替えるための口。既定は実際のヘッドレス実行。 */
  run?: ((deps: HeadlessCliDeps, prompt: string) => Promise<HeadlessOutcome>) | undefined;
}

/**
 * 会話を要約して新しい名前を返す。失敗したとき・材料が無いときは `undefined` で、理由は
 * `logWarn` へ出す。例外は投げない。
 */
export async function summarizeSessionName(
  deps: SessionAutoNameDeps,
  input: SessionAutoNameInput,
): Promise<string | undefined> {
  const material = buildMaterial(input);
  if (material === undefined) {
    return undefined;
  }
  const run = deps.run ?? runHeadlessPromptDetailed;
  const timeoutMs = deps.timeoutMs ?? CLASSIFIER_TIMEOUT_MS;
  try {
    const outcome = await run(
      {
        provider: deps.provider,
        executable: deps.executable,
        model: CLASSIFIER_MODELS[deps.provider],
        timeoutMs,
        ...(deps.logWarn === undefined ? {} : { logWarn: deps.logWarn }),
      },
      buildPrompt(material),
    );
    if (!outcome.ok) {
      deps.logWarn?.(
        outcome.reason === 'timeout'
          ? `タブ名の自動付け直しが時間切れになりました（${timeoutMs}ms）`
          : 'タブ名の自動付け直しを実行できませんでした（CLIの起動失敗・異常終了）',
      );
      return undefined;
    }
    const result = parseAutoNameResponse(outcome.text, materialText(material));
    if (result === undefined) {
      deps.logWarn?.('タブ名の自動付け直しの応答を読めませんでした（JSONとして不正）');
      return undefined;
    }
    const name = buildAutoSessionName(result, input.currentName);
    if (name === undefined) {
      deps.logWarn?.('タブ名の自動付け直しの応答に番号もslugもありませんでした');
    }
    return name;
  } catch (e) {
    deps.logWarn?.(
      `タブ名の自動付け直しで例外が出ました: ${e instanceof Error ? e.message : String(e)}`,
    );
    return undefined;
  }
}

/**
 * 1セッションで同時に1本だけ走らせる（Issue #1426）。
 *
 * 実行中に次の契機が来たら、終わってから1回だけ走らせ直す。契機が何度来ても走らせ直しは
 * 1回にまとめる。走らせ直すときの材料は、その時点の会話から読み直す（`job` の責務）。
 */
export class SerialRerun {
  private running = false;
  private again = false;

  constructor(
    private readonly job: () => Promise<void>,
    /** `job` が例外を投げたときの報告先。投げても次の契機では走らせる。 */
    private readonly onError: (error: unknown) => void,
  ) {}

  request(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    void this.drain();
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      do {
        this.again = false;
        await this.job().catch(this.onError);
      } while (this.again);
    } finally {
      this.running = false;
    }
  }
}

/** `MementoLike`（実体は `context.globalState`）に保存するときのキー。 */
export const MANUALLY_NAMED_SESSIONS_KEY = 'agent.manuallyNamedSessions';

/**
 * 人が手で名前を変えたセッションの印（Issue #1426）。
 *
 * 印の付いたセッションは自動で付け直さない。再読み込み後も効かせるため `globalState` に
 * 持つ。キーは `pinKeyFor` と同じ `<provider>:<sessionId>`。
 */
export class ManuallyNamedSessionStore {
  constructor(private readonly memento: MementoLike) {}

  has(key: string): boolean {
    return this.memento.get<string[]>(MANUALLY_NAMED_SESSIONS_KEY, []).includes(key);
  }

  async add(key: string): Promise<void> {
    const current = this.memento.get<string[]>(MANUALLY_NAMED_SESSIONS_KEY, []);
    if (current.includes(key)) {
      return;
    }
    await this.memento.update(MANUALLY_NAMED_SESSIONS_KEY, [...current, key]);
  }
}

/**
 * 画面（`ChatViewManager` / `ClaudeChatViewManager`）へ渡す自動付け直しの口（Issue #1426）。
 * 渡さなければ自動付け直し自体をしない（テストで実際のCLIを起こさないため）。
 */
export interface SessionAutoNameHost {
  marks: ManuallyNamedSessionStore;
  /** テストから差し替えるための口。既定は実際のヘッドレス実行。 */
  run?: SessionAutoNameDeps['run'];
}
