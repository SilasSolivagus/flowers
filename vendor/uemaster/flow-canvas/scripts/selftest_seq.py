#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""seq 布局 golden 自检（可独立运行；selftest.py 集成时调用 section(check, tmp, run)）。"""
import json, os, subprocess, sys, tempfile

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
LAYOUT = os.path.join(HERE, "flowlayout.py")

GOLDENS = [
    ("seq-login-auth.mmd", 3, 7),
    ("seq-order-pay.mmd", 4, 8),
    ("seq-oauth-resource.mmd", 4, 8),
    ("seq-push-notify.mmd", 5, 9),
]
REPORT_FIELDS = ("nodes", "edges", "crossings", "overlaps", "textOverflow", "warnings", "canvas")

DEGRADE_NOTE = """sequenceDiagram
  participant U as 用户
  participant A as 应用
  U->>A: 请求
  Note over U,A: 这里有一条注记
"""
DEGRADE_ALT = """sequenceDiagram
  participant U as 用户
  participant A as 应用
  alt 成功
  U->>A: 请求
  end
"""
DEGRADE_CROSS = """sequenceDiagram
  participant U as 用户
  participant A as 应用
  participant D as 用户库
  U->>D: 越过应用直连数据库
"""
EMOJI_SRC = """sequenceDiagram
  participant U as 用户
  participant A as 应用
  U->>A: 请求成功 \u2705
"""


def run(args):
    return subprocess.run([sys.executable, LAYOUT] + args, capture_output=True, text=True, encoding="utf-8")


def _report(stdout):
    """从 stdout 取出报告 JSON（flowcommon.common_main 以 indent=1 打印，末行为“已生成 …”）。"""
    txt = (stdout or "").strip()
    lines = [l for l in txt.splitlines() if not l.startswith("已生成")]
    return json.loads("\n".join(lines))


def _write(tmp, name, src):
    p = os.path.join(tmp, name)
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write(src)
    return p


def section(check, tmp, run):
    # ── 1. 每个 golden：产出 SVG + 报告三项全 0 + SVG 契约标记 ──
    for name, n_nodes, n_edges in GOLDENS:
        src = os.path.join(ROOT, "examples", name)
        tag = name[:-4]
        svg_path = os.path.join(tmp, tag + ".svg")
        p = run([src, "--type", "seq", "-o", svg_path])
        ok = p.returncode == 0
        check("seq %s 布局器运行" % tag, ok, (p.stderr or "").strip()[:160])
        if not ok:
            continue
        rep = _report(p.stdout)
        check("seq %s 报告字段齐全" % tag,
              all(k in rep for k in REPORT_FIELDS),
              str(sorted(set(REPORT_FIELDS) - set(rep))))
        check("seq %s 参与者数 = %d" % (tag, n_nodes), rep["nodes"] == n_nodes, str(rep.get("nodes")))
        check("seq %s 消息数 = %d" % (tag, n_edges), rep["edges"] == n_edges, str(rep.get("edges")))
        check("seq %s 零交叉" % tag, rep["crossings"] == 0, str(rep.get("crossings")))
        check("seq %s 零重叠" % tag, rep["overlaps"] == 0, str(rep.get("overlaps")))
        check("seq %s 零文字溢出" % tag, rep["textOverflow"] == 0, str(rep.get("textOverflow")))
        check("seq %s 画布尺寸为整数" % tag,
              isinstance(rep["canvas"], list) and len(rep["canvas"]) == 2
              and all(isinstance(v, int) for v in rep["canvas"]), str(rep.get("canvas")))
        svg = open(svg_path, encoding="utf-8").read()
        check("seq %s SVG 带 data-seqspec 契约版本" % tag, 'data-seqspec="1"' in svg)
        check("seq %s SVG 含 class=participant" % tag, 'class="participant"' in svg)
        check("seq %s SVG 含 class=message" % tag, 'class="message"' in svg)
        check("seq %s SVG 生命线为虚线" % tag, 'stroke-dasharray' in svg)
        check("seq %s 产物无 emoji" % tag,
              not [ch for ch in svg if 0x1F000 <= ord(ch) <= 0x1FAFF or 0x2600 <= ord(ch) <= 0x27BF])

        # ── 2. 每个 golden 再跑 --check ──
        p2 = run([src, "--type", "seq", "--check"])
        ok2 = p2.returncode == 0
        check("seq %s --check 通过" % tag, ok2, (p2.stderr or "").strip()[:160])
        if ok2:
            rep2 = _report(p2.stdout)
            check("seq %s --check 报告字段齐全" % tag,
                  all(k in rep2 for k in REPORT_FIELDS),
                  str(sorted(set(REPORT_FIELDS) - set(rep2))))
            check("seq %s --check 三项全 0" % tag,
                  rep2["crossings"] == 0 and rep2["overlaps"] == 0 and rep2["textOverflow"] == 0,
                  "%s/%s/%s" % (rep2.get("crossings"), rep2.get("overlaps"), rep2.get("textOverflow")))

    # ── 3. HTML 画布模式 ──
    html_path = os.path.join(tmp, "seq-golden.html")
    p = run([os.path.join(ROOT, "examples", GOLDENS[0][0]), "--type", "seq", "-o", html_path, "--html"])
    html = open(html_path, encoding="utf-8").read() if p.returncode == 0 else ""
    check("seq HTML 画布模式生成",
          p.returncode == 0 and "setZoom" in html and "pointerdown" in html and 'data-seqspec="1"' in html,
          (p.stderr or "").strip()[:160])

    # ── 4. 形态降级：note / alt / 跨列消息一律报错且提示「形态超限」 ──
    for label, name, src in (("note 注记", "seq-bad-note.mmd", DEGRADE_NOTE),
                             ("alt 分支", "seq-bad-alt.mmd", DEGRADE_ALT),
                             ("跨列消息", "seq-bad-cross.mmd", DEGRADE_CROSS)):
        p = run([_write(tmp, name, src), "--type", "seq", "--check"])
        check("seq 降级：%s 明确报错" % label,
              p.returncode != 0 and "形态超限" in (p.stderr or ""),
              (p.stderr or p.stdout).strip()[:120])

    # ── 5. emoji 输入拒绝 ──
    p = run([_write(tmp, "seq-emoji.mmd", EMOJI_SRC), "--type", "seq", "--check"])
    check("seq emoji 输入被拒绝", p.returncode != 0 and "emoji" in (p.stderr or ""),
          (p.stderr or p.stdout).strip()[:120])


if __name__ == "__main__":
    results = []
    def check(name, ok, detail=""):
        results.append((name, bool(ok), detail))
        print("%s %s%s" % ("PASS" if ok else "FAIL", name, ("  [%s]" % detail) if detail and not ok else ""))
    tmp = tempfile.mkdtemp(prefix="flowcanvas-seq-")
    section(check, tmp, run)
    fails = [r for r in results if not r[1]]
    print("\n%d/%d 通过" % (len(results) - len(fails), len(results)))
    sys.exit(1 if fails else 0)
