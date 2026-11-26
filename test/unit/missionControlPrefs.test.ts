import { describe, expect, it } from 'vitest';
import {
  applyDeleteFilter,
  applySaveFilter,
  MAX_FILTER_NAME_CHARS,
  MAX_SAVED_FILTERS,
  MC_PREF_KEYS,
  normalizeFilterName,
  normalizeFilterSpec,
  parseSetPref,
  readMcPrefs,
  readSavedFilters,
} from '../../src/view/missionControlPrefs';
import type { McPrefKey, McSavedFilter } from '../../src/webview/missionControl/protocol';

const STALL: McPrefKey = 'missionControl.stallMinutes';

describe('readMcPrefs', () => {
  it('型の合う値はそのまま、合わない値は既定へ丸める', () => {
    const values: Partial<Record<McPrefKey, unknown>> = {
      'notifications.turnComplete': true,
      'notifications.sound.enabled': 'yes',
      [STALL]: 30,
    };
    const prefs = readMcPrefs((key) => values[key]);
    expect(prefs['notifications.turnComplete']).toBe(true);
    expect(prefs['notifications.sound.enabled']).toBe(true); // 既定
    expect(prefs['notifications.approvalPending']).toBe(true); // 未設定は既定
    expect(prefs[STALL]).toBe(30);
    expect(Object.keys(prefs).sort()).toEqual([...MC_PREF_KEYS].sort());
  });

  it('stallMinutesは使う側と同じ規則で読む（範囲内なら整数でなくても効いている値を出す）', () => {
    expect(readMcPrefs((key) => (key === STALL ? 2.5 : undefined))[STALL]).toBe(2.5);
    for (const bad of [0, 0.5, 1441, Number.NaN, Number.POSITIVE_INFINITY, '10', null]) {
      expect(readMcPrefs((key) => (key === STALL ? bad : undefined))[STALL]).toBe(5);
    }
  });
});

describe('parseSetPref', () => {
  it('許可リストのキーと、型・範囲の合う値だけを受ける', () => {
    expect(parseSetPref({ type: 'setPref', seq: 1, key: STALL, value: 10 })).toEqual({
      key: STALL,
      value: 10,
    });
    expect(
      parseSetPref({ type: 'setPref', seq: 1, key: 'notifications.turnComplete', value: false }),
    ).toEqual({ key: 'notifications.turnComplete', value: false });
  });

  it('整数でない値・範囲外・型違いを拒む（書くのは整数だけ）', () => {
    for (const value of [2.5, 0, 1441, '10', true]) {
      expect(parseSetPref({ type: 'setPref', seq: 1, key: STALL, value })).toBe(
        '設定の値は1〜1440の整数にしてください',
      );
    }
    expect(
      parseSetPref({ type: 'setPref', seq: 1, key: 'notifications.turnComplete', value: 1 }),
    ).toBe('設定の値が正しくありません');
  });

  it('許可リストに無いキー・__proto__・余分なキーを拒む', () => {
    for (const key of ['notifications.sound.turnCompleteFile', '__proto__', 'constructor', 1]) {
      expect(parseSetPref({ type: 'setPref', seq: 1, key, value: true })).toBe(
        'この設定はMission Controlから変えられません',
      );
    }
    expect(parseSetPref({ type: 'setPref', seq: 1, key: STALL, value: 10, extra: 1 })).toBe(
      '設定の変更の形が正しくありません',
    );
    const polluted = JSON.parse('{"type":"setPref","seq":1,"key":"x","value":1,"__proto__":{}}');
    expect(parseSetPref(polluted as Record<string, unknown>)).toBe(
      '設定の変更の形が正しくありません',
    );
    const inherited = Object.create({ key: STALL }) as Record<string, unknown>;
    inherited.value = 10;
    expect(parseSetPref(inherited)).toBe('設定の変更の形が正しくありません');
  });
});

