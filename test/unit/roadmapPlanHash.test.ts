import { describe, expect, it } from 'vitest';
import {
  classifyRoadmapPlanChange,
  computeRoadmapPlanHash,
  computeRoadmapSourceSnapshot,
  describeRoadmapSourceDiff,
  diffRoadmapSource,
  findRoadmapPlanMeta,
  formatRoadmapPlanMeta,
  hashRoadmapChildBody,
  hashRoadmapPlanSectionContent,
  ROADMAP_PLAN_VERSION,
  type RoadmapPlanMeta,
} from '../../src/orchestrator/roadmapPlanHash';
import {
  childTitles,
  findRoadmapPlanSection,
  formatRoadmapPlanSection,
  parseRoadmapPlanSection,
  type RoadmapChild,
} from '../../src/orchestrator/roadmapImport';
import { useCurrentPlanSection } from '../../src/orchestrator/roadmapPlanProposal';
import type { RoadmapPlanNode } from '../../src/orchestrator/roadmapRunState';

const bodies = (entries: [number, string][]): Map<number, string> => new Map(entries);

const NODES: RoadmapPlanNode[] = [
  { issueNumber: 101, dependsOn: [], wave: undefined },
  { issueNumber: 102, dependsOn: [101], wave: undefined },
];

function metaFor(source: Map<number, string>, content: readonly string[]): RoadmapPlanMeta {
  const snapshot = computeRoadmapSourceSnapshot(source);
  return {
    planVersion: ROADMAP_PLAN_VERSION,
    sourceHash: snapshot.sourceHash,
    generatedPlanHash: computeRoadmapPlanHash(content),
    children: snapshot.children,
  };
}

describe('hashRoadmapChildBody', () => {
  it('同じ本文なら同じハッシュ、違えば違うハッシュ', () => {
    expect(hashRoadmapChildBody('a\nb')).toBe(hashRoadmapChildBody('a\nb'));
    expect(hashRoadmapChildBody('a\nb')).not.toBe(hashRoadmapChildBody('a\nc'));
    expect(hashRoadmapChildBody('a')).toMatch(/^[0-9a-f]{12}$/u);
  });

  it('改行コード・行末の空白・前後の空行の違いを無視する', () => {
    expect(hashRoadmapChildBody('\n\na  \r\nb\t\r\n\n')).toBe(hashRoadmapChildBody('a\nb'));
  });
});

describe('computeRoadmapSourceSnapshot', () => {
  it('子の並び順に依らない', () => {
    const a = computeRoadmapSourceSnapshot(
      bodies([
        [101, 'x'],
        [102, 'y'],
      ]),
    );
    const b = computeRoadmapSourceSnapshot(
      bodies([
        [102, 'y'],
        [101, 'x'],
      ]),
    );
    expect(a.sourceHash).toBe(b.sourceHash);
    expect(a.sourceHash).toMatch(/^[0-9a-f]{32}$/u);
  });

  it('子の追加・本文の変更でハッシュが変わる', () => {
    const base = computeRoadmapSourceSnapshot(bodies([[101, 'x']])).sourceHash;
    expect(
      computeRoadmapSourceSnapshot(
        bodies([
          [101, 'x'],
          [102, 'y'],
        ]),
      ).sourceHash,
    ).not.toBe(base);
    expect(computeRoadmapSourceSnapshot(bodies([[101, 'x2']])).sourceHash).not.toBe(base);
  });
});

describe('computeRoadmapPlanHash', () => {
  it('メタデータの行と改行コード・行末の空白を除いて計算する', () => {
    const content = ['## 着手順', '', '- #101 段1 依存: なし'];
    const withMeta = [
      formatRoadmapPlanMeta(metaFor(bodies([[101, 'x']]), content)),
      '## 着手順  ',
      '',
      '- #101 段1 依存: なし',
      '',
    ];
    expect(computeRoadmapPlanHash(withMeta)).toBe(computeRoadmapPlanHash(content));
  });

  it('区画を丸ごとのハッシュはメタデータの行も含む', () => {
    const content = ['- #101 段1 依存: なし'];
    const meta = formatRoadmapPlanMeta(metaFor(bodies([[101, 'x']]), content));
    expect(hashRoadmapPlanSectionContent([meta, ...content])).not.toBe(
      hashRoadmapPlanSectionContent(content),
    );
  });
});

