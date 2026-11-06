#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""flow-canvas 多图类型共享基础件（零依赖，Python 3.8+ 标准库）。

flowchart / arch / er / gantt / seq 五类布局模块共用的文本度量、几何质检、
路由辅助、SVG 原语、统一检查报告与通用 CLI 骨架。各模块从本文件导入，
不在模块内复制实现。

统一布局产物字典（各类型 layout() 返回，渲染 / 报告 / 质检均消费此结构）：

  nodes       : {id: {...节点数据..., "x","y","w","h"}}   包围盒中心坐标 (x,y) + 宽高
  order       : [id]                                       渲染顺序
  routes      : [{"pts": [(x,y), ...], "label": [..],
                  "lx": float|None, "ly": float|None,
                  "anchor": "start|middle|end", "arrow": bool}]
  extra       : dict                                       类型专属渲染数据（时间轴、属性行、泳道等）
  W, H        : int                                        画布尺寸
  style       : dict                                       样式变量（可被 --style 覆盖）
  crossings   : [{"at":[x,y], "r1":i, "r2":j}]             线段交叉
  overlaps    : [{"ids":[a,b]}]                            包围盒重叠
  textOverflow: [{"id","line","text","need","avail"}]      文字溢出
  warnings    : [str]

统一检查报告 build_report（--check 输出，全部类型一致）：

  {"nodes", "edges", "crossings", "overlaps", "textOverflow", "warnings", "canvas"}

