#!/usr/bin/env bash
# lint / typecheck / test をまとめて実行する。commit前に全緑であること。
set -euo pipefail

cd "$(dirname "$0")/.."

echo "=== lint ==="
npm run --silent lint

echo "=== typecheck ==="
npm run --silent typecheck

echo "=== test ==="
npm run --silent test

echo "=== ALL PASS ==="
