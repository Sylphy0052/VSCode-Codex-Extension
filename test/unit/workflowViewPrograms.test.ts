import { describe, expect, it, vi } from 'vitest';
import { ProgramRunner, type ProgramWorkflowPort } from '../../src/orchestrator/programRunner';
import { ProgramStore, type ProgramMemento } from '../../src/orchestrator/programStore';
import type { WorkflowFilePort, WorkflowRunner } from '../../src/orchestrator/runner';
import type { RunOutcome } from '../../src/orchestrator/scheduler';
import type { Logger } from '../../src/log';
import { WorkflowViewManager } from '../../src/view/workflowView';
import { __mock } from '../mocks/vscode';

/**
 * 失敗の伝播（`skipped`化）の結果がワークフローViewへ届くことの確認（design.md
 * §16.37.3のレビュー指摘F1、Issue #606）。
 *
 * `ProgramRunner`が起動したrunの終了は`workflow.onChanged`（`WorkflowRunner`側の
 * `SimpleEmitter`）を経由するが、そのリスナである`ProgramRunner.attach()`の
 * `onRunChanged`は非同期（定義ファイルの再読込を`await`する`pumpProgram`を経る）。
 * このテストは、フェイクをそのまま同期呼び出しするのではなく、`WorkflowRunner`側の
 * `onChanged`購読を実際に発火させ（`sharedWorkflow.finishRun`）、`ProgramRunner`の
 * 内部の非同期処理が実際に永続化を終える（`vi.waitFor`でポーリングする）ところまで
 * 進めてから、`WorkflowViewManager`がWebviewへ送った内容を観測する
 * （design.md §16.25「無効なテストの一般則」の確認事項3・4: 本番の呼び出し経路を通し、
 * 途中の非同期処理を通過させてから観測する）。
 *
 * 依存する後続run（R2）が`skipped`となって連鎖が止まる**終端**のケースを選んでいる
 * （R1が`failed`→R2が`skipped`となった後、これ以上どのrunも起動しないため、以後
 * `workflow.onChanged`は発火しない）。修正前は、`WorkflowViewManager`が
 * `runner.onChanged`（実行中のrunの変化）にただ乗りして`postPrograms()`を呼んでいたため、
 * この終端ケースではR2の`skipped`化がWebviewへ永久に届かなかった。
 */

const quietLog: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  show: () => undefined,
};

function fakeMemento(): ProgramMemento {
  const store = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue: T): T {
      return (store.has(key) ? store.get(key) : defaultValue) as T;
    },
    update(key: string, value: unknown): Thenable<void> {
      store.set(key, value);
      return Promise.resolve();
    },
  };
}

function fakeFilePort(files: Record<string, string>): WorkflowFilePort {
  return {
    async fileSize(p: string): Promise<number | undefined> {
      const content = files[p];
      return content === undefined ? undefined : Buffer.byteLength(content, 'utf8');
    },
    async readTextFile(p: string): Promise<string | undefined> {
      return files[p];
    },
  };
}

/**
 * `ProgramWorkflowPort`と、`WorkflowViewManager`が使う`WorkflowRunner`の一部
 * （`onChanged` / `listLive`）を同時に満たすフェイク。本番の`WorkflowRunner`が
 * `ProgramRunner`と`WorkflowViewManager`の両方から同じインスタンスとして参照されるのと
 * 同じ配線を再現する（`extension.ts`参照）。
 */
function sharedWorkflow(): ProgramWorkflowPort & {
  finishRun: (runId: string, outcome: RunOutcome) => void;
} {
  const outcomes = new Map<string, RunOutcome>();
  let listeners: ((runId: string) => void)[] = [];
  let nextId = 0;
  return {
    async start() {
      nextId += 1;
      const runId = `run-${nextId}`;
      outcomes.set(runId, 'running');
      return { ok: true, runId };
    },
    listLive() {
      return [...outcomes.entries()].map(([runId, outcome]) => ({
        runId,
        name: '',
        defPath: '',
        outcome,
      }));
    },
    onChanged(listener) {
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((l) => l !== listener);
      };
    },
    stop() {
      // このテストでは使わない（失敗の伝播のみを確認する）
    },
    finishRun(runId, outcome) {
      outcomes.set(runId, outcome);
      for (const l of listeners) {
        l(runId);
      }
    },
  };
}

