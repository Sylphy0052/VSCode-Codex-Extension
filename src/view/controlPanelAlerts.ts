import type { HooksSnapshot } from '../provider/hooks';
import type { McpServersSnapshot } from '../provider/mcpServers';
import type { SectionId } from './settingsProvider';

/**
 * 設定パネルの先頭に出す「異常のまとめ」（issue #741）。
 *
 * hooksもMCPも折りたたまれた`<details>`の中にしか出ておらず、開かない限り気付けない。
 * hooksは任意のコマンドを実行する仕組みで、プロジェクト側で定義されたhookはcloneしただけで
 * 任意コマンドが動く経路になりうる（`controlPanelView.ts`の注記）。「開けば分かる」では
 * 気付く保証が無いので、最上部へ引き上げる。
 *
 * 判定はここ（ホスト側・TypeScript）で行い、webviewへは結果だけを渡す。
 * `controlPanelScript.ts`はテンプレートリテラルの中の素のJSで、型検査もlintも効かない。
 *
 * 1本だけ出す。複数並べると帯自体が場所を取り、いちばん重い異常が埋もれる。
 */

/** 帯の見た目。`warning`は黄色、`error`は`errorForeground`。 */
export type PanelAlertSeverity = 'warning' | 'error';

export interface PanelAlert {
  readonly message: string;
  /** クリックしたときに開くセクション。 */
  readonly sectionId: SectionId;
  readonly severity: PanelAlertSeverity;
}

/** 判定に使う分だけを受け取る。プロバイダ2つ分をまとめて渡す。 */
export interface PanelAlertInput {
  readonly codexHooks: HooksSnapshot;
  readonly claudeHooks: HooksSnapshot;
  readonly codexMcp: McpServersSnapshot;
  readonly claudeMcp: McpServersSnapshot;
  /**
   * 一度でも取得したセクション（`SettingsProvider.loaded`）。
   *
   * 未取得のセクションは`{ ok: false, reason: 'まだ読み込んでいません' }`のままで、
   * 取得に失敗した状態と形が区別できない。ここに載っていないセクションは判定から外す。
   * hooksは折りたたまれていても先に読む（`controlPanelView.ts`）ので、常に載る。
   */
  readonly loadedSections: ReadonlySet<SectionId>;
}

/**
 * いちばん重い異常を1件返す。異常が無ければ`undefined`。
 *
 * 重い順は「未信頼・改変されたhook」＞「接続できていないMCPサーバー」＞「読み込みに失敗した
 * セクション」。前者ほど、放っておくと実害が出るまでの距離が短い。読み込み失敗を最後に置くのは、
 * CLIが古い・起動しないといった環境要因で起きることが多く、放置しても何かが実行されるわけでは
 * ないため。
 *
 * Claude Codeのhookは信頼状態を返す経路がプロトコルに無く、常に`unsupported`
 * （`src/provider/hooks.ts`）。よってhookの警告はCodex側からしか出ない。Claude側で
 * 出せるのはMCPの接続失敗と読み込み失敗だけで、これは実装の手抜きではなくCLIが返す情報の差。
 */
export function buildPanelAlert(input: PanelAlertInput): PanelAlert | undefined {
  const untrusted = countUntrustedHooks(input.codexHooks) + countUntrustedHooks(input.claudeHooks);

  if (untrusted > 0) {
    return {
      message: `未信頼または改変されたhookが${untrusted}件あります`,
      // 信頼状態を持つのはCodexだけなので、飛ぶ先もCodex側に決まる
      sectionId: 'codexHooks',
      severity: 'error',
    };
  }

  const codexUnavailable = countUnavailableServers(input.codexMcp);
  const claudeUnavailable = countUnavailableServers(input.claudeMcp);
  const unavailable = codexUnavailable + claudeUnavailable;
  if (unavailable > 0) {
    return {
      message: `起動していないMCPサーバーが${unavailable}件あります`,
      sectionId: codexUnavailable > 0 ? 'codexMcp' : 'claudeMcp',
      severity: 'warning',
    };
  }

  const failed = failedSection(input);
  if (failed !== undefined) {
    return {
      message: `${failed.label}の読み込みに失敗しました`,
      sectionId: failed.sectionId,
      severity: 'warning',
    };
  }

  return undefined;
}

/**
 * 未信頼・改変されたhookの数。
 *
 * `managed`（組織が配布したもの）と`unsupported`（Claude Codeのように信頼状態を返さない）は
 * 数えない。前者は人が承認する対象ではなく、後者は「未信頼だと分かった」わけではないため。
 * 無効なhook（`enabled === false`）も数えない。実行されないものを警告しても手が無い。
 */
function countUntrustedHooks(snapshot: HooksSnapshot): number {
  if (!snapshot.ok) {
    return 0;
  }
  return snapshot.hooks.filter(
    (hook) => hook.enabled && (hook.trust === 'untrusted' || hook.trust === 'modified'),
  ).length;
}

/** 起動していないMCPサーバーの数。無効化されたもの（`disabled`）は人が選んだ状態なので数えない。 */
function countUnavailableServers(snapshot: McpServersSnapshot): number {
  if (!snapshot.ok) {
    return 0;
  }
  return snapshot.servers.filter((server) => server.state === 'unavailable').length;
}

/**
 * 読み込みに失敗したセクションのうち、いちばん先に出てくるもの。
 *
 * まだ取得していないセクションは対象外（`PanelAlertInput.loadedSections`）。
 */
function failedSection(
  input: PanelAlertInput,
): { label: string; sectionId: SectionId } | undefined {
  const candidates: ReadonlyArray<{
    snapshot: HooksSnapshot | McpServersSnapshot;
    label: string;
    sectionId: SectionId;
  }> = [
    { snapshot: input.codexHooks, label: 'Codexのhooks', sectionId: 'codexHooks' },
    { snapshot: input.claudeHooks, label: 'Claude Codeのhooks', sectionId: 'claudeHooks' },
    { snapshot: input.codexMcp, label: 'CodexのMCPサーバー', sectionId: 'codexMcp' },
    { snapshot: input.claudeMcp, label: 'Claude CodeのMCPサーバー', sectionId: 'claudeMcp' },
  ];
  const found = candidates.find(
    (candidate) => input.loadedSections.has(candidate.sectionId) && !candidate.snapshot.ok,
  );
  return found === undefined ? undefined : { label: found.label, sectionId: found.sectionId };
}
