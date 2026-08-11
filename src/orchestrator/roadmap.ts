import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';

import { isPathWithinRoot } from './escalation';
import { detectForgeHost, type CliCommandRunner } from './forge';
import type { GitCommandRunner } from './worktree';
import { TASK_ID_PATTERN } from './workflow';

/**
 * ロードマップ（design.md §16.19）の純粋ロジック。
 *
 * VSCode APIには一切依存しない。生成セッションの起動（`TaskSessionHost` 経由での
 * 実際の実行）とVSCode層のUI（入力欄・エディタを開く等）はここに置かない。
 * `RoadmapGenerationPort` はインターフェースの定義だけをここに置き、実装（VSCode層の配線）は
 * 後続のIssueに委ねる（#95: `taskSession.ts` / `runner.ts` は別PR（#90）が変更中のため、
 * このIssueでは変更しない）。
 *
 * `workflow.ts`（純粋ロジック・全件まとめてのエラー報告）と `worktree.ts`（外部コマンドを
 * ポート越しに呼ぶ・execFileでシェルを経由しない）の書き方に合わせる。
 *
 * ホストの判定（`detectForgeHost`）と汎用CLI実行ポート（`CliCommandRunner`）は `forge.ts`
 * （#94）が正式な置き場になったため、そちらから参照する（重複を残さない）。
 */

/* -------------------------------------------------------------------------------------------- */
/* ロードマップMarkdownのパース                                                                  */
/* -------------------------------------------------------------------------------------------- */

/** ロードマップの1項目。`line` は元のMarkdown文字列中でのチェックボックス行の0始まりの行番号（書き戻し用）。 */
export interface RoadmapItem {
  id: string;
  checked: boolean;
  text: string;
  dependsOn: string[];
  issue: number | undefined;
  line: number;
}

export interface RoadmapPhase {
  name: string;
  items: RoadmapItem[];
}

export interface ParsedRoadmap {
  title: string;
  phases: RoadmapPhase[];
}

const TITLE_PATTERN = /^#\s+(.*)$/;
const PHASE_HEADING_PATTERN = /^##\s+(.*)$/;
/** `- [ ] R1 認証方式を決めて設計を書く` / `- [x] R1 ...`（大文字Xも許す）。 */
const CHECKBOX_ITEM_PATTERN = /^- \[([ xX])\]\s+(\S+)\s*(.*)$/;
const DEPENDS_LINE_PATTERN = /^\s*-\s*依存:\s*(.*)$/;
const ISSUE_LINE_PATTERN = /^\s*-\s*Issue:\s*#?(\d+)\s*$/;
/** `依存: なし` のような「無い」ことを表す値。 */
const NO_DEPENDENCY_TOKENS = new Set(['なし', 'none', '']);

function parseDependsValue(raw: string): string[] {
  return raw
    .split(/[,、]/u)
    .map((s) => s.trim())
    .filter((s) => !NO_DEPENDENCY_TOKENS.has(s));
}

/**
 * ロードマップMarkdownを構造化する（design.md §16.19の形式）。
 *
 * 見出し・チェックボックス以外の行はそのまま無視する。フェーズ見出しより前に現れた項目は
 * 名前が空文字のフェーズへ入れる（本来は無い想定だが、壊れた入力でも例外を投げないため）。
 */
export function parseRoadmapMarkdown(markdown: string): ParsedRoadmap {
  const lines = markdown.split(/\r?\n/u);
  let title = '';
  const phases: RoadmapPhase[] = [];
  let currentPhase: RoadmapPhase | undefined;

  const ensurePhase = (): RoadmapPhase => {
    if (currentPhase === undefined) {
      currentPhase = { name: '', items: [] };
      phases.push(currentPhase);
    }
    return currentPhase;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';

    const titleMatch = title === '' ? TITLE_PATTERN.exec(line) : null;
    if (titleMatch !== null) {
      title = (titleMatch[1] ?? '').trim();
      i += 1;
      continue;
    }

    const phaseMatch = PHASE_HEADING_PATTERN.exec(line);
    if (phaseMatch !== null) {
      currentPhase = { name: (phaseMatch[1] ?? '').trim(), items: [] };
      phases.push(currentPhase);
      i += 1;
      continue;
    }

    const itemMatch = CHECKBOX_ITEM_PATTERN.exec(line);
    if (itemMatch !== null) {
      const checked = (itemMatch[1] ?? ' ').toLowerCase() === 'x';
      const id = itemMatch[2] ?? '';
      const text = (itemMatch[3] ?? '').trim();
      const item: RoadmapItem = {
        id,
        checked,
        text,
        dependsOn: [],
        issue: undefined,
        line: i,
      };
      i += 1;
      // インデントされた付随行（依存・Issue）を読み進める
      while (i < lines.length) {
        const sub = lines[i] ?? '';
        const dependsMatch = DEPENDS_LINE_PATTERN.exec(sub);
        if (dependsMatch !== null) {
          item.dependsOn = parseDependsValue(dependsMatch[1] ?? '');
          i += 1;
          continue;
        }
        const issueMatch = ISSUE_LINE_PATTERN.exec(sub);
        if (issueMatch !== null) {
          const n = Number.parseInt(issueMatch[1] ?? '', 10);
          item.issue = Number.isFinite(n) ? n : undefined;
          i += 1;
          continue;
        }
        break;
      }
      ensurePhase().items.push(item);
      continue;
    }

    i += 1;
  }

  return { title, phases };
}

