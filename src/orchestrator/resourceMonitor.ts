import type { TaskRunResourceThresholds } from '../config';
import type {
  CpuMeasureMethod,
  HostResources,
  ProcessTreeUsage,
  ResourceSampler,
} from './resourceSampler';
import type { StageProcess } from './taskStageRunner';
import { sanitizeInlineText } from './untrustedText';

/**
 * オーケストレータモードの資源の状態（Issue #1629）。CPUとメモリで別々に持ち、新しい工程の開始の
 * 扱い（`StartPolicy`）は2つの組み合わせから監視側で決める（Issue #1807）。
 */
export type ResourceLevel = 'ok' | 'warning' | 'critical';

/**
 * 新しい工程セッションの開始の扱い（Issue #1807）。動いている工程はどれでも止めない。
 *
 * - unrestricted: 制限なし
 * - limit_to_1: このウィンドウの工程を同時に1本までにする（メモリがwarning）
 * - liveness: runで動いている工程が0本のときだけ、低い優先度で1本を60秒に1回始める（CPUがcritical）
 * - hold: 全面保留（メモリがcritical。原因がrunの外でも保留する）
 */
export type StartPolicy = 'unrestricted' | 'limit_to_1' | 'liveness' | 'hold';

/**
 * CPUとメモリの状態から新しい工程の開始の扱いを決める（Issue #1807の表）。
 * CPUのwarningでは絞らない。CPUがcriticalでも、外の負荷が下がるのを待つだけでrunが止まり続けない
 * よう例外の1本（liveness）を残す。
 */
export function decideStartPolicy(cpu: ResourceLevel, memory: ResourceLevel): StartPolicy {
  if (memory === 'critical') {
    return 'hold';
  }
  if (cpu === 'critical') {
    return 'liveness';
  }
  return memory === 'warning' ? 'limit_to_1' : 'unrestricted';
}

/** 例外の1本（liveness lane）を続けて始める間隔の下限。 */
export const LIVENESS_LANE_INTERVAL_MS = 60_000;

/** CPUの状態を下げるのに、戻しの閾値を下回り続ける必要のある計測の回数。 */
const CPU_RELEASE_SAMPLES = 2;

/**
 * CPUの戻しの閾値。PSIはcritical→warningを25%未満、warning→okを10%未満とする（Issue #1807。
 * 既定の40%・20%に対する比で、閾値を設定で変えたときも同じ比を保つ）。使用率は張り付きやすいため
 * 比ではなく閾値から10ポイント下で戻す。
 */
const PSI_CRITICAL_RELEASE_RATIO = 25 / 40;
const PSI_WARNING_RELEASE_RATIO = 10 / 20;
const USAGE_RELEASE_MARGIN_PERCENT = 10;

// メモリ: 空きの割合が閾値より5ポイント増えるまで下げない。ビルドやテストの一時的な確保で数ポイントは揺れる
const MEMORY_RELEASE_MARGIN = 0.05;

/**
 * runの工程を一時停止すると負荷が下がる（`run_pause_effective`）とみなす、逼迫している指標に占める
 * runの工程の割合の下限。CPUは使われているCPU時間に、メモリは使われているメモリに対する割合で見る。
 */
const RUN_PAUSE_EFFECTIVE_SHARE = 0.25;

// 計測失敗の行に載せるエラー文の上限。psやpowershell.exeの標準エラーをそのまま含むことがあり、見出しを押し流さないよう切る
const FAILURE_MESSAGE_MAX_LENGTH = 200;

const LEVEL_ORDER: Record<ResourceLevel, number> = { ok: 0, warning: 1, critical: 2 };

/** CPUの判定に使った値と閾値。 */
export interface CpuAssessment {
  method: CpuMeasureMethod;
  /** 計測間隔の間の割合（%）。初回などで差を取れなければ`undefined`（状態は前回のまま）。 */
  percent: number | undefined;
  warningPercent: number;
  criticalPercent: number;
  pressureSource?: 'cgroup' | 'system';
}

