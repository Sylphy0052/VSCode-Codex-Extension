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
 * userinfo本体の文字クラスは `%` `\s` `&` に加え、ホスト・パスの区切りとなりうる
 * `/` `?` `#` も除外している（Issue #474 指摘3で追加。監査が実測で確認した過剰
 * マスク: `https%3A%2F%2Fexample.com/search?q=...%40notasecret.com` のような
 * 「スキームの直後はホスト名で、クエリ引数にメールアドレスが別途含まれる」形では、
 * 除外前の文字クラスがホスト名・パス（`example.com/search?q=`）まで一致に含めてしまい、
 * 実際のリダイレクト先ホストがログから読めなくなっていた。userinfoは仕様上これらの
 * 区切り文字を生のまま含まないため、除外してもuserinfo自体の検出は妨げない。
 *
 * それでも対象外のまま残る形（意図的な限界）: 二重エンコード（`%253A%252F%252F`）や、
 * 上限（`{0,256}`）を超える長さのuserinfoはこの並びに一致しないため素通りする。
 *
 * スキーム名・userinfo本体の量指定子はいずれも上限を設けている（`{0,63}` `{0,256}`）。
 * 上限なしの `*` のまま `%3A%2F%2F` という固定リテラルへ繋ぐと、リテラルが一切
 * 現れない巨大な英数字の連続（ログに実際に出現しうる、CLI出力中の長いbase64文字列等）
 * に対して、各開始位置で末尾まで走査してからバックトラックする動作がO(n²)に達する
 * （ReDoS。約90万文字で20秒超を実測して確認、`{0,63}`へ上限を設けて数十msへ改善した）。
 * スキーム名・userinfoが実際にこの長さを超えることは想定していない。上限は当初`{0,2048}`
 * だったが、10MB規模の敵対的入力での処理コストが他パターンに比べ突出して高いことが
 * 実測で判明したため（Issue #474 指摘4）、現実的なuserinfoの長さに絞って`{0,256}`へ
 * 縮小した（1回のバックトラック走査の上限が下がり、線形コストの傾きが下がる）。
 */
