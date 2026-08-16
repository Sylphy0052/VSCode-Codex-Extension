/**
 * 会話に出るファイル差分（issue #291）から、変更前の内容を復元する。
 *
 * 会話に届く差分は unified diff のテキストで、CLI（Codex/Claude）が組み立てたものを
 * そのまま持っている（`src/appserver/chatState.ts` の `FileDiff`）。変更前を作る方法には
 * 「差分自身から復元する」か「gitの索引と比較する」かの選択があるが、ここでは前者を採る。
 * 理由は design.md §14.52 を参照（要約: gitに依存すると、対象がgit管理下でない
 * ワークスペースや、コミット前の一時的な状態で機能しなくなる。この拡張機能はgitへの
 * 依存を他の機能でも持たせていない）。
 *
 * 復元が成り立たない形の差分（ハンク見出しが無い・宣言された行数と実際が食い違う）は
 * `undefined` / `ok: false` で返し、呼び出し側はそれを「操作を出さない」判断に使う
 * （issue #291の受入基準）。
 */

/** 呼び出し側が持つ `FileDiff` の最小形。util層はappserverの型に依存しない。 */
export interface DiffLike {
  kind: string;
  diff: string;
  movePath?: string | undefined;
}

export interface HunkLine {
  kind: 'context' | 'add' | 'remove';
  text: string;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: HunkLine[];
}

