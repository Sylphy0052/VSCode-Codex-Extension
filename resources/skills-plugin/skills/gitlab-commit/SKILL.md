---
name: gitlab-commit
description: 'GitLabで変更を論理単位でConventional Commits短形commit・pushする。Use when: 「コミット」「commit」、/codex-ext:gitlab-commit、codex-ext:gitlab-develop呼出時。Do not use: 実装、MR作成、マージ、直接push、無指示commit。'
allowed-tools: 'Bash(git:*), Read, Grep, Glob'
---

# gitlab-commit

**自発的な連続commitを避ける**。実装の途中で無関係な区切りごとに勝手にcommitが刻まれると、後から分割し直せない。人間が「いまcommitする」と明示したとき、または `codex-ext:gitlab-develop` が1タスク完了のタイミングで明示的に呼んだときだけ動く (`disable-model-invocation` は使わない。`codex-ext:gitlab-develop` からの委譲呼び出しもモデルによる起動に含まれ、その設定だとブロックされてしまうため。誤発火の抑止はdescriptionのUse when/Do not useで行う)。

リポジトリの `CLAUDE.md` / `AGENTS.md` にcommit規約の定めがあれば、そちらに従う。以下は既定。

## 起動のされ方

| 起動元                                                                                             | 何が違うか                                                       |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| ユーザーが Claude Codeでは `/codex-ext:gitlab-commit`、Codexでは `$codex-ext:gitlab-commit` と打つ | ローカル作業ファイルの更新漏れを確認する (下記)                  |
| `codex-ext:gitlab-develop` から呼ばれる                                                            | 呼び出し元がローカル作業ファイルを更新するため、ここでは触らない |

## 手順

```mermaid
flowchart TD
    A["1. 変更を見る"] --> B{"1 commit = 1論理単位か"}
    B -->|混在している| C["分割を提案する"]
    C --> D["2. ステージング"]
    B -->|単一| D
    D --> E["3. メッセージを作る"]
    E --> F["4. commit"]
    F --> G{"ブランチは<br/>デフォルトブランチか"}
    G -->|そうだ| H(["pushせず止まる"])
    G -->|違う| I["5. push"]
```

### 1. 変更を見る

```bash
git status
git diff --stat
git diff
```

**差分を読まずにcommitしない**。意図しない変更 (デバッグ用の出力、別セッションが触ったファイル、`.env`) が混ざる。

### 2. ステージング

**`git add -A` と `git add .` を使わない**。ファイルを明示指定する。

```bash
git add <path> <path>
```

一括ステージは、secretsや巨大なバイナリ、別の作業ブランチのファイル、別セッションが作業中のファイルを巻き込む。

#### 1 commit = 1論理単位

次が混ざっているなら分ける。

| 混在の例                  | なぜ分けるか                            |
| ------------------------- | --------------------------------------- |
| 実装 + 無関係なリファクタ | リファクタだけを戻せない                |
| 依存更新 + 機能追加       | 依存が原因の不具合を切り分けられない    |
| 複数バグの修正            | 1つを戻すともう1つも戻る                |
| 実装 + そのテスト         | **分けない**。REDからGREENまでで1セット |

分割が要ると判断したら、**commitする前に提案する**。勝手に分けても勝手にまとめてもいけない。

#### ステージした内容を見る

commitする前に、ステージした差分そのものを見る。

```bash
git diff --cached --stat
git diff --cached
```

**次の2つが混ざっていないかを見る**。どちらもcommitしてpushすると取り消せない。

```bash
# 資格情報
git diff --cached | grep -inE 'api[_-]?key|secret|passwd|password|token|BEGIN [A-Z ]*PRIVATE KEY'

# 作業ドラフト
git diff --cached --name-only | grep -E '^docs/(issue|mr)/'
```

どちらも**ヒットしないことが正常**。grepが何も返さなければ次へ進む。

このskill自身のように、検出パターンそのものを本文に含むファイルをcommitするときは偽陽性が出る。**ヒットした行が実際の値かパターンの記述かを目で見て切り分ける**。ヒットしたという理由だけで機械的に止めない。

資格情報が引っかかったら、**commitせずに止まる**。値をコードから外し、環境変数か秘密情報の管理先へ移してから作り直す。既にcommit済みなら、履歴からの除去とその値の失効 (rotate) の両方が要る。

作業ドラフト (`docs/issue/issue-<IID>.md` / `docs/mr/mr-<MRのIID>.md`) は**ローカル限定でリモートへpushしない**既定になっている。ヒットしたら `.gitignore` に次が入っているかを確認する。入っていなければ追記し、ステージから外す。

```
docs/mr/
docs/issue/
```

### 3. メッセージを作る

書式は `<type>(<scope>): <subject>`。`scope` は任意。

| type     | 用途                   |
| -------- | ---------------------- |
| feat     | 新機能                 |
| fix      | バグ修正               |
| refactor | 挙動を変えない構造改善 |
| docs     | ドキュメントのみ       |
| test     | テストのみ             |
| chore    | 依存・設定・雑務       |
| perf     | パフォーマンス改善     |
| ci       | CI設定                 |

