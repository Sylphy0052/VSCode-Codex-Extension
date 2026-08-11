#!/usr/bin/env bash
# 仮想ディスプレイ（Xvfb）上で @vscode/test-electron の統合テストを走らせる。
#
# XDG_RUNTIME_DIR が無い環境（WSL2など、/run/user/<uid> が作られないもの）では、
# VSCode（Electron）がウィンドウを作る前に無言で止まり、テストが1件も報告されないまま
# ハングする。未設定・実在しない場合だけ使い捨てのディレクトリを用意して渡す
# （既に設定されていればその値を尊重する）。
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -z "${XDG_RUNTIME_DIR:-}" ] || [ ! -d "${XDG_RUNTIME_DIR}" ]; then
  XDG_RUNTIME_DIR="${TMPDIR:-/tmp}/xdg-runtime-$(id -u)"
  mkdir -p "${XDG_RUNTIME_DIR}"
  chmod 700 "${XDG_RUNTIME_DIR}"
  export XDG_RUNTIME_DIR
fi

exec xvfb-run -a npx vscode-test "$@"
