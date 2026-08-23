import type { ChatItem } from './chatState';

/**
 * 会話全体をMarkdownで取り出す（issue #25・design.md §14.23）。
 *
 * TUIのトランスクリプト表示・`/raw` に相当する機能。`ChatState.items` をそのまま
 * 辿るだけの純粋関数にし、`vscode` を import する `src/view/**` から切り離してテストする。
 * 折りたたみ・画像の遅延読み込みなど画面だけの都合は持ち込まない
 * （書き出した内容が会話と一致することが受入基準のため）。
 */

/** 見出しに使う項目種類ごとのラベル。`chatScript.ts` の `KIND_LABEL` と語彙を揃えてある。
 * `agentMessage` だけは呼び出し側が渡す `agentLabel`（Codex / Claude Code）で決まるため
 * ここには含めない。 */
const KIND_TITLE: Record<string, string> = {
  userMessage: 'あなた',
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
  sideQuestion: '脇道の質問',
  subAgentActivity: 'サブエージェント',
  collabAgentToolCall: 'サブエージェント操作',
  autoApprovalReview: '自動承認レビュー',
  fileRead: 'ファイル読み取り',
};

/** ファイル変更の種類ラベル。`chatScript.ts` の `createDiff` と同じ対応。 */
const DIFF_KIND_TITLE: Record<string, string> = { add: '追加', delete: '削除', update: '変更' };

/** 未知の種類でも崩れないよう、対応する見出しが無ければ種類名をそのまま出す（`normalizeItem` と同じ方針）。 */
function titleOf(item: ChatItem, agentLabel: string): string {
  if (item.kind === 'agentMessage') {
    return agentLabel;
  }
  return KIND_TITLE[item.kind] ?? item.kind;
}

function headingOf(item: ChatItem, agentLabel: string): string {
  const bits = [titleOf(item, agentLabel)];
  if (item.detail !== '') {
    bits.push(item.detail);
  }
  if (item.status !== undefined && item.status !== '') {
    bits.push(item.status);
  }
  if (item.truncated === true) {
    bits.push('先頭は省略');
  }
  if (item.interruptedWhileRunning === true) {
    bits.push('中断後も継続中の可能性');
  }
  return `## ${bits.join(' ・ ')}`;
}

/**
 * 本文。reasoningは全文（`reasoningFull`）があればそちらを優先する（issue #19と同じ考え方）。
 * 画面の折りたたみ（要約/末尾だけを既定で見せる）は表示だけの都合で、書き出しには影響させない。
 */
function bodyOf(item: ChatItem): string {
  if (item.kind === 'reasoning') {
    return item.reasoningFull ?? item.text;
  }
  return item.text;
}

function diffBlocks(item: ChatItem): string[] {
  return item.diffs.map((diff) => {
    const kindLabel = DIFF_KIND_TITLE[diff.kind] ?? diff.kind;
    const header = `${diff.path}${diff.movePath === undefined ? '' : ` → ${diff.movePath}`}（${kindLabel}）`;
    return `${header}\n\n\`\`\`diff\n${diff.diff}\n\`\`\``;
  });
}

function searchResultBlock(item: ChatItem): string | undefined {
  const results = item.searchResults ?? [];
  if (results.length === 0) {
    return undefined;
  }
  return results.map((r) => `- [${r.title}](${r.url})`).join('\n');
}

function imageBlock(item: ChatItem): string | undefined {
  const images = item.images ?? [];
  if (images.length === 0) {
    return undefined;
  }
  return images
    .map((image) => {
      const label = image.alt !== '' ? image.alt : '画像';
      return image.path === undefined ? `- ${label}` : `- ${label}（${image.path}）`;
    })
    .join('\n');
}

/** 1項目分のMarkdown。本文・差分・検索結果・画像のいずれも無い項目も見出しだけ残す（イベントを取りこぼさない）。 */
function renderItem(item: ChatItem, agentLabel: string): string {
  const parts = [headingOf(item, agentLabel)];
  const body = bodyOf(item);
  if (body !== '') {
    parts.push(body);
  }
  parts.push(...diffBlocks(item));
  const search = searchResultBlock(item);
  if (search !== undefined) {
    parts.push(search);
  }
  const images = imageBlock(item);
  if (images !== undefined) {
    parts.push(images);
  }
  return parts.join('\n\n');
}

/**
 * Markdown全体で許す上限文字数。
 *
 * `MAX_OUTPUT_CHARS`（1項目あたりの上限）と同じ考え方を会話全体の合計にも適用する。
 * 際限なく伸びる会話をそのまま組み立てると、コピー・保存・エディタでの表示が重くなる
 * （issue #25の受入基準「長い会話でも取り出しが完了する」）。超えた分は先頭を捨て、
 * 直近のやり取り（末尾）を残す。
 */
export const MAX_TRANSCRIPT_CHARS = 5_000_000;

function capTranscript(text: string): string {
  if (text.length <= MAX_TRANSCRIPT_CHARS) {
    return text;
  }
  const kept = text.slice(text.length - MAX_TRANSCRIPT_CHARS);
  return (
    `> 会話が長いため、先頭を省略しました（末尾${MAX_TRANSCRIPT_CHARS.toLocaleString('ja-JP')}文字のみ表示しています）\n\n` +
    kept
  );
}

/**
 * 会話全体をMarkdownにする（issue #25）。
 *
 * 項目を区切り線（`---`）で並べるだけの単純な組み立てにし、`ChatState.items` がそのまま
 * 辿れるものはすべて出す。空の会話（`items.length === 0`）は空文字列を返す。呼び出し側は
 * 空文字列のときエクスポートの操作自体を進めない（design.md §14.23）。
 *
 * @param agentLabel `agentMessage` の見出しに使う（Codex / Claude Code）。
 */
export function buildTranscriptMarkdown(items: readonly ChatItem[], agentLabel: string): string {
  if (items.length === 0) {
    return '';
  }
  const sections = items.map((item) => renderItem(item, agentLabel));
  return capTranscript(sections.join('\n\n---\n\n'));
}

/** 保存ダイアログの既定ファイル名。秒まで含めて同日の複数回エクスポートでも上書きになりにくくする。 */
export function defaultTranscriptFileName(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `transcript-${stamp}.md`;
}
