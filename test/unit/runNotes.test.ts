import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nodeRunNotesFileSystem } from '../../src/orchestrator/nodeRunNotesFileSystem';
import {
  MAX_LESSON_EVIDENCE_ITEMS,
  MAX_LESSON_EVIDENCE_LENGTH,
  MAX_LESSON_FIELD_LENGTH,
  MAX_LESSONS_STORED,
  RECORD_LESSON_TOOL,
  RUN_NOTES_RELATIVE_PATH,
  RunNotesStore,
  formatLessonsForIntro,
  parseLessonArgs,
  parseRunNotes,
  withLessonReminder,
  type LessonRecord,
  type RunNotesFileSystemPort,
} from '../../src/orchestrator/runNotes';
import type { RemainingRecord } from '../../src/orchestrator/runRemaining';
import { MAX_REMAINING_STORED } from '../../src/orchestrator/runRemaining';

const FIXED_NOW = new Date('2026-10-03T01:02:03.000Z');

function lesson(overrides: Partial<LessonRecord> = {}): LessonRecord {
  return {
    v: 1,
    kind: 'lesson',
    id: 'lesson-1',
    recordedAt: '2026-10-01T00:00:00.000Z',
    runId: 'run-1',
    runKind: 'workflow',
    observation: '観測',
    evidence: ['根拠A'],
    instruction: '指示',
    ...overrides,
  };
}

function remaining(overrides: Partial<RemainingRecord> = {}): RemainingRecord {
  return {
    v: 1,
    kind: 'remaining',
    status: 'open',
    id: 'rem-1',
    recordedAt: '2026-10-01T00:00:00.000Z',
    runId: 'run-1',
    runKind: 'taskRun',
    source: 'unresolved',
    text: '残件の本文',
    ...overrides,
  };
}

