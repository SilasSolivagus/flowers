#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""blueprint 布局 golden 自检（可独立运行；selftest.py 集成时调用 section(check, tmp, run)）。

blueprint 尚未来得及接入 flowlayout.py 的 --type 分发，因此本自检不走 CLI，
而是用 subprocess 调 `python3 -c` 内联 import layout_blueprint 直接执行 layout。
"""
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

GOLDENS = ["blueprint-enterprise"]

INLINE = r'''
import sys, json
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
sys.path.insert(0, {here!r})
import layout_blueprint as m
from flowcommon import find_emoji
try:
    spec = m.load_spec({src!r})
    bad = []
    for label in m.iter_labels(spec):
        bad += find_emoji(label)
    if bad:
        print(json.dumps(dict(ok=False, err="emoji:%s" % bad), ensure_ascii=False))
    else:
        lay = m.layout(spec)
        rep = dict(nodes=len(spec["nodes"]), edges=len(spec["edges"]),
                   crossings=len(lay["crossings"]), overlaps=len(lay["overlaps"]),
                   textOverflow=len(lay["textOverflow"]),
                   labelCollisions=len(lay.get("labelCollisions", [])),
                   hasLabelCollisions=("labelCollisions" in lay),
                   metrics=lay.get("metrics", {{}}),
                   warnings=lay["warnings"],
                   canvas=[int(lay["W"]), int(lay["H"])])
        svg = m.render_svg(lay)
        print(json.dumps(dict(ok=True, rep=rep, svg=svg), ensure_ascii=False))
except SystemExit as e:
    print(json.dumps(dict(ok=False, err=str(e)), ensure_ascii=False))
'''


def run_layout(src_path):
    code = INLINE.format(here=HERE, src=src_path)
    p = subprocess.run([sys.executable, "-c", code],
                       capture_output=True, text=True, encoding="utf-8")
    try:
        return json.loads(p.stdout)
    except Exception:
        return {"ok": False, "err": (p.stderr or p.stdout or "no-output").strip()[:200]}


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
    # ── T3 golden：能力全景图（≥6 band / ≥8 domain / 50–80 模块合成数据）──
    for name in GOLDENS:
        src = os.path.join(ROOT, "examples", name + ".mmd")
        r = run_layout(src)
        check("blueprint %s 布局器运行" % name, r.get("ok"), r.get("err", "")[:120])
        if r.get("ok"):
            rep = r["rep"]
            check("blueprint %s 节点数 50–80" % name, 50 <= rep["nodes"] <= 80, str(rep["nodes"]))
            check("blueprint %s 零交叉" % name, rep["crossings"] == 0, str(rep["crossings"]))
            check("blueprint %s 零重叠" % name, rep["overlaps"] == 0, str(rep["overlaps"]))
            check("blueprint %s 零文字溢出" % name, rep["textOverflow"] == 0, str(rep["textOverflow"]))
            check("blueprint %s 零标签碰撞" % name, rep["labelCollisions"] == 0, str(rep["labelCollisions"]))
            check("blueprint %s 画布尺寸为整数" % name,
                  all(isinstance(v, int) for v in rep["canvas"]), str(rep["canvas"]))
            svg_text = r["svg"]
            check("blueprint %s SVG 带 data-blueprintspec 契约版本" % name,
                  'data-blueprintspec="4"' in svg_text)
            for cls in ("band", "domain", "rail", "legend", "todo"):
                check("blueprint %s SVG 含 class=%s" % (name, cls),
                      'class="%s"' % cls in svg_text)
            check("blueprint %s 含 band-title" % name, 'class="band-title"' in svg_text)
            check("blueprint %s 含 domain-title" % name, 'class="domain-title"' in svg_text)
            check("blueprint %s 含域名" % name, "交易域" in svg_text and "渠道" in svg_text)
            fss = [int(x) for x in re.findall(r'font-size="(\d+)"', svg_text)]
            check("blueprint %s 字号硬阈值 ≥ 10px" % name,
                  bool(fss) and min(fss) >= 10, str(sorted(set(fss))))
            colors = set(re.findall(r'data-color="([^"]+)"', svg_text))
            check("blueprint %s 浅色分域 ≥ 3 种 data-color" % name, len(colors) >= 3, str(len(colors)))
            # ── 紧凑度硬指标（防画布膨胀回归）──
            metrics = rep.get("metrics", {})
            W, H = rep["canvas"]
            check("blueprint %s 画布正常桌面范围（≤2000×1500）" % name,
                  W <= 2000 and H <= 1500, str([W, H]))
            check("blueprint %s centralFillX ≥ 0.60" % name,
                  metrics.get("centralFillX", 0) >= 0.60, str(metrics.get("centralFillX")))
            check("blueprint %s rail 紧邻中央区（≤2×间距）" % name,
                  metrics.get("railDistance", 999) <= 48, str(metrics.get("railDistance")))
            check("blueprint %s 无大面积纯空白（maxHorizontalGap ≤ 中央宽一半）" % name,
                  metrics.get("maxHorizontalGap", 999) <= max(W * 0.5, 1),
                  str(metrics.get("maxHorizontalGap")))
            check("blueprint %s 画布比例诚实（0.5–2.5，不靠纯空白扩宽）" % name,
                  0.5 <= metrics.get("canvasAspect", 0) <= 2.5, str(metrics.get("canvasAspect")))
            check("blueprint %s contentFill ≥ 0.2" % name,
                  metrics.get("contentFill", 0) >= 0.2, str(metrics.get("contentFill")))
            ok_ext, detail = _extent_ok(svg_text)
            check("blueprint %s 元素不越画布（右缘不裁剪）" % name, ok_ext, detail)
            emoji = [ch for ch in svg_text
                     if 0x1F000 <= ord(ch) <= 0x1FAFF or 0x2600 <= ord(ch) <= 0x27BF]
            check("blueprint %s 产物无 emoji" % name, not emoji, "".join(emoji[:5]))

    # ── T4 跨层集成（blueprint 侧）：外部系统 + 同步/异步 + 跨 band + 回路 ──
    t4 = os.path.join(tmp, "bp-t4.mmd")
    with open(t4, "w", encoding="utf-8") as f:
        f.write("blueprint LR\n"
                "title 跨层集成\nview blueprint\nscope 合成数据\n"
                "band 接入层\n  domain 渠道\n    A[\"前端\"]\n  end\nend\n"
                "band 平台层\n  domain 交易\n    B[\"订单\"]\n    C[\"支付\"]\n  end\nend\n"
                "band 支撑层\n  domain 服务\n    D[\"消息\"]\n  end\nend\n"
                "rail left\n  E[[\"外部网关\"]]\nend\n"
                "rel E -->|HTTPS| A\n"
                "rel A -->|调用| B\n"
                "rel B -.->|事件| D\n"
                "rel D -.->|回执| B\n")
    r = run_layout(t4)
    check("blueprint T4 跨层集成运行", r.get("ok"), r.get("err", "")[:120])
    if r.get("ok"):
        rep = r["rep"]
        check("blueprint T4 四项全 0",
              rep["crossings"] == 0 and rep["overlaps"] == 0
              and rep["textOverflow"] == 0 and rep["labelCollisions"] == 0,
              "c=%d o=%d t=%d l=%d" % (rep["crossings"], rep["overlaps"],
                                       rep["textOverflow"], rep["labelCollisions"]))
        svg_text = r["svg"]
        check("blueprint T4 异步边为虚线空心箭头",
              "stroke-dasharray" in svg_text and "arw-open" in svg_text)
        check("blueprint T4 外部系统虚线框",
              'data-style="external"' in svg_text and "stroke-dasharray" in svg_text)
        ok_ext, detail = _extent_ok(svg_text)
        check("blueprint T4 元素不越画布", ok_ext, detail)

    # ── T5 极端输入 ──
    # 超长中英文模块名（>20 字符，换行后无溢出且成功）
    t5a = os.path.join(tmp, "bp-longname.mmd")
    with open(t5a, "w", encoding="utf-8") as f:
        f.write("blueprint LR\n"
                "band 层\n  domain 域\n"
                "    L1[\"这是一个非常非常长的中文模块名称用于测试换行行为\"]\n"
                "    L2[\"ExtraordinaryLongEnglishModuleNameTest\"]\n"
                "  end\nend\n")
    r = run_layout(t5a)
    check("blueprint T5 超长模块名成功且换行后无溢出",
          r.get("ok") and r["rep"]["textOverflow"] == 0, r.get("err", "")[:80])

    # 空 domain/band 被丢弃且成功
    t5b = os.path.join(tmp, "bp-empty.mmd")
    with open(t5b, "w", encoding="utf-8") as f:
        f.write("blueprint LR\n"
                "band 空层\n  domain 空域\n  end\nend\n"
                "band 实层\n  domain 实域\n    X[\"模块\"]\n  end\nend\n")
    r = run_layout(t5b)
    check("blueprint T5 空 domain/band 被丢弃且成功",
          r.get("ok") and r["rep"]["nodes"] == 1, r.get("err", "")[:80])

    # 重复 rail 报形态超限
    t5c = os.path.join(tmp, "bp-dup-rail.mmd")
    with open(t5c, "w", encoding="utf-8") as f:
        f.write("blueprint LR\nrail left\n  A[\"甲\"]\nend\nrail left\n  B[\"乙\"]\nend\n")
    r = run_layout(t5c)
    check("blueprint T5 重复 rail 报形态超限",
          not r.get("ok") and "形态超限" in r.get("err", ""), r.get("err", "")[:80])

    # rel 引用未定义模块报形态超限
    t5d = os.path.join(tmp, "bp-undef-rel.mmd")
    with open(t5d, "w", encoding="utf-8") as f:
        f.write("blueprint LR\nband 层\n  domain 域\n    X[\"模块\"]\n  end\nend\n"
                "rel X -->|x| Y\n")
    r = run_layout(t5d)
    check("blueprint T5 rel 引用未定义模块报形态超限",
          not r.get("ok") and "形态超限" in r.get("err", ""), r.get("err", "")[:80])

    # 孤儿锚点双向警告
    t5e = os.path.join(tmp, "bp-orphan.mmd")
    with open(t5e, "w", encoding="utf-8") as f:
        f.write("blueprint LR\ntodo [A9] 无人引用\ntodo [A1] 被引用\n"
                "band 层\n  domain 域\n    X[\"模块 [A1]\"]\n    Y[\"模块 [A2]\"]\n  end\nend\n")
    r = run_layout(t5e)
    check("blueprint T5 孤儿注释/孤儿锚点双向警告",
          r.get("ok") and any("未挂接" in w and "A9" in w for w in r["rep"]["warnings"])
          and any("没有对应的 todo" in w and "A2" in w for w in r["rep"]["warnings"]),
          str(r["rep"]["warnings"]) if r.get("ok") else r.get("err", "")[:80])

    # emoji 拒绝
    t5f = os.path.join(tmp, "bp-emoji.mmd")
    with open(t5f, "w", encoding="utf-8") as f:
        f.write("blueprint LR\nband 层\n  domain 域\n    P1[\"甲🚀\"]\n  end\nend\n")
    r = run_layout(t5f)
    check("blueprint T5 emoji 输入被拒绝", not r.get("ok"), r.get("err", "")[:80])

    # 非法 view 报错（只接受 blueprint）
    t5g = os.path.join(tmp, "bp-bad-view.mmd")
    with open(t5g, "w", encoding="utf-8") as f:
        f.write("blueprint LR\nview container\nband 层\n  domain 域\n    X[\"模块\"]\n  end\nend\n")
    r = run_layout(t5g)
    check("blueprint T5 非法 view 报形态超限",
          not r.get("ok") and "形态超限" in r.get("err", ""), r.get("err", "")[:80])

    # 模块标签层级 >3 报形态超限
    t5h = os.path.join(tmp, "bp-deep-label.mmd")
    with open(t5h, "w", encoding="utf-8") as f:
        f.write("blueprint LR\nband 层\n  domain 域\n    X[\"名｜次｜状｜超\"]\n  end\nend\n")
    r = run_layout(t5h)
    check("blueprint T5 标签层级超过 3 报形态超限",
          not r.get("ok") and "形态超限" in r.get("err", ""), r.get("err", "")[:80])

    # ── T6 关系路由压力：rail↔中央 + 长跨 band + 同间隙竞争 + 同步/异步回路 ──
    t6 = os.path.join(tmp, "bp-routing.mmd")
    with open(t6, "w", encoding="utf-8") as f:
        f.write("blueprint LR\n"
                "title 关系路由压力\nview blueprint\nscope 合成数据\n"
                "band L1\n  domain D1\n    A1[\"A1\"]\n    A2[\"A2\"]\n    A3[\"A3\"]\n  end\nend\n"
                "band L2\n  domain D2\n    B1[\"B1\"]\n    B2[\"B2\"]\n    B3[\"B3\"]\n  end\nend\n"
                "band L3\n  domain D3\n    C1[\"C1\"]\n    C2[\"C2\"]\n    C3[\"C3\"]\n  end\nend\n"
                "band L4\n  domain D4\n    D1[\"D1\"]\n    D2[\"D2\"]\n    D3[\"D3\"]\n  end\nend\n"
                "rail left\n  E[[\"外部网关\"]]\nend\n"
                "rail right\n  Q[\"治理\"]\nend\n"
                "rel E -->|调用| A1\n"
                "rel Q -.->|审计| C3\n"
                "rel A1 -->|调用| B1\n"
                "rel A2 -->|调用| B2\n"
                "rel A3 -->|调用| B3\n"
                "rel B1 -->|调用| C1\n"
                "rel B2 -.->|事件| C2\n"
                "rel B3 -->|调用| C3\n"
                "rel A2 -->|长跨| D2\n"
                "rel D1 -.->|心跳| A1\n")
    r = run_layout(t6)
    check("blueprint T6a 关系路由压力运行", r.get("ok"), r.get("err", "")[:120])
    if r.get("ok"):
        rep = r["rep"]
        check("blueprint T6a 四项全 0（10 条关系）",
              rep["crossings"] == 0 and rep["overlaps"] == 0
              and rep["textOverflow"] == 0 and rep["labelCollisions"] == 0
              and rep["edges"] == 10,
              "c=%d o=%d t=%d l=%d e=%d" % (rep["crossings"], rep["overlaps"],
                                            rep["textOverflow"], rep["labelCollisions"],
                                            rep["edges"]))
        svg_text = r["svg"]
        check("blueprint T6a 同步实线 + 异步虚线", "arw" in svg_text and "arw-open" in svg_text
              and "stroke-dasharray" in svg_text)
        ok_ext, detail = _extent_ok(svg_text)
        check("blueprint T6a 元素不越画布", ok_ext, detail)

    # T6b：全量 13 边密集回路（3 条竞争同间隙 + 双向回路 + 双长跨）——诚实降级拒绝产图
    t6b = os.path.join(tmp, "bp-routing-dense.mmd")
    with open(t6b, "w", encoding="utf-8") as f:
        f.write("blueprint LR\n"
                "title 关系路由压力全量\nview blueprint\nscope 合成数据\n"
                "band L1\n  domain D1\n    A1[\"A1\"]\n    A2[\"A2\"]\n    A3[\"A3\"]\n  end\nend\n"
                "band L2\n  domain D2\n    B1[\"B1\"]\n    B2[\"B2\"]\n    B3[\"B3\"]\n  end\nend\n"
                "band L3\n  domain D3\n    C1[\"C1\"]\n    C2[\"C2\"]\n    C3[\"C3\"]\n  end\nend\n"
                "band L4\n  domain D4\n    D1[\"D1\"]\n    D2[\"D2\"]\n    D3[\"D3\"]\n  end\nend\n"
                "rail left\n  E[[\"外部网关\"]]\nend\n"
                "rail right\n  Q[\"治理\"]\nend\n"
                "rel E -->|调用| A1\n"
                "rel Q -.->|审计| C3\n"
                "rel A1 -->|调用| B1\n"
                "rel A2 -->|调用| B2\n"
                "rel A3 -->|调用| B3\n"
                "rel B1 -->|调用| C1\n"
                "rel B2 -.->|事件| C2\n"
                "rel B3 -->|调用| C3\n"
                "rel A1 -->|直达| C1\n"
                "rel A2 -->|长跨| D2\n"
                "rel C1 -->|回执| B1\n"
                "rel C2 -->|回执| B2\n"
                "rel D1 -.->|心跳| A1\n")
    r = run_layout(t6b)
    check("blueprint T6b 密集回路（13 条）在 stacked 模式零交叉成功",
          r.get("ok") and r["rep"]["crossings"] == 0 and r["rep"]["overlaps"] == 0
          and r["rep"]["textOverflow"] == 0 and r["rep"]["labelCollisions"] == 0,
          r.get("err", "")[:80] if not r.get("ok") else "c=%d o=%d t=%d l=%d"
          % (r["rep"]["crossings"], r["rep"]["overlaps"],
             r["rep"]["textOverflow"], r["rep"]["labelCollisions"]))

    # ── 语义与版式：layout 模式 / section / rail 标题 / 图形类型 ──
    lay_src = os.path.join(ROOT, "examples", "blueprint-layered.mmd")
    r = run_layout(lay_src)
    check("blueprint stacked 分层架构样例运行", r.get("ok"), r.get("err", "")[:120])
    if r.get("ok"):
        svg_text = r["svg"]
        ys = [float(v) for v in re.findall(r'<text x="[\d.]+" y="([\d.]+)"[^>]*class="band-title">',
                                           svg_text)]
        check("blueprint stacked band 自上而下声明序", len(ys) >= 4 and all(a < b for a, b in zip(ys, ys[1:])),
              str(ys))
        # stacked 单列：无多列 section 折叠（section 关键字在 stacked 下报错）
        rep = r["rep"]
        check("blueprint stacked 中央宽 = 最宽 band（无多列折叠）",
              rep["metrics"]["canvasAspect"] < 1.0, str(rep["metrics"]["canvasAspect"]))
        # 标题逐字使用 DSL title；图种显示分层架构
        check("blueprint stacked 标题逐字（DSL title 不被覆盖）", "分层企业架构图" in svg_text)
        check("blueprint stacked 图种显示分层架构", "图种：分层架构" in svg_text)
        # 等宽完整水平层：band 背景矩形同宽
        widths = [float(w) for w in re.findall(r'<g class="band"[^>]*>\s*<rect x="[\d.]+" y="[\d.]+" width="([\d.]+)" height="[\d.]+" rx="4" fill="#f7f7f7"', svg_text)]
        check("blueprint stacked 所有 band 等宽完整水平层",
              len(widths) >= 4 and max(widths) - min(widths) < 1.0, str(widths))
        # 层间距 16–24
        check("blueprint stacked 层间距 ≤24（maxVerticalGap）",
              rep["metrics"]["maxVerticalGap"] <= 4, str(rep["metrics"]["maxVerticalGap"]))

    # grid 模式：标题逐字 + 图种能力地图 + 左对齐（无二次居中）+ 标题条
    grid_src = os.path.join(ROOT, "examples", "blueprint-enterprise.mmd")
    r = run_layout(grid_src)
    if r.get("ok"):
        svg_text = r["svg"]
        check("blueprint grid 标题逐字（DSL title 不被覆盖）",
              "企业应用架构全景图（能力地图）" in svg_text)
        check("blueprint grid 图种显示能力地图", "图种：能力地图" in svg_text)
        check("blueprint grid 目标宽高比 1.2–2.6", 
              1.2 <= r["rep"]["metrics"]["canvasAspect"] <= 2.6,
              str(r["rep"]["metrics"]["canvasAspect"]))
        n_store = len(re.findall(r'data-style="datastore"', svg_text))
        check("blueprint grid 数据存储符号数量正确（6 个真实存储）", n_store == 6, str(n_store))
        check("blueprint grid rail 带栏标题", 'class="rail-title"' in svg_text
              and "外部生态" in svg_text and "治理保障" in svg_text)
        m = re.search(r'<g class="rail" id="bp-rail-left">\s*<rect x="[\d.]+" y="([\d.]+)" width="[\d.]+" height="([\d.]+)"', svg_text)
        if m:
            check("blueprint grid rail 贯穿主体高度（>400px）", float(m.group(2)) > 400, m.group(2))
        # 跨宽标题条 + 固定列起点左对齐（无二次居中）
        check("blueprint grid 标题条存在（titlebar）", svg_text.count('fill="#f0f0f0"') >= 6)
        # 首个 section 的 domain 左缘 == 列起点（左对齐）
        m2 = re.search(r'<g class="domain"[^>]*>\s*<rect x="([\d.]+)"', svg_text)
        if m2:
            m3 = re.search(r'<g class="band"[^>]*>\s*<rect x="([\d.]+)"', svg_text)
            check("blueprint grid 左对齐（首个 domain 左缘 = 列起点）",
                  m3 and abs(float(m2.group(1)) - float(m3.group(1))) < 2.0,
                  "%s vs %s" % (m2.group(1), m3.group(1) if m3 else "?"))

    # 模式误用：grid 下 band 报形态超限；stacked 下 section 报形态超限
    bad1 = os.path.join(tmp, "bp-band-in-grid.mmd")
    with open(bad1, "w", encoding="utf-8") as f:
        f.write("blueprint LR\nlayout grid\nband 层\n  domain 域\n    X[\"模块\"]\n  end\nend\n")
    r = run_layout(bad1)
    check("blueprint grid 模式用 band 报形态超限",
          not r.get("ok") and "形态超限" in r.get("err", ""), r.get("err", "")[:80])
    bad2 = os.path.join(tmp, "bp-section-in-stacked.mmd")
    with open(bad2, "w", encoding="utf-8") as f:
        f.write("blueprint LR\nlayout stacked\nsection 块\n  domain 域\n    X[\"模块\"]\n  end\nend\n")
    r = run_layout(bad2)
    check("blueprint stacked 模式用 section 报形态超限",
          not r.get("ok") and "形态超限" in r.get("err", ""), r.get("err", "")[:80])

    # 无标题 rail：警告降级为普通外部域
    bad3 = os.path.join(tmp, "bp-rail-notitle.mmd")
    with open(bad3, "w", encoding="utf-8") as f:
        f.write("blueprint LR\nlayout grid\nsection 块\n  domain 域\n    X[\"模块\"]\n  end\nend\n"
                "rail left\n  E[[\"外部\"]]\nend\n")
    r = run_layout(bad3)
    check("blueprint 无标题 rail 出警告且降级",
          r.get("ok") and any("未命名" in w for w in r["rep"]["warnings"]),
          str(r["rep"]["warnings"]) if r.get("ok") else r.get("err", "")[:80])

    # ── 直接 import 测试：layout() 产物含 labelCollisions 字段 ──
    code = ('import sys; sys.path.insert(0, %r)\n'
            'import layout_blueprint as m\n'
            'spec = m.load_spec(%r)\n'
            'lay = m.layout(spec)\n'
            'print("labelCollisions" in lay)\n'
            % (HERE, os.path.join(ROOT, "examples", "blueprint-enterprise.mmd")))
    p = subprocess.run([sys.executable, "-c", code],
                       capture_output=True, text=True, encoding="utf-8")
    check("blueprint 直接 import：layout() 含 labelCollisions 字段",
          p.returncode == 0 and p.stdout.strip() == "True", (p.stdout + p.stderr).strip()[:80])


if __name__ == "__main__":
    results = []

    def check(name, ok, detail=""):
        results.append((name, bool(ok), detail))
        print("%s %s%s" % ("PASS" if ok else "FAIL", name,
                           ("  [%s]" % detail) if detail and not ok else ""))

    tmp = tempfile.mkdtemp(prefix="flowcanvas-blueprint-")
    section(check, tmp, None)
    fails = [r for r in results if not r[1]]
    print("\n%d/%d 通过" % (len(results) - len(fails), len(results)))
    sys.exit(1 if fails else 0)
