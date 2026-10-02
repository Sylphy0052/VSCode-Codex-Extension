#!/usr/bin/env bash
# レビュー用subagentへ渡す review packet を1回で作る。
#
# 使い方:
#   review-packet.sh <base> [head] [issue-ref]
#     base      比較元 (main, origin/main など)
#     head      比較先 (既定: HEAD)
#     issue-ref Issue番号またはIID (省略時はIssue本文を取らない)
#
# 出力: packetディレクトリの絶対パスを1行だけstdoutへ出す。
# 差分本文はstdoutへ出さない。親のコンテキストへ差分を載せないための前提。
set -euo pipefail

# packetにはIssue本文や差分が入る。他ユーザーから読めないようにする。
umask 077

BASE="${1:?base branch required}"
HEAD_REF="${2:-HEAD}"
ISSUE="${3:-}"

# Issue番号はそのまま外部コマンドの引数になる。数字 (先頭の # は許容) 以外は
# 受け付けない。これでオプションに化ける値を渡せなくする。
if [ -n "$ISSUE" ] && ! printf '%s' "$ISSUE" | grep -qE '^#?[0-9]+$'; then
  echo "review-packet.sh: issue-ref must be a number: $ISSUE" >&2
  exit 2
fi
ISSUE="${ISSUE#\#}"

command -v jq >/dev/null 2>&1 || { echo "review-packet.sh: jq not found" >&2; exit 2; }

ROOT="$(git rev-parse --show-toplevel)"
BASE_SHA="$(git rev-parse "$BASE")"
HEAD_SHA="$(git rev-parse "$HEAD_REF")"

# packetはリポジトリの外へ置く。リポジトリ内だと各repoで除外設定が要り、
# 消し忘れるとcommitへ紛れ込む。
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/review-packet"
PARENT="$CACHE/$(basename "$ROOT")"
# 途中がsymlinkだと、書き込み先が意図しない場所へ向く。
# 作る前と作った後の両方で見る。1回だけだと、見てから mkdir するまでの間に
# symlinkへ差し替えられたときに素通りする。
no_symlink() {
  local d
  for d in "$CACHE" "$PARENT"; do
    if [ -L "$d" ]; then
      echo "review-packet.sh: refusing to write through symlink: $d" >&2
      exit 2
    fi
  done
}
no_symlink
mkdir -p "$PARENT"
no_symlink
chmod 700 "$CACHE" "$PARENT"

