/**
 * 個人plugin（別repo、`~/.claude`へ同期され全プロジェクトに効く）向けの改善を、そのrepoの
 * ロードマップへ自律で起票する（Issue #2089）。
 *
 * - 自律で起票してよいのはplugin内のskill本文の改善だけ。hook・設定・規約・スクリプトの改善は
 *   調査Issueのチェックリストへ提案として残す（全プロジェクトへ影響するため人が判断する）。
 * - 起票したIssueは、ロードマップIssueの本文のREADY一覧へ追加する（ラベルは付けない。無人の自動
 *   サイクルは本文の一覧から着手するため、ラベルだけでは拾われない）。
 * - 起票する文は#2085のマスク（`maskForGithub`）を通し、他repoの非公開情報を含めない。
 *
 * `vscode`にも入出力にも依存しない。入出力は`PluginRoadmapForge`の口で受ける。
 */

import { decideIssueFiling, maskForGithub, type RepoVisibility } from './lessonPromotion';
import type { LessonRecord, LessonSource } from './runNotes';

/** skill本文のパス（`skills/<名前>/`の下のMarkdown）。repo直下でも`claude-home/`の下でもよい。 */
const SKILL_BODY_PATTERN = /^(?:[^/]+\/)?skills\/[^/]+\/.+\.md$/;

/** パスに`..`や絶対パスを含まない、素直なrepo内の相対パスか。 */
function isPlainRelativePath(file: string): boolean {
  return (
    file.length > 0 &&
    !file.startsWith('/') &&
    !file.includes('\\') &&
    !file.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')
  );
}

/** 変えるファイルがすべてskill本文なら`skill`。1つでも外れる（空を含む）なら`other`。 */
export function classifyPluginFiles(files: readonly string[]): 'skill' | 'other' {
  if (files.length === 0) {
    return 'other';
  }
  return files.every((f) => isPlainRelativePath(f) && SKILL_BODY_PATTERN.test(f))
    ? 'skill'
    : 'other';
}

export interface PluginImprovementCandidate {
  /** 冪等キー。同じ改善を二重に起票しないために本文へ載せる。 */
  key: string;
  title: string;
  /** 何をどう直すか（自由文。マスクを通して出す）。 */
  body: string;
  /** 変えるplugin内のファイル。 */
  files: readonly string[];
  /** 根拠にした教訓の出典。 */
  source: LessonSource;
}

export interface PluginIssueRef {
  issueNumber: number;
  body: string;
}

/** 同期の状態。pluginのcommitと`~/.claude`へ同期済みのcommitの一致。 */
export interface PluginSyncState {
  /** pluginのrepoの最新commit。取れなければ`undefined`。 */
  pluginHead: string | undefined;
  /** `~/.claude`へ同期済みのcommit。取れなければ`undefined`。 */
  installed: string | undefined;
}

export function describeSyncState(sync: PluginSyncState): string {
  const short = (v: string | undefined): string => (v === undefined ? '不明' : v.slice(0, 12));
  const verdict =
    sync.pluginHead === undefined || sync.installed === undefined
      ? '確かめられない'
      : sync.pluginHead === sync.installed
        ? '一致'
        : '不一致（同期前の可能性がある）';
  return `plugin最新=${short(sync.pluginHead)}、~/.claude同期済み=${short(sync.installed)}、${verdict}`;
}

export interface PluginRoadmapForge {
  repoVisibility(repo: string): Promise<RepoVisibility>;
  /** ロードマップIssue（ラベル付きの1本）。無ければ`undefined`、確かめられなければ`'error'`。 */
  readRoadmap(repo: string): Promise<PluginIssueRef | undefined | 'error'>;
  /** 調査Issue（提案を溜める1本）。無ければ`undefined`、確かめられなければ`'error'`。 */
  readResearch(repo: string): Promise<PluginIssueRef | undefined | 'error'>;
  /** 冪等キーを本文に含むIssue（ロードマップ・調査を除く）。 */
  findIssueByKey(repo: string, key: string): Promise<number | undefined | 'error'>;
  /** ラベル無しでIssueを作る。 */
  createIssue(
    repo: string,
    issue: { title: string; body: string },
  ): Promise<{ ok: true; issueNumber: number } | { ok: false; message: string }>;
  /** 調査Issueが無いときに作る（`research`ラベル付き）。 */
  createResearchIssue(
    repo: string,
    issue: { title: string; body: string },
  ): Promise<{ ok: true; issueNumber: number } | { ok: false; message: string }>;
  updateIssueBody(repo: string, issueNumber: number, body: string): Promise<boolean>;
  readHeadCommit(repo: string): Promise<string | undefined>;
}

