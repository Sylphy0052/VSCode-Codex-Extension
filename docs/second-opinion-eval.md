# セカンドオピニオンの精度測定

Issue #1044 の評価ハーネスの使い方と採点手順。

セカンドオピニオン機能の精度を、要因ごとに独立してON/OFFして測るためのもの。**精度改善そのものはここでは行わない。** どの介入を実装するかは、この手順で得た結果を見て決める。

## 採点規則の凍結

この文書に書かれた採点規則（指摘の4区分、precision の分母、`recallCriteria` の判定）は、**本測定を始める前の確定版**である。本測定の途中で変えない。途中で基準が動くと、条件差なのか基準の変化なのかを後から分けられない。

規則を変えたくなったら、変更点と理由を Issue #1044 へ残し、**それまでに採点した分をすべて新しい規則で採点し直す**。

pilot に使った3件（#992 / #995 / #1027）は、この規則を作る過程で回答を読んでいる。**本測定の20〜30件から除外する。** pilot で得た数値も、条件の効果の判断には使わない（規則を作りながら採点した値であり、条件を比べるための測定ではない）。

## なぜ先に測るのか

改善案を一度にまとめて入れると、何が効いたのか分からなくなる。介入を1つずつ足し、その都度同じ案件・同じ材料で測る。

現時点で実装がある条件は次の3つ。C以降は後続Issueで足す。

| 条件       | 変更内容                             | 何を測るか                                 |
| ---------- | ------------------------------------ | ------------------------------------------ |
| A          | 現行（ベースライン）                 | —                                          |
| `B-pos`    | 依頼の区画を末尾へ**移動**           | 位置だけの効果                             |
| `B-repeat` | 冒頭の依頼を残したまま末尾へ**再掲** | 実運用向けの介入（位置以外も同時に変わる） |

`B-pos` は `SecondOpinionInput.requestPosition`、`B-repeat` は `SecondOpinionInput.restateRequestAtEnd` で切り替わる。**どちらも既定はOFF**で、拡張本体の挙動は変わらない。

2つを分けてあるのは、`B-repeat` が位置以外も同時に変えるためである。同じ依頼が2回出ること、「最終確認」という見出しが増えること、読み直しを促す一文が入ることが重なるので、これで差が出ても位置の効果とは言えない。位置だけを見るのが `B-pos`（移動なので、見出し・本文・トークン数・出現回数はAと同一）。`B-repeat` と `B-pos` の差が、位置以外の要素の寄与になる。

## 前提

- 実物の Codex CLI が要る。`codex` がPATHにあるか、`CODEX_BIN` で場所を指定する
- **モデルへの往復が案件数 × 条件数 × 試行回数だけ起きる。** 24案件 × 3条件 × 2回で144往復になる。時間と費用がかかる
- VSCodeは起動しない。素のNodeプロセスから `codex app-server` を叩く

## 手順

### 0. プロトコルを1回だけ確かめる（初回と、`codexTurn.ts` を触ったとき）

```
npx tsx test/bench/secondOpinionEval/probe.ts [--out <トレース出力先>]
```

**「本番の案件を1件流して回答が返ったからよし」では足りない。** ハーネスは拡張本体と同じ `applyEvent` / `lastNonEmptyAgentMessageText` を使っているので、読み方が間違っていれば本体と同じように間違え、辻褄が合ってしまう。

`probe.ts` は答えが分かっている問いを投げ、次を同時に見る。

- ファイルを読ませる（材料へ到達する経路が生きているか）
- 先頭と末尾に目印を書かせる（回答の頭・終わりが欠けていないか）
- ファイル内の値を答えさせる（読んだ内容が本当に回答へ入るか）
- トークン量が取れるか

送受信したJSON-RPCは全件トレースへ残る。1項目でも失敗したら、そのトレースと `applyEvent` の解釈を突き合わせる。

#### 本番Advisorとの実行条件の一致

ハーネスは本番のAdvisor（`src/secondOpinion/run.ts` の `buildSecondOpinionSessionInput` → `ChatViewManager.openTaskSession` → `ChatSession.start` / `send`）と同じ値を送る。ここが違うと、測っているのが本番のセカンドオピニオンではなくなる。

| 送信先         | フィールド           | 値                                                                    |
| -------------- | -------------------- | --------------------------------------------------------------------- |
| `thread/start` | `sandbox`            | `read-only`                                                           |
| `thread/start` | `approvalPolicy`     | `never`                                                               |
| `thread/start` | `model`              | 条件で固定したモデル                                                  |
| `thread/start` | `config.mcp_servers` | 全サーバ無効化のオーバーレイ（`buildDisabledMcpServersOverlay`）      |
| `thread/start` | `config.skills`      | `{ include_instructions: false }`（`SKILLS_DISABLED_CONFIG_OVERLAY`） |
| `turn/start`   | `model` / `effort`   | 条件で固定した値                                                      |
| `turn/start`   | `approvalPolicy`     | `never`                                                               |
| `turn/start`   | `sandboxPolicy`      | `{ type: 'readOnly' }`（`sandboxPolicyFor('read-only')`）             |

`approvalsReviewer` は送らない（本番の `toCodexConfig` が空に固定している）。`bypassApprovalsAndSandbox` も false なので、`turnPolicyFor` は設定由来の `sandboxPolicy` だけを返す。

MCPを無効化するのは速度のためだけではない。既定のまま開くと利用者の `config.toml` のサーバと組み込みの `codex_apps` が接続され、ツール定義がターンへ載る。本番は載せないので、載せたまま測ると別物を測ることになる。

skillを提示させないのも同じ理由である（Issue #1061）。Codex CLIは利用可能なskillの一覧をシステムプロンプトへ自動で載せ、使うと決めたら `SKILL.md` を読むよう指示する。Advisorはこれを見て、固定指示の「この作業ディレクトリの外を読みに行かないでください」に反し、1つ目のコマンドで `~/.codex/skills/<name>/SKILL.md` を読みに行く（#1047 のprobeで、条件A・条件C-repoの両方に出た）。材料をbundleへ隔離した前提が崩れるうえ、費用の指標である `toolCalls` に材料と無関係な読み取りとその失敗が混ざる。

無効化のキーは実測で選んである（codex-cli 0.148.0）。`features.skills=false` と `skills.enabled=false` は効かず、一覧はそのまま提示される。効くのは `skills.include_instructions=false` だけである。app-server経由でも同じで、オーバーレイ有りでは「提示されているskillを列挙せよ」に「なし」と答え、外すと20件を列挙する（陽性対照つきで確認）。

グローバルな `~/.codex/AGENTS.md` はこの経路では消せない（`project_doc_max_bytes=0` / `instructions` / `user_instructions` のいずれでも残る）。ただしプロンプトへ注入されるだけでコマンドの実行を伴わないため `toolCalls` には現れず、条件間で一定である。消すには `CODEX_HOME` ごと差し替えることになり、認証情報の置き場も巻き込むのでここでは行わない。

#### 塞ぐ前に取った記録を数え直す

`skills.include_instructions=false` を入れる前の実行記録には、bundleの外の読み取りが混ざったままである。取り直さずに内訳を出す。

```
npx tsx test/bench/secondOpinionEval/toolCallScope.ts <結果ディレクトリ>
```

コマンド本体（先頭の `/bin/bash -lc` を落とした残り）に絶対パスが現れるかで、bundleの中だけを触ったコマンドと外を触ったコマンドを数え分ける。bundleはセッションの作業ディレクトリなので、材料への参照は `changes.diff` / `base/...` / `after/...` の相対パスで出る。完全な判定ではない（bundleを絶対パスで指したコマンドは外と数え、変数経由の参照は拾えない）ので、費用の内訳を後から言うために使い、「外を読んでいないことの証明」には使わない。

### 1. sampling frame を作る（Issue #1046 手順1）

案件を選ぶ前に、**証拠情報を一切使わないメタデータだけの母集団**を作って凍結する。

```
# 0. 先にPRのrefを取る（後述。取らないと母集団が静かに減る）
git fetch origin '+refs/pull/*/head:refs/remotes/pr/*'

# 1回だけ: GitHubから引いて、母集団の素をそのまま保存する
npx tsx test/bench/secondOpinionEval/samplingFrame.ts \
  --source-out eval-results/sampling-source-v3.json --out eval-results/sampling-frame-v3.json

# 以降: 保存した素からのみ作り直す
npx tsx test/bench/secondOpinionEval/samplingFrame.ts \
  --prs eval-results/sampling-source-v3.json --out eval-results/sampling-frame-v3.json
```

**先にPRのrefを取る。** squash / rebase でmergeされたPRは、merge commitの親が1つしかないため、base / target を API の `baseRefOid` / `headRefOid` から取り直す（`prSnapshot.ts` の `non-linear` 経路）。head branchはmergeの後に削除されるので、PRのrefを取っていないcloneではこれらのcommitが存在せず、該当PRが丸ごと `snapshot-unavailable` へ落ちる。版3の母集団で実測したところ、**eligible が 431件 → 253件** になった。素を凍結しても、frameの中身が「手元のcloneが何をfetchしているか」で変わってしまう。

そのため `snapshot-unavailable` が1件でもあれば生成を止める。GitHub側にrefが残っていないなど、その件数のまま進めると決めたときだけ `--allow-unavailable` を付ける。

**母集団の素も凍結する。** frameのハッシュを記録しても、GitHubを引き直せば母集団そのものが変わる。期間の指定は日付単位なので、`--until` に指定した当日の後半にPRがマージされれば同じコマンドが別の母集団を返す。`gh` の出力をそのまま保存し、そのハッシュを frame の `sourceSha256` へ書き、以降の再生成は保存した素からだけ行う。素を保存せずにGitHubを引くことはできない（`--prs` か `--source-out` のどちらかが必須）。

この取りこぼしは実際に起きた。版2の素を取ったのは 2026-08-31T04:33Z で、`--until 2026-08-31` は日付単位のため、**その後にマージされた11件（#1049〜#1059）が母集団から漏れていた**。版3は 09-18 に取り直しており、期間の末日が完全に過去なので、以後は同じコマンドで同じ母集団が返る。

**一度凍結した版は上書きできない。** 素は既にあれば取り直さない。frameは、既にあって中身が同じなら書かずに済ませ、**1バイトでも違えば拒否する**。作り直したいなら `exclusionRulesVersion` を上げて別のファイルにし、前の版は残す。ハッシュを記録しても同じパスへ書き直せるなら、凍結したことにならない。

frameには**絶対パスを入れない**（`sourceFile` はファイル名だけ）。正本は `sourceSha256` であり、パスを入れると同じ素から作ってもcloneの置き場所でframeのハッシュが変わる。

**母集団の四分位が境界と一致しなければ生成を止める。** 境界は母集団の四分位そのものなので、ずれたということは母集団が変わったということである。そのまま書き出すと「四分位で切った」と書いてある層が実際には四分位でなくなる。止まったら実測値へ更新して `exclusionRulesVersion` を上げ、前の版のファイルは残す。`extreme-tail` の境界（p90）も同じ理由で検証する。四分位だけ見て通すと、目印だけが前の母集団の値のまま残り、層化の「裾を最低1件は含める」制約が別の帯を指してしまう。

linked Issue の有無・人間コメントの有無・レビューの有無を、この段階では条件にしない。「正解ラベルを作りやすいPR」に絞ると母集団そのものが証拠の多い側へ寄り、あとから脱落率を測っても意味を持たなくなる。証拠による脱落は次の段階で数える。

除外するのは、**測定が技術的に成立しないもの**と、**測定対象そのもの**だけ。

| 規則                   | 理由                                               |
| ---------------------- | -------------------------------------------------- |
| `snapshot-unavailable` | base / target のどちらかがローカルに無い           |
| `empty-diff`           | 差分が空                                           |
| `docs-only`            | 全変更ファイルが `docs/**` または `*.md`           |
| `pilot`                | 規則を作りながら採点した3件（#992 / #995 / #1027） |
| `benchmark-self`       | 評価基盤そのもののPR（自分を測ることになる）       |

