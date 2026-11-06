#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ER 图布局模块（layout_er）。实现 erspec/2 契约，见 contract/erspec-v2.md。

布局要点：实体表格块在网格中向上/下/左/右扩展（行列对齐），
边在行间隙 / 列间隙中正交绕行，两端画乌鸦脚（crow's foot）基数记号。
"""
import re
import sys
from collections import deque

from flowcommon import (
    COMMON_STYLE, text_width, esc, ortho_crossings, box_overlaps,
    text_overflow_check, svg_open, svg_close, svg_text,
    render_html as _render_html, common_argparse, common_main)

SPEC_VERSION = "erspec/2"
DATA_ATTR = 'data-erspec="2"'

STYLE = dict(COMMON_STYLE)
STYLE.update({
    "header_fill": "#e9e9e9",
    "row_line": "#e0e0e0",
    "attr_h": 18,
    "header_h": 26,
    "col_gap": 80,
    "row_gap": 80,
    "margin": 60,
    "detour_step": 14,
})

MAX_ENTITIES = 8
CARDS = {"||", "o|", "|o", "o{", "}o", "|{", "}|"}
# 实体名 / 属性类型 / 属性名：ASCII 标识符或中文（首字符不得为数字）
_NAME = r'[A-Za-z\u4e00-\u9fff][A-Za-z0-9_\u4e00-\u9fff]*'
ENTITY_RE = re.compile(r'^(%s)\s*\{\s*$' % _NAME)
REL_RE = re.compile(r'^(%s)\s+(\S+)\s*--\s*(\S+)\s+(%s)\s*:\s*(.*)$' % (_NAME, _NAME))
_ID_RE = re.compile(r'^(%s)$' % _NAME)
_COMMENT_TOKEN_RE = re.compile(r'^[\u4e00-\u9fffA-Za-z0-9_]+$')

# 四邻域（先上下左右）与对角（用于网格放置）
NEIGH4 = [(-1, 0), (1, 0), (0, -1), (0, 1)]
DIAG = [(-1, -1), (-1, 1), (1, -1), (1, 1)]
# 端口向外单位向量
OUT = {"L": (-1, 0), "R": (1, 0), "T": (0, -1), "B": (0, 1)}


def parse_mermaid(src):
    nodes, order = {}, []
    edges = []
    cur = None
    for raw in src.splitlines():
        line = raw.strip()
        if not line or line.startswith("%%") or line.startswith("erDiagram"):
            continue
        m = ENTITY_RE.match(line)
        if m:
            name = m.group(1)
            if name in nodes:
                raise SystemExit("错误：实体 %s 重复定义（形态超限）" % name)
            nodes[name] = {"id": name, "label": [name], "attrs": []}
            order.append(name)
            cur = name
            continue
        if line == "}":
            cur = None
            continue
        m = REL_RE.match(line)
        if m:
            a, cl, cr, b, label = m.groups()
            if cl not in CARDS or cr not in CARDS:
                raise SystemExit("错误：关系 %s--%s 基数记号无法识别（形态超限）" % (cl, cr))
            label = label.strip()
            if len(label) >= 2 and label[0] == '"' and label[-1] == '"':
                label = label[1:-1]
            edges.append({"from": a, "to": b, "cardL": cl, "cardR": cr,
                          "label": [label] if label else []})
            continue
        if cur:
            nodes[cur]["attrs"].append(_parse_attr(line, cur))
            continue
        raise SystemExit("错误：无法识别的行「%s」（形态超限，请改用 mermaid 原生渲染）" % line)

    for e in edges:
        for nid in (e["from"], e["to"]):
            if nid not in nodes:
                raise SystemExit("错误：关系引用了未定义实体 %s（形态超限）" % nid)
        if e["from"] == e["to"]:
            raise SystemExit("错误：实体自引用关系不支持（形态超限）")
    if len(order) > MAX_ENTITIES:
        raise SystemExit("错误：实体数 %d 超过上限 %d（形态超限）" % (len(order), MAX_ENTITIES))

    seen = set()
    for e in edges:
        key = (e["from"], e["to"], e["cardL"], e["cardR"])
        if key in seen:
            raise SystemExit("错误：关系 %s %s--%s %s 完全重复（形态超限）"
                             % (e["from"], e["cardL"], e["cardR"], e["to"]))
        seen.add(key)

    return {"spec": SPEC_VERSION, "nodes": [nodes[i] for i in order], "edges": edges}


def _parse_attr(line, cur):
    """属性行 = `类型 属性名 [PK|FK] ["注释"]`；注释可带引号也可不带。

    去掉引号注释后，剩余尾部分号/逗号分隔的 token：
      ∈ {PK, FK} → 修饰；由中文/字母数字/下划线组成 → 合并为注释；
      含其他字符 → 报「形态超限」。
    """
    parts = line.split(None, 2)
    if len(parts) < 2 or not (_ID_RE.match(parts[0]) and _ID_RE.match(parts[1])):
        raise SystemExit("错误：实体 %s 的属性行「%s」无法解析（形态超限）" % (cur, line))
    atype, aname = parts[0], parts[1]
    rest = parts[2] if len(parts) > 2 else ""

    comment = ""
    qm = re.search(r'"([^"]*)"', rest)
    if qm:
        comment = qm.group(1)
        rest = rest[:qm.start()] + " " + rest[qm.end():]

    flags, extra = [], []
    for tok in re.split(r'[;,\s]+', rest):
        tok = tok.strip()
        if not tok:
            continue
        if tok in ("PK", "FK"):
            flags.append(tok)
        elif _COMMENT_TOKEN_RE.match(tok):
            extra.append(tok)
        else:
            raise SystemExit("错误：实体 %s 的属性行「%s」无法解析（形态超限，含非法字符「%s」）"
                             % (cur, line, tok))
    if extra and not comment:
        comment = " ".join(extra)

    text = "%s %s" % (atype, aname)
    if comment:
        text += " (%s)" % comment
    return {"pk": "PK" in flags, "fk": "FK" in flags, "text": text}


def load_spec(path):
    text = open(path, encoding="utf-8").read()
    return parse_mermaid(text)


def iter_labels(spec):
    for n in spec["nodes"]:
        yield n["label"][0]
        for a in n["attrs"]:
            yield a["text"]
    for e in spec["edges"]:
        for l in e.get("label", []):
            yield l


# ── 网格放置 ────────────────────────────────────────────────────────
def _place_once(order, edges):
    """确定性贪心网格放置。order: [id]（候选序，order[0] 为种子），edges: 边声明序。"""
    pos = {order[0]: (0, 0)}
    grid = {(0, 0): order[0]}

    def place_near(eid, r, c):
        for dr, dc in NEIGH4 + DIAG:
            cell = (r + dr, c + dc)
            if cell not in grid:
                pos[eid] = cell
                grid[cell] = eid
                return
        place_ring(eid)

    def place_ring(eid):
        q = deque([(0, 0)])
        seen = {(0, 0)}
        while q:
            r, c = q.popleft()
            if (r, c) not in grid:
                pos[eid] = (r, c)
                grid[(r, c)] = eid
                return
            for dr, dc in NEIGH4:
                cell = (r + dr, c + dc)
                if cell not in seen:
                    seen.add(cell)
                    q.append(cell)

    for e in edges:
        a, b = e["from"], e["to"]
        pa, pb = a in pos, b in pos
        if pa and not pb:
            place_near(b, *pos[a])
        elif pb and not pa:
            place_near(a, *pos[b])
    for eid in order:
        if eid not in pos:
            place_ring(eid)

    min_r = min(r for r, _ in pos.values())
    min_c = min(c for _, c in pos.values())
    return {eid: (r - min_r, c - min_c) for eid, (r, c) in pos.items()}


def _to_pixels(pos, ents, st):
    rows = sorted(set(r for r, _ in pos.values()))
    cols = sorted(set(c for _, c in pos.values()))
    by_col = {c: [eid for eid, (_, cc) in pos.items() if cc == c] for c in cols}
    by_row = {r: [eid for eid, (rr, _) in pos.items() if rr == r] for r in rows}
    col_w = {c: max(ents[e]["w"] for e in by_col[c]) + st["col_gap"] for c in cols}
    row_h = {r: max(ents[e]["h"] for e in by_row[r]) + st["row_gap"] for r in rows}
    margin = st["margin"]
    col_left, x = {}, margin
    for c in cols:
        col_left[c] = x
        x += col_w[c]
    row_top, y = {}, margin
    for r in rows:
        row_top[r] = y
        y += row_h[r]
    W = round(margin + sum(col_w.values()) + margin)
    H = round(margin + sum(row_h.values()) + margin)
    for eid, (r, c) in pos.items():
        ents[eid]["x"] = col_left[c] + col_w[c] / 2
        ents[eid]["y"] = row_top[r] + row_h[r] / 2
        ents[eid]["grid"] = (r, c)
    return W, H, cols, rows, col_left, row_top, col_w, row_h


# ── 路由 ────────────────────────────────────────────────────────────
def _span(card):
    return 15 if card in ("||", "o|", "|o") else 41


def _stagger(k, step):
    if k == 0:
        return 0
    sign = 1 if k % 2 == 1 else -1
    return sign * step * ((k + 1) // 2)


def _port(n, side, off):
    x, y, w, h = n["x"], n["y"], n["w"], n["h"]
    if side == "L":
        return (x - w / 2, y + off)
    if side == "R":
        return (x + w / 2, y + off)
    if side == "T":
        return (x + off, y - h / 2)
    return (x + off, y + h / 2)


def _indent(p, side, span, plus):
    dx, dy = OUT[side]
    return (p[0] + dx * (span + plus), p[1] + dy * (span + plus))


def _route(edges, ents, pos, cols, rows, col_left, row_top, col_w, row_h, st):
    edge_sides, usage = [], {}
    for idx, e in enumerate(edges):
        a, b = e["from"], e["to"]
        ra, ca = pos[a]
        rb, cb = pos[b]
        dr, dc = rb - ra, cb - ca
        if abs(dr) + abs(dc) == 1:
            if dc == 1:
                sa, ta = "R", "L"
            elif dc == -1:
                sa, ta = "L", "R"
            elif dr == 1:
                sa, ta = "B", "T"
            else:
                sa, ta = "T", "B"
        elif dr == 0:
            sa = ta = "T" if ra == 0 else "B"
        elif dc == 0:
            sa = ta = "L" if ca == 0 else "R"
        else:
            sa = "B" if dr > 0 else "T"
            ta = "T" if dr > 0 else "B"
        edge_sides.append((sa, ta))
        usage.setdefault((a, sa), []).append((idx, "s"))
        usage.setdefault((b, ta), []).append((idx, "t"))

    port_off = {}
    for lst in usage.values():
        for k, (idx, role) in enumerate(lst):
            port_off[(idx, role)] = _stagger(k, 8)

    row_bottom = {r: row_top[r] + row_h[r] for r in rows}
    col_right = {c: col_left[c] + col_w[c] for c in cols}
    hcorr, vcorr = {}, {}

    def hoff(yc):
        k = hcorr.get(yc, 0)
        hcorr[yc] = k + 1
        return _stagger(k, st["detour_step"])

    def voff(xc):
        k = vcorr.get(xc, 0)
        vcorr[xc] = k + 1
        return _stagger(k, st["detour_step"])

    routes, detours, label_overflow = [], 0, []
    for idx, e in enumerate(edges):
        a, b = e["from"], e["to"]
        na, nb = ents[a], ents[b]
        ra, ca = pos[a]
        rb, cb = pos[b]
        dr, dc = rb - ra, cb - ca
        sa, ta = edge_sides[idx]
        ps = _port(na, sa, port_off[(idx, "s")])
        pt = _port(nb, ta, port_off[(idx, "t")])
        spanL, spanR = _span(e["cardL"]), _span(e["cardR"])
        label = e.get("label", [])

        if abs(dr) + abs(dc) == 1:
            p1 = _indent(ps, sa, spanL, 2)
            p2 = _indent(pt, ta, spanR, 2)
            pts = [p1, p2]
            if dc != 0:
                lx, ly, anchor = (p1[0] + p2[0]) / 2, p1[1] - 6, "middle"
                gap = abs(pt[0] - ps[0])
            else:
                lx, ly, anchor = p1[0] + 8, (p1[1] + p2[1]) / 2, "start"
                gap = abs(pt[1] - ps[1])
        else:
            detours += 1
            pts, lx, ly, gap = _detour_pts(
                ps, pt, sa, ta, spanL, spanR, ra, ca, rb, cb,
                row_top, row_bottom, col_left, col_right, hoff, voff, st)
            anchor = "middle"

        if label:
            for t in label:
                need = text_width(t, st["fs_label"])
                if need > gap + 8:
                    label_overflow.append({"id": "%s-%s" % (a, b), "line": 0,
                                           "text": t, "need": round(need),
                                           "avail": round(gap + 8)})

        routes.append({"pts": pts, "label": label, "lx": lx, "ly": ly, "anchor": anchor,
                       "ends": [{"card": e["cardL"], "x": ps[0], "y": ps[1], "side": sa},
                                {"card": e["cardR"], "x": pt[0], "y": pt[1], "side": ta}]})
    return routes, detours, label_overflow


def _detour_pts(ps, pt, sa, ta, spanL, spanR, ra, ca, rb, cb,
                row_top, row_bottom, col_left, col_right, hoff, voff, st):
    p1 = _indent(ps, sa, spanL, 4)
    pend = _indent(pt, ta, spanR, 4)
    dr, dc = rb - ra, cb - ca
    if dr == 0:
        ycorr = row_top[0] if ra == 0 else row_bottom[ra]
        y = ycorr + hoff(ycorr)
        pts = [p1, (p1[0], y), (pend[0], y), pend]
        lx, ly = (p1[0] + pend[0]) / 2, y - 6
        gap = st["col_gap"]
    elif dc == 0:
        xcorr = col_left[0] if ca == 0 else col_right[ca]
        x = xcorr + voff(xcorr)
        pts = [p1, (x, p1[1]), (x, pend[1]), pend]
        lx, ly = (p1[0] + x) / 2, p1[1] - 6
        gap = st["row_gap"]
    else:
        y1corr = row_bottom[ra] if dr > 0 else row_top[ra]
        xcorr = col_left[cb] if dc > 0 else col_right[cb]
        y2corr = row_top[rb] if dr > 0 else row_bottom[rb]
        y1 = y1corr + hoff(y1corr)
        x = xcorr + voff(xcorr)
        y2 = y2corr + hoff(y2corr)
        pts = [p1, (p1[0], y1), (x, y1), (x, y2), (pend[0], y2), pend]
        lx, ly = (p1[0] + x) / 2, y1 - 6
        gap = st["col_gap"]
    return pts, lx, ly, gap


# ── 布局 ────────────────────────────────────────────────────────────
def _layout_once(order, edges, base, decl_order, st, fs, fsub, fcard):
    ents = {eid: dict(base[eid]) for eid in base}
    pos = _place_once(order, edges)
    W, H, cols, rows, col_left, row_top, col_w, row_h = _to_pixels(pos, ents, st)
    routes, detours, label_overflow = _route(
        edges, ents, pos, cols, rows, col_left, row_top, col_w, row_h, st)

    crossings = ortho_crossings(routes)
    boxes = [(eid, ents[eid]["x"], ents[eid]["y"], ents[eid]["w"], ents[eid]["h"])
             for eid in decl_order]
    overlaps = box_overlaps(boxes)

    tmp = {}
    for eid in decl_order:
        n = ents[eid]
        tmp[eid] = {"w": n["w"], "label": [n["label"][0]] + [a["text"] for a in n["attrs"]]}

    def metrics(n, j):
        return (fs if j == 0 else fsub), n["w"] - 10

    overflow = text_overflow_check(tmp, decl_order, metrics) + label_overflow

    return {"nodes": ents, "order": list(decl_order), "routes": routes,
            "extra": {"grid": pos}, "W": W, "H": H, "style": st,
            "crossings": crossings, "overlaps": overlaps,
            "textOverflow": overflow, "warnings": [], "detours": detours}


def layout(spec, style=None, args=None):
    st = dict(STYLE)
    if style:
        st.update(style)
    base = {n["id"]: dict(n) for n in spec["nodes"]}
    decl_order = [n["id"] for n in spec["nodes"]]
    edges = [dict(e) for e in spec["edges"]]
    fs, fsub, fcard = st["fs_node"], st["fs_sub"], st["fs_label"]

    for eid in decl_order:
        n = base[eid]
        widths = [text_width(n["label"][0], fs)] + [text_width(a["text"], fsub) for a in n["attrs"]]
        n["w"] = round(max(widths) + 20)
        n["h"] = st["header_h"] + len(n["attrs"]) * st["attr_h"] + 10

    # 候选实体放置序：声明序 / 2 轮 barycenter / 逆声明序
    candidates = [list(decl_order)]
    order = list(decl_order)
    idx = {eid: i for i, eid in enumerate(order)}
    for _ in range(2):
        sums = {eid: 0.0 for eid in order}
        cnt = {eid: 0 for eid in order}
        for e in edges:
            sums[e["from"]] += idx[e["to"]]
            cnt[e["from"]] += 1
            sums[e["to"]] += idx[e["from"]]
            cnt[e["to"]] += 1
        order = sorted(order, key=lambda eid: (sums[eid] / cnt[eid] if cnt[eid] else idx[eid]))
        idx = {eid: k for k, eid in enumerate(order)}
        candidates.append(list(order))
    candidates.append(list(reversed(decl_order)))

    best = None
    for cand in candidates:
        lay = _layout_once(cand, edges, base, decl_order, st, fs, fsub, fcard)
        if best is None or len(lay["crossings"]) < len(best["crossings"]):
            best = lay

    if best["detours"] > 6:
        raise SystemExit("错误：绕行边数 %d 超过上限 6（形态超限，请简化关系或改用 mermaid 原生渲染）"
                         % best["detours"])
    if len(best["crossings"]) > 0:
        raise SystemExit("错误：网格布局后仍有 %d 处边交叉（形态超限，请简化关系或改用 mermaid 原生渲染）"
                         % len(best["crossings"]))
    return best


# ── 乌鸦脚渲染 ──────────────────────────────────────────────────────
def _card_svg(card, px, py, side, edge_color):
    out = []

    def tick(d):
        if side in ("L", "R"):
            xd = px - d if side == "L" else px + d
            return ('<line class="er-tick" x1="%g" y1="%g" x2="%g" y2="%g" '
                    'stroke="%s" stroke-width="1.4"/>' % (xd, py - 8, xd, py + 8, edge_color))
        yd = py - d if side == "T" else py + d
        return ('<line class="er-tick" x1="%g" y1="%g" x2="%g" y2="%g" '
                'stroke="%s" stroke-width="1.4"/>' % (px - 8, yd, px + 8, yd, edge_color))

    def circle(d):
        if side in ("L", "R"):
            cx = px - d if side == "L" else px + d
            cy = py
        else:
            cx = px
            cy = py - d if side == "T" else py + d
        return ('<circle class="er-circle" cx="%g" cy="%g" r="5" fill="#ffffff" '
                'stroke="%s" stroke-width="1.4"/>' % (cx, cy, edge_color))

    def fork():
        if side == "L":
            apex, legs = (px - 26, py), [(px - 14, py), (px - 14, py - 8), (px - 14, py + 8)]
        elif side == "R":
            apex, legs = (px + 26, py), [(px + 14, py), (px + 14, py - 8), (px + 14, py + 8)]
        elif side == "T":
            apex, legs = (px, py - 26), [(px, py - 14), (px - 8, py - 14), (px + 8, py - 14)]
        else:
            apex, legs = (px, py + 26), [(px, py + 14), (px - 8, py + 14), (px + 8, py + 14)]
        return "".join('<line class="er-fork" x1="%g" y1="%g" x2="%g" y2="%g" '
                       'stroke="%s" stroke-width="1.4"/>' % (apex[0], apex[1], lx, ly, edge_color)
                       for lx, ly in legs)

    if card == "||":
        out.append(tick(6))
        out.append(tick(13))
    elif card in ("o|", "|o"):
        out.append(tick(6))
        out.append(circle(16))
    elif card == "|{":
        out.append(fork())
        out.append(tick(34))
    elif card in ("o{", "}o"):
        out.append(fork())
        out.append(circle(34))
    elif card == "}|":
        out.append(fork())
        out.append(tick(34))
    return '<g class="er-card" data-card="%s">%s</g>' % (esc(card), "".join(out))


def render_svg(lay, title=""):
    st = lay["style"]
    out = svg_open(lay["W"], lay["H"], DATA_ATTR, st)
    for i, nid in enumerate(lay["order"]):
        n = lay["nodes"][nid]
        x0, y0 = n["x"] - n["w"] / 2, n["y"] - n["h"] / 2
        out.append('<g class="entity" id="er-%s-%d">' % (nid, i))
        out.append('<rect x="%g" y="%g" width="%g" height="%g" rx="3" fill="%s" stroke="%s" stroke-width="1.2"/>'
                   % (x0, y0, n["w"], n["h"], st["fill"], st["stroke"]))
        hy = y0 + st["header_h"]
        out.append('<rect x="%g" y="%g" width="%g" height="%g" fill="%s"/>'
                   % (x0, y0, n["w"], st["header_h"], st["header_fill"]))
        out.append('<line x1="%g" y1="%g" x2="%g" y2="%g" stroke="%s" stroke-width="0.8"/>'
                   % (x0, hy, x0 + n["w"], hy, st["row_line"]))
        out.append(svg_text(n["x"], y0 + st["header_h"] / 2 + 4, st["fs_node"], st["text"],
                            "middle", n["label"][0]))
        for k, a in enumerate(n["attrs"]):
            ay = hy + (k + 0.5) * st["attr_h"] + 4
            deco = ' text-decoration="underline"' if a["pk"] else ""
            style_attr = ' font-style="italic"' if a["fk"] else ""
            out.append('<text x="%g" y="%g" font-size="%d" fill="%s" text-anchor="middle"%s%s>%s</text>'
                       % (n["x"], ay, st["fs_sub"], st["text"], deco, style_attr, esc(a["text"])))
            if k:
                out.append('<line x1="%g" y1="%g" x2="%g" y2="%g" stroke="%s" stroke-width="0.6"/>'
                           % (x0 + 6, hy + k * st["attr_h"], x0 + n["w"] - 6, hy + k * st["attr_h"], st["row_line"]))
        out.append('</g>')
    for r in lay["routes"]:
        p = " ".join("%g,%g" % (px, py) for px, py in r["pts"])
        out.append('<polyline points="%s" fill="none" stroke="%s" stroke-width="1.4"/>'
                   % (p, st["edge_color"]))
        if r["label"] and r["lx"] is not None:
            for k, t in enumerate(r["label"]):
                out.append(svg_text(r["lx"], r["ly"] + k * 13, st["fs_label"], st["label_color"],
                                    r["anchor"], t))
        for end in r["ends"]:
            out.append(_card_svg(end["card"], end["x"], end["y"], end["side"], st["edge_color"]))
    out += svg_close()
    return "\n".join(out)


def render_html(lay, title):
    return _render_html(render_svg(lay, title), title, lay["style"]["font_family"])


def main_cli(args):
    return common_main(args, sys.modules[__name__])


if __name__ == "__main__":
    ap = common_argparse("flow-canvas ER 图布局器（erspec/2）")
    raise SystemExit(main_cli(ap.parse_args()))
