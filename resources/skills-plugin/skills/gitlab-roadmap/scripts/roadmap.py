#!/usr/bin/env python3
"""roadmap Issue本文のパース・状態判定・Mermaid生成 (gitlab-roadmap用)

references/format.md の「チェックリストの記法」と「状態クラスの算出」を機械的に行う。
規則の正本は format.md であり、このスクリプトはそれに合わせる。
標準ライブラリのみ (外部依存なし)。

使い方:
    python3 roadmap.py parse [FILE]    # 行ごとの line/phase/phase_name/iid/priority/title/checked/depends/invalid をJSONで出す
    python3 roadmap.py state [FILE]    # 各IIDの状態と、着手可能なIssueの順位をJSONで出す
    python3 roadmap.py mermaid [FILE]  # ```mermaid```ブロックを出す
    python3 roadmap.py render [FILE]   # 本文中のMermaidブロックだけを置き換えた本文を出す
    FILEを省略するか - を渡すと標準入力から読む

終了コード:
    0  正常 (stateは優先度の分類漏れがあっても0。JSONの unclassified を見る)
    1  入力を読めない、チェックリスト行が1行も無い、またはMermaidブロックが閉じていない
    3  (mermaid/render) 優先度付きroadmapに優先度の無い行がある。何も出さない
    4  (state/mermaid/render) dependsに循環がある。出力は通常どおり出し、循環したIIDの列を標準エラーへ出す
    5  読み飛ばしたチェックリスト行がある (閉じていないコードフェンス、書式違いのPhase見出し、
       `#IID`で始まるが記法に合わない行)。出力は出すが項目が欠けた診断用。4より優先する
       (mermaid/renderでは3が5より優先する)
    2はargparseの引数エラー等と衝突するため使わない。呼び出し側は0と4以外のとき出力を採用しない
    (parseは循環を検出しないため、常に0か1か5)
"""

from __future__ import annotations

import argparse
import json
import re
import sys

# format.md「パース用正規表現」と同じもの
ITEM_RE = re.compile(r"^- \[( |x)\] #(\d+) (.+?)(?:\s*\(depends:\s*([^)]+)\))?\s*$")
PHASE_RE = re.compile(r"^## Phase (\d+):\s*(.+)$")
# `#IID`で始まるのにチェックリスト記法に合わない行 (インデント付き、`[X]`など)。読み飛ばすと項目が欠ける
ITEM_LIKE_RE = re.compile(r"^\s*[-*+]\s*\[[ xX]?\]\s*#\d+")
# 書式に合わないフェーズ見出し (`### Phase 1: x`、`## phase 1: x`、`## フェーズ1`など) を拾う
PHASE_LIKE_RE = re.compile(r"^#{1,6}\s*(?:phase|フェーズ)", re.IGNORECASE)
PRIORITY_RE = re.compile(r"^(?:\[(P[0-3])\]|(P[0-3]):)\s*")
# Phase以外のレベル1・2見出しでフェーズの範囲が終わる
SECTION_END_RE = re.compile(r"^#{1,2}\s")
MEMO_RE = re.compile(r"^## メモ\s*$")
# コードフェンスの開始。バッククォート列と同じ行に別のバッククォートがあればインラインコードでありフェンスではない
FENCE_RE = re.compile(r"^\s*(`{3,}(?!.*`)|~{3,})")
MERMAID_OPEN_RE = re.compile(r"^```mermaid\s*$")
DEP_IID_RE = re.compile(r"#(\d+)")
# depends内の`#IID`と区切り以外の残り (`(depends: #3, 4)`の`4`など)
DEP_SEP_RE = re.compile(r"[\s,、]+")
# `(Depends: #3)` `(depends：#3)` のように、ITEM_REのdependsグループへ入らずタイトルに残る表記ゆれ
DEPENDS_TYPO_RE = re.compile(r"\(\s*depends\s*[:：]", re.IGNORECASE)
GATE_KEYS = {"p0p1": "P0/P1動作確認", "p2": "P2動作確認"}
PRIORITY_ORDER = {"P0": 0, "P1": 1, "P2": 2, "P3": 3}
BLOCKED_KEYS = ("depends", "external", "gate", "invalid")
CLASS_DEFS = [
    "classDef done fill:#8BC34A,stroke:#558B2F,color:#fff",
    "classDef ready fill:#FFD54F,stroke:#F57F17,color:#000",
    "classDef blocked fill:#ECEFF1,stroke:#90A4AE,color:#000",
]
# format.md手順3: 改行は空白、その他の制御文字と " [ ] ` < > は除去
LABEL_DROP_RE = re.compile(r"[\x00-\x09\x0b\x0c\x0e-\x1f\x7f\"\[\]`<>]")
NEWLINE_RE = re.compile(r"\r\n|\r|\n")
# Mermaidの文字参照 (`#lt;` `#62;` など) を成立させる `#`
CHAR_REF_RE = re.compile(r"#(?=[A-Za-z0-9]+;)")
# 標準エラーへ出す前に除く制御文字 (本文由来の端末エスケープで表示を偽装させない)
STDERR_DROP_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
EXIT_INPUT = 1
EXIT_UNCLASSIFIED = 3
EXIT_CYCLE = 4
EXIT_SKIPPED = 5