/** メモリの判定に使った値と閾値。 */
export interface MemoryAssessment {
  availableRatio: number | undefined;
  warningRatio: number;
  criticalRatio: number;
}

/** 1回の計測の結果。`/proc`等の文字列は持たず、解釈済みの数値だけを持つ。 */
export interface ResourceSnapshot {
  /** CPUとメモリの悪い方。 */
  level: ResourceLevel;
  cpuLevel: ResourceLevel;
  memoryLevel: ResourceLevel;
  cpu: CpuAssessment;
  memory: MemoryAssessment;
  startPolicy: StartPolicy;
  host: HostResources;
  /** 工程セッションごとのプロセスツリーの使用量。共有プロセスは同じ`pid`の工程が同じ値を持つ。 */
  stages: Array<StageProcess & { usage: ProcessTreeUsage | undefined }>;
  /**
   * 工程1本が終わったとき（pause・完了とも）に空いた`MemAvailable`の実測（バイト）。PSSを読めない
   * 環境で、pauseで空く量の見積もりに使う。まだ観測していなければ`undefined`。
   */
  observedFreedBytesPerStage: number | undefined;
  sampledAt: Date;
}

/** runの工程を一時停止したときの効果の見積もり（Issue #1807）。 */
export interface RunPauseEffect {
  /** 逼迫している指標が下がるか。見積もれなければ`undefined`。逼迫していなければ`false`。 */
  effective: boolean | undefined;
  /** 使われているCPU時間に占めるrunの工程の割合（0〜1）。 */
  cpuShare: number | undefined;
  /** 使われているメモリに占める、runの工程を止めて空く量の割合（0〜1）。 */
  memoryShare: number | undefined;
  /** 空く量の見積もり方。PSSの和か、過去に工程が終わった前後の`MemAvailable`の差か。 */
  memoryBasis: 'pss' | 'observed' | undefined;
}

/** 計測が続けて失敗している間の記録。成功するか計測を止めると消える。 */
export interface ResourceSampleFailure {
  /** 続けて失敗した回数。 */
  count: number;
  lastMessage: string;
  /** 続けて失敗し始めた時刻。 */
  since: Date;
}

