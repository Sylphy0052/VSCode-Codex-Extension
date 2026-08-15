import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';

import type { Logger } from '../log';
import { isPathWithinRoot } from './escalation';
import { detectForgeHost, type CliCommandRunner } from './forge';
import {
  buildPlannerSessionInput,
  planWorkflow,
  sendSingleTurn,
  type PlanWorkflowFailure,
  type PlanWorkflowInput,
  type PlanWorkflowSuccess,
  type WorkspaceSummary,
} from './planner';
import type { ExtensionSafetyBaseline } from './taskConfig';
import type { TaskSessionHost } from './taskSession';
import type { GitCommandRunner } from './worktree';
import {
  findCycleGroups,
  MAX_TASK_COUNT,
  TASK_ID_PATTERN,
  type Provider,
  type WorkflowDefinition,
} from './workflow';

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
/* 2段目: ロードマップからYAMLへ変換する材料（design.md §16.19 2段目、Issue #58）                */
/* -------------------------------------------------------------------------------------------- */

/**
 * `workflow.plan`（`planner.ts`）へ渡す、ロードマップの1項目分の材料。`RoadmapItem`から
 * 分解セッションの材料として必要な部分だけを取り出した形（`checked`/`line`は不要）。
 */
export interface RoadmapMaterialItem {
  id: string;
  text: string;
  dependsOn: readonly string[];
  issue: number | undefined;
}

/**
 * 次に着手すべきフェーズを選ぶ（design.md §16.19 2段目「次のフェーズだけYAMLにする」を
 * 選べるようにする、の既定候補）。未チェックの項目を1件以上含む最初のフェーズを返す。
 * 全フェーズ完了済みなら `undefined`。呼び出し側（UI層）はこれを既定の選択にしつつ、
 * `parsed.phases` から他のフェーズも選び直せるようにする。
 */
export function selectNextRoadmapPhase(parsed: ParsedRoadmap): RoadmapPhase | undefined {
  return parsed.phases.find((phase) => phase.items.some((item) => !item.checked));
}

/** フェーズの項目を、分解セッションへ渡す材料の形へ変換する。 */
export function selectRoadmapPhaseItems(phase: RoadmapPhase): RoadmapMaterialItem[] {
  return phase.items.map((item) => ({
    id: item.id,
    text: item.text,
    dependsOn: item.dependsOn,
    issue: item.issue,
  }));
}

/** 複数フェーズ分の項目を、渡された順にそのまま連結する。 */
export function selectRoadmapPhasesItems(phases: readonly RoadmapPhase[]): RoadmapMaterialItem[] {
  return phases.flatMap((phase) => selectRoadmapPhaseItems(phase));
}

/**
 * チャンク分割によって落とした依存1件（design.md §16.19 2段目「複数フェーズをまとめて
 * YAML化する」）。落とした側の項目idと、参照先だった項目idを持つ。
 */
export interface DroppedRoadmapDependency {
  itemId: string;
  dependsOnId: string;
}

/**
 * 1つのYAMLへまとめるフェーズの束。
 *
 * `items` の `dependsOn` は**このチャンクの中に存在する項目だけ**に絞ってある。チャンクを
 * またぐ依存はYAMLでは表現できない（別のrunになるため、存在しないタスクidへの`dependsOn`は
 * §16.2の検証で弾かれる）。落とした依存は `droppedDependencies` に残し、呼び出し側が人へ
 * 知らせる（チャンクの実行順序は人が守る必要がある）。
 */
export interface RoadmapPhaseChunk {
  /** このチャンクに入ったフェーズ名（ロードマップ上の順）。 */
  phaseNames: string[];
  items: RoadmapMaterialItem[];
  droppedDependencies: DroppedRoadmapDependency[];
  /**
   * 1フェーズだけで上限を超えており、これ以上フェーズ単位では割れないチャンク。
   * 生成しても§16.2のタスク数上限で弾かれる可能性が高いことを呼び出し側へ知らせる。
   */
  overCapacity: boolean;
}