# 保持期間を過ぎたpacketを消す。実行のたびに前回までの消し忘れを回収する。
# 削除対象は $CACHE 配下に限定する。$PARENT が空、または $CACHE の外を指す
# ときは削除せずstderrへ警告する (basenameの結果が想定外になった場合の保険)。
# find/rmの失敗 (権限不足、併走セッションによる二重削除など) はここで打ち切らない。
# 保持削除の失敗は新規packet作成を妨げるべきではない。
RETENTION_DAYS=7
case "$PARENT" in
  "$CACHE"/*)
    find "$PARENT" -mindepth 1 -maxdepth 1 -type d -mtime "+$RETENTION_DAYS" -exec rm -rf {} + ||
      echo "review-packet.sh: retention cleanup failed (continuing)" >&2
    ;;
  *)
    echo "review-packet.sh: refusing to prune outside cache: ${PARENT:-<empty>}" >&2
    ;;
esac

# mktemp の引数に使う短縮SHAは、symlink検査より前に確定させる。検査と mktemp -d の
# 間にコマンド置換を挟むと、その fork/exec の分だけ差し替えの余地が伸びる。
SHORT_SHA="$(git rev-parse --short "$HEAD_SHA")"

# symlink検査の3回目。mkdir 直後の2回目から後に $CACHE か $PARENT を symlink へ
# 差し替えられても気付けないため、書き込みの直前でもう一度見る。差し替えを注入して
# 測ると、find は物理モードで起点の symlink を辿らないので保持削除は素通りするが、
# 次の mktemp -d "$PARENT/..." は辿り、packet (diff.patch や mr.md) をリンク先へ書く。
# 止めたいのは削除範囲の拡大ではなく、この書き込み先の乗っ取り。
# したがって検査は保持削除の case の中ではなく、mktemp -d の直前に置く。
# case の中だと (1) 検査から実際に危ない mktemp -d までの間に find を挟んで
# 待ち時間が伸び、(2) $CACHE 配下に合致しない側の分岐が検査を通らずに
# mktemp -d へ進む。この行から mktemp -d までは変数展開しか挟まない。
# cleanup の失敗と違ってここは続行しない (書き込み先が不明な以上 fail-closed)。
no_symlink

# 1回の実行につき1ディレクトリ。同じsha向けに作り直しても前回の内容が混ざらず、
# 併走セッションが同じsha向けに同時実行しても互いのpacketを壊さない。
# パスをstdoutへ出すのは全ファイルを書き終えた後なので、読み手は途中状態を見ない。
# 名前は <短縮SHA>-<ランダム>。前半で由来を追え、後半で併走実行どうしがぶつからない。
OUT="$(mktemp -d "$PARENT/$SHORT_SHA-XXXXXX")"
# 途中で失敗したら作りかけを消す。パスを出していない以上、呼び出し元は掃除できない。
trap 'rm -rf "${OUT:?}"' EXIT

# 文脈行数は差分規模に応じて変える。小さい差分では広く取り、
# 大きい差分では狭める。広すぎる文脈は追い読みを減らす代わりに
# packet自体を肥大させるため、総量が最小になる側へ倒す。
# bc など追加コマンドには依存しない。欠けていても気付けず、
# 「差分ゼロ」と誤認して文脈を広げてしまうため。
# `--numstat` は "追加 削除 パス" を1ファイル1行で出す。`--shortstat` の文章と違い
# 翻訳の対象にならないため、ロケールを問わず同じ形で読める。バイナリは "-" になる。
CHANGED="$(git diff --numstat "$BASE_SHA...$HEAD_SHA" |
  awk '{if ($1 != "-") s += $1; if ($2 != "-") s += $2} END {print s + 0}')"
if [ "$CHANGED" -lt 400 ]; then
  U=24
elif [ "$CHANGED" -lt 2000 ]; then
  U=16
else
  U=8
fi

# 秘密鍵ブロックはsedの範囲アドレス (/start/,/end/c\) ではなくawkで扱う。
# 範囲アドレスはEND側にマッチする行が最後まで現れないと、そこから末尾まで
# 丸ごと1行に畳んでしまう。実際にこのMRの説明文中の「-----BEGIN...PRIVATE
# KEY-----」という地の文がBEGIN側の開始条件に誤ってマッチし、それ以降の
# 本文がpacketから丸ごと消える事故が起きた。
#
# 途中の実装ではBEGINにマッチしても即座に畳まず、行をバッファへ貯めてENDが
# 確定した時点でだけ畳む方式にした。しかし自己レビューで、200行以内にENDが
# 見つからない場合にバッファをそのまま生で出す設計が別の問題を持ち込むと
# 指摘された。実鍵が200行を超える巨大ブロックだった場合、overflow時点まで
# 貯めた実鍵の中身とその後に続くENDが無マスクで出てしまう (secrets漏洩の
# 経路になる)。地の文の誤検出を防ぐために作った猶予行数が、今度は本物の
# 鍵の取りこぼしを許してしまっては本末転倒。
#
# 最終形: BEGINに一致したら即座に貯め込みを始め、ENDが確定した時点だけ
# [MASKED:private-key] に畳む。200行以内にENDが確定しない場合も、EOFまで
# 確定しない場合も、それまでの中身は一切出力せず [MASKED:possible-
# private-key-fragment] に畳む。「本物の鍵かどうか確定できない」ときは
# 中身を出さない側へ倒す。これで地の文の誤検出時にレビュー材料の一部が
# 畳まれることはあるが、レビュー材料の欠落よりsecrets漏洩の方が重いため、
# このIssueの目的 (packetの機微情報の露出を下げる) に沿う判断とした。
#
# 200行を超えた時点 (span > 200) で「もう鍵ブロックの一部として貯め込む
# のはやめる」が、そこで通常出力へ戻すと、超過分がまだ実鍵の続きだった
# 場合に201行目以降の鍵本文とEND行自体が生で出てしまう (自己レビューで
# 指摘・実測して確認した)。skipping状態を挟み、ENDが見つかるまで出力を
# 抑制し続ける。ただしEND無しに無限に抑制し続けると地の文の誤検出で
# それ以降のレビュー材料が全部消える (最初の事故と同じ形) ため、
# skipping自体にも上限 (1000行) を設け、それを超えたら諦めて通常出力へ
# 戻る。本物の秘密鍵がこの上限を超えることは想定しない。
mask_private_key_block() {
  awk '
    !in_key && !skipping && /-----BEGIN[^-]*PRIVATE KEY-----/ {
      in_key = 1; span = 1
      next
    }
    in_key {
      span++
      if ($0 ~ /-----END[^-]*PRIVATE KEY-----/) {
        in_key = 0
        print "[MASKED:private-key]"
        next
      }
      if (span > 200) {
        # overflow遷移そのものではラベルを出さない。ここで出すと、
        # 後続でEND検出/skip上限到達/EOFのいずれかが来たときに
        # END{}やskipping側でも出るため二重出力になる (7巡目で
        # 実際に踏んだ)。「1つの終端 (END検出/skip上限到達/EOF)
        # につきラベル1つ」に一本化し、overflow遷移はskipping状態
        # への切替だけを行う。
        in_key = 0; skipping = 1; skip_span = 0
        next
      }
      next
    }
    # skip解除 (END検出、skip上限到達、EOF到達) のどれでも、
    # 解除のきっかけになった行自体は生で出さずマスクラベルを出す。
    # 一度目の修正 (skip_span>1000到達行にprintを足す) はサイレント
    # 欠落こそ直したが、その行がまだ鍵本体の可能性を否定できないのに
    # 生出力していたため、自己レビューでsecrets露出の経路として
    # 指摘された。「解除のきっかけの行を出さない」が3つの終端に
    # 共通する不変条件なので、どれか1つだけ非対称な形にしない。
    skipping {
      skip_span++
      if ($0 ~ /-----END[^-]*PRIVATE KEY-----/ || skip_span > 1000) {
        skipping = 0
        print "[MASKED:possible-private-key-fragment]"
      }
      next
    }
    { print }
    END {
      # in_key・skippingいずれの状態でEOFに達しても、解除の
      # きっかけとなる行が来なかっただけで不変条件は同じなので、
      # 同じマスクラベルを出す (サイレントな欠落にしない)。
      if (in_key || skipping) print "[MASKED:possible-private-key-fragment]"
    }
  '
}

# 鍵・トークンらしき値を伏せ字にする。既知の形 (AWS/GitHub/Slack/Stripe/SendGrid鍵、
# URL埋め込み資格情報、秘密鍵ブロック、JWT、key=value形式) に絞り、誤検知で
# レビュー材料が欠けるのを避ける。伏せた箇所は種別付きの [MASKED:...] にし、
# 伏せた事実そのものを読み手に伝える。
mask_secrets() {
  # 最後の2つの-e (key=value形式) のキャプチャグループ: \1=キー名、\4=区切り文字
  # ([:=]または=>の前後空白含む)。値だけを [MASKED:secret] に置き換えるため \1\4 を残す。
  # \4はキー名直後の閉じ引用符 (" または ') を1つだけ許し、JSONやPythonのdict
  # リテラル ("password": "...") も対象にする。閉じ引用符の直後に[:=]または=>が来ることを
  # 求めるため、"password_hint" のようにキー名を含む別のキーは伏せない。
  # secret_key はキー名の一部としてキー群に含む。secretは前方の選択肢に入れず
  # secret[_-]?key と単独のsecretで表し、secret_secret のような組み合わせを
  # キー群に含めない (Issue #158)。区切りに=>を許すのはRuby/PHPの
  # ハッシュ記法 ('password' => '...') を伏せるため (Issue #153、MR !148の見送りlow)。
  # 引用符で囲まれた値は閉じ引用符までを値とみなし、空白を含んでもマスクする。
  # 値の中のバックスラッシュとその次の1文字 (\" や \') はエスケープとして1文字に
  # 数え、閉じ引用符とみなさない。単引用符も同じ扱いにするのは、Python・JS・PHPの
  # 文字列で \' を使うため。\' をエスケープとしないシェルやYAMLの単引用符では、
  # 同じ行の次の単引用符まで伏せる範囲が広がることがあるが、伏せ過ぎる側に倒す。
  # 引用符なしの値は空白で終わるとみなす。地の文 (「password: 8文字以上必須」など)
  # を丸ごと伏せないため、空白を越えて行末まで伏せることはしない。
  # sedは1行ずつ処理するため、キーと値が別の行に分かれた値は対象外。
  mask_private_key_block | sed -E \
    -e 's/AKIA[0-9A-Z]{16}/[MASKED:aws-access-key]/g' \
    -e 's/gh[pousr]_[A-Za-z0-9]{36,}/[MASKED:github-token]/g' \
    -e 's/github_pat_[A-Za-z0-9_]{20,}/[MASKED:github-token]/g' \
    -e 's/xox[baprs]-[A-Za-z0-9-]{10,}/[MASKED:slack-token]/g' \
    -e 's/sk_live_[A-Za-z0-9]{16,}/[MASKED:stripe-key]/g' \
    -e 's/SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/[MASKED:sendgrid-key]/g' \
    -e 's#([a-zA-Z][a-zA-Z0-9+.-]*://[^/[:space:]:@]+:)[^/[:space:]@]+(@)#\1[MASKED:url-credential]\2#g' \
    -e 's/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/[MASKED:jwt]/g' \
    -e 's/((api|access|client)[_-]?(key|secret)|secret[_-]?key|secret|token|passwd|password)(["'"'"']?[[:space:]]*(=>|[:=])[[:space:]]*)("([^"\\]|\\.){12,}"|'"'"'([^'"'"'\\]|\\.){12,}'"'"')/\1\4[MASKED:secret]/Ig' \
    -e 's/((api|access|client)[_-]?(key|secret)|secret[_-]?key|secret|token|passwd|password)(["'"'"']?[[:space:]]*(=>|[:=])[[:space:]]*)["'"'"']?[A-Za-z0-9_.\/+=-]{12,}["'"'"']?/\1\4[MASKED:secret]/Ig'
}

git diff --unified="$U" "$BASE_SHA...$HEAD_SHA" | mask_secrets >"$OUT/diff.patch"
# 伏せた箇所を含むファイルを masked.txt へ出す。diff.patch ではテストのダミー値も
# 伏せられて読めないため、実ファイルを読むべき箇所を読み手へ知らせる (Issue #159)。
# diff.patch からは切り出せない。秘密鍵ブロックの畳み込みで行数が変わり、
# ファイル境界の行まで消えうる。そこでファイルごとに差分を取り直して比べる。
# パスは :(literal) で渡し、* や : を含む名前がpathspecとして解釈されないようにする。
# 1ファイルの取得失敗で set -e がpacket全体を消さないよう、失敗は拾って続ける。
# 失敗したファイルは伏せた箇所の有無を判定できないので、載せる側へ倒す。
# rename・copy (R/C) は元のパスもpathspecへ入れる。新しいパスだけだとrename検出が
# 効かずファイル全体の追加として出て、変えていない行の伏せる値で載ってしまう (Issue #160)。
# -z の --name-status は「状態、パス」、R/C だけ「状態、元のパス、新しいパス」の順に並ぶ。
# C は diff.renames=copies の設定で出る。diff.renames=false では R も出ないが、そのときは
# diff.patch もファイル全体の追加になるので、masked.txt と diff.patch は食い違わない。
git diff --name-status -z "$BASE_SHA...$HEAD_SHA" | while IFS= read -r -d '' status && IFS= read -r -d '' f; do
  specs=(":(literal)$f")
  case "$status" in
    R* | C*)
      # f を新しいパスへ置き換える。以降の判定と masked.txt への出力は新しいパスで行う。
      # 入力が途切れて読めなければ元のパスのまま進み、set -e でpacket全体を消さない。
      # read は失敗しても読めた分 (空文字を含む) を代入するので、別の変数で受ける。
      if IFS= read -r -d '' new_f; then
        f=$new_f
        specs+=(":(literal)$f")
      fi
      ;;
  esac
  if ! raw="$(git diff --unified="$U" "$BASE_SHA...$HEAD_SHA" -- "${specs[@]}")"; then
    echo "review-packet.sh: diff failed for $f; listing it in masked.txt" >&2
    printf '%s\n' "$f"
    continue
  fi
  if [ "$raw" != "$(printf '%s\n' "$raw" | mask_secrets)" ]; then
    printf '%s\n' "$f"
  fi
done >"$OUT/masked.txt"
git diff --name-status "$BASE_SHA...$HEAD_SHA" >"$OUT/files.txt"
git log --format='%h %s' "$BASE_SHA..$HEAD_SHA" >"$OUT/log.txt"

jq -n --arg base_sha "$BASE_SHA" --arg head_sha "$HEAD_SHA" --arg base_ref "$BASE" \
  --argjson unified "$U" --argjson changed_lines "$CHANGED" \
  '{base_sha: $base_sha, head_sha: $head_sha, base_ref: $base_ref, unified: $unified, changed_lines: $changed_lines}' \
  >"$OUT/meta.json"

# Issue/MR本文。タイトルと本文だけ取る。コメントまで入れるとpacketが肥大する。
title_body() {
  python3 -c 'import json, sys
d = json.load(sys.stdin)
print("# " + (d.get("title") or ""))
print(d.get("description") or d.get("body") or "")' | mask_secrets
}

REMOTE="$(git remote get-url origin 2>/dev/null || true)"
# 取得できない理由は必ずstderrへ残す。黙って欠けると、呼び出し元が
# 「Issue番号を渡し忘れた」のか「この環境では取れない」のかを区別できない。
# remote URLからホスト名を求める (git@host:group/proj.git / https://host/group/proj.git)。
REMOTE_HOST="$(printf '%s' "$REMOTE" | sed -E 's#^[a-z+]+://([^@/]+@)?##; s#^[^@/]+@##; s#[:/].*$##')"
case "$REMOTE_HOST" in
  github.com) KIND=github ;;
  '') KIND=none ;;
  *) KIND=gitlab ;;
esac
case "$KIND" in
  gitlab)
    export GITLAB_HOST="$REMOTE_HOST"
    if ! command -v python3 >/dev/null 2>&1; then
      echo "review-packet.sh: python3 not found; skipping issue/mr fetch" >&2
    else
      if [ -n "$ISSUE" ]; then
        glab issue view "$ISSUE" --output json 2>/dev/null | title_body >"$OUT/issue.md" 2>/dev/null || true
      fi
      glab mr view --output json 2>/dev/null | title_body >"$OUT/mr.md" 2>/dev/null || true
    fi
    ;;
  github)
    if [ -n "$ISSUE" ]; then
      gh issue view "$ISSUE" --json title,body \
        -t '# {{.title}}

{{.body}}' 2>/dev/null | mask_secrets >"$OUT/issue.md" || true
    fi
    gh pr view --json title,body \
      -t '# {{.title}}

{{.body}}' 2>/dev/null | mask_secrets >"$OUT/mr.md" || true
    ;;
  *)
    echo "review-packet.sh: unsupported remote; skipping issue/mr fetch: ${REMOTE:-none}" >&2
    ;;
esac

# 差分が無いときは空のdiff.patchも消える。base の指定間違い (fetch忘れなど) を
# 取得失敗と見分けられるよう、事実をstderrへ出す。
if [ "$CHANGED" -eq 0 ]; then
  echo "review-packet.sh: no changes between $BASE and $HEAD_REF" >&2
fi

# 空ファイルは残さない。agent側が「取得できなかった」と誤解しないようにする。
find "$OUT" -maxdepth 1 -type f -empty -delete

# ここまで来たら packet は完成。作りかけを消す trap を外してからパスを出す。
trap - EXIT
echo "$OUT"
