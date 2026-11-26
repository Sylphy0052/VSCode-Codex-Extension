import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  startImageGenerationMcpHost,
  type ImageGenerationMcpHost,
} from '../../src/webGpt/imageGenerationMcp';

describe('startImageGenerationMcpHost', () => {
  let root: string;
  let host: ImageGenerationMcpHost | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'image-mcp-'));
  });
  afterEach(async () => {
    await host?.close();
    host = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it('close()は生成中の呼び出しへ中断を伝え、中断した生成の終了を待ってから閉じる', async () => {
    let seenSignal: AbortSignal | undefined;
    let generateFinished = false;
    const started = vi.fn();
    host = await startImageGenerationMcpHost({
      readEndpoint: () => 'https://chatgpt.com',
      outputDir: join(root, 'out'),
      configDir: join(root, 'cfg'),
      checkAvailable: async () => undefined,
      logWarn: () => undefined,
      generate: (_request, signal) =>
        new Promise((resolve) => {
          seenSignal = signal;
          started();
          signal.addEventListener('abort', () => {
            generateFinished = true;
            resolve({ ok: false, error: '中断されました' });
          });
        }),
    });

    const pending = fetch(host.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'generate_image', arguments: { prompt: '猫' } },
      }),
    }).catch(() => undefined);
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1));
    expect(seenSignal?.aborted).toBe(false);

    await host.close();
    host = undefined;

    expect(seenSignal?.aborted).toBe(true);
    expect(generateFinished).toBe(true);
    await pending;
  });

  it('クライアントが応答前に切断すると生成を中断する', async () => {
    let seenSignal: AbortSignal | undefined;
    const started = vi.fn();
    host = await startImageGenerationMcpHost({
      readEndpoint: () => 'https://chatgpt.com',
      outputDir: join(root, 'out'),
      configDir: join(root, 'cfg'),
      checkAvailable: async () => undefined,
      logWarn: () => undefined,
      generate: (_request, signal) =>
        new Promise((resolve) => {
          seenSignal = signal;
          started();
          signal.addEventListener('abort', () => resolve({ ok: false, error: '中断' }));
        }),
    });
    const controller = new AbortController();
    const pending = fetch(host.url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'generate_image', arguments: { prompt: '猫' } },
      }),
    }).catch(() => undefined);
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1));

    controller.abort();
    await vi.waitFor(() => expect(seenSignal?.aborted).toBe(true));
    await pending;
  });

  it('設定ファイルを書けなくても起動し、claudeConfigPathはundefinedで警告を残す', async () => {
    const blocker = join(root, 'file');
    writeFileSync(blocker, '');
    const warnings: string[] = [];
    host = await startImageGenerationMcpHost({
      readEndpoint: () => 'https://chatgpt.com',
      outputDir: join(root, 'out'),
      configDir: join(blocker, 'cfg'),
      checkAvailable: async () => undefined,
      logWarn: (message) => warnings.push(message),
    });

    expect(host.claudeConfigPath).toBeUndefined();
    expect(host.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[0-9a-f]{32}$/u);
    expect(warnings.some((message) => message.includes('MCP設定ファイルを書けませんでした'))).toBe(
      true,
    );
  });
});