/* -------------------------------------------------------------------------------------------- */
/* パース結果の検証                                                                              */
/* -------------------------------------------------------------------------------------------- */

export interface RoadmapIssueEntry {
  itemIds: string[];
  message: string;
}

export interface RoadmapValidationResult {
  errors: RoadmapIssueEntry[];
  warnings: RoadmapIssueEntry[];
}

function allItems(parsed: ParsedRoadmap): RoadmapItem[] {
  return parsed.phases.flatMap((p) => p.items);
}

/**
 * 依存の循環を強連結成分（SCC）単位で検出する。`workflow.ts` の `findCycleGroups` と
 * 同じTarjanベースの考え方をロードマップ項目向けに書き直したもの（対象の型が違うため複製）。
 */
function findCycleGroups(items: readonly RoadmapItem[]): string[][] {
  const byId = new Map(items.map((it) => [it.id, it] as const));
  let counter = 0;
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const groups: string[][] = [];

  function strongConnect(id: string): void {
    index.set(id, counter);
    lowlink.set(id, counter);
    counter += 1;
    stack.push(id);
    onStack.add(id);

    const current = byId.get(id);
    for (const dep of current?.dependsOn ?? []) {
      if (!byId.has(dep)) {
        continue;
      }
      if (!index.has(dep)) {
        strongConnect(dep);
        lowlink.set(id, Math.min(lowlink.get(id) as number, lowlink.get(dep) as number));
      } else if (onStack.has(dep)) {
        lowlink.set(id, Math.min(lowlink.get(id) as number, index.get(dep) as number));
      }
    }

    if (lowlink.get(id) === index.get(id)) {
      const group: string[] = [];
      let member: string;
      do {
        member = stack.pop() as string;
        onStack.delete(member);
        group.push(member);
      } while (member !== id);

      const isSelfLoop = group.length === 1 && (byId.get(id)?.dependsOn ?? []).includes(id);
      if (group.length > 1 || isSelfLoop) {
        groups.push(group);
      }
    }
  }

  for (const id of byId.keys()) {
    if (!index.has(id)) {
      strongConnect(id);
    }
  }
  return groups;
}

/**
 * ロードマップの検証（design.md §16.19、Issue #95の受入基準）。`workflow.ts` の
 * `validateWorkflow` と同じく、1件見つかった時点で止めずエラーを全件まとめて返す。
 *
 * idの字種は `workflow.ts` の `TASK_ID_PATTERN` を再利用する。ロードマップの項目idは
 * §16.19の2段目でYAMLのタスクidへそのまま写される想定のため、worktreeのパス・ブランチ名に
 * 使える字種であることをこの時点で確かめておくと、後段（#58）での作り直しを防げる。
 */
export function validateRoadmap(parsed: ParsedRoadmap): RoadmapValidationResult {
  const errors: RoadmapIssueEntry[] = [];
  const warnings: RoadmapIssueEntry[] = [];
  const items = allItems(parsed);

  if (items.length === 0) {
    errors.push({ itemIds: [], message: 'ロードマップに項目が1件もありません' });
  }

  const idCounts = new Map<string, number>();
  for (const item of items) {
    idCounts.set(item.id, (idCounts.get(item.id) ?? 0) + 1);
    if (!TASK_ID_PATTERN.test(item.id)) {
      errors.push({
        itemIds: [item.id],
        message: `id の形式が不正です（半角英数字・_・-のみ、1〜50文字にしてください）: "${item.id}"`,
      });
    }
  }
  for (const [id, count] of idCounts) {
    if (count > 1) {
      errors.push({ itemIds: [id], message: `id が重複しています: ${id}` });
    }
  }

  const idSet = new Set(items.map((it) => it.id));
  for (const item of items) {
    for (const dep of item.dependsOn) {
      if (!idSet.has(dep)) {
        errors.push({
          itemIds: [item.id],
          message: `依存が未定義の項目を参照しています: ${dep}`,
        });
      }
    }
  }

  for (const group of findCycleGroups(items)) {
    errors.push({ itemIds: group, message: `依存が循環しています: ${group.join(', ')}` });
  }

  return { errors, warnings };
}

