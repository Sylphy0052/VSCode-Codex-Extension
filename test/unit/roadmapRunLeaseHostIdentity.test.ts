import { readFileSync, readlinkSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeHostIdentity } from '../../src/orchestrator/roadmapRunLease';

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  readFileSync: vi.fn(),
  readlinkSync: vi.fn(),
}));

const readFile = vi.mocked(readFileSync);
const readlink = vi.mocked(readlinkSync);

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe('computeHostIdentity', () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it('boot_idとPID名前空間を組み合わせる', () => {
    readFile.mockReturnValue('0b5e7c1a-1111-2222-3333-444455556666\n');
    readlink.mockReturnValue('pid:[4026531836]');
    expect(computeHostIdentity()).toBe('0b5e7c1a-1111-2222-3333-444455556666:pid:[4026531836]');
    expect(readFile).toHaveBeenCalledWith('/proc/sys/kernel/random/boot_id', 'utf8');
    expect(readlink).toHaveBeenCalledWith('/proc/self/ns/pid');
  });

  it('/procが無い環境では空文字列を返す', () => {
    readFile.mockImplementation(() => {
      throw fsError('ENOENT');
    });
    expect(computeHostIdentity()).toBe('');
  });

  it('/procを読めない（権限が無い）環境でも空文字列を返す', () => {
    readFile.mockReturnValue('0b5e7c1a-1111-2222-3333-444455556666\n');
    readlink.mockImplementation(() => {
      throw fsError('EACCES');
    });
    expect(computeHostIdentity()).toBe('');
  });

  it('boot_idが空なら空文字列を返す', () => {
    readFile.mockReturnValue('\n');
    readlink.mockReturnValue('pid:[4026531836]');
    expect(computeHostIdentity()).toBe('');
  });
});