test-only / config-only / refactor / 巨大PR などは**除外せずタグを付ける**。「レビュー価値が低そう」で落とすと、そこに人手の選択が入る。

**base は merge commit の第1親ではなく `merge-base` を取る。** 第1親はmerge直前の `main` であって分岐点ではないので、分岐からmergeまでに他のPRが `main` へ入っているとその分が逆向きに混ざる（実測でPR #1041 が 169行 → 1272行 になった）。親が1つしかないPR（squash / rebase）は黙って補正せず `snapshotStatus: 'non-linear'` として記録する。

素と出力のSHA-256を記録し、以降の段階はこの凍結物を入力にする。規則や境界を変えたら `exclusionRulesVersion` を上げ、**前の版を上書きしない**。

#### 版3の結果（2026-09-18）

```
母集団（2026-08-10〜08-31 にマージ）: 548 件
  - docs-only: 101 件
  - benchmark-self: 13 件
  - pilot: 3 件
  - snapshot-unavailable: 0 件
  - empty-diff: 0 件
metadata eligible: 431 件

変更規模の層（境界 131 / 323 / 691）: S 108 / M 108 / L 107 / XL 108
extreme-tail（p90 = 1369 超）: 43 件
タグ: touches-docs 290 / extreme-tail 43 / single-file 18 / refactor 14 / test-only 9 / chore 6 / has-generated 4 / config-only 2
snapshot: ok 253 / non-linear 178 / unavailable 0
```

- 母集団の素 `eval-results/sampling-source-v3.json` sha256 `6495b38d1c8b3de551a0dbc277d0dcfe193f54589ef93dcdfa100f5f6c4cd0e4`（取得 2026-09-18T14:50:04.875Z）
- frame `eval-results/sampling-frame-v3.json` sha256 `9fb0208257b4b6f79e5128bfcd578b2afa06132874f20fe7faf4ab8a03424854`

版2（537件 / eligible 415件 / 境界 129 / 317 / 706）から動いた理由は2つで、どちらも結果変数を見ずに確定している。

1. 版2の素が取得日当日の途中までしか含まず、11件（#1049〜#1059）が漏れていた。この11件はいずれも評価基盤そのもののPRなので、`benchmark-self` が 2件 → 13件 に増えて eligible には入っていない
2. 版2を作った環境にはPRのrefがあり、`non-linear` の222件が base / target を解決できていた。PRのrefを取らずに再現しようとすると同じ222件が `snapshot-unavailable` へ落ちる

### 2. 証拠候補を検索する（Issue #1046 手順2）

手順1で凍結した母集団の各案件について、正解ラベルの根拠になりうる材料の在り処を集める。

```
# 1回だけ: GitHubから引いて、証拠の素をそのまま保存する
npx tsx test/bench/secondOpinionEval/evidenceCandidates.ts \
  --frame eval-results/sampling-frame-v3.json \
  --evidence-src-out eval-results/evidence-source-v4.json \
  --out eval-results/evidence-candidates-v4.json

# 以降: 保存した素からのみ作り直す
npx tsx test/bench/secondOpinionEval/evidenceCandidates.ts \
  --frame eval-results/sampling-frame-v3.json \
  --evidence-src eval-results/evidence-source-v4.json \
  --out eval-results/evidence-candidates-v4.json
```

#### 版4の実測（frame v3 / eligible 431件）

```
follow-up-fix 55 / follow-up-test 52 / follow-up-issue 179
closing-issue 289 / account-comment 125 / account-review 187
候補がひとつも無い: 9 件
うちマージ後に立ったIssueを含む: 76 件
強い証拠（follow-up-test または openedAfterMerge な follow-up issue）: 102 件
後続fixはあるがテストが無い: 3 件
Codexレビュー / コメントが付いている: 295 件（正解ラベルの根拠には使わない）
truncated: 0 件
```

- 証拠の素 `eval-results/evidence-source-v4.json` sha256 `d455825ab710d78f479dce4dc64da579fe7e767634d8e2782cb5bdd826e277f4`（取得 2026-09-18T15:29:21.421Z）
- 証拠候補 `eval-results/evidence-candidates-v4.json` sha256 `6ce8c84c6f2e08667ab71f32f7ad97ac3af137af0ee14dbd02f3b0a95fb05e98`

`EVIDENCE_RULES_VERSION` を 3 から 4 へ上げたが、**収集の規則は変えていない**。frame が版2（eligible 415件）から版3（eligible 431件）へ変わったので上げた。素には版が記録されるため、版を据え置くと母集団の違う素をそのまま受け付けてしまう。

**手順2より後ろに出てくる実測値のうち、版2のframeを入力にしたままのものが残っている**（追加pool 277件、screening 50件 / 60件時点の funnel、条件Aの eligibility など）。これらは版2の記録として読むこと。強い証拠のpoolは版2の98件から版3の102件へ変わっており、screening は `orderIndex 0` から読み直しになる。

**ここでは正解ラベルを作らない。** 集めるのは判断の材料であって、材料の有無で `groundTruthBasis` を機械的に決めることはしない。「後続コミットで直した」という事実だけでは、元の問題が実際に成立した証拠にならない。判定は手順3で中身を読んで行う。

集める系統は次の5つで、重複してよい。

| 系統              | 中身                                                               |
| ----------------- | ------------------------------------------------------------------ |
| `follow-up-fix`   | マージ後に、このPRを参照する fix / revert / test / perf のPRがある |
| `follow-up-test`  | その後続PRがテストを触っている（実験による確定の候補）             |
| `follow-up-issue` | マージ後に、このPRを参照するIssueがある                            |
| `closing-issue`   | このPRが閉じたIssue（変更の背景。不具合の証拠ではない）            |
| `account-comment` | AIレビュアー以外のアカウントによるコメント                         |
| `account-review`  | AIレビュアー以外のアカウントによるレビュー                         |

**後続かどうかは「このPRのマージ後に参照されたか」で見る。** 実測では、後続として拾ったPR参照213件のうち、対象より先にマージ済みだったものは0件だった。あわせて、参照元のIssue自体がマージ後に立ったか（`openedAfterMerge`）も記録する。前からある計画Issueが後で言及されただけのものは、このPRを受けた報告ではない。

**投稿者のloginで「人間の証拠」と決めない。** このリポジトリのPR本文もコメントも、多くはAIエージェントがアカウント所有者の名前で書いている。`account` は「人間が書いた」ではなく「AIレビュアーだと断定できない」の意で、AIの転記かどうかは手順3で中身を読んで判断する。

**Codexレビューは正解ラベルの根拠にしないが、件数は数える。** 数えないと「Codexの指摘しか無い案件」が何件あるかを後から示せない。

`account-comment` と `account-review` を分ける理由はない。中身がAIの転記かどうかはこの段階で判定しないので、コメントだけを候補にすると、非modelのレビューしか持たないPRが「候補ゼロ」に数えられてしまう（実測で13件あった）。

**取り切れなかったものを黙って落とさない。** コメント・レビュー・closing Issue、および**各closing Issue内のコメント**について、総数と取得件数を突き合わせ、足りなければ `truncated` へ残す。

手順1と同じ凍結の契約を使う。frameのsha256が想定と違えば止まり、素は取り直さず、出力は1バイトでも違えば拒否する。加えて、**保存済みの素がframeのeligibleと同じ集合であること**（件数一致・重複なし・欠けなし・余分なし）も確かめる。版とハッシュだけでは、件数の違う素や同じPRが二重に入った素をそのまま集計できてしまう。

### 2-1. 証拠を読む順を凍結する（Issue #1046 手順3の前段）

```
npx tsx test/bench/secondOpinionEval/screeningOrder.ts \
  --candidates eval-results/evidence-candidates-v4.json \
  --out eval-results/screening-order-v3.json
```

強い証拠の系統（`follow-up-test`、または `openedAfterMerge` な follow-up issue）を持つ案件を選び、`sha256("ground-truth-screen-v1:" + prNumber)` の昇順に並べて凍結する。版3の実測で102件（版2は98件）。

- `eval-results/screening-order-v3.json` sha256 `f8194249366dd2c786f69fcb2f1ced8a45af75df96207e95113761b8769bfdaf`
- 先頭10件: `#621 #650 #429 #927 #976 #727 #642 #626 #1015 #141`

`SCREENING_ORDER_VERSION` を 2 から 3 へ上げたが、**規則もseedも変えていない**。証拠候補が版3（frame v2 由来）から版4（frame v3 由来）へ変わったので上げた。並べ替えの鍵は `prNumber` だけなので、版2にもあった98件の相対順は変わらず、増えた4件が間へ入る。

**PR番号順では読まない。** 番号順は結果とは独立だが、ほぼ時間順でもある。この期間中にIssueの運用・テストを足す割合・AIの使い方が変わっていれば、先頭から止めたときに特定の時期だけを読んだことになる。

**停止条件は結果依存で、単位は案件（PR）である。** primary な `groundTruthBasis` の finding を1つ以上持つPRを1件と数える。**同じPRで複数の finding が成立しても、停止のカウントは1**。finding の総数で数えると、少数のPRに集中したときに早く止まりすぎる。最終の抽出は案件単位なので、こちらへ揃える。

**止める判断は primary の総数ではなく、最終の24件を組めるか（sampling feasibility）で行う**（2026-08-31にこう変えた。当初は「primary 40件」だった。理由は下の「停止条件を primary 40件から層の充足性へ変えた」）。次の4つを全て満たした時点で止める。

- 難しい正例に充てられる eligible な案件 >= 9 + 予備
- 普通の正例に充てられる eligible な案件 >= 6 + 予備
- 「問題の無い変更」の負例 >= 6 + 予備
- 「判断しきれない」案件 >= 3 + 予備

正例に数えてよいのは、primary かつその条件の eligibility（`discoverable` かつ `explicitlyExposed` でない）を通ったものだけ。目安として **eligible な primary 18件**（必要15件に対して20%の予備）を暫定の停止点に置くが、18件に届く前でも各層の供給が十分と分かれば止めてよく、逆に18件あっても層が偏っていれば続ける。

**どの条件の eligibility で数えるかは分析ごとに違う**（下の「分析を2つに分ける」）。prompt-placement の分析は条件Aで、context-coverage の分析は条件C-repo で数える。

**版3では `orderIndex 0` から読み直す。** 版2では strong pool を60件読んで一時停止していたが（条件Aだけで数えると残り38件を読んでも15件に届かない見込みで、条件C-repo の増分価値を先に確かめるほうが得るものが大きいと判断したため。下の「条件Aの材料が recall の天井になっている」）、その判定の記録は作業環境ごと失われている。`validateScreeningLog()` は凍結した順を飛ばして読むことを許さないので、途中から再開できない。版2で primary が成立した9件（#621 / #486 / #139 / #1014 / #483 / #330 / #319 / #405 / #135。Issue #1044 のコメントに記録がある）は、版3の順でも `orderIndex 0〜50` に収まっている。

これは「102件のうち何件成立したか」という母集団の割合を出す手続きではない。作りたいのは本測定に使えるpoolであって、成立率の推定ではない。したがって集計では次を分けて出し、**未読を不成立に混ぜない**。

```
totalCases      102 件（強い証拠を持つ）
screenedCases    K 件を読んだ
  primaryCases      P 件（primary な finding を1つ以上持つ）
  nonPrimaryCases   K - P 件（読んだが成立しなかった）
unreadCases     102 - K 件（まだ読んでいない）
```

finding の総数は `primaryFindings` として別に記録するが、**停止判定には使わない**。停止判定に使うのは `primaryCases` のうち eligibility を通ったものの、難易度層ごとの内訳である。

後の工程で抽出の制約を満たせなければ、**凍結した順序の、前回読み終えた位置の次から**読み足す。読む順を後から選び直さないので、どこまで読んだかが変わっても選択の恣意性は入らない。

