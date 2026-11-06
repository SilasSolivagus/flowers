#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""gantt 布局 golden 自检（可独立运行；selftest.py 集成时调用 section(check, tmp, run)）。"""
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

GOLDENS = ["gantt-release", "gantt-day-schedule", "gantt-infra"]


def run(args):
    return subprocess.run([sys.executable, LAYOUT] + args,
                          capture_output=True, text=True, encoding="utf-8")


def section(check, tmp, run):
    for name in GOLDENS:
        src = os.path.join(ROOT, "examples", name + ".mmd")
        svg = os.path.join(tmp, name + ".svg")
        p = run([src, "--type", "gantt", "-o", svg])
        check("gantt %s 布局器运行" % name, p.returncode == 0, p.stderr.strip()[:120])
        if p.returncode == 0:
            rep = json.loads(p.stdout.splitlines()[0])
            check("gantt %s 报告字段齐全" % name,
                  all(k in rep for k in ("nodes", "edges", "crossings", "overlaps", "textOverflow", "warnings", "canvas")))
            check("gantt %s 零交叉" % name, rep.get("crossings") == 0, str(rep.get("crossings")))
            check("gantt %s 零重叠" % name, rep.get("overlaps") == 0, str(rep.get("overlaps")))
            check("gantt %s 零文字溢出" % name, rep.get("textOverflow") == 0, str(rep.get("textOverflow")))
            check("gantt %s 画布尺寸为整数" % name,
                  all(isinstance(v, int) for v in rep.get("canvas", [])), str(rep.get("canvas")))
            svg_text = open(svg, encoding="utf-8").read()
            check("gantt %s SVG 带 data-ganttspec 契约版本" % name, 'data-ganttspec="1"' in svg_text)
            check("gantt %s SVG 含 class=task" % name, 'class="task"' in svg_text)
            check("gantt %s SVG 含 data-task" % name, 'data-task=' in svg_text)
            emoji = [ch for ch in svg_text if 0x1F000 <= ord(ch) <= 0x1FAFF or 0x2600 <= ord(ch) <= 0x27BF]
            check("gantt %s 产物无 emoji" % name, not emoji, "".join(emoji[:5]))
        p2 = run([src, "--type", "gantt", "--check"])
        check("gantt %s --check 通过" % name, p2.returncode == 0, p2.stderr.strip()[:120])
        if p2.returncode == 0:
            rep2 = json.loads(p2.stdout)
            check("gantt %s --check 报告字段齐全" % name,
                  all(k in rep2 for k in ("nodes", "edges", "crossings", "overlaps", "textOverflow", "warnings", "canvas")))
            check("gantt %s --check 三项全 0" % name,
                  rep2["crossings"] == 0 and rep2["overlaps"] == 0 and rep2["textOverflow"] == 0)

    html = os.path.join(tmp, "gantt-golden.html")
    p = run([os.path.join(ROOT, "examples", "gantt-release.mmd"), "--type", "gantt", "-o", html, "--html"])
    check("gantt HTML 画布模式生成", p.returncode == 0 and "setZoom" in open(html, encoding="utf-8").read() and "pointerdown" in open(html, encoding="utf-8").read())

    # ── 刻度日期标签互不重叠（回归：28 天跨度，此前 2 天步长导致重叠）──
    ov_src = os.path.join(tmp, "gantt-date-ticks.mmd")
    with open(ov_src, "w", encoding="utf-8") as f:
        f.write("gantt\n  dateFormat YYYY-MM-DD\n  section 设计\n  需求分析 :a1, 2026-02-02, 5d\n"
                "  原型设计 :a2, after a1, 4d\n  section 开发\n  前端开发 :b1, after a2, 8d\n"
                "  section 里程碑\n  正式上线 :milestone, m1, 2026-03-02, 0d\n")
    p = run([ov_src, "--type", "gantt", "--check"])
    check("gantt 日期刻度标签零重叠", p.returncode == 0
          and json.loads(p.stdout)["textOverflow"] == 0, (p.stderr or "").strip()[:80])
    ov_svg = os.path.join(tmp, "gantt-date-ticks.svg")
    p = run([ov_src, "--type", "gantt", "-o", ov_svg])
    if p.returncode == 0:
        svg_text = open(ov_svg, encoding="utf-8").read()
        xs = sorted(float(m) for m in re.findall(
            r'<text x="([\d.]+)" y="[\d.]+" font-size="10"[^>]*>\d{4}-\d{2}-\d{2}</text>', svg_text))
        check("gantt 刻度间距 ≥ 标签宽", len(xs) >= 2 and all(b - a >= 55 for a, b in zip(xs, xs[1:])), str(xs))

    # ── 里程碑支持 after 依赖（此前明确报错，已放宽）──
    ma_src = os.path.join(tmp, "gantt-milestone-after.mmd")
    with open(ma_src, "w", encoding="utf-8") as f:
        f.write("gantt\n  dateFormat YYYY-MM-DD\n  任务甲 :a1, 2026-01-05, 3d\n"
                "  上线 :milestone, m1, after a1, 0d\n")
    p = run([ma_src, "--type", "gantt", "--check"])
    check("gantt 里程碑支持 after 依赖", p.returncode == 0, (p.stderr or "").strip()[:80])

    # ── 形态超限降级 ──
    bad1 = os.path.join(tmp, "gantt-bad-fmt.mmd")
    with open(bad1, "w", encoding="utf-8") as f:
        f.write("gantt\n  dateFormat MM/DD/YYYY\n  任务甲 :a1, 01/05/2026, 3d\n")
    p = run([bad1, "--type", "gantt", "--check"])
    check("gantt 降级：不支持的 dateFormat 明确报错", p.returncode != 0 and "形态超限" in (p.stderr or ""), (p.stderr or "").strip()[:80])

    bad2 = os.path.join(tmp, "gantt-bad-until.mmd")
    with open(bad2, "w", encoding="utf-8") as f:
        f.write("gantt\n  dateFormat YYYY-MM-DD\n  任务甲 :a1, 2026-01-05, 3d\n  任务乙 :a2, until a1, 2d\n")
    p = run([bad2, "--type", "gantt", "--check"])
    check("gantt 降级：until 依赖明确报错", p.returncode != 0 and "形态超限" in (p.stderr or ""), (p.stderr or "").strip()[:80])

    bad3 = os.path.join(tmp, "gantt-bad-after.mmd")
    with open(bad3, "w", encoding="utf-8") as f:
        f.write("gantt\n  dateFormat YYYY-MM-DD\n  任务甲 :a1, after 不存在, 3d\n")
    p = run([bad3, "--type", "gantt", "--check"])
    check("gantt 降级：after 依赖缺失明确报错", p.returncode != 0 and "形态超限" in (p.stderr or ""), (p.stderr or "").strip()[:80])

    # ── emoji 拒绝 ──
    bad4 = os.path.join(tmp, "gantt-emoji.mmd")
    with open(bad4, "w", encoding="utf-8") as f:
        f.write("gantt\n  dateFormat YYYY-MM-DD\n  任务🚀 :a1, 2026-01-05, 3d\n")
    p = run([bad4, "--type", "gantt", "--check"])
    check("gantt emoji 输入被拒绝", p.returncode != 0, (p.stderr or "").strip()[:80])


if __name__ == "__main__":
    results = []

    def check(name, ok, detail=""):
        results.append((name, bool(ok), detail))
        print("%s %s%s" % ("PASS" if ok else "FAIL", name, ("  [%s]" % detail) if detail and not ok else ""))

    tmp = tempfile.mkdtemp(prefix="flowcanvas-gantt-")
    section(check, tmp, run)
    fails = [r for r in results if not r[1]]
    print("\n%d/%d 通过" % (len(results) - len(fails), len(results)))
    sys.exit(1 if fails else 0)
