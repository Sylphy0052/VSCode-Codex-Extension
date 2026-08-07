import * as fs from 'node:fs/promises';
import type { ActivityAppendPort } from './activityLogger';

/**
 * バッファへの追記。
 *
 * 1レコードを1回の `appendFile` で書き切る。複数ウィンドウから同時に書いても
 * 行が混ざらないようにするため、呼び出し側は必ず改行で終わる1行を渡すこと。
 */
export const nodeActivityAppender: ActivityAppendPort = {
  async append(filePath: string, line: string): Promise<void> {
    const dir = filePath.slice(0, filePath.lastIndexOf('/'));
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(filePath, line, 'utf8');
  },
};
