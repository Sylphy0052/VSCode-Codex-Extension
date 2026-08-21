import type { LocateResult } from '../codex/cliLocator';
import type { SessionSummary } from '../codex/types';
import type { ListOptions, ListResult } from '../session/sessionStore';
import type { ProviderId } from './id';

export { PROVIDER_IDS, isProviderId, type ProviderId } from './id';

/**
 * プロバイダごとに「できること」が違う。
 * Claude Code には archive/delete に相当するCLIが無いため、UIの出し分けに使う。
 *
 * `rename` は持たない（issue #218で削除）。以前は `codex/claude/provider.ts` に
 * `rename: true/false` の宣言があったが、改名メニュー（`codex.renameChat` /
 * `claude.renameChat`）はこの値を一度も参照せず常に表示しており、単なるデッドコードだった。
 * 加えて「できるか」も1個のbooleanに単純化しづらい: Codexの改名はapp-server側に永続化される
 * （`chatView.ts`の`renameActive`参照）のに対し、Claude Codeの改名（issue #199）は拡張機能
 * ローカルの`ClaudeSessionNameStore`止まりで、CLI側の`rename_session`は使っていない
 * （`claude/sessionStore.ts`のJSDoc参照。読み戻す索引が無いため）。どちらも利用者から見れば
 * 「名前を変えれば次回も残る」という同じ体験を提供できているため、素直に`true/false`へ
 * 戻すよりは、実際にUIの出し分けが必要になったときに定義し直すほうが安全と判断した。
 */
export interface ProviderCapabilities {
  /** セッション全体の分岐。 */
  fork: boolean;
  /** 会話の途中のターンを指定した分岐。 */
  forkFromTurn: boolean;
  archive: boolean;
  delete: boolean;
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
  /** 一覧に出すタブ名。プロバイダ名を接頭辞に付ける。 */
  tabTitle(session: Pick<SessionSummary, 'id' | 'threadName'>): string;
}
