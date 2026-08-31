import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { refuseIfExists, writeFrozen } from '../bench/secondOpinionEval/frozenFile';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'so-eval-frozen-'));
}

describe('writeFrozen', () => {
  it('まだ無ければ書く', async () => {
    const target = path.join(await tempDir(), 'nested', 'frame.json');

    await expect(writeFrozen(target, '{"a":1}')).resolves.toBe('created');
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('{"a":1}');
  });

  it('既にあって中身が同じなら書かない', async () => {
    const target = path.join(await tempDir(), 'frame.json');
    await writeFrozen(target, '{"a":1}');

    await expect(writeFrozen(target, '{"a":1}')).resolves.toBe('unchanged');
  });

  it('既にあって中身が違えば拒否し、元のファイルを変えない', async () => {
    const target = path.join(await tempDir(), 'frame.json');
    await writeFrozen(target, '{"a":1}');

    await expect(writeFrozen(target, '{"a":2}')).rejects.toThrow(/凍結済みの版は上書きしません/);
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('{"a":1}');
  });

  it('1バイトの違いでも拒否する', async () => {
    const target = path.join(await tempDir(), 'frame.json');
    await writeFrozen(target, '{"a":1}\n');

    await expect(writeFrozen(target, '{"a":1}')).rejects.toThrow(/凍結済みの版は上書きしません/);
  });
});

describe('refuseIfExists', () => {
  it('無ければ通す', async () => {
    const target = path.join(await tempDir(), 'source.json');

    await expect(refuseIfExists(target, '母集団の素')).resolves.toBeUndefined();
  });

  it('あれば拒否する', async () => {
    const target = path.join(await tempDir(), 'source.json');
    await fs.writeFile(target, '[]', 'utf8');

    await expect(refuseIfExists(target, '母集団の素')).rejects.toThrow(/取り直しません/);
  });
});
