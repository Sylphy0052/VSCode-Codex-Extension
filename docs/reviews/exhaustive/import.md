# 設定importの変換・テスト精査

`src/provider/import.ts`、`src/codex/importStatus.ts`、`test/unit/importProvider.test.ts`、`test/unit/codexImportStatus.test.ts`の全文を精査した。テストは未実行。

## 関数・分岐

Providerの型契約、種別ラベル、既知種別判定、長さと文字によるkey検査を読んだ。parserではroot/entryの型検査、type欠落、home/project、typeとcwdによる先勝ち、raw参照の保持、各内訳の抽出、8件の表示上限、memoryの件数のみの表示を確認した。plugin内訳はmarketplaceごとの名前を平坦化し、sessionはtitle→cwdの順で名前を採る。

履歴はimportId必須、時刻の既定値、providerId、成功・失敗の種別別集約、新しい順を確認した。開始応答はimportIdのみ、通知はimportIdと種別ごとの成功/失敗配列長、未知種別、最大5件の有効な失敗messageを扱う。record/string/array補助の不正値の経路も読んだ。

## テスト内容と不足

Providerのテストは10種別、未知種別、label、正常key、空/制御文字/型違い、長さ2000と2001を検査する。parserのテストは通常fixtureのdescription・scope・key、hooks/skills/plugin/session/memoryの内訳、10件から8件への切捨て、未知種別、生データ保持、root不正、type欠落を検査する。開始応答は通常・不正、通知は成功/失敗の件数とmessage・不正、履歴は時刻順・集約・providerIdのnull・不正を検査する。

不足は、重複key、空cwd、内訳の壊れた中間要素、plugin/sessionの切捨て、名前を持たない内訳と件数の差、通知の未知種別・型欠落・5件上限、履歴の時刻欠落・非有限数・同時刻・未知種別、同一種別の成功と失敗の合流である。rawByKey保持の期待値は値の等価性であり、参照同一性の契約までは検査していない。

## EX-IMPORT-01[P2]:継承プロパティを既知種別として受け入れる

`isKnownImportItemType`は通常objectに対する`in`で判定し、`labelForImportItemType`も所有プロパティを確認せず添字参照する。そのため`constructor`や`toString`を入力すると10種別のどれでもないのに既知と判定され、labelには文字列ではなく継承した関数が返る。未知種別をUNKNOWNと元文字列に退避させるparserの契約を破る。

静的に確定する入力処理の不備。外部CLIがこの値を実際に返した事象は未確認。既存テストの未知値は`SOMETHING_NEW`等であり、この境界を通らない。所有プロパティの判定またはMapで既知集合を表現すると防げる。同種の通常objectによるscope/source変換も一覧精査記録に注意点として残した。

確認ダイアログ待機中のrawByKey更新による対象のすり替わりは既存F17-01。今回はparser精査の完了であり、UI・要求・通知をまたぐ処理の追加精査は別途必要。
