# VSCode-Codex-Extension 固有規約

グローバル規約 (`~/.claude/CLAUDE.md`) を前提とし、本ファイルは本リポジトリ固有の差分のみ記載する。矛盾する場合は本ファイルを優先する。

## ロードマップ

- ロードマップの正本はGitHubの `roadmap` ラベルのIssue（2026-09-26時点で #1457 の1本）とする。着手順・優先度・進捗はそこだけに書き、ロードマップIssueを増やさずこの1本へ足す
- `docs/archive/` は凍結記録。参照せず、書き換えない（旧 `docs/roadmap/` はここへ移した。Issue #1458）

## チャットでの作業の流れ

- Issueを起票してロードマップ#1457を整理したら、実装以降は task-messaging MCPの `start_roadmap_orchestrator` でオーケストレータモードに任せる（会話の中で実装しない）。子Issueが1件でも呼ぶ。調査・質問への回答・ロードマップに載せない小さな修正では呼ばない

## PR運用

- 各PRの最後に `node scripts/bump-version.mjs` を実行し、`package.json` と `package-lock.json` の版上げを `chore: バージョンを<版>にする` として同じPRへcommitする。配布したvsixの版とmainのcommitを1対1にするため
  - merge直前に `git fetch origin` し、`origin/main` の版が版上げ前の版から変わっていたら、mainを取り込んでから `bump-version.mjs` を実行し直す。並行する2つのPRが同じ版へ上げた場合、変更が同一なのでgitは衝突として止めず、同じ版番号の中身違いが2回配布されてしまう
- PR作成後は自己レビュー必須。指摘があれば自分で修正してから次へ進む
- CIのworkflow（`CI`、`checks` / `external-cli`）は2026-11-20から無効にしてある。CIの結果は確かめず、完了も待たない。CIを有効に戻すかどうかも尋ねない。他者レビューも不要で、下の「自己mergeの条件」を満たせば自己マージしてよい
- 自己mergeの条件（CIの代わり）: 自己レビュー・修正が済み、手元で `npm run format:check`・`npm run typecheck`・`npm run lint`・変更に関わるテストが通っていること。自己レビューの指摘は`low`まで同じPRで直し、`critical`/`high`/`medium`が1件でも残っている間はmergeしない。直さずに残してよい例外（ユーザー本人が発話で許容した`low`、差分の外に前からある`[既存]`の指摘）と、その例外でもmergeを止める場合は、本人の個人規約 `~/.claude/docs/rules-details/development-workflow.md` の「レビューと自己マージ」に従う
- 自己mergeの手順と制約
  - ブランチ保護は承認数0で自己merge可能な設定になっている（詳細: `docs/repository-hygiene.md`）
  - `gh pr merge` が `mergeStateStatus: BLOCKED` を返す場合は `--admin` を付けてstatus check待ちを迂回する
  - squash mergeはこのリポジトリで禁止されている（2026-08-24〜）。`--merge` か `--rebase` を使う
- `self-improvement`ラベルのPR（この拡張自身を直すPR）も、CIの成功を待たずにmergeしてよい（「自己mergeの条件」は同じく満たす）。ただし配布は全runが終わってから行い、自動Reloadはしない。配布前に直前のvsixを`/tmp`以外へ保管する。戻し方は `docs/self-improvement-revert.md`
- merge後のcleanupは必須
  - リモートの元ブランチ削除、ローカルブランチ削除、worktree撤去まで行う
  - `gh pr merge --delete-branch` は、対象ブランチがworktreeへcheckout済みだと `Cannot delete branch ... checked out at ...` で失敗し、リモートブランチが残ったままになることがある。失敗時は `git ls-remote --heads origin <branch>` で残存を確認し、`git push origin --delete <branch>` 等で手動削除する
  - 後片付けの最後に、ローカルの `main` をリモートへ追いつかせる。worktreeを撤去してメインのworking treeへ戻ったうえで `git fetch origin --prune` と `git pull --ff-only` を実行する（次の作業が古い基点から始まるのを防ぐ）。worktree内のセッションからは `main` へ切り替えられないため、この手順はworktree撤去より後に行う
  - 上記は「今merge対象にした自分のPRの元ブランチ」の後片付けに限る。過去に溜まった不要ブランチの一括削除は対象外で、`docs/repository-hygiene.md` の定める通りAIエージェントが自律判断で実行してはならない（人が対象ブランチ名を明示し承認した場合のみ）

## 作業後のビルドとインストール

作業を終えるたびに（PRのmergeとcleanupの後）、最新の `main` から拡張機能をビルドし、WSLのVS Codeへ入れる。b90/b115のdev containersへは入れない（2026-10-09〜）。

- ビルドはメインのworking treeで `npm run build` のあと `npx vsce package --no-dependencies -o /tmp/<名前>.vsix` を実行する。`npm run package` はここでもう一度版番号を上げて `package.json` を書き換えるため使わない（版上げはPR側で済んでいる）。`<名前>` には `package.json` の版を入れる（例: `vscode-codex-extension-2026.923.3`）
- `self-improvement`ラベルのPRを入れるときは、インストール前に直前の版のvsixを `~/.local/share/vscode-codex-extension/vsix-backup/` へ保管する（手順は `docs/self-improvement-revert.md`）
- WSL: `code --install-extension /tmp/<名前>.vsix --force`
- 入れた後は、ウィンドウで「Developer: Reload Window」を実行すると新しい版が読み込まれる
