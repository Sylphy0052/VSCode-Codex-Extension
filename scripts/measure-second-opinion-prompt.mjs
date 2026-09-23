// セカンドオピニオンのプロンプト本文が、差分の目次化でどれだけ小さくなるかを実測する
// （Issue #1322 受入基準5）。
//
// なぜ拡張機能を通さないのか:
// 受入基準5が問うているのは「同じ差分から組み立てたプロンプト本文が、変更前後でどれだけ
// 変わるか」と「指摘が明らかに劣化していないか」の2点で、どちらもプロンプトの組み立てと
// CLIの応答で決まる。VSCodeを起動しなくても、本番の `captureWorkspaceSnapshot` /
// `buildSecondOpinionPrompt` / `createReviewBundle` をそのまま呼べば同じ本文が得られる。
//
// なぜ scripts/ に置くのか:
// `--consult` を付けるとモデルを実際に呼ぶ。CIの external-cli ジョブには認証情報が無く、
// テストとして置くと恒常的に赤になる（`measure-contract-history.mjs` と同じ理由）。
// `--consult` 無しの本文の比較だけなら認証も利用枠も要らない。
//
// 使い方:
//   node scripts/measure-second-opinion-prompt.mjs --base HEAD~20
//   node scripts/measure-second-opinion-prompt.mjs --base HEAD~20 --consult
//   node scripts/measure-second-opinion-prompt.mjs --base origin/main --out /tmp/1322
//
// 出力:
//   - 各モード（inline = 変更前 / index = 変更後）の本文の文字数・概算トークン・段階
//   - `--out` を渡すと本文そのものと、`--consult` のときは回答も書き出す
//
// 本文の組み立ては本番実装をesbuildでその場にバンドルして読み込む。計測用に写すと、
// 本番が送る本文と食い違っても気づけないため。
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';

const CODEX_BIN = process.env.CODEX_BIN ?? 'codex';

/** 相談1回を待つ上限。差分を読ませるため、`measure-contract-history.mjs` より長く取る。 */
const CONSULT_TIMEOUT_MS = 15 * 60_000;

/** `--consult` で送る依頼文。両モードで同じものを使う（比べたいのは材料の渡し方だけ）。 */
const CONSULT_REQUEST =
  'この変更をレビューしてください。特に設計上の欠陥、見落とし、より単純な代替案を挙げてください。';

function parseArgs(argv) {
  const args = {
    base: 'HEAD~20',
    cwd: process.cwd(),
    out: undefined,
    consult: false,
    model: 'gpt-6-sol',
    effort: 'medium',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--consult') {
      args.consult = true;
    } else if (arg === '--base' || arg === '--cwd' || arg === '--out' || arg === '--model') {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error(`${arg} には値が要ります`);
      }
      args[arg.slice(2)] = value;
      i += 1;
    } else if (arg === '--effort') {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error('--effort には値が要ります');
      }
      args.effort = value;
      i += 1;
    } else {
      throw new Error(`知らない引数です: ${arg}`);
    }
  }
  return args;
}

/**
 * 本番の実装を読み込む。
 *
 * `snapshot.ts` / `prompt.ts` / `reviewBundle.ts` / `diffIndex.ts` は `vscode` を使わない
 * （使うのは view 層だけ）。設定の読み出し（`config.ts`）は `vscode` に依存するため通さず、
 * 既定の閾値だけを `diffIndex.ts` から取る。
 */
async function loadProductionModules() {
  const outDir = mkdtempSync(join(tmpdir(), 'second-opinion-prompt-bundle-'));
  const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/secondOpinion');
  const esbuild = await import('esbuild');
  const require = createRequire(import.meta.url);
  const build = async (name) => {
    const outFile = join(outDir, `${name}.cjs`);
    await esbuild.build({
      entryPoints: [join(srcDir, `${name}.ts`)],
      bundle: true,
      format: 'cjs',
      platform: 'node',
      external: ['vscode'],
      outfile: outFile,
    });
    return require(outFile);
  };
  return {
    snapshot: await build('snapshot'),
    prompt: await build('prompt'),
    reviewBundle: await build('reviewBundle'),
    diffIndex: await build('diffIndex'),
    cleanup: () => rmSync(outDir, { recursive: true, force: true }),
  };
}