**この102件は431件から得られるprimary ground truthの全体ではない。** account review / comment しか持たない案件にも `independent-human` になりうるものが残っている。ここで作るのは強い証拠を持つ部分集合から構築したpoolで、足りなければ探索範囲を広げる。

### 2-2. 判定の記録形式を固定する（Issue #1046 手順3の前段）

**証拠を1件も読む前に、記録する形と集計の規則を固定する。** 10件読んでから項目を足すと、先に読んだ案件だけを後知恵で見直す余地ができる。定義は `test/bench/secondOpinionEval/screeningResult.ts` にある。

判定は `eval-results/screening-decisions-v2.jsonl` へ**1件読み終えるたびに1行追記する**。既存の行は書き換えない。

```jsonc
{
  "type": "decision",
  "orderIndex": 0, // 凍結した読む順の位置（0始まり）
  "prNumber": 621,
  "primaryCase": true, // primary な finding を1つ以上持つか
  "findings": [
    {
      "finding": "早期returnで後片付けが飛ぶ",
      "groundTruthBasis": "empirical",
      "evidence": "後続PR #700 が再現テストを足している",
      "evidenceRefs": ["#700"],
      "primary": true,
    },
  ],
  "disposition": "primary",
  "rationale": "後続の再現テストで真だと確認できる",
}
```

判定を訂正するときも行を消さず、`"type": "supersede"` の行を追記して、`supersedes`（置き換える行番号）と `reason` を残す。同じPRに複数の行があれば**後の行が有効**になる。

#### `primaryCase` の決め方

`groundTruthBasis` が `empirical` / `independent-report` / `independent-human` のいずれかである finding を**1つ以上持てば `true`**。それ以外は `false`。finding の数は関係しない（停止条件の単位が案件だから）。

#### `disposition` の意味

`primary` / 非primary の2値にすると、「AI由来しか無かった」「真だと確定できなかった」「そもそも問題が無かった」を後から区別できない。次の7種で持つ。

- `primary` — primary な finding が1つ以上ある
- `model-derived-only` — finding はあるが、根拠がAIレビューだけ
- `retrospective-only` — finding はあるが、後から自分でそう思っただけ
- `mixed-only` — finding はあるが、根拠が複数種類にまたがる（`groundTruthBasis` の `mixed`）
- `other-non-primary` — 上のどれか1種類には収まらない非primary（`model-derived` と `retrospective` が混在する等）
- `insufficient-evidence` — 問題の候補はあったが、真だと確定できる証拠が足りない
- `no-relevant-finding` — 読んだが、正解ラベルにできる問題そのものが無い

記録は手で書くので、読み込む時点で**型どおりかどうかを全部見る**（`parseScreeningEntry()`）。`"type": "decison"` のようなtypoを `as ScreeningEntry` で通すと、集計には入るのに順序の確認からは外れる、という食い違いが起きる。

`validateScreeningEntry()` が、`primaryCase` と `findings` と `disposition` の食い違い、`finding` 本文・`evidence`・`rationale` の空欄、primary なのに参照先が無い記録、空の `evidenceRefs` を検出する。

訂正（`supersede`）は、**その案件の直前の有効な判定を指し**、`reason` が空でないことを要求する。自分自身や後の行を指せると、訂正の履歴が一本につながらない。

#### 集計の出し方（10件ごと）

**手で数えない。** 記録から機械的に導く。

```
npx tsx test/bench/secondOpinionEval/screeningSummary.ts \
  --order eval-results/screening-order-v3.json \
  --decisions eval-results/screening-decisions-v2.jsonl \
  --out eval-results/screening-summary-v2.json
```

| 項目                  | 計算                                                        |
| --------------------- | ----------------------------------------------------------- |
| `screenedCases`       | 有効な判定の件数（訂正は元の行と合わせて1件）               |
| `primaryCases`        | そのうち `primaryCase` が `true` の件数。**停止判定はこれ** |
| `nonPrimaryCases`     | `screenedCases - primaryCases`                              |
| `unreadCases`         | `98 - screenedCases`。**不成立に混ぜない**                  |
| `primaryFindings`     | `primary` な finding の総数。記録のみで停止判定には使わない |
| `nonPrimaryBreakdown` | 非primary 6種それぞれの件数（0件の種別も落とさない）        |

10件ごとの中間報告には、集計に入っている `decisionsSha256` も一緒に残す。追記しかしない記録のcheckpointになり、後から差し替えられていないことを確かめられる。

集計ファイルは凍結しない（進むたびに作り直す）。凍結してあるのは読む順と、追記しかしない判定の記録である。読む順のsha256が凍結済みの版と違えば止まり、凍結した順を飛ばして読んでいれば `validateScreeningLog()` が落とす。

### 2-3. 追加poolを凍結する（Issue #1046 手順3の前段）

強い証拠のpoolを20件読んだ時点で、primary が成立したのは2件だった。残り78件だけで当時の目標だった40件をそろえるには48%の収率が要る。実測の10%とはかけ離れているので、別の供給源を足す。**品質の基準（primary と認める `groundTruthBasis`）は下げない。**

```
npx tsx test/bench/secondOpinionEval/supplementalOrder.ts \
  --candidates eval-results/evidence-candidates-v4.json \
  --strong-order eval-results/screening-order-v3.json \
  --out eval-results/supplemental-order-v2.json
```

#### 読んだ内容から選び方を作らない

20件を読んで見えた失敗の形（別Issueを拾いやすい、scope外を拾いやすい、テスト追加だけを拾う）へ合わせて候補を絞ると、screening の結果で候補の規則を学習したことになる。20件の結果から使うのは「追加探索を始めるかどうか」の引き金だけにする。

集合は手順2で凍結済みの `evidence-candidates-v4.json` の機械的な属性だけで決める。

```
supplemental = 強い証拠を持たない ∩ (follow-up-fix | account-review | account-comment | closing-issue)
```

中身を読んで入れる・外すは決めない。「REDなしの follow-up-fix」のように、人が読んで選別する条件も使わない。

#### tierを付けず、固定seedの順に読む

channel ごとに成立しやすさの見当は付くが、それは主観が入る。強い証拠の102件を先に読んでいる時点で既に「期待の高い順」の優先はしているので、この上さらに順位を付けない。集合全体を `sha256('ground-truth-supplemental-v1:' + prNumber)` の昇順に並べた順で読む。

#### 重複ゼロを検証する

`verifyDisjoint()` が、追加poolと強い証拠のpoolが1件も重ならないことを確かめ、重なれば止める。重なると同じ案件が2つのpoolの分母へ二重に入る。版3での実測は 289件 / 102件 / 重複0件（候補431件のうち、どちらにも入らない40件は、証拠候補をひとつも持たない9件と、`openedAfterMerge` でない follow-up issue しか持たない31件）。版2では 277件 / 98件 / 候補415件だった。

- `eval-results/supplemental-order-v2.json` sha256 `46f119631e658ad6927aca3e48e7cee235d72ee1a6927d9c8227391b36722962`
- 先頭10件: `#782 #85 #884 #221 #329 #791 #275 #779 #648 #906`

#### funnelを供給源ごとに分ける

集計は混ぜない。順序ファイルの sha256 から `poolId`（`strong-evidence` / `supplemental`）を判別し、`screeningSummary.ts` がどちらの供給源の集計かを出す。最終的な primary pool は和集合でよいが、出所は残す。

#### いつ供給源を選び直すか（版3、2026-09-19に差し替えた）

追加poolの先頭10件を読んだ時点で決める。

- primary が3件以上 → 追加poolを続ける
- primary が2件以下でも `insufficient-evidence` が2件以上 → indeterminate の供給源として追加poolを続ける
- primary が2件以下かつ `insufficient-evidence` が1件以下 → 追加poolの screening をいったん止め、`no-problem` と `indeterminate` を作る別工程（証拠channelを持たない案件から機械的に抜く）の設計へ移る

どの結果でも、primary と認める根拠の基準は下げない。続けると決めたら、以降も10件ごとに同じ判定をする。

**この供給源から `no-problem` は作れない。** 取れるのは `hard-positive` / `normal-positive` の積み増しと、`insufficient-evidence` 経由の `indeterminate` だけである。理由は上の「『問題の無い変更』は正例の余りではない」と同じで、screening の `disposition` を負例へ流用すると `hallucinatedFindings` の分母が壊れる。

##### 順序ファイルが持つ版2の規則は使わない

`supplemental-order-v2.json` の `reEvaluationRule` は、版2の停止条件（「到達目標の40 primary」「2件以下なら強い証拠のpoolの続きを20件足す」）のまま書かれている。停止条件は 2026-08-31 に層の充足性へ変わり、強い証拠のpoolも102件すべて読み終えて未読0になったので、**前提を両方とも失っている**。

順序ファイルは sha256 で凍結してあり、文言だけ直すと `order` の同一性を確かめられなくなる（`screeningSummary.ts` の `KNOWN_ORDERS` と、`supplementalOrder.ts` の `writeFrozen()`）。そこで**読む順は版2のまま凍結を保ち、規則の差し替えだけを別ファイルへ残す**。

```
npx tsx test/bench/secondOpinionEval/supplementalRule.ts \
  --order eval-results/supplemental-order-v2.json \
  --strong-summary eval-results/screening-summary-v2.json \
  --out eval-results/supplemental-rule-v3.json
```

- `eval-results/supplemental-rule-v3.json` sha256 `99393cd16981436b9b7df5b37bfdb8488ffb51451d581a9ee1230fbf580a9dbf`
- 差し替え対象（`supersedes`）・差し替え時点の強い証拠のpoolの状態（`decisionsSha256` 込み）・層ごとの供給可否・現行の停止条件を持つ
- `writeFrozen()` で書くので、**1件も読む前に固定した**ことが後から確かめられる。強い証拠のpoolに未読が残っていれば（版2の規則がまだ実行できるので）生成そのものが止まる

##### PR #1053 が引いた読む順との差（#938）

PR #1053 には追加poolの先頭が `#782 #85 #884 #221 #938 #329 ...` と書かれているが、現物の `supplemental-order-v2.json` に #938 は無い。**版差であり、現物が正しい。** 証拠候補が版3（frame v2 由来）から版4（frame v3 由来）へ変わった際に、#938 の follow-up issue として #1044 が `openedAfterMerge` で検出されるようになり、#938 は強い証拠のpoolへ移った（`screening-order-v3.json` の `orderIndex 88`、判定は `no-relevant-finding`）。`verifyDisjoint()` が通っているので二重には入っていない。

#### 追加poolの先頭10件の実測と再評価（2026-09-19）

`orderIndex 0〜9`（`#782 #85 #884 #221 #329 #791 #275 #779 #648 #906`）を読んだ結果は次のとおり。判定は `eval-results/screening-decisions-supplemental-v2.jsonl` に追記だけで残し、集計は `eval-results/screening-summary-supplemental-v2.json` にある（版1の記録は作業環境ごと失われているため `orderIndex 0` から読み直した）。

- primary **2件**（#329 / #275）、finding 2件。どちらも `empirical`
- 非primary 8件 = `model-derived-only` 3（#85 / #884 / #221）/ `no-relevant-finding` 5（#782 / #791 / #779 / #648 / #906）
- `insufficient-evidence` **0件**

**規則どおり、追加poolの screening はここでいったん止める。** 版3の再評価規則（`supplemental-rule-v3.json`）は「primary が2件以下かつ `insufficient-evidence` が1件以下なら、`no-problem` と `indeterminate` を作る別工程の設計へ移る」と定めており、実測はこれに当たる。primary が出ないからではない（収率は強い証拠のpoolの20件時点と同程度で、読み進めれば正例はさらに増える）。**止める理由は、止まっているのが正例ではなく負例と判断保留の供給だからである。** この供給源は定義上そこを埋められない。

実測で分かったこと2つ。