质量红线：crossings / overlaps / textOverflow 任一非 0 即不合格，调用方应降级、
不交付产物。
"""
import argparse
import os
import json
import sys
import unicodedata

DEFAULT_FONT = "-apple-system, PingFang SC, Segoe UI, Microsoft YaHei, sans-serif"

# 新类型布局模块的公共样式基线；各模块可增补自己需要的键。
COMMON_STYLE = {
    "font_family": DEFAULT_FONT,
    "fs_node": 13,
    "fs_sub": 11,
    "fs_label": 11,
    "edge_color": "#555555",
    "label_color": "#888888",
    "stroke": "#333333",
    "fill": "#ffffff",
    "fill_alt": "#f4f4f4",
    "text": "#333333",
}

EMOJI_RANGES = [
    (0x1F000, 0x1FAFF), (0x2600, 0x27BF), (0x2B00, 0x2BFF),
    (0xFE0F, 0xFE0F), (0x2705, 0x2705), (0x274C, 0x274C),
    (0x2714, 0x2714), (0x2716, 0x2716),
]


# ── 文本度量 ────────────────────────────────────────────────────────
def find_emoji(text):
    return [ch for ch in text if any(a <= ord(ch) <= b for a, b in EMOJI_RANGES)]


def text_width(s, fs):
    """按字符宽度估算文本像素宽（全角 1.0、半角 0.55），留 8% buffer 兜字体差异。"""
    w = 0.0
    for ch in s:
        w += fs * (1.0 if unicodedata.east_asian_width(ch) in ("F", "W") else 0.55)
    return w * 1.08


def wrap_label(lines, limit=13):
    out = []
    for l in lines:
        while len(l) > limit:
            out.append(l[:limit])
            l = l[limit:]
        out.append(l)
    return out


def node_size(n, st):
    """流程图形状感知的默认节点尺寸（decision 扁菱形 / 其余矩形）；
    其他类型可复用于通用矩形节点，或按自己规则计算。"""
    fs = st["fs_node"]
    lines = n["label"]
    widths = [text_width(l, fs if i == 0 or n["type"] != "process" else st["fs_sub"])
              for i, l in enumerate(lines)]
    tw = max(widths) if widths else 40
    nl = len(lines)
    if n["type"] == "decision":
        w = max(150, tw * 1.55 + 24)
        h = max(64, nl * (fs + 6) + 44)
    else:
        w = max(120, tw + 30)
        h = max(36, nl * (fs + 5) + 18)
    return round(w / 2) * 2, round(h / 2) * 2


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# ── 几何质检 ────────────────────────────────────────────────────────
def ortho_crossings(routes):
    """正交（水平/垂直）折线之间的交叉检测；返回 [{"at":[x,y],"r1":i,"r2":j}]。

    同一 route 内的线段不互查；H×H、V×V 不查；仅在端点相接（T 形汇入）不算交叉。
    """
    segs = []
    for ri, r in enumerate(routes):
        p = r["pts"]
        for i in range(len(p) - 1):
            segs.append((p[i], p[i + 1], ri))
    crossings = []
    for i in range(len(segs)):
        for j in range(i + 1, len(segs)):
            (a1, a2, r1), (b1, b2, r2) = segs[i], segs[j]
            if r1 == r2:
                continue
            ah = abs(a1[1] - a2[1]) < 0.01
            bh = abs(b1[1] - b2[1]) < 0.01
            if ah == bh:
                continue
            hseg, vseg = ((a1, a2), (b1, b2)) if ah else ((b1, b2), (a1, a2))
            hy = hseg[0][1]
            hx1, hx2 = sorted((hseg[0][0], hseg[1][0]))
            vx = vseg[0][0]
            vy1, vy2 = sorted((vseg[0][1], vseg[1][1]))
            if hx1 < vx < hx2 and vy1 < hy < vy2:
                endpoints = [hseg[0], hseg[1], vseg[0], vseg[1]]
                if any(abs(px - vx) < 0.01 and abs(py - hy) < 0.01 for px, py in endpoints):
                    continue
                crossings.append({"at": [round(vx), round(hy)], "r1": r1, "r2": r2})
    return crossings


def _seg_intersect_params(a1, a2, b1, b2, eps=1e-9):
    r = (a2[0] - a1[0], a2[1] - a1[1])
    s = (b2[0] - b1[0], b2[1] - b1[1])
    denom = r[0] * s[1] - r[1] * s[0]
    if abs(denom) < eps:
        return None
    qp = (b1[0] - a1[0], b1[1] - a1[1])
    t = (qp[0] * s[1] - qp[1] * s[0]) / denom
    u = (qp[0] * r[1] - qp[1] * r[0]) / denom
    return t, u


def line_crossings(routes, eps=1e-6):
    """一般线段交叉检测（含斜线；ER 直连边等用）。端点相接不算交叉；
    共线重叠（两条线段在同一走廊上视觉重叠）算交叉。"""
    segs = []
    for ri, r in enumerate(routes):
        p = r["pts"]
        for i in range(len(p) - 1):
            segs.append((p[i], p[i + 1], ri))
    out = []
    for i in range(len(segs)):
        for j in range(i + 1, len(segs)):
            (a1, a2, r1), (b1, b2, r2) = segs[i], segs[j]
            if r1 == r2:
                continue
            rv = (a2[0] - a1[0], a2[1] - a1[1])
            sv = (b2[0] - b1[0], b2[1] - b1[1])
            cross = rv[0] * sv[1] - rv[1] * sv[0]
            if abs(cross) < eps:
                # 平行：检查共线重叠（水平 / 垂直走廊上的视觉重叠）
                if abs(a1[1] - a2[1]) < eps and abs(b1[1] - b2[1]) < eps \
                        and abs(a1[1] - b1[1]) < eps:
                    ax = sorted((a1[0], a2[0]))
                    bx = sorted((b1[0], b2[0]))
                    if ax[0] < bx[1] - eps and bx[0] < ax[1] - eps:
                        mid = (max(ax[0], bx[0]) + min(ax[1], bx[1])) / 2
                        out.append({"at": [round(mid), round(a1[1])], "r1": r1, "r2": r2})
                        continue
                if abs(a1[0] - a2[0]) < eps and abs(b1[0] - b2[0]) < eps \
                        and abs(a1[0] - b1[0]) < eps:
                    ay = sorted((a1[1], a2[1]))
                    by = sorted((b1[1], b2[1]))
                    if ay[0] < by[1] - eps and by[0] < ay[1] - eps:
                        mid = (max(ay[0], by[0]) + min(ay[1], by[1])) / 2
                        out.append({"at": [round(a1[0]), round(mid)], "r1": r1, "r2": r2})
                continue
            pr = _seg_intersect_params(a1, a2, b1, b2)
            if pr is None:
                continue
            t, u = pr
            if eps < t < 1 - eps and eps < u < 1 - eps:
                out.append({"at": [round(a1[0] + t * (a2[0] - a1[0])),
                                   round(a1[1] + t * (a2[1] - a1[1]))],
                            "r1": r1, "r2": r2})
    return out


def box_overlaps(boxes, tol=1.0):
    """轴对齐矩形重叠检测。boxes: [(key, cx, cy, w, h)]（中心坐标）；
    返回 [{"ids":[k1,k2]}]。贴边（间隔 < tol 视为贴边）不算重叠。"""
    out = []
    for i in range(len(boxes)):
        for j in range(i + 1, len(boxes)):
            k1, x1, y1, w1, h1 = boxes[i]
            k2, x2, y2, w2, h2 = boxes[j]
            if abs(x1 - x2) < (w1 + w2) / 2 - tol and abs(y1 - y2) < (h1 + h2) / 2 - tol:
                out.append({"ids": [k1, k2]})
    return out


def text_overflow_check(nodes, order, metrics=None):
    """文字溢出检测。metrics(node, line_index) -> (font_size, avail_width)；
    缺省按矩形盒：fs = node.get("fs", 13)，可用宽 = w - 10。
    返回 [{"id","line","text","need","avail"}]。"""
    out = []
    for nid in order:
        n = nodes[nid]
        for j, t in enumerate(n["label"]):
            if metrics:
                fs, avail = metrics(n, j)
            else:
                fs, avail = n.get("fs", 13), n["w"] - 10
            need = text_width(t, fs)
            if need > avail:
                out.append({"id": nid, "line": j, "text": t,
                            "need": round(need), "avail": round(avail)})
    return out


# ── 路由辅助 ────────────────────────────────────────────────────────
def port(n, side):
    """节点包围盒（中心坐标）四边中点端口。"""
    x, y, w, h = n["x"], n["y"], n["w"], n["h"]
    return {"L": (x - w / 2, y), "R": (x + w / 2, y),
            "T": (x, y - h / 2), "B": (x, y + h / 2)}[side]


def ortho_path_hv(sx, sy, tx, ty, vx):
    """水平出发、在 x=vx 处垂直折返、水平进入的正交路径（3 段 4 点）。"""
    return [(sx, sy), (vx, sy), (vx, ty), (tx, ty)]


def t_merge_y(n, offset=18):
    """节点顶部上方 offset 处的 T 形汇入 y。"""
    return n["y"] - n["h"] / 2 - offset


# ── SVG 原语 ────────────────────────────────────────────────────────
def svg_open(w, h, data_attr, style):
    out = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" '
           'width="%d" height="%d" %s font-family="%s">'
           % (w, h, w, h, data_attr, style["font_family"])]
    # 主题画布底色（深色主题必需，浅色主题下与页面同色）
    if style.get("bg"):
        out.append('<rect x="0" y="0" width="%d" height="%d" fill="%s"/>'
                   % (w, h, style["bg"]))
    return out


def svg_close():
    return ["</svg>"]


def arrow_marker(style, mid="arw"):
    return ('<defs><marker id="%s" viewBox="0 0 10 10" refX="9" refY="5" '
            'markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
            '<path d="M0,0 L10,5 L0,10 z" fill="%s"/></marker></defs>'
            % (mid, style["edge_color"]))


def svg_text(x, y, fs, fill, anchor, t):
    return ('<text x="%g" y="%g" font-size="%d" fill="%s" text-anchor="%s">%s</text>'
            % (x, y, fs, fill, anchor, esc(t)))


# ── HTML 画布（缩放/拖拽/全屏壳，各类型共用） ──────────────────────────
HTML_SHELL = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>__TITLE__</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; background: #f7f7f7; font-family: __FONT__; color: #333; }
.wrap { display: flex; flex-direction: column; height: 100vh; padding: 16px; gap: 10px; }
.bar { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #888; }
.bar .t { font-size: 15px; font-weight: 700; color: #333; margin-right: auto; }
.zb { padding: 2px 10px; border: 1px solid #c0c0c0; border-radius: 4px; cursor: pointer; background: #fff; user-select: none; color: #333; }
.zv { min-width: 40px; text-align: center; }
.cv { flex: 1; min-height: 0; overflow: hidden; border: 1px solid #e0e0e0; border-radius: 6px; background: #fff; cursor: grab; touch-action: none; user-select: none; }
.cv:active { cursor: grabbing; }
.inner { transform-origin: 0 0; will-change: transform; }
.inner svg { width: 100%; height: auto; display: block; }
</style>
</head>
<body>
<div class="wrap">
  <div class="bar">
    <span class="t">__TITLE__</span>
    <span class="zb" onclick="setZoom(-1)">&#65293;</span>
    <span class="zv" id="zv">100%</span>
    <span class="zb" onclick="setZoom(1)">&#65291;</span>
    <span class="zb" onclick="setZoom(0)">适宽</span>
    <span class="zb" id="fsb" onclick="toggleFs()">全屏</span>
  </div>
  <div class="cv" id="cv"><div class="inner" id="inner">__SVG__</div></div>
</div>
<script>
var zoom = 100, px = 0, py = 0;
function apply() { document.getElementById('inner').style.transform = 'translate(' + px + 'px,' + py + 'px)'; }
function setZoom(d) {
  zoom = (d === 0) ? 100 : Math.min(300, Math.max(100, zoom + d * 40));
  if (d === 0) { px = 0; py = 0; apply(); }
  var svg = document.querySelector('#inner svg');
  if (svg) svg.style.width = zoom + '%';
  document.getElementById('zv').textContent = zoom + '%';
}
function toggleFs() {
  if (document.fullscreenElement) { document.exitFullscreen(); }
  else if (document.documentElement.requestFullscreen) { document.documentElement.requestFullscreen(); }
}
document.addEventListener('fullscreenchange', function () {
  document.getElementById('fsb').textContent = document.fullscreenElement ? '退出全屏' : '全屏';
});
(function () {
  var cv = document.getElementById('cv');
  var drag = false, sx = 0, sy = 0, ox = 0, oy = 0;
  cv.addEventListener('pointerdown', function (e) { drag = true; sx = e.clientX; sy = e.clientY; ox = px; oy = py; apply(); });
  window.addEventListener('pointermove', function (e) { if (!drag) return; px = ox + e.clientX - sx; py = oy + e.clientY - sy; apply(); });
  window.addEventListener('pointerup', function () { drag = false; });
})();
</script>
</body>
</html>
"""


