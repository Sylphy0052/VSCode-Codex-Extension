import * as vscode from 'vscode';
import type { WorkflowTestApiLike } from './workflow';

export const EXTENSION_ID = 'Sylphy0052.vscode-codex-extension';

/**
 * `src/extension.ts` の `SessionTreeProvider` が実際に公開しているメンバのうち、
 * 統合テストが使う部分だけを構造的に写した型。`tsconfig.integration.json` の
 * `rootDir` の都合で `src/**` を直接importできないため、ここでは実物と構造互換な
 * 最小限の宣言だけを持つ（実行時は `activate()` が返した本物のインスタンスを渡す）。
 */
export interface SessionSummaryLike {
  id: string;
  provider: 'codex' | 'claude';
  threadName?: string;
  updatedAt: string;
  cwd?: string;
  archived: boolean;
}

export interface SessionTreeLike {
  getChildren(): Promise<SessionSummaryLike[]>;
  getTreeItem(session: SessionSummaryLike): vscode.TreeItem;
  setScope(scope: 'workspace' | 'all'): Promise<void>;
}

/**
 * VSCodeに依存する層（`view/**`）はユニットテストから触れないため（設計書 §11）、
 * `activate()` の戻り値経由でTreeDataProviderの実インスタンスを受け取る
 * （`src/extension.ts` の `ExtensionTestApi` 参照）。
 */
export interface ExtensionTestApi {
  readonly sessionTree: SessionTreeLike;
  /**
   * ワークフロー（design.md §16）用の口。`AGENT_SESSIONS_INTEGRATION_TEST=1` が
   * 立っているときだけ実体が入る（`src/extension.ts` の `WorkflowTestApi`、Issue #158）。
   */
  readonly workflow?: WorkflowTestApiLike;
}

/** 拡張機能を（未活性なら）有効化し、テスト用APIを返す。 */
export async function activateExtension(): Promise<ExtensionTestApi> {
  const ext = vscode.extensions.getExtension<ExtensionTestApi>(EXTENSION_ID);
  if (ext === undefined) {
    throw new Error(
      `拡張機能 ${EXTENSION_ID} が見つからない（package.jsonのpublisher/nameを確認）`,
    );
  }
  return ext.isActive ? ext.exports : await ext.activate();
}
