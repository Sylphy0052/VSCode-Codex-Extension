/**
 * hooksの一覧・信頼状態表示（TP-52、issue #28）で共有する型。
 *
 * CodexとClaude Codeでプロトコルの形も、扱える情報の粒度もまったく違う（`src/codex/hooksStatus.ts` /
 * `src/claude/hooksSettings.ts` を参照）が、画面へ渡す最終形はここへ揃える。
 * 設定パネル（`src/view/controlPanelScript.ts`）はこの形だけを見ればよい。
 *
 * hooksは任意のコマンドを実行する仕組みで、特にプロジェクト側（リポジトリ内）で定義された
 * hookはcloneしただけで任意コマンドが動く経路になりうる。中身を隠さず全部見せる方針のため、
 * 一部のフィールド（`command` / `originDetail`）は取れる限り常に持つ。
 */

/**
 * どこで定義されたか。
 *
 * Codexの `HookSource`（実測。`codex app-server generate-json-schema` が根拠）をそのまま使う。
 * Claude Codeは `user` / `project` / `unknown` の3つしか区別できない（実測。`hooksSettings.ts` の
 * コメントを参照）ため、この型の部分集合として扱う。
 */
export type HookOrigin =
  | 'system'
  | 'user'
  | 'project'
  | 'mdm'
  | 'sessionFlags'
  | 'plugin'
  | 'cloudRequirements'
  | 'cloudManagedConfig'
  | 'legacyManagedConfigFile'
  | 'legacyManagedConfigMdm'
  | 'unknown';

/**
 * 信頼状態。
 *
 * - Codexは `trustStatus`（`managed` / `untrusted` / `trusted` / `modified`）をそのまま持つ
 * - Claude Codeは信頼状態を返す経路がプロトコルに無い（実測。新規のプロジェクトhookが
 *   承認なしで実行された）ため、常に `unsupported`
 */
export type HookTrustState = 'trusted' | 'untrusted' | 'modified' | 'managed' | 'unsupported';

export interface HookView {
  /** 表示・信頼操作に使うキー。CodexはCLIが持つ `key`、Claude Codeは位置から組み立てる。 */
  key: string;
  /** どのイベントで動くか（CLIの語彙のまま。`preToolUse` / `PreToolUse` など）。 */
  eventName: string;
  /** 対象を絞る条件（ツール名など）。持たない場合は undefined。 */
  matcher: string | undefined;
  /** `command` / `prompt` / `agent`。Claude Codeは実測範囲内では常に `command`。 */
  handlerType: string;
  /** 実行するコマンド。command以外のhandlerTypeでは undefined。 */
  command: string | undefined;
  /** どこで定義されているか。 */
  origin: HookOrigin;
  /** originの補足(ファイルパスや設定ソース名など)。取れなければ undefined。 */
  originDetail: string | undefined;
  /** プラグイン由来のときのプラグインid。それ以外は undefined。 */
  pluginId: string | undefined;
  /** 有効かどうか。 */
  enabled: boolean;
  trust: HookTrustState;
  /** 信頼を更新するために必要なハッシュ(Codexのみ)。無ければ undefined。 */
  trustHash: string | undefined;
}

/**
 * 一覧を取得できたかどうかを型で分ける。
 *
 * 空配列(0件)と「取得に失敗した」を区別しないと、CLIが古い・app-serverが起動しない・
 * 対応する経路がまだ無いといった状況で「hookは設定されていません」と誤って出してしまう
 * (design.mdの「黙って何も起きない状態を作らない」に反する)。
 */
export type HooksSnapshot =
  { ok: true; hooks: HookView[]; warnings: string[] } | { ok: false; reason: string };

/**
 * hookの key の形は実機で1件も観測できていない(この環境にはhookが1件も設定されていない
 * ため。Phase 0のコメント参照)。実在の形が不明なぶん、設定の書き込み先(config/batchWriteの
 * keyPath)へそのまま埋め込む前の防御をやや広めに取る。TOMLのキー構造を壊しうる二重引用符・
 * バックスラッシュと、空白・制御文字だけを拒否するブラックリストにする。
 */
const QUOTE_CHAR_CODE = 34;
const BACKSLASH_CHAR_CODE = 92;

export function isValidHookKey(value: unknown): value is string {
  if (typeof value !== 'string' || value === '') {
    return false;
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const isControlOrSpace = code <= 32;
    const isQuoteOrBackslash = code === QUOTE_CHAR_CODE || code === BACKSLASH_CHAR_CODE;
    if (isControlOrSpace || isQuoteOrBackslash) {
      return false;
    }
  }
  return true;
}
