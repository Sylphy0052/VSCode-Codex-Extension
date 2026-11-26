import { describe, expect, it } from 'vitest';
import type { RoadmapRunForgePorts } from '../../src/orchestrator/roadmapRunForge';
import {
  findProtectedTouches,
  parseProtectedPaths,
  SELF_IMPROVE_LABEL,
  selfImproveMergeDenial,
} from '../../src/orchestrator/selfImproveGuard';
import { checkSelfImproveMerge } from '../../src/orchestrator/selfImproveMergeCheck';

describe('selfImproveGuard', () => {
  it('parseProtectedPaths: 空行・コメントを除き、前後の空白とCRLFを落とす', () => {
    expect(parseProtectedPaths('# c\r\n\r\n  src/a.ts  \r\nsrc/b/\n')).toEqual([
      'src/a.ts',
      'src/b/',
    ]);
  });

  it('findProtectedTouches: *は/を越えず、**は越え、末尾/は配下すべて、正規表現記号はリテラル', () => {
    const files = ['src/a.ts', 'src/x/a.ts', 'src/x/y/a.ts', 'srcXa.ts', 'src/a+b.ts', 'doc/a.ts'];
    expect(findProtectedTouches(files, ['src/*.ts'])).toEqual(['src/a.ts', 'src/a+b.ts']);
    expect(findProtectedTouches(files, ['src/**/a.ts'])).toEqual(['src/x/a.ts', 'src/x/y/a.ts']);
    expect(findProtectedTouches(files, ['src/x/'])).toEqual(['src/x/a.ts', 'src/x/y/a.ts']);
    expect(findProtectedTouches(files, ['src/a+b.ts'])).toEqual(['src/a+b.ts']);
    expect(findProtectedTouches(files, ['src.a.ts'])).toEqual([]);
    expect(findProtectedTouches(files, [])).toEqual([]);
  });

  it('selfImproveMergeDenial: ラベルが無ければ保護パスに触れても許す', () => {
    expect(selfImproveMergeDenial(['bug'], ['src/a.ts'], ['src/a.ts'])).toBeUndefined();
  });

  it('selfImproveMergeDenial: ラベルがあっても触れていなければ許す', () => {
    expect(selfImproveMergeDenial([SELF_IMPROVE_LABEL], ['x.ts'], ['src/a.ts'])).toBeUndefined();
  });

  it('selfImproveMergeDenial: 触れていれば拒否し、10件超は「ほか」を付ける', () => {
    const few = selfImproveMergeDenial([SELF_IMPROVE_LABEL], ['src/a.ts'], ['src/a.ts']);
    expect(few).toContain('src/a.ts');
    expect(few).not.toContain('ほか');
    const files = Array.from({ length: 11 }, (_, i) => `g/${String(i)}.ts`);
    const many = selfImproveMergeDenial([SELF_IMPROVE_LABEL], files, ['g/']);
    expect(many).toContain('ほか');
    expect(many).not.toContain('g/10.ts');
  });
});

type Res = { code: number; stdout: string; stderr: string };
const ok = (stdout: string): Res => ({ code: 0, stdout, stderr: '' });
const ng: Res = { code: 1, stdout: '', stderr: 'err' };

function makePorts(opts: {
  remote?: Res;
  view?: Res;
  files?: Res;
  list?: Res;
}): RoadmapRunForgePorts {
  return {
    git: {
      run: (args: readonly string[]) =>
        Promise.resolve(
          args[0] === 'remote'
            ? (opts.remote ?? ok('git@github.com:o/r.git\n'))
            : (opts.list ?? ok('src/a.ts\n')),
        ),
    },
    cli: {
      run: (_c: string, args: readonly string[]) =>
        Promise.resolve(
          args[0] === 'pr' ? (opts.view ?? ok('{"labels":[]}')) : (opts.files ?? ok('')),
        ),
    },
  } as unknown as RoadmapRunForgePorts;
}

const labelsJson = (...names: string[]): string =>
  JSON.stringify({ labels: names.map((name) => ({ name })) });

describe('checkSelfImproveMerge', () => {
  it('GitHub以外・判定不能は対象外', async () => {
    expect(
      await checkSelfImproveMerge(makePorts({ remote: ok('git@gitlab.com:o/r.git') }), '/r', 1),
    ).toBeUndefined();
    expect(await checkSelfImproveMerge(makePorts({ remote: ng }), '/r', 1)).toBeUndefined();
  });

  it('ラベル取得失敗・解釈不能は拒否', async () => {
    expect(await checkSelfImproveMerge(makePorts({ view: ng }), '/r', 5)).toContain('取得できず');
    for (const bad of ['not json', '{}', 'null']) {
      expect(await checkSelfImproveMerge(makePorts({ view: ok(bad) }), '/r', 5)).toContain(
        '解釈できず',
      );
    }
  });

  it('ラベルが無い: 通常は許可、selfImproveRunは拒否。名前が文字列でないラベルは無視', async () => {
    const view = ok(JSON.stringify({ labels: [{ name: 1 }, null, { name: 'bug' }] }));
    expect(await checkSelfImproveMerge(makePorts({ view }), '/r', 5)).toBeUndefined();
    expect(
      await checkSelfImproveMerge(makePorts({ view }), '/r', 5, { selfImproveRun: true }),
    ).toContain('ラベルが無い');
    expect(
      await checkSelfImproveMerge(makePorts({ view }), '/r', 5, { selfImproveRun: false }),
    ).toBeUndefined();
  });

  it('ファイル・一覧の取得失敗は拒否', async () => {
    const view = ok(labelsJson(SELF_IMPROVE_LABEL));
    expect(await checkSelfImproveMerge(makePorts({ view, files: ng }), '/r', 5)).toContain(
      '取得できず',
    );
    expect(await checkSelfImproveMerge(makePorts({ view, list: ng }), '/r', 5)).toContain(
      '取得できず',
    );
  });

  it('保護パスに触れていれば拒否、触れていなければ許可', async () => {
    const view = ok(labelsJson(SELF_IMPROVE_LABEL));
    expect(
      await checkSelfImproveMerge(makePorts({ view, files: ok('src/a.ts\n\nx.ts\n') }), '/r', 5),
    ).toContain('保護パス');
    expect(
      await checkSelfImproveMerge(makePorts({ view, files: ok('x.ts\n') }), '/r', 5),
    ).toBeUndefined();
  });
});
