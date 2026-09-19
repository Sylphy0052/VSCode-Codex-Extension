/* eslint-disable no-console -- 組み立てた案件の内訳を出すのがこのファイルの目的 */
/**
 * 本測定の案件ファイルを、凍結済みの判定と人の入力から組み立てる（Issue #1304 / #1046 手順4）。
 *
 * ```
 * npx tsx test/bench/secondOpinionEval/caseFile.ts \
 *   --selected eval-results/selected-cases-v1.json \
 *   --frame eval-results/sampling-frame-v3.json \
 *   --screening eval-results/screening-decisions-v2.jsonl \
 *   --known-findings eval-results/known-findings-v1.jsonl \
 *   --eligibility eval-results/eligibility-v1.json \
 *   --condition A \
 *   --repo-path /absolute/path/to/repo \
 *   --out eval-results/cases-v1.json
 * ```
 *
 * **人の入力は `known-findings-*.jsonl` にしか無い。** 案件ファイル本体は実案件の絶対パスを
 * 含むため追跡外だが、`recallCriteria` は採点の判定条件そのもので、実験の前に凍結しないと
 * recall が採点者の解釈で動く（pilot #1027 で同じ6回答の recall が 1.000 と 0.000 の両方に
 * なった）。追跡外のファイルにだけ置くと作業環境ごと失われたときに再現できないので、人の
 * 入力だけを追跡対象の別ファイルへ分け、ここではそれを凍結済みの判定と束ねるだけにする。
 *
 * **`finding` / `groundTruthBasis` / `evidence` は screening 側から引く。** 人の入力側へ写すと
 * 二重に持つことになり、食い違ったときにどちらが正本か言えなくなる。
 *
 * **依頼文・背景・制約は案件ごとに書き分けない。** 理由はそれぞれ {@link UNIFORM_USER_REQUEST}
 * {@link UNIFORM_CONVERSATION} {@link UNIFORM_KNOWN_CONSTRAINTS} に書いてある。
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import process from 'node:process';

import { MAX_RECALL_CRITERIA, parseCases } from './caseSchema';
import { writeFrozen } from './frozenFile';
import {
  DIFFICULTY_STRATA,
  POSITIVE_STRATA,
  verifyPositivesEligible,
  type ChangeSizeStratum,
  type DifficultyStratum,
  type EligibilityEntry,
  type SelectionCandidate,
} from './stratifiedSample';

import type { EvalCase, KnownFinding } from './types';

/**
 * 案件ファイルの組み立て規則の版。
 *
 * 依頼文・背景・制約の決め方を変えたら上げ、前の版のファイルは残す。入力（selected / frame /
 * screening / known-findings）の版はそれぞれのファイルが持つので、ここで数えるのは規則だけ。
 */
const CASE_FILE_VERSION = 1;

/**
 * 全案件に付ける `kind`。母集団の組み立て（`selectionPool.ts`）と同じ値でなければ止める。
 */
const UNIFORM_KIND = 'codeReview';

/**
 * 全案件で同じ依頼文。
 *
 * 母集団はすべてPRの差分で、`kind` も全件 `codeReview` に揃えてある。案件ごとに依頼文を
 * 書き分けると、測っているのが条件の差なのか依頼文の差なのか分からなくなる。`B-pos` /
 * `B-repeat` は依頼文の**位置**だけを動かす条件なので、依頼文そのものは全案件・全条件で
 * 同一である必要がある。
 *
 * **「挙げてください」ではなく「あれば挙げてください」にしてある。** 問題があることを前提に
 * した依頼文にすると、`no-problem` 層で存在しない問題を作って答える方向へ押すことになり、
 * `hallucinatedFindings` が依頼文の影響を含んでしまう。
 */
const UNIFORM_USER_REQUEST =
  'この変更をレビューしてください。設計上の欠陥、見落とし、より単純な代替案があれば挙げてください。' +
  '材料だけでは判断しきれないことは、決めつけずにその旨を書いてください。';