function toLines(records: readonly object[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

describe('parseLessonArgs', () => {
  it('正常な引数を検証して前後の空白を落とす', () => {
    const result = parseLessonArgs({
      observation: '  観測  ',
      instruction: ' 指示 ',
      evidence: [' a ', 'b'],
    });
    expect(result).toEqual({
      ok: true,
      value: { observation: '観測', instruction: '指示', evidence: ['a', 'b'] },
    });
  });

  it('evidenceを省略すると空配列になる', () => {
    const result = parseLessonArgs({ observation: 'o', instruction: 'i' });
    expect(result).toEqual({
      ok: true,
      value: { observation: 'o', instruction: 'i', evidence: [] },
    });
  });

  it.each([undefined, null, 'str', 42, ['x']])(
    'オブジェクトでない入力 %j はobservation不正で拒否する',
    (raw) => {
      const result = parseLessonArgs(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain('observation');
      }
    },
  );

  it('observationが空白だけ・非文字列・上限超過なら拒否する', () => {
    expect(parseLessonArgs({ observation: '   ', instruction: 'i' }).ok).toBe(false);
    expect(parseLessonArgs({ observation: 1, instruction: 'i' }).ok).toBe(false);
    expect(
      parseLessonArgs({ observation: 'あ'.repeat(MAX_LESSON_FIELD_LENGTH + 1), instruction: 'i' })
        .ok,
    ).toBe(false);
  });

  it('observationが上限ちょうどなら受理する（コードポイント数で数える）', () => {
    const result = parseLessonArgs({
      observation: '𠮷'.repeat(MAX_LESSON_FIELD_LENGTH),
      instruction: 'i',
    });
    expect(result.ok).toBe(true);
  });

  it('instructionが不正ならinstructionのメッセージで拒否する', () => {
    const result = parseLessonArgs({ observation: 'o', instruction: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('instruction');
    }
  });

  it('evidenceが配列でなければ拒否する', () => {
    const result = parseLessonArgs({ observation: 'o', instruction: 'i', evidence: 'x' });
    expect(result).toEqual({ ok: false, message: 'evidenceは文字列の配列で指定する' });
  });

  it('evidenceが件数上限を超えると拒否する', () => {
    const evidence = Array.from({ length: MAX_LESSON_EVIDENCE_ITEMS + 1 }, () => 'e');
    const result = parseLessonArgs({ observation: 'o', instruction: 'i', evidence });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain(String(MAX_LESSON_EVIDENCE_ITEMS));
    }
  });

  it('evidenceの要素が空・非文字列・上限超過なら拒否する', () => {
    for (const bad of ['', 3, 'x'.repeat(MAX_LESSON_EVIDENCE_LENGTH + 1)]) {
      const result = parseLessonArgs({ observation: 'o', instruction: 'i', evidence: ['ok', bad] });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain('evidenceの各要素');
      }
    }
  });
});

describe('RECORD_LESSON_TOOL', () => {
  it('必須項目とevidenceの件数上限をスキーマに持つ', () => {
    expect(RECORD_LESSON_TOOL.name).toBe('record_lesson');
    expect(RECORD_LESSON_TOOL.inputSchema).toMatchObject({
      required: ['observation', 'instruction'],
      properties: { evidence: { maxItems: MAX_LESSON_EVIDENCE_ITEMS } },
    });
  });
});

describe('parseRunNotes', () => {
  it('教訓と残件を記録順に読み、空行・壊れた行・未知のkind・版違いは読み飛ばす', () => {
    const text = [
      JSON.stringify(lesson({ id: 'a' })),
      '',
      '   ',
      '{ 壊れたJSON',
      JSON.stringify({ ...lesson({ id: 'b' }), v: 2 }),
      JSON.stringify({ ...lesson({ id: 'c' }), kind: 'unknown' }),
      JSON.stringify(remaining({ id: 'r' })),
      'null',
      '42',
      JSON.stringify(lesson({ id: 'd' })),
    ].join('\n');
    expect(parseRunNotes(text).map((r) => r.id)).toEqual(['a', 'r', 'd']);
  });

  it('必須フィールドの型が違う教訓は読み飛ばす', () => {
    const bad = [
      { ...lesson(), id: 1 },
      { ...lesson(), runKind: 'other' },
      { ...lesson(), evidence: 'x' },
      { ...lesson(), evidence: [1] },
      { ...lesson(), observation: null },
    ];
    expect(parseRunNotes(toLines(bad))).toEqual([]);
  });

  it('過去に記録されたroadmapRunのkindも読める', () => {
    const records = parseRunNotes(toLines([lesson({ runKind: 'roadmapRun' })]));
    expect(records).toHaveLength(1);
  });

  it('空文字は空配列になる', () => {
    expect(parseRunNotes('')).toEqual([]);
  });
});

describe('formatLessonsForIntro', () => {
  it('空配列は空文字を返す', () => {
    expect(formatLessonsForIntro([])).toBe('');
  });

  it('1行へ均して日付・種別・runIdと各項目を並べ、nonceで囲う', () => {
    const text = formatLessonsForIntro(
      [lesson({ observation: '1行目\n2行目', evidence: ['e1', 'e2'], instruction: '指示' })],
      'NONCE',
    );
    expect(text).toContain('過去のrunの教訓（新しい順');
    expect(text).toContain('[NONCE] runNotes.lessons');
    expect(text).toContain(
      '- [2026-10-01 workflow run-1] 事実: 1行目 2行目 / 根拠: e1; e2 / 次への指示: 指示',
    );
    expect(text).not.toContain('ほか');
  });

  it('nonce省略時は毎回ランダムなnonceを使う', () => {
    const a = formatLessonsForIntro([lesson()]);
    const b = formatLessonsForIntro([lesson()]);
    expect(a).not.toBe(b);
  });

  it('件数上限（20件）を超える分は末尾から落として省略件数を書く', () => {
    const lessons = Array.from({ length: 25 }, (_, i) =>
      lesson({ id: `l${String(i)}`, runId: `run-${String(i)}` }),
    );
    const text = formatLessonsForIntro(lessons, 'N');
    expect(text).toContain('run-19]');
    expect(text).not.toContain('run-20]');
    expect(text).toContain('- ほか5件は省略');
  });

  it('文字数上限（4000字）を超える分は行単位で古い方から落とす', () => {
    const long = 'あ'.repeat(MAX_LESSON_FIELD_LENGTH);
    const lessons = Array.from({ length: 10 }, (_, i) =>
      lesson({
        id: `l${String(i)}`,
        runId: `run-${String(i)}`,
        observation: long,
        instruction: long,
      }),
    );
    const text = formatLessonsForIntro(lessons, 'N');
    expect(text).toContain('run-0]');
    expect(text).not.toContain('run-9]');
    expect(text).toMatch(/- ほか\d+件は省略/);
  });
});

describe('withLessonReminder', () => {
  it('runFinishedで有効なら本文へ教訓の案内を足す（元のイベントは変えない）', () => {
    const event = { kind: 'runFinished', body: '完了' };
    const result = withLessonReminder(event, true);
    expect(result.body).toBe('完了。次のrunへ残す教訓があればrecord_lessonで記録する。');
    expect(event.body).toBe('完了');
  });

  it('無効なら同じイベントをそのまま返す', () => {
    const event = { kind: 'runFinished', body: '完了' };
    expect(withLessonReminder(event, false)).toBe(event);
  });

  it('runFinished以外は同じイベントをそのまま返す', () => {
    const event = { kind: 'taskDone', body: '完了' };
    expect(withLessonReminder(event, true)).toBe(event);
  });
});

describe('RunNotesStore（実ファイル）', () => {
  let root: string;
  let warnings: string[];
  let store: RunNotesStore;
  const notesFile = (): string => path.join(root, RUN_NOTES_RELATIVE_PATH);
  const readFile = (): string => fs.readFileSync(notesFile(), 'utf8');
  const input = (over: Record<string, unknown> = {}) => ({
    runId: 'run-1',
    runKind: 'taskRun' as const,
    observation: '観測',
    evidence: ['根拠'],
    instruction: '指示',
    ...over,
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_NOW);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-notes-test-'));
    warnings = [];
    store = new RunNotesStore(nodeRunNotesFileSystem, { warn: (m) => warnings.push(m) });
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('recordLesson / listLessons', () => {
    it('教訓を追記し、新しい順で一覧できる（時刻は注入した時計）', async () => {
      expect(await store.recordLesson(root, input({ observation: '一件目' }))).toEqual({
        ok: true,
      });
      vi.setSystemTime(new Date('2026-10-04T00:00:00.000Z'));
      expect(await store.recordLesson(root, input({ observation: '二件目' }))).toEqual({
        ok: true,
      });

      const lessons = await store.listLessons(root);
      expect(lessons.map((l) => l.observation)).toEqual(['二件目', '一件目']);
      expect(lessons[1]?.recordedAt).toBe('2026-10-03T01:02:03.000Z');
      expect(lessons[0]?.recordedAt).toBe('2026-10-04T00:00:00.000Z');
      expect(readFile().endsWith('\n')).toBe(true);
    });

    it('記録が無ければ空配列でログも出さない', async () => {
      expect(await store.listLessons(root)).toEqual([]);
      expect(warnings).toEqual([]);
    });

    it('秘密・制御文字を落とし、上限で切り詰め、evidenceは件数を絞って保存する', async () => {
      const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
      const result = await store.recordLesson(
        root,
        input({
          observation: `token=${token}\u0007\n次の行`,
          instruction: 'あ'.repeat(MAX_LESSON_FIELD_LENGTH + 100),
          evidence: Array.from(
            { length: MAX_LESSON_EVIDENCE_ITEMS + 2 },
            (_, i) => `e${String(i)}`,
          ),
          runId: 'r'.repeat(300),
        }),
      );
      expect(result.ok).toBe(true);
      const [saved] = await store.listLessons(root);
      expect(saved?.observation).not.toContain(token);
      expect(saved?.observation).not.toContain('\u0007');
      expect(saved?.observation).toContain('\n次の行');
      expect([...(saved?.instruction ?? '')].length).toBeLessThanOrEqual(MAX_LESSON_FIELD_LENGTH);
      expect(saved?.evidence).toHaveLength(MAX_LESSON_EVIDENCE_ITEMS);
      expect([...(saved?.runId ?? '')].length).toBeLessThanOrEqual(200);
    });

    it('件数上限を超えると古い教訓から落として書き直し、残件は残す', async () => {
      const existing = [
        remaining({ id: 'keep-rem' }),
        ...Array.from({ length: MAX_LESSONS_STORED }, (_, i) =>
          lesson({ id: `old-${String(i)}`, observation: `古い${String(i)}` }),
        ),
      ];
      fs.mkdirSync(path.dirname(notesFile()), { recursive: true });
      fs.writeFileSync(notesFile(), toLines(existing));

      const result = await store.recordLesson(root, input({ observation: '最新' }));
      expect(result.ok).toBe(true);
      const records = parseRunNotes(readFile());
      const lessons = records.filter((r) => r.kind === 'lesson');
      expect(lessons).toHaveLength(MAX_LESSONS_STORED);
      expect(lessons.some((l) => l.id === 'old-0')).toBe(false);
      expect(lessons.some((l) => l.id === 'old-1')).toBe(true);
      expect(records.some((r) => r.id === 'keep-rem')).toBe(true);
      expect(lessons[lessons.length - 1]).toMatchObject({ observation: '最新' });
    });

    it('壊れた行を含む既存ファイルでも追記でき、読み取りでは壊れた行を飛ばす', async () => {
      fs.mkdirSync(path.dirname(notesFile()), { recursive: true });
      fs.writeFileSync(notesFile(), `${JSON.stringify(lesson({ id: 'ok' }))}\n壊れた行\n`);
      await store.recordLesson(root, input());
      const lessons = await store.listLessons(root);
      expect(lessons).toHaveLength(2);
    });

    it('変更を購読でき、解除後は通知されない', async () => {
      const listener = vi.fn();
      const off = store.onDidChange(listener);
      await store.recordLesson(root, input());
      expect(listener).toHaveBeenCalledTimes(1);
      off();
      await store.recordLesson(root, input());
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('deleteLesson', () => {
    it('指定IDの教訓だけを消し、他の教訓と残件は残す', async () => {
      fs.mkdirSync(path.dirname(notesFile()), { recursive: true });
      fs.writeFileSync(
        notesFile(),
        toLines([lesson({ id: 'a' }), remaining({ id: 'a-rem' }), lesson({ id: 'b' })]),
      );
      const listener = vi.fn();
      store.onDidChange(listener);

      expect(await store.deleteLesson(root, 'a')).toEqual({ ok: true });
      expect(parseRunNotes(readFile()).map((r) => r.id)).toEqual(['a-rem', 'b']);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('残件のIDを指定しても消さずに見つからないと返す', async () => {
      fs.mkdirSync(path.dirname(notesFile()), { recursive: true });
      fs.writeFileSync(notesFile(), toLines([remaining({ id: 'r1' })]));
      const result = await store.deleteLesson(root, 'r1');
      expect(result).toEqual({ ok: false, message: '指定の教訓は見つかりませんでした。' });
      expect(parseRunNotes(readFile())).toHaveLength(1);
    });

    it('ファイルが無ければ見つからないと返す', async () => {
      expect(await store.deleteLesson(root, 'x')).toEqual({
        ok: false,
        message: '指定の教訓は見つかりませんでした。',
      });
    });

    it('最後の1件を消すとファイルは空になる', async () => {
      await store.recordLesson(root, input());
      const [only] = await store.listLessons(root);
      expect(await store.deleteLesson(root, only?.id ?? '')).toEqual({ ok: true });
      expect(readFile()).toBe('');
    });
  });

  describe('recordRemaining / listRemaining / markRemainingDone', () => {
    const remInput = (over: Record<string, unknown> = {}) => ({
      runId: 'run-1',
      runKind: 'taskRun' as const,
      source: 'unresolved' as const,
      text: '残件',
      ...over,
    });

    it('本文が空の入力だけなら何も書かずok', async () => {
      expect(await store.recordRemaining(root, [remInput({ text: '   ' })])).toEqual({ ok: true });
      expect(fs.existsSync(notesFile())).toBe(false);
      expect(await store.recordRemaining(root, [])).toEqual({ ok: true });
    });

    it('複数件をまとめて追記し、新しい順で一覧する。通知は1回', async () => {
      const listener = vi.fn();
      store.onDidChange(listener);
      const result = await store.recordRemaining(root, [
        remInput({
          text: '一件目',
          source: 'issue',
          url: 'https://example.com/o/r/issues/12',
          issueNumber: 12,
        }),
        remInput({ text: '二件目', taskId: 'T1' }),
      ]);
      expect(result).toEqual({ ok: true });
      expect(listener).toHaveBeenCalledTimes(1);
      const list = await store.listRemaining(root);
      expect(list.map((r) => r.text)).toEqual(['二件目', '一件目']);
      expect(list[1]).toMatchObject({
        source: 'issue',
        issueNumber: 12,
        onRoadmap: false,
        status: 'open',
      });
      expect(list[0]).toMatchObject({ taskId: 'T1', recordedAt: '2026-10-03T01:02:03.000Z' });
    });

    it('残件の件数上限を超えると古い済から落とし、教訓には触れない', async () => {
      const existing = [
        lesson({ id: 'les' }),
        remaining({ id: 'done-0', status: 'done', doneAt: '2026-10-02T00:00:00.000Z' }),
        ...Array.from({ length: MAX_REMAINING_STORED - 1 }, (_, i) =>
          remaining({ id: `open-${String(i)}` }),
        ),
      ];
      fs.mkdirSync(path.dirname(notesFile()), { recursive: true });
      fs.writeFileSync(notesFile(), toLines(existing));

      expect(await store.recordRemaining(root, [remInput({ text: '新規' })])).toEqual({ ok: true });
      const records = parseRunNotes(readFile());
      const rems = records.filter((r) => r.kind === 'remaining');
      expect(rems).toHaveLength(MAX_REMAINING_STORED);
      expect(rems.some((r) => r.id === 'done-0')).toBe(false);
      expect(rems.some((r) => r.id === 'open-0')).toBe(true);
      expect(records.some((r) => r.id === 'les')).toBe(true);
    });

    it('markRemainingDoneで未処理の残件を済にし、時刻を記録する', async () => {
      await store.recordRemaining(root, [remInput()]);
      const [rem] = await store.listRemaining(root);
      vi.setSystemTime(new Date('2026-10-05T00:00:00.000Z'));
      expect(await store.markRemainingDone(root, rem?.id ?? '')).toEqual({
        ok: true,
        changed: true,
      });
      const [after] = await store.listRemaining(root);
      expect(after).toMatchObject({ status: 'done', doneAt: '2026-10-05T00:00:00.000Z' });
    });

    it('済の残件・存在しないIDは見つからないと返し、書き直さない', async () => {
      fs.mkdirSync(path.dirname(notesFile()), { recursive: true });
      fs.writeFileSync(
        notesFile(),
        toLines([remaining({ id: 'd', status: 'done', doneAt: '2026-10-02T00:00:00.000Z' })]),
      );
      const before = readFile();
      const expected = { ok: false, message: '指定の未処理の残件は見つかりませんでした。' };
      expect(await store.markRemainingDone(root, 'd')).toEqual(expected);
      expect(await store.markRemainingDone(root, 'none')).toEqual(expected);
      expect(readFile()).toBe(before);
    });

    it('markIssuesOnRoadmapはチェックリストに載った未掲載issue残件だけを掲載済みにする', async () => {
      await store.recordRemaining(root, [
        remInput({ source: 'issue', issueNumber: 11, text: 'a' }),
        remInput({ source: 'issue', issueNumber: 22, text: 'b' }),
        remInput({ source: 'issue', text: '番号なし' }),
        remInput({ source: 'unresolved', text: 'issueでない' }),
      ]);
      const body = '- [ ] #11: タイトル\n関連: #22\n';
      expect(await store.markIssuesOnRoadmap(root, body)).toEqual({ ok: true, changed: true });
      const list = await store.listRemaining(root);
      const byText = new Map(list.map((r) => [r.text, r]));
      expect(byText.get('a')?.onRoadmap).toBe(true);
      expect(byText.get('b')?.onRoadmap).toBe(false);
      expect(byText.get('番号なし')?.onRoadmap).toBe(false);
      expect(byText.get('issueでない')?.onRoadmap).toBeUndefined();

      const before = readFile();
      expect(await store.markIssuesOnRoadmap(root, body)).toEqual({ ok: true, changed: false });
      expect(readFile()).toBe(before);
    });

    it('markIssuesOnRoadmapは本文に番号が無ければ何も読まずok', async () => {
      expect(await store.markIssuesOnRoadmap(root, 'チェックリスト無し #5')).toEqual({ ok: true });
    });
  });

  describe('readIntroBlock', () => {
    it('記録が無ければ空文字', async () => {
      expect(await store.readIntroBlock(root)).toBe('');
    });

    it('教訓と未処理の残件を空行区切りで返し、済の残件は含めない', async () => {
      fs.mkdirSync(path.dirname(notesFile()), { recursive: true });
      fs.writeFileSync(
        notesFile(),
        toLines([
          lesson({ observation: '教訓の観測' }),
          remaining({ id: 'o', text: '未処理の残件' }),
          remaining({ id: 'd', status: 'done', text: '済の残件' }),
        ]),
      );
      const block = await store.readIntroBlock(root);
      expect(block).toContain('教訓の観測');
      expect(block).toContain('未処理の残件');
      expect(block).not.toContain('済の残件');
      expect(block).toContain('\n\n');
    });

    it('教訓だけでも返す', async () => {
      fs.mkdirSync(path.dirname(notesFile()), { recursive: true });
      fs.writeFileSync(notesFile(), toLines([lesson({ observation: '教訓だけ' })]));
      const block = await store.readIntroBlock(root);
      expect(block).toContain('教訓だけ');
      expect(block).not.toContain('\n\n');
    });
  });

  describe('シンボリックリンクの防御', () => {
    let outside: string;

    beforeEach(() => {
      outside = fs.mkdtempSync(path.join(os.tmpdir(), 'run-notes-outside-'));
      fs.symlinkSync(outside, path.join(root, '.agents'));
    });

    afterEach(() => {
      fs.rmSync(outside, { recursive: true, force: true });
    });

    it('書き込み系・読み取り系のどれもリンク先へ触れず失敗を返す', async () => {
      expect(await store.recordLesson(root, input())).toEqual({
        ok: false,
        message: '教訓を書き込めませんでした（経路が不正です）。',
      });
      expect(await store.deleteLesson(root, 'x')).toEqual({
        ok: false,
        message: '教訓を削除できませんでした（経路が不正です）。',
      });
      expect(
        await store.recordRemaining(root, [
          { runId: 'r', runKind: 'taskRun', source: 'unresolved', text: 't' },
        ]),
      ).toEqual({
        ok: false,
        message: '残件を書き込めませんでした（経路が不正です）。',
      });
      expect(await store.markRemainingDone(root, 'x')).toEqual({
        ok: false,
        message: '残件を済にできませんでした（経路が不正です）。',
      });
      expect(await store.listLessons(root)).toEqual([]);
      expect(await store.listRemaining(root)).toEqual([]);
      expect(await store.readIntroBlock(root)).toBe('');
      expect(fs.readdirSync(outside)).toEqual([]);
      expect(warnings.length).toBeGreaterThanOrEqual(7);
      expect(warnings.every((w) => w.startsWith('[runNotes] '))).toBe(true);
    });
  });
});

describe('RunNotesStore（失敗の注入）', () => {
  const ROOT = '/virtual/root';
  let warnings: string[];

  function makeStore(overrides: Partial<RunNotesFileSystemPort>): RunNotesStore {
    const port: RunNotesFileSystemPort = {
      isSymbolicLink: () => Promise.resolve(false),
      makeDirectory: () => Promise.resolve(true),
      appendLine: () => Promise.resolve(true),
      readTextFile: () => Promise.resolve({ kind: 'missing' }),
      replaceTextFile: () => Promise.resolve(true),
      ...overrides,
    };
    return new RunNotesStore(port, { warn: (m) => warnings.push(m) }, () => FIXED_NOW);
  }

  const lessonInput = {
    runId: 'run-1',
    runKind: 'workflow' as const,
    observation: '観測',
    evidence: [],
    instruction: '指示',
  };
  const remInput = {
    runId: 'r',
    runKind: 'taskRun' as const,
    source: 'unresolved' as const,
    text: 't',
  };

  beforeEach(() => {
    warnings = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ログ口が無くても失敗を返せる（例外にならない）', async () => {
    const store = new RunNotesStore({
      isSymbolicLink: () => Promise.resolve(false),
      makeDirectory: () => Promise.resolve(false),
      appendLine: () => Promise.resolve(true),
      readTextFile: () => Promise.resolve({ kind: 'missing' }),
      replaceTextFile: () => Promise.resolve(true),
    });
    expect((await store.recordLesson(ROOT, lessonInput)).ok).toBe(false);
  });

  it('ログへは秘密を伏せて出す', async () => {
    const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
    const store = makeStore({
      readTextFile: () => Promise.reject(new Error(`boom ${token}`)),
    });
    await store.listLessons(ROOT);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain(token);
  });

  describe('recordLesson', () => {
    it('ディレクトリを作れなければ失敗を返す', async () => {
      const store = makeStore({ makeDirectory: () => Promise.resolve(false) });
      expect(await store.recordLesson(ROOT, lessonInput)).toEqual({
        ok: false,
        message: '教訓を書き込めませんでした。',
      });
      expect(warnings[0]).toContain('ディレクトリ');
    });

    it('追記に失敗したら失敗を返し、通知しない', async () => {
      const store = makeStore({ appendLine: () => Promise.resolve(false) });
      const listener = vi.fn();
      store.onDidChange(listener);
      expect((await store.recordLesson(ROOT, lessonInput)).ok).toBe(false);
      expect(listener).not.toHaveBeenCalled();
      expect(warnings[0]).toContain('追記できませんでした');
    });

    it('上限整理の書き直しに失敗したら失敗を返す', async () => {
      const text = toLines(
        Array.from({ length: MAX_LESSONS_STORED }, (_, i) => lesson({ id: `l${String(i)}` })),
      );
      const store = makeStore({
        readTextFile: () => Promise.resolve({ kind: 'ok', text }),
        replaceTextFile: () => Promise.resolve(false),
      });
      expect((await store.recordLesson(ROOT, lessonInput)).ok).toBe(false);
      expect(warnings[0]).toContain('書き直せませんでした');
    });

    it('既存を読めないときは上限整理を飛ばして追記だけ行う', async () => {
      const appendLine = vi.fn(() => Promise.resolve(true));
      const replaceTextFile = vi.fn(() => Promise.resolve(true));
      const store = makeStore({
        readTextFile: () => Promise.resolve({ kind: 'error', message: 'EACCES' }),
        appendLine,
        replaceTextFile,
      });
      expect(await store.recordLesson(ROOT, lessonInput)).toEqual({ ok: true });
      expect(appendLine).toHaveBeenCalledTimes(1);
      expect(replaceTextFile).not.toHaveBeenCalled();
      expect(warnings[0]).toContain('EACCES');
    });

    it('予期しない例外（Errorと非Error）は失敗へ畳む', async () => {
      const errStore = makeStore({ makeDirectory: () => Promise.reject(new Error('kaboom')) });
      expect((await errStore.recordLesson(ROOT, lessonInput)).ok).toBe(false);
      expect(warnings[0]).toContain('kaboom');
      const nonError = makeStore({ makeDirectory: () => Promise.reject('文字列の例外') });
      expect((await nonError.recordLesson(ROOT, lessonInput)).ok).toBe(false);
      expect(warnings.at(-1)).toContain('文字列の例外');
    });
  });

  describe('deleteLesson', () => {
    const existingText = toLines([lesson({ id: 'a' })]);

    it('読めないときは読み取り失敗として返す（見つからないとは区別する）', async () => {
      const store = makeStore({
        readTextFile: () => Promise.resolve({ kind: 'error', message: 'EIO' }),
      });
      expect(await store.deleteLesson(ROOT, 'a')).toEqual({
        ok: false,
        message: '教訓を削除できませんでした（記録を読めませんでした）。',
      });
    });

    it('書き直しに失敗したら失敗を返す', async () => {
      const store = makeStore({
        readTextFile: () => Promise.resolve({ kind: 'ok', text: existingText }),
        replaceTextFile: () => Promise.resolve(false),
      });
      expect(await store.deleteLesson(ROOT, 'a')).toEqual({
        ok: false,
        message: '教訓を削除できませんでした。',
      });
    });

    it('予期しない例外は失敗へ畳む', async () => {
      const store = makeStore({ readTextFile: () => Promise.reject(new Error('boom')) });
      expect((await store.deleteLesson(ROOT, 'a')).ok).toBe(false);
      expect(warnings[0]).toContain('boom');
    });
  });

  describe('recordRemaining', () => {
    it('組み立ての例外は失敗へ畳む', async () => {
      const store = makeStore({});
      const bad = {
        get text(): string {
          throw new Error('getter');
        },
        runId: 'r',
        runKind: 'taskRun',
        source: 'unresolved',
      } as never;
      expect(await store.recordRemaining(ROOT, [bad])).toEqual({
        ok: false,
        message: '残件を書き込めませんでした。',
      });
      expect(warnings[0]).toContain('getter');
    });

    it('ディレクトリを作れなければ失敗を返す', async () => {
      const store = makeStore({ makeDirectory: () => Promise.resolve(false) });
      expect((await store.recordRemaining(ROOT, [remInput])).ok).toBe(false);
    });

    it('追記・書き直しの失敗を失敗として返す', async () => {
      const appendFail = makeStore({ appendLine: () => Promise.resolve(false) });
      expect((await appendFail.recordRemaining(ROOT, [remInput])).ok).toBe(false);
      const text = toLines(
        Array.from({ length: MAX_REMAINING_STORED }, (_, i) => remaining({ id: `r${String(i)}` })),
      );
      const replaceFail = makeStore({
        readTextFile: () => Promise.resolve({ kind: 'ok', text }),
        replaceTextFile: () => Promise.resolve(false),
      });
      expect((await replaceFail.recordRemaining(ROOT, [remInput])).ok).toBe(false);
    });

    it('既存を読めないときは追記だけ行う', async () => {
      const appendLine = vi.fn(() => Promise.resolve(true));
      const store = makeStore({
        readTextFile: () => Promise.resolve({ kind: 'error', message: 'EACCES' }),
        appendLine,
      });
      expect(await store.recordRemaining(ROOT, [remInput])).toEqual({ ok: true });
      expect(appendLine).toHaveBeenCalledTimes(1);
    });

    it('予期しない例外は失敗へ畳む', async () => {
      const store = makeStore({ makeDirectory: () => Promise.reject(new Error('boom')) });
      expect((await store.recordRemaining(ROOT, [remInput])).ok).toBe(false);
      expect(warnings.at(-1)).toContain('boom');
    });
  });

  describe('markRemainingDone / markIssuesOnRoadmap', () => {
    const text = toLines([remaining({ id: 'r1' })]);

    it('読めないときは読み取り失敗として返す', async () => {
      const store = makeStore({
        readTextFile: () => Promise.resolve({ kind: 'error', message: 'EIO' }),
      });
      expect(await store.markRemainingDone(ROOT, 'r1')).toEqual({
        ok: false,
        message: '残件を済にできませんでした（記録を読めませんでした）。',
      });
    });

    it('書き直しに失敗したら失敗を返す', async () => {
      const store = makeStore({
        readTextFile: () => Promise.resolve({ kind: 'ok', text }),
        replaceTextFile: () => Promise.resolve(false),
      });
      expect(await store.markRemainingDone(ROOT, 'r1')).toEqual({
        ok: false,
        message: '残件を済にできませんでした。',
      });
    });

    it('予期しない例外は失敗へ畳む', async () => {
      const store = makeStore({ readTextFile: () => Promise.reject(new Error('boom')) });
      expect(await store.markIssuesOnRoadmap(ROOT, '- [ ] #1: x')).toEqual({
        ok: false,
        message: '残件のロードマップ掲載を記録できませんでした。',
      });
    });

    it('ファイルが無ければ変更なしでokを返す', async () => {
      const store = makeStore({});
      expect(await store.markIssuesOnRoadmap(ROOT, '- [ ] #1: x')).toEqual({
        ok: true,
        changed: false,
      });
    });
  });

  describe('読み込みの失敗と待ち上限', () => {
    it('読めないときは空配列を返しログへ残す', async () => {
      const store = makeStore({
        readTextFile: () => Promise.resolve({ kind: 'error', message: 'EACCES' }),
      });
      expect(await store.listLessons(ROOT)).toEqual([]);
      expect(warnings[0]).toContain('教訓一覧を読めませんでした: EACCES');
    });

    it('読み込みが5秒以内に終わらなければ空配列で見切る', async () => {
      vi.useFakeTimers();
      const store = makeStore({ readTextFile: () => new Promise(() => undefined) });
      const pending = store.listRemaining(ROOT);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await pending).toEqual([]);
      expect(
        warnings.some((w) => w.includes('残件一覧の読み込みが5秒以内に終わりませんでした')),
      ).toBe(true);
    });

    it('時間内に読めたらタイマーを残さない', async () => {
      vi.useFakeTimers();
      const store = makeStore({
        readTextFile: () => Promise.resolve({ kind: 'ok', text: toLines([lesson()]) }),
      });
      expect(await store.listLessons(ROOT)).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('書き込みは直列化される（先の読み込みが終わるまで次は始まらない）', async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const store = makeStore({
      appendLine: async () => {
        if (first) {
          first = false;
          order.push('1:start');
          await gate;
          order.push('1:end');
        } else {
          order.push('2');
        }
        return true;
      },
    });
    const p1 = store.recordLesson(ROOT, lessonInput);
    const p2 = store.recordLesson(ROOT, lessonInput);
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(['1:start']);
    release();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['1:start', '1:end', '2']);
  });
});
