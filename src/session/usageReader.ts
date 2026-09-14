import type { CodexPaths } from '../codex/cliLocator';
import { findLastTokenCount, type UsageSnapshot } from '../codex/usage';
import { mapWithLimit } from '../util/concurrency';
import type { FileSystemPort } from './ports';
import { MTIME_CONCURRENCY_LIMIT } from './sessionStore';

/** 末尾から読む量。token_countイベントは数百バイト程度なので十分な余裕がある。 */
const TAIL_BYTES = 64 * 1024;

/**
 * mtime降順で試す候補の上限（issue #1226）。
 *
 * 最新ファイルに`token_count`が無くても諦めず次点を試すが、無制限に遡ると会話数の
 * 多いアカウントで毎回大量の`readTail`を投げかねない。通常は1〜2件目で見つかる。
 */
const USAGE_CANDIDATE_LIMIT = 5;

/**
 * 現在のレート制限使用量を読む。
 *
 * レート制限はアカウント単位なので、更新の新しいロールアウトほど現在値に近い
 * `token_count` を持つ可能性が高い。ただし最新ファイルが`session_meta`のみだったり、
 * 末尾64KiBから古い`token_count`が押し出されていたりして読めないことがあるため、
 * 上限件数までmtime降順で候補を試す（issue #1226）。
 */
export class UsageReader {
  constructor(
    private readonly fs: FileSystemPort,
    private readonly paths: CodexPaths,
  ) {}

  async read(): Promise<UsageSnapshot | undefined> {
    const candidates = await this.newestRollouts(USAGE_CANDIDATE_LIMIT);
    for (const file of candidates) {
      const tail = await this.fs.readTail(file, TAIL_BYTES);
      if (tail === undefined) {
        continue;
      }
      const snapshot = findLastTokenCount(tail);
      if (snapshot !== undefined) {
        return snapshot;
      }
    }
    return undefined;
  }

  /** mtimeが新しい順に最大`limit`件を返す。 */
  private async newestRollouts(limit: number): Promise<string[]> {
    const files = await this.fs.listRollouts(this.paths.sessions);
    // 会話中は`onRolloutChanged`のたびに全件呼ばれうるため、逐次待ちだと件数に比例して
    // 遅くなる。並列化する（issue #382）。ただし件数分を無制限に同時発火しないよう
    // 上限を設ける（レビュー指摘）。
    const mtimes = await mapWithLimit(files, MTIME_CONCURRENCY_LIMIT, (file) =>
      this.fs.mtimeMs(file),
    );

    return files
      .map((file, i) => ({ file, mtime: mtimes[i] }))
      .filter((entry): entry is { file: string; mtime: number } => entry.mtime !== undefined)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit)
      .map((entry) => entry.file);
  }
}
