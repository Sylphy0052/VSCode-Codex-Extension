# Forge本体と全単体テストの精査

対象は`src/orchestrator/forge.ts`全2446行と`test/unit/forge.test.ts`全2424行。関数本体、各ホスト分岐、早期終了、例外、待機・取消、全テストの準備・操作・期待値を読んだ。静的精査のみ。CLI起動、外部投稿、テスト実行はしていない。

## 確認範囲

ホスト判定/override/none、CLIのPATH/PATHEXT探索、認証前提、層設定、最終マージ選択、タイトル/本文/番号/branchの生成と検証、pushの競合リトライ、PR/MR・Issue・コメント作成、一時ファイルのfinally削除を確認した。続いてタスクフローの各失敗段、任意レビュー/ready、統合PR作成、最終マージ、CIの両ホスト形式と状態遷移、期限・取消・base更新上限、レビュー/コメント/threadの解析・取得・返信・解決を追った。

FakeGit/FakeCliのprefix一致と既定成功、FakeFSのMap相当保存、SequencedCli/SequencedGitの応答消費と枯渇後成功、待機/時計差替えも読んだ。テストは作成順序、CLI引数、本文ファイル、失敗時後片付け、push上限、Draft省略、番号不正、CI赤/未知CheckRun/欠落キー、ポーリング、取消の各境界、base更新再試行を検査する。実際のCLIによる型変換・ページ送りは再現しない。タイトルの試験名は空/改行を挙げるが入力は空だけ。Issueのlabel/assignee/milestone試験は主にGitHubで、GitLab assigneeは文字列引数一致だけ。Windows探索は.CMDを発見する試験で、Windows上での実行を証明しない。

## EX-FORGE-03[P1]:返信本文をCLIがファイル参照として解釈する

`forge.ts:2377`はGitHub返信の自由入力を`-F body=...`へ直接渡す。本文が`@/path/to/local.txt`なら、文字列ではなくそのローカルファイルを読み込んで投稿する。GitLabのPR/MRタイトル707行、Issueタイトル833行などにも同じtyped fieldがある。CLIのargv配列を使ってもこの変換は防げない。投稿権限と対象ファイルへの読取り権限がある実行環境が条件。

`-F/--field`の@先頭はファイル参照、`-f/--raw-field`は文字列という仕様を[GitHub CLI公式](https://cli.github.com/manual/gh_api)と[GitLab CLI公式](https://docs.gitlab.com/cli/api/)で確認した。自由入力は文字列として渡し、意図した本文一時ファイル参照と分ける必要がある。現在のテストはGitLab返信の本文ファイルとGitHub解決を確認するだけで、GitHub返信の@先頭、true/null/数値の型変換を扱わない。

## EX-FORGE-04[P1]:レビュー失敗でも統合マージする

設計書§16.18の手順3.5は指摘・壊れた応答・レビュー失敗で停止を要求し、`TaskPullRequestSteps`の1026行も同じ契約。しかし1108行以降はreview.okを分岐に使わず、1112行で常にmergeAndPushIntegrationを呼ぶ。runnerMergeのレビューcallbackは指摘/エラーをfalseで返し、finalizeもreviewを停止判定に使わない。レビュー機能を有効にしても指摘のある変更が統合へ入る。

テストは明示的に「reviewPullRequestが失敗してもマージを止めない」を期待するため、この回帰を検出せず固定する。作成/pushの失敗時にローカル統合を続ける仕様と、レビューゲート失敗を分ける必要がある。前回F33記録の「現行仕様」という説明は訂正した。F33-01のマージ失敗後ready化とは別の停止条件。

## EX-FORGE-05[P2]:レビュー取得が途中で切れても成功扱い

GitHubの`forge.ts:2333`付近のGraphQLはthread/各commentsをfirst:100で取り、cursor/pageInfoを要求しない。101件目以降を取得できない。GitLabのnotes/discussionsにもページ送りがない。GitHubのthread取得失敗/解析失敗では既存reviewsをそのままok:trueで返すため、欠落も表示できない。ページ送りと部分取得状態が必要。現在のテストは各1ページの少数応答のみで、GitHubの取得失敗fallbackも検査しない。ページ送り要件は上記両CLI公式資料でも確認した。

## EX-FORGE-06[P2]:CIの旧形式で未知状態が成功になる

`forge.ts:1427`以降のStatusContext形式はPENDING/ERROR/FAILURE以外をそのまま通す。`state:"UNKNOWN"`や空文字だけの応答をpassedと判定する。CheckRun形式は成功値の許可リストを持つが旧形式に同じ拒否方針がない。現在のGitHubが通常返すenum以外の応答が条件で、通常応答での発生は未確認。テストの未知値試験はCheckRunだけ。旧形式もSUCCESSだけを許可する必要がある。

## 異常系と残る確認

CI配列のnull要素はentry.stateで例外になり、レビュー配列のnullも一部のparserで型assertion後に例外になる。壊れたJSONや外側の形だけを試す現行テストでは検出できない。CLI/FS portのreject、mkdtemp後write失敗の後片付け、取消と進行中CLIの完了競合、CI対象SHAと実際のマージ対象、GitLab assignee/milestoneのAPI互換性は実サービス未確認。これらを成功確認済みとは扱わない。
