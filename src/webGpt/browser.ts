import { execFile, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { get } from 'node:http';
import { homedir, release } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { parseCdpEndpoint } from './discussion';

const execFileAsync = promisify(execFile);
const pendingStarts = new Map<string, Promise<void>>();

function isConnectionRefused(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ('code' in error && error.code === 'ECONNREFUSED') return true;
  return (
    'errors' in error &&
    Array.isArray(error.errors) &&
    error.errors.length > 0 &&
    error.errors.every(isConnectionRefused)
  );
}

/** 接続拒否だけを「未起動」とする。他のサービスや無応答を未起動扱いしない。 */
async function isCdpReady(endpoint: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const request = get(`${endpoint}/json/version`, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(
          new Error(
            'CDP接続先が正常な応答を返しません。接続先とポートの使用状況を確認してください',
          ),
        );
        return;
      }
      response.setEncoding('utf8');
      let body = '';
      response.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 65536) request.destroy(new Error('CDP接続先の応答が大きすぎます'));
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          const info = JSON.parse(body) as { Browser?: unknown; webSocketDebuggerUrl?: unknown };
          if (
            typeof info.Browser !== 'string' ||
            !/(?:Chrome|Chromium)\//.test(info.Browser) ||
            typeof info.webSocketDebuggerUrl !== 'string'
          ) {
            throw new Error('invalid CDP response');
          }
          const socket = new URL(info.webSocketDebuggerUrl);
          if (
            socket.protocol !== 'ws:' ||
            !['127.0.0.1', 'localhost', '[::1]'].includes(socket.hostname) ||
            socket.port !== new URL(endpoint).port ||
            socket.username !== '' ||
            socket.password !== '' ||
            !socket.pathname.startsWith('/devtools/browser/')
          ) {
            throw new Error('invalid CDP endpoint');
          }
          resolve(true);
        } catch {
          reject(
            new Error(
              '接続先はChromeのCDPではありません。agent.webGpt.cdpEndpointを確認してください',
            ),
          );
        }
      });
    });
    const timeout = setTimeout(() => {
      request.destroy(
        new Error('Chromeの接続確認が時間切れになりました。CDP接続先を確認してください'),
      );
    }, 2000);
    request.once('close', () => clearTimeout(timeout));
    request.once('error', (error) => {
      if (isConnectionRefused(error)) resolve(false);
      else reject(error);
    });
  });
}

async function launchChrome(port: number): Promise<void> {
  const windows =
    process.platform === 'win32' || (process.platform === 'linux' && /microsoft/i.test(release()));
  if (windows) {
    // 動的に埋め込む値はURLで検証した数値ポートだけ。パスはWindows側で解決する。
    const script = `$ErrorActionPreference = 'Stop'
$paths = @(
  "$env:ProgramFiles\\Google\\Chrome\\Application\\chrome.exe",
  "\${env:ProgramFiles(x86)}\\Google\\Chrome\\Application\\chrome.exe",
  "$env:LOCALAPPDATA\\Google\\Chrome\\Application\\chrome.exe"
)
$chrome = $paths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $chrome) { throw 'Google Chrome is not installed' }
$profile = Join-Path $env:LOCALAPPDATA 'Codex\\ChromeChatGPT'
Start-Process -FilePath $chrome -ArgumentList @(
  '--remote-debugging-port=${port}',
  '--remote-debugging-address=127.0.0.1',
  ('--user-data-dir="' + $profile + '"'),
  'https://chatgpt.com/'
)
`;
    try {
      await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64'),
        ],
        { timeout: 15000, maxBuffer: 65536, windowsHide: true },
      );
    } catch {
      throw new Error(
        'WindowsのChromeを起動できませんでした。ChromeのインストールとPowerShellの実行環境を確認してください',
      );
    }
    return;
  }

  const candidates =
    process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
        ]
      : process.platform === 'linux'
        ? ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome']
        : [];
  let executable: string | undefined;
  for (const candidate of candidates) {
    try {
      await access(candidate);
      executable = candidate;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (executable === undefined) {
    throw new Error(
      'Google Chromeが見つかりません。ChromeをインストールするかCDP対応で手動起動してください',
    );
  }
  const profile =
    process.platform === 'darwin'
      ? join(homedir(), 'Library/Application Support/Codex/ChromeChatGPT')
      : join(homedir(), '.local/share/codex/ChromeChatGPT');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      executable,
      [
        `--remote-debugging-port=${port}`,
        '--remote-debugging-address=127.0.0.1',
        `--user-data-dir=${profile}`,
        'https://chatgpt.com/',
      ],
      { detached: true, stdio: 'ignore' },
    );
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function connectOrLaunch(endpoint: string): Promise<void> {
  if (await isCdpReady(endpoint)) return;
  await launchChrome(Number(new URL(endpoint).port));
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await isCdpReady(endpoint)) return;
    await delay(500);
  }
  throw new Error(
    'Chromeを起動しましたがCDPへ接続できません。専用Chromeの起動状態と、WSLなどから接続先へ到達できるかを確認してください',
  );
}

/** 同じ接続先への起動確認を共有し、終了後もブラウザとプロファイルを残す。 */
export async function ensureWebGptBrowser(rawEndpoint: string): Promise<void> {
  const endpoint = parseCdpEndpoint(rawEndpoint);
  const existing = pendingStarts.get(endpoint);
  if (existing !== undefined) return existing;
  const pending = connectOrLaunch(endpoint);
  pendingStarts.set(endpoint, pending);
  try {
    await pending;
  } finally {
    pendingStarts.delete(endpoint);
  }
}
