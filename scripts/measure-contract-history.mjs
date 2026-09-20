// 実行契約がCLI側の会話履歴に積み上がるのかを実測する（Issue #1320 受入基準4）。
//
// なぜ拡張機能を通さないのか:
// 受入基準4が問うているのは「`setPromptTransform` が前置した実行契約入りの本文を、
// CLI（Codex / Claude Code）が会話履歴へそのまま残すのか」という一点で、これはCLI側の
// 実装で決まる。拡張機能のオーケストレーターを動かさなくても、同じ形の本文を同じ経路
// （Codexは`codex app-server`のJSON-RPC、Claude Codeは`claude --print --input-format
// stream-json`）で同一スレッドへ複数ターン送り、セッション記録ファイルに残った契約の数を
// 数えれば答えは出る。VSCodeを起動せずに済み、CLIのバージョンを変えて追試もできる。
//
// なぜ test/external-cli/ ではなく scripts/ に置くのか:
// CIの external-cli ジョブ（.github/workflows/ci.yml）は `npm run test:external-cli` で
// test/external-cli/*.test.mjs を全件走らせるが、そのジョブには認証情報が無い。この計測は
// モデルを実際に呼ぶターンを複数回まわす必要があり、認証と利用枠を消費する。テストとして
// 置くとCIが恒常的に赤になるため、手元で明示的に走らせる計測スクリプトにしてある。
//
// 契約の送り方は2通りを測れる（Issue #1321）。
//
// - `--mode full`: 全ターンへ契約の全文を前置する（#1321より前の挙動）
// - `--mode reference`: 初回だけ全文、2ターン目以降は識別子とハッシュの参照だけ（#1321の挙動）
// - `--mode both`（既定）: 両方を別々のスレッドで走らせて並べる
//
// 使い方:
//   node scripts/measure-contract-history.mjs                       # 全プロバイダ・両モード・3ターン
//   node scripts/measure-contract-history.mjs --provider codex
//   node scripts/measure-contract-history.mjs --mode reference --turns 4
//
// 送る本文と契約の出現回数の数え方は、どちらも本番実装をesbuildでその場にバンドルして
// 読み込む（`src/orchestrator/runner.ts` の `composeTaskExecutionContract` /
// `composeTaskExecutionContractReference`、`src/orchestrator/promptMetrics.ts` の
// `countContractsInSessionRecord`）。計測用に写すと、本番が送る本文や出力パネルの
// `[promptMetrics ...] history=` と食い違っても気づけないため。
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';

const CODEX_BIN = process.env.CODEX_BIN ?? 'codex';
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';

/** 1ターンの完了を待つ上限。モデルの応答を待つため、`thread/start` などより長く取る。 */
const TURN_TIMEOUT_MS = 180_000;
/** JSON-RPCの即答系（initialize / thread/start）を待つ上限。 */
const REQUEST_TIMEOUT_MS = 30_000;
/** ターン完了から記録ファイルへ書き終わるまでの遅れを吸収するポーリング。 */
const SESSION_FILE_POLL_INTERVAL_MS = 500;
const SESSION_FILE_POLL_ATTEMPTS = 20;
/** 契約が増えるのをどこまで待つか。ここを過ぎたら「増えない」を答えとして受け取る。 */
const GROWTH_WAIT_ATTEMPTS = 6;
/** セッション記録ファイルを探すときに降りる深さ（runner.tsのSESSION_FILE_SEARCH_DEPTHと同じ）。 */
const SESSION_FILE_SEARCH_DEPTH = 4;

const TERMINATE_GRACE_MS = 5_000;
const TERMINATE_KILL_MS = 5_000;

// 契約の中身として使うワークフロー定義。`formatTaskExecutionContract` がそのまま読む形
// （`WorkflowDefinition` / `WorkflowTask`）で、計測に要るフィールドだけを埋めてある。
const MEASURE_DEPENDENCY = {
  id: 'T0',
  outcome: '計測対象のCLIとそのバージョンを確定させる。',
  outputs: ['計測対象のCLI一覧'],
  dependsOn: [],
};

