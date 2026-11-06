#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""架构图布局模块（layout_arch）。实现 archspec/4 契约，见 contract/archspec-v4.md。

v4 核心（对齐「结构化图形渲染」规范：先语义模型，再固定视觉规则渲染）：
- 样式注册表：一种语义 = 一种唯一视觉——外部实体（中性填充+虚线框）、
  组件容器（实线圆角矩形）、数据存储（圆柱体）、系统边界（粗实线框）、
  逻辑层（弱化背景带无边框）、同步调用（实线实心箭头）、异步事件（虚线空心箭头）；
  虚线只表达「外部实体」一种语义。
- 拓扑驱动排版：先按图拓扑做邻接重心列对齐（父节点居中于子节点组、兄弟对称），
  再填充文字；对齐后常见父子边直接垂直落下（0 折弯），跨层总线 ≤ 2 折弯。
- 节点三层文字：名称 / 次级职责 / 状态徽标（`｜` 分隔），字号硬阈值 ≥ 10px。
- 注释锚点：todo 带 [A1] 编号，节点/边标签尾部 [A1] 挂接，孤儿双向警告。
- view 图种指令（context/container/deployment/data-flow/information-architecture）。
- 图例由实际使用的样式自动生成（含边型），未用到的类型不出现。
"""
import re
import sys

from flowcommon import (
    COMMON_STYLE, text_width, esc,
    ortho_crossings, box_overlaps,
    label_rect, _rects_overlap, _seg_hits_rect, label_collisions,
    svg_open, svg_close, arrow_marker, svg_text,
    render_html as _render_html, common_argparse, common_main)

SPEC_VERSION = "archspec/5"
DATA_ATTR = 'data-archspec="5"'

STYLE = dict(COMMON_STYLE)
STYLE.update({
    "fill_external": "#f2f2f2",
    "stroke_external": "#777777",
    "fill_backend": "#ececec",
    "stroke_backend": "#555555",
    "band_fill": "#f7f7f7",
    "band_stroke": "#e0e0e0",
    "band_text": "#777777",
    "boundary_stroke": "#444444",
    "fs_section": 12,
    "fs_title": 15,
    "fs_meta": 11,
    "fs_legend": 11,
    "fs_todo": 11,
    "fs_sub": 11,
    "fs_badge": 10,
    "label_color": "#666666",
    "async_edge": "#666666",
    "pill_fill": "#eeeeee",
    "pill_stroke": "#cccccc",
    "pill_text": "#555555",
    "note_fill": "#fdf3d8",
    "note_stroke": "#c9a86a",
    "note_text": "#8a6d1a",
    "gap_base": 60,
    "gap_step": 14,
})

MIN_FS = 10  # 可读性硬阈值：正文最小字号（50% 缩放可读的引擎侧保证）
MAX_LANES = 6
VIEW_CN = {
    "context": "系统上下文",
    "container": "容器",
    "deployment": "部署",
    "data-flow": "数据流",
    "information-architecture": "信息架构",
}
ID_RE = re.compile(r'([A-Za-z][A-Za-z0-9_]*)')
REF_RE = re.compile(r'\[([A-Za-z][A-Za-z0-9]*)\]\s*$')
NODE_SHAPES = [
    (re.compile(r'^\[\["(.*)"\]\]'), "external"),
    (re.compile(r'^\[\[(.*)\]\]'), "external"),
    (re.compile(r'^\[\("(.*)"\)\]'), "datastore"),
    (re.compile(r'^\[\((.*)\)\]'), "datastore"),
    (re.compile(r'^\["(.*)"\]'), "process"),
    (re.compile(r'^\[(.*)\]'), "process"),
    (re.compile(r'^\("(.*)"\)'), "rounded"),
    (re.compile(r'^\((.*)\)'), "rounded"),
]
DECISION_RE = re.compile(r'^\{"?(.*?)"?\}')
CLASS_TYPE = {"external": "external", "backend": "backend", "back": "backend"}


def _split_refs(text):
    """从文本尾部剥离 [A1] 式锚点，返回 (正文, refs)。"""
    refs = []
    t = text.strip()
    while True:
        m = REF_RE.search(t)
        if not m:
            break
        refs.insert(0, m.group(1))
        t = t[:m.start()].rstrip()
    return t, refs


def parse_mermaid(src):
    nodes, order, edges = {}, [], []
    tops = []
    subs = []
    top_ids = []
    meta = {"title": "", "view": "", "scope": "", "version": "", "todos": []}

    def ensure(nid, label=None, ntype=None, shape=None):
        if nid not in nodes:
            nodes[nid] = {"id": nid, "type": "process", "shape": "rect",
                          "segs": [{"text": nid, "refs": []}], "refs": [], "label": [nid]}
            order.append(nid)
            if subs:
                if nid not in subs[-1]["ids"]:
                    subs[-1]["ids"].append(nid)
            else:
                top_ids.append(nid)
        if label is not None:
            parts = [p.strip() for p in label.split("｜") if p.strip()]
            if len(parts) > 3:
                raise SystemExit("错误：节点 %s 标签层级超过 3 层（名称/次级职责/状态，形态超限）" % nid)
            segs, refs = [], []
            for p in parts:
                txt, r = _split_refs(p)
                segs.append({"text": txt, "refs": r})
                refs += r
            nodes[nid]["segs"] = segs
            nodes[nid]["refs"] = refs
            nodes[nid]["label"] = [s["text"] for s in segs]
        if ntype is not None:
            nodes[nid]["type"] = ntype
        if shape is not None:
            nodes[nid]["shape"] = shape

    def eat_node(chunk):
        m = ID_RE.match(chunk)
        if not m:
            return None
        nid = m.group(1)
        rest = chunk[m.end():]
        if DECISION_RE.match(rest):
            raise SystemExit("错误：架构图不支持判断菱形节点 %s（形态超限，请改用 mermaid 原生渲染）" % nid)
        for rx, shape in NODE_SHAPES:
            sm = rx.match(rest)
            if sm:
                ntype = "external" if shape == "external" else ("backend" if shape == "datastore" else None)
                ensure(nid, sm.group(1), ntype, shape)
                return nid
        ensure(nid)
        return nid

    for raw in src.splitlines():
        line = raw.strip()
        if not line or line.startswith("%%"):
            continue
        if line.startswith("title "):
            meta["title"] = line[6:].strip().strip('"')
            continue
        if line.startswith("view "):
            v = line[5:].strip()
            if v not in VIEW_CN:
                raise SystemExit("错误：view %s 不支持（形态超限：context/container/deployment/"
                                 "data-flow/information-architecture）" % v)
            meta["view"] = v
            continue
        if line.startswith("scope "):
            meta["scope"] = line[6:].strip().strip('"')
            continue
        if line.startswith("version "):
            meta["version"] = line[8:].strip().strip('"')
            continue
        if line.startswith("todo "):
            t = line[5:].strip().strip('"')
            m = re.match(r'^\[([A-Za-z][A-Za-z0-9]*)\]\s*(.*)$', t)
            if m:
                meta["todos"].append({"id": m.group(1), "text": m.group(2)})
            else:
                meta["todos"].append({"id": "A%d" % (len(meta["todos"]) + 1), "text": t})
            continue
        if (line.startswith("flowchart") or line.startswith("graph")
                or line.startswith("classDef") or line.startswith("direction")):
            continue
        if line.startswith("subgraph"):
            if len(subs) >= 2:
                raise SystemExit("错误：subgraph 嵌套超过两层（形态超限：仅支持 系统边界 > 逻辑层 两层）")
            m = re.match(r'^subgraph\s*(.*?)\s*$', line)
            s = {"title": (m.group(1) if m else "").strip() or "", "ids": [], "subs": []}
            if subs:
                subs[-1]["subs"].append(s)
            else:
                tops.append(s)
            subs.append(s)
            continue
        if line.startswith("end"):
            if subs:
                subs.pop()
            continue
        cm = re.match(r'^class\s+([\w,\s]+?)\s+(\w+);?$', line)
        if cm:
            t = CLASS_TYPE.get(cm.group(2).lower())
            if t:
                for nid in [x.strip() for x in cm.group(1).split(",")]:
                    ensure(nid)
                    nodes[nid]["type"] = t
            continue
        if "-->" in line or "-.->" in line:
            parts = re.split(r'\s*(?:-->|-\.->)\s*', line)
            for i in range(len(parts) - 1):
                left, right = parts[i], parts[i + 1]
                label = ""
                lm = re.match(r'^\|(.*?)\|\s*(.*)$', right)
                if lm:
                    label = lm.group(1).strip().strip('"')
                    right = lm.group(2)
                txt, refs = _split_refs(label)
                a = eat_node(left.strip())
                b = eat_node(right.strip())
                if a and b:
                    edges.append({"from": a, "to": b,
                                  "label": [txt] if txt else [],
                                  "refs": refs,
                                  "async": "-.->" in line})
            continue
        eat_node(line)

    # ── 边界 / 泳道 / 外部实体归类 ───────────────────────────────────
    boundaries = [s for s in tops if s["subs"]]
    if len(boundaries) > 1:
        raise SystemExit("错误：检测到多个系统边界（形态超限：一张图只允许一个最外层 subgraph 作系统边界）")
    lane_of = {}
    boundary = None
    externals = []
    lanes = []
    if boundaries:
        b = boundaries[0]
        if any(s is not b and s["ids"] for s in tops):
            raise SystemExit("错误：系统边界之外不允许独立泳道层（形态超限：请并入边界或作为外部实体）")
        lanes = [{"title": s["title"], "ids": list(s["ids"])} for s in b["subs"]]
        if b["ids"]:
            lanes.append({"title": "", "ids": list(b["ids"])})
        boundary = {"title": b["title"]}
        externals = list(top_ids)
    else:
        lanes = [{"title": s["title"], "ids": list(s["ids"])} for s in tops]
        if top_ids:
            lanes.append({"title": "其他", "ids": list(top_ids)})
    lanes = [l for l in lanes if l["ids"]]
    if not lanes:
        raise SystemExit("错误：没有可布局的泳道/节点（形态超限）")
    if boundary and len(lanes) == 0:
        raise SystemExit("错误：系统边界内没有节点（形态超限）")
    for li, l in enumerate(lanes):
        for nid in l["ids"]:
            lane_of[nid] = li
    for nid in nodes:
        if nid not in lane_of and nid not in externals:
            raise SystemExit("错误：节点 %s 的泳道丢失（形态超限）" % nid)
    return {"spec": SPEC_VERSION, "nodes": [nodes[i] for i in order],
            "edges": edges, "lanes": lanes, "lane_of": lane_of,
            "boundary": boundary, "externals": externals, "meta": meta}


def load_spec(path):
    text = open(path, encoding="utf-8").read()
    return parse_mermaid(text)


def iter_labels(spec):
    m = spec.get("meta") or {}
    if m.get("title"):
        yield m["title"]
    if m.get("view"):
        yield VIEW_CN[m["view"]]
    for k in ("scope", "version"):
        if m.get(k):
            yield m[k]
    for t in m.get("todos", []):
        yield t["id"]
        yield t["text"]
    b = spec.get("boundary")
    if b and b.get("title"):
        yield b["title"]
    for n in spec["nodes"]:
        for seg in n.get("segs", []):
            yield seg["text"]
            for r in seg["refs"]:
                yield r
    for e in spec["edges"]:
        for l in e.get("label", []):
            yield l
        for r in e.get("refs", []):
            yield r
    for lane in spec["lanes"]:
        if lane.get("title"):
            yield lane["title"]


def _node_style(n):
    if n["type"] == "external" or n["shape"] == "external":
        return "external"
    if n["type"] == "backend":
        return "datastore"
    return "container"


def _node_size(n, st):
    segs = n.get("segs") or [{"text": t, "refs": []} for t in n["label"]]
    line_h = {0: st["fs_node"] + 4, 1: st["fs_sub"] + 4, 2: 20}
    widths = []
    for j, seg in enumerate(segs):
        fs_j = st["fs_node"] if j == 0 else (st["fs_sub"] if j == 1 else st["fs_badge"])
        widths.append(text_width(seg["text"], fs_j) + (30 if j < 2 else 28))
    refs = n.get("refs") or []
    if refs:
        ref_w = sum(text_width("[%s]" % r, st["fs_badge"]) + 8 for r in refs) \
            + 4 * (len(refs) - 1) + 24
        widths.append(ref_w)
    w = max(90, max(widths or [90]))
    h = 18 + sum(line_h[j] for j in range(len(segs))) + (16 if refs else 0)
    # 数据存储圆柱体需要内部文字安全区：最小高度保证上下椭圆不与文字抢位
    if _node_style(n) == "datastore":
        h = max(h, 44)
    return round(w / 2) * 2, round(h / 2) * 2


def _place(spec, st):
    lanes = [dict(l) for l in spec["lanes"]]
    lane_of = dict(spec["lane_of"])
    edges = [dict(e) for e in spec["edges"]]
    boundary = spec.get("boundary")
    ext_ids = list(spec.get("externals") or [])
    ext_set = set(ext_ids)
    meta = spec.get("meta") or {}
    N = {}
    for n in spec["nodes"]:
        nd = dict(n)
        nd["w"], nd["h"] = _node_size(nd, st)
        N[nd["id"]] = nd
    if len(lanes) > MAX_LANES:
        raise SystemExit("错误：泳道数 %d 超过上限 %d（形态超限）" % (len(lanes), MAX_LANES))
    # 同级节点统一高度（同类节点尺寸稳定，端口与文字不再随文字长度漂移）
    for li, l in enumerate(lanes):
        mh = max(N[i]["h"] for i in l["ids"])
        for i in l["ids"]:
            N[i]["h"] = mh
    if ext_ids:
        mh = max(N[i]["h"] for i in ext_ids)
        for i in ext_ids:
            N[i]["h"] = mh

    warnings = []
    # 字号硬阈值：任何字体键不得低于 MIN_FS（防 --style 覆盖破坏可读性）
    for key, val in st.items():
        if key.startswith("fs_") and isinstance(val, int) and val < MIN_FS:
            warnings.append("样式 fs 值 %s=%d 低于可读性硬阈值 %dpx" % (key, val, MIN_FS))

    # ── 边分类 ───────────────────────────────────────────────────────
    for e in edges:
        if not e.get("label"):
            warnings.append("边 %s→%s 无语义标签：建议标注协议/行为（如「HTTPS：请求/响应」）"
                            % (e["from"], e["to"]))
        a_out, b_out = e["from"] in ext_set, e["to"] in ext_set
        if a_out and b_out:
            ids = ext_ids
            ia, ib = ids.index(e["from"]), ids.index(e["to"])
            e["kind"] = "ext_adj" if abs(ia - ib) == 1 else "ext_ext"
            e["up"] = ia < ib
        elif a_out:
            e["kind"] = "ext_int"
        elif b_out:
            e["kind"] = "int_ext"
        else:
            li, lj = lane_of[e["from"]], lane_of[e["to"]]
            if li == lj:
                ids = lanes[li]["ids"]
                ia, ib = ids.index(e["from"]), ids.index(e["to"])
                if abs(ia - ib) == 1:
                    e["kind"] = "adj"
                    e["up"] = ia < ib
                else:
                    e["kind"] = "same_skip"
            elif abs(li - lj) == 1:
                e["kind"] = "bus"
            else:
                e["kind"] = "cross_skip"

    # ── 注释锚点：孤儿双向警告 ───────────────────────────────────────
    refs_used = set()
    for n in spec["nodes"]:
        refs_used |= set(n.get("refs") or [])
    for e in edges:
        refs_used |= set(e.get("refs") or [])
    todo_ids = [t["id"] for t in meta.get("todos", [])]
    for t in meta.get("todos", []):
        if t["id"] not in refs_used:
            warnings.append("待确认项 [%s]「%s」未挂接到任何节点或关系" % (t["id"], t["text"]))
    for r in sorted(refs_used):
        if r not in todo_ids:
            warnings.append("锚点 [%s] 没有对应的 todo 注释" % r)

    fs = st["fs_node"]
    margin = 20
    gap_h = st["gap_base"]
    step_y = st["gap_step"]

    # ── 页眉 ─────────────────────────────────────────────────────────
    header_bottom = margin
    if meta.get("title"):
        header_bottom = margin + 20
    meta_line = " · ".join([x for x in (
        ("图种：" + VIEW_CN[meta["view"]]) if meta.get("view") else "",
        meta.get("scope"), meta.get("version")) if x])
    if meta_line:
        header_bottom += 18

    # ── 泳道带高度与标题列 ──────────────────────────────────────────
    band_h = [max([N[i]["h"] for i in l["ids"]] or [36]) + 24 for l in lanes]
    n_lanes = len(lanes)
    title_w = max([text_width(l["title"], st["fs_section"]) for l in lanes if l["title"]] or [0])
    band_x = margin + (title_w + 16 if title_w else 0)

    # ── 外部实体行 ──────────────────────────────────────────────────
    ext_row_right = 0.0
    if ext_ids:
        ext_h = max(N[i]["h"] for i in ext_ids)
        y_ext = header_bottom + 12 + ext_h / 2
        x = band_x + 12
        for nid in ext_ids:
            n = N[nid]
            n["x"] = x + n["w"] / 2
            n["y"] = y_ext
            x += n["w"] + 40
        ext_row_right = x - 40
        ext_bottom = y_ext + ext_h / 2
    else:
        ext_bottom = header_bottom

    # ── 顶部走廊带 ──────────────────────────────────────────────────
    n_top_users = sum(
        1 for e in edges if (
            (e["kind"] == "same_skip" and lane_of[e["from"]] == 0)
            or e["kind"] in ("ext_int", "int_ext", "ext_ext")))
    y_zone = ext_bottom + 14
    y_band_top = y_zone + 7 * 2 * (n_top_users + 4) + 10

    lane_y = []
    y = y_band_top
    for hb in band_h:
        lane_y.append(y + hb / 2)
        y += hb + gap_h
    y_end = y - gap_h

    bus_y = {}
    for g in range(n_lanes - 1):
        bus_y[g] = lane_y[g] + band_h[g] / 2 + gap_h / 2

    # ── 泳道内相邻对间隙（容纳邻边标签）─────────────────────────────
    row_gap_base = 30
    pair_gap = {}
    for e in edges:
        if e["kind"] == "adj":
            li = lane_of[e["from"]]
            ids = lanes[li]["ids"]
            ia = ids.index(e["from"])
            key = (li, min(ia, ids.index(e["to"])))
            need = max([text_width(l, st["fs_label"]) for l in e.get("label", [])] or [0]) + 16
            pair_gap[key] = max(pair_gap.get(key, row_gap_base), need)
    # 扇出标签留白：同一源扇出到同泳道相邻两目标时，间隙须容纳标签宽
    # （源列居中于目标组，标签不得越过源列/目标列触到相邻边的垂直段）
    src_targets = {}
    for e in edges:
        if e["kind"] == "bus":
            src_targets.setdefault(e["from"], []).append(e["to"])
            src_targets.setdefault(e["to"], []).append(e["from"])
    for src, tgts in src_targets.items():
        by_lane = {}
        for t in tgts:
            by_lane.setdefault(lane_of[t], []).append(t)
        for li, tl in by_lane.items():
            ids = lanes[li]["ids"]
            for i in range(len(ids) - 1):
                if ids[i] in tl and ids[i + 1] in tl:
                    lw = max([max([text_width(l, st["fs_label"]) for l in e.get("label", [])] or [0])
                              for e in edges if e["kind"] == "bus" and e["from"] == src
                              and e["to"] in (ids[i], ids[i + 1])] or [0])
                    if lw:
                        need = 2 * (lw + 8) - (N[ids[i]]["w"] + N[ids[i + 1]]["w"]) / 2
                        pair_gap[(li, i)] = max(pair_gap.get((li, i), row_gap_base), need)

    # ── 初始横向排布（泳道内左包；外部实体行固定间距 40）────────────
    for li, l in enumerate(lanes):
        x = band_x + 12
        for k, nid in enumerate(l["ids"]):
            n = N[nid]
            if k:
                x += pair_gap.get((li, k - 1), row_gap_base)
            n["x"] = x + n["w"] / 2
            n["y"] = lane_y[li]
            x += n["w"]

    # ── 拓扑列对齐：邻接重心 3 轮 + 每轮行内最小间隔双扫 ────────────
    # 目标：父节点居中于子节点组、兄弟对称；行内顺序与邻接标签间隙保持。
    def _sweep_row(ids, gap_fn):
        for k, nid in enumerate(ids):
            n = N[nid]
            if k == 0:
                n["x"] = max(pref[nid], band_x + 12 + n["w"] / 2)
            else:
                p = N[ids[k - 1]]
                sep = (p["w"] + n["w"]) / 2 + gap_fn(k - 1)
                n["x"] = max(pref[nid], p["x"] + sep)
        for k in range(len(ids) - 2, -1, -1):
            n = N[ids[k]]
            nx = N[ids[k + 1]]
            sep = (n["w"] + nx["w"]) / 2 + gap_fn(k)
            n["x"] = min(n["x"], nx["x"] - sep)

    pref = {nid: N[nid]["x"] for nid in N}
    for _round in range(6):
        for nid, n in N.items():
            nbs = []
            for e in edges:
                if e["from"] == nid:
                    nbs.append(e["to"])
                if e["to"] == nid:
                    nbs.append(e["from"])
            if nbs:
                pref[nid] = sum(N[b]["x"] for b in nbs) / len(nbs)
            else:
                pref[nid] = N[nid]["x"]
        if ext_ids:
            _sweep_row(ext_ids, lambda k: 40)
        for li, l in enumerate(lanes):
            _sweep_row(l["ids"], lambda k, _li=li: pair_gap.get((_li, k), row_gap_base))

    # 画布带宽度按对齐后的实际范围计算
    max_right = max((n["x"] + n["w"] / 2 for nid, n in N.items() if nid not in ext_set),
                    default=band_x)
    band_w = round(max_right - band_x) + 12
    content_right = band_x + band_w

    # ── 端口错位 ────────────────────────────────────────────────────
    port_use = {}

    def _use(nid, side, eid):
        port_use.setdefault((nid, side), []).append(eid)

    for e in edges:
        li = lane_of.get(e["from"])
        lj = lane_of.get(e["to"])
        k = e["kind"]
        if k == "bus":
            _use(e["from"], "B" if li < lj else "T", id(e))
            _use(e["to"], "T" if li < lj else "B", id(e))
        elif k == "same_skip":
            _use(e["from"], "T", id(e))
            _use(e["to"], "T", id(e))
        elif k == "cross_skip":
            _use(e["from"], "B", id(e))
            _use(e["to"], "B", id(e))
        elif k == "ext_int":
            _use(e["from"], "B", id(e))
            _use(e["to"], "T", id(e))
            _use(e["to"], "B", id(e))
        elif k == "int_ext":
            _use(e["from"], "T", id(e))
            _use(e["from"], "B", id(e))
            _use(e["to"], "B", id(e))
        elif k == "ext_ext":
            _use(e["from"], "B", id(e))
            _use(e["to"], "B", id(e))
    port_off = {}
    for (nid, side), ids in port_use.items():
        n = len(ids)
        for k, eid in enumerate(ids):
            port_off[eid] = (k - (n - 1) / 2) * 8

    # ── 走廊带候选 y ────────────────────────────────────────────────
    used_y = {}

    def _top_cands():
        # 顶部走廊带加密通道（7px 一档，供外部边在既有通道之间穿插）
        return [y_zone + 7 * k for k in range(2 * (n_top_users + 4))]

    def _gap_above_cands(li):
        top_edge = lane_y[li] - band_h[li] / 2
        by_above = bus_y[li - 1]
        return [top_edge - 12 - step_y * k for k in range(4)] + \
               [by_above - 12 - step_y * k for k in range(2)]

    def _gap_below_cands(li):
        if li >= n_lanes - 1:
            return [y_end + 16 + step_y * k for k in range(5)]
        bb = bus_y[li]
        return [bb + 16 + step_y * k for k in range(2)] + \
               [bb - 16 - step_y * k for k in range(2)]

    def _bottom_cands():
        # 底部总线：所有走底的边共享同一 y（T 形汇入端点互不计数，共线重叠不计）
        return [y_end + 24]

    # ── 右侧线廊 x ──────────────────────────────────────────────────
    corridor_users = [e for e in edges if e["kind"] in ("cross_skip", "ext_int", "int_ext")]

    def _span(e):
        k = e["kind"]
        if k == "cross_skip":
            return abs(lane_of[e["from"]] - lane_of[e["to"]])
        if k == "ext_int":
            return n_lanes - lane_of[e["to"]] + 1
        return lane_of[e["from"]] + 1

    corridor_sorted = sorted(corridor_users, key=_span)
    base_right = max(content_right, ext_row_right + 8 if ext_ids else 0)
    corridor_x = {}
    for k, e in enumerate(corridor_sorted):
        corridor_x[id(e)] = base_right + 18 + step_y * k

    # ── 确定性路由（对齐后可直落：0 折弯）────────────────────────────
    routes = []

    def _push(rid, e, pts, lx, ly, anchor="middle"):
        routes.append({"id": rid, "from": e["from"], "to": e["to"],
                       "pts": pts, "label": e.get("label", []), "refs": e.get("refs", []),
                       "async": e.get("async", False),
                       "lx": lx, "ly": ly, "anchor": anchor, "arrow": True})

    def _aligned(a, b):
        return abs(a["x"] - b["x"]) < 0.5

    for e in edges:
        a, b = N[e["from"]], N[e["to"]]
        off = port_off.get(id(e), 0)
        rid = "%s-%s-%d" % (e["from"], e["to"], len(routes))
        if e["kind"] == "adj":
            if e["up"]:
                pts = [(a["x"] + a["w"] / 2, a["y"]), (b["x"] - b["w"] / 2, b["y"])]
            else:
                pts = [(a["x"] - a["w"] / 2, a["y"]), (b["x"] + b["w"] / 2, b["y"])]
            _push(rid, e, pts, (pts[0][0] + pts[1][0]) / 2, a["y"] - 12)
            continue
        if e["kind"] == "ext_adj":
            if e["up"]:
                pts = [(a["x"] + a["w"] / 2, a["y"]), (b["x"] - b["w"] / 2, b["y"])]
            else:
                pts = [(a["x"] - a["w"] / 2, a["y"]), (b["x"] + b["w"] / 2, b["y"])]
            _push(rid, e, pts, (pts[0][0] + pts[1][0]) / 2, a["y"] - 12)
            continue
        if e["kind"] == "bus":
            by = bus_y[min(lane_of[e["from"]], lane_of[e["to"]])]
            if lane_of[e["from"]] < lane_of[e["to"]]:
                sx, sy = a["x"] + off, a["y"] + a["h"] / 2
                tx, ty = b["x"] - off, b["y"] - b["h"] / 2
            else:
                sx, sy = a["x"] + off, a["y"] - a["h"] / 2
                tx, ty = b["x"] - off, b["y"] + b["h"] / 2
            if abs(sx - tx) < 0.5:  # 列对齐：垂直直落 0 折弯
                pts = [(sx, sy), (tx, ty)]
                _push(rid, e, pts, sx + 12, (sy + ty) / 2 - 10, anchor="start")
            else:
                pts = [(sx, sy), (sx, by), (tx, by), (tx, ty)]
                lw = max([text_width(l, st["fs_label"]) for l in e.get("label", [])] or [0])
                if abs(sx - tx) >= lw + 16:
                    # 标签钳制在水平段内并避开两端垂直列（扇出标签不得戳过源/目标列）
                    mid = (sx + tx) / 2
                    if tx > sx:
                        lx = max(mid, sx + lw / 2 + 6)
                    else:
                        lx = min(mid, sx - lw / 2 - 6)
                    _push(rid, e, pts, lx, by - 8)
                else:
                    # 水平段放不下：标签竖排在源侧垂直段旁
                    _push(rid, e, pts, sx + 10, (sy + by) / 2 - 10, anchor="start")
            continue

    skip_edges = sorted([e for e in edges if e["kind"] not in ("adj", "ext_adj", "bus")],
                        key=lambda e: _span(e) if e["kind"] != "same_skip" else 0)
    placed_label_rects = []  # 已放置路由的标签盒（候选评估时避让）
    for e in skip_edges:
        a, b = N[e["from"]], N[e["to"]]
        k = e["kind"]
        li = lane_of.get(e["from"])
        lj = lane_of.get(e["to"])
        off = port_off.get(id(e), 0)
        cands = []
        # 直落候选：外部实体与顶层泳道节点列对齐时优先 0 折弯直线
        if k == "ext_int" and lj == 0 and _aligned(a, b):
            sx, sy = a["x"] + off, a["y"] + a["h"] / 2
            tx, ty = b["x"] - off, b["y"] - b["h"] / 2
            cands.append({"pts": [(sx, sy), (tx, ty)], "lx": sx + 12, "ly": (sy + ty) / 2 - 10,
                          "anchor": "start", "bands": []})
        if k == "int_ext" and li == 0 and _aligned(a, b):
            sx, sy = a["x"] + off, a["y"] - a["h"] / 2
            tx, ty = b["x"] - off, b["y"] + b["h"] / 2
            cands.append({"pts": [(sx, sy), (tx, ty)], "lx": sx + 12, "ly": (sy + ty) / 2 - 10,
                          "anchor": "start", "bands": []})
        if k == "same_skip":
            # 上侧走廊：顶端口出线（顶部泳道走顶部走廊带）
            sx, sy = a["x"] + off, a["y"] - a["h"] / 2
            tx, ty = b["x"] - off, b["y"] - b["h"] / 2
            band = "top" if li == 0 else "above-%d" % li
            ys = _top_cands() if li == 0 else _gap_above_cands(li)
            for yc in ys:
                cands.append({"pts": [(sx, sy), (sx, yc), (tx, yc), (tx, ty)],
                              "lx": (sx + tx) / 2, "ly": yc - 6, "anchor": "middle",
                              "bands": [(band, yc)]})
            # 下侧走廊：底端口出线（对齐错位时上侧可能被相邻总线封死）
            sx2, sy2 = a["x"] + off, a["y"] + a["h"] / 2
            tx2, ty2 = b["x"] - off, b["y"] + b["h"] / 2
            band2 = "below-%d" % li
            for yc in _gap_below_cands(li):
                cands.append({"pts": [(sx2, sy2), (sx2, yc), (tx2, yc), (tx2, ty2)],
                              "lx": (sx2 + tx2) / 2, "ly": yc - 6, "anchor": "middle",
                              "bands": [(band2, yc)]})
        elif k == "ext_ext":
            sx, sy = a["x"] + off, a["y"] + a["h"] / 2
            tx, ty = b["x"] - off, b["y"] + b["h"] / 2
            for yc in _top_cands():
                cands.append({"pts": [(sx, sy), (sx, yc), (tx, yc), (tx, ty)],
                              "lx": (sx + tx) / 2, "ly": yc - 6, "anchor": "middle",
                              "bands": [("top", yc)]})
        elif k == "ext_int":
            sx, sy = a["x"] + off, a["y"] + a["h"] / 2
            tx, ty = b["x"] - off, b["y"] - b["h"] / 2
            cxx = corridor_x[id(e)]
            if lj == 0:
                for yc in _top_cands():
                    cands.append({"pts": [(sx, sy), (sx, yc), (tx, yc), (tx, ty)],
                                  "lx": (sx + tx) / 2, "ly": yc - 6, "anchor": "middle",
                                  "bands": [("top", yc)]})
            else:
                for y1 in _top_cands():
                    for y2 in _gap_above_cands(lj):
                        if y2 == y1:
                            continue
                        cands.append({"pts": [(sx, sy), (sx, y1), (cxx, y1),
                                              (cxx, y2), (tx, y2), (tx, ty)],
                                      "lx": (sx + cxx) / 2, "ly": y1 - 6, "anchor": "middle",
                                      "bands": [("top", y1), ("above-%d" % lj, y2)]})
            # 下侧入线族（上侧被总线封死时走）：顶部带 → 线廊 → 目标下方 gap → 底端口
            bx, by_ = b["x"] - off, b["y"] + b["h"] / 2
            for y1 in _top_cands():
                for y2 in _gap_below_cands(lj):
                    if y2 == y1:
                        continue
                    cands.append({"pts": [(sx, sy), (sx, y1), (cxx, y1),
                                          (cxx, y2), (bx, y2), (bx, by_)],
                                  "lx": (sx + cxx) / 2, "ly": y1 - 6, "anchor": "middle",
                                  "bands": [("top", y1), ("below-%d" % lj, y2)]})
            # 侧端口入线族（目标为本泳道最右节点时）：顶部带 → 线廊 → 目标右端口
            ids_t = lanes[lj]["ids"]
            if ids_t.index(e["to"]) == len(ids_t) - 1:
                bx2, by2 = b["x"] + b["w"] / 2, b["y"]
                for y1 in _top_cands():
                    cands.append({"pts": [(sx, sy), (sx, y1), (cxx, y1), (cxx, by2), (bx2, by2)],
                                  "lx": sx + 10, "ly": sy + 10, "anchor": "start",
                                  "bands": [("top", y1)]})
            # 左侧线廊入线族（目标为本泳道最左节点时）：顶部带 → 左廊 → 目标左端口
            if ids_t.index(e["to"]) == 0:
                xl = band_x - 12
                bx2, by2 = b["x"] - b["w"] / 2, b["y"]
                for y1 in _top_cands():
                    cands.append({"pts": [(sx, sy), (sx, y1), (xl, y1), (xl, by2), (bx2, by2)],
                                  "lx": sx + 10, "ly": sy + 10, "anchor": "start",
                                  "bands": [("top", y1)]})
        elif k == "int_ext":
            sx, sy = a["x"] + off, a["y"] - a["h"] / 2
            tx, ty = b["x"] - off, b["y"] + b["h"] / 2
            cxx = corridor_x[id(e)]
            if li == 0:
                for yc in _top_cands():
                    cands.append({"pts": [(sx, sy), (sx, yc), (tx, yc), (tx, ty)],
                                  "lx": (sx + tx) / 2, "ly": yc - 6, "anchor": "middle",
                                  "bands": [("top", yc)]})
            else:
                for y2 in _top_cands():
                    for y1 in _gap_above_cands(li):
                        if y1 == y2:
                            continue
                        cands.append({"pts": [(sx, sy), (sx, y1), (cxx, y1),
                                              (cxx, y2), (tx, y2), (tx, ty)],
                                      "lx": (sx + cxx) / 2, "ly": y1 - 6, "anchor": "middle",
                                      "bands": [("above-%d" % li, y1), ("top", y2)]})
            # 下侧出线族：源底端口 → 源下方 gap → 线廊 → 顶部带 → 外部底端口
            ax, ay_ = a["x"] + off, a["y"] + a["h"] / 2
            for y2 in _top_cands():
                for y1 in _gap_below_cands(li):
                    if y1 == y2:
                        continue
                    cands.append({"pts": [(ax, ay_), (ax, y1), (cxx, y1),
                                          (cxx, y2), (tx, y2), (tx, ty)],
                                  "lx": (ax + cxx) / 2, "ly": y1 - 6, "anchor": "middle",
                                  "bands": [("below-%d" % li, y1), ("top", y2)]})
            # 侧端口出线族（源为本泳道最右节点时）：源右端口 → 线廊 → 顶部带 → 外部
            ids_s = lanes[li]["ids"]
            if ids_s.index(e["from"]) == len(ids_s) - 1:
                ax2, ay2 = a["x"] + a["w"] / 2, a["y"]
                for y2 in _top_cands():
                    cands.append({"pts": [(ax2, ay2), (cxx, ay2), (cxx, y2), (tx, y2), (tx, ty)],
                                  "lx": (ax2 + cxx) / 2, "ly": ay2 - 6, "anchor": "middle",
                                  "bands": [("top", y2)]})
            # 左侧线廊出线族（源为本泳道最左节点时）：源左端口 → 左廊 → 顶部带 → 外部
            if ids_s.index(e["from"]) == 0:
                xl = band_x - 12
                ax2, ay2 = a["x"] - a["w"] / 2, a["y"]
                for y2 in _top_cands():
                    cands.append({"pts": [(ax2, ay2), (xl, ay2), (xl, y2), (tx, y2), (tx, ty)],
                                  "lx": (xl + tx) / 2, "ly": y2 - 6, "anchor": "middle",
                                  "bands": [("top", y2)]})
        else:  # cross_skip
            cxx = corridor_x[id(e)]
            sx, sy = a["x"] + off, a["y"] + a["h"] / 2
            tx, ty = b["x"] - off, b["y"] + b["h"] / 2
            ids_a = lanes[li]["ids"]
            pos_a = ids_a.index(e["from"])
            # 左/右侧线廊出线（源为本泳道最左/最右节点时绕开饱和间隙）
            if pos_a == 0:
                xl = band_x - 12
                for yb in _bottom_cands():
                    cands.append({"pts": [(a["x"] - a["w"] / 2, a["y"]), (xl, a["y"]),
                                          (xl, yb), (tx, yb), (tx, ty)],
                                  "lx": (xl + tx) / 2, "ly": yb - 6, "anchor": "middle",
                                  "bands": [("bottom", yb)]})
            if pos_a == len(ids_a) - 1:
                xr = base_right + 12
                for yb in _bottom_cands():
                    cands.append({"pts": [(a["x"] + a["w"] / 2, a["y"]), (xr, a["y"]),
                                          (xr, yb), (tx, yb), (tx, ty)],
                                  "lx": (xr + tx) / 2, "ly": yb - 6, "anchor": "middle",
                                  "bands": [("bottom", yb)]})
            # 底部空白带直落（源/目标列垂直通道无阻挡时 3 段即可，折弯最少优先）
            for yb in _bottom_cands():
                cands.append({"pts": [(sx, sy), (sx, yb), (tx, yb), (tx, ty)],
                              "lx": (sx + tx) / 2, "ly": yb - 6, "anchor": "middle",
                              "bands": [("bottom", yb)]})
            for y1 in _gap_below_cands(li):
                for y2 in _gap_below_cands(lj):
                    if y2 == y1:
                        continue
                    cands.append({"pts": [(sx, sy), (sx, y1), (cxx, y1),
                                          (cxx, y2), (tx, y2), (tx, ty)],
                                  "lx": (sx + cxx) / 2, "ly": y1 - 6, "anchor": "middle",
                                  "bands": [("below-%d" % li, y1), ("below-%d" % lj, y2)]})

        base_count = len(ortho_crossings(routes))
        best = None
        lw_label = e.get("label") or []

        def _trial(c):
            delta = len(ortho_crossings(routes + [{"pts": c["pts"]}])) - base_count
            if lw_label:
                r = label_rect(c["lx"], c["ly"], lw_label[0], st["fs_label"],
                               c.get("anchor", "middle"))
                for rt in routes:
                    for k in range(len(rt["pts"]) - 1):
                        if _seg_hits_rect(rt["pts"][k], rt["pts"][k + 1], r):
                            delta += 1
                            break
                for p in placed_label_rects:
                    if _rects_overlap(r, p):
                        delta += 1
                        break
            return delta

        for c in cands:
            if any(yy in used_y.get(key, ()) for key, yy in c["bands"]):
                continue
            newc = _trial(c)
            c["newc"] = newc
            if best is None or newc < best["newc"]:
                best = c
            if newc == 0:
                break
        if best is None:
            for c in cands:
                newc = _trial(c)
                c["newc"] = newc
                if best is None or newc < best["newc"]:
                    best = c
        for key, yy in best["bands"]:
            if key == "bottom":
                continue  # 底部总线共享同一 y，不占位
            used_y.setdefault(key, set()).add(yy)
        rid = "%s-%s-%d" % (e["from"], e["to"], len(routes))
        _push(rid, e, best["pts"], best["lx"], best["ly"], anchor=best.get("anchor", "middle"))
        if lw_label:
            placed_label_rects.append(label_rect(best["lx"], best["ly"], lw_label[0],
                                                 st["fs_label"], best.get("anchor", "middle")))

    # ── 边标签自动分轨：同一走廊带内文本互叠则上下错行 ──────────────
    lane_groups = {}
    for r in routes:
        if r.get("label"):
            lane_groups.setdefault(round(r["ly"] / step_y), []).append(r)
    for rs in lane_groups.values():
        placed = []
        for r in rs:
            base = label_rect(r["lx"], r["ly"], r["label"][0], st["fs_label"], r["anchor"])
            for delta in (0, 13, -13, 26, -26, 39, -39):
                cand = (base[0], base[1] + delta, base[2], base[3] + delta)
                if all(not _rects_overlap(cand, p) for p in placed):
                    r["ly"] += delta
                    break
            placed.append(label_rect(r["lx"], r["ly"], r["label"][0], st["fs_label"], r["anchor"]))

    # 折弯数 QC：除避障外连线最多两次折弯；超出出 warning
    for r in routes:
        bends = 0
        for i in range(1, len(r["pts"]) - 1):
            h1 = abs(r["pts"][i][1] - r["pts"][i - 1][1]) < 0.01
            h2 = abs(r["pts"][i + 1][1] - r["pts"][i][1]) < 0.01
            if h1 != h2:
                bends += 1
        if bends > 2:
            warnings.append("边 %s 折弯 %d 次（>2：仅避障允许，建议简化拓扑）" % (r["id"], bends))

    # ── 图例（样式注册表驱动：只列图中真实使用的样式）───────────────
    legend = []
    used_styles = {_node_style(n) for n in N.values()}
    if "external" in used_styles:
        legend.append(("外部实体", "ext"))
    if "container" in used_styles:
        legend.append(("组件容器", "comp"))
    if "datastore" in used_styles:
        legend.append(("数据存储", "store"))
    if boundary:
        legend.append(("系统边界", "bnd"))
        if lanes:
            legend.append(("逻辑层", "lane"))
    has_sync = any(not e.get("async") for e in edges)
    has_async = any(e.get("async") for e in edges)
    if has_sync:
        legend.append(("同步调用", "sync"))
    if has_async:
        legend.append(("异步事件", "async"))
    legend_w = max([text_width(t, st["fs_legend"]) for t, _ in legend] or [0]) + 56
    legend_x0 = base_right + 18 + step_y * len(corridor_users) + 14
    legend_y0 = (header_bottom if header_bottom > margin else margin) + 6

    # ── 待确认项区 ──────────────────────────────────────────────────
    todos = meta.get("todos") or []
    todo_h = (18 * len(todos) + 30) if todos else 0
    todo_w = max([text_width("「%s」%s" % (t["id"], t["text"]), st["fs_todo"])
                  for t in todos] or [0]) + 28
    todo_y0 = y_end + 16 + step_y * 5 + 12

    # ── 画布范围 ────────────────────────────────────────────────────
    W = round(max([legend_x0 + legend_w,
                   max([r["pts"][i][0] for r in routes for i in range(len(r["pts"]))] or [0])])
              + 20)
    H = round(max(y_end + 36, todo_y0 + todo_h if todos else 0) + 16)

    crossings = ortho_crossings(routes)
    boxes = [(nid, n["x"], n["y"], n["w"], n["h"]) for nid, n in N.items()]
    overlaps = box_overlaps(boxes)
    overflow = []
    for nid, n in N.items():
        segs = n.get("segs") or [{"text": t, "refs": []} for t in n["label"]]
        for j, seg in enumerate(segs):
            fs_j = st["fs_node"] if j == 0 else (st["fs_sub"] if j == 1 else st["fs_badge"])
            avail = n["w"] - 12 if j < 2 else n["w"] - 28
            need = text_width(seg["text"], fs_j)
            if need > avail:
                overflow.append({"id": nid, "line": j, "text": seg["text"],
                                 "need": round(need), "avail": round(avail)})
        refs = n.get("refs") or []
        if refs:
            need = sum(text_width("[%s]" % r, st["fs_badge"]) + 8 for r in refs) \
                + 4 * (len(refs) - 1) + 24
            if need > n["w"] - 12:
                overflow.append({"id": nid, "line": 99, "text": "refs:%s" % refs,
                                 "need": round(need), "avail": round(n["w"] - 12)})
    for r in routes:
        label_w = text_width(r["label"][0], st["fs_label"]) if r.get("label") else 0
        for j, t in enumerate(r.get("label", [])):
            need = text_width(t, st["fs_label"])
            half = need / 2
            if r["anchor"] == "start":
                if r["lx"] < 2 or r["lx"] + need > W - 2 \
                        or r["ly"] + j * 13 < 4 or r["ly"] + j * 13 > H - 4:
                    overflow.append({"id": r["id"], "line": j, "text": t,
                                     "need": round(need), "avail": round(W - 4)})
            else:
                if r["lx"] - half < 2 or r["lx"] + half > W - 2 \
                        or r["ly"] + j * 13 < 4 or r["ly"] + j * 13 > H - 4:
                    overflow.append({"id": r["id"], "line": j, "text": t,
                                     "need": round(need), "avail": round(W - 4)})
        if r.get("refs"):
            ref_w = sum(text_width("[%s]" % x, st["fs_badge"]) + 4 for x in r["refs"])
            start = r["lx"] + (label_w / 2 if r["anchor"] == "middle" else label_w)
            if start + ref_w > W - 2:
                overflow.append({"id": r["id"], "line": 98, "text": "refs",
                                 "need": round(ref_w), "avail": round(W - 4)})
    if meta.get("title"):
        need = text_width(meta["title"], st["fs_title"])
        if need > legend_x0 - margin - 10:
            overflow.append({"id": "title", "line": 0, "text": meta["title"],
                             "need": round(need), "avail": round(legend_x0 - margin - 10)})
    if meta_line:
        need = text_width(meta_line, st["fs_meta"])
        if need > W - margin * 2:
            overflow.append({"id": "meta", "line": 0, "text": meta_line,
                             "need": round(need), "avail": W - margin * 2})
    if boundary:
        bt = boundary.get("title") or ""
        need = text_width(bt, st["fs_section"])
        avail = content_right + 16 - (band_x - 8)
        if bt and need > avail:
            overflow.append({"id": "boundary-title", "line": 0, "text": bt,
                             "need": round(need), "avail": round(avail)})

    # ── 标签碰撞检测（文本×文本 / ×连线 / ×节点框）──────────────────
    lc_labels = []
    for ri, r in enumerate(routes):
        for j, t in enumerate(r.get("label", [])):
            lc_labels.append({"id": "%s-l%d" % (r["id"], j), "text": t, "lx": r["lx"],
                              "ly": r["ly"] + j * 13, "anchor": r["anchor"], "fs": st["fs_label"],
                              "route": ri, "own": [r.get("from"), r.get("to")]})
        if r.get("refs"):
            lw = text_width(r["label"][0], st["fs_label"]) if r.get("label") else 0
            x = r["lx"] + (lw / 2 if r["anchor"] == "middle" else lw) + 6
            for ref in r["refs"]:
                lc_labels.append({"id": "%s-ref-%s" % (r["id"], ref), "text": "[%s]" % ref,
                                  "lx": x, "ly": r["ly"] + 4, "anchor": "start", "fs": st["fs_badge"],
                                  "route": ri, "own": [r.get("from"), r.get("to")]})
                x += text_width("[%s]" % ref, st["fs_badge"]) + 4
    if meta.get("title"):
        lc_labels.append({"id": "title", "text": meta["title"], "lx": margin, "ly": 34,
                          "anchor": "start", "fs": st["fs_title"], "own": []})
    if meta_line:
        lc_labels.append({"id": "meta", "text": meta_line, "lx": margin, "ly": header_bottom - 3,
                          "anchor": "start", "fs": st["fs_meta"], "own": []})
    if boundary:
        lc_labels.append({"id": "boundary-title", "text": boundary.get("title") or "",
                          "lx": band_x - 8 + 12, "ly": y_band_top - 22 + 16,
                          "anchor": "start", "fs": st["fs_section"], "own": []})
    for k, t in enumerate(todos):
        lc_labels.append({"id": "todo-%s" % t["id"], "text": "「%s」%s" % (t["id"], t["text"]),
                          "lx": 32, "ly": todo_y0 + 33 + k * 18,
                          "anchor": "start", "fs": st["fs_todo"], "own": []})
    for i, (label, kind) in enumerate(legend):
        lc_labels.append({"id": "legend-%s" % label, "text": label,
                          "lx": legend_x0 + 22, "ly": legend_y0 + 22 + i * 18,
                          "anchor": "start", "fs": st["fs_legend"], "own": []})
    lc_boxes = [(nid, n["x"], n["y"], n["w"], n["h"]) for nid, n in N.items()]
    lc = label_collisions(routes, lc_labels, lc_boxes, None)

    return {"nodes": N, "order": [n["id"] for n in spec["nodes"]], "routes": routes,
            "lanes": lanes, "lane_of": lane_of, "lane_y": lane_y, "band_h": band_h,
            "ext_ids": ext_ids,
            "extra": {"band_x": band_x - 12, "band_w": band_w + 24, "title_x": margin,
                      "header": {"title": meta.get("title", ""), "meta_line": meta_line,
                                 "bottom": header_bottom},
                      "boundary": boundary, "y_band_top": y_band_top, "y_end": y_end,
                      "legend": legend, "legend_x0": legend_x0, "legend_y0": legend_y0,
                      "todos": todos, "todo_y0": todo_y0, "todo_w": todo_w, "todo_h": todo_h},
            "W": W, "H": H, "style": st,
            "crossings": crossings, "overlaps": overlaps,
            "textOverflow": overflow, "labelCollisions": lc,
            "warnings": warnings}


def layout(spec, style=None, args=None):
    st = dict(STYLE)
    if style:
        st.update(style)
    lay = _place(spec, st)
    # 布局失败自愈：交叉/标签碰撞无法消除时自动扩宽泳道间隙重排一次，再失败才降级
    if lay["crossings"] or lay["labelCollisions"]:
        st2 = dict(st)
        st2["gap_base"] = st.get("gap_base", 60) + 40
        st2["gap_step"] = st.get("gap_step", 14) + 4
        lay2 = _place(spec, st2)
        if not lay2["crossings"] and not lay2["labelCollisions"]:
            lay2["warnings"].append("已自动扩宽泳道间隙消除交叉/标签碰撞（60→%d）" % st2["gap_base"])
            return lay2
    return lay


def _legend_style(kind, st):
    if kind == "ext":
        return 'fill="%s" stroke="%s" stroke-width="1" stroke-dasharray="4 3"' \
               % (st["fill_external"], st["stroke_external"])
    if kind == "store":
        return 'fill="%s" stroke="%s" stroke-width="1"' % (st["fill_backend"], st["stroke_backend"])
    if kind == "bnd":
        return 'fill="none" stroke="%s" stroke-width="1.6"' % st["boundary_stroke"]
    if kind == "lane":
        return 'fill="%s" stroke="none"' % st["band_fill"]
    if kind == "sync":
        return 'data-edge="sync"'
    if kind == "async":
        return 'data-edge="async"'
    return 'fill="%s" stroke="%s" stroke-width="1.2" rx="3"' % (st["fill"], st["stroke"])


def _legend_swatch(out, x0, y, kind, st):
    """图例小样：节点样式为小矩形/圆柱，边样式为小线段+箭头。"""
    if kind == "sync":
        out.append('<line x1="%g" y1="%g" x2="%g" y2="%g" stroke="%s" stroke-width="1.5" marker-end="url(#arw)"/>'
                   % (x0, y, x0 + 14, y, st["edge_color"]))
        return
    if kind == "async":
        out.append('<line x1="%g" y1="%g" x2="%g" y2="%g" stroke="%s" stroke-width="1.4" stroke-dasharray="4 3" marker-end="url(#arw-open)"/>'
                   % (x0, y, x0 + 14, y, st["async_edge"]))
        return
    if kind == "store":
        out.append('<path d="M %g %g a 6 3 0 0 0 12 0 v 4 a 6 3 0 0 0 -12 0 Z" fill="%s" stroke="%s" stroke-width="1"/>'
                   % (x0, y - 6, st["fill_backend"], st["stroke_backend"]))
        return
    out.append('<rect x="%g" y="%g" width="14" height="10" %s/>' % (x0, y - 8, _legend_style(kind, st)))


def _cylinder(out, cx, cy, w, h, st):
    """标准数据库圆柱体：顶部椭圆横向半径 = 节点宽/2 - 2，左右垂直边，底部半椭圆。"""
    rx = max(w / 2 - 2.0, 10.0)
    ry = min(max(4.0, h / 8.0), 10.0)
    x0, x1 = cx - w / 2, cx + w / 2
    yt = cy - h / 2 + ry
    yb = cy + h / 2 - ry
    out.append('<path d="M %g %g A %g %g 0 0 0 %g %g L %g %g A %g %g 0 0 0 %g %g Z" '
               'fill="%s" stroke="%s" stroke-width="1.3"/>'
               % (x0, yt, rx, ry, x1, yt, x1, yb, rx, ry, x0, yb,
                  st["fill_backend"], st["stroke_backend"]))
    out.append('<ellipse cx="%g" cy="%g" rx="%g" ry="%g" fill="%s" stroke="%s" stroke-width="1.3"/>'
               % (cx, yt, rx, ry, st["fill_backend"], st["stroke_backend"]))


def render_svg(lay, title=""):
    st = lay["style"]
    ex = lay["extra"]
    out = svg_open(lay["W"], lay["H"], DATA_ATTR, st)
    out.append(arrow_marker(st))
    out.append('<defs><marker id="arw-open" viewBox="0 0 10 10" refX="9" refY="5" '
               'markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
               '<path d="M0,0 L10,5 L0,10 z" fill="#ffffff" stroke="%s" stroke-width="1.2"/>'
               '</marker></defs>' % st["edge_color"])
    # 页眉
    hd = ex["header"]
    if hd["title"] or title:
        out.append('<text x="%g" y="%g" font-size="%d" font-weight="700" fill="%s" text-anchor="start">%s</text>'
                   % (ex["title_x"], 20 + 14, st["fs_title"], st["text"],
                      esc(hd["title"] or title)))
    if hd["meta_line"]:
        out.append('<text x="%g" y="%g" font-size="%d" fill="%s" text-anchor="start">%s</text>'
                   % (ex["title_x"], hd["bottom"] - 3, st["fs_meta"], st["label_color"],
                      esc(hd["meta_line"])))
    # 系统边界（粗实线主框架）
    if ex["boundary"]:
        bx = ex["band_x"] - 4
        bw = (ex["band_w"] + 24) + 8
        by = ex["y_band_top"] - 22
        bh = ex["y_end"] + 12 - by
        out.append('<g class="boundary" id="arch-boundary">')
        out.append('<rect x="%g" y="%g" width="%g" height="%g" rx="8" fill="none" stroke="%s" '
                   'stroke-width="1.6"/>'
                   % (bx, by, bw, bh, st["boundary_stroke"]))
        if ex["boundary"].get("title"):
            out.append('<text x="%g" y="%g" font-size="%d" font-weight="700" fill="%s" '
                       'text-anchor="start" class="boundary-title">%s</text>'
                       % (bx + 12, by + 16, st["fs_section"], st["band_text"],
                          esc(ex["boundary"]["title"])))
        out.append('</g>')
    # 逻辑层：弱化背景带（无边框，不与系统边界竞争）
    for i, l in enumerate(lay["lanes"]):
        y0 = lay["lane_y"][i] - lay["band_h"][i] / 2 - 4
        h = lay["band_h"][i] + 8
        out.append('<g class="lane" id="arch-lane-%d">' % i)
        out.append('<rect x="%g" y="%g" width="%g" height="%g" fill="%s" stroke="none" rx="6"/>'
                   % (ex["band_x"], y0, ex["band_w"], h, st["band_fill"]))
        if l["title"]:
            out.append('<text x="%g" y="%g" font-size="%d" fill="%s" text-anchor="start" '
                       'class="lane-title">%s</text>'
                       % (ex["title_x"], lay["lane_y"][i] + 4, st["fs_section"],
                          st["band_text"], esc(l["title"])))
        out.append('</g>')
    # 图例（注册表驱动 + 边型）
    if ex["legend"]:
        out.append('<g class="legend" id="arch-legend">')
        out.append('<text x="%g" y="%g" font-size="%d" font-weight="700" fill="%s" '
                   'text-anchor="start">图例</text>'
                   % (ex["legend_x0"], ex["legend_y0"] + 10, st["fs_legend"], st["text"]))
        y = ex["legend_y0"] + 22
        for label, kind in ex["legend"]:
            _legend_swatch(out, ex["legend_x0"], y, kind, st)
            out.append('<text x="%g" y="%g" font-size="%d" fill="%s" text-anchor="start">%s</text>'
                       % (ex["legend_x0"] + 22, y, st["fs_legend"], st["text"], esc(label)))
            y += 18
        out.append('</g>')
    # 待确认项（编号锚点）
    if ex["todos"]:
        out.append('<g class="todo" id="arch-todo">')
        out.append('<rect x="%g" y="%g" width="%g" height="%g" rx="4" fill="%s" stroke="%s" stroke-width="0.8"/>'
                   % (20, ex["todo_y0"], ex["todo_w"], ex["todo_h"],
                      st["band_fill"], st["band_stroke"]))
        out.append('<text x="%g" y="%g" font-size="%d" font-weight="700" fill="%s" text-anchor="start">待确认项</text>'
                   % (32, ex["todo_y0"] + 17, st["fs_todo"], st["text"]))
        for k, t in enumerate(ex["todos"]):
            out.append('<text x="%g" y="%g" font-size="%d" fill="%s" text-anchor="start">「%s」%s</text>'
                       % (32, ex["todo_y0"] + 33 + k * 18, st["fs_todo"], st["label_color"],
                          esc(t["id"]), esc(t["text"])))
        out.append('</g>')
    # 路由（同步实线 / 异步虚线）与标签（含锚点标记）
    for r in lay["routes"]:
        p = " ".join("%g,%g" % (x, y) for x, y in r["pts"])
        if r.get("async"):
            out.append('<polyline points="%s" fill="none" stroke="%s" stroke-width="1.4" '
                       'stroke-dasharray="5 4" marker-end="url(#arw-open)"/>'
                       % (p, st["async_edge"]))
        else:
            out.append('<polyline points="%s" fill="none" stroke="%s" stroke-width="1.5" '
                       'marker-end="url(#arw)"/>'
                       % (p, st["edge_color"]))
        if r["label"] and r["lx"] is not None:
            for k, t in enumerate(r["label"]):
                out.append('<text x="%g" y="%g" font-size="%d" fill="%s" text-anchor="%s">%s</text>'
                           % (r["lx"], r["ly"] + k * 13, st["fs_label"], st["label_color"],
                              r["anchor"], esc(t)))
        if r.get("refs"):
            label_w = text_width(r["label"][0], st["fs_label"]) if r.get("label") else 0
            x = r["lx"] + (label_w / 2 if r["anchor"] == "middle" else label_w) + 6
            for ref in r["refs"]:
                out.append('<text x="%g" y="%g" font-size="%d" fill="%s" text-anchor="start" '
                           'class="note-badge">[%s]</text>'
                           % (x, r["ly"] + 4, st["fs_badge"], st["note_text"], esc(ref)))
                x += text_width("[%s]" % ref, st["fs_badge"]) + 4
    # 节点（样式注册表 + 三层文字 + 状态徽标 + 锚点徽章）
    for i, nid in enumerate(lay["order"]):
        n = lay["nodes"][nid]
        cx, cy, w, h = n["x"], n["y"], n["w"], n["h"]
        style_k = _node_style(n)
        out.append('<g class="node" id="arch-%s-%d" data-node="%s" data-style="%s">'
                   % (nid, i, nid, style_k))
        if style_k == "external":
            out.append('<rect x="%g" y="%g" width="%g" height="%g" rx="4" fill="%s" stroke="%s" '
                       'stroke-width="1.3" stroke-dasharray="5 4"/>'
                       % (cx - w / 2, cy - h / 2, w, h, st["fill_external"], st["stroke_external"]))
        elif style_k == "datastore":
            _cylinder(out, cx, cy, w, h, st)
        else:
            out.append('<rect x="%g" y="%g" width="%g" height="%g" rx="6" fill="%s" stroke="%s" stroke-width="1.4"/>'
                       % (cx - w / 2, cy - h / 2, w, h, st["fill"], st["stroke"]))
        segs = n.get("segs") or [{"text": t, "refs": []} for t in n["label"]]
        # 圆柱体顶部椭圆占用上方空间，文字下移进入中央安全区
        ry_shift = min(max(4.0, h / 8.0), 10.0) if style_k == "datastore" else 0
        y = cy - h / 2 + 14 + ry_shift
        for j, seg in enumerate(segs):
            if j == 2:  # 状态徽标
                tw = text_width(seg["text"], st["fs_badge"])
                out.append('<rect x="%g" y="%g" width="%g" height="16" rx="8" fill="%s" stroke="%s" stroke-width="0.8"/>'
                           % (cx - tw / 2 - 7, y - 12, tw + 14, st["pill_fill"], st["pill_stroke"]))
                out.append('<text x="%g" y="%g" font-size="%d" fill="%s" text-anchor="middle">%s</text>'
                           % (cx, y, st["fs_badge"], st["pill_text"], esc(seg["text"])))
                y += 20
            elif j == 1:
                out.append('<text x="%g" y="%g" font-size="%d" fill="%s" text-anchor="middle">%s</text>'
                           % (cx, y, st["fs_sub"], st["band_text"], esc(seg["text"])))
                y += st["fs_sub"] + 4
            else:
                out.append('<text x="%g" y="%g" font-size="%d" fill="%s" text-anchor="middle">%s</text>'
                           % (cx, y, st["fs_node"], st["text"], esc(seg["text"])))
                y += st["fs_node"] + 4
        refs = n.get("refs") or []
        if refs:
            ref_w = sum(text_width("[%s]" % r, st["fs_badge"]) + 8 for r in refs) + 4 * (len(refs) - 1)
            x = cx - ref_w / 2
            yy = cy + h / 2 - 15
            for r in refs:
                tw = text_width("[%s]" % r, st["fs_badge"]) + 8
                out.append('<rect x="%g" y="%g" width="%g" height="14" rx="7" fill="%s" stroke="%s" stroke-width="0.8"/>'
                           % (x, yy, tw, st["note_fill"], st["note_stroke"]))
                out.append('<text x="%g" y="%g" font-size="%d" fill="%s" text-anchor="middle" '
                           'class="note-badge">[%s]</text>'
                           % (x + tw / 2, yy + 10, st["fs_badge"], st["note_text"], esc(r)))
                x += tw + 4
        out.append('</g>')
    out += svg_close()
    return "\n".join(out)


def render_html(lay, title):
    return _render_html(render_svg(lay, title), title, lay["style"]["font_family"])


def main_cli(args):
    return common_main(args, sys.modules[__name__])


if __name__ == "__main__":
    ap = common_argparse("flow-canvas 架构图布局器（archspec/4）")
    raise SystemExit(main_cli(ap.parse_args()))
