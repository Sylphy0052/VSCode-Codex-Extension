# フェーズ6: レビューを依頼する

[SKILL.md](../SKILL.md) から参照される。自己レビュー (フェーズ5、[self-review.md](../../gitlab-review/references/self-review.md)) を終えてから読む。

## 依頼の前に確認する

- [ ] 4観点 (`review-spec` / `review-robust` / `review-style` / `security-auditor`) すべての報告を受け取り、統合した。Codexでは4つの手順書を読んで自分で確かめた結果を指す
- [ ] `critical` / `high` / `medium` の指摘が残っていない (最終ゲートの独立レビューで見つかったものを含む)。見送った `low` が残るならIssueへ切り出した
- [ ] 最終ゲートで再レビューが必須と判定された変更は、再レビューを済ませ判定をnoteへ残した。推奨と判定された変更は、済ませたか見送る理由をnoteへ残した ([self-review.md](../../gitlab-review/references/self-review.md) の最終ゲートに従う)。最終ゲートで直した修正はpush済みである
- [ ] 実行した検証の結果、または未実行の理由がMR本文に書かれている
- [ ] MR本文の `## レビュー記録` の巡数と、投稿したnoteの数が一致している
- [ ] GitLab側のMR本文の `## レビュー記録` に `- self-review 完了 (head <SHA>)` の行があり、`<SHA>` (40桁) がMRの現在のhead (`glab mr view <MRのIID> --output json` の出力から読む `sha`) と完全一致している
- [ ] ローカルMarkdown (`docs/issue/` `docs/mr/`) の内容とGitLab側の本文が一致している

1つでも欠けたら対応する節へ戻る。最終判定の項目、および `high` 以上の指摘が最終ゲートの独立レビュー由来である場合は、フェーズ5の並列4観点の巡へは戻さず、[self-review.md](../../gitlab-review/references/self-review.md) の最終ゲートの手順3〜4をやり直す。`self-review 完了` の項目は、行が無いだけなら、最終ゲートのnoteに書いたheadのSHAと現在のhead (`.sha`) が完全一致することを確かめて最終ゲートの手順5だけを行い (一致しない、または手順3〜4を飛ばしてnoteにSHAが無ければ、最終ゲートの後にcommitが足されていないと確かめられないのでフェーズ5へ戻る)、行の `<SHA>` が現在のheadと一致しなければ完了後にcommitが足されたのでフェーズ5へ戻る。それ以外の項目が欠けている場合はフェーズ5へ戻る。

## GitLabへまとめてpushする

**ここが作業が止まる箇所**。ローカルMarkdownの内容をGitLabへ反映する。`<IssueのIID>` `<MRのIID>`はSKILL.md「現在地の判定」・implement.mdで確認済みの値をそのまま使う。ここでは確認し直さない。

```bash
glab api projects/:id/issues/<IssueのIID> -X PUT --field "description=@docs/issue/issue-<IID>.md"
glab api projects/:id/merge_requests/<MRのIID> -X PUT --field "description=@docs/mr/mr-<MRのIID>.md"
```

Issue側は `### 試したこと` `### 起票時の想定との差` `### 調査で分かったこと` が埋まっている状態にする。実装中に何を試したかは、ここにしか残らない。

応答の判定と停止は [glab-response.md](glab-response.md) に従う。

## readyにする

```bash
glab mr update <MRのIID> --ready
```

readyにした時点がレビュー依頼になる。

## reviewerへ伝える

MRのURLと、**特に見てほしい点**を伝える。MR本文の `### 特に見てほしい点` と同じ内容でよい。

## 止まる

ここでこのskillは終わる。**このskillではマージしない**。マージは `codex-ext:gitlab-review` のマージモードの担当で、自己マージしてよいかもそちらで判定する。指摘への対応も `codex-ext:gitlab-review` の担当。

利用者へ次の3点を伝えて終了する。

- MRのURLとタイトル
- 自己レビューで何巡し、何を直したか
- reviewerに見てほしい点