/**
 * 全案件で空にする背景。
 *
 * 対象は2026-08にマージされたPRで、当時の会話記録は残っていない。PR本文を貼る案は採らない。
 * 本文には解決した問題や設計判断が書かれていることがあり、`eligibility-v1.json` の
 * `explicitlyExposed`（「現時点の材料だけで判定した」と明記して凍結してある）を全件やり直す
 * ことになる。空なら答えの漏れは構造的に起きない。
 *
 * 空にすると条件Aは「本番のベースライン」ではなく「背景を固定したベースライン」になる。
 * これは `docs/second-opinion-eval.md` の「測っていないもの」に既に書いてある限界である。
 */
const UNIFORM_CONVERSATION = '';

/**
 * 背景の種別。空文字のときプロンプトには背景の区画自体が出ないが、`run.ts` は値を要求する。
 */
const UNIFORM_CONVERSATION_KIND = 'summary' as const;

/**
 * 全案件で空にする制約。
 *
 * `knownConstraints` は「材料の中で確かめられる事実」を書く欄だが、後から書けばそれ自体が
 * 何が重要かのヒントになる。24件分を書く根拠も無い。
 */
const UNIFORM_KNOWN_CONSTRAINTS: readonly string[] = [];

/**
 * `recallCriteria` の下限。
 *
 * 1本にすると、広く書けば何でも拾ったことになり、狭く書けば言い換えを落とす。上限
 * （{@link MAX_RECALL_CRITERIA}）は実行側と同じ値を使う。ここで別に持つと、片方だけ変えた
 * ときに組み立ては通って実行で落ちる。
 */
const MIN_RECALL_CRITERIA = 2;

/** `selected-cases-*.json` / `explore-only-*.json` の1件。 */
interface SelectedEntry {
  caseId: string;
  prNumber: number;
  stratum: DifficultyStratum;
  kind: string;
  changeSizeStratum: ChangeSizeStratum;
  tags: string[];
}

/**
 * 抽出結果のファイル。
 *
 * `selected-cases-*.json` は `selected` と `conditionId` を、`explore-only-*.json` は `cases` と
 * `excludedFromConditionId` を持つ。どちらからも案件ファイルを作れるようにしてあるのは、
 * context-coverage 用の4件のラベルが本測定の24件と共通で、別のCLIを作ると同じ finding の
 * 判定条件が2か所に生まれるためである。
 */
interface SelectedFile {
  selected?: SelectedEntry[];
  cases?: SelectedEntry[];
  conditionId?: string;
  frameFile?: string;
  frameSha256?: string;
  eligibilityFile?: string;
  eligibilitySha256?: string;
}

/** 凍結済みの sampling frame から、案件ファイルに要る分だけ。 */
interface FrameEntry {
  prNumber: number;
  baseSha?: string;
  targetSha?: string;
  snapshotStatus?: string;
  excludedBy?: string;
}

interface ScreeningFinding {
  finding: string;
  groundTruthBasis: KnownFinding['groundTruthBasis'];
  evidence: string;
  evidenceRefs?: string[];
  primary?: boolean;
}

interface ScreeningDecision {
  type: string;
  prNumber: number;
  findings?: ScreeningFinding[];
}

/** `known-findings-*.jsonl` の先頭行。入力にした screening 判定の時点を持つ。 */
interface KnownFindingsHeader {
  type: 'header';
  decisionsFile: string;
  decisionsSha256: string;
}

/** `known-findings-*.jsonl` の1行。人が書くのはここだけ。 */
interface KnownFindingRow {
  type: 'finding';
  caseId: string;
  prNumber: number;
  findingIndex: number;
  screeningFindingIndex: number;
  recallCriteria: string[];
  severity: KnownFinding['severity'];
  provenance: KnownFinding['provenance'];
  evidencePaths: string[];
}

interface EligibilityRow extends EligibilityEntry {
  findingIndex: number;
}

interface EligibilityFile {
  decisionsFile: string;
  decisionsSha256: string;
  entries: EligibilityRow[];
}

