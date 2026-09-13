# F21レビュー:セカンドオピニオンの資料準備

対象commit:efd5cd67eb6a9b0a957538c9b5f981e2969875b6。[台帳](../feature-inventory.md#f21)の5項目を静的レビューした。P1が1件、P2が1件。

| 項目   | 確認内容                                                                                                                                                         |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F21.01 | HEAD/base固定、作業差分、未追跡ファイル、空変更・非git・取得失敗を確認。未追跡はrealpath・通常ファイル・バイナリ・容量を判定                                     |
| F21.02 | bundleに全差分と変更前ファイルを保存。after-treeは別indexからbaseを展開しbinary diffを適用。失敗時は差分とbaseだけへフォールバック                               |
| F21.03 | 送信差分は20万バイトを基準に未追跡分を引き、生成物・hunk単位で配分し欠落を記録。マスク関数は存在するが、この機能からは呼ばれていない                             |
| F21.04 | 親の終了を待って、独立したCodexへ会話の先頭/末尾抜粋を送る。要約失敗は背景なしで続ける。要約と差分の採取時刻は別                                                 |
| F21.05 | 通常終了・失敗時にbundleを削除。相談へ移譲した場合は相談終了まで保持。要約rolloutはIDを照合して削除し、候補不一致時は消さない。古いbundleは名前とmtimeで対象選別 |

### F21-01[P1]:資料と会話を相談先へ送る経路に資格情報マスクがない

[本体](../../src/secondOpinion/run.ts#L178)と[要約](../../src/secondOpinion/summary.ts#L233)はpromptをそのまま単発セッションへ渡す。[bundle保存](../../src/secondOpinion/reviewBundle.ts#L285)も原文を保存し、read-onlyの相談先から読める。redactCredentialsの利用先を検索すると下書き役とループAdvisorだけで、相談資料・要約には適用されていない。差分・会話・変更前ファイルに資格情報がある場合、そのままモデルへ送る経路になる。

送信本文と相談先が読める資料を一緒に設計し、マスク後の資料だけを公開する必要がある。after-treeの再現性とマスクが両立しない場合は、除外と欠落通知を選べるようにする。マスク関数単体のテストだけでは送信経路を保証できない。今回は外部送信していない。

### F21-02[P2]:差分・ファイル一覧・after-tree用差分を別時点で採取する

[captureWorkspaceSnapshot](../../src/secondOpinion/snapshot.ts#L179)は通常diff、name-only、binary diff、未追跡の読込を順番に実行する。親の実行終了を待つのは[採取後](../../src/view/secondOpinionCommand.ts#L493)。親が採取中に書き換えると、同じ資料内の差分とafter-treeが異なる内容になり、押下時点の一貫した写しではなくなる。

静止後に採取するか、採取用の固定状態から全形式を生成する。採取中に追跡ファイルと未追跡ファイルが変わるケースで、時点の不一致を検出・再取得する必要がある。

根拠:[snapshot](../../src/secondOpinion/snapshot.ts)、[容量配分](../../src/secondOpinion/diffBudget.ts#L199)、[未追跡](../../src/secondOpinion/untracked.ts)、[after-tree](../../src/secondOpinion/afterTree.ts#L153)、[rollout削除](../../src/secondOpinion/summaryRollout.ts#L67)。テスト・実際の資料作成・削除・実CLIは未実行。
