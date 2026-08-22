/**
 * ワークフローViewのWebviewで動くスクリプト（design.md §16.8）。
 *
 * `chatScript.ts` と同じ方針。テンプレートリテラルの中身なのでTypeScriptの型検査もlintも
 * 効かない（`workflowScript.test.ts` で構文だけは機械的に確かめる）。
 *
 * **セキュリティ上の要点**（design.md §16.8「画面に出す動的な文字列は必ずテキストノードとして
 * 挿入する」）: タスクid・ブランチ名・cwd・応答の要約・承認理由など、エージェントの出力や
 * YAMLに由来する値は、この中で一度も文字列結合でHTML/SVGへ埋め込まない。必ず
 * `document.createElement` / `createElementNS` でノードを作り、`.textContent` へ代入する。
 * `innerHTML` はこのファイルのどこにも登場しない。
 */
export function workflowScript(): string {
  return `
  const vscode = acquireVsCodeApi();
  const SVGNS = 'http://www.w3.org/2000/svg';
  const el = (id) => document.getElementById(id);

  const STATE_LABEL = {
    pending: '待機',
    running: '実行中',
    waitingApproval: '承認待ち',
    waitingReply: '返信待ち',
    merging: '統合中',
    done: '完了',
    failed: '失敗',
    blocked: 'ブロック（統合できず）',
    skipped: 'スキップ',
  };

  const FAILURE_LABEL = {
    maxReached: '回数切れ',
    loopFailed: 'ターン失敗',
    approvalRejected: '承認拒否',
    dependencyFailed: '依存先の失敗',
    mergeBlocked: '依存先の統合ブロック',
    mergeFailed: 'マージ失敗',
    runHalted: '実行停止のため未着手',
    reloadInterrupted: 'リロードによる中断',
    manualStop: '手動停止',
    // design.md §16.27、Issue #336。同じ応答が繰り返され進捗が無いまま停止した
    stalled: '停滞',
  };

  let currentRuns = [];
  let currentSnapshot = null;
  let currentLayout = null;

  // ---- グラフの表示倍率（design.md §16.8「依存グラフ」） ----
  // グラフがパネル幅に収まらないと全体を見渡せないため、次の3段構えで対処する。
  //   1. 段の折り返し: 描画領域の幅を拡張機能側へ伝え、layoutGraphが1段を複数行へ折る
  //   2. 幅に合わせた縮小: 折り返しても収まらなければviewBoxごと縮小する（下限あり）
  //   3. 手動ズーム: 拡大して細部を読む・縮小して更に広く見る操作を人に開放する
  // 'fit'は1と2の自動追随、'manual'は人が選んだ倍率を保つ。
  let zoomMode = 'fit';
  let zoomScale = 1;
  /** 自動縮小の下限。これ以上小さくすると文字が読めないので、残りは横スクロールに任せる。 */
  const MIN_FIT_SCALE = 0.5;
  const MIN_ZOOM = 0.25;
  const MAX_ZOOM = 2;
  const ZOOM_STEP = 1.25;
  /** 直近に拡張機能へ伝えた描画領域の幅。同じ値の往復とスクロールバー分の振動を抑える。 */
  let reportedGraphWidth = -1;
  let viewportTimer = 0;

  // ---- ユーティリティ ----

  function svgEl(tag, attrs) {
    const node = document.createElementNS(SVGNS, tag);
    if (attrs) {
      for (const key of Object.keys(attrs)) {
        node.setAttribute(key, String(attrs[key]));
      }
    }
    return node;
  }

  function el2(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function text(tag, className, value) {
    const node = el2(tag, className);
    node.textContent = value;
    return node;
  }

  function formatElapsed(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const mm = (m < 10 ? '0' : '') + m;
    const ss = (s < 10 ? '0' : '') + s;
    return h > 0 ? h + ':' + mm + ':' + ss : mm + ':' + ss;
  }

  function findTask(taskId) {
    if (!currentSnapshot) return undefined;
    return currentSnapshot.tasks.find((t) => t.id === taskId);
  }

  function describeFailure(task) {
    if (!task.failure) return '';
    const label = FAILURE_LABEL[task.failure.kind] || task.failure.kind;
    if (task.failure.kind === 'dependencyFailed' && task.failure.failedTaskIds) {
      return label + '（' + task.failure.failedTaskIds.join(', ') + '）';
    }
    if (task.failure.kind === 'mergeBlocked' && task.failure.blockedTaskIds) {
      return label + '（' + task.failure.blockedTaskIds.join(', ') + '）';
    }
    return label;
  }

  // 衝突解決セッションのバッジ文言（Issue #413 PR4）。承認待ち
  // （mergeResolutionWaitingApproval）かLLMが作業中かで出し分ける。
  function mergeResolutionBadgeLabel(task) {
    return task.mergeResolutionWaitingApproval ? 'マージ解決中（承認待ち）' : 'マージ解決中';
  }

  // ---- 最上段: 全体の進捗 ----
  // 集計そのものは拡張機能側（workflowGraph.tsのaggregateProgress。純粋関数でテスト済み）が
  // 行い、ここではその結果（progress）を表示するだけにする。以前はここでも同じ集計を
  // JavaScriptとして再実装しており、workflowGraph.ts側だけを直しても3状態
  // （waitingReply/merging/blocked）がここに反映されない食い違いの原因になっていた
  // （Issue #104が起きた背景そのもの）。

  function renderHeader(snapshot, progress) {
    const counts = progress.counts;
    const total = progress.total;

    el('runName').textContent = snapshot.name || snapshot.runId;
    el('runCounts').textContent =
      total + 'タスク中 ' + counts.done + '完了 / ' + counts.running + '実行中 / ' +
      counts.pending + '待機' +
      (counts.merging > 0 ? ' / ' + counts.merging + '統合中' : '') +
      (counts.waitingApproval > 0 ? ' / ' + counts.waitingApproval + '承認待ち' : '') +
      (counts.waitingReply > 0 ? ' / ' + counts.waitingReply + '返信待ち' : '') +
      (counts.failed > 0 ? ' / ' + counts.failed + '失敗' : '') +
      (counts.blocked > 0 ? ' / ' + counts.blocked + 'ブロック' : '') +
      (counts.skipped > 0 ? ' / ' + counts.skipped + 'スキップ' : '');
    el('progressFill').style.width = progress.percentDone + '%';
    el('progressPercent').textContent = progress.percentDone + '%';
    el('runStartedAt').setAttribute('data-started', String(Date.parse(snapshot.startedAt) || 0));

    const stopBtn = el('stopAllBtn');
    stopBtn.disabled = snapshot.outcome !== 'running';

    renderBanner(snapshot, progress);
  }

  /**
   * 承認待ち・返信待ち・失敗・統合できていないものが1件でもあれば最上段で目立たせる
   * （design.md §16.8「全体の進捗」）。複数同時に該当しうるため、該当する種別を全て
   * 1行にまとめ、最も重い種別（失敗 > 統合ブロック > 承認待ち > 返信待ち）でバナーの
   * 色を決める。
   */
  function renderBanner(snapshot, progress) {
    const banner = el('banner');
    const counts = progress.counts;
    const parts = [];
    if (progress.hasFailed) parts.push('失敗（' + counts.failed + '件）');
    if (progress.hasBlocked) parts.push('統合できていないタスク（' + counts.blocked + '件）');
    if (progress.hasWaitingApproval) parts.push('承認待ち（' + counts.waitingApproval + '件）');
    if (progress.hasWaitingReply) parts.push('返信待ち（' + counts.waitingReply + '件）');

    if (parts.length > 0) {
      banner.hidden = false;
      banner.className = progress.hasFailed ? 'failed' : progress.hasBlocked ? 'blocked' : 'approval';
      banner.textContent = parts.join(' ・ ') + '。一覧から内容を確認してください。';
      return;
    }
    if (snapshot.isDraft) {
      // ゴール文から生成した直後・未実行の下書き（design.md §16.9）。outcomeの4値には
      // 「まだ始まっていない」を表す値が無いため、専用フラグで判定する
      banner.hidden = false;
      banner.className = 'draft';
      banner.textContent =
        'これは生成された下書きです。内容を確認し、問題なければ「実行」から開始してください。';
      return;
    }
    banner.hidden = true;
    banner.textContent = '';
  }

  // ---- 依存グラフ（SVG） ----

  function markForState(state, submissionCount) {
    const group = svgEl('g', { class: 'wf-mark' });
    if (state === 'running') {
      group.appendChild(svgEl('circle', { class: 'wf-mark-running', cx: 0, cy: 0, r: 7 }));
    } else if (state === 'waitingApproval') {
      group.appendChild(svgEl('rect', { class: 'wf-mark-waiting', x: -5, y: -6, width: 3, height: 12 }));
      group.appendChild(svgEl('rect', { class: 'wf-mark-waiting', x: 2, y: -6, width: 3, height: 12 }));
    } else if (state === 'done') {
      group.appendChild(svgEl('polyline', { class: 'wf-mark-done', points: '-6,0 -2,5 7,-7' }));
    } else if (state === 'failed') {
      group.appendChild(svgEl('line', { class: 'wf-mark-failed', x1: -6, y1: -6, x2: 6, y2: 6 }));
      group.appendChild(svgEl('line', { class: 'wf-mark-failed', x1: 6, y1: -6, x2: -6, y2: 6 }));
    } else if (state === 'skipped') {
      group.appendChild(svgEl('line', { class: 'wf-mark-skipped', x1: -6, y1: 6, x2: 6, y2: -6 }));
    } else if (state === 'waitingReply') {
      // 吹き出し（design.md §16.8「waitingReply: 警告色の枠＋吹き出しの記号」）
      group.appendChild(svgEl('rect', { class: 'wf-mark-reply', x: -7, y: -6, width: 14, height: 9, rx: 2 }));
      group.appendChild(svgEl('polygon', { class: 'wf-mark-reply', points: '-3,3 1,3 -2,8' }));
    } else if (state === 'merging' || state === 'blocked') {
      // 合流の記号（design.md §16.8「merging: 完了色の枠＋合流の記号」
      // 「blocked: 警告色の枠＋合流の記号にバツ」）。2本のブランチが1本に合流する形を
      // 単純な線分3本で表す
      const markClass = state === 'merging' ? 'wf-mark-merging' : 'wf-mark-blocked';
      group.appendChild(svgEl('line', { class: markClass, x1: -6, y1: -6, x2: 0, y2: 0 }));
      group.appendChild(svgEl('line', { class: markClass, x1: -6, y1: 6, x2: 0, y2: 0 }));
      group.appendChild(svgEl('line', { class: markClass, x1: 0, y1: 0, x2: 7, y2: 0 }));
      if (state === 'blocked') {
        group.appendChild(svgEl('line', { class: 'wf-mark-blocked-x', x1: -6, y1: -7, x2: 6, y2: 7 }));
        group.appendChild(svgEl('line', { class: 'wf-mark-blocked-x', x1: 6, y1: -7, x2: -6, y2: 7 }));
      }
    }
    return group;
  }

  function buildNode(task, pos) {
    const group = svgEl('g', {
      class: 'wf-node state-' + task.state + (task.id === selectedTaskId ? ' selected' : ''),
      transform: 'translate(' + pos.x + ',' + pos.y + ')',
      'data-task-id': task.id,
    });
    const w = 168, h = 60;
    group.appendChild(svgEl('rect', { class: 'wf-node-rect', x: -w / 2, y: -h / 2, width: w, height: h, rx: 6 }));

    const mark = markForState(task.state, task.submissionCount);
    mark.setAttribute('transform', 'translate(' + (-w / 2 + 14) + ',' + (-h / 2 + 14) + ')');
    group.appendChild(mark);

    const idText = svgEl('text', { class: 'wf-id', x: -w / 2 + 26, y: -h / 2 + 18 });
    // idはYAML由来（design.mdの検証で字種は絞られているが、Viewとしては信用しない）。
    // 必ずtextContentへ代入する（HTML/SVGとして解釈させない）
    idText.textContent = task.id;
    group.appendChild(idText);

    const metaParts = [STATE_LABEL[task.state] || task.state];
    if (task.state === 'running' && task.submissionCount > 0) {
      metaParts.push(task.submissionCount + '回目');
    }
    if (task.state === 'failed') {
      const reason = describeFailure(task);
      if (reason) metaParts.push(reason);
    }
    const metaText = svgEl('text', { class: 'wf-meta', x: -w / 2 + 10, y: -h / 2 + 34 });
    metaText.textContent = metaParts.join(' ・ ');
    group.appendChild(metaText);

    // 衝突解決セッション（design.md §16.17「コンフリクト」5.）はワークフローの定義に無いため
    // ノード化しない。対象タスクのノードへ「マージ解決中」として重ねて出す（Issue #104）。
    // 押すとそのセッションのタブへ移動する（クリックハンドラは下のselectAndRevealが
    // runner.tsのrevealTask経由で衝突解決セッションを優先して開く）
    if (task.mergeResolutionActive) {
      const badge = svgEl('text', {
        class: 'wf-merge-resolution-badge',
        x: 0,
        y: h / 2 - 6,
        'text-anchor': 'middle',
      });
      badge.textContent = mergeResolutionBadgeLabel(task);
      group.appendChild(badge);
    }

    if (task.lastResponseSummary) {
      const summaryText = svgEl('text', { class: 'wf-summary', x: -w / 2 + 10, y: -h / 2 + 48 });
      const shown =
        task.lastResponseSummary.length > 26
          ? task.lastResponseSummary.slice(0, 26) + '…'
          : task.lastResponseSummary;
      summaryText.textContent = shown;
      group.appendChild(summaryText);
    }

    const title = svgEl('title');
    title.textContent = task.id + ' ・ ' + (STATE_LABEL[task.state] || task.state) +
      (task.mergeResolutionActive ? ' ・ ' + mergeResolutionBadgeLabel(task) : '') +
      (task.lastResponseSummary ? ' ・ ' + task.lastResponseSummary : '');
    group.appendChild(title);

    group.addEventListener('click', () => selectAndReveal(task.id));
    return group;
  }

  /** グラフ描画領域の内寸（px）。パネルが閉じている等で取れなければ0。 */
  function graphViewportWidth() {
    const wrap = el('graphWrap');
    if (!wrap) return 0;
    const style = window.getComputedStyle(wrap);
    const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    return Math.max(0, wrap.clientWidth - padding);
  }

  /**
   * 段の折り返しに使う幅を拡張機能へ伝える（layoutGraphのmaxWidth）。
   * 手動で縮小しているときは実寸より多くのノードが横に入るので、倍率で割った値を渡す。
   */
  function reportViewport() {
    const available = graphViewportWidth();
    if (available <= 0) return;
    const scale = zoomMode === 'manual' ? zoomScale : 1;
    const width = Math.round(available / scale);
    // スクロールバーの出入りで数px揺れるだけの変化は無視する（再レイアウトの往復で
    // 折り返しが振動するのを防ぐ）
    if (Math.abs(width - reportedGraphWidth) < 8) return;
    reportedGraphWidth = width;
    vscode.postMessage({ type: 'viewport', width });
  }

  function scheduleReportViewport() {
    clearTimeout(viewportTimer);
    viewportTimer = setTimeout(reportViewport, 150);
  }

  /** 現在の倍率。'fit'なら描画領域の幅に収まる倍率（下限 MIN_FIT_SCALE、拡大はしない）。 */
  function effectiveScale(layout) {
    if (zoomMode === 'manual') return zoomScale;
    const available = graphViewportWidth();
    if (available <= 0 || !layout || layout.width <= 0) return 1;
    return Math.max(MIN_FIT_SCALE, Math.min(1, available / layout.width));
  }

  /** SVGの表示サイズ（viewBoxは実寸のまま）と倍率表示を現在の倍率へ合わせる。 */
  function applyGraphScale() {
    const layout = currentLayout;
    if (!layout) return;
    const svg = el('graph');
    const scale = effectiveScale(layout);
    const height = Math.max(1, layout.height);
    svg.setAttribute('width', String(Math.max(1, Math.round(layout.width * scale))));
    svg.setAttribute('height', String(Math.max(1, Math.round(height * scale))));
    const label = el('graphZoomLabel');
    label.textContent = Math.round(scale * 100) + '%' + (zoomMode === 'fit' ? '（自動）' : '');
    el('graphZoomFitBtn').disabled = zoomMode === 'fit';
    el('graphZoomInBtn').disabled = zoomMode === 'manual' && zoomScale >= MAX_ZOOM;
    el('graphZoomOutBtn').disabled = zoomMode === 'manual' && zoomScale <= MIN_ZOOM;
    el('graphWrapNote').hidden = !layout.wrapped;
  }

  function setZoom(next) {
    zoomMode = 'manual';
    zoomScale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    applyGraphScale();
    // 倍率が変わると1行に入るノード数も変わるため、折り返し幅を伝え直す
    scheduleReportViewport();
  }

  // 辺の矢印。markerの中身は参照元のstrokeを継承しないため、色ごとに別idで用意する。
  // 濃淡（dim / faded）は参照元のopacityがmarkerごと下げてくれるので、id は色の2種類で足りる
  const ARROW_IDS = { normal: 'wfArrow', related: 'wfArrowRelated' };

  function arrowIdFor(related) {
    return related ? ARROW_IDS.related : ARROW_IDS.normal;
  }

  function buildArrowDefs() {
    const defs = svgEl('defs');
    const variants = [
      { id: ARROW_IDS.normal, cls: 'wf-arrow-head' },
      { id: ARROW_IDS.related, cls: 'wf-arrow-head related' },
    ];
    for (const v of variants) {
      const marker = svgEl('marker', {
        id: v.id,
        viewBox: '0 0 10 10',
        refX: 9,
        refY: 5,
        markerWidth: 6,
        markerHeight: 6,
        orient: 'auto-start-reverse',
      });
      marker.appendChild(svgEl('path', { class: v.cls, d: 'M 0 0 L 10 5 L 0 10 z' }));
      defs.appendChild(marker);
    }
    return defs;
  }

  /**
   * 依存元の下端から依存先の上端へ引く3次ベジェ。制御点を縦方向へ伸ばして、
   * 出入りの向きを縦に揃える（同じ段へ折り返した辺でも破綻しないよう最低量を確保する）
   */
  function edgePath(x1, y1, x2, y2) {
    const k = Math.max(18, Math.abs(y2 - y1) / 2);
    return 'M ' + x1 + ' ' + y1 +
      ' C ' + x1 + ' ' + (y1 + k) + ', ' + x2 + ' ' + (y2 - k) + ', ' + x2 + ' ' + y2;
  }

  function renderGraph(snapshot, layout) {
    const svg = el('graph');
    svg.replaceChildren();
    svg.setAttribute('viewBox', '0 0 ' + layout.width + ' ' + Math.max(1, layout.height));
    svg.setAttribute('preserveAspectRatio', 'xMidYMin meet');

    const byId = {};
    for (const t of snapshot.tasks) byId[t.id] = t;
    const posById = {};
    for (const n of layout.nodes) posById[n.id] = n;

    svg.appendChild(buildArrowDefs());

    // 依存が選ばれているあいだは、その入出力の辺だけを濃くする（Issue #282）。
    // 段が広いと辺が何本も交差するため、色の濃淡で追う先を1本に絞る
    const hasSelection = Boolean(selectedTaskId && posById[selectedTaskId]);
    const edgeGroup = svgEl('g', { class: 'wf-edges' });
    for (const edge of layout.edges) {
      const from = posById[edge.from];
      const to = posById[edge.to];
      if (!from || !to) continue;
      const fromTask = byId[edge.from];
      const dim = !fromTask || fromTask.state !== 'done';
      const related = hasSelection && (edge.from === selectedTaskId || edge.to === selectedTaskId);
      const faded = hasSelection && !related;
      const classes = 'wf-edge' + (dim ? ' dim' : '') + (related ? ' related' : '') +
        (faded ? ' faded' : '');
      const path = svgEl('path', {
        class: classes,
        d: edgePath(from.x, from.y + 30, to.x, to.y - 30),
        'marker-end': 'url(#' + arrowIdFor(related) + ')',
      });
      edgeGroup.appendChild(path);
    }
    svg.appendChild(edgeGroup);

    const nodeGroup = svgEl('g', { class: 'wf-nodes' });
    for (const n of layout.nodes) {
      const task = byId[n.id];
      if (!task) continue;
      nodeGroup.appendChild(buildNode(task, n));
    }
    svg.appendChild(nodeGroup);
    applyGraphScale();
  }

  // ---- タスク一覧 ----

  /**
   * 「続ける」を出せるか（issue #284）。回数切れで止まっていて、かつこのウィンドウに
   * セッションが残っているタスクだけ。リロードするとセッションは失われるため、
   * そのあとは「再実行」だけになる。
   */
  function canContinueTask(task) {
    // 回数切れ（maxReached）に加え、停滞（stalled、design.md §16.27、Issue #336）も
    // 同じ会話のまま続けられる。どちらもセッションは生きたまま止まっている
    return (
      task.state === 'failed'
      && task.failure
      && (task.failure.kind === 'maxReached' || task.failure.kind === 'stalled')
      && task.hasLiveSession === true
    );
  }

  function buildOpsCell(task) {
    const cell = el2('td', 'ops');
    if (task.hasLiveSession) {
      const openBtn = text('button', 'secondary', '開く');
      openBtn.type = 'button';
      openBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'reveal', taskId: task.id });
      });
      cell.appendChild(openBtn);
    }
    if (task.state === 'running') {
      const interruptBtn = text('button', 'secondary', '中断');
      interruptBtn.type = 'button';
      interruptBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'interrupt', taskId: task.id });
      });
      cell.appendChild(interruptBtn);
    }
    // mergingは、衝突解決セッションが実際に生きている（task.mergeResolutionActive）
    // ときだけ出す。タスク自身のループは既に終わっているが、統合worktreeで開く解決
    // セッションはそちらのstopLoop()で止められる（issue #514）。生きていないmerging
    // （解決セッションが無い状態）にはボタンを出しても届く先が無い
    if (
      task.state === 'running'
      || task.state === 'waitingApproval'
      || (task.state === 'merging' && task.mergeResolutionActive)
    ) {
      const stopBtn = text('button', 'danger', 'タスク停止');
      stopBtn.type = 'button';
      stopBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'stopTask', taskId: task.id });
      });
      cell.appendChild(stopBtn);
    }
    if (canContinueTask(task)) {
      // 回数切れ（maxReached）・停滞（stalled、design.md §16.27、Issue #336）で
      // 止まったタスクだけに出す（design.md §16.8、issue #284）。
      // セッションが生きている間しか続きから走らせられないため、hasLiveSessionも見る
      const continueBtn = text('button', 'secondary', '続ける');
      continueBtn.type = 'button';
      continueBtn.title = '同じ会話のまま、送信回数の上限をもう一度足して続きを走らせる';
      continueBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'continueTask', taskId: task.id });
      });
      cell.appendChild(continueBtn);
    }
    if (task.state === 'failed' || task.state === 'skipped') {
      const retryBtn = text('button', 'secondary', '再実行');
      retryBtn.type = 'button';
      retryBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'retry', taskId: task.id });
      });
      cell.appendChild(retryBtn);
    }
    if (task.state === 'blocked') {
      // design.md §16.17「Viewから人が解決したうえで『再マージ』を指示できる」。
      // runner.tsのretryMergeをそのまま呼ぶ（人が統合worktreeで手元の衝突を解いた後を想定）
      const retryMergeBtn = text('button', 'secondary', '再マージ');
      retryMergeBtn.type = 'button';
      retryMergeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'retryMerge', taskId: task.id });
      });
      cell.appendChild(retryMergeBtn);
    }
    if (task.pullRequestUrl) {
      // design.md §16.8「タスクの一覧から、そのタスクのPR/MRを開けるようにする」・Issue #118。
      // URLはWebviewから渡さず、拡張機能側（workflowView.ts）がtaskIdから引いて開く
      // （https以外のスキームを開かないガードも拡張機能側に集約する）
      const openPrBtn = text('button', 'secondary', 'PR/MRを開く');
      openPrBtn.type = 'button';
      openPrBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'openTaskPullRequest', taskId: task.id });
      });
      cell.appendChild(openPrBtn);
    }
    // 展開後のプロンプト（design.md §16.4 案1「見せる」、Issue #67）。
    // {{T1.result}}等がどう膨らんだかを実際の文面で確認できるようにする
    if (typeof task.expandedPrompt === 'string') {
      const isOpen = openPromptTaskIds.has(task.id);
      const promptBtn = text(
        'button',
        'secondary',
        isOpen ? 'プロンプトを閉じる' : 'プロンプトを見る',
      );
      promptBtn.type = 'button';
      promptBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePromptRow(task.id);
      });
      cell.appendChild(promptBtn);
    }
    return cell;
  }

  function buildApprovalRow(task) {
    const row = el2('tr', 'approval-row');
    const cell = document.createElement('td');
    cell.colSpan = 8;
    const box = el2('div', 'approval-box');

    const heading = text('div', 'kind', task.pendingApproval.kind + ' の承認要求: ');
    const titleSpan = document.createElement('span');
    // title/detailはCLI・エージェント由来（design.md §16.7）。必ずtextContentへ代入する
    titleSpan.textContent = task.pendingApproval.title;
    heading.appendChild(titleSpan);
    box.appendChild(heading);

    if (task.pendingApproval.detail) {
      box.appendChild(text('pre', 'detail', task.pendingApproval.detail));
    }

    const actions = el2('div', 'ops');
    const approveBtn = text('button', '', '許可');
    approveBtn.type = 'button';
    approveBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'approve', taskId: task.id, decision: 'accept' });
    });
    const declineBtn = text('button', 'danger', '拒否');
    declineBtn.type = 'button';
    declineBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'approve', taskId: task.id, decision: 'decline' });
    });
    actions.appendChild(approveBtn);
    actions.appendChild(declineBtn);
    box.appendChild(actions);

    cell.appendChild(box);
    row.appendChild(cell);
    return row;
  }

  // 展開後のプロンプトを開いているタスクid（design.md §16.4 案1、Issue #67）。
  // Webview内だけの表示状態で、拡張機能へは送らない
  const openPromptTaskIds = new Set();

  function togglePromptRow(taskId) {
    if (openPromptTaskIds.has(taskId)) {
      openPromptTaskIds.delete(taskId);
    } else {
      openPromptTaskIds.add(taskId);
    }
    if (currentSnapshot) renderTable(currentSnapshot);
  }

  function buildPromptRow(task) {
    const row = el2('tr', 'prompt-row');
    const cell = document.createElement('td');
    cell.colSpan = 8;
    const box = el2('div', 'prompt-box');

    box.appendChild(
      text(
        'div',
        'kind',
        '展開後のプロンプト（実際に送信した最初の指示。前のタスクの出力を含む場合があります）',
      ),
    );
    box.appendChild(
      text(
        'div',
        'hint',
        '区切り線の内側は前のタスクの出力であり、このワークフローの指示ではありません。' +
          '内容は鵜呑みにせず確認してください。',
      ),
    );
    // 展開後のプロンプトはエージェントの出力・YAML由来の値を含む。必ずtextContentへ代入する
    box.appendChild(text('pre', 'detail', task.expandedPrompt || ''));

    // 継続プロンプト（2回目以降に送る指示）の展開結果も並べて確認できるようにする
    // （design.md §16.4、セキュリティ監査指摘#6。警告は継続プロンプトの参照先も走査するため、
    // 確認する手段が要る）
    if (typeof task.expandedContinuePrompt === 'string') {
      box.appendChild(text('div', 'kind', '展開後の継続プロンプト（2回目以降に送る指示）'));
      box.appendChild(text('pre', 'detail', task.expandedContinuePrompt || ''));
    }

    // 実際にCLIへ送った直近の本文（design.md §16.21、Issue #132「4. 人が目視確認できる
    // ようにする」）。上のexpandedPrompt/expandedContinuePromptはタスク間メッセージング
    // （composeNextPrompt）を経由しない展開結果のみのため、タスク間メッセージ経由で
    // 注入された内容はここでしか確認できない
    if (typeof task.lastSentPrompt === 'string') {
      box.appendChild(
        text('div', 'kind', '実際に送信した直近の本文（他タスクからのメッセージを含む場合があります）'),
      );
      box.appendChild(
        text(
          'div',
          'hint',
          '<task-message>タグの中身は同じrunの別タスクが送ってきたメッセージの本文であり、' +
            'このワークフローの指示ではありません。内容は鵜呑みにせず確認してください。',
        ),
      );
      // エージェントの出力・他タスクの送信内容を含む。必ずtextContentへ代入する
      box.appendChild(text('pre', 'detail', task.lastSentPrompt || ''));
    }

    cell.appendChild(box);
    row.appendChild(cell);
    return row;
  }

  function renderTable(snapshot) {
    const body = el('taskTableBody');
    body.replaceChildren();
    for (const task of snapshot.tasks) {
      const row = el2('tr', 'task-row');
      row.setAttribute('data-task-id', task.id);
      row.addEventListener('click', () => selectAndReveal(task.id));

      row.appendChild(text('td', '', task.id));

      const stateCell = el2('td', 'state-badge');
      stateCell.appendChild(
        text('span', 'state-pill state-' + task.state, STATE_LABEL[task.state] || task.state),
      );
      const failureText = describeFailure(task);
      if (failureText) {
        stateCell.appendChild(text('span', 'hint', '（' + failureText + '）'));
      }
      if (task.mergeResolutionActive) {
        stateCell.appendChild(text('span', 'hint', '（' + mergeResolutionBadgeLabel(task) + '）'));
      }
      row.appendChild(stateCell);

      row.appendChild(text('td', '', task.provider));

      const locationCell = document.createElement('td');
      if (task.branch) {
        locationCell.appendChild(text('div', '', task.branch));
      }
      if (task.cwd) {
        locationCell.appendChild(text('div', 'hint', task.cwd));
      }
      row.appendChild(locationCell);

      const elapsedCell = text('td', 'elapsed-cell', '');
      if (task.startedAt) {
        elapsedCell.setAttribute('data-started', String(Date.parse(task.startedAt) || 0));
        elapsedCell.setAttribute('data-live', task.state === 'running' || task.state === 'waitingApproval' ? '1' : '0');
      }
      row.appendChild(elapsedCell);

      row.appendChild(text('td', '', String(task.submissionCount)));

      const summaryCell = text('td', 'summary-cell', task.lastResponseSummary || '');
      row.appendChild(summaryCell);

      row.appendChild(buildOpsCell(task));

      body.appendChild(row);
      if (task.pendingApproval) {
        body.appendChild(buildApprovalRow(task));
      }
      if (openPromptTaskIds.has(task.id) && typeof task.expandedPrompt === 'string') {
        body.appendChild(buildPromptRow(task));
      }
    }
    el('taskTable').hidden = snapshot.tasks.length === 0;
  }

  // ---- 警告欄 ----

  // ---- 最上段: オーケストレーター欄（design.md §16.23「会話のUI」） ----

  /**
   * 直近の応答の1行要約・状態（応答中／待機）・未読の印を出し、1行入力と会話を開くを
   * 有効／無効にする。**応答の全文はここに出さない**（拡張機能側も送ってこない）。全文・
   * 承認カード・Markdown描画は会話を開くで前面に出す既存のチャット画面が担う。
   *
   * 要約はエージェントの出力なので、必ずtextContentへ代入して挿入する
   * （design.md §16.8「画面に出す動的な文字列は必ずテキストノードとして挿入する」）。
   */
  function renderOrchestrator(snapshot) {
    const box = el('orchestrator');
    const orch = snapshot.orchestrator;
    if (!orch) {
      // 拡張機能が欄の値を送ってこないrun（下書きプレビュー等）では欄そのものを出さない
      box.hidden = true;
      return;
    }
    box.hidden = false;

    const input = el('orchInput');
    const sendBtn = el('orchSendBtn');
    const openBtn = el('orchOpenBtn');
    input.disabled = !orch.available;
    sendBtn.disabled = !orch.available;
    openBtn.disabled = !orch.available;

    if (!orch.available) {
      el('orchStatus').textContent = '利用できません';
      el('orchSummary').textContent =
        'このrunではオーケストレーターセッションを開けていません（生成に失敗した、または拡張機能をリロードして復元したrunです）。';
      el('orchUnread').hidden = true;
      return;
    }

    el('orchStatus').textContent = orch.busy ? '応答中' : '待機';
    el('orchSummary').textContent = orch.lastResponseSummary || 'まだ応答はありません。';
    const unread = el('orchUnread');
    unread.hidden = orch.unreadCount <= 0;
    unread.textContent = '未読 ' + orch.unreadCount;
  }

  /**
   * 「ask_user」（design.md §16.33）の回答待ちを描く。質問文・選択肢はエージェント
   * （オーケストレーター）の出力に由来する文字列なので、必ずtextContentへ代入する
   * （design.md §16.8「画面に出す動的な文字列は必ずテキストノードとして挿入する」）。
   *
   * リロード後（「hasLiveSession: false」）は永続化された問いの文言だけを表示し、
   * 選択ボタンは無効にする（答える経路がまだ無い。design.md §16.33「永続化」）。
   */
  function renderAskUser(snapshot) {
    const box = el('orchAskUser');
    box.replaceChildren();
    const pending = snapshot.pendingAskUser;
    if (!pending) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    box.appendChild(text('div', 'orch-ask-user-question', pending.question));
    if (!pending.hasLiveSession) {
      box.appendChild(
        text('div', 'hint', 'このセッションは復元できていないため、いまは回答できません。'),
      );
      return;
    }
    const choicesBox = el2('div', 'orch-ask-user-choices');
    pending.choices.forEach((choice, index) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = choice;
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: 'answerAskUser', choiceIndex: index });
      });
      choicesBox.appendChild(btn);
    });
    box.appendChild(choicesBox);
  }

  /** 入力欄の内容を送って空にする。空白のみの入力は送らない（拡張機能側も弾く）。 */
  function sendOrchestratorInput() {
    const input = el('orchInput');
    const text = input.value;
    if (!text.trim()) return;
    vscode.postMessage({ type: 'orchestratorSend', text: text });
    input.value = '';
  }

  function renderWarnings(snapshot) {
    const box = el('warnings');
    box.replaceChildren();
    for (const w of snapshot.warnings) {
      const item = el2('div', 'warning-item ' + w.kind);
      const prefix = w.taskId ? '[' + w.taskId + '] ' : '';
      item.textContent = prefix + w.message;
      box.appendChild(item);
    }
    el('warningsSection').hidden = snapshot.warnings.length === 0;
  }

  // ---- そのほか: 統合の状況（design.md §16.8「そのほか」・§16.11・§16.17・§16.18） ----

  /**
   * 統合ブランチ名・取り込み済みタスク数・統合PR/MRへのリンク・最終マージの結果を表示する
   * （Issue #118）。PR/MRが作られていなければ番号・URLの行を出さず、runが終わっている
   * （outcomeが'running'でない）場合だけ「作成されていません」と明示する（受入基準
   * 「PR/MRが作られなかったrunでは...作られなかったことが分かるようにする」）。
   */
  function renderIntegration(snapshot, integration) {
    const box = el('integrationInfo');
    box.replaceChildren();
    const openBtn = el('openIntegrationPrBtn');
    if (!integration) {
      el('integrationSection').hidden = true;
      openBtn.disabled = true;
      return;
    }
    el('integrationSection').hidden = false;
    // ブランチ名はgit由来（design.md §16.8「画面に出す動的な文字列は必ずテキストノードとして
    // 挿入する」）。必ずtextContentへ代入する
    box.appendChild(text('div', '', '統合ブランチ: ' + integration.branch));
    box.appendChild(text('div', '', '取り込み済みタスク: ' + integration.mergedTaskCount + '件'));

    if (integration.pullRequestUrl) {
      const label = integration.pullRequestNumber
        ? '統合PR/MR: #' + integration.pullRequestNumber
        : '統合PR/MR: 作成済み';
      box.appendChild(text('div', '', label));
      openBtn.disabled = false;
    } else {
      openBtn.disabled = true;
      if (snapshot.outcome !== 'running') {
        box.appendChild(text('div', 'hint', '統合PR/MRは作成されていません'));
      }
    }

    if (integration.finalMergeOutcome === 'merged') {
      box.appendChild(text('div', '', 'mainへの最終マージ: 完了'));
    } else if (integration.finalMergeOutcome === 'failed') {
      box.appendChild(text('div', 'hint', 'mainへの最終マージ: 失敗'));
    } else if (integration.finalMergeOutcome === 'held') {
      // design.md §16.26。finalMerge: orchestrator/confirmで「マージしない」と
      // 判断された（またはタイムアウトでholdへ倒れた）状態。理由はsnapshot.warnings
      // （finalMergeDecision種別）に記録済みで、警告欄側に表示される
      box.appendChild(text('div', 'hint', 'mainへの最終マージ: 保留（マージしない）'));
    } else if (integration.finalMergeDecision !== undefined) {
      // design.md §16.26。判断待ち。confirmモードは人がここで応答する
      // （decideFinalMergeメッセージ→workflowView.ts→WorkflowRunner.decideFinalMerge）。
      // サンドボックス化されたwebviewではwindow.promptが使えない場合があるため、
      // orchInput（オーケストレーターへの発話欄）と同じ「テキスト欄+ボタン」の形にする
      box.appendChild(text('div', 'hint', 'mainへの最終マージ: 判断待ち'));
      if (integration.finalMergeDecision.mode === 'confirm') {
        const reasonInput = document.createElement('input');
        reasonInput.type = 'text';
        reasonInput.placeholder = '判断の理由（必須）';
        const mergeBtn = document.createElement('button');
        mergeBtn.type = 'button';
        mergeBtn.textContent = 'mainへマージする';
        mergeBtn.addEventListener('click', () => {
          const reason = reasonInput.value;
          if (!reason.trim()) return;
          vscode.postMessage({ type: 'decideFinalMerge', decision: 'merge', reason: reason });
        });
        const holdBtn = document.createElement('button');
        holdBtn.type = 'button';
        holdBtn.textContent = 'マージしない';
        holdBtn.addEventListener('click', () => {
          const reason = reasonInput.value;
          if (!reason.trim()) return;
          vscode.postMessage({ type: 'decideFinalMerge', decision: 'hold', reason: reason });
        });
        box.appendChild(reasonInput);
        box.appendChild(mergeBtn);
        box.appendChild(holdBtn);
      }
    }
  }

  // ---- 選択・操作 ----

  let selectedTaskId = undefined;

  function selectAndReveal(taskId) {
    selectedTaskId = taskId;
    if (currentSnapshot && currentLayout) {
      renderGraph(currentSnapshot, currentLayout);
    }
    const task = findTask(taskId);
    if (task && (task.hasLiveSession || task.mergeResolutionActive)) {
      vscode.postMessage({ type: 'reveal', taskId });
    }
  }

  // ---- runの切り替え ----

  function applyRuns(runs) {
    currentRuns = runs;
    const select = el('runSelect');
    select.replaceChildren();
    for (const r of runs) {
      const opt = document.createElement('option');
      opt.value = r.runId;
      opt.textContent = (r.name || r.runId) + '（' + r.outcome + '）';
      select.appendChild(opt);
    }
    select.hidden = runs.length <= 1;
    if (currentSnapshot) select.value = currentSnapshot.runId;
    el('empty').hidden = runs.length > 0;
  }

  function applyState(snapshot, layout, progress, integration) {
    currentSnapshot = snapshot;
    currentLayout = layout;
    el('content').hidden = false;
    el('empty').hidden = true;
    renderHeader(snapshot, progress);
    renderOrchestrator(snapshot);
    renderAskUser(snapshot);
    renderGraph(snapshot, layout);
    renderTable(snapshot);
    renderWarnings(snapshot);
    renderIntegration(snapshot, integration);
    // 初回表示（contentのhidden解除）直後は描画領域の幅が確定するので折り返し幅を伝える
    scheduleReportViewport();
    const select = el('runSelect');
    if (select.value !== snapshot.runId) select.value = snapshot.runId;
  }

  function applyNoRun() {
    currentSnapshot = null;
    currentLayout = null;
    el('content').hidden = true;
    el('empty').hidden = false;
    el('openIntegrationPrBtn').disabled = true;
    // オーケストレーター欄は#header側にあり#contentのhiddenでは消えないため明示的に隠す
    el('orchestrator').hidden = true;
    el('orchAskUser').hidden = true;
  }

  // ---- 経過時間: ローカルで毎秒更新する（拡張機能からは状態が変わったときだけ届く） ----

  setInterval(() => {
    const started = el('runStartedAt');
    const ts = Number(started.getAttribute('data-started') || '0');
    if (ts > 0) {
      started.textContent = '経過 ' + formatElapsed(Date.now() - ts);
    }
    document.querySelectorAll('.elapsed-cell[data-live="1"]').forEach((cellNode) => {
      const cell = cellNode;
      const cellTs = Number(cell.getAttribute('data-started') || '0');
      if (cellTs > 0) {
        cell.textContent = formatElapsed(Date.now() - cellTs);
      }
    });
  }, 1000);

  // ---- 操作 ----

  // 'fit'から拡大・縮小するときは今見えている倍率を起点にする（1.0起点だと見た目が飛ぶ）
  el('graphZoomInBtn').addEventListener('click', () =>
    setZoom(effectiveScale(currentLayout) * ZOOM_STEP),
  );
  el('graphZoomOutBtn').addEventListener('click', () =>
    setZoom(effectiveScale(currentLayout) / ZOOM_STEP),
  );
  el('graphZoomFitBtn').addEventListener('click', () => {
    zoomMode = 'fit';
    applyGraphScale();
    scheduleReportViewport();
  });

  // パネル幅が変わったら折り返し幅を伝え直し、'fit'なら倍率も追随させる
  // （ResizeObserverはVSCodeのWebview（Chromium）で常に使える）
  const graphResizeObserver = new ResizeObserver(() => {
    applyGraphScale();
    scheduleReportViewport();
  });
  graphResizeObserver.observe(el('graphWrap'));

  el('runSelect').addEventListener('change', (e) => {
    vscode.postMessage({ type: 'selectRun', runId: e.target.value });
  });
  el('runBtn').addEventListener('click', () => vscode.postMessage({ type: 'run' }));
  el('stopAllBtn').addEventListener('click', () => vscode.postMessage({ type: 'stopAll' }));
  el('removeWorktreesBtn').addEventListener('click', () =>
    vscode.postMessage({ type: 'removeWorktrees' }),
  );
  el('openDefBtn').addEventListener('click', () => vscode.postMessage({ type: 'openDefFile' }));
  el('openIntegrationPrBtn').addEventListener('click', () =>
    vscode.postMessage({ type: 'openIntegrationPullRequest' }),
  );
  el('cleanupIntegrationBtn').addEventListener('click', () =>
    vscode.postMessage({ type: 'cleanupIntegration' }),
  );

  // オーケストレーター欄（design.md §16.23「会話のUI」）。Enterでも送れるようにする
  // （1行の指示をViewから離れずに送るための欄なので、改行を入れる用途が無い）
  el('orchSendBtn').addEventListener('click', sendOrchestratorInput);
  el('orchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      sendOrchestratorInput();
    }
  });
  el('orchOpenBtn').addEventListener('click', () =>
    vscode.postMessage({ type: 'orchestratorReveal' }),
  );
  el('orchSummary').addEventListener('click', () => {
    // 要約の押下でも会話を開く（design.md §16.23「会話を開く（またはオーケストレーター
    // 欄の要約の押下）で同じ画面を前面に出す」）
    if (!el('orchOpenBtn').disabled) {
      vscode.postMessage({ type: 'orchestratorReveal' });
    }
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'runs') {
      applyRuns(msg.runs);
    } else if (msg.type === 'state') {
      applyState(msg.snapshot, msg.layout, msg.progress, msg.integration);
    } else if (msg.type === 'noRun') {
      applyNoRun();
    }
  });

  vscode.postMessage({ type: 'ready' });
`;
}
