import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Claude Codeの`--mcp-config`へ渡すMCP設定ファイルの置き場。
 *
 * トークン入りのURLを引数へ直接書くと、プロセスの引数一覧（`ps`）に載る。権限600の
 * ファイルへ書き、パスだけを渡す（Issue #1903, #1905）。ファイルは小さく、書く頻度も
 * 会話の開始時だけなので同期APIで足りる。
 */

/** ファイル名: `<prefix>-<拡張ホストのpid>-<16桁のhex>.json`。 */
function fileNamePattern(prefix: string): RegExp {
  return new RegExp(`^${prefix}-(\\d+)-[0-9a-f]{16}\\.json$`);
}

/**
 * `mcpServers`を権限600のファイルへ書き、パスを返す。ディレクトリの権限は、すでにあって
 * 緩くても700へ締める（`mkdir`の`mode`は新しく作ったときにしか効かない）。
 */
export function writeMcpConfigFile(
  configDir: string,
  prefix: string,
  mcpServers: Record<string, unknown>,
): string {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  chmodSync(configDir, 0o700);
  // globalStorageは全ウィンドウで共有されるため、ウィンドウ（拡張ホスト）ごとに別のファイルにする。
  // 名前にpidを入れ、異常終了で残ったファイルを次の起動で見分けられるようにする
  const path = join(configDir, `${prefix}-${process.pid}-${randomBytes(8).toString('hex')}.json`);
  writeFileSync(path, JSON.stringify({ mcpServers }), { flag: 'wx', mode: 0o600 });
  return path;
}

export function removeMcpConfigFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // すでに消えている
  }
}

/**
 * 終了したプロセスが残した設定ファイルを消す。起動中の他のウィンドウのファイルは残す。
 *
 * 生死はpidで見るため、拡張ホストが別のPID名前空間（コンテナなど）にあり`globalStorage`を
 * 共有する構成では、生きているウィンドウのファイルを消しうる。その場合そのウィンドウの
 * 会話は、次に起動し直すまで該当のMCPを読み込めない。
 */
export function pruneStaleMcpConfigFiles(configDir: string, prefix: string): void {
  let names: string[];
  try {
    names = readdirSync(configDir);
  } catch {
    return;
  }
  const pattern = fileNamePattern(prefix);
  for (const name of names) {
    const pid = Number(pattern.exec(name)?.[1]);
    if (!Number.isInteger(pid) || pid <= 0 || isProcessAlive(pid)) continue;
    removeMcpConfigFile(join(configDir, name));
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERMは別ユーザーのプロセスが生きている。消さない側へ倒す
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
