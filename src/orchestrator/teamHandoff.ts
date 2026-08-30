import * as path from 'node:path';

import {
  findSymlinkedAncestor,
  identifierError,
  runIdError,
  type SymlinkCheckPort,
} from './fsGuards';
import { TASK_ID_PATTERN } from './workflow';

/**
 * チームモードのファイル受け渡し（design.md §16.44、Issue #693）。
 *
 * セッション間の主な連絡経路は `messaging.ts` の `send_message` / `ask_orchestrator`
 * （オーケストレーター中継、design.md §16.34）のままで、**ここはその代わりではない**。
 * メッセージ本文の上限（`MAX_MESSAGE_BODY_LENGTH`）に収まらない・後から何度も読み返したい
 * 情報（設計メモ、レビュー結果、共有コンテキスト）だけをファイルとして残すための置き場を
 * 提供する。不要になったら消す前提の作業領域で、リポジトリへはcommitしない
 * （`.gitignore` の `.agents/handoff/runs/`）。
 *
 * 置き場は `.agents/handoff/runs/<runId>/<taskId>-<slug>.md`。run単位で分けるのは、
 * runが終わったときに丸ごと片付けられるようにするため（`worktree.ts` の
 * `.agents/worktrees/<runId>/` と同じ考え方）。
 *
 * **パスの組み立てはこのファイルの `handoffPath` だけが行う。** `worktree.ts` が
 * `createWorktree` / `removeWorktree` を非exportにして入口を1つに絞ったのと同じ方針で、
 * 検証（識別子の字種・スラッグの字種・シンボリックリンク祖先）を通らない経路を作らない。
 */

/** `.agents` 直下のディレクトリ名。`worktree.ts` の `.agents/worktrees` と並ぶ位置。 */
const HANDOFF_DIR_SEGMENTS = ['.agents', 'handoff', 'runs'] as const;

/**
 * ファイル名のうち、taskIdに続く自由記述部分（スラッグ）の字種。
 *
 * `TASK_ID_PATTERN`（`workflow.ts`）と同じくパス区切り・`..`・制御文字を作れない字種に絞る。
 * スラッグはエージェントが生成した文字列がそのまま来る経路なので、taskIdと同じ強度で縛る。
 */
const SLUG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;

/**
 * ファイル名の中で `taskId` とスラッグを区切る1文字。
 *
 * `TASK_ID_PATTERN`（`workflow.ts`）と `SLUG_PATTERN` のどちらも `~` を許さないため、
 * この文字が現れる位置は組み立てで置いた1箇所だけになり、分割が一意に決まる（Issue #1022）。
 * 以前は `-` で区切り「最後の `-` で割る」と決めていたが、`-` は両側の字種に含まれるため
 * 割り方が定まらず、`impl` + `design-memo` と `impl-design` + `memo` が同じファイル名に
 * なっていた——一覧が書いた本人と違う`taskId`を返し、`write_handoff`が
 * `connection.taskId`だけを使って守っていた「別タスクの名義を騙れない」も破れていた。
 */
const NAME_SEPARATOR = '~';

/** 1ファイルの本文の上限。巨大なファイルで拡張機能ホストを固まらせないための安全弁。 */
export const MAX_HANDOFF_BYTES = 256 * 1024;

/** run単位のディレクトリ数の上限ではなく、1run内のファイル数の上限。 */
export const MAX_HANDOFF_FILES_PER_RUN = 100;

/** このモジュールが必要とする最小限のファイルシステム操作。 */
export interface HandoffFileSystemPort extends SymlinkCheckPort {
  /**
   * 親を含めてディレクトリを作る。既にあれば何もしない。
   *
   * **書き換える操作は成否を`boolean`で返す。** 失敗を`void`で握り潰すと、
   * `TeamHandoffStore.write`が書けていないファイルに対して`ok: true`（「書き込みました」）
   * を返し、直後の`read`が「ありません」になる——という、呼び出し側からは原因の追えない
   * 不整合になる（PR #711 自己レビュー指摘: high）。読む操作（`readTextFile` /
   * `listDirectory`）は「無ければ空」という戻り値自体が失敗を表せるので`boolean`にしない。
   */
  makeDirectory(target: string): Promise<boolean>;
  /** UTF-8で書き込む（既存は上書き）。書けたら true。 */
  writeTextFile(target: string, content: string): Promise<boolean>;
  /** UTF-8で読む。存在しなければ undefined。 */
  readTextFile(target: string): Promise<string | undefined>;
  /** ディレクトリ直下の名前一覧。存在しなければ空配列。 */
  listDirectory(target: string): Promise<string[]>;
  /** ファイルを消す。存在しなければ何もしない（その場合も true）。 */
  removeFile(target: string): Promise<boolean>;
  /** ディレクトリを中身ごと消す。存在しなければ何もしない（その場合も true）。 */
  removeDirectory(target: string): Promise<boolean>;
}

