import * as path from 'node:path';

import type { WorkflowTask } from './workflow';

/**
 * 承認要求を `auto` / `ask` に振り分ける危険判定（design.md §16.7）。
 *
 * VSCode APIにもファイルシステムにも依存しない純粋関数のみを置く。実パス解決
 * （`realpath` / `git rev-parse --git-common-dir`）はここでは行わず、呼び出し側
 * （`runner.ts`）が解決済みの値を渡す。
 *
 * ## 位置付け（§16.7 より）
 *
 * **この判定は防御の主軸ではない。** コマンドは文字列として渡ってくるだけで、
 * シェルの構文木は得られない。実際に塞げない例（`;` `$` `&` `|` 等のシェルメタ文字を
 * 含まないため、本モジュールのチェックをすべて素通りする）:
 *
 * - 別名の同等バイナリを直接呼ぶ: `rm` を指す別名の実行ファイル（`rm-alias -rf ...` の
 *   ようにPATH解決される名前、または境界内の場所に置かれた同等バイナリ）を直接起動する。
 *   既知のコマンド名一覧に無く、境界外への絶対パスでもないため、コマンド名照合にも
 *   引数パスの境界チェックにも掛からない（実測で確認済み）
 * - スクリプト言語のワンライナーで同じ効果を得る: `perl -e 'unlink glob
 *   "/repo/work/tmp/*"'` はシェルメタ文字も既知のコマンド名も含まない。引数中の
 *   パスも、クォートに包まれているため `extractPathLikeArguments` の
 *   「`/` 始まり」判定に掛からない
 * - 2つの承認要求にまたがる間接実行: 1つ目の要求（`fileChange`）でスクリプトを
 *   書き込み、2つ目の要求（`command`）で `bash script.sh` のように無害な形で実行する。
 *   個々の要求は単体では安全に見えるため、1要求単位の判定である以上原理的に防げない
 *
 * パターン照合でこれを塞ぎ切ることはできないし、塞げるふりをしてはいけない。
 * 一次防御は `sandbox: workspace-write`（拡張機能の設定より緩められない）であり、
 * ここでのパターン照合は「分かりやすい危険を先回りして人へ回す」ための補助的な
 * 検知に過ぎない。取りこぼす前提で置く。
 *
 * ## ステップ0の実測結果（実装前に確定させる宿題、§16.7の「実装前に確認すること」）
 *
 * 確認方法・確認日・CLIバージョン:
 *
 * - Codex: `codex app-server generate-json-schema --out <dir>` でプロトコル定義を
 *   出し、`CommandExecutionRequestApprovalParams.json`（`item/commandExecution/requestApproval`
 *   の params）を読んだ。`command` は `"type": ["string", "null"]` ——
 *   **文字列（またはnull）であり、配列ではない**。確認日2026-08-11、
 *   `codex-cli 0.147.0`（`codex --version`）。`docs/tui-parity-backlog.md` の
 *   Phase 0 が「このコマンドで全量が取れる」としている通りに取得できた。
 *   なお `FileChangeRequestApprovalParams` は変更対象パスを一切持たない
 *   （`itemId` / `reason` / `grantRoot` のみ）。変更対象パスは別途、呼び出し側が
 *   `itemId` から対応する項目の差分を引いて渡す必要がある。
 * - Claude Code: `src/claude/transcript.ts` の `describeTool`（`Bash` /
 *   `BashOutput` ケース）が `str(input['command'])` として読んでおり、
 *   `src/claude/control.ts` の `describeCanUseTool` もこれをそのまま使っている。
 *   既存実装は最初から文字列を前提にしている（Claude公式のBashツール定義も
 *   `command` を文字列パラメータとして公開している）。
 *
 * 結論: 現行プロトコルでは両CLIとも `command` は文字列であり、既存の
 * `src/appserver/approvals.ts` の `typeof v === 'string'` 判定（新形式の
 * `item/commandExecution/requestApproval` に対して）は正しく動作する。
 * ただし旧形式（`execCommandApproval`）は配列で届くため `joinCommand` で
 * 結合している。将来の仕様変更やCLIのバージョン差に備え、本モジュールでも
 * 配列を結合する `normalizeCommand` を用意し、呼び出し側が型を意識せず
 * 判定へ渡せるようにする。
 *
 * ## 構造化データで判定できるものはパターン照合より優先する
 *
 * `CommandExecutionRequestApprovalParams` の `required` は `itemId` /
 * `startedAtMs` / `threadId` / `turnId` の4つだけで、`command` は
 * `"type": ["string", "null"]` ——**必須でもnull非許容でもない**。届かない
 * ことがある以上、コマンド文字列が空・欠落の要求は「判定に失敗した」として
 * `ask` にする（本体の実装を参照）。
 *
 * 同スキーマには、コマンド文字列のパターン照合に頼らずに「外部へ出る操作」を
 * 確実に検知できる構造化フィールドがある。app-server自身がネットワークアクセスの
 * 承認を求めるとき、接続先を構造化データとして渡してくる。
 *
 * - `networkApprovalContext: { host, protocol }` — 接続先ホストとプロトコル
 * - `proposedNetworkPolicyAmendments: [{ action: 'allow' | 'deny', host }]` —
 *   `action: 'allow'` は「このホストを以後ずっと許可する」という永続的な
 *   権限拡大の提案。1回の実行より重いため、`curl` / `wget` 等の文字列照合とは
 *   独立に、これらが存在するだけで `ask` にする
 *
 * `FileChangeRequestApprovalParams` の `grantRoot`（`[UNSTABLE] When set, the
 * agent is asking the user to allow writes under this root for the remainder
 * of the session`）も同様に構造化データで確実に拾える。これは1回分の変更承認
 * ではなく**セッション残り全体への書き込み許可要求**という別種の権限拡大であり、
 * `.git` 配下への書き込み・`permissions` 種別と同じく `allow` でも解除できない
 * 扱いにする。
 *
 * 確認方法・確認日・CLIバージョンは本コメント冒頭と同じ
 * （`codex app-server generate-json-schema`、2026-08-11、`codex-cli 0.147.0`）。
 */

