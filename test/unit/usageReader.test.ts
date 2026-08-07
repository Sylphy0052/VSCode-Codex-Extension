import { describe, expect, it } from 'vitest';
import { codexPaths } from '../../src/codex/cliLocator';
import type { FileSystemPort } from '../../src/session/ports';
import { UsageReader } from '../../src/session/usageReader';

const paths = codexPaths('/home/u/.codex');

const tokenCountLine = (usedPercent: number) =>
  JSON.stringify({
    timestamp: '2026-08-06T18:46:34.665Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { total_tokens: 1 } },
      rate_limits: {
        primary: { used_percent: usedPercent, window_minutes: 10080, resets_at: 1786388667 },
        credits: { has_credits: true, balance: '1000' },
        plan_type: 'prolite',
      },
    },
  });

class FakeFs implements FileSystemPort {
  constructor(private readonly files: Record<string, { content: string; mtime: number }>) {}

  async readTextFile(filePath: string): Promise<string | undefined> {
    return this.files[filePath]?.content;
  }

  async readFirstLine(filePath: string): Promise<string | undefined> {
    return this.files[filePath]?.content.split('\n')[0];
  }

  async readTail(filePath: string, maxBytes: number): Promise<string | undefined> {
    const content = this.files[filePath]?.content;
    return content === undefined ? undefined : content.slice(-maxBytes);
  }

  async mtimeMs(filePath: string): Promise<number | undefined> {
    return this.files[filePath]?.mtime;
  }

  async readHead(filePath: string, maxLines: number): Promise<string[]> {
    return (this.files[filePath]?.content.split('\n') ?? []).slice(0, maxLines);
  }

  async listRollouts(dir: string): Promise<string[]> {
    return Object.keys(this.files).filter((p) => p.startsWith(`${dir}/`));
  }

  async listJsonl(dir: string): Promise<string[]> {
    return Object.keys(this.files).filter((p) => p.startsWith(`${dir}/`) && p.endsWith('.jsonl'));
  }
}

const rollout = (name: string) => `${paths.sessions}/2026/08/07/rollout-${name}.jsonl`;

describe('UsageReader', () => {
  it('最後に更新されたロールアウトから読む（レート制限はアカウント単位のため）', async () => {
    const fs = new FakeFs({
      [rollout('old')]: { content: tokenCountLine(10), mtime: 100 },
      [rollout('new')]: { content: tokenCountLine(90), mtime: 200 },
      [rollout('mid')]: { content: tokenCountLine(50), mtime: 150 },
    });

    const snapshot = await new UsageReader(fs, paths).read();
    expect(snapshot?.usedPercent).toBe(90);
  });

  it('ファイル内の最新のtoken_countを採用する', async () => {
    const fs = new FakeFs({
      [rollout('a')]: {
        content: [tokenCountLine(20), tokenCountLine(35)].join('\n'),
        mtime: 100,
      },
    });
    expect((await new UsageReader(fs, paths).read())?.usedPercent).toBe(35);
  });

  it('ロールアウトが無ければundefined', async () => {
    expect(await new UsageReader(new FakeFs({}), paths).read()).toBeUndefined();
  });

  it('token_countを含まないファイルでもundefinedを返して落ちない', async () => {
    const fs = new FakeFs({
      [rollout('a')]: { content: '{"type":"session_meta"}', mtime: 100 },
    });
    expect(await new UsageReader(fs, paths).read()).toBeUndefined();
  });
});
