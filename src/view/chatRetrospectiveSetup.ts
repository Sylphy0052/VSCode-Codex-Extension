import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';

import { ChatConversationTracker } from '../chat/chatConversationTracker';
import { createChatSegmentRecorder } from '../chat/chatRetrospective';
import { readChatRetrospectiveSettingsRaw, readSelfImproveSourcesRaw } from '../config';
import { normalizeChatRetrospectiveSettings } from '../orchestrator/retrospectiveMetrics/chat';
import type { RunRetrospective } from '../orchestrator/runRetrospective';
import { RUN_METRICS_DIR_NAME } from '../orchestrator/runMetricsStore';
import type { RunNotesStore } from '../orchestrator/runNotes';
import { normalizeRetrospectiveSources } from '../orchestrator/runSummary';

/** 会話の区切りを追わせる画面（`BaseChatViewManager`）。 */
export interface ChatConversationHost {
  setConversationTracker(tracker: ChatConversationTracker): void;
}

export interface ChatRetrospectiveSetupDeps {
  hosts: readonly ChatConversationHost[];
  retrospective: Pick<RunRetrospective, 'onRunFinished'>;
  runNotes: RunNotesStore | undefined;
  globalStorageDir: string;
  extensionVersion: string;
  log(message: string): void;
}

/**
 * 通常チャットの会話を区切って振り返る（Issue #2123）。Codex・Claudeの画面で1つの追跡器を共有し、
 * 区切りを指標・教訓・振り返りへ渡す。返したDisposableはタイマーを止める。
 */
export function setupChatRetrospective(deps: ChatRetrospectiveSetupDeps): vscode.Disposable {
  const settings = (): ReturnType<typeof normalizeChatRetrospectiveSettings> =>
    normalizeChatRetrospectiveSettings(readChatRetrospectiveSettingsRaw());
  const record = createChatSegmentRecorder({
    metricsDir: path.join(deps.globalStorageDir, RUN_METRICS_DIR_NAME),
    extensionVersion: deps.extensionVersion,
    claudeHome: path.join(os.homedir(), '.claude'),
    sources: () => normalizeRetrospectiveSources(readSelfImproveSourcesRaw()),
    settings,
    runNotes: deps.runNotes,
    retrospective: deps.retrospective,
    log: deps.log,
  });
  const tracker = new ChatConversationTracker({
    idleMs: () => settings().idleMinutes * 60_000,
    onSegment: (segment, finishedAt) => {
      void record(segment, finishedAt);
    },
  });
  for (const host of deps.hosts) {
    host.setConversationTracker(tracker);
  }
  return { dispose: () => tracker.dispose() };
}