/** 承認要求の種別。表示用の `PendingApproval.kind` より粗く、判定に必要な4種に絞る。 */
export const APPROVAL_REQUEST_KINDS = ['command', 'fileChange', 'permissions', 'unknown'] as const;
export type ApprovalRequestKind = (typeof APPROVAL_REQUEST_KINDS)[number];

/** `networkApprovalContext`（app-serverがネットワーク到達を構造化データで申告してくる）。 */
export interface NetworkApprovalContext {
  host: string;
  protocol: string;
}

/**
 * `proposedNetworkPolicyAmendments` の1件。`action: 'allow'` は「このホストを
 * 以後ずっと許可する」という永続的な権限拡大の提案（§16.7）。
 */
export interface NetworkPolicyAmendment {
  action: 'allow' | 'deny';
  host: string;
}

/**
 * 判定の入力。表示用に整形済みの `PendingApproval`（`title` / `detail` に結合済みの
 * 文字列しか持たない）は使わない。生の要求パラメータをそのまま渡す。
 */
export interface EscalationRequest {
  kind: ApprovalRequestKind;
  /**
   * `command` 種別のときだけ意味を持つ。`normalizeCommand` で正規化済みの文字列。
   * `CommandExecutionRequestApprovalParams.command` は必須でもnull非許容でもない
   * （実測、§16.7）ため、`command` 種別なのに空文字なら「判定に失敗した」として扱う。
   */
  command: string;
  /**
   * `command` 種別のときの実行ディレクトリ（実パス解決済み）。
   * 空文字は「不明・未指定」を表す。多くの場合はタスク自身のcwdがそのまま使われる
   * だけなので、空文字を境界違反とはしない（不明を危険側に倒すと通常のコマンドまで
   * 軒並み `ask` になり、無人実行の意味が無くなる）。
   */
  cwd: string;
  /**
   * `fileChange` 種別のときの変更対象パス（実パス解決済み）。
   * app-serverの `item/fileChange/requestApproval` はパスを持たないため、
   * 呼び出し側が `itemId` から対応する項目の差分を引いて渡す。
   */
  paths: readonly string[];
  /**
   * `command` 種別の要求に付随する、ネットワーク到達先の構造化申告。
   * 存在すればコマンド文字列の中身によらず `ask` にする（§16.7）。
   */
  networkApprovalContext: NetworkApprovalContext | undefined;
  /**
   * `command` 種別の要求に付随する、恒久的なネットワーク許可の提案。
   * `action: 'allow'` を含む要求は `ask` にする（§16.7）。
   */
  proposedNetworkPolicyAmendments: readonly NetworkPolicyAmendment[];
  /**
   * `fileChange` 種別の要求に付随する、セッション残り全体への書き込み許可要求
   * （`FileChangeRequestApprovalParams.grantRoot`）。設定されていれば常に `ask`
   * にし、`allow` でも解除できない（`.git` 配下・`permissions` 種別と同じ扱い）。
   */
  grantRoot: string | undefined;
  /**
   * `command` 種別の要求に付随する、以後同種のコマンドを無確認で通すための提案
   * （`CommandExecutionRequestApprovalParams.proposedExecpolicyAmendment`）。
   *
   * ネットワークの許可提案と違い、対象が特定のホストではなくコマンド全般に及ぶ。
   * 既定の危険パターンのどれかに属する話ではなく権限そのものの拡大なので、
   * `grantRoot` と同じく `allow` では解除できない扱いにする。
   */
  proposedExecpolicyAmendment: readonly string[];
}