const programYaml = `
version: 1
name: F1確認用
runs:
  - id: R1
    defPath: .agents/workflows/a.yaml
  - id: R2
    defPath: .agents/workflows/b.yaml
    dependsOn: [R1]
`;

type ProgramsMessage = { type: 'programs'; programs: readonly unknown[] };

function lastProgramsMessage(sent: readonly unknown[]): ProgramsMessage | undefined {
  const messages = sent.filter(
    (m): m is ProgramsMessage =>
      typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'programs',
  );
  return messages[messages.length - 1];
}

describe('WorkflowViewManager: 失敗の伝播（skipped化）の通知（design.md §16.37.3のレビュー指摘F1、Issue #606）', () => {
  it('依存先の失敗によりR2がskippedへ倒れ、以後runの起動が無い終端ケースでも、ビューへskipped状態が届く', async () => {
    const programStore = new ProgramStore(fakeMemento());
    const filePort = fakeFilePort({ '/repo/program.yaml': programYaml });
    const workflow = sharedWorkflow();
    const programRunner = new ProgramRunner({ programStore, filePort, workflow, log: quietLog });
    programRunner.attach();

    const view = new WorkflowViewManager(workflow as unknown as WorkflowRunner, quietLog, {
      list: () => programStore.list(),
      halt: (programId) => programRunner.haltProgram(programId),
      onChanged: (listener) => programRunner.onChanged(listener),
    });
    view.show();
    const panel = __mock.createdPanels[0]!;

    const result = await programRunner.startProgram('/repo/program.yaml', '/repo');
    expect(result.ok).toBe(true);
    const programId = result.programId as string;

    // 起動直後の`programs`メッセージ: R1がrunning、R2はpending。
    // `programs`が空配列のまま（＝`postPrograms`が未発火）だと後続の`programs[0]`アクセスが
    // 無関係なTypeErrorになり、失敗の理由が読めなくなる（レビュー指摘F3、Issue #606）ため、
    // 中身を読む前にまず「1件届いているか」自体を主張しておく
    const afterStart = lastProgramsMessage(panel.webview.sent);
    expect(afterStart).toBeDefined();
    expect(afterStart!.programs).toHaveLength(1);
    const afterStartRuns = (
      afterStart!.programs[0] as { state: { runs: Record<string, { state: string }> } }
    ).state.runs;
    expect(afterStartRuns.R1?.state).toBe('running');
    expect(afterStartRuns.R2?.state).toBe('pending');

    // R1が失敗する。R2はこれに依存するため`propagateProgramFailures`によりskippedへ倒れ、
    // これ以上起動するrunが無い（=終端）ため、以後`workflow.onChanged`は発火しない
    workflow.finishRun('run-1', 'failed');

    // `onRunChanged`（`pumpProgram`を経る）が永続化を終えるまでポーリングで待つ
    // （design.md §16.25の確認事項4: 途中の非同期処理を通過させてから観測する）
    await vi.waitFor(() => {
      const persisted = programStore.find(programId);
      expect(persisted?.state.runs.R2?.state).toBe('skipped');
    });

    const finalMessage = lastProgramsMessage(panel.webview.sent);
    expect(finalMessage).toBeDefined();
    expect(finalMessage!.programs).toHaveLength(1);
    const finalRuns = (
      finalMessage!.programs[0] as {
        state: {
          runs: Record<
            string,
            { state: string; skipReason?: { kind: string; failedRunId?: string } }
          >;
        };
      }
    ).state.runs;
    expect(finalRuns.R1?.state).toBe('failed');
    expect(finalRuns.R2?.state).toBe('skipped');
    expect(finalRuns.R2?.skipReason).toEqual({ kind: 'failedDependency', failedRunId: 'R1' });

    view.dispose();
    programRunner.dispose();
  });
});
