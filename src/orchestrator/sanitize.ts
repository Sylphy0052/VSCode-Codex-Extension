import * as os from 'os';

/**
 * ログ・理由文字列へ埋め込む前に、外部プロセス（git・CLI）由来のテキストを無害化する
 * 共通ヘルパー（design.md §16.7の `sanitizeForReason` と同じ考え方。レビュー指摘: warning）。
 *
 * `worktree.ts`（gitのstderr）と `runner.ts`（CLI起動失敗などの例外メッセージ）の両方が
 * このモジュールを通す。現状のサブコマンドは資格情報を含む出力を返さないが、将来
 * `fetch` / `push` 等を足したときに同じ経路で漏れるのを防ぐため、今のうちに共通化する。
 */

/** 理由・ログに埋め込む値の既定の上限長。長大な値で表示・ログが崩れるのを防ぐ。 */
export const SANITIZE_MAX_LEN = 200;

/**
 * `scheme://user:pass@host` の `user:pass@` 部分（userinfo）を `***@` に置き換える。
 * gitのリモートURLやエラーメッセージにHTTPS用のトークン付きURLがそのまま出ることがある
 * （例: `remote: Invalid username or password. fatal: Authentication failed for
 * 'https://token@github.com/...'`）。
 */
const URL_USERINFO_PATTERN = /(\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/@]+@/gu;

/**
 * パーセントエンコードされたURL（スキーム区切り`://`が`%3A%2F%2F`、userinfoの`@`が
 * `%40`になっている形）を検出する（Issue #474 指摘1）。
 *
 * `URL_USERINFO_PATTERN` は素の`user:pass@`表記しか見ないため、リダイレクトURLの
 * クエリ引数に別URLを丸ごとエンコードして埋め込む形（例:
 * `redirect?url=https%3A%2F%2Ftoken%40evil.com%2Fpath`）には一致しない。
 *
 * 対応方針として、パーセントデコードしてから一律にマスクを掛ける方式は採らなかった。
 * デコードは`&`区切りや他の`%XX`を含むクエリ文字列の構造を壊さずに行う必要があり、
 * 実装を誤ると正当なクエリ文字列（例: `?next=%2Fdashboard`）まで書き換えてしまう
 * 懸念がある。代わりに、監査指摘の形状そのもの（パーセントエンコードされたスキーム
 * 区切り`%3A%2F%2F`の直後にパーセントエンコードされた`@`である`%40`が続く）だけを
 * 狭く検出する。この並びが偶然クエリ文字列に現れる可能性は低く、過剰マスクの
 * リスクを抑えられる。
 *
 * それでも対象外のまま残る形（意図的な限界）: 二重エンコード（`%253A%252F%252F`）や、
 * スキーム区切りだけデコード済み・`@`だけエンコード済みのような混在形はこの並びに
 * 一致しないため素通りする。
 *
 * スキーム名・userinfo本体の量指定子はいずれも上限を設けている（`{0,63}` `{0,2048}`）。
 * 上限なしの `*` のまま `%3A%2F%2F` という固定リテラルへ繋ぐと、リテラルが一切
 * 現れない巨大な英数字の連続（ログに実際に出現しうる、CLI出力中の長いbase64文字列等）
 * に対して、各開始位置で末尾まで走査してからバックトラックする動作がO(n²)に達する
 * （ReDoS。約90万文字で20秒超を実測して確認、`{0,63}`へ上限を設けて数十msへ改善した）。
 * スキーム名・userinfoが実際にこの長さを超えることは想定していない。
 */
const ENCODED_URL_USERINFO_PATTERN = /([a-zA-Z][a-zA-Z0-9+.-]{0,63}%3A%2F%2F)[^%\s&]{0,2048}?%40/giu;

function maskUrlUserinfo(value: string): string {
  return value
    .replace(URL_USERINFO_PATTERN, '$1***@')
    .replace(ENCODED_URL_USERINFO_PATTERN, '$1***%40');
}