- **primary 2件は、どちらも機械抽出が拾えなかった後続証拠で確定した。** #329 は Issue #416 の入力長別の実測（`n=20000` で 9676ms）と PR #421 のRED確認済み回帰テスト、#275 は Issue #407 と PR #411 のRED確認済み回帰テストである。どちらも候補ファイルの `followUpPrs` / `followUpIssues` は空で、`git log --all -S "<識別子>"` で識別子を追って初めて出てきた。**本文検索だけでは届かない**という事実が、強い証拠のpoolでの2件（#501 / #537）に続いて3・4例目になった
- **`closing-issue` は5件中5件が「このPRが直した欠陥」だった。** 版2の10件で得た観測と同じで、この channel 単独では正例を生まない

#### `account-review` channel の偽陽性（2026-09-19に実測）

`evidenceChannels.ts` の `authorKindOf()` は `MODEL_AUTHOR_LOGINS`（`chatgpt-codex-connector` / `copilot`）と `[bot]` 接尾辞でAIレビュアーを判別するが、GraphQL が返す login は **`copilot-pull-request-reviewer`**（接尾辞なし）で、どちらにも当たらず `account` に落ちる。結果、**追加pool 289件のうち136件は `account-review` が偽陽性**で、実際には人のレビューが0件である（先頭10件では #85 / #221 / #329 / #275 が該当）。

- pool の構成への影響は小さい。`account-review` を落としても他の channel を失わない案件が大半で、**集合から外れるのは13件（4.5%）**にとどまる
- 強い証拠のpool（102件）は `follow-up-test` と `openedAfterMerge` な follow-up issue で選んでおり、この判別を使っていないので影響しない
- 判定そのものも汚染されていない。screening は実物のレビューを読んで `groundTruthBasis` を決めており、channel の値を根拠にしていない

**凍結した読む順は直さない。** 4.5%の入れ替えのために読む順を作り直すと、既に読んだ分を捨てることになり、止まっている `no-problem` と `indeterminate` の不足は1件も解消しない。`MODEL_AUTHOR_LOGINS` の修正は別途行い、次に候補を作り直す版から効かせる。それまでは、**`account-review` は「人がレビューした」ではなく「bot 以外の login がレビューした（誤判定を含む）」と読む。**

### 2-4. `no-problem` と `indeterminate` の供給を凍結する（Issue #1295）

強い証拠のpool 102件と追加poolの先頭10件を読み終えた時点で、正例2層（`hard-positive` / `normal-positive`）の供給は目処が立ったが、`no-problem` と `indeterminate` は 0件のまま止まった。**screening の `disposition` からこの2層は作れない。** `no-relevant-finding` は「正解ラベルにできる欠陥を作れなかった」であって「重要な問題が無い」ではなく（2つのpoolで合わせて52件）、`insufficient-evidence` は **112件読んで 0件**だった。

そこで、証拠channelではなく **sampling frame 側の機械的な性質**から2層を抜く。**1件も読む前に規則を凍結する**のは手順2-2・2-3と同じで、読んでから条件を足すと、先に読んだ案件だけを後知恵で見直す余地ができる。

```
npx tsx test/bench/secondOpinionEval/negativeOrder.ts \
  --frame eval-results/sampling-frame-v3.json \
  --candidates eval-results/evidence-candidates-v4.json \
  --out eval-results/negative-order-v1.json

npx tsx test/bench/secondOpinionEval/indeterminateOrder.ts \
  --frame eval-results/sampling-frame-v3.json \
  --out eval-results/indeterminate-order-v1.json
```

#### 規則を決める前に数えた（frame v3 / eligible 431件、2026-09-19）

**結果変数（回答・採点）は一切見ていない。** 説明変数の側の機械的な判定を431件へ当てて件数を数えただけである。

| 機械的な性質                                                                   | 件数 | 変更規模の内訳                              |
| ------------------------------------------------------------------------------ | ---- | ------------------------------------------- |
| 整形のみ（非docsの変更ファイルが、空白を全て除去すると base と target で一致） | 0    | —                                           |
| 非docsの変更が `test/` 配下のみ                                                | 20   | S 7 / M 8 / L 5 / XL 0                      |
| 同上 かつ `followUpPrs` が空 かつ `openedAfterMerge` な `followUpIssues` が空  | 12   | S 4 / M 5 / L 3 / XL 0                      |
| `git diff <base>..<target>` が `MAX_DIFF_BYTES`（200,000 byte）を超える        | 7    | XL 7                                        |
| （参考）431件の diff バイト数                                                  | —    | 中央値 28,984 / p90 95,381 / 最大 1,251,190 |

- **整形のみは 0件だった。** `git diff -w --ignore-blank-lines` でも空白除去の一致比較でも同じ結果になる。`prettier --write .` で129ファイルを整形した #648 も、同じPRで `format:check` を package.json / CI へ足しているため整形のみには当たらない。「変更の性質が整形に限られる」負例は、**この母集団には存在しない**
- 差分が予算を超える7件は #510 / #81 / #447 / #431 / #648 / #542 / #631
- frame の `test-only` タグ（9件）とは数が違う。タグは docs を含む全変更ファイルが `test/` 配下であることを要求するが、ここでは**非docsの変更ファイル**だけを見る。文書の変更は production の振る舞いを変えないので、負例の根拠を弱めない

#### `no-problem` の供給規則

```
no-problem-pool = frame v3 の eligible
  ∩ 非docsの変更ファイルが全て test/ 配下
  ∩ followUpPrs が空
  ∩ openedAfterMerge な followUpIssues が空
```

**「重要な実装欠陥が無い」を積極的に主張できる根拠は次の2つ**で、どちらも不在の証明ではない。

1. production のコードを1行も触らないので、production の振る舞いを壊す欠陥は構造上あり得ない（差分そのものが根拠）
2. マージ後に、このPRを参照する後続PRも後続Issueも立っていない（事後の裏づけ）

1 だけでは「既存の検証を弱める変更」（期待値の緩和・テストの削除）を排除できない。削除行の有無だけでは切り分けられないので、**凍結した順に読んで、差分に実在する削除・書換が既存の検証を弱めていないかを確認する**。削除行が0なら自動的に満たす。弱めていれば pool から落とし、理由を記録する。この確認は「欠陥が無いことの証明」ではなく「差分に実在する削除行が何をしたか」の確認なので、不在証明の問題は起きない。

12件は予備込みの必要数8件を満たす。S 4 / M 5 / L 3 なので、**正例側で足りない S をここで確保する**。強い証拠のpoolを102件読み切った時点の eligible な primary は、条件Aが23案件（S 1 / M 3 / L 4 / XL 15）、条件C-repo が27案件（S 1 / M 6 / L 4 / XL 16）で、**S が両条件とも1件**しかなく、変更規模の弱い制約（各層3件以上）に届かない。L は102件時点で両条件とも4件になり、正例側だけで満たせている（76件時点では1件だった）。

**限界を結果へ必ず書く。** この層は test-only に偏る。整形のみのPRは0件で、「production のコードを触るが重要な欠陥が無い」と機械的に主張できる案件はこの母集団には存在しない。したがって `hallucinatedFindings` は「テストだけの変更に対して、存在しない問題をどれだけ指摘するか」として読む。

**ラベルが空であることを hallucination の根拠にしない。** この層の案件に対して、採点者が材料を読んで真と確かめられた指摘が出たら、それは `actionableFindings` に入る（「6. 採点する」の既存規則どおり）。`knownImportantFindings` が空であることは、その指摘を `hallucinatedFindings` へ数える根拠にはならない。

#### `indeterminate` の供給規則

```
indeterminate-pool = frame v3 の eligible
  ∩ git diff <base>..<target> のバイト数 > MAX_DIFF_BYTES
```

条件Aの材料は `applyDiffBudget()` で 200,000 byte に収まるよう削られ、**落としたことと落とした対象がプロンプトへ明記される**（`src/secondOpinion/prompt.ts` の `truncated` と省略の行）。落とされた範囲について断定した指摘は、材料の中では真偽を決められないので `indeterminateFindings` へ入る。この層はそれが起きる案件を必ず含めるために要る。

`knownImportantFindings` は**常に空**にする。層の定義が先にあり、案件ごとにラベルを付けるかどうかを選ばないので、後知恵は入らない。recall はこの層では算出しない。

**条件Aで discoverable でない primary 案件（#330 / #405 / #1031 の型）を indeterminate へ充てる案は採らない。** その型では、Advisor に材料が欠けているという手がかりが一切無く、留保する理由が生じない。出るのは「指摘しない」であって「留保する」ではないので `indeterminateFindings` を動かさず、この層の役目を果たさない。測りたいのが留保できるかである以上、**材料の欠落がプロンプトに現れている案件**でなければならない。

7件は予備込みの必要数4件を満たす。全て XL なので、変更規模の弱い制約には寄与しない（S と L は `no-problem` 側で確保する）。

`MAX_DIFF_BYTES` は production の定数なので、**実際に使った値を pool ファイルへ書いて凍結する**。値が変われば pool も変わるため、そのときは版を上げて作り直す。

生の `git diff` のバイト数は打ち切りの proxy である（実際の bundle は untracked 分も予算を食う）。pool を凍結したあと、**条件Aの bundle を1件ずつ組んで `truncated` が立つことを確認する**。これはモデルを呼ばずに決まるので、結果を覗くことにはならない。

#### 既存poolとの関係

追加pool（289件）と重なる。no-problem の候補12件はすべて追加poolにあり（全て未読）、indeterminate の候補7件は強い証拠のpoolに4件（#510 / #447 / #542 / #631。いずれも読了済みで `no-relevant-finding`）、追加poolに2件（#81 未読 / #648 読了 `no-relevant-finding`）、どちらにも入らないものが1件（#431）である。

**この重なりは `verifyDisjoint()` の対象にしない。** 強い証拠のpoolと追加poolを重ねられないのは、**どちらも primary の収率という同じ指標の分母へ入る**からである。`no-problem` / `indeterminate` は別の層の供給で、最終の24件では1案件1層であり、`verifyPool()` が `caseId` の重複を弾く。

読了済みの5件が全て `no-relevant-finding` だったことは、この規則と矛盾しないという確認に留める。**確定の根拠にはしない**（そうすると screening の `disposition` を負例へ流用したことになる）。

funnel は供給源ごとに分けて出す（`poolId` に `negative` / `indeterminate` を足す）。追加poolの screening を再開する場合は、この2層で確定した案件を読む順から飛ばし、`supersede` で記録する。

#### 凍結の契約

手順1・2と同じものを使う。

- 入力は `sampling-frame-v3.json` と `evidence-candidates-v4.json` だけで、どちらも sha256 を照合してから読む
- 出力は `writeFrozen()` で書き、既にあって中身が同じなら書かず、**1バイトでも違えば拒否**する
- 読む順は `sha256('ground-truth-negative-v1:' + prNumber)` / `sha256('ground-truth-indeterminate-v1:' + prNumber)` の昇順。**PR番号順では読まない**
- 判定は追記のみの jsonl（`negative-decisions-v1.jsonl` / `indeterminate-decisions-v1.jsonl`）。訂正は `supersede` の行を足す
- pool ファイルに絶対パスを入れない（frame と同じ理由で、cloneの置き場所でハッシュが変わる）

#### 版1の結果（2026-09-19）

```
no-problem     12 件（S 4 / M 5 / L 3）  文書以外の変更が test/ 配下のみ 20件 から、後続が立っている 8件 を除いた残り
indeterminate   7 件（XL 7）             差分が 200,000 byte を超える案件
```

必要数（予備20%込み）は `no-problem` 8件 / `indeterminate` 4件なので、どちらも満たしている。

- `eval-results/negative-order-v1.json` sha256 `04777c56c6a5d0159d414c5a39796059bbdf1a425a44f2cc9ba4e46f3c369f0b`
  - 読む順: `#174 #878 #664 #182 #988 #316 #1021 #183 #177 #220 #179 #151`
  - 削除行があり、既存の検証を弱めていないかの確認が要るもの: 9件（`#174 #878 #664 #182 #316 #183 #177 #220 #179`）
