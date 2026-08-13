# 承認方法とサンドボックスの対応表

CodexとClaude Codeでは承認の設計が違う。Codexは「承認方針(`approval_policy`)」と「サンドボックス(`sandbox_mode`)」の2軸で決まり、Claude Codeは`permissionMode`の1軸にまとまっている。本拡張は両方を設定パネルから扱うため、値の意味と対応関係をここに残す。

調査時点: 2026-08-13 / `codex-cli 0.147.0`（`codex --help`の実測とバイナリ内文字列で確認）

## Codexの承認方針(`-a` / `--ask-for-approval`)

`codex --help`が出す説明そのままの意味は次の3つ。本拡張の`codex.approvalMode`はこの3値をそのまま持つ（[src/codex/types.ts](../src/codex/types.ts)の`APPROVAL_MODES`）。

- `untrusted` — 最も厳しい。`ls` / `cat` / `sed`のような「信頼済み」コマンドだけ承認なしで動く。それ以外をモデルが提案した時点で人へエスカレーションする。
- `on-request` — モデルが承認を求めるタイミングを自分で決める。サンドボックス内で完結する操作は無承認で動き、外へ出る必要が出たときに承認要求が飛ぶ。
- `never` — 承認を一切求めない。実行の失敗はそのままモデルへ返る。人へは回らない。

宣言順がそのまま安全順（`untrusted` → `on-request` → `never`）であり、Shift+Tabの循環（[src/provider/approvalCycle.ts](../src/provider/approvalCycle.ts)）とYAMLのクランプ（design.md §16.16「設定の信頼境界」）はこの順序に依存している。

### `never`を選ぶ場面

読み取り専用を保証したい場面（Plan相当）では`never`が必須になる。`on-request`のままだと、サンドボックスに弾かれた書き込みが「サンドボックス脱出の承認要求」へ化け、そこで人が許可すると読み取り専用でなくなる（design.md §14.10「Plan mode」）。

逆に承認カードの経路そのものを確認したい場面（自動承認の判定など）では、要求が飛ばないと判定できないため`on-request`を使う。

## Codexのサンドボックス(`-s` / `--sandbox`)

- `read-only` — 読み取りのみ。
- `workspace-write` — 作業フォルダ内の書き込みを許す。ネットワークは既定で不可（`codex.sandboxNetworkAccess`で開ける）。
- `danger-full-access` — ファイルもネットワークも制限なし。

サンドボックスの選択にあたる文字列は、バイナリ内に`Read Only` / `Workspace` / `Workspace with network access` / `No Sandbox` / `Custom`として入っている（TUI上の正確な表記は実機で未確認）。

## Claude Codeの`permissionMode`との対応

Codexは2軸なので、Claudeの1軸に対しては組み合わせが対応する。

| Claudeの`permissionMode` | Codexで相当する組み合わせ | 備考 |
| --- | --- | --- |
| `plan` | `read-only` + `never` | `on-request`だと脱出承認へ化けるため`never`が必須 |
| `manual` | 任意のサンドボックス + `untrusted` | 都度承認に寄せる |
| `acceptEdits` / `auto` | `workspace-write` + `on-request` | 作業フォルダ内は無承認、外は承認要求 |
| `dontAsk` | 完全に相当する値は無い | Codexの`never`は「聞かずに実行」ではなく「聞かずに失敗」 |
| `bypassPermissions` | `danger-full-access` + `never` | 承認カードが一切出ない。両者とも起動前にモーダルで同意を取る |

`danger-full-access` + `never`（および`danger-full-access` + `approvalsReviewer: auto_review`）の検出は[src/codex/argvBuilder.ts](../src/codex/argvBuilder.ts)の`isUnsafeCombination`が担う。ただし**この関数はまだどこからも呼ばれていない**（ユニットテストのみ）。モーダルでの同意を出す配線は残っており、issue #222に残課題として書いてある。

## TUIから変える

TUIのスラッシュコマンドは`/permissions`（旧`/approvals`）。バイナリ内の案内文も`Use /permissions to control when Codex asks for confirmation.`となっている。本拡張は端末を素通しするため、TUI側での変更はそのまま効く。

## 承認まわりのCLIフラグ

`codex --help`(0.147.0)にある承認・サンドボックス関連のフラグは次の通り。

