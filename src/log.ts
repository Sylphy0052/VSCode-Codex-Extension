import * as os from 'os';
import * as vscode from 'vscode';
import { maskForLog } from './orchestrator/sanitize';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  show(): void;
}

/**
 * OutputChannelへ書き出すLoggerを作る。
 *
 * 書き出す直前に `maskForLog` を一律で掛ける（Issue #391）。Node.jsのfsエラーは
 * 対象パスをメッセージへそのまま埋め込む（例: `ENOENT: no such file or directory,
 * scandir '/home/<username>/.codex/sessions'`）ため、例外を `String(e)` のまま流している
 * 既存の多数の呼び出し（`pruneOnStartup.ts` や `extension.ts` 等、231箇所）で
 * OSのユーザー名がログへ出る。呼び出し側で個別に掛ける方式は追加のたびに漏れるため、
 * 書き出し口で一括して掛ける。
 *
 * 掛けるのは `sanitizeForLog` ではなく `maskForLog`（マスクのみ）。`sanitizeForLog` は
 * 改行の畳み込みと200文字での切り詰めも行うので、スタックトレースや長いCLI出力を
 * そのまま流す一般経路へ適用すると障害調査に必要な情報が落ちる。マスクは値を削らず、
 * パスの構造（どのファイルで失敗したか）はそのまま残る。
 *
 * `maskForLog` の置換は冪等なので、`sanitizeForLog` を通してから `log.warn` へ渡している
 * orchestrator配下の既存経路が二重に処理されても出力は変わらない。
 *
 * `homeDir` はLogger生成時に一度だけ解決する（1行ごとに `os.homedir()` を呼ばないため）。
 * テストから明示的に渡せるようにもしてある。
 *
 * **限界（セキュリティ監査指摘）**: ここで一律に掛かる `maskForLog` が隠すのはURLの
 * userinfoとホームディレクトリ配下のユーザー名の2種類だけ。`Bearer <token>` `ghp_...`
 * `sk-...` のようなAPIキー・トークン・認証ヘッダ等は対象外でそのままログへ出る。
 * 外部CLIのstderrをそのまま `log.warn` / `log.error` へ渡す既存の呼び出し（例:
 * `src/view/settingsProvider.ts`、`src/extension.ts`）はこの経路を通るため、この
 * Loggerを経由していても「トークンが漏れない」ことは保証されない。この穴自体を塞ぐ
 * 対応はIssue #474で追跡する（ここでは限界の明記のみ）。詳細は `maskForLog`
 * （`src/orchestrator/sanitize.ts`）のJSDocを参照。
 */
export function createLogger(
  channel: vscode.OutputChannel,
  homeDir: string = os.homedir(),
): Logger {
  const write = (level: string, message: string): void => {
    channel.appendLine(`[${new Date().toISOString()}] ${level} ${maskForLog(message, homeDir)}`);
  };
  return {
    info: (m) => write('INFO ', m),
    warn: (m) => write('WARN ', m),
    error: (m) => write('ERROR', m),
    show: () => channel.show(true),
  };
}