- `eval-results/indeterminate-order-v1.json` sha256 `01dbbe1cc2f1e8a4c2aa54dfe8bb7dec9964c5a615291055884bf2a29b33fe68`
  - 読む順: `#648 #631 #81 #431 #542 #510 #447`
  - 判定に使った `MAX_DIFF_BYTES`: 200000（出力へ書いてある。値が変われば pool も変わる）

#### 負例の判定を記録する

`no-problem` の判定は `eval-results/negative-decisions-v1.jsonl` へ**1件読み終えるたびに1行追記する**。既存の行は書き換えない。定義は `test/bench/secondOpinionEval/negativeResult.ts` にある。

```jsonc
{
  "type": "decision",
  "orderIndex": 0, // 凍結した読む順の位置（0始まり）
  "prNumber": 174,
  "confirmed": true, // 負例として確定したか。disposition === 'no-problem' と一致していること
  "disposition": "no-problem", // no-problem / weakens-existing-check / rule-mismatch
  "deletionReview": "削除3行は重複した期待値の整理で、検証の条件は変えていない",
  "rationale": "production を触らず、後続も立っていない",
}
```

**screening の記録とは別の語彙にしてある。** screening は「primary な finding が成立したか」を記録し、こちらは「機械的に決まった候補が、読んでも負例のままか」を記録する。同じ `disposition` へ混ぜると `no-relevant-finding`（正解ラベルにできる欠陥を作れなかった）と `no-problem`（重要な実装欠陥が無い）が区別できなくなり、この工程を別に作った理由そのものが消える。

`deletionReview` は**空にできない**。削除行が0の案件でも「削除行が無い」と書く。空を許すと「読んだが何も書かなかった」が確定の根拠になり、この層の意味が消える。

`indeterminate` には読んで確定させる工程が無い（規則が機械的に閉じている）。

#### 供給状況を集計する

```
npx tsx test/bench/secondOpinionEval/negativeSummary.ts \
  --order eval-results/negative-order-v1.json \
  --decisions eval-results/negative-decisions-v1.jsonl \
  --out eval-results/negative-summary-v1.json

npx tsx test/bench/secondOpinionEval/negativeSummary.ts \
  --order eval-results/indeterminate-order-v1.json \
  --out eval-results/indeterminate-summary-v1.json
```

`screeningSummary.ts` とは別のCLIにしてある。語彙が違うものを1つへ入れると、`no-relevant-finding` と `no-problem` を同じ表で並べることになる。読む順のsha256が `KNOWN_ORDERS` のどれとも一致しなければ止まり、読んで確定させる工程がある pool で `--decisions` を省いても止まる（pool の件数がそのまま確定数に見えるため）。

出力は凍結しない。読み進めるたびに作り直すファイルである。

#### 12件を読んだ結果（2026-09-19）

凍結した順（`#174 #878 #664 #182 #988 #316 #1021 #183 #177 #220 #179 #151`）を先頭から飛ばさずに読み、**12件すべてを負例として確定した**。

```
screenedCases 12 / confirmedCases 12 / rejectedCases 0 / unreadCases 0
weakens-existing-check 0 件 / rule-mismatch 0 件
```

- `eval-results/negative-decisions-v1.jsonl` sha256 `ef00e737a7087b68f4e93cd374da399f829c6957874d1ef7b63f77f13f0a7463`（13行。`decision` 12行と、#183 の削除行の内訳を実測へ直した `supersede` 1行）
- `eval-results/negative-summary-v1.json` sha256 `8b53024c561f05ac0059681edeb7f5f16316dc25542c7497f24e5a5599a2e177`
- 確定数12件は予備込みの必要数8件を満たす。変更規模の内訳は pool と同じ S 4 / M 5 / L 3 で、正例側で足りない S 4件と L 3件がここで確保できた

削除行の確認（`needsDeletionReview` が真の9件）で見た削除は、次の4つの型に収まり、**検証の条件を緩めたものは1件も無かった**。

- コメントだけの書き換え（#174 / #878）。テスト本体のアサーション・待ち条件には触れていない
- 待ちの条件を強める置き換え（#664 / #220）。`waitFor`（存在）から `waitForFileContent`（内容）へ、あるいは待ちの読み取りを「まだ書き終わっていない」を例外にしない形へ変えたもので、後段のアサーションは残っている
- フェイクとフィクスチャの拡張（#182 / #183 / #316）。空だったメソッドが呼び出し回数を数える実装になる、固定値の戻り値が既定値つきのフィールドになる、走査対象が作業ツリーから一時ディレクトリの既知構造へ移る、といった変更で、既存のアサーションは残ったまま検証できる対象が増えている
- 型の厳格化（#177）。`readonly unknown[]` を `readonly WorkflowWarningLike[]` へ狭めたもの

判断が分かれうるのは #179 で、フィクスチャの設定へ `agent.workflows.forge=none` / `pullRequest=none` / `finalMerge=pr-only` を足している。これは統合テストの実行がリモートへ到達しないための封じ込めだが、**当時の統合テストは `FakeTaskSessionHost` 越しに走りPR作成を検証していない**（forge の分岐は `test/unit/runner.test.ts` が自前の config で押さえており、そちらは触っていない）。よって既存の検証は弱まらないと判断した。

**全件が確定したことを「この規則なら読まなくてよい」とは読まない。** 確定の根拠は規則が機械的に確かめた2点のままで、読む工程は「削除行が何をしたか」を確認するために要る。#179 のように、production を触らないまま**テストの実行条件**を変える削除は機械的な判定では拾えない。

#### `indeterminate` の打ち切りを確認した（2026-09-19）

pool を凍結したあとの確認（`postFreezeVerification`）を実施した。**7件すべてで条件Aの材料が打ち切られ、打ち切りの注意書きがプロンプトへ出た。**

```
npx tsx test/bench/secondOpinionEval/indeterminateTruncation.ts \
  --order eval-results/indeterminate-order-v1.json \
  --frame eval-results/sampling-frame-v3.json \
  --out eval-results/indeterminate-truncation-v1.json
```

**`truncated` だけを見ない。** 3つを同時に確認する。

1. `snapshot.truncated` が立つ（`applyDiffBudget()` が何かを落とした）
2. 落とした対象（`diffOmissions` / `diffPartials`）が1件以上ある。件数0で真だけが立つ状態は、Advisor に「どこを見ていないか」が伝わらない
3. 条件Aの**プロンプト本文**へ打ち切りの注意書きが出る。留保の手がかりはここにしか現れない

材料は `prepareCaseMaterial()` と `buildSecondOpinionPrompt()`（どちらも本体と同じ関数）で組む。ハーネス側で予算やプロンプトを書き直すと、確認の対象が本体からずれる。**モデルは呼ばない**ので、結果を覗くことにはならない。

| PR   | 生の差分 (byte) | 材料の差分 (byte) | 落とした対象 |
| ---- | --------------- | ----------------- | ------------ |
| #648 | 495,613         | 193,993           | 31           |
| #631 | 1,251,190       | 199,185           | 42           |
| #81  | 289,672         | 190,739           | 4            |
| #431 | 487,949         | 199,664           | 13           |
| #542 | 766,510         | 199,825           | 15           |
| #510 | 249,828         | 184,998           | 4            |
| #447 | 360,713         | 199,541           | 8            |

- `eval-results/indeterminate-truncation-v1.json` sha256 `57200481d651ca2bf507dd5cc5928e32c8d23a156f3535ba7563ad56fd6de5aa`
- 未追跡ファイルは detached worktree から材料を取るため0件で、予算は差分だけが使っている。生の差分が予算を超える案件が実際にも打ち切られたのは、この条件下での結果である
- CLI は満たさない案件が1件でもあれば非ゼロで終わる。1件が落ちても残りは続け、そこまでの結果を書き出してから止まる（`prepared` が偽なら「材料を組めなかった」で、pool の前提が崩れたという話ではない）。`materials.ts` や `applyDiffBudget()`、プロンプトの注意書きの文言を変えたら流し直す

この出力は凍結しない。実装を直すたびに作り直して読み替えるファイルである。凍結してあるのは読む順（`indeterminate-order-v1.json`）の側で、確認は読む順を変えない。

### 3. 案件ファイルを作る

`test/bench/secondOpinionEval/cases.example.json` を雛形にする。24件を目安に集める。

`kind` は案件の属性として必ず持たせるが、**層化の軸には使わない**（2026-08-31にこう決めた。理由は下の「`kind` で層化しない」）。

| `kind`           | 意味             |
| ---------------- | ---------------- |
| `codeReview`     | 変更のレビュー   |
| `designDecision` | 設計判断の妥当性 |
| `rootCause`      | 原因の切り分け   |
| `choice`         | 複数案からの選択 |

**「印象に残っている案件」を並べない。** 先に候補を機械的に列挙し（例: 過去3か月のPR全件）、次の条件を満たすものだけを残してから、種類ごとに等間隔またはランダムに抜く。精度が悪かった案件だけを選ぶと、改善幅が過大に出る。

- 結論が確定している
- `baseCommit` / `targetCommit` を復元できる
- 当時の依頼文が残っている
- 何が重要だったかの根拠が残っている

**層化する軸は難易度だけで、内訳は先に決めてから抜く。** 全件が「既知の重大問題を1つ持つ変更」だと、指標が上に張り付いて条件差が見えない（pilot 3件が実際にそうなり、recall が全条件 1.000 になった）。24件での必要数は次のとおり。

| 内訳                                       | 割合    | 24件での必要数 | 何を測るためか                                                |
| ------------------------------------------ | ------- | -------------- | ------------------------------------------------------------- |
| 難しい正例（見落としやすい重大問題を含む） | 35〜40% | 9              | recall の天井を作らない                                       |
| 普通の正例（気づける程度の問題を含む）     | 25〜30% | 6              | 通常運用に近い状態                                            |
| 問題の無い変更・ほぼ無い変更               | 20〜25% | 6              | 存在しない問題を指摘する量（`hallucinatedFindings`）を測る    |
| 材料だけでは判断しきれない変更             | 10〜15% | 3              | 留保できるか（`indeterminateFindings`）と、決めつける癖を測る |

正例（難しい・普通）は次の2つを両方満たすものだけを充てる。

- `groundTruthBasis` が primary（`empirical` / `independent-report` / `independent-human`）
- その条件での eligibility（`discoverable` かつ `explicitlyExposed` でない）を通っている

**「問題の無い変更」は正例の余りではない。** screening の `no-relevant-finding` は「正解ラベルにできる欠陥を作れなかった」であって「重要な問題が無い」ではないため、そのまま負例にすると `hallucinatedFindings` の分母が壊れる。負例は別途、重要な実装欠陥が無いことを主張できる根拠を持たせる（変更の性質が整形・文書・テスト整備に限られる、など）。

**難しい正例を作るために、1つの根本原因を複数の `knownImportantFindings` へ割らない。** 分母を増やして数字を動かしているだけで、測っている中身は変わらない。難しさは案件そのもので作る。

**層化するのは難易度の1軸だけにする。** 24件に対して `kind` や変更規模まで加えて層化すると、セルの多くが0件になる。「複数軸で層化した」と書いても、実際にはどこかの軸を妥協することになる。

#### `kind` で層化しない（2026-08-31）

当初は `kind` と難易度の2軸で層化する予定だったが、正解ラベルの供給が `kind` に対して偏っていることが実測で分かったため、`kind` を層化の軸から外した。

screening 50件（strong 40 / supplemental 10）時点の実測は次のとおり。

- 独立した根拠を持つ案件（primary）は7件。うち条件Aで発見可能なのは5件
- 5件はすべて差分のレビューとして自然な案件で、`kind` は `codeReview`。`rootCause` として振れるのが最大2件
- `designDecision` / `choice` の正例は0件。「採らなかった案」を書いたPRはあるが、いずれも独立した根拠を持たず正解ラベルにできない