/**
 * 選んだフェーズを、1つのYAMLへ収まる単位（チャンク）へ分ける（design.md §16.19 2段目）。
 *
 * フェーズをまたいで1本のYAMLにできるようにしたが、タスク数には上限（`MAX_TASK_COUNT`）が
 * あるため、合計が上限を超える選択では複数のYAMLへ分ける。**区切りはフェーズ単位**で、
 * フェーズの途中では割らない（フェーズの中の項目は互いに関係が深く、途中で切ると
 * 依存を落とす量が増えるため）。ロードマップ上の順を保ったまま、前から貪欲に詰める。
 *
 * 1フェーズだけで上限を超える場合は、そのフェーズだけで1チャンクにし `overCapacity` を
 * 立てる（フェーズ単位という区切り方を保つ以上、これ以上は割れない）。
 */
export function splitRoadmapPhasesIntoChunks(
  phases: readonly RoadmapPhase[],
  maxItemsPerChunk: number = MAX_TASK_COUNT,
): RoadmapPhaseChunk[] {
  const limit = Math.max(1, maxItemsPerChunk);
  const groups: RoadmapPhase[][] = [];
  let current: RoadmapPhase[] = [];
  let currentCount = 0;

  for (const phase of phases) {
    const count = phase.items.length;
    if (current.length > 0 && currentCount + count > limit) {
      groups.push(current);
      current = [];
      currentCount = 0;
    }
    current.push(phase);
    currentCount += count;
  }
  if (current.length > 0) {
    groups.push(current);
  }

  return groups.map((group) => {
    const items = selectRoadmapPhasesItems(group);
    const idsInChunk = new Set(items.map((item) => item.id));
    const droppedDependencies: DroppedRoadmapDependency[] = [];
    const scopedItems = items.map((item) => {
      const kept: string[] = [];
      for (const dep of item.dependsOn) {
        if (idsInChunk.has(dep)) {
          kept.push(dep);
          continue;
        }
        droppedDependencies.push({ itemId: item.id, dependsOnId: dep });
      }
      return { ...item, dependsOn: kept };
    });
    return {
      phaseNames: group.map((phase) => phase.name),
      items: scopedItems,
      droppedDependencies,
      overCapacity: group.length === 1 && items.length > limit,
    };
  });
}

/**
 * 選んだ項目を、分解セッションへ渡すテキストの材料として整形する（design.md §16.19 2段目
 * 「項目をtasksに、依存をdependsOnに写す」「Issue番号を持つ項目は…issueフィールドとして
 * 持たせる」）。
 *
 * idと依存とIssue番号はそのまま転記するよう明示的に指示する。分解セッション（LLM）が
 * 依存関係やIssue番号を書き換えてしまうと、依存順序が壊れたまま実行されたり、誤った
 * Issueへ`Closes #<N>`が送られたりする。ここでの指示はあくまで補助で、一次防御ではない
 * （`planWorkflowFromRoadmapPhase`が生成後に`detectRoadmapMaterialMismatches`で機械的にも
 * 確認する）。
 */
export function formatRoadmapMaterial(items: readonly RoadmapMaterialItem[]): string {
  const lines: string[] = [];
  lines.push('## ロードマップの材料');
  lines.push('');
  lines.push(
    '次の項目を、それぞれ1つのタスクとして書き出してください。' +
      'タスクのidは項目のidをそのまま使い、書き換えないこと。' +
      'dependsOnは項目の依存をそのまま写し、それ以外の依存を追加しないこと。' +
      'Issueが示されている項目は、タスクのissueフィールドへその番号をそのまま書くこと' +
      '（省略・改変しないこと。Issueが示されていない項目にissueを書かないこと）。' +
      'promptとdoneは、項目の内容から具体的に書き起こすこと。',
  );
  lines.push('');
  for (const item of items) {
    const depends = item.dependsOn.length > 0 ? item.dependsOn.join(', ') : 'なし';
    const issueText = item.issue !== undefined ? `#${item.issue}` : 'なし';
    lines.push(`- id: ${item.id}`);
    lines.push(`  内容: ${item.text}`);
    lines.push(`  依存: ${depends}`);
    lines.push(`  Issue: ${issueText}`);
  }
  return lines.join('\n');
}

/**
 * `planWorkflowFromRoadmapPhases`が使う既定のゴール文。ロードマップのタイトルと
 * フェーズ名から組み立てる。複数フェーズをまとめてYAML化する場合は全ての名前を並べる。
 */
export function buildRoadmapPlanGoal(roadmapTitle: string, phaseNames: readonly string[]): string {
  const names = phaseNames.map((name) => `「${name}」`).join('');
  return `${roadmapTitle}のうち${names}を実行できるワークフローに分解する`;
}

