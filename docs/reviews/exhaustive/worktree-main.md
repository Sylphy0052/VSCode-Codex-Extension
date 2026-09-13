# タスクworktreeの作成・撤去とテスト

対象:src/orchestrator/worktree.ts、test/unit/worktree.test.ts。全文の関数・分岐・型契約と全テスト本体を確認した。テスト未実行。

## 名前と隔離方式

run/task識別子、retry有無、wf/conventionalとIssue有無、type変換、slug文字変換・切詰め、branch自己検査、cwd指定/shared/git有無/strictの優先順位、cleanup×タスク状態を確認した。

**EX-WORKTREE-01(P2):別タスクのブランチ名が正規化で衝突する。** worktree.ts:258のkebabCaseは大文字小文字とunderscore/hyphenの区別を失い、274のbuildConventionalSlugはIDの後半も切り捨てる。同じrun・type・IssueのT_AとT-Aは両方t-a-<run先頭8文字>になり、後続createはbranchExistsで止まる。異なる長いIDが先頭21文字を共有しても同様。付加するrunIdは同一run内の区別にはならない。単体テストは長さと形式だけでIDの異なる組合せを検査しない。taskId由来の識別成分を失わない名前生成が必要。

worktreeモジュール単独ではT1のretry0とT1-retry0が同じパス・ブランチになる。ただし上流のworkflow.ts:1556が-retry<数字>で終わるタスクIDを拒否するため、検証済み定義からの不具合には数えない。後続の全体精査で確認し、当初の衝突候補を訂正した。retry数値の範囲はこのモジュールで検査せず、生成branchの形式検査が最後の拒否になる。64桁HEADは7〜40桁制約で拒否される。

## git・filesystem・境界

execFileのargv、30秒timeout/10MiB上限、数値以外の終了コード、stderr代替、環境変数の上書き/削除を確認した。env指定の無い一般経路は親環境をそのまま継承し、GIT_DIR等の影響を排除しない。filesystemの全catchは権限/I/Oエラーも不在相当へ畳む。撤去のpathExists失敗も成功扱いになる点は運用上の注意。

HEAD取得、git判定、git-common-dirの非git/コマンド失敗/空出力/相対パス/realpath失敗、境界rootの解決・重複排除、警告付与を確認した。境界取得失敗は警告で継続し、git共有領域の保護を省く契約。呼出し側の承認機構と併読する。gitignore確認は4つの行の存在確認であり、先頭slash、global exclude、否定行を含む実gitの判定を再現しない。

## 作成・撤去・キュー

作成は識別子/HEAD/branch、祖先symlink、既存branch、git add、作成後realpathの順。事前検査後の外部差替えは排他できず、事後に境界逸脱を検出するとforce付きgit removeで撤去を試みる。作成自体の失敗時は残存branch等を片付けない。verifyの全非0をbranch不在と扱う。撤去は不在/dirty/status失敗/remove失敗を区別し、forceを使わない。撤去前のsymlink・実パス再確認は無いが、git側の登録worktree検査もあるため、この読取りだけで任意外部削除と断定しない。

create/remove/createWithOrigin/enqueueは同じSerialQueueを使う。HEAD解決とcreateを同一項目に入れて内部再enqueueを避ける。queue instance外の操作や外部gitは排他しない。buildRequestが受け取ったHEADを使うことは型だけでは強制されない。shouldRemoveはdoneかつremove/after-mergeのみ。

## テスト内容と不足

純粋関数の通常値・無効ID・retry・conventionalのfallback、作成のargv・既存branch・git失敗・ログ無害化・無効HEAD、HEAD引継ぎ、createWithOrigin未解決/割込み、直列キューと先行失敗、撤去のdirty/clean/不在/status失敗、ignore案内、common-dir/boundaryを確認する。

「生成branchの自己検査」は有効な1件だけで、検査文を削除しても通る。「HEAD解決と作成の間に割り込まない」はresolveの開始/終了とmergeだけを記録し、実際のcreate時点はorderに含めない。「createとremoveも直列」は両方の成功だけで、重なりを観測しない。一般enqueueの直列性試験はactive最大値と順序を観測するが、create/removeがそれを使うことの独立した検査ではない。

実gitを使うテスト本体も読んだ。毎回mkdtempからinit/config/add/commitし、afterEachで削除する。git/non-git/HEAD、作成/同名拒否、retry分離、common-dir、dirty保持/clean撤去、二重撤去、シェルメタ文字不実行、既存symlink先が空のままを確認する。これらを今回実行したわけではない。親git設定/環境を分離せず、git不在・symlink権限制約のskipは無い。作成後の境界逸脱とcleanup失敗、remove失敗、env削除、timeout/上限、否定ignore、命名衝突をこのファイルでは検査しない。