/** 実パス解決済みの境界。ファイルシステムに触れず、解決済みの値を受け取るだけ。 */
export interface TaskBoundary {
  /**
   * 書き込みを許すディレクトリの一覧（実パス解決済み）。
   * 通常は「タスクの作業ディレクトリ」と「worktreeのルート」の2つを渡す想定だが、
   * `isolation: shared` のように両者が同一の場合もあるため配列にしてある。
   */
  allowedRoots: readonly string[];
  /**
   * `git rev-parse --git-common-dir` を実パス解決した結果。
   * worktreeの `.git` は実体がファイルで、hooksなどの実データは親リポジトリの
   * 共有領域にある。字面ではworktree内（`allowedRoots` の配下）に見えるため、
   * `allowedRoots` の境界チェックだけでは共有領域への書き込みを検出できない。
   * gitでない、または取得できない場合は `undefined`。
   */
  gitCommonDir: string | undefined;
}

/** タスク単位の停止条件の調整。`WorkflowTask` からそのまま渡せる形にしてある。 */
export type EscalationPolicy = Pick<WorkflowTask, 'escalate' | 'allow' | 'autoApprove'>;

export type EscalationDecision = 'auto' | 'ask';

/** 判定結果。`auto` で通したものも呼び出し側が記録できるよう、理由は両方で返す。 */
export interface EscalationResult {
  decision: EscalationDecision;
  /** 該当した停止条件の説明。`auto` のときも「該当なし」を1件入れる（常に非空）。 */
  reasons: readonly string[];
}

/**
 * `command` パラメータを判定用の文字列へ正規化する。
 *
 * ステップ0の実測では現行プロトコルはいずれも文字列だったが、旧形式
 * （`execCommandApproval`）や将来の変更で配列（例: `["bash", "-lc", "..."]`）が
 * 届く可能性に備える。配列で届いた場合に素通しすると判定入力が常に空になり、
 * 危険判定が丸ごと無効になる（§16.7で名指しされている事故）ため、ここで必ず結合する。
 */
export function normalizeCommand(raw: unknown): string {
  if (typeof raw === 'string') {
    return raw;
  }
  if (Array.isArray(raw)) {
    return raw.filter((part): part is string => typeof part === 'string').join(' ');
  }
  return '';
}

/**
 * 既定で `ask` に倒す停止条件のid。`allow` はこのidの文字列一致で解除する。
 * `.git` 配下への書き込みと `permissions` 種別はここに含めない
 * （id自体を存在させないことで、`allow` からの参照を構造的に不可能にする）。
 */
export const DANGER_PATTERN_IDS = {
  shellMetacharacters: 'shell-metacharacters',
  outsideWorkingDirectory: 'outside-working-directory',
  recursiveForceDelete: 'recursive-force-delete',
  untrackedClean: 'untracked-clean',
  worktreeReset: 'worktree-reset',
  branchTagDelete: 'branch-tag-delete',
  dbDropTruncate: 'db-drop-truncate',
  findDeleteExec: 'find-delete-exec',
  forcePush: 'force-push',
  deployPublish: 'deploy-publish',
  externalEgress: 'external-egress',
  decode: 'decode',
} as const;

type DangerPatternId = (typeof DANGER_PATTERN_IDS)[keyof typeof DANGER_PATTERN_IDS];

interface DangerPattern {
  id: DangerPatternId;
  description: string;
  test: (command: string) => boolean;
}

/**
 * 空白区切りの雑なトークン化。シェルの完全なパースは目指さない（§16.7）。
 *
 * コマンド名・フラグの照合はすべて大文字小文字を無視する。Windowsは実行ファイルの
 * 解決自体が大文字小文字を区別しないため、`RM -RF` は本物の `rm` を実際に起動する
 * （実測で確認された回避経路）。ここで小文字化しておくことで、以降のパターン照合を
 * 個別に `/i` フラグへ気を配らなくても大文字小文字を問わない形に揃える。
 */
