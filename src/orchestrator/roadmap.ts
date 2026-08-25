import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';

import { isMap, isSeq, parseDocument } from 'yaml';

import type { Logger } from '../log';
import { isPathWithinRoot } from './escalation';
import { detectForgeHost, type CliCommandRunner } from './forge';
import {
  buildPlannerSessionInput,
  planWorkflow,
  sendSingleTurn,
  slugifyGoal,
  type PlanWorkflowFailure,
  type PlanWorkflowInput,
  type PlanWorkflowSuccess,
  type WorkspaceSummary,
} from './planner';
import { sanitizeForLog } from './sanitize';
import { SerialQueue } from './serialQueue';
import type { ExtensionSafetyBaseline } from './taskConfig';
import type { TaskSessionHost } from './taskSession';
import { formatUntrusted, sanitizeInlineText } from './untrustedText';
import type { GitCommandRunner } from './worktree';
import {
  findCycleGroups,
  MAX_TASK_COUNT,
  parseWorkflowYaml,
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
  /**
   * `Issue:` 行自体は存在したが、番号として読み取れなかった場合に `true`（Issue #408 根拠1）。
   * `issue === undefined` だけでは「そもそもIssue行が無い」場合と区別できず、
   * `alignRoadmapIssues` がどちらも同じに扱うと、後者（読み取れなかっただけ）でも
   * 生成YAML側の`issue`を誤って削ってしまう。両者を区別するためのフィールド。
   */
  issueUnparseable: boolean;
  line: number;
}

export interface RoadmapPhase {
  name: string;
  items: RoadmapItem[];
}

export interface ParsedRoadmap {
  title: string;
  phases: RoadmapPhase[];
  /**
   * パース時に読み飛ばした・警告に倒した内容（Issue #408）。`validateRoadmap`が
   * 自身の`warnings`へ引き継ぐ（design.md §16.19の警告の器へ乗せる）。
   */
  warnings: RoadmapIssueEntry[];
}

const TITLE_PATTERN = /^#\s+(.*)$/;
const PHASE_HEADING_PATTERN = /^##\s+(.*)$/;
/**
 * `- [ ] R1 認証方式を決めて設計を書く` / `- [x] R1 ...`（大文字Xも許す）。
 *
 * 先頭のインデントと `-` / `*` / `+` のマーカーの揺れを許容する（Issue #408 根拠2。
 * 実測で `  - [ ] R1 foo` も `* [ ] R1 foo` も旧パターンでは不一致だった）。
 */
const CHECKBOX_ITEM_PATTERN = /^\s*[-*+]\s*\[([ xX])\]\s+(\S+)\s*(.*)$/u;
/**
 * チェックボックスらしき行のうち、`CHECKBOX_ITEM_PATTERN`に一致しなかったものを検出する
 * ための緩いパターン（Issue #408）。`[]`の中身を短く限定し、`(`が直後に続く場合
 * （Markdownリンク `- [text](url)`）を除外することで、自由記述のロードマップに実在する
 * リンクの箇条書き（例: `docs/roadmap/review-and-feature-consolidation.md:22`）を
 * 誤検出しないようにしてある。
 *
 * **`[]`の中身は0〜3文字までしか警告対象にしない（4文字以上は無音で読み飛ばす）。**
 * 上限を設けず`[^\]]*`にすると、Markdownリンクの箇条書き（`- [ux-improvements.md](...)`
 * や `- [text](url)`）の`[]`部分まで拾ってしまい、正当なリンク行を誤って
 * 「チェックボックスらしき行」として警告してしまう（実測: `[ux-improvements.md]`は
 * 18文字あり、桁数で区別しないと`(`の直後除外だけでは弾けない場合がある）。
 * 実在のロードマップのチェックボックス記号（` `/`x`/`X`程度、たまに`z`等の誤字1文字）は
 * 3文字以内に収まるため、境界を3文字に置き、4文字以上は「チェックボックスではなく
 * 自由記述のリンク等だろう」と判断して無視する（レビュー指摘: minor 5）。
 */
