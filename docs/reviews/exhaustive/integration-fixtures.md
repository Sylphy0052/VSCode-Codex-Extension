# 統合試験fixture・補助の精査

対象は末尾の台帳記録に示す10ファイル。全文を読んだ。テスト、fixture生成、git初期化は実行していない。

## 新規指摘

### EX-TEST-03[P2]隔離ガードのテストが既存の固定ディレクトリを削除する

`test/unit/integrationFixtureGuards.test.ts`は`.vscode-test/guard-check`をmkdir(recursive=true)した後、既存かを区別せずtemporariesへ入れる。afterAllは再帰削除する。同名の既存ディレクトリにファイルがあれば、試験実行により失われる。固有ディレクトリの作成・回収に揃える必要がある。

## 全関数・分岐・内容

| 対象                                                                 | 確認経路とテストの限界                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| setup.mjsのgitToplevelOf/isInside/assertOutsideThisRepository        | git出力空/正常/例外、realpath、相対パスの内外、親gitルートも含めた拒否を確認。isInsideのstartsWith('..')は..で始まる子名も外と扱う。通常は親gitルート検査で補われるが、その名前の独立した入れ子gitルートは外として通る。生成側の通常パスには該当しない |
| assertIsolatedGitRepo                                                | gitの根の一致とremote空を要求。gitコマンド自体の失敗は伝播                                                                                                                                                                                             |
| createRuntimeDir/createNonGitRoot/createForgeRoot/createFixturesRoot | mkdtemp、作成後ガード、exitで自分の根を回収。途中のガード失敗は一部のexit登録前なので残る。SIGKILL・rm失敗は完全回収を保証しない                                                                                                                       |
| writeJsonl/initGitRepo/prepareFixtures                               | 親作成、JSONL直列化、gitローカル設定、初期コミット、各ディレクトリ生成、日時/UUID、Codex通常/アーカイブ/未命名とClaude範囲内外の履歴、設定書込、独立repo検査、manifest書込と返値を確認。既存ソースにはcommit --no-verifyがあるが今回実行していない     |
| 7種のYAML・Markdownひな形                                            | diamondの依存合流、疑似worktree、strict拒否、roadmapの対象外行、3者messaging、同一行競合と独立枝、forge1タスクを全文確認。モデルや実CLIが正しく動いた証拠にはならない                                                                                  |
| setup.d.mts                                                          | 4exportの引数/返値と実装を照合。manifestはunknownで、呼出側の厳密な形を検査しない                                                                                                                                                                      |
| integrationFixtureGuards.test.ts                                     | 動的import、独立一時repo作成、afterAll、外/内/根の3件と独立/非git/親へ遡る/remoteありの4件を確認。symlink、..子名、gitコマンド失敗は未検査。固定パス回収は上記指摘                                                                                     |
| integrationFixturesRoot.test.ts                                      | 動的import、createdRootsの後始末、2回の固有性・親パス・存在の3件を確認。プロセスを2本立てた並行試験やexit hook自体の観測はない。existsSyncだけなので型がdirectoryであることはassertしない                                                              |
| helpers/waitFor.ts                                                   | fn待機、predicate成功、deadline、interval、読込エラー時undefined、最後の内容付きcause、到達不能に備えたundefined拒否を確認。timeoutはfn自体の未解決Promiseを中断しない。read失敗は権限不足なども「ファイルが無い」と表示する                           |
| helpers/sessionTree.ts                                               | getChildrenの逐次再帰、group判別、葉の表示順を確認。循環や極端な深さは検出しない。入力は拡張側Tree契約を前提                                                                                                                                           |
| helpers/manifest.ts                                                  | 型の全項目、workspace欠落throw、同期read/JSON parseと型assertionを確認。messagingコメントは2タスクだがfixture実体は3。型検査でJSON構造は検証されない                                                                                                   |
| extension.test.ts                                                    | activate後isActive、package宣言コマンドが非空で全登録済み、Tree取得の3件。最後のArray.isArrayはflattenSessions自身が作る配列に対するassertなので、空のTreeでも通る。履歴内容は別試験で確認する設計                                                     |
| docs/integration-testing.md                                          | 実行入口、ビルド前提、絞込、ベースライン、過去のC-13/C-42失敗、XDG、環境隔離を全文確認。2026-08-29の85 passing/2 failingは過去記録で、現HEADの成功/失敗とは扱わない                                                                                    |
| docs/manual-test-2026-08-10.md                                       | 全ケースと当時の修正・設定制約を確認。途中分岐の成功記録はあるが、操作中のturn状態や複数指示の境界を限定しておらず、現在報告された失敗を否定する根拠にならない                                                                                         |