function tokenize(command: string): string[] {
  return command
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .filter((t) => t !== '');
}

/**
 * 空白区切りの雑なトークン化（大文字小文字を保持する版）。
 * コマンド引数からパスらしいトークンを拾う用途では、パスの実体を変えないために
 * 大文字小文字を保ったまま扱う（`.git` セグメント判定だけは別途大文字小文字を無視する）。
 */
function rawTokenize(command: string): string[] {
  return command
    .trim()
    .split(/\s+/u)
    .filter((t) => t !== '');
}

/** `name` そのもの、または `.../name` の形のトークンのインデックス一覧（`sudo rm -rf` 等を拾うため）。 */
function indexesOfCommandName(tokens: readonly string[], name: string): number[] {
  const indexes: number[] = [];
  tokens.forEach((t, i) => {
    if (t === name || t.endsWith(`/${name}`)) {
      indexes.push(i);
    }
  });
  return indexes;
}

/** `rm` 以降のトークンに再帰(`r`/`R`/`--recursive`)と強制(`f`/`--force`)の両方があるか。 */
function isRecursiveForceDelete(command: string): boolean {
  const tokens = tokenize(command);
  const starts = indexesOfCommandName(tokens, 'rm');
  return starts.some((start) => {
    const rest = tokens.slice(start + 1);
    let hasRecursive = false;
    let hasForce = false;
    for (const token of rest) {
      if (token === '--recursive') hasRecursive = true;
      if (token === '--force') hasForce = true;
      if (/^-[A-Za-z]+$/.test(token)) {
        const flags = token.slice(1);
        if (/[rR]/.test(flags)) hasRecursive = true;
        if (/f/.test(flags)) hasForce = true;
      }
    }
    return hasRecursive && hasForce;
  });
}

/** `git clean` に強制フラグ（`-f` を含む短縮形、または `--force`）が付いているか。 */
function isUntrackedClean(command: string): boolean {
  const tokens = tokenize(command);
  const cleanIndexes = indexesOfCommandName(tokens, 'git').filter((i) => tokens[i + 1] === 'clean');
  return cleanIndexes.some((i) =>
    tokens
      .slice(i + 2)
      .some((token) => token === '--force' || (/^-[A-Za-z]+$/.test(token) && token.includes('f'))),
  );
}

/**
 * `git reset --hard` / `git checkout -f|--force` / `git restore --worktree` のいずれか。
 * `/i` を付け、`GIT RESET --HARD` のような大文字化での回避を防ぐ。
 */
function isWorktreeReset(command: string): boolean {
  return (
    /\bgit\s+reset\s+(--hard|-[A-Za-z]*h)\b/i.test(command) ||
    /\bgit\s+checkout\b[^\n]*\s(-f|--force)\b/i.test(command) ||
    /\bgit\s+restore\b[^\n]*--worktree\b/i.test(command)
  );
}

/**
 * ブランチ/タグの削除、またはリモートからの削除push。
 * `/i` を付け、大文字化での回避を防ぐ。
 */
function isBranchOrTagDelete(command: string): boolean {
  return (
    /\bgit\s+branch\b[^\n]*\s(-[A-Za-z]*d[A-Za-z]*|--delete)\b/i.test(command) ||
    /\bgit\s+tag\b[^\n]*\s(-d|--delete)\b/i.test(command) ||
    /\bgit\s+push\b[^\n]*--delete\b/i.test(command)
  );
}

/** テーブルの削除・全消去（`DROP TABLE` / `TRUNCATE`）。大文字小文字を問わない。 */
function isDbDropOrTruncate(command: string): boolean {
  return /\bdrop\s+table\b/i.test(command) || /\btruncate\b/i.test(command);
}

/** `find` の `-delete` / `-exec`。 */
function isFindDeleteOrExec(command: string): boolean {
  const tokens = tokenize(command);
  const starts = indexesOfCommandName(tokens, 'find');
  return starts.some((start) =>
    tokens.slice(start + 1).some((token) => token === '-delete' || token === '-exec'),
  );
}

/** `git push` に強制フラグ（`--force` / `--force-with-lease` / 単体の `-f`）が付いているか。 */
function isForcePush(command: string): boolean {
  const tokens = tokenize(command);
  const gitIndexes = indexesOfCommandName(tokens, 'git').filter((i) => tokens[i + 1] === 'push');
  return gitIndexes.some((i) =>
    tokens
      .slice(i + 2)
      .some((token) => token === '--force' || token === '--force-with-lease' || token === '-f'),
  );
}

