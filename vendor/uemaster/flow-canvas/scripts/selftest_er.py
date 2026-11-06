#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""er 布局 golden 自检（可独立运行；selftest.py 集成时调用 section(check, tmp, run)）。"""
import json
import os
import re
import subprocess
import sys
import tempfile

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
LAYOUT = os.path.join(HERE, "flowlayout.py")
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import layout_er  # noqa: E402  直接调用布局产物做网格断言

GOLDENS = ["er-order", "er-blog", "er-school"]


def run(args):
    return subprocess.run([sys.executable, LAYOUT] + args,
                          capture_output=True, text=True, encoding="utf-8")


def _block(name, *attrs):
    return ["  %s {" % name] + ["    %s" % a for a in attrs] + ["  }"]


def _mmd(edges, entities):
    """entities: [(name, [attr_lines...]), ...]"""
    lines = ["erDiagram"] + ["  %s" % e for e in edges]
    for name, attrs in entities:
        lines += _block(name, *attrs)
    return "\n".join(lines) + "\n"


def _canvas_scan(svg):
    """解析 SVG 所有坐标/尺寸/points 数值，返回越出 [0,W]×[0,H] 的列表。"""
    m = re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', svg)
    if not m:
        return [("no-viewBox", 0)]
    W, H = float(m.group(1)), float(m.group(2))
    bad = []

    def chk(v, lo, hi, what):
        if v < lo - 1e-6 or v > hi + 1e-6:
            bad.append((what, v))

    for mm in re.finditer(r'\b(x|y|x1|y1|x2|y2|cx|cy|width|height)="(-?[\d.]+)"', svg):
        attr, val = mm.group(1), float(mm.group(2))
        if attr in ("x", "x1", "x2", "cx", "width"):
            chk(val, 0, W, attr)
        else:
            chk(val, 0, H, attr)
    for mm in re.finditer(r'points="([^"]+)"', svg):
        for pair in mm.group(1).split():
            x, y = map(float, pair.split(","))
            chk(x, 0, W, "px")
            chk(y, 0, H, "py")
    return bad


