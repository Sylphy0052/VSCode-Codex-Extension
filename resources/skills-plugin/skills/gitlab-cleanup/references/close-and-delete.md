# フェーズ3-4: Issueを締めて消す

[SKILL.md](../SKILL.md)から参照される。**この順序を入れ替えない**。完了記録はローカルの作業ファイルを見て書くため、先に消すと書けなくなる。

## フェーズ3: Issueを締める

**IssueのIIDとMRのIIDは`docs/issue/`・`docs/mr/`のファイル名に使う前に確認する**。ブランチ名やGitLabの応答から取った値をここで初めてパスへ埋め込むので、このフェーズの最初に両方を1回ずつ確認する。以降のフェーズで再度確認しない。`<IID>` `<MRのIID>`と書いた箇所には、ここで確認した`$IID` `$MR_IID`を使う。

```bash
IID=<IssueのIID>
MR_IID=<MRのIID>
case "$IID" in
  ''|*[!0-9]*) echo "IssueのIIDが数字だけではない。ここで止めてユーザーへ報告する" ;;
esac
case "$MR_IID" in
  ''|*[!0-9]*) echo "MRのIIDが数字だけではない。ここで止めてユーザーへ報告する" ;;
esac
```

止めると出たら次へ進まない。

### 完了記録を書く

ローカルの作業ファイル (`docs/issue/issue-<IID>.md` / `docs/mr/mr-<MRのIID>.md`) とコミット履歴を読んで書く。テンプレートはnote-template.mdを使う (SKILL.mdから参照)。

```bash
git log --oneline "<default>" --since="<着手日>" -- <変更したパス>
glab mr view <MRのIID>
```

**Issueを見た人が、何が起きて何が残ったかを追える形**にする。MRを開かないと分からない書き方にしない。

ローカルの作業ファイルが無い場合 (別のセッションで作業した、既に消してしまった) は、GitLabから取り直す。

**`glab`はパイプ・コマンド置換を付けず単独で実行する**。sandbox付きのセッションでは、付けるとsandbox内で走ってGitLabへの接続を拒否されることがある。

```bash
glab issue view <IID>
```

```bash
glab mr view <MRのIID>
```

出力のMarkdown本文をそのまま読んで完了記録へ使う。応答の判定と停止は[glab-response.md](../../gitlab-develop/references/glab-response.md)に従う。

それでも試行錯誤の記録が見つからないなら、**無いことを完了記録に書く**。あったことにしない。

### 未達の受入基準を確認する

受入基準に`- [ ]`が残っているなら、**閉じる前に扱いを決める**。

| 状況 | どうするか |
| --- | --- |
| 実際は満たしている (チェック漏れ) | チェックを付けて閉じる |
| 満たしていないが、別Issueへ持ち越す | 持ち越し先を完了記録に書いて閉じる。持ち越し先のIssueが無いなら先に起票する |
| 満たしておらず、まだこのIssueの作業が残っている | **閉じない**。このskillを止めてユーザーへ報告する |

「だいたい終わったので閉じる」をしない。未達を残したまま閉じるなら、**どこへ持ち越したかを必ず書く**。

### 投稿してクローズする

**判定結果を提示して利用者の承認を得るまで、投稿とクローズを実行しない**。投稿するnoteの本文も、承認を得るときに見せる。承認はSKILL.mdの「承認を得てから実行する」で得る。

```bash
glab api projects/:id/issues/<IID>/notes -X POST --field "body=@/path/to/note.md"
glab issue close <IID>
```

ラベル体系 (ToDo/Doing/OnHold/Review/Done) があるプロジェクトでは、close時に`Done`ラベルも付与する。ラベル名がプロジェクトで違うなら、そのプロジェクトの名前に合わせる。

```bash
glab issue update <IID> --label Done --unlabel ToDo,Doing,OnHold,Review
```

`Closes #<IID>`がMR本文にあれば、マージ時に自動でクローズされている。その場合も**完了記録のnoteは投稿する**。自動クローズは状態を変えるだけで、何が起きたかを残さない。

```bash
glab issue view <IID>     # stateを確認してからcloseするか決める
```

### 統合MRなど、Closesが無い場合

複数Issueをまたぐ統合MRでは`Closes #<IID>`を付けられない (全部を機械的に閉じてしまうため)。この場合は**Issueごとに個別に判断して閉じる**。

