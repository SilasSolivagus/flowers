#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""arch 布局 golden 自检（可独立运行；selftest.py 集成时调用 section(check, tmp, run)）。"""
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

GOLDENS = ["arch-3tier", "arch-microservice", "arch-portal", "arch-logical"]


def run(args):
    return subprocess.run([sys.executable, LAYOUT] + args,
                          capture_output=True, text=True, encoding="utf-8")


def _extent_ok(svg_text):
    """扫描 SVG 所有坐标/尺寸/折线点是否落在 viewBox 内（防右缘裁剪回归）。"""
    m = re.search(r'viewBox="0 0 (\d+) (\d+)"', svg_text)
    if not m:
        return False, "no viewBox"
    W, H = int(m.group(1)), int(m.group(2))
    for m2 in re.finditer(r'(x|y|width|height)="(-?[\d.]+)"', svg_text):
        v = float(m2.group(2))
        a = m2.group(1)
        if a in ("x", "width") and not (-0.5 <= v <= W + 0.5):
            return False, "%s=%s W=%d" % (a, v, W)
        if a in ("y", "height") and not (-0.5 <= v <= H + 0.5):
            return False, "%s=%s H=%d" % (a, v, H)
    for m2 in re.finditer(r'points="([^"]+)"', svg_text):
        for pt in m2.group(1).split():
            x, y = (float(t) for t in pt.split(","))
            if not (-0.5 <= x <= W + 0.5) or not (-0.5 <= y <= H + 0.5):
                return False, "pt %s W=%d H=%d" % ((x, y), W, H)
    return True, ""


