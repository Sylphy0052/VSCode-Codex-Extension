import type { CodexPaths } from '../codex/cliLocator';
import { findLastTokenCount, type UsageSnapshot } from '../codex/usage';
import type { FileSystemPort } from './ports';

/** 末尾から読む量。token_countイベントは数百バイト程度なので十分な余裕がある。 */
const TAIL_BYTES = 64 * 1024;

/**
 * 現在のレート制限使用量を読む。
 *
 * レート制限はアカウント単位なので、**最後に更新されたロールアウト**の最新
 * `token_count` が現在値になる。セッションを跨いで探す必要がある。
 */
export class UsageReader {
  constructor(
    private readonly fs: FileSystemPort,
    private readonly paths: CodexPaths,
  ) {}

  async read(): Promise<UsageSnapshot | undefined> {
    const newest = await this.newestRollout();
    if (newest === undefined) {
      return undefined;
    }
    const tail = await this.fs.readTail(newest, TAIL_BYTES);
    if (tail === undefined) {
      return undefined;
    }
    return findLastTokenCount(tail);
  }

  private async newestRollout(): Promise<string | undefined> {
    const files = await this.fs.listRollouts(this.paths.sessions);
    let newest: string | undefined;
    let newestMtime = -1;

    for (const file of files) {
      const mtime = await this.fs.mtimeMs(file);
      if (mtime !== undefined && mtime > newestMtime) {
        newestMtime = mtime;
        newest = file;
      }
    }
    return newest;
  }
}
