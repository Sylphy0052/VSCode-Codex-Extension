import type { CodexPaths } from '../codex/cliLocator';
import { findLastTokenCount, type UsageSnapshot } from '../codex/usage';
import { mapWithLimit } from '../util/concurrency';
import type { FileSystemPort } from './ports';
import { MTIME_CONCURRENCY_LIMIT } from './sessionStore';

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
    // 会話中は`onRolloutChanged`のたびに全件呼ばれうるため、逐次待ちだと件数に比例して
    // 遅くなる。並列化する（issue #382）。ただし件数分を無制限に同時発火しないよう
    // 上限を設ける（レビュー指摘）。
    const mtimes = await mapWithLimit(files, MTIME_CONCURRENCY_LIMIT, (file) =>
      this.fs.mtimeMs(file),
    );

    let newest: string | undefined;
    let newestMtime = -1;
    files.forEach((file, i) => {
      const mtime = mtimes[i];
      if (mtime !== undefined && mtime > newestMtime) {
        newestMtime = mtime;
        newest = file;
      }
    });
    return newest;
  }
}
