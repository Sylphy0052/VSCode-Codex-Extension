#!/usr/bin/env python3
"""見送ったlow指摘の切り出し漏れ検査 (gitlab-review / gitlab-develop用)

自己レビューnoteの「### 見送り一覧 (累積)」節 (gitlab-develop/references/mr-template.md)
を読み、状態が `見送り (low、別Issue予定)` のまま残っている行を列挙する。
一覧は累積なので、入力内に節が複数あるときは最後の節だけを見る。
標準ライブラリのみ (外部依存なし)。

使い方:
    python3 check_deferred_low.py <noteのファイル>
    python3 check_deferred_low.py -          # 標準入力から読む

終了コード:
    0  切り出し未了の行が無い (見送り一覧が N/A の場合を含む)
    1  切り出し未了の行、または状態を判定できない行がある
    2  入力を読めない、または見送り一覧の節が無い
"""

from __future__ import annotations

import argparse
import re
import sys

SECTION_RE = re.compile(r"^###\s+見送り一覧\s*\(累積\)\s*$")
HEADING_RE = re.compile(r"^#{1,6}\s")
ITEM_RE = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$")
# 水平線 (---等) の後は一覧の外とみなす
THEMATIC_BREAK_RE = re.compile(r"^\s*([-*_])(\s*\1){2,}\s*$")
# 箇条書き以外の書き方 (表・地の文) で残った予定行も見逃さないための目印
PENDING_MARK = "別Issue予定"
# 行の4要素は「ファイル / 見出し — 要約 — 状態」。要約に「—」が入っても崩れないよう右端で切る
STATE_SEP = " — "
PENDING_RE = re.compile(r"^見送り\s*\(low、別Issue予定\)$")
SPLIT_RE = re.compile(r"^見送り\s*\(low、#\d+へ切り出し済み\)$")
RESOLVED_RE = re.compile(r"^解消\s*\(.+\)$")


def last_section(lines: list[str]) -> list[str] | None:
    """最後の「見送り一覧 (累積)」節の本文行を返す。節が無ければNone。"""
    start = None
    for i, line in enumerate(lines):
        if SECTION_RE.match(line.strip()):
            start = i + 1
    if start is None:
        return None
    body = []
    for line in lines[start:]:
        if (
            HEADING_RE.match(line)
            or line.strip().startswith("```")
            or THEMATIC_BREAK_RE.match(line)
        ):
            break
        body.append(line)
    return body


def classify(body: list[str]) -> tuple[list[str], list[str], int]:
    """(切り出し未了の行, 状態を判定できない行, 切り出し済み・解消の件数) を返す。"""
    pending, unknown, done = [], [], 0
    for line in body:
        m = ITEM_RE.match(line)
        if not m:
            if PENDING_MARK in line:
                pending.append(line.strip())
            continue
        item = m.group(1)
        if item.strip("`") == "N/A":
            continue
        state = item.rsplit(STATE_SEP, 1)[-1].strip() if STATE_SEP in item else ""
        # 状態をコード表記 (`見送り (low、別Issue予定)`) で書いた行も同じ状態として扱う
        state = state.strip("`").strip()
        if PENDING_RE.match(state):
            pending.append(item)
        elif SPLIT_RE.match(state) or RESOLVED_RE.match(state):
            done += 1
        else:
            unknown.append(item)
    return pending, unknown, done


def main() -> int:
    parser = argparse.ArgumentParser(
        description="見送ったlow指摘の切り出し漏れを検査する"
    )
    parser.add_argument("note", help="自己レビューnoteのファイル (- で標準入力)")
    args = parser.parse_args()

    try:
        if args.note == "-":
            text = sys.stdin.read()
        else:
            with open(args.note, encoding="utf-8") as f:
                text = f.read()
    except OSError as e:
        print(f"エラー: 入力を読めない: {e}", file=sys.stderr)
        return 2

    body = last_section(text.splitlines())
    if body is None:
        print("エラー: 「### 見送り一覧 (累積)」節が無い", file=sys.stderr)
        return 2

    pending, unknown, done = classify(body)
    for item in pending:
        print(f"未切り出し: {item}")
    for item in unknown:
        print(f"状態不明: {item}")
    print(
        f"結果: 未切り出し{len(pending)}件 / 状態不明{len(unknown)}件 / 切り出し済み・解消{done}件"
    )
    return 1 if pending or unknown else 0


if __name__ == "__main__":
    sys.exit(main())
