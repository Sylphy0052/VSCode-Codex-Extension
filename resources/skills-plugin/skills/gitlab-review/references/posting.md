# GitLabへの投稿操作

[SKILL.md](../SKILL.md) から参照される。discussion・note・resolve・approve・削除のコマンドと落とし穴をここに集約する。初回レビュー / 再レビュー / 指摘対応の各モードは、ここに書いたコマンドをそのまま使う。

**ここにある操作はすべてGitLabへの書き込み**。ユーザーのgoを得てから実行する。

## 共通の準備

```bash
IID=<数字だけであることを確認済み>
glab api user
```

出力の `.username` を読み、以降 `ME=<値>` として使う。応答の判定と停止は[glab-response.md](../../gitlab-develop/references/glab-response.md)に従う。

```bash
glab api "projects/:id/merge_requests/$IID/versions"
```

出力の `[0]` (最新) から `base_commit_sha`、`head_commit_sha`、`start_commit_sha` を読む。行に紐づくdiscussionはこの3つのSHAを要求する。**投稿の途中でpushが入るとheadがずれる**。投稿前に一度取り、投稿後に `glab mr view $IID --output json` を単独で実行し、その出力の `.sha` が同じであることを確認する。応答の判定と停止は[glab-response.md](../../gitlab-develop/references/glab-response.md)に従う。

**`glab` は1回のBash呼出に単独で書く**。パイプ・コマンド置換・ファイルへのリダイレクトを付けない (sandbox付きセッションではコマンドがsandbox内で走り、GitLabホストへの接続を拒否されることがあるため)。

本文はローカルのドラフトファイルから `--field "body=@<path>"` で渡す。`--field` は値が `@` で始まるとファイルの中身を文字列として読む。

**本文を `"$(cat file.md)"` で渡さない**。sandbox付きのセッションではコマンド置換を含むコマンドがsandboxの除外 (`glab *`) に一致せず、sandbox内で走ってネットワークを拒否される。

**`--form "body=@file.md"` は使えない**。`--form` の `@` はファイルのアップロード (multipart) になり、本文の文字列にならない。`--form` と `--field` は併用できない。

**`position` は `--field 'position={...}'` のJSONオブジェクトで渡す**。`-f` (`--raw-field`) や `--field "position[new_line]=42"` の形では、`position[position_type]` のようなネストしたキーがそのままキー名になりGitLab側で無視される。**エラーにならず、positionの付かない通常のnoteが作られる**ため気づきにくい。

## 行に紐づくdiscussionを立てる

```bash
glab api "projects/:id/merge_requests/$IID/discussions" -X POST \
  --field "body=@$TMPDIR/mr-$IID/M1.md" \
  --field 'position={"position_type":"text","base_sha":"<base_commit_sha>","start_sha":"<start_commit_sha>","head_sha":"<head_commit_sha>","new_path":"path/to/file.py","old_path":"path/to/file.py","new_line":42}'
```

出力の `id` の先頭8桁と `notes[0].position.new_path`・`notes[0].position.new_line` を読む。`path`か`line`が無い、または応答がエラーになっている場合は失敗している (認証切れ・positionの形式違反などが本文に出る)。**1件ずつ投稿し、1件ずつ確認する**。ループで流して最後にまとめて確認すると、途中の失敗に気づかず総評の件数が合わなくなる。応答の判定と停止は[glab-response.md](../../gitlab-develop/references/glab-response.md)に従う。

`new_line` は**差分に含まれる行**でなければ通らない。事前に差分のhunk範囲を確認する。

```bash
git diff -U0 <base_sha>...<head_sha> -- path/to/file.py | grep '^@@'    # +N,M の範囲に new_line が入っているか
```

削除行を指す場合は `position` の `new_line` の代わりに `old_line` を使う。変更されていない行に付けたい場合は通らないことがあるので、行に紐づかないdiscussionへ落とす。

## 行に紐づかないdiscussionを立てる

対象ファイルが無い指摘 (MR本文、Issue本文) や、positionが通らない指摘に使う。**本文の先頭行に対象を書く**。

```bash
glab api "projects/:id/merge_requests/$IID/discussions" -X POST \
  --field "body=@$TMPDIR/mr-$IID/L5.md"
```

出力の `id` の先頭8桁と `notes[0].position` (無ければ「none」) を読む。応答の判定と停止は[glab-response.md](../../gitlab-develop/references/glab-response.md)に従う。

