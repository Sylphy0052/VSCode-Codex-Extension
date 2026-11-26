# knowledge

失敗した試みと指摘の記録。1ファイル1件。

- [一括置換で長くなった行がFormatで落ちる](edit-replace-all-skips-prettier.md) — commit前に変えたファイルへprettier --checkをかける
- [並列PRのマージ後は、統合後のmainの検証を確かめるまで完了と言わない](parallel-pr-completion-check.md) — CI無効の2026-11-20以降は手元で全テストまで回す。subagentの「既存エラー」報告は裏取りする
- [ロードマップの着手順には、チェックリストの子Issueをすべて載せる](roadmap-plan-needs-all-children.md) — 欠けると計画の検証で弾かれる。着手条件待ちも載せる
- [引き継ぎの申し送りに書かれたIssueの状態は、ghで確かめてから使う](verify-handoff-issue-states.md) — runの`[x]`はIssueのCLOSEと連動しない
