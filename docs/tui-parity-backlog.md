# TUI機能パリティ バックログ

チャット画面（拡張機能が自前で描画する会話UI）を、CLI本体のTUIでできることに追いつかせるための作業一覧。

**目的**: チャット画面だけで作業が完結する状態にする。

**TUIタブ方式は廃止済み**（設計書 §2）。退避先が無くなったため、チャット画面でできないことは**この拡張機能ではできない**。ターミナルで直接CLIを起動するしかない。

**比較対象**: ターミナルで直接起動したCLIのTUI。ここに挙げるギャップは全て**チャット画面側**（Codex: app-server / Claude Code: stream-json）のもの。

**この文書の役割**: 一覧と優先度だけを持つ。背景・仕様・受入基準・実装計画は各GitHub Issueの本文に書く。Issue化したらこの表の「Issue」列にリンクを入れる。

## 調査の出典

TUI側の機能一覧は、実機のCLIバイナリから抽出した実測値に基づく（憶測ではない）。

- Codex CLI 0.147.0: `strings` でTUIのスラッシュコマンド定義（48件）とその説明文を抽出
- Claude Code 2.1.226: `strings` でコマンド定義（`name:"..."` / `description:"..."` 形式、80件超）を抽出

CLI版が上がるとこの一覧は増減する。再抽出の手順はPhase 0の調査Issue（[#1](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/1) / [#2](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/2)）にある。Codexについては `codex app-server generate-json-schema` が正となる。

## 優先度の定義

| 優先度 | 意味                                                     |
| ------ | -------------------------------------------------------- |
| P1     | これが無いと拡張機能の外へ出る必要がある。パリティの本丸 |
| P2     | 代替手段はあるが不便。TUIとの体験差が明確に出る          |
| P3     | あると嬉しい。無くても作業は止まらない                   |

## 現在の状況（2026-08-11）

**P1は残ゼロ。** 本丸にあたる11件（TP-01 / TP-10 / TP-11 / TP-21 / TP-22 / TP-30 / TP-31 / TP-40 / TP-70 / TP-80 / TP-82）が全て入っている。

- 入るようになったもの: 画像添付・スラッシュコマンドの実効性・セッション中の設定変更・Plan mode・差分表示・コンテキスト残量・手動圧縮・ツールやMCPからの問い合わせ・応答を止めない割り込み
- 残っているのは P2 / P3。体験差は出るが、作業そのものは拡張機能の中で完結する
- **実機確認は追いついていない**。ユニットテストとプロトコル上の実測で確かめた範囲までで、画面上の挙動は [manual-test.md](manual-test.md) の未実施ケースとして残っている

各表の「Issue」列に `済` と書いてあるものはマージ済み。

## Phase 0: 能力調査（実装より先）

「拡張UIで全部やる」方針を取るため、まずapp-server / control protocolに**何ができるか**を確定させる。ここの結果で後続タスクの実現可否と実装方針が決まるので、実装タスクの着手前に必ず通す。

調査は実CLIプロセスへ直接JSON-RPC / NDJSONを流して確かめた。ドキュメントに書かれていない領域なので、実測以外の根拠は採っていない。

調査Issue: Z-01〜Z-08 は [#1 Codex app-server の能力を実測で確定する](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/1)、Z-09〜Z-13 は [#2 Claude Code の control protocol / stream-json の能力を実測で確定する](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/2)。

| ID   | 調査内容                                                 | 結果                                                                                                                                 |
| ---- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Z-01 | Codex: 組込スラッシュコマンドは解釈されるか              | **されない**。`/status` がテキストとしてモデルへ渡り、モデルが答えた。専用メソッドへ振り替える                                       |
| Z-02 | Codex: ターン内で model/effort/approval/sandbox を変える | **できる**。`TurnStartParams` の各フィールドが「このターン以降」に効く。`sandboxPolicy` も含む                                       |
| Z-03 | Codex: 画像入力                                          | **できる**。`UserInput` は text / image(url) / localImage(path) / audio                                                              |
| Z-04 | Codex: 差分本文                                          | **取れる**。`turn/diff/updated` が unified diff 文字列を送ってくる                                                                   |
| Z-05 | Codex: トークン使用量                                    | **取れる**。`thread/tokenUsage/updated`（`modelContextWindow` 込み）                                                                 |
| Z-06 | Codex: compact / review / plan                           | **ある**。`thread/compact/start` `review/start` `turn/plan/updated`。`thread/rollback` は deprecated                                 |
| Z-07 | Codex: MCP / hooks / plugins / apps / skills             | **全てAPIあり**。実測で応答を確認                                                                                                    |
| Z-08 | Codex: background terminal / agent thread                | terminal は `command/exec` 系で**できる**。agent thread 切替は未確定                                                                 |
| Z-09 | Claude: スラッシュコマンドは解釈されるか                 | **される**。`/context` で `model: "<synthetic>"` の応答。APIコールもコストもゼロ                                                     |
| Z-10 | Claude: control protocol の能力                          | `set_model` `set_permission_mode` ほか多数を実測で確認                                                                               |
| Z-11 | Claude: compact / rewind                                 | `rewind_files` 実在（要チェックポイント）。compact はコマンド送信で可                                                                |
| Z-12 | Claude: 途中ターンからの分岐                             | control には無い。`/branch` コマンド経由の可能性あり（[#22](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/22) で追試） |
| Z-13 | Claude: todos / cost / context                           | **取れる**。`get_context_usage` `get_session_cost` `get_usage`                                                                       |

**Phase 0 は完了**（2026-08-10、Codex CLI 0.147.0 / Claude Code 2.1.226）。詳細な根拠は [#1](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/1) と [#2](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/2) のコメントにある。各実装Issueにも結論を反映済み。

### Phase 0 で分かった最重要の3点

1. **`codex app-server generate-json-schema --out <DIR>` でプロトコル定義が全量取れる**（ClientRequest 95メソッド / ServerNotification 70 / ServerRequest 10）。`generate-ts` でTypeScriptバインディングも出る。憶測でプロトコルを探る必要はもう無い
2. **CodexとClaudeでスラッシュコマンドの扱いが正反対**。Codexは解釈せず専用メソッドへの振り替えが要る。Claudeはそのまま送れば効く。CLIごとに別の作りにする
3. **Claudeは `initialize` が使えるコマンド90件を返す**。一覧のハードコードは不要

## Phase 0.5: 調査中に見つかった、当初のバックログに無かった項目

いずれもPhase 0の副産物。既存の不具合を含む。

| ID    | 内容                                                                             | 対象  | 優先度 | Issue                                                                                           |
| ----- | -------------------------------------------------------------------------------- | ----- | ------ | ----------------------------------------------------------------------------------------------- |
| TP-80 | app-serverからの要求10種のうち7種を処理していない（MCPツールが黙って失敗しうる） | Codex | P1     | [#41](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/41) 済（UIは #48 #49 で完了） |
| TP-81 | `serverRequest/resolved` を処理しておらず、解決済みの承認カードが残る            | Codex | P2     | [#42](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/42) 済                        |
| TP-82 | `turn/steer` で応答を中断せずに指示を割り込ませる                                | Codex | P1     | [#43](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/43) 済                        |
| TP-83 | モデルとeffortの選択肢をCLIから取得する                                          | 両方  | P2     | [#44](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/44) 済                        |
| TP-84 | app-serverの生成済み型定義を取り込むか判断する                                   | Codex | P2     | [#46](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/46)                           |
| TP-85 | 履歴の取得を `thread/list` へ移すか判断する                                      | Codex | P3     | [#45](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/45)                           |

## Phase 1: 入力欄

| ID    | 内容                                                                            | 対象         | 優先度 | 依存 | Issue |
| ----- | ------------------------------------------------------------------------------- | ------------ | ------ | ---- | ----- |
| TP-01 | 画像の貼付・添付。現状は `input: [{ type: 'text' }]` 固定でテキストしか送れない | Codex/Claude | P1     | Z-03 | #3 済 |
| TP-02 | `@` によるファイル参照の補完。現状は `/` の候補のみ                             | Codex/Claude | P2     | -    | #4 済 |
| TP-03 | `!` から始まる行をシェルコマンドとして扱う（Claude TUIのbashモード相当）        | Claude       | P3     | Z-10 | #5    |
| TP-04 | `#` から始まる行をメモリへ追記する（Claude TUIのメモリモード相当）              | Claude       | P3     | Z-10 | #6    |

## Phase 2: スラッシュコマンド

着手前は `CODEX_BUILTINS` / `CLAUDE_BUILTINS` が各7件しか登録されておらず（実測: Codex 48件 / Claude 80件超）、しかもCodexの組込コマンドはTUI層で処理されるためapp-serverへ送っても効かなかった。

**候補に出るのに効かない状態が最悪**なので、TP-11（実効性の確保または候補からの除外）をTP-10より優先した。結果として、Codexは効かないものを候補から外して画面の操作へ差し替え、Claudeは `initialize` が返す一覧をそのまま出す形に落ち着いている。判定表は [slash-commands.md](slash-commands.md)。

| ID    | 内容                                                                                     | 対象         | 優先度 | 依存      | Issue |
| ----- | ---------------------------------------------------------------------------------------- | ------------ | ------ | --------- | ----- |
| TP-11 | 組込コマンドの実行経路を確保する。効かないものは候補から外すか、拡張側の機能へ差し替える | Codex/Claude | P1     | Z-01 Z-09 | #7 済 |
| TP-10 | 組込コマンド一覧を実測値に揃える。CLI版ごとの差分に追従する仕組みも決める                | Codex/Claude | P1     | TP-11     | #8 済 |
| TP-12 | 候補に `argument-hint` を表示し、引数付きコマンドを補完する                              | Codex/Claude | P3     | TP-10     | #9    |

## Phase 3: セッション中の設定変更

| ID    | 内容                                                                                                 | 対象   | 優先度 | 依存      | Issue                                |
| ----- | ---------------------------------------------------------------------------------------------------- | ------ | ------ | --------- | ------------------------------------ |
| TP-21 | Claude のセッション中に model / effort / permissionMode を変える。現状は起動引数のみで、会話中は固定 | Claude | P1     | Z-10      | #10 済（effortの反映は観測できない） |
| TP-22 | Plan mode の切替（Codex `/plan` / Claude Shift+Tab 相当）。現状どちらも手段が無い                    | 両方   | P1     | Z-06 Z-10 | #11 済（Codexは権限で代替）          |
| TP-20 | Codex の sandbox をターン単位で変える。現状は `thread/start` 時のみで、明示的に非対応としている      | Codex  | P2     | Z-02      | #12 済                               |
| TP-23 | 承認モードを循環させるキーバインド（TUIのShift+Tab相当）を画面に用意する                             | 両方   | P3     | TP-22     | #13                                  |

Codexはターン単位で model / effort / approvalPolicy を渡せるのにClaudeは起動時固定、という非対称が現状ある。TP-21はこの差を埋めるもの。

## Phase 4: 表示

| ID    | 内容                                                                     | 対象         | 優先度 | 依存      | Issue  |
| ----- | ------------------------------------------------------------------------ | ------------ | ------ | --------- | ------ |
| TP-30 | ファイル変更の差分本文を表示する                                         | Codex/Claude | P1     | Z-04      | #14 済 |
| TP-31 | トークン使用量とコンテキスト残量を表示する。現状はレート制限の消費率のみ | Codex/Claude | P1     | Z-05 Z-13 | #15 済 |
| TP-33 | 画像の表示（モデルが見た画像・生成した画像）                             | Codex/Claude | P2     | Z-03      | #16 済 |
| TP-35 | コマンド実行の出力を逐次表示し、長い出力を折りたためるようにする         | Codex/Claude | P2     | -         | #17 済 |
| TP-32 | Web検索の結果を表示する。現状はクエリのみ                                | Codex/Claude | P3     | -         | #18    |
| TP-34 | 思考の全文表示と折りたたみ。現状は summary のみ                          | Codex/Claude | P3     | -         | #19    |

## Phase 5: 会話操作

| ID    | 内容                                                                                                         | 対象         | 優先度 | 依存      | Issue  |
| ----- | ------------------------------------------------------------------------------------------------------------ | ------------ | ------ | --------- | ------ |
| TP-40 | 手動の会話圧縮（`/compact` 相当）。コンテキストが逼迫したときの手が現状ない                                  | Codex/Claude | P1     | Z-06 Z-11 | #20 済 |
| TP-41 | 巻き戻し（Codex Esc Esc / Claude `/rewind` 相当）。Codexはターン分岐で部分的に代替できるが、Claudeは代替なし | 両方         | P2     | Z-11      | #21    |
| TP-44 | Claude で会話の途中ターンから分岐する。現状「CLIに手段が無い」としている                                     | Claude       | P2     | Z-12      | #22    |
| TP-45 | コードレビューの起動（`/review` 相当）を画面の操作として持つ                                                 | Codex/Claude | P2     | Z-06 Z-09 | #23 済 |
| TP-42 | 一時的な脇道の会話（Codex `/btw` 相当）                                                                      | Codex        | P3     | Z-06      | #24    |
| TP-43 | トランスクリプト表示と生テキストモード（Ctrl+T / `/raw` 相当）                                               | Codex/Claude | P3     | -         | #25    |
| TP-46 | `AGENTS.md` / `CLAUDE.md` の生成（`/init` 相当）                                                             | Codex/Claude | P3     | TP-11     | #26    |

## Phase 6: 環境・管理系

拡張UIで実装する方針。TUIタブが無くなったため「TUIタブへの導線に留める」という逃げは取れない。CLI側にAPIが無いものは、設定ファイルの編集やターミナルでのCLI起動を案内する形になる。Phase 0で全領域にAPIがあることは確認済み。

| ID    | 内容                                                                  | 対象         | 優先度 | 依存      | Issue                                      |
| ----- | --------------------------------------------------------------------- | ------------ | ------ | --------- | ------------------------------------------ |
| TP-50 | MCPサーバの一覧・状態・有効無効                                       | Codex/Claude | P2     | Z-07 Z-10 | #27 済                                     |
| TP-52 | hooksの一覧と信頼の管理                                               | Codex/Claude | P2     | Z-07 Z-10 | #28                                        |
| TP-53 | ログイン状態の表示とlogin / logout                                    | Codex/Claude | P2     | Z-07      | #29 済                                     |
| TP-58 | カスタムエージェントの選択と一覧（Claude `--agent` / `/agents` 相当） | Claude       | P2     | Z-10      | #30 済（起動時のみ。切替の制御要求は無い） |
| TP-59 | TODO一覧の表示（Claude `/todos` 相当）                                | Claude       | P2     | Z-13      | #31 済                                     |
| TP-51 | plugins / apps の閲覧と管理                                           | Codex/Claude | P3     | Z-07      | #32                                        |
| TP-54 | バックグラウンドターミナルの一覧と停止（Codex `/ps` 相当）            | Codex        | P3     | Z-08      | #33                                        |
| TP-55 | agent thread の切替とサブエージェントの状況表示                       | Codex        | P3     | Z-08      | #34                                        |
| TP-56 | skillsの一覧表示と管理。取得は `skillsList.ts` で一部実装済み         | Codex/Claude | P3     | Z-07      | #35                                        |
| TP-57 | 他エージェントからの設定インポート（Codex `/import` 相当）            | Codex        | P3     | Z-07      | #36                                        |
| TP-60 | 課金額とセッション分析（`/cost` `/insights` 相当）                    | Claude       | P3     | Z-13      | #37                                        |

## Phase 7: 文書の整合

| ID    | 内容                                                                                                                                                        | 優先度 | 依存  | Issue  |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----- | ------ |
| TP-70 | READMEのスラッシュコマンド記述の矛盾を直す。「2つの画面」の表では「チャット画面では使えない」、「使い方」では「`/` で候補が出る」と書いていて食い違っている | P1     | TP-11 | #38 済 |
| TP-71 | パリティ達成に合わせて「対応CLI」の表と `docs/design.md` を更新する                                                                                         | P2     | 全体  | #39 済 |
| TP-72 | 追加した機能の実機確認手順を `docs/manual-test.md` へ追記する                                                                                               | P2     | 全体  | #40    |

## Issue化するときの書き方

各Issueの本文には次を含める（`gitlab-issue` skillのテンプレートと同じ構成をGitHub Issueで使う）。

1. 背景: TUIで何ができて、チャット画面で何ができないか。実測した根拠（バイナリ抽出の文字列、実際のJSON-RPCのやり取り）を貼る
2. スコープ: Codexのみ / Claudeのみ / 両方。片方だけ先に出すかどうか
3. 仕様: 画面の見た目と操作、プロトコル上のやり取り
4. 受入基準: 実機で何をどう確認したら完了とみなすか
5. 実装計画: 触るファイルと順序
6. 検証方法: ユニットテストで担保する範囲と、`docs/manual-test.md` へ足すケース

## 進め方の原則

- Phase 0は完了済み。各Issueのコメントに結論があるので、着手前にそれを読む
- Phase 0.5の不具合（[#41](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/41) / [#42](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/42)）は機能追加より先に片付けた。同じ方針を続ける。既に壊れているものを抱えたまま積み上げない
- 1 Issue 1 ブランチ。実装はworktree隔離
- プロトコルに触るタスクは、未知のイベント・応答が来ても壊れないこと（現状の「未知は素通し」の方針）を維持する
- 承認・権限に関わるタスクは、既定を安全側（拒否・確認あり）に倒す
- CLIの更新で壊れうる箇所は、**壊れても会話そのものは続けられる**ように作る（未知の通知・要求は素通し、承認は拒否側に倒す）。TUIタブという退避先はもう無い