def render_html(svg, title, font_family):
    return (HTML_SHELL.replace("__TITLE__", esc(title or "多图类型排版"))
            .replace("__FONT__", font_family)
            .replace("__SVG__", svg))


# ── 标签碰撞检测（archspec/5、blueprintspec/1 起启用）───────────────
def label_rect(lx, ly, text, fs, anchor="middle"):
    """标签文本包围盒（左上/右下）。anchor ∈ middle|start。"""
    w = text_width(text, fs)
    h = fs + 4
    if anchor == "start":
        return (lx, ly - h, lx + w, ly + 4)
    return (lx - w / 2, ly - h, lx + w / 2, ly + 4)


def _rects_overlap(a, b, tol=1.0):
    return (a[0] < b[2] - tol and b[0] < a[2] - tol
            and a[1] < b[3] - tol and b[1] < a[3] - tol)


def _seg_hits_rect(p1, p2, r, tol=1.0):
    """正交线段（水平/垂直）是否穿过矩形（含 tol 膨胀）。"""
    x0, y0, x1, y1 = r
    if abs(p1[1] - p2[1]) < 0.01:      # 水平段
        if not (y0 - tol < p1[1] < y1 + tol):
            return False
        sx, ex = sorted((p1[0], p2[0]))
        return sx < x1 + tol and ex > x0 - tol
    if abs(p1[0] - p2[0]) < 0.01:      # 垂直段
        if not (x0 - tol < p1[0] < x1 + tol):
            return False
        sy, ey = sorted((p1[1], p2[1]))
        return sy < y1 + tol and ey > y0 - tol
    return False


