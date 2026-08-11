/**
 * 入力欄の `@` で出すファイル候補。
 *
 * TUIは `@` でワークスペースのファイルを補完できる。チャット画面でも同じことをする。
 *
 * **`.gitignore` は簡易解釈にとどめる。** 否定（`!`）・階層ごとの `.gitignore`・
 * `**` の複雑な組み合わせは扱わない。正確さより「生成物が候補を埋め尽くさないこと」を取る。
 * 読めなかった行は無視する（除外し損ねて候補に出るほうが、間違って消すよりまし）。
 */

/** 走査そのものを止めるディレクトリ。`.gitignore` が無いリポジトリでも効かせる。 */
export const DEFAULT_IGNORE_DIRS: readonly string[] = [
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage',
  'vendor',
  'target',
  '.next',
  '.nuxt',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.gradle',
  '.idea',
];

/** 候補として持つ上限。これを超える巨大なツリーは頭打ちにする。 */
const SCAN_LIMIT = 20_000;

/** 走査し直さずに使い回す時間。`@` の連打で毎回歩かないための間隔。 */
const CACHE_MS = 5_000;

export interface IgnoreRules {
  /** この名前のディレクトリには入らない。 */
  dirNames: Set<string>;
  /** ワークスペース相対パスに当てる。当たったら候補から外す。 */
  patterns: RegExp[];
}

/** ファイル走査の口。VSCode APIにもnode:fsにも依存させない。 */
export interface FileScanPort {
  /**
   * `dir` 配下を再帰的に走査し、`dir` からの相対パスを返す。
   * `skipDir` が真を返した名前のディレクトリには入らない。
   */
  scan(dir: string, options: { skipDir(name: string): boolean; limit: number }): Promise<string[]>;
  /** ファイル全体をUTF-8で読む。無ければ undefined。 */
  readText(filePath: string): Promise<string | undefined>;
}

const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/** globを正規表現の断片へ。`*` は階層を跨がず、`**` は跨ぐ。 */
function globSource(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c !== '*') {
      out += c === '?' ? '[^/]' : c.replace(REGEXP_SPECIALS, '\\$&');
      continue;
    }
    if (glob[i + 1] !== '*') {
      out += '[^/]*';
      continue;
    }
    // `**/` は「0段以上のディレクトリ」。末尾の `**` はその先すべて
    if (glob[i + 2] === '/') {
      out += '(?:.*/)?';
      i += 2;
    } else {
      out += '.*';
      i += 1;
    }
  }
  return out;
}

/**
 * 1行を正規表現にする。
 *
 * gitの規則に合わせ、**行の途中に `/` があるものはワークスペース直下からの相対パス**として
 * 当てる。`/` を含まないものはどの階層のファイル名にも当てるため、前に「0段以上の
 * ディレクトリ」を足す。
 */
function lineToPattern(body: string, anchored: boolean): RegExp {
  const prefix = anchored ? '' : '(?:.*/)?';
  return new RegExp(`^${prefix}${globSource(body)}$`);
}

const hasGlob = (value: string): boolean => value.includes('*') || value.includes('?');

/** `.gitignore` の中身を簡易解釈する。読めない行は落とす。 */
export function parseGitignore(content: string): IgnoreRules {
  const dirNames = new Set<string>();
  const patterns: RegExp[] = [];

  for (const raw of content.split('\n')) {
    const line = raw.trim();
    // 空行・コメント・否定は扱わない
    if (line === '' || line.startsWith('#') || line.startsWith('!')) {
      continue;
    }

    const rooted = line.startsWith('/');
    const body = rooted ? line.slice(1) : line;
    if (body === '') {
      continue;
    }

    if (body.endsWith('/')) {
      const dir = body.slice(0, -1);
      // 単純な名前だけなら走査を止められる。階層やglobを含むものはパターンで判断する
      if (!dir.includes('/') && !hasGlob(dir)) {
        dirNames.add(dir);
        continue;
      }
      patterns.push(lineToPattern(`${dir}/**`, rooted || dir.includes('/')));
      continue;
    }

    patterns.push(lineToPattern(body, rooted || body.includes('/')));
  }

  return { dirNames, patterns };
}

/** 既定の除外と `.gitignore` 由来の規則を1つにまとめる。 */
export function mergeIgnoreRules(...all: readonly IgnoreRules[]): IgnoreRules {
  const dirNames = new Set<string>();
  const patterns: RegExp[] = [];
  for (const rules of all) {
    for (const name of rules.dirNames) {
      dirNames.add(name);
    }
    patterns.push(...rules.patterns);
  }
  return { dirNames, patterns };
}

/** 既定の除外だけを持つ規則。 */
export function defaultIgnoreRules(): IgnoreRules {
  return { dirNames: new Set(DEFAULT_IGNORE_DIRS), patterns: [] };
}

/** 相対パスが除外に当たるか。 */
export function isIgnored(relPath: string, rules: IgnoreRules): boolean {
  const segments = relPath.split('/');
  // 最後の要素はファイル名なので、途中のディレクトリ名だけを見る
  for (let i = 0; i < segments.length - 1; i++) {
    if (rules.dirNames.has(segments[i] as string)) {
      return true;
    }
  }
  return rules.patterns.some((pattern) => pattern.test(relPath));
}

/**
 * 候補を絞り込む。
 *
 * ファイル名の前方一致を最優先にする。パスの途中を打った場合（`provider/`）も拾えるよう、
 * 相対パス全体に対する一致も見る。
 */
export function filterFiles(files: readonly string[], query: string, limit: number): string[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') {
    return files.slice(0, limit);
  }

  const nameHead: string[] = [];
  const pathHead: string[] = [];
  const nameRest: string[] = [];
  const pathRest: string[] = [];

  for (const file of files) {
    const lower = file.toLowerCase();
    const name = lower.slice(lower.lastIndexOf('/') + 1);
    if (name.startsWith(needle)) {
      nameHead.push(file);
    } else if (lower.startsWith(needle)) {
      pathHead.push(file);
    } else if (name.includes(needle)) {
      nameRest.push(file);
    } else if (lower.includes(needle)) {
      pathRest.push(file);
    }
  }

  return [...nameHead, ...pathHead, ...nameRest, ...pathRest].slice(0, limit);
}

/**
 * ワークスペースのファイル一覧。
 *
 * `@` を打つたびに聞かれるため、短い間はキャッシュを返す。エージェント自身が作った
 * ファイルをすぐ候補に出したいので、キャッシュは数秒に留める。
 */
export class FileMentionCatalog {
  private cache: { cwd: string; at: number; files: string[] } | undefined;

  constructor(
    private readonly port: FileScanPort,
    private readonly now: () => number = Date.now,
  ) {}

  async list(cwd: string): Promise<string[]> {
    const cached = this.cache;
    if (cached !== undefined && cached.cwd === cwd && this.now() - cached.at < CACHE_MS) {
      return cached.files;
    }

    const content = (await this.port.readText(`${cwd}/.gitignore`)) ?? '';
    const rules = mergeIgnoreRules(defaultIgnoreRules(), parseGitignore(content));
    const found = await this.port.scan(cwd, {
      skipDir: (name) => rules.dirNames.has(name),
      limit: SCAN_LIMIT,
    });
    const files = found.filter((relPath) => !isIgnored(relPath, rules));

    this.cache = { cwd, at: this.now(), files };
    return files;
  }
}
