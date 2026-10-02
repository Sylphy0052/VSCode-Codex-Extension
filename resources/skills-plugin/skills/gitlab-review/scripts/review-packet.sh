#!/usr/bin/env bash
# レビュー用subagentへ渡す review packet を1回で作る。
#
# 使い方:
#   review-packet.sh <base> [head] [issue-ref]
#     base      比較元 (main, origin/main など)
#     head      比較先 (既定: HEAD)
#     issue-ref IssueのIID (省略時はIssue本文を取らない)
#   review-packet.sh --drafts <MRのIID>
#     指摘や総評のドラフトを置くディレクトリを作り、その絶対パスを1行だけ出す。
#
# 出力: packetディレクトリの絶対パスを1行だけstdoutへ出す。
# 差分本文はstdoutへ出さない。親のコンテキストへ差分を載せないための前提。
#
# 置き場: <リポジトリのルート>/.review-packet/ (環境変数 REVIEW_PACKET_DIR は無い。固定)。
# 実行のたびに .git/info/exclude へ追記し、git管理外にする。リポジトリ内に置くのは、
# 読み取り専用のsubagentが追加の許可なしに読めるようにするため。
# packetには差分とIssue本文が入る。他ユーザーから読めないようにする。
set -euo pipefail
umask 077

DIR_NAME=".review-packet"
EXCLUDE_LINE="/$DIR_NAME/"

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

