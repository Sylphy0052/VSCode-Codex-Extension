# 実機確認記録 2026-08-10

手順: [manual-test.md](manual-test.md)

- 拡張機能: b65e3cb（+ docs追加分、未コミット）
- Codex CLI: 0.147.0 / Claude Code: 2.1.226
- 環境: WSL Remote（extensionKind: workspace）
- 事前: `npm run check` 全緑（264件）、`npm run build` 済み

| ケース                      | 結果         | 備考                                                                                                                                                                                                                |
| --------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-01 画面が開いて発言が返る | OK           | Codex画面（Webview）で確認。応答が逐次表示される                                                                                                                                                                    |
| C-02 使用量と状態表示       | OK（修正後） | 画面フッターに使用量が出なかった。`account/rateLimits/updated` は threadId を持たず、routeNotification が宛先無しとして捨てていた。アカウント単位の通知を全画面へ配るよう修正。あわせてトークン数表示を仕様から削除 |
| C-03 承認カード（許可）     | 未           | TUIの承認プロンプトを見ていたため、Codex画面では未確認                                                                                                                                                              |
| C-04 承認カード（拒否）     | 未           | 同上                                                                                                                                                                                                                |

## 実装した対応

実機確認の途中で見つかった不具合と、その場で決めた仕様変更。

- **使用量が画面に出ない**（C-02）。`account/rateLimits/updated` は threadId を持たず、`routeNotification` が宛先無しとして捨てていた。アカウント単位の通知を全画面へ配るよう修正。トークン数の表示は仕様から削除
- **Claude Codeの使用量**。`rate_limit_event` に消費率が無いことを実機で確認し、制限の種類とリセット時刻で表示する形にした。transcriptには残らないためステータスバーには出せない（設計書§14.8）
- **新規セッションの導線がTUI優先だった**。`+` をチャット画面に割り当て、TUIは `...` メニューへ。Claude側の `$(sparkle)` 重複も解消
- **名称がCodex限定だった**。サイドバー `Codex` → `Agents`、拡張機能名 `Codex Sessions` → `Agent Sessions`、コマンドのカテゴリ `Codex:` → `Agent:`、出力チャネルも `Agent Sessions` に。コマンドIDと設定キーは互換のため据え置き
- **設定パネルがCodex限定だった**。Codex / Claude Code のタブを追加。Claude側の選択肢はエイリアス固定（一覧APIが無いため）、既定値は `~/.claude/settings.json` から読む
- **Claudeの既定モデル/effortが未指定だった**。`claude.model` = `opus`、`claude.effort` = `medium` を拡張機能の既定値にした
- **Claude画面に空の設定行が出ていた**。`#settings { display: flex }` がHTMLの `hidden` 属性に勝っていたのが原因。隠すのではなくClaude用に機能させた（設計書§14.7）

## 環境・設定で詰まった点

- `codex.approvalMode` が `never` のままだったため、C-03で承認カードが出ず書き込みが失敗した。手順書の設定を入れ直して再実行する
- `bubblewrap` が未導入だとサンドボックス実行が失敗し、承認要求が「サンドボックス無しで再試行するか」に変わる。導入して解消
- `codex.sandbox` は `read-only` にしないと作業フォルダ内の書き込みが承認なしで通る。手順書を修正
- タブ復元でClaude Code側のTUIタブが `exit=1` で終了した（`起動 provider=claude args=["-r","da343e79-..."]`）。H-04で追う
- 画面の取り違えが起きた。TUIタブとCodex画面は見た目で区別できるが、手順書に見分け方が無かった（追記済み）
