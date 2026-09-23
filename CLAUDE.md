# VSCode-Codex-Extension 固有規約

グローバル規約 (`~/.claude/CLAUDE.md`) を前提とし、本ファイルは本リポジトリ固有の差分のみ記載する。矛盾する場合は本ファイルを優先する。

## PR運用

- 各PRの最後に `node scripts/bump-version.mjs` を実行し、`package.json` と `package-lock.json` の版上げを `chore: バージョンを<版>にする` として同じPRへcommitする。配布したvsixの版とmainのcommitを1対1にするため
  - merge直前に `git fetch origin` し、`origin/main` の版が版上げ前の版から変わっていたら、mainを取り込んでから `bump-version.mjs` を実行し直す。並行する2つのPRが同じ版へ上げた場合、変更が同一なのでgitは衝突として止めず、同じ版番号の中身違いが2回配布されてしまう
- PR作成後は自己レビュー必須。指摘があれば自分で修正してから次へ進む
- CI (`checks` / `external-cli`) の確認、他者レビューは不要。自己マージしてよい
- 自己レビュー・修正が済んでいれば、CI (`checks` / `external-cli`) の完了を待たずに自己mergeしてよい
  - ブランチ保護は承認数0で自己merge可能な設定になっている（詳細: `docs/repository-hygiene.md`）
  - CI未完了で `gh pr merge` が `mergeStateStatus: BLOCKED` を返す場合は `--admin` を付けてstatus check待ちを迂回する
  - squash mergeはこのリポジトリで禁止されている（2026-08-24〜）。`--merge` か `--rebase` を使う
- merge後のcleanupは必須
  - リモートの元ブランチ削除、ローカルブランチ削除、worktree撤去まで行う
  - `gh pr merge --delete-branch` は、対象ブランチがworktreeへcheckout済みだと `Cannot delete branch ... checked out at ...` で失敗し、リモートブランチが残ったままになることがある。失敗時は `git ls-remote --heads origin <branch>` で残存を確認し、`git push origin --delete <branch>` 等で手動削除する
  - 後片付けの最後に、ローカルの `main` をリモートへ追いつかせる。worktreeを撤去してメインのworking treeへ戻ったうえで `git fetch origin --prune` と `git pull --ff-only` を実行する（次の作業が古い基点から始まるのを防ぐ）。worktree内のセッションからは `main` へ切り替えられないため、この手順はworktree撤去より後に行う
  - 上記は「今merge対象にした自分のPRの元ブランチ」の後片付けに限る。過去に溜まった不要ブランチの一括削除は対象外で、`docs/repository-hygiene.md` の定める通りAIエージェントが自律判断で実行してはならない（人が対象ブランチ名を明示し承認した場合のみ）

## 作業後のビルドとインストール

作業を終えるたびに（PRのmergeとcleanupの後）、最新の `main` から拡張機能をビルドし、WSLのVS Codeとb90/b115のdev containersの3か所へ入れる。

- ビルドはメインのworking treeで `npm run build` のあと `npx vsce package --no-dependencies -o /tmp/<名前>.vsix` を実行する。`npm run package` はここでもう一度版番号を上げて `package.json` を書き換えるため使わない（版上げはPR側で済んでいる）。`<名前>` には `package.json` の版を入れる（例: `vscode-codex-extension-2026.923.3`）
- WSL: `code --install-extension /tmp/<名前>.vsix --force`
- b90/b115: WSLから `ssh -p 12290 kfuruhashi@localhost`（b90）、`ssh -p 12222 kfuruhashi@localhost`（b115）で入る。`ssh b90` は通らない
  - 両ホストのホームは同じNFS。vsixは `scp -P 12290` でb90へ送り、`~/.local/share/vsix/` に置けばb115からも見える
  - `~/.local/share/vsix/` には1つの版だけを置く。devcontainerの `postAttachCommand` がここの `*.vsix` を全部 `--force` で入れるため、古い版が残っていると並び順次第で古い版に戻る。置き換える前の版は `~/.local/share/vsix-old/` へ移す
  - 起動中のコンテナへは各ホストで `docker ps --filter label=devcontainer.local_folder` で探し、`docker exec <コンテナ> sh -c 'cs=$(ls -t $HOME/.vscode-server/bin/*/bin/code-server | head -1); $cs --install-extension $HOME/.local/share/vsix/<名前>.vsix --force'` で入れる。コンテナ内の `remote-cli/code` はIPC前提のため使えない
- 入れた後は、各ウィンドウで「Developer: Reload Window」を実行すると新しい版が読み込まれる