describe('formatRoadmapPlanMeta / findRoadmapPlanMeta', () => {
  it('書いたメタデータを読み戻せる', () => {
    const meta = metaFor(
      bodies([
        [102, 'y'],
        [101, 'x'],
      ]),
      ['- #101 段1 依存: なし'],
    );
    const line = formatRoadmapPlanMeta(meta);
    expect(line).toMatch(/^<!-- roadmap-kanban:plan-meta planVersion=1 sourceHash=/u);
    const found = findRoadmapPlanMeta(['## 着手順', line]);
    expect(found).toEqual({ kind: 'present', meta });
  });

  it('子が0件でも読み戻せる', () => {
    const meta = metaFor(bodies([]), []);
    expect(findRoadmapPlanMeta([formatRoadmapPlanMeta(meta)])).toEqual({ kind: 'present', meta });
  });

  it('メタデータの行が無ければabsent', () => {
    expect(findRoadmapPlanMeta(['## 着手順', '- #101 段1 依存: なし'])).toEqual({
      kind: 'absent',
    });
  });

  it('形式が崩れたメタデータは使わない', () => {
    const meta = metaFor(bodies([[101, 'x']]), []);
    const line = formatRoadmapPlanMeta(meta);
    const cases = [
      [line, line],
      line.replace(' -->', ''),
      line.replace('planVersion=1', 'planVersion=2'),
      line.replace(/sourceHash=[0-9a-f]{32}/u, `sourceHash=${'0'.repeat(32)}`),
      line.replace(/generatedPlanHash=[0-9a-f]{32}/u, 'generatedPlanHash=xyz'),
      line.replace('children=101:', 'children=0:'),
      line.replace(/children=(\S+)/u, 'children=$1,$1'),
      `${line.replace(' -->', '')} extra=1 -->`,
    ];
    for (const content of cases) {
      const found = findRoadmapPlanMeta(Array.isArray(content) ? content : [content]);
      expect(found.kind).toBe('malformed');
    }
  });

  it('子が上限を超えるメタデータは使わない', () => {
    const many = bodies(Array.from({ length: 201 }, (_, i): [number, string] => [i + 1, 'x']));
    const line = formatRoadmapPlanMeta(metaFor(many, []));
    expect(findRoadmapPlanMeta([line]).kind).toBe('malformed');
  });
});

describe('diffRoadmapSource / describeRoadmapSourceDiff', () => {
  it('追加・削除・本文の変更を番号順に返す', () => {
    const before = computeRoadmapSourceSnapshot(
      bodies([
        [103, 'c'],
        [101, 'a'],
        [102, 'b'],
      ]),
    ).children;
    const after = computeRoadmapSourceSnapshot(
      bodies([
        [105, 'e'],
        [101, 'a2'],
        [102, 'b'],
        [104, 'd'],
      ]),
    ).children;
    const diff = diffRoadmapSource(before, after);
    expect(diff).toEqual({ added: [104, 105], removed: [103], bodyChanged: [101] });
    expect(describeRoadmapSourceDiff(diff)).toBe(
      '追加: #104, #105 / 削除: #103 / 本文の変更: #101',
    );
  });

  it('titlesを渡すと追加・本文の変更にタイトルを添える（削除は番号だけ）', () => {
    const diff = { added: [104], removed: [103], bodyChanged: [101] };
    const titles = childTitles([
      { issueNumber: 104, title: '新機能A', checked: false },
      { issueNumber: 101, title: '既存B', checked: true },
    ]);
    expect(describeRoadmapSourceDiff(diff, titles)).toBe(
      '追加: #104（新機能A） / 削除: #103 / 本文の変更: #101（既存B）',
    );
  });
});

