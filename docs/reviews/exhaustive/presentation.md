# 表示用の純粋関数の精査

対象:`src/view/{panelState,activePanelSequence,reducedMotion,density,relativeTime,sessionTitle}.ts`、`src/util/sessionFilter.ts`、`test/unit/{panelState,density,relativeTime,sessionTitle,sessionFilter}.test.ts`。全文を静的に精査した。テストは未実行。

| 関数・定義                                     | 全経路の確認                                                                             | テスト内容・不足                                                                                                                              |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `readPersistedThreadId`                        | 非object/null、threadId非文字列/空、正常。空白だけは受け入れる                           | 正常、undefined/null/文字列/空object/空id/数値idを確認。空白や継承propertyは未検査                                                            |
| `nextActivePanelSequence/ActiveComposerTarget` | プロセス全体で単調加算し、insertの境界を定義。実用上到達困難な安全整数超過は指摘にしない | 直接テストなし。Managerテストは[chat-view-manager-tests.md](chat-view-manager-tests.md)と[claude-view-main.md](claude-view-main.md)で精査済み |
| `reducedMotionStyles`                          | 全称セレクターと疑似要素に対しduration/iteration/scrollを上書き。分岐なし                | CSS文字列だけでは実描画を保証しない。webviewStyles全体は[chat-shared-styles.md](chat-shared-styles.md)で精査済み                              |
| `normalizeChatDensity/densityBodyClass`と定数  | compact/comfortable/未知値、既定クラス付与                                               | 2値、未知型9種類、既定comfortable、各クラス名、一意性を確認                                                                                   |
| `formatRelativeTime`                           | 無効日付、未来、1分/1時間/1日/2日/7日の各区間、ローカル日付                              | 区間代表値、1時間、1日、2日直前、未来、無効を確認。1分丁度、2日丁度、7日丁度は未検査。nowのNaNは呼出契約外                                    |
| `formatAbsoluteTime`とpad callback             | 無効値はそのまま、正常値はローカル年月日時分                                             | 無効値と書式の正規表現を確認。日時分の正確な値は検査しない                                                                                    |
| `buildSessionPanelTitle`                       | 衝突解決→orchestrator→非空taskId→ラベルのみの順                                          | Codex/Claudeの2ラベルで8ケース。全優先関係、role=task、空taskIdを確認。空mergeResolutionTaskIdは未検査                                        |
| `matchesSessionQuery`                          | query空白除去・小文字化、空語、名前/cwd省略、名前一致/cwd一致/両方不一致                 | 上記を6ケースで確認。非空queryの前後空白は名前強調側の試験のみ                                                                                |
| `sessionNameHighlights`                        | 空語、長さが変わる小文字化の棄却、無一致、複数一致、非重複の走査終了                     | 7ケースで先頭/途中、大文字小文字、複数、重複候補、空語、trim、無一致、İの長さ変化を確認                                                       |

各テストのfor/describe callback、session factoryの既定値、時刻変換helperも読んだ。パラメーター化により、ソース上のit呼出し数と実行ケース数は一致しない。

## 送信キーの追加精査

`src/view/sendKey.ts`と`test/unit/sendKey.test.ts`も全文精査した。`normalizeSendOn`はenterだけを通し、その他をctrlEnterへ丸める。`decideSendKeyAction`はEnter以外→IME中→Ctrl/Cmd→enterモードかつShiftなし→無視の順で、Ctrl/Cmd+Shift+Enterは送信になる。`SEND_KEY_SOURCE`内のJavaScriptも同じ順序である。

テストのkey factory、TS側の2モードの各6件、正規化2件、new FunctionによるJS実装の7入力を確認した。TS側では両モードのCtrl/Cmd、IMEとShift、非Enterを扱う。JS側の比較にはmetaKey=true、非Enter、Ctrl+Shift、IME+Ctrlの入力がなく、二重実装の全分岐の一致までは検査しない。全件同じ値を返す誤実装はTS側のsend/ignore期待値で検知できる。new Functionの評価を含め、今回は実行していない。

## 指摘

### EX-VIEW-01[P2]:相対日付テストの期待値が負のUTCオフセットを除外する

[relativeTime.test.ts](../../../test/unit/relativeTime.test.ts#L40)は`2026-06-01T00:00:00Z`をローカル日付にし、`2026/06/01`または`2026/06/02`だけを許す。UTCより西側では正しい表示が`2026/05/31`となり、このassertionに失敗する。実装のgetMonth/getDateはローカル時刻であり、vitest.config.tsとnpmのtest scriptはTZを固定していない。テスト内でローカル日時からISO入力を作るか、期待値のタイムゾーンを固定する必要がある。静的判定であり、TZを変えた実行はしていない。
