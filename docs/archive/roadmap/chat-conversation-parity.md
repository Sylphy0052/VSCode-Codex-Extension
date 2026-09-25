# チャット画面の会話操作と表示の改善

書き手: 完了済み。記録として残す（追記しない） この文書が WF-F の書き場である
（[review-and-feature-consolidation.md](review-and-feature-consolidation.md) の
「docs/roadmap/ の5本の関係」を参照）。運用規約は [ops-rules.md](ops-rules.md)、
番号の割り当ては [numbering.md](numbering.md) にある。

CodexとClaude Codeの会話操作の差を埋め、応答を読みやすくする3項目のロードマップ。
進捗の追跡は epic Issue [#340](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/340) に集める。

> **このロードマップは X1〜X3 すべて完了済み。** 統合ブランチ `wf/wf-f/integration` から
> PR [#510](https://github.com/Sylphy0052/VSCode-Codex-Extension/pull/510) で main へ入り、
> epic Issue #340 もクローズしてある。統合ブランチは削除済み。
> 以降は着手時の記録として残してあるだけで、新しく着手する項目は無い。
> 現在動いているロードマップは [review-and-feature-consolidation.md](review-and-feature-consolidation.md) を見ること。

## きっかけ

Claude Code CLI 2.1.235 で、これまで「CLIに手段が無い」として見送っていた2つの操作が使える
ようになっていることを実測で確認した（2026-08-22）。

- `rewind_conversation`: 会話だけを戻す（ファイルには触れない）。
  [#22](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/22) で不可と結論した
  「会話の途中のターンから分岐」が組める
- `side_question`: Codexの `/btw` に相当する脇道の質問。
  [#24](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/24) でスコープ外とした機能が組める

あわせて、[#290](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/290) で入れた
Markdown描画が最小限（表・引用・ネストしたリストが未対応）で、エージェントの出力が読みにくい
点も直す。

方針は次の3つ。

1. **CodexとClaude Codeで同じ操作は同じ見た目にする。** 片方だけにある機能は、CLIの制約で
   本当に無理なときに限る
2. **実測できないことを実測したふうに書かない。** CLIのプロトコルに依存する項目は、実装の
   最初に実測して前提を確定させ、結果を design.md へ残す
3. **エージェントの出力を信用しない描画を崩さない。** Markdownの対応を広げても、HTML文字列は
   組み立てずテキストノードで挿入する既存の方針は変えない

各項目の `依存` はロードマップのパーサ（[roadmap.ts](../../src/orchestrator/roadmap.ts)）が読む
形式に合わせてある。

## フェーズ1 表示（読みやすさ）

- [x] X1 応答のMarkdown描画へ表・引用・ネストしたリストを足す（完了、PR [#489](https://github.com/Sylphy0052/VSCode-Codex-Extension/pull/489)）
  - 依存: なし
  - Issue: #332
  - 現状: [markdown.ts](../../src/view/markdown.ts) が扱うのは見出し・箇条書き・番号付きリスト・
    強調・インラインコード・コードフェンス・リンクのみ。表・引用・ネストしたリスト・水平線・
    打消し線・タスクリストは素のテキストとして流れる。エージェントは比較や一覧を表で出すことが
    多く、影響が大きい
  - 変更: (a) `BlockToken` へ `table` / `quote` / `hr` を足し `list` へネストの深さと `checked` を
    持たせる、(b) `InlineToken` へ `strike` を足す、(c) TS実装と webview 埋め込み用の
    `MARKDOWN_PARSE_SOURCE` の両方を更新する、(d) 描画側（[chatScript.ts](../../src/view/chatScript.ts)）
    とスタイル（[chatStyles.ts](../../src/view/chatStyles.ts)）を足す。表は横スクロールさせる
  - 受入基準: GFMの表が表として描画される／ネストしたリストが階層を保つ／引用・水平線・打消し線・
    タスクリストが描画される／ストリーミング中の未閉じの記法で描画が壊れない／TS実装とwebview実装が
    同じトークン列を返す
  - 注意: `chatScript.ts` のコメントにバッククォートと `${` を書かない（テンプレートリテラルが
    切れて `tsc` が壊れる。過去に2回発生）
  - 影響: [markdown.ts](../../src/view/markdown.ts) / [chatScript.ts](../../src/view/chatScript.ts) /
    [chatStyles.ts](../../src/view/chatStyles.ts)

## フェーズ2 会話操作（CodexとClaude Codeの差を埋める）

- [x] X2 Claude Codeでも会話の途中のターンから分岐できるようにする（完了、PR [#494](https://github.com/Sylphy0052/VSCode-Codex-Extension/pull/494)）
  - 依存: X1
  - Issue: #333
  - 現状: Codexは各発言の「ここから分岐」で、その指示の手前までを引き継いだ新しいタブを開ける
    （[chatScript.ts](../../src/view/chatScript.ts) / [conversationView.ts](../../src/view/conversationView.ts)）。
    Claude Codeはセッション全体のfork（`--fork-session`）だけで、途中のターンからは分岐できない
  - 変更: `rewind_conversation` control request を使い、Codexと同じ「新しいタブへ分岐、元の会話は
    残る」に揃える。`--fork-session` で複製したタブを開き、複製側へ `rewind_conversation` を送って
    指定ターンの手前まで戻し、`prefillText` を入力欄へ入れる
  - 実装前に確認すること: `--fork-session` の直後、最初のターンを送る前に control request を
    送れるか／fork後のtranscriptで `target_message_uuid` が元セッションと同じ値のままか
  - 受入基準: Claude Code画面の各ユーザー発言に「ここから分岐」が出る／押すと新しいタブが開き
    その発言の手前までの会話が復元される／元のタブの会話が変わらない／ファイルが巻き戻らない／
    `prefillText` が入力欄へ入る／Codex画面の同じ操作と見た目・文言が揃っている
  - 影響: [control.ts](../../src/claude/control.ts) / [streamSession.ts](../../src/claude/streamSession.ts) /
    [claudeChatView.ts](../../src/view/claudeChatView.ts) / [chatScript.ts](../../src/view/chatScript.ts)

- [x] X3 Claude Codeでも脇道の質問を使えるようにする（完了、PR [#501](https://github.com/Sylphy0052/VSCode-Codex-Extension/pull/501)）
  - 依存: X2
  - Issue: #334
  - 現状: Codexのみ対応（[sideQuestion.ts](../../src/codex/sideQuestion.ts)）。Claude Codeは
    非対話環境で組込コマンドが効かないためスコープ外としていた
  - 変更: `side_question` control request（`{ question }` → `{ response, synthetic }`）を使って
    Claude Code画面にも導線を足す。応答の見せ方はCodex側と揃える
  - 実装前に確認すること: `side_question` の応答が transcript に残るか／走行中のターンがあるときに
    送れるか
  - 受入基準: 入力欄で `/btw <質問>` が候補に出る／送ると応答が返る／本流の会話に痕跡が残らない
    （残る場合はその旨が画面から分かる）／Codex側の挙動が変わらない
  - 影響: [control.ts](../../src/claude/control.ts) / [streamSession.ts](../../src/claude/streamSession.ts) /
    [claudeChatView.ts](../../src/view/claudeChatView.ts) / [pseudoCommands.ts](../../src/provider/pseudoCommands.ts) /
    [docs/slash-commands.md](../slash-commands.md)

## 進め方

- 1項目1 Issue・1ブランチ・1 PRとする
- 3項目とも `chatScript.ts` かClaude Codeのcontrol protocol層を触るため、**逐次で進める**
  （X1 → X2 → X3）。並列にすると必ず衝突する
- CLIのプロトコルに依存する X2 / X3 は、実装の最初に実測して前提を確定させ、結果を design.md へ
  記録する。実測できていないことを実測したふうに書かない
- 実VSCodeでしか確かめられない受入基準は [docs/manual-test.md](../manual-test.md) へ追記する
- 各項目の完了時にREADMEの使い方・対応表・既知の制約を同じPRで更新する

## 番号の事前割り当て

着手前に次のとおり割り当ててある。担当する項目は、ここに書かれた番号だけを使う。

| 項目 | Issue | ブランチ | design.md | manual-test.md |
| --- | --- | --- | --- | --- |
| X1 | #332 | `feat/332/markdown-table-quote-nested-list` | §14.60 | U-26〜U-28 |
| X2 | #333 | `feat/333/claude-fork-from-turn` | §14.61 | U-29〜U-31 |
| X3 | #334 | `feat/334/claude-side-question` | §14.62 | U-32, U-33 |

## ワークフローとしての実施記録（WF-F）

この文書は項目の仕様を持つ。ここから下は、[review-and-feature-consolidation.md](review-and-feature-consolidation.md) 側で
WF-F として運営したときの依存・前提・決定・申し送りである（Issue #613 で統合した）。

- 依存: X1 → X2 → X3（逐次。3項目とも `chatScript.ts` かcontrol protocol層を触る）
- 前提: WF-Cの完了（`chatScript.ts` / `claudeChatView.ts` / `streamSession.ts` を共有する）。
  完了済み（2026-08-22、PR #431）
- **完了**（2026-08-22、PR [#510](https://github.com/Sylphy0052/VSCode-Codex-Extension/pull/510)）。
  着手時の想定と違った点が4つあり、いずれも実測して [design.md](../design.md) §14.61 / §14.62 へ残した
  - `rewind_conversation` は1回では戻れない。対象ターンとそれ以降のユーザー発言を新しい順に逐次送る（N往復）
  - `rewind_conversation` は失敗時も封筒が `subtype:"success"` で返る。本体の `rewound:false` でしか失敗が分からない
  - `side_question` も同型で、`synthetic:true` が失敗を意味する。`response` はCLI生成の英語プレースホルダで
    モデルの回答ではない。**当初の `response.ok` 判定はエラーを正常な回答として画面に出していた**
  - 脇道の質問は本流の会話の文脈を暗黙に共有する。また拡張のtranscriptエクスポートには `/btw` が残るため、
    「痕跡が残らない」は不正確。design.md §14.62 / README.md / docs/slash-commands.md の3か所へ明記した
  - `--fork-session` でないセッションへ `rewind_conversation` を送るとユーザーのtranscriptが壊れるため、
    最下層（`streamSession.ts`）に `isForkSession` ガードを入れている
