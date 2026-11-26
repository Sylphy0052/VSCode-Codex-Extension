---
name: edit-replace-all-skips-prettier
description: 複数箇所の一括置換で長くなった行がPrettierで折り返されず、mainのCIがFormatで止まった
updated: 2026-11-07
---

# 一括置換で長くなった行がFormatで落ちる

## 何が起きたか

PR #2047（#2033）で、`src/orchestrator/taskRunState.ts`の`{ ...x, attention: 'none', failure: undefined, updatedAt: at }`という1行2か所へ、Claude CodeのEditツールの`replace_all`で`haltCause: undefined`を足した。行が`printWidth`を超えたが整形されないままmergeされ、mainのCIの`Format`（`prettier --check .`）が失敗した。`Format`が落ちると、後ろのTypecheck・Build・Testは走らない（2026-10-30〜11-07にも同じ形で、型エラーとテスト失敗が隠れていた）。PR #2050で整形し直した。

## なぜ

編集後に自動でPrettierをかけるhookの効果を当てにして、commit前に整形を確かめなかった。`replace_all`の編集後に整形が効かなかった理由は確かめていない。

## どうするか

- commitの前に、変えたファイルへ`node_modules/.bin/prettier --check <files>`をかける。worktreeに`node_modules`が無ければ、メインのworking treeの`node_modules/.bin/prettier`を使う
- 1行の要素を足して長くなる置換をした後は、特に確かめる
- mainの`Format`が落ちたら、整形だけ直して終わらせない。そのPRのCIでTypecheck・Testまで通るのを見てからmergeする
