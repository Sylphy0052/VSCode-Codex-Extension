# F24レビュー:セッションカンバン

対象commit:efd5cd67eb6a9b0a957538c9b5f981e2969875b6。[台帳](../feature-inventory.md#f24)の3項目を静的レビューした。独立した新規指摘はなし。

| 項目   | 確認内容                                                                                                                               |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| F24.01 | 履歴全件ではなく両managerの管理中会話を使用。cwd不明とworkspace外は除外し、配下のworktreeは含める                                      |
| F24.02 | activityを承認待ち・実行中・待機の3列へ分け、列内はタイトル順。Codexの質問待ちの分類漏れはF12-01と同じ                                 |
| F24.03 | providerとthreadIdで会話を開く。対象消失時は警告して再取得。状態変更・パネル変更を購読し、250ms間隔で送信を抑制。非表示中はdirtyを保持 |

根拠:[対象抽出](../../src/view/sessionKanbanModel.ts#L31)、[画面とイベント](../../src/view/sessionKanbanView.ts#L35)、[配線](../../src/extension.ts#L728)、[共通活動状態](../../src/view/sessionActivity.ts)、[既存の分類指摘](f12-notifications-session-activity.md)。

描画はtextContentを使用し、カード更新後はprovider/threadIdでフォーカスを復元する。workspace構成変更だけで即時更新する購読はこのビューにはなく、次の会話イベント・再表示で反映される。テスト・実VSCodeは未実行。
