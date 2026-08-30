import { MERGE_TURNS_SOURCE } from './progressDelta';

/**
 * 進捗画面（issue #721、見た目の作り直しは issue #781）のWebviewで動くスクリプト。
 *
 * `workflowScript.ts` と同じ方針。テンプレートリテラルの中身なのでTypeScriptの型検査も
 * lintも効かない（`test/unit/webviewScript.test.ts` で構文だけ機械的に確かめる）。
 *
 * セキュリティ上の要点: 指示・応答・ファイルパス・コマンド・TODOの本文はすべて
 * エージェントの出力に由来する。文字列結合でHTMLへ埋め込まず、必ず
 * `document.createElement` で作ったノードの `.textContent` へ入れる。
 * `innerHTML` はこのファイルのどこにも登場しない。
 *
 * アイコンはインラインSVGで組み立てる（`document.createElementNS`）。codiconのフォントは
 * 使わない: `.vscodeignore` が `node_modules/**` を落とし `vsce package --no-dependencies`
 * で固めるため、webviewUriで参照しても配布物に入らず黙って壊れる。SVGにしておけば
 * CSP（`default-src 'none'`、`img-src` も `font-src` も無し）を広げずに済む。
 */
export function progressScript(): string {
  return `
  const vscode = acquireVsCodeApi();
  const el = (id) => document.getElementById(id);

  const SVG_NS = 'http://www.w3.org/2000/svg';

  /**
   * アイコンの形。値は 16x16 のviewBox上のパス。
   * fill を塗るものは 'fill'、線で描くものは 'stroke' に分けて持つ。
   */
  const ICONS = {
    check: { stroke: ['M3 8.5 L6.5 12 L13 4.5'] },
    circle: { stroke: ['M8 2.5 A5.5 5.5 0 1 0 8 13.5 A5.5 5.5 0 1 0 8 2.5'] },
    half: {
      stroke: ['M8 2.5 A5.5 5.5 0 1 0 8 13.5 A5.5 5.5 0 1 0 8 2.5'],
      fill: ['M8 3 A5 5 0 0 1 8 13 Z'],
    },
    file: { stroke: ['M4 1.5 L9.5 1.5 L12.5 4.5 L12.5 14.5 L4 14.5 Z', 'M9.5 1.5 L9.5 4.5 L12.5 4.5'] },
    terminal: { stroke: ['M2 2.5 L14 2.5 L14 13.5 L2 13.5 Z', 'M4.5 6 L6.5 8 L4.5 10', 'M8.5 10.5 L11.5 10.5'] },
    plus: { stroke: ['M8 3.5 L8 12.5', 'M3.5 8 L12.5 8'] },
    minus: { stroke: ['M3.5 8 L12.5 8'] },
    play: { fill: ['M5 3 L12 8 L5 13 Z'] },
    list: { stroke: ['M2.5 4 L13.5 4', 'M2.5 8 L13.5 8', 'M2.5 12 L9 12'] },
    clock: { stroke: ['M8 2.5 A5.5 5.5 0 1 0 8 13.5 A5.5 5.5 0 1 0 8 2.5', 'M8 5 L8 8 L10.5 9.5'] },
    folder: { stroke: ['M1.5 3.5 L6 3.5 L7.5 5.5 L14.5 5.5 L14.5 12.5 L1.5 12.5 Z'] },
  };

  /** TODOの状態ごとのアイコン。未知の値が来たときは未着手として出す。 */
  const TODO_ICON = { completed: 'check', in_progress: 'half', pending: 'circle' };
  /** 印だけでは読み上げに乗らないため、同じ状態を文字でも持つ。 */
  const TODO_LABEL = { completed: '完了', in_progress: '着手中', pending: '未着手' };
  const CHANGE_LABEL = { added: '追加', started: '着手', completed: '完了', removed: '取り下げ' };
  const CHANGE_ICON = { added: 'plus', started: 'play', completed: 'check', removed: 'minus' };

  /** 閉じずに開いたまま出すターン数（末尾から数える）。 */
  const OPEN_TURNS = 3;
  /** 「作り直すターンは1つも無い」を表す（issue #1025）。undefined は全量の作り直しを指す。 */
  const EMPTY_CHANGED = new Set();
  /**
   * ターン番号 → 開閉。自分で開閉したターンだけを覚え、触っていないターンは
   * OPEN_TURNS の既定に従わせる（issue 750）。render は状態が届くたびに
   * タイムラインを作り直すので、開閉をDOM側に置いたままにはできない。
   */
  const turnOpen = {};
  /** 応答中か。renderSummary が更新し、renderTimeline が既定の開閉を決めるのに使う。 */
  let isBusy = false;
  /** ファイル一覧を畳まずに出す件数。これを超えた分は「もっと見る」の裏へ回す。 */
  const FILES_SHOWN = 20;
  /**
   * ファイル一覧を全件出すか（issue #1013）。renderFiles は状態が届くたびに一覧を
   * 作り直すので、開いた状態をDOM側に置いたままにはできない。応答中の状態通知は
   * 間引き後でも 50ms 間隔（STATE_POST_INTERVAL_MS）で届くため、覚えておかないと
   * 「もっと見る」を押した直後に畳み戻る。turnOpen と同じ理由・同じ持ち方。
   */
  let filesExpanded = false;

  /**
   * アイコンを作る。label を渡した場合だけ読み上げの対象にする。
   *
   * 文字が横に並ぶアイコン（ファイル・コマンドなど）は飾りなので aria-hidden にする。
   * 状態そのものをアイコンだけで表す箇所（TODOの印など）は、以前は '[x]' のような
   * 文字で読めていた。ラベルを付けないとそこだけ読み上げから消えるため、
   * title を持たせて role=img で拾わせる。
   */
  function icon(name, label) {
    const shape = ICONS[name] || ICONS.circle;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('focusable', 'false');
    if (label === undefined || label === '') {
      svg.setAttribute('aria-hidden', 'true');
    } else {
      svg.setAttribute('role', 'img');
      const title = document.createElementNS(SVG_NS, 'title');
      title.textContent = label;
      svg.appendChild(title);
    }
    for (const d of shape.stroke || []) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '1.4');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(path);
    }
    for (const d of shape.fill || []) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('fill', 'currentColor');
      svg.appendChild(path);
    }
    return svg;
  }

  function node(tag, className, value) {
    const created = document.createElement(tag);
    if (className !== '') {
      created.className = className;
    }
    if (value !== undefined) {
      created.textContent = value;
    }
    return created;
  }

  /** アイコンとテキストを並べた要素を作る。テキストは必ず textContent 経由で入る。 */
  function labeled(tag, className, iconName, value) {
    const created = node(tag, className, undefined);
    created.appendChild(icon(iconName, undefined));
    created.appendChild(node('span', 'text', value));
    return created;
  }

  function clear(target) {
    while (target.firstChild !== null) {
      target.removeChild(target.firstChild);
    }
  }

  function renderChecklist(todos) {
    const list = el('checklist');
    clear(list);
    for (const todo of todos) {
      const row = node('li', 'todo ' + todo.status, undefined);
      const mark = node('span', 'mark', undefined);
      mark.appendChild(icon(TODO_ICON[todo.status] || 'circle', TODO_LABEL[todo.status] || '未着手'));
      row.appendChild(mark);
      const label = todo.status === 'in_progress' && todo.activeForm !== '' ? todo.activeForm : todo.content;
      row.appendChild(node('span', 'text', label));
      list.appendChild(row);
    }
    el('checklistSection').hidden = todos.length === 0;
  }

  /**
   * ファイルパスを1行として作る。ディレクトリ部分を淡く、ファイル名を通常色で出す。
   * counts に回数があり2以上なら、右にバッジを添える。
   */
  function pathRow(path, counts) {
    const row = node('li', 'path', undefined);
    row.appendChild(icon('file', undefined));
    const cut = path.lastIndexOf('/');
    if (cut >= 0) {
      row.appendChild(node('span', 'dir', path.slice(0, cut + 1)));
      row.appendChild(node('span', 'name', path.slice(cut + 1)));
    } else {
      row.appendChild(node('span', 'name', path));
    }
    const count = counts === undefined || counts === null ? 0 : counts[path];
    if (typeof count === 'number' && count > 1) {
      row.appendChild(node('span', 'count', String(count) + '回'));
    }
    return row;
  }

  /** ディレクトリの見出しと、その下のファイル名の並びを作る（issue 749）。 */
  function fileGroupRow(group, names) {
    const row = node('li', 'fileGroup', undefined);
    if (group.dir !== '') {
      const head = node('div', 'groupHead', undefined);
      head.appendChild(icon('folder', undefined));
      head.appendChild(node('span', 'dir', group.dir));
      head.appendChild(node('span', 'count', String(group.files.length)));
      row.appendChild(head);
    }
    const list = node('ul', 'groupFiles', undefined);
    for (const name of names) {
      const item = node('li', 'path', undefined);
      item.appendChild(icon('file', undefined));
      item.appendChild(node('span', 'name', name));
      list.appendChild(item);
    }
    row.appendChild(list);
    return row;
  }

  /**
   * 変更したファイルをディレクトリごとにまとめて出す（issue 749）。
   *
   * 先頭から FILES_SHOWN 件で打ち切り、残りは「もっと見る」の裏へ回す。打ち切りは
   * ファイル数で数える（グループ数ではない）。1つのディレクトリに数百件ある形でも
   * 既定の表示が短く収まるようにするため。
   */
  /** 直前に描いたファイル一覧の内容。同じなら作り直さない（issue #1025）。 */
  let filesShownKey = undefined;

  /**
   * ファイル一覧を描く。中身が前回と同じなら何もしない（issue #1025）。
   *
   * タイムラインと同じ理由で、ここも毎更新で作り直していた。ファイルは1ターンに
   * 数件しか増えないため、状態が届くたびに全行を作り直すのは無駄が大きい。
   * 突き合わせはディレクトリとファイル名を連ねた文字列で行う。数百件でも安く、
   * 並びの入れ替わりも拾える。
   */
  function renderFiles(groups) {
    const key = groups.map((group) => group.dir + '\u0000' + group.files.join('\u0000')).join('\u0001');
    if (key === filesShownKey) {
      return;
    }
    filesShownKey = key;
    const list = el('files');
    const foot = el('filesMore');
    clear(list);
    clear(foot);

    let shown = 0;
    const rest = [];
    for (const group of groups) {
      // 一度開いたら以降は全件出す。ファイルが増えた分もそのまま続けて出る（issue #1013）
      const room = filesExpanded ? group.files.length : FILES_SHOWN - shown;
      if (room <= 0) {
        rest.push(group);
        continue;
      }
      list.appendChild(fileGroupRow(group, group.files.slice(0, room)));
      shown += Math.min(group.files.length, room);
      if (group.files.length > room) {
        rest.push({ dir: group.dir, files: group.files.slice(room) });
      }
    }

    let hidden = 0;
    for (const group of rest) {
      hidden += group.files.length;
    }
    if (hidden > 0) {
      const button = node('button', 'more', '残り' + hidden + '件を表示');
      button.type = 'button';
      button.addEventListener('click', () => {
        filesExpanded = true;
        // 内容は同じで出す範囲だけが変わるので、突き合わせの鍵を捨ててから描き直す
        filesShownKey = undefined;
        renderFiles(groups);
      });
      foot.appendChild(button);
    }

    el('filesSection').hidden = groups.length === 0;
  }

  function renderDetail(parent, label, iconName, values, className, counts) {
    if (values.length === 0) {
      return;
    }
    const block = node('div', 'detail', undefined);
    block.appendChild(labeled('span', 'label', iconName, label + ' ' + values.length + '件'));
    const list = node('ul', '', undefined);
    if (className === 'path') {
      for (const value of values) {
        list.appendChild(pathRow(value, counts));
      }
    } else {
      for (const value of values) {
        list.appendChild(labeled('li', className, iconName, value));
      }
    }
    block.appendChild(list);
    parent.appendChild(block);
  }

  /**
   * 畳んだターンの見出しに出す数のチップ。数字だけでは何の数か分からないため、
   * ホバーと読み上げ向けに名前を持たせる（画面上はアイコンで区別する）。
   */
  function chip(iconName, value, label) {
    const created = labeled('span', 'chip', iconName, value);
    created.title = label;
    created.setAttribute('aria-label', label + ' ' + value);
    return created;
  }

  function renderTurn(turn, isLatest, isOpen) {
    const article = node('details', 'turn' + (isLatest ? ' latest' : ''), undefined);
    article.open = isOpen;

    const head = node('summary', '', undefined);
    // 開閉を覚えるのは toggle ではなく summary のクリックで拾う（issue 750）。
    // toggle は描画時の article.open への代入でも発火するため、どちらが人の操作かを
    // 区別できない。クリックの時点ではまだ反転していないので、反転後の値を入れる。
    // キーボード操作（Enter / Space）も summary への click として届く
    head.addEventListener('click', () => {
      turnOpen[turn.index] = !article.open;
    });
    head.appendChild(node('span', 'title', 'ターン ' + (turn.index + 1)));
    if (turn.editedFiles.length > 0) {
      head.appendChild(chip('file', String(turn.editedFiles.length), '変更したファイル'));
    }
    if (turn.commands.length > 0) {
      head.appendChild(chip('terminal', String(turn.commands.length), '実行したコマンド'));
    }
    if (turn.todoChanges.length > 0) {
      head.appendChild(chip('check', String(turn.todoChanges.length), 'TODOの変化'));
    }
    if (turn.instruction !== '') {
      // 閉じたままでも何のターンか分かるように、指示の頭を1行だけ添える
      head.appendChild(node('span', 'preview', turn.instruction));
    }
    article.appendChild(head);

    const body = node('div', 'body', undefined);
    if (turn.instruction !== '') {
      body.appendChild(node('div', 'instruction', turn.instruction));
    }
    if (turn.response !== '') {
      body.appendChild(node('div', 'response', turn.response));
    }

    if (turn.todoChanges.length > 0) {
      const changes = node('div', 'detail', undefined);
      changes.appendChild(labeled('span', 'label', 'list', 'TODOの変化'));
      const list = node('ul', '', undefined);
      for (const change of turn.todoChanges) {
        const row = node('li', 'change ' + change.kind, undefined);
        const mark = node('span', 'mark', undefined);
        mark.appendChild(icon(CHANGE_ICON[change.kind] || 'circle', undefined));
        row.appendChild(mark);
        row.appendChild(node('span', 'text', (CHANGE_LABEL[change.kind] || change.kind) + ' ' + change.content));
        list.appendChild(row);
      }
      changes.appendChild(list);
      body.appendChild(changes);
    }

    renderDetail(body, '変更したファイル', 'file', turn.editedFiles, 'path', turn.fileEditCounts);
    renderDetail(body, '実行したコマンド', 'terminal', turn.commands, 'command', undefined);
    article.appendChild(body);
    return article;
  }

  /**
   * ターン番号 → いま出ているノード。据え置くターンを見分けるために持つ（issue #1025）。
   * 全量が届いたときに空へ戻す。
   */
  let turnNodes = {};

  /**
   * タイムラインを描く（issue #1025）。
   *
   * changed は今回作り直すターン番号の集合。undefined なら全部作り直す（全量が届いた
   * ときと初回）。**据え置いたノードは触らない**: 作り直すとその中の選択が消え、
   * フォーカスが body へ戻り、スクロール位置も失われる。応答中は毎秒20回ここへ来る
   * ため、末尾のターンだけが伸びる普段の更新で全部を作り直すと、文字を選んでいる間に
   * 選択が消え続ける。
   */
  function renderTimeline(turns, changed) {
    const timeline = el('timeline');
    if (changed === undefined) {
      clear(timeline);
      turnNodes = {};
    }
    // 古いターンは畳む。全部開いたままだと、長いセッションでは下まで辿れない
    const firstOpen = Math.max(turns.length - OPEN_TURNS, 0);
    let closed = 0;
    for (let i = 0; i < turns.length; i += 1) {
      const turn = turns[i];
      const isLatest = i === turns.length - 1;
      // 自分で開閉したターンはその状態を優先する。触っていないターンだけ既定に従う。
      // 応答中の最新ターンは、まだ触っていなければ開いておく（issue 750）
      const remembered = turnOpen[turn.index];
      const isOpen = remembered === undefined ? i >= firstOpen || (isLatest && isBusy) : remembered;
      if (!isOpen) {
        closed += 1;
      }
      const current = turnNodes[turn.index];
      if (current === undefined) {
        const fresh = renderTurn(turn, isLatest, isOpen);
        turnNodes[turn.index] = fresh;
        timeline.appendChild(fresh);
      } else if (changed !== undefined && changed.has(turn.index)) {
        const fresh = renderTurn(turn, isLatest, isOpen);
        turnNodes[turn.index] = fresh;
        timeline.replaceChild(fresh, current);
      } else {
        // 中身は変わっていない。最新の印と開閉だけは移りうるので属性だけ当てる
        current.className = 'turn' + (isLatest ? ' latest' : '');
        current.open = isOpen;
      }
    }
    el('timelineSection').hidden = turns.length === 0;
    renderExpandAll(turns, closed);
  }

  /**
   * 「すべて開く」。畳まれたターンが1件も無いときは出さない（issue 750。ターンが
   * OPEN_TURNS 件以下のセッションで、押しても何も起きないボタンを見せないため）。
   */
  /** 直前に出した「閉じているNターンを開く」の N。同じなら作り直さない（issue #1025）。 */
  let expandAllShown = -1;

  function renderExpandAll(turns, closed) {
    const holder = el('timelineMore');
    // 押せるボタンを毎回作り直すと、当たっていたフォーカスが body へ戻る
    if (closed === expandAllShown) {
      return;
    }
    expandAllShown = closed;
    clear(holder);
    if (closed === 0) {
      return;
    }
    const button = node('button', 'more', '閉じている' + closed + 'ターンを開く');
    button.type = 'button';
    button.addEventListener('click', () => {
      for (const turn of turns) {
        turnOpen[turn.index] = true;
      }
      // 開閉は据え置きの経路（属性だけ当てる）で移せる。作り直さない
      renderTimeline(turns, EMPTY_CHANGED);
    });
    holder.appendChild(button);
  }

  function setKpi(id, value, suffix) {
    el(id).textContent = suffix === undefined ? String(value) : String(value) + suffix;
  }

  /** 直前に出した状態。応答中↔待機中が移ったときだけバッジを書き換える（issue #1025）。 */
  let badgeBusy = undefined;

  function renderSummary(summary) {
    isBusy = summary.busy === true;
    // 画面上端の稼働バー（issue 751）。バッジの点滅だけでは、画面を下へスクロールして
    // サマリが見えていないときに動いているかが分からない
    el('busyBar').hidden = !summary.busy;

    const badge = el('statusBadge');
    // バッジは読み上げの窓（aria-live）にしてある。応答中の間も状態は毎秒20回届くので、
    // 毎回作り直すと同じ「応答中」を延々と読み上げることになる。遷移のときだけ触る
    // （issue #1025）。読み上げるのは状態の1語だけで、KPIの数字は含めない
    if (badgeBusy !== isBusy) {
      badgeBusy = isBusy;
      badge.className = summary.busy ? 'busy' : '';
      clear(badge);
      badge.appendChild(node('span', 'dot', undefined));
      badge.appendChild(node('span', 'text', summary.busy ? '応答中' : '待機中'));
    }

    setKpi('kpiTurns', summary.turnCount, undefined);
    setKpi('kpiFiles', summary.editedFiles.length, undefined);
    setKpi('kpiCommands', summary.commandCount, undefined);
    setKpi(
      'kpiTodo',
      summary.todoTotal === 0 ? '—' : summary.todoCompleted + '/' + summary.todoTotal,
      undefined,
    );

    const row = el('progressRow');
    row.hidden = summary.todoTotal === 0;
    if (summary.todoTotal === 0) {
      return;
    }
    const done = summary.todoCompleted / summary.todoTotal;
    const percent = Math.round(done * 100);
    const fill = el('progressFill');
    fill.style.width = percent + '%';
    const marks = [];
    if (percent === 100) {
      marks.push('done');
    }
    if (summary.busy) {
      marks.push('busy');
    }
    fill.className = marks.join(' ');
    el('progressPercent').textContent = percent + '%';
  }

  function render(view, changed) {
    if (view === undefined || view === null || view.summary.turnCount === 0) {
      // 据え置きの土台を捨てる。次に中身が来たときは全部作り直しになる（issue #1025）
      clear(el('timeline'));
      turnNodes = {};
      expandAllShown = -1;
      filesShownKey = undefined;
      badgeBusy = undefined;
      el('empty').hidden = false;
      el('summary').hidden = true;
      el('busyBar').hidden = true;
      el('checklistSection').hidden = true;
      el('filesSection').hidden = true;
      el('timelineSection').hidden = true;
      return;
    }
    el('empty').hidden = true;
    el('summary').hidden = false;
    renderSummary(view.summary);
    renderChecklist(view.checklist);
    renderFiles(view.summary.editedFileGroups);
    renderTimeline(view.turns, changed);
  }

  /**
   * これまでに積んだターン（issue #1024）。届く差し分はこれへ当てて積み直す。
   * 空にするのは全量が届いたときと、拡張機能側が「対象の会話が無い」を送ってきたとき。
   */
  let turns = [];

  ${MERGE_TURNS_SOURCE}

  /**
   * 届いた内容を積み直して描く。積み直せなければ全量を送り直してもらう。
   *
   * 総数が合わないのは取りこぼしか並びのずれで、そのまま描くと古いターンが
   * 残り続ける。会話項目の側（stateDelta.ts）と同じく、疑わしいときは全量へ戻す。
   */
  function apply(message) {
    if (message.payload === undefined || message.payload === null) {
      turns = [];
      render(undefined);
      return;
    }
    const merged = mergeTurns(turns, message.payload.turns);
    if (merged === undefined) {
      turns = [];
      vscode.postMessage({ type: 'progressFull' });
      return;
    }
    turns = merged;
    // 全量が届いたら作り直す。差し分なら届いたターンだけを作り直す（issue #1025）
    const changed =
      message.payload.turns.mode === 'full'
        ? undefined
        : new Set(message.payload.turns.turns.map((turn) => turn.index));
    render(
      {
        summary: message.payload.summary,
        checklist: message.payload.checklist,
        turns: turns,
      },
      changed,
    );
  }

  function renderEmptyDecoration() {
    const target = el('emptyIcon');
    clear(target);
    target.appendChild(icon('clock', undefined));
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message === undefined || message === null || message.type !== 'progress') {
      return;
    }
    apply(message);
  });

  renderEmptyDecoration();

  // HTMLを入れた直後の送信は取りこぼすため、こちらから受け取れることを伝えてから初期表示を貰う
  vscode.postMessage({ type: 'ready' });
`;
}