/** `GitCommandRunner` のNode実装（`src/orchestrator/worktree.ts` と同じ形）。 */
const git = {
  run: (args, cwd) =>
    new Promise((resolvePromise) => {
      const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', (e) => resolvePromise({ code: 1, stdout: '', stderr: String(e) }));
      child.on('close', (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
    }),
};

/** `codex exec` を1回だけ走らせて最終出力を受け取る。 */
function runCodexExec(prompt, cwd, model, effort) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      CODEX_BIN,
      [
        'exec',
        '--cd',
        cwd,
        '--sandbox',
        'read-only',
        // 材料だけを置いた一時ディレクトリはgitリポジトリではない。拡張機能側は
        // `codex app-server` 経由で開くためこの確認に掛からないが、`codex exec` は掛かる
        '--skip-git-repo-check',
        '--model',
        model,
        '-c',
        `model_reasoning_effort="${effort}"`,
        '-',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`codex exec がタイムアウトしました（${CONSULT_TIMEOUT_MS}ms）`));
    }, CONSULT_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`codex exec が終了コード ${code} で落ちました: ${stderr.slice(-2000)}`));
        return;
      }
      resolvePromise(stdout);
    });
    child.stdin.end(prompt);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const modules = await loadProductionModules();
  try {
    const captured = await modules.snapshot.captureWorkspaceSnapshot(args.cwd, git, {
      baseCommit: args.base,
    });
    if (!captured.ok) {
      throw new Error(`スナップショットを取れませんでした: ${captured.reason}`);
    }
    const artifact = { kind: 'workspaceChanges', snapshot: captured.snapshot };
    const thresholds = modules.diffIndex.DEFAULT_DIFF_PRESENTATION_THRESHOLDS;
    const modes = [
      // 変更前（Issue #1322 以前）。差分の全文を本文へ貼る
      { name: 'inline', diffPresentation: undefined },
      // 変更後。量に応じて目次へ切り替える
      { name: 'index', diffPresentation: thresholds },
    ];

    if (args.out !== undefined) {
      mkdirSync(args.out, { recursive: true });
    }

    const built = modes.map((mode) => {
      const input = {
        userRequest: CONSULT_REQUEST,
        artifact,
        ...(mode.diffPresentation === undefined ? {} : { diffPresentation: mode.diffPresentation }),
      };
      const text = modules.prompt.buildSecondOpinionPrompt(input);
      return {
        name: mode.name,
        text,
        tier: modules.prompt.resolveDiffPresentationTier(input),
      };
    });

    console.log(`base=${args.base} cwd=${args.cwd}`);
    console.log(
      `diff: files=${captured.snapshot.diffIndex?.entries.length ?? 0} ` +
        `+${captured.snapshot.diffIndex?.totalAdded ?? 0}/-${captured.snapshot.diffIndex?.totalDeleted ?? 0} ` +
        `bytes=${captured.snapshot.diffIndex?.totalBytes ?? 0} ` +
        `untracked=${captured.snapshot.untrackedFiles.length}`,
    );
    for (const item of built) {
      console.log(
        `${item.name}: tier=${item.tier} chars=${item.text.length} ` +
          `tokens≈${modules.diffIndex.estimateTokens(item.text)}`,
      );
      if (args.out !== undefined) {
        writeFileSync(join(args.out, `prompt-${item.name}.md`), item.text, 'utf8');
      }
    }
    const [before, after] = built;
    console.log(
      `削減: chars ${before.text.length} → ${after.text.length} ` +
        `(${(((before.text.length - after.text.length) / before.text.length) * 100).toFixed(1)}%減)`,
    );

    if (!args.consult) {
      return;
    }

    // 相談は本番と同じ材料の上で走らせる（`changes.diff` / `base/` / `untracked/`）。
    // 目次だけを渡して参照先が無い状態で測ると、読めないことを劣化として数えてしまう
    const root = join(tmpdir(), 'second-opinion-prompt-measure');
    for (const item of built) {
      const bundle = await modules.reviewBundle.createReviewBundle({
        root,
        cwd: args.cwd,
        git,
        baseCommit: captured.snapshot.baseCommit,
        fullDiff: captured.material.fullDiff,
        changedPaths: captured.material.changedPaths,
        untrackedFiles: captured.snapshot.untrackedFiles,
      });
      try {
        const started = Date.now();
        const response = await runCodexExec(item.text, bundle.dir, args.model, args.effort);
        const elapsed = Math.round((Date.now() - started) / 1000);
        console.log(`${item.name}: 回答 chars=${response.length} elapsed=${elapsed}s`);
        if (args.out !== undefined) {
          writeFileSync(join(args.out, `response-${item.name}.md`), response, 'utf8');
        }
      } finally {
        await bundle.dispose();
      }
    }
  } finally {
    modules.cleanup();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