describe('絞り込みの名前と中身', () => {
  it('名前は1行にして切り、空なら受けない', () => {
    expect(normalizeFilterName('  a\nb\tc  ')).toBe('a b c');
    expect(normalizeFilterName('あ'.repeat(MAX_FILTER_NAME_CHARS + 5))).toBe(
      'あ'.repeat(MAX_FILTER_NAME_CHARS),
    );
    expect(normalizeFilterName(' \n ')).toBeUndefined();
    expect(normalizeFilterName(1)).toBeUndefined();
  });

  it('中身は型を確かめて作り直す', () => {
    expect(
      normalizeFilterSpec({
        provider: 'claude',
        currentWindowOnly: true,
        query: 'a\nb',
        repoKey: '/r',
        activity: 'running',
        extra: 'drop',
      }),
    ).toEqual({
      provider: 'claude',
      currentWindowOnly: true,
      query: 'a b',
      repoKey: '/r',
      activity: 'running',
    });
    const base = { provider: 'all', currentWindowOnly: false, query: '' };
    expect(normalizeFilterSpec(base)).toEqual(base);
    for (const bad of [
      null,
      [],
      'x',
      { ...base, provider: 'other' },
      { ...base, currentWindowOnly: 'no' },
      { ...base, query: 1 },
      { ...base, query: 'x'.repeat(201) },
      { ...base, repoKey: 1 },
      { ...base, repoKey: 'x'.repeat(1001) },
      { ...base, activity: 'sleeping' },
    ]) {
      expect(normalizeFilterSpec(bad)).toBeUndefined();
    }
  });
});

describe('保存した絞り込みの一覧', () => {
  const a: McSavedFilter = {
    name: 'A',
    filter: { provider: 'codex', currentWindowOnly: false, query: '' },
  };
  const b: McSavedFilter = {
    name: 'B',
    filter: { provider: 'claude', currentWindowOnly: false, query: '' },
  };
  const msg = (name: unknown, filter: unknown): Record<string, unknown> => ({
    type: 'saveFilter',
    seq: 1,
    name,
    filter,
  });

  it('読むときに壊れた項目・名前の重複・同じ中身を落とし、上限で切る', () => {
    expect(readSavedFilters('x')).toEqual([]);
    expect(
      readSavedFilters([
        a,
        null,
        { name: '', filter: a.filter },
        { ...b, name: 'A' },
        b,
        {
          name: 'C',
          filter: a.filter,
        },
      ]),
    ).toEqual([a, b]);
    const many = Array.from({ length: MAX_SAVED_FILTERS + 3 }, (_, i) => ({
      name: `F${String(i)}`,
      filter: { provider: 'all', currentWindowOnly: false, query: String(i) },
    }));
    expect(readSavedFilters(many)).toHaveLength(MAX_SAVED_FILTERS);
  });

  it('保存は足すか、同じ名前なら位置を保って差し替える', () => {
    expect(applySaveFilter([a], msg('B', b.filter))).toEqual([a, b]);
    const replaced = { provider: 'all', currentWindowOnly: true, query: 'z' };
    expect(applySaveFilter([a, b], msg('A', replaced))).toEqual([
      { name: 'A', filter: replaced },
      b,
    ]);
  });

  it('同じ中身を別の名前で重ねない・上限・形の違いを拒む', () => {
    expect(applySaveFilter([a], msg('Z', a.filter))).toBe('同じ絞り込みが「A」で保存されています');
    const full = Array.from({ length: MAX_SAVED_FILTERS }, (_, i) => ({
      name: `F${String(i)}`,
      filter: { provider: 'all' as const, currentWindowOnly: false, query: String(i) },
    }));
    expect(applySaveFilter(full, msg('new', b.filter))).toBe(
      `保存できる絞り込みは${String(MAX_SAVED_FILTERS)}件までです`,
    );
    expect(applySaveFilter([], msg(' ', b.filter))).toBe('名前を入れてください');
    expect(applySaveFilter([], msg('B', { provider: 'x' }))).toBe(
      '絞り込みの中身が正しくありません',
    );
    expect(applySaveFilter([], { ...msg('B', b.filter), extra: 1 })).toBe(
      '絞り込みの保存の形が正しくありません',
    );
  });

  it('削除は名前で引き、無ければ拒む', () => {
    expect(applyDeleteFilter([a, b], { type: 'deleteFilter', seq: 1, name: 'A' })).toEqual([b]);
    expect(applyDeleteFilter([a], { type: 'deleteFilter', seq: 1, name: 'Z' })).toBe(
      'その名前の絞り込みはありません',
    );
    expect(applyDeleteFilter([a], { type: 'deleteFilter', seq: 1, name: 'A', x: 1 })).toBe(
      '絞り込みの削除の形が正しくありません',
    );
  });
});