const MEASURE_TASK = {
  id: 'T1',
  outcome: '計測用のダミータスク。内容に意味は無く、契約の分量と見出しだけが計測対象。',
  evidence: ['src/orchestrator/runner.ts', 'src/orchestrator/promptMetrics.ts'],
  outputs: ['計測ログ'],
  risks: ['実CLIを呼ぶため認証と利用枠を消費する'],
  // 契約の「依存タスクから受け取る成果」を埋めるために1件だけ依存させる。この節は
  // `--probe` で遵守を確かめるときの問いの答えになる
  dependsOn: ['T0'],
};

const MEASURE_DEFINITION = {
  goal: '実行契約がCLI側の会話履歴へ積み上がるかを実測する（Issue #1320・#1321）。',
  acceptance: [
    '同一スレッドで複数ターン送ったとき、セッション記録に残る実行契約の数の増え方を判定できる',
    '契約の送り方（全文／参照）を変えたときの差を同じ物差しで比べられる',
  ],
  assumptions: ['計測は実CLIを直接叩き、VSCodeとオーケストレーターを介さない'],
  nonGoals: ['モデルの応答内容そのものの評価', '計測結果にもとづく削減の実装'],
  tasks: [MEASURE_DEPENDENCY, MEASURE_TASK],
};

/**
 * 契約の遵守を確かめる最後のターンの問い（`--probe`。Issue #1321 受入基準4）。
 *
 * 参照だけを前置したターンでも、初回に読んだ契約の内容を引き続き守れているかを見る。
 * 答えは契約の「対象外」と「依存タスクから受け取る成果」にしか書かれていないため、
 * 履歴の契約を参照できていなければ答えられない。
 */
const PROBE_INSTRUCTION =
  '実行契約に書かれている「対象外」の項目と、「依存タスクから受け取る成果」の項目を、' +
  '推測を混ぜずにそのまま列挙してください。契約に無い項目は足さないこと。';

/** そのターンの指示。モデルにツールを使わせないよう、短く答えられるものにする。 */
function turnInstruction(turn) {
  return `これは計測用のターン${turn}です。ツールは一切使わず、「ack ${turn}」とだけ返してください。`;
}

/**
 * そのターンにCLIへ送る本文を、本番実装と同じ関数で組み立てる。
 *
 * `full`は全ターンへ全文を前置する（Issue #1321より前の挙動）。`reference`は初回だけ
 * 全文で、2ターン目以降は識別子とハッシュの参照に置き換える（#1321の挙動）。
 */
function buildTurnPrompt(runner, mode, turn, instructionOverride) {
  const instruction = instructionOverride ?? turnInstruction(turn);
  if (mode === 'full' || turn === 1) {
    return runner.composeTaskExecutionContract(MEASURE_DEFINITION, MEASURE_TASK, instruction);
  }
  const contract = runner.formatTaskExecutionContract(MEASURE_DEFINITION, MEASURE_TASK);
  const digest = runner.taskExecutionContractDigest(contract);
  return runner.composeTaskExecutionContractReference(MEASURE_TASK.id, digest, instruction);
}

function parseArgs(argv) {
  let provider = 'both';
  let mode = 'both';
  let turns = 3;
  let probe = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--provider') {
      provider = argv[i + 1] ?? provider;
      i += 1;
      continue;
    }
    if (arg === '--mode') {
      mode = argv[i + 1] ?? mode;
      i += 1;
      continue;
    }
    if (arg === '--turns') {
      turns = Number.parseInt(argv[i + 1] ?? '', 10);
      i += 1;
      continue;
    }
    if (arg === '--probe') {
      probe = true;
      continue;
    }
    throw new Error(`未知の引数: ${arg}`);
  }
  if (!['codex', 'claude', 'both'].includes(provider)) {
    throw new Error(`--providerはcodex/claude/bothのいずれか: ${provider}`);
  }
  if (!['full', 'reference', 'both'].includes(mode)) {
    throw new Error(`--modeはfull/reference/bothのいずれか: ${mode}`);
  }
  if (!Number.isInteger(turns) || turns < 2) {
    throw new Error(`--turnsは2以上の整数（増えるかを見るため2ターン以上要る）: ${turns}`);
  }
  return { provider, mode, turns, probe };
}