行に紐づかないdiscussionもresolvableになる。総評noteとは別物で、指摘として立てる。

## 総評noteを投稿する

**個別のdiscussionを全件投稿し終えてから、1巡につき1件だけ**。本文は note-template.md の総評テンプレートに従い、`reviewed-head` マーカーを含める。

```bash
glab api "projects/:id/merge_requests/$IID/notes" -X POST \
  --field "body=@$TMPDIR/mr-$IID/summary.md"
```

出力の `id` を読む (summary noteのid)。応答の判定と停止は[glab-response.md](../../gitlab-develop/references/glab-response.md)に従う。

投稿後に件数を突き合わせる。

```bash
glab api "projects/:id/merge_requests/$IID/discussions?per_page=100"
```

出力 (discussions一覧) から `notes[0].author.username == $ME` のものを拾い、`id` の先頭8桁・`notes[0].position.new_path` (無ければ「行なし」)・`notes[0].position.new_line`・`notes[0].body` の先頭40文字を一覧にする。応答の判定と停止は[glab-response.md](../../gitlab-develop/references/glab-response.md)に従う。

自分のdiscussion数 = 個別指摘の件数 + 総評1件 になっていることを確認する。

## discussionへ返信する

指摘対応 (address.md) と、再レビューで聞き返すときに使う。`<DISCUSSION_ID>` は取得したidをそのまま使い、手で組み立てない。

返信の本文は先にファイルへ書く。短縮SHAは `git rev-parse --short HEAD` を別コマンドで取り、その値を本文へ書き込む。`glab` の引数の中で `$(git rev-parse ...)` を展開しない (理由は冒頭の `$(cat ...)` と同じ)。

```text
`<短縮SHA>`で対応済。<何をどう直したか1行>
```

```bash
glab api "projects/:id/merge_requests/$IID/discussions/<DISCUSSION_ID>/notes" -X POST \
  --field "body=@$TMPDIR/mr-$IID/reply-<DISCUSSION_ID>.md"
```

## resolveする

```bash
glab api "projects/:id/merge_requests/$IID/discussions/<DISCUSSION_ID>" -X PUT --form resolved=true
```

resolveのたびに残りを数える。

```bash
glab api "projects/:id/merge_requests/$IID/discussions?per_page=100"
```

出力から `system == false` かつ `resolved == false` のnoteの件数を数える (自分のnoteも含めた件数)。応答の判定と停止は[glab-response.md](../../gitlab-develop/references/glab-response.md)に従う。

**自分の総評noteもresolvableとして残る**。マージ判定はこれも数える。approveの段になったら自分の総評noteもresolveする。残っていると `detailed_merge_status` が `discussions_not_resolved` になりマージが拒否される。

## approveする

```bash
glab mr approve "$IID"
```

```bash
glab api "projects/:id/merge_requests/$IID/approvals"
```

出力から `approved_by[].user.username` の一覧と `approvals_left` を読む。応答の判定と停止は[glab-response.md](../../gitlab-develop/references/glab-response.md)に従う。

**pushが入るとapproveが外れる設定がある**。再レビューでpushを確認したら、approvals を取り直して自分のapproveが残っているかを見る。外れていれば条件を満たした時点でもう一度approveする。

## 誤投稿を消す

goを得る前に投稿してしまった、内容を誤った、といったときに使う。**削除も書き込み操作**。消す対象のidと本文の先頭を提示してから実行する。

```bash
glab api "projects/:id/merge_requests/$IID/notes/<NOTE_ID>" -X DELETE
```

```bash
glab api "projects/:id/merge_requests/$IID/discussions?per_page=100"
```

出力から `notes[0].author.username == $ME` の件数を数える。0になったかを確認する。応答の判定と停止は[glab-response.md](../../gitlab-develop/references/glab-response.md)に従う。

discussionの最初のnoteを消すとdiscussionごと消える。

## 一時ファイルを片付ける

このMRの巡 (初回レビュー / 再レビュー / 指摘対応) で投稿し終えたら、ドラフトを消す。

```bash
rm -rf "${TMPDIR:?}/mr-$IID"
```

`${TMPDIR:?}`は`$TMPDIR`が空なら削除を実行せずに止める。空のまま`"$TMPDIR/mr-$IID"`と書くと`/mr-<IID>`を消しにいく。
