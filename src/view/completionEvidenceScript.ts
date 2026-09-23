/**
 * 完了根拠（Issue #1380）の表示。ワークフローのタスク行と、会話画面のループ終了表示の
 * 両方に埋め込む（`MERGE_ITEMS_SOURCE` と同じ流儀）。
 *
 * 記録のコマンドと出力は信頼できない本文なので、すべて `textContent` で入れる
 * （HTMLとして解釈させない・リンクにしない）。長さの制限と1行化は拡張機能側
 * （`buildCompletionEvidenceView`）で済ませてから届く。
 *
 * `renderCompletionEvidence(view, options)` は `details` 要素を返す。
 * - `options.open`: 開いた状態で作る（再描画で閉じないよう、呼び出し側が開閉を覚えておく）
 * - `options.onToggle(open)`: 開閉が変わったとき
 * - `options.onRefresh()`: 渡すと「再確認」ボタンを出す（表示時点のソースで導き直す）
 */
export const COMPLETION_EVIDENCE_SOURCE = `var EVIDENCE_LABEL = {
    verified: '確認済み',
    failed: '失敗',
    selfReportedOnly: '自己申告のみ',
    unverified: '未確認',
  };
  var EVIDENCE_ACQUISITION_LABEL = {
    observed: '拡張機能が実行',
    'agent-reported': 'AIの報告',
    imported: '外部から取り込み',
  };
  var EVIDENCE_OUTCOME_LABEL = { pass: '成功', fail: '失敗', unknown: '結果不明' };
  var EVIDENCE_SOURCE_MATCH_LABEL = {
    match: '一致',
    mismatch: '不一致（記録の後に変更あり）',
    changedDuringRun: '不一致（実行中に変更あり）',
    unknown: '不明',
  };
  var EVIDENCE_TIME_KIND_LABEL = { ended: '終了', started: '開始', recorded: '保存' };

  function evidenceText(tag, className, value) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = value;
    return node;
  }

  function evidenceTime(value) {
    var date = new Date(value);
    return isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }

  function renderCompletionEvidence(view, options) {
    var opts = options || {};
    var box = document.createElement('details');
    box.className = 'completion-evidence evidence-' + view.category;
    if (opts.open) box.open = true;
    // 行のクリック（タスクの選択）へ伝わらないようにする
    box.addEventListener('click', function (e) { e.stopPropagation(); });
    box.addEventListener('toggle', function () {
      if (opts.onToggle) opts.onToggle(box.open);
    });

    var summary = document.createElement('summary');
    summary.appendChild(
      evidenceText('span', 'evidence-badge', EVIDENCE_LABEL[view.category] || view.category),
    );
    box.appendChild(summary);

    var head = document.createElement('div');
    head.className = 'evidence-head';
    head.appendChild(evidenceText('span', 'evidence-reason', view.reason));
    if (opts.onRefresh) {
      var refresh = evidenceText('button', 'secondary evidence-refresh', '再確認');
      refresh.type = 'button';
      refresh.title = '現在のソースの状態で表示区分を導き直します';
      refresh.addEventListener('click', function (e) {
        e.stopPropagation();
        opts.onRefresh();
      });
      head.appendChild(refresh);
    }
    box.appendChild(head);

    if (!view.entries || view.entries.length === 0) {
      box.appendChild(evidenceText('div', 'evidence-empty', '検証記録はありません'));
      return box;
    }
    var list = document.createElement('ul');
    list.className = 'evidence-list';
    view.entries.forEach(function (entry) {
      var item = document.createElement('li');
      item.className = 'evidence-entry evidence-trust-' + entry.trust;
      item.appendChild(evidenceText('code', 'evidence-command', entry.command));
      var meta = [
        'exit code ' + (entry.exitCode === null ? 'なし' : entry.exitCode),
        EVIDENCE_OUTCOME_LABEL[entry.outcome] || entry.outcome,
        EVIDENCE_ACQUISITION_LABEL[entry.acquisition] || entry.acquisition,
        (EVIDENCE_TIME_KIND_LABEL[entry.timeKind] || '') + ' ' + evidenceTime(entry.time),
        'ソース ' + (EVIDENCE_SOURCE_MATCH_LABEL[entry.sourceMatch] || entry.sourceMatch),
      ];
      item.appendChild(evidenceText('div', 'evidence-meta', meta.join(' ・ ')));
      if (entry.outputTail) {
        item.appendChild(evidenceText('div', 'evidence-output', entry.outputTail));
      }
      list.appendChild(item);
    });
    box.appendChild(list);
    if (view.omitted > 0) {
      box.appendChild(evidenceText('div', 'evidence-empty', 'ほか古い記録 ' + view.omitted + ' 件'));
    }
    return box;
  }`;

/** 完了根拠の表示のスタイル。ワークフロー画面と会話画面の両方で使う */
export function completionEvidenceStyles(): string {
  return `
  .completion-evidence > summary { cursor: pointer; }
  .completion-evidence .evidence-badge {
    padding: 0 6px;
    border: 1px solid var(--vscode-descriptionForeground);
    border-radius: var(--agent-radius-pill);
  }
  .completion-evidence.evidence-verified .evidence-badge {
    border-color: var(--vscode-testing-iconPassed);
  }
  .completion-evidence.evidence-failed .evidence-badge {
    border-color: var(--vscode-errorForeground);
    color: var(--vscode-errorForeground);
  }
  .completion-evidence .evidence-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
    white-space: normal;
  }
  .completion-evidence .evidence-empty { margin-top: 4px; opacity: 0.8; }
  .completion-evidence .evidence-list {
    margin: 4px 0 0;
    padding-left: 16px;
    white-space: normal;
  }
  .completion-evidence .evidence-command { overflow-wrap: anywhere; }
  .completion-evidence .evidence-meta { opacity: 0.85; }
  .completion-evidence .evidence-output {
    font-family: var(--vscode-editor-font-family);
    opacity: 0.85;
    overflow-wrap: anywhere;
    max-width: 60ch;
  }
`;
}