def label_collisions(routes, labels, boxes, reserved=None):
    """标签碰撞检测：文本×文本 / 文本×连线 / 文本×节点框 / 文本×预留区。

    labels:   [{"id","text","lx","ly","anchor","fs","route":ri|None,"own":[box_key...]}]
    boxes:    [(key, cx, cy, w, h)]（中心坐标）
    reserved: [(key, x0, y0, x1, y1)]（图例/待确认区/页眉等预留区域）
    返回 [{"id","with","kind"}]；kind ∈ text/line/box/reserved。
    标签自身所在路由与自身端点节点不参与（own/route 排除）。
    """
    rects = [(i, label_rect(l["lx"], l["ly"], l["text"], l["fs"], l["anchor"]))
             for i, l in enumerate(labels)]
    out = []
    for i in range(len(labels)):
        for j in range(i + 1, len(labels)):
            if _rects_overlap(rects[i][1], rects[j][1]):
                out.append({"id": labels[i]["id"], "with": labels[j]["id"], "kind": "text"})
    for i, l in enumerate(labels):
        r = rects[i][1]
        own = set(l.get("own") or [])
        for key, cx, cy, w, h in boxes:
            if key in own:
                continue
            if _rects_overlap(r, (cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)):
                out.append({"id": l["id"], "with": key, "kind": "box"})
        for key, x0, y0, x1, y1 in (reserved or []):
            if _rects_overlap(r, (x0, y0, x1, y1)):
                out.append({"id": l["id"], "with": key, "kind": "reserved"})
        for ri, rt in enumerate(routes):
            if ri == l.get("route"):
                continue
            for k in range(len(rt["pts"]) - 1):
                if _seg_hits_rect(rt["pts"][k], rt["pts"][k + 1], r):
                    out.append({"id": l["id"], "with": "route-%d" % ri, "kind": "line"})
                    break
    return out


