import type { LocateResult } from '../codex/cliLocator';
import type { LaunchTarget, SessionSummary } from '../codex/types';
import type { ListOptions, ListResult } from '../session/sessionStore';
import type { ProviderId } from './id';

export { PROVIDER_IDS, isProviderId, type ProviderId } from './id';

/**
 * プロバイダごとに「できること」が違う。
 * Claude Code には archive/delete に相当するCLIが無いため、UIの出し分けに使う。
 */
export interface ProviderCapabilities {
  /** セッション全体の分岐。 */
  fork: boolean;
  /** 会話の途中のターンを指定した分岐。 */
  forkFromTurn: boolean;
  archive: boolean;
  delete: boolean;
  /** セッション名の変更をCLI側へ永続化できるか。 */
  rename: boolean;
}

/** TUIタブとして起動するために必要な材料。 */
export interface LaunchSpec {
  /** 実行ファイル名を含まない引数列。シェルを経由しないためエスケープは不要。 */
  args: string[];
  env: Record<string, string>;
  /**
   * 起動前に確定しているセッションid。
   * Codexは起動後の事後紐付けになるため undefined になる（設計書 §9.1）。
   */
  sessionId: string | undefined;
  /** 無視した設定値。呼び出し側でログに残す。 */
  warnings: string[];
}

export interface LaunchInput {
  target: LaunchTarget;
  cwd: string | undefined;
  /**
   * 起動ごとの一意なタグ。Codexは環境変数で渡して事後紐付けに使う（設計書 §9.1）。
   * idを起動前に決められるプロバイダは使わない。
   */
  tag: string;
  /** resume時など、CLIへ渡せる表示名。 */
  name?: string | undefined;
}

/**
 * CLIエージェント1種類分の境界。
 *
 * 拡張機能の他の層はこのインターフェースだけを見る。CLI固有の事情
 * （ファイル配置・引数・紐付け方法）はここから先に出さない。
 */
export interface AgentProvider {
  readonly id: ProviderId;
  /** 通知や一覧に出す名前。 */
  readonly label: string;
  readonly capabilities: ProviderCapabilities;
  /** 導入手順の案内先。 */
  readonly installUrl: string;
  /** 実行ファイルのパスを指定する設定キー。未検出時の案内に使う。 */
  readonly executableSettingKey: string;

  locate(): LocateResult;
  listSessions(options: ListOptions): Promise<ListResult>;
  buildLaunch(input: LaunchInput): LaunchSpec;
  /** 一覧に出すタブ名。プロバイダ名を接頭辞に付ける。 */
  tabTitle(session: Pick<SessionSummary, 'id' | 'threadName'>): string;
}