def find_fences(lines: list[str]) -> list[tuple[int, int | None]]:
    """トップレベルのコードフェンスを (開始行index, 終了行index) で返す。

    開いたときの文字と長さを覚え、同じ文字で同じ長さ以上の行だけで閉じる。
    閉じなければ終了行はNone (最終行まで続くものとして扱う)。
    """
    spans: list[tuple[int, int | None]] = []
    i = 0
    while i < len(lines):
        m = FENCE_RE.match(lines[i])
        if not m:
            i += 1
            continue
        char, size = m.group(1)[0], len(m.group(1))
        close_re = re.compile(rf"^\s*{re.escape(char)}{{{size},}}\s*$")
        end = next(
            (k for k in range(i + 1, len(lines)) if close_re.match(lines[k])), None
        )
        spans.append((i, end))
        if end is None:
            break
        i = end + 1
    return spans


def fenced_indexes(spans: list[tuple[int, int | None]], total: int) -> set[int]:
    """フェンスの開始行・内部・終了行のindex集合。"""
    return {
        i
        for start, end in spans
        for i in range(start, (total - 1 if end is None else end) + 1)
    }


def parse(text: str) -> dict:
    """本文からチェックリスト行とメモの行を取り出す。

    skipped は項目が欠けた原因の行番号 (終了コード5の判定に使う)。
    """
    items: list[dict] = []
    memo: list[str] = []
    warnings: list[str] = []
    skipped: list[int] = []
    phase: tuple[int, str] | None = None
    in_memo = False
    lines = [ln.rstrip("\r") for ln in text.split("\n")]
    spans = find_fences(lines)
    fenced = fenced_indexes(spans, len(lines))
    for start, end in spans:
        if end is None:
            warnings.append(f"閉じていないコードフェンスがある ({start + 1}行目)")
            skipped.append(start + 1)
    for idx, line in enumerate(lines):
        lineno = idx + 1
        if idx in fenced:
            continue
        m = PHASE_RE.match(line)
        if m and m.group(2).strip():
            phase = (int(m.group(1)), m.group(2).strip())
            in_memo = False
            continue
        ends_section = bool(SECTION_END_RE.match(line))
        # メモ節の中の小見出しはメモの本文として扱う
        if PHASE_LIKE_RE.match(line) and (ends_section or not in_memo):
            # 直下の項目を前のフェーズへ混ぜず、どのフェーズにも入れない
            warnings.append(f"line {lineno}: フェーズ見出しの記法に合わない行: {line}")
            skipped.append(lineno)
            phase = None
            in_memo = False
            continue
        if ends_section:
            phase = None
            in_memo = bool(MEMO_RE.match(line))
            continue
        if in_memo:
            memo.append(line)
            continue
        if phase is None:
            # Phase外 (メモ節を除く) の`#IID`付き行は、見出し崩れで外れた項目でありうる
            if ITEM_LIKE_RE.match(line):
                warnings.append(f"line {lineno}: フェーズ見出しの外にある項目: {line}")
                skipped.append(lineno)
            continue
        m = ITEM_RE.match(line)
        if not m:
            # `#IID`で始まる行だけが項目の欠落であり終了コード5にする。
            # `- [ ] 評価基盤 (#19)`のような行は参照用として警告だけ出す
            item_like = bool(ITEM_LIKE_RE.match(line))
            if item_like or line.lstrip().startswith("- ["):
                warnings.append(
                    f"line {lineno}: チェックリスト記法に合わない行: {line}"
                )
            if item_like:
                skipped.append(lineno)
            continue
        title = m.group(3)
        pm = PRIORITY_RE.match(title)
        priority = (pm.group(1) or pm.group(2)) if pm else None
        dep_text = m.group(4) or ""
        depends = [int(d) for d in DEP_IID_RE.findall(dep_text)]
        invalid: list[str] = []
        if m.group(4) and not depends:
            invalid.append(f"dependsに#IIDが無い: {m.group(4)}")
        elif DEP_SEP_RE.sub("", DEP_IID_RE.sub("", dep_text)):
            invalid.append(f"dependsに#IID以外の記載がある: {dep_text}")
        if DEPENDS_TYPO_RE.search(title):
            invalid.append("dependsの記法が不正 (`(depends: #N)`の半角表記だけを読む)")
        for reason in invalid:
            warnings.append(f"line {lineno}: #{m.group(2)} {reason}。BLOCKEDにする")
        items.append(
            {
                "line": lineno,
                "phase": phase[0],
                "phase_name": phase[1],
                "iid": int(m.group(2)),
                "priority": priority,
                "title": title,
                "checked": m.group(1) == "x",
                "depends": depends,
                "invalid": invalid,
            }
        )
    seen: set[int] = set()
    for it in items:
        if it["iid"] in seen:
            warnings.append(
                f"line {it['line']}: #{it['iid']} が重複している。最初の行だけを使う"
            )
        seen.add(it["iid"])
    return {"items": items, "memo": memo, "warnings": warnings, "skipped": skipped}


