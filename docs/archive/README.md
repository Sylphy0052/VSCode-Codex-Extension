# 凍結記録

このディレクトリの文書は書き換えない。今後の作業の根拠や手順として参照しない。

## roadmap/

2026-09-26まで `docs/roadmap/` にあったロードマップと運用ルールを、そのままの構成で移したもの（Issue #1458）。

- ロードマップの正本は、GitHubの `roadmap` ラベルのIssueに移した。未完了だった計画（WF-HのH1〜H7、Agent Attentionの後続候補）も、そのIssueへ移してある
- 運用ルール（`ops-rules.md`・`numbering.md`）のうち今も有効なものは、`CONTRIBUTING.md` へ移した
- 拡張機能の設定 `agent.workflows.roadmapDir` の既定値は `docs/roadmap` のまま。ロードマップ生成機能を使うと、出力先として `docs/roadmap/` が作られることがある。ここへ移した記録とは関係がない
