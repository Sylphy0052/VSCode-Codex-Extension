# CI設定の骨組み

[setup.md](setup.md)から参照される。

中身は持たない。stages、キャッシュ、実行条件までを骨組みとして示し、テストコマンドはプロジェクトごとに書く。言語・テスト構成に依存するため、雛形に埋め込むと必ず合わない。

## 先に確認する

```bash
glab api "projects/:id/runners"
```

出力から各要素の`description`と`status`を読む。応答の判定と停止は[glab-response.md](../../gitlab-develop/references/glab-response.md)に従う。

`online`のrunnerが1つも無いなら、CIを書いても走らない。設定を追加する前にこれを確認する。runnerが無い状態で`only_allow_merge_if_pipeline_succeeds`を`true`にすると、すべてのMRがマージできなくなる。

## 骨組み

```yaml
stages:
  - check

default:
  interruptible: true          # 新しいpushで古いジョブを止める

variables:
  GIT_DEPTH: "20"              # 浅いcloneで足りることが多い

check:
  stage: check
  image: <言語のイメージ>
  cache:
    key:
      files:
        - <ロックファイル>
    paths:
      - <依存のキャッシュ先>
  script:
    - <lint>
    - <型チェック>
    - <テスト>
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
```

### 各項目の意図

| 項目 | なぜそうするか |
| --- | --- |
| `stages`は1つから始める | 分ける必要が出てから分ける。最初から`build`・`test`・`deploy`と並べても、中身が無ければ待ち時間が増えるだけ |
| `interruptible: true` | 自己レビューの修正で何度もpushする。古いジョブが走り続けるとrunnerを占有する |
| `rules`でMRとデフォルトブランチに限定 | 全ブランチで走らせると、作業中のpushのたびにジョブが積まれる |
| `cache`のキーをロックファイルに紐づける | 依存が変わったときだけ作り直す |

`$CI_DEFAULT_BRANCH`を使う。`main`と直接書かない。`master`のリポジトリで動かなくなる。

## 検証

```bash
glab ci lint                      # 構文チェック
git push
glab ci status
```

pushする前に`glab ci lint`を通す。構文エラーのままpushすると、パイプラインが作られずMRのマージ条件が満たせない状態になりうる。

## `only_allow_merge_if_pipeline_succeeds`との順序

CIが動くことを確認してから`true`にする。逆にすると、パイプラインが無いか失敗する状態でマージできなくなり、設定を戻すまで作業が止まる。

1. `.gitlab-ci.yml`を追加する
2. MRを出してパイプラインが緑になることを確認する
3. `only_allow_merge_if_pipeline_succeeds`を`true`にする

## CIを置かない選択

ドキュメントだけのリポジトリなど、自動テストの対象が無い場合は置かなくてよい。その場合は次を明示する。

- `auto_devops_enabled`を`false`にする (設定が無いのに有効だと意図しないパイプラインが走りうる)
- `only_allow_merge_if_pipeline_succeeds`は`false`のままにする
- 何で品質を担保するかを規約ファイル (`CLAUDE.md`か`AGENTS.md`) に書く。「CIが無いので確認しない」で通さない