- 件名は50文字を目安に、末尾に句点を打たない
- 日本語で書く。体言止めか、動詞で終える形
- bodyは任意。**なぜそうしたか**を書く。何をしたかは差分を見れば分かる
- 破壊的変更は `<type>(<scope>)!: <subject>` とし、bodyに移行内容を書く

#### commitに書かないもの

| 書かないもの                            | 理由                                                                                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `Closes #<IID>` / `Refs #<IID>`         | Issueとの紐付けはMR本文の `Closes #` に集約する。commitとMRの両方にあると、どちらが正かが分からなくなる                                  |
| `Co-Authored-By: Claude` などの帰属表記 | `Generated with Claude Code` / `Authored by Claude Code` も同様。既定ではAI起源を示す表記を書かない (リポジトリの規約が求める場合を除く) |
| 絵文字                                  | 既定で使わない                                                                                                                           |

混入していないか確認する。

```bash
git log -1 --format=%B | grep -iE 'claude|anthropic|authored by|generated with' && echo "NG: 帰属表記が混入している"
```

### 4. commit

```bash
git commit -m "<type>: <subject>"
```

**`--no-verify` と `-n` は使わない**。機械的な拒否はないので、**手順として守る** (リポジトリの `CLAUDE.md` / `AGENTS.md` が明示的に許可している場合だけ例外)。pre-commit hookが落ちたら、迂回せず原因を直す。

### 5. push

デフォルトブランチを決め打ちしない。

```bash
DEFAULT=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')
CURRENT=$(git branch --show-current)

if [ -z "$DEFAULT" ] || [ -z "$CURRENT" ]; then
  echo "判定できない (DEFAULT='$DEFAULT' CURRENT='$CURRENT')。pushしない"
elif [ "$CURRENT" = "$DEFAULT" ]; then
  echo "デフォルトブランチ ($DEFAULT) への直接pushは禁止。MR経由にする"
else
  git push
fi
```

**判定できないときはpushしない**。ここを省くと2つの経路でガードが無効になる。

| 状態                   | 何が起きるか                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `origin/HEAD` が未設定 | `symbolic-ref` が失敗して `DEFAULT` が空になる。空文字とブランチ名の比較は常に偽なので、**デフォルトブランチにいてもpushが通る** |
| detached HEAD          | `git branch --show-current` が空になる。同じく比較が偽になる                                                                     |

`origin/HEAD` が無い場合は次で設定できる (リモートを1回参照する)。

```bash
git remote set-head origin --auto
```

**`[ 条件 ] || { echo ...; }` の形で書かない**。メッセージを出すだけで後続の `git push` が素通りし、ガードにならない。分岐でpushそのものを包む。

初回は `-u origin "$CURRENT"` を付ける。`git push -f` と `--force` は使わない。必要になったら対象と影響範囲を示してユーザーの許可を得る。

## 検証の扱い

**commit前にテストやlintを自動では実行しない**。リポジトリの `CLAUDE.md` / `AGENTS.md` に検証コマンドの定めがあるとき、またはユーザーが明示したときにだけ実行する。実行しなかった場合はMR本文と完了報告に未実行であることを記録する。

## 単独起動されたとき

`codex-ext:gitlab-develop` は「commitのたびに `docs/issue/issue-<IID>.md` を更新する」と定めている ([gitlab-developのimplement.md](../gitlab-develop/references/implement.md))。単独で起動されると、これが漏れる。

ブランチ名からIIDを取り、該当ファイルがあれば**更新を促す。自動では書かない**。何を消化したかは実装した本人にしか分からない。

```bash
IID=$(git branch --show-current | cut -d/ -f2)
case "$IID" in
  ''|*[!0-9]*) echo "ブランチ名から取ったIIDが数字だけではない。促さずに終える" ;;
  *) ls "docs/issue/issue-${IID}.md" 2>/dev/null ;;
esac
```

**数字であることを確かめる**。`<type>/<IID>/<slug>` に従わないブランチ (`main`、`hotfix/urgent/fix` など) では2つ目の要素が数字にならず、存在しないファイルや無関係なファイルを指す。

促す内容は2つ。

- `### 実装計画` のうち、今のcommitで消化したチェック
- 試して駄目だったことがあれば `### 試したこと` へ1行

## 失敗パターン

| 失敗                         | 対処                                                                     |
| ---------------------------- | ------------------------------------------------------------------------ |
| commitする差分が無い         | `git add` を忘れている。`git status` を見る                              |
| pre-commit hookが落ちた      | 出力を読んで直す。自動整形が走った場合は再ステージングが要る             |
| 帰属表記が混入した           | `git commit --amend` で直す。push前なら安全                              |
| 間違ったファイルをcommitした | push前なら `git reset --soft HEAD^` で戻す。push後は打ち消しcommitを作る |
| `--amend` したくなった       | push済みなら履歴が壊れる。**ユーザーの明示指示があるときだけ**行う       |

## 前提

pushする先はGitLabのリポジトリを前提にしている。このskill自体は `glab` を使わない。GitLabのホストは `git remote get-url origin` のURLから求める。
