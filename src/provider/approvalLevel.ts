import type { ProviderId } from './id';

/**
 * CodexとClaude Codeで共通に扱う承認レベル（3段階）。
 *
 * Codexは「承認方針(`approval_policy`)」と「サンドボックス(`sandbox_mode`)」の2軸、
 * Claude Codeは`permissionMode`の1軸で承認を決める（docs/approval-modes.md）。
 * 語彙が食い違うため、画面で選ぶときにどちらのプロバイダを触っているかで意味を
 * 読み替える必要があった。ここで両者の上に共通の3段階を置き、プロバイダごとの値へは
 * このモジュールだけが展開する。
 *
 * **宣言順がそのまま安全順**（`ask` → `auto` → `full`）。Shift+Tabの循環がこの順序に
 * 依存する。生の値の安全順（`APPROVAL_MODES` / `SANDBOX_MODES` /
 * `CLAUDE_PERMISSION_SAFETY_ORDER`）はこれまで通り各所で使う。レベルは生の値へ
 * 展開してから既存のクランプ（`src/util/safetyClamp.ts`）に乗るため、クランプ側は
 * レベルを知らない。
 */
export const APPROVAL_LEVELS = ['ask', 'auto', 'full'] as const;
export type ApprovalLevel = (typeof APPROVAL_LEVELS)[number];

export function isApprovalLevel(value: unknown): value is ApprovalLevel {
  return typeof value === 'string' && (APPROVAL_LEVELS as readonly string[]).includes(value);
}

/** 画面に出す表示名。 */
export const APPROVAL_LEVEL_LABELS: Record<ApprovalLevel, string> = {
  ask: '全確認',
  auto: 'Auto（承認をエージェントに任せる）',
  full: '全承認',
};

/** 表示名の下に添える1行説明。 */
export const APPROVAL_LEVEL_DESCRIPTIONS: Record<ApprovalLevel, string> = {
  ask: '読み取り以外は都度確認する',
  auto: '承認の可否をエージェント自身が判定する',
  full: '確認を一切せず実行する',
};

/**
 * レベルを展開したCodexの設定値。`src/codex/types.ts`の`CodexConfig`のうち
 * 承認に関わる3項目にあたる。
 */
export interface CodexApprovalSettings {
  approvalMode: string;
  sandbox: string;
  /** 承認要求を誰へ回すか。`auto`のときだけ`auto_review`になる。 */
  approvalsReviewer: string;
}

/**
 * 承認レベルをCodexの設定値へ展開する。
 *
 * - `ask` — `untrusted` + `workspace-write`。信頼済みの読み取りコマンド以外は全て
 *   承認カードへ回り、承認すれば作業フォルダ内を変更できる。Claudeの`manual`と揃う。
 * - `auto` — `on-request` + `workspace-write` + `auto_review`。承認要求はCodex内部の
 *   自動レビュー(Guardian)が判定する。Claudeの`auto`に最も近い挙動
 *   （docs/approval-modes.md の`--approve-for-me`の項）。
 * - `full` — `never` + `danger-full-access`。承認カードが一切出ない。
 *   `isUnsafeCombination`が検出する危険な組み合わせそのものであり、選ぶときは
 *   明示の同意を取る。
 *
 * `full`に`--dangerously-bypass-approvals-and-sandbox`（`bypassApprovalsAndSandbox`）を
 * 使わないのは、あちらが`thread/start`では表現できずターンごとの`sandboxPolicy`送信に
 * なるうえ、既存の別軸の設定と二重になるため。保護を全て外す点では同じ状態になる。
 */
export function codexSettingsForLevel(level: ApprovalLevel): CodexApprovalSettings {
  switch (level) {
    case 'ask':
      return { approvalMode: 'untrusted', sandbox: 'workspace-write', approvalsReviewer: 'user' };
    case 'auto':
      return {
        approvalMode: 'on-request',
        sandbox: 'workspace-write',
        approvalsReviewer: 'auto_review',
      };
    case 'full':
      return {
        approvalMode: 'never',
        sandbox: 'danger-full-access',
        approvalsReviewer: 'user',
      };
  }
}

/**
 * 承認レベルをClaude Codeの`permissionMode`へ展開する。
 *
 * `acceptEdits` / `plan` / `dontAsk`はこの3段階に対応する値を持たない。3段階から
 * 選んだときにそれらへ落ちることは無く、詳細から直接選んだときだけ効く（その場合は
 * `levelFromClaudePermissionMode`が`undefined`を返し、画面は「カスタム」になる）。
 */
export function claudePermissionModeForLevel(level: ApprovalLevel): string {
  switch (level) {
    case 'ask':
      return 'manual';
    case 'auto':
      return 'auto';
    case 'full':
      return 'bypassPermissions';
  }
}