interface Args {
  selectedPath: string;
  framePath: string;
  screeningPath: string;
  knownFindingsPath: string;
  eligibilityPath: string;
  conditionId: string;
  repoPath: string;
  outPath: string;
}

function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token !== undefined && token.startsWith('--')) {
      values.set(token.slice(2), argv[i + 1] ?? '');
      i += 1;
    }
  }
  const required = (name: string, what: string): string => {
    const value = values.get(name);
    if (value === undefined || value === '') {
      throw new Error(`--${name}（${what}）は必須です`);
    }
    return value;
  };
  return {
    selectedPath: required('selected', '抽出済みの案件一覧'),
    framePath: required('frame', '凍結済みの sampling frame'),
    screeningPath: required('screening', 'screening の判定'),
    knownFindingsPath: required('known-findings', '人が書いた正解ラベル'),
    eligibilityPath: required('eligibility', '条件ごとの eligibility 判定'),
    conditionId: required('condition', '分母に使う条件'),
    repoPath: required('repo-path', '材料を取るリポジトリの絶対パス'),
    outPath: required('out', '案件ファイルの書き出し先'),
  };
}

async function readWithSha(filePath: string): Promise<{ raw: string; sha256: string }> {
  const raw = await fs.readFile(filePath, 'utf8');
  return { raw, sha256: createHash('sha256').update(raw).digest('hex') };
}

function parseJsonLines(raw: string): unknown[] {
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as unknown);
}

/**
 * 入力の素性が食い違っていないかを確かめる（検査1）。
 *
 * 時点のずれた screening 判定からラベルを引くと、`screeningFindingIndex` が別の finding を
 * 指したまま黙って通る。ハッシュが合わないときは、どちらが正しいかをここで決めずに止める。
 */
function verifyLineage(params: {
  selected: SelectedFile;
  frameSha256: string;
  screeningSha256: string;
  eligibilitySha256: string;
  eligibility: EligibilityFile;
  header: KnownFindingsHeader;
  conditionId: string;
}): void {
  const problems: string[] = [];
  /**
   * 記録が無いファイルもあるので、あるときだけ照合する。
   *
   * `explore-only-*.json` は frame も eligibility も記録していない（母集団から外した案件の
   * 一覧で、抽出はしていないため）。
   */
  const compareIfRecorded = (what: string, recorded: string | undefined, actual: string): void => {
    if (recorded !== undefined && recorded !== actual) {
      problems.push(`${what}（記録: ${recorded} / 実測: ${actual}）`);
    }
  };
  /** 記録が無いこと自体を欠陥として扱う。無ければ照合が黙って飛ぶ。 */
  const compareRequired = (what: string, recorded: string | undefined, actual: string): void => {
    if (recorded === undefined || recorded === '') {
      problems.push(`${what}が記録されていません`);
      return;
    }
    compareIfRecorded(what, recorded, actual);
  };
  compareIfRecorded(
    '抽出結果が記録している frame',
    params.selected.frameSha256,
    params.frameSha256,
  );
  compareIfRecorded(
    '抽出結果が記録している eligibility',
    params.selected.eligibilitySha256,
    params.eligibilitySha256,
  );
  compareRequired(
    'eligibility が記録している screening 判定',
    params.eligibility.decisionsSha256,
    params.screeningSha256,
  );
  compareRequired(
    '正解ラベルが記録している screening 判定',
    params.header.decisionsSha256,
    params.screeningSha256,
  );
  if (
    params.selected.conditionId !== undefined &&
    params.selected.conditionId !== params.conditionId
  ) {
    problems.push(
      `抽出に使った条件と --condition が違います（抽出: ${params.selected.conditionId} / 指定: ${params.conditionId}）`,
    );
  }
  if (problems.length > 0) {
    throw new Error(
      `入力の素性が合っていません: ${problems.join(' / ')}。` +
        '同じ時点のファイルを指すか、入力を作り直してください',
    );
  }
}

