import { effortsFor, type ModelInfo } from '../codex/modelCatalog';
import type { SessionHandoffModelOption } from './sessionHub';

/**
 * Mission Controlの設定欄（Issue #2159）に出すmodelの候補。先頭は既定（`slug: ''`）。
 *
 * 今のmodelが一覧に無い（設定パネルで直接書いた名前など）ときは、それも候補へ足す。
 * 落とすと、選び直していないのに画面の選択が別のmodelへずれる。
 *
 * @param fallback 一覧が取れないときのeffort。Claudeは`CLAUDE_EFFORTS`、Codexは既定のまま。
 */
export function buildSettingModelOptions(
  models: ModelInfo[],
  current: string,
  fallback?: readonly string[],
): SessionHandoffModelOption[] {
  const efforts = (slug: string): string[] =>
    fallback === undefined ? effortsFor(models, slug) : effortsFor(models, slug, fallback);
  const options: SessionHandoffModelOption[] = [{ slug: '', label: '既定', efforts: efforts('') }];
  for (const model of models) {
    options.push({
      slug: model.slug,
      label: model.displayName === '' ? model.slug : model.displayName,
      efforts: efforts(model.slug),
    });
  }
  if (current !== '' && !options.some((o) => o.slug === current)) {
    options.push({ slug: current, label: current, efforts: efforts(current) });
  }
  return options;
}
