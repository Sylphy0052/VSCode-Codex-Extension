#!/usr/bin/env bash
# 仮想ディスプレイ（Xvfb）上で @vscode/test-electron の統合テストを走らせる。
#
# XDG_RUNTIME_DIR が無い環境（WSL2など、/run/user/<uid> が消えるもの）では、VSCodeが
# IPCソケットを作れずウィンドウを作る前に無言で止まり、テストが1件も報告されないまま
# ハングする。その対策はこのスクリプトではなく `.vscode-test.mjs` の `env` で入れて
# あるため（issue #163、理由は `test/integration/fixtures/setup.mjs` の
# createRuntimeDir 参照）、ディスプレイが既にある環境向けの `npm run test:integration`
# でも同じように効く。
set -euo pipefail

cd "$(dirname "$0")/.."

exec xvfb-run -a npx vscode-test "$@"