/**
 * 材料を取る地点が揃っているかを確かめる（検査2）。
 *
 * `baseCommit` / `targetCommit` のどちらが欠けても、後日流し直したときに別の材料になる。
 * `snapshotStatus` が `unavailable` の案件は、そもそも地点を復元できない。
 */
function frameEntryOf(entry: SelectedEntry, frame: ReadonlyMap<number, FrameEntry>): FrameEntry {
  const found = frame.get(entry.prNumber);
  if (found === undefined) {
    throw new Error(`${entry.caseId} が sampling frame にありません`);
  }
  if (found.excludedBy !== undefined) {
    throw new Error(`${entry.caseId} は frame で ${found.excludedBy} として除外されています`);
  }
  if (
    found.baseSha === undefined ||
    found.baseSha === '' ||
    found.targetSha === undefined ||
    found.targetSha === ''
  ) {
    throw new Error(`${entry.caseId} の baseSha / targetSha が frame にありません`);
  }
  if (found.snapshotStatus === 'unavailable') {
    throw new Error(
      `${entry.caseId} は snapshotStatus が unavailable で、材料を取る地点を復元できません`,
    );
  }
  return found;
}

/** screening の `primary: true` な finding だけを、screening と同じ順で返す。 */
function primaryFindingsOf(
  decision: ScreeningDecision,
): { finding: ScreeningFinding; screeningIndex: number }[] {
  return (decision.findings ?? [])
    .map((finding, screeningIndex) => ({ finding, screeningIndex }))
    .filter((entry) => entry.finding.primary === true);
}

/**
 * 正解ラベルを組み立てる（検査3・4・5）。
 *
 * screening の primary な finding と人の入力を1対1で突き合わせる。件数が合わないときは
 * 多くても少なくても止める。少なければ書き漏らした finding が黙って分母から落ち、多ければ
 * screening にない finding を分母へ足すことになる。
 */
function knownFindingsOf(
  entry: SelectedEntry,
  decision: ScreeningDecision,
  rows: readonly KnownFindingRow[],
): KnownFinding[] {
  const primaries = primaryFindingsOf(decision);
  if (rows.length !== primaries.length) {
    throw new Error(
      `${entry.caseId} の正解ラベルが screening の primary な finding と件数が違います` +
        `（ラベル: ${rows.length} / screening: ${primaries.length}）`,
    );
  }
  const sorted = [...rows].sort((a, b) => a.findingIndex - b.findingIndex);
  return sorted.map((row, index) => {
    if (row.findingIndex !== index) {
      throw new Error(
        `${entry.caseId} の findingIndex が primary の並びの添字と違います（${row.findingIndex} / 期待 ${index}）`,
      );
    }
    const primary = primaries[index];
    if (primary === undefined || row.screeningFindingIndex !== primary.screeningIndex) {
      throw new Error(
        `${entry.caseId} の screeningFindingIndex が screening の並びと合いません` +
          `（${row.screeningFindingIndex} / 期待 ${primary?.screeningIndex}）`,
      );
    }
    if (
      row.recallCriteria.length < MIN_RECALL_CRITERIA ||
      row.recallCriteria.length > MAX_RECALL_CRITERIA
    ) {
      throw new Error(
        `${entry.caseId}[${index}] の recallCriteria が ${MIN_RECALL_CRITERIA}〜${MAX_RECALL_CRITERIA} 件の範囲にありません（${row.recallCriteria.length} 件）`,
      );
    }
    return {
      finding: primary.finding.finding,
      recallCriteria: row.recallCriteria,
      evidence: primary.finding.evidence,
      severity: row.severity,
      provenance: row.provenance,
      groundTruthBasis: primary.finding.groundTruthBasis,
      evidencePaths: row.evidencePaths,
    };
  });
}

/**
 * ラベルが空であるはずの層に、ラベルが紛れ込んでいないかを確かめる（検査6）。
 *
 * `no-problem` と `indeterminate` は層の定義上 `knownImportantFindings` が常に空で、
 * `hallucinatedFindings` と `indeterminateFindings` の分母になる。1件でも入れば分母が壊れる。
 */