export interface ResourceMonitorDeps {
  sampler: Pick<ResourceSampler, 'sampleHost' | 'sampleProcessTrees'>;
  /** 動いているrunがあるか。無い間は計らない。 */
  hasActiveRuns(): boolean;
  listStageProcesses(): StageProcess[];
  thresholds(): TaskRunResourceThresholds;
  intervalMs(): number;
  /**
   * CPUかメモリの状態が変わったときだけ呼ぶ（同じ状態が続く間は呼ばない）。`prev`は前回の計測
   * （計測を始めてから初めてなら`undefined`で、両方okだったものとして扱う）。
   */
  onLevelChanged(prev: ResourceSnapshot | undefined, snapshot: ResourceSnapshot): void;
  /** 計測のたびに呼ぶ。例外の1本の間隔が空いたときに開始を試みるのに使う。 */
  onSampled?(snapshot: ResourceSnapshot): void;
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

/** CPUの閾値（%）と戻しの閾値。 */
export interface CpuThresholds {
  warning: number;
  critical: number;
  warningRelease: number;
  criticalRelease: number;
}

export function cpuThresholds(
  method: CpuMeasureMethod,
  t: TaskRunResourceThresholds,
): CpuThresholds {
  if (method === 'psi') {
    return {
      warning: t.cpuPressureWarningPercent,
      critical: t.cpuPressureCriticalPercent,
      warningRelease: t.cpuPressureWarningPercent * PSI_WARNING_RELEASE_RATIO,
      criticalRelease: t.cpuPressureCriticalPercent * PSI_CRITICAL_RELEASE_RATIO,
    };
  }
  return {
    warning: t.cpuUsageWarningPercent,
    critical: t.cpuUsageCriticalPercent,
    warningRelease: Math.max(0, t.cpuUsageWarningPercent - USAGE_RELEASE_MARGIN_PERCENT),
    criticalRelease: Math.max(0, t.cpuUsageCriticalPercent - USAGE_RELEASE_MARGIN_PERCENT),
  };
}

/**
 * CPUの状態を決める（Issue #1807）。上げるときは閾値ちょうどで上げ、下げるときは戻しの閾値を
 * `CPU_RELEASE_SAMPLES`回続けて下回ったときに1段だけ下げる（critical→warning→ok）。値が取れない
 * 計測（初回・PSIの読み元が替わった直後）は状態を変えない。
 */
export function nextCpuLevel(
  prev: ResourceLevel,
  value: number | undefined,
  th: CpuThresholds,
  releaseStreak: number,
): { level: ResourceLevel; releaseStreak: number } {
  if (value === undefined || !Number.isFinite(value)) {
    return { level: prev, releaseStreak };
  }
  if (value >= th.critical) {
    return { level: 'critical', releaseStreak: 0 };
  }
  if (prev === 'critical') {
    const streak = value < th.criticalRelease ? releaseStreak + 1 : 0;
    return streak >= CPU_RELEASE_SAMPLES
      ? { level: 'warning', releaseStreak: 0 }
      : { level: 'critical', releaseStreak: streak };
  }
  if (value >= th.warning) {
    return { level: 'warning', releaseStreak: 0 };
  }
  if (prev === 'warning') {
    const streak = value < th.warningRelease ? releaseStreak + 1 : 0;
    return streak >= CPU_RELEASE_SAMPLES
      ? { level: 'ok', releaseStreak: 0 }
      : { level: 'warning', releaseStreak: streak };
  }
  return { level: 'ok', releaseStreak: 0 };
}

function worse(a: ResourceLevel, b: ResourceLevel): ResourceLevel {
  return LEVEL_ORDER[a] >= LEVEL_ORDER[b] ? a : b;
}

type Sample = Pick<ResourceSnapshot, 'host' | 'stages' | 'sampledAt'>;

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
  private cpuReleaseStreak = 0;
  private memoryLevel: ResourceLevel = 'ok';
  private latest: ResourceSnapshot | undefined;
  private failure: ResourceSampleFailure | undefined;
  /**
   * 例外の1本を最後に始めた時刻（ms）。runごとではなくこの監視で1つにする（複数のrunが同時に
   * 例外の1本を始めないため）。監視は拡張ホストごとに動くため、ウィンドウをまたいでは効かない。
   */
  private lastLivenessStartAt: number | undefined;
  /** 直近に枠を取る前の`lastLivenessStartAt`。枠を返すときに戻す。 */
  private livenessLaneBefore: number | undefined;
  private observedFreedBytesPerStage: number | undefined;

  constructor(private readonly deps: ResourceMonitorDeps) {}

  get level(): ResourceLevel {
    return this.latest?.level ?? 'ok';
  }

  /** 新しい工程の開始の扱い。計測前は制限しない。 */
  get startPolicy(): StartPolicy {
    return this.latest?.startPolicy ?? 'unrestricted';
  }

  get snapshot(): ResourceSnapshot | undefined {
    return this.latest;
  }

  /**
   * 計測が続けて失敗しているときの記録。失敗の間は`snapshot`が最後に計れた値のまま残り、状態も
   * 上げ下げしないため、`get_run_state`で「余裕がある」と「計れていない」を分けて出すのに使う。
   */
  get sampleFailure(): ResourceSampleFailure | undefined {
    return this.failure;
  }

  /**
   * 例外の1本（Issue #1807）の枠を取る。開始の扱いが`liveness`で、前回の例外の開始から
   * `LIVENESS_LANE_INTERVAL_MS`以上経っていれば取れて、その時刻を記録する。runで動いている工程が
   * 0本かは呼び出し側（`TaskStageRunner.pump`）が確かめてから呼ぶ。
   */
  tryAcquireLivenessLane(): boolean {
    if (this.startPolicy !== 'liveness') {
      return false;
    }
    const now = this.now().getTime();
    if (
      this.lastLivenessStartAt !== undefined &&
      now - this.lastLivenessStartAt < LIVENESS_LANE_INTERVAL_MS
    ) {
      return false;
    }
    this.livenessLaneBefore = this.lastLivenessStartAt;
    this.lastLivenessStartAt = now;
    return true;
  }