const CHECKBOX_LIKE_PATTERN = /^\s*[-*+]\s*\[[^\]]{0,3}\](?!\()/u;
const DEPENDS_LINE_PATTERN = /^\s*-\s*依存:\s*(.*)$/;
/**
 * `- Issue: #12` / `- Issue: 12` に加え、番号の直後の余剰テキストも許容する
 * （Issue #408 根拠1。実測で `- Issue: #12（既存）` は旧パターンでは不一致だった）。
 *
 * 末尾の`(?!\d)`は付けていない。`\d+`は貪欲マッチのため、数字が続く限り呑み込んでから
 * バックトラックする形にしかならず、この否定先読みは常に真になる（＝no-op。実測で
 * 削除前後の挙動に差が無いことを確認済み。レビュー指摘: minor 6）。「`#123`のうち
 * `12`だけを拾ってしまう」ような誤読は、`\d+`が貪欲である時点で起きない。
 */
const ISSUE_LINE_PATTERN = /^\s*-\s*Issue:\s*#?(\d+).*$/u;
/**
 * `Issue:` 行そのものの検出用（数字が読めるかは問わない）。`ISSUE_LINE_PATTERN`が不一致でも
 * この緩いパターンが一致すれば「Issue行のつもりだが数値として読めなかった」と判定できる
 * （Issue #408。`- Issue: 未起票（着手時に起票する）`のような実例が
 * `docs/roadmap/review-and-feature-consolidation.md:132`にある）。
 */
const ISSUE_LINE_CANDIDATE_PATTERN = /^\s*-\s*Issue:\s*(.*)$/u;
/** `依存: なし` のような「無い」ことを表す値。 */
const NO_DEPENDENCY_TOKENS = new Set(['なし', 'none', '']);

/**
 * GitHub/GitLabのIssue番号として現実的とみなす最大桁数（レビュー指摘: medium 2）。
 * 両サービスとも実際のissue/iidが10桁（100億件超）に達することはまず無いため、
 * これを超える桁数は「数字らしき文字列ではあるが番号としては扱わない」判断に使う。
 * `Number.isSafeInteger`だけでは、10桁でも安全整数の範囲に収まる値（例:
 * `9999999999`は10桁で安全整数）を弾けないため、別途この桁数チェックを設けてある。
 */
const MAX_ISSUE_NUMBER_DIGITS = 10;

/**
 * 1回のパース（`parseRoadmapMarkdown`）で積む警告件数の上限（レビュー指摘: low 4）。
 * 壊れたロードマップMarkdownは「チェックボックスらしき行」が大量に一致しうるため、
 * 無制限に積むとOutput panelが警告で埋まる。上限を超えた分は個別の警告を積まず、
 * 末尾に「他N件」の警告を1件だけ積む。
 */
const MAX_ROADMAP_PARSE_WARNINGS = 20;

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
  const warnings: RoadmapIssueEntry[] = [];
  // 上限（`MAX_ROADMAP_PARSE_WARNINGS`）を超えた分はここで数えるだけにし、個別には積まない
  let suppressedWarningCount = 0;
  const addWarning = (entry: RoadmapIssueEntry): void => {
    if (warnings.length < MAX_ROADMAP_PARSE_WARNINGS) {
      warnings.push(entry);
    } else {
      suppressedWarningCount += 1;
    }
  };

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
        issueUnparseable: false,
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
          const rawNumber = issueMatch[1] ?? '';
          const n = Number.parseInt(rawNumber, 10);
          // `Number.parseInt`は桁溢れした数字列（例: 20桁の`9`並び）を`Infinity`として
          // 返す。`Number.isFinite`だけで弾いても、`Infinity`にならない程度の桁溢れ
          // （安全整数の範囲を超えるが有限）は`Number.isSafeInteger`でないと弾けず、
          // さらに安全整数の範囲に収まる10桁超の値（現実には存在しない桁数のIssue番号）
          // は桁数チェックでないと弾けない。3つとも満たさなければ「番号として読めなかった」
          // 扱いにする（レビュー指摘: medium 2。以前は`Number.isFinite`だけを見ており、
          // 桁溢れで`Infinity`になった場合に`issueUnparseable`が立たず、`ISSUE_LINE_PATTERN`
          // に一致した時点で`continue`するため後段の`ISSUE_LINE_CANDIDATE_PATTERN`
          // フォールバックへも到達せず、「Issue行が無い」場合と誤って同一視されていた）
          const isValidIssueNumber =
            Number.isFinite(n) &&
            Number.isSafeInteger(n) &&
            rawNumber.length <= MAX_ISSUE_NUMBER_DIGITS;
          if (isValidIssueNumber) {
            item.issue = n;
          } else {
            item.issueUnparseable = true;
            addWarning({
              itemIds: [item.id],
              message:
                `${sanitizeForLog(item.id)}: Issue番号が大きすぎて読み取れませんでした: ` +
                `"${sanitizeForLog(rawNumber)}"`,
            });
          }
          i += 1;
          continue;
        }
        const issueCandidateMatch = ISSUE_LINE_CANDIDATE_PATTERN.exec(sub);
        if (issueCandidateMatch !== null) {
          // Issue行のつもりだが数値として読めなかった（例: 「未起票」）。削除ではなく
          // 警告に倒し、「そもそもIssue行が無い」場合と区別する（Issue #408 根拠1）
          item.issueUnparseable = true;
          addWarning({
            itemIds: [item.id],
            message:
              `${sanitizeForLog(item.id)}: Issue行を番号として読み取れませんでした: ` +
              `"${sanitizeForLog((issueCandidateMatch[1] ?? '').trim())}"`,
          });
          i += 1;
          continue;
        }
        break;
      }
      ensurePhase().items.push(item);
      continue;
    }

    const checkboxLikeMatch = CHECKBOX_LIKE_PATTERN.exec(line);
    if (checkboxLikeMatch !== null) {
      addWarning({
        itemIds: [],
        message:
          `チェックボックスらしき行を認識できませんでした（行 ${i + 1}）: ` +
          `"${sanitizeForLog(line.trim())}"`,
      });
      i += 1;
      continue;
    }

    i += 1;
  }

  if (suppressedWarningCount > 0) {
    warnings.push({
      itemIds: [],
      message: `他${suppressedWarningCount}件の警告は上限のため省略しました`,
    });
  }

  return { title, phases, warnings };
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
  // パース時点の警告（読み飛ばした行・パース不能なIssue行）を引き継ぐ（Issue #408）
  const warnings: RoadmapIssueEntry[] = [...parsed.warnings];
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
        message: `id の形式が不正です（半角英数字・_・-のみ、1〜50文字にしてください）: "${sanitizeForLog(item.id)}"`,
      });
    }
  }
  for (const [id, count] of idCounts) {
    if (count > 1) {
      errors.push({ itemIds: [id], message: `id が重複しています: ${sanitizeForLog(id)}` });
    }
  }

  const idSet = new Set(items.map((it) => it.id));
  for (const item of items) {
    for (const dep of item.dependsOn) {
      if (!idSet.has(dep)) {
        errors.push({
          itemIds: [item.id],
          message: `依存が未定義の項目を参照しています: ${sanitizeForLog(dep)}`,
        });
      }
    }
  }

  for (const group of findCycleGroups(items)) {
    errors.push({
      itemIds: group,
      message: `依存が循環しています: ${group.map((id) => sanitizeForLog(id)).join(', ')}`,
    });
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
  /**
   * `RoadmapItem.issueUnparseable`と同じ（Issue #408）。省略時は`false`扱い
   * （テストで直接組み立てる既存の呼び出しを壊さないため、任意項目にしてある）。
   */
  issueUnparseable?: boolean;
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
    issueUnparseable: item.issueUnparseable,
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
 * ロードマップ項目の本文（`item.text`）に設ける長さ上限。前段のLLM生成セッションが
 * 出力したロードマップMarkdown由来の自由記述であり、上限が無いと下流のプロンプトを
 * 圧迫する（design.md §16.24、Issue #369）。
 */
const ROADMAP_ITEM_TEXT_MAX_LENGTH = 2000;

/**
 * 選んだ項目を、分解セッションへ渡すテキストの材料として整形する（design.md §16.19 2段目
 * 「項目をtasksに、依存をdependsOnに写す」「Issue番号を持つ項目は…issueフィールドとして
 * 持たせる」）。
 *
 * idと依存とIssue番号はそのまま転記するよう明示的に指示する。分解セッション（LLM）が
 * 依存関係やIssue番号を書き換えてしまうと、依存順序が壊れたまま実行されたり、誤った
 * Issueへ`Closes #<N>`が送られたりする。ここでの指示はあくまで補助で、一次防御ではない
 * （`planWorkflowFromRoadmapPhases`が生成後に`detectRoadmapMaterialMismatches`で機械的にも
 * 確認し、`issue`については`alignRoadmapIssues`が実際に直す）。**この指示だけでは防げない
 * ことは実測済み**で、Issue番号を持つ項目の隣にある無関係な項目へ同じ番号が並んだ。
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
    const issueText =
      item.issue !== undefined
        ? `#${item.issue}`
        : item.issueUnparseable === true
          ? '不明（元のロードマップのIssue行を読み取れませんでした）'
          : 'なし';
    // `item.text`は前段のLLM生成セッションが出力したロードマップMarkdown由来の自由記述
    // （外部由来テキスト）のため、`formatUntrusted`で囲う（design.md §16.24、Issue #369）
    const safeText = formatUntrusted(item.text, {
      id: item.id,
      field: 'text',
      maxLength: ROADMAP_ITEM_TEXT_MAX_LENGTH,
      preserveNewlines: true,
    });
    lines.push(`- id: ${item.id}`);
    lines.push(`  内容: ${safeText}`);
    lines.push(`  依存: ${depends}`);
    lines.push(`  Issue: ${issueText}`);
  }
  return lines.join('\n');
}

/** `buildRoadmapPlanGoal`が受け取るタイトル・フェーズ名の1要素あたりの表示上限。 */
const ROADMAP_TITLE_MAX_LENGTH = 200;
const PHASE_NAME_MAX_LENGTH = 100;

/**
 * `planWorkflowFromRoadmapPhases`が使う既定のゴール文。ロードマップのタイトルと
 * フェーズ名から組み立てる。複数フェーズをまとめてYAML化する場合は全ての名前を並べる。
 *
 * `roadmapTitle` / `phaseNames`はロードマップ生成セッション（LLM）が出力したMarkdownの
 * 見出しであり、外部由来テキストである。ここでは一覧の要素として`sanitizeInlineText`で
 * 1行に均すだけにする（`formatUntrusted`の囲いは付けない）。組み立てた返値はこのあと
 * `buildPlannerPrompt`の`goal`としてそのまま渡り、そちらで改めて`formatUntrusted`により
 * 囲われるため、ここで囲うと二重になる（design.md §16.24、Issue #369）。
 */
export function buildRoadmapPlanGoal(roadmapTitle: string, phaseNames: readonly string[]): string {
  const safeTitle = sanitizeInlineText(roadmapTitle, ROADMAP_TITLE_MAX_LENGTH);
  const names = phaseNames
    .map((name) => `「${sanitizeInlineText(name, PHASE_NAME_MAX_LENGTH)}」`)
    .join('');
  return `${safeTitle}のうち${names}を実行できるワークフローに分解する`;
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
        message: `ロードマップの項目 ${sanitizeForLog(item.id)} に対応するタスクが生成されていません`,
      });
      continue;
    }

    const expectedDeps = new Set(item.dependsOn);
    const actualDeps = new Set(task.dependsOn);
    const dependsOnMatches =
      expectedDeps.size === actualDeps.size && [...expectedDeps].every((d) => actualDeps.has(d));
    if (!dependsOnMatches) {
      const expectedText = [...expectedDeps].map((d) => sanitizeForLog(d)).join(', ') || 'なし';
      const actualText = [...actualDeps].map((d) => sanitizeForLog(d)).join(', ') || 'なし';
      mismatches.push({
        itemId: item.id,
        kind: 'dependsOnMismatch',
        message:
          `${sanitizeForLog(item.id)}: dependsOnがロードマップの依存と一致しません` +
          `（期待: ${expectedText}, 実際: ${actualText}）`,
      });
    }

    if (item.issue !== task.issue) {
      mismatches.push({
        itemId: item.id,
        kind: 'issueMismatch',
        message:
          `${sanitizeForLog(item.id)}: issueがロードマップと一致しません` +
          `（期待: ${item.issue ?? 'なし'}, 実際: ${task.issue ?? 'なし'}）`,
      });
    }
  }

  return mismatches;
}