export interface PluginRoadmapDeps {
  /** pluginのrepo（`owner/name`）。 */
  repo: string;
  forge: PluginRoadmapForge;
  /** 今のrunから出た、plugin向けの改善の候補。 */
  candidates(): Promise<readonly PluginImprovementCandidate[]>;
  /** `~/.claude`へ同期済みのpluginのcommit。取れなければ`undefined`。 */
  installedCommit(): Promise<string | undefined>;
}

const READY_HEADING = /^#{1,6}\s*READY\b/i;
const LIST_LINE = /^\s*[-*]\s/;

/**
 * ロードマップ本文のREADY一覧へ行を足す。READYの見出しがあればその一覧の末尾、無ければ本文の
 * 末尾へ。同じ行（Issue番号が同じ）は足さない。
 */
export function appendToRoadmapReady(
  body: string,
  issueNumber: number,
  title: string,
): { body: string; added: boolean } {
  const ref = new RegExp(`(^|[^\\w])#${String(issueNumber)}(?!\\d)`);
  if (body.split('\n').some((l) => LIST_LINE.test(l) && ref.test(l))) {
    return { body, added: false };
  }
  const line = `- [ ] #${String(issueNumber)} ${title.replace(/\s+/g, ' ').trim()}`;
  const lines = body.split('\n');
  const heading = lines.findIndex((l) => READY_HEADING.test(l));
  if (heading < 0) {
    const sep = body.endsWith('\n') || body === '' ? '' : '\n';
    return { body: `${body}${sep}${line}\n`, added: true };
  }
  let at = heading + 1;
  let last = heading;
  while (at < lines.length && !/^#{1,6}\s/.test(lines[at] ?? '')) {
    if (LIST_LINE.test(lines[at] ?? '')) {
      last = at;
    }
    at += 1;
  }
  lines.splice(last + 1, 0, line);
  return { body: lines.join('\n'), added: true };
}

/** 調査Issueのチェックリストへ提案を足す。同じキーは足さない。 */
export function appendResearchItem(
  body: string,
  key: string,
  title: string,
): { body: string; added: boolean } {
  if (body.includes(key)) {
    return { body, added: false };
  }
  const line = `- [ ] ${title.replace(/\s+/g, ' ').trim()}（${key}）`;
  const sep = body.endsWith('\n') || body === '' ? '' : '\n';
  return { body: `${body}${sep}${line}\n`, added: true };
}

export interface PluginRoadmapResult {
  /** 判断の記録（1件1行）。 */
  notes: string[];
}

function keyMarker(key: string): string {
  return `<!-- self-improve-key: ${key} -->`;
}

/** 候補を処理する。失敗は止めずに記録へ残し、次の候補へ進む。 */
export async function fileToPluginRoadmap(deps: PluginRoadmapDeps): Promise<PluginRoadmapResult> {
  const { repo, forge } = deps;
  const notes: string[] = [];
  const sync: PluginSyncState = {
    pluginHead: await forge.readHeadCommit(repo),
    installed: await deps.installedCommit(),
  };
  notes.push(`同期の状態: ${describeSyncState(sync)}`);

  const candidates = await deps.candidates();
  if (candidates.length === 0) {
    notes.push('plugin向けの改善の候補が無い');
    return { notes };
  }
  const visibility = await forge.repoVisibility(repo);
  const mask = (text: string): string => maskForGithub(text, { ownRepo: repo });

  for (const c of candidates) {
    const decision = decideIssueFiling({ source: c.source }, visibility);
    if (!decision.ok) {
      notes.push(`${c.key}: ${decision.reason}`);
      continue;
    }
    const existing = await forge.findIssueByKey(repo, c.key);
    if (existing === 'error') {
      notes.push(`${c.key}: 既存のIssueを確かめられないため起票しない`);
      continue;
    }
    const title = mask(c.title);
    if (existing !== undefined) {
      // 前回、起票は済んだがロードマップ本文の更新に失敗した場合に備え、skill本文の改善なら載せ直す
      notes.push(
        classifyPluginFiles(c.files) === 'skill'
          ? await ensureOnRoadmap(deps, c.key, existing, title)
          : `${c.key}: #${String(existing)}で起票済み`,
      );
      continue;
    }
    const body = `${mask(c.body)}\n\n${keyMarker(c.key)}\n`;
    if (classifyPluginFiles(c.files) === 'skill') {
      notes.push(await fileSkillImprovement(deps, c.key, title, body));
    } else {
      notes.push(await fileResearchProposal(deps, c.key, title));
    }
  }
  return { notes };
}

