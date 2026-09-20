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
// 使い方:
//   node scripts/measure-contract-history.mjs                 # codexとclaudeの両方を3ターン
//   node scripts/measure-contract-history.mjs --provider codex
//   node scripts/measure-contract-history.mjs --turns 4
//
// 契約の出現回数を数えるロジックは本番実装（src/orchestrator/promptMetrics.ts）を
// esbuildでその場にバンドルして読み込む。計測用に数え方を書き写すと、本番の
// `[promptMetrics ...] history=` と違う数を出しても気づけないため。
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
/** セッション記録ファイルを探すときに降りる深さ（runner.tsのSESSION_FILE_SEARCH_DEPTHと同じ）。 */
const SESSION_FILE_SEARCH_DEPTH = 4;

const TERMINATE_GRACE_MS = 5_000;
const TERMINATE_KILL_MS = 5_000;

// 実行契約の代わりに送る本文。`formatTaskExecutionContract`（src/orchestrator/runner.ts:203）
// が出す形を、計測に要る骨格だけ残して写してある。見出しの2行が
// `measurePromptText` / `countContractsInSessionRecord` の数える対象そのもの。
const CONTRACT_BLOCK = [
  '## 実行契約',
  '### 全体ゴール',
  'Issue #1320の受入基準4を実測する。',
  '',
  '### 全体の受入条件',
  '- 同一スレッドで複数ターン送ったとき、セッション記録に残る実行契約の数が増えるかを判定できる',
  '',
  '### このタスクの成果',
  '計測用のダミー契約。内容に意味は無く、行数と見出しだけが計測対象。',
].join('\n');

/** そのターンの指示。モデルにツールを使わせないよう、短く答えられるものにする。 */
function turnPrompt(turn) {
  return [
    CONTRACT_BLOCK,
    '',
    '## 今回の指示',
    `これは計測用のターン${turn}です。ツールは一切使わず、「ack ${turn}」とだけ返してください。`,
  ].join('\n');
}

function parseArgs(argv) {
  let provider = 'both';
  let turns = 3;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--provider') {
      provider = argv[i + 1] ?? provider;
      i += 1;
      continue;
    }
    if (arg === '--turns') {
      turns = Number.parseInt(argv[i + 1] ?? '', 10);
      i += 1;
      continue;
    }
    throw new Error(`未知の引数: ${arg}`);
  }
  if (!['codex', 'claude', 'both'].includes(provider)) {
    throw new Error(`--providerはcodex/claude/bothのいずれか: ${provider}`);
  }
  if (!Number.isInteger(turns) || turns < 2) {
    throw new Error(`--turnsは2以上の整数（増えるかを見るため2ターン以上要る）: ${turns}`);
  }
  return { provider, turns };
}

/**
 * 本番の計測ロジックを読み込む。
 *
 * src/orchestrator/promptMetrics.ts はvscodeにも他モジュールにも依存していないため、
 * 単体でESMへバンドルできる。
 */
async function loadPromptMetrics() {
  const outDir = mkdtempSync(join(tmpdir(), 'prompt-metrics-bundle-'));
  const outFile = join(outDir, 'promptMetrics.mjs');
  const esbuild = await import('esbuild');
  await esbuild.build({
    // 実行時のカレントディレクトリに依存させない（どこから起動しても同じものを測る）
    entryPoints: [
      resolve(dirname(fileURLToPath(import.meta.url)), '../src/orchestrator/promptMetrics.ts'),
    ],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: outFile,
  });
  const mod = await import(pathToFileURL(outFile).href);
  return { mod, cleanup: () => rmSync(outDir, { recursive: true, force: true }) };
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
 * 「読めた数が前ターンから増え、かつ連続して同じ値で落ち着いた」ところで確定させる。
 * 増えないまま上限回数に達した場合は、そのとき読めた数をそのまま返す（増えないという
 * 結果自体が答えでありうるため）。
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
    if (last > previous && stableFor >= 2) {
      return last;
    }
  }
  return last;
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

async function measureCodex(countFn, turns) {
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
      const ended = waitTurnEnd();
      const response = await request('turn/start', {
        threadId,
        input: [{ type: 'text', text: turnPrompt(turn) }],
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
        status: event.method === 'turn/failed' ? 'failed' : (status ?? 'completed'),
        usage: lastUsage,
      });
      process.stdout.write(
        `[codex] turn=${turn} history=${history ?? '-'} status=${rows[rows.length - 1].status}\n`,
      );
    }
    return { threadId, rows };
  } finally {
    await terminateProcess(proc);
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------- Claude Code

async function measureClaude(countFn, turns) {
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
      const done = waitResult();
      const payload = {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: turnPrompt(turn) }] },
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
        status: result.is_error === true ? 'failed' : (result.subtype ?? 'success'),
        usage: lastUsage,
      });
      process.stdout.write(
        `[claude] turn=${turn} history=${history ?? '-'} status=${rows[rows.length - 1].status}\n`,
      );
    }
    return { threadId: sessionId, rows };
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
function judge(rows) {
  const counts = rows.map((row) => row.history);
  if (counts.some((count) => count === undefined)) {
    return '判定不能（セッション記録ファイルを読めなかったターンがある）';
  }
  const deltas = counts.map((count, index) => (index === 0 ? count : count - counts[index - 1]));
  const step = deltas[0];
  const steady = deltas.every((delta) => delta === step);
  if (steady && step === 0) {
    return `積み上がらない（履歴の契約数が${counts[0]}のまま。#1321の二次膨張は成立しない）`;
  }
  if (steady && step > 0) {
    return (
      `積み上がる（1ターンあたり${step}件ずつ増える: ${counts.join(', ')}。` +
      '#1321の二次膨張は成立する）'
    );
  }
  return `一定でない伸び方（${counts.join(', ')}。記録の形を直接確かめる必要がある）`;
}

function formatUsage(usage) {
  if (usage === undefined) {
    return 'usage=-';
  }
  return `usage=${JSON.stringify(usage)}`;
}

function report(provider, outcome) {
  process.stdout.write(`\n=== ${provider} ===\n`);
  process.stdout.write(`threadId/sessionId: ${outcome.threadId}\n`);
  for (const row of outcome.rows) {
    process.stdout.write(
      `turn=${row.turn} history=${row.history ?? '-'} status=${row.status} ${formatUsage(row.usage)}\n`,
    );
  }
  process.stdout.write(`判定: ${judge(outcome.rows)}\n`);
}

async function main() {
  const { provider, turns } = parseArgs(process.argv.slice(2));
  const { mod, cleanup } = await loadPromptMetrics();
  const countFn = mod.countContractsInSessionRecord;
  const failures = [];
  try {
    if (provider === 'codex' || provider === 'both') {
      try {
        report('codex', await measureCodex(countFn, turns));
      } catch (e) {
        failures.push(`codex: ${String(e)}`);
        process.stderr.write(`[codex] 計測に失敗した: ${String(e)}\n`);
      }
    }
    if (provider === 'claude' || provider === 'both') {
      try {
        report('claude', await measureClaude(countFn, turns));
      } catch (e) {
        failures.push(`claude: ${String(e)}`);
        process.stderr.write(`[claude] 計測に失敗した: ${String(e)}\n`);
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