/**
 * 慣習的なホームディレクトリの直下（`/home/<user>` `/Users/<user>` `X:\Users\<user>`）を検出し、
 * ユーザー名部分だけを `***` に置き換える。パスの残りの構造（ドライブレター・`Users`という
 * ディレクトリ名・後続のサブパス）は保持する。「どのファイルで失敗したか」を切り分けられる
 * 情報を失わせないため（Issue #378 自己レビュー観点）、パス全体は畳まない。
 *
 * 対応する形状（セキュリティ監査指摘: MEDIUM/LOW対応）:
 * - POSIX標準: `/home/<user>`
 * - `/home` の前に既知の祖先ディレクトリが付くレイアウト: `/var/home/`（NixOS）・
 *   `/usr/home/`（BSD系）・`/export/home/`（Solaris/illumos系）
 * - `file://` スキームのURI: `file:///home/<user>`（`file://` + `/home/` の連結）
 * - macOS: `/Users/<user>`
 * - Windows: `X:\Users\<user>` `X:/Users/<user>`（大文字小文字は`i`フラグで区別しない）
 * - UNC（ローミングプロファイル等）: `\\server\Users\<user>`
 *
 * 旧パターンは `(?<![A-Za-z0-9_/\\])` を `/home/` 等の直前にのみ適用していたため、
 * 祖先ディレクトリやスキームが挟まる形状（`/var/home/…` の直前は英数字の `r`、
 * `file:///home/…` の3連スラッシュの直前は `/`）が軒並み不成立になりマスクを回避できた。
 * 対策として、祖先ディレクトリ・スキームを否定先読みの対象外（キャプチャ対象の内側）へ
 * 取り込み、否定先読み自体は各分岐の先頭（`/var` や `file` の直前）にのみ適用する形へ
 * 変更した。この位置なら実際のホームディレクトリパスは常に文字列の先頭・空白・引用符の
 * 直後から始まり、`src/Users/foo.ts` のような相対パス中の偶然の一致（`Users`の直前が
 * 英数字の`c`）だけを引き続き除外できる。
 *
 * `i`フラグにより大文字小文字を区別しない（`/HOME/` `C:\users\` 等）。過剰マスクの
 * 懸念（`homework/` `income/` 等）は、いずれも`/home/`直後に区切り文字が続かないため
 * 該当しない（`sanitize.test.ts` で回帰確認済み）。
 */