/** 成否と理由。`worktree.ts` の `Result` と同じ流儀（例外ではなく値で返す）。 */
export type HandoffResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** run1件ぶんのファイル置き場。 */
export function handoffRunDir(repoRoot: string, runId: string): string {
  const message = runIdError(runId);
  if (message !== undefined) {
    throw new Error(message);
  }
  return path.join(repoRoot, ...HANDOFF_DIR_SEGMENTS, runId);
}

/**
 * 1ファイルのパス。識別子・スラッグが不正なら例外を投げる（`worktreePath` と同じ流儀で、
 * パスを組み立てる純粋関数は不正な入力を値で返さず落とす）。
 */
export function handoffPath(repoRoot: string, runId: string, taskId: string, slug: string): string {
  const message = identifierError(runId, taskId);
  if (message !== undefined) {
    throw new Error(message);
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(`不正なスラッグ（許可されない文字を含みます）: ${slug}`);
  }
  return path.join(handoffRunDir(repoRoot, runId), `${taskId}${NAME_SEPARATOR}${slug}.md`);
}

/** 一覧の1件。 */
export interface HandoffEntry {
  taskId: string;
  slug: string;
  /** `repoRoot` からの相対パス。オーケストレーターへ知らせる表示用。 */
  relativePath: string;
}

/**
 * ファイル名を `<taskId>~<slug>.md` として解釈する。想定外の名前（人が置いたファイル、
 * 旧命名の残骸）は `undefined` を返して一覧から外す。
 *
 * 区切りの `NAME_SEPARATOR` は taskId・スラッグのどちらの字種にも含まれないため、
 * 最初に現れた1文字で割れば `handoffPath` が組み立てた形へ必ず戻る。両側は
 * それぞれのパターン（taskIdは `TASK_ID_PATTERN`、スラッグは `SLUG_PATTERN`）で
 * 個別に検証する。区切りが2つ以上ある名前は、どちらかの検証で必ず落ちる。
 */
export function parseHandoffFileName(
  fileName: string,
): { taskId: string; slug: string } | undefined {
  if (!fileName.endsWith('.md')) {
    return undefined;
  }
  const stem = fileName.slice(0, -'.md'.length);
  const cut = stem.indexOf(NAME_SEPARATOR);
  if (cut <= 0 || cut === stem.length - 1) {
    return undefined;
  }
  const taskId = stem.slice(0, cut);
  const slug = stem.slice(cut + NAME_SEPARATOR.length);
  if (!SLUG_PATTERN.test(slug)) {
    return undefined;
  }
  // taskIdは`identifierError`と同じ`TASK_ID_PATTERN`で見る（runIdを持たないため
  // `identifierError`自体は呼べない）。スラッグのパターンで代用すると、taskIdとしては
  // 長すぎる名前（50文字超）を通してしまう
  if (!TASK_ID_PATTERN.test(taskId)) {
    return undefined;
  }
  return { taskId, slug };
}

/**
 * ファイル受け渡しの唯一の入口（design.md §16.44）。
 *
 * `repoRoot` は呼び出し側（`runner.ts`）が解決済みのワークスペースルートを渡す。
 * 各操作の前に、組み立てたパスの祖先にシンボリックリンクが無いことを確かめる
 * （`worktree.ts` / `pseudoWorktree.ts` と同じ一次防御。`.agents` や `.agents/handoff`
 * がリポジトリにcommitされたシンボリックリンクだと、文字列結合で組み立てたパスが
 * リポジトリの外を指す。design.md §16.6）。
 */
export class TeamHandoffStore {
  constructor(
    private readonly repoRoot: string,
    private readonly fs: HandoffFileSystemPort,
  ) {}

  /** 祖先にシンボリックリンクが無いか確かめる。あればその位置を理由として返す。 */
  private async guard(target: string): Promise<string | undefined> {
    const linked = await findSymlinkedAncestor(this.repoRoot, target, this.fs);
    return linked === undefined
      ? undefined
      : `受け渡しファイルの置き場の途中がシンボリックリンクのため中止しました: ${linked}`;
  }

