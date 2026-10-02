---
name: gitlab-issue
description: 'GitLabにIssueを起票する。SDD仕様書兼実装計画として概要・詳細・確認点の3部構成で書き、現状を残す。Use when: 「Issue作成」「起票」「チケット切って」「仕様書」「バグ報告」「調査したい」、/codex-ext:gitlab-issue。Do not use: 既存Issue更新、GitHub issue。'
allowed-tools: 'Bash(glab auth status), Bash(glab issue list:*), Bash(glab issue view:*), Bash(glab issue create:*), Bash(glab label list:*), Bash(glab api projects/:id/milestones:*), Bash(git status:*), Bash(git rev-parse:*), Bash(mkdir:*), Bash(mv:*)'
---

# gitlab-issue

GitLabのIssueを起票する。起票のみを担当し、起票後の本文更新は着手skillの範囲。

## 前提

- GitLabのhostは `git remote get-url origin` から求める (`git@host:group/proj.git` と `https://host/group/proj.git` の両形式。例: `gitlab.example.com`)。`glab` CLIを使い、`gh` は使わない
- 認証確認: `glab auth status --hostname <host>`。未認証なら `glab auth login --hostname <host>` で認証する。`GITLAB_HOST=<host>` を環境変数に置けば以降の `glab` に `--hostname` を付けずに済む
- 規約は既定を書く。リポジトリの `CLAUDE.md` / `AGENTS.md` に定めがあればそちらに従う
- **1 Issue 1 Branch**。Issueを起票せずに実装を始めない
- Issueは日本語で書く (リポジトリの規約が別言語なら従う)

## フェーズ1: 種別を決める

先に種別を決める。テンプレートが変わる。

| 種別       | 使う場面                                       |
| ---------- | ---------------------------------------------- |
| `feature`  | 新機能、機能追加                               |
| `chore`    | 環境整備、CI、雑務。スコープを明示して区別する |
| `bug`      | 不具合の報告と修正                             |
| `research` | 調査、技術選定。実装しない                     |
| `trivial`  | typo、設定値1つの変更、依存バージョン更新      |

`trivial` を使ってよいのは**変更が1ファイル数行に収まり、技術判断もリスクも無い**場合だけ。迷ったら `chore` にする。

種別が判断できないときは推測せず、A/B/C形式でユーザーに聞く。Claude Codeでは `AskUserQuestion` で選択肢を出し、Codexでは会話で質問して返答を待つ。

## フェーズ2: 重複を確認する

```bash
glab issue list --search "<キーワード>" --all --per-page 10
```

似たIssueがあれば、既存への追記で足りるかを判断する。足りるなら起票しない。

## フェーズ3: 本文を書く

**ローカルのMarkdownファイルに書く**。GitLabへ直接書かない。

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
mkdir -p "$REPO_ROOT/docs/issue"
```

`docs/issue/` は `.gitignore` 対象。未登録なら追記する。

種別に応じてテンプレートを読み、そのまま埋める。

- [templates/feature.md](templates/feature.md) — feature / chore
- [templates/bug.md](templates/bug.md) — bug
- [templates/research.md](templates/research.md) — research
- [templates/trivial.md](templates/trivial.md) — trivial

書き方の規約は [references/conventions.md](references/conventions.md) にある。**初めて起票するとき、または規約を思い出せないときは必ず読む**。

要点だけ再掲する。

### 見出しを変えない

見出しの追加・削除・改名を禁止する。GitLabにはGitHub Issue Formsのような構造化機能が無く、見出し文字列が機械読解の唯一のアンカーになる。

先頭の `**種別**:` トークンも必須。これが無いとどのテンプレートか判定できない。

### 空欄を残さない

固定語彙3つで埋める。切り分けの基準は**回答者が誰か**。

| 語彙             | 意味                           | 誰が解消するか |
| ---------------- | ------------------------------ | -------------- |
| `N/A`            | 検討した上で該当なし           | 解消不要       |
| `(実装後に記載)` | 起票時点では書けない           | 起票者自身     |
| `要確認: <質問>` | ユーザーに聞かないと決まらない | ユーザー       |

自分で調べれば分かること・実装すれば決まることは `(実装後に記載)`。ユーザーの意向や外部の事情に依存するものだけが `要確認:`。

**`要確認:` が1つでも残っているIssueは着手できない**。起票してよいが、着手をブロックする状態であることをユーザーへ伝える。

### 着手前の現状を必ず書く

概要の `**現状**:` は**起票時にしか書けない**。実装が進むと元の状態は再現できない。

- UI変更 — 着手前の画面のスクリーンショットを貼る
- バグ — エラーメッセージの原文、不具合が見えている画面
- 設定・環境 — 変更前の設定値、バージョン

### 受入基準には検証と期待を対で書く

```markdown
- [ ] (何が満たされれば完了か)
  - 検証: `<コマンド>`
  - 期待: (出力・状態)
