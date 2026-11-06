#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""时序图布局模块（layout_seq）。实现 seqspec/1 契约，见 contract/seqspec-v1.md。"""
import re
import sys
from flowcommon import (
    COMMON_STYLE, text_width, wrap_label, esc, port,
    ortho_crossings, line_crossings, box_overlaps, text_overflow_check,
    svg_open, svg_close, arrow_marker, svg_text,
    render_html as _render_html, common_argparse, common_main)

SPEC_VERSION = "seqspec/1"
DATA_ATTR = 'data-seqspec="1"'

MAX_PARTICIPANTS = 6

# v1 明确不支持的 sequenceDiagram 关键字（一律报「形态超限」降级）。
UNSUPPORTED_KEYWORDS = {
    "actor": "actor 声明（v1 只支持 participant）",
    "note": "note 注记",
    "alt": "alt 条件分支",
    "else": "else 分支",
    "end": "块结束 end",
    "loop": "loop 循环块",
    "opt": "opt 可选块",
    "par": "par 并行块",
    "and": "par 并行分支 and",
    "critical": "critical 块",
    "option": "critical 分支 option",
    "break": "break 块",
    "rect": "rect 背景块",
    "box": "box 分组",
    "activate": "activate 激活条",
    "deactivate": "deactivate 激活条",
    "autonumber": "autonumber 自动编号",
    "links": "links 扩展",
    "link": "link 扩展",
    "properties": "properties 扩展",
    "details": "details 扩展",
}

RE_PARTICIPANT = re.compile(r"^participant\s+(\S+?)(?:\s+as\s+(.+?))?\s*$")
RE_MESSAGE = re.compile(r"^(\S+?)\s*(-->>|->>)\s*(\S+?)\s*:\s*(.+?)\s*$")

STYLE = dict(COMMON_STYLE)  # 可加时序专属键（生命线色、参与者头底色等），全部可被 --style 覆盖
STYLE.update({
    # 颜色（灰度线框基调）
    "head_fill": "#f4f4f4",
    "head_stroke": "#333333",
    "head_text": "#333333",
    "lifeline": "#aaaaaa",
    "lifeline_dash": "5 4",
    "msg_dash": "5 4",
    # 几何（单位 px，全部可被 --style 覆盖）
    "row_h": 26,          # 消息行高
    "self_w": 40,         # 自消息回环宽
    "self_h": 20,         # 自消息回环高
    "head_min_w": 96,     # 参与者头最小宽
    "head_min_h": 34,     # 参与者头最小高
    "head_pad_x": 24,     # 参与者头左右内边距
    "head_gap": 40,       # 相邻参与者头之间的最小空隙
    "col_min_dist": 110,  # 相邻列最小中心距
    "label_pad": 30,      # 消息标签两侧留白（列距 = 最宽标签 + 该留白）
    "self_label_gap": 8,  # 自消息标签与回环的间距
    "self_clear": 16,     # 自消息标签右侧净空
    "pad_x": 20,          # 画布左右边距
    "pad_top": 18,        # 画布上边距
    "pad_bottom": 24,     # 画布下边距
    "msg_top_pad": 30,    # 参与者头底部到首条消息的距离
    "label_dy": 7,        # 标签基线在箭头上方的偏移
    "lifeline_tail": 14,  # 生命线在末条消息之下的延伸
    "wrap_limit": 12,     # 参与者显示名折行字符数
})


def _die(msg):
    raise SystemExit("错误：%s（形态超限：seqspec/1 见 contract/seqspec-v1.md）" % msg)


def parse_mermaid(src):
    """解析 mermaid sequenceDiagram 子集，返回 seqspec/1 spec 字典。"""
    text = src.replace("\r\n", "\n").replace("\r", "\n")
    nodes, index, edges, warnings = [], {}, [], []
    started = False

    def ensure(pid, display=None, declared=False):
        if pid not in index:
            if len(nodes) >= MAX_PARTICIPANTS:
                _die("参与者数 %d 超过上限 %d" % (len(nodes) + 1, MAX_PARTICIPANTS))
            index[pid] = len(nodes)
            nodes.append({"id": pid, "type": "participant", "name": display or pid,
                          "label": wrap_label([display or pid], STYLE["wrap_limit"]),
                          "col": index[pid]})
            if not declared:
                warnings.append("消息中出现未声明的参与者 %s，已自动补充" % pid)
        elif declared:
            _die("参与者 %s 重复声明" % pid)
        return index[pid]

    for raw in text.split("\n"):
        line = raw.strip()
        if not line or line.startswith("%%"):
            continue
        if not started:
            if line != "sequenceDiagram":
                _die("首个有效行须为 sequenceDiagram，实际为 %r" % line[:40])
            started = True
            continue
        kw = re.split(r"[\s:]+", line, maxsplit=1)[0].lower()
        if kw in UNSUPPORTED_KEYWORDS:
            _die("不支持的时序语法：%s" % UNSUPPORTED_KEYWORDS[kw])
        m = RE_PARTICIPANT.match(line)
        if m:
            pid = m.group(1)
            display = (m.group(2) or pid).strip()
            if not display:
                _die("参与者 %s 显示名为空" % pid)
            ensure(pid, display, declared=True)
            continue
        m = RE_MESSAGE.match(line)
        if not m:
            _die("无法解析的行 %r" % line[:40])
        a, arrow, b, label = m.group(1), m.group(2), m.group(3), m.group(4).strip()
        if not label:
            _die("消息 %s%s%s 文本为空" % (a, arrow, b))
        ia, ib = ensure(a), ensure(b)
        dist = abs(ia - ib)
        if dist > 1:
            _die("消息 %s%s%s 跨 %d 列（仅支持相邻列或自消息）" % (a, arrow, b, dist))
        edges.append({"from": a, "to": b, "label": [label],
                      "dashed": arrow == "-->>", "self": ia == ib,
                      "type": "return" if arrow == "-->>" else "call"})
    if not started:
        _die("输入为空或缺少 sequenceDiagram 头")
    if not nodes:
        _die("未解析到任何参与者")
    if not edges:
        _die("未解析到任何消息")
    return {"spec": SPEC_VERSION, "nodes": nodes, "edges": edges, "warnings": warnings}


