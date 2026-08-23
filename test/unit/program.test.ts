import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROGRAM_MAX_PARALLEL,
  MAX_PROGRAM_RUN_COUNT,
  parseProgramYaml,
  PROGRAM_MAX_PARALLEL_MAX,
  PROGRAM_MAX_PARALLEL_MIN,
  PROGRAM_RUN_ID_PATTERN,
  validateProgram,
  type ProgramDefinition,
  type ProgramRunRef,
} from '../../src/orchestrator/program';

const runRef = (overrides: Partial<ProgramRunRef> = {}): ProgramRunRef => ({
  id: 'R1',
  defPath: '.agents/workflows/a.yaml',
  dependsOn: [],
  parseErrors: [],
  ...overrides,
});

const program = (overrides: Partial<ProgramDefinition> = {}): ProgramDefinition => ({
  version: 1,
  name: 'テストプログラム',
  maxParallel: 3,
  runs: [runRef()],
  ...overrides,
});

describe('parseProgramYaml（design.md §16.37、Issue #604）', () => {
  it('正常な定義を読み、runの一覧と依存が得られる', () => {
    const yaml = `
version: 1
name: 7ワークフロー・3波の運用

runs:
  - id: R1
    defPath: .agents/workflows/a.yaml
  - id: R2
    defPath: .agents/workflows/b.yaml
    dependsOn: [R1]
`;
    const def = parseProgramYaml(yaml);
    expect(def.version).toBe(1);
    expect(def.name).toBe('7ワークフロー・3波の運用');
    expect(def.runs).toHaveLength(2);
    expect(def.runs[1]?.dependsOn).toEqual(['R1']);
    expect(validateProgram(def).errors).toEqual([]);
  });

  it('未知のフィールドは読み飛ばす', () => {
    const yaml = `
version: 1
name: テスト
runs:
  - id: R1
    defPath: .agents/workflows/a.yaml
    wave: 1
`;
    const def = parseProgramYaml(yaml);
    expect(validateProgram(def).errors).toEqual([]);
  });

  it('dependsOnが配列でない場合はparseErrorsへ残す（黙って[]にしない）', () => {
    const yaml = `
version: 1
name: テスト
runs:
  - id: R1
    defPath: .agents/workflows/a.yaml
    dependsOn: R2
`;
    const def = parseProgramYaml(yaml);
    expect(def.runs[0]?.parseErrors).toEqual([
      'dependsOn は配列で指定してください（例: dependsOn: [R1]）',
    ]);
    expect(validateProgram(def).errors.some((e) => e.runIds.includes('R1'))).toBe(true);
  });
});

