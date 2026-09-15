import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { parseCdpEndpoint } from './discussion';

/** 現在のCodexがシェルから操作する。エージェントやブラウザは新規起動しない。 */
export async function prepareWebGptCli(storageDir: string, endpoint: string): Promise<string> {
  const cdpEndpoint = parseCdpEndpoint(endpoint);
  const session = `webgpt-${randomUUID()}`;
  const directory = path.join(storageDir, 'webgpt', session);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const configPath = path.join(directory, 'cli.config.json');
  await writeFile(
    configPath,
    JSON.stringify({
      browser: { browserName: 'chromium', cdpEndpoint, cdpTimeout: 30000 },
      outputDir: directory,
      outputMode: 'stdout',
    }),
    { encoding: 'utf8', mode: 0o600, flag: 'wx' },
  );
  const args = ['--yes', '@playwright/cli@0.1.20', `-s=${session}`, '--config', configPath];
  return `あなた自身が、この会話のシェルツールからPlaywright CLIを使ってください。別のAIプロセスは起動しません。
実行ファイルはnpxです。各呼び出しの共通引数は次のJSON配列です。引数は個別の値として渡し、シェルへ渡す際は使用中のシェルに合わせて安全に引用してください。
${JSON.stringify(args)}
共通引数の後へCLIコマンドとその引数を追加します。最初に--helpで構文を確認し、open（URLなし）で設定済みCDPへ接続してください。このopenは既存Chromeへの接続です。設定を外して実行しないでください。
以後も同じ共通引数とセッション名を使い、tab-list、tab-select、必要な場合だけ対象URLのtab-new（新規会話の作成指示ならhttps://chatgpt.com/を新しいタブで開く）、snapshot、fill、clickなどで操作してください。毎回現在のスナップショットと対象URLを確認してください。
CLI実行は現在の権限・承認手順に従い、実行不可・接続失敗なら理由を報告して中断してください。設定変更・権限回避・別の実行方式への切り替えは禁止です。
CLIの作業ディレクトリは${JSON.stringify(directory)}としてください。設定・出力はこの専用ストレージを使い、リポジトリへ生成物を作らないでください。close、close-all、kill-all、delete-dataや認証情報取得・ファイル転送コマンドは使わないでください。`;
}