```

機械検証が原理的にできないもの (ドキュメントの内容の妥当性、設計判断、UIの見た目、文体) は目視確認形式を使う。

```markdown
- 検証: (目視確認) <確認する観点>
- 期待: (どうなっていれば合格か)
```

`grep` で形だけ確認する検証は書かない。形骸化するだけで、目視確認と正直に書いた方が良い。

### 概要は非エンジニアが読んで分かる語で書く

`## 概要` の読み手は非エンジニア。専門用語を使わない。各ラベル1〜2行。

利用者から見て何も変わらない変更 (内部リファクタ、環境整備) では、「開発者から見た変化」に読み替えて書く。

### 図にすると分かりやすいならMermaidを入れる

GitLabは ` ```mermaid ` フェンスを描画する。処理の流れ、状態遷移、構造の対比、分岐が多い判断は図にすると速い。

**図にしても情報が増えないなら書かない**。

## フェーズ4: 自己チェック

GitLabには必須項目を強制する仕組みが無い。**起票の前にここで自分で確認する**。

- [ ] 先頭に `**種別**:` があり、値が5種のいずれか
- [ ] その種別のテンプレートの見出しがすべて存在する (追加・削除・改名なし)
- [ ] 空欄が無い (`N/A` / `(実装後に記載)` / `要確認:` のいずれかで埋まっている)
- [ ] 概要に `**現状**:` があり、着手後に読んでも着手前の状態が分かる
- [ ] 概要が専門用語を使わずに書けている
- [ ] 受入基準のすべてに検証と期待がある (コマンド形式または目視確認形式)
- [ ] 目視確認形式を使った項目が、機械検証が原理的にできないものに限られている
- [ ] UI変更があるなら、スクリーンショットまたはその撮影条件が書かれている
- [ ] `要確認:` が残っている場合、着手をブロックする状態であることをユーザーへ伝えている

1つでも欠けたらフェーズ3へ戻る。

## フェーズ5: 起票する

本文をユーザーに提示し、承認を得てから実行する。**`<slug>`はファイル名へ使う前に許可文字だけであることを確認する**。

```bash
SLUG=<ここで決めたslug>
case "$SLUG" in
  ''|-*|*[!a-z0-9-]*) echo "slugが英小文字・数字・ハイフン (先頭はハイフン以外) 以外を含む。ここで止めてユーザーへ報告する" ;;
esac
```

止めると出たら次へ進まない。確認を通ったら起票する。

```bash
glab api projects/:id/issues -X POST --raw-field "title=<title>" --field "description=@docs/issue/draft-$SLUG.md"
```

本文を`--description "$(cat ...)"`で渡さない。sandbox付きのセッションではsandbox内で走ってネットワークを拒否される ([implement.md](../gitlab-develop/references/implement.md) の「Draftで作る」を参照)。

起票後、応答JSONの`iid`でローカルファイルをリネームする。**`<IID>`は数字だけであることを確認してから使う**。

```bash
IID=<応答JSONの.iid>
case "$IID" in
  ''|*[!0-9]*) echo "起票応答のIIDが数字でない。ここで止めてユーザーへ報告する" ;;
  *) mv "docs/issue/draft-$SLUG.md" "docs/issue/issue-$IID.md" ;;
esac
```

**このローカルファイルが以降の作業中の正本**になる。着手skillはこれを更新し、切りが良いときにGitLabへpushする。

ラベル・マイルストーン・期限は、プロジェクトがこの運用を採っている場合、起票時に設定する。ステータスラベルの標準5種 (`ToDo` / `Doing` / `OnHold` / `Review` / `Done`)、マイルストーンの切り方、期限の逆算は [references/conventions.md](references/conventions.md) の「ラベル・マイルストーン・期限」にある。運用の有無は `glab label list` と `glab api "projects/:id/milestones"` で確認する。担当者もプロジェクトが運用している場合のみ付ける。

## 出口基準

- [ ] Issueが起票され、URLが返っている
- [ ] `docs/issue/issue-<IID>.md` が存在し、GitLab側の本文と一致している
- [ ] フェーズ4の自己チェック9項目をすべて満たしている
- [ ] `要確認:` が残っている場合、その旨をユーザーへ伝えている

## 次にすること

着手するなら `codex-ext:gitlab-develop` (Claude Codeでは `/codex-ext:gitlab-develop`、Codexでは `$codex-ext:gitlab-develop`) を使う。`要確認:` が残っているなら、先にユーザーの回答を得る。

## やらないこと

- **既存Issueの本文更新** — 実装中の進捗反映は着手skillの担当
- **本文の整頓、別問題の切り出し** — 必要になった時点で追加する
- **ブランチ作成、実装** — 着手skillの担当