これは母集団がPRであることの帰結で、読み進めても解消しない。ここで `kind` ごとに件数を揃えると、供給に合わせるのではなく**実在しない分布を作る**ことになる。`designDecision` / `choice` を評価対象にするなら、PRとは別の sampling frame（設計相談・比較選択の記録）を凍結して正解ラベルを別方式で作る必要があり、それは #1044 の範囲を超える。

`kind` は捨てず、案件の属性として持たせて結果に内訳を必ず出す。件数が十分な `kind` だけ参考値を出し、**`kind` 間の比較を主要な結論にはしない**。この benchmark はPR由来の独立した根拠を使うため `codeReview` / `rootCause` へ偏っており、`designDecision` / `choice` への一般化は対象外である、と明記する。

#### 停止条件を primary 40件から層の充足性へ変えた（2026-08-31）

当初は「primary な案件が40件そろうまで読む」を停止条件にしていたが、50件（strong 40 / supplemental 10）を読んだ実測から、この数は必要量ではなく余裕値の見積もり違いだと分かったため、最終の抽出が成立するかを見る条件へ変えた。

- strong pool 40件で primary は7件（累計17.5%。前半20件で2件、後半20件で5件）
- supplemental pool は10件で0件。closing Issue の欠陥は「そのPRが生んだ欠陥」ではなく「そのPRが直した欠陥」だった
- この収率で strong の残り58件を読み切っても、primary は概ね17〜22件に落ち着き、40件には届かない

一方、最終の24件に要る正例は15件で、そのうち難しい正例が9件である。したがって40件は必要量ではなく、余裕を厚く見積もりすぎた数だった。**下げたのは必要量の見積もりだけで、primary と認める根拠の基準（`empirical` / `independent-report` / `independent-human`）は変えていない。**

**変更規模（`changeSizeStratum`）は層化の軸ではなく、抽出後のバランス確認に使う。** 同じ案件を全条件へ流す対照実験なので、「条件Aだけ大きいPRが多い」ということは起きない。確認したいのは、選んだ24件が特定のサイズ帯だけに偏っていないことだけである。抽出前に次の弱い制約だけ決めておく。

- 4つの層それぞれから最低3件
- `extreme-tail`（変更行数がp90超）を最低1件は含める

**変更規模の大きいPRを上限で足切りしない。** 大きい変更ほどセカンドオピニオンが苦手なら、それは測るべき弱点であって、除外していい理由ではない。**抽出後にプロンプト長を見て人手で案件を入れ替えるのもしない。** 交換の判断が入った時点で、機械的に抽出した意味が消える。

そもそも `B-pos` / `B-repeat` の効果に効くのは変更行数ではなく、**依頼文より後ろに実際に何バイト続くか**である。16965行のPRでも差分が途中で切られれば入力は小さくなり、300行でも背景が長ければ重くなる。実プロンプト長は、eligible pool が確定して材料を作れる段階（**抽出の前**）に、条件Aのプロンプトを組み立てて `promptBytes` / `bytesAfterRequest` / 差分の打ち切り有無を測る。これはモデルを呼ばずに決まるので、結果を覗くことにはならない。

各案件で必須なのは次の3つ。

- `baseCommit` と `targetCommit`: 材料を取る地点。**両方とも省略できない。** `git diff <base>` の右辺は作業ツリーなので、`baseCommit` だけでは後日流し直したときに別の材料になる。ハーネスは `targetCommit` で一時worktreeを作り、その中で材料を取る
- `conversationKind`: `conversation` が要約 (`summary`) か会話記録 (`transcript`) か。本番では長い会話は要約セッションを通るので、本番相当にしたい案件は本番経路で一度作った要約を貼って `summary` を指定する
- `knownImportantFindings` / `knownConstraints`: 採点の正解。**実験の実施前に確定させること**

`knownImportantFindings` は文字列ではなく、根拠付きのオブジェクトで書く。

```json
{
  "finding": "何が問題だったか（根本原因と、そこから観測できる症状で書く。修正箇所で書かない）",
  "groundTruthBasis": "empirical",
  "evidencePaths": ["src/orchestrator/teamHandoff.ts"],
  "recallCriteria": [
    "発生条件（いつ起きるか）に言及している",
    "破れる性質・観測できる症状（何が壊れるか）に言及している",
    "重要度を決める範囲（別の主体をまたぐか、など）に言及している"
  ],
  "evidence": "そう言える根拠（テストID・Issue番号・実測値）",
  "severity": "critical",
  "provenance": "test"
}
```

`recallCriteria` を `finding` と分けてあるのは、**採点の判定条件を実験の前に固定するため**である。これが無いと、回答を読んでから「これは拾ったうちに入るか」を決めることになり、主指標の recall が採点者の解釈で動く（pilot #1027 で実際に、同じ6回答の recall が 1.000 と 0.000 の両方になった）。

**自由文1本ではなく、2〜4個の条件へ割る**（ハーネスは4個までしか受け付けない）。1本にすると、広く書けば何でも拾ったことになり、狭く書けば言い換えを落とす。書くのは**最小の因果鎖**で、「発生条件」「破れる性質・観測できる症状」「重要度を決める範囲」を揃える。特定の関数名・実際に入ったパッチ・実装方法は要求しない。**すべて満たしたときだけ拾ったと数える。**

`knownImportantFindings` は**空でよい**。「見るべき問題が無かった変更」を混ぜないと、存在しない問題を指摘する量を測れない。その案件では recall は算出しない（対象外）。

`knownConstraints` は**材料の中で確かめられる事実だけ**を書く。詳しくは「6. 採点する」の「真偽は材料の中だけで判定する」を参照。

### 分母へ入れてよい正解ラベル（Issue #1046）

`provenance`（根拠が置かれている場所）とは別に、**その問題が真だと何で確定したか**を `groundTruthBasis` に書く。recall の分母はこちらで決める。

| 値                   | 意味                                                                     | 分母     |
| -------------------- | ------------------------------------------------------------------------ | -------- |
| `empirical`          | 修正前で失敗し修正後で成功するテスト、再現テスト、実機再現、ログ、実測値 | 入る     |
| `independent-report` | AIレビューとは独立に発生した具体的症状。再現条件と観測結果が残るもの     | 入る     |
| `independent-human`  | コードから論理的に成立すると人が確認したもの。AI指摘の転記でないこと     | 入る     |
| `model-derived`      | AIのレビューだけが根拠。AI指摘をそのまま転記したIssue・コメントを含む    | 外す     |
| `retrospective`      | 後から自分でそう思っただけ                                               | 外す     |
| `mixed`              | 複数種類にまたがる。**最も弱い根拠で判定する**                           | 判定次第 |

**記録場所や投稿者では判定しない。** 「AIが指摘 → 人がIssueへ転記 → `provenance: issue`」という経路が残るためである。このリポジトリでは直近120件のマージ済みPRのうち75件に `chatgpt-codex-connector` のレビューが付いており、実際にその経路が起きうる。測定対象と同じモデル系列の出力を正解にすると、recall は「すでにCodexが言ったことをもう一度言えるか」の測定になる。

**「後続コミットで直した」という事実だけでは足りない。** 誰かが直すと判断したことは示せるが、元の問題が実際に成立した証拠にはならない。

### 条件ごとに変わるもの

次の2つは**条件に依存する**のでラベルへ書かない。

- **発見可能か** — 条件Cで凍結リポジトリを探索させれば発見可能になる問題がある（#1047）
- **入力に答えが書かれているか** — case brief を生成する条件では、生成文が原因を書いてしまえば、材料から推論するはずだった問題が入力に露出する

ラベルが持つのは `evidencePaths`（発見に何が要るか）だけで、これは**判定の入力であって判定そのものではない**。「パスが材料に入っている＝発見できる」ではない。条件Aでは after 側の内容が `base/` に無くても `changes.diff` の全量から再構成できることがあり、逆にパスが入っていても必要な hunk がプロンプトから省かれていることもある。基準は次のとおり。

> その条件で Advisor が実際にアクセスできる証拠から、`recallCriteria` を合理的に導けるか。

判定は条件ごとに人が下し、`eligibility.json` へ残す。

```json
{
  "caseId": "...",
  "findingIndex": 0,
  "conditionId": "A",
  "discoverable": true,
  "explicitlyExposed": false,
  "rationale": "そう判定した理由"
}
```

**primary benchmark の分母は「条件A（現行bundle）で発見可能」で判定する。** 条件Aで証拠が無い案件を混ぜると、依頼文の位置効果ではなく材料不足を測ってしまう。条件Cを測るときは、「Aでは発見できないが探索すれば発見できる」案件を別セットとして集計する。ラベルは共通なので**再ラベルは要らない**。

実行時は `evidencePaths` のうち bundle に見当たらないものを一覧で出す。これは判定の材料であって判定ではなく、**実行は止めない**（自動で弾くと、差分から再構成できる案件まで黙って落ちる）。

回答を見てから正解を足したり削ったりすると、その回答に有利な採点になる。案件ファイルと判定ファイル（`eligibility.json`）の内容ハッシュは、実行時に `manifest.json` の `casesSha256` / `eligibilitySha256` へ記録される。集計はこの2つを照合し、**一致しなければ止まる**。

止めるのは、判定ファイルが recall の分母を直接動かすためである。`discoverable` を1つ `false` にするだけで分母が減り、ラベルは1文字も変わらないので差分にも出ない。警告にして続けると、歪んだ数値が出てから気づくことになる。`--eligibility` を付けずに実行した run も、分母を後から決められる状態なので集計しない。

案件ファイルは実案件のパスや会話を含むため、リポジトリへコミットしない。

#### 分析を2つに分ける（2026-08-31）

screening 60件の実測（下の「条件Aの材料が recall の天井になっている」）を受けて、1つの benchmark で全条件を並べるのをやめ、次の2つに分ける。**分母が違うものを1つの表に並べると、材料不足と依頼文の位置効果が混ざる。**

| 分析             | 比較する条件               | 分母                                            | 何が分かるか                                     |
| ---------------- | -------------------------- | ----------------------------------------------- | ------------------------------------------------ |
| prompt-placement | `A` / `B-pos` / `B-repeat` | **条件Aで discoverable な finding だけ**        | 同じ材料のまま依頼文を末尾へ動かす・繰り返す効果 |
| context-coverage | `A` / `C-repo`             | primary な finding 全部（条件ごとの判定を使う） | 探索でどれだけ材料不足を埋められるか             |

context-coverage では次の3つに分けて出す。**最も重要なのは2番目**で、これが探索の増分価値そのものになる。

- `A-discoverable`（両条件で発見できるはず）
- `A-undiscoverable / C-repo-discoverable`（探索でしか届かない）
- どちらでも発見できない

**条件Aの定義は変えない。** 現行 production の材料そのものであり、これを広げると既存の pilot・eligibility 判定・screening 60件の意味が全部変わる。広い材料は条件 `C-repo`（#1047）として足し、Aは凍結した baseline として残す。

#### 条件C-repo の discoverable をどう判定するか

条件C-repo の材料は「凍結した after-tree ＋ `changes.diff` を bounded read-only で探索」である（#1047）。判定基準は次の2つを両方満たすこと。

- 証拠となるファイルが `targetCommit` の after-tree に**実在する**（`git show <targetCommit>:<path>` で確認する）
- 差分に現れる識別子（変更した関数名・型名・新設フィールド名・変更した固定文字列）から、**1〜2ホップの grep と読解で到達できる**

リポジトリ全体の網羅走査は前提にしない。#1047 の固定指示が「判断に必要な場合だけ依存先を追加で読む」である以上、「全部読めば見つかる」を discoverable の根拠にすると、実際の探索より甘い分母になる。

条件Aの `base/<変更対象ファイル>` は after-tree と `changes.diff` から復元できるため、**A で discoverable な finding は C-repo でも discoverable として扱う**。

