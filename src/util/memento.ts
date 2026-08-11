/**
 * `vscode.Memento` と構造的に一致する最小限の口。`context.workspaceState` /
 * `context.globalState` をそのまま渡せる。
 *
 * `src/orchestrator/runStore.ts` の `WorkflowRunMemento` と `src/provider/inputModes.ts` の
 * `MemoryModeMemento` が同型の定義を重複して持っていたため、こちらへ1本化した
 * （両ファイルはこの型を再export し、既存の型名のまま使い続けられる）。
 */
export interface MementoLike {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}