def gate_memo(memo: list[str], key: str) -> bool:
    """メモの `<key>:` の値がすべて `済` と完全一致するときだけ通過とする (format.md)。

    値は空白・バッククォート・`。`・`、`・`,` の手前までを読む。
    """
    values = re.findall(
        rf"(?<![\w/]){re.escape(key)}:\s*([^\s`。、,]+)", "\n".join(memo)
    )
    return bool(values) and all(v == "済" for v in values)


def unique_items(items: list[dict]) -> list[dict]:
    """同じIIDの行は最初の1行だけを残す。"""
    seen: set[int] = set()
    out = []
    for it in items:
        if it["iid"] not in seen:
            seen.add(it["iid"])
            out.append(it)
    return out


def find_cycles(items: list[dict]) -> list[list[int]]:
    """dependsグラフの閉路を深さ優先探索で探す (訪問中ノードへの再訪問=閉路)。"""
    graph = {it["iid"]: list(it["depends"]) for it in items}
    visiting: list[int] = []
    done: set[int] = set()
    found: dict[tuple[int, ...], list[int]] = {}

    def visit(node: int) -> None:
        visiting.append(node)
        for dep in graph.get(node, []):
            if dep in visiting:
                cyc = visiting[visiting.index(dep) :]
                # 同じ閉路を回転違いで重複して報告しない
                k = cyc.index(min(cyc))
                norm = cyc[k:] + cyc[:k]
                found.setdefault(tuple(norm), norm)
            elif dep in graph and dep not in done:
                visit(dep)
        visiting.pop()
        done.add(node)

    for iid in graph:
        if iid not in done:
            visit(iid)
    return list(found.values())