/** `detectRoadmapMaterialMismatches`が返す1件。 */
export interface RoadmapMaterialMismatch {
  itemId: string;
  kind: 'missing' | 'dependsOnMismatch' | 'issueMismatch';
  message: string;
}

/**
 * 生成されたワークフロー定義が、渡した材料（id・依存・Issue）を正しく転記できているかを
 * 機械的に確かめる（design.md §16.19 2段目の検証。分解セッションはLLMであり、転記を誤る・
 * 省略する可能性を否定できないため）。
 *
 * `validateWorkflow`（YAMLとして妥当かどうか）とは別の観点の確認で、これに失敗しても
 * YAML自体は妥当でありうる。あくまで「材料を正しく使ったか」の確認であり、`planWorkflow`
 * の検証・再試行の対象にはしない（design.md §16.9の再試行は検証エラーに対するものであり、
 * 材料の転記漏れはここでは検証エラーとして扱わない）。呼び出し側が結果を見て人に知らせる。
 */
export function detectRoadmapMaterialMismatches(
  material: readonly RoadmapMaterialItem[],
  definition: WorkflowDefinition,
): RoadmapMaterialMismatch[] {
  const byId = new Map(definition.tasks.map((t) => [t.id, t] as const));
  const mismatches: RoadmapMaterialMismatch[] = [];

  for (const item of material) {
    const task = byId.get(item.id);
    if (task === undefined) {
      mismatches.push({
        itemId: item.id,
        kind: 'missing',
        message: `ロードマップの項目 ${item.id} に対応するタスクが生成されていません`,
      });
      continue;
    }

    const expectedDeps = new Set(item.dependsOn);
    const actualDeps = new Set(task.dependsOn);
    const dependsOnMatches =
      expectedDeps.size === actualDeps.size && [...expectedDeps].every((d) => actualDeps.has(d));
    if (!dependsOnMatches) {
      mismatches.push({
        itemId: item.id,
        kind: 'dependsOnMismatch',
        message:
          `${item.id}: dependsOnがロードマップの依存と一致しません` +
          `（期待: ${[...expectedDeps].join(', ') || 'なし'}, ` +
          `実際: ${[...actualDeps].join(', ') || 'なし'}）`,
      });
    }

    if (item.issue !== task.issue) {
      mismatches.push({
        itemId: item.id,
        kind: 'issueMismatch',
        message:
          `${item.id}: issueがロードマップと一致しません` +
          `（期待: ${item.issue ?? 'なし'}, 実際: ${task.issue ?? 'なし'}）`,
      });
    }
  }

  return mismatches;
}

export interface PlanWorkflowFromRoadmapInput {
  roadmapTitle: string;
  /**
   * このYAMLへまとめるフェーズの束（`splitRoadmapPhasesIntoChunks`が返すチャンク）。
   * `items`の`dependsOn`はチャンクの中だけに絞られている前提で扱う。
   */
  chunk: RoadmapPhaseChunk;
  /** 既定は `buildRoadmapPlanGoal(roadmapTitle, chunk.phaseNames)`。呼び出し側が上書きできる。 */
  goal?: string;
  workspaceSummary: WorkspaceSummary;
  /** 分解セッションに使うプロバイダ（`planner.ts`の`PlanWorkflowInput`と同じ）。 */
  provider: Provider;
  host: TaskSessionHost;
  cwd: string;
  baseline: ExtensionSafetyBaseline;
  log: Logger;
}

export type PlanWorkflowFromRoadmapResult =
  | (PlanWorkflowSuccess & {
      roadmapMismatches: readonly RoadmapMaterialMismatch[];
      /** このチャンクで落とした、チャンクをまたぐ依存（`RoadmapPhaseChunk`参照）。 */
      droppedDependencies: readonly DroppedRoadmapDependency[];
    })
  | PlanWorkflowFailure;

/**
 * ロードマップの1チャンク（1つ以上のフェーズ）から、ワークフロー定義（YAML）を生成する
 * （design.md §16.19 2段目）。`planner.ts`の分解セッション（§16.9）をそのまま使い、
 * 材料としてチャンクの項目（id・依存・Issue）を渡す。生成後、材料が正しく転記されたかを
 * `detectRoadmapMaterialMismatches`で確認し、結果に含める。
 *
 * 分解セッションの安全設定（`sandbox: read-only`相当・承認全拒否）は`planWorkflow`が
 * `buildPlannerSessionInput`経由で組み立てる。ここで独自に安全設定を作らない
 * （`createTaskSessionRoadmapGenerationPort`と同じ「重複を残さない」判断）。
 */
