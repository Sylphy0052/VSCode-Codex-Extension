#!/usr/bin/env bash
# lint / format / typecheck / test をまとめて実行する。commit前に全緑であること。
set -euo pipefail

cd "$(dirname "$0")/.."

echo "=== lint ==="
npm run --silent lint

# eslintは整形を見ない（eslint.config.mjsにprettier連携は無い）。加えてeslintは
# .mdや.ymlを検査対象にしないため、eslint側へprettierを繋いでもdocs配下の非準拠は
# 拾えない。そのためprettier --checkを独立したステップとして置く（Issue #551）。
echo "=== format ==="
npm run --silent format:check

echo "=== typecheck ==="
npm run --silent typecheck

echo "=== test ==="
npm run --silent test

echo "=== ALL PASS ==="
