/**
 * `vscode.Memento` と構造的に一致する最小限の口。`context.workspaceState` /
 * `context.globalState` をそのまま渡せる。
 *
 * `src/orchestrator/runStore.ts` の `WorkflowRunMemento` が同型の定義を持っていたため、
 * こちらへ1本化した（runStore.tsはこの型を再exportする）。
 */
export interface MementoLike {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}
