/**
 * 他エージェントからの設定インポート（issue #36、design.md TP-57、Codex TUIの `/import` 相当）で
 * 共有する型。
 *
 * Codexのみのスコープ（issueの決定）。CLIは `externalAgentConfig/detect` で候補を検出し、
 * `externalAgentConfig/import` へ同じ形の項目をそのまま送り返すと実行できる（実測・スキーマ根拠は
 * `src/codex/importStatus.ts` 参照）。取り込みは既存の設定を書き換えうるため、実行前に必ず確認を
 * 挟む（§8のセキュリティ考慮、design.md TP-57節）。
 */

/**
 * 取り込める対象の種別（`ExternalAgentConfigMigrationItemType`。スキーマ根拠）。
 * 未知の値が来ても一覧を落とさないよう、想定外の文字列も型としては許容し、
 * ラベル解決側（`labelForImportItemType`）で `unknown` 扱いにする。
 */
export type ImportItemType =
  | 'AGENTS_MD'
  | 'CONFIG'
  | 'SKILLS'
  | 'PLUGINS'
  | 'MCP_SERVER_CONFIG'
  | 'SUBAGENTS'
  | 'HOOKS'
  | 'COMMANDS'
  | 'MEMORY'
  | 'SESSIONS';

/** 内訳（`MigrationDetails`）を項目種別ごとに数えた表示用の1グループ。 */
export interface ImportItemDetailGroup {
  kind:
    | 'skills'
    | 'hooks'
    | 'mcpServers'
    | 'plugins'
    | 'subagents'
    | 'commands'
    | 'sessions'
    | 'memory';
  count: number;
  /**
   * 代表的な名前。多い場合は先頭のみに絞る（`moreCount` に残りを出す）。
   * `memory` は実際のメモリ内容を出さない方針（§8のセッション本文の扱いと同じ考え方。
   * 中身ではなく件数だけを見せる）のため常に空。
   */
  sampleNames: string[];
  /** `sampleNames` に入れなかった残り件数。0なら省略なし。 */
  moreCount: number;
}

export interface ImportItemView {
  /** 一覧の識別・選択・インポート実行時の参照に使うキー（`itemType:cwd`）。 */
  key: string;
  itemType: ImportItemType | 'UNKNOWN';
  /** 種別の日本語ラベル。 */
  label: string;
  /** CLIが返す説明文（英語、そのまま）。何を・どこから・どこへ、が書かれている。 */
  description: string;
  /** `cwd` が無ければホーム配下（ユーザー全体）、あればそのプロジェクト配下。 */
  scope: 'home' | 'project';
  cwd: string | undefined;
  details: ImportItemDetailGroup[];
}

/**
 * 一覧を取得できたかどうかを型で分ける。
 *
 * 空配列（0件）と「取得に失敗した」を区別しないと、CLIが古い・app-serverが起動しない
 * といった状況で「インポートできるものはありません」と誤って出してしまう
 * （design.mdの「黙って何も起きない状態を作らない」に反する）。
 */
export type ImportSnapshot = { ok: true; items: ImportItemView[] } | { ok: false; reason: string };

export interface ImportHistoryItemTypeResultView {
  itemType: ImportItemType | 'UNKNOWN';
  label: string;
  successCount: number;
  failureCount: number;
  /** 失敗理由（多い場合は先頭のみ）。 */
  failureMessages: string[];
}

export interface ImportHistoryEntryView {
  importId: string;
  /** epoch ms。表示用の整形は呼び出し側（view層）が行う。 */
  completedAtMs: number;
  providerId: string | undefined;
  results: ImportHistoryItemTypeResultView[];
}

export type ImportHistorySnapshot =
  { ok: true; entries: ImportHistoryEntryView[] } | { ok: false; reason: string };

export interface ImportRunItemResult {
  itemType: ImportItemType | 'UNKNOWN';
  label: string;
  successCount: number;
  failureCount: number;
  failureMessages: string[];
}

/**
 * インポート実行の結果。
 *
 * `results: undefined` は「開始（importIdを取得）はできたが、完了通知が時間内に届かなかった」
 * 状態を表す。これは失敗ではない（実測していないため確証は無いが、Phase 0の調査で
 * インポートは非同期に進む旨のUI文言が確認されている。詳細はappServerClient.tsのコメント参照）。
 * 黙って握りつぶさず、次回の履歴一覧で確認するよう案内する。
 */
export type ImportRunResult =
  | { ok: true; importId: string; results: ImportRunItemResult[] }
  | { ok: true; importId: string; results: undefined }
  /** `error: undefined` は確認ダイアログでの取り消しを意味する（他のAccountActionResultと同じ形）。 */
  | { ok: false; error: string | undefined };

const ITEM_TYPE_LABEL: Record<ImportItemType, string> = {
  AGENTS_MD: 'Instructions（AGENTS.md）',
  CONFIG: '設定（config.toml）',
  SKILLS: 'skills',
  PLUGINS: 'plugins',
  MCP_SERVER_CONFIG: 'MCPサーバー設定',
  SUBAGENTS: 'サブエージェント',
  HOOKS: 'hooks',
  COMMANDS: 'スラッシュコマンド',
  MEMORY: 'メモリ',
  SESSIONS: '最近のセッション',
};

/** 未知の種別が来ても一覧自体は失わない（生の値をそのまま出す）。 */
export function labelForImportItemType(itemType: string): string {
  return (ITEM_TYPE_LABEL as Record<string, string | undefined>)[itemType] ?? itemType;
}

export function isKnownImportItemType(value: string): value is ImportItemType {
  return value in ITEM_TYPE_LABEL;
}

/**
 * webviewから返る選択キーの防御。
 *
 * CLIへ直接渡す値ではなく（実際にimportへ渡すのはサーバー側でキャッシュした生の項目）、
 * サーバー側キャッシュの検索キーとして使うだけだが、異常な入力（極端な長さ・制御文字）を
 * 早期に弾く。
 */
export function isValidImportItemKey(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value.length > 2000) {
    return false;
  }
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) < 32) {
      return false;
    }
  }
  return true;
}