def section(check, tmp, run):
    for name in GOLDENS:
        src = os.path.join(ROOT, "examples", name + ".mmd")
        svg = os.path.join(tmp, name + ".svg")
        p = run([src, "--type", "arch", "-o", svg])
        check("arch %s 布局器运行" % name, p.returncode == 0, p.stderr.strip()[:120])
        if p.returncode == 0:
            rep = json.loads(p.stdout.splitlines()[0])
            check("arch %s 报告字段齐全" % name,
                  all(k in rep for k in ("nodes", "edges", "crossings", "overlaps", "textOverflow", "warnings", "canvas")))
            check("arch %s 零交叉" % name, rep.get("crossings") == 0, str(rep.get("crossings")))
            check("arch %s 零重叠" % name, rep.get("overlaps") == 0, str(rep.get("overlaps")))
            check("arch %s 零文字溢出" % name, rep.get("textOverflow") == 0, str(rep.get("textOverflow")))
            check("arch %s 零标签碰撞" % name, rep.get("labelCollisions") == 0, str(rep.get("labelCollisions")))
            check("arch %s 画布尺寸为整数" % name,
                  all(isinstance(v, int) for v in rep.get("canvas", [])), str(rep.get("canvas")))
            svg_text = open(svg, encoding="utf-8").read()
            check("arch %s SVG 带 data-archspec 契约版本" % name, 'data-archspec="5"' in svg_text)
            check("arch %s SVG 含 class=node" % name, 'class="node"' in svg_text)
            check("arch %s SVG 含 class=lane" % name, 'class="lane"' in svg_text)
            check("arch %s SVG 含 lane-title" % name, 'class="lane-title"' in svg_text)
            check("arch %s SVG 含自动图例" % name, 'class="legend"' in svg_text and "图例" in svg_text)
            fss = [int(x) for x in re.findall(r'font-size="(\d+)"', svg_text)]
            check("arch %s 字号硬阈值 ≥ 10px" % name, bool(fss) and min(fss) >= 10, str(sorted(set(fss))))
            ys = [float(v) for v in re.findall(
                r'<text x="[^"]+" y="([\d.]+)"[^>]*class="lane-title">', svg_text)]
            check("arch %s 泳道纵向分层（声明序自上而下）" % name,
                  len(ys) >= 2 and all(a < b for a, b in zip(ys, ys[1:])), str(ys))
            ok_ext, detail = _extent_ok(svg_text)
            check("arch %s 元素不越画布（右缘不裁剪）" % name, ok_ext, detail)
            emoji = [ch for ch in svg_text if 0x1F000 <= ord(ch) <= 0x1FAFF or 0x2600 <= ord(ch) <= 0x27BF]
            check("arch %s 产物无 emoji" % name, not emoji, "".join(emoji[:5]))
        p2 = run([src, "--type", "arch", "--check"])
        check("arch %s --check 通过" % name, p2.returncode == 0, p2.stderr.strip()[:120])
        if p2.returncode == 0:
            rep2 = json.loads(p2.stdout)
            check("arch %s --check 报告字段齐全" % name,
                  all(k in rep2 for k in ("nodes", "edges", "crossings", "overlaps", "textOverflow", "warnings", "canvas")))
            check("arch %s --check 三项全 0" % name,
                  rep2["crossings"] == 0 and rep2["overlaps"] == 0 and rep2["textOverflow"] == 0)

    html = os.path.join(tmp, "arch-golden.html")
    p = run([os.path.join(ROOT, "examples", "arch-3tier.mmd"), "--type", "arch", "-o", html, "--html"])
    check("arch HTML 画布模式生成", p.returncode == 0 and "setZoom" in open(html, encoding="utf-8").read() and "pointerdown" in open(html, encoding="utf-8").read())

    # ── 跳级边能力：泳道内非相邻 + 跨多泳道（顶部走廊路由，全 0） ──
    skip_src = os.path.join(ROOT, "examples", "arch-skip.mmd")
    skip_svg = os.path.join(tmp, "arch-skip.svg")
    p = run([skip_src, "--type", "arch", "-o", skip_svg])
    check("arch 跳级边样例布局器运行", p.returncode == 0, p.stderr.strip()[:120])
    if p.returncode == 0:
        rep = json.loads(p.stdout.splitlines()[0])
        check("arch 跳级边样例零交叉", rep.get("crossings") == 0, str(rep.get("crossings")))
        check("arch 跳级边样例零重叠", rep.get("overlaps") == 0, str(rep.get("overlaps")))
        check("arch 跳级边样例零文字溢出", rep.get("textOverflow") == 0, str(rep.get("textOverflow")))
        ok_ext, detail = _extent_ok(open(skip_svg, encoding="utf-8").read())
        check("arch 跳级边样例元素不越画布", ok_ext, detail)

    # ── 逻辑容器图能力：系统边界 / 外部实体 / 元信息 / 待确认项 ──
    lg_src = os.path.join(ROOT, "examples", "arch-logical.mmd")
    lg_svg = os.path.join(tmp, "arch-logical.svg")
    p = run([lg_src, "--type", "arch", "-o", lg_svg])
    check("arch 逻辑容器图样例布局器运行", p.returncode == 0, p.stderr.strip()[:120])
    if p.returncode == 0:
        lg = open(lg_svg, encoding="utf-8").read()
        check("arch 逻辑容器图含系统边界", 'class="boundary"' in lg)
        check("arch 逻辑容器图含边界标题", 'class="boundary-title"' in lg)
        check("arch 逻辑容器图含待确认项区", 'class="todo"' in lg and "待确认项" in lg)
        check("arch 逻辑容器图含标题与范围", "逻辑容器图" in lg and "不描述部署" in lg)
        check("arch 逻辑容器图含图种", "图种：容器" in lg)
        # 视觉语法：一语义一视觉（虚线只表达外部实体；边界粗实线无虚线）
        bnd_rect = re.search(r'<g class="boundary".*?<rect ([^>]*)>', lg, re.S).group(1)
        check("arch 系统边界为实线（不带虚线）", "stroke-dasharray" not in bnd_rect)
        check("arch 外部实体为虚线框", len(re.findall(r'data-style="external">\s*<rect[^>]*stroke-dasharray', lg)) >= 1)
        # 数据存储 = 圆柱体；状态徽标 = 第三层文字 pill；注释锚点徽章
        check("arch 数据存储为圆柱体", lg.count("<ellipse") >= 2)
        check("arch 状态徽标 pill", 'height="16" rx="8"' in lg)
        check("arch 注释锚点徽章", lg.count('class="note-badge"') >= 2)
        check("arch 待确认项带编号锚点", "「A1」" in lg and "「A2」" in lg)
        leg = re.search(r'<g class="legend".*?</g>', lg, re.S).group(0)
        leg_txt = "".join(re.findall(r'>([^<]+)</text>', leg))
        for entry in ("外部实体", "组件容器", "数据存储", "系统边界", "逻辑层", "同步调用"):
            check("arch 图例覆盖样式：%s" % entry, entry in leg_txt)
        # 拓扑对齐：浏览器→NGINX 列对齐直落（0 折弯）
        straight = re.findall(r'<polyline points="([^"]+)"[^>]*/>', lg)
        check("arch 对齐后存在 0 折弯直落边", any(len(p.split()) == 2 for p in straight))
        # 外部实体（浏览器）必须位于系统边界上方
        m_ext = re.search(r'<g class="node"[^>]*data-node="W">.*?</g>', lg, re.S)
        m_bnd = re.search(r'<g class="boundary".*?<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"', lg, re.S)
        if m_ext and m_bnd:
            ext_y = float(re.search(r'<rect x="[\d.]+" y="([\d.]+)"', m_ext.group(0)).group(1))
            bnd_top = float(m_bnd.group(2))
            check("arch 外部实体在系统边界之外（上方）", ext_y < bnd_top,
                  "ext_y=%s bnd_top=%s" % (ext_y, bnd_top))
        ok_ext, detail = _extent_ok(lg)
        check("arch 逻辑容器图元素不越画布", ok_ext, detail)

    # ── 无语义边标签 → warnings 提醒（不阻断产出）──
    wl_src = os.path.join(tmp, "arch-warn-label.mmd")
    with open(wl_src, "w", encoding="utf-8") as f:
        f.write("flowchart TD\nsubgraph A\n  X[\"组件X\"]\n  Y[\"组件Y\"]\nend\nX --> Y\n")
    p = run([wl_src, "--type", "arch", "--check"])
    rep_wl = json.loads(p.stdout)
    check("arch 无边标签出 warnings 且不阻断", p.returncode == 0 and any("无语义标签" in w for w in rep_wl["warnings"]),
          str(rep_wl.get("warnings")))

    # ── 注释锚点孤儿双向警告 ──
    orp = os.path.join(tmp, "arch-orphan-note.mmd")
    with open(orp, "w", encoding="utf-8") as f:
        f.write("flowchart TD\ntodo [A9] 无人引用\ntodo [A1] 被引用\n"
                "subgraph B\n  X[\"组件X [A1]\"]\n  Y[\"组件Y [A2]\"]\nend\nX --> Y\n")
    p = run([orp, "--type", "arch", "--check"])
    rep_o = json.loads(p.stdout)
    check("arch 孤儿注释/孤儿锚点双向警告", p.returncode == 0
          and any("未挂接" in w and "A9" in w for w in rep_o["warnings"])
          and any("没有对应的 todo" in w and "A2" in w for w in rep_o["warnings"]),
          str(rep_o.get("warnings")))

    # ── 非法 view 图种 → 形态超限 ──
    bv = os.path.join(tmp, "arch-bad-view.mmd")
    with open(bv, "w", encoding="utf-8") as f:
        f.write("flowchart TD\nview roadmap\nsubgraph B\n  X[\"组件X\"]\nend\n")
    p = run([bv, "--type", "arch", "--check"])
    check("arch 降级：非法 view 图种明确报错", p.returncode != 0 and "形态超限" in (p.stderr or ""),
          (p.stderr or "").strip()[:80])

    # ── 异步事件：虚线 + 空心箭头 ──
    asy = os.path.join(tmp, "arch-async.mmd")
    with open(asy, "w", encoding="utf-8") as f:
        f.write("flowchart TD\nsubgraph B\n  X[\"组件X\"]\n  Y[\"组件Y\"]\nend\nX -.->|事件| Y\n")
    p = run([asy, "--type", "arch", "-o", os.path.join(tmp, "arch-async.svg")])
    if p.returncode == 0:
        asy_svg = open(os.path.join(tmp, "arch-async.svg"), encoding="utf-8").read()
        check("arch 异步事件为虚线空心箭头", "stroke-dasharray" in asy_svg and "arw-open" in asy_svg)
    else:
        check("arch 异步事件为虚线空心箭头", False, p.stderr.strip()[:80])

    # ── T2 高扇入扇出：4 层 20 节点 30 条关系（扇出带标签 + 异步 + 跨层跳级）──
    t2 = os.path.join(tmp, "arch-t2-fanout.mmd")
    with open(t2, "w", encoding="utf-8") as f:
        f.write("flowchart TB\ntitle 高扇入扇出压力测试\nscope 合成数据\n")
        f.write("subgraph 接入层\n  G1[\"网关1\"]\n  G2[\"网关2\"]\nend\n")
        f.write("subgraph 服务层\n" + "\n".join('  S%d["服务%d"]' % (i, i) for i in range(1, 9)) + "\nend\n")
        f.write("subgraph 数据层\n" + "\n".join('  D%d[("存储%d")]' % (i, i) for i in range(1, 9)) + "\nend\n")
        f.write("subgraph 运行层\n  R1[\"监控告警\"]\n  R2[\"日志平台\"]\nend\n")
        f.write("\n".join("G1 -->|转发| S%d" % i for i in range(1, 5)) + "\n")
        f.write("\n".join("G2 -->|转发| S%d" % i for i in range(5, 9)) + "\n")
        f.write("\n".join("S%d -->|读写| D%d" % (i, i) for i in range(1, 9)) + "\n")
        f.write("\n".join("S%d -->|读写| D%d" % (i, i + 1) for i in range(1, 8)) + "\n")
        f.write("S1 -->|上报| R1\nS8 -->|上报| R1\nS1 -->|上报| R2\nS8 -->|上报| R2\n")
        f.write("G1 -.->|健康检查| R1\nG2 -.->|健康检查| R2\n")
    p = run([t2, "--type", "arch", "--check"])
    rep2 = json.loads(p.stdout)
    check("T2 高扇入扇出零交叉零碰撞", p.returncode == 0
          and rep2["crossings"] == 0 and rep2["overlaps"] == 0
          and rep2["textOverflow"] == 0 and rep2.get("labelCollisions") == 0,
          str({k: rep2.get(k) for k in ("crossings", "overlaps", "textOverflow", "labelCollisions")}))

    # ── T4 跨层集成：外部系统 + 同步/异步 + 回路 + 跨组调用 ──
    t4 = os.path.join(tmp, "arch-t4-integration.mmd")
    with open(t4, "w", encoding="utf-8") as f:
        f.write("flowchart TB\ntitle 跨层集成\nscope 合成数据\n"
                "subgraph 平台\n  subgraph 接入层\n    ING[\"入口网关\"]\n  end\n"
                "  subgraph 核心层\n    C1[\"核心服务A\"]\n    C2[\"核心服务B\"]\n  end\n"
                "  subgraph 数据层\n    DB1[(\"主库\")]\n    DB2[(\"缓存\")]\n  end\nend\n"
                "EXT1[[\"外部支付\"]]\nEXT2[[\"外部短信\"]]\n"
                "EXT1 -->|HTTPS：回调| ING\nING -->|路由| C1\nING -->|路由| C2\n"
                "C1 -.->|事件| C2\nC2 -->|写入| DB1\nC1 -->|读写| DB2\n"
                "C2 -->|回调| EXT2\nDB2 -.->|失效通知| C2\n")
    p = run([t4, "--type", "arch", "-o", os.path.join(tmp, "arch-t4.svg")])
    if p.returncode == 0:
        rep4 = json.loads(p.stdout.splitlines()[0])
        check("T4 跨层集成零交叉零碰撞", rep4["crossings"] == 0 and rep4["overlaps"] == 0
              and rep4["textOverflow"] == 0 and rep4.get("labelCollisions") == 0,
              str({k: rep4.get(k) for k in ("crossings", "overlaps", "textOverflow", "labelCollisions")}))
        t4svg = open(os.path.join(tmp, "arch-t4.svg"), encoding="utf-8").read()
        check("T4 异步事件虚线空心箭头", "arw-open" in t4svg and "stroke-dasharray" in t4svg)
    else:
        check("T4 跨层集成零交叉零碰撞", False, p.stderr.strip()[:80])

    # ── T4b 病态骑跨：中间节点跨层出线被相邻总线的水平段封死 → 诚实降级 ──
    t4b = os.path.join(tmp, "arch-t4b-pathological.mmd")
    with open(t4b, "w", encoding="utf-8") as f:
        f.write("flowchart TB\ntitle 病态骑跨\n"
                "subgraph 平台\n  subgraph 接入层\n    ING[\"入口网关\"]\n  end\n"
                "  subgraph 核心层\n    C1[\"核心服务A\"]\n    C2[\"核心服务B\"]\n  end\nend\n"
                "EXT1[[\"外部A\"]]\nEXT2[[\"外部B\"]]\n"
                "EXT1 -->|回调| ING\nING -->|路由| C1\nING -->|路由| C2\n"
                "C1 -->|回调| EXT2\nC2 -->|回调| EXT2\n")
    p = run([t4b, "--type", "arch", "--check"])
    check("T4b 无法消除的骑跨明确降级（拒绝产图）", p.returncode != 0,
          (p.stderr or "").strip()[:80])

    # ── T5 极端输入：超长标签 / 空分组 / 状态徽标 ──
    t5 = os.path.join(tmp, "arch-t5-extreme.mmd")
    with open(t5, "w", encoding="utf-8") as f:
        f.write("flowchart TB\ntitle 极端输入\n"
                "subgraph 空层\nend\n"
                "subgraph 业务\n"
                "  X[\"超长中文名称测试节点｜这是一段非常长的次级职责描述文字用于测试尺寸计算\"]\n"
                "  Y[\"Long English Node Label For Size Testing｜secondary text for sizing｜试验中\"]\n"
                "end\nX -->|超长关系标签用于测试标签间隙与分轨行为| Y\n")
    p = run([t5, "--type", "arch", "--check"])
    rep5 = json.loads(p.stdout)
    check("T5 极端输入零溢出零碰撞（空分组被丢弃）", p.returncode == 0
          and rep5["textOverflow"] == 0 and rep5.get("labelCollisions") == 0
          and rep5["nodes"] == 2, str({k: rep5.get(k) for k in ("nodes", "textOverflow", "labelCollisions")}))

    # ── 形态超限降级：嵌套过深 / 多系统边界 ──
    bad_deep = os.path.join(tmp, "arch-bad-deep.mmd")
    with open(bad_deep, "w", encoding="utf-8") as f:
        f.write("flowchart TD\nsubgraph A\n  subgraph B\n    subgraph C\n      X[\"节点\"]\n    end\n  end\nend\n")
    p = run([bad_deep, "--type", "arch", "--check"])
    check("arch 降级：subgraph 嵌套超过两层明确报错", p.returncode != 0 and "形态超限" in (p.stderr or ""), (p.stderr or "").strip()[:80])

    bad_mb = os.path.join(tmp, "arch-bad-multibound.mmd")
    with open(bad_mb, "w", encoding="utf-8") as f:
        f.write("flowchart TD\nsubgraph A\n  subgraph A1\n    X[\"节点\"]\n  end\nend\n"
                "subgraph B\n  subgraph B1\n    Y[\"节点\"]\n  end\nend\n")
    p = run([bad_mb, "--type", "arch", "--check"])
    check("arch 降级：多个系统边界明确报错", p.returncode != 0 and "形态超限" in (p.stderr or ""), (p.stderr or "").strip()[:80])

    # ── 形态超限降级 ──
    bad1 = os.path.join(tmp, "arch-bad-decision.mmd")
    with open(bad1, "w", encoding="utf-8") as f:
        f.write("flowchart TD\nsubgraph A\n  X{判断？}\nend\n")
    p = run([bad1, "--type", "arch", "--check"])
    check("arch 降级：decision 菱形明确报错", p.returncode != 0 and "形态超限" in (p.stderr or ""), (p.stderr or "").strip()[:80])

    bad2 = os.path.join(tmp, "arch-bad-lanes.mmd")
    with open(bad2, "w", encoding="utf-8") as f:
        f.write("flowchart TD\n" + "\n".join(
            "subgraph L%d\n  N%d[\"节点%d\"]\nend" % (i, i, i) for i in range(7)))
    p = run([bad2, "--type", "arch", "--check"])
    check("arch 降级：泳道数超限明确报错", p.returncode != 0 and "形态超限" in (p.stderr or ""), (p.stderr or "").strip()[:80])

    # ── emoji 拒绝 ──
    bad4 = os.path.join(tmp, "arch-emoji.mmd")
    with open(bad4, "w", encoding="utf-8") as f:
        f.write("flowchart TD\nsubgraph A\n  P1[\"甲🚀\"]\nend\n")
    p = run([bad4, "--type", "arch", "--check"])
    check("arch emoji 输入被拒绝", p.returncode != 0, (p.stderr or "").strip()[:80])


if __name__ == "__main__":
    results = []

    def check(name, ok, detail=""):
        results.append((name, bool(ok), detail))
        print("%s %s%s" % ("PASS" if ok else "FAIL", name, ("  [%s]" % detail) if detail and not ok else ""))

    tmp = tempfile.mkdtemp(prefix="flowcanvas-arch-")
    section(check, tmp, run)
    fails = [r for r in results if not r[1]]
    print("\n%d/%d 通过" % (len(results) - len(fails), len(results)))
    sys.exit(1 if fails else 0)
