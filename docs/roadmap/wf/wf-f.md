# WF-F チャット画面の会話操作と表示

第2波 機能の追加。

全体の骨格は
[review-and-feature-consolidation.md](../review-and-feature-consolidation.md)
を見ること。運用規約は [ops-rules.md](../ops-rules.md)、番号の割り当ては
[numbering.md](../numbering.md) にある。

書き手: 完了済み。記録として残す（追記しない）

- **WF-F チャット画面の会話操作と表示**（3項目、詳細は [chat-conversation-parity.md](../chat-conversation-parity.md)）
  - X1 応答のMarkdown描画へ表・引用・ネストしたリストを足す（[#332](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/332)）
  - X2 Claude Codeでも会話の途中のターンから分岐できるようにする（[#333](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/333)）
  - X3 Claude Codeでも脇道の質問を使えるようにする（[#334](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/334)）
  - 依存: X1 → X2 → X3（逐次。3項目とも `chatScript.ts` かcontrol protocol層を触る）
  - 前提: WF-Cの完了（`chatScript.ts` / `claudeChatView.ts` / `streamSession.ts` を共有する）。
    完了済み（2026-08-22、PR #431）
  - **完了**（2026-08-22、PR [#510](https://github.com/Sylphy0052/VSCode-Codex-Extension/pull/510)）。
    着手時の想定と違った点が4つあり、いずれも実測して [design.md](../../design.md) §14.61 / §14.62 へ残した
    - `rewind_conversation` は1回では戻れない。対象ターンとそれ以降のユーザー発言を新しい順に逐次送る（N往復）
    - `rewind_conversation` は失敗時も封筒が `subtype:"success"` で返る。本体の `rewound:false` でしか失敗が分からない
    - `side_question` も同型で、`synthetic:true` が失敗を意味する。`response` はCLI生成の英語プレースホルダで
      モデルの回答ではない。**当初の `response.ok` 判定はエラーを正常な回答として画面に出していた**
    - 脇道の質問は本流の会話の文脈を暗黙に共有する。また拡張のtranscriptエクスポートには `/btw` が残るため、
      「痕跡が残らない」は不正確。design.md §14.62 / README.md / docs/slash-commands.md の3か所へ明記した
    - `--fork-session` でないセッションへ `rewind_conversation` を送るとユーザーのtranscriptが壊れるため、
      最下層（`streamSession.ts`）に `isForkSession` ガードを入れている
