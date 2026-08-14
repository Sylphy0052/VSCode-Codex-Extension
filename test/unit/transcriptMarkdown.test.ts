import { describe, expect, it } from 'vitest';
import type { ChatItem } from '../../src/appserver/chatState';
import {
  MAX_TRANSCRIPT_CHARS,
  buildTranscriptMarkdown,
  defaultTranscriptFileName,
} from '../../src/appserver/transcriptMarkdown';

/** テストで使い回す最小限のChatItem。個別のテストでは足りないフィールドだけ上書きする。 */
function makeItem(overrides: Partial<ChatItem> & Pick<ChatItem, 'id' | 'kind'>): ChatItem {
  return {
    text: '',
    detail: '',
    status: undefined,
    turnId: undefined,
    diffs: [],
    ...overrides,
  };
}

describe('buildTranscriptMarkdown', () => {
  it('空の会話は空文字列を返す', () => {
    expect(buildTranscriptMarkdown([], 'Codex')).toBe('');
  });

  it('userMessage を見出し付きの節にする', () => {
    const md = buildTranscriptMarkdown(
      [makeItem({ id: 'u1', kind: 'userMessage', text: 'こんにちは' })],
      'Codex',
    );
    expect(md).toBe('## あなた\n\nこんにちは');
  });

  it('agentMessage の見出しは呼び出し側が渡したagentLabelを使う（Codex/Claude Codeの差し替え）', () => {
    const item = makeItem({ id: 'a1', kind: 'agentMessage', text: 'OK' });
    expect(buildTranscriptMarkdown([item], 'Codex')).toContain('## Codex\n\nOK');
    expect(buildTranscriptMarkdown([item], 'Claude Code')).toContain('## Claude Code\n\nOK');
  });

  it('reasoning は全文(reasoningFull)があればそちらを使う（issue #19と同じ考え方）', () => {
    const item = makeItem({
      id: 'r1',
      kind: 'reasoning',
      text: '要約',
      reasoningFull: '全文の思考過程',
    });
    expect(buildTranscriptMarkdown([item], 'Codex')).toBe('## 思考\n\n全文の思考過程');
  });

  it('reasoning は全文が無ければ要約(text)を使う', () => {
    const item = makeItem({ id: 'r2', kind: 'reasoning', text: '要約のみ' });
    expect(buildTranscriptMarkdown([item], 'Codex')).toBe('## 思考\n\n要約のみ');
  });

  it('commandExecution はコマンド(detail)・状態(status)・出力(text)を見出しと本文に分けて出す', () => {
    const item = makeItem({
      id: 'c1',
      kind: 'commandExecution',
      text: 'total 0',
      detail: 'ls -la',
      status: 'exit 0',
    });
    expect(buildTranscriptMarkdown([item], 'Codex')).toBe('## コマンド ・ ls -la ・ exit 0\n\ntotal 0');
  });

  it('先頭を捨てた(truncated)コマンド出力には注記が付く', () => {
    const item = makeItem({
      id: 'c2',
      kind: 'commandExecution',
      text: '...',
      detail: 'find /',
      truncated: true,
    });
    expect(buildTranscriptMarkdown([item], 'Codex')).toContain('先頭は省略');
  });

  it('中断した時点で実行中だったコマンドには注記が付く', () => {
    const item = makeItem({
      id: 'c3',
      kind: 'commandExecution',
      text: 'line 1',
      detail: 'sleep 60',
      status: 'inProgress',
      interruptedWhileRunning: true,
    });
    expect(buildTranscriptMarkdown([item], 'Codex')).toContain('中断後も継続中の可能性');
  });

  it('fileChange は差分をdiffフェンスで出す', () => {
    const item = makeItem({
      id: 'f1',
      kind: 'fileChange',
      detail: 'a.ts',
      diffs: [{ path: 'a.ts', kind: 'update', movePath: undefined, diff: '@@ -1 +1 @@\n-old\n+new' }],
    });
    const md = buildTranscriptMarkdown([item], 'Codex');
    expect(md).toContain('## ファイル変更 ・ a.ts');
    expect(md).toContain('a.ts（変更）');
    expect(md).toContain('```diff\n@@ -1 +1 @@\n-old\n+new\n```');
  });

  it('fileChangeの移動先(movePath)も見出しに出す', () => {
    const item = makeItem({
      id: 'f2',
      kind: 'fileChange',
      diffs: [{ path: 'old.ts', kind: 'update', movePath: 'new.ts', diff: 'x' }],
    });
    expect(buildTranscriptMarkdown([item], 'Codex')).toContain('old.ts → new.ts（変更）');
  });

  it('未知のdiff.kindはそのまま出す（将来種類が増えても崩れない）', () => {
    const item = makeItem({
      id: 'f3',
      kind: 'fileChange',
      diffs: [{ path: 'a.ts', kind: 'rename', movePath: undefined, diff: 'x' }],
    });
    expect(buildTranscriptMarkdown([item], 'Codex')).toContain('a.ts（rename）');
  });

  it('webSearch は検索結果をMarkdownリンクの一覧にする', () => {
    const item = makeItem({
      id: 'w1',
      kind: 'webSearch',
      detail: 'TypeScript 最新リリース',
      searchResults: [{ title: 'TypeScript 5.7', url: 'https://example.test/ts57' }],
    });
    const md = buildTranscriptMarkdown([item], 'Codex');
    expect(md).toContain('## Web検索 ・ TypeScript 最新リリース');
    expect(md).toContain('- [TypeScript 5.7](https://example.test/ts57)');
  });

  it('画像はパスまたは代替テキストを箇条書きで出す', () => {
    const item = makeItem({
      id: 'i1',
      kind: 'imageView',
      images: [{ dataUrl: undefined, path: '/tmp/shot.png', alt: 'スクリーンショット' }],
    });
    expect(buildTranscriptMarkdown([item], 'Codex')).toContain(
      '- スクリーンショット（/tmp/shot.png）',
    );
  });

  it('未知の種類(kind)は種類名をそのまま見出しにする（normalizeItemの防御的な既定と同じ方針）', () => {
    const item = makeItem({ id: 'x1', kind: 'futureKind', text: '中身' });
    expect(buildTranscriptMarkdown([item], 'Codex')).toBe('## futureKind\n\n中身');
  });

  it('本文・差分・検索結果・画像のいずれも無い項目は見出しだけを残す（取りこぼさない）', () => {
    const item = makeItem({ id: 'e1', kind: 'enteredReviewMode' });
    expect(buildTranscriptMarkdown([item], 'Codex')).toBe('## レビュー開始');
  });

  it('複数項目は区切り線(---)で並べる', () => {
    const items = [
      makeItem({ id: 'u1', kind: 'userMessage', text: '質問' }),
      makeItem({ id: 'a1', kind: 'agentMessage', text: '回答' }),
    ];
    expect(buildTranscriptMarkdown(items, 'Codex')).toBe(
      '## あなた\n\n質問\n\n---\n\n## Codex\n\n回答',
    );
  });

  it('巨大な会話は上限文字数で先頭を捨て、末尾を残したうえで完了する（画面を固まらせない）', () => {
    const huge = 'x'.repeat(MAX_TRANSCRIPT_CHARS + 100_000);
    const items = [makeItem({ id: 'big', kind: 'agentMessage', text: huge })];
    const md = buildTranscriptMarkdown(items, 'Codex');
    expect(md.length).toBeLessThan(huge.length);
    expect(md).toContain('先頭を省略しました');
    expect(md.endsWith('x')).toBe(true);
  });

  it('項目数が多い会話でも組み立てが完了する', () => {
    const items = Array.from({ length: 2000 }, (_, i) =>
      makeItem({ id: `u${i}`, kind: 'userMessage', text: `発言${i}` }),
    );
    const md = buildTranscriptMarkdown(items, 'Codex');
    expect(md).toContain('発言0');
    expect(md).toContain('発言1999');
  });
});

describe('defaultTranscriptFileName', () => {
  it('日時から yyyyMMdd-HHmmss 形式のファイル名を作る', () => {
    const name = defaultTranscriptFileName(new Date(2026, 7, 11, 9, 5, 3));
    expect(name).toBe('transcript-20260811-090503.md');
  });
});
