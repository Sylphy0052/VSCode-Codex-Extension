# 同梱GitLab skillの保守メモ

`resources/skills-plugin/` に同梱しているGitLab skillとagentの保守向けメモ。配布先のskill本文には書かない内容だけをここへ置く。

## 見送った指摘 (Issue #1849、#1836の残りのlow 2件)

### maxTurnsがプラグインのagentで効くかの実測

- 状態: 見送り。直していない
- 現状: `resources/skills-plugin/agents/` の4ファイルがfrontmatterで `maxTurns` を指定している (security-auditor 12、review-robust 15、review-spec 15、review-style 8)。プラグインのagentで上限として働くかは実測していない
- 見送った理由: 実測にはreview agentを実際に走らせる費用がかかり、見合わない。agent本文は、上限に達しても `status: INCOMPLETE` と `未確認` を返す前提で書いてあり、効かなくても「問題なし」と誤報しない
- 再開の条件: `maxTurns` の効き目に依存した挙動 (打ち切りの検出など) を足すとき

### 空白の表記揺れ

- 状態: 見送り。直していない
- 現状: `resources/skills-plugin/skills/` で、日本語と英数字の間に空白がある行が約90行 (18ファイル) ある。`scripts/` の `.py` と `.sh` には英文も混ざる
- 見送った理由: 機械置換だとスクリプトの英文や正規表現を壊す恐れがあり、差分も大きい。linterで検出と除外を定めてから一括で直すほうが安全
- 再開の条件: 同梱skillのMarkdownにlinterを入れるとき
