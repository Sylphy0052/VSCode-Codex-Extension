/**
 * 依存グラフのSVG描画に使う部品（Issue #1465 分割案8b-2）。ワークフロー画面
 * （`workflowScript.ts`）とロードマップのKanban（`roadmapKanbanView.ts`）の両方に埋め込む
 * （`COMPLETION_EVIDENCE_SOURCE` と同じ流儀）。
 *
 * 座標は拡張機能側の `layoutGraph`（`workflowGraph.ts`）が決める。ここにあるのは
 * 要素の作成・文字の切り詰め・辺の曲線・矢印の定義だけで、ノードの中身は各画面が描く。
 * 外部由来の文字列は呼び出し側が `textContent` で入れる（ここでも文字列結合でSVGへ埋め込まない）。
 */
export const GRAPH_SVG_SOURCE = `var SVGNS = 'http://www.w3.org/2000/svg';

  function svgEl(tag, attrs) {
    const node = document.createElementNS(SVGNS, tag);
    if (attrs) {
      for (const key of Object.keys(attrs)) {
        node.setAttribute(key, String(attrs[key]));
      }
    }
    return node;
  }

  /**
   * ノード内の文字を、実測幅がmaxWidthに収まるまで末尾から削って省略記号を付ける
   * （issue #1011）。
   *
   * **SVGへappendしたあとに呼ぶこと。** getComputedTextLengthはDOMへ接続され描画されて
   * いる要素でしか測れず、未接続・非表示では0を返す。0が返ったときは何もしない
   * （ノードのクリップが隣のノードへのはみ出しだけは防ぐ）。
   *
   * **測定の回数を抑える。** textContentの書き換えと測定を交互に行うと、そのたびに
   * レイアウトが同期で走る。タスクは1runあたり最大50件、1ノードに3つの文字列があるので、
   * 1文字列あたりの測定回数がそのまま効いてくる。幅は文字数にほぼ比例するため、直前の
   * 測定値から次の候補を比率で推定し、推定が範囲外へ出たときだけ二分探索へ落とす。
   * 日本語26文字の要約で測定3回（二分探索のみなら5回）だった。
   */
  function fitNodeText(node, maxWidth) {
    const full = node.textContent;
    if (full === '') return;
    let width = node.getComputedTextLength();
    if (width === 0 || width <= maxWidth) return;
    // lo: 収まると確認できた文字数。hi: 収まる可能性が残っている上限
    // （full全体は超過すると分かっているので、最低1文字は削る）
    let lo = 0;
    let hi = full.length - 1;
    let count = full.length;
    let probe = Math.min(hi, Math.max(1, Math.floor((full.length * maxWidth) / width)));
    while (lo < hi) {
      node.textContent = full.slice(0, probe) + '…';
      width = node.getComputedTextLength();
      count = probe;
      if (width <= maxWidth) {
        lo = probe;
      } else {
        hi = probe - 1;
      }
      if (lo >= hi) break;
      // 比率での推定がloより先へ進まない・hiを超えるときは二分探索へ落とす
      // （進まない候補を測り続けると終わらない）
      const next = Math.floor((count * maxWidth) / width);
      probe = next > lo && next <= hi ? next : Math.ceil((lo + hi) / 2);
    }
    // 1文字＋省略記号すら入らないとき（極端に幅の広い文字）は空にする。
    // 枠の外へ出すよりは何も出さないほうがよい
    node.textContent = lo > 0 ? full.slice(0, lo) + '…' : '';
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

  /**
   * 辺の矢印。markerの中身は参照元のstrokeを継承しないため、色ごとに別idで作る。
   * clsは矢印の塗りを決めるクラス。
   */
  function arrowMarker(id, cls) {
    const marker = svgEl('marker', {
      id: id,
      viewBox: '0 0 10 10',
      refX: 9,
      refY: 5,
      markerWidth: 6,
      markerHeight: 6,
      orient: 'auto-start-reverse',
    });
    marker.appendChild(svgEl('path', { class: cls, d: 'M 0 0 L 10 5 L 0 10 z' }));
    return marker;
  }
`;