/**
 * デプロイ・パッケージ公開に類するコマンド。
 *
 * 生態系ごとに語彙がばらばらで網羅はできない。よく使われるものだけを拾う
 * （報告時の「漏れ」として明示する対象）。
 */
const DEPLOY_PUBLISH_PATTERN =
  /\b(npm|yarn|pnpm)\s+publish\b|\bcargo\s+publish\b|\bgem\s+push\b|\btwine\s+upload\b|\bdocker\s+push\b|\bkubectl\s+apply\b|\bterraform\s+apply\b|\bserverless\s+deploy\b|\bcdk\s+deploy\b|\bfirebase\s+deploy\b/i;

function isDeployOrPublish(command: string): boolean {
  return DEPLOY_PUBLISH_PATTERN.test(command);
}

/** 外部へ到達しうるコマンド（`curl` / `wget` / `nc` 系）。 */
function isExternalEgress(command: string): boolean {
  const tokens = tokenize(command);
  return ['curl', 'wget', 'nc', 'ncat', 'netcat'].some(
    (name) => indexesOfCommandName(tokens, name).length > 0,
  );
}

/** `base64 -d/--decode` や `xxd -r`（デコードして間接実行する足がかりになりうる）。 */
function isDecode(command: string): boolean {
  const tokens = tokenize(command);
  const base64Hit = indexesOfCommandName(tokens, 'base64').some((i) =>
    tokens.slice(i + 1).some((token) => token === '-d' || token === '--decode'),
  );
  const xxdHit = indexesOfCommandName(tokens, 'xxd').some((i) =>
    tokens.slice(i + 1).some((token) => token === '-r'),
  );
  return base64Hit || xxdHit;
}

/**
 * シェルメタ文字（`;` `|` `&` `$` バッククォート `(` `)` `<` `>` 改行）を含む、
 * または複数のコマンドが連結されている。単純な1コマンドでなくなった時点で
 * 判定の当てが外れたとみなす（§16.7）。
 */