/**
 * 本番の実装を読み込む。
 *
 * 数え方（`promptMetrics.ts`）と、CLIへ送る本文の組み立て（`runner.ts`）の両方を、
 * 計測側で写さず本物のまま使う。`runner.ts` は `vscode` を型としてしか使っていないため、
 * 外部化すればNodeから読み込める。
 */
async function loadProductionModules() {
  const outDir = mkdtempSync(join(tmpdir(), 'contract-history-bundle-'));
  const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/orchestrator');
  const esbuild = await import('esbuild');
  // CommonJSへ出す。`runner.ts` が依存する `yaml` はCJSで配布されており、ESMへ束ねると
  // バンドル内の `require` 代替が実行時に `Dynamic require of "process" is not supported`
  // で落ちる（実測）。読み込む側もCJSのまま扱えば、この差異に触れずに済む。
  const require = createRequire(import.meta.url);
  const build = async (name) => {
    const outFile = join(outDir, `${name}.cjs`);
    await esbuild.build({
      // 実行時のカレントディレクトリに依存させない（どこから起動しても同じものを測る）
      entryPoints: [join(srcDir, `${name}.ts`)],
      bundle: true,
      format: 'cjs',
      platform: 'node',
      external: ['vscode'],
      outfile: outFile,
    });
    return require(outFile);
  };
  const promptMetrics = await build('promptMetrics');
  const runner = await build('runner');
  return {
    promptMetrics,
    runner,
    cleanup: () => rmSync(outDir, { recursive: true, force: true }),
  };
}

/** ディレクトリを深さ優先で辿り、名前が`suffix`で終わる最初のファイルを返す。 */
function findFileBySuffix(dir, suffix, depth) {
  if (depth < 0) {
    return undefined;
  }
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const subdirs = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      subdirs.push(full);
      continue;
    }
    if (entry.name.endsWith(suffix)) {
      return full;
    }
  }
  for (const sub of subdirs) {
    const found = findFileBySuffix(sub, suffix, depth - 1);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/**
 * セッション記録に残っている契約の数を数える。
 *
 * ターン完了の通知が届いてもCLIが記録を書き終えているとは限らない。1ターン分の本文が
 * 複数のレコードに分かれて書かれるCLIもあるため（Codexは会話履歴用とUIイベント用の2件）、
 * 「連続して同じ値で落ち着いた」ところで確定させる。
 *
 * 増えるはずのターン（全文を送ったターン）では、書き終わる前の値で早々に落ち着いたと
 * 誤認しないよう、前ターンから増えるまで待つ。参照だけを送ったターン（Issue #1321）は
 * そもそも増えないのが正しいので、一定回数まで待って増えなければその値を答えとする。
 */
async function countContractsInSession(countFn, dirs, threadId, previous) {
  const suffix = `${threadId}.jsonl`;
  let last;
  let stableFor = 0;
  for (let attempt = 0; attempt < SESSION_FILE_POLL_ATTEMPTS; attempt += 1) {
    await delay(SESSION_FILE_POLL_INTERVAL_MS);
    let current;
    for (const dir of dirs) {
      const found = findFileBySuffix(dir, suffix, SESSION_FILE_SEARCH_DEPTH);
      if (found === undefined) {
        continue;
      }
      try {
        current = countFn(readFileSync(found, 'utf8'));
      } catch {
        // 書き込み途中で読めないことがある。次の周回で読み直す
      }
      break;
    }
    if (current === undefined) {
      continue;
    }
    stableFor = current === last ? stableFor + 1 : 0;
    last = current;
    if (stableFor >= 2 && (last > previous || attempt >= GROWTH_WAIT_ATTEMPTS)) {
      return last;
    }
  }
  return last;
}

/**
 * Codexのrolloutから、直近のアシスタント応答の本文を取り出す（`--probe`用）。
 *
 * Claude Codeは`result`メッセージが最終応答をそのまま持つのに対し、Codexのapp-serverは
 * 応答本文をターン完了の通知へ載せない。記録ファイル側から拾う。
 */
async function readLastAssistantText(dirs, threadId) {
  const suffix = `${threadId}.jsonl`;
  // 応答が書き終わるまでの遅れを、契約数の待ちと同じ間隔で吸収する
  await delay(SESSION_FILE_POLL_INTERVAL_MS * 2);
  for (const dir of dirs) {
    const found = findFileBySuffix(dir, suffix, SESSION_FILE_SEARCH_DEPTH);
    if (found === undefined) {
      continue;
    }
    let text;
    for (const line of readFileSync(found, 'utf8').split('\n')) {
      if (line.trim() === '') {
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed.type !== 'response_item' || parsed.payload?.role !== 'assistant') {
        continue;
      }
      const content = parsed.payload?.content;
      if (Array.isArray(content) && typeof content[0]?.text === 'string') {
        text = content[0].text;
      }
    }
    return text;
  }
  return undefined;
}

function terminateProcess(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    let killTimer;
    const onExit = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(graceTimer);
      clearTimeout(killTimer);
      resolve();
    };
    proc.once('exit', onExit);
    const graceTimer = setTimeout(() => {
      proc.kill('SIGKILL');
      killTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        proc.removeListener('exit', onExit);
        resolve();
      }, TERMINATE_KILL_MS);
      killTimer.unref();
    }, TERMINATE_GRACE_MS);
    graceTimer.unref();
    proc.kill('SIGTERM');
  });
}