/* -------------------------------------------------------------------------------------------- */
/* 完了の書き戻し                                                                                */
/* -------------------------------------------------------------------------------------------- */

/** `applyRunCompletion` が受け取る、runの結果（タスクidと状態の対応）。 */
export type RunTaskStates = ReadonlyMap<string, string>;

export interface RunCompletionResult {
  markdown: string;
  /** チェックを入れた項目id。 */
  updatedItemIds: string[];
  /**
   * `taskStates` に含まれていたが、ロードマップのどの項目にも対応しなかったid
   * （design.md §16.19「対応が取れない項目には何もしない。ログに残す」）。
   */
  unmatchedTaskIds: string[];
}

const CHECKBOX_PREFIX_PATTERN = /^(\s*-\s*)\[[ xX]\]/;

/**
 * runが終わったら、`done` になったタスクに対応する項目のチェックボックスの記号だけを書き換える。
 * 本文は変えない。対応が取れない項目（`taskStates` にあるがロードマップに無いid）は何もせず、
 * `unmatchedTaskIds` として返す（design.md §16.19）。
 *
 * チェックは一方向にしか動かさない（`done` 以外の状態で既にチェック済みの項目を戻すことはしない）。
 * 人が書いた文を機械が書き換えないという方針（design.md）に、チェックの意味も含めて従う。
 */
export function applyRunCompletion(
  markdown: string,
  taskStates: RunTaskStates,
): RunCompletionResult {
  const parsed = parseRoadmapMarkdown(markdown);
  const itemsById = new Map(allItems(parsed).map((it) => [it.id, it] as const));
  const lines = markdown.split(/\r?\n/u);

  const updatedItemIds: string[] = [];
  const unmatchedTaskIds: string[] = [];

  for (const [taskId, state] of taskStates) {
    const item = itemsById.get(taskId);
    if (item === undefined) {
      unmatchedTaskIds.push(taskId);
      continue;
    }
    if (state !== 'done' || item.checked) {
      continue;
    }
    const target = lines[item.line] ?? '';
    const replaced = target.replace(CHECKBOX_PREFIX_PATTERN, '$1[x]');
    if (replaced !== target) {
      lines[item.line] = replaced;
      updatedItemIds.push(taskId);
    }
  }

  return { markdown: lines.join('\n'), updatedItemIds, unmatchedTaskIds };
}

/* -------------------------------------------------------------------------------------------- */
/* 生成用プロンプトの組み立て                                                                    */
/* -------------------------------------------------------------------------------------------- */

export interface RoadmapPromptInput {
  goal: string;
  /** ワークスペース直下の構成（ファイル・ディレクトリ名。ディレクトリは末尾に `/` を付ける）。 */
  workspaceSummary: readonly string[];
  hasAgentsFile: boolean;
  hasClaudeFile: boolean;
  /** 取得できなければ `undefined`（design.md §16.19「取れなければ飛ばす」）。 */
  existingIssues: readonly RoadmapIssueSummary[] | undefined;
}

const ROADMAP_FORMAT_EXAMPLE = `# <ゴール>

## Phase 1: <フェーズ名>

- [ ] R1 認証方式を決めて設計を書く
  - 依存: なし
  - Issue: #12
- [ ] R2 API側を実装する
  - 依存: R1
  - Issue: #13
- [ ] R3 UI側を実装する
  - 依存: R1`;

/**
 * ロードマップ生成セッションへ渡すプロンプトを組み立てる（design.md §16.19）。
 *
 * `workflow.ts` の分解セッション（§16.9）と同じく、返答はMarkdownのみとするよう指示する。
 * 既存のIssueと重複する項目を作らせないため、および項目にIssue番号を紐づけるために
 * `existingIssues` を材料へ含める。
 */
