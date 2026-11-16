/**
 * 通常チャットの会話の区切り（`chatConversationTracker.ts`）を、指標・教訓・振り返りへつなぐ
 * （Issue #2123）。
 *
 * 1. 設定`agent.orchestrator.selfImprove.sources`に`chat`が無ければ何もしない（指標も教訓も残さない）
 * 2. 選別条件（タスク管理下でない・編集のあったターンが1回以上・ターン数が下限以上）を満たさない
 *    区切りは保存しない
 * 3. 会話の作業フォルダがこの拡張自身のGitHubリポジトリでなければ何も書かない
 *    （判定は`RunRetrospective.resolveOwnRepo`を使い回す。Issue #2128）
 * 4. `kind: 'chat'`の指標を`<globalStorage>/run-metrics`へ1件保存する（群分けの鍵はチャット用の
 *    プロンプトのハッシュとpluginのハッシュ）
 * 5. 失敗ターンから機械的に作った教訓をrun-notesへ`runKind: 'chat'`で記録する
 * 6. 振り返り（`RunRetrospective.onRunFinished`）を呼ぶ
 *
 * 失敗しても会話は止めず、ログへ残す。`vscode`に依存しない。
 */

import {
  buildChatLessons,
  chatRunSummary,
  checkChatSegmentEligibility,
  computeChatRunMetrics,
  type ChatSegment,
} from '../orchestrator/retrospectiveMetrics/chat';
import type { RunRetrospective } from '../orchestrator/runRetrospective';
import { collectRunMetricsKeys, writeRunMetrics } from '../orchestrator/runMetricsStore';
import type { RunNotesStore } from '../orchestrator/runNotes';
import type { RunKind } from '../orchestrator/runSummary';

export interface ChatSegmentRecorderDeps {
  /** 指標の置き場（`<globalStorage>/run-metrics`）。 */
  metricsDir: string;
  extensionVersion: string;
  claudeHome: string;
  /** 振り返る種別（設定`agent.orchestrator.selfImprove.sources`）。 */
  sources(): readonly RunKind[];
  /** 選別のターン数の下限と、区切りの無入力の分数（群分けの鍵の上限値に含める）。 */
  settings(): { minTurns: number; idleMinutes: number };
  runNotes: Pick<RunNotesStore, 'recordLesson'> | undefined;
  /**
   * 振り返り。`resolveOwnRepo`で会話の作業フォルダがこの拡張自身のリポジトリかを確かめてから
   * 書く。無ければ自repoか確かめられないので何も書かない。
   */
  retrospective: Pick<RunRetrospective, 'onRunFinished' | 'resolveOwnRepo'> | undefined;
  log(message: string): void;
}

export type ChatSegmentOutcome =
  { kind: 'skipped'; reason: string } | { kind: 'recorded'; written: boolean; lessons: number };

/** 区切りを受け取って記録する関数を作る。同じ区切りを二度渡しても指標は1件のまま。 */
export function createChatSegmentRecorder(
  deps: ChatSegmentRecorderDeps,
): (segment: ChatSegment, finishedAt: number) => Promise<ChatSegmentOutcome> {
  return async (segment, finishedAt) => {
    if (!deps.sources().includes('chat')) {
      return { kind: 'skipped', reason: 'sourcesにchatが無い' };
    }
    const settings = deps.settings();
    const eligibility = checkChatSegmentEligibility(segment, settings.minTurns);
    if (!eligibility.ok) {
      return { kind: 'skipped', reason: eligibility.reason };
    }
    const summary = chatRunSummary(segment, finishedAt);
    if (summary === undefined) {
      return { kind: 'skipped', reason: '作業ディレクトリが分からない' };
    }
    const retrospective = deps.retrospective;
    if (retrospective === undefined) {
      return { kind: 'skipped', reason: '振り返りが無く、自repoの会話か確かめられない' };
    }
    try {
      // 他repoの会話の指標・教訓は残さない（評価の母集団にも他repoのrun-notesにも入れない）
      const own = await retrospective.resolveOwnRepo(summary.workspaceRoot);
      if (!own.ok) {
        return { kind: 'skipped', reason: own.reason };
      }
      const keys = await collectRunMetricsKeys({
        extensionVersion: deps.extensionVersion,
        claudeHome: deps.claudeHome,
        limits: { chatMinTurns: settings.minTurns, chatIdleMinutes: settings.idleMinutes },
        kind: 'chat',
      });
      const metrics = computeChatRunMetrics(segment, finishedAt, keys);
      if (metrics === undefined) {
        return { kind: 'skipped', reason: 'ターンが無い' };
      }
      const written = (await writeRunMetrics(deps.metricsDir, metrics)) === 'written';
      let lessons = 0;
      if (written && deps.runNotes !== undefined) {
        for (const lesson of buildChatLessons(segment)) {
          const result = await deps.runNotes.recordLesson(summary.workspaceRoot, {
            ...lesson,
            runId: segment.runId,
            runKind: 'chat',
          });
          if (result.ok) {
            lessons += 1;
          }
        }
      }
      if (written) {
        await retrospective.onRunFinished(summary);
      }
      return { kind: 'recorded', written, lessons };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      deps.log(
        `[chat retrospective] 会話の指標を記録できませんでした（${segment.runId}）: ${message}`,
      );
      return { kind: 'skipped', reason: message };
    }
  };
}