def compute_state(parsed: dict) -> dict:
    """format.mdの状態クラス算出表に従い、各行をdone/ready/blockedに分類する。"""
    items = unique_items(parsed["items"])
    by_iid = {it["iid"]: it for it in items}
    with_prio = [it for it in items if it["priority"]]
    if not with_prio:
        mode = "none"
    elif len(with_prio) == len(items):
        mode = "full"
    else:
        mode = "partial"
    unclassified = [
        it["iid"] for it in items if mode == "partial" and not it["priority"]
    ]

    def group_passed(prios: set[str], key: str) -> bool:
        rows = [it for it in items if it["priority"] in prios]
        if not rows:
            return True
        return all(it["checked"] for it in rows) and gate_memo(
            parsed["memo"], GATE_KEYS[key]
        )

    gates = {
        "p0p1": group_passed({"P0", "P1"}, "p0p1"),
        "p2": group_passed({"P2"}, "p2"),
    }

    out_items = []
    for it in items:
        blocked_by: dict[str, list] = {k: [] for k in BLOCKED_KEYS}
        if it["checked"]:
            state = "done"
        else:
            blocked_by["depends"] = [
                d for d in it["depends"] if d in by_iid and not by_iid[d]["checked"]
            ]
            # roadmap外のIssueは[x]を確かめられないため未完了として扱う
            blocked_by["external"] = [d for d in it["depends"] if d not in by_iid]
            blocked_by["invalid"] = list(it["invalid"])
            if mode == "full":
                if it["priority"] in ("P2", "P3") and not gates["p0p1"]:
                    blocked_by["gate"].append(GATE_KEYS["p0p1"])
                if it["priority"] == "P3" and not gates["p2"]:
                    blocked_by["gate"].append(GATE_KEYS["p2"])
            state = "blocked" if any(blocked_by.values()) else "ready"
        out_items.append({**it, "state": state, "blocked_by": blocked_by})

    def rank_key(it: dict) -> tuple:
        if mode == "full":
            return (it["phase"], PRIORITY_ORDER[it["priority"]], it["line"], it["iid"])
        return (it["phase"], it["line"], it["iid"])

    ready = [
        it["iid"]
        for it in sorted((i for i in out_items if i["state"] == "ready"), key=rank_key)
    ]
    return {
        "priority_mode": mode,
        "unclassified": unclassified,
        "gates": gates,
        "items": out_items,
        "ready": ready,
        "blocked": [it["iid"] for it in out_items if it["state"] == "blocked"],
        "done": [it["iid"] for it in out_items if it["state"] == "done"],
        # 分類漏れがあるroadmapは推奨を出さない (format.md)
        "next": ready[0] if ready and mode != "partial" else None,
        "cycles": find_cycles(items),
        "warnings": parsed["warnings"],
    }


def sanitize(label: str) -> str:
    """Mermaidのラベルに使えない文字と文字参照を除去する (format.md手順3)。"""
    s = LABEL_DROP_RE.sub("", NEWLINE_RE.sub(" ", label))
    # 除去の結果 `#1#2;` が `#12;` になるなど新しく文字参照ができるため、変化が無くなるまで繰り返す
    while True:
        out = CHAR_REF_RE.sub("", s)
        if out == s:
            return s
        s = out


def mermaid(state: dict) -> str:
    """format.mdのMermaid生成アルゴリズムどおりに```mermaid```ブロックを組み立てる。"""
    items = state["items"]
    lines = ["```mermaid", "flowchart LR"] + [f"    {c}" for c in CLASS_DEFS] + [""]
    phases: list[int] = []
    for it in items:
        if it["phase"] not in phases:
            phases.append(it["phase"])
    for ph in phases:
        rows = [it for it in items if it["phase"] == ph]
        lines.append(
            f'    subgraph P{ph}["Phase {ph}: {sanitize(rows[0]["phase_name"])}"]'
        )
        lines += [
            f'        I{it["iid"]}["#{it["iid"]} {sanitize(it["title"])}"]'
            for it in rows
        ]
        lines.append("    end")
    known = {it["iid"] for it in items}
    # roadmap外のIssueはノードが無いためエッジを引かない (format.mdの注意点)
    edges = [
        f"    I{d} --> I{it['iid']}"
        for it in items
        for d in it["depends"]
        if d in known
    ]
    if edges:
        lines += [""] + edges
    lines += [""] + [f"    class I{it['iid']} {it['state']}" for it in items]
    lines.append("```")
    return "\n".join(lines)