export async function planWorkflowFromRoadmapPhases(
  input: PlanWorkflowFromRoadmapInput,
): Promise<PlanWorkflowFromRoadmapResult> {
  const items = input.chunk.items;
  const material = formatRoadmapMaterial(items);
  const goal = input.goal ?? buildRoadmapPlanGoal(input.roadmapTitle, input.chunk.phaseNames);

  const planInput: PlanWorkflowInput = {
    goal,
    workspaceSummary: input.workspaceSummary,
    provider: input.provider,
    host: input.host,
    cwd: input.cwd,
    baseline: input.baseline,
    log: input.log,
    roadmapMaterial: material,
  };
  const result = await planWorkflow(planInput);
  if (!result.ok) {
    return result;
  }
  return {
    ...result,
    roadmapMismatches: detectRoadmapMaterialMismatches(items, result.definition),
    droppedDependencies: input.chunk.droppedDependencies,
  };
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

/**
 * `RoadmapGenerationPort` の実装（Issue #105。上のJSDocが「範囲外」としていた配線）。
 *
 * `planner.ts` の分解セッション（design.md §16.9）と全く同じ安全要件（`sandbox: read-only`
 * 相当で起動し、承認要求は全て拒否する。プロンプトの指示ではなく起動時の設定で縛る）を
 * 課される（design.md §16.19「生成セッションは§16.9の分解セッションと同じ制限で走らせる」）
 * ため、独自に実装し直さず `planner.ts` がexportする `buildPlannerSessionInput` /
 * `sendSingleTurn` をそのまま使う。この2関数は「最も安全な値を直接指定し、起動直前に
 * ずれていないか確認してから開く」（`assertPlannerSessionIsSafe`）を内包しているため、
 * ここで安全設定を再実装する必要が無い。
 *
 * 生成は1ターンで終わらせ、`sendSingleTurn` が `finally` でセッションを閉じる
 * （design.md §16.19「生成が終わったらセッションを閉じる」）。
 */
export function createTaskSessionRoadmapGenerationPort(
  host: TaskSessionHost,
  provider: Provider,
  cwd: string,
): RoadmapGenerationPort {
  return {
    async generate(request: RoadmapGenerationRequest): Promise<RoadmapGenerationResult> {
      const input = buildPlannerSessionInput(provider, cwd);
      try {
        const text = await sendSingleTurn(host, provider, input, request.prompt);
        return { ok: true, text };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { ok: false, message: `ロードマップ生成セッションが失敗しました: ${message}` };
      }
    },
  };
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

/**
 * 生成したワークフロー定義へ、生成元のロードマップへの参照（`roadmap:`）を書き加える
 * （design.md §16.19「ロードマップの更新」、Issue #173）。
 *
 * runが終わったときにどのロードマップへチェックを書き戻すかは、定義ファイル自身が持って
 * いないと分からない（runと定義の対応しか実行時には残らない）。分解セッションが生成した
 * YAMLはロードマップの所在を知らないため、保存する直前にオーケストレータ側で足す。
 *
 * `version:` の直後（無ければ先頭）へ1行だけ挿入する。値はダブルクォートで囲み、パス区切りは
 * POSIX形式（`/`）へ揃える。既に `roadmap:` を持つ定義（人が手で書いた場合など）はその値を
 * 尊重してそのまま返す。
 */
export function withRoadmapReference(
  yaml: string,
  definition: WorkflowDefinition,
  roadmapRelativePath: string,
): { yaml: string; definition: WorkflowDefinition } {
  const normalized = roadmapRelativePath.split(/[\\/]/u).join('/');
  if (definition.roadmap !== undefined) {
    return { yaml, definition };
  }
  const lines = yaml.split(/\r?\n/u);
  const versionIndex = lines.findIndex((line) => /^version\s*:/u.test(line));
  const inserted = `roadmap: ${JSON.stringify(normalized)}`;
  const at = versionIndex >= 0 ? versionIndex + 1 : 0;
  lines.splice(at, 0, inserted);
  return {
    yaml: lines.join('\n'),
    definition: { ...definition, roadmap: normalized },
  };
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