async function ensureOnRoadmap(
  deps: PluginRoadmapDeps,
  key: string,
  issueNumber: number,
  title: string,
): Promise<string> {
  const { repo, forge } = deps;
  const roadmap = await forge.readRoadmap(repo);
  if (roadmap === undefined || roadmap === 'error') {
    return `${key}: #${String(issueNumber)}で起票済み。ロードマップを読めず載っているか確かめられない`;
  }
  const next = appendToRoadmapReady(roadmap.body, issueNumber, title);
  if (!next.added) {
    return `${key}: #${String(issueNumber)}で起票済み`;
  }
  return (await forge.updateIssueBody(repo, roadmap.issueNumber, next.body))
    ? `${key}: #${String(issueNumber)}が未掲載だったため、ロードマップ#${String(roadmap.issueNumber)}へ載せ直した`
    : `${key}: #${String(issueNumber)}をロードマップ#${String(roadmap.issueNumber)}へ載せ直せなかった`;
}

async function fileSkillImprovement(
  deps: PluginRoadmapDeps,
  key: string,
  title: string,
  body: string,
): Promise<string> {
  const { repo, forge } = deps;
  const roadmap = await forge.readRoadmap(repo);
  if (roadmap === undefined || roadmap === 'error') {
    return `${key}: pluginのロードマップIssueを読めないため起票しない`;
  }
  const created = await forge.createIssue(repo, { title, body });
  if (!created.ok) {
    return `${key}: 起票できない: ${created.message}`;
  }
  const next = appendToRoadmapReady(roadmap.body, created.issueNumber, title);
  if (next.added && !(await forge.updateIssueBody(repo, roadmap.issueNumber, next.body))) {
    return `${key}: #${String(created.issueNumber)}を起票したが、ロードマップ#${String(roadmap.issueNumber)}の本文へ載せられなかった`;
  }
  return `${key}: skill本文の改善#${String(created.issueNumber)}を起票し、ロードマップ#${String(roadmap.issueNumber)}へ載せた`;
}

async function fileResearchProposal(
  deps: PluginRoadmapDeps,
  key: string,
  title: string,
): Promise<string> {
  const { repo, forge } = deps;
  const research = await forge.readResearch(repo);
  if (research === 'error') {
    return `${key}: 調査Issueを読めないため提案を残さない`;
  }
  if (research === undefined) {
    const item = appendResearchItem('', key, title);
    const created = await forge.createResearchIssue(repo, {
      title: '提案: pluginのskill本文以外の改善（人が判断）',
      body: item.body,
    });
    return created.ok
      ? `${key}: skill本文以外のため、調査Issue#${String(created.issueNumber)}へ提案として残した`
      : `${key}: 調査Issueを作れない: ${created.message}`;
  }
  const next = appendResearchItem(research.body, key, title);
  if (next.added && !(await forge.updateIssueBody(repo, research.issueNumber, next.body))) {
    return `${key}: 調査Issue#${String(research.issueNumber)}の本文を更新できない`;
  }
  return `${key}: skill本文以外のため、調査Issue#${String(research.issueNumber)}へ提案として残した`;
}

/** 教訓の文中に現れる、plugin内のファイルらしいパス。 */
const PLUGIN_PATH_TOKEN =
  /(?:claude-home\/)?(?:skills|hooks|rules|scripts|bin|docs)\/[\w.-]+(?:\/[\w.-]+)*|(?:claude-home\/)?(?:settings\.json|CLAUDE\.md)/g;

/**
 * このrunの教訓から、plugin向けの改善の候補を作る。文中にpluginのファイルらしいパスが無い教訓は
 * このrepo向けなので候補にしない。出典は教訓の記録のまま（無ければ`external`）。
 */
export function candidatesFromLessons(
  lessons: readonly LessonRecord[],
  runId: string,
): PluginImprovementCandidate[] {
  const out: PluginImprovementCandidate[] = [];
  for (const lesson of lessons) {
    if (lesson.runId !== runId) {
      continue;
    }
    const text = [lesson.observation, lesson.instruction, ...lesson.evidence].join('\n');
    const files = [...new Set(text.match(PLUGIN_PATH_TOKEN) ?? [])];
    if (files.length === 0) {
      continue;
    }
    out.push({
      key: `plugin-lesson-${lesson.id.slice(0, 8)}`,
      title: `plugin: ${lesson.instruction.replace(/\s+/g, ' ').trim().slice(0, 60)}`,
      body: `観察: ${lesson.observation}\n\n改善: ${lesson.instruction}\n\n対象: ${files.join(', ')}`,
      files,
      source: lesson.source ?? 'external',
    });
  }
  return out;
}