const HOME_DIR_USERNAME_PATTERN =
  /(?<![A-Za-z0-9_/\\])((?:file:\/\/)?(?:\/(?:var|usr|export))?\/home\/|(?:file:\/\/)?\/Users\/|[A-Za-z]:[\\/]Users[\\/]|\\\\[^\\\s]+\\Users\\)([^/\\\s'"]+)/giu;

function maskHomeDirUsername(value: string): string {
  return value.replace(HOME_DIR_USERNAME_PATTERN, (_match, prefix: string) => `${prefix}***`);
}

/**
 * `homeDir` がパス区切り文字だけで構成される（空文字 `''` を除く。例: `/` `\` `//`）場合に
 * `true`。コンテナ環境で `HOME=/` になっているケースが実在する（`createLogger` が
 * `os.homedir()` を生成時に一度だけ固定するため、この異常値は一度固定されると全ログ経路に
 * 効き続ける）。この状態で `exactHomeDirPattern` をそのまま使うと、「後続が区切り文字か
 * 文字列末尾」という条件だけを持つ単独の `/` が、パス中のあらゆる区切りにマッチしてしまい
 * （例: `/tmp/` の末尾の `/` が `~` に化けて `/tmp~` になる）、パスの構造を壊してしまう。
 */
function isPathSeparatorOnly(homeDir: string): boolean {
  return homeDir.length > 0 && /^[\\/]+$/u.test(homeDir);
}

/**
 * `os.homedir()` が返す実際のホームディレクトリ（`/home/<user>` `/Users/<user>` の慣習に
 * 沿わない値を含む。例: コンテナの `/root`）と厳密に一致する接頭辞を丸ごと `~` へ置換する。
 * 後続のパス区切り（`/` `\`）または文字列末尾が続く場合のみマッチさせ、
 * `/home/kfuruhashi2/...` のような「別ユーザーの、たまたま前方一致するパス」を
 * 誤ってマスクしないようにする。
 *
 * テスト容易性のため `homeDir` を第2引数として受け取れるようにしてある（既定は
 * `os.homedir()`）。本番の呼び出し（`sanitizeForLog`）は既定値のまま呼ぶため、実行環境の
 * ホームディレクトリが自動的に使われる。テストは実ホームディレクトリに依存せず、
 * 任意の`homeDir`を明示的に渡して検証できる。
 */
export function maskHomeDir(value: string, homeDir: string = os.homedir()): string {
  if (!homeDir || isPathSeparatorOnly(homeDir)) {
    return maskHomeDirUsername(value);
  }
  const escaped = homeDir.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const exactHomeDirPattern = new RegExp(`${escaped}(?=[\\\\/]|$)`, 'gu');
  return maskHomeDirUsername(value.replace(exactHomeDirPattern, '~'));
}

/**
 * ログ・理由文字列へ埋め込む値から、値そのものを削らずに秘匿情報だけを隠す。
 * URL中のuserinfo（トークン付きURL）と、ホームディレクトリ配下のユーザー名の2種類。
 *
 * `sanitizeForLog` から制御文字の畳み込みと長さの切り詰めを除いた部分にあたる。
 * 一般経路のログ（`src/log.ts` の `createLogger`）は、fsエラーやスタックトレースを
 * そのまま流す使い方が前提で、改行を潰したり200文字で切ったりすると障害調査に
 * 必要な情報が失われる。そのため一般経路にはこちらだけを掛ける（Issue #391）。
 *
 * 置換はいずれも冪等（`/home/***` の `***`・`https://***@` の `***` は再度同じ形に
 * 置き換わるだけ、`~` はどちらのパターンにも一致しない）。よって既に `sanitizeForLog` を
 * 通した文字列を `createLogger` が再度この関数へ通しても結果は変わらない。
 *
 * `homeDir` はテスト容易性のために受け取れるようにしてある（既定は `os.homedir()`）。
 *
 * **限界（セキュリティ監査指摘、Issue #474で一部対応）**: マスクするのはURLのuserinfoと
 * ホームディレクトリ配下のユーザー名の2種類だけで、それ以外の秘密情報（APIキー・トークン・
 * 認証ヘッダ等。例: `Bearer <token>` `ghp_...` `sk-...`）は対象外のためそのまま素通りする。
 * 外部CLIのstderrをそのまま `log.warn` / `log.error` へ渡す経路
 * （`src/view/settingsProvider.ts`・`src/extension.ts` 等）は、マスク済みのログでも
 * これらの文字列が含まれていれば漏れうる。「マスク済みだから安全」と誤解してログを
 * 共有しないこと。この穴自体を塞ぐ対応は Issue #474 で追跡する（ここでは限界の明記のみ）。
 *
 * 監査が実測で確認した既知のすり抜け例（いずれも意図的な範囲外として残る、または
 * Issue #474 で対応済み）:
 * - （対応済み）パーセントエンコードされたURL（`https%3A%2F%2Ftoken%40evil.com` のように
 *   スキーム区切り・`@`が丸ごとエンコードされた形）は `ENCODED_URL_USERINFO_PATTERN`
 *   で検出するようにした。ただし二重エンコード等、この並びに一致しない変形は
 *   引き続き対象外（`maskUrlUserinfo` のJSDoc参照）
 * - `\\` にエスケープされたWindowsパス（例: JSON化されたエラーメッセージ中の
 *   `C:\\\\Users\\\\alice\\\\...` は `HOME_DIR_USERNAME_PATTERN` が想定する
 *   `C:\Users\alice` の形状と一致せず素通りする）
 */
export function maskForLog(value: string, homeDir?: string): string {
  return maskHomeDir(maskUrlUserinfo(value), homeDir);
}

/**
 * 双方向制御文字（RTL override等）と、幅を持たない不可視文字。`textContent` で挿入する限り
 * XSSにはならないが（design.md §16.8のワークフローViewの前提）、表示上の文字の並びを
 * 反転・偽装したり、目視比較をすり抜けたりできてしまう。ワークフローViewの「承認」操作は
 * 会話タブを開かずその場で許可・拒否を決められる設計（design.md §16.8）で、通常の
 * チャット画面より文脈が少なく見た目の偽装が誤判断に直結しやすいため、制御文字と
 * 同列に落とす（レビュー指摘: medium 3 / low）。
 *
 * - `U+200E` `U+200F`: LRM / RLM（双方向）
 * - `U+061C`: Arabic Letter Mark（双方向）
 * - `U+202A`-`U+202E`: LRE / RLE / PDF / LRO / RLO（双方向）
 * - `U+2066`-`U+2069`: LRI / RLI / FSI / PDI（双方向）
 * - `U+200B`: ゼロ幅スペース
 * - `U+2060`: word joiner
 * - `U+FEFF`: BOM / ゼロ幅no-breakスペース
 */
const INVISIBLE_CHAR_PATTERN = /[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069\u200B\u2060\uFEFF]/gu;

/**
 * C0制御文字・DEL・双方向制御文字を取り除く。改行やタブは空白に畳み、それ以外の
 * 制御文字（双方向制御含む）は跡を残さず削除する。`sanitizeForLog` の下請けだが、
 * 単独でも使う（`runner.ts` の承認要求表示、`taskSummary.ts` の応答要約。
 * レビュー指摘: medium 3 / low）。
 */
export function stripControlChars(value: string): string {
  let normalized = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    normalized += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  return normalized.replace(INVISIBLE_CHAR_PATTERN, '');
}

/**
 * `stripControlChars` と同じく双方向制御文字・不可視文字（Trojan Source対策）を落とすが、
 * 改行（`\n` `\r`）とタブ（`\t`）は残す。
 *
 * `stripControlChars` は改行も含めた全てのC0制御文字を空白へ畳むため、1行の表示
 * （承認カードのタイトル、応答の1行要約）には適するが、複数行のテキストへ使うと
 * 改行が空白に潰れて読めなくなる。ワークフローViewの「展開後のプロンプトを見る」
 * （design.md §16.4 案1、Issue #67）は複数行のプロンプトをそのまま人が目視で確認する
 * 機能なので、双方向制御文字だけを落として整形は保つ必要がある（セキュリティ監査
 * 指摘#5。双方向制御文字を仕込まれると、この目視確認そのものを欺けるため、
 * `INVISIBLE_CHAR_PATTERN` の除去自体は省略できない）。
 */
export function stripControlCharsPreservingNewlines(value: string): string {
  let normalized = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    const isPreservedWhitespace = code === 0x0a || code === 0x0d || code === 0x09;
    normalized += !isPreservedWhitespace && (code < 0x20 || code === 0x7f) ? ' ' : ch;
  }
  return normalized.replace(INVISIBLE_CHAR_PATTERN, '');
}

/**
 * 制御文字・改行を空白に畳み、URL中のuserinfoとホームディレクトリ配下のユーザー名をマスクし、
 * 長すぎる値を切り詰める。HTMLエスケープはView側の責務（design.md §16.8）であり、
 * ここでは行わない。
 *
 * Node.jsのfsエラーは慣習的に絶対パスをメッセージへ埋め込む（例:
 * `EACCES: permission denied, open '/home/<username>/...'`）。Windowsの
 * `C:\Users\<username>\...` も同様。`maskHomeDir` によりユーザー名だけを隠し、
 * パスの構造（どのファイルで失敗したかの手がかり）は残す（Issue #378）。
 */
export function sanitizeForLog(value: string, maxLen: number = SANITIZE_MAX_LEN): string {
  const normalized = stripControlChars(value);
  const masked = maskForLog(normalized);
  const collapsed = masked.replace(/ {2,}/gu, ' ').trim();
  return collapsed.length > maxLen ? `${collapsed.slice(0, maxLen)}…` : collapsed;
}

/**
 * `<` `>` をHTML実体参照に置き換える。**本文に囲いのタグと同じ文字列（`</task-message>` 等）が
 * 含まれていても、囲いを破れないようにする**（design.md §16.21・§16.23）ための一次防御。
 * 本文中の全ての `<` を実体参照化しておけば、本文だけからは `<...>` という
 * タグ構造そのものを再構成できない（＝どんな文字列を書かれても閉じタグを偽装できない）。
 *
 * タスク間メッセージング（`messaging.ts` の `wrapTaskMessage`）とオーケストレーターへの
 * イベント通知（`orchestratorSession.ts`）の両方が使うため、ここに置く。
 */
export function escapeAngleBrackets(text: string): string {
  return text.replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}