  /**
   * 取った例外の1本の枠を返す。枠を取った後に工程が始まらなかったとき（専有権を取れない、
   * 既に開始途中だった等）に呼ぶ。返さないと、始まっていない1本のために60秒待つことになる。
   */
  releaseLivenessLane(): void {
    this.lastLivenessStartAt = this.livenessLaneBefore;
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

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  /** 計測を止め、状態をokへ戻す。次にrunが動き出したら計り直す（通知はしない。知らせる先のrunが無いため）。 */
  private stop(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.epoch += 1;
    this.latest = undefined;
    this.failure = undefined;
    this.cpuLevel = 'ok';
    this.cpuReleaseStreak = 0;
    this.memoryLevel = 'ok';
  }

  private async tick(): Promise<void> {
    this.timer = undefined;
    const epoch = this.epoch;
    this.sampling = true;
    try {
      const sample = await this.sample();
      if (epoch === this.epoch && !this.disposed) {
        this.failure = undefined;
        this.apply(sample);
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      this.deps.log(`[task run] 資源の計測に失敗: ${message}`);
      if (epoch === this.epoch && !this.disposed) {
        this.failure = {
          count: (this.failure?.count ?? 0) + 1,
          lastMessage: message,
          since: this.failure?.since ?? this.now(),
        };
      }
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

  private async sample(): Promise<Sample> {
    const processes = this.deps.listStageProcesses();
    // 工程ごとのツリーは1回のプロセス一覧から組む（共有のapp-serverは1回だけ数える）
    const [host, trees] = await Promise.all([
      this.deps.sampler.sampleHost(),
      this.deps.sampler.sampleProcessTrees([...new Set(processes.map((p) => p.pid))]),
    ]);
    return {
      host,
      stages: processes.map((p) => ({ ...p, usage: trees.get(p.pid) })),
      sampledAt: this.now(),
    };
  }

  /**
   * 専用のプロセスを持つ工程が前回から減っていれば、その間に増えた`MemAvailable`を1本あたりで記録する
   * （PSSを読めない環境での、pauseで空く量の見積もり。Issue #1807）。pauseと完了は区別しない
   * （どちらもプロセスが終わってメモリが空く）。増えていなければ記録しない（他の確保と重なった）。
   */
  private observeFreedMemory(sample: Sample): void {
    const previous = this.latest;
    const before = previous?.host.memoryAvailableBytes;
    const after = sample.host.memoryAvailableBytes;
    if (previous === undefined || before === undefined || after === undefined) {
      return;
    }
    const alive = new Set(sample.stages.filter((s) => !s.shared).map((s) => s.pid));
    const ended = new Set(
      previous.stages.filter((s) => !s.shared && !alive.has(s.pid)).map((s) => s.pid),
    ).size;
    if (ended > 0 && after > before) {
      this.observedFreedBytesPerStage = (after - before) / ended;
    }
  }

  private apply(sample: Sample): void {
    const t = this.deps.thresholds();
    this.observeFreedMemory(sample);
    const cpuTh = cpuThresholds(sample.host.cpu.method, t);
    const cpu = nextCpuLevel(this.cpuLevel, sample.host.cpu.percent, cpuTh, this.cpuReleaseStreak);
    this.cpuLevel = cpu.level;
    this.cpuReleaseStreak = cpu.releaseStreak;
    // メモリは空きが少ないほど逼迫なので「使用中の割合」に直して同じ判定へ通す
    const used =
      sample.host.memoryAvailableRatio === undefined
        ? undefined
        : 1 - sample.host.memoryAvailableRatio;
    this.memoryLevel = classify(
      used,
      1 - t.memoryWarningAvailableRatio,
      1 - t.memoryCriticalAvailableRatio,
      MEMORY_RELEASE_MARGIN,
      this.memoryLevel,
    );
    const prev = this.latest;
    const snapshot: ResourceSnapshot = {
      ...sample,
      level: worse(this.cpuLevel, this.memoryLevel),
      cpuLevel: this.cpuLevel,
      memoryLevel: this.memoryLevel,
      cpu: {
        method: sample.host.cpu.method,
        percent: sample.host.cpu.percent,
        warningPercent: cpuTh.warning,
        criticalPercent: cpuTh.critical,
        ...(sample.host.cpu.pressureSource === undefined
          ? {}
          : { pressureSource: sample.host.cpu.pressureSource }),
      },
      memory: {
        availableRatio: sample.host.memoryAvailableRatio,
        warningRatio: t.memoryWarningAvailableRatio,
        criticalRatio: t.memoryCriticalAvailableRatio,
      },
      startPolicy: decideStartPolicy(this.cpuLevel, this.memoryLevel),
      observedFreedBytesPerStage: this.observedFreedBytesPerStage,
    };
    this.latest = snapshot;
    if (
      snapshot.cpuLevel !== (prev?.cpuLevel ?? 'ok') ||
      snapshot.memoryLevel !== (prev?.memoryLevel ?? 'ok')
    ) {
      this.deps.onLevelChanged(prev, snapshot);
    }
    this.deps.onSampled?.(snapshot);
  }
}

/**
 * runの工程を一時停止したときの効果を見積もる（Issue #1807）。codexの工程はapp-serverを共有して
 * いて止めても空かないため数えない。メモリはRSSの和ではなくPSSの和で見積もり、PSSを読めなければ
 * 過去に工程が終わった前後の`MemAvailable`の差（1本あたり）を使う。
 */
export function assessRunPause(snapshot: ResourceSnapshot, runId: string): RunPauseEffect {
  const own = snapshot.stages.filter((s) => s.runId === runId && !s.shared);
  const host = snapshot.host;

  let cpuShare: number | undefined;
  const busyCorePercent =
    host.cpuUsagePercent === undefined ? undefined : host.cpuUsagePercent * host.cpuCores;
  if (own.length === 0) {
    cpuShare = 0;
  } else if (busyCorePercent !== undefined && busyCorePercent > 0) {
    const cpus = own.map((s) => s.usage?.cpuPercent);
    cpuShare = cpus.every((c): c is number => c !== undefined)
      ? Math.min(1, cpus.reduce((a, b) => a + b, 0) / busyCorePercent)
      : undefined;
  }

  let reclaimable: number | undefined;
  let memoryBasis: RunPauseEffect['memoryBasis'];
  const pss = own.map((s) => s.usage?.pssBytes);
  if (own.length === 0) {
    reclaimable = 0;
  } else if (pss.every((p): p is number => p !== undefined)) {
    reclaimable = pss.reduce((a, b) => a + b, 0);
    memoryBasis = 'pss';
  } else if (snapshot.observedFreedBytesPerStage !== undefined) {
    reclaimable = snapshot.observedFreedBytesPerStage * own.length;
    memoryBasis = 'observed';
  }
  const usedBytes =
    host.memoryTotalBytes === undefined || host.memoryAvailableBytes === undefined
      ? undefined
      : host.memoryTotalBytes - host.memoryAvailableBytes;
  const memoryShare =
    reclaimable === undefined || usedBytes === undefined || usedBytes <= 0
      ? undefined
      : Math.min(1, reclaimable / usedBytes);

  const pressing: Array<number | undefined> = [];
  if (snapshot.cpuLevel !== 'ok') {
    pressing.push(cpuShare);
  }
  if (snapshot.memoryLevel !== 'ok') {
    pressing.push(memoryShare);
  }
  let effective: boolean | undefined;
  if (pressing.length === 0) {
    effective = false;
  } else if (pressing.some((s) => s !== undefined && s >= RUN_PAUSE_EFFECTIVE_SHARE)) {
    effective = true;
  } else {
    effective = pressing.every((s) => s !== undefined) ? false : undefined;
  }
  return { effective, cpuShare, memoryShare, memoryBasis };
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)}MiB`;
}

function formatPercent(ratio: number | undefined): string {
  return ratio === undefined ? '不明' : `${(ratio * 100).toFixed(0)}%`;
}

function formatCpu(snapshot: ResourceSnapshot): string {
  const { cpu } = snapshot;
  const method =
    cpu.method === 'psi'
      ? `PSI some${cpu.pressureSource === 'cgroup' ? '（cgroup）' : ''}`
      : 'CPU使用率';
  const value = cpu.percent === undefined ? '計測中' : `${cpu.percent.toFixed(0)}%`;
  return (
    `CPU ${snapshot.cpuLevel}（${method} ${value}、` +
    `warning ${String(cpu.warningPercent)}% / critical ${String(cpu.criticalPercent)}%）`
  );
}

function formatMemory(snapshot: ResourceSnapshot): string {
  const { memory, host } = snapshot;
  const value =
    memory.availableRatio === undefined
      ? '不明'
      : formatPercent(memory.availableRatio) +
        (host.memoryAvailableBytes === undefined
          ? ''
          : `（${formatBytes(host.memoryAvailableBytes)}）`) +
        (host.memoryFromCgroup ? '・コンテナの上限基準' : '');
  return (
    `メモリ ${snapshot.memoryLevel}（空き ${value}、` +
    `warning ${formatPercent(memory.warningRatio)} / critical ${formatPercent(memory.criticalRatio)}）`
  );
}

/** 新しい工程の開始の扱いを、Orchestratorがそのまま読める文にする。 */
export function describeStartPolicy(policy: StartPolicy): string {
  switch (policy) {
    case 'unrestricted':
      return '新規開始: 制限なし';
    case 'limit_to_1':
      return '新規開始: 並列1（limit_to_1。メモリがwarningのため、このウィンドウの工程は同時に1本まで）';
    case 'liveness':
      return (
        '新規開始: 例外の1本だけ（CPUがcriticalのため。runで動いている工程が0本のときだけ、' +
        `${String(LIVENESS_LANE_INTERVAL_MS / 1000)}秒に1回、低い優先度で1本を始める）`
      );
    case 'hold':
      return '新規開始: 全面保留（hold。メモリがcriticalのため。状態が下がるまで始めない）';
  }
}

function describePause(effect: RunPauseEffect): string {
  const shares =
    `runの工程はCPUの${formatPercent(effect.cpuShare)}、メモリの${formatPercent(effect.memoryShare)}` +
    (effect.memoryBasis === 'observed'
      ? '。メモリは過去に工程が終わった前後の空きの差から見積もり'
      : '');
  if (effect.effective === true) {
    return `run_pause_effective: true（${shares}）。pause_stageで工程を一時停止すると負荷が下がる`;
  }
  if (effect.effective === undefined) {
    return `run_pause_effective: 不明（${shares}）。pause_stageは使わない`;
  }
  return `run_pause_effective: false（${shares}）。pause_stageでは負荷が下がらないため使わない`;
}

function formatDiagnostics(host: HostResources): string {
  const load = host.loadPerCore === undefined ? '不明' : host.loadPerCore.toFixed(2);
  const usage =
    host.cpuUsagePercent === undefined ? '計測中' : `${host.cpuUsagePercent.toFixed(0)}%`;
  return (
    `診断値（判定には使わない）: loadavg 1分平均（1コアあたり）${load} / ` +
    `CPU使用率 ${usage} / コア数 ${String(host.cpuCores)}`
  );
}

/** 監視側で決めた扱い（指標ごとの状態、新規開始、pauseの効果）を並べる。 */
function decisionLines(snapshot: ResourceSnapshot, runId: string): string[] {
  return [
    `${formatCpu(snapshot)} / ${formatMemory(snapshot)}`,
    describeStartPolicy(snapshot.startPolicy),
    describePause(assessRunPause(snapshot, runId)),
    formatDiagnostics(snapshot.host),
  ];
}

/**
 * 状態の変化をOrchestratorへ知らせる本文（runごと。pauseの効果がrunの工程で変わるため）。
 * 閾値の解釈と対処の選択はLLMに任せず、監視側で決めた扱いを書く（Issue #1807）。
 */
export function describeResourceChange(
  prev: ResourceSnapshot | undefined,
  snapshot: ResourceSnapshot,
  runId: string,
): string {
  const lines = [
    `資源の状態が変わりました（CPU ${prev?.cpuLevel ?? 'ok'}→${snapshot.cpuLevel} / ` +
      `メモリ ${prev?.memoryLevel ?? 'ok'}→${snapshot.memoryLevel}）。` +
      '以下の扱いは監視側で決めたもので、拡張がそのとおりに動かす。',
    ...decisionLines(snapshot, runId),
    '動いている工程は止めない。start_stageは受け付け、新規開始の扱いに従って始める。',
  ];
  if (
    (prev?.startPolicy ?? 'unrestricted') !== 'unrestricted' &&
    snapshot.startPolicy === 'unrestricted'
  ) {
    lines.push('保留していた工程の開始を再開する。一時停止した工程はresume_stageで再開できる。');
  }
  lines.push('工程ごとの使用量はget_run_stateで確かめられる。');
  return lines.join('\n');
}

function formatUsage(usage: ProcessTreeUsage | undefined): string {
  if (usage === undefined) {
    return '計測できず';
  }
  const cpu = usage.cpuPercent === undefined ? '計測中' : `${usage.cpuPercent.toFixed(0)}%`;
  const pss = usage.pssBytes === undefined ? '' : ` / PSS ${formatBytes(usage.pssBytes)}`;
  return `RSS ${formatBytes(usage.rssBytes)}${pss} / CPU ${cpu} / プロセス${String(usage.processCount)}個`;
}

/**
 * `get_run_state`の見出しへ足す行。指標ごとの状態と監視側で決めた扱い、このrunの工程ごとの使用量を
 * 並べる。codexの工程はapp-serverを共有しているため工程ごとに分けられず、共有プロセス全体の使用量を
 * 「共有」として1行で出す。
 */
export function formatResourceLines(
  snapshot: ResourceSnapshot | undefined,
  runId: string,
  failure?: ResourceSampleFailure,
): string[] {
  // 計測の失敗中は状態を上げ下げしない。okのままでも余裕があるとは限らないことを見出しの直後に出す
  const failureLine =
    failure === undefined
      ? []
      : [
          `  計測失敗: ${failure.since.toISOString()}から${String(failure.count)}回続けて失敗（最後: ` +
            `${sanitizeInlineText(failure.lastMessage, FAILURE_MESSAGE_MAX_LENGTH)}）。状態は最後に計れた値のまま`,
        ];
  if (snapshot === undefined) {
    return ['資源: 未計測', ...failureLine];
  }
  const lines = [
    `資源: ${snapshot.level}（${snapshot.sampledAt.toISOString()}に計測）`,
    ...decisionLines(snapshot, runId).map((line) => `  ${line}`),
    ...failureLine,
  ];
  const own = snapshot.stages.filter((s) => s.runId === runId);
  for (const stage of own.filter((s) => !s.shared)) {
    lines.push(`  工程 ${stage.taskId}:${stage.stage} ${formatUsage(stage.usage)}`);
  }
  const sharedPids = new Set(own.filter((s) => s.shared).map((s) => s.pid));
  for (const pid of sharedPids) {
    const members = own
      .filter((s) => s.shared && s.pid === pid)
      .map((s) => `${s.taskId}:${s.stage}`);
    const all = snapshot.stages.filter((s) => s.shared && s.pid === pid).length;
    lines.push(
      `  共有 codex app-server（${members.join(', ')}を含む全${String(all)}工程と他のタブの合計。工程ごとには分けられない） ` +
        formatUsage(own.find((s) => s.pid === pid)?.usage),
    );
  }
  return lines;
}