/**
 * 子プロセスの起動失敗を、応答待ちのPromiseへ伝える。
 *
 * `spawn`はCLIが見つからない場合に`error`イベントを出す。これを誰も購読しないとNodeが
 * 例外にして計測プロセスごと落ちるため、`--provider both`でCodexが無いだけでClaude Code
 * 側の計測まで巻き添えで止まる。応答待ちと`race`させて、そのプロバイダの失敗として
 * 扱えるようにする。stdinへの書き込みもプロセスが死んでいると`error`を出すので併せて拾う。
 */
function watchSpawnFailure(proc, bin) {
  const failure = new Promise((_resolve, reject) => {
    proc.on('error', (e) => {
      reject(new Error(`${bin}の起動に失敗した: ${e.message}`));
    });
  });
  // 誰も待っていない時点で起動に失敗しても未処理のrejectionにしない
  failure.catch(() => {});
  proc.stdin.on('error', () => {});
  return failure;
}

/** 改行区切りJSONを読み、1件ずつコールバックへ渡す。 */
function readJsonLines(stream, onMessage) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (line === '') {
        continue;
      }
      try {
        onMessage(JSON.parse(line));
      } catch {
        // 進捗表示など、JSONでない行が混じることがある
      }
    }
  });
}

// ---------------------------------------------------------------- Codex