const ENCODED_URL_USERINFO_PATTERN =
  /([a-zA-Z][a-zA-Z0-9+.-]{0,63}%3A%2F%2F)[^%\s&/?#]{0,256}?%40/giu;

/**
 * スキーム区切りは生のまま（`://`）で、userinfoの`@`だけがパーセントエンコードされた
 * 混在形（`https://token%40evil.com/path`）を検出する（Issue #474 指摘5）。
 *
 * `URL_USERINFO_PATTERN`は生の`@`を要求し、`ENCODED_URL_USERINFO_PATTERN`は
 * `%3A%2F%2F`（スキームもエンコード済み）を要求するため、「スキームは生・`@`だけ
 * エンコード」の中間形はどちらにも一致せず素通りしていた。監査からの指摘を受けて
 * 検出対象に追加した。
 *
 * userinfo本体の文字クラスは`ENCODED_URL_USERINFO_PATTERN`と同じ考え方で
 * `/` `?` `#` を除外している。これにより、`https://cdn.example.com/logo%40copy.png`
 * のように`%40`がパスの奥（ファイル名等）に現れるだけで、実際にはuserinfoではない形を
 * 誤ってマスクしない（`://`の直後から`/`に達するまでの間に`%40`が無ければ不一致）。
 */
const PARTIAL_ENCODED_URL_USERINFO_PATTERN =
  /(\b[a-zA-Z][a-zA-Z0-9+.-]{0,63}:\/\/)[^%\s&/?#]{0,256}?%40/gu;

function maskUrlUserinfo(value: string): string {
  return value
    .replace(URL_USERINFO_PATTERN, '$1***@')
    .replace(ENCODED_URL_USERINFO_PATTERN, '$1***%40')
    .replace(PARTIAL_ENCODED_URL_USERINFO_PATTERN, '$1***%40');
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
 *
 * Windows系の区切り文字（`\`）は単発ではなく1つ以上（`\\+`）に一致させている
 * （Issue #474 指摘2）。`JSON.stringify(err)` を経由したエラーメッセージは
 * バックスラッシュが2連（`\\`）にエスケープされるため、単発の `\` にしか一致しない
 * 旧パターンでは `C:\\Users\\alice\\...`（実体は2連バックスラッシュ）のような形を
 * 素通りしていた。`\\+` へ緩めることで単発（元のパス）・2連（1回JSON化）のどちらも
 * 同じパターンで拾える。UNC区切りの先頭も同様に `\\{2,}`（2つ以上）へ緩めている。
 *
 * この緩和が退行を生んだため、否定先読みに `:` を追加している（Issue #474 指摘2の
 * レビューで発覚）。UNC分岐 `\\{2,}[^\\\s]+\\+Users\\+` は「2連以上のバックスラッシュ →
 * 任意の非バックスラッシュ文字列 → 1連以上のバックスラッシュ → Users」という並びしか
 * 見ないため、ドライブレター直後の `C:\\Backup\\Users\\Shared\\...`（JSON化された
 * 通常のWindowsパス。`Backup`はユーザー名ではなくただのフォルダ名）でも、`C:`の直後の
 * 2連バックスラッシュを起点にUNC分岐がマッチを開始し、`Shared`をユーザー名として
 * 誤ってマスクしてしまっていた。この退行の直接の原因は否定先読みが`:`を除外対象に
 * 含めておらず、ドライブレターの`:`直後からの開始を防げていなかったことにある。
 * `:`を除外対象へ加えることで、`C:`の直後からUNC分岐が始まることを防ぐ。
 * ドライブレター分岐（`[A-Za-z]:(?:\\+|\/)Users(?:\\+|\/)`）自体は否定先読みの外側、
 * ドライブレターより前の位置に適用されるため影響を受けず、`C:\\Users\\alice\\...`
 * （`Users`がドライブ直下）は引き続き正しくマスクされる（`sanitize.test.ts`で
 * 両ケースを回帰確認済み）。
 */
const HOME_DIR_USERNAME_PATTERN =
  /(?<![A-Za-z0-9_/\\:])((?:file:\/\/)?(?:\/(?:var|usr|export))?\/home\/|(?:file:\/\/)?\/Users\/|[A-Za-z]:(?:\\+|\/)Users(?:\\+|\/)|\\{2,}[^\\\s]+\\+Users\\+)([^/\\\s'"]+)/giu;

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
 * `Bearer <token>` 形式の認証ヘッダ値を検出し、`Bearer` の直後の1トークンだけを
 * `***` に置き換える（Issue #474 指摘3）。`Bearer` という単語だけが偶然出現する
 * ケース（`Bearer` 単体で終わる等）は対象にならない（後ろに区切り文字とトークン様の
 * 値が必須のため）。
 *
 * 直前が英数字・アンダースコアの場合は対象外にしている（`(?<![A-Za-z0-9_])`）。
 * これにより、`SomeBearer xyz` のような他の識別子の一部として現れた場合の
 * 誤検出を避ける。
 *
 * レビュー指摘（過剰マスク2件、Issue #474）を受けて、`GITHUB_TOKEN_PATTERN` /
 * `OPENAI_STYLE_KEY_PATTERN` と同じ「接頭辞＋長さ閾値＋トークンらしい文字種」の
 * 規律に揃えた:
 *
 * (a) `Bearer`直後の区切りを、改行を含む`\s+`ではなく改行を含まない`[ \t]+`にした。
 *     `\s`は改行にも一致するため、`Bearer`が行末で値を伴わずに終わる場合
 *     （例: `"...near Bearer\n    at Object.<anonymous> (...)"`）、旧パターンは
 *     次の行の先頭語（`at`ではなく実際には`Object.<anonymous>`のような識別子）まで
 *     食ってスタックトレースを破壊していた。`[ \t]+`にすることで、`Bearer`の後に
 *     同一行内の空白＋値が続かない限りマッチしない。
 * (b) `\S+`（空白以外なら何でも1文字以上）だった後続トークンの文字クラスを、
 *     Base64url相当（`[A-Za-z0-9_.~+-]`）＋最低8文字に絞った。これにより
 *     `Bearer /repo/src/config/token.ts`（パス。`/`が文字クラス外）や
 *     `Bearer token`（`token`が5文字で閾値未満）のような、トークンではない
 *     後続語を誤ってマスクしなくなる。
 *
 * (c) 上記(b)の文字クラスは標準Base64（`/` `+` `=`を使う）のBearerトークンに対して
 *     部分マスクしか掛からない不具合があった（レビュー指摘）。標準Base64のトークンが
 *     `/`を含む場合、`/`が文字クラス外であるため一致がそこで途切れ、`Bearer abcd1234/xyz+abc==`
 *     のような値は前半（`abcd1234`）だけが`***`に置き換わり、後半（`/xyz+abc==`）が
 *     マスクされないままログに残っていた。「マスク済みに見えるが実は秘密の断片が
 *     残っている」状態は、マスクしないより悪い誤解を招く。
 *
 *     一方で`/`を後続トークン全体の文字クラスへ単純に足すと、(b)で直したはずの
 *     過剰マスク（`Bearer /repo/src/config/token.ts`が丸ごとマスクされる）が
 *     再発する。そこで「先頭1文字は`/`を含まない現行の文字クラスのまま」
 *     （パスのようにスラッシュで始まる語は対象にならない）にしつつ、
 *     「2文字目以降は`/`と`=`を追加で許す」形に分けた。全体の長さ閾値（8文字以上、
 *     先頭1文字＋残り7文字以上）は維持している。これにより:
 *     - `Bearer /repo/...`: 先頭が`/`のため不一致のまま（過剰マスクは再発しない）
 *     - `Bearer token`: 5文字で閾値未満のため不一致のまま
 *     - `Bearer abcd1234/xyz+abc==`: 先頭`a`から始まり、残り全体が拡張後の文字クラスに
 *       収まるため、トークン全体が一致し部分マスクにならない
 */
const BEARER_TOKEN_PATTERN =
  /(?<![A-Za-z0-9_])(Bearer[ \t]+)[A-Za-z0-9_.~+-][A-Za-z0-9_.~+/=-]{7,}/giu;

/**
 * GitHub発行のトークン形状（`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_` = personal access token・
 * OAuth・user-to-server・server-to-server・refresh token）を検出する（Issue #474 指摘3）。
 * 接頭辞の直後に英数字20文字以上を要求することで、`gh_1234` のような短い偶然の一致
 * （過剰マスク）を避けている。
 *
 * 意図的に`i`フラグを付けていない（レビュー指摘、Issue #474 指摘7）。GitHubが実際に
 * 発行するトークンの接頭辞は常に小文字（`ghp_`等）であり、`GHP_...`のような大文字形は
 * 実在しない。他パターン（`BEARER_TOKEN_PATTERN`等）が`i`フラグ付きなのは、`Bearer`が
 * HTTPヘッダの慣習として大文字小文字表記に揺れがあるため。本パターンにその事情は
 * 無いので、`i`フラグを付けない方が「トークン形状として妥当な文字列だけを対象にする」
 * という設計意図に合う。
 */
const GITHUB_TOKEN_PATTERN = /(?<![A-Za-z0-9_])gh[oprsu]_[A-Za-z0-9]{20,}/gu;

/**
 * OpenAI/Anthropic系でよく使われる `sk-` 接頭辞のAPIキー形状を検出する
 * （Issue #474 指摘3）。接頭辞の直後にハイフンを含む英数字10文字以上を要求し、
 * `sk-` で始まる短い一般語（過剰マスク）を避けている。
 */
const OPENAI_STYLE_KEY_PATTERN = /(?<![A-Za-z0-9_])sk-[A-Za-z0-9-]{10,}/gu;

/**
 * トークン様の文字列を代表的な3形状（`Bearer <token>` / GitHubトークン / `sk-`形式の
 * APIキー）に絞ってマスクする（Issue #474 指摘3。監査が「一番実害に近い」とした穴）。
 *
 * 線引きの判断: 外部CLIのstderrをそのまま `log.warn` / `log.error` へ渡す経路が
 * 複数あり（`src/view/settingsProvider.ts`・`src/extension.ts` 等）、「マスク済みの
 * ログだから安全」という誤解を生む実害が最も大きい。一方でパターンを広げすぎると、
 * 障害調査に要る情報（どのファイルで失敗したか・エラーの種類）まで潰しかねない
 * （例: 汎用的すぎる正規表現は英数字の羅列であるファイルハッシュやIDまで拾う）。
 * そこで対象は「接頭辞・書式が固定されており、かつ実際にこのプロジェクトが連携する
 * 外部サービス（GitHub・OpenAI/Anthropic系）・標準的な認証ヘッダに由来する」3形状のみに
 * 絞った。JWT（`eyJ...`）・AWSアクセスキー（`AKIA...`）・Slackトークン（`xox[bpsr]-...`）
 * 等、他の形状は対象外のまま残る（意図的な限界。必要になったら同じ考え方で追加する）。
 *
 * 置換はいずれも冪等（`Bearer ***` の `***`・`***`単体はいずれも各パターンに
 * 再度一致しない）。
 */
function maskTokenLike(value: string): string {
  return value
    .replace(BEARER_TOKEN_PATTERN, '$1***')
    .replace(GITHUB_TOKEN_PATTERN, '***')
    .replace(OPENAI_STYLE_KEY_PATTERN, '***');
}

/**
 * ログ・理由文字列へ埋め込む値から、値そのものを削らずに秘匿情報だけを隠す。
 * URL中のuserinfo（トークン付きURL）・ホームディレクトリ配下のユーザー名・
 * トークン様文字列（`Bearer <token>` / GitHubトークン / `sk-`形式のAPIキー）の3種類。
 *
 * `sanitizeForLog` から制御文字の畳み込みと長さの切り詰めを除いた部分にあたる。
 * 一般経路のログ（`src/log.ts` の `createLogger`）は、fsエラーやスタックトレースを
 * そのまま流す使い方が前提で、改行を潰したり200文字で切ったりすると障害調査に
 * 必要な情報が失われる。そのため一般経路にはこちらだけを掛ける（Issue #391）。
 *
 * 置換はいずれも冪等（`/home/***` の `***`・`https://***@` の `***`・
 * `Bearer ***` の `***` はいずれも再度同じ形に置き換わるだけ、`~` はどのパターンにも
 * 一致しない）。よって既に `sanitizeForLog` を通した文字列を `createLogger` が
 * 再度この関数へ通しても結果は変わらない。
 *
 * `homeDir` はテスト容易性のために受け取れるようにしてある（既定は `os.homedir()`）。
 *
 * **限界（セキュリティ監査指摘、Issue #474で一部対応）**: マスクするのはURLの
 * userinfo・ホームディレクトリ配下のユーザー名・代表的なトークン形状
 * （`Bearer <token>` / `gh[oprsu]_...` / `sk-...`）のみ。JWT（`eyJ...`）・
 * AWSアクセスキー（`AKIA...`）・Slackトークン（`xox[bpsr]-...`）等、他の形状の
 * 秘密情報は対象外のためそのまま素通りする。外部CLIのstderrをそのまま
 * `log.warn` / `log.error` へ渡す経路（`src/view/settingsProvider.ts`・
 * `src/extension.ts` 等）は、マスク済みのログでもこれらの文字列が含まれていれば
 * 漏れうる。「マスク済みだから安全」と誤解してログを共有しないこと。
 *
 * 監査が実測で確認した既知のすり抜け例（**以下は既知のものを列挙したものであり、
 * 網羅的な一覧ではない**。「これで全部」と読まないこと）:
 * - 二重エンコードされたURL（例: `%253A%252F%252F` のようにパーセント記号自体が
 *   再エンコードされている場合、`ENCODED_URL_USERINFO_PATTERN` が見る
 *   `%3A%2F%2F...%40` の形状と一致しない）
 * - URLエンコードされたバックスラッシュ（`%5C`）でエスケープされたWindowsパスは
 *   `HOME_DIR_USERNAME_PATTERN` が見る実体の `\` 文字と一致しない
 * - `ENCODED_URL_USERINFO_PATTERN` / `PARTIAL_ENCODED_URL_USERINFO_PATTERN` の
 *   上限（`{0,256}`）を超える長さのuserinfoは黙って素通りする（ReDoS対策の副作用。
 *   Issue #474 指摘4・5）
 * - JWT（`eyJ...`）・AWSアクセスキー（`AKIA...`）・Slackトークン（`xox[bpsr]-...`）等、
 *   `maskTokenLike` が対象とする3形状以外のトークン・APIキー形状
 *
 * このマスク処理は、`GIT_MAX_BUFFER_BYTES`（`worktree.ts`）・`CLI_MAX_BUFFER_BYTES`
 * （`forge.ts`）がいずれも10MBであるため到達しうる規模の入力に対して、秒単位の
 * コストがかかりうる（Issue #474監査実測）。
 */
export function maskForLog(value: string, homeDir?: string): string {
  return maskHomeDir(maskUrlUserinfo(maskTokenLike(value)), homeDir);
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
