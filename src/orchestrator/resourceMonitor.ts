import type { TaskRunResourceThresholds } from '../config';
import type { HostResources, ProcessTreeUsage, ResourceSampler } from './resourceSampler';
import type { StageProcess } from './taskStageRunner';

/**
 * オーケストレータモードの資源の状態（Issue #1629）。
 *
 * - ok: 何もしない
 * - warning: Orchestratorへ知らせるだけ。工程の開始は止めない
 * - critical: 新しい工程セッションの開始を保留する（`start_stage`は受け付けて待たせる）。動いている工程は止めない
 */
export type ResourceLevel = 'ok' | 'warning' | 'critical';

/**
 * 状態を下げるときの余裕（ヒステリシス）。閾値ちょうどの前後で上げ下げを繰り返し、そのたびに
 * Orchestratorへ通知が飛ぶのを防ぐ。上げるときは閾値ちょうどで上げる。
 */
// CPU: 1コアあたりの負荷が閾値より0.1下がるまで下げない。1分平均のloadavgは15秒ごとの揺れが小さく、0.1で足りる
const CPU_RELEASE_MARGIN = 0.1;
// メモリ: 空きの割合が閾値より5ポイント増えるまで下げない。ビルドやテストの一時的な確保で数ポイントは揺れる
const MEMORY_RELEASE_MARGIN = 0.05;

const LEVEL_ORDER: Record<ResourceLevel, number> = { ok: 0, warning: 1, critical: 2 };

/** 1回の計測の結果。`/proc`等の文字列は持たず、解釈済みの数値だけを持つ。 */
export interface ResourceSnapshot {
  level: ResourceLevel;
  host: HostResources;
  /** 工程セッションごとのプロセスツリーの使用量。共有プロセスは同じ`pid`の工程が同じ値を持つ。 */
  stages: Array<StageProcess & { usage: ProcessTreeUsage | undefined }>;
  sampledAt: Date;
}

export interface ResourceMonitorDeps {
  sampler: Pick<ResourceSampler, 'sampleHost' | 'sampleProcessTrees'>;
  /** 動いているrunがあるか。無い間は計らない。 */
  hasActiveRuns(): boolean;
  listStageProcesses(): StageProcess[];
  thresholds(): TaskRunResourceThresholds;
  intervalMs(): number;
  /** 状態が変わったときだけ呼ぶ（同じ状態が続く間は呼ばない）。 */
  onLevelChanged(prev: ResourceLevel, snapshot: ResourceSnapshot): void;
  log(message: string): void;
  now?: () => Date;
}

/**
 * 大きいほど逼迫している値を状態に分ける。`prev`より下げるのは、閾値から`margin`以上離れたときだけ。
 * 値が取れなければokとする（計れない環境で工程を止めない）。
 */
function classify(
  value: number | undefined,
  warning: number,
  critical: number,
  margin: number,
  prev: ResourceLevel,
): ResourceLevel {
  if (value === undefined || !Number.isFinite(value)) {
    return 'ok';
  }
  if (value >= critical || (prev === 'critical' && value > critical - margin)) {
    return 'critical';
  }
  if (value >= warning || (prev !== 'ok' && value > warning - margin)) {
    return 'warning';
  }
  return 'ok';
}

function worse(a: ResourceLevel, b: ResourceLevel): ResourceLevel {
  return LEVEL_ORDER[a] >= LEVEL_ORDER[b] ? a : b;
}

/**
 * 動いているrunがある間だけ一定間隔でCPUとメモリを計り、状態の変化を知らせる。
 * 間隔は前の計測が終わってから数える（計測が重なって`ps`等を並べて起こさない）。
 */
export class ResourceMonitor {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sampling = false;
  private disposed = false;
  /** 計測を止めるたびに進める。止めた後に届いた計測結果を捨てるため。 */
  private epoch = 0;
  private cpuLevel: ResourceLevel = 'ok';
  private memoryLevel: ResourceLevel = 'ok';
  private latest: ResourceSnapshot | undefined;

  constructor(private readonly deps: ResourceMonitorDeps) {}

  get level(): ResourceLevel {
    return this.latest?.level ?? 'ok';
  }

  get snapshot(): ResourceSnapshot | undefined {
    return this.latest;
  }

