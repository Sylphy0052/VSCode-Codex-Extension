# 引き継ぎメモ（2026-09-14, PC移行のため）

## 状態

作業は完結済み。次に着手すべき残タスクは無い。

- `main` はclean、`origin/main` と一致（fast-forward済み）
- 未pushのローカル変更、未マージのブランチ、残存worktreeなし

## 直近やったこと

1. 前セッション（Issue #1214 / PR #1215、`agent.autoHandoff.costPreset` の3段階プリセット追加）の後始末
   - `npm install` 未実行だった件を解消（jsdom不足による `progressDom.test.ts` 失敗と `npm run check` 停止が解消）
2. Issue #1216 → PR #1218（本セッションで新規対応、merge済み）
   - 要望: Codex画面とClaude Code画面でコスト方針を別々に持ちたい（使用量の上限がCLIごとに別のため）
   - 実装: `agent.autoHandoff.costPreset.codex` / `.claude` を新設。旧 `agent.autoHandoff.costPreset` は非推奨表示のまま残し、新設定が未設定（`inspect()` で全スコープ `undefined`）のときだけ旧値を初期値として引き継ぐ
   - 変更ファイル: `src/config.ts`（`readAutoHandoffCostPreset` / `setAutoHandoffCostPreset` に `agent: 'codex'|'claude'` 引数追加）、`src/view/handoffModelChoice.ts`（`pickHandoffCostPreset` 同様）、`src/view/chatView.ts`（`'codex'`固定で呼ぶ）、`src/view/claudeChatView.ts`（`'claude'`固定で呼ぶ）、`package.json`（設定定義追加）、`test/mocks/vscode.ts`（`WorkspaceConfiguration.inspect()` が未実装だったため追加）
   - 検証: `tsc --noEmit` / `eslint` / `prettier --check` 全て問題なし、`vitest run` 267 files / 5750 tests 全通過
   - 後片付け: リモート/ローカルブランチ削除、worktree撤去、`main` を `origin/main` へfast-forward、全て完了

## 新PCでの環境準備

- `npm install` が必要（`node_modules` はgit管理外）
- `gh auth status` でGitHub CLIの認証状態を確認
- `~/.claude/` 配下の個人設定（CLAUDE.md、rules、auto-memory）は別マシンなので無し。必要なら `sync-claude-home` skillやdotfiles等で移す

## このファイルについて

通常の `handoff` skillはVSCode拡張のglobalStorage（マシンローカル）へ保存するため新PCから見えない。PC移行のため、このメモはリポジトリ内 `docs/handoff/` へ直接pushしている。役目を終えたら削除してよい。
