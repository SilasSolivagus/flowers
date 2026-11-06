#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""flow-canvas 自检脚本：环境检查 + golden 样例断言。安装后运行一次确认可用。

用法： python3 scripts/selftest.py
退出码： 0 = 全部通过；1 = 存在失败项。
"""
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
import json
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
LAYOUT = os.path.join(HERE, "flowlayout.py")
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print("%s %s%s" % ("PASS" if ok else "FAIL", name, ("  [%s]" % detail) if detail and not ok else ""))


def run(args):
    p = subprocess.run([sys.executable, LAYOUT] + args, capture_output=True, text=True, encoding="utf-8")
    return p


def main():
    # ── L1 环境 ──
    check("python 版本 >= 3.8", sys.version_info >= (3, 8), sys.version.split()[0])
    try:
        with tempfile.NamedTemporaryFile(dir=tempfile.gettempdir(), delete=True):
            pass
        check("临时目录可写", True)
    except OSError as e:
        check("临时目录可写", False, str(e))

    tmp = tempfile.mkdtemp(prefix="flowcanvas-selftest-")

    # ── L2 minimal 冒烟 ──
    p = run([os.path.join(ROOT, "examples", "minimal.mmd"), "--check"])
    check("minimal 布局器运行", p.returncode == 0, p.stderr.strip()[:120])
    if p.returncode == 0:
        rep = json.loads(p.stdout)
        check("minimal 节点数 = 4", rep["nodes"] == 4, str(rep["nodes"]))
        check("minimal 主干 = A,B,C", rep["spine"] == ["A", "B", "C"], str(rep["spine"]))
        check("minimal 零交叉", rep["crossings"] == 0, str(rep["crossings"]))

    # ── L3 golden 全形态 ──
    svg_path = os.path.join(tmp, "golden.svg")
    p = run([os.path.join(ROOT, "examples", "pet-boarding.mmd"), "-o", svg_path])
    check("golden 布局器运行", p.returncode == 0, p.stderr.strip()[:120])
    if p.returncode == 0:
        rep = json.loads(p.stdout.splitlines()[0])
        check("golden 节点数 = 20", rep["nodes"] == 20, str(rep["nodes"]))
        check("golden 边数 = 24", rep["edges"] == 24, str(rep["edges"]))
        check("golden 主干 12 节点", rep["spine"] == ["A", "B", "C", "D", "E", "X", "F", "G", "H", "I", "K", "L"], str(rep["spine"]))
        check("golden 零交叉", rep["crossings"] == 0, str(rep["crossings"]))
        svg = open(svg_path, encoding="utf-8").read()
        check("SVG 带 data-flowspec 契约版本", 'data-flowspec="1"' in svg)
        n_clickable = len(re.findall(r'data-node="', svg))
        check("可点节点 data-node = 20（含 5 个判断节点）", n_clickable == 20, str(n_clickable))
        check("SVG 带选中框元素 sel-ring", 'id="sel-ring"' in svg)
        emoji = [ch for ch in svg if 0x1F000 <= ord(ch) <= 0x1FAFF or 0x2600 <= ord(ch) <= 0x27BF]
        check("产物无 emoji", not emoji, "".join(emoji[:5]))
        html_path = os.path.join(tmp, "golden.html")
        p2 = run([os.path.join(ROOT, "examples", "pet-boarding.mmd"), "-o", html_path, "--html"])
        html = open(html_path, encoding="utf-8").read() if p2.returncode == 0 else ""
        check("HTML 画布模式生成", p2.returncode == 0 and "setZoom" in html and "pointerdown" in html)

    # ── 强制主干 + 主干跳级边 ──
    skip = os.path.join(tmp, "skip.mmd")
    with open(skip, "w", encoding="utf-8") as f:
        f.write("flowchart TD\nA[开始] --> B{校验一？}\nB -->|是| C{校验二？}\nB -->|否| E\n"
                "C -->|不满足| E[基础通道]\nC -->|满足| G\nE --> F[提交]\nF --> G{终审？}\nG -->|通过| H[完成]\n")
    p = run([skip, "--check", "--spine", "A,B,C,E,F,G,H"])
    ok = p.returncode == 0
    rep3 = json.loads(p.stdout) if ok else {}
    check("--spine 强制主干生效", ok and rep3.get("spine") == list("ABCEFGH"), str(rep3.get("spine")))
    check("主干跳级边零交叉", ok and rep3.get("crossings") == 0, str(rep3.get("crossings")))

    # ── 左列分支链 --left ──
    lft = os.path.join(tmp, "left.mmd")
    with open(lft, "w", encoding="utf-8") as f:
        f.write("flowchart TD\nA[开始] --> B{校验？}\nB -->|否| P[人工核对]\nP --> DD\n"
                "P -->|重新校验| B\nB -->|是| CC[自动通过]\nCC --> DD[汇总]\nDD --> EE[完成]\n")
    p = run([lft, "--check", "--left", "P"])
    ok = p.returncode == 0
    rep4 = json.loads(p.stdout) if ok else {}
    check("--left 左列分支链生效", ok and rep4.get("spine") == ["A", "B", "CC", "DD", "EE"], str(rep4.get("spine")))
    check("左列分支链零交叉", ok and rep4.get("crossings") == 0, str(rep4.get("crossings")))

    # ── 形态降级检查：不适用图应明确报错而非产出烂图 ──
    bad = os.path.join(tmp, "bad.mmd")
    with open(bad, "w", encoding="utf-8") as f:
        f.write("flowchart TD\nA[甲] --> B[乙]\nA --> C[丙]\nC --> D[丁]\nD --> C2[戊]\nB --> C2\nX[孤立] --> Y[孤岛]\nY --> X2[乱]\nX --> X2\n")
    p = run([bad, "--check"])
    check("复杂图明确降级（报错而非烂图）", p.returncode != 0 and "适用形态" in (p.stderr or ""),
          (p.stderr or p.stdout).strip()[:80])

    # ── 落盘门禁：不干净的布局必须拒绝产出，不得静默产烂图 ──
    ov = os.path.join(tmp, "overlap.mmd")
    with open(ov, "w", encoding="utf-8") as f:
        f.write("flowchart TD\nA[开始] --> B[校验]\nB --> R1[分支1]\nB --> R2[分支2]\n"
                "B --> R3[分支3]\nR1 --> Z[汇合]\nR2 --> Z\nR3 --> Z\n")
    chk = run([ov, "--check"])
    try:
        chkrep = json.loads(chk.stdout)
    except Exception:
        chkrep = None
    dirty = bool(chkrep) and bool(chkrep.get("crossings") or chkrep.get("overlaps")
                                  or chkrep.get("textOverflow"))
    check("--check 退出码反映布局质量",
          chkrep is not None and (chk.returncode == 0) == (not dirty),
          "rc=%s dirty=%s" % (chk.returncode, dirty))
    ov_out = os.path.join(tmp, "overlap.svg")
    p = run([ov, "-o", ov_out])
    check("不干净的布局拒绝落盘（不静默产烂图）",
          (p.returncode != 0 and not os.path.exists(ov_out))
          or (p.returncode == 0 and not dirty and os.path.exists(ov_out)),
          "rc=%s exists=%s dirty=%s" % (p.returncode, os.path.exists(ov_out), dirty))

    # ── 空输入：明确报错，不抛 traceback ──
    empty = os.path.join(tmp, "empty.mmd")
    open(empty, "w", encoding="utf-8").close()
    for args, label in (([empty], "flowchart"), ([empty, "--type", "er"], "er")):
        p = run(args)
        err = (p.stderr or "") + (p.stdout or "")
        check("空输入明确报错而非 traceback（%s）" % label,
              p.returncode != 0 and "Traceback" not in err and "IndexError" not in err,
              err.strip()[:80])

    # ── L4 多图类型（arch/er/gantt/seq，各自独立自检模块集成） ──
    import importlib
    for mod_name in ("selftest_arch", "selftest_er", "selftest_gantt", "selftest_seq",
                     "selftest_blueprint"):
        try:
            m = importlib.import_module(mod_name)
            m.section(check, tmp, run)
        except Exception as e:
            check("%s 自检模块加载" % mod_name, False, str(e))

    fails = [r for r in results if not r[1]]
    print("\n%d/%d 通过" % (len(results) - len(fails), len(results)))
    if fails:
        print("失败项：" + "; ".join(r[0] for r in fails))
        sys.exit(1)
    print("flow-canvas 自检全部通过")


if __name__ == "__main__":
    main()
