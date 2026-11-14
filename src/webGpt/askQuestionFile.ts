import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** 議題の文字数上限。`buildWebGptDiscussionPrompt`の検証と同じ値（Issue #2057）。 */
export const ASK_QUESTION_TOPIC_MAX_LENGTH = 12000;

/** 読み込むファイルの大きさの上限。これを超えるものは読まずに断る。 */
const ASK_QUESTION_MAX_BYTES = 1024 * 1024;

const ASK_QUESTION_NAME = /^ask-[A-Za-z0-9][A-Za-z0-9-]*\.md$/;

/**
 * `filePath`が`root`直下の`docs/chatgpt/ask-<slug>.md`（連番付きを含む）か（Issue #2057）。
 * 文字列だけの判定。リポジトリ外・別の場所・`docs/chatgpt/`の入れ子は一致しない。
 * シンボリックリンクは`readAskQuestionTopic`が実ファイルで確かめる。
 */
export function isAskQuestionFilePath(root: string, filePath: string): boolean {
  if (root === '' || filePath === '') return false;
  const rel = path.relative(root, path.resolve(root, filePath));
  const parts = rel.split(path.sep);
  return (
    parts.length === 3 &&
    parts[0] === 'docs' &&
    parts[1] === 'chatgpt' &&
    ASK_QUESTION_NAME.test(parts[2] ?? '')
  );
}

export type TopicCheck = { ok: true; topic: string } | { ok: false; message: string };

/** 本文を議題にできるか。切り詰めて送らず、上限を超えたら超過字数を示して断る。 */
export function checkAskQuestionTopic(content: string): TopicCheck {
  const topic = content.trim();
  if (topic === '') {
    return { ok: false, message: '質問ファイルが空です' };
  }
  if (topic.length > ASK_QUESTION_TOPIC_MAX_LENGTH) {
    const excess = topic.length - ASK_QUESTION_TOPIC_MAX_LENGTH;
    return {
      ok: false,
      message: `質問ファイルが議題の上限（${ASK_QUESTION_TOPIC_MAX_LENGTH}文字）を${excess}文字超えています。質問ファイルを短くしてから、もう一度押してください`,
    };
  }
  return { ok: true, topic };
}

export type AskQuestionRead =
  { ok: true; topic: string; absolutePath: string } | { ok: false; message: string };

/**
 * 質問ファイルを読み、議題として使える本文を返す（Issue #2057）。
 * `roots`のどれかの直下にあるものだけを対象にし、シンボリックリンクは読まない。
 */
export async function readAskQuestionTopic(
  roots: readonly string[],
  filePath: string,
): Promise<AskQuestionRead> {
  const root = roots.find((r) => isAskQuestionFilePath(r, filePath));
  if (root === undefined) {
    return { ok: false, message: 'この作業フォルダ直下のdocs/chatgpt/ask-*.mdではありません' };
  }
  const absolutePath = path.resolve(root, filePath);
  try {
    for (const target of [
      path.join(root, 'docs'),
      path.join(root, 'docs', 'chatgpt'),
      absolutePath,
    ]) {
      if ((await fs.lstat(target)).isSymbolicLink()) {
        return { ok: false, message: `シンボリックリンクは対象外です: ${target}` };
      }
    }
    // 判定と読み込みの間にシンボリックリンクへ差し替えられても辿らないよう、`O_NOFOLLOW`で開き、
    // 同じファイル記述子で種別・大きさを確かめて読む（lstatの後にreadFileする形だと競合する）
    const handle = await fs.open(absolutePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        return { ok: false, message: `通常のファイルではありません: ${absolutePath}` };
      }
      if (stat.size > ASK_QUESTION_MAX_BYTES) {
        return {
          ok: false,
          message: '質問ファイルが大きすぎます。短くしてから、もう一度押してください',
        };
      }
      // 開いた後に親ディレクトリが差し替えられていないか、実体のパスで確かめる
      const expected = path.join(
        await fs.realpath(root),
        'docs',
        'chatgpt',
        path.basename(absolutePath),
      );
      if ((await fs.realpath(absolutePath)) !== expected) {
        return { ok: false, message: `作業フォルダの外を指しています: ${absolutePath}` };
      }
      const checked = checkAskQuestionTopic(await handle.readFile('utf8'));
      return checked.ok ? { ok: true, topic: checked.topic, absolutePath } : checked;
    } finally {
      await handle.close();
    }
  } catch (error) {
    return {
      ok: false,
      message: `質問ファイルを読めませんでした: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
