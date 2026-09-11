# F31レビュー:オーケストレーター・タスク間通信

対象commit:efd5cd67eb6a9b0a957538c9b5f981e2969875b6。[台帳](../feature-inventory.md#f31)の5項目を静的レビューした。

| 項目   | 確認内容                                                                                    |
| ------ | ------------------------------------------------------------------------------------------- |
| F31.01 | 接続に結び付く送信元を使用。タスクの宛先はオーケストレーター固定、run内の相手だけ許可       |
| F31.02 | 文字数・総数上限、配送キュー、返信待ちのpause/resume、全員待機・期限の検出を確認            |
| F31.03 | 制御ツールはオーケストレーターのみ。開始前タスクの編集と依存変更は定義全体を再検証          |
| F31.04 | ask_user、最終マージ判断、停止済みrunの操作制限を確認                                       |
| F31.05 | localhost限定HTTP、ランダムな接続トークン、再登録時の旧トークン無効化、本文サイズ制限を確認 |

## 指摘

### F31-01[P2]:不正なURLの例外をHTTPハンドラで処理しない

[HTTP入口](../../src/orchestrator/messaging.ts#L2069)は認証前にnew URLを呼び、その例外を捕捉しない。不正な絶対URLをrequest-targetとして受け取ると、JSON-RPC側のsafeDispatchに届く前に例外が外へ出る。ローカルHTTP経由での拡張ホストへの影響が懸念される。

修正案:URL解析失敗を400へ変換し、要求単位で閉じる。確認ケース:不正な絶対URL・不正JSON・巨大本文・有効な認証付き要求。HTTPパーサとVSCode側を含む実際の影響範囲は未検証。

根拠:[送信検証](../../src/orchestrator/messaging.ts#L195)、[操作権限](../../src/orchestrator/messaging.ts#L1670)、[動的変更](../../src/orchestrator/runnerOrchestrator.ts#L903)、[返信待ち](../../src/orchestrator/runnerMessaging.ts#L64)。動的なタスク定義変更はYAMLへ保存しない旨を警告する仕様。

実装修正、テスト・型チェック・lint、実VSCode・外部CLI連携の検証は未実施。