def render(text: str, block: str) -> tuple[str, list[str]]:
    """本文中の最初の```mermaid```ブロックだけを置き換える。無ければ最初のPhase見出しの前へ入れる。

    他のコードフェンスの中は対象にしない。(置き換えた本文, 警告) を返す。
    """
    lines = text.split("\n")
    spans = find_fences(lines)
    fenced = fenced_indexes(spans, len(lines))
    warnings: list[str] = []
    blocks = [(s, e) for s, e in spans if MERMAID_OPEN_RE.match(lines[s])]
    if blocks:
        start, end = blocks[0]
        if end is None:
            raise ValueError("```mermaid```ブロックが閉じていない")
        if len(blocks) > 1:
            warnings.append(
                f"```mermaid```ブロックが{len(blocks)}個ある。先頭 ({start + 1}行目) だけを置き換える"
            )
        new = lines[:start] + block.split("\n") + lines[end + 1 :]
    else:
        at = next(
            (
                i
                for i, ln in enumerate(lines)
                if i not in fenced and PHASE_RE.match(ln.rstrip("\r"))
            ),
            None,
        )
        if at is None:
            raise ValueError("## Phase見出しが無い")
        new = lines[:at] + block.split("\n") + [""] + lines[at:]
    return "\n".join(new), warnings


def read_input(path: str | None) -> str:
    """FILEまたは標準入力 (省略か -) をUTF-8で読む。"""
    if path in (None, "-"):
        return sys.stdin.read()
    with open(path, encoding="utf-8") as f:
        return f.read()


def safe_stderr(text: str) -> str:
    """本文由来の文字列から制御文字を除き、標準エラーへ出せる形にする。"""
    return STDERR_DROP_RE.sub("", text)


def main() -> int:
    ap = argparse.ArgumentParser(
        description="roadmap Issue本文のパース・状態判定・Mermaid生成"
    )
    ap.add_argument("command", choices=["parse", "state", "mermaid", "render"])
    ap.add_argument("file", nargs="?")
    args = ap.parse_args()
    try:
        text = read_input(args.file)
    except (OSError, UnicodeDecodeError) as e:
        print(f"error: 入力を読めない: {e}", file=sys.stderr)
        return EXIT_INPUT
    parsed = parse(text)
    for w in parsed["warnings"]:
        print(f"warning: {safe_stderr(w)}", file=sys.stderr)
    # 項目が欠けた出力は採用させない。循環 (4) は採用されるため、5を優先する
    skipped_rc = EXIT_SKIPPED if parsed["skipped"] else 0
    if skipped_rc:
        skipped_lines = ", ".join(str(n) for n in parsed["skipped"])
        print(
            f"error: 読み飛ばしたチェックリスト行がある (行 {skipped_lines})。記法を直す",
            file=sys.stderr,
        )
    # 警告と読み飛ばしを先に出し、項目が0件になった原因を示す
    if not parsed["items"]:
        print("error: チェックリスト行が1行も無い", file=sys.stderr)
        return EXIT_INPUT
    if args.command == "parse":
        # parseは循環を検出しない (常に0か1か5)
        print(
            json.dumps(
                {"items": parsed["items"], "warnings": parsed["warnings"]},
                ensure_ascii=False,
                indent=2,
            )
        )
        return skipped_rc
    state = compute_state(parsed)
    # 循環は警告として扱い、出力は止めない (next-and-list.md)。呼び出し元は終了コード4で気付く
    rc = skipped_rc or (EXIT_CYCLE if state["cycles"] else 0)
    for cyc in state["cycles"]:
        path = " -> ".join(f"#{i}" for i in cyc + cyc[:1])
        print(f"error: 循環依存: {path}", file=sys.stderr)
    if args.command == "state":
        print(json.dumps(state, ensure_ascii=False, indent=2))
        return rc
    if state["unclassified"]:
        iids = ", ".join(f"#{i}" for i in state["unclassified"])
        print(
            f"error: 優先度の無い行がある (UPDATEで分類する): {iids}", file=sys.stderr
        )
        return EXIT_UNCLASSIFIED
    block = mermaid(state)
    if args.command == "mermaid":
        print(block)
        return rc
    try:
        out, warns = render(text, block)
    except ValueError as e:
        print(f"error: {safe_stderr(str(e))}", file=sys.stderr)
        return EXIT_INPUT
    for w in warns:
        print(f"warning: {safe_stderr(w)}", file=sys.stderr)
    sys.stdout.write(out)
    return rc


if __name__ == "__main__":
    sys.exit(main())