def load_spec(path):
    text = open(path, encoding="utf-8").read()
    return parse_mermaid(text)


def iter_labels(spec):
    """产出全部文本：参与者显示名、消息文本（供 emoji 校验）。"""
    for n in spec["nodes"]:
        yield n["name"]
        for l in n["label"]:
            yield l
    for e in spec["edges"]:
        for l in e["label"]:
            yield l


def layout(spec, style=None, args=None):
    st = dict(STYLE)
    if style:
        st.update(style)
    parts = spec["nodes"]
    edges = spec["edges"]
    order = [n["id"] for n in parts]
    col = {n["id"]: i for i, n in enumerate(parts)}
    ncol = len(parts)
    warnings = list(spec.get("warnings", []))
    fs_n, fs_l = st["fs_node"], st["fs_label"]

    # ── 参与者头尺寸（同排等高，宽按显示名自适应） ──
    widths, nlines = [], 1
    for n in parts:
        tw = max([text_width(l, fs_n) for l in n["label"]] or [0])
        widths.append(max(int(st["head_min_w"]), int(tw + st["head_pad_x"]) + 1))
        nlines = max(nlines, len(n["label"]))
    hh = max(int(st["head_min_h"]), nlines * (fs_n + 5) + 16)
    hy = int(st["pad_top"]) + hh // 2

    # ── 逐对列距：相邻两列间消息文本最宽者 + 边距；并为自消息标签预留右侧空间 ──
    pair_lbl = [0.0] * max(0, ncol - 1)
    self_lbl = [0.0] * ncol
    for e in edges:
        w = max(text_width(t, fs_l) for t in e["label"])
        if e["self"]:
            i = col[e["from"]]
            self_lbl[i] = max(self_lbl[i], w)
        else:
            i = min(col[e["from"]], col[e["to"]])
            pair_lbl[i] = max(pair_lbl[i], w)

    def self_need(i):
        if self_lbl[i] <= 0:
            return 0
        return int(st["self_w"] + st["self_label_gap"] + self_lbl[i] + st["self_clear"]) + 1

    xs = [int(st["pad_x"]) + widths[0] // 2]
    dists = []
    for i in range(ncol - 1):
        d = max(int(st["col_min_dist"]),
                (widths[i] + widths[i + 1]) // 2 + int(st["head_gap"]),
                int(pair_lbl[i] + st["label_pad"]) + 1,
                self_need(i))
        dists.append(d)
        xs.append(xs[-1] + d)
    right_space = max(widths[-1] // 2 + int(st["pad_x"]), self_need(ncol - 1))

    # ── 节点（参与者头包围盒，中心坐标） ──
    N = {}
    for i, n in enumerate(parts):
        N[n["id"]] = {"id": n["id"], "type": "participant", "name": n["name"],
                      "label": list(n["label"]), "col": i, "fs": fs_n,
                      "x": xs[i], "y": hy, "w": widths[i], "h": hh}

    # ── 消息分层：每条 y 递增；自消息额外让出回环高度 ──
    routes, overflow = [], []
    y = hy + hh // 2 + int(st["msg_top_pad"])
    row_h, sw, sh = int(st["row_h"]), int(st["self_w"]), int(st["self_h"])
    label_boxes = []
    for k, e in enumerate(edges):
        ia, ib = col[e["from"]], col[e["to"]]
        txt = e["label"][0]
        need = text_width(txt, fs_l)
        if e["self"]:
            x = xs[ia]
            pts = [(x, y), (x + sw, y), (x + sw, y + sh), (x, y + sh)]
            lx = x + sw + int(st["self_label_gap"])
            ly = y + sh // 2 + int(round(fs_l * 0.35))
            anchor = "start"
            space = dists[ia] if ia < ncol - 1 else right_space
            avail = space - sw - int(st["self_label_gap"]) - 2
            cx_lbl = lx + need / 2
        else:
            xa, xb = xs[ia], xs[ib]
            pts = [(xa, y), (xb, y)]
            lx = (xa + xb) // 2
            ly = y - int(st["label_dy"])
            anchor = "middle"
            avail = dists[min(ia, ib)]
            cx_lbl = lx
        if need > avail:
            overflow.append({"id": "seq-msg-%d" % k, "line": 0, "text": txt,
                             "need": int(round(need)), "avail": int(round(avail))})
        label_boxes.append(("seq-lbl-%d" % k, cx_lbl, ly - fs_l * 0.35, need + 4, fs_l + 4))
        routes.append({"pts": [(int(px), int(py)) for px, py in pts],
                       "label": [txt], "lx": int(lx), "ly": int(ly), "anchor": anchor,
                       "arrow": True, "dashed": bool(e["dashed"]), "self": bool(e["self"]),
                       "index": k, "from": e["from"], "to": e["to"],
                       "y": int(y)})
        y += row_h + (sh if e["self"] else 0)

    last_y = y - row_h
    bottom = last_y + int(st["lifeline_tail"])
    lifelines = [{"id": n["id"], "x": xs[i], "y1": hy + hh // 2, "y2": bottom}
                 for i, n in enumerate(parts)]

    W = xs[-1] + right_space
    H = bottom + int(st["pad_bottom"])

    # ── 质检 ──
    crossings = ortho_crossings(routes)
    boxes = [("seq-head-" + nid, N[nid]["x"], N[nid]["y"], N[nid]["w"], N[nid]["h"])
             for nid in order]
    boxes += label_boxes
    overlaps = box_overlaps(boxes)

    def metrics(n, j):
        return fs_n, n["w"] - 10

    text_overflow = text_overflow_check(N, order, metrics)
    text_overflow += overflow

    return {"nodes": N, "order": order, "routes": routes,
            "extra": {"lifelines": lifelines, "head_h": hh, "head_y": hy,
                      "cols": xs, "dists": dists, "bottom": bottom,
                      "spec": SPEC_VERSION},
            "W": int(round(W)), "H": int(round(H)), "style": st,
            "crossings": crossings, "overlaps": overlaps,
            "textOverflow": text_overflow, "warnings": warnings, "col": col}


def render_svg(lay, title=""):
    st = lay["style"]
    out = svg_open(lay["W"], lay["H"], DATA_ATTR, st)
    out.append(arrow_marker(st, "arw"))
    # 空心箭头（虚线返回消息用）；flowcommon 只提供实心 marker，这里补一个。
    out.append('<defs><marker id="arwo" viewBox="0 0 10 10" refX="9" refY="5" '
               'markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
               '<path d="M0,0 L10,5 L0,10 z" fill="%s" stroke="%s" stroke-width="1.2"/>'
               '</marker></defs>' % (st["fill"], st["edge_color"]))
    lifelines = {l["id"]: l for l in lay["extra"]["lifelines"]}
    for nid in lay["order"]:
        n = lay["nodes"][nid]
        cx, cy, w, h = n["x"], n["y"], n["w"], n["h"]
        ll = lifelines[nid]
        out.append('<g class="participant" id="seq-%s" data-node="%s">' % (nid, esc(nid)))
        out.append('<line x1="%g" y1="%g" x2="%g" y2="%g" stroke="%s" stroke-width="1.2" '
                   'stroke-dasharray="%s"/>'
                   % (ll["x"], ll["y1"], ll["x"], ll["y2"], st["lifeline"], st["lifeline_dash"]))
        out.append('<rect x="%g" y="%g" width="%g" height="%g" rx="4" fill="%s" stroke="%s" '
                   'stroke-width="1.4"/>'
                   % (cx - w / 2, cy - h / 2, w, h, st["head_fill"], st["head_stroke"]))
        nl = len(n["label"])
        for j, t in enumerate(n["label"]):
            ty = cy + (j - (nl - 1) / 2) * (st["fs_node"] + 4) + st["fs_node"] * 0.35
            out.append(svg_text(cx, ty, st["fs_node"], st["head_text"], "middle", t))
        out.append('</g>')
    for r in lay["routes"]:
        pts = " ".join("%g,%g" % (x, y) for x, y in r["pts"])
        dash = ' stroke-dasharray="%s"' % st["msg_dash"] if r["dashed"] else ""
        marker = ' marker-end="url(#%s)"' % ("arwo" if r["dashed"] else "arw")
        out.append('<g class="message" id="seq-msg-%d">' % r["index"])
        out.append('<polyline points="%s" fill="none" stroke="%s" stroke-width="1.5"%s%s/>'
                   % (pts, st["edge_color"], dash, marker))
        for i, t in enumerate(r["label"]):
            out.append(svg_text(r["lx"], r["ly"] + i * (st["fs_label"] + 2),
                                st["fs_label"], st["label_color"], r["anchor"], t))
        out.append('</g>')
    out += svg_close()
    return "\n".join(out)


def render_html(lay, title):
    return _render_html(render_svg(lay, title), title, lay["style"]["font_family"])


def main_cli(args):
    return common_main(args, sys.modules[__name__])


if __name__ == "__main__":
    ap = common_argparse("flow-canvas 时序图布局器（seqspec/1）")
    raise SystemExit(main_cli(ap.parse_args()))
