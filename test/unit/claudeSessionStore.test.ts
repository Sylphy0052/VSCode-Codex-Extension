import { describe, expect, it } from 'vitest';
import { claudePaths } from '../../src/claude/cliLocator';
import { ClaudeSessionStore } from '../../src/claude/sessionStore';
import type { FileSystemPort } from '../../src/session/ports';

const HOME = '/home/u/.claude';
const paths = claudePaths(HOME);

const ID_A = '019fd79f-1e16-7b60-b9d2-0324b275ed81';
const ID_B = '019fd7a6-d25e-7bd2-b181-751e467277f3';
const ID_C = '019fd7c1-9554-7f62-816e-50e8acf1ed38';

const transcript = (slug: string, id: string) => `${paths.projects}/${slug}/${id}.jsonl`;

const userLine = (id: string, cwd: string, text: string, ts: string) =>
  JSON.stringify({
    type: 'user',
    userType: 'external',
    origin: { kind: 'human' },
    timestamp: ts,
    cwd,
    sessionId: id,
    message: { role: 'user', content: [{ type: 'text', text }] },
  });

class FakeFs implements FileSystemPort {
  headReads = 0;

  constructor(
    private readonly files: Record<string, string>,
    private readonly mtimes: Record<string, number> = {},
  ) {}

  async readTextFile(filePath: string): Promise<string | undefined> {
    return this.files[filePath];
  }

  async readFirstLine(filePath: string): Promise<string | undefined> {
    return this.files[filePath]?.split('\n')[0];
  }

  async readHead(filePath: string, maxLines: number): Promise<string[]> {
    this.headReads++;
    return (this.files[filePath]?.split('\n') ?? []).slice(0, maxLines);
  }

  async readTail(filePath: string, maxBytes: number): Promise<string | undefined> {
    const content = this.files[filePath];
    return content === undefined ? undefined : content.slice(-maxBytes);
  }

  async mtimeMs(filePath: string): Promise<number | undefined> {
    return this.mtimes[filePath];
  }

  async listRollouts(): Promise<string[]> {
    return [];
  }

  async listJsonl(dir: string): Promise<string[]> {
    return Object.keys(this.files).filter((p) => p.startsWith(`${dir}/`));
  }

  async listMarkdown(dir: string): Promise<string[]> {
    return Object.keys(this.files).filter((p) => p.startsWith(`${dir}/`) && p.endsWith('.md'));
  }
}

const options = (overrides: Partial<Parameters<ClaudeSessionStore['list']>[0]> = {}) => ({
  scope: 'workspace' as const,
  workspaceFolders: ['/w/alpha'],
  maxEntries: 100,
  ...overrides,
});

describe('ClaudeSessionStore', () => {
  it('transcriptから一覧を組み立てる', async () => {
    const fs = new FakeFs(
      {
        [transcript('-w-alpha', ID_A)]: userLine(
          ID_A,
          '/w/alpha',
          '設計を見直したい',
          '2026-08-06T20:13:18.000Z',
        ),
      },
      { [transcript('-w-alpha', ID_A)]: Date.parse('2026-08-06T21:00:00Z') },
    );

    const { sessions } = await new ClaudeSessionStore(fs, paths).list(options());

    expect(sessions).toEqual([
      {
        id: ID_A,
        provider: 'claude',
        threadName: '設計を見直したい',
        updatedAt: '2026-08-06T21:00:00.000Z',
        cwd: '/w/alpha',
        archived: false,
      },
    ]);
  });

  it('ワークスペース外のセッションを除く', async () => {
    const fs = new FakeFs({
      [transcript('-w-alpha', ID_A)]: userLine(ID_A, '/w/alpha', 'A', '2026-08-06T20:00:00.000Z'),
      [transcript('-w-beta', ID_B)]: userLine(ID_B, '/w/beta', 'B', '2026-08-06T20:00:00.000Z'),
    });

    const workspace = await new ClaudeSessionStore(fs, paths).list(options());
    expect(workspace.sessions.map((s) => s.id)).toEqual([ID_A]);

    const all = await new ClaudeSessionStore(fs, paths).list(options({ scope: 'all' }));
    expect(all.sessions.map((s) => s.id).sort()).toEqual([ID_A, ID_B].sort());
  });

  it('更新の新しい順に並べ、上限を超える分は読まない', async () => {
    const files = {
      [transcript('-w-alpha', ID_A)]: userLine(ID_A, '/w/alpha', 'A', '2026-08-05T00:00:00.000Z'),
      [transcript('-w-alpha', ID_B)]: userLine(ID_B, '/w/alpha', 'B', '2026-08-06T00:00:00.000Z'),
      [transcript('-w-alpha', ID_C)]: userLine(ID_C, '/w/alpha', 'C', '2026-08-07T00:00:00.000Z'),
    };
    const fs = new FakeFs(files, {
      [transcript('-w-alpha', ID_A)]: 1,
      [transcript('-w-alpha', ID_B)]: 2,
      [transcript('-w-alpha', ID_C)]: 3,
    });

    const { sessions } = await new ClaudeSessionStore(fs, paths).list(options({ maxEntries: 2 }));

    expect(sessions.map((s) => s.id)).toEqual([ID_C, ID_B]);
    expect(fs.headReads).toBe(2);
  });

  it('UUID以外のファイル名を無視する', async () => {
    const fs = new FakeFs({
      [`${paths.projects}/-w-alpha/summary.jsonl`]: '{}',
      [transcript('-w-alpha', ID_A)]: userLine(ID_A, '/w/alpha', 'A', '2026-08-06T20:00:00.000Z'),
    });
    const { sessions } = await new ClaudeSessionStore(fs, paths).list(options());
    expect(sessions.map((s) => s.id)).toEqual([ID_A]);
  });

  it('素性を読めなかったファイルを数える', async () => {
    const fs = new FakeFs({
      [transcript('-w-alpha', ID_A)]: '{壊れている',
    });
    const result = await new ClaudeSessionStore(fs, paths).list(options());
    expect(result.sessions).toEqual([]);
    expect(result.unresolved).toBe(1);
  });

  it('発言がまだ無いセッションは名前なしで出す', async () => {
    const fs = new FakeFs({
      [transcript('-w-alpha', ID_A)]: JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-06T20:00:00.000Z',
        cwd: '/w/alpha',
        sessionId: ID_A,
        message: { role: 'assistant', content: [] },
      }),
    });
    const { sessions } = await new ClaudeSessionStore(fs, paths).list(options());
    expect(sessions[0]?.threadName).toBeUndefined();
  });

  it('idからtranscriptの場所を解決する', async () => {
    const path = transcript('-w-alpha', ID_A);
    const fs = new FakeFs({ [path]: userLine(ID_A, '/w/alpha', 'A', '2026-08-06T20:00:00.000Z') });
    const store = new ClaudeSessionStore(fs, paths);
    expect(await store.resolveTranscriptPath(ID_A)).toBe(path);
    expect(await store.resolveTranscriptPath(ID_B)).toBeUndefined();
  });
});
