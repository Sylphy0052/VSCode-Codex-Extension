# マージモード

[SKILL.md](../SKILL.md) から参照される。指摘がなくなり承認が揃ったMRをマージする。

**マージは取り消しにくい**。マージ後のrevertは履歴に残り、Issueは自動でcloseされ、`--remove-source-branch` を付けていればブランチも消える。確認を飛ばさない。**マージも書き込み操作**。ユーザーのgoを得てから実行する。

## マージ前の確認

すべて満たしていることを確認してから実行する。**1つでも欠けたらマージしない**。

```bash
glab mr view $IID --output json
```

出力から `author.username` (author)、`state`、`draft`、`head_pipeline.status` (pipeline)、`has_conflicts`、`blocking_discussions_resolved`、`detailed_merge_status`、`sha` を読む。応答の判定と停止は[glab-response.md](../../gitlab-develop/references/glab-response.md)に従う。

```bash
glab api user
```

出力の `.username` を読み、以降 `ME=<値>` として使う。応答の判定と停止は[glab-response.md](../../gitlab-develop/references/glab-response.md)に従う。

```bash
glab api "projects/:id/merge_requests/$IID/discussions?per_page=100"
```

出力 (discussions一覧) を保持する。自分のnoteも含めて、未resolvedのnote (`system == false` かつ `resolved == false`) の件数を数える。0件であることを確認する。応答の判定と停止は[glab-response.md](../../gitlab-develop/references/glab-response.md)に従う。

```bash
glab api "projects/:id/merge_requests/$IID/approvals"
```

出力から `approved_by[].user.username` の一覧と `approvals_left` を読む。応答の判定と停止は[glab-response.md](../../gitlab-develop/references/glab-response.md)に従う。

**`glab` は1回のBash呼出に単独で書く**。パイプ・コマンド置換・ファイルへのリダイレクトを付けない (sandbox付きセッションではコマンドがsandbox内で走り、GitLabホストへの接続を拒否されることがあるため)。出力のJSONを直接読んで値を拾い、次のコマンドへ書く。

| 確認                                         | 期待                                              | 満たさない場合                                                                  |
| -------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------- |
| authorが自分でない                           | `author != $ME`                                   | 自分なら下記「自己マージ」の条件で判定する                                      |
| MRがDraftでない                              | `draft: false`                                    | `glab mr update $IID --ready` を先に                                            |
| **指摘がなくなっている**                     | 下記「「指摘がなくなった」の判定」を3つとも満たす | 再レビューへ戻る                                                                |
| `detailed_merge_status` がブロックしていない | `"mergeable"`                                     | `"discussions_not_resolved"` なら自分の総評note含め全件resolveする (posting.md) |
| CIが緑                                       | `pipeline: "success"`                             | 落ちているなら直す。pipelineが無い場合は下記                                    |
| コンフリクトが無い                           | `has_conflicts: false`                            | rebaseまたはmergeで解消してから                                                 |
| 承認が揃っている                             | `approvals_left: 0`                               | reviewerを待つ。`null` の場合は下記                                             |
| `Closes #<IID>` がMR本文にある               | 記載あり                                          | 無いなら追記する。無いとIssueが閉じない                                         |

### 「指摘がなくなった」の判定

**未resolvedが0件であることと、指摘がなくなったことは別**。まだ読み直していない差分があれば、指摘は「無い」のではなく「まだ出ていない」だけ。

| 条件                         | 確認方法                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| 全discussionがresolved       | **自分のnoteを含めた**全件で件数0 (上の確認)                                                  |
| 最新のpushまで読み終えている | 最後の総評noteの `reviewed-head` が現在の `.sha` と一致する (SKILL.md の現在地判定と同じ確認) |
| 最新巡で新規の指摘が0件      | 最後の総評noteの承認可否が「承認」で、新規の指摘が0件                                         |

**`reviewed-head` と現在のheadが違うなら、resolveした後に入った差分を誰も読んでいない**。マージせず再レビューへ戻る。

`blocking_discussions_resolved` はGitLab側の判定で、リポジトリ設定によっては未resolvedがあっても `true` になる。**この値だけを根拠にしない**。件数を自分で数える。

**未対応の指摘の数え方 (`author != $ME` で絞る、SKILL.md) はここでは使わない**。それは「他人からの指摘の残り」を数える式で、自分の総評noteがresolvableのまま残っていても0件と出る。GitLabの実際のマージ判定は自分のnoteも見るため、残っていると `detailed_merge_status: "discussions_not_resolved"` で `glab mr merge` が拒否される。

