# チャット共有処理・スタイルと検査内容

対象:src/view/chatShared.ts、chatStyles.ts、controlPanelStyles.ts、test/unit/webviewStyles.test.ts。全文を確認した。テスト・ブラウザー未実行。

## 共有処理

添付の型/名前/拒否理由、各確認ダイアログの一致と取消、巻戻し対象10件上限、成果記録のsession/cwd/空結果guard、書出しのcopy/save/rawと取消、コード挿入の全selection、言語ID変換、新規document、ローカルリンクのscheme/絶対相対/Windows/行番号とopen失敗を確認した。editor.editのfalseは報告しない。言語IDの辞書は通常objectのため、__proto__等の継承キーを文字列として返せる契約ではない。行番号は1未満だけを除外し有限/安全整数を確認しない。これらは入力境界の不足で、外部APIでの実際のエラー表示は未確認。

差分はitemId/diffIndexで会話から引き、move先優先でworkspace文字列境界とrealpathを検査する。開く/差分/戻すの可否、行のclamp、言語ID取得失敗の継続、仮想beforeと実after、deleteの空after、読み取り失敗、確認前後の内容検査、trash削除/UTF-8書込みと失敗表示を確認した。deleteの存在判定はFileNotFoundだけを無いと扱い、それ以外のstat失敗を在る側へ倒す。戻す直前のパス再検査とdirty buffer保護は無く、F09-01/03/04/07を参照する。画像応答は会話のallowlist経由、mentionはcwd省略時workspaceへfallbackし、50件に制限する。返答の新旧判定はwebview側のquery照合に委ねる。

## HTML契約

ChatShellOptionsの全省略値とprovider差、nonce/CSP、17種のcomposerButtonSpec、表とoverflowの単一生成、hidden/pressed/role/ラベル、navigation・deferred restore・queue・承認・入力要求・使用量・TODO・background・loop・添付・設定の全要素を確認した。import文言とsettingsNoteはescapeHtmlを通す。agentLabel/approvalModes/sandboxModesは直接HTMLへ入り、現在の呼出し側が固定・検証済み値を渡す契約。生成スクリプトの引数と各機能のDOM入口を照合した。ユーザー設定からの不正composer ID/重複をこの関数では再検査しない。

## CSS

共有変数とhidden resetの連結、密度5変数、外枠の青/黄/赤優先、scroll領域とsticky見出し、カードと本文枠の詳細度、画像/編集/承認/質問、composer3段、overflowと候補の絶対位置・z-index、queue/使用量/TODO/background/設定/loop、diff/search/折畳み、Markdownの行長・table/codeの横scroll・highlight、reduced motionまで読んだ。カード化による.agentの枠打消しは高い詳細度で後置の一般規則にも勝ち、runningの同詳細度後置で実行中表示を戻す。

設定パネルは承認radioのchecked/unsafe/hover/focus、usageバー、alert banner、tabs、details、空/読込/失敗とretry、MCP/hooks/skills/plugin/apps/import各カードとbadge、出所の線種・状態の記号、history失敗とmotion抑制を確認した。狭幅、長いラベル、低い画面でのloopとoverflowの位置、テーマ変数の欠落は実際の描画で確認する余地がある。ここでは未確認の見た目を不具合確定としない。

## テストの強さ

webviewStyles.test.tsは全it/loop/helperを確認した。括弧検査は開閉の個数一致だけで順序・ネスト・CSS構文の合法性は見ない。hidden reset検査はコメントを除かず、文字列が存在すれば通る。scriptの対象id検査は単なるincludesであり開閉操作を保証しない。初回の見出し規則だけを見る検査と最後の規則を見る検査が混在し、最終computed styleの検査ではない。

行長の対象/非対象、詳細度に依存する順序、テーマ色、カードの枠、密度、state block、retry幅、summary marker、radio、badgeの色以外の手掛かり、カードhover、tab、usage、CSP、共有token、角丸、motion抑制を照合した。badge/card検査は正規表現と特定padding値から母数を推定するため、その形式から外れる新要素は母数に入らない。陽性対照は空集合素通りを一部防ぐが全要素の検査とは異なる。CSPのsubstring検査も別directiveの追加を全て拒否する試験ではない。
