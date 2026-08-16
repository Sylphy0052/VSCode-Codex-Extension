# スラッシュコマンドの判定表

チャット画面の入力欄に出す候補を、何を根拠に決めているかの記録。CLIの版が上がったときはここを見て確かめ直す。

- 実測日: 2026-08-10
- Codex CLI 0.147.0 / Claude Code 2.1.226

## 結論

**CodexとClaude Codeで正反対**。同じ「組込スラッシュコマンド」でも扱いが違うため、CLIごとに別の作りにしてある。

|             | 組込コマンドは効くか | 一覧の出どころ      | 候補に出すもの                                      |
| ----------- | -------------------- | ------------------- | --------------------------------------------------- |
| Codex       | **効かない**         | 取得APIなし         | 拡張機能側の擬似コマンド + `skills/list` + ファイル |
| Claude Code | **効く**             | `initialize` の応答 | CLIが返した一覧をそのまま                           |

## Codex: 組込コマンドは効かない

`turn/start` に `input: [{ type: 'text', text: '/status' }]` を送った結果:

```
item/completed  userMessage   content: [{ type: 'text', text: '/status' }]
item/completed  agentMessage  text: "待機中。実行中の作業はありません。"
```

**ただのテキストとしてモデルへ渡り、モデルが日本語で答えた**。TUIのスラッシュコマンドはTUI層の機能で、app-serverには存在しない。app-serverの95メソッドを全部見ても、コマンド一覧を返すものも、コマンドを実行するものも無い。

したがって組込コマンドは**候補から外す**。以前は7件（`/review` `/compact` `/init` `/status` `/diff` `/plan` `/skills`）を並べていたが、そのすべてが効いていなかった。

### 代わりに何を出すか

1. **拡張機能側の擬似コマンド**（[pseudoCommands.ts](../src/provider/pseudoCommands.ts)）。CLIへは送らず、拡張機能の機能を呼ぶ
2. **スキル**。`skills/list` で取得する（無効化されたものが除かれ、プロジェクト側も解決済みで返る）
3. **カスタムプロンプト・コマンドファイル**。`~/.codex` と `<workspace>/.codex` の `prompts` / `skills` / `commands` を走査する

2と3は `/name` をそのまま送れば効く（Codexが展開する。実機で確認済み）。

### 擬似コマンドの一覧

| コマンド   | 呼ぶもの                                           | 状態          |
| ---------- | -------------------------------------------------- | ------------- |
| `/compact` | `thread/compact/start`                             | 実装済（#20） |
| `/init`    | `turn/start`（固定の指示文を通常の発言として送る） | 実装済（#26） |

対応する動作が拡張機能側にあるものだけを載せる。「候補に出るのに押しても何も起きない」状態に戻さないため、機能ができてから足す。

`/init` はapp-server側に専用メソッドが無いため（下記）、他の擬似コマンドと違って新しいAPIは呼ばない。`buildInitInstructionText`（`src/provider/pseudoCommands.ts`）が組み立てた指示文を、送信欄に打った発言と同じ経路（`sendOrQueue`）で送るだけ。既存のAGENTS.mdがあれば送る前に確認を挟む（`confirmGenerateAgentsFile`、`confirmCompact` と同じ形）。

### 振り替え先が決まっているが未実装のもの

各Issueの作業で擬似コマンドへ足す。

| 組込コマンド | 振り替え先                | Issue |
| ------------ | ------------------------- | ----- |
| `/review`    | `review/start`            | #23   |
| `/plan`      | `turn/start` のパラメータ | #11   |
| `/diff`      | `turn/diff/updated` 通知  | #14   |

### 拡張機能の別のUIで代替済みのもの

コマンドとしては出さない。同じことが画面の操作でできる。

| 組込コマンド                                            | 代わりの場所                                         |
| ------------------------------------------------------- | ---------------------------------------------------- |
| `/status` `/usage`                                      | 入力欄の下（コンテキスト残量とレート制限の消費率）   |
| `/model` `/effort`                                      | 画面下の設定行                                       |
| `/skills`                                               | 入力欄の候補そのもの                                 |
| `/new` `/resume` `/fork` `/rename` `/archive` `/delete` | 履歴ツリーとコマンドパレット                         |
| `/clear`                                                | エディタ右上のクリアアイコン（会話を閉じて開き直す） |
| `/quit`                                                 | タブを閉じる                                         |

### 判定していないもの

残りの組込コマンド（`/ide` `/permissions` `/keymap` `/vim` `/features` `/memory` `/import` `/hooks` `/app` `/goal` `/btw` `/copy` `/raw` `/title` `/statusline` `/theme` `/pet` `/mcp` `/apps` `/plugins` `/feedback` `/rollout` `/ps` ほか）は、**一律で効かないことが確定しているため個別の判定は要らない**。候補に出さない以上、間違って送られることも無い。

拡張機能側で実装するかどうかは、それぞれのIssue（環境系: MCP / plugins / hooks / login など）で決める。

## Claude Code: 組込コマンドは効く

ユーザーメッセージとして `/context` を送った結果:

```
assistant  model: "<synthetic>"  stop_reason: "stop_sequence"
result     num_turns: 0  total_cost_usd: 0  duration_api_ms: 0
```

CLI側がコマンドとして処理し、APIを呼ばずに合成応答を返している。**そのまま送れば効く**ので、振り替えは要らない。

### 一覧はCLIが持っている

`control_request` の `{ subtype: 'initialize' }` に対する応答が `commands` を返す。実測で **90件**。組込・ユーザー定義・プラグイン由来が混ざり、`description` の末尾に `(user)` のような出所が付く。