/**
 * Codexの現在の設定値がどのレベルにあたるかを引く。
 *
 * 3項目が揃って一致したときだけレベルを返す。1つでもずれていれば`undefined`
 * （＝画面では「カスタム」）。`approvalsReviewer`が空文字のときはCodex側の既定
 * （`user`）として扱う。空文字の`approvalMode` / `sandbox`（CLIのconfig.tomlへ委譲）は
 * 何が効くか拡張機能側では決められないため、どのレベルにも一致させない。
 */
export function levelFromCodexSettings(settings: CodexApprovalSettings): ApprovalLevel | undefined {
  const reviewer = settings.approvalsReviewer === '' ? 'user' : settings.approvalsReviewer;
  return APPROVAL_LEVELS.find((level) => {
    const expected = codexSettingsForLevel(level);
    return (
      expected.approvalMode === settings.approvalMode &&
      expected.sandbox === settings.sandbox &&
      expected.approvalsReviewer === reviewer
    );
  });
}

/** Claude Codeの`permissionMode`がどのレベルにあたるかを引く。 */
export function levelFromClaudePermissionMode(mode: string): ApprovalLevel | undefined {
  return APPROVAL_LEVELS.find((level) => claudePermissionModeForLevel(level) === mode);
}

/**
 * Shift+Tabで回す承認レベルの並び。
 *
 * **`full`（全承認）は含めない。** 確認なしでツールが動く状態であり、キーを連打していて
 * 到達してよいものではない（承認レベルを入れる前の循環が`bypassPermissions`を外していたのと
 * 同じ理由。issue #13）。セレクタからは明示の同意を取ったうえで選べる。
 */
export const APPROVAL_LEVEL_CYCLE: readonly ApprovalLevel[] = ['ask', 'auto'];

/**
 * 次の承認レベルを返す。現在値が循環に無い場合（カスタム、または`full`）は
 * **先頭へ進む**。いまどこにいるか画面から判らない状態から、いちばん厳しいところへ寄せる
 * （`nextApprovalMode`と同じ考え方）。
 */
export function nextApprovalLevel(current: ApprovalLevel | undefined): ApprovalLevel {
  // 循環に無い値（`indexOf`が-1）は (-1 + 1) % length === 0 で先頭へ落ちる
  const index = current === undefined ? -1 : APPROVAL_LEVEL_CYCLE.indexOf(current);
  return APPROVAL_LEVEL_CYCLE[(index + 1) % APPROVAL_LEVEL_CYCLE.length] ?? APPROVAL_LEVELS[0];
}

/**
 * そのレベルが「保護を全て外した状態」か。選ぶ前に明示の同意を取るかどうかの判定に使う
 * （Codexは`isUnsafeCombination`、Claudeは`bypassPermissions`の確認と同じ位置づけ）。
 */
export function isUnsafeLevel(level: ApprovalLevel): boolean {
  return level === 'full';
}

/** Webviewへ渡す1レベル分の表示情報。 */
export interface ApprovalLevelMetaEntry {
  label: string;
  description: string;
  /** プロバイダごとの、そのレベルで実際に効く値。 */
  effective: Record<ProviderId, string>;
}

/**
 * Webviewのスクリプトへ渡す表示情報をまとめる。
 *
 * WebviewのJSはテンプレートリテラルの中身で型検査が効かないため、表示名や説明を
 * あちらへ書き写すと定義が二重になる。ここで組み立てた値をJSONとして注入し、
 * 定義元をこのモジュールだけに保つ。
 */
export function approvalLevelMeta(): Record<ApprovalLevel, ApprovalLevelMetaEntry> {
  const entries = APPROVAL_LEVELS.map((level) => [
    level,
    {
      label: APPROVAL_LEVEL_LABELS[level],
      description: APPROVAL_LEVEL_DESCRIPTIONS[level],
      effective: {
        codex: describeLevel('codex', level),
        claude: describeLevel('claude', level),
      },
    },
  ]);
  return Object.fromEntries(entries) as Record<ApprovalLevel, ApprovalLevelMetaEntry>;
}

/** プロバイダごとの、そのレベルで実際に効く値の説明（画面のヒントに出す）。 */
export function describeLevel(provider: ProviderId, level: ApprovalLevel): string {
  if (provider === 'claude') {
    return `permission-mode: ${claudePermissionModeForLevel(level)}`;
  }
  const s = codexSettingsForLevel(level);
  const reviewer = s.approvalsReviewer === 'auto_review' ? ' / 自動レビュー' : '';
  return `${s.approvalMode} / ${s.sandbox}${reviewer}`;
}
