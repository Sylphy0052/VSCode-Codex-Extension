import type { ChatItem } from '../appserver/chatState';
import { readSettledCommand, type SettledCommand } from '../loop/goalLoop';
import type { VerificationLink, VerificationRecordInput } from './record';
import { captureSourceIdentity, type SourceIdentity } from './sourceIdentity';

/**
 * Workerが会話中に実行したコマンドを、信頼できない検証記録（`agent-reported`）として
 * 残す（issue #1379）。
 *
 * 会話の`commandExecution`項目はエージェントの出力を経由して届くため、拡張機能が
 * 直接観測した記録（`observed`）とは区別する。信頼区分は`trustForAcquisition`が
 * 取得方法から決めるので、ここから`trusted`になる経路は無い。
 */

/** 記録の出どころになるWorkerのCLI。記録の`actor`は`worker:<provider>`になる */
export type AgentReportedProvider = 'codex' | 'claude';

/** 記録1件ごとに変わらない、会話の側の情報 */
export interface AgentReportedScope {
  readonly provider: AgentReportedProvider;
  /** 会話の作業ディレクトリ。ソースの同一性もここから取る */
  readonly cwd: string;
  readonly link: VerificationLink;
}

/**
 * 終わったコマンド実行の項目1件を記録の入力にする。
 *
 * 項目は実行の開始・終了時刻を持たないため、時刻は`undefined`のまま渡す（保存時刻などで
 * 埋めない）。終了コードが読めない項目（Claudeの成功したBashなど）も`undefined`のまま
 * 渡し、`outcomeForExitCode`が`unknown`にする。
 */
export function buildAgentReportedInput(
  command: SettledCommand,
  scope: AgentReportedScope,
  source: { before?: SourceIdentity | undefined; after?: SourceIdentity | undefined } = {},
): VerificationRecordInput {
  return {
    before: source.before,
    after: source.after,
    command: command.command,
    cwd: scope.cwd,
    exitCode: command.exitCode,
    startedAt: undefined,
    endedAt: undefined,
    actor: `worker:${scope.provider}`,
    acquisition: 'agent-reported',
    output: command.output,
    link: scope.link,
  };
}

/** 記録の保存先。`VerificationStore`がこの形を満たす */
export interface AgentReportedSink {
  append(input: VerificationRecordInput): Promise<unknown>;
}

interface Tracked {
  /** 既に記録した（または記録しないと決めた）項目のid */
  readonly seen: Set<string>;
  /** 次に記録するターンの開始時点のソース同一性 */
  before: Promise<SourceIdentity | undefined>;
}

/**
 * 会話ごとに、まだ記録していない終わったコマンドを記録する。
 *
 * 会話は`key`（会話を表すオブジェクト。ループなら画面のエントリ、ワークフローのタスクなら
 * セッション）で区別し、`begin`を呼んだ会話だけを記録する。`begin`の時点で終わっていた
 * 項目は記録しない（ループを始める前の会話や、読み直した履歴を記録しないため）。
 *
 * 記録の`subject`は「ターンの開始時点」のソースで、終了時点と違えば`sourceChanged`が
 * 真になる。項目はコマンドを実行した時点のソースを持たないため、ターンの前後で挟む。
 */
export class AgentReportedRecorder {
  private readonly tracked = new WeakMap<object, Tracked>();

  constructor(
    private readonly sink: AgentReportedSink,
    private readonly options: {
      readonly captureSource?: (cwd: string) => Promise<SourceIdentity | undefined>;
      readonly onError?: (message: string) => void;
    } = {},
  ) {}

  /**
   * 記録を始める（またはターンの開始を知らせる）。今ある終わった項目を記録済みとして扱い、
   * 次に記録するターンの開始時点のソースを取る。
   */
  begin(key: object, items: readonly ChatItem[], cwd: string): void {
    const tracked = this.tracked.get(key);
    const seen = tracked?.seen ?? new Set<string>();
    for (const item of items) {
      const command = readSettledCommand(item);
      if (command !== undefined) {
        seen.add(command.id);
      }
    }
    this.tracked.set(key, { seen, before: this.capture(cwd) });
  }

  /**
   * ターンの確定時に呼ぶ。`begin`後に終わった項目を1件ずつ記録する。`begin`していない
   * 会話では何もしない。書けなかった記録は`onError`へ知らせ、例外は投げない。
   */
  async record(key: object, items: readonly ChatItem[], scope: AgentReportedScope): Promise<void> {
    const tracked = this.tracked.get(key);
    if (tracked === undefined) {
      return;
    }
    const added: SettledCommand[] = [];
    for (const item of items) {
      const command = readSettledCommand(item);
      if (command !== undefined && !tracked.seen.has(command.id)) {
        // 保存を待つ間に次の状態変化が来ても同じ項目を二度記録しないよう、先に印を付ける
        tracked.seen.add(command.id);
        added.push(command);
      }
    }
    const before = tracked.before;
    const after = this.capture(scope.cwd);
    // 次のターンは、このターンの終了時点から始まる
    tracked.before = after;
    if (added.length === 0) {
      return;
    }
    const source = { before: await before, after: await after };
    for (const command of added) {
      try {
        await this.sink.append(buildAgentReportedInput(command, scope, source));
      } catch (e) {
        this.options.onError?.(
          `会話中のコマンドを検証記録へ書けませんでした: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  private capture(cwd: string): Promise<SourceIdentity | undefined> {
    return (this.options.captureSource ?? captureSourceIdentity)(cwd).catch(() => undefined);
  }
}