# .git/info/exclude へ除外行を足す。worktreeでも共通の .git/info/exclude を指す。
ensure_excluded() {
  local excl
  excl="$(git rev-parse --git-path info/exclude)"
  case "$excl" in
    /*) ;;
    *) excl="$ROOT/$excl" ;;
  esac
  mkdir -p "$(dirname "$excl")"
  if ! grep -qxF "$EXCLUDE_LINE" "$excl" 2>/dev/null; then
    printf '%s\n' "$EXCLUDE_LINE" >>"$excl"
  fi
}

# 書き込み先の途中がsymlinkだと、意図しない場所へ書いてしまう。
no_symlink() {
  if [ -L "$PARENT" ]; then
    echo "review-packet.sh: refusing to write through symlink: $PARENT" >&2
    exit 2
  fi
}

PARENT="$ROOT/$DIR_NAME"

if [ "${1:-}" = "--drafts" ]; then
  MR_IID="${2:?MR IID required}"
  case "$MR_IID" in
    '' | *[!0-9]*)
      echo "review-packet.sh: MR IID must be digits only: $MR_IID" >&2
      exit 2
      ;;
  esac
  ensure_excluded
  no_symlink
  mkdir -p "$PARENT/drafts/mr-$MR_IID"
  no_symlink
  chmod 700 "$PARENT" "$PARENT/drafts" "$PARENT/drafts/mr-$MR_IID"
  echo "$PARENT/drafts/mr-$MR_IID"
  exit 0
fi

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

command -v jq >/dev/null 2>&1 || {
  echo "review-packet.sh: jq not found. Install jq (see codex-ext:gitlab-init for the setup steps)" >&2
  exit 2
}

# baseやheadが "-" で始まってもオプションに化けないよう --end-of-options を付け、
# コミットとして解決できる値だけを通す。
BASE_SHA="$(git rev-parse --verify --end-of-options "$BASE^{commit}")" || {
  echo "review-packet.sh: cannot resolve base '$BASE'. Run 'git fetch origin' and check the name" >&2
  exit 2
}
HEAD_SHA="$(git rev-parse --verify --end-of-options "$HEAD_REF^{commit}")" || {
  echo "review-packet.sh: cannot resolve head '$HEAD_REF'. Run 'git fetch origin' and check the name" >&2
  exit 2
}

ensure_excluded
# symlink検査は作る前、作った後、書き込みの直前の3回行う。1回だけだと、
# 検査してから書くまでの間にsymlinkへ差し替えられたときに素通りする。
no_symlink
mkdir -p "$PARENT"
no_symlink
chmod 700 "$PARENT"

# 保持期間を過ぎたpacketを消す。実行のたびに前回までの消し忘れを回収する。
# 対象は $PARENT 直下のディレクトリのうち drafts 以外。
# 削除の失敗 (権限不足、併走セッションによる二重削除など) は新規packet作成を妨げない。
RETENTION_DAYS=7
find "$PARENT" -mindepth 1 -maxdepth 1 -type d ! -name drafts -mtime "+$RETENTION_DAYS" -exec rm -rf {} + ||
  echo "review-packet.sh: retention cleanup failed (continuing)" >&2

# mktemp の引数に使う短縮SHAは、symlink検査より前に確定させる。検査と mktemp -d の
# 間にコマンド置換を挟むと、その分だけ差し替えの余地が伸びる。
SHORT_SHA="$(git rev-parse --short "$HEAD_SHA")"

# 書き込み先が不明なまま続行しない (fail-closed)。この行から mktemp -d までは
# 変数展開しか挟まない。
no_symlink

# 1回の実行につき1ディレクトリ。同じshaで作り直しても前回の内容が混ざらず、
# 併走セッションが同時に実行しても互いのpacketを壊さない。
# パスをstdoutへ出すのは全ファイルを書き終えた後なので、読み手は途中状態を見ない。
OUT="$(mktemp -d "$PARENT/$SHORT_SHA-XXXXXX")"
# 途中で失敗したら作りかけを消す。パスを出していない以上、呼び出し元は掃除できない。
trap 'rm -rf "${OUT:?}"' EXIT

# 文脈行数は差分規模に応じて変える。小さい差分では広く取り、大きい差分では狭める。
# 広すぎる文脈は追い読みを減らす代わりにpacket自体を肥大させるため、総量が最小に
# なる側へ倒す。`--numstat` は "追加 削除 パス" を1ファイル1行で出す。ロケールを
# 問わず同じ形で読める。バイナリは "-" になる。
CHANGED="$(git diff --numstat "$BASE_SHA...$HEAD_SHA" |
  awk '{if ($1 != "-") s += $1; if ($2 != "-") s += $2} END {print s + 0}')"
if [ "$CHANGED" -lt 400 ]; then
  U=24
elif [ "$CHANGED" -lt 2000 ]; then
  U=16
else
  U=8
fi

# 秘密鍵ブロックはsedの範囲アドレスではなくawkで扱う。範囲アドレスはEND側に
# マッチする行が最後まで現れないと、そこから末尾まで丸ごと畳んでしまう。
# 方針は「本物の鍵かどうか確定できないときは中身を出さない側へ倒す」。
#   - BEGINに一致したら即座に貯め込みを始め、ENDが確定した時点で
#     [MASKED:private-key] に畳む。
#   - 200行以内にENDが確定しない場合は、貯めた中身を出さず skipping 状態へ移り、
#     ENDが見つかるまで (または1000行の上限まで) 出力を抑制する。
#   - 解除のきっかけになった行 (END行、上限到達行) も生では出さない。
#   - どの終端 (END検出、上限到達、EOF) でもラベルは1つだけ出す。
#     END検出は [MASKED:private-key]、それ以外は [MASKED:possible-private-key-fragment]。
#     ただし200行超えでskippingへ移った後にENDが見つかった場合は後者になる。
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
        in_key = 0; skipping = 1; skip_span = 0
        next
      }
      next
    }
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
      if (in_key || skipping) print "[MASKED:possible-private-key-fragment]"
    }
  '
}

# 鍵・トークンらしき値を伏せ字にする。既知の形 (AWS/GitHub/Slack/Stripe/SendGrid鍵、
# URL埋め込み資格情報、秘密鍵ブロック、JWT、key=value形式) に絞り、誤検知で
# レビュー材料が欠けるのを避ける。伏せた箇所は種別付きの [MASKED:...] にする。
mask_secrets() {
  # 最後の2つの-e (key=value形式) のキャプチャグループ: \1=キー名、\4=区切り文字
  # ([:=]または=>の前後空白含む)。値だけを [MASKED:secret] に置き換えるため \1\4 を残す。
  # \4はキー名直後の閉じ引用符を1つだけ許し、JSONやPythonのdictリテラル
  # ("password": "...") も対象にする。閉じ引用符の直後に[:=]または=>が来ることを
  # 求めるため、"password_hint" のようにキー名を含む別のキーは伏せない。
  # 区切りに=>を許すのはRuby/PHPのハッシュ記法 ('password' => '...') のため。
  # 引用符で囲まれた値は閉じ引用符までを値とみなし、空白を含んでもマスクする。
  # 値の中のバックスラッシュとその次の1文字はエスケープとして1文字に数える。
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
# 伏せられて読めないため、実ファイルを読むべき箇所を読み手へ知らせる。
# diff.patch からは切り出せない (秘密鍵ブロックの畳み込みで行数が変わるため)。
# そこでファイルごとに差分を取り直して比べる。
# パスは :(literal) で渡し、* や : を含む名前がpathspecとして解釈されないようにする。
# 1ファイルの取得失敗で set -e がpacket全体を消さないよう、失敗は拾って続ける。
# 失敗したファイルは伏せた箇所の有無を判定できないので、載せる側へ倒す。
# rename・copy (R/C) は元のパスもpathspecへ入れる。新しいパスだけだとrename検出が
# 効かず、変えていない行の伏せる値まで載ってしまう。
# -z の --name-status は「状態、パス」、R/C だけ「状態、元のパス、新しいパス」の順に並ぶ。
git diff --name-status -z "$BASE_SHA...$HEAD_SHA" | while IFS= read -r -d '' status && IFS= read -r -d '' f; do
  specs=(":(literal)$f")
  case "$status" in
    R* | C*)
      # 入力が途切れて読めなければ元のパスのまま進む。
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

# remoteのURLからホスト名だけを取り出す。
# 対応する形: https://host/path、http://host/path、https://user:token@host/path、
#   https://host:8443/path、ssh://git@host:port/path、git://host/path、git@host:path
# URLに埋め込まれた資格情報はここで捨てる (ホスト名以外は使わない)。
# https・httpはポートを残す (host:8443)。ssh://・git://・scp形式はAPIのポートではないので落とす。
# それ以外のscheme (file://など) とローカルパスは空を返す。
# サブパス配置のGitLab (https://host/sub/g/p.git) は扱えない。
remote_host() {
  printf '%s' "$1" | sed -E \
    -e 's#^https?://([^/]*@)?([^/]+).*#\2#;t' \
    -e 's#^(ssh|git|git\+ssh|ssh\+git)://([^/]*@)?([^/:]+).*#\3#;t' \
    -e 's#^[a-z+]+://.*##;t' \
    -e 's#^([^/]*@)?([^/:]+):.*#\2#;t' \
    -e 's#.*##'
}

# 取得コマンドを実行し、成功したら出力を filter 経由で dest へ書く。
#   fetch_into <dest> <対象名> <失敗時の案内> <filter関数> <コマンド...>
# 失敗 (終了コードが0以外) はstderrへ理由と案内を出し、packet作成は続ける。
# MR・PRが無いだけの失敗 (glab・ghは非ゼロで終わる) は、その旨のメッセージを見て黙る。
# コマンドが成功して出力が空のときも黙る (空ファイルは最後に消える)。
fetch_into() {
  local dest="$1" what="$2" hint="$3" filter="$4"
  shift 4
  local errf rc=0 body
  errf="$(mktemp "$OUT/.fetch-err-XXXXXX")"
  body="$("$@" 2>"$errf")" || rc=$?
  if [ "$rc" -ne 0 ]; then
    if ! grep -qiE 'no (open )?(merge request|pull request)|could not find any (merge request|pull request)' "$errf"; then
      echo "review-packet.sh: failed to fetch $what (exit $rc): $(head -c 300 "$errf" | mask_secrets | tr '\n' ' ')" >&2
      echo "review-packet.sh: $hint" >&2
    fi
    rm -f "$errf"
    return 0
  fi
  rm -f "$errf"
  [ -n "$body" ] || return 0
  if ! printf '%s\n' "$body" | "$filter" >"$dest"; then
    echo "review-packet.sh: failed to process $what output; skipping it" >&2
    rm -f "$dest"
  fi
  return 0
}

REMOTE="$(git remote get-url origin 2>/dev/null || true)"
HOST="$(remote_host "$REMOTE")"
# 取得できない理由は必ずstderrへ残す。黙って欠けると、呼び出し元が
# 「Issue番号を渡し忘れた」のか「この環境では取れない」のかを区別できない。
if [ -z "$HOST" ]; then
  echo "review-packet.sh: no origin remote; skipping issue/mr fetch" >&2
elif [ "${HOST%%:*}" = "github.com" ]; then
  if ! command -v gh >/dev/null 2>&1; then
    echo "review-packet.sh: gh not found; skipping issue/mr fetch" >&2
  else
    GH_HINT="check 'gh auth status'"
    GH_TEMPLATE='# {{.title}}

{{.body}}'
    if [ -n "$ISSUE" ]; then
      fetch_into "$OUT/issue.md" "issue #$ISSUE" "$GH_HINT" mask_secrets \
        gh issue view "$ISSUE" --json title,body -t "$GH_TEMPLATE"
    fi
    fetch_into "$OUT/mr.md" "pull request" "$GH_HINT" mask_secrets \
      gh pr view --json title,body -t "$GH_TEMPLATE"
  fi
else
  # github.com以外はGitLabとみなし、glabへホストを渡す。GitLabでないホストでも
  # ここへ来るので、失敗時の案内でそれにも触れる。
  if ! command -v glab >/dev/null 2>&1; then
    echo "review-packet.sh: glab not found; skipping issue/mr fetch" >&2
  elif ! command -v python3 >/dev/null 2>&1; then
    echo "review-packet.sh: python3 not found; skipping issue/mr fetch" >&2
  else
    # fetch_intoへ環境変数付きのコマンドを渡せないため関数で包む (envコマンドはPATH次第で別物になる)。
    glab_host() { GITLAB_HOST="$HOST" glab "$@"; }
    GLAB_HINT="check 'glab auth status --hostname $HOST'. If origin ($HOST) is not a GitLab host, this failure can be ignored"
    if [ -n "$ISSUE" ]; then
      fetch_into "$OUT/issue.md" "issue #$ISSUE" "$GLAB_HINT" title_body \
        glab_host issue view "$ISSUE" --output json
    fi
    fetch_into "$OUT/mr.md" "merge request" "$GLAB_HINT" title_body \
      glab_host mr view --output json
  fi
fi

# 差分が無いときは空のdiff.patchも消える。baseの指定間違い (fetch忘れなど) を
# 取得失敗と見分けられるよう、事実をstderrへ出す。
if [ "$CHANGED" -eq 0 ]; then
  echo "review-packet.sh: no changes between $BASE and $HEAD_REF" >&2
fi

# 空ファイルは残さない。agent側が「取得できなかった」と誤解しないようにする。
find "$OUT" -maxdepth 1 -type f -empty -delete

# ここまで来たら packet は完成。作りかけを消す trap を外してからパスを出す。
trap - EXIT
echo "$OUT"