- そのIssueの分は本当にマージされたか
- 他のセッションがまだそのIssueで作業していないか

判断がつかないIssueは閉じない。ユーザーへ提示する。

## フェーズ3.5: roadmapへ反映する

締めたIssueが`label=roadmap`のIssue (ロードマップ) のチェックリストに載っているかを確認し、載っていればそこも更新する。roadmapは複数Issueをまたぐ進捗の道標であり、子Issueを締めただけでは自動的に反映されない。

### roadmapを探す

**毎回全roadmap Issueを走査する**。子Issue側にroadmapへの逆リンクを持たせない設計 (roadmap側のフォーマット変更が不要なため) の代わりに、この走査を行う。

**`$ROADMAP_IID`はGitLabのAPIが返した数字のみであることを確認してから使う**。コマンド置換・ファイル名の一部になるため、他フェーズ (ローカルの作業ファイル削除) と同じ理由でここも確認する。

```bash
glab issue list --label roadmap --output json
```

出力JSONを読み、各要素の`iid`を数字のみであることを確認して一覧にする。応答の判定と停止は[glab-response.md](../../gitlab-develop/references/glab-response.md)に従う。

0件なら (roadmap未使用のプロジェクト、またはこのプロジェクトでまだ1件も作っていない)、**何もせず次のフェーズへ進む**。以降の手順は実行しない。

各roadmapの本文から、締めたIssueの行を探す。roadmap IIDごとに1回ずつ、素の`glab issue view`を呼ぶ。

```bash
glab issue view "<ROADMAP_IID>"
```

出力のMarkdown本文を読み、`#<締めたIID>` (直後にスペース) を含む行があるかを目視で確認する。あれば「roadmap #<ROADMAP_IID>に該当行あり」と判断する。応答の判定と停止は[glab-response.md](../../gitlab-develop/references/glab-response.md)に従う。

**検索パターンは末尾にスペースを含める** (`#<IID>`の直後)。`#5`が`#50` `#58`に部分一致するのを防ぐ。

見つからなければ、そのIssueはroadmap管理下にない。何もせず次のフェーズへ進む。

### 見つかったroadmapを更新する

**更新内容を提示して利用者の承認を得るまで、roadmapへの反映 (`-X PUT`を含む) を実行しない**。承認はSKILL.mdの「承認を得てから実行する」で得る。

`codex-ext:gitlab-roadmap`をUPDATEモードの機械可読な省略形で呼ぶ。ヒアリングを飛ばし、該当行のチェックとMermaid図の再生成だけを行わせる。Claude Codeは次の形で呼ぶ。Codexでは`/`を`$`に読み替える。

```text
/codex-ext:gitlab-roadmap update --check <締めたIID> --closed
```

呼び出せない環境では、[gitlab-roadmap/references/update.md](../../gitlab-roadmap/references/update.md)の「機械可読呼び出し」の手順をそのまま実行する。

**同じIIDが複数のroadmapに載っている場合は、見つかった全roadmapに対して行う**。1件見つかった時点で走査をやめない。

roadmap本文の更新自体 (チェックリストの書き換え・Mermaid再生成・GitLabへの反映) は`codex-ext:gitlab-roadmap`側の責務であり、ここでは呼び出すだけで内容には立ち入らない。

## フェーズ4: 消す

**フェーズ2の判定に通ったものだけを消す**。ここで判定をやり直さない。**判定結果を提示して利用者の承認を得るまで、ここの削除 (`git branch -D`、`git push origin --delete`、作業ファイルの`rm`) を実行しない**。承認はSKILL.mdの「承認を得てから実行する」で得たものを使い、判定結果が変わったときは取り直す。

### ローカルブランチ

**消すブランチをチェックアウトしている場合は、先に`<default>`へ移る**。自分がいるブランチは削除できない。後片付けの対象はたいてい直前まで作業していたブランチなので、この状態がほぼ毎回発生する。

```bash
git rev-parse --abbrev-ref HEAD          # いま自分がどこにいるか
git switch "<default>"
```

未コミットの変更があると`git switch`が拒否することがある。その場合は**変更の中身を確認してからユーザーへ提示する**。勝手にstashや破棄をしない。

