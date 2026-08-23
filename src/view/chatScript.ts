import type { ProviderId } from '../provider/id';
import { MARKDOWN_PARSE_SOURCE } from './markdown';
import { SEND_KEY_SOURCE, type SendOnMode } from './sendKey';
import { MERGE_ITEMS_SOURCE } from './stateDelta';

/**
 * レビューボタンの動作。
 *
 * `quickPick`: 対象とdeliveryをQuickPickで選ばせてから `review/start` を呼ぶ（Codexのみ）。
 * ボタンは常に出す（app-serverの標準機能のため一覧を待つ必要が無い）。
 *
 * `command`: コマンド一覧に `commandName` があるときだけボタンを出し、押したら
 * そのままスラッシュコマンドとして発言に送る（Claude Codeのみ）。
 */
export type ReviewButtonConfig = { mode: 'quickPick' } | { mode: 'command'; commandName: string };

/**
 * チャット画面のWebviewで動くスクリプト。
 *
 * テンプレートリテラルの中身なので型検査もlintも効かない。壊れると画面全体が黙って
 * 動かなくなるため、`webviewScript.test.ts` で構文だけは機械的に確かめている。
 * 文字列リテラルに改行を書くときは `\\n` と二重にエスケープすること（`\n` は
 * テンプレートリテラルの時点で実際の改行に展開され、リテラルが分断される）。
 */
