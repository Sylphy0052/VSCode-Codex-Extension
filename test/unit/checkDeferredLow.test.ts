import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 同梱skillの `check_deferred_low.py` の入力まわりの検査（Issue #1836）。
 * 不正なUTF-8、空入力、節なし、標準入力（`-`）を確かめる。python3が無い環境では飛ばす。
 */

const script = path.resolve(
  __dirname,
  '../../resources/skills-plugin/skills/gitlab-review/scripts/check_deferred_low.py',
);
const hasPython = spawnSync('python3', ['--version']).status === 0;

function run(input: Buffer | string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('python3', [script, '-'], { input });
  return { status: r.status, stdout: String(r.stdout), stderr: String(r.stderr) };
}

describe.skipIf(!hasPython)('check_deferred_low.py', () => {
  it('標準入力 (-) の節なしは終了コード2', () => {
    const r = run('## 見出しだけ\n本文\n');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('節が無い');
  });

  it('空入力は節なしとして終了コード2', () => {
    expect(run('').status).toBe(2);
  });

  it('不正なUTF-8は読み取り失敗として終了コード2', () => {
    const r = run(Buffer.from([0xff, 0xfe, 0x80, 0x0a]));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('入力を読めない');
  });

  it('N/Aだけの節は終了コード0', () => {
    expect(run('### 見送り一覧 (累積)\n\n- N/A\n').status).toBe(0);
  });

  it('切り出し未了の行があれば終了コード1', () => {
    const r = run('### 見送り一覧 (累積)\n\n- a.md / 見出し — 要約 — 見送り (low、別Issue予定)\n');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('未切り出し');
  });
});
