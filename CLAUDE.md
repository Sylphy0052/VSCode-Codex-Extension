# VSCode-Codex-Extension 固有規約

グローバル規約 (`~/.claude/CLAUDE.md`) を前提とし、本ファイルは本リポジトリ固有の差分のみ記載する。矛盾する場合は本ファイルを優先する。

## PR運用

- PR作成後は自己レビュー必須。指摘があれば自分で修正してから次へ進む
- 自己レビュー・修正が済んでいれば、CI (`checks` / `external-cli`) の完了を待たずに自己mergeしてよい
  - ブランチ保護は承認数0で自己merge可能な設定になっている（詳細: `docs/repository-hygiene.md`）
  - CI未完了で `gh pr merge` が `mergeStateStatus: BLOCKED` を返す場合は `--admin` を付けてstatus check待ちを迂回する
  - squash mergeはこのリポジトリで禁止されている（2026-08-24〜）。`--merge` か `--rebase` を使う
- merge後のcleanupは必須
  - リモートの元ブランチ削除、ローカルブランチ削除、worktree撤去まで行う
  - `gh pr merge --delete-branch` は、対象ブランチがworktreeへcheckout済みだと `Cannot delete branch ... checked out at ...` で失敗し、リモートブランチが残ったままになることがある。失敗時は `git ls-remote --heads origin <branch>` で残存を確認し、`git push origin --delete <branch>` 等で手動削除する
  - 上記は「今merge対象にした自分のPRの元ブランチ」の後片付けに限る。過去に溜まった不要ブランチの一括削除は対象外で、`docs/repository-hygiene.md` の定める通りAIエージェントが自律判断で実行してはならない（人が対象ブランチ名を明示し承認した場合のみ）
