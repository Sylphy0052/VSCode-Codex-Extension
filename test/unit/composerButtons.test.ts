import { describe, expect, it } from 'vitest';
import {
  COMPOSER_BUTTON_IDS,
  DEFAULT_COMPOSER_BUTTONS,
  isComposerButtonId,
  normalizeComposerButtons,
  overflowComposerButtons,
} from '../../src/view/composerButtons';

describe('COMPOSER_BUTTON_IDS（issue #296、入力欄アイコン列の正準の並び）', () => {
  it('17個の操作を正準の並びで持つ', () => {
    expect(COMPOSER_BUTTON_IDS).toEqual([
      'attach',
      'loopToggle',
      'compact',
      'claudeImport',
      'recap',
      'planToggle',
      'fastToggle',
      'review',
      'exportTranscript',
      'workflowMenu',
      'teamWorkflow',
      'workflowView',
      'sessionKanban',
      'forgeHub',
      'openProgress',
      'handoffToNewSession',
      'secondOpinion',
    ]);
  });
});

describe('DEFAULT_COMPOSER_BUTTONS（Issue #900で見直した既定の7つ）', () => {
  it('attach/loopToggle/compact/claudeImportの4つ', () => {
    expect(DEFAULT_COMPOSER_BUTTONS).toEqual([
      'attach',
      'loopToggle',
      'compact',
      'recap',
      'planToggle',
      'handoffToNewSession',
      'secondOpinion',
    ]);
  });
});

describe('isComposerButtonId', () => {
  it('既知のIDはtrue', () => {
    for (const id of COMPOSER_BUTTON_IDS) {
      expect(isComposerButtonId(id)).toBe(true);
    }
  });

  it('未知の文字列・文字列以外はfalse', () => {
    expect(isComposerButtonId('nope')).toBe(false);
    expect(isComposerButtonId(123)).toBe(false);
    expect(isComposerButtonId(undefined)).toBe(false);
    expect(isComposerButtonId(null)).toBe(false);
  });
});

describe('normalizeComposerButtons（設定 agent.chat.composerButtons の検証）', () => {
  it('未設定（undefined）は既定へ落ちる', () => {
    expect(normalizeComposerButtons(undefined)).toEqual({ buttons: DEFAULT_COMPOSER_BUTTONS });
  });

  it('配列でない値は既定へ落ちる', () => {
    expect(normalizeComposerButtons('attach')).toEqual({ buttons: DEFAULT_COMPOSER_BUTTONS });
    expect(normalizeComposerButtons(42)).toEqual({ buttons: DEFAULT_COMPOSER_BUTTONS });
    expect(normalizeComposerButtons({ attach: true })).toEqual({
      buttons: DEFAULT_COMPOSER_BUTTONS,
    });
  });

  it('既知のIDだけの配列はそのまま使う（順序も保持する）', () => {
    const result = normalizeComposerButtons(['review', 'attach']);
    expect(result.buttons).toEqual(['review', 'attach']);
    expect(result.warning).toBeUndefined();
  });

  it('空配列は「全部畳む」有効な指定として受け入れる', () => {
    const result = normalizeComposerButtons([]);
    expect(result.buttons).toEqual([]);
    expect(result.warning).toBeUndefined();
  });

  it('未知のIDを1つでも含む場合は丸ごと既定へ落とし、警告を返す（利用者の設定ミスで入力欄が壊れないこと）', () => {
    const result = normalizeComposerButtons(['attach', 'doesNotExist']);
    expect(result.buttons).toEqual(DEFAULT_COMPOSER_BUTTONS);
    expect(result.warning).toContain('doesNotExist');
    expect(result.warning).toContain('agent.chat.composerButtons');
  });

  it('文字列以外の要素が混じる場合も未知扱いで既定へ落とす', () => {
    const result = normalizeComposerButtons(['attach', 42]);
    expect(result.buttons).toEqual(DEFAULT_COMPOSER_BUTTONS);
    expect(result.warning).toBeDefined();
  });

  it('同じIDが重複する場合も既定へ落とし、警告を返す', () => {
    const result = normalizeComposerButtons(['attach', 'attach']);
    expect(result.buttons).toEqual(DEFAULT_COMPOSER_BUTTONS);
    expect(result.warning).toContain('agent.chat.composerButtons');
  });
});

describe('overflowComposerButtons（「…」メニューへ畳むボタンの算出）', () => {
  it('既定の7つを渡すと、残り10個が正準の並びの順で返る（インポートも到達できる）', () => {
    expect(overflowComposerButtons(DEFAULT_COMPOSER_BUTTONS)).toEqual([
      'claudeImport',
      'fastToggle',
      'review',
      'exportTranscript',
      'workflowMenu',
      'teamWorkflow',
      'workflowView',
      'sessionKanban',
      'forgeHub',
      'openProgress',
    ]);
  });

  it('空配列（表に何も出さない設定）を渡すと17個すべてが返る', () => {
    expect(overflowComposerButtons([])).toEqual(COMPOSER_BUTTON_IDS);
  });

  it('17個すべてを渡すと空配列が返る（どこにも重複しない）', () => {
    expect(overflowComposerButtons(COMPOSER_BUTTON_IDS)).toEqual([]);
  });

  it('表の並びをどう変えても、表に無いボタンは必ずここに現れる', () => {
    const primary = ['workflowMenu', 'review'] as const;
    const overflow = overflowComposerButtons(primary);
    for (const id of COMPOSER_BUTTON_IDS) {
      const inPrimary = primary.includes(id as (typeof primary)[number]);
      const inOverflow = overflow.includes(id);
      // 表と…のどちらか片方には必ずいる（両方には入らない、どちらにもいない、はNG）
      expect(inPrimary !== inOverflow).toBe(true);
    }
  });
});
