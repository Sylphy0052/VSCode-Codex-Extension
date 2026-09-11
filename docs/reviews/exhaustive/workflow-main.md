# ワークフロー定義・検証・展開と全テスト

対象:src/orchestrator/workflow.ts全1,897行、test/unit/workflow.test.ts全1,799行。型・全関数本体・全分岐、全テストの準備・操作・期待値を静的精査。テスト未実行。

## 新規指摘

EX-WORKFLOW-02/P2:issueの文字列を先頭の整数だけで受理する。workflow.ts:384のparseIntにより`issue: "12abc"`は12、`"1.5"`は1となり、正の安全整数チェックを通る。runnerMerge.ts:166からこの値をPR作成へ渡すため、不正な指定が別Issueとの関連付け・自動クローズ指定になる。文字列全体を整数として検査する必要がある。既存試験は数値の正常値、負数、安全整数の上限と超過を検査するが、文字列末尾・小数・指数表記は検査していない。

EX-WORKFLOW-03/P1:escalateの配列書き忘れを警告せず無効化する。workflow.ts:586はarrで配列以外を空配列へ変換し、配列内の非文字列要素だけ警告する。`autoApprove: true`かつ`escalate: npm run sensitive-local-task`のような独自停止指定は空になる。機械設定でも自動承認を許可し、要求が既定停止条件に該当しなければ、escalation.ts:747–755はaskを返さずautoへ進む。既定の危険コマンド判定は残るため、全承認が無条件化するわけではない。scalarの型誤りはdependsOnと同様に読み込みエラーにする必要がある。試験は配列内の数値混在だけで、scalar欠落と承認判定までの接続がない。

## 関数・分岐

- 型、既定値、予約ID、危険なオブジェクトキーの排除、文字列・配列・数値・真偽値の変換を確認。数値文字列は一般にparseIntで前方一致。未知列挙文字列は警告、非文字列は既定へ戻る。versionやdefaultsの型を厳密に拒否する検証はない。
- タスク・defaults・役割のmodel/effort優先順位を確認。未知のタスクroleは警告文では「なし」だが、有効なdefaults.roleがあれば継承する。テストはこの継承を明示している。
- dependsOnのscalarはエラー、非文字列要素は警告で除去。allow、escalate、verify配列、evidence等は変換時に不正型を落とす。verifyのcommands/filesのscalar誤りは検証条件の欠落として残る契約上の注意点。runtime検証全体の判定はrunner側も確認する。
- buildOrchestratorTaskは権限・境界フィールドの所有キーを値によらず拒否する。roleは許可。型・ID・依存関係の最終妥当性は後段validateWorkflow、入力schemaに依存する。
- YAML読込み、reviewメタデータ、withWorkflowReviewStatus、テンプレート参照削除、defaults.provider補完を確認。review書込みは行正規表現であり、flow mapping・引用キー等を含む任意のYAML表記の保持は保証されない。後者2つはYAMLノードを使用し、解析エラーでは原文を保持する。
- Tarjan法による強連結成分、自己依存、祖先集合、sharedの並列警告、権限比較のprovider別分岐を確認。明示cwd間の衝突や未指定権限の実効値はこの段階では判断しない。
- validateWorkflowの空タスク・上限、ID長・文字種・Windows予約語・casefold重複・予約接尾辞、文字数、再試行、issue、verifyパス、ロードマップパス、依存・循環・テンプレートの全エラーと警告を確認。型付き定義を直接渡す場合のNaN・小数・構造違反はパーサを経る場合と同等には拒否しない。
- テンプレートの5フィールド、未知・未完了・空値、直接依存の検証、非信頼出力のnonce区切り・個別上限・全体上限を確認。cwd/branchは生成済み構造化情報として区切らない。展開全体を生成してから全体上限を適用する。
- withCommitRequirementとclampAutoApproveの全出口を確認。完了条件は追記、クランプは機械設定が無効な場合のみtrueをfalseに落とす。

## テスト内容と不足

- 全143定義候補内のパラメータ展開、assertion、条件付き期待値を読み、既定値・警告・安全整数・上限・循環・共有領域・権限差・展開・YAML補完・役割優先順位と実装を対応付けた。AST候補数は実行ケース数ではない。
- buildOrchestratorTaskの分岐内assertionは、その前にtask/errorの存在を明示検査しており、分岐に入らないだけで成功しない。
- 循環に無関係なT3を除く試験はoptional chainingにより循環エラー自体がなくても成功し得る。他の循環検知試験は存在を確認しているが、このケース単体の期待値は弱い。
- 名称と実入力に差がある。issueの「0や負数」は負数だけ、テンプレート未宣言の見出しと実際の参照IDが異なる。clampのfalse入力はfalse/falseだけで、false/trueは未検査。
- 上限ちょうど、サロゲート対、偽区切り、nonce変化、結果とfiles、複数SCC、大小文字予約IDは具体値を検査する。一方、withWorkflowReviewStatusのYAML表記差、scalarの権限停止条件、verify条件の型誤り、文字列issueの部分受理はこのファイルに検査がない。

## 既存記録の訂正

worktree-main.mdの再試行接尾辞の候補は、workflow.tsの`-retry数字`予約により通常の検証済み定義では拒否される。到達可能な不具合と区別するよう訂正した。従来形式の大文字・小文字を含むIDの正規化衝突EX-WORKTREE-01は別の問題として残る。
