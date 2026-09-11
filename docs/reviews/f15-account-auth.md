# F15レビュー:アカウント・ログイン状態

対象commit:efd5cd67eb6a9b0a957538c9b5f981e2969875b6。[台帳](../feature-inventory.md#f15)の3項目を静的レビューした。独立した新規指摘はなし。

| 項目   | 確認内容                                                                                                                               |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| F15.01 | Codexはaccount/read、Claudeはauth status --json。取得失敗と未ログインを別のsnapshotで表示。設定パネルの遅延取得と操作後refreshまで追跡 |
| F15.02 | CodexのAPIキー入力はpassword指定。CLIへstdinで渡し、引数・設定snapshotへ載せない。logoutは確認後に実行し、失敗は画面へ通知             |
| F15.03 | Claudeのlogoutも確認付き。ログインターミナルは固定コマンドをsendTextの改行なしで入力し、実行は利用者に委ねる                           |

根拠:[accountStatus](../../src/codex/accountStatus.ts)、[authStatus](../../src/claude/authStatus.ts)、[authProbe](../../src/claude/authProbe.ts)、[Codex操作](../../src/codex/accountActions.ts)、[Claude操作](../../src/claude/authActions.ts)、[共通CLI実行](../../src/process/commandRunner.ts)、[入力](../../src/view/controlPanelView.ts#L443)、[結果処理](../../src/view/controlPanelView.ts#L551)、[設定側](../../src/view/settingsProvider.ts#L876)。

CLI実行には30秒、Claudeの状態取得には15秒の期限がある。キー本体を直接記録するコードはないが、CLIのstderrは失敗ログへ出るため、CLI自身が返す文面まで秘密情報非包含とは保証できない。Codexの未知account型、Claudeの未認証時の実際の終了コードとJSON形は実環境での互換性確認が必要。設定全体の再取得・競合は[F04](f04-model-settings-presets.md)も参照。

テスト・型チェック・lint・実CLI・実際のlogin/logoutは実行していない。
