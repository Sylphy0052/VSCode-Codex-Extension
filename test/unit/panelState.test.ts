import { describe, expect, it } from 'vitest';
import { readPersistedThreadId } from '../../src/view/panelState';

describe('readPersistedThreadId', () => {
  it('webviewが持たせたidを読む', () => {
    expect(readPersistedThreadId({ threadId: 'abc' })).toBe('abc');
  });

  it('idが無い・空・型違いのときは復元しない', () => {
    expect(readPersistedThreadId(undefined)).toBeUndefined();
    expect(readPersistedThreadId(null)).toBeUndefined();
    expect(readPersistedThreadId('abc')).toBeUndefined();
    expect(readPersistedThreadId({})).toBeUndefined();
    expect(readPersistedThreadId({ threadId: '' })).toBeUndefined();
    expect(readPersistedThreadId({ threadId: 42 })).toBeUndefined();
  });
});