def assign_label_lanes(rects, rows=4, step=13):
    """同带标签自动分轨：重叠则逐行上移（每标签返回 ly 偏移，先到先得）。"""
    off = [0.0] * len(rects)
    placed = []
    for i, (x0, y0, x1, y1) in enumerate(rects):
        k = 0
        while k < rows:
            cand = (x0, y0 - step * k, x1, y1 - step * k)
            if all(not _rects_overlap(cand, p) for p in placed):
                break
            k += 1
        off[i] = -step * k
        placed.append((x0, y0 - step * k, x1, y1 - step * k))
    return off


# ── 统一检查报告 ────────────────────────────────────────────────────

THEME_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))), "_theme")
DEFAULT_THEME = os.path.join(THEME_DIR, "default.style.json")


def load_style(path):
    """读取样式覆盖：显式 --style 优先，否则用 _theme/default.style.json。"""
    target = path or (DEFAULT_THEME if os.path.exists(DEFAULT_THEME) else None)
    if not target:
        return None
    try:
        with open(target, encoding="utf-8") as f:
            return json.load(f)
    except Exception as exc:
        raise SystemExit("错误：样式文件 %s 读取失败：%s" % (target, exc))

def build_report(n_nodes, n_edges, lay):
    report = {
        "nodes": n_nodes,
        "edges": n_edges,
        "crossings": len(lay["crossings"]),
        "crossing_points": lay["crossings"],
        "overlaps": len(lay["overlaps"]),
        "overlap_points": lay["overlaps"],
        "textOverflow": len(lay["textOverflow"]),
        "textOverflow_points": lay["textOverflow"],
        "warnings": list(lay["warnings"]),
        "canvas": [int(round(lay["W"])), int(round(lay["H"]))],
    }
    if lay["crossings"]:
        report["warnings"].append("检测到 %d 处线段交叉" % len(lay["crossings"]))
    if lay["overlaps"]:
        report["warnings"].append("检测到 %d 处节点重叠" % len(lay["overlaps"]))
    if lay["textOverflow"]:
        report["warnings"].append("检测到 %d 处文字溢出" % len(lay["textOverflow"]))
    if "labelCollisions" in lay:
        report["labelCollisions"] = len(lay["labelCollisions"])
        report["labelCollision_points"] = lay["labelCollisions"]
        if lay["labelCollisions"]:
            report["warnings"].append("检测到 %d 处标签碰撞" % len(lay["labelCollisions"]))
    if lay.get("metrics"):
        report["metrics"] = lay["metrics"]
    if lay.get("routeQuality"):
        report["routeQuality"] = lay["routeQuality"]
    return report


