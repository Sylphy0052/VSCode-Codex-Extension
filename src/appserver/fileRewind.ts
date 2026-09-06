import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseUnifiedDiffHunks, reverseApplyHunks } from '../util/diffRestore';
import type { ChatItem } from './chatState';

/** 復元はproviderの差分表現から独立した、存在の有無を含む前後像で扱う。 */
export interface FileImage {
  path: string;
  before: string | undefined;
  after: string | undefined;
}

export interface RewindChange {
  path: string;
  kind: string;
  movePath: string | undefined;
  diff: string;
}

interface EditRecord {
  images: FileImage[];
  error?: string;
}

function failure(message: string): never {
  throw new Error(`ファイルを戻せません: ${message}`);
}

/** 親も含めsymlinkを拒否する。存在しない末端は新規・削除の正当な状態。 */
function checkedPath(cwd: string, value: string): string {
  const root = fs.realpathSync(cwd);
  const resolved = path.resolve(cwd, value);
  const relative = path.relative(path.resolve(cwd), resolved);
  const parts = relative.split(path.sep);
  if (
    !relative ||
    path.isAbsolute(relative) ||
    parts.some((p) => p === '..' || p.toLowerCase() === '.git')
  ) {
    failure(`作業ディレクトリ外または管理領域です: ${value}`);
  }
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
        failure(`通常ファイル以外を含むパスです: ${value}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return current;
}

function read(cwd: string, file: string): string | undefined {
  const target = checkedPath(cwd, file);
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024) {
      failure(`通常の8MiB以下の単独ファイルではありません: ${file}`);
    }
    const bytes = fs.readFileSync(target);
    const text = bytes.toString('utf8');
    if (text.includes('\0') || !Buffer.from(text).equals(bytes))
      failure(`UTF-8テキストではありません: ${file}`);
    return text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function reverseUpdate(after: string, diff: string): string {
  const parsed = parseUnifiedDiffHunks(diff);
  if (!parsed) failure('逆適用できない差分形式です');
  // 全行削除の後像は開始行0。既存の表示用逆適用関数へは配列位置1として渡す。
  const hunks = parsed.hunks.map((h) => ({
    ...h,
    newStart: h.newLines === 0 ? h.newStart + 1 : h.newStart,
  }));
  const result = reverseApplyHunks(after, hunks);
  if (!result.ok) failure(result.error);
  return result.before;
}

/** completed通知を受けた時点で後像を読む。履歴の再読込から後像を捏造しない。 */
export class FileRewindJournal {
  private readonly records = new Map<string, EditRecord>();

  capture(cwd: string, itemId: string, changes: readonly RewindChange[]): void {
    if (this.records.has(itemId)) return;
    try {
      if (changes.length === 0) failure('編集差分がありません');
      const images: FileImage[] = [];
      for (const change of changes) {
        if (change.diff.includes('\0')) failure('復元可能なテキスト差分がありません');
        const source = checkedPath(cwd, change.path);
        const destination = checkedPath(cwd, change.movePath ?? change.path);
        const after = read(cwd, destination);
        if (change.kind === 'add') {
          if (change.movePath || after !== change.diff)
            failure(`新規ファイルの後像が一致しません: ${source}`);
          images.push({ path: source, before: undefined, after });
        } else if (change.kind === 'delete') {
          if (change.movePath || after !== undefined)
            failure(`削除されたファイルが残っています: ${source}`);
          images.push({ path: source, before: change.diff, after: undefined });
        } else if (change.kind === 'update') {
          if (after === undefined) failure(`編集後のファイルがありません: ${destination}`);
          const trailer = change.movePath ? `\n\n\nMoved to: ${change.movePath}` : '';
          const diff =
            trailer && change.diff.endsWith(trailer)
              ? change.diff.slice(0, -trailer.length)
              : change.diff;
          const before = diff === '' && change.movePath ? after : reverseUpdate(after, diff);
          if (source !== destination) {
            if (read(cwd, source) !== undefined) failure(`移動元が残っています: ${source}`);
            images.push({ path: source, before, after: undefined });
            images.push({ path: destination, before: undefined, after });
          } else {
            images.push({ path: source, before, after });
          }
        } else {
          failure(`未対応の編集種別です: ${change.kind}`);
        }
      }
      this.records.set(itemId, { images });
    } catch (error) {
      this.records.set(itemId, {
        images: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  prepare(cwd: string, items: readonly ChatItem[], messageId: string): FileRewindPlan {
    const index = items.findIndex((item) => item.id === messageId && item.kind === 'userMessage');
    if (index < 0) failure('対象の発言がありません');
    const edits = items
      .slice(index)
      .filter(
        (item) =>
          item.kind === 'fileChange' && item.status !== 'declined' && item.status !== 'failed',
      );
    const images = new Map<string, FileImage>();
    for (const item of [...edits].reverse()) {
      const record = this.records.get(item.id);
      if (!record || record.error)
        failure(record?.error ?? '編集直後の記録がありません。再読込前の編集は戻せません');
      for (const image of [...record.images].reverse()) {
        const newer = images.get(image.path);
        if (newer && newer.before !== image.after)
          failure(`編集履歴が連続していません: ${image.path}`);
        images.set(image.path, { ...image, after: newer ? newer.after : image.after });
      }
    }
    const plan = new FileRewindPlan(cwd, [...images.values()]);
    plan.validate();
    return plan;
  }

  copy(): FileRewindJournal {
    const copy = new FileRewindJournal();
    for (const [id, record] of this.records) copy.records.set(id, record);
    return copy;
  }
}

export class FileRewindPlan {
  constructor(
    private readonly cwd: string,
    readonly images: readonly FileImage[],
  ) {}

  validate(): void {
    for (const image of this.images) {
      if (read(this.cwd, image.path) !== image.after)
        failure(`編集後に内容が変わっています: ${image.path}`);
      // 削除された親ディレクトリは自動再作成しない。
      if (!fs.statSync(path.dirname(checkedPath(this.cwd, image.path))).isDirectory())
        failure(`親ディレクトリがありません: ${image.path}`);
    }
  }

  apply(): void {
    this.validate();
    const written: FileImage[] = [];
    try {
      for (const image of this.images) {
        if (image.before === image.after) continue;
        written.push(image);
        this.write(image.path, image.before);
      }
    } catch (error) {
      const failures: string[] = [];
      for (const image of written.reverse()) {
        try {
          this.write(image.path, image.after);
        } catch {
          failures.push(image.path);
        }
      }
      if (failures.length)
        failure(`書込みと復旧に失敗しました。確認が必要です: ${failures.join(', ')}`);
      throw error;
    }
  }

  private write(file: string, content: string | undefined): void {
    const target = checkedPath(this.cwd, file);
    if (content === undefined) {
      if (fs.existsSync(target)) fs.unlinkSync(target);
    } else fs.writeFileSync(target, content, { flag: fs.existsSync(target) ? 'w' : 'wx' });
  }
}