function verifyLabelFreeStrata(
  entries: readonly SelectedEntry[],
  rowsByCase: ReadonlyMap<string, KnownFindingRow[]>,
): void {
  const offenders = entries
    .filter((entry) => !POSITIVE_STRATA.has(entry.stratum))
    .filter((entry) => (rowsByCase.get(entry.caseId)?.length ?? 0) > 0)
    .map((entry) => `${entry.caseId}（${entry.stratum}）`);
  if (offenders.length > 0) {
    throw new Error(
      `ラベルを持たない層に正解ラベルがあります: ${offenders.join(' / ')}。` +
        'この層は hallucinatedFindings と indeterminateFindings の分母なので、空のままにしてください',
    );
  }
}

/**
 * finding ごとに、その条件の判定があるかを確かめる（検査7）。
 *
 * **通っていることまでは要求しない。** ラベルは条件に依存しないので、ある条件で
 * `discoverable` でない finding も案件ファイルには載せ、分母から外すのは集計側
 * （`recall.ts`）の仕事である。ここで落とすと、条件ごとに別のラベルを持つことになる。
 *
 * 一方で**判定が無いものは止める**。判定漏れをそのまま流すと、recall が「判定していない
 * だけ」の分だけ動く。
 */
function verifyFindingsJudged(
  entries: readonly SelectedEntry[],
  findingsByCase: ReadonlyMap<string, KnownFinding[]>,
  eligibility: readonly EligibilityRow[],
  conditionId: string,
): { judged: number; passing: number } {
  const judged = new Map<string, EligibilityRow>();
  for (const row of eligibility) {
    if (row.conditionId === conditionId) {
      judged.set(`${row.caseId}#${row.findingIndex}`, row);
    }
  }
  const missing: string[] = [];
  let passing = 0;
  let total = 0;
  for (const entry of entries) {
    const findings = findingsByCase.get(entry.caseId) ?? [];
    for (let index = 0; index < findings.length; index += 1) {
      total += 1;
      const row = judged.get(`${entry.caseId}#${index}`);
      if (row === undefined) {
        missing.push(`${entry.caseId}[${index}]`);
        continue;
      }
      if (row.discoverable && !row.explicitlyExposed) {
        passing += 1;
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `条件 ${conditionId} の判定が無い finding があります（${missing.join(' / ')}）。` +
        'eligibility を判定してから案件ファイルを作り直してください',
    );
  }
  return { judged: total, passing };
}

function candidateOf(entry: SelectedEntry): SelectionCandidate {
  return {
    caseId: entry.caseId,
    prNumber: entry.prNumber,
    stratum: entry.stratum,
    kind: entry.kind,
    changeSizeStratum: entry.changeSizeStratum,
    tags: entry.tags,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const selected = await readWithSha(args.selectedPath);
  const frame = await readWithSha(args.framePath);
  const screening = await readWithSha(args.screeningPath);
  const knownFindings = await readWithSha(args.knownFindingsPath);
  const eligibility = await readWithSha(args.eligibilityPath);

  const selectedFile = JSON.parse(selected.raw) as SelectedFile;
  const entries = selectedFile.selected ?? selectedFile.cases;
  if (entries === undefined || entries.length === 0) {
    throw new Error(`${args.selectedPath} に selected も cases もありません`);
  }
  const eligibilityFile = JSON.parse(eligibility.raw) as EligibilityFile;

  const rows = parseJsonLines(knownFindings.raw) as (KnownFindingsHeader | KnownFindingRow)[];
  const header = rows[0];
  if (header === undefined || header.type !== 'header') {
    throw new Error(`${args.knownFindingsPath} の先頭行が header ではありません`);
  }
  verifyLineage({
    selected: selectedFile,
    frameSha256: frame.sha256,
    screeningSha256: screening.sha256,
    eligibilitySha256: eligibility.sha256,
    eligibility: eligibilityFile,
    header,
    conditionId: args.conditionId,
  });

  const rowsByCase = new Map<string, KnownFindingRow[]>();
  for (const row of rows.slice(1)) {
    if (row.type !== 'finding') {
      throw new Error(
        `${args.knownFindingsPath} に header / finding 以外の行があります: ${row.type}`,
      );
    }
    const list = rowsByCase.get(row.caseId) ?? [];
    list.push(row);
    rowsByCase.set(row.caseId, list);
  }

  const frameByPr = new Map<number, FrameEntry>();
  for (const entry of (JSON.parse(frame.raw) as { prs: FrameEntry[] }).prs) {
    frameByPr.set(entry.prNumber, entry);
  }

  const decisionsByPr = new Map<number, ScreeningDecision>();
  for (const row of parseJsonLines(screening.raw) as ScreeningDecision[]) {
    if (row.type === 'decision') {
      decisionsByPr.set(row.prNumber, row);
    }
  }

  const findingsByCase = new Map<string, KnownFinding[]>();
  const cases: EvalCase[] = entries.map((entry) => {
    if (entry.kind !== UNIFORM_KIND) {
      throw new Error(`${entry.caseId} の kind が ${UNIFORM_KIND} ではありません: ${entry.kind}`);
    }
    const framed = frameEntryOf(entry, frameByPr);
    let findings: KnownFinding[] = [];
    if (POSITIVE_STRATA.has(entry.stratum)) {
      const decision = decisionsByPr.get(entry.prNumber);
      if (decision === undefined) {
        throw new Error(`${entry.caseId} の screening 判定がありません`);
      }
      findings = knownFindingsOf(entry, decision, rowsByCase.get(entry.caseId) ?? []);
    }
    findingsByCase.set(entry.caseId, findings);
    return {
      id: entry.caseId,
      kind: UNIFORM_KIND as EvalCase['kind'],
      repoPath: args.repoPath,
      baseCommit: framed.baseSha as string,
      targetCommit: framed.targetSha as string,
      userRequest: UNIFORM_USER_REQUEST,
      conversation: UNIFORM_CONVERSATION,
      conversationKind: UNIFORM_CONVERSATION_KIND,
      knownImportantFindings: findings,
      knownConstraints: [...UNIFORM_KNOWN_CONSTRAINTS],
    };
  });

  verifyLabelFreeStrata(entries, rowsByCase);
  verifyPositivesEligible(entries.map(candidateOf), eligibilityFile.entries, args.conditionId);
  const judged = verifyFindingsJudged(
    entries,
    findingsByCase,
    eligibilityFile.entries,
    args.conditionId,
  );

  const json = `${JSON.stringify(cases, null, 2)}\n`;
  // 書く前に、実行するのと同じ検査を通す。書いてから確かめると、凍結したファイルが壊れた
  // 状態で残り、版を上げないと直せなくなる
  parseCases(json, args.outPath);
  const written = await writeFrozen(args.outPath, json);

  console.log(`案件ファイル v${CASE_FILE_VERSION}: ${cases.length} 件（条件 ${args.conditionId}）`);
  for (const stratum of DIFFICULTY_STRATA) {
    const inStratum = entries.filter((entry) => entry.stratum === stratum);
    if (inStratum.length === 0) {
      continue;
    }
    const labels = inStratum.reduce(
      (sum, entry) => sum + (findingsByCase.get(entry.caseId)?.length ?? 0),
      0,
    );
    console.log(`  - ${stratum}: ${inStratum.length} 件 / 正解ラベル ${labels} 件`);
  }
  console.log(
    `  条件 ${args.conditionId} の判定: ${judged.judged} 件（うち分母に入るのは ${judged.passing} 件）`,
  );
  console.log(`  入力: ${path.basename(args.selectedPath)} ${selected.sha256}`);
  console.log(`        ${path.basename(args.knownFindingsPath)} ${knownFindings.sha256}`);
  console.log(
    `書き出し: ${args.outPath}${written === 'unchanged' ? '（既存と同一。書き換えていない）' : ''}`,
  );
  console.log(`  sha256: ${createHash('sha256').update(json).digest('hex')}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