export function buildRoadmapPrompt(input: RoadmapPromptInput): string {
  const lines: string[] = [];
  lines.push('次のゴールを達成するためのロードマップを、Markdownで1つ作成してください。');
  lines.push('');
  lines.push('## ゴール');
  lines.push('');
  lines.push(input.goal);
  lines.push('');
  lines.push('## ワークスペースの構成（直下）');
  lines.push('');
  if (input.workspaceSummary.length === 0) {
    lines.push('（取得できませんでした）');
  } else {
    for (const entry of input.workspaceSummary) {
      lines.push(`- ${entry}`);
    }
  }
  lines.push('');
  lines.push('## AGENTS.md / CLAUDE.md');
  lines.push('');
  lines.push(`- AGENTS.md: ${input.hasAgentsFile ? 'あり' : 'なし'}`);
  lines.push(`- CLAUDE.md: ${input.hasClaudeFile ? 'あり' : 'なし'}`);
  lines.push('');
  lines.push('## 既存のIssue');
  lines.push('');
  if (input.existingIssues === undefined) {
    lines.push(
      '（取得できませんでした。重複の確認・Issue番号の紐付けはできる範囲で行ってください）',
    );
  } else if (input.existingIssues.length === 0) {
    lines.push('（既存のIssueはありません）');
  } else {
    for (const issue of input.existingIssues) {
      lines.push(`- #${issue.number} ${issue.title}`);
    }
  }
  lines.push('');
  lines.push('## 出力形式');
  lines.push('');
  lines.push(
    '次の形式のMarkdownのみを返してください。説明文やコードフェンスの前後の文章は含めないでください。',
  );
  lines.push('');
  lines.push('```markdown');
  lines.push(ROADMAP_FORMAT_EXAMPLE);
  lines.push('```');
  lines.push('');
  lines.push('- 項目のid（`R1` など）はロードマップの中で一意にしてください');
  lines.push(
    '- `依存` は同じロードマップ内の項目idで書いてください（無ければ `なし`）。書かれていない項目同士は並列に走らせられます',
  );
  lines.push(
    '- 既存のIssueと重複する項目は作らず、対応するIssueがあれば `Issue: #<番号>` を添えてください',
  );
  return lines.join('\n');
}

/** コードフェンスで囲まれて返ることが多いため、剥がしてからパーサへ渡す（design.md §16.9）。 */
export function stripMarkdownCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = /^```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n```$/u.exec(trimmed);
  return fenceMatch !== null ? (fenceMatch[1] ?? trimmed) : trimmed;
}

/* -------------------------------------------------------------------------------------------- */
/* ホストの判定・既存Issueの取得（ポート越し）                                                    */
/* -------------------------------------------------------------------------------------------- */

export interface RoadmapIssueSummary {
  number: number;
  title: string;
}

/** Issue一覧の取得の抽象。`gh issue list` / `glab issue list` を直接呼ばず、テストで差し替える。 */
export interface IssueListPort {
  /** 取得できなければ `undefined`（design.md §16.19「取れなければ飛ばす」）。 */
  listIssues(cwd: string): Promise<RoadmapIssueSummary[] | undefined>;
}

const ISSUE_LIST_LIMIT = 200;

function parseNumberTitleArray(
  stdout: string,
  numberKey: 'number' | 'iid',
): RoadmapIssueSummary[] | undefined {
  try {
    const data: unknown = JSON.parse(stdout);
    if (!Array.isArray(data)) {
      return undefined;
    }
    const out: RoadmapIssueSummary[] = [];
    for (const entry of data) {
      if (typeof entry !== 'object' || entry === null) {
        continue;
      }
      const rec = entry as Record<string, unknown>;
      const num = rec[numberKey];
      const title = rec['title'];
      if (typeof num === 'number' && typeof title === 'string') {
        out.push({ number: num, title });
      }
    }
    return out;
  } catch {
    return undefined;
  }
}

/**
 * `git remote get-url origin` でホストを判定し、`gh issue list` / `glab issue list` を
 * 実行するポートの実装（design.md §16.19「Issueは `gh issue list` / `glab issue list` で取る。
 * ホストの判定は §16.18 と同じ」）。
 *
 * 途中のどの段階が失敗しても（remoteが無い・ホストが判定できない・CLIが失敗する・出力が
 * JSONとして読めない）、例外を投げず `undefined` を返す（「取れなければ飛ばす」）。
 */