```json
{
  "name": "compact",
  "description": "Free up context by summarizing the conversation so far",
  "argumentHint": "<optional custom summarization instructions>"
}
```

セッションの途中で増減したときは `system` の `commands_changed` 通知が**一覧をまるごと**押し付けてくる（CLI内の説明に `Clients should REPLACE their cached command list with this payload` とある）。受け取った側は入れ替える。

したがって**一覧をハードコードしない**。以前は7件を手で並べていたが、実測の90件と突き合わせると `review` と `cost` は**実在しなかった**（実体は `code-review` と `usage` / `usage-credits`）。存在しないコマンドを送ると、ただのユーザー発言としてモデルに渡る。#7 が言う「候補に出るのに黙って素通し」がClaude側でも起きていた。

同じ名前が重複して返ることがある（プラグインのskillで確認）ので、先に見つけたものを残す。

`init`（`AGENTS.md` / `CLAUDE.md` 生成の `/init` 相当）もこの90件に実在する（実測、`description: "Initialize a new CLAUDE.md file with codebase documentation"`）。専用の擬似コマンドは作らず候補のまま送る（issue #26）。既存ファイルがある場合の確認は組込コマンド自体の振る舞いに任せる。

### ファイル走査は代替手段として残す

`initialize` の応答が届かない、または `commands` を持たない版では、`~/.claude` と `<workspace>/.claude` の走査結果を使う。候補がまったく出ない状態よりはよい。

## CLIの版が上がったとき

- **Claude Code**: 何もしなくてよい。一覧は実行時にCLIから取る
- **Codex**: 擬似コマンドの振り替え先（`thread/compact/start` など）が生きているかを確かめる。プロトコルの全量は次で取れる

```bash
codex app-server generate-json-schema --out <DIR>   # ClientRequest / ServerNotification / ServerRequest の全量
codex app-server generate-ts --out <DIR>            # TypeScript バインディング
```

Claude側の一覧を手で見たいときは、`claude --print --input-format stream-json --output-format stream-json --verbose` を起動して stdin へ次を流す。

```json
{ "type": "control_request", "request_id": "1", "request": { "subtype": "initialize" } }
```

## 2026-08-12 の再抽出（Issue #195）

- Codex CLI 0.147.0（前回と同版）/ Claude Code **2.1.227**（前回は 2.1.226）

### Codex: 差分なし

`codex app-server generate-json-schema --out <DIR>` の出力を数え直した結果、前回と完全に一致した。

| 種別               | 件数 |
| ------------------ | ---- |
| ClientRequest      | 95   |
| ServerNotification | 70   |
| ServerRequest      | 10   |
| ClientNotification | 1    |

### Claude Code: 一覧は 90件（前回と同数だが内訳は環境依存）

`initialize` の `commands` は 90件。ただし**ユーザー定義・プラグイン由来が混ざる**ため、件数だけでは版の差分にならない。今回の内訳は次のとおり。

| 区分                                          | 件数 |
| --------------------------------------------- | ---- |
| ユーザー定義（`description` 末尾が `(user)`） | 26   |
| プラグイン由来（`名前:名前` の形）            | 8    |
| CLI組込 + 同梱skill                           | 56   |

前回（2.1.226）はこの内訳を残していなかったため、厳密な版差分は取れない。**次回から差分が取れるよう、この時点の組込一覧を下に記録する。**

<details>
<summary>CLI組込 + 同梱skill（56件、2.1.227 実測）</summary>

`__remote-workflow` `agents`（`(removed)` と明記）`artifact-capabilities` `artifact-design` `artifact-diagramming` `autocompact` `batch` `claude-api` `clear` `code-review` `color` `compact` `config` `context` `dataviz` `debug` `deep-research` `design` `design-consent` `design-revoke` `design-sync` `doctor` `effort` `extra-usage` `fast` `fewer-permission-prompts` `goal` `heapdump` `import` `init` `insights` `list-agents` `loop` `mcp` `model` `recap` `reload-skills` `rename` `run` `run-skill-generator` `schedule` `security-review` `simplify` `team-onboarding` `ultrareview` `update-config` `usage` `usage-credits` `verify` `workflow-launch-exec`

</details>

### 一覧のほかに `initialize` が返すもの（実測）

コマンド一覧だけでなく、**画面へ出せる状態**も同じ応答に入っている。今回の再抽出で確認した。

| フィールド                                 | 中身（実測）                                       |
| ------------------------------------------ | -------------------------------------------------- |
| `fast_mode_state`                          | `"off"`。Fast mode（`/fast`）の現在値              |
| `models[].supportsFastMode`                | そのモデルがFast modeを持つか（`true` / 無し）     |
| `current_permission_mode`                  | 起動時の承認方法                                   |
| `agents`                                   | カスタムエージェントの一覧（TP-58で利用済み）      |
| `models[]`                                 | モデルと`supportedEffortLevels`（TP-83で利用済み） |
| `account`                                  | ログイン状態（TP-53で利用済み）                    |
| `output_style` / `available_output_styles` | 出力スタイル（拡張機能では未使用）                 |

### この再抽出から起票したもの

同梱skill（`dataviz` `artifact-*` `code-review` `doctor` `batch` `goal` `loop` `schedule` など）は、Claude Codeでは**送ればそのまま効く**うえ候補にも出ているため、拡張機能側の追加実装は要らない。

一方、**CLI組込のUI機能**のうちチャット画面に無いものは残っている。バックログの Phase 8（TP-86〜TP-93）として起票した。