describe('validateProgram（受入基準: 複数runの定義・循環依存と未定義参照の拒否、Issue #604）', () => {
  it('複数のrunを1つのプログラムとして定義できる（エラー無し）', () => {
    const def = program({
      runs: [
        runRef({ id: 'R1' }),
        runRef({ id: 'R2', dependsOn: ['R1'] }),
        runRef({ id: 'R3', dependsOn: ['R1'] }),
      ],
    });
    expect(validateProgram(def)).toEqual({ errors: [], warnings: [] });
  });

  it('未定義run参照を開始前に拒否し理由が返る', () => {
    const def = program({ runs: [runRef({ id: 'R1', dependsOn: ['R404'] })] });
    const result = validateProgram(def);
    expect(result.errors).toContainEqual({
      runIds: ['R1'],
      message: 'dependsOn が未定義のrunを参照しています: R404',
    });
  });

  it('循環依存（2件）を開始前に拒否し理由が返る', () => {
    const def = program({
      runs: [runRef({ id: 'R1', dependsOn: ['R2'] }), runRef({ id: 'R2', dependsOn: ['R1'] })],
    });
    const result = validateProgram(def);
    expect(result.errors.some((e) => e.message.includes('依存が循環しています'))).toBe(true);
    expect(result.errors.find((e) => e.message.includes('循環'))?.runIds.sort()).toEqual([
      'R1',
      'R2',
    ]);
  });

  it('無関係な複数の循環はグループごとに別のエラーとして返る', () => {
    const def = program({
      runs: [
        runRef({ id: 'A', dependsOn: ['B'] }),
        runRef({ id: 'B', dependsOn: ['A'] }),
        runRef({ id: 'C', dependsOn: ['D'] }),
        runRef({ id: 'D', dependsOn: ['C'] }),
      ],
    });
    const result = validateProgram(def);
    const cycleErrors = result.errors.filter((e) => e.message.includes('循環'));
    expect(cycleErrors).toHaveLength(2);
  });

  it('id の重複を拒否する', () => {
    const def = program({ runs: [runRef({ id: 'R1' }), runRef({ id: 'R1' })] });
    expect(validateProgram(def).errors).toContainEqual({
      runIds: ['R1'],
      message: 'id が重複しています: R1',
    });
  });

  it('id の字種が不正なら拒否する', () => {
    const def = program({ runs: [runRef({ id: '../evil' })] });
    expect(
      validateProgram(def).errors.some((e) => e.message.includes('id の形式が不正です')),
    ).toBe(true);
  });

  it('プロトタイプ汚染を招くrun id（危険キー）を、文字種チェックを通っても拒否する（横断レビュー実測、Issue #606）', () => {
    // テストのソースに危険キーをリテラルで書かず、組み立てて回避する
    const dangerousId = ['__', 'proto', '__'].join('');
    // PROGRAM_RUN_ID_PATTERN（半角英数字・_・-のみ）自体はこの文字列を通してしまう
    // ことを確認したうえで、validateProgramが別のチェックで弾くことを検証する
    expect(PROGRAM_RUN_ID_PATTERN.test(dangerousId)).toBe(true);
    const def = program({
      runs: [runRef({ id: dangerousId }), runRef({ id: 'R2', dependsOn: [] })],
    });
    const result = validateProgram(def);
    expect(result.errors.some((e) => e.runIds.includes(dangerousId))).toBe(true);
    expect(
      result.errors.some((e) => e.message.includes('プロトタイプ汚染')),
    ).toBe(true);
  });

  it('name未指定を拒否する', () => {
    const def = program({ name: '' });
    expect(validateProgram(def).errors).toContainEqual({
      runIds: [],
      message: 'name が指定されていません',
    });
  });

  it('runsが0件を拒否する', () => {
    const def = program({ runs: [] });
    expect(
      validateProgram(def).errors.some((e) => e.message.includes('runs が1件も定義されていません')),
    ).toBe(true);
  });

  it('runの総数が上限を超えたら拒否する', () => {
    const runs = Array.from({ length: MAX_PROGRAM_RUN_COUNT + 1 }, (_, i) =>
      runRef({ id: `R${i}` }),
    );
    const def = program({ runs });
    expect(validateProgram(def).errors.some((e) => e.message.includes('runの総数が上限'))).toBe(
      true,
    );
  });

  it('defPathがワークスペース外・拡張子違いを拒否する', () => {
    const def = program({
      runs: [
        runRef({ id: 'R1', defPath: '../outside.yaml' }),
        runRef({ id: 'R2', defPath: 'a.txt' }),
      ],
    });
    const result = validateProgram(def);
    expect(result.errors.filter((e) => e.message.includes('defPath'))).toHaveLength(2);
  });

  it('version が1以外なら拒否する', () => {
    const def = program({ version: 2 });
    expect(
      validateProgram(def).errors.some((e) => e.message.includes('version はサポートしていない')),
    ).toBe(true);
  });

  it('PROGRAM_RUN_ID_PATTERNはworkflow.tsのTASK_ID_PATTERNと同じ字種を許す', () => {
    expect(PROGRAM_RUN_ID_PATTERN.test('R1')).toBe(true);
    expect(PROGRAM_RUN_ID_PATTERN.test('-R1')).toBe(false);
  });

  it('maxParallelが範囲外なら拒否する', () => {
    const tooLow = program({ maxParallel: PROGRAM_MAX_PARALLEL_MIN - 1 });
    const tooHigh = program({ maxParallel: PROGRAM_MAX_PARALLEL_MAX + 1 });
    const notInteger = program({ maxParallel: 1.5 });
    expect(validateProgram(tooLow).errors.some((e) => e.message.includes('maxParallel'))).toBe(
      true,
    );
    expect(validateProgram(tooHigh).errors.some((e) => e.message.includes('maxParallel'))).toBe(
      true,
    );
    expect(validateProgram(notInteger).errors.some((e) => e.message.includes('maxParallel'))).toBe(
      true,
    );
  });
});

describe('maxParallelの読み込み（design.md §16.37.2、Issue #605）', () => {
  it('未指定ならDEFAULT_PROGRAM_MAX_PARALLELを使う', () => {
    const yaml = `
version: 1
name: テスト
runs:
  - id: R1
    defPath: .agents/workflows/a.yaml
`;
    expect(parseProgramYaml(yaml).maxParallel).toBe(DEFAULT_PROGRAM_MAX_PARALLEL);
  });

  it('指定した値を読む', () => {
    const yaml = `
version: 1
name: テスト
maxParallel: 2
runs:
  - id: R1
    defPath: .agents/workflows/a.yaml
`;
    expect(parseProgramYaml(yaml).maxParallel).toBe(2);
  });
});
