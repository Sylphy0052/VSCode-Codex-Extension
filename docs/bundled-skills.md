# 同梱skill（GitLab向け）

VSIXに同梱して、Codex・Claude Codeの会話へ読み込ませるskillの出どころと更新方法をまとめる（Issue #1821）。
読み込ませる仕組みは`docs/design.md`の「拡張機能が管理するskill（Issue #1820）」を参照。

## 中身

置き場所は`resources/skills-plugin/`で、プラグイン名は`codex-ext`。

| 種類     | パス                                               | 呼び出し名                                                                                                       |
| -------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| skill    | `skills/gitlab-develop/`                           | `codex-ext:gitlab-develop`（Forge Hubが呼ぶ）                                                                    |
| skill    | `skills/gitlab-review/`                            | `codex-ext:gitlab-review`（Forge Hubが呼ぶ）                                                                     |
| skill    | `skills/gitlab-cleanup/`                           | `codex-ext:gitlab-cleanup`（Forge Hubが呼ぶ）                                                                    |
| skill    | `skills/gitlab-commit/`                            | `codex-ext:gitlab-commit`                                                                                        |
| skill    | `skills/gitlab-issue/`                             | `codex-ext:gitlab-issue`                                                                                         |
| skill    | `skills/gitlab-screenshot/`                        | `codex-ext:gitlab-screenshot`                                                                                    |
| skill    | `skills/gitlab-roadmap/`                           | `codex-ext:gitlab-roadmap`                                                                                       |
| subagent | `agents/review-*.md`・`agents/security-auditor.md` | Claude Codeは`codex-ext:review-robust`等のsubagent。Codexはskill本文の指示で同じファイルを観点の手順書として読む |

同梱する範囲は、Forge Hubが送る3本（`gitlab-develop`・`gitlab-review`・`gitlab-cleanup`）と、そこから呼ばれるskill・subagentに限る。
`gitlab-init`・`gitlab-auto-cycle`・Wiki更新のように、Forge Hubから辿れないものや特定の環境を前提にするものは入れていない。
`gitlab-init`が担っていた`glab`の認証は、各skillの本文に`glab auth login --hostname <host>`の手順として書いてある。

## 出どころ

開発者本人が使っていた個人のskill（Claude Code用とCodex用の2系統）を、2026-10-03に次の方針で書き直したもの。

- GitLabのホストは`git remote get-url origin`のURLから求める。特定のホスト名を書かない
- 個人の規約ファイルに依っていた規則（severityの段階、自己レビューの巡数、squash禁止、ブランチ名、Conventional Commits等）は、
  skill本文へ既定として取り込み、リポジトリの`CLAUDE.md`・`AGENTS.md`に定めがあればそちらに従う形にした
- 個人の`bin/`にあったスクリプト（レビュー用のpacket作成）は、使うskillの`scripts/`へ移した
- Claude Code用とCodex用で中身を1本にし、違いが要る箇所（ユーザーへの確認、subagentの起動）は本文中で書き分けた

## 正本と更新方法

同梱skillの正本はこのリポジトリの`resources/skills-plugin/`とする。個人のskillから生成し直すことはしない
（生成元が個人の環境にあると、配布物の中身をこのリポジトリだけで再現できないため）。

更新するとき:

1. `resources/skills-plugin/`配下を直接編集する。個人のskillで入れた改善を取り込むときも、差分を見てこちらへ手で当てる
2. skillやsubagentを足す・消すときは、`test/unit/bundledSkills.test.ts`の一覧も合わせて直す
3. `npx vitest run --maxWorkers=2 test/unit/bundledSkills.test.ts`を通す。このテストは次を確かめる
   - 社内のホスト名・個人のパス・個人の規約ファイルへの参照・メールアドレスを含まない
   - `codex-ext:<名前>`の参照とMarkdownの相対リンクが、同梱した範囲で解決する

このリポジトリはGitHubで公開している。同梱した内容は誰でも読めるため、社内の情報や個人の設定を書かない。