def section(check, tmp, run):
    for name in GOLDENS:
        src = os.path.join(ROOT, "examples", name + ".mmd")
        svg = os.path.join(tmp, name + ".svg")
        p = run([src, "--type", "er", "-o", svg])
        check("er %s 布局器运行" % name, p.returncode == 0, p.stderr.strip()[:120])
        if p.returncode == 0:
            rep = json.loads(p.stdout.splitlines()[0])
            check("er %s 报告字段齐全" % name,
                  all(k in rep for k in ("nodes", "edges", "crossings", "overlaps", "textOverflow", "warnings", "canvas")))
            check("er %s 零交叉" % name, rep.get("crossings") == 0, str(rep.get("crossings")))
            check("er %s 零重叠" % name, rep.get("overlaps") == 0, str(rep.get("overlaps")))
            check("er %s 零文字溢出" % name, rep.get("textOverflow") == 0, str(rep.get("textOverflow")))
            check("er %s 画布尺寸为整数" % name,
                  all(isinstance(v, int) for v in rep.get("canvas", [])), str(rep.get("canvas")))
            svg_text = open(svg, encoding="utf-8").read()
            check("er %s SVG 带 data-erspec 契约版本" % name, 'data-erspec="2"' in svg_text)
            check("er %s SVG 含 class=entity" % name, 'class="entity"' in svg_text)
            check("er %s SVG 含乌鸦脚记号" % name, 'class="er-card"' in svg_text)
            check("er %s 画布越界扫描为 0" % name, not _canvas_scan(svg_text),
                  str(_canvas_scan(svg_text)[:3]))
            emoji = [ch for ch in svg_text if 0x1F000 <= ord(ch) <= 0x1FAFF or 0x2600 <= ord(ch) <= 0x27BF]
            check("er %s 产物无 emoji" % name, not emoji, "".join(emoji[:5]))
        p2 = run([src, "--type", "er", "--check"])
        check("er %s --check 通过" % name, p2.returncode == 0, p2.stderr.strip()[:120])
        if p2.returncode == 0:
            rep2 = json.loads(p2.stdout)
            check("er %s --check 报告字段齐全" % name,
                  all(k in rep2 for k in ("nodes", "edges", "crossings", "overlaps", "textOverflow", "warnings", "canvas")))
            check("er %s --check 三项全 0" % name,
                  rep2["crossings"] == 0 and rep2["overlaps"] == 0 and rep2["textOverflow"] == 0)

    html = os.path.join(tmp, "er-golden.html")
    p = run([os.path.join(ROOT, "examples", "er-order.mmd"), "--type", "er", "-o", html, "--html"])
    check("er HTML 画布模式生成", p.returncode == 0 and "setZoom" in open(html, encoding="utf-8").read() and "pointerdown" in open(html, encoding="utf-8").read())

    # ── 乌鸦脚记号断言：o{ 与 |{ 关系 → circle + fork 线段，er-card 分组数量正确 ──
    crow = os.path.join(tmp, "er-crow.mmd")
    with open(crow, "w", encoding="utf-8") as f:
        f.write(_mmd(['A ||--o{ B : "x"', 'C ||--|{ D : "y"'],
                     [("A", ["int id PK"]), ("B", ["int id PK"]),
                      ("C", ["int id PK"]), ("D", ["int id PK"])]))
    crow_svg = os.path.join(tmp, "er-crow.svg")
    p = run([crow, "--type", "er", "-o", crow_svg])
    ok = p.returncode == 0
    csvg = open(crow_svg, encoding="utf-8").read() if ok else ""
    check("er 乌鸦脚：2 边 4 组 er-card", ok and csvg.count('class="er-card"') == 4, str(csvg.count('class="er-card"') if ok else -1))
    check("er 乌鸦脚：o{ 含 circle 记号", ok and 'data-card="o{"' in csvg and csvg.count('class="er-circle"') == 1)
    check("er 乌鸦脚：|{ 含 fork 三叉（3 线段）", ok and 'data-card="|{"' in csvg and csvg.count('class="er-fork"') == 6)
    check("er 乌鸦脚：画布越界扫描为 0", ok and not _canvas_scan(csvg), str(_canvas_scan(csvg)[:3]) if ok else "run-failed")

    # ── 网格断言：4 实体呈多行多列结构（y 取值 ≥ 2 种，不再单行）──
    grid_mmd = _mmd(['A ||--o{ B : "x"', 'A ||--o{ C : "y"', 'A ||--o{ D : "z"'],
                    [("A", ["int id PK"]), ("B", ["int id PK"]),
                     ("C", ["int id PK"]), ("D", ["int id PK"])])
    try:
        spec = layout_er.parse_mermaid(grid_mmd)
        glay = layout_er.layout(spec)
        ys = sorted(set(round(n["y"]) for n in glay["nodes"].values()))
        xs = sorted(set(round(n["x"]) for n in glay["nodes"].values()))
        check("er 网格：实体 y 取值 ≥ 2 种（不再单行）", len(ys) >= 2, str(ys))
        check("er 网格：实体 x 取值 ≥ 2 种（不再单列）", len(xs) >= 2, str(xs))
        check("er 网格：三项全 0", not glay["crossings"] and not glay["overlaps"] and not glay["textOverflow"])
    except SystemExit as e:
        check("er 网格：布局未降级", False, str(e))

    # ── 形态超限降级 ──
    bad1 = os.path.join(tmp, "er-bad-card.mmd")
    with open(bad1, "w", encoding="utf-8") as f:
        f.write(_mmd(['A ||--xx B : "x"'], [("A", ["int id PK"]), ("B", ["int id PK"])]))
    p = run([bad1, "--type", "er", "--check"])
    check("er 降级：非法基数记号明确报错", p.returncode != 0 and "形态超限" in (p.stderr or ""), (p.stderr or "").strip()[:80])

    bad2 = os.path.join(tmp, "er-bad-attr.mmd")
    with open(bad2, "w", encoding="utf-8") as f:
        f.write(_mmd([], [("A", ["int id !!"])]))
    p = run([bad2, "--type", "er", "--check"])
    check("er 降级：非法属性字符明确报错", p.returncode != 0 and "形态超限" in (p.stderr or ""), (p.stderr or "").strip()[:80])

    # 无引号注释 + 中文注释 + 引号注释 均能解析
    cmt = os.path.join(tmp, "er-comment.mmd")
    with open(cmt, "w", encoding="utf-8") as f:
        f.write(_mmd(['A ||--o{ B : "下单"'],
                     [("A", ["int id 主键", "string name PK \"姓名\""]), ("B", ["int id PK"])]))
    p = run([cmt, "--type", "er", "--check"])
    check("er 注释：无引号/引号注释均可解析", p.returncode == 0, (p.stderr or "").strip()[:80])

    # 三实体两两交叉：网格布局可绕行消除 → 应成功 + 三项全 0 + 含乌鸦脚
    bad3 = os.path.join(tmp, "er-triangle.mmd")
    with open(bad3, "w", encoding="utf-8") as f:
        f.write(_mmd(['A ||--o{ B : "x"', 'B ||--o{ C : "y"', 'A ||--o{ C : "z"'],
                     [("A", ["int id PK"]), ("B", ["int id PK"]), ("C", ["int id PK"])]))
    tri_svg = os.path.join(tmp, "er-triangle.svg")
    p = run([bad3, "--type", "er", "-o", tri_svg])
    ok = p.returncode == 0
    if ok:
        trep = json.loads(p.stdout.splitlines()[0])
        tsvg = open(tri_svg, encoding="utf-8").read()
        check("er 三角关系：网格布局运行成功", ok, p.stderr.strip()[:120])
        check("er 三角关系：三项全 0", trep["crossings"] == 0 and trep["overlaps"] == 0 and trep["textOverflow"] == 0)
        check("er 三角关系：SVG 含乌鸦脚记号", 'class="er-card"' in tsvg)
    else:
        check("er 三角关系：网格布局运行成功", ok, p.stderr.strip()[:120])

    # 绕行边数 > 6 的密集图 → 形态超限降级
    dense = os.path.join(tmp, "er-dense.mmd")
    with open(dense, "w", encoding="utf-8") as f:
        f.write("erDiagram\n")
        for i in range(8):
            for j in range(i + 1, 8):
                f.write("  E%d ||--o{ E%d : \"\"\n" % (i, j))
        for i in range(8):
            f.write("  E%d {\n    int id PK\n  }\n" % i)
    p = run([dense, "--type", "er", "--check"])
    check("er 降级：绕行边 > 6 明确报错", p.returncode != 0 and "形态超限" in (p.stderr or ""), (p.stderr or "").strip()[:80])

    # 完全重复关系边 → 形态超限
    dup = os.path.join(tmp, "er-dup-edge.mmd")
    with open(dup, "w", encoding="utf-8") as f:
        f.write(_mmd(['A ||--o{ B : "x"', 'A ||--o{ B : "y"'],
                     [("A", ["int id PK"]), ("B", ["int id PK"])]))
    p = run([dup, "--type", "er", "--check"])
    check("er 降级：完全重复关系边明确报错", p.returncode != 0 and "形态超限" in (p.stderr or ""), (p.stderr or "").strip()[:80])

    # ── emoji 拒绝 ──
    bad4 = os.path.join(tmp, "er-emoji.mmd")
    with open(bad4, "w", encoding="utf-8") as f:
        f.write(_mmd([], [("A", ["int id PK"]), ("B", ["int 数量🚀"])]))
    p = run([bad4, "--type", "er", "--check"])
    check("er emoji 输入被拒绝", p.returncode != 0, (p.stderr or "").strip()[:80])

    # ── 中文实体名 / 属性名（mermaid 官方语法允许中文标识符） ──
    cn = os.path.join(tmp, "er-cn.mmd")
    with open(cn, "w", encoding="utf-8") as f:
        f.write(_mmd(['作者 ||--o{ 文章 : "撰写"'],
                     [("作者", ["int 编号 PK"]), ("文章", ["int 编号 PK"])]))
    p = run([cn, "--type", "er", "--check"])
    check("er 中文实体名与属性名可解析", p.returncode == 0 and '"nodes": 2' in (p.stdout or ""),
          (p.stderr or "").strip()[:80])

    # ── 竖排关系标签不压线（anchor 应为 start，右移 8px 后左端对齐） ──
    svg_cn = os.path.join(tmp, "er-cn.svg")
    p = run([cn, "--type", "er", "-o", svg_cn])
    if p.returncode == 0:
        _s = open(svg_cn, encoding="utf-8").read()
        check("er 竖排关系标签不压线（text-anchor=start）",
              re.search(r'text-anchor="start"[^>]*>撰写<', _s) is not None,
              "未见 start 锚定标签")


if __name__ == "__main__":
    results = []

    def check(name, ok, detail=""):
        results.append((name, bool(ok), detail))
        print("%s %s%s" % ("PASS" if ok else "FAIL", name, ("  [%s]" % detail) if detail and not ok else ""))

    tmp = tempfile.mkdtemp(prefix="flowcanvas-er-")
    section(check, tmp, run)
    fails = [r for r in results if not r[1]]
    print("\n%d/%d 通过" % (len(results) - len(fails), len(results)))
    sys.exit(1 if fails else 0)