export interface ParsedUpdateDiff {
  hunks: Hunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * unified diffのハンクを読む。
 *
 * ハンク見出し（`@@ -a,b +c,d @@`）が1つも無い、または宣言された行数（`b`/`d`）と
 * 実際に並んでいる行数が食い違う場合は `undefined` を返す。Claude CodeのEdit入力から
 * 組み立てる差分（`src/claude/transcript.ts` の `editDiff`）は行番号を持たずハンク見出しが
 * 無い形で来るため、ここで確実に弾かれる（issue #291の受入基準どおり、複元できない形は
 * 操作を出さない側へ倒す）。
 */
export function parseUnifiedDiffHunks(diffText: string): ParsedUpdateDiff | undefined {
  const rawLines = diffText.split('\n');
  const hunks: Hunk[] = [];
  let i = 0;
  while (i < rawLines.length) {
    const headerLine = rawLines[i];
    const header = headerLine !== undefined ? HUNK_HEADER.exec(headerLine) : null;
    if (header === null) {
      // ハンク見出し以外の行（ファイル名見出し等）が先頭に来ることがあるため読み飛ばす。
      // 1つもハンクを読めないまま終端まで進んだら、下のsawHeaderチェックで弾かれる
      i++;
      continue;
    }
    const oldStart = Number(header[1]);
    const oldLines = header[2] !== undefined ? Number(header[2]) : 1;
    const newStart = Number(header[3]);
    const newLines = header[4] !== undefined ? Number(header[4]) : 1;
    i++;

    const lines: HunkLine[] = [];
    let oldCount = 0;
    let newCount = 0;
    while (i < rawLines.length) {
      const body = rawLines[i];
      if (body === undefined || HUNK_HEADER.test(body)) {
        break;
      }
      if (body.startsWith('+')) {
        lines.push({ kind: 'add', text: body.slice(1) });
        newCount++;
      } else if (body.startsWith('-')) {
        lines.push({ kind: 'remove', text: body.slice(1) });
        oldCount++;
      } else if (body.startsWith(' ')) {
        lines.push({ kind: 'context', text: body.slice(1) });
        oldCount++;
        newCount++;
      } else if (body === '' && i === rawLines.length - 1) {
        // 末尾改行で生まれた最後の空要素。ハンクの中身ではない
        break;
      } else {
        // 未知の行頭記号。壊れた/対応できない形式として扱う
        return undefined;
      }
      i++;
    }
    if (oldCount !== oldLines || newCount !== newLines) {
      // 宣言された行数と実際が食い違う。コンテキストが足りない・壊れた差分として扱う
      return undefined;
    }
    hunks.push({ oldStart, oldLines, newStart, newLines, lines });
  }
  return hunks.length === 0 ? undefined : { hunks };
}

/**
 * 現在の内容（変更後）へハンクを逆適用し、変更前の内容を作る。
 *
 * 各ハンクの文脈（context）行・追加（add）行が、宣言された行番号のとおり現在の内容に
 * 実在するかを確かめながら進める。一致しなければ「差分を取ったときから内容が変わった」と
 * 判断し `ok: false` を返す（issue #291の受入基準）。ハンクの外側（前後の文脈行）までは
 * 検証しない（unified diffの一般的な適用と同じ粒度）。
 */
export function reverseApplyHunks(
  currentContent: string,
  hunks: readonly Hunk[],
): { ok: true; before: string } | { ok: false; error: string } {
  const currentLines = currentContent.split('\n');
  const result: string[] = [];
  let cursor = 0;

  for (const hunk of hunks) {
    const startIdx = hunk.newStart - 1;
    if (startIdx < cursor || startIdx > currentLines.length) {
      return { ok: false, error: 'ハンクの位置がファイルの内容と一致しません' };
    }
    for (let k = cursor; k < startIdx; k++) {
      result.push(currentLines[k] ?? '');
    }
    cursor = startIdx;

    for (const line of hunk.lines) {
      if (line.kind === 'context') {
        if (currentLines[cursor] !== line.text) {
          return { ok: false, error: 'ファイルの内容が差分を取ったときから変わっています' };
        }
        result.push(line.text);
        cursor++;
      } else if (line.kind === 'add') {
        if (currentLines[cursor] !== line.text) {
          return { ok: false, error: 'ファイルの内容が差分を取ったときから変わっています' };
        }
        // 追加行は変更前には無い行なので出力には積まず、現在側の読み位置だけ進める
        cursor++;
      } else {
        // 削除行は変更前には有ったが変更後には無い行。出力には積むが読み位置は進めない
        result.push(line.text);
      }
    }
  }
  for (let k = cursor; k < currentLines.length; k++) {
    result.push(currentLines[k] ?? '');
  }
  return { ok: true, before: result.join('\n') };
}

/**
 * `add` / `delete` の差分本文（行頭が全て `+`／全て `-`）から、ファイル全体の内容を作る。
 *
 * `normalizeDiffBody`（`src/appserver/chatState.ts`）が整えたあとの形を前提にする。
 * 1行でも印が無い・違う印が混じっている場合は復元できない形として `ok: false` を返す。
 */
export function reconstructWholeFile(
  diffText: string,
  marker: '+' | '-',
): { ok: true; content: string } | { ok: false; error: string } {
  if (diffText === '') {
    return { ok: true, content: '' };
  }
  const rawLines = diffText.split('\n');
  const lines =
    rawLines.length > 0 && rawLines[rawLines.length - 1] === '' ? rawLines.slice(0, -1) : rawLines;
  if (lines.length === 0) {
    return { ok: true, content: '' };
  }
  const out: string[] = [];
  for (const line of lines) {
    if (!line.startsWith(marker)) {
      return { ok: false, error: '差分の形式を復元できません' };
    }
    out.push(line.slice(1));
  }
  return { ok: true, content: out.join('\n') };
}

/**
 * 変更前・変更後の内容の両方を作る。`currentContent` は対象パスの現在の内容
 * （ファイルが存在しなければ `undefined`）。
 *
 * `add`/`delete`/`update` それぞれで「現在の状態が差分の想定どおりか」を確かめてから
 * 返す（issue #291の受入基準: 消えている・変わっている場合は理由を出して何もしない）。
 */
export function computeDiffContents(
  diff: DiffLike,
  currentContent: string | undefined,
): { ok: true; before: string; after: string } | { ok: false; error: string } {
  if (diff.kind === 'add') {
    const parsed = reconstructWholeFile(diff.diff, '+');
    if (!parsed.ok) {
      return parsed;
    }
    if (currentContent === undefined) {
      return { ok: false, error: 'ファイルが見つかりません（既に削除されている可能性があります）' };
    }
    if (currentContent !== parsed.content) {
      return { ok: false, error: 'ファイルの内容が差分を取ったときから変わっています' };
    }
    return { ok: true, before: '', after: currentContent };
  }

  if (diff.kind === 'delete') {
    const parsed = reconstructWholeFile(diff.diff, '-');
    if (!parsed.ok) {
      return parsed;
    }
    if (currentContent !== undefined) {
      return {
        ok: false,
        error: 'ファイルが既に存在します（差分を取ったときから状況が変わっています）',
      };
    }
    return { ok: true, before: parsed.content, after: '' };
  }

  if (diff.kind === 'update') {
    const parsed = parseUnifiedDiffHunks(diff.diff);
    if (parsed === undefined) {
      return {
        ok: false,
        error: '差分の形式を復元できません（ハンク見出しが無い、またはコンテキストが足りません）',
      };
    }
    if (currentContent === undefined) {
      return { ok: false, error: 'ファイルが見つかりません（既に削除されている可能性があります）' };
    }
    const reversed = reverseApplyHunks(currentContent, parsed.hunks);
    if (!reversed.ok) {
      return reversed;
    }
    return { ok: true, before: reversed.before, after: currentContent };
  }

  return { ok: false, error: `種類が分からない差分は復元できません: ${diff.kind}` };
}

/** ある差分に対して出してよい操作。 */
export interface DiffActionAvailability {
  /** 「エディタで開く」。 */
  openEditor: boolean;
  /** 「差分を開く」。 */
  openDiff: boolean;
  /** 「この変更を戻す」。 */
  revert: boolean;
  /** 「エディタで開く」でジャンプする1-indexedの行番号。決められなければ `undefined`。 */
  jumpToLine: number | undefined;
}

/**
 * 差分の種類・本文だけから、出してよい操作を決める（issue #291の受入基準:
 * add/delete/update/移動のそれぞれで妥当に決める）。
 *
 * - `add`: ファイルは今の場所に実在する前提。エディタでは常に開ける（先頭へジャンプ）。
 *   差分・戻すは、差分本文が全て `+` 行として復元できるときだけ
 * - `delete`: ファイルは既に無い前提。エディタで開く対象が無いため出さない。
 *   差分・戻す（＝再作成）は、差分本文が全て `-` 行として復元できるときだけ
 * - `update`（移動を伴わない）: ハンクを解析できるときだけ、開く・差分・戻すの全てを出す。
 *   解析できない（見出しが無い・コンテキスト不足）ときは「エディタで開く」だけに絞る
 * - `update`（`movePath` を伴う）: 「戻す」はここでは出さない。移動そのものを安全に
 *   取り消す処理（改名＋内容の巻き戻しの二段操作）は、途中で失敗すると
 *   ファイルがどちらの場所にも正しく残らない状態を作りかねず、単純な書き戻しより
 *   リスクが高いと判断した（design.md §14.52の設計判断）。エディタで開く・差分を開くは
 *   移動後の場所（`movePath`）に対して引き続き出す
 * - 上記以外の種類（CLIが将来送りうる未知の種類）: 何が起きるか判断できないため
 *   「エディタで開く」だけに絞る
 */
export function planDiffActions(diff: DiffLike): DiffActionAvailability {
  if (diff.kind === 'add') {
    const parsed = reconstructWholeFile(diff.diff, '+');
    return { openEditor: true, openDiff: parsed.ok, revert: parsed.ok, jumpToLine: 1 };
  }
  if (diff.kind === 'delete') {
    const parsed = reconstructWholeFile(diff.diff, '-');
    return { openEditor: false, openDiff: parsed.ok, revert: parsed.ok, jumpToLine: undefined };
  }
  if (diff.kind === 'update') {
    const parsed = parseUnifiedDiffHunks(diff.diff);
    const reconstructable = parsed !== undefined;
    return {
      openEditor: true,
      openDiff: reconstructable,
      revert: reconstructable && diff.movePath === undefined,
      jumpToLine: parsed?.hunks[0]?.newStart,
    };
  }
  return { openEditor: true, openDiff: false, revert: false, jumpToLine: undefined };
}