export function createCliIssueListPort(
  git: GitCommandRunner,
  cli: CliCommandRunner,
): IssueListPort {
  return {
    async listIssues(cwd: string): Promise<RoadmapIssueSummary[] | undefined> {
      const remote = await git.run(['remote', 'get-url', 'origin'], cwd);
      if (remote.code !== 0) {
        return undefined;
      }
      const host = detectForgeHost(remote.stdout.trim());
      if (host === undefined) {
        return undefined;
      }
      if (host === 'github') {
        const result = await cli.run(
          'gh',
          ['issue', 'list', '--json', 'number,title', '--limit', String(ISSUE_LIST_LIMIT)],
          cwd,
        );
        return result.code === 0 ? parseNumberTitleArray(result.stdout, 'number') : undefined;
      }
      const result = await cli.run('glab', ['issue', 'list', '-O', 'json'], cwd);
      return result.code === 0 ? parseNumberTitleArray(result.stdout, 'iid') : undefined;
    },
  };
}

/* -------------------------------------------------------------------------------------------- */
/* 出力先の決定・検証                                                                            */
/* -------------------------------------------------------------------------------------------- */

/** Windowsではファイル名として使えない予約デバイス名（大文字小文字を問わない完全一致）。 */
const WINDOWS_RESERVED_NAME_PATTERN = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
/** ファイル名・パスの区切りとして使えない文字、および空白類。 */
const SLUG_INVALID_CHARS_PATTERN = /[\\/:*?"<>|\s]+/gu;
const SLUG_MAX_LENGTH = 60;

/**
 * ゴールの文からファイル名（拡張子なし）を作る。Windowsでも使えないパス区切り文字・
 * 予約デバイス名は避けるが、日本語の文字自体は残す（一般的なファイルシステムはUnicode
 * ファイル名を扱えるため、無理に英数字へ変換しない）。
 */
export function slugifyGoal(goal: string): string {
  const collapsed = goal
    .trim()
    .replace(SLUG_INVALID_CHARS_PATTERN, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '');
  const truncated = collapsed.slice(0, SLUG_MAX_LENGTH);
  if (truncated === '' || WINDOWS_RESERVED_NAME_PATTERN.test(truncated)) {
    return 'roadmap';
  }
  return truncated;
}

export type RoadmapPathResult = { ok: true; path: string } | { ok: false; message: string };

/**
 * ロードマップの出力先パスを解決し、ワークスペースフォルダの配下に収まっているか検証する
 * （design.md §16.16「成果の統合まわりの設定」表の `agent.workflows.roadmapDir`
 * 「出力先のパス。ワークスペースフォルダの配下に限る」）。
 *
 * `roadmapDir` 自体の安全確認（絶対パス・`..` を含まないか）は設定の読み込み側
 * （`config.ts` の `isSafeRelativeDir`）が既に行う前提だが、ここでも文字列結合の結果を
 * 実際に検証する（`worktree.ts` の多層防御と同じ考え方。設定側の検証漏れ・将来の変更に
 * 対する二次防御）。
 */
export function resolveRoadmapOutputPath(
  workspaceRoot: string,
  roadmapDir: string,
  slug: string,
): RoadmapPathResult {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(root, roadmapDir, `${slug}.md`);
  if (!isPathWithinRoot(target, root)) {
    return { ok: false, message: `出力先がワークスペースフォルダの外です: ${target}` };
  }
  return { ok: true, path: target };
}

/* -------------------------------------------------------------------------------------------- */
/* 生成セッションの起動（ポートのみ。実装は後続Issue）                                            */
/* -------------------------------------------------------------------------------------------- */

export interface RoadmapGenerationRequest {
  prompt: string;
}

export type RoadmapGenerationResult = { ok: true; text: string } | { ok: false; message: string };

/**
 * ロードマップ生成セッションの起動を抽象化するポート。
 *
 * **実装（VSCode層の配線）はこのIssue（#95）の範囲外。** design.md §16.19は生成セッションを
 * §16.9の分解セッションと同じ制限（`sandbox: read-only` 相当、承認要求は全て拒否）で
 * 走らせると定めているが、それを実現する `TaskSessionHost.openTaskSession` /
 * `runLoop` / `setApprovalHandler`（全承認を拒否）/ `ChatState.turnResultText` の呼び出しは
 * `src/orchestrator/taskSession.ts` を経由する。同ファイルは別PR（#90）が変更中のため、
 * このIssueでは変更しない方針に合わせ、ここではインターフェースの定義だけに留める。
 * 呼び出し側（`extension.ts` の合成ルート）は、実装が用意されるまで
 * 「未実装」を返すポートを渡してもよい。
 */
export interface RoadmapGenerationPort {
  generate(request: RoadmapGenerationRequest): Promise<RoadmapGenerationResult>;
}

/* -------------------------------------------------------------------------------------------- */
/* ファイルシステムのポート                                                                      */
/* -------------------------------------------------------------------------------------------- */

export interface RoadmapFileSystemPort {
  writeTextFile(target: string, content: string): Promise<void>;
  readTextFile(target: string): Promise<string | undefined>;
}

export const nodeRoadmapFileSystem: RoadmapFileSystemPort = {
  async writeTextFile(target: string, content: string): Promise<void> {
    await fsPromises.mkdir(path.dirname(target), { recursive: true });
    await fsPromises.writeFile(target, content, 'utf8');
  },
  async readTextFile(target: string): Promise<string | undefined> {
    try {
      return await fsPromises.readFile(target, 'utf8');
    } catch {
      return undefined;
    }
  },
};

/* -------------------------------------------------------------------------------------------- */
/* オーケストレーション                                                                          */
/* -------------------------------------------------------------------------------------------- */

export interface GenerateRoadmapDeps {
  generation: RoadmapGenerationPort;
  issues: IssueListPort;
  fs: RoadmapFileSystemPort;
}

export interface GenerateRoadmapInput {
  goal: string;
  workspaceRoot: string;
  roadmapDir: string;
  workspaceSummary: readonly string[];
  hasAgentsFile: boolean;
  hasClaudeFile: boolean;
}

export type GenerateRoadmapResult =
  | {
      ok: true;
      path: string;
      markdown: string;
      parsed: ParsedRoadmap;
      validation: RoadmapValidationResult;
    }
  | { ok: false; reason: 'pathOutsideWorkspace' | 'generationFailed'; message: string };

/**
 * ゴールの文からロードマップを生成し、設定した置き場へ保存する（design.md §16.19の1段目）。
 * 純粋関数ではないが、I/Oは全てポート越しにしているためVSCode APIには依存しない。
 */
export async function generateRoadmap(
  deps: GenerateRoadmapDeps,
  input: GenerateRoadmapInput,
): Promise<GenerateRoadmapResult> {
  const slug = slugifyGoal(input.goal);
  const pathResult = resolveRoadmapOutputPath(input.workspaceRoot, input.roadmapDir, slug);
  if (!pathResult.ok) {
    return { ok: false, reason: 'pathOutsideWorkspace', message: pathResult.message };
  }

  const existingIssues = await deps.issues.listIssues(input.workspaceRoot);
  const prompt = buildRoadmapPrompt({
    goal: input.goal,
    workspaceSummary: input.workspaceSummary,
    hasAgentsFile: input.hasAgentsFile,
    hasClaudeFile: input.hasClaudeFile,
    existingIssues,
  });

  const generated = await deps.generation.generate({ prompt });
  if (!generated.ok) {
    return { ok: false, reason: 'generationFailed', message: generated.message };
  }

  const markdown = stripMarkdownCodeFence(generated.text);
  const parsed = parseRoadmapMarkdown(markdown);
  const validation = validateRoadmap(parsed);
  await deps.fs.writeTextFile(pathResult.path, markdown);

  return { ok: true, path: pathResult.path, markdown, parsed, validation };
}

export interface ApplyRunCompletionDeps {
  fs: RoadmapFileSystemPort;
}

export type ApplyRunCompletionOutcome =
  | { ok: true; updatedItemIds: string[]; unmatchedTaskIds: string[] }
  | { ok: false; reason: 'readFailed'; message: string };

/**
 * ロードマップファイルを読み込み、runの結果で `done` になった項目のチェックだけを更新して
 * 書き戻す（design.md §16.19「ロードマップの更新」）。更新が1件も無ければファイルには触れない。
 */
export async function applyRunCompletionToFile(
  deps: ApplyRunCompletionDeps,
  roadmapPath: string,
  taskStates: RunTaskStates,
): Promise<ApplyRunCompletionOutcome> {
  const markdown = await deps.fs.readTextFile(roadmapPath);
  if (markdown === undefined) {
    return {
      ok: false,
      reason: 'readFailed',
      message: `ロードマップファイルを読み込めませんでした: ${roadmapPath}`,
    };
  }
  const result = applyRunCompletion(markdown, taskStates);
  if (result.updatedItemIds.length > 0) {
    await deps.fs.writeTextFile(roadmapPath, result.markdown);
  }
  return {
    ok: true,
    updatedItemIds: result.updatedItemIds,
    unmatchedTaskIds: result.unmatchedTaskIds,
  };
}
