/* eslint-disable no-console -- 母集団の絞り込み過程を出すのがこのファイルの目的 */
/**
 * 本測定の案件を選ぶ前段として、母集団のsampling frameを作る（Issue #1046 手順1）。
 *
 * 使い方:
 *
 * ```
 * # 1回だけ: GitHubから引いて、母集団の素をそのまま保存する
 * npx tsx test/bench/secondOpinionEval/samplingFrame.ts \
 *   --source-out eval-results/sampling-source-v2.json --out eval-results/sampling-frame-v2.json
 *
 * # 以降: 保存した素からのみ作り直す
 * npx tsx test/bench/secondOpinionEval/samplingFrame.ts \
 *   --prs eval-results/sampling-source-v2.json --out eval-results/sampling-frame-v2.json
 * ```
 *
 * **母集団の素も凍結する。** frameのハッシュを記録しても、GitHubを引き直せば母集団そのものが
 * 変わる。期間の指定は日付単位なので、`--until` に指定した当日の後半にPRがマージされれば、
 * 同じコマンドが別の母集団を返す。frameだけを凍結しても「どの入力から作ったか」は固定されない
 * ので、`gh` の出力をそのまま保存し、そのハッシュをframeへ書く。以降の再生成は保存した素から
 * だけ行う。
 *
 * **証拠の有無をここでは一切見ない。** linked Issue があるか、人間のコメントが付いているか、
 * テストが後から足されたかは、どれもこの段階では条件にしない。ここで「正解ラベルを作りやすい
 * PR」に絞ると、母集団そのものが証拠の多い側へ寄り、あとから脱落率を測っても意味を持たなく
 * なる。証拠による脱落は手順2〜3で数える。
 *
 * 除外するのは、**測定が技術的に成立しないもの**と、**測定対象そのもの**だけである。
 *
 * - snapshotを復元できない（base / target のどちらかがローカルに無い）
 * - 差分が空
 * - 全変更ファイルが `docs/**` または `*.md`
 * - pilotで使った3件（規則を作りながら採点した案件で、条件の比較には使えない）
 * - 評価基盤そのもののPR（自分を測ることになる）
 *
 * それ以外は**除外せずタグを付ける**。test-only や config-only や巨大PRを「レビュー価値が
 * 低そう」で落とすと、そこに人手の選択が入る。使わなかったなら、あとでどの段階で落ちたかを
 * 説明できるほうがよい。
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { refuseIfExists, writeFrozen } from './frozenFile';
import { resolveSnapshot, type SnapshotStatus } from './prSnapshot';

const run = promisify(execFile);

/** 案件の判定は、このスクリプトを動かしているリポジトリに対して行う。 */
const REPO_DIR = process.cwd();

