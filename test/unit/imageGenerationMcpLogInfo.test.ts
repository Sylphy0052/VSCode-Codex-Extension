import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ generateImage: vi.fn() }));
vi.mock('../../src/webGpt/imageGeneration', async () => {
  const actual = await vi.importActual<typeof import('../../src/webGpt/imageGeneration')>(
    '../../src/webGpt/imageGeneration',
  );
  return { ...actual, generateImage: mocks.generateImage };
});

import {
  startImageGenerationMcpHost,
  type ImageGenerationMcpHost,
} from '../../src/webGpt/imageGenerationMcp';

describe('generate_imageの遅れログ（Issue #1998）', () => {
  let root: string;
  let host: ImageGenerationMcpHost | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'image-mcp-log-'));
  });
  afterEach(async () => {
    await host?.close();
    host = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it('既定の生成経路へlogInfoを渡す', async () => {
    const logInfo = vi.fn();
    mocks.generateImage.mockResolvedValue({ ok: false, error: 'x' });
    host = await startImageGenerationMcpHost({
      readEndpoint: () => 'https://chatgpt.com',
      outputDir: join(root, 'out'),
      configDir: join(root, 'cfg'),
      checkAvailable: async () => undefined,
      logWarn: () => undefined,
      logInfo,
    });
    await fetch(host.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'generate_image', arguments: { prompt: '猫' } },
      }),
    });
    expect(mocks.generateImage).toHaveBeenCalledTimes(1);
    expect(mocks.generateImage.mock.calls[0]?.[1]).toMatchObject({ logInfo });
  });
});