describe('classifyRoadmapPlanChange', () => {
  const content = ['- #101 段1 依存: なし', '- #102 段2 依存: #101'];
  const source = bodies([
    [101, 'a'],
    [102, 'b'],
  ]);
  const meta = metaFor(source, content);
  const planHash = computeRoadmapPlanHash(content);
  const editedHash = computeRoadmapPlanHash(['- #102 段1 依存: なし', '- #101 段2 依存: #102']);
  const grown = computeRoadmapSourceSnapshot(
    bodies([
      [101, 'a'],
      [102, 'b'],
      [103, 'c'],
    ]),
  );

  it('どちらも変わらなければunchanged', () => {
    expect(classifyRoadmapPlanChange(meta, computeRoadmapSourceSnapshot(source), planHash)).toEqual(
      { kind: 'unchanged' },
    );
  });

  it('計画だけが変わればmanuallyModified', () => {
    expect(
      classifyRoadmapPlanChange(meta, computeRoadmapSourceSnapshot(source), editedHash),
    ).toEqual({ kind: 'manuallyModified' });
  });

  it('子Issue側だけが変わればsourceChangedで違いを返す', () => {
    expect(classifyRoadmapPlanChange(meta, grown, planHash)).toEqual({
      kind: 'sourceChanged',
      source: { added: [103], removed: [], bodyChanged: [] },
    });
  });

  it('両方が変わればbothChanged', () => {
    expect(classifyRoadmapPlanChange(meta, grown, editedHash)).toEqual({
      kind: 'bothChanged',
      source: { added: [103], removed: [], bodyChanged: [] },
    });
  });
});

describe('formatRoadmapPlanSection', () => {
  it('sourceを渡すと開始の目印の直後にメタデータを入れ、区画のハッシュと一致する', () => {
    const snapshot = computeRoadmapSourceSnapshot(
      bodies([
        [101, 'a'],
        [102, 'b'],
      ]),
    );
    const lines = formatRoadmapPlanSection(NODES, snapshot);
    const section = findRoadmapPlanSection(lines.join('\n'));
    expect(section.kind).toBe('present');
    if (section.kind !== 'present') {
      return;
    }
    const found = findRoadmapPlanMeta(section.content);
    expect(found.kind).toBe('present');
    if (found.kind !== 'present') {
      return;
    }
    expect(section.content[0]).toBe(formatRoadmapPlanMeta(found.meta));
    expect(found.meta.sourceHash).toBe(snapshot.sourceHash);
    expect(found.meta.generatedPlanHash).toBe(computeRoadmapPlanHash(section.content));
    // メタデータの行は計画の行として読まれない
    const parsed = parseRoadmapPlanSection(section.content);
    expect(parsed.errors).toEqual([]);
    expect(parsed.nodes.map((node) => [node.issueNumber, node.dependsOn])).toEqual([
      [101, []],
      [102, [101]],
    ]);
  });

  it('sourceが無ければメタデータを入れない', () => {
    const lines = formatRoadmapPlanSection(NODES);
    expect(findRoadmapPlanMeta(lines)).toEqual({ kind: 'absent' });
  });
});

describe('useCurrentPlanSection', () => {
  const change = {
    kind: 'sourceChanged' as const,
    source: { added: [], removed: [], bodyChanged: [101] },
  };

  it('今の区画が検証に通ればreadyにして知らせを付ける（子のタイトルを添える）', () => {
    const plan = {
      nodes: NODES,
      source: 'existingSection' as const,
      planOrigin: 'generated' as const,
    };
    const children: RoadmapChild[] = [{ issueNumber: 101, title: '既存B', checked: false }];
    const outcome = useCurrentPlanSection({
      kind: 'planDecisionNeeded',
      children,
      duplicates: [],
      change,
      current: { kind: 'valid', plan },
      sectionHash: 'h',
    });
    expect(outcome.kind).toBe('ready');
    if (outcome.kind === 'ready') {
      expect(outcome.plan).toBe(plan);
      expect(outcome.notices?.[0]).toContain('本文の変更: #101（既存B）');
    }
  });

  it('今の区画が検証に通らなければinvalidPlan', () => {
    expect(
      useCurrentPlanSection({
        kind: 'planDecisionNeeded',
        children: [],
        duplicates: [],
        change,
        current: { kind: 'invalid', errors: ['子Issue#103が計画にありません'] },
        sectionHash: 'h',
      }),
    ).toEqual({ kind: 'invalidPlan', errors: ['子Issue#103が計画にありません'] });
  });
});