/** `alignRoadmapIssues` が直した1件。 */
export interface CorrectedIssue {
  itemId: string;
  /** 生成されたYAMLに書かれていた値（無ければ `undefined`）。 */
  actual: number | undefined;
  /** ロードマップ側の値（無ければ `undefined`。この場合は`issue`を削る）。 */
  expected: number | undefined;
}

/**
 * 生成されたYAMLの `issue` を、ロードマップの値へ機械的に揃える（design.md §16.19）。
 *
 * 分解セッション（LLM）は、ロードマップにIssue番号が無い項目にも近くの番号を書き写して
 * しまう（実測では、Issue番号を持つ項目の隣にある無関係な項目へ同じ番号が並んだ）。
 * `issue` はPR/MR本文の `Closes #<N>` になる（§16.18）ため、**誤った番号のまま走ると
 * 無関係のIssueがマージで閉じられる**。転記の誤りとして警告するだけでは取り返しがつかない
 * ので、ロードマップ側の値へ直してから保存する。
 *
 * ロードマップが正であり、YAML側の値は材料の写しでしかない（§16.19 2段目）。
 * ロードマップに番号が無ければ `issue` の行ごと削る。
 *
 * 対象はロードマップの項目に対応するタスクだけ。材料に無いタスク（分解セッションが
 * 独自に足したもの）は触らない。そちらは `detectRoadmapMaterialMismatches` が
 * 転記の誤りとして人へ見せる範囲である。
 *
 * YAMLの整形とコメントを保つため、`yaml`パッケージのDocument APIで該当ノードだけを
 * 書き換える（`dropUndeclaredTemplateRefs`と同じ方針）。
 */
