# F04レビュー:モデル・設定パネル・プリセット

レビュー日:2026-09-09。対象commit:`efd5cd67eb6a9b0a957538c9b5f981e2969875b6`。

静的レビューで4件の指摘を記録した。すべてP2（通常の修正対象）、未修正・実行による再現未確認。テスト・型チェック・lintは実行していない。

[機能別レビュー台帳へ戻る](../feature-inventory.md#f04)。

## レビュー範囲

| 小項目 | 確認内容                                                                           | 結果                                  |
| ------ | ---------------------------------------------------------------------------------- | ------------------------------------- |
| F04.01 | 新規会話コマンドへの接続、セクションの遅延取得・同時要求・再試行                   | 静的レビュー済み                      |
| F04.02 | モデルと推論深度の候補、一覧外の値、プロファイル、Claudeエージェント、設定スコープ | 静的レビュー済み。F04-01/F04-03を参照 |
| F04.03 | 5分ごとのモデル更新、同時取得の集約、CLI・ファイルキャッシュ・前回値への退避       | 静的レビュー済み                      |
| F04.04 | 会話単位の保存、次の送信への反映、既定への復帰、Claudeの制御要求                   | 静的レビュー済み。F04-02を参照        |
| F04.05 | プリセットの検証、cwd、モデル・effort・承認設定の合成、新規会話への適用            | 静的レビュー済み。F04-04を参照        |

台帳のF04.05にあった「初期指示」は訂正した。`SessionPreset`とmanifestに初期指示のフィールドはなく、適用先も`openNew()`までで本文の送信はない。未実装の機能を既存機能として数えない。

## 指摘一覧

| ID     | 重要度 | 問題                                                                   | 主な箇所                                          |
| ------ | ------ | ---------------------------------------------------------------------- | ------------------------------------------------- |
| F04-01 | P2     | Codexプロファイルの設定が会話用CLIへ渡らない                           | connection.ts:112、chatSession.ts:153             |
| F04-02 | P2     | Codexのモデル・effortを既定へ戻しても以前の上書きが残る                | chatView.ts:1497、chatSession.ts:320              |
| F04-03 | P2     | ワークスペースに設定値があると設定パネルでの変更が実効値に反映されない | settingsProvider.ts:975、settingsProvider.ts:1023 |
| F04-04 | P2     | プリセットのcwdに通常ファイルを受け入れる                              | sessionPresets.ts:267                             |

### F04-01[P2]:Codexプロファイルの設定が会話用CLIへ渡らない

**条件:**`codex.profile`へプロファイル名を設定し、新しいCodex会話を開く。

[config.ts:113](../../src/config.ts#L113)は設定値を読むが、[connection.ts:112](../../src/appserver/connection.ts#L112)の起動引数は`['app-server']`だけ。[ChatSession.start:153](../../src/appserver/chatSession.ts#L153)も、プロファイルの指定や設定内容の合成を行わない。`src/`の参照を追うと、値は主に設定スナップショットと表示へ流れている。

[manifest](../../package.json#L641)は`-p`に渡す設定と説明し、[設定パネル](../../src/view/controlPanelScript.ts#L999)も指定プロファイルによって既定値が変わる場合があると表示する。例えばプロファイル内だけに書いたモデル指定は、この設定経路ではCLIへ伝わらない。

**修正方針:**対応CLIのプロファイル適用方法を確認して会話開始へ接続し、表示と実効値を揃える。共有app-serverの起動時設定にする場合は、接続開始後の設定変更をいつ反映するかも定める。

**修正後の確認条件:**CLIの通常既定とプロファイル内のモデルを変え、最初の会話・接続開始後の新規会話で実効モデルを確認する。存在しない名前と、モデルの個別上書きとの優先順位も確認する。

### F04-02[P2]:Codexのモデル・effortを既定へ戻しても以前の上書きが残る

**条件:**会話中に明示的なモデルまたはeffortで一度送信し、その項目を「既定」（空文字）へ戻して次の指示を送る。

[chatView.ts:1497](../../src/view/chatView.ts#L1497)は空文字をセッション設定へ保存し、表示を更新する。[ChatSession.send:320](../../src/appserver/chatSession.ts#L320)は空文字の場合に`model`と`effort`を要求から省略するだけで、CLIへリセットを伝えない。

手元の`codex-cli 0.153.4`から生成した`v2/TurnStartParams.ts`では、この2項目は現在および後続のターンへの上書きと定義されている。項目を省略することは、過去に上書きした値をCLIの初期既定へ戻す操作にはならない。表示が既定でも、会話では以前の上書きが残る条件がある。モデル変更に伴って非対応effortを空文字へ戻す処理も、同じ省略経路になる。

**修正方針:**「既定」の意味をCLIの初期既定・モデル別既定・会話の現在値から区別する。既定値を解決して明示適用するか、会話中に戻せない場合は画面で反映時点を示す。

**修正後の確認条件:**初期既定と異なる値を送信後、既定へ戻してCLIの実効値を読む。モデル変更時のeffortリセットと、会話の再開後も確認する。

### F04-03[P2]:ワークスペースに設定値があると設定パネルでの変更が実効値に反映されない

**条件:**ワークスペース設定に`codex.model`や`claude.model`などの値があり、サイドバーの設定パネルで別の値を選ぶ。

対象のモデル設定は[manifest](../../package.json#L629)で`machine-overridable`として宣言され、ワークスペースから上書きできる。一方、[SettingsProvider.update](../../src/view/settingsProvider.ts#L1023)と[updateClaude](../../src/view/settingsProvider.ts#L975)は一律に`ConfigurationTarget.Global`へ書く。[snapshot](../../src/view/settingsProvider.ts#L613)は設定を読み直すため、ワークスペースの値が優先され、選択した値が画面上で元へ戻る。ユーザー設定だけが書き換わり、別のワークスペースへ影響する。

**修正方針:**モデル・effort・エージェントなど上書き可能な項目は、現在の値の設定元を調べて変更先を示すか、その設定元を更新する。machineスコープの項目まで一律にワークスペースへ書く変更にはしない。

**修正後の確認条件:**ユーザー設定のみ、ワークスペース上書きあり、複数ルートのフォルダ設定ありを分け、変更先・画面表示・新規会話の値が一致することを確認する。

### F04-04[P2]:プリセットのcwdに通常ファイルを受け入れる

**条件:**プリセットの`workingDirectory`へ、ワークスペース配下の実在する通常ファイルの絶対パスを指定する。例:`/repo/README.md`。

[resolveWorkingDirectory:267](../../src/sessionPresets.ts#L267)は絶対パス、`realpath()`による実体解決、ワークスペース境界を確認するが、ディレクトリかどうかを確認しない。通常ファイルも検証を通り、[applyPresetChat:1281](../../src/extension.ts#L1281)からそのまま新規会話へ渡る。

Claudeでは[spawnのcwd](../../src/claude/streamSession.ts#L296)に入り、Codexでは[thread/startのcwd](../../src/appserver/chatSession.ts#L154)に入る。プリセットの検証段階で警告・フォールバックされず、会話の起動やCLI側の処理で失敗する条件になる。実際のエラー文言は未確認。

**修正方針:**実体解決後にディレクトリであることを確認し、通常ファイルは既存の警告・作業フォルダ選択へ戻す。

**修正後の確認条件:**通常ファイル、通常ファイルを指すシンボリックリンク、正常なディレクトリ、欠損パスで検証結果と後続のcwdを確認する。

## 確認できた処理と既存テスト

- セクション取得は`pendingSectionLoads`で同時要求を集約する。取得済みの開閉では再取得せず、失敗後の再試行は`reloadSection()`を使う。hooksは警告表示のため畳まれていても先読みする:[settingsProviderSections.test.ts](../../test/unit/settingsProviderSections.test.ts)、[controlPanelView.test.ts](../../test/unit/controlPanelView.test.ts)。
- モデル一覧の更新は[refreshModels:357](../../src/view/settingsProvider.ts#L357)で集約し、片側の失敗を`Promise.allSettled()`で処理する。空・未取得時は前回候補を保持し、初回だけCodexのキャッシュまたはClaudeのエイリアスへ退避する。[extension.ts:920](../../src/extension.ts#L920)が起動時と5分ごとに更新し、破棄後は表示更新を止める。
- 候補のパーサーは壊れた入力を除外し、一覧外の現在値も[設定パネル](../../src/view/controlPanelScript.ts#L140)に残す。未知モデルのeffortは候補の和集合へ退避する:[modelCatalog.test.ts](../../test/unit/modelCatalog.test.ts)、[claudeModelProbe.test.ts](../../test/unit/claudeModelProbe.test.ts)。
- セッション別保存はproviderとIDで分離し、書込順序と直近値を保持する。会話間のモデル分離と再開時の復元を確認する既存テストがある:[sessionModelSettings.test.ts](../../test/unit/sessionModelSettings.test.ts)、[chatViewManager.test.ts:587](../../test/unit/chatViewManager.test.ts#L587)。これらはCLIの既定復帰までを再現していない。
- Claudeのモデル・effortは制御要求で反映する。空文字へ戻す操作とエージェント変更は現在のプロセスへ送らず、次のセッションから適用するとログに残す:[applyToSession:1789](../../src/view/claudeChatView.ts#L1789)。effortの実効性はコードにも未観測の制約が記されている。
- プリセットは重複名・型違いを除外し、承認設定のクランプ、実体パスによる境界確認、複数ルート時の選択を行う。モデル・effortの空文字はCLIの既定へ委譲する仕様:[sessionPresets.test.ts](../../test/unit/sessionPresets.test.ts)、[manifest](../../package.json#L1056)。

## 検証の限界

既存テストは関連ケースを読み、実行していない。モデル・エージェント取得の実CLI通信、設定パネルの実操作、上記4件の再現は未実施。CodexのAPI確認はローカルCLIによる型定義の生成のみ。生成物はworktree内の無視対象`.worktree/review-schema-20260909/`へ置いた。

承認要求の実行経路はF10、編集再送の全体はF09で扱う。次のレビュー対象はF05（入力・送信・キュー・中断）。
