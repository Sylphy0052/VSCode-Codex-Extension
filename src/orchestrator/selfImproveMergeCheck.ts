import { detectRoadmapForgeHost, type RoadmapRunForgePorts } from './roadmapRunForge';
import {
  parseProtectedPaths,
  SELF_IMPROVE_LABEL,
  SELF_IMPROVE_PROTECTED_PATHS_FILE,
  selfImproveMergeDenial,
} from './selfImproveGuard';

/**
 * PRのmerge前に、自己改善PRが保護パスに触れていないか確かめる（Issue #2082）。
 * ラベルと変更ファイルは`gh`で取り、保護パスの一覧はPRの変更で空にされないよう`origin/main`のものを読む。
 * 拒否しなくてよければ`undefined`、拒否する理由か確かめられなかった理由を返す（GitHub以外のforgeは対象外）。
 */
export async function checkSelfImproveMerge(
  ports: RoadmapRunForgePorts,
  repoRoot: string,
  pullRequestNumber: number,
): Promise<string | undefined> {
  if ((await detectRoadmapForgeHost(ports, repoRoot)) !== 'github') {
    return undefined;
  }
  const n = String(pullRequestNumber);
  const view = await ports.cli.run('gh', ['pr', 'view', n, '--json', 'labels'], repoRoot);
  if (view.code !== 0) {
    return `PR #${n}のラベルを取得できず、自己改善PRか確かめられないためmergeできない`;
  }
  const labels = parseLabels(view.stdout);
  if (labels === undefined) {
    return `PR #${n}のラベルを解釈できず、自己改善PRか確かめられないためmergeできない`;
  }
  // ラベルが無ければファイルと一覧は要らない（人の依頼の通常の実装は従来どおり）
  if (!labels.includes(SELF_IMPROVE_LABEL)) {
    return undefined;
  }
  const filesResult = await ports.cli.run(
    'gh',
    ['api', '--paginate', `repos/{owner}/{repo}/pulls/${n}/files`, '--jq', '.[].filename'],
    repoRoot,
  );
  const listResult = await ports.git.run(
    ['show', `origin/main:${SELF_IMPROVE_PROTECTED_PATHS_FILE}`],
    repoRoot,
  );
  if (filesResult.code !== 0 || listResult.code !== 0) {
    return `自己改善PR #${n}の変更ファイルか保護パスの一覧を取得できず、保護パスに触れていないか確かめられないためmergeできない`;
  }
  const files = filesResult.stdout.split('\n').filter((l) => l !== '');
  return selfImproveMergeDenial(labels, files, parseProtectedPaths(listResult.stdout));
}

function parseLabels(stdout: string): string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    const labels = (parsed as { labels?: unknown } | null)?.labels;
    if (!Array.isArray(labels)) {
      return undefined;
    }
    return labels.flatMap((l: unknown) => {
      const name = (l as { name?: unknown } | null)?.name;
      return typeof name === 'string' ? [name] : [];
    });
  } catch {
    return undefined;
  }
}