  /** runの状態が変わったときに呼ぶ。動いているrunの有無に合わせて計測を始める・止める。 */
  refresh(): void {
    if (this.disposed) {
      return;
    }
    if (!this.deps.hasActiveRuns()) {
      this.stop();
      return;
    }
    if (this.timer === undefined && !this.sampling) {
      void this.tick();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  /** 計測を止め、状態をokへ戻す。次にrunが動き出したら計り直す（通知はしない。知らせる先のrunが無いため）。 */
  private stop(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.epoch += 1;
    this.latest = undefined;
    this.cpuLevel = 'ok';
    this.memoryLevel = 'ok';
  }

  private async tick(): Promise<void> {
    this.timer = undefined;
    const epoch = this.epoch;
    this.sampling = true;
    try {
      const snapshot = await this.sample();
      if (epoch === this.epoch && !this.disposed) {
        this.apply(snapshot);
      }
    } catch (e: unknown) {
      this.deps.log(`[task run] 資源の計測に失敗: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.sampling = false;
    }
    if (this.disposed) {
      return;
    }
    if (!this.deps.hasActiveRuns()) {
      this.stop();
      return;
    }
    if (this.timer === undefined) {
      this.timer = setTimeout(() => void this.tick(), this.deps.intervalMs());
    }
  }

  private async sample(): Promise<Omit<ResourceSnapshot, 'level'>> {
    const processes = this.deps.listStageProcesses();
    // 工程ごとのツリーは1回のプロセス一覧から組む（共有のapp-serverは1回だけ数える）
    const [host, trees] = await Promise.all([
      this.deps.sampler.sampleHost(),
      this.deps.sampler.sampleProcessTrees([...new Set(processes.map((p) => p.pid))]),
    ]);
    return {
      host,
      stages: processes.map((p) => ({ ...p, usage: trees.get(p.pid) })),
      sampledAt: (this.deps.now ?? (() => new Date()))(),
    };
  }

  private apply(sample: Omit<ResourceSnapshot, 'level'>): void {
    const t = this.deps.thresholds();
    this.cpuLevel = classify(
      sample.host.cpuLoadPerCore,
      t.cpuWarningLoadPerCore,
      t.cpuCriticalLoadPerCore,
      CPU_RELEASE_MARGIN,
      this.cpuLevel,
    );
    // メモリは空きが少ないほど逼迫なので「使用中の割合」に直して同じ判定へ通す
    const used = sample.host.memoryAvailableRatio === undefined ? undefined : 1 - sample.host.memoryAvailableRatio;
    this.memoryLevel = classify(
      used,
      1 - t.memoryWarningAvailableRatio,
      1 - t.memoryCriticalAvailableRatio,
      MEMORY_RELEASE_MARGIN,
      this.memoryLevel,
    );
    const prev = this.level;
    const snapshot: ResourceSnapshot = { ...sample, level: worse(this.cpuLevel, this.memoryLevel) };
    this.latest = snapshot;
    if (snapshot.level !== prev) {
      this.deps.onLevelChanged(prev, snapshot);
    }
  }
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)}MiB`;
}

function formatHost(host: HostResources): string {
  const cpu = host.cpuLoadPerCore === undefined ? '不明' : host.cpuLoadPerCore.toFixed(2);
  const memory =
    host.memoryAvailableRatio === undefined
      ? '不明'
      : `${(host.memoryAvailableRatio * 100).toFixed(0)}%` +
        (host.memoryAvailableBytes === undefined ? '' : `（${formatBytes(host.memoryAvailableBytes)}）`) +
        (host.memoryFromCgroup ? '・コンテナの上限基準' : '');
  return `CPU負荷（1コアあたり）${cpu} / 空きメモリ ${memory}`;
}

function formatUsage(usage: ProcessTreeUsage | undefined): string {
  if (usage === undefined) {
    return '計測できず';
  }
  const cpu = usage.cpuPercent === undefined ? '計測中' : `${usage.cpuPercent.toFixed(0)}%`;
  return `RSS ${formatBytes(usage.rssBytes)} / CPU ${cpu} / プロセス${String(usage.processCount)}個`;
}

/** 状態の変化をOrchestratorへ知らせる本文。 */
export function describeResourceChange(prev: ResourceLevel, snapshot: ResourceSnapshot): string {
  const lines = [`資源の状態が${prev}から${snapshot.level}になりました。${formatHost(snapshot.host)}`];
  if (snapshot.level === 'critical') {
    lines.push(
      'criticalの間は新しい工程セッションを始めません。start_stageは受け付けて、状態が下がるまで待たせます。動いている工程は止めません。',
    );
  } else if (prev === 'critical') {
    lines.push('保留していた工程の開始を再開します。');
  }
  lines.push('工程ごとの使用量はget_run_stateで確かめてください。');
  return lines.join('\n');
}

/**
 * `get_run_state`の見出しへ足す行。このrunの工程ごとの使用量を並べる。codexの工程はapp-serverを
 * 共有しているため工程ごとに分けられず、共有プロセス全体の使用量を「共有」として1行で出す。
 */
export function formatResourceLines(snapshot: ResourceSnapshot | undefined, runId: string): string[] {
  if (snapshot === undefined) {
    return ['資源: 未計測'];
  }
  const lines = [`資源: ${snapshot.level} / ${formatHost(snapshot.host)}（${snapshot.sampledAt.toISOString()}に計測）`];
  const own = snapshot.stages.filter((s) => s.runId === runId);
  for (const stage of own.filter((s) => !s.shared)) {
    lines.push(`  工程 ${stage.taskId}:${stage.stage} ${formatUsage(stage.usage)}`);
  }
  const sharedPids = new Set(own.filter((s) => s.shared).map((s) => s.pid));
  for (const pid of sharedPids) {
    const members = own.filter((s) => s.shared && s.pid === pid).map((s) => `${s.taskId}:${s.stage}`);
    const all = snapshot.stages.filter((s) => s.shared && s.pid === pid).length;
    lines.push(
      `  共有 codex app-server（${members.join(', ')}を含む全${String(all)}工程と他のタブの合計。工程ごとには分けられない） ` +
        formatUsage(own.find((s) => s.pid === pid)?.usage),
    );
  }
  return lines;
}