### 承認ルールが無い場合

`approvals_left` が `null` なら承認の要否が定義されていない。**`0` と同じ扱いにしない**。`approved_by` が空で `null` なら、誰も承認していない状態でマージしようとしている。総評noteが投稿されているかを確認し、**ユーザーへ確認してから進む**。

### CIが無い場合

`head_pipeline` が `null` のリポジトリでは、**何で品質を担保したかをユーザーへ伝えてから進む**。「CIが無いので確認しない」で通さない。

## 誰がマージしてよいか

| authorが       | どうするか                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| **自分でない** | マージしてよい。上の確認を全件通し、goを得てから実行する                                                     |
| **自分**       | 下記「自己マージ」の条件を満たすときだけマージしてよい。満たさなければマージせず、足りない条件を伝えて止まる |

### 自己マージ

第三者の目が1回も入らないまま本流へ入ることになるので、次の順で判定する。**どの場合も `critical` / `high` / `medium` の未対応が0件であることは必ず確認する** (severityの定義は [review-common.md](review-common.md) の「severity」)。リポジトリの `CLAUDE.md` / `AGENTS.md` の記載で変わるのは自己マージしてよいかと巡数の上限だけで、この品質条件は外せない。

1. リポジトリの `CLAUDE.md` / `AGENTS.md` に自己マージの記載 (許可・禁止・独自条件) があれば、自己マージしてよいかと巡数の上限はそれに従う。記載が「既定の条件より優先する」という書き方でも、`critical` / `high` / `medium` の未対応0件の確認は省かない
2. 記載が無ければ、本skillの既定として次の3点を満たすときだけマージしてよい。
   - 自己レビューを通した。巡数をMR本文の `## レビュー記録` で確かめる。レビューが1度も入っていないMRはマージしない
   - `critical` / `high` / `medium` の未対応が0件
   - 見送った `low` が1件以上残るなら、MRごとに1件のIssueへ切り出してある。0件なら切り出しは不要。[self-review-exit.md](self-review-exit.md) の「切り出し漏れの機械検査」を実行し、終了コード0を確かめる
3. 上の2つの条件を満たせない環境 (自己レビューを通せない、リポジトリの記載が禁止している等) では禁止とし、ユーザーがこのセッションで明示的に許可した場合だけ行う。squash mergeはどの場合も行わない (`--squash` を付けない)

## マージする

```bash
glab mr merge $IID --remove-source-branch --yes
```

- `--remove-source-branch` を推奨する。付けないとマージ後にブランチが残り、後片付けが手作業になる
- `--yes` は確認プロンプトを飛ばす。**上の確認を全部通し、goを得てから**使う
- squash commitとsquash mergeは禁止する

マージ後の確認。

```bash
glab mr view $IID --output json
```

出力から `state` と `merge_commit_sha` を読む。応答の判定と停止は[glab-response.md](../../gitlab-develop/references/glab-response.md)に従う。

```bash
glab issue view <Closes対象のIID> --output json
```

出力から `state` を読む。応答の判定と停止は[glab-response.md](../../gitlab-develop/references/glab-response.md)に従う。

`Closes #<IID>` があればIssueは自動でcloseされる。**closeされたことと、完了記録が残っていないことは別**。完了記録は後片付けで書く。

## マージ後

**後片付けは行わない**。ブランチ削除、ローカル作業ファイルの削除、Issueへの完了記録は `codex-ext:gitlab-cleanup` の担当。

ユーザーへ次を伝えて終わる。

- マージが完了したこと (MRのIIDとマージ先のコミット)
- Issueがcloseされたかどうか
- **後片付けが残っていること**

## マージできない場合の分岐

| 状況                                             | どうするか                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------ |
| CIが落ちている                                   | 落ちたジョブのログを確認する。原因が変更由来なら指摘対応モードと同じ流れで直す |
| コンフリクト                                     | `glab mr rebase $IID` を試す。解消できないならローカルで解決してpushする       |
| 承認が足りない                                   | reviewerへ依頼する。待つ以外にできることが無いことを伝えて止まる               |
| 未resolvedの指摘が残っている                     | 指摘対応モードへ戻る。**残したままマージしない**                               |
| `reviewed-head` と現在のheadが違う               | 再レビューへ戻り、その差分を読む。**読まずにマージしない**                     |
| authorが自分で、「自己マージ」の条件を満たさない | マージせず、足りない条件を伝えて止まる                                         |
| MRがDraftのまま                                  | `codex-ext:gitlab-develop` の区間が終わっていない。そちらへ戻す                |