async function git(args: readonly string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', REPO_DIR, ...args], { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/**
 * 変更規模の層の境界（Issue #1046）。metadata eligible 415件の四分位。
 *
 * 当初は 69 / 178 / 460 だった。あれは**対象母集団が決まる前に**直近120件から取った暫定値
 * であり、除外規則を固定した本測定の母集団（415件）では四分位から外れていた（実際の層は
 * 15% / 20% / 27% / 38%）。回答の生成も採点もまだしていない段階、つまり**結果を一切見ずに**、
 * 説明変数の側の分布だけで置き換えている。旧境界は {@link PREVIOUS_CHANGE_SIZE_QUARTILES}
 * として残す。
 */
const CHANGE_SIZE_QUARTILES = { q1: 129, median: 317, q3: 706 } as const;

/** 旧境界。どこから来た値かを追えるように残す。 */
const PREVIOUS_CHANGE_SIZE_QUARTILES = { q1: 69, median: 178, q3: 460 } as const;

/**
 * 裾の重い側の目印（Issue #1046）。metadata eligible 415件の p90。
 *
 * 上限で足切りはしない。大きい変更ほどセカンドオピニオンが苦手なら、それは測るべき弱点で
 * あって、除外していい理由ではない。層をさらに割るのも24件には細かすぎるので、タグだけ持ち、
 * 最終的に選んだ案件へこの帯が残っているかを見る。
 */
const EXTREME_TAIL_LINES = 1387;

/** 除外規則の版。境界や規則を変えたら上げる。frameのhashと合わせて、どの規則で作ったかを示す。 */
const EXCLUSION_RULES_VERSION = 2;

/** pilotで使った案件。規則を作りながら採点したので、条件の比較には使えない。 */
const PILOT_PR_NUMBERS: readonly number[] = [992, 995, 1027];

/** 評価基盤そのもののIssue。これらに紐づくPRは測定対象から外す。 */
const BENCHMARK_ISSUE_NUMBERS: readonly number[] = [1044, 1045, 1046, 1047, 1048];

/** 実際に最も古いマージが 2026-08-10。当初は 08-07 としていたが、その3日間にマージは無い。 */
const DEFAULT_SINCE = '2026-08-10';
const DEFAULT_UNTIL = '2026-08-31';

interface GhPullRequest {
  number: number;
  title: string;
  body: string;
  mergedAt: string;
  baseRefOid: string;
  headRefOid: string;
  mergeCommit: { oid: string } | null;
}

type ChangeSizeStratum = 'S' | 'M' | 'L' | 'XL';

type ExclusionRule =
  'snapshot-unavailable' | 'empty-diff' | 'docs-only' | 'pilot' | 'benchmark-self';

/**
 * 変更規模の層は**主層化の軸ではない**（Issue #1046）。
 *
 * 24件に対して `kind` × 難易度 × 変更規模 の3軸をすべて層化すると64セルになり、ほとんどが
 * 0件になる。主層化は `kind` と難易度の2軸にし、変更規模は抽出後のバランス確認に使う。
 *
 * 条件間のconfoundにもならない。同じ案件を全条件へ流す対照実験なので、「条件Aだけ大きいPRが
 * 多い」ということは起きない。確認したいのは、選んだ24件が特定のサイズ帯だけに偏っていない
 * ことだけである。
 *
 * そもそも B-pos の効果に効くのは変更行数ではなく、依頼文より後ろに実際に何バイト続くかで
 * ある。16965行のPRでも差分が途中で切られれば入力は小さくなり、300行でも背景が長ければ重く
 * なる。実プロンプト長は、材料を作れる段階（eligible pool 確定後、抽出前）に別途測る。
 */
interface FramePullRequest {
  prNumber: number;
  title: string;
  mergedAt: string;
  mergeCommit: string;
  baseSha: string | undefined;
  targetSha: string | undefined;
  snapshotStatus: SnapshotStatus;
  /** snapshot が ok でないときの理由。黙って補正せずここへ残す。 */
  snapshotNote: string | undefined;
  changedLines: number | undefined;
  changedFiles: number | undefined;
  changeSizeStratum: ChangeSizeStratum | undefined;
  /** 除外はしないが、あとで内訳を見るための目印。 */
  tags: string[];
  /** 除外した規則。含まれていれば sampling frame の対象外。 */
  excludedBy: ExclusionRule | undefined;
}

interface Args {
  outPath: string;
  prsPath: string | undefined;
  sourceOutPath: string | undefined;
  since: string;
  until: string;
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
  const outPath = values.get('out');
  if (outPath === undefined || outPath === '') {
    throw new Error('--out は必須です');
  }
  const prsPath = values.get('prs');
  const sourceOutPath = values.get('source-out');
  if (
    (prsPath === undefined || prsPath === '') &&
    (sourceOutPath === undefined || sourceOutPath === '')
  ) {
    // 素を保存しないままGitHubを引くと、そのframeがどの入力から出たかを後から示せない
    throw new Error(
      '--prs（保存済みの母集団）か --source-out（これから保存する先）のどちらかは必須です',
    );
  }
  return {
    outPath,
    prsPath,
    sourceOutPath,
    since: values.get('since') ?? DEFAULT_SINCE,
    until: values.get('until') ?? DEFAULT_UNTIL,
  };
}

const GH_ARGS = [
  'pr',
  'list',
  '--state',
  'merged',
  '--limit',
  '1000',
  '--json',
  'number,title,body,mergedAt,baseRefOid,headRefOid,mergeCommit',
] as const;

/** 保存した母集団の素。`prs` は `gh` の出力をそのまま入れる。 */
interface SourceSnapshot {
  capturedAt: string;
  command: string;
  prs: GhPullRequest[];
}

/**
 * 母集団の素を用意する（Issue #1046）。
 *
 * `--prs` があればそれを読む。無ければGitHubを引き、**引いた内容をそのまま保存する**。保存
 * せずに引くのは `parseArgs` で禁止してあるので、素の無いframeはできない。
 */
async function loadSource(
  args: Args,
): Promise<{ snapshot: SourceSnapshot; path: string; sha256: string }> {
  if (args.prsPath !== undefined && args.prsPath !== '') {
    const raw = await fs.readFile(args.prsPath, 'utf8');
    const parsed = JSON.parse(raw) as SourceSnapshot | GhPullRequest[];
    // `gh` の生出力（配列）を直接渡された場合も読む。ただし取得時刻は分からない
    const snapshot: SourceSnapshot = Array.isArray(parsed)
      ? { capturedAt: 'unknown', command: `gh ${GH_ARGS.join(' ')}`, prs: parsed }
      : parsed;
    return {
      snapshot,
      path: args.prsPath,
      sha256: createHash('sha256').update(raw).digest('hex'),
    };
  }

  const outPath = args.sourceOutPath ?? '';
  // 素は一度取ったら二度と取り直さない。同じパスへ書き直せるなら、凍結したことにならない
  await refuseIfExists(outPath, '母集団の素');
  const { stdout } = await run('gh', [...GH_ARGS], { maxBuffer: 64 * 1024 * 1024 });
  const snapshot: SourceSnapshot = {
    capturedAt: new Date().toISOString(),
    command: `gh ${GH_ARGS.join(' ')}`,
    prs: JSON.parse(stdout) as GhPullRequest[],
  };
  const json = `${JSON.stringify(snapshot, null, 2)}\n`;
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await fs.writeFile(outPath, json, 'utf8');
  return {
    snapshot,
    path: outPath,
    sha256: createHash('sha256').update(json).digest('hex'),
  };
}

function stratumOf(changedLines: number): ChangeSizeStratum {
  if (changedLines <= CHANGE_SIZE_QUARTILES.q1) {
    return 'S';
  }
  if (changedLines <= CHANGE_SIZE_QUARTILES.median) {
    return 'M';
  }
  if (changedLines <= CHANGE_SIZE_QUARTILES.q3) {
    return 'L';
  }
  return 'XL';
}

const GENERATED_PATTERNS = [/package-lock\.json$/, /\.lock$/, /^dist\//, /^out\//];
const CONFIG_PATTERNS = [
  /^\.github\//,
  /^\.vscode\//,
  /\.json$/,
  /\.ya?ml$/,
  /^\.[^/]*rc/,
  /^\.gitignore$/,
];

function isDocsPath(file: string): boolean {
  return file.startsWith('docs/') || file.endsWith('.md');
}

function tagsFor(files: readonly string[], title: string, changedLines: number): string[] {
  const tags: string[] = [];
  if (files.length === 1) {
    tags.push('single-file');
  }
  if (files.every((f) => f.startsWith('test/'))) {
    tags.push('test-only');
  }
  if (files.every((f) => CONFIG_PATTERNS.some((p) => p.test(f)))) {
    tags.push('config-only');
  }
  if (files.some((f) => GENERATED_PATTERNS.some((p) => p.test(f)))) {
    tags.push('has-generated');
  }
  if (files.some(isDocsPath)) {
    tags.push('touches-docs');
  }
  if (changedLines > EXTREME_TAIL_LINES) {
    tags.push('extreme-tail');
  }
  const lower = title.toLowerCase();
  if (lower.startsWith('revert')) {
    tags.push('revert');
  }
  if (lower.startsWith('refactor')) {
    tags.push('refactor');
  }
  if (lower.startsWith('chore') || lower.startsWith('ci:')) {
    tags.push('chore');
  }
  return tags;
}

/**
 * 評価基盤そのもののPRか（Issue #1046）。
 *
 * PR番号だけでなく本文の参照も見る。`Refs #1044` を書いたPRは評価基盤の一部であり、それを
 * 案件にすると自分を測ることになる。本文は外部由来のテキストなので、参照番号の照合にだけ使い、
 * そこに書かれた指示めいた文は読まない。
 */
function isBenchmarkSelf(pr: GhPullRequest): boolean {
  if (BENCHMARK_ISSUE_NUMBERS.includes(pr.number)) {
    return true;
  }
  const text = `${pr.title}\n${pr.body}`;
  return BENCHMARK_ISSUE_NUMBERS.some((issue) => new RegExp(`#${issue}\\b`).test(text));
}

async function classify(pr: GhPullRequest): Promise<FramePullRequest> {
  const snapshot = await resolveSnapshot(pr, REPO_DIR);
  const base: FramePullRequest = {
    prNumber: pr.number,
    title: pr.title,
    mergedAt: pr.mergedAt,
    mergeCommit: pr.mergeCommit?.oid ?? '',
    baseSha: snapshot.baseSha,
    targetSha: snapshot.targetSha,
    snapshotStatus: snapshot.status,
    snapshotNote: snapshot.note,
    changedLines: undefined,
    changedFiles: undefined,
    changeSizeStratum: undefined,
    tags: [],
    excludedBy: undefined,
  };

  if (PILOT_PR_NUMBERS.includes(pr.number)) {
    return { ...base, excludedBy: 'pilot' };
  }
  if (isBenchmarkSelf(pr)) {
    return { ...base, excludedBy: 'benchmark-self' };
  }
  if (snapshot.baseSha === undefined || snapshot.targetSha === undefined) {
    return { ...base, excludedBy: 'snapshot-unavailable' };
  }

  const numstat = await git([
    'diff',
    '--numstat',
    `${snapshot.baseSha}..${snapshot.targetSha}`,
    '--',
  ]);
  const rows = numstat
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => line.split('\t'));
  const files = rows.map((row) => row[2] ?? '').filter((f) => f !== '');
  // バイナリは `-` で来る。行数としては数えないが、変更ファイルには含める
  const changedLines = rows.reduce((sum, row) => {
    const added = Number(row[0]);
    const removed = Number(row[1]);
    return sum + (Number.isFinite(added) ? added : 0) + (Number.isFinite(removed) ? removed : 0);
  }, 0);

  const enriched: FramePullRequest = {
    ...base,
    changedLines,
    changedFiles: files.length,
    changeSizeStratum: stratumOf(changedLines),
    tags: tagsFor(files, pr.title, changedLines),
  };

  if (files.length === 0) {
    return { ...enriched, excludedBy: 'empty-diff' };
  }
  if (files.every(isDocsPath)) {
    return { ...enriched, excludedBy: 'docs-only' };
  }
  return enriched;
}

function quartilesOf(values: readonly number[]): { q1: number; median: number; q3: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number): number => sorted[Math.floor((sorted.length - 1) * fraction)] ?? 0;
  return { q1: at(0.25), median: at(0.5), q3: at(0.75) };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const source = await loadSource(args);
  const inWindow = source.snapshot.prs.filter((pr) => {
    const day = pr.mergedAt.slice(0, 10);
    return day >= args.since && day <= args.until;
  });

  const classified: FramePullRequest[] = [];
  for (const pr of inWindow) {
    classified.push(await classify(pr));
    if (classified.length % 50 === 0) {
      console.log(`[frame] ${classified.length} / ${inWindow.length} 件`);
    }
  }

  const eligible = classified.filter((pr) => pr.excludedBy === undefined);
  const measured = quartilesOf(
    eligible.map((pr) => pr.changedLines).filter((n): n is number => typeof n === 'number'),
  );

  // 境界は母集団の四分位そのものである。ずれたということは母集団が変わったということで、
  // そのまま書き出すと「四分位で切った」と書いてある層が実際には四分位でなくなる
  if (
    measured.q1 !== CHANGE_SIZE_QUARTILES.q1 ||
    measured.median !== CHANGE_SIZE_QUARTILES.median ||
    measured.q3 !== CHANGE_SIZE_QUARTILES.q3
  ) {
    throw new Error(
      `母集団の四分位が境界と一致しません。境界: ${JSON.stringify(CHANGE_SIZE_QUARTILES)} / 実測: ${JSON.stringify(measured)}。` +
        '母集団が変わっています。CHANGE_SIZE_QUARTILES を実測値へ更新し、EXCLUSION_RULES_VERSION を上げ、前の版のファイルは残してください',
    );
  }

  const frame = {
    population: inWindow.length,
    window: [args.since, args.until],
    /**
     * 母集団の素。frameだけ凍結しても、GitHubを引き直せば母集団は変わる。
     *
     * 正本は `sourceSha256` のほうで、ファイル名は目印にすぎない。**絶対パスは入れない。**
     * 入れると、同じ素から作ってもcloneの置き場所でframeのハッシュが変わってしまう。
     */
    sourceFile: path.basename(source.path),
    sourceSha256: source.sha256,
    capturedAt: source.snapshot.capturedAt,
    exclusionRulesVersion: EXCLUSION_RULES_VERSION,
    /** 層を切る境界。 */
    quartiles: CHANGE_SIZE_QUARTILES,
    /** 版1で使っていた境界。どこから来た値かを追えるように残す。 */
    previousQuartiles: PREVIOUS_CHANGE_SIZE_QUARTILES,
    /** この母集団で測り直した四分位。`quartiles` と一致しているはずで、ずれたら規則の版を上げる。 */
    measuredQuartiles: measured,
    /** 変更規模の層の使い道。主層化の軸ではない。 */
    changeSizeStratumRole: 'balance-check',
    extremeTailLines: EXTREME_TAIL_LINES,
    prs: classified,
  };

  const json = `${JSON.stringify(frame, null, 2)}\n`;
  const written = await writeFrozen(args.outPath, json);
  const sha256 = createHash('sha256').update(json).digest('hex');

  console.log('');
  console.log(`母集団（${args.since}〜${args.until} にマージ）: ${inWindow.length} 件`);
  const rules: ExclusionRule[] = [
    'pilot',
    'benchmark-self',
    'snapshot-unavailable',
    'empty-diff',
    'docs-only',
  ];
  for (const rule of rules) {
    const count = classified.filter((pr) => pr.excludedBy === rule).length;
    console.log(`  - ${rule}: ${count} 件`);
  }
  console.log(`metadata eligible: ${eligible.length} 件`);
  console.log('');
  console.log('変更規模の層:');
  for (const stratum of ['S', 'M', 'L', 'XL'] as const) {
    const count = eligible.filter((pr) => pr.changeSizeStratum === stratum).length;
    console.log(`  - ${stratum}: ${count} 件`);
  }
  console.log(
    `  境界: q1=${CHANGE_SIZE_QUARTILES.q1} / median=${CHANGE_SIZE_QUARTILES.median} / q3=${CHANGE_SIZE_QUARTILES.q3}` +
      `（今回の実測: q1=${measured.q1} / median=${measured.median} / q3=${measured.q3}）`,
  );
  console.log('');
  console.log('タグ（除外していない目印）:');
  const tagCounts = new Map<string, number>();
  for (const pr of eligible) {
    for (const tag of pr.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }
  for (const [tag, count] of [...tagCounts].sort((a, b) => b[1] - a[1])) {
    console.log(`  - ${tag}: ${count} 件`);
  }
  console.log('');
  console.log('snapshot:');
  for (const status of ['ok', 'non-linear', 'unavailable'] as const) {
    console.log(
      `  - ${status}: ${classified.filter((pr) => pr.snapshotStatus === status).length} 件`,
    );
  }
  console.log('');
  console.log(`母集団の素: ${source.path}`);
  console.log(`  sha256: ${source.sha256}`);
  console.log(`  取得時刻: ${source.snapshot.capturedAt}`);
  console.log(
    `書き出し: ${args.outPath}${written === 'unchanged' ? '（既存と同一。書き換えていない）' : ''}`,
  );
  console.log(`  sha256: ${sha256}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