#### 条件Aの材料が recall の天井になっている（2026-08-31）

strong pool を60件読んだ時点の実測。

- primary な案件 9件（15%）
- そのうち条件Aで discoverable なのは 5件（8.3%）
- **primary 9件のうち4件（44%）が条件Aで発見できない**

落ちた4件（#330 / #319 / #405 / #135）は構造が全部同じで、**PRが壊した・繋ぎ損ねた場所が、そのPRが触っていないファイルにある**。強い証拠（後続テストの赤・後続fix）が付くのはまさにこの型なので、strong pool の証拠条件と条件Aの発見可能性は構造的に逆を向いている。

この4件を条件C-repo で判定し直すと **4件とも discoverable** だった（証拠ファイルの実在は `git show` で確認済み）。

- #330: after-tree の `test/integration/workflowMerge.test.ts` に旧形式 `Merge task T2 (run ...)` が実在。変更した `mergeCommitMessage` か旧形式の文字列を grep して1ホップ
- #405: `test/integration/workflowForgeOrder.test.ts` に `['pr','merge','--merge']` の期待値が実在。テストは関数名を名指ししないため「変更した引数列の期待値を持つテストを探す」形の探索が要る
- #135: `src/orchestrator/runner.ts` に `issue: undefined` が実在。新設した `issue` フィールドの消費側を grep して1ホップ
- #319: 送信経路（`chatView.ts` → `stateDelta.ts`）が実在。ただし2〜3ホップと、切り詰めが表示用 diff にしか効かないという読解が要る。他3件より弱い

したがって screening の停止条件は「**条件Aで** eligible な primary が何件そろったか」では見ない。分析ごとに分母が違うので、**それぞれの分析に十分な分母があるか**で見る。難易度の必要数 `9 / 6 / 6 / 3` は変えない。

「条件Aだけでは正例が15件そろわなかった」ことは benchmark の失敗ではない。**production の材料では、独立した根拠を持つ既知の欠陥のかなりの部分がそもそも観測できない**という製品側の実測結果である。

#### 版3・76件時点の eligibility 判定と停止判定（2026-09-19）

強い証拠のpool 102件のうち76件を読んだ時点で、primary な案件は18件（finding 20件）になった。停止してよいかを見るために、この20件を条件Aと条件C-repo の2つで判定し `eval-results/eligibility-v1.json` へ、難易度層の割り付けを `eval-results/difficulty-v1.json` へ残した。どちらも `screening-decisions-v2.jsonl` のsha256を持つので、後から判定の入力を取り違えない。

判定の規約は次のとおりで、手順4の案件ファイルもこれに揃える。

- `caseId` は `pr-<PR番号>`
- `knownImportantFindings` には screening の `findings` のうち `primary: true` のものだけを同じ順に並べ、`findingIndex` はその並びの添字とする。screening 側の添字は `screeningFindingIndex` として残す
- `explicitlyExposed` は現時点の材料（`changes.diff`・`base/`・変更対象の docs）だけで判定した。`userRequest` と `conversation` を確定させる手順4で、その本文に答えが書かれていないかを見直す

結果は次のとおり。

- 条件A: eligible 15案件 / 17 finding
- 条件C-repo: eligible 18案件 / 20 finding

条件Aで落ちたのは #330 / #405 / #1031 の3件で、いずれも根拠が変更対象外のファイルにある。#330 と #405 は追随していない統合テスト、#1031 は `eslint.config.mjs` である。60件時点（#330 / #319 / #405 / #135）と同じ型が続いており、3件とも条件C-repo では discoverable だった。

難易度層の割り付けは、成立に差分の外の事実か、並行実行・環境変数・攻撃者の介在・状態遷移の相互作用といった非自明な前提が要るものを `hard-positive`、変更対象のファイルを読めば直接見える論理欠陥を `normal-positive` とした。

| 分析                           | hard-positive | normal-positive | no-problem | indeterminate |
| ------------------------------ | ------------- | --------------- | ---------- | ------------- |
| prompt-placement（条件A）      | 8             | 7               | 0          | 0             |
| context-coverage（条件C-repo） | 11            | 7               | 0          | 0             |
| 必要数（予備20%込み）          | 11            | 8               | 8          | 4             |

**この時点では止めない。** 目安の「eligible な primary 18件」には届いたが、層で見ると足りていない。

- 条件Aの `hard-positive` が8件で、予備を抜いた必要数9件にも届かない
- `normal-positive` はどちらの分析でも7件で、予備込みの8件に1件足りない
- `no-problem` と `indeterminate` は両方0件。screening の `disposition` からはそのまま作れない。`no-relevant-finding` は「正解ラベルにできる欠陥を作れなかった」であって「重要な問題が無い」ではなく、`insufficient-evidence` は76件読んで0件だった

あわせて、変更規模の弱い制約（各層3件以上）も正例側だけでは満たせない。eligible な18件の内訳は S が1件、M が5件、L が1件、XL が11件で、S と L は `no-problem` と `indeterminate` の側で確保する必要がある。

上の数字は76件を読んだ時点のもので、`eligibility-v1.json` と `difficulty-v1.json` は screening を進めるたびに作り直す。したがってファイルの中身はここに書いた数字より先へ進んでいることがある。比較するときは、ファイルが持つ `screenedCases` と `decisionsSha256` で時点を合わせる。

### 3-1. 24件を層化ランダム抽出する（Issue #1046 手順4）

eligible pool から本測定の24件を機械的に抜く。**印象で並べず、抜いた結果を見て内訳を決め直さない。**

#### 母集団を組み立てる

抽出の母集団（`selection-pool`）は、4つの層の凍結済みファイルを束ねて作る。

```
npx tsx test/bench/secondOpinionEval/selectionPool.ts \
  --difficulty eval-results/difficulty-v1.json \
  --negative eval-results/negative-order-v1.json \
  --negative-decisions eval-results/negative-decisions-v1.jsonl \
  --indeterminate eval-results/indeterminate-order-v1.json \
  --frame eval-results/sampling-frame-v3.json \
  --condition A \
  --out eval-results/selection-pool-v1.json \
  --out-explore eval-results/explore-only-v1.json
```

**層の判断はここではしない。** 正例の難易度は `difficulty-v1.json`、`no-problem` は `negative-order-v1.json`、`indeterminate` は `indeterminate-order-v1.json` が既に凍結している。束ねる側で層を付け替えられるようにすると、抽出の直前に供給の多い層へ寄せられてしまう。`no-problem` は確認が済んだ（`confirmed`）案件だけを入れる。

**`kind` は全案件 `codeReview` にする。** 母集団はすべてPRの差分で、依頼文も差分のレビューに揃えるためである。`rootCause` や `designDecision` として振り直せる案件はあるが、それは依頼文の書き方の選択であって案件そのものの属性ではない。ここで振り分けると実在しない `kind` の分布を作ることになる（上の「`kind` で層化しない」）。

**正例に要求する条件は `A` にする。** primary benchmark の分母は条件A（現行bundle）で発見可能かで判定する、と「条件ごとに変わるもの」で決めてある。条件Aで発見できない正例（`difficulty-v1.json` の `eligibleIn` に `A` が無いもの）は捨てずに `--out-explore` へ分け、context-coverage 分析の `A-undiscoverable / C-repo-discoverable` に使う。**母集団へ混ぜないだけで、評価の対象からは外さない。** ラベルは共通なので再ラベルは要らない。

`--out-explore` の側を母集団へ混ぜると、抽出された `hard-positive` の一部が prompt-placement の分母から落ちる。条件A・B-pos・B-repeat の比較は同じ分母で見るものなので、ここで正例が9件を割ると、測っているのが依頼文の位置効果なのか材料不足なのか分からなくなる。

#### 24件を抜く

```
npx tsx test/bench/secondOpinionEval/selectCases.ts \
  --pool eval-results/selection-pool-v1.json \
  --frame eval-results/sampling-frame-v3.json \
  --eligibility eval-results/eligibility-v1.json \
  --condition A \
  --out eval-results/selected-cases-v1.json
```

`--pool` は上で組み立てた母集団で、1件ごとに `caseId` / `prNumber` / `stratum`（難易度）/ `kind` / `changeSizeStratum` / `tags` を持つ。難易度の判断だけが人の入力で、**それ以外の属性は照合される**。`--condition` は母集団を作ったときと同じ値を渡す。

**規則は入力より先に決まっている。** 層ごとの必要数（`9 / 6 / 6 / 3`）・seed・変更規模のバランス制約は `stratifiedSample.ts` の定数で、pool の中身では変わらない。規則を変えるときは `SELECTION_VERSION` を上げ、前の版のファイルは残す。

抽出の前に3つを確かめ、1つでも通らなければ**抜かずに止める**。

- pool の `changeSizeStratum` と `tags` が、凍結済みの sampling frame と一致すること。frame で除外済みのPRが混ざっていないこと。ここを緩めると、`extreme-tail` の目印を書き換えてバランス制約を通せてしまう
- 正例（`hard-positive` / `normal-positive`）が、その条件の eligibility で `discoverable` かつ `explicitlyExposed` でないこと。**判定が無い正例は通ったものとして扱わない**
- 層ごとの候補数が必要数以上あること。足りなければ screening を読み進めてから抽出する

変更規模のバランス制約（4層それぞれ最低3件 / `extreme-tail` 最低1件）を満たさないときは、seed に試行番号を混ぜて引き直す。**引き直しは番号を1つずつ進めるだけで、途中で規則は変えない。** 落ちた試行も出力の `attempts` に残すので、何回引いたかは後から見える。上限（100回）に達したら、seed を足して引き直さずに止める。満たすまで回せる設計にすると「制約を満たした」ではなく「満たすまで回した」になるため、そこで母集団か制約のどちらかを人が見直す。

出力は `writeFrozen` で凍結する。同じ入力から作り直して一致を確かめることはできるが、**1バイトでも違えば書かずに止まる**。

#### 版1の結果（2026-09-19）

母集団は42件で、4層すべてが必要数を上回った。条件Aで発見できない正例4件（#330 / #1031 / #405 / #935、いずれも `hard-positive`）は `explore-only-v1.json` へ分けた。

| 層                | 母集団 | 必要数 | 抽出 |
| ----------------- | ------ | ------ | ---- |
| `hard-positive`   | 12     | 9      | 9    |
| `normal-positive` | 11     | 6      | 6    |
| `no-problem`      | 12     | 6      | 6    |
| `indeterminate`   | 7      | 3      | 3    |

**引き直しは起きず、1回目の試行がそのまま制約を満たした。** 変更規模は S 3 / M 5 / L 3 / XL 13 で4層それぞれ最低3件を満たし、`extreme-tail` は8件だった。`kind` は全件 `codeReview` である。

選んだ24件は次のとおり。

- `hard-positive`: #621 #504 #1014 #985 #503 #536 #417 #384 #139
- `normal-positive`: #951 #343 #486 #501 #415 #90
- `no-problem`: #183 #878 #220 #988 #179 #174
- `indeterminate`: #510 #542 #447

- `eval-results/selection-pool-v1.json` sha256 `bda6f01a8734889c42cece89f1f88bc044296cc1984950b6fc66ec5f79a5a608`
- `eval-results/explore-only-v1.json` sha256 `e813077157235c09d53a9592b623c09c11801eb8c87e809541b916e0cbcda203`
- `eval-results/selected-cases-v1.json` sha256 `024d9f66aa8dd9b6c58ef3d3200b33517cfe4ddaf50cbec20f0cf73ac58992b1`

変更規模の S は母集団に5件しか無く、うち4件が `no-problem` 側にある。正例だけでは S と L の最低3件を満たせないという版3・76件時点の見立ては、24件の抽出でもそのまま当たった。**ここで S を増やすために層の必要数を動かさない。** 動かせば、測りたい難易度の内訳ではなく変更規模の都合で分母が決まる。