  /**
   * 書き込む（既存は上書き）。本文が上限を超える・1run内のファイル数が上限に達している
   * 場合は書かずに理由を返す。
   */
  async write(
    runId: string,
    taskId: string,
    slug: string,
    content: string,
  ): Promise<HandoffResult<HandoffEntry>> {
    let target: string;
    try {
      target = handoffPath(this.repoRoot, runId, taskId, slug);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_HANDOFF_BYTES) {
      return {
        ok: false,
        error: `本文が上限(${MAX_HANDOFF_BYTES}バイト)を超えています: ${bytes}バイト`,
      };
    }

    const guardMessage = await this.guard(target);
    if (guardMessage !== undefined) {
      return { ok: false, error: guardMessage };
    }

    const dir = handoffRunDir(this.repoRoot, runId);
    const existing = await this.fs.listDirectory(dir);
    // 上書きは件数を増やさないので、新規のときだけ上限を見る
    if (!existing.includes(path.basename(target)) && existing.length >= MAX_HANDOFF_FILES_PER_RUN) {
      return {
        ok: false,
        error: `このrunの受け渡しファイルが上限(${MAX_HANDOFF_FILES_PER_RUN}件)に達しています。不要なものを削除してください`,
      };
    }

    if (!(await this.fs.makeDirectory(dir))) {
      return { ok: false, error: '受け渡しファイルの置き場を作れませんでした' };
    }
    if (!(await this.fs.writeTextFile(target, content))) {
      return { ok: false, error: '受け渡しファイルを書き込めませんでした' };
    }
    return {
      ok: true,
      value: { taskId, slug, relativePath: path.relative(this.repoRoot, target) },
    };
  }

  /** 読む。存在しなければ `ok: false`。 */
  async read(runId: string, taskId: string, slug: string): Promise<HandoffResult<string>> {
    let target: string;
    try {
      target = handoffPath(this.repoRoot, runId, taskId, slug);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const guardMessage = await this.guard(target);
    if (guardMessage !== undefined) {
      return { ok: false, error: guardMessage };
    }
    const content = await this.fs.readTextFile(target);
    if (content === undefined) {
      return {
        ok: false,
        error: `受け渡しファイルが見つかりません: ${taskId}${NAME_SEPARATOR}${slug}.md`,
      };
    }
    return { ok: true, value: content };
  }

  /** runの中の一覧。想定外の名前のファイルは含めない。 */
  async list(runId: string): Promise<HandoffEntry[]> {
    const dir = handoffRunDir(this.repoRoot, runId);
    if ((await this.guard(dir)) !== undefined) {
      return [];
    }
    const names = await this.fs.listDirectory(dir);
    const entries: HandoffEntry[] = [];
    for (const name of names) {
      const parsed = parseHandoffFileName(name);
      if (parsed !== undefined) {
        entries.push({
          taskId: parsed.taskId,
          slug: parsed.slug,
          relativePath: path.relative(this.repoRoot, path.join(dir, name)),
        });
      }
    }
    return entries;
  }

  /**
   * 1件消す。存在しなくても成功として扱う（不要になったものを消す操作であり、
   * 既に無いことは目的の達成と同じ）。
   */
  async remove(runId: string, taskId: string, slug: string): Promise<HandoffResult<undefined>> {
    let target: string;
    try {
      target = handoffPath(this.repoRoot, runId, taskId, slug);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const guardMessage = await this.guard(target);
    if (guardMessage !== undefined) {
      return { ok: false, error: guardMessage };
    }
    if (!(await this.fs.removeFile(target))) {
      return { ok: false, error: '受け渡しファイルを削除できませんでした' };
    }
    return { ok: true, value: undefined };
  }

  /**
   * runのディレクトリごと消す。runが終わったときに `runner.ts` が呼ぶ。
   *
   * `cleanup` の設定（`CLEANUP_MODES`）とは独立に常に消す。worktreeと違って
   * 受け渡しファイルには「後から人が見たい成果物」は入らない前提で、成果は統合ブランチと
   * PR/MRの側に残るため（design.md §16.17）。
   */
  async removeRun(runId: string): Promise<HandoffResult<undefined>> {
    let dir: string;
    try {
      dir = handoffRunDir(this.repoRoot, runId);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const guardMessage = await this.guard(dir);
    if (guardMessage !== undefined) {
      return { ok: false, error: guardMessage };
    }
    if (!(await this.fs.removeDirectory(dir))) {
      return { ok: false, error: '受け渡しファイルの置き場を削除できませんでした' };
    }
    return { ok: true, value: undefined };
  }
}
