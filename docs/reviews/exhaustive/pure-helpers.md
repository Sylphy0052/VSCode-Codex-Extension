# 純粋関数・表示状態の追加精査

以下の実装と対応するunit testを全文精査。テスト未実行。

## EX-VIEW-02[P2]夏時間をまたぐ日付分類で前日が「今日」になる

`src/util/dateBucket.ts`はローカル0時同士の差を固定24時間で割り、floorする。夏時間で前日の長さが23時間だった翌日の昼に、その前日0時の履歴を分類するとdiffDays=0になり「今日」へ入る。12時間より古いためrecentにも入らない。暦日の差というコメントの契約と異なる。年/月/日から日番号を求めるなど、時差の変化を含まない比較が必要。テストは8月の固定日だけで、夏時間切替を検査しない。実行での再現は未実施。

| 実装と対応テスト                              | 全関数・分岐・テスト内容と不足                                                                                                                                                                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| util/ndjson、ndjson                           | consumeの改行探索・空行・JSON parse・非object/null/array拒否・残りのUTF-8上限を確認。テストは途中行、結合、診断、配列/文字列/数値、空行、通常/超過/ちょうど上限。null・CRLF・多バイト境界はない。上限は未完のrestのみで、改行付きの巨大完成行は対象外という契約 |
| util/dateBucket、dateBucket                   | startOfDay、parse失敗、12時間範囲、未来、0/1/2〜7/8日以上を確認。iso helperと8テストの期待値を確認。上記指摘                                                                                                                                                    |
| codex/sideQuestion、sideQuestion              | threadIdとephemeral=trueのみ返す1関数を完全一致で検査。CLIの永続化/再開不可などの説明は過去実測で、今回の試験が確認する内容ではない                                                                                                                             |
| view/chatCsp、chatCsp                         | options省略・includeImgData既定とfalse、3固定directiveとjoin。2テストは生成文字列を完全一致で確認。CSPのブラウザー上の強制は検査しない。入力nonce/cspSourceは呼出側の信頼境界                                                                                   |
| view/approvalPending、approvalPending         | badgeとstatusBarTextのcount<=0/正数、件数と固定アイコン。7テストは0/負/正とアイコン。件数は配列length由来の非負整数を前提                                                                                                                                       |
| view/turnSummary、turnSummary                 | 無効・指示空・本文空の各return、有効時の末尾空白除去と空行挿入。6テストは原文維持と各経路、指示trimを確認。package側既定値との一致はこの試験にない。本文が閉じていないコードフェンスの場合、空行だけでは指示をフェンス外へ出せない                              |
| claude/costText、claudeCostText               | rec/num/strOrUndefined、sessionと金額必須、行数0補完を確認。7テストは正常・0・subscription省略・行数省略・金額不正・session不正・未知field。テスト名「行数が数値でなければ」に対し入力は省略だけ。NaN/Infinity、配列、空subscription、負値は未検査              |
| claude/autocompactText、claudeAutocompactText | 問い合わせ/変更の正規表現、auto/数値/k、小数とfinite判定を確認。7テストは通常書式と失敗文・無関係文。小数、大文字K、桁超過、autoの後に別語が続く場合は未検査。CLIの固定書式を前提とする                                                                         |
| claude/usageText、claudeUsageText             | formatのusage欠落、率優先/label/到達、reset有無、空表示。parseはsession優先・weekly・失敗、usageOf固定値。10テストは各正常と不明・変更書式を確認。小数/異常率や数値範囲は検査しない                                                                             |
| loop/turnFocus、turnFocus                     | normalize列挙/unknown、describeのnone/undefined/固定文、選択肢filter/map。5テストは列挙全件、不正型7種、文の存在、選択肢件数と値。固定文そのものの意味や改変はtruthyだけでは検出できない                                                                        |
| loop/stallDetector、stallDetector             | trim抽出、履歴追加と上限slice、最小threshold/件数不足、空/undefined、全一致を確認。4+2+5テストは過去itemsへ戻らないことと主要分岐。threshold<2、trim、履歴不変、NaN/小数は未検査。設定側で整数に制約する前提                                                    |
| orchestrator/taskSummary、taskSummary         | turnResultText優先/fallback、作業prompt要約、最初の非空行・制御文字除去・120文字省略。7テストは応答経路、長さ、先頭空行、制御文字。buildTaskWorkSummaryはこのファイルでは未検査。sanitize前に行選択するため制御文字だけの先頭行では後続の本文を選ばない         |
| util/editorSelection、editorSelection         | 次行先頭を含む/含まない範囲、1始まり変換、見出しと本文連結、UTF-8上限。11テストは同一行・複数行・末尾空行の各形、payload、上限前後/一致/多バイトを確認。VSCode APIからの取得は別経路                                                                            |
| view/approvalStatusBar、approvalStatusBar     | constructor初期非表示、updateの0/正、tooltip各sessionのescape、show/hide、dispose。8テストは件数遷移・command設定・色・位置・tooltip・強調escape。コマンド試験はクリックせずIDを見るだけ。dispose、改行/リンク等の別Markdown構文は未検査                        |
| view/sessionActivity、sessionActivity         | 承認優先、busy二択、switch3状態、空白圧縮/trimと長さ制限。11テストは状態4組、装飾3種、通知整形。制御文字全般やUnicode字形数の保証はない。通知文はMarkdownではない                                                                                               |