export function chatScript(
  agentLabel: string,
  review: ReviewButtonConfig,
  showRewind = false,
  approvalCycle: readonly string[] = [],
  showInputModeHints = false,
  renderMarkdown = true,
  sendOn: SendOnMode = 'ctrlEnter',
  /**
   * 承認レベル（3段階）の表示情報。`approvalLevelMeta()` をJSON化した文字列。
   * webviewのJSは型検査が効かないため、表示名の定義を持ち込まずここへ注入する。
   */
  approvalLevelMetaJson = '{}',
  /** この画面のプロバイダ。レベルの実効値（Codexは2軸、Claudeは1軸）の出し分けに使う。 */
  approvalProvider: ProviderId = 'codex',
  /**
   * 「ここから分岐」ボタンの対象を、発言自身のid（Claude Code画面）にするか
   * （issue #333、design.md §14.61）。falseの既定はCodex画面の従来どおり
   * （対象は直前の発言のturnId）。`chatShared.ts` の `ChatShellOptions.showTurnFork` 参照。
   */
  showTurnFork = false,
): string {
  return `
  const vscode = acquireVsCodeApi();
  const el = (id) => document.getElementById(id);
  /**
   * webviewのstateを部分更新する。stateはスレッドIDと設定の開閉を相乗りさせているため、
   * setStateで丸ごと置き換えると片方が消える。
   */
  function patchState(patch) {
    const prev = vscode.getState() || {};
    vscode.setState(Object.assign({}, prev, patch));
  }
  /** この会話で自分が送った発言。古い順。入力欄の履歴に使う。 */
  let sentTexts = [];
  /** 入力欄でスラッシュを打ったときに出す候補。 */
  let commands = [];
  let matched = [];
  let activeIndex = 0;
  // 出している候補の種類。'command' はスラッシュコマンド、'file' は @ のファイル参照
  let menuMode = '';
  /** 最後に描いた項目。画像が遅れて届いたときに描き直すため保つ。 */
  let lastItems = undefined;
  /**
   * 拡張機能から差し分で届く会話項目を積む先（issue #262）。
   * 全項目を毎回受け取ると、会話が長いほど1回の受信が重くなる。
   */
  let mergedItems = [];
  /** 承認レベルをShift+Tabで回すときの並び（issue #13。制限が強い側から緩い側へ）。 */
  const APPROVAL_CYCLE = ${JSON.stringify(approvalCycle)};
  /** いま効いている承認レベル。循環の起点にする。どのレベルとも一致しなければ空文字。 */
  let currentApproval = '';
  /**
   * 承認レベル（3段階）の表示名・説明・プロバイダごとの実効値。
   * 定義元は拡張機能側の src/provider/approvalLevel.ts で、ここへは組み立て済みの値が入る。
   */
  const APPROVAL_LEVEL_META = ${approvalLevelMetaJson};
  /** この画面のプロバイダ（レベルの実効値の出し分けに使う）。 */
  const APPROVAL_PROVIDER = ${JSON.stringify(approvalProvider)};
  /**
   * ワークスペースフォルダの絶対パス一覧（issue #291）。差分の見出し行の操作
   * （エディタで開く・差分を開く・戻す）をボタンとして出すかどうかの目安に使う。
   * 権威ある判定はホスト側（handleOpenDiffFile等、chatView.ts）が改めて行うため、
   * ここでの判定はUXのためのヒントに過ぎない
   */
  let workspaceRoots = [];

  const KIND_LABEL = {
    userMessage: 'あなた',
    agentMessage: '${agentLabel}',
    reasoning: '思考',
    commandExecution: 'コマンド',
    fileChange: 'ファイル変更',
    mcpToolCall: 'ツール',
    webSearch: 'Web検索',
    plan: '計画',
    contextCompaction: '会話を圧縮しました',
    settingsChanged: '設定',
    imageView: '画像',
    imageGeneration: '画像の生成',
    enteredReviewMode: 'レビュー開始',
    exitedReviewMode: 'レビュー終了',
    subAgentActivity: 'サブエージェント',
    collabAgentToolCall: 'サブエージェント操作',
    autoApprovalReview: '自動承認レビュー',
    sideQuestion: '脇道の質問',
    // Claude CodeのReadツール。describeTool（claude/transcript.ts）が作る種類で、
    // Codex側には対応する項目種別が無い
    fileRead: 'ファイル読み取り',
  };

  /** ホスト側から渡されたレビューボタンの動作。 */
  const REVIEW = ${JSON.stringify(review)};

  /**
   * 発言ごとに「ここまで戻す」ボタンを出すか（Claude Code画面のみ）。
   * Codexは会話の途中から分岐する導線（「ここから分岐」）を使う。巻き戻しは実装しない
   * （design.md「Claude Codeの巻き戻し」参照）。
   */
  const SHOW_REWIND = ${JSON.stringify(showRewind)};

  /**
   * 「ここから分岐」ボタンの対象を、発言自身のid（Claude Code画面）にするか
   * （issue #333、design.md §14.61）。turnForkTarget 関数を参照。
   */
  const SHOW_TURN_FORK = ${JSON.stringify(showTurnFork)};

  /**
   * 入力欄の下に !/# 始まりの案内を出すか（Claude Code画面のみ、issue #5/#6、
   * design.md §14.29）。CodexのTUIにこの挙動は無い。
   */
  const SHOW_INPUT_MODE_HINTS = ${JSON.stringify(showInputModeHints)};

  /**
   * 応答本文をMarkdownとして描画するか（設定 agent.chat.renderMarkdown、既定true、issue #290）。
   * falseなら従来どおりtextContentのみで出す。commandExecutionとreasoningは
   * このフラグに関わらず常に生テキストのまま（renderBody参照）。
   */
  const RENDER_MARKDOWN = ${JSON.stringify(renderMarkdown)};

  /**
   * 送信キーの設定（設定 agent.chat.sendOn、既定'ctrlEnter'、issue #288）。
   * 'enter'ならEnterで送信・Shift+Enterで改行、'ctrlEnter'なら従来どおりEnterは改行の
   * まま（Ctrl/Cmd+Enterはどちらのモードでも送信を維持する。decideSendKeyAction参照）。
   */
  const SEND_ON = ${JSON.stringify(sendOn)};

  /** 残りがこの割合を下回ったら警告として見せる。 */
  const LOW_CONTEXT_PERCENT = 20;

  /** コマンド出力を畳まずに出す行数。超えた分は末尾だけ見せる。 */
  const MAX_VISIBLE_LINES = 20;

  /** Web検索結果を畳まずに出す件数（issue #18）。超えた分は開くまで隠す。 */
  const MAX_VISIBLE_SEARCH_RESULTS = 5;

  /** app-serverが返すコマンドの状態。そのまま出すと英語のままになる。 */
  const STATUS_LABEL = {
    inProgress: '実行中',
    running: '実行中',
    completed: '完了',
    failed: '失敗',
    declined: '拒否',
    // subAgentActivity（issue #34）のkindがそのままstatusへ入る（SubAgentActivityKind）
    started: '開始',
    interacted: '応答',
    interrupted: '中断',
    // 承認要求の自動レビュー（GuardianApprovalReviewStatus）
    approved: '承認',
    denied: '拒否',
    timedOut: '時間切れ',
    aborted: '中止',
  };

  const CLASS_OF = {
    userMessage: 'user',
    agentMessage: 'agent',
    reasoning: 'reasoning',
    commandExecution: 'tool',
    fileChange: 'tool',
    mcpToolCall: 'tool',
    subAgentActivity: 'tool',
    collabAgentToolCall: 'tool',
    autoApprovalReview: 'tool',
  };

  // 全体を作り直すと選択中のテキストが消えてコピーできないため、要素を使い回す
  const nodes = new Map();

  function createNode(item) {
    const wrap = document.createElement('div');
    wrap.className = 'item ' + (CLASS_OF[item.kind] || '');

    const head = document.createElement('div');
    head.className = 'head';
    const label = document.createElement('span');
    head.appendChild(label);

    const actions = document.createElement('span');
    actions.className = 'actions';

    const copy = document.createElement('button');
    copy.className = 'secondary';
    copy.textContent = 'コピー';
    copy.hidden = true;
    copy.addEventListener('click', () => {
      // 畳んでいても全文をコピーする（見えている末尾だけにしない）
      const text = node.fullText || '';
      navigator.clipboard.writeText(text).then(
        () => {
          copy.textContent = 'コピーしました';
          setTimeout(() => (copy.textContent = 'コピー'), 1200);
        },
        () => (copy.textContent = 'コピーできません'),
      );
    });
    actions.appendChild(copy);

    // 長いコマンド出力の展開。開いた状態は要素と一緒に保つ（再描画で閉じない）
    const expand = document.createElement('button');
    expand.className = 'secondary';
    expand.hidden = true;
    expand.addEventListener('click', () => {
      node.expanded = !node.expanded;
      renderBody(node, node.lastItem);
    });
    actions.appendChild(expand);

    const fork = document.createElement('button');
    fork.className = 'secondary';
    fork.textContent = 'ここから分岐';
    fork.hidden = true;
    fork.addEventListener('click', () => {
      if (!node.forkTarget) return;
      fork.disabled = true;
      vscode.postMessage({ type: 'fork', turnId: node.forkTarget });
    });
    actions.appendChild(fork);

    // ファイルだけを戻す（Claude Code画面のみ）。会話には触れない。確認は拡張機能側の
    // モーダルダイアログが持つため、ここでは要求を送るだけ
    const rewind = document.createElement('button');
    rewind.className = 'secondary';
    rewind.textContent = 'ここまで戻す';
    rewind.hidden = true;
    rewind.addEventListener('click', () => {
      if (!node.rewindTarget) return;
      vscode.postMessage({ type: 'rewind', messageId: node.rewindTarget });
    });
    actions.appendChild(rewind);

    head.appendChild(actions);
    wrap.appendChild(head);

    const body = document.createElement('div');
    body.className = 'body';
    wrap.appendChild(body);

    // Web検索の結果（issue #18）。URLとタイトルの一覧を出す。webSearch以外では常に空
    const searchResults = document.createElement('div');
    searchResults.className = 'search-results';
    searchResults.hidden = true;
    wrap.appendChild(searchResults);

    const images = document.createElement('div');
    images.className = 'images';
    images.hidden = true;
    wrap.appendChild(images);

    const diffs = document.createElement('div');
    diffs.className = 'diffs';
    diffs.hidden = true;
    wrap.appendChild(diffs);

    const node = {
      wrap,
      label,
      body,
      searchResults,
      searchResultsKey: '',
      images,
      imageKey: '',
      diffs,
      diffKey: '',
      copy,
      expand,
      fork,
      forkTarget: undefined,
      rewind,
      rewindTarget: undefined,
      expanded: false,
      fullText: '',
      lastItem: undefined,
      // Markdown描画のキャッシュ（issue #290）。'text' はtextContentのみ、
      // 'markdown' はrenderMarkdownIntoで組み立てたDOM。どちらも直前と同じキーなら
      // 作り直さない（選択中のテキストが消える事故を防ぐ、他のキャッシュと同じ考え方）
      bodyMode: 'text',
      bodyKey: undefined,
    };
    return node;
  }

  /**
   * Markdownのパース（issue #290）。実装は markdown.ts に置き、ここへ差し込む
   * （両側へ書くと片方だけ直したときに黙ってずれる。stateDelta.ts の
   * MERGE_ITEMS_SOURCE と同じ流儀）。ここでは parseMarkdown(text) だけを使う。
   */
  ${MARKDOWN_PARSE_SOURCE}

  /**
   * インライントークン列をDOMへ差し込む。HTML文字列を組み立ててDOMへ流し込むAPIは
   * 使わない。すべて createElement / createTextNode で作り、エージェントの出力が
   * HTMLとして評価されることはない（issue #290の受入基準）。
   */
  function appendInline(parent, tokens) {
    for (const token of tokens) {
      if (token.type === 'text') {
        parent.appendChild(document.createTextNode(token.value));
        continue;
      }
      if (token.type === 'bold') {
        const strong = document.createElement('strong');
        strong.textContent = token.value;
        parent.appendChild(strong);
        continue;
      }
      if (token.type === 'italic') {
        const em = document.createElement('em');
        em.textContent = token.value;
        parent.appendChild(em);
        continue;
      }
      if (token.type === 'code') {
        const code = document.createElement('code');
        code.textContent = token.value;
        parent.appendChild(code);
        continue;
      }
      if (token.type === 'strike') {
        const s = document.createElement('s');
        s.textContent = token.value;
        parent.appendChild(s);
        continue;
      }
      if (token.type === 'link') {
        const a = document.createElement('a');
        a.href = '#';
        a.textContent = token.value;
        // Webviewから直接遷移はさせない。押した行き先は既存のopenUrl経路（Web検索結果と
        // 同じ）でホスト側へ渡し、vscode.env.openExternalで開く
        a.addEventListener('click', (e) => {
          e.preventDefault();
          vscode.postMessage({ type: 'openUrl', url: token.url });
        });
        parent.appendChild(a);
      }
    }
  }

  /**
   * 表のセル配置（align）をクラス名へ変換する。undefinedは既定（左寄せ）のまま
   * クラスを付けない。
   */
  function alignClass(align) {
    if (align === 'center') return 'md-align-center';
    if (align === 'right') return 'md-align-right';
    if (align === 'left') return 'md-align-left';
    return '';
  }

  /** 表1つ。列が多いと横に伸びるため、ラップ要素をoverflow-xさせる（chatStyles.ts側）。 */
  function createTable(token) {
    const wrap = document.createElement('div');
    wrap.className = 'md-table-wrap';
    const table = document.createElement('table');
    table.className = 'md-table';

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    token.header.forEach((cellTokens, idx) => {
      const th = document.createElement('th');
      const cls = alignClass(token.align[idx]);
      if (cls) th.className = cls;
      appendInline(th, cellTokens);
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    token.rows.forEach((row) => {
      const tr = document.createElement('tr');
      row.forEach((cellTokens, idx) => {
        const td = document.createElement('td');
        const cls = alignClass(token.align[idx]);
        if (cls) td.className = cls;
        appendInline(td, cellTokens);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    wrap.appendChild(table);
    return wrap;
  }

  /** 引用1つ。複数行は段落と同じくbrで改行を保つ。 */
  function createQuote(token) {
    const bq = document.createElement('blockquote');
    bq.className = 'md-quote';
    token.lines.forEach((lineTokens, index) => {
      if (index > 0) bq.appendChild(document.createElement('br'));
      appendInline(bq, lineTokens);
    });
    return bq;
  }

  /**
   * 箇条書き1つ。itemのdepthに沿って親liの中へul/olを入れ子にする。
   * parseMarkdown側でdepthは1段ずつしか増えない前提（親のdepth+1を超えない）ため、
   * 深さが増える側は常に直前のitemの下へ潜ればよい。減る側は該当階層まで戻す。
   */
  function createList(token) {
    const tag = token.ordered ? 'ol' : 'ul';
    const root = document.createElement(tag);
    const stack = [{ depth: 0, list: root }];

    for (const item of token.items) {
      while (stack.length > 1 && stack[stack.length - 1].depth > item.depth) {
        stack.pop();
      }
      let top = stack[stack.length - 1];
      if (item.depth > top.depth) {
        const parentLi = top.list.lastElementChild || document.createElement('li');
        if (!parentLi.parentNode) top.list.appendChild(parentLi);
        const nested = document.createElement(tag);
        parentLi.appendChild(nested);
        top = { depth: item.depth, list: nested };
        stack.push(top);
      }

      const li = document.createElement('li');
      if (item.checked !== undefined) {
        li.className = 'md-task-item';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = item.checked;
        checkbox.disabled = true;
        li.appendChild(checkbox);
      }
      appendInline(li, item.inline);
      top.list.appendChild(li);
    }
    return root;
  }

  /** コードブロック1つ。コピー・エディタへ挿入・新規ファイルで開くの3操作を付ける。 */
  function createCodeBlock(token) {
    const wrap = document.createElement('div');
    wrap.className = 'md-code';

    const head = document.createElement('div');
    head.className = 'md-code-head';
    const lang = document.createElement('span');
    lang.className = 'md-code-lang';
    lang.textContent = token.lang || 'text';
    head.appendChild(lang);

    const actions = document.createElement('span');
    actions.className = 'md-code-actions';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'secondary';
    copyBtn.textContent = 'コピー';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(token.code).then(
        () => {
          copyBtn.textContent = 'コピーしました';
          setTimeout(() => (copyBtn.textContent = 'コピー'), 1200);
        },
        () => (copyBtn.textContent = 'コピーできません'),
      );
    });
    actions.appendChild(copyBtn);

    // どちらもWebviewからは実行できない操作。ホスト側（chatView.ts / claudeChatView.ts の
    // handleMessage）へ要求を送るだけにする（openUrl・requestImageと同じ往復の形）
    const insertBtn = document.createElement('button');
    insertBtn.type = 'button';
    insertBtn.className = 'secondary';
    insertBtn.textContent = 'エディタへ挿入';
    insertBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'insertCode', code: token.code, lang: token.lang });
    });
    actions.appendChild(insertBtn);

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'secondary';
    openBtn.textContent = '新規ファイルで開く';
    openBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'openCodeFile', code: token.code, lang: token.lang });
    });
    actions.appendChild(openBtn);

    head.appendChild(actions);
    wrap.appendChild(head);

    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.textContent = token.code;
    pre.appendChild(code);
    wrap.appendChild(pre);
    return wrap;
  }

  /**
   * 本文コンテナへMarkdownを組み立てて差し込む。呼ぶたびに中身を作り直す
   * （renderBody側でテキストが変わったときだけ呼ぶよう間引いている）。
   */
  function renderMarkdownInto(container, text) {
    container.replaceChildren();
    const tokens = parseMarkdown(text);
    for (const token of tokens) {
      if (token.type === 'heading') {
        const level = Math.min(6, Math.max(1, token.level));
        const heading = document.createElement('h' + level);
        appendInline(heading, token.inline);
        container.appendChild(heading);
        continue;
      }
      if (token.type === 'paragraph') {
        const p = document.createElement('p');
        token.lines.forEach((lineTokens, index) => {
          if (index > 0) p.appendChild(document.createElement('br'));
          appendInline(p, lineTokens);
        });
        container.appendChild(p);
        continue;
      }
      if (token.type === 'list') {
        container.appendChild(createList(token));
        continue;
      }
      if (token.type === 'table') {
        container.appendChild(createTable(token));
        continue;
      }
      if (token.type === 'quote') {
        container.appendChild(createQuote(token));
        continue;
      }
      if (token.type === 'hr') {
        container.appendChild(document.createElement('hr'));
        continue;
      }
      if (token.type === 'codeblock') {
        container.appendChild(createCodeBlock(token));
      }
    }
  }

  /**
   * 本文を描く。長い場合は畳んで、展開できるようにする。
   *
   * コマンド出力・思考の全文は途中経過が流れ込んで伸び続けるため、全部を描き続けると重くなる。
   *
   * 思考（reasoning）だけは畳み方が違う。Codexは要約(text)と全文(reasoningFull)が別に
   * 届くことがあり、その場合は既定で要約だけを見せ、展開すると全文に切り替える
   * （コマンド出力のような「末尾だけ」ではなく丸ごと入れ替える）。全文が無い・要約と同じ
   * ときは、コマンド出力と同じ行数での折りたたみに落ちる（Claude Codeの思考は要約を
   * 持たずここに該当する。issue #19）。
   */
  function renderBody(node, item) {
    if (!item) return;
    node.lastItem = item;
    const text = item.text || '';
    const full = item.kind === 'reasoning' ? item.reasoningFull || '' : '';
    const hasSummaryAndFull = full !== '' && text !== '' && full !== text;

    if (hasSummaryAndFull) {
      node.fullText = full;
      const shown = node.expanded ? full : text;
      if (node.body.textContent !== shown) node.body.textContent = shown;
      node.body.hidden = false;
      node.copy.hidden = false;
      node.expand.hidden = false;
      node.expand.textContent = node.expanded ? '要約だけ表示' : '全文を表示';
      return;
    }

    // 要約が無ければ全文をそのまま本文として扱う（コマンド出力と同じ行数折りたたみ）
    const primary = text !== '' ? text : full;
    node.fullText = primary;

    const foldByLines = item.kind === 'commandExecution' || item.kind === 'reasoning';
    const lines = foldByLines ? primary.split('\\n') : undefined;
    const overflow = lines !== undefined && lines.length > MAX_VISIBLE_LINES;
    const shown =
      overflow && !node.expanded
        ? lines.slice(lines.length - MAX_VISIBLE_LINES).join('\\n')
        : primary;

    // Markdownとして解釈するのは通常の発言・応答（userMessage/agentMessage）と
    // 脇道の質問（sideQuestion、issue #334。質問と応答を1本文にまとめており、応答部分は
    // 普通の発言と同じ体裁で見せたい）。commandExecution・reasoningは折りたたみ含め
    // 従来どおり生テキストのまま（issue #290）
    const useMarkdown =
      RENDER_MARKDOWN &&
      (item.kind === 'userMessage' || item.kind === 'agentMessage' || item.kind === 'sideQuestion');
    const bodyMode = useMarkdown ? 'markdown' : 'text';
    if (node.bodyMode !== bodyMode || node.bodyKey !== shown) {
      node.bodyMode = bodyMode;
      node.bodyKey = shown;
      if (useMarkdown) {
        renderMarkdownInto(node.body, shown);
      } else {
        node.body.replaceChildren();
        node.body.textContent = shown;
      }
    }
    node.body.hidden = primary === '';
    node.copy.hidden = primary === '';

    node.expand.hidden = !overflow;
    if (overflow) {
      node.expand.textContent = node.expanded
        ? '末尾だけ表示'
        : '全体を表示（' + lines.length + '行）';
    }
  }

  /**
   * パスで届いた画像の中身。ホスト側が読んで返したデータURLを覚える。
   *
   * Webviewから直接ファイルを読むことはできない（CSPは img-src data: のみ）。
   * 値は 'data:...' か、読めなかった理由の文字列。
   */
  const imageData = new Map();
  /** 要求済みのパス。同じ画像を何度も頼まない。 */
  const imageAsked = new Set();

  function requestImage(path) {
    if (imageAsked.has(path)) return;
    imageAsked.add(path);
    vscode.postMessage({ type: 'requestImage', path });
  }

  /** 画像1枚。クリックで原寸表示へ切り替える。 */
  function createImage(image) {
    const wrap = document.createElement('div');
    wrap.className = 'image';

    const src = image.dataUrl || (image.path ? imageData.get(image.path) : undefined);
    if (src && src.slice(0, 5) === 'data:') {
      const img = document.createElement('img');
      img.src = src;
      img.alt = image.alt || '';
      img.title = image.alt || '';
      img.addEventListener('click', () => wrap.classList.toggle('zoom'));
      wrap.appendChild(img);
      return wrap;
    }

    // まだ読めていない・読めなかった。黙って空白を残さず理由を出す
    const note = document.createElement('div');
    note.className = 'image-note';
    if (image.path) {
      requestImage(image.path);
      note.textContent = src ? src + ': ' + image.path : '読み込み中… ' + image.path;
    } else {
      note.textContent = image.alt || '画像を表示できません';
    }
    wrap.appendChild(note);
    return wrap;
  }

  function renderImages(container, images) {
    container.replaceChildren();
    for (const image of images) container.appendChild(createImage(image));
    container.hidden = images.length === 0;
  }

  /**
   * Web検索結果1件（issue #18）。URLは全部見せ、自動では開かない。
   * クリックしたら拡張機能側へ要求を送り、host側でvscode.env.openExternalを使って開く
   * （Webviewから直接は開けないため）。押す＝行き先を見た上での明示の意思表示なので、
   * ここでの追加確認はしない（design.mdの問い合わせカードのurlモードと同じ考え方）。
   */
  function createSearchResult(result) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'search-result';

    const title = document.createElement('span');
    title.className = 'search-result-title';
    title.textContent = result.title;
    button.appendChild(title);

    const url = document.createElement('span');
    url.className = 'search-result-url';
    url.textContent = result.url;
    button.appendChild(url);

    button.addEventListener('click', () => {
      vscode.postMessage({ type: 'openUrl', url: result.url });
    });
    return button;
  }

  /** 件数が多いときは折りたたむ。開いた状態は要素と一緒に保つ（issue #17/#19と同じやり方）。 */
  function renderSearchResults(container, results) {
    container.replaceChildren();
    if (results.length === 0) {
      container.hidden = true;
      return;
    }
    container.hidden = false;

    if (results.length <= MAX_VISIBLE_SEARCH_RESULTS) {
      for (const result of results) container.appendChild(createSearchResult(result));
      return;
    }

    const details = document.createElement('details');
    details.className = 'search-results-fold';
    const summary = document.createElement('summary');
    summary.textContent = 'Web検索結果（' + results.length + '件）';
    details.appendChild(summary);
    for (const result of results) details.appendChild(createSearchResult(result));
    container.appendChild(details);
  }

  /** パス文字列が..セグメントを含むか。含めばどう解決してもワークスペース外扱いにする。 */
  function containsParentSegment(p) {
    return p.split(/[\\\\/]/).some((seg) => seg === '..');
  }

  /**
   * パスがワークスペース内へ解決できそうかの簡易判定（issue #291）。
   *
   * 文字列だけで判定するUX用のヒント。相対パスはホスト側でワークスペースルートへ
   * 結合されるためここでは通すが、..を含む場合と、ワークスペース外を指す絶対パスは
   * ここで弾く。権威ある判定・シンボリックリンクの確認はホスト側
   * （resolveDiffFileForAction、chatView.ts）が行う
   */
  function withinWorkspace(p) {
    if (!p || containsParentSegment(p)) return false;
    if (workspaceRoots.length === 0) return false;
    const isAbsolute = /^([a-zA-Z]:[\\\\/]|[\\\\/])/.test(p);
    if (!isAbsolute) return true;
    return workspaceRoots.some((root) => {
      const norm = root.replace(/[\\\\/]+$/, '');
      return p === norm || p.indexOf(norm + '/') === 0 || p.indexOf(norm + '\\\\') === 0;
    });
  }

  /**
   * 差分の見出し行に足す操作ボタン（issue #291）。「エディタで開く」「差分を開く」
   * 「この変更を戻す」を、種類とパスから出し分ける。実際の復元可否（ハンクの解析等）は
   * ここでは見ない（Webview側は文字列のパース器を持たないため）。ホスト側が
   * planDiffActions（src/util/diffRestore.ts）で改めて判定し、出せない操作は
   * 理由を添えて断る
   */
  function buildDiffActions(diff, itemId, index) {
    const targetPath = diff.movePath || diff.path;
    if (!withinWorkspace(targetPath)) return null;

    const offerOpenEditor = diff.kind !== 'delete';
    const offerOpenDiff = diff.kind === 'add' || diff.kind === 'delete' || diff.kind === 'update';
    const offerRevert = offerOpenDiff && !diff.movePath;
    if (!offerOpenEditor && !offerOpenDiff && !offerRevert) return null;

    const wrap = document.createElement('span');
    wrap.className = 'diff-actions';

    function addButton(label, messageType) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary';
      button.textContent = label;
      button.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        vscode.postMessage({ type: messageType, itemId: itemId, diffIndex: index });
      });
      wrap.appendChild(button);
    }

    if (offerOpenEditor) addButton('エディタで開く', 'openDiffFile');
    if (offerOpenDiff) addButton('差分を開く', 'openDiffEditor');
    if (offerRevert) addButton('この変更を戻す', 'revertDiff');

    return wrap;
  }

  /**
   * 1ファイル分の差分。既定は畳んでおき、開いた状態は要素を使い回して保つ。
   *
   * interactiveが真のときだけ操作ボタンを出す（issue #291）。承認カードのプレビュー
   * （renderApproval）は、まだ適用されていない変更の見込みを見せているだけで、
   * 開く・戻すが指す実体が無いため操作を出さない
   */
  function createDiff(diff, itemId, index, interactive) {
    const details = document.createElement('details');
    details.className = 'diff';

    const summary = document.createElement('summary');
    const kindLabel = { add: '追加', delete: '削除', update: '変更' }[diff.kind] || diff.kind;
    const label = document.createElement('span');
    label.className = 'diff-label';
    label.textContent = diff.path + (diff.movePath ? ' → ' + diff.movePath : '') +
      ' ・ ' + kindLabel;
    summary.appendChild(label);

    if (interactive) {
      const actions = buildDiffActions(diff, itemId, index);
      if (actions) summary.appendChild(actions);
    }
    details.appendChild(summary);

    const pre = document.createElement('pre');
    pre.className = 'diff-body';
    // 行ごとに色を付ける。行頭の記号がそのまま意味を持つ
    for (const line of (diff.diff || '').split('\\n')) {
      const row = document.createElement('span');
      const head = line.charAt(0);
      row.className =
        head === '+' ? 'diff-add' : head === '-' ? 'diff-del' : head === '@' ? 'diff-hunk' : '';
      row.textContent = line + '\\n';
      pre.appendChild(row);
    }
    details.appendChild(pre);
    return details;
  }

  function renderDiffs(container, diffs, itemId, interactive) {
    container.replaceChildren();
    for (let i = 0; i < diffs.length; i++) {
      container.appendChild(createDiff(diffs[i], itemId, i, !!interactive));
    }
    container.hidden = diffs.length === 0;
  }

  // 「ここから分岐」ボタンの対象を決める（issue #333、design.md §14.61）。
  //
  // Codex画面（既定）: 対象は直前の発言のturnId（thread/forkのlastTurnIdは
  // 「引き継ぐ最後のターン」を指すため）。最初の発言には手前が無いのでボタンを出さない。
  //
  // Claude Code画面（SHOW_TURN_FORK）: 対象は押した発言自身のid（rewind_conversationの
  // target_message_uuidは「戻す対象＝分岐したい発言そのもの」を指すため、Codexとは
  // 向きが違う）。Claude Codeの発言idは常に持っているため、最初の発言でもボタンを出す
  // （CLIが対象にできない場合はエラー応答として画面に返る。design.md §14.61の
  // 「未確認のリスク」参照）。
  function turnForkTarget(item, previousTurnId) {
    if (item.kind !== 'userMessage') return undefined;
    return SHOW_TURN_FORK ? item.id : previousTurnId;
  }

  function updateNode(node, item, forkTarget) {
    const bits = [KIND_LABEL[item.kind] || item.kind];
    if (item.detail) bits.push(item.detail);
    if (item.status) bits.push(STATUS_LABEL[item.status] || item.status);
    // 上限を超えて先頭を捨てた分は本文に印を混ぜず、ここで断る
    if (item.truncated) bits.push('先頭は省略');
    // 中断しても子プロセスは残る。止まって見えるだけかもしれないと断る（issue #246）
    if (item.interruptedWhileRunning) bits.push('中断後も継続中の可能性');
    const label = bits.join(' ・ ');
    if (node.label.textContent !== label) node.label.textContent = label;

    // 実行中のコマンドは見た目でも区別する（Codexは inProgress、Claude Codeは running）
    const running =
      item.kind === 'commandExecution' &&
      (item.status === 'inProgress' || item.status === 'running');
    node.wrap.classList.toggle('running', running);

    renderBody(node, item);

    // 中身が同じなら作り直さない。折りたたみを開いた状態が勝手に戻るのを防ぐ
    const searchResults = item.searchResults || [];
    const searchResultsKey = JSON.stringify(searchResults);
    if (node.searchResultsKey !== searchResultsKey) {
      node.searchResultsKey = searchResultsKey;
      renderSearchResults(node.searchResults, searchResults);
    }

    // 中身が同じなら作り直さない。拡大した画像が勝手に戻るのを防ぐ
    const images = item.images || [];
    const imageKey = JSON.stringify(images) + '|' + images.map((i) => imageData.get(i.path) || '').join(',');
    if (node.imageKey !== imageKey) {
      node.imageKey = imageKey;
      renderImages(node.images, images);
    }

    // 中身が同じなら作り直さない。開いた差分が勝手に閉じるのを防ぐ
    const diffs = item.diffs || [];
    const diffKey = JSON.stringify(diffs);
    if (node.diffKey !== diffKey) {
      node.diffKey = diffKey;
      // 適用済みの実変更なので操作ボタンを出す（issue #291）
      renderDiffs(node.diffs, diffs, item.id, true);
    }

    // 分岐は「この指示の手前まで」。押した指示からやり直せるようにする
    node.forkTarget = forkTarget;
    node.fork.hidden = !(item.kind === 'userMessage' && forkTarget);

    // 巻き戻しは発言自身のidを渡す（対象は「この発言を送る前」）。turnIdと違い、
    // どの発言でも常に持っている値なので、直前の発言の有無を待つ必要が無い
    node.rewindTarget = item.kind === 'userMessage' ? item.id : undefined;
    node.rewind.hidden = !(SHOW_REWIND && item.kind === 'userMessage');
  }

  function syncItems(items) {
    const log = el('log');
    const seen = new Set();
    let previousTurnId;

    for (const item of items) {
      seen.add(item.id);
      let node = nodes.get(item.id);
      if (!node) {
        node = createNode(item);
        nodes.set(item.id, node);
        log.appendChild(node.wrap);
      }
      updateNode(node, item, turnForkTarget(item, previousTurnId));
      if (item.kind === 'userMessage' && item.turnId) previousTurnId = item.turnId;
    }

    for (const [id, node] of nodes) {
      if (!seen.has(id)) {
        node.wrap.remove();
        nodes.delete(id);
      }
    }
  }

  function renderApproval(approval, items) {
    const wrap = document.createElement('div');
    wrap.className = 'approval';

    const title = document.createElement('h3');
    title.textContent = approval.title;
    wrap.appendChild(title);

    if (approval.detail) {
      const pre = document.createElement('pre');
      pre.textContent = approval.detail;
      wrap.appendChild(pre);
    }

    // ファイル変更の要求は差分を持たない。同じidの項目から引いて、承認する前に読めるようにする
    const target = approval.itemId ? items.find((i) => i.id === approval.itemId) : undefined;
    const diffs = (target && target.diffs) || [];
    if (diffs.length > 0) {
      const box = document.createElement('div');
      box.className = 'diffs';
      // まだ適用されていない見込みの表示なので操作ボタンは出さない（issue #291）
      renderDiffs(box, diffs, undefined, false);
      wrap.appendChild(box);
    }

    const actions = document.createElement('div');
    actions.className = 'actions';
    for (const [label, decision, secondary] of [
      ['許可', 'accept', false],
      ['この会話では常に許可', 'acceptForSession', true],
      ['拒否', 'decline', true],
    ]) {
      const button = document.createElement('button');
      button.textContent = label;
      if (secondary) button.className = 'secondary';
      button.addEventListener('click', () => {
        actions.querySelectorAll('button').forEach((b) => (b.disabled = true));
        vscode.postMessage({ type: 'approve', requestId: approval.requestId, decision });
      });
      actions.appendChild(button);
    }
    wrap.appendChild(actions);
    return wrap;
  }

  /**
   * ユーザーへの問い合わせ。ツールの質問（requestUserInput）とMCPサーバのフォーム
   * （elicitation）を同じ形で出す。
   *
   * 入力欄の中身は画面が持ち、送信のときにまとめて集める。状態の再描画で入力中の
   * 値が消えないよう、カードは中身が変わったときだけ作り直す。
   */
  function renderPrompt(prompt) {
    const wrap = document.createElement('div');
    wrap.className = 'prompt';

    const title = document.createElement('h3');
    title.textContent = prompt.title;
    wrap.appendChild(title);

    // 誰が聞いているか。外部のプログラムからの要求なので必ず出す
    if (prompt.source) {
      const source = document.createElement('p');
      source.className = 'source';
      source.textContent = prompt.source + ' からの要求';
      wrap.appendChild(source);
    }

    if (prompt.message) {
      const message = document.createElement('p');
      message.className = 'message';
      message.textContent = prompt.message;
      wrap.appendChild(message);
    }

    // 行き先は全部見せる。押すだけで外部へ飛ぶ導線は作らない
    if (prompt.url) {
      const url = document.createElement('pre');
      url.className = 'prompt-url';
      url.textContent = prompt.url;
      wrap.appendChild(url);
    }

    if (!prompt.blocking && prompt.kind === 'userInput') {
      const note = document.createElement('p');
      note.className = 'note';
      note.textContent = '答えなくても応答は進みます';
      wrap.appendChild(note);
    }

    const readers = [];
    for (const field of prompt.fields || []) {
      wrap.appendChild(buildField(field, readers));
    }

    const actions = document.createElement('div');
    actions.className = 'actions';
    const buttons = [['送信', 'submit', false]];
    buttons.push(['拒否', 'decline', true]);
    if (prompt.kind === 'elicitation') buttons.push(['取り消す', 'cancel', true]);

    for (const [label, action, secondary] of buttons) {
      const button = document.createElement('button');
      button.textContent = label;
      if (secondary) button.className = 'secondary';
      button.addEventListener('click', () => {
        actions.querySelectorAll('button').forEach((b) => (b.disabled = true));
        const values = {};
        if (action === 'submit') {
          for (const read of readers) read(values);
        }
        vscode.postMessage({
          type: 'prompt',
          requestId: prompt.requestId,
          submission: { action, values },
        });
      });
      actions.appendChild(button);
    }
    wrap.appendChild(actions);
    return wrap;
  }

  /** 1つの入力欄。集め方は readers へ積む。 */
  function buildField(field, readers) {
    const box = document.createElement('div');
    box.className = 'field';

    const label = document.createElement('div');
    label.className = 'field-label';
    label.textContent = field.label + (field.required ? ' *' : '');
    box.appendChild(label);

    if (field.description) {
      const desc = document.createElement('div');
      desc.className = 'field-desc';
      desc.textContent = field.description;
      box.appendChild(desc);
    }

    if (field.input === 'boolean') {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = field.defaultValue === 'true';
      box.appendChild(input);
      readers.push((values) => {
        values[field.id] = [input.checked ? 'true' : 'false'];
      });
      return box;
    }

    const options = field.options || [];
    if (options.length > 0) {
      buildOptions(box, field, options, readers);
      return box;
    }

    box.appendChild(buildFreeInput(field, readers));
    return box;
  }

  function buildOptions(box, field, options, readers) {
    // 同じカードに複数の質問が並ぶため、name はフィールドidで分ける
    const name = 'prompt-' + field.id;
    const inputs = [];
    for (const option of options) {
      const row = document.createElement('label');
      row.className = 'option';

      const input = document.createElement('input');
      input.type = field.multiple ? 'checkbox' : 'radio';
      input.name = name;
      input.value = option.value;
      if (option.value === field.defaultValue) input.checked = true;
      row.appendChild(input);
      inputs.push(input);

      const text = document.createElement('span');
      text.textContent = option.label + (option.description ? ' ・ ' + option.description : '');
      row.appendChild(text);
      box.appendChild(row);
    }

    let other;
    if (field.allowOther) {
      const row = document.createElement('label');
      row.className = 'option';
      const pick = document.createElement('input');
      pick.type = field.multiple ? 'checkbox' : 'radio';
      pick.name = name;
      pick.value = '';
      row.appendChild(pick);
      const text = document.createElement('span');
      text.textContent = 'その他';
      row.appendChild(text);
      other = document.createElement('input');
      other.type = 'text';
      other.className = 'other';
      row.appendChild(other);
      box.appendChild(row);
      inputs.push(pick);
      // 書き始めたら選ばれている扱いにする。選び忘れで消えるのを防ぐ
      other.addEventListener('input', () => {
        if (other.value) pick.checked = true;
      });
    }

    readers.push((values) => {
      const picked = [];
      for (const input of inputs) {
        if (!input.checked) continue;
        if (input.value === '' && other) picked.push(other.value);
        else picked.push(input.value);
      }
      values[field.id] = picked;
    });
  }

  function buildFreeInput(field, readers) {
    const input = document.createElement('input');
    // 伏せ字の指定は画面でも守る
    input.type = field.secret ? 'password' : field.input === 'number' ? 'number' : 'text';
    input.value = field.defaultValue || '';
    readers.push((values) => {
      values[field.id] = [input.value];
    });
    return input;
  }

  function renderPrompts(prompts) {
    const box = el('prompts');
    const list = prompts || [];
    // 入力中の値を消さないため、顔ぶれが変わったときだけ作り直す
    const key = list.map((p) => String(p.requestId)).join(',');
    if (box.dataset.key === key) return;
    box.dataset.key = key;
    box.replaceChildren();
    for (const prompt of list) box.appendChild(renderPrompt(prompt));
  }

  function defaultLabel(value) {
    return value ? '既定: ' + value : '既定';
  }

  function fillSelect(select, values, current, defaultText, labelOf) {
    select.replaceChildren();
    const def = document.createElement('option');
    def.value = '';
    def.textContent = defaultText;
    select.appendChild(def);
    for (const v of values) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = labelOf ? labelOf(v) : v;
      select.appendChild(o);
    }
    if (current !== '' && !values.includes(current)) {
      const o = document.createElement('option');
      o.value = current;
      o.textContent = current + ' (一覧外)';
      select.appendChild(o);
    }
    select.value = current;
  }

  const SETTING_KEYS = ['model', 'reasoningEffort', 'approvalMode', 'sandbox', 'agent'];

  function applySettings(s, planning) {
    if (!s) return;
    const nameOf = (slug) => {
      const m = s.models.find((x) => x.slug === slug);
      return m ? m.displayName : slug;
    };
    const d = s.defaults || {};
    fillSelect(
      el('model'),
      s.models.map((m) => m.slug),
      s.model,
      defaultLabel(d.model ? nameOf(d.model) : ''),
      nameOf,
    );
    fillSelect(el('reasoningEffort'), s.efforts, s.reasoningEffort, defaultLabel(d.reasoningEffort));
    // effortを持たないモデル（Claude Codeのhaikuなど）では選ばせない
    const selected = s.models.find((m) => m.slug === s.model);
    const noEffort = !!selected && selected.supportsEffort === false;
    el('reasoningEffort').disabled = noEffort;
    el('reasoningEffort').title = noEffort ? 'このモデルはeffortを選べません' : '';
    const approvalDefault = el('approvalMode').querySelector('option[value=""]');
    if (approvalDefault) approvalDefault.textContent = defaultLabel(d.approvalMode);
    el('approvalMode').value = s.approvalMode;
    // 承認レベル（3段階）。詳細で個別に指定した状態のときだけ「カスタム」を足す
    currentApproval = s.approvalLevel || '';
    const level = el('approvalLevel');
    if (level) {
      const custom = level.querySelector('option[value=""]');
      if (currentApproval) {
        if (custom) custom.remove();
      } else if (!custom) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'カスタム（詳細で個別に指定）';
        level.insertBefore(opt, level.firstChild);
      }
      level.value = currentApproval;
      const meta = currentApproval ? APPROVAL_LEVEL_META[currentApproval] : undefined;
      level.title = meta
        ? meta.description + '（' + meta.effective[APPROVAL_PROVIDER] + '）'
        : '承認の詳細で個別に指定されています';
    }

    // サンドボックスはCodex画面にしか無い（Claude Codeは承認方法に集約されている）
    const sandbox = el('sandbox');
    if (sandbox) {
      const sandboxDefault = sandbox.querySelector('option[value=""]');
      if (sandboxDefault) sandboxDefault.textContent = defaultLabel(d.sandbox);
      sandbox.value = s.sandbox || '';
      // 計画モード中は読み取り専用が優先される。選ばせても効かないので止める
      sandbox.disabled = !!planning;
      sandbox.title = planning
        ? '計画モード中は読み取り専用が優先されます'
        : '次の発言から効きます';
    }

    // エージェントはClaude Code画面にしか無い。起動引数でのみ決まり、実行中は
    // 切り替えられないため、選んでも「次のセッションから」になる（下の但し書きで補足）
    const agent = el('agent');
    if (agent) {
      const agents = s.agents || [];
      fillSelect(
        agent,
        agents.map((a) => a.name),
        s.agent || '',
        defaultLabel(d.agent),
      );
      const selectedAgent = agents.find((a) => a.name === s.agent);
      agent.title =
        selectedAgent && selectedAgent.description
          ? selectedAgent.description
          : '次のセッションから効きます';
    }

    updateSettingsSummary();
  }

  /**
   * 折りたたんだ設定の1行サマリ（issue #266）。閉じていても、いまどのモデル・承認で
   * 動くのかは分かるようにする。既定のままの項目（valueが空）は並べても情報が増えない
   * ため省き、全部が既定なら「既定のまま」とだけ出す。
   */
  function updateSettingsSummary() {
    const box = el('settingsSummary');
    if (!box) return;
    const parts = [];
    // 承認は3段階の表示名で出す。詳細で個別に指定した状態（レベルが空）のときだけ、
    // 中身が分かるよう生の値（承認方法・サンドボックス）を並べる
    const keys = currentApproval
      ? ['model', 'reasoningEffort', 'approvalLevel', 'agent']
      : SETTING_KEYS;
    for (const key of keys) {
      const select = el(key);
      if (!select || !select.value) continue;
      const option = select.options[select.selectedIndex];
      const text = option ? option.textContent : '';
      if (text) parts.push(text);
    }
    box.textContent = parts.length === 0 ? '既定のまま' : parts.join(' / ');
  }

  // 承認レベルは1つ選ぶと複数の設定項目へ展開される。空文字（カスタム）は選ばせない
  const approvalLevelSelect = el('approvalLevel');
  if (approvalLevelSelect) {
    approvalLevelSelect.addEventListener('change', (e) => {
      if (!e.target.value) return;
      vscode.postMessage({ type: 'approvalLevel', level: e.target.value });
    });
  }

  for (const key of SETTING_KEYS) {
    const select = el(key);
    if (!select) continue;
    select.addEventListener('change', (e) => {
      vscode.postMessage({ type: 'config', key, value: e.target.value });
    });
  }

  // 設定の開閉はリロードをまたいで覚える（issue #266）。既定は閉じた状態
  const settingsBox = el('settingsBox');
  if (settingsBox) {
    const saved = vscode.getState() || {};
    settingsBox.open = saved.settingsOpen === true;
    settingsBox.addEventListener('toggle', () => {
      patchState({ settingsOpen: settingsBox.open });
    });
  }

  // TODOの進み具合の記号。計画（Codexの plan）と同じ記号を使う。絵文字は使わない
  const TODO_MARK = { pending: '[ ]', in_progress: '[~]', completed: '[x]' };

  /**
   * TODO一覧（Claude CodeのTodoWrite）。会話には積まず、ここだけが書き変わる。
   * 使っていないセッションでは要素ごと隠す。
   */
  function renderTodos(todos) {
    const box = el('todos');
    const list = el('todosList');
    const items = todos || [];
    box.hidden = items.length === 0;
    list.replaceChildren();
    for (const todo of items) {
      const li = document.createElement('li');
      li.className = todo.status || '';

      const mark = document.createElement('span');
      mark.className = 'mark';
      mark.textContent = TODO_MARK[todo.status] || '[' + todo.status + ']';
      li.appendChild(mark);

      const label = document.createElement('span');
      // 進行中は「Aを準備中」のような進行形（activeForm）で見せる
      label.textContent = todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content;
      li.appendChild(label);

      list.appendChild(li);
    }
  }

  // バックグラウンドで実行中のプロセス一覧（issue #33、design.md 14.23、Codexの/ps相当）。
  // stoppableが立っている項目（Claude Codeのみ、実測でstop_taskが機能することを
  // 確認した）にだけ停止ボタンを出す。Codexは確定した停止経路が無いため、その旨を注記して
  // ボタンは出さない（design.md 14.23。「黙って何も起きない状態を作らない」ため）。
  function renderBackgroundTerminals(terminals) {
    const box = el('backgroundTerminals');
    const list = el('backgroundTerminalsList');
    const items = terminals || [];
    box.hidden = items.length === 0;
    list.replaceChildren();
    for (const t of items) {
      const li = document.createElement('li');

      const command = document.createElement('span');
      command.className = 'command';
      command.textContent = t.command || t.id;
      command.title = t.command || t.id;
      li.appendChild(command);

      if (t.stoppable) {
        const stop = document.createElement('button');
        stop.className = 'secondary';
        stop.textContent = '停止';
        stop.addEventListener('click', () => {
          vscode.postMessage({ type: 'stopBackgroundTask', id: t.id, command: t.command });
        });
        li.appendChild(stop);
      } else {
        const note = document.createElement('span');
        note.className = 'note';
        note.textContent = 'この画面から停止する経路はありません';
        li.appendChild(note);
      }

      list.appendChild(li);
    }
  }

  function renderQueue(queued) {
    const box = el('queue');
    const list = el('queueList');
    if (!queued || queued.length === 0) {
      box.hidden = true;
      list.replaceChildren();
      return;
    }

    box.hidden = false;
    // 割り込めなかった指示だけがここに残る
    el('queueLabel').textContent = '割り込めなかったので待っています（' + queued.length + '件）';
    list.replaceChildren();
    queued.forEach((message, index) => {
      const li = document.createElement('li');
      const label = document.createElement('span');
      const count = (message.attachments || []).length;
      // 添えた画像も一緒に待っている。件数を出して、消えていないことを示す
      const text = message.text + (count > 0 ? '（画像' + count + '枚）' : '');
      label.textContent = text;
      label.title = text;
      li.appendChild(label);

      const cancel = document.createElement('button');
      cancel.className = 'secondary';
      cancel.textContent = '取り消す';
      cancel.addEventListener('click', () => {
        vscode.postMessage({ type: 'cancelQueued', index });
      });
      li.appendChild(cancel);
      list.appendChild(li);
    });
  }

  function apply(state) {
    // リロード後にVSCodeがパネルを復元したとき、どのスレッドかを思い出すために保持する
    if (state.threadId) {
      patchState({ threadId: state.threadId });
    }
    // 届かない・配列でない回（未知の状態）では前回の値を保つ（issue #291）
    if (Array.isArray(state.workspaceRoots)) {
      workspaceRoots = state.workspaceRoots;
    }
    sentTexts = state.items
      .filter((i) => i.kind === 'userMessage' && i.text.trim() !== '')
      .map((i) => i.text);
    applySettings(state.settings, state.planMode);
    const log = el('log');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    lastItems = state.items;
    syncItems(state.items);
    // 承認カードは一時的なので作り直してよい（会話本文の選択は壊れない）
    const approvals = el('approvals');
    approvals.replaceChildren();
    for (const approval of state.approvals) {
      approvals.appendChild(renderApproval(approval, state.items || []));
    }
    renderPrompts(state.prompts);
    if (atBottom) log.scrollTop = log.scrollHeight;

    renderTodos(state.todos);
    renderBackgroundTerminals(state.backgroundTerminals);
    renderQueue(state.queued);
    el('stop').hidden = !state.busy;
    // 応答中でも送れる。進行中のターンへ割り込むので、応答は止まらない
    el('send').disabled = false;
    // 圧縮は新しいターンを起こす。応答中に重ねると割り込みになるため止める
    el('compact').disabled = !!state.busy;
    // インポートの確認要求も新しいターンを起こす（Claude Code画面のみ、issue #200）
    el('claudeImport').disabled = !!state.busy;
    // 要約も新しいターンを起こす（Claude Code画面のみ、issue #203）
    el('recap').disabled = !!state.busy;
    // 自動圧縮の確認・変更も新しいターンを起こす（Claude Code画面のみ、issue #201）
    const autocompactApplyButton = el('autocompactApply');
    if (autocompactApplyButton) autocompactApplyButton.disabled = !!state.busy;
    // /debugでの診断も新しいターンを起こす（Claude Code画面のみ、issue #205）。
    // 「デバッグログを開く」はCLIへ何も送らないローカル操作のため、応答中でも押せてよい
    const sendDebugCommandButton = el('sendDebugCommand');
    if (sendDebugCommandButton) sendDebugCommandButton.disabled = !!state.busy;
    applyPlanMode(state.planMode);
    applyFastMode(state);
    renderAttachments(state.attachments);
    applyLoop(state.loop);
    renderStatus(state);
  }

  // いま添えている枚数。本文が空でも送れるかの判定に使う
  let attachmentCount = 0;

  /**
   * 送信前の添付。サムネイルを並べ、送る前に個別に取り消せるようにする。
   * 上限の判定は拡張機能側が持つ（両方に書くと片方だけ直したとき食い違う）。
   */
  function renderAttachments(list) {
    const box = el('attachments');
    const items = list || [];
    attachmentCount = items.length;
    box.hidden = items.length === 0;
    box.replaceChildren();

    for (const item of items) {
      const cell = document.createElement('div');
      cell.className = 'attachment';

      const image = document.createElement('img');
      image.src = item.dataUrl;
      image.alt = item.name;
      cell.appendChild(image);

      const label = document.createElement('span');
      label.className = 'name';
      label.textContent = item.name + ' ・ ' + item.size;
      label.title = item.name;
      cell.appendChild(label);

      const remove = document.createElement('button');
      remove.className = 'secondary';
      remove.textContent = '取り消す';
      remove.addEventListener('click', () => {
        vscode.postMessage({ type: 'removeAttachment', id: item.id });
      });
      cell.appendChild(remove);
      box.appendChild(cell);
    }
  }

  /** 画像を読み込んで拡張機能側へ渡す。形式と大きさの判定は向こうがやる。 */
  function offerFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      vscode.postMessage({ type: 'attach', name: file.name || '', dataUrl: reader.result });
    };
    reader.readAsDataURL(file);
  }

  function offerFiles(files) {
    for (const file of files || []) {
      if (file && String(file.type).indexOf('image/') === 0) offerFile(file);
    }
  }

  /**
   * ドロップされたものを添付にする（issue #241）。
   *
   * 画像を1枚も取れなかったときは理由をホストへ渡す。黙って何も起きない状態にすると
   * 「ドロップがWebviewまで届いていない」のか「届いたが受け付けられなかった」のかを
   * 見分けられない。
   */
  function offerDropped(dataTransfer) {
    const files = (dataTransfer && dataTransfer.files) || [];
    let took = false;
    for (const file of files) {
      if (file && String(file.type).indexOf('image/') === 0) {
        offerFile(file);
        took = true;
      }
    }
    if (took) return;

    // 実体のあるファイルはfilesに入る。VS Codeのエクスプローラーなど画面内からの
    // ドラッグはパスだけをtext/uri-listに載せてくるため、両者を分けて理由にする
    const types = (dataTransfer && dataTransfer.types) || [];
    const hasUriList = Array.prototype.indexOf.call(types, 'text/uri-list') !== -1;
    const kind = files.length > 0 ? 'notImage' : hasUriList ? 'pathOnly' : 'empty';
    vscode.postMessage({ type: 'dropRejected', kind: kind });
  }

  // いまPlan modeか。押したときに反転させるため覚えておく
  let planMode = false;

  /** 計画ボタンの見た目。押されているかが常に分かるようにする。 */
  function applyPlanMode(on) {
    planMode = !!on;
    const button = el('planToggle');
    button.setAttribute('aria-pressed', planMode ? 'true' : 'false');
    button.className = planMode ? 'toggled' : 'secondary';
  }

  // いまFast modeか（Claude Codeのみ）。押したときに反転させるため覚えておく
  let fastMode = false;

  /**
   * 高速ボタン（Fast mode）の見た目（issue #198）。
   *
   * state.fastMode が undefined のときはボタンごと隠す。Codex画面にはこの概念が無く、
   * Claude Code側でも initialize が fast_mode_state を返さない版があるため、
   * 「対応しない」と「オフ」を見た目でも区別する。
   */
  function applyFastMode(state) {
    const button = el('fastToggle');
    if (!button) return;
    const supported = state.fastMode !== undefined && state.fastMode !== null;
    button.hidden = !supported;
    if (!supported) return;

    fastMode = !!state.fastMode;
    button.setAttribute('aria-pressed', fastMode ? 'true' : 'false');
    button.className = fastMode ? 'toggled' : 'secondary';

    // 選んでいるモデルがFast modeを持たない場合は押させない（effortのセレクタと同じ扱い）
    const s = state.settings;
    const selected = s && s.models ? s.models.find((m) => m.slug === s.model) : undefined;
    const unsupportedModel = !!selected && selected.supportsFastMode === false;
    button.disabled = unsupportedModel;
    button.title = unsupportedModel
      ? 'このモデルはFast modeに対応していません'
      : '応答を速くします（Fast mode）';
  }

  /**
   * 入力欄の下の一行。レート制限の消費率とコンテキスト残量は別物なので、
   * どちらの数字か分かる言葉を付けて並べる。
   */
  function renderStatus(state) {
    const status = el('status');
    status.replaceChildren();

    const bits = [];
    // 承認は常に見えるようにする（Shift+Tabで回すため。issue #13）。3段階のどれかに
    // 当てはまるならその表示名を、当てはまらないなら生の値をそのまま出す
    const settings = state.settings || {};
    const levelMeta = settings.approvalLevel ? APPROVAL_LEVEL_META[settings.approvalLevel] : undefined;
    const approval = levelMeta ? levelMeta.label : settings.approvalMode;
    bits.push('承認 ' + (approval ? approval : '既定'));
    if (state.planMode) bits.push('計画モード（ファイルは変更されません）');
    if (state.reviewing) bits.push('レビュー中は割り込めません');
    if (state.busy) bits.push('応答中…');
    const usageText = formatUsage(state.usage);
    if (usageText !== '') bits.push(usageText);
    if (bits.length > 0) status.appendChild(document.createTextNode(bits.join(' ・ ')));

    const context = formatContext(state.context);
    if (context) {
      if (status.childNodes.length > 0) status.appendChild(document.createTextNode(' ・ '));
      const span = document.createElement('span');
      if (context.low) span.className = 'warn';
      span.textContent = context.text;
      status.appendChild(span);
    }

    const cost = formatSessionCost(state.sessionCost);
    if (cost) {
      if (status.childNodes.length > 0) status.appendChild(document.createTextNode(' ・ '));
      const costSpan = document.createElement('span');
      costSpan.textContent = cost.text;
      costSpan.title = cost.title;
      status.appendChild(costSpan);
    }

    // セッション累計のトークン数（Codexのみ、issue #294）。Claude Codeのコストと同じ場所に
    // 並べるが、値が届いていない間は枠ごと出さない（0や-で「取れていない」と「本当に0」を
    // 混同させないため）
    const sessionTokens = formatSessionTokens(state.sessionTokens);
    if (sessionTokens) {
      if (status.childNodes.length > 0) status.appendChild(document.createTextNode(' ・ '));
      const tokensSpan = document.createElement('span');
      tokensSpan.textContent = sessionTokens.text;
      tokensSpan.title = sessionTokens.title;
      status.appendChild(tokensSpan);
    }

    // 自動圧縮の窓サイズ（issue #201）。まだ問い合わせていない間は state.autocompactWindow
    // 自体が無いため何も出さない（「自動」だと決め付けない）。コンテキスト残量のすぐ隣に
    // 置く（issue本文の置き場指定）
    const autocompact = formatAutocompactWindow(state.autocompactWindow);
    if (autocompact !== '') {
      if (status.childNodes.length > 0) status.appendChild(document.createTextNode(' ・ '));
      status.appendChild(document.createTextNode(autocompact));
    }

    // 追加クレジット（issue #204）。状態が取れているときは常に一言添える（受入基準
    // 「追加クレジットの状態が画面から分かる」）。基本のusage（レート制限の消費率）とは
    // 別の数字なので見出しを分ける
    const extraUsageText = formatExtraUsage(state.extraUsage);
    if (extraUsageText !== '') {
      if (status.childNodes.length > 0) status.appendChild(document.createTextNode(' ・ '));
      status.appendChild(document.createTextNode(extraUsageText));
    }

    // 上限に達している状態のときだけ、追加クレジットを要求する導線を出す（issue #204の
    // スコープ「フッターの使用量表示から導線を出す」）。extraUsage自体が取れなくても、
    // 既存のレート制限（state.usage.limited）が立っていれば導線だけは出す（受入基準
    // 「取れない場合は根拠を残し、コマンド送信の導線だけを提供する」）
    if (usageCreditsLimited(state)) {
      if (status.childNodes.length > 0) status.appendChild(document.createTextNode(' ・ '));
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary';
      button.textContent = '追加クレジットを要求';
      button.title = '上限に達しています。/usage-creditsを送って設定・管理者への要求ができます';
      button.disabled = !!state.busy;
      button.addEventListener('click', () => vscode.postMessage({ type: 'usageCreditsRequest' }));
      status.appendChild(button);
    }
  }

  /**
   * 自動圧縮の窓サイズの表記（issue #201）。formatTokensはコンテキスト残量と同じ
   * 丸め方（k/M単位）を使い、見え方をそろえる。
   */
  function formatAutocompactWindow(win) {
    if (!win) return '';
    if (win.mode === 'auto') return '自動圧縮 自動';
    if (typeof win.tokens === 'number') return '自動圧縮 ' + formatTokens(win.tokens);
    return '';
  }

  // 追加クレジット（usage credits）の表記（issue #204）。CLIが返すdisabled_reasonの
  // うち、実測で確認できたものだけ日本語を当てる。未知の値はそのまま出す（増えても
  // 表示が消えないようにするため）
  const EXTRA_USAGE_DISABLED_REASON_LABEL = {
    out_of_credits: 'クレジット切れ',
  };

  function formatExtraUsage(extraUsage) {
    if (!extraUsage) return '';
    if (extraUsage.isEnabled) {
      return typeof extraUsage.utilization === 'number'
        ? '追加クレジット ' + Math.round(extraUsage.utilization) + '%'
        : '追加クレジット 有効';
    }
    const reason = extraUsage.disabledReason
      ? EXTRA_USAGE_DISABLED_REASON_LABEL[extraUsage.disabledReason] || extraUsage.disabledReason
      : '';
    return '追加クレジット 無効' + (reason ? '（' + reason + '）' : '');
  }

  // フッターから追加クレジットの要求導線を出す条件（issue #204のスコープ「上限に達し
  // ている状態のとき」）。基本プランのレート制限（five_hour/seven_day）到達か、追加
  // クレジット自体の月次上限到達のどちらか。extraUsageが取れていなくても、既存の
  // レート制限が立っていれば導線を出す（状態が取れない場合でも導線だけは残す）
  function usageCreditsLimited(state) {
    const rateLimited = !!(state.usage && state.usage.limited);
    const spendLimitReached = !!(state.extraUsage && state.extraUsage.spendLimitReached);
    return rateLimited || spendLimitReached;
  }

  // セッションのコスト（issue #37、/cost相当）。レート制限の消費率（usage）とも
  // コンテキスト残量（context）とも別の数字なので、見出しを分けて並べる。Claude Codeの
  // セッションでのみ値が届く（Codexでは常にundefinedのまま）。
  function formatSessionCost(cost) {
    if (!cost || typeof cost.totalCostUsd !== 'number') return undefined;
    const amount = cost.totalCostUsd.toFixed(4);
    const titleBits = ['見積りコスト（現在のセッション、USD）: $' + amount];
    if (cost.subscriptionType) {
      titleBits.push(
        'サブスクリプション(' + cost.subscriptionType +
          ')のため、実際の請求額ではなくAPI料金換算の見積もりです',
      );
    }
    if (cost.totalLinesAdded || cost.totalLinesRemoved) {
      titleBits.push('コード変更: +' + cost.totalLinesAdded + ' / -' + cost.totalLinesRemoved + ' 行');
    }
    if (typeof cost.capturedAt === 'number') {
      titleBits.push('取得時刻: ' + new Date(cost.capturedAt).toLocaleString('ja-JP'));
    }
    return { text: 'コスト $' + amount, title: titleBits.join(' / ') };
  }

  // セッション累計のトークン数（issue #294）。Codexには金額（コスト）を取得する経路が無い
  // ため、formatSessionCostに相当する表示としてトークン数を出す。値が数値で届いていない間は
  // undefinedを返し、呼び出し側で枠ごと出さない（0や-を出すと「取れていない」のか
  // 「本当に0」なのか区別できなくなるため）。
  function formatSessionTokens(tokens) {
    if (typeof tokens !== 'number') return undefined;
    const titleBits = [
      'このセッションの累計トークン数: ' + tokens.toLocaleString('ja-JP'),
      'Codexには金額（コスト）を取得する経路が無いため、代わりにトークン数を表示しています',
    ];
    return { text: '累計トークン ' + formatTokens(tokens), title: titleBits.join(' / ') };
  }

  /**
   * コンテキストの使用量。上限が判らないときは割合を出さない（作った数字を出さない）。
   * 値そのものが無ければ何も返さず、表示ごと消す。
   */
  function formatContext(context) {
    if (!context) return undefined;
    const used = formatTokens(context.usedTokens);
    if (context.remainingPercent === undefined) {
      return { text: 'コンテキスト ' + used, low: false };
    }
    return {
      text:
        'コンテキスト ' + used + '/' + formatTokens(context.contextWindow) +
        '（残り' + context.remainingPercent + '%）',
      low: context.remainingPercent <= LOW_CONTEXT_PERCENT,
    };
  }

  function formatTokens(count) {
    if (typeof count !== 'number') return '?';
    if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M';
    if (count >= 1000) return Math.round(count / 1000) + 'k';
    return String(count);
  }

  // ループが止まった理由の説明。止まったことに気付けるよう、次を始めるまで残す。
  const LOOP_STOP_LABEL = {
    done: '条件が成立しました',
    maxReached: '指定した回数を送り終えました',
    failed: '応答が失敗したため止めました',
    manual: '停止しました',
    interrupted: '手動の操作が入ったため止めました',
    // design.md §16.27、Issue #336。同じ応答が繰り返され進捗が無いまま停止した
    stalled: '同じ応答が繰り返されたため止めました',
    // design.md §16.8。ワークフローViewの「タスク停止」による停止。manual（この画面の
    // 停止ボタン）とは別の操作なので、LoopStopReason側で区別されている
    taskStopped: 'ワークフローから停止されました',
  };

  function applyLoop(loop) {
    el('loopStart').disabled = !!(loop && loop.running);
    const bar = el('loopBar');
    if (!loop || (!loop.running && !loop.stopReason)) {
      bar.hidden = true;
      el('loopStop').hidden = true;
      return;
    }

    bar.hidden = false;
    el('loopStop').hidden = !loop.running;
    const count = loop.iteration + '/' + loop.maxIterations + '回目';
    if (loop.running) {
      const bits = ['ループ ' + count];
      if (loop.condition) bits.push('条件: ' + loop.condition);
      el('loopProgress').textContent = bits.join(' ・ ');
      return;
    }
    el('loopProgress').textContent =
      'ループ終了（' + count + '）・' + (LOOP_STOP_LABEL[loop.stopReason] || loop.stopReason);
  }

  el('loopToggle').addEventListener('click', () => {
    const panel = el('loop');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) el('loopContinue').focus();
  });

  el('loopStart').addEventListener('click', () => {
    const plan = {
      initialPrompt: el('loopInitial').value,
      continuePrompt: el('loopContinue').value,
      maxIterations: el('loopMax').value,
      condition: el('loopCondition').value,
    };
    if (!plan.continuePrompt.trim()) {
      el('loopContinue').focus();
      return;
    }
    el('loop').hidden = true;
    vscode.postMessage({ type: 'loop/start', plan });
  });

  el('loopStop').addEventListener('click', () => vscode.postMessage({ type: 'loop/stop' }));

  // 使用量の表記。Codexは消費率、Claude Codeは制限の種類とリセットまでの時間で示す。
  function formatUsage(usage) {
    if (!usage) return '';
    if (usage.usedPercent !== undefined) return '使用量 ' + Math.round(usage.usedPercent) + '%';

    const bits = [];
    if (usage.limitLabel) bits.push(usage.limitLabel + '制限');
    if (usage.limited) bits.push('到達');
    const resets = formatResetsIn(usage.resetsAt);
    if (resets !== '') bits.push('リセット ' + resets);
    return bits.join(' ');
  }

  function formatResetsIn(resetsAtEpochSeconds) {
    if (typeof resetsAtEpochSeconds !== 'number') return '';
    const minutes = Math.round((resetsAtEpochSeconds * 1000 - Date.now()) / 60000);
    if (minutes <= 0) return 'まもなく';
    if (minutes < 60) return minutes + '分後';
    const hours = Math.round(minutes / 60);
    if (hours < 24) return hours + '時間後';
    return Math.round(hours / 24) + '日後';
  }

  // スラッシュで始まる行を書いている間だけ候補を出す。行の途中では邪魔しない
  function commandQuery(input) {
    const upto = input.value.slice(0, input.selectionStart);
    const line = upto.slice(upto.lastIndexOf('\\n') + 1);
    const m = /^\\/([\\w-]*)$/.exec(line);
    return m ? m[1] : undefined;
  }

  // @ で始まる語を書いている間だけファイル候補を出す。メールアドレスなどを邪魔しないよう、
  // 直前が行頭か空白のものだけを拾う
  function mentionQuery(input) {
    const upto = input.value.slice(0, input.selectionStart);
    const m = /(?:^|\\s)@([^\\s@]*)$/.exec(upto);
    return m ? m[1] : undefined;
  }

  function menuOpen() {
    return !el('commands').hidden;
  }

  function showCommands(query) {
    menuMode = 'command';
    matched = filterCommands(commands, query);
    renderMenu();
  }

  /** ファイル候補はホスト側で絞ってから届く。絞り込みの規則を2か所に持たないため */
  function showFiles(list) {
    menuMode = 'file';
    matched = list;
    renderMenu();
  }

  function renderMenu() {
    const box = el('commands');
    if (matched.length === 0) {
      box.hidden = true;
      return;
    }

    if (activeIndex >= matched.length) activeIndex = 0;
    box.hidden = false;
    box.replaceChildren();
    matched.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'row' + (index === activeIndex ? ' active' : '');

      const name = document.createElement('span');
      name.className = 'name';
      const desc = document.createElement('span');
      desc.className = 'desc';

      if (menuMode === 'file') {
        // ファイル名を主、置き場所を従にする。同名のファイルを見分けられるように
        const path = String(item);
        const cut = path.lastIndexOf('/');
        name.textContent = cut < 0 ? path : path.slice(cut + 1);
        desc.textContent = cut < 0 ? '' : path.slice(0, cut);
      } else {
        name.textContent = '/' + item.name;
        desc.textContent = item.description || '';
      }

      row.appendChild(name);
      // 引数の書き方は名前と別の色で添える（issue #9）。無いコマンドでは要素ごと出さない
      if (menuMode !== 'file' && item.argumentHint) {
        const hint = document.createElement('span');
        hint.className = 'hint';
        hint.textContent = item.argumentHint;
        row.appendChild(hint);
      }
      row.appendChild(desc);
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        acceptItem(index);
      });
      box.appendChild(row);
    });
    const active = box.querySelector('.row.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  /**
   * いま打っているコマンドの引数ヒントを入力欄の下に出す（issue #9）。
   *
   * 候補一覧にもヒントは出るが、確定すると一覧が閉じる。書き方が要るのはむしろ
   * その後なので、打っている間ずっと見えるようにする。
   * 判定の規則はホスト側の hintForInput（src/provider/slashCommands.ts）と同じ。
   * テンプレートリテラルの中からは関数を呼べないため書き直している。両方を揃えること。
   */
  function renderArgumentHint() {
    const box = el('argumentHint');
    if (!box) return;
    const text = el('input').value;
    const line = text.slice(text.lastIndexOf('\\n') + 1);
    const space = line.indexOf(' ');
    let found;
    if (line.slice(0, 1) === '/' && space !== -1) {
      const name = line.slice(1, space);
      found = commands.find((c) => c.name === name && c.argumentHint);
    }
    box.hidden = !found;
    box.textContent = found ? '/' + found.name + ' ' + found.argumentHint : '';
  }

  /**
   * 行頭の !/# を送信前に案内する（issue #5/#6、Claude Code画面のみ）。
   *
   * 判定の規則はホスト側の routeInputMode（src/provider/inputModes.ts）と同じ。
   * テンプレートリテラルの中からは関数を呼べないため書き直している。両方を揃えること。
   */
  function renderInputModeHint() {
    const box = el('inputModeHint');
    if (!box || !SHOW_INPUT_MODE_HINTS) return;
    const line = el('input').value.trim();
    let text = '';
    if (line.indexOf('\\n') === -1) {
      if (line.slice(0, 1) === '!' && line.slice(1).trim() !== '') {
        text = 'シェルコマンドとしてターミナルへ入力します: ' + line.slice(1).trim();
      } else if (line.slice(0, 1) === '#' && line.slice(1).trim() !== '') {
        text = 'メモリへ追記します: ' + line.slice(1).trim();
      }
    }
    box.hidden = text === '';
    box.textContent = text;
  }

  function filterCommands(list, query) {
    const needle = String(query).toLowerCase();
    if (needle === '') return list.slice();
    const prefix = [];
    const partial = [];
    for (const command of list) {
      const name = command.name.toLowerCase();
      if (name.startsWith(needle)) prefix.push(command);
      else if (name.includes(needle)) partial.push(command);
    }
    return prefix.concat(partial);
  }

  function closeMenu() {
    el('commands').hidden = true;
    activeIndex = 0;
    menuMode = '';
  }

  /** 候補を確定して入力欄へ入れる。送信まではしない（引数を書き足せるように） */
  function acceptItem(index) {
    const item = matched[index];
    if (!item) return;
    const input = el('input');
    const upto = input.value.slice(0, input.selectionStart);
    const rest = input.value.slice(input.selectionStart);

    if (menuMode === 'file') {
      // @ は候補を出す引き金なので消す。CLIへはただの相対パスとして渡す
      const at = upto.lastIndexOf('@');
      if (at < 0) return;
      const inserted = String(item) + ' ';
      input.value = input.value.slice(0, at) + inserted + rest;
      input.selectionStart = input.selectionEnd = at + inserted.length;
    } else {
      const lineStart = upto.lastIndexOf('\\n') + 1;
      const inserted = '/' + item.name + ' ';
      input.value = input.value.slice(0, lineStart) + inserted + rest;
      input.selectionStart = input.selectionEnd = lineStart + inserted.length;
    }

    closeMenu();
    // 候補が閉じた後こそ書き方が要る。確定した時点でヒントへ切り替える（issue #9）
    renderArgumentHint();
    input.focus();
  }

  function send() {
    const input = el('input');
    const text = input.value;
    // 画像だけ送るのも許す。本文が無くても添付があれば送る意味がある
    if (!text.trim() && attachmentCount === 0) return;
    input.value = '';
    renderArgumentHint();
    renderInputModeHint();
    resetHistory();
    vscode.postMessage({ type: 'send', text });
  }

  // 入力欄の履歴。この会話の自分の発言を新しい順にたどる。
  // -1 は「履歴に入っていない（編集中）」状態。
  let historyIndex = -1;
  let draft = '';

  function resetHistory() {
    historyIndex = -1;
    draft = '';
  }

  function historyEntries() {
    return sentTexts.slice().reverse();
  }

  /** カーソルが1行目にあるか。複数行の編集を邪魔しないための判定。 */
  function atFirstLine(input) {
    return input.value.lastIndexOf('\\n', Math.max(0, input.selectionStart - 1)) === -1;
  }

  function atLastLine(input) {
    return input.value.indexOf('\\n', input.selectionStart) === -1;
  }

  function applyHistory(input, index) {
    historyIndex = index;
    const entries = historyEntries();
    input.value = index === -1 ? draft : entries[index];
    // 呼び出した直後に続きを書けるよう末尾へ置く
    input.selectionStart = input.selectionEnd = input.value.length;
  }

  function stepHistory(input, direction) {
    const entries = historyEntries();
    if (entries.length === 0) return false;

    if (direction < 0) {
      if (historyIndex === -1) draft = input.value;
      if (historyIndex + 1 >= entries.length) return false;
      applyHistory(input, historyIndex + 1);
      return true;
    }

    if (historyIndex === -1) return false;
    applyHistory(input, historyIndex - 1);
    return true;
  }

  el('send').addEventListener('click', send);
  // 確認は拡張機能側で出す。会話の内容を不可逆に変えるため、押しただけでは実行しない
  el('compact').addEventListener('click', () => vscode.postMessage({ type: 'compact' }));
  // 他エージェントからの設定インポート（issue #200）。確認は拡張機能側で出す
  el('claudeImport').addEventListener('click', () =>
    vscode.postMessage({ type: 'claudeImport' }),
  );
  // 会話の1行要約（issue #203）。壊れる操作ではないため確認は無く、押すとそのまま送る
  el('recap').addEventListener('click', () => vscode.postMessage({ type: 'recap' }));
  // 自動圧縮の窓サイズ（issue #201）。Codex画面には要素ごと無い（showAutocompactが
  // falseだと設定行に描画されない）ため、Fast modeと同じくnullを許して素通しする。
  // 入力欄が空欄なら現在値の問い合わせ、値があれば変更として拡張機能側で分岐する
  // （streamSession.tsのsetAutocompactWindow参照）。壊れる操作ではないため確認は無い
  const autocompactApplyButton = el('autocompactApply');
  if (autocompactApplyButton) {
    autocompactApplyButton.addEventListener('click', () => {
      const input = el('autocompactInput');
      vscode.postMessage({ type: 'autocompactWindow', window: input ? input.value : '' });
    });
  }
  // CLI側のデバッグログ（issue #205）。Codex画面には要素ごと無い（showDebugがfalseだと
  // 設定行に描画されない）ため、自動圧縮と同じくnullを許して素通しする。
  // 「デバッグログを開く」はCLIへ何も送らないため確認は無く、押すとそのまま拡張機能側へ
  // 依頼する（実際にファイルを開けるかは拡張機能側で判定する）。「/debugで診断」は実モデルが
  // 動き課金されるため、拡張機能側で確認してから送る
  const openDebugLogButton = el('openDebugLog');
  if (openDebugLogButton) {
    openDebugLogButton.addEventListener('click', () =>
      vscode.postMessage({ type: 'openDebugLog' }),
    );
  }
  const sendDebugCommandButton = el('sendDebugCommand');
  if (sendDebugCommandButton) {
    sendDebugCommandButton.addEventListener('click', () =>
      vscode.postMessage({ type: 'debugCommand' }),
    );
  }
  // 見た目は状態が返ってきてから変える。押した瞬間に変えると、失敗したとき嘘になる
  el('planToggle').addEventListener('click', () =>
    vscode.postMessage({ type: 'planMode', on: !planMode }),
  );
  // Fast mode（issue #198）。計画ボタンと同じく、見た目は状態が返ってきてから変える
  el('fastToggle').addEventListener('click', () =>
    vscode.postMessage({ type: 'fastMode', on: !fastMode }),
  );

  // Codexは対象をQuickPickで選ばせるためホストへ委ねる。Claude Codeはコマンドとして
  // そのまま送る（CLI側が対話で対象を聞く）
  el('review').addEventListener('click', () => {
    if (REVIEW.mode === 'command') {
      vscode.postMessage({ type: 'send', text: '/' + REVIEW.commandName });
      return;
    }
    vscode.postMessage({ type: 'review' });
  });

  // 会話全体の取り出し（issue #25）。Markdownの組み立て・コピー・保存・生テキスト表示は
  // すべて拡張機能側で行う（巨大な会話でもWebviewの描画スレッドを固まらせないため）
  el('exportTranscript').addEventListener('click', () =>
    vscode.postMessage({ type: 'exportTranscript' }),
  );

  // ワークフローの導線（issue #250）。この会話とは独立した全体の操作なので、
  // 応答中でも押せるまま（送信中に無効化する要素の一覧には入れない）にしてある
  el('workflowMenu').addEventListener('click', () =>
    vscode.postMessage({ type: 'workflowMenu' }),
  );

  /**
   * アイコン列の「…」メニューの開閉（issue #296）。畳んだボタンはcomposerIconRowの
   * 中に実体をそのまま置いてあり、hidden属性で表と行き来させているだけなので、
   * 応答中のdisabled切替・state更新によるhidden切替（fastToggle等、applyFastMode
   * 参照）はこのブロックを触らずとも既存のコードのままどちら側でも効く。
   */
  const composerOverflow = el('composerOverflow');
  const composerOverflowToggle = el('composerOverflowToggle');
  const composerOverflowMenu = el('composerOverflowMenu');

  /** 隠していない（=いま押せる）メニュー項目だけを、DOM順のまま返す。 */
  function overflowMenuItems() {
    return Array.prototype.filter.call(composerOverflowMenu.querySelectorAll('button'), (b) => !b.hidden);
  }

  function closeOverflowMenu(focusToggle) {
    if (composerOverflowMenu.hidden) return;
    composerOverflowMenu.hidden = true;
    composerOverflowToggle.setAttribute('aria-expanded', 'false');
    if (focusToggle) composerOverflowToggle.focus();
  }

  function openOverflowMenu() {
    composerOverflowMenu.hidden = false;
    composerOverflowToggle.setAttribute('aria-expanded', 'true');
    const items = overflowMenuItems();
    if (items.length > 0) items[0].focus();
  }

  composerOverflowToggle.addEventListener('click', () => {
    if (composerOverflowMenu.hidden) {
      openOverflowMenu();
    } else {
      closeOverflowMenu(false);
    }
  });

  // メニュー内はTab/矢印キーで移動し、端で折り返す（フォーカスがメニュー外へ逃げない）。
  // Escapeは閉じてトグルボタンへフォーカスを戻す
  composerOverflowMenu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeOverflowMenu(true);
      return;
    }
    const items = overflowMenuItems();
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(index + 1 + items.length) % items.length].focus();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(index - 1 + items.length) % items.length].focus();
      return;
    }
    if (e.key === 'Tab') {
      // 最後の項目でTab・最初の項目でShift+Tabを押されたら折り返す。それ以外は
      // ブラウザ標準のTab移動に任せてよい（項目同士の間はメニュー内にとどまる）
      if (e.shiftKey && index <= 0) {
        e.preventDefault();
        items[items.length - 1].focus();
      } else if (!e.shiftKey && index >= items.length - 1) {
        e.preventDefault();
        items[0].focus();
      }
    }
  });

  // 項目を押したら閉じる（トグル系も含め、他の操作に進めるよう他のメニューUIと揃える）
  composerOverflowMenu.addEventListener('click', (e) => {
    if (e.target.closest('button')) closeOverflowMenu(false);
  });

  // メニュー外クリックで閉じる
  document.addEventListener('click', (e) => {
    if (!composerOverflowMenu.hidden && !composerOverflow.contains(e.target)) {
      closeOverflowMenu(false);
    }
  });

  el('attach').addEventListener('click', () => el('filePicker').click());
  el('filePicker').addEventListener('change', (e) => {
    offerFiles(e.target.files);
    // 同じファイルを続けて選べるようにする
    e.target.value = '';
  });

  // 貼り付け。スクリーンショットを見せながら指示する使い方の本命
  el('input').addEventListener('paste', (e) => {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    let took = false;
    for (const item of items) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (file && String(file.type).indexOf('image/') === 0) {
        offerFile(file);
        took = true;
      }
    }
    // 画像を取ったときだけ既定の貼り付けを止める。テキストの貼り付けは邪魔しない
    if (took) e.preventDefault();
  });

  // ドラッグ&ドロップ。既定の動作（画像を開く）を止めないと画面が置き換わる。
  // dragenterも止める（issue #241）。HTML5のD&Dは、ドロップ先として認められるために
  // dragenterとdragoverの両方で既定動作を打ち消すことを求める。dragoverだけだと
  // 入った時点で「ここは受け取らない」と判断され、VS Code本体がファイルを開く側へ回る
  for (const name of ['dragenter', 'dragover', 'drop']) {
    document.addEventListener(name, (e) => {
      e.preventDefault();
      // 外側（VS Codeのワークベンチ）へ渡さない。渡るとエディタでファイルが開く
      e.stopPropagation();
      if (name === 'drop') offerDropped(e.dataTransfer);
    });
  }
  el('flushQueue').addEventListener('click', () => vscode.postMessage({ type: 'flushQueue' }));
  el('stop').addEventListener('click', () => vscode.postMessage({ type: 'interrupt' }));
  // 応答中のEscで中断する。画面のどこにフォーカスがあっても効くようにする
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || el('stop').hidden) return;
    e.preventDefault();
    vscode.postMessage({ type: 'interrupt' });
  });

  el('input').addEventListener('input', (e) => {
    renderArgumentHint();
    renderInputModeHint();
    const command = commandQuery(e.target);
    if (command !== undefined) {
      showCommands(command);
      return;
    }
    const mention = mentionQuery(e.target);
    if (mention !== undefined) {
      // 一覧はホストが持つ。走査し直すかどうかもホスト側で間引く
      menuMode = 'file';
      vscode.postMessage({ type: 'requestFiles', query: mention });
      return;
    }
    closeMenu();
  });

  el('input').addEventListener('blur', closeMenu);

  /**
   * IME変換中かどうかの追跡（issue #288）。keydownのe.isComposingだけに頼ると
   * ブラウザ差で取りこぼすことがあるため、compositionstart/compositionendでも
   * 二重に追う（decideSendKeyAction呼び出し側でどちらか一方の真を採用する）。
   */
  let imeComposing = false;
  el('input').addEventListener('compositionstart', () => {
    imeComposing = true;
  });
  el('input').addEventListener('compositionend', () => {
    imeComposing = false;
  });

  /**
   * 送信キー判定の実装（issue #288）。vscodeに依存しない純粋関数として
   * src/view/sendKey.tsに書き、ここへソースとして差し込む（mergeItemsと同じ流儀。
   * sendKey.tsのSEND_KEY_SOURCEのJSDoc参照）。
   */
  ${SEND_KEY_SOURCE}

  el('input').addEventListener('keydown', (e) => {
    if (menuOpen()) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIndex = (activeIndex + 1) % matched.length;
        renderMenu();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIndex = (activeIndex - 1 + matched.length) % matched.length;
        renderMenu();
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.ctrlKey && !e.metaKey)) {
        e.preventDefault();
        acceptItem(activeIndex);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMenu();
        return;
      }
    }

    // Shift+Tab で承認レベルを回す（TUIと同じ操作。入力欄にいるときだけ効かせる）。
    // 「全承認」は循環に入っていないため、連打で保護が外れることはない
    if (e.key === 'Tab' && e.shiftKey && APPROVAL_CYCLE.length > 0) {
      e.preventDefault();
      const index = APPROVAL_CYCLE.indexOf(currentApproval);
      const next = index === -1 ? APPROVAL_CYCLE[0] : APPROVAL_CYCLE[(index + 1) % APPROVAL_CYCLE.length];
      currentApproval = next;
      const level = el('approvalLevel');
      if (level) level.value = next;
      vscode.postMessage({ type: 'approvalLevel', level: next });
      return;
    }

    if (e.key === 'Enter') {
      const composing = imeComposing || e.isComposing === true;
      const action = decideSendKeyAction(
        {
          key: e.key,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          shiftKey: e.shiftKey,
          isComposing: composing,
        },
        SEND_ON,
      );
      if (action === 'send') {
        e.preventDefault();
        send();
      }
      return;
    }

    const input = e.target;
    if (e.key === 'ArrowUp' && !e.altKey && atFirstLine(input) && stepHistory(input, -1)) {
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowDown' && !e.altKey && atLastLine(input) && stepHistory(input, 1)) {
      e.preventDefault();
    }
  });

  /**
   * 差し分で届いた会話項目を積み直す（issue #262）。実装は stateDelta.ts に置き、
   * ここへ差し込む（両側へ書くと片方だけ直したときに黙ってずれる）。
   */
  ${MERGE_ITEMS_SOURCE}

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data) return;
    if (data.type === 'state') {
      // items（差し分）を送ってこない送信元は state.items を全量としてそのまま使う
      if (!data.items) {
        apply(data.state);
        return;
      }
      const items = mergeItems(mergedItems, data.items);
      if (items === undefined) {
        // 取りこぼしか並びのずれ。古い会話を出したままにせず、全量を送り直してもらう
        vscode.postMessage({ type: 'stateFull' });
        return;
      }
      mergedItems = items;
      apply(Object.assign({}, data.state, { items: items }));
    }
    if (data.type === 'commands') {
      commands = data.commands || [];
      // コマンド一覧に無ければボタンを出さない（押しても何も起きない状態を作らない）
      if (REVIEW.mode === 'command') {
        el('review').hidden = !commands.some((c) => c.name === REVIEW.commandName);
      }
    }
    if (data.type === 'files') {
      // 打っている途中に古い応答が届くことがある。今の語と一致するものだけ出す
      if (menuMode !== 'file') return;
      if (mentionQuery(el('input')) !== data.query) return;
      showFiles(data.files || []);
    }
    if (data.type === 'imageData' && data.path) {
      imageData.set(data.path, data.dataUrl || data.error || '画像を読み込めませんでした');
      // 届いた画像を反映する。差分がある項目だけ描き直される
      if (lastItems) syncItems(lastItems);
    }
    if (data.type === 'insertComposerText' && typeof data.text === 'string') {
      // エディタの選択範囲を入力欄へ挿す（issue #292）。ホスト側（chatView.ts /
      // claudeChatView.ts）が挿す先のタブと本文を決め、ここは受け取って反映するだけ。
      // 既に入力中の内容は壊さず末尾へ追記する（空でも改行を余分に挟まないよう分ける）。
      // 送信はしない（人が指示を書き足してから自分で送る）
      const input = el('input');
      const needsNewline = input.value.length > 0 && input.value.slice(-1) !== '\\n';
      input.value = input.value + (needsNewline ? '\\n' : '') + data.text;
      input.selectionStart = input.selectionEnd = input.value.length;
      input.focus();
    }
  });

  vscode.postMessage({ type: 'ready' });
`;
}