const SHELL_METACHARACTER_PATTERN = /[;|&$`()<>\r\n]/;

function hasShellMetacharacters(command: string): boolean {
  return SHELL_METACHARACTER_PATTERN.test(command);
}

/** `allow` で解除可能な、コマンド文字列に対するパターンの一覧。 */
const DANGER_COMMAND_PATTERNS: readonly DangerPattern[] = [
  {
    id: DANGER_PATTERN_IDS.shellMetacharacters,
    description: 'シェルメタ文字を含む、または複数のコマンドが連結されている',
    test: hasShellMetacharacters,
  },
  {
    id: DANGER_PATTERN_IDS.recursiveForceDelete,
    description: '再帰的な強制削除（rm -rf 相当）',
    test: isRecursiveForceDelete,
  },
  {
    id: DANGER_PATTERN_IDS.untrackedClean,
    description: '追跡外ファイルの一括削除（git clean の強制実行）',
    test: isUntrackedClean,
  },
  {
    id: DANGER_PATTERN_IDS.worktreeReset,
    description: '作業ツリーの強制巻き戻し（git reset --hard 等）',
    test: isWorktreeReset,
  },
  {
    id: DANGER_PATTERN_IDS.branchTagDelete,
    description: 'ブランチまたはタグの削除',
    test: isBranchOrTagDelete,
  },
  {
    id: DANGER_PATTERN_IDS.dbDropTruncate,
    description: 'テーブルの削除・全消去（DROP TABLE / TRUNCATE）',
    test: isDbDropOrTruncate,
  },
  {
    id: DANGER_PATTERN_IDS.findDeleteExec,
    description: 'find の -delete / -exec',
    test: isFindDeleteOrExec,
  },
  {
    id: DANGER_PATTERN_IDS.forcePush,
    description: 'リモートへの強制push',
    test: isForcePush,
  },
  {
    id: DANGER_PATTERN_IDS.deployPublish,
    description: 'デプロイまたはパッケージの公開',
    test: isDeployOrPublish,
  },
  {
    id: DANGER_PATTERN_IDS.externalEgress,
    description: '外部へ到達しうるコマンド（curl / wget / nc 系）',
    test: isExternalEgress,
  },
  {
    id: DANGER_PATTERN_IDS.decode,
    description: 'デコードによる間接実行の足がかり（base64 / xxd）',
    test: isDecode,
  },
];

/**
 * 対象パスが境界の配下（境界そのものを含む）かどうか。
 *
 * `target.startsWith(root)` のような字面比較は `/repo` が `/repo-evil/x` に
 * 一致する類のバグを生むため使わない。`path.relative` は両者を正規化したうえで
 * `..` から始まるかどうかで境界の内外を判定でき、区切り文字の境界も自然に守れる。
 * 呼び出し側は実パス解決済みの絶対パスを渡す前提（本関数はシンボリックリンクの
 * 解決を行わない）。
 */
export function isPathWithinRoot(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function isOutsideAllowedRoots(target: string, boundary: TaskBoundary): boolean {
  if (boundary.allowedRoots.length === 0) {
    return true;
  }
  return !boundary.allowedRoots.some((root) => isPathWithinRoot(target, root));
}

/** パスをディレクトリ区切り文字で分割する（`/` と `\` の両方。Windowsのパスも対象にするため）。 */
function pathSegments(value: string): string[] {
  return value.split(/[\\/]/u);
}

/**
 * `.git` をパスセグメントとして含むか。大文字小文字を無視する。
 *
 * macOS既定のAPFSはファイル名の大文字小文字を区別しないため、`.GIT` という表記でも
 * 実際には同じディレクトリを指しうる（実測で指摘された回避経路）。Linuxでは大文字小文字を
 * 区別する別ディレクトリになり実害は無いが、多層防御として区別しない側に倒す。
 */
function hasGitSegment(value: string): boolean {
  return pathSegments(value).some((seg) => seg.toLowerCase() === '.git');
}

/**
 * `.git` 配下への書き込みか。パス中のどこかに `.git` セグメントがあれば、`allowedRoots` や
 * `gitCommonDir` との位置関係を問わず即座に該当とする。worktreeの `.git` は実体がファイルで、
 * hooksなどの実データは親リポジトリの共有領域（`gitCommonDir`）にあるため、こちらも別途見る
 * （§16.7）。
 */
function touchesGitDirectory(target: string, boundary: TaskBoundary): boolean {
  if (hasGitSegment(target)) {
    return true;
  }
  return boundary.gitCommonDir !== undefined && isPathWithinRoot(target, boundary.gitCommonDir);
}

/** 絶対パスらしいトークンか（`/` 始まり、またはWindowsのドライブレター `C:\` `C:/`）。 */
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:[\\/]/;
function looksAbsolutePath(token: string): boolean {
  return token.startsWith('/') || WINDOWS_DRIVE_PATTERN.test(token);
}

/** `..` をパスセグメントとして含むか（相対パスでの境界越え）。 */
function hasParentSegment(token: string): boolean {
  return pathSegments(token).includes('..');
}

/**
 * コマンド引数のうち「パスらしい」トークンを拾う。完全なシェル解析はしない方針
 * （§16.7）のため、フラグ（`-C` 等）や普通の相対ファイル名（`archive.tar` 等）まで
 * 拾うと過検知になる。次の3条件のいずれかに絞る（実測で指摘された回避経路への対応）。
 *
 * - 絶対パスらしい（`/` 始まり、またはWindowsのドライブレター）
 * - `..` を含む（相対パスでの境界越え）
 * - `.git` をパスセグメントとして含む（`cwd` 相対の書き込み先でも拾うため）
 */
function extractPathLikeArguments(command: string): string[] {
  return rawTokenize(command).filter(
    (t) => looksAbsolutePath(t) || hasParentSegment(t) || hasGitSegment(t),
  );
}

/**
 * パスらしいトークンを実パスへ解決する。絶対パスはそのまま正規化するだけ、相対パスは
 * `cwd` を基準に解決する。`cwd` が不明（空文字）で相対パスなら判定不能として `undefined`
 * を返す（`process.cwd()` には依存しない。環境によって結果が変わる純粋関数にしないため）。
 */
function resolveArgumentPath(token: string, cwd: string): string | undefined {
  if (looksAbsolutePath(token)) {
    return path.normalize(token);
  }
  return cwd === '' ? undefined : path.resolve(cwd, token);
}

/**
 * `command` 種別で判定対象になるパス。`cwd` 自身に加えて、コマンド引数から拾った
 * パスらしいトークンを解決したものを含める。シェルメタ文字を含まない単純な
 * `cp` / `chmod` / `tar` 等でも、引数に指定した書き込み先は境界チェックの対象にする
 * （実測で指摘された回避経路: `cp payload.sh .git/hooks/pre-commit`）。
 */
function commandCandidatePaths(request: EscalationRequest): readonly string[] {
  const paths: string[] = [];
  if (request.cwd !== '') {
    paths.push(request.cwd);
  }
  for (const token of extractPathLikeArguments(request.command)) {
    const resolved = resolveArgumentPath(token, request.cwd);
    if (resolved !== undefined) {
      paths.push(resolved);
    }
  }
  return paths;
}

/** 判定対象のパス群。`command` は `cwd` とコマンド引数由来のパスを、`fileChange` は `paths` を見る。 */
function targetPathsOf(request: EscalationRequest): readonly string[] {
  if (request.kind === 'command') {
    return commandCandidatePaths(request);
  }
  if (request.kind === 'fileChange') {
    return request.paths;
  }
  return [];
}

function isAllowed(policy: EscalationPolicy, id: DangerPatternId): boolean {
  return policy.allow.includes(id);
}

/**
 * `escalate` の判定に使う検索対象文字列。`command` / `cwd` / `paths` に加えて、
 * 構造化フィールド（ネットワーク到達先のホスト、`grantRoot`、execpolicyの提案）も
 * 含める。「このタスクは外部通信を許可するが特定のホストだけは人に回したい」のような
 * escalateが、コマンド文字列に現れない構造化データに対しても効くようにするため（§16.7）。
 */
function buildEscalateHaystack(request: EscalationRequest): string {
  const parts = [
    request.command,
    request.cwd,
    ...request.paths,
    request.networkApprovalContext?.host ?? '',
    ...request.proposedNetworkPolicyAmendments.map((a) => a.host),
    request.grantRoot ?? '',
    ...request.proposedExecpolicyAmendment,
  ];
  return parts.join('\n').toLowerCase();
}

/** 理由文字列に埋め込む値の上限長。長大な値でログ・ワークフローViewの表示が崩れるのを防ぐ。 */
const REASON_VALUE_MAX_LEN = 200;

/**
 * 理由に埋め込む値の無害化。`grantRoot` やホスト名、パスはapp-server・エージェント
 * 由来で内容を信用できない。改行や制御文字を含んでいると、理由がそのまま複数行になったり
 * ログ・ワークフローViewの表示を崩したりする。HTMLエスケープはView側の責務
 * （design.md §16.8）なのでここでは行わない。
 */
function sanitizeForReason(value: string): string {
  let normalized = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    normalized += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  const collapsed = normalized.replace(/ {2,}/gu, ' ').trim();
  return collapsed.length > REASON_VALUE_MAX_LEN
    ? `${collapsed.slice(0, REASON_VALUE_MAX_LEN)}…`
    : collapsed;
}

/**
 * 承認要求を `auto` / `ask` に振り分ける。
 *
 * 判定の原則（§16.7）: 迷ったら `ask`。パターンに部分一致した時点で `ask` にする。
 * `.git` 配下への書き込みと `permissions` 種別は `allow` でも解除できない。
 * `escalate` は常に安全側（`ask` を増やす方向）にしか働かない。
 */
export function classifyApprovalRequest(
  request: EscalationRequest,
  boundary: TaskBoundary,
  policy: EscalationPolicy,
): EscalationResult {
  if (!policy.autoApprove) {
    return { decision: 'ask', reasons: ['autoApproveが無効なため、全ての承認要求を人へ回します'] };
  }

  if (request.kind === 'unknown') {
    return { decision: 'ask', reasons: ['要求の種別が不明なため安全側にしました'] };
  }

  if (request.kind === 'permissions') {
    return {
      decision: 'ask',
      reasons: ['権限そのものの変更は常に確認が必要です（allowでは解除できません）'],
    };
  }

  // commandExecutionのcommandは必須でもnull非許容でもない（実測、§16.7）。
  // 空・欠落は「判定に失敗した」ものとして扱い、パターンidを介さず無条件でaskにする
  // （unknown種別・.git配下・permissions種別と同じく allow で解除できる余地を作らない）。
  if (request.kind === 'command' && request.command.trim() === '') {
    return {
      decision: 'ask',
      reasons: [
        'コマンド文字列を取得できないため、判定に失敗したものとして扱いました（allowでは解除できません）',
      ],
    };
  }

  // fileChangeのitemIdからパスを解決するのは実行層の責務（§16.7）。ここを実装し忘れると
  // pathsが空のまま渡ってきて、パス境界の判定が丸ごと素通りしてautoに倒れる。
  // その失敗モードを判定関数側でも防ぐため、pathsが空なら「判定に失敗した」ものとして扱う。
  if (request.kind === 'fileChange' && request.paths.length === 0) {
    return {
      decision: 'ask',
      reasons: [
        '変更対象のパスを取得できないため、判定に失敗したものとして扱いました（allowでは解除できません）',
      ],
    };
  }

  const reasons: string[] = [];

  // grantRootは1回分の変更承認ではなく、セッション残り全体への書き込み許可要求
  // （FileChangeRequestApprovalParams.grantRoot）。.git配下・permissions種別と
  // 同じ権限拡大の重さがあるため、allowでは解除できない扱いにする。
  if (request.grantRoot !== undefined && request.grantRoot !== '') {
    reasons.push(
      `セッション残り全体への書き込み許可要求です（allowでは解除できません）: ${sanitizeForReason(request.grantRoot)}`,
    );
  }

  // execpolicyの修正提案は「以後、同種のコマンドを無確認で通す」という提案。
  // ネットワークの許可提案が特定のホストに閉じるのに対し、こちらは対象がコマンド全般に
  // 及ぶため、externalEgressのような特定カテゴリのallowでは緩められない扱いにする。
  if (request.proposedExecpolicyAmendment.length > 0) {
    reasons.push(
      `以後同種のコマンドを無確認で通す提案が付いています（allowでは解除できません）: ${sanitizeForReason(request.proposedExecpolicyAmendment.join(' '))}`,
    );
  }

  const gitTarget = targetPathsOf(request).find(
    (p) => p !== '' && touchesGitDirectory(p, boundary),
  );
  if (gitTarget !== undefined) {
    reasons.push(
      `.git配下への書き込みです（allowでは解除できません）: ${sanitizeForReason(gitTarget)}`,
    );
  } else if (
    request.kind === 'command' &&
    extractPathLikeArguments(request.command).some(
      (t) => hasGitSegment(t) && resolveArgumentPath(t, request.cwd) === undefined,
    )
  ) {
    // cwdが不明で相対パスを実パスへ解決できなくても、引数に`.git`セグメントを含む
    // トークンがある時点で十分に疑わしい（実測で指摘された回避経路）。resolve可否に
    // 関わらず、この独立したチェックで拾う。
    reasons.push('.git配下への書き込みの疑いがあるコマンド引数です（allowでは解除できません）');
  }

  if (!isAllowed(policy, DANGER_PATTERN_IDS.outsideWorkingDirectory)) {
    const outsideTarget = targetPathsOf(request).find((p) => isOutsideAllowedRoots(p, boundary));
    if (outsideTarget !== undefined) {
      reasons.push(`作業ディレクトリ・worktreeの境界外です: ${sanitizeForReason(outsideTarget)}`);
    }
  }

  if (request.kind === 'command') {
    for (const pattern of DANGER_COMMAND_PATTERNS) {
      if (!isAllowed(policy, pattern.id) && pattern.test(request.command)) {
        reasons.push(`既定の停止条件に一致しました: ${pattern.description}`);
      }
    }

    // ネットワーク到達は文字列照合（curl/wget/nc）より、app-server自身が渡してくる
    // 構造化データのほうが確実に拾える。externalEgressと同じidで allow を共有する。
    if (!isAllowed(policy, DANGER_PATTERN_IDS.externalEgress)) {
      const ctx = request.networkApprovalContext;
      if (ctx !== undefined) {
        reasons.push(
          `外部ネットワークへの到達が申告されています: ${sanitizeForReason(ctx.host)} (${sanitizeForReason(ctx.protocol)})`,
        );
      }
      const allowAmendment = request.proposedNetworkPolicyAmendments.find(
        (a) => a.action === 'allow',
      );
      if (allowAmendment !== undefined) {
        reasons.push(
          `このホストを以後許可する恒久的な権限拡大が提案されています: ${sanitizeForReason(allowAmendment.host)}`,
        );
      }
    }
  }

  const haystack = buildEscalateHaystack(request);
  for (const raw of policy.escalate) {
    const pattern = raw.trim();
    if (pattern !== '' && haystack.includes(pattern.toLowerCase())) {
      reasons.push(`escalateで指定されたパターンに一致しました: ${sanitizeForReason(pattern)}`);
    }
  }

  if (reasons.length === 0) {
    return { decision: 'auto', reasons: ['既定の停止条件に該当しませんでした'] };
  }
  return { decision: 'ask', reasons };
}
