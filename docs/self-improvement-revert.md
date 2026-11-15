# 自己改善PRのmergeと、拡張なしで戻す手順

この拡張は会話UIも兼ねる。オーケストレータを壊す変更が入ると、直す手段も同時に失う。そのため、拡張自身を直すPR（`self-improvement`ラベル）には次を適用する。

## mergeの条件

- `--admin`でstatus check待ちを迂回しない。`checks`と`external-cli`が成功してからmergeする
- CI未完了・失敗の間はmergeしない（`gh pr checks <PR番号>`で確認）
- 通常PRの「CI完了を待たず自己merge」はこのラベルのPRには適用しない

## 配布の条件

- 配布（ビルド・インストール・Reload）は、動いている全runが終わってから行う
- 自動Reloadはしない。Reloadは人が「Developer: Reload Window」で行う（承認済みのrunが止まるため）

## 配布前: 直前のvsixを保管する

インストール済みの版のvsixを`/tmp`以外に残してから、新しい版を入れる。

```bash
mkdir -p ~/.local/share/vscode-codex-extension/vsix-backup
ls ~/.local/share/vscode-codex-extension/vsix-backup
```

- 直前に入れたvsix（例: `/tmp/vscode-codex-extension-<旧版>.vsix`）が`/tmp`に残っていれば、新版を入れる前にこのディレクトリへ`cp`する
- 残っていなければ、旧版のcommitをcheckoutしてビルドし直す（下記「ビルドし直す」）
- ファイル名は版入りのまま保つ（`vscode-codex-extension-<版>.vsix`）

## 戻す手順（拡張を使わない。ターミナルだけで行う）

### A. 直前のvsixを再インストールする（最短）

```bash
code --install-extension ~/.local/share/vscode-codex-extension/vsix-backup/vscode-codex-extension-<旧版>.vsix --force
```

その後、VS Codeで「Developer: Reload Window」を実行する。

### B. vsixが無いとき: 旧版をビルドし直す

メインのworking treeで、壊れる前のcommit（`package.json`の版が旧版のもの）を一時的にworktreeへ取り出す。

```bash
git log --oneline -- package.json
git worktree add .agents/worktrees/rollback <旧版のcommit>
```

そのworktreeで`npm ci`、`npm run build`、`npx vsce package --no-dependencies -o ~/.local/share/vscode-codex-extension/vsix-backup/<名前>.vsix`を実行し、Aの手順で入れる。`npm run package`は版を上げるため使わない。

### C. mainの変更を戻す（git revert）

vsixを戻したあと、原因のPRをmainからも戻す。

```bash
git fetch origin
git switch -c revert/<PR番号> origin/main
git revert -m 1 <壊したmerge commit>
git push origin revert/<PR番号>
gh pr create --title "revert: <PR番号>を戻す" --body "Reverts #<PR番号>"
```

このPRも`self-improvement`ラベルを付け、`checks`と`external-cli`の成功を待ってからmergeする。squash mergeは使わない。