async function measureCodex(ctx, turns, mode, probe) {
  const { countFn, runner } = ctx;
  const cwd = mkdtempSync(join(tmpdir(), 'contract-history-codex-'));
  // CODEX_HOMEは既定（~/.codex）のまま使う。認証情報が要るうえ、記録ファイルの置き場所も
  // 拡張機能が実際に読む場所（extension.ts の paths.sessions）と揃えたいため。
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const sessionDirs = [join(codexHome, 'sessions'), join(codexHome, 'archived_sessions')];

  const proc = spawn(CODEX_BIN, ['app-server'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const spawnFailed = watchSpawnFailure(proc, CODEX_BIN);
  const pending = new Map();
  const turnWaiters = [];
  const stderrChunks = [];
  let nextId = 1;
  /** そのターンのusage。`thread/tokenUsage/updated` で届いた最後の値を使う。 */
  let lastUsage;

  readJsonLines(proc.stdout, (message) => {
    if (message.id !== undefined && message.method === undefined) {
      const resolve = pending.get(message.id);
      if (resolve !== undefined) {
        pending.delete(message.id);
        resolve(message);
      }
      return;
    }
    if (message.method === 'thread/tokenUsage/updated') {
      lastUsage = message.params;
      return;
    }
    if (message.method === 'turn/completed' || message.method === 'turn/failed') {
      const waiter = turnWaiters.shift();
      if (waiter !== undefined) {
        waiter({ method: message.method, params: message.params });
      }
      return;
    }
    // サーバ側からの要求（承認など）に誰も答えないと、そのままターンが止まる。
    // read-only + approvalPolicy=never で来ないはずだが、来たら空で返して先へ進める。
    if (message.id !== undefined && message.method !== undefined) {
      process.stderr.write(`[codex] 想定外のサーバ要求に空応答を返す: ${message.method}\n`);
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n`);
    }
  });
  proc.stderr.on('data', (chunk) => {
    stderrChunks.push(chunk.toString('utf8'));
  });

  function request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = nextId;
    nextId += 1;
    const answered = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`${method}がタイムアウトした。stderr: ${stderrChunks.join('')}`));
        }
      }, timeoutMs);
      timer.unref();
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    return Promise.race([spawnFailed, answered]);
  }

  function waitTurnEnd() {
    const ended = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`ターンの完了通知がタイムアウトした。stderr: ${stderrChunks.join('')}`));
      }, TURN_TIMEOUT_MS);
      timer.unref();
      turnWaiters.push((event) => {
        clearTimeout(timer);
        resolve(event);
      });
    });
    return Promise.race([spawnFailed, ended]);
  }

  const rows = [];
  try {
    const init = await request('initialize', {
      clientInfo: { name: 'contract-history-measure', version: '0.0.1' },
    });
    if (init.error !== undefined) {
      throw new Error(`initializeが失敗した: ${JSON.stringify(init.error)}`);
    }
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);

    const started = await request('thread/start', {
      cwd,
      sandbox: 'read-only',
      approvalPolicy: 'never',
    });
    if (started.error !== undefined) {
      throw new Error(`thread/startが失敗した: ${JSON.stringify(started.error)}`);
    }
    const threadId = started.result?.thread?.id;
    if (typeof threadId !== 'string' || threadId === '') {
      throw new Error(`threadIdを取得できない: ${JSON.stringify(started.result)}`);
    }
    process.stdout.write(`[codex] threadId=${threadId}\n`);

    let previousCount = 0;
    for (let turn = 1; turn <= turns; turn += 1) {
      lastUsage = undefined;
      const prompt = buildTurnPrompt(runner, mode, turn);
      const ended = waitTurnEnd();
      const response = await request('turn/start', {
        threadId,
        input: [{ type: 'text', text: prompt }],
      });
      if (response.error !== undefined) {
        throw new Error(`turn/startが失敗した: ${JSON.stringify(response.error)}`);
      }
      const event = await ended;
      const status = event.params?.turn?.status;
      const history = await countContractsInSession(countFn, sessionDirs, threadId, previousCount);
      previousCount = history ?? previousCount;
      rows.push({
        turn,
        history,
        promptChars: prompt.length,
        status: event.method === 'turn/failed' ? 'failed' : (status ?? 'completed'),
        usage: lastUsage,
      });
      process.stdout.write(
        `[codex] turn=${turn} history=${history ?? '-'} chars=${prompt.length} status=${rows[rows.length - 1].status}\n`,
      );
    }
    let probeAnswer;
    if (probe) {
      const ended = waitTurnEnd();
      const response = await request('turn/start', {
        threadId,
        input: [
          { type: 'text', text: buildTurnPrompt(runner, mode, turns + 1, PROBE_INSTRUCTION) },
        ],
      });
      if (response.error !== undefined) {
        throw new Error(`確認ターンのturn/startが失敗した: ${JSON.stringify(response.error)}`);
      }
      await ended;
      probeAnswer = await readLastAssistantText(sessionDirs, threadId);
    }
    return { threadId, rows, probeAnswer };
  } finally {
    await terminateProcess(proc);
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------- Claude Code

async function measureClaude(ctx, turns, mode, probe) {
  const { countFn, runner } = ctx;
  const cwd = mkdtempSync(join(tmpdir(), 'contract-history-claude-'));
  const sessionId = randomUUID();
  const projectsDir = join(homedir(), '.claude', 'projects');

  // 引数は src/claude/argvBuilder.ts の buildClaudeStreamArgs に合わせる。計測に関係の無い
  // 承認まわり（--permission-prompt-tool）は、ツールを使わせない指示なので載せない。
  const args = [
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--replay-user-messages',
    '--session-id',
    sessionId,
  ];
  const proc = spawn(CLAUDE_BIN, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const spawnFailed = watchSpawnFailure(proc, CLAUDE_BIN);
  const resultWaiters = [];
  const stderrChunks = [];
  let lastUsage;

  readJsonLines(proc.stdout, (message) => {
    if (message.type === 'result') {
      lastUsage = message.usage;
      const waiter = resultWaiters.shift();
      if (waiter !== undefined) {
        waiter(message);
      }
    }
  });
  proc.stderr.on('data', (chunk) => {
    stderrChunks.push(chunk.toString('utf8'));
  });

  function waitResult() {
    const answered = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`resultがタイムアウトした。stderr: ${stderrChunks.join('')}`));
      }, TURN_TIMEOUT_MS);
      timer.unref();
      resultWaiters.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
    return Promise.race([spawnFailed, answered]);
  }

  const rows = [];
  try {
    process.stdout.write(`[claude] sessionId=${sessionId}\n`);
    let previousCount = 0;
    for (let turn = 1; turn <= turns; turn += 1) {
      lastUsage = undefined;
      const prompt = buildTurnPrompt(runner, mode, turn);
      const done = waitResult();
      const payload = {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: prompt }],
        },
      };
      proc.stdin.write(`${JSON.stringify(payload)}\n`);
      const result = await done;
      const history = await countContractsInSession(
        countFn,
        [projectsDir],
        sessionId,
        previousCount,
      );
      previousCount = history ?? previousCount;
      rows.push({
        turn,
        history,
        promptChars: prompt.length,
        status: result.is_error === true ? 'failed' : (result.subtype ?? 'success'),
        usage: lastUsage,
      });
      process.stdout.write(
        `[claude] turn=${turn} history=${history ?? '-'} chars=${prompt.length} status=${rows[rows.length - 1].status}\n`,
      );
    }
    let probeAnswer;
    if (probe) {
      const done = waitResult();
      const payload = {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: buildTurnPrompt(runner, mode, turns + 1, PROBE_INSTRUCTION) },
          ],
        },
      };
      proc.stdin.write(`${JSON.stringify(payload)}\n`);
      const result = await done;
      probeAnswer = typeof result.result === 'string' ? result.result : undefined;
    }
    return { threadId: sessionId, rows, probeAnswer };
  } finally {
    proc.stdin.end();
    await terminateProcess(proc);
    rmSync(cwd, { recursive: true, force: true });
  }
}

// -------------------------------------------------------------- 判定・出力

/**
 * 記録に残った契約の数の推移から、二次膨張が成立するかを判定する。
 *
 * ターンごとに一定数ずつ増えるなら、契約入りメッセージがCLIの会話履歴へ積み上がって
 * いる（Issue #1321 の前提が成立する）。増分が0なら成立しない。
 *
 * 1ターンあたりの増分は必ずしも1にならない。`countContractsInSessionRecord` は記録の
 * レコード種別で絞り込まない方針のため（src/orchestrator/promptMetrics.ts のコメント）、
 * 同じ本文が複数のレコードに書かれるCLIでは増分がその本数になる。実測ではCodexが2
 * （会話履歴そのものの `response_item/message` と、UI向けの `event_msg/item_completed`）。
 * 判定に効くのは増分が一定かどうかであって、その値そのものではない。
 */
function judge(rows, mode) {
  const counts = rows.map((row) => row.history);
  if (counts.some((count) => count === undefined)) {
    return '判定不能（セッション記録ファイルを読めなかったターンがある）';
  }
  const deltas = counts.map((count, index) => (index === 0 ? count : count - counts[index - 1]));
  const first = deltas[0];
  const rest = deltas.slice(1);
  if (mode === 'reference') {
    // 期待する形は「初回だけ積まれ、以降は増えない」（Issue #1321 受入基準1・3）
    if (first > 0 && rest.every((delta) => delta === 0)) {
      return `初回だけ積まれる（${counts.join(', ')}。継続ターンは契約を積まない）`;
    }
    return `期待と違う（${counts.join(', ')}。継続ターンでも契約が積まれている）`;
  }
  const steady = deltas.every((delta) => delta === first);
  if (steady && first === 0) {
    return `積み上がらない（履歴の契約数が${counts[0]}のまま。#1321の二次膨張は成立しない）`;
  }
  if (steady && first > 0) {
    return (
      `積み上がる（1ターンあたり${first}件ずつ増える: ${counts.join(', ')}。` +
      '#1321の二次膨張は成立する）'
    );
  }
  return `一定でない伸び方（${counts.join(', ')}。記録の形を直接確かめる必要がある）`;
}

/**
 * そのターンの入力トークン数を、プロバイダごとの形から取り出す。
 *
 * Codexは`thread/tokenUsage/updated`の`tokenUsage.last`（そのターン分。`total`はスレッド
 * 通算なので使わない）、Claude Codeは`result`の`usage`。キャッシュ読み取り分は名前が
 * 違うだけで同じ意味の値なので、同じ列へ並べる。
 */
function readTurnTokens(provider, usage) {
  if (usage === undefined) {
    return { inputTokens: undefined, cachedInputTokens: undefined };
  }
  if (provider === 'codex') {
    const last = usage.tokenUsage?.last;
    return { inputTokens: last?.inputTokens, cachedInputTokens: last?.cachedInputTokens };
  }
  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.cache_read_input_tokens,
  };
}

function formatTokens(tokens) {
  return `input=${tokens.inputTokens ?? '-'} cached=${tokens.cachedInputTokens ?? '-'}`;
}

function report(provider, mode, outcome) {
  process.stdout.write(`\n=== ${provider} / mode=${mode} ===\n`);
  process.stdout.write(`threadId/sessionId: ${outcome.threadId}\n`);
  for (const row of outcome.rows) {
    process.stdout.write(
      `turn=${row.turn} history=${row.history ?? '-'} chars=${row.promptChars} ` +
        `${formatTokens(readTurnTokens(provider, row.usage))} status=${row.status}\n`,
    );
  }
  process.stdout.write(`判定: ${judge(outcome.rows, mode)}\n`);
  if (outcome.probeAnswer !== undefined) {
    process.stdout.write(`契約の遵守（確認ターンの応答）:\n${outcome.probeAnswer}\n`);
  }
}

async function main() {
  const { provider, mode, turns, probe } = parseArgs(process.argv.slice(2));
  const { promptMetrics, runner, cleanup } = await loadProductionModules();
  const ctx = { countFn: promptMetrics.countContractsInSessionRecord, runner };
  const providers = provider === 'both' ? ['codex', 'claude'] : [provider];
  const modes = mode === 'both' ? ['full', 'reference'] : [mode];
  const measure = { codex: measureCodex, claude: measureClaude };
  const failures = [];
  try {
    for (const target of providers) {
      for (const currentMode of modes) {
        try {
          report(target, currentMode, await measure[target](ctx, turns, currentMode, probe));
        } catch (e) {
          failures.push(`${target}/${currentMode}: ${String(e)}`);
          process.stderr.write(`[${target}] mode=${currentMode} の計測に失敗した: ${String(e)}\n`);
        }
      }
    }
  } finally {
    cleanup();
  }
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

await main();