`<branch>`はシェルで使う前に、形式を確かめる。既定の形式は正規表現`^[a-z]+/[0-9]+/[a-z0-9._-]+$` (`<type>/<IID>/<slug>`)。リポジトリ規約に別の命名があればそれでもよいが、英数字と`._/-`以外の文字を含む名前は使わない。合わない名前はコマンドに埋め込まず、ユーザーへ提示して止まる。ダブルクォートで囲んでも`$(...)`やバッククォートは展開されるので、囲むだけでは足りず、文字種の確認が要る。実行できる形:

```bash
printf '%s' "$BRANCH" | grep -Eq '^[a-z]+/[0-9]+/[a-z0-9._-]+$' || echo "ブランチ名が形式に合わない。ここで止める"
```

`<default>`も同様に、リモート由来の値なので`^[A-Za-z0-9._/-]+$`に合い`-`で始まらないことを確かめ、使う箇所はダブルクォートで囲む。

```bash
git merge-base --is-ancestor "<branch>" "<default>" && git branch -D "<branch>"
```

判定と削除を1行にまとめておく。判定が通らなければ削除は実行されない。

`git branch -d`を先に試して拒否されても、それはupstream基準の判定なので根拠にならない ([SKILL.md](../SKILL.md)のフェーズ2)。

### リモートブランチ

MR作成時に`--remove-source-branch`を付けていれば、マージ時に削除されている。残っている場合だけ消す。

**リモートにも同じ判定を適用する**。ローカルを消したからリモートも消してよい、とはならない。リモートにしか無いコミットが乗っている可能性がある。

`--prune`を先に打つ。リモートで既に消えているブランチの追跡参照が残っていると、判定が狂う。

```bash
git fetch origin --prune
git branch -r                                    # 残っているか確認
git merge-base --is-ancestor "origin/<branch>" "<default>"; rc=$?; echo "exit=$rc"   # 0: 含まれる、1: 含まれない、128: 判定できない (追跡参照が無いなど)
[ "$rc" -eq 0 ] && git push origin --delete "refs/heads/<branch>"
```

`<branch>`は上の形式確認に通ったものだけを使う。判定が通らなければ削除は実行されない。1なら「リモートにしか無いcommitがある」、128なら「判定できない」として、区別して報告する。

### ローカルの作業ファイル

```bash
rm -f docs/issue/issue-<IID>.md docs/mr/mr-<MRのIID>.md
```

`<IID>` `<MRのIID>`にはフェーズ3の`case`で確認した`$IID` `$MR_IID`を使う。ここで別の値を取り直さない。消す前に対象を列挙して見せる。

```bash
ls -1 docs/issue/issue-<IID>.md docs/mr/mr-<MRのIID>.md
```

`docs/issue/` `docs/mr/`はリモートへpushしないローカルの作業ドラフトで、リモートには存在しない。**GitLab側の本文が最新であることを確認してから消す**。ローカルにしか無い記述を消してしまうと復元できない。

```bash
glab issue view <IID>
```

出力の本文を一時ファイル (例: `$TMPDIR/issue-<IID>-remote.md`) へ書き出し、`diff $TMPDIR/issue-<IID>-remote.md docs/issue/issue-<IID>.md`で差分を確認する。Claude Codeでは書き出しにWriteツールを使う。応答の判定と停止は[glab-response.md](../../gitlab-develop/references/glab-response.md)に従う。

差分があるなら、先にGitLabへ反映する。反映または確認が終わったら一時ファイルを消す。

```bash
rm -f "${TMPDIR:?}/issue-<IID>-remote.md"
```

### 消した後に確認する

```bash
git branch -vv
git branch -r
ls -1 docs/issue docs/mr
glab issue list --per-page 10
```

残ったものを、**残した理由つきで**ユーザーへ提示する。

### ローカルの`<default>`を最新にする

後片付けの最後に、手元の`<default>`がリモートに追いついているかを確かめる。フェーズ1の最新化はマージを確認した時点のもので、その後に他のマージが入っていると届かない。追いついていないまま次のIssueに着手すると、古い時点からブランチを切ってしまう。

**worktreeを使っていたなら、撤去してメインのworking treeへ戻ってから行う**。worktree内のセッションからは`<default>`へ切り替えられない。

```bash
git fetch origin --prune
git status -sb          # <default>...origin/<default> が behind でないことを確認する
git pull --ff-only
```

未コミットの変更があると`pull`は`Your local changes to the following files would be overwritten by merge`で止まる。**その変更を勝手に捨てない**。何が残っているかをユーザーへ提示し、退避 (`git stash`) してよいかを確かめてから進める。