export function alignRoadmapIssues(
  yamlText: string,
  material: readonly RoadmapMaterialItem[],
): { yaml: string; corrected: CorrectedIssue[] } {
  const corrected: CorrectedIssue[] = [];
  // パース不能なIssue行を持つ項目（`issueUnparseable`）は、材料に含めない。
  // 「そもそもIssue行が無い」（issue: undefined）場合と区別せずに扱うと、
  // 読み取れなかっただけの項目についても生成YAML側の`issue`を誤って削ってしまう
  // （Issue #408 根拠1）。材料に無い扱いにすることで、以降の`!expectedById.has(rawId)`の
  // 分岐（何もしない）へ自然に合流させる
  const expectedById = new Map(
    material
      .filter((item) => item.issueUnparseable !== true)
      .map((item) => [item.id, item.issue] as const),
  );

  let doc;
  try {
    doc = parseDocument(yamlText);
  } catch {
    return { yaml: yamlText, corrected };
  }
  if (doc.errors.length > 0) {
    return { yaml: yamlText, corrected };
  }

  const tasksNode = doc.get('tasks', true);
  if (!isSeq(tasksNode)) {
    return { yaml: yamlText, corrected };
  }

  let changed = false;
  for (const item of tasksNode.items) {
    if (!isMap(item)) {
      continue;
    }
    const rawId = item.get('id');
    if (typeof rawId !== 'string' || !expectedById.has(rawId)) {
      continue;
    }
    const expected = expectedById.get(rawId);
    const rawIssue = item.get('issue');
    const actual = typeof rawIssue === 'number' ? rawIssue : undefined;
    if (actual === expected) {
      continue;
    }

    if (expected === undefined) {
      item.delete('issue');
    } else {
      item.set('issue', expected);
    }
    corrected.push({ itemId: rawId, actual, expected });
    changed = true;
  }

  return { yaml: changed ? String(doc) : yamlText, corrected };
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
      /** ロードマップの値へ直した `issue`（`alignRoadmapIssues`）。 */
      correctedIssues: readonly CorrectedIssue[];
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

  // `issue` だけは警告に留めず直す。誤った番号は `Closes #<N>` として無関係のIssueを
  // 閉じてしまうため（`alignRoadmapIssues`のコメント参照）。直した後のYAMLから定義を
  // 組み直し、YAMLと定義がずれないようにする
  const aligned = alignRoadmapIssues(result.yaml, items);
  let yaml = result.yaml;
  let definition = result.definition;
  if (aligned.corrected.length > 0) {
    try {
      definition = parseWorkflowYaml(aligned.yaml);
      yaml = aligned.yaml;
    } catch {
      // 直した結果がパースできないことは`issue`の書き換えだけである以上まず起きないが、
      // 起きたときは直す前のものをそのまま使い、転記の誤りとして人へ見せる
      input.log.warn('[roadmap] issueを直した後のYAMLを解釈できなかったため、元のまま使います');
    }
  }

  return {
    ...result,
    yaml,
    definition,
    roadmapMismatches: detectRoadmapMaterialMismatches(items, definition),
    droppedDependencies: input.chunk.droppedDependencies,
    correctedIssues: aligned.corrected,
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
  /**
   * パース時の警告、および重複idを検出して書き戻しを中止した場合の警告（Issue #408）。
   * 重複idを検出した場合、`markdown`は入力をそのまま返し（`updatedItemIds`は空）、
   * 呼び出し側はこの配列を見て人へ知らせる。
   */
  warnings: RoadmapIssueEntry[];
}

const CHECKBOX_PREFIX_PATTERN = /^(\s*-\s*)\[[ xX]\]/;

/**
 * 元のMarkdownで使われている改行コードを検出する（Issue #408 根拠3）。
 *
 * 最初に現れた改行の種別をファイル全体の慣習とみなす。改行コードが混在するファイルでも、
 * 書き戻し後は検出した1種類へ揃える（行ごとの改行種別までは保持しない。書き換えるのは
 * 特定の行のチェックボックス記号だけであり、そのために全行を分解・再結合する以上、
 * 「どの行が元々どちらだったか」を保持し続ける複雑さに見合う実害が無いための単純化）。
 */
function detectLineEnding(markdown: string): '\n' | '\r\n' {
  const index = markdown.indexOf('\n');
  if (index > 0 && markdown[index - 1] === '\r') {
    return '\r\n';
  }
  return '\n';
}

/**
 * runが終わったら、`done` になったタスクに対応する項目のチェックボックスの記号だけを書き換える。
 * 本文は変えない。対応が取れない項目（`taskStates` にあるがロードマップに無いid）は何もせず、
 * `unmatchedTaskIds` として返す（design.md §16.19）。
 *
 * チェックは一方向にしか動かさない（`done` 以外の状態で既にチェック済みの項目を戻すことはしない）。
 * 人が書いた文を機械が書き換えないという方針（design.md）に、チェックの意味も含めて従う。
 *
 * 書き戻し前に項目idの重複を検出する（Issue #408 根拠4）。`validateRoadmap`
 * （循環依存の検出等、重い検証を含む）は経由しない設計を保ったまま、軽量な重複チェックだけを
 * ここで行う。重複が見つかった場合は何も書き換えず、警告を返す（`itemsById`をMapで作ると
 * 同一idで後勝ちになり、誤った項目へチェックが書き込まれかねないため）。
 */
export function applyRunCompletion(
  markdown: string,
  taskStates: RunTaskStates,
): RunCompletionResult {
  const parsed = parseRoadmapMarkdown(markdown);
  const items = allItems(parsed);

  const idCounts = new Map<string, number>();
  for (const item of items) {
    idCounts.set(item.id, (idCounts.get(item.id) ?? 0) + 1);
  }
  const duplicateIds = [...idCounts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  if (duplicateIds.length > 0) {
    return {
      markdown,
      updatedItemIds: [],
      unmatchedTaskIds: [],
      warnings: [
        ...parsed.warnings,
        {
          itemIds: duplicateIds,
          // idは`CHECKBOX_ITEM_PATTERN`の`\S+`由来で任意の非空白文字を許すため、
          // 双方向制御文字等を含みうる。ログへ埋め込む前に無害化する（レビュー指摘: medium 3）
          message: `項目idが重複しているため書き戻しを中止しました: ${duplicateIds.map((id) => sanitizeForLog(id)).join(', ')}`,
        },
      ],
    };
  }

  const itemsById = new Map(items.map((it) => [it.id, it] as const));
  const lineEnding = detectLineEnding(markdown);
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

  return {
    markdown: lines.join(lineEnding),
    updatedItemIds,
    unmatchedTaskIds,
    warnings: parsed.warnings,
  };
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

/**
 * `buildRoadmapPrompt`が一覧として並べるworkspaceSummaryの1要素・既存Issueタイトルの
 * 表示上限（design.md §16.24、Issue #369）。`planner.ts`の`MAX_ENTRY_NAME_LENGTH`と
 * 揃え、`extension.ts`の`listWorkspaceSummary`・`planner.ts`の`buildWorkspaceSummary`
 * のどちらを経由しても同じ扱いになるようにする。
 */
const WORKSPACE_ENTRY_MAX_LENGTH = 100;
const ISSUE_TITLE_MAX_LENGTH = 200;

/**
 * `buildRoadmapPrompt`が展開するgoal文の長さ上限（design.md §16.24、Issue #369）。
 * `planner.ts`の`buildPlannerPrompt`が`input.goal`に設ける`MAX_GOAL_LENGTH`と同じ値・
 * 同じ理由（人が直接入力する値だが、由来を問わず一律に上限を設ける）。
 */
const ROADMAP_GOAL_MAX_LENGTH = 8000;

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
 *
 * `input.goal`は`untrustedText.ts`の`formatUntrusted`で囲う（design.md §16.24、
 * Issue #369）。以前は無加工・上限なしで連結していた（`planner.ts`の`buildPlannerPrompt`が
 * `input.goal`に対して行った対応と同じ）。
 */
export function buildRoadmapPrompt(input: RoadmapPromptInput): string {
  const lines: string[] = [];
  lines.push('次のゴールを達成するためのロードマップを、Markdownで1つ作成してください。');
  lines.push('');
  lines.push('## ゴール');
  lines.push('');
  lines.push(
    formatUntrusted(input.goal, {
      id: 'roadmap',
      field: 'goal',
      maxLength: ROADMAP_GOAL_MAX_LENGTH,
      preserveNewlines: true,
    }),
  );
  lines.push('');
  lines.push('## ワークスペースの構成（直下）');
  lines.push('');
  if (input.workspaceSummary.length === 0) {
    lines.push('（取得できませんでした）');
  } else {
    // ファイル名には改行を含められるため、`sanitizeInlineText`で1行に均す
    // （`planner.ts`の`buildWorkspaceSummary`経由の場合は既に通っているが、
    // このパス（`extension.ts`の`listWorkspaceSummary`経由）は通っていないため、
    // 呼び出し元を問わずsink側で防御する。design.md §16.24、Issue #369）
    for (const entry of input.workspaceSummary) {
      lines.push(`- ${sanitizeInlineText(entry, WORKSPACE_ENTRY_MAX_LENGTH)}`);
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
    // Issueタイトルは`gh issue list` / `glab issue list`の出力をJSON.parseしただけの
    // 値で、無害化を一切通っていない（design.md §16.24、Issue #369）
    for (const issue of input.existingIssues) {
      lines.push(`- #${issue.number} ${sanitizeInlineText(issue.title, ISSUE_TITLE_MAX_LENGTH)}`);
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
  lines.push('- フェーズ見出しは必ず `## ` で始めてください');
  lines.push('- 実行項目は必ず `- [ ] <一意なid> <内容>` の形式にしてください');
  lines.push('- 各フェーズに実行項目を1件以上含めてください');
  lines.push(
    '- `依存` は同じロードマップ内の項目idで書いてください（無ければ `なし`）。書かれていない項目同士は並列に走らせられます',
  );
  lines.push(
    '- 既存のIssueと重複する項目は作らず、対応するIssueがあれば `Issue: #<番号>` を添えてください',
  );
  return lines.join('\n');
}

/** 任意の計画Markdownをワークフロー用ロードマップへ変換するための入力。 */
export interface RoadmapConversionPromptInput {
  /** 選択したファイルのワークスペース相対パス（表示用）。 */
  sourcePath: string;
  /** 選択したMarkdownの本文。外部由来のデータとして扱う。 */
  sourceMarkdown: string;
}

/**
 * 任意Markdownの変換セッションへ渡す本文の上限。
 *
 * 計画書はロードマップより長くなりやすいため、ゴール文の上限より大きく取る。一方で、
 * プロンプト全体を不必要に圧迫しないよう無制限にはしない。
 */
const ROADMAP_CONVERSION_SOURCE_MAX_LENGTH = 100_000;

/**
 * 任意のMarkdownを、ロードマップの機械可読な形式へ変換させるプロンプトを組み立てる。
 *
 * 入力文書はエージェントへの命令ではなく材料なので、`formatUntrusted`で明示的に区切る。
 * これにより、文書中の指示が生成セッションの上位指示を上書きする経路を作らない。
 */
export function buildRoadmapConversionPrompt(input: RoadmapConversionPromptInput): string {
  return [
    '次の計画Markdownを、ワークフロー実行用のロードマップへ変換してください。',
    '入力文書の意図、実施順、依存関係を保ち、実行できる粒度の項目へ分解してください。',
    '',
    '## 入力ファイル',
    '',
    sanitizeInlineText(input.sourcePath, WORKSPACE_ENTRY_MAX_LENGTH),
    '',
    '## 入力Markdown',
    '',
    formatUntrusted(input.sourceMarkdown, {
      id: 'roadmap-conversion',
      field: 'sourceMarkdown',
      maxLength: ROADMAP_CONVERSION_SOURCE_MAX_LENGTH,
      preserveNewlines: true,
    }),
    '',
    '## 出力形式',
    '',
    '次の形式のMarkdownのみを返してください。説明文やコードフェンスの前後の文章は含めないでください。',
    '',
    '```markdown',
    ROADMAP_FORMAT_EXAMPLE,
    '```',
    '',
    '- フェーズ見出しは必ず `## ` で始めること',
    '- 実行項目は必ず `- [ ] <一意なid> <内容>` の形式にすること',
    '- 項目のidは半角英数字・`_`・`-`だけを使い、ロードマップ内で一意にすること',
    '- `依存` は同じロードマップ内の項目idで書くこと（無ければ `なし`）',
    '- 入力にIssue番号が明記されている項目だけ、対応する `Issue: #<番号>` を添えること',
  ].join('\n');
}

/**
 * 初回の生成結果にパース可能な項目が1件も無い場合だけ使う、形式修復用の再試行プロンプト。
 * 元の返答は命令ではなく変換対象のデータとして扱う。
 */
export function buildRoadmapRepairPrompt(response: string): string {
  return [
    '前の返答にはワークフロー用ロードマップとして認識できる実行項目がありませんでした。',
    '次の内容を、必ず指定形式のMarkdownだけへ変換してください。説明文、コードフェンス、作業報告は返さないでください。',
    '',
    '## 必須形式',
    '',
    '```markdown',
    ROADMAP_FORMAT_EXAMPLE,
    '```',
    '',
    '- フェーズ見出しは `## ` で始める',
    '- 実行項目は必ず `- [ ] R1 内容` の形式にする',
    '- 項目は1件以上にする',
    '',
    '## 変換対象',
    '',
    formatUntrusted(response, {
      id: 'roadmap-repair',
      field: 'response',
      maxLength: ROADMAP_CONVERSION_SOURCE_MAX_LENGTH,
      preserveNewlines: true,
    }),
  ].join('\n');
}

async function repairRoadmapIfEmpty(
  generation: RoadmapGenerationPort,
  generated: RoadmapGenerationResult,
): Promise<RoadmapGenerationResult> {
  if (!generated.ok) return generated;
  if (allItems(parseRoadmapMarkdown(stripMarkdownCodeFence(generated.text))).length > 0) {
    return generated;
  }
  generated.dispose?.();
  return generation.generate({ prompt: buildRoadmapRepairPrompt(generated.text) });
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

// ゴールの文からファイル名（拡張子なし）を作る `slugifyGoal` は、以前はここに独自実装を
// 持っていたが、`planner.ts` の `slugifyGoal` と重複していた（`stripControlChars` を
// 通す・通さない、上限が60/40、予約語のときの既定値が`roadmap`/`workflow`等の細かい差異は
// あったが、目的も入出力の形も同じ）。循環importにはならない（`roadmap.ts` は既に
// `planner.ts` から複数の関数をimportしており、逆方向のimportは無い）ため、`planner.ts`
// 側（上のimport文で取り込み済み）へ一本化し、こちらの独自実装は削除した（Issue #408）。
//
// 一本化の副作用として、`generateRoadmap`（下）が作る既定のファイル名の上限は60文字から
// 40文字（`planner.ts` の `SLUG_MAX_LENGTH`）へ短くなる。利用者は保存前に名前を確認・編集
// できる（`extension.ts` の入力欄）ため、既定値が短くなること自体は実害が無い判断とした。

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

export type RoadmapGenerationResult =
  | { ok: true; text: string; dispose?: () => void; reportFailure?: (message: string) => void }
  | { ok: false; message: string };

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

/** ロードマップの未紐付け項目へIssueを起票するポート。 */
export interface RoadmapIssueCreationPort {
  createIssues(
    workspaceRoot: string,
    items: readonly RoadmapItem[],
  ): Promise<{ ok: true; issues: ReadonlyMap<string, number> } | { ok: false; message: string }>;
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
 * 生成は1ターンで終わらせる。形式外の応答を利用者が会話画面で確認できるよう、
 * ロードマップ生成セッションは自動で閉じない。
 */
export function createTaskSessionRoadmapGenerationPort(
  host: TaskSessionHost,
  provider: Provider,
  cwd: string,
): RoadmapGenerationPort {
  return {
    async generate(request: RoadmapGenerationRequest): Promise<RoadmapGenerationResult> {
      const input = buildPlannerSessionInput(provider, cwd);
      let dispose: (() => void) | undefined;
      let reportFailure: ((message: string) => void) | undefined;
      try {
        const text = await sendSingleTurn(
          host,
          provider,
          input,
          request.prompt,
          undefined,
          undefined,
          false,
          (session) => {
            dispose = () => session.dispose();
            reportFailure = (message) => {
              session.send(`ロードマップ生成は失敗しました。理由: ${message}`);
            };
          },
        );
        return { ok: true, text, dispose, reportFailure };
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
  /** 指定時は、既存Issueを持たない項目を保存前にIssue化する。 */
  issueCreation?: RoadmapIssueCreationPort;
}

export interface GenerateRoadmapInput {
  goal: string;
  workspaceRoot: string;
  roadmapDir: string;
  workspaceSummary: readonly string[];
  hasAgentsFile: boolean;
  hasClaudeFile: boolean;
  /**
   * 保存先のファイル名（拡張子なし）。省略すると `slugifyGoal(goal)` から作る。
   *
   * 呼び出し側（`extension.ts`）は既定値を入力欄へ出して利用者に確認・編集させ、その結果を
   * ここへ渡す。ゴール文をそのままファイル名にすると読みにくい名前になりやすいため
   * （`slugifyGoal` のコメント参照）。
   */
  slug?: string;
}

export type GenerateRoadmapResult =
  | {
      ok: true;
      path: string;
      markdown: string;
      parsed: ParsedRoadmap;
      validation: RoadmapValidationResult;
    }
  | {
      ok: false;
      reason: 'pathOutsideWorkspace' | 'generationFailed' | 'invalidRoadmap';
      message: string;
      /** 形式外の生成結果を保存せず人へ見せるための生の応答。 */
      rawResponse?: string;
    };

/**
 * ゴールの文からロードマップを生成し、設定した置き場へ保存する（design.md §16.19の1段目）。
 * 純粋関数ではないが、I/Oは全てポート越しにしているためVSCode APIには依存しない。
 */
export async function generateRoadmap(
  deps: GenerateRoadmapDeps,
  input: GenerateRoadmapInput,
): Promise<GenerateRoadmapResult> {
  // 利用者が名前を確認・編集した場合はそれを使い、無ければゴール文から機械的に作る
  const slug = input.slug ?? slugifyGoal(input.goal);
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

  const generated = await repairRoadmapIfEmpty(
    deps.generation,
    await deps.generation.generate({ prompt }),
  );
  if (!generated.ok) {
    return { ok: false, reason: 'generationFailed', message: generated.message };
  }

  let markdown = stripMarkdownCodeFence(generated.text);
  let parsed = parseRoadmapMarkdown(markdown);
  let validation = validateRoadmap(parsed);
  if (validation.errors.length > 0) {
    const message = validation.errors.map((error) => error.message).join(' / ');
    generated.reportFailure?.(message);
    return {
      ok: false,
      reason: 'invalidRoadmap',
      message,
      rawResponse: generated.text,
    };
  }

  if (deps.issueCreation !== undefined) {
    const missingIssueItems = allItems(parsed).filter((item) => item.issue === undefined);
    if (missingIssueItems.length > 0) {
      const created = await deps.issueCreation.createIssues(input.workspaceRoot, missingIssueItems);
      if (!created.ok) {
        const message = `ロードマップ項目のIssue起票に失敗しました: ${created.message}`;
        generated.reportFailure?.(message);
        return {
          ok: false,
          reason: 'generationFailed',
          message,
          rawResponse: generated.text,
        };
      }
      markdown = applyRoadmapIssueNumbers(markdown, created.issues);
      parsed = parseRoadmapMarkdown(markdown);
      validation = validateRoadmap(parsed);
      if (validation.errors.length > 0) {
        const message = validation.errors.map((error) => error.message).join(' / ');
        generated.reportFailure?.(message);
        return {
          ok: false,
          reason: 'invalidRoadmap',
          message,
          rawResponse: generated.text,
        };
      }
    }
  }
  await deps.fs.writeTextFile(pathResult.path, markdown);
  generated.dispose?.();

  return { ok: true, path: pathResult.path, markdown, parsed, validation };
}

/**
 * 指定した項目へIssue番号を書き戻す。既存の`Issue:`行は置換し、無ければ依存行の後へ追加する。
 * 生成直後のMarkdownだけを対象にし、元のタイトル・タスク本文・チェック状態は変更しない。
 */
export function applyRoadmapIssueNumbers(
  markdown: string,
  issues: ReadonlyMap<string, number>,
): string {
  if (issues.size === 0) return markdown;

  const parsed = parseRoadmapMarkdown(markdown);
  const lineEnding = detectLineEnding(markdown);
  const lines = markdown.split(/\r?\n/u);
  const items = allItems(parsed)
    .filter((item) => issues.has(item.id))
    .sort((a, b) => b.line - a.line);

  for (const item of items) {
    const issue = issues.get(item.id);
    if (issue === undefined || !Number.isSafeInteger(issue) || issue <= 0) continue;

    let insertAt = item.line + 1;
    let replaced = false;
    for (let index = item.line + 1; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      if (CHECKBOX_ITEM_PATTERN.test(line) || PHASE_HEADING_PATTERN.test(line)) break;
      if (ISSUE_LINE_CANDIDATE_PATTERN.test(line)) {
        lines[index] = `  - Issue: #${String(issue)}`;
        replaced = true;
        break;
      }
      if (DEPENDS_LINE_PATTERN.test(line)) insertAt = index + 1;
    }
    if (!replaced) lines.splice(insertAt, 0, `  - Issue: #${String(issue)}`);
  }
  return lines.join(lineEnding);
}

/** 任意Markdownからロードマップへ変換するための入力。 */
export interface ConvertMarkdownToRoadmapInput extends RoadmapConversionPromptInput {
  workspaceRoot: string;
  roadmapDir: string;
  /** 保存先のファイル名（拡張子なし）。省略時は入力ファイル名から作る。 */
  slug?: string;
}

/** 任意のMarkdownをワークフロー用ロードマップへ変換して保存する。 */
export async function convertMarkdownToRoadmap(
  deps: Pick<GenerateRoadmapDeps, 'generation' | 'fs'>,
  input: ConvertMarkdownToRoadmapInput,
): Promise<GenerateRoadmapResult> {
  const slug =
    input.slug ?? slugifyGoal(path.basename(input.sourcePath, path.extname(input.sourcePath)));
  const pathResult = resolveRoadmapOutputPath(input.workspaceRoot, input.roadmapDir, slug);
  if (!pathResult.ok) {
    return { ok: false, reason: 'pathOutsideWorkspace', message: pathResult.message };
  }

  const generated = await repairRoadmapIfEmpty(
    deps.generation,
    await deps.generation.generate({ prompt: buildRoadmapConversionPrompt(input) }),
  );
  if (!generated.ok) {
    return { ok: false, reason: 'generationFailed', message: generated.message };
  }

  const markdown = stripMarkdownCodeFence(generated.text);
  const parsed = parseRoadmapMarkdown(markdown);
  const validation = validateRoadmap(parsed);
  if (validation.errors.length > 0) {
    const message = validation.errors.map((error) => error.message).join(' / ');
    generated.reportFailure?.(message);
    return {
      ok: false,
      reason: 'invalidRoadmap',
      message,
      rawResponse: generated.text,
    };
  }
  await deps.fs.writeTextFile(pathResult.path, markdown);
  generated.dispose?.();
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
  | {
      ok: true;
      updatedItemIds: string[];
      unmatchedTaskIds: string[];
      /** `applyRunCompletion`の`warnings`をそのまま引き継ぐ（Issue #408）。 */
      warnings: RoadmapIssueEntry[];
    }
  | { ok: false; reason: 'readFailed'; message: string };

/**
 * 書き戻し先のロードマップファイルごとの排他キュー（Issue #620）。
 *
 * `applyRunCompletionToFile` は read → 更新 → write という非アトミックな並びで、
 * その間に別のrunの write が差し込まれると、後から書いた側が先に入ったチェックを
 * 消す（lost update）。`src/orchestrator/runner.ts` の `pump()` は run の終了時に
 * `void this.applyRoadmapCompletion(runId)` と fire-and-forget で呼ぶだけなので、
 * 呼び出し側でも直列化されていない。同じロードマップを指す複数のrunが `maxParallel`
 * （既定3）の枠で同時に走り同時に終わる構成は、W12以降は標準の使い方である
 * （design.md §16.19・§16.37.2）。
 *
 * **キーはファイル単位。** ロードマップが違えば書き戻し先も違うので、待たせる理由が無い。
 * 呼び出し側（`runner.ts`）は `path.resolve` 済みのパスを渡すが、ここでも `path.resolve`
 * を通してからキーにする（同じファイルを別の綴りで渡されても同じキューに入るようにする）。
 * `fs` へ渡すパスは加工しない（呼び出し側が意図した文字列のまま渡す）。
 *
 * **`workspaceState` 側と同じ道具立てを使う。** `WorkflowRunStore` / `ProgramStore` /
 * `ProgramRunner` は同じ `SerialQueue` で read-modify-write を守っている
 * （Issue #146・#625）。ファイルへの書き戻しだけがその扱いを受けていなかった。
 *
 * **プロセス内の排他しか与えない。** 別プロセス（別のVSCodeウィンドウ、人の手による編集）
 * からの同時書き込みは防げない。ロックファイルを置く形なら防げるが、クラッシュ時の
 * 残留ロックの後始末という別の問題を抱える。今回の対象は「拡張機能プロセス内で同時に
 * 終わったrun同士」であり、そこはこれで閉じる。
 */
const roadmapWriteQueues = new Map<string, { queue: SerialQueue; pending: number }>();

/**
 * `roadmapPath` に対応する排他キューへ `task` を積み、完了を待つ。
 *
 * 待っている呼び出しが無くなった時点で `roadmapWriteQueues` から自分のエントリを
 * 取り除く。ロードマップのパスは有限とはいえ、モジュールレベルのMapは拡張機能の
 * プロセス寿命の間ずっと残るため、使い終わったものを残す理由が無い
 * （`ProgramRunner.runExclusive` が `programQueues` に対して行っている掃除と同じ考え）。
 */
async function runExclusiveOnRoadmapFile<T>(
  roadmapPath: string,
  task: () => Promise<T>,
): Promise<T> {
  const key = path.resolve(roadmapPath);
  let entry = roadmapWriteQueues.get(key);
  if (entry === undefined) {
    entry = { queue: new SerialQueue(), pending: 0 };
    roadmapWriteQueues.set(key, entry);
  }
  entry.pending += 1;
  try {
    return await entry.queue.enqueue(task);
  } finally {
    entry.pending -= 1;
    if (entry.pending === 0) {
      roadmapWriteQueues.delete(key);
    }
  }
}

/**
 * ロードマップファイルを読み込み、runの結果で `done` になった項目のチェックだけを更新して
 * 書き戻す（design.md §16.19「ロードマップの更新」）。更新が1件も無ければファイルには触れない。
 *
 * 同じファイルに対する呼び出しは `runExclusiveOnRoadmapFile` で直列化する（Issue #620）。
 * 直列化しないと、同時に終わった2つのrunの書き戻しが重なり、後から書いた側が先に入った
 * チェックを消す。
 */
export async function applyRunCompletionToFile(
  deps: ApplyRunCompletionDeps,
  roadmapPath: string,
  taskStates: RunTaskStates,
): Promise<ApplyRunCompletionOutcome> {
  return runExclusiveOnRoadmapFile(roadmapPath, async () =>
    applyRunCompletionToFileLocked(deps, roadmapPath, taskStates),
  );
}

/**
 * `applyRunCompletionToFile` の本体。呼び出し元で同じファイルに対する排他が取れている
 * 前提で、read → 更新 → write を行う。
 */
async function applyRunCompletionToFileLocked(
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
    warnings: result.warnings,
  };
}