| フラグ | 内容 | 本拡張の対応 |
| --- | --- | --- |
| `-a` / `--ask-for-approval` | 承認方針(`untrusted` / `on-request` / `never`) | 対応済み(`codex.approvalMode`) |
| `-s` / `--sandbox` | サンドボックス(`read-only` / `workspace-write` / `danger-full-access`) | 対応済み(`codex.sandbox`) |
| `--approve-for-me` | 承認要求を`workspace-write`サンドボックス上の自動レビュー(Guardian)へ回す | 対応済み(`codex.approvalsReviewer`。issue #222) |
| `--dangerously-bypass-approvals-and-sandbox` | 確認を全て飛ばし、サンドボックスなしで実行する | 未対応（`danger-full-access` + `never`で近い状態は作れる） |
| `--dangerously-bypass-hook-trust` | hookの信頼確認を省いて実行する | 未対応（承認方法ではなくhook側の話） |
| `--full-auto` | 0.147.0には存在しない | 対応不要 |

### `--approve-for-me`

人が承認カードを押す代わりに、Codexが内部の自動レビュー(Guardian)へ承認要求を回す。バイナリにはGuardian用のリスク分類ポリシー（データ持ち出し・破壊的操作などの判定基準）が埋め込まれており、`core/src/guardian/`配下のモジュールがそれを扱う。Claude Codeの`auto`に最も近い挙動になる。

#### app-serverでの表現（実測、`codex app-server generate-json-schema`）

CLIフラグ相当の値は`approvalPolicy`ではなく、**独立した`approvalsReviewer`**として定義されている。

- `ApprovalsReviewer`: `enum: ["user", "auto_review", "guardian_subagent"]`。説明文は「承認要求(sandbox脱出・ネットワーク遮断・MCPの承認・ARCエスカレーション)を誰へ回すか。既定は`user`。`auto_review`は文脈を集めた上でリスク基準にもとづき承認/拒否するsubagentを使う。legacyの`guardian_subagent`は互換のため受け付ける」。
- `ThreadStartParams.approvalsReviewer` / `TurnStartParams.approvalsReviewer`: どちらも省略可。前者は「このスレッドと以降のターン」、後者は「このターンと以降のターン」を上書きする。

したがって`approvalMode`（いつ承認を求めるか）と`approvalsReviewer`（誰が答えるか）は**別の軸**であり、`APPROVAL_MODES`へ値を足す形にはしない。本拡張は`codex.approvalsReviewer`という別の設定項目として持つ（[src/codex/types.ts](../src/codex/types.ts)の`APPROVALS_REVIEWERS`）。legacyの`guardian_subagent`は受け取る側の互換値でしかないため、選択肢としては出さない。

#### 安全順序と循環

`approvalsReviewer`は`approvalMode`と直交するため、Shift+Tabの循環（`APPROVAL_MODES`の宣言順に依存）には**入れない**。安全順序の前提を壊さずに済む。

代わりに次の2点で安全側へ寄せる。

- `danger-full-access` + `auto_review`は`danger-full-access` + `never`と同じ重さの危険な組み合わせとして扱う（`isUnsafeCombination`）。承認要求は出るが人が答えないため、制限なしのサンドボックスと組むと機械の判定だけでマシン全体への操作が通る。
- 計画モード中は`approvalsReviewer`を送らない。読み取り専用の保証（`PLAN_POLICY`）は人の承認を前提にしており、判断を自動レビューへ渡すと保証の根拠が変わる。

#### 判定の見え方と覆し（実測）

自動レビューの経過は通知で届く（いずれも`[UNSTABLE]`とスキーマに明記されている）。

- `item/autoApprovalReview/started` / `item/autoApprovalReview/completed`: 同じ`reviewId`で1件の審査を知らせる。`action`は`command` / `execve` / `applyPatch` / `networkAccess` / `mcpToolCall` / `requestPermissions`の6種。`review.status`は`inProgress` / `approved` / `denied` / `timedOut` / `aborted`、`riskLevel`は`low` / `medium` / `high` / `critical`。
- `guardianWarning`: 判定そのものではない警告。

拒否された操作は`thread/approveGuardianDeniedAction`で人が覆せる。要求は`{ threadId, event }`で、`event`は「シリアライズ済みの`GuardianAssessmentEvent`」としか定義されていない（中身の形はスキーマに無い）。こちらで組み立てようが無いため、届いた完了通知をそのまま返す。

### `--dangerously-bypass-approvals-and-sandbox`

`danger-full-access` + `never`と同じ「保護を全部外した状態」だが、こちらはサンドボックス自体を張らない。外側で隔離済みの環境向け、とヘルプが明記している。取り込む場合は`bypassPermissions`と同じくモーダルでの同意が要る（design.md §7）。

## 出典

- `codex --help`（`codex-cli 0.147.0`）の実測
- 上記バージョンのバイナリ内文字列（`/permissions`の案内文、Guardian関連のモジュール名）
- [Agent approvals & security | OpenAI](https://developers.openai.com/codex/agent-approvals-security)
