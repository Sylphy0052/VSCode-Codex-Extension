# フェーズ3-4: 実装とMR作成

[SKILL.md](../SKILL.md) から参照される。

## フェーズ3: 実装する

### 1タスク = 1コミット

Issue本文の `### 実装計画` を上から順に消化する。1タスクを終えたらcommitする。まとめてcommitしない。

**commitの手順は `codex-ext:gitlab-commit` ([SKILL.md](../../gitlab-commit/SKILL.md)) が持つ**。ここからそれを呼ぶ。メッセージの書式、分割の判断、帰属表記、pushの可否はすべて向こうにある。二重に書かない。

`codex-ext:gitlab-commit` は利用者の発話からの誤発火を防ぐためdescriptionを絞ってあるだけで、モデルからの呼び出しは禁止していない。Claude CodeはSkillツールで、Codexは `$codex-ext:gitlab-commit` として、**ここから明示的に呼ぶ**。呼ばれた側はローカルMarkdownを触らない (下記のとおり、この場で更新するため)。

### commitのたびにローカルMarkdownを更新する

これが最も忘れられやすい。**commitと同じタイミングで必ず行う**。

| 更新する箇所 | いつ | 何を書くか |
| --- | --- | --- |
| `### 実装計画` のチェック | そのタスクのcommitを作った時点 | `- [ ]` を `- [x]` にする |
| `### 試したこと` の表 | 試して駄目だった時点 | 試したこと / 結果 / 採否 の3列 |
| `### 調査で分かったこと` | 分かった時点 | 次に効く事実 |
| `### 起票時の想定との差` | 差が出た時点 | 何がどう違ったか |

受入基準のチェックは**検証が成功した時点**で付ける。実装しただけでは付けない。

**試して不採用にした案はMRの差分に残らない**。ここに書かないと記録がどこにも残らない。「動かなかったので別の方法にした」は、それ自体が次に効く情報になる。

### 計画から外れたとき

実装中に計画が変わることは普通にある。**黙って変えない**。

- タスクが増えた — `### 実装計画` に追加し、`### 起票時の想定との差` に理由を書く
- タスクが不要になった — 消さずに `- [x] (不要になった: 理由)` の形で残す
- 別の問題を見つけた — このIssueで対応せず、Issue化を提案する。scopeを広げない

### 品質チェック

commit前の自動実行は行わない。**必要なタイミングで手動で回す**。

- 実行する検証は、リポジトリ規約と利用者の指示に従う。規約や指示が無ければ、受入基準の `検証:` に書かれたコマンドを実行し、結果を記録する
- 規約や指示で実行しない、または環境の都合で実行できない検証は、実行せず、MR本文へ未実行であることと理由を記録する

結果はMR本文の受入基準の `結果:` に書く。「動くはず」で埋めない。

### 途中で止まるとき

セッションが切れる、日をまたぐ、といった場合は**ローカルMarkdownを最新にしてから止まる**。次の起動で現在地判定がここを読む。

## フェーズ4: MRを作る

### 作る前に確認する

```bash
git log --oneline <default>..HEAD
git diff --stat <default>...HEAD
```

- 実装計画のタスクがすべて消化されているか (残っているなら、なぜ残したかをMRに書く)
- 意図しないファイルが混ざっていないか (`docs/issue/` `docs/mr/` は `.git/info/exclude` に入れてあるので入らないはず)

### 本文をローカルMarkdownに書く

```bash
mkdir -p docs/mr
```

`docs/mr/mr-<IID>.md` (IssueのIIDの仮名。MR作成後にMRのIIDへ改名する) に書く。テンプレートは [mr-template.md](mr-template.md) にある。

**Issueの写しにしない**。MRは「実際に何が変わったか」と「Issueに書いた予定との差」を書く場所。過程はIssue、結果はMR。

### Draftで作る

```bash
git push -u origin <branch>
glab api projects/:id/merge_requests -X POST \
  --raw-field "source_branch=<branch>" \
  --raw-field "target_branch=<default>" \
  --raw-field "title=Draft: <title>" \
  --field "description=@docs/mr/mr-<IID>.md" \
  --field "remove_source_branch=true"
```

- **`remove_source_branch=true` を既定にする**。リポジトリ規約やプロジェクトの設定が別の扱いを求めるなら従う。付けない場合は後片付けで残ったbranchを処理する
- **`Closes #<IID>` を本文に必ず入れる**。IssueとMRを機械的に結ぶ唯一の手段
- readyにするのはフェーズ6。自己レビューを終えるまでDraftのまま
- `<branch>` は `git rev-parse --abbrev-ref HEAD` を別に実行して確かめた値をそのまま書く

**`glab`と`git push`の引数にコマンド置換 (`"$(cat ...)"`・`"$(git rev-parse ...)"`) を書かない**。sandbox付きのセッションでは、置換を含むコマンドがsandboxの除外設定に一致せず、sandbox内で走ってネットワークを拒否されることがある。worktree隔離のセッションでは「検証できない複雑なコマンド」として拒否されることもある。本文はファイルに書き、`glab api`の`--field <key>=@<path>`で渡す。本文以外の文字列は`--raw-field`で渡す (`--field`は数値や真偽値へ型を変える)。

`--field draft=true`はGitLab側で無視される。draft化はタイトルの`Draft:`プレフィックス (コロンの後に半角スペース) でのみ機械判定される。`glab mr create --draft`はこのプレフィックスを自動で付けるが、`glab api`直叩きではtitleに自分で含める必要がある。**`glab mr create`を使う場合は`--title`に`Draft:`を含めたまま`--draft`を併用しない**。両方付けるとプレフィックスが二重になる (`Draft: Draft: <title>`)。

応答の判定と停止は [glab-response.md](glab-response.md) に従う。

作成後、返ってきたMRのIIDでローカルファイル名が正しいかを確認する。IssueのIIDとMRのIIDは別物なので、ファイル名は**MRのIID**に合わせる。**返ってきた値は数字だけであることを確認してから使う**。

```bash
MR_IID=<API応答の.iid>
case "$MR_IID" in
  ''|*[!0-9]*) echo "MRのIIDが数字でない。ここで止めて利用者へ報告する" ;;
  *) mv docs/mr/mr-<IID>.md "docs/mr/mr-$MR_IID.md" ;;
esac
```
