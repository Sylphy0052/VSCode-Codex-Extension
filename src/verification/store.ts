import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  buildVerificationRecord,
  parseVerificationRecord,
  type VerificationLink,
  type VerificationRecord,
  type VerificationRecordInput,
} from './record';

/**
 * 検証結果の来歴の保存先（Issue #1377）。
 *
 * `baseDir` には `ExtensionContext.globalStorageUri` 配下を渡す（`nodeOutputOffload.ts` と同じ
 * 方針。リポジトリ内にも `~/.codex` / `~/.claude` にも置かない）。ウィンドウを再読込しても
 * 残るよう、1記録を1ファイルに書く。複数のVSCodeウィンドウが同じ `globalStorage` を共有する
 * ため、1つのファイルを読み書きし直す形にはせず（同時に書くと片方の記録が消える）、
 * 追加は新しいファイルの作成だけで済ませる。
 *
 * 記録を書き換えるAPIは持たない。消すのは上限を超えた古い記録だけ。
 */
const RECORDS_DIR_NAME = 'verification-records';

/** 保存件数の上限。超えた分は保存した時刻の古い順に消す */
export const MAX_VERIFICATION_RECORDS = 500;

/** 保存期間の上限（ミリ秒）。これより古い記録は消す */
export const MAX_VERIFICATION_RECORD_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

/**
 * ファイル名は `<保存時刻のミリ秒を15桁ゼロ埋め>-<id>.json`。名前の辞書順が保存した順になり、
 * 上限の判定に中身を読まずに済む。id は {@link buildVerificationRecord} が作るUUIDだけで、
 * 外から来た値をパスへ混ぜない。
 */
const RECORD_FILE_PATTERN = /^(\d{15})-[0-9a-f-]{36}\.json$/u;

const recordFileName = (record: VerificationRecord): string =>
  `${String(Date.parse(record.recordedAt)).padStart(15, '0')}-${record.id}.json`;

export interface VerificationStoreOptions {
  readonly maxRecords?: number;
  readonly maxAgeMs?: number;
  readonly now?: () => Date;
  /** 出力のマスクでホームディレクトリ配下のユーザー名を伏せるために使う */
  readonly homeDir?: string | undefined;
  readonly onError?: (message: string) => void;
}

/** 読出の絞り込み。指定した項目がすべて一致する記録だけを返す */
export type VerificationRecordFilter = Partial<
  Pick<VerificationLink, 'runId' | 'taskId' | 'sessionId'>
>;

export class VerificationStore {
  private readonly dir: string;
  private readonly maxRecords: number;
  private readonly maxAgeMs: number;
  private readonly now: () => Date;

  constructor(
    baseDir: string,
    private readonly options: VerificationStoreOptions = {},
  ) {
    this.dir = join(baseDir, RECORDS_DIR_NAME);
    this.maxRecords = options.maxRecords ?? MAX_VERIFICATION_RECORDS;
    this.maxAgeMs = options.maxAgeMs ?? MAX_VERIFICATION_RECORD_AGE_MS;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * 記録を組み立てて保存し、保存した記録を返す。信頼区分・結果・出力のマスクは
   * {@link buildVerificationRecord} が決める。書けなかった場合は例外を投げる。
   */
  async append(input: VerificationRecordInput): Promise<VerificationRecord> {
    const record = buildVerificationRecord(input, {
      now: this.now(),
      homeDir: this.options.homeDir,
    });
    await mkdir(this.dir, { recursive: true });
    // 書きかけのファイルを読出側に見せないよう、別名で書いてから置き換える
    const tmpPath = join(this.dir, `.tmp-${randomUUID()}`);
    await writeFile(tmpPath, JSON.stringify(record), 'utf8');
    await rename(tmpPath, join(this.dir, recordFileName(record)));
    await this.prune();
    return record;
  }

  /** 保存済みの記録を、保存した時刻の古い順に返す。期間の上限を過ぎたもの・壊れたものは返さない */
  async list(filter: VerificationRecordFilter = {}): Promise<VerificationRecord[]> {
    const cutoff = this.now().getTime() - this.maxAgeMs;
    const records: VerificationRecord[] = [];
    for (const name of await this.recordFileNames()) {
      if (Number(RECORD_FILE_PATTERN.exec(name)?.[1]) < cutoff) {
        continue;
      }
      const record = await this.readRecord(name);
      if (
        record === undefined ||
        Date.parse(record.recordedAt) < cutoff ||
        !matches(record, filter)
      ) {
        continue;
      }
      records.push(record);
    }
    return records;
  }

  /** 期間の上限を過ぎた記録と、件数の上限を超えた古い記録を消す */
  async prune(): Promise<void> {
    const names = await this.recordFileNames();
    const cutoff = this.now().getTime() - this.maxAgeMs;
    const overflow = Math.max(0, names.length - this.maxRecords);
    const doomed = names.filter(
      (name, index) => index < overflow || Number(RECORD_FILE_PATTERN.exec(name)?.[1]) < cutoff,
    );
    for (const name of doomed) {
      await rm(join(this.dir, name), { force: true });
    }
  }

  /** 記録のファイル名を古い順に返す。ディレクトリがまだ無ければ空 */
  private async recordFileNames(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw e;
    }
    return names.filter((name) => RECORD_FILE_PATTERN.test(name)).sort();
  }

  private async readRecord(name: string): Promise<VerificationRecord | undefined> {
    try {
      const record = parseVerificationRecord(
        JSON.parse(await readFile(join(this.dir, name), 'utf8')),
      );
      if (record === undefined) {
        this.options.onError?.(`検証記録の形式が不正なため読み飛ばした: ${name}`);
      }
      return record;
    } catch (e) {
      // 別ウィンドウのpruneと競合して消えた場合もここへ来る
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.options.onError?.(`検証記録を読めなかった: ${name}: ${String(e)}`);
      }
      return undefined;
    }
  }
}

function matches(record: VerificationRecord, filter: VerificationRecordFilter): boolean {
  return (
    (filter.runId === undefined || record.link.runId === filter.runId) &&
    (filter.taskId === undefined || record.link.taskId === filter.taskId) &&
    (filter.sessionId === undefined || record.link.sessionId === filter.sessionId)
  );
}