def is_clean(report):
    return not (report["crossings"] or report["overlaps"] or report["textOverflow"]
                or report.get("labelCollisions", 0))


# ── 通用 CLI 骨架 ───────────────────────────────────────────────────
def common_argparse(description):
    ap = argparse.ArgumentParser(description=description)
    ap.add_argument("input")
    ap.add_argument("-o", "--output")
    ap.add_argument("--html", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--title", default="")
    ap.add_argument("--style", default=None, help="样式覆盖 JSON 文件")
    return ap


def common_main(args, mod):
    """通用 CLI 主流程：parse → emoji 校验 → layout → 质检 → check / 渲染落盘。

    mod 需提供：
      load_spec(path)           读入并解析输入（mermaid 子集），返回 spec dict
      iter_labels(spec)         产出所有文本标签（供 emoji 校验）
      layout(spec, style, args) 返回统一布局产物字典（见文件头）
      render_svg(lay, title)    返回 SVG 字符串
      report_extra(lay)         可选：报告附加字段（如 spine）
    """
    spec = mod.load_spec(args.input)
    if not spec.get("nodes"):
        raise SystemExit("错误：输入为空或未解析出任何节点（形态超限）")
    bad = []
    for label in mod.iter_labels(spec):
        bad += find_emoji(label)
    if bad:
        raise SystemExit("错误：输入含 emoji 字符 %s（本工具产物禁用 emoji）" % bad)
    style = load_style(args.style)
    lay = mod.layout(spec, style, args)
    report = build_report(len(spec["nodes"]), len(spec["edges"]), lay)
    if hasattr(mod, "report_extra"):
        report.update(mod.report_extra(lay) or {})
    if args.check:
        print(json.dumps(report, ensure_ascii=False, indent=1))
        return 0 if is_clean(report) else 1
    if not args.output:
        raise SystemExit("错误：需要 -o 指定输出文件（或使用 --check）")
    if not is_clean(report):
        raise SystemExit("错误：布局检查未通过（交叉 %d / 重叠 %d / 文字溢出 %d / 标签碰撞 %d），"
                         "形态超限已拒绝产出——建议拆图、折叠细节或改用 mermaid 原生渲染。"
                         % (report["crossings"], report["overlaps"], report["textOverflow"],
                            report.get("labelCollisions", 0)))
    content = mod.render_html(lay, args.title) if args.html else mod.render_svg(lay, args.title)
    with open(args.output, "w", encoding="utf-8", newline="\n") as f:
        f.write(content)
    print(json.dumps(report, ensure_ascii=False))
    print("已生成 %s" % args.output)
    return 0