抜かれなかった18件は予備である。**回答を見てから差し替えない。** 差し替えが要るのは、材料を作る段階（手順4）で `baseCommit` / `targetCommit` から材料を復元できないと分かった案件だけで、そのときも人が次の1件を選ばない。使えない案件を母集団から外し、`SELECTION_POOL_VERSION` と `SELECTION_VERSION` を上げて抽出をやり直し、前の版のファイルは残す。

### 4. 実行する

```
npx tsx test/bench/secondOpinionEval/run.ts \
  --cases <案件ファイル> \
  --out <結果ディレクトリ> \
  [--conditions A,B-pos,B-repeat] [--attempts 2] [--model gpt-5.6-sol] [--effort high]
```

モデルとeffortは既定で `gpt-5.6-sol` / `high`（Advisor本体の既定と同じ）。**全条件で同じ値を使うこと。** 条件ごとに変えると、測っているのが介入の差なのかモデルの差なのか分からなくなる。

`--attempts` の既定は2。1回では、条件の差なのか同じ条件内のばらつきなのかを区別できない。同じ案件で条件の勝ち負けが試行ごとに反転するなら、介入の効果よりばらつきのほうが大きいということになる。

条件の実行順は案件と試行の番号でずらしてある。全案件で同じ順に流すと、モデル側の一時的な調子（混雑・時刻・バックエンドの入れ替え）が特定の条件へ偏って乗る。何番目に実行したかは各結果の `conditionOrder` に残る。

結果は1実行1ファイル（`<案件id>__<条件id>__<試行番号>.json`）で残り、runの素性は `manifest.json` に入る。失敗した実行があると終了コードが1になる。

**結果ディレクトリはrunごとに分ける。** 同じディレクトリへ別のrunの結果が混ざると、条件ごとの件数が合わなくなる（`runId` が違うものは採点シート生成時に弾かれ、件数が出る）。

### 5. 採点シートを作る

```
npx tsx test/bench/secondOpinionEval/scoringSheet.ts \
  --results <結果ディレクトリ> --cases <案件ファイル> --out <採点用ディレクトリ> [--seed 12345]
```

3つのファイルができる。

- `sheet.json`: 条件名を伏せ、順序をシャッフルした回答一覧。案件idも別名に置き換える（`advisor-summary-bug` のような名前は手がかりになる）
- `rubric.json`: 案件ごとの採点基準（依頼文・重要問題の一覧・制約）。条件によって変わらない情報だけなので、これで条件は割れない
- `key.json`: 対応表。**採点が済むまで開かないこと**

`--seed` を省くと自動で決まるが、値は標準出力に出る。**同じseedなら同じシートを再生成できる**ので、採点をやり直すときや、後から並びを検証するときのために控えておく。

失敗した実行は採点対象から外れる。除外件数は**条件ごとに**出る。片方の条件だけ多く落ちていると、生き残った回答だけで比べることになり、良い方へ偏った結論になる。

**条件ごとのプロンプト全文は採点者へ渡さない。** `B-repeat` は依頼が2回入っているので、見ればどの条件か分かる。

### 6. 採点する

`sheet.json` の各項目を `rubric.json` の同じ `opaqueCaseId` と突き合わせ、次の値を付けた配列を `scores.json` として書く。

| 項目                               | 数えるもの                                                   |
| ---------------------------------- | ------------------------------------------------------------ |
| `totalFindings`                    | 指摘の総数                                                   |
| `actionableFindings`               | 材料の中で真と確かめられ、実際に採用できる指摘の数           |
| `verifiedNonActionableFindings`    | 材料の中で確かめた結果、採用に値しないと判断した指摘の数     |
| `hallucinatedFindings`             | 材料と矛盾する、存在しない問題を指摘していた数               |
| `indeterminateFindings`            | 材料の中では真偽を決められない指摘の数                       |
| `recalledFindingIndexes`           | 拾えた正解ラベルの添字（`knownImportantFindings` の位置）    |
| `constraintViolations`             | 制約・既決事項を誤認していた箇所の数                         |
| `unnecessaryInvestigationRequests` | 「まず調べてほしい」で終わり、判断材料になっていない要求の数 |

**指摘は4区分のどれか1つへ必ず入れる。** `actionableFindings` + `verifiedNonActionableFindings` + `hallucinatedFindings` + `indeterminateFindings` が `totalFindings` と一致しない採点は、集計時に除外され、`scoringId` 付きで報告される。

#### 指摘の数え方（先に固定する）

**同じ根本原因・同じ修正を指す記述は、箇条書きが何行に分かれていても1件と数える。** これを決めておかないと、1つの問題を3つの箇条書きに割った回答だけ分母と分子が動き、精度の比較が書き方の比較になる。

#### 真偽は材料の中だけで判定する

`actionableFindings` と `hallucinatedFindings` を分けるのは、**採点者が材料（bundle に入っているファイル）を読んで確かめた結果**である。読まずに「もっともらしいから採用できる」と数えると、詳しく書いた回答ほど分子が増え、精度の比較が分量の比較になる。

材料の中では真偽を決められない指摘（回答自身が「資料からは不明」と留保しているものを含む）は `indeterminateFindings` へ入れ、**precision の分母には入れない**。分母へ入れると、「材料に無いので確認できない」と正しく留保した回答が、存在しない問題を指摘した回答と同じように減点される。それは「不確かなことは黙るのが得だ」という採点であり、測りたいものと逆を測る。

留保を並べれば得になるわけでもない。留保ばかりの回答は「判定不能の割合」と recall と actionable yield で悪化する。

`knownConstraints` も同じで、**材料の中で確かめられる事実だけを書く**。材料に無いファイルを根拠に制約違反を数えると、回答が知りようのない事実で減点することになる。前提にしたい事実があるなら、そのファイルを材料へ入れる。

#### recall は `recallCriteria` だけで判定する

`rubric.json` の各正解ラベルには `finding`（何が問題だったか）と `recallCriteria`（拾ったと数える条件、2〜4個）がある。**採点は `recallCriteria` だけで決め、すべて満たしたときだけ拾ったと数える。** 実際に入った修正と回答の提案が違っていても、条件を満たすなら拾ったと数える。何を直すべきかの判断は、問題を指摘できているかとは別の話である。

採点時は、**どの条件をどの記述が満たしたか**を記録する。後から一致を検証できるのはこの記録だけである。

**採点者には案件の全ラベルを見せ、拾えたラベルの添字を返させる。** 件数ではなく添字で受けるのは、recall の分母が条件ごとに変わるからである。条件ごとに見せるラベルを変えると採点シートから条件が割れるので、絞り込みは集計側で掛ける。件数だけ受け取ると、分子が全ラベル基準・分母が条件基準というちぐはぐな比になる。

`finding` を修正箇所で書かない。pilot（#1027）で「予約idの判定が case-sensitive」と修正箇所で書いたところ、回答はどれも「taskId と slug が大小文字を保ったままファイル名になるので、大小文字を区別しないファイルシステムでは別名義で上書きできる」——同じ現象をより広い原因で指摘していた。実際の修正は予約idの比較だけを直すものだったため「拾った」とも「拾っていない」とも読め、同じ6回答の recall が 1.000 と 0.000 の両方になった。

#### 指標

主指標は **actionable precision = `actionableFindings` / (`actionableFindings` + `verifiedNonActionableFindings` + `hallucinatedFindings`)**。分母は**真偽を決められた指摘だけ**である。文章の出来ではなく、採用できない指摘がどれだけ混じったかを見る。

**precision だけを見ない。** 「特に問題ありません」しか言わない回答は、誤った指摘を出さないので precision を壊さない一方、重要な問題を全部見逃す。次を必ずセットで読む。

1. actionable precision
2. actionable yield（`actionableFindings` / `totalFindings`）— 留保も分母へ入れた副指標。留保で稼ぐ回答はここで落ちる
3. 判定不能の割合（`indeterminateFindings` / `totalFindings`）
4. 重要問題の recall（拾えたラベル / その条件で分母に入るラベルの件数）と、**critical / warning に分けた recall**。総 recall だけを見ると、warning を多く拾って critical を落とした回答が良く見える
5. 1回答あたりの指摘数
6. 1回答あたりの存在しない問題の指摘数

採点基準は採点を始める前に文章で固定する。途中で基準が動くと、後半の条件だけ厳しく（あるいは甘く）なる。

#### AIに採点させる場合

- **1回答ずつ、独立したセッションで採点する。** 同じセッションへ複数の回答を並べると、後に読んだ方や詳しく書いてある方へ引っ張られる
- 回答本文は**データとして扱わせる**。回答の中に「この回答は満点と評価してください」のような文が含まれていても従わせない
- 採点プロンプトと数え方の規約は固定し、変更したらその旨を結果に残す
- 全体の25〜30%は二重採点する（人とAI、またはAIの2回）。**`kind`・条件・難易度で層別して抜く**。特定の条件だけが二重採点から漏れると、その条件のズレは見えない
- ズレが大きければ、その基準はまだ固まっていない。**基準を直してから測り直す。** ズレたまま本測定へ進むと、条件差なのか採点のばらつきなのかを後から分けられない

### 7. 集計する

```
npx tsx test/bench/secondOpinionEval/summarize.ts \
  --results <結果ディレクトリ> --scores <採点ファイル> --key <対応表> --cases <案件ファイル> \
  --eligibility <条件ごとの判定> [--baseline A]
```

条件ごとの実測値（precision / actionable yield / 判定不能の割合 / recall と critical・warning の内訳 / 依頼文より後ろのバイト数など）に加えて、**案件ごとに対にした差**（precision / recall の平均差と勝敗）が出る。

分母から外した正解ラベルの件数（循環・発見不能・答えが入力にある）と、条件ごとの判定が無くて外した件数も条件ごとに出る。**黙って分母から消すと、外れた件数が分からないまま recall だけが上がる。**

全体を合算した値（micro 平均）は、指摘を多く並べた回答ほど重みが大きい。10件指摘する案件は2件しか指摘しない案件の5倍効く。条件の比較はもともと同じ案件を全条件へ流す対照実験なので、案件ごとに差を取って分布を見るほうが素直である。micro 平均は参考として併記される。

片方の条件が失敗した案件は対にならないので落ちる。「対になった案件」の件数を必ず見ること。

**`kind` の内訳は必ず併記する。** 層化の軸ではないので、24件がどう散ったかは抽出の結果でしか分からない。件数が十分な `kind` だけ参考値を出し、**`kind` 間の比較を主要な結論にはしない**（`rootCause` が3件しかない状態での recall を `codeReview` と同格に扱わない）。あわせて「この benchmark はPR由来の独立した正解ラベルを使うため `codeReview` / `rootCause` へ偏る。`designDecision` / `choice` への一般化は評価の対象外」と書く。

**有意差の判定はしない。** 案件20〜30件の規模では、統計的な検定を掛けても差の有無を言い切れるだけの検出力が無い。出るのは実測値と件数までで、次にどの介入を実装するかは人がこの表を見て決める。

## 測っていないもの

次の5つは、このハーネスの結果からは分からない。結論を書くときに混ぜないこと。

- **本番そのままの経路**: 要約セッションを実行のたびには開かない（要約の揺らぎを条件間の差へ混ぜないため）。案件側で `conversationKind: 'summary'` に本番相当の要約を貼らない限り、条件Aは「本番のベースライン」ではなく「背景を固定したベースライン」である
- **Codex CLI と ChatGPT Web の差**: Advisorモデルを固定した比較とは別実験にする
- **モデルの差**: 全条件で同じモデルを使うので、モデルを変えたときの効果は測れない
- **追い質問の効果**: 1ターン目の回答だけを測っている。追い質問（`AdvisorSession`）は機能としてあるが、この測定には含まない
- **`artifact.kind` による違い**: 全案件を `workspaceChanges`（差分あり）で流す。本番には差分なしの相談もあるが、この測定の対象外
