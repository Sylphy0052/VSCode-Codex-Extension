# 点検項目と推奨値

[setup.md](setup.md)のフェーズ2から参照される。

上から順に流す。取得できなかった項目は「不明」として残す。取得失敗を「設定されていない」と読み替えない。応答の判定と停止は[glab-response.md](../../gitlab-develop/references/glab-response.md)に従う。

## GitLab側

```bash
glab api "projects/:id"
```

出力から`visibility`、`default_branch`、`merge_method`、`squash_option`、`remove_source_branch_after_merge`、`only_allow_merge_if_pipeline_succeeds`、`only_allow_merge_if_all_discussions_are_resolved`、`auto_devops_enabled`、`issues_enabled`、`merge_requests_enabled`、`wiki_enabled`を読む。

`projects/:id`の応答には`runners_token`が入ることがある (Maintainer以上で取得した場合)。Runner登録に使える資格情報なので、応答をファイルへ保存したり、利用者への報告にそのまま貼ったりしない。必要なフィールドだけを読む。ファイルへ書く必要があるときは、`mktemp`で作り`chmod 600`した一時ファイルへ、`runners_token`を除いた内容だけを書き、使い終わったら消す。

```bash
glab api "projects/:id/protected_branches"
```

出力から各要素の`name`、`push_access_levels[].access_level_description`、`merge_access_levels[].access_level_description`、`allow_force_push`を読む。

```bash
glab label list
glab api "projects/:id/runners"
```

runnersの出力から各要素の`description`と`status`を読む。

```bash
glab api "projects/:id/wikis"
```

出力から各要素の`slug`を読む。

| 項目 | 推奨 | ずれていると何が起きるか |
| --- | --- | --- |
| `only_allow_merge_if_all_discussions_are_resolved` | `true` | 未対応の指摘を残したままマージできる。レビューの往復が成立しない。CEで機械強制できる数少ない条件の1つ |
| `only_allow_merge_if_pipeline_succeeds` | CIがあれば`true` | テストが落ちたままマージできる。CIが無い状態で`true`にすると、パイプラインが無いMRをマージできなくなる |
| `remove_source_branch_after_merge` | `true` | マージ後にブランチが残り、後片付けが手作業になる。`codex-ext:gitlab-cleanup`の負担が増える |
| `merge_method` | リポジトリ規約に従う。規約が無ければ現状を報告するだけで、変更を提案しない | 規約と違うと、履歴の形がチームの想定と変わる |
| `squash_option` | 同上 | 同上。squashするとコミット単位の意図が消えるため、規約があるならそれを確認する |
| `auto_devops_enabled` | `false` | `.gitlab-ci.yml`が無いのに有効だと、意図しないパイプラインが走りうる |
| 保護ブランチ (デフォルトブランチ) | pushはMaintainer、force push禁止 | force pushで履歴を壊せる。誰でも直接pushできる状態では、MRを経ない変更が入る |
| ラベル | Issueの種別と揃える | Issue・MRの分類ができない。一覧から目的のものを探せなくなる |
| runner | 1つ以上`online` | CIを書いても走らない |

### エディションによる差

```bash
glab api version
```

出力から`version`と`enterprise`を読む。

`enterprise: false` (Community Edition) では次が存在しない。点検項目から落とす。

| 機能 | CE | 代替 |
| --- | --- | --- |
| MR承認ルール (`approval_rules`) | 404 | 無い。自己マージの禁止は運用でしか担保できない |
| 承認数の必須化 (`approvals`) | 404 | 無い |
| コードオーナー | 無し | 規約ファイルに担当範囲を書く |

CEで機械強制できるのは`only_allow_merge_if_all_discussions_are_resolved`と`only_allow_merge_if_pipeline_succeeds`の2つだけ。第三者レビューの強制はできない。

## リポジトリ側

```bash
ls CLAUDE.md AGENTS.md CONTRIBUTING.md .gitignore .gitlab-ci.yml
git symbolic-ref refs/remotes/origin/HEAD
glab --version
grep -E 'docs/(issue|mr)' .gitignore "$(git rev-parse --git-path info/exclude)"
```

存在しないファイルは`ls`がエラーを返す。エラーになったものは「無い」と読んでよいが、`ls`以外の理由 (権限など) で失敗していないかをメッセージで確かめる。

| 項目 | 推奨 | 無いと何が起きるか |
| --- | --- | --- |
| `CLAUDE.md`・`AGENTS.md`・`CONTRIBUTING.md`のいずれか | あり | 規約がどこにも書かれていない。skillは既定の規約 (ブランチ名、`Closes #`など) で動くが、リポジトリ固有の確認コマンドや触らない場所が伝わらない |
| `docs/issue/`・`docs/mr/`のpush除外 | `.gitignore`か`.git/info/exclude`にある | 作業ドラフトがリポジトリへ混入する。`codex-ext:gitlab-issue`と`codex-ext:gitlab-develop`がこれを前提にしている |
| `.gitlab-ci.yml` | プロジェクトによる | CIが走らない。`only_allow_merge_if_pipeline_succeeds`も意味を持たない |

## 環境側 (確認のみ、変更しない)

```bash
command -v glab && glab --version
command -v jq
glab auth status
echo "$GITLAB_HOST"
```

| 項目 | 期待 | 満たさないと |
| --- | --- | --- |
| `glab` | インストール済み | GitLabの操作が一切できない |
| `jq` | インストール済み | `glab api`の応答を読む手順が失敗する |
| 認証 | originのホストに対して`glab auth status`が通る | GitLabの操作が一切できない |
| `GITLAB_HOST` | 未設定、またはoriginのホスト | 別のホストを見に行く |

これらは変更しない。利用者の環境設定にあたるため、必要なら手順を提示して承認を得る。

## 見ていない項目

点検した項目と、見ていない項目を分けて伝える。GitLabの設定は多く、全部は見られない。

このチェックリストが見ていないもの。

- メンバーと権限の割り当て
- Webhook、インテグレーション
- コンテナレジストリ、パッケージレジストリ
- CI/CD変数、デプロイキー、環境
- Issueボードの設定、マイルストーン
- プッシュルール (CEでは大半が使えない)

必要になったら個別に見る。ここに無いことが「問題無い」ではない。
