# プロセス補助の精査

`src/process/{commandRunner,childProcess,stdinSafety}.ts`、`test/helpers/fakeChildProcess.ts`、`test/unit/{childProcess,stdinSafety}.test.ts`を全文精査。テスト未実行。

| 対象                                      | 関数・分岐とテスト内容                                                                                                                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| commandRunner.runと内部callback           | spawn、stdin有無、書込可否、stderr蓄積、error/close、settledによる二重完了防止、30秒timeout、タイマー解除を確認。stdin異常で完了した後に子を止めない問題は既存F01-05を参照。stderr上限がなく、spawn/endの同期throwと非同期通知の経路も専用テストで検査されていない |
| killWithEscalationとexit/timeout callback | SIGTERM、3秒後SIGKILL、exitで解除、同期exit後の早期return、unrefを確認。4テストは通常kill・時間経過・途中exit・同期exitを検査する。タイマーが残らないという説明に対しassertはkill回数だけ。killのfalse/throw、複数回呼出しは未検査                                 |
| canWriteToStdin                           | killed/destroyed/writableの3条件を確認。テストは正常と各条件の反転                                                                                                                                                                                                 |
| safeWriteToStdin                          | 不可ならfalse、可ならwrite後true。writeの戻り値は反映しない契約。テストは正常・killed・destroyed。write=falseと同期例外、writable=falseを直接通す試験はない                                                                                                        |
| guardStdinErrors                          | errorイベントのcallback転送。テストは引数同一性と複数通知。listener解除を提供しないため寿命は子プロセスに従う                                                                                                                                                      |
| FakeChildProcessとstdin/stdout/stderr補助 | EventEmitterの構築、書込記録、end、kill、同期exit、stdout/exit通知を確認。emitStdoutは常に改行を追加する。実際の任意チャンク分割・exitCode/signalCode・close通知は再現しない                                                                                       |

JSONLの上限定数も確認した。受信側の行分割・上限超過処理は各セッション実装の精査で別途扱う。stderrの無制限蓄積は耐性上の注意として残すが、この補助だけで実際の障害発生は断定していない。
