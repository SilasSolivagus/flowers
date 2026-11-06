#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""企业应用架构全景图（能力地图）布局模块（layout_blueprint）。

实现 blueprintspec/2 契约，见 contract/blueprintspec-v2.md。

与 archspec 同族，但采用「约束式网格」而非拓扑重心：
- 输入 DSL（非可移植 mermaid，引擎自有预处理语法）：
  `blueprint LR|TB` + title/view/scope/version/todo 指令 + band/domain 分组 + rail 侧栏 + rel 关系；
- 统一模块尺寸（宽取最宽文本行，高取全图最多实际文本行数——锚点徽章用右上角标，不增高节点）；
- 横屏 LR 优先两行网格（2×2/3×2/4×2…），纵屏 TB 按目标列数；候选网格按目标宽高比择优重排，
  画布由内容紧包围盒 + margin 生成，禁止纯空白扩宽；
- rail 紧邻中央内容区（固定 24px 间距）；图例为底部横向一至两行；
- 浅色分域（10 色浅色盘循环 + 同色加深边框 + 标题加深色），颜色不是唯一载体；
- 少量关键关系正交折线路由，候选走廊零交叉搜索；
- 质检含 crossings / overlaps / textOverflow / labelCollisions 四项 + 紧凑度指标
  （centralFillX/contentFill/maxHorizontalGap/railDistance/canvasAspect），任一硬指标非 0 拒绝产出。
"""
import math
import re
import sys

from flowcommon import (
    COMMON_STYLE, text_width, wrap_label, esc,
    ortho_crossings, box_overlaps,
    svg_open, svg_close, arrow_marker,
    render_html as _render_html, common_argparse, common_main,
    label_collisions)

SPEC_VERSION = "blueprintspec/4"
DATA_ATTR = 'data-blueprintspec="4"'

STYLE = dict(COMMON_STYLE)
STYLE.update({
    "fill_external": "#f2f2f2",
    "stroke_external": "#777777",
    "fill_backend": "#ececec",
    "stroke_backend": "#555555",
    "band_text": "#777777",
    "rail_fill": "#f7f7f7",
    "band_stroke": "#e8e8e8",
    "titlebar_fill": "#f0f0f0",
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
})

MIN_FS = 10
MAX_MODULES = 120
MAX_BANDS = 8
MAX_DOMAINS = 12

DOMAIN_PALETTE = ["#eef3fb", "#e8f5ee", "#fdf3e3", "#f5eefb", "#e9f4f5",
                  "#fbeef0", "#f2f6e8", "#efe9e1", "#e6f0f7", "#f7efe6"]

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


def _darken(hexc, factor=0.85):
    h = hexc.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return "#%02x%02x%02x" % (int(r * factor), int(g * factor), int(b * factor))


def _node_style(n):
    if n["type"] == "external" or n["shape"] == "external":
        return "external"
    if n["type"] == "backend":
        return "datastore"
    return "container"


def _wrap(text, limit=10):
    return [p for p in wrap_label([text], limit) if p]


def _node_lines(n, st):
    """模块文本按 segs 各层分别换行（≤10 字/行），返回 [(text, fs, kind)]。"""
    segs = n.get("segs") or [{"text": t, "refs": []} for t in n["label"]]
    lines = []
    for j, seg in enumerate(segs):
        if j == 2:  # 状态徽标 pill
            lines.append((seg["text"], st["fs_badge"], "pill"))
        else:
            fs = st["fs_node"] if j == 0 else st["fs_sub"]
            for piece in _wrap(seg["text"]):
                lines.append((piece, fs, "text"))
    return lines


# ── 解析层 ──────────────────────────────────────────────────────────
def parse_mermaid(src):
    nodes = {}
    decl_order = []
    edges = []
    meta = {"title": "", "view": "blueprint", "scope": "", "version": "", "todos": [], "layout": "stacked"}
    direction = "LR"
    bands = []              # 声明序 band 结构（domains: [{title, ids}] + direct）
    rails = {"left": [], "right": [], "titles": {"left": "", "right": ""}}
    stack = []              # 上下文栈：{"kind": "band"|"domain"|"rail", ...}

    def ensure(nid, label=None, ntype=None, shape=None):
        if nid in nodes:
            raise SystemExit("错误：模块 id %s 重复（形态超限）" % nid)
        nodes[nid] = {"id": nid, "type": "process", "shape": "rect",
                      "segs": [{"text": nid, "refs": []}], "refs": [], "label": [nid]}
        decl_order.append(nid)
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
        for rx, shape in NODE_SHAPES:
            sm = rx.match(rest)
            if sm:
                ntype = "external" if shape == "external" else ("backend" if shape == "datastore" else None)
                ensure(nid, sm.group(1), ntype, shape)
                return nid
        if rest.strip():
            return None  # 无法识别的形状后缀 → 调用方报形态超限
        ensure(nid)
        return nid

    def add_module(nid):
        if not stack:
            raise SystemExit("错误：模块 %s 不在 band/domain/rail 内（形态超限）" % nid)
        top = stack[-1]
        if top["kind"] == "domain":
            top["ids"].append(nid)
        elif top["kind"] == "band":
            top["direct"].append(nid)
        else:  # rail
            rails[top["side"]].append(nid)

    for raw in src.splitlines():
        line = raw.strip()
        if not line or line.startswith("%%"):
            continue
        m = re.match(r'^blueprint\s*(LR|TB)?\s*$', line, re.I)
        if m:
            direction = (m.group(1) or "LR").upper()
            continue
        if line.startswith("flowchart") or line.startswith("graph") or line.startswith("direction"):
            raise SystemExit("错误：blueprint 首行应为 blueprint LR|TB（形态超限，非可移植 mermaid）")
        if line.startswith("title "):
            meta["title"] = line[6:].strip().strip('"')
            continue
        if line.startswith("view "):
            v = line[5:].strip()
            if v != "blueprint":
                raise SystemExit("错误：view %s 不支持（形态超限：仅接受 blueprint）" % v)
            meta["view"] = v
            continue
        if line.startswith("layout "):
            mode = line[7:].strip().lower()
            if mode not in ("stacked", "grid"):
                raise SystemExit("错误：layout 只支持 stacked|grid（形态超限）")
            meta["layout"] = mode
            continue
        if line.startswith("scope "):
            meta["scope"] = line[6:].strip().strip('"')
            continue
        if line.startswith("version "):
            meta["version"] = line[8:].strip().strip('"')
            continue
        if line.startswith("todo "):
            t = line[5:].strip().strip('"')
            mm = re.match(r'^\[([A-Za-z][A-Za-z0-9]*)\]\s*(.*)$', t)
            if mm:
                meta["todos"].append({"id": mm.group(1), "text": mm.group(2)})
            else:
                meta["todos"].append({"id": "A%d" % (len(meta["todos"]) + 1), "text": t})
            continue
        if line.startswith("band "):
            if stack:
                raise SystemExit("错误：band 不能嵌套在 band/domain/rail 内（形态超限）")
            if meta["layout"] == "grid":
                raise SystemExit("错误：layout grid 模式下层级用 section 声明，band 仅限 stacked 模式（形态超限）")
            stack.append({"kind": "band", "title": line[5:].strip(),
                          "domains": [], "direct": []})
            continue
        if line.startswith("section "):
            if stack:
                raise SystemExit("错误：section 不能嵌套（形态超限）")
            if meta["layout"] == "stacked":
                raise SystemExit("错误：layout stacked 模式下层级用 band 声明（形态超限）")
            stack.append({"kind": "band", "title": line[8:].strip(),
                          "domains": [], "direct": []})
            continue
        if line.startswith("domain "):
            if not stack or stack[-1]["kind"] != "band":
                raise SystemExit("错误：domain 必须在 band/section 内（形态超限）")
            d = {"title": line[7:].strip(), "ids": []}
            stack[-1]["domains"].append(d)
            stack.append({"kind": "domain", "title": d["title"], "ids": d["ids"]})
            continue
        if line.startswith("rail "):
            parts = line[5:].strip().split(None, 1)
            side = parts[0].lower()
            if side not in ("left", "right"):
                raise SystemExit("错误：rail 只支持 left/right（形态超限）")
            if stack:
                raise SystemExit("错误：rail 不能嵌套在 band/domain 内（形态超限）")
            if rails[side]:
                raise SystemExit("错误：重复声明 rail %s（形态超限：左右各最多一个）" % side)
            title = parts[1].strip() if len(parts) > 1 else ""
            stack.append({"kind": "rail", "side": side, "title": title})
            rails["titles"][side] = title
            continue
        if line == "end":
            if not stack:
                raise SystemExit("错误：多余的 end（形态超限）")
            top = stack.pop()
            if top["kind"] == "band":
                bands.append({"title": top["title"], "domains": top["domains"],
                              "direct": top["direct"]})
            continue
        if line.startswith("rel "):
            rest = line[4:].strip()
            parts = re.split(r'\s*(?:-->|-\.->)\s*', rest)
            if len(parts) < 2:
                raise SystemExit("错误：rel 语法错误（形态超限）：%s" % line)
            for i in range(len(parts) - 1):
                left, right = parts[i].strip(), parts[i + 1].strip()
                label = ""
                lm = re.match(r'^\|(.*?)\|\s*(.*)$', right)
                if lm:
                    label = lm.group(1).strip().strip('"')
                    right = lm.group(2).strip()
                txt, refs = _split_refs(label)
                am = ID_RE.match(left)
                bm = ID_RE.match(right)
                if not am or not bm:
                    raise SystemExit("错误：rel 端点无法识别（形态超限）：%s" % line)
                edges.append({"from": am.group(1), "to": bm.group(1),
                              "label": [txt] if txt else [], "refs": refs,
                              "async": "-.->" in line})
            continue
        if "-->" in line or "-.->" in line:
            raise SystemExit("错误：边必须用 rel 前缀（形态超限）：%s" % line)
        if line.startswith("subgraph") or line.startswith("class") or line.startswith("classDef"):
            raise SystemExit("错误：blueprint 不支持 %s（形态超限）" % line.split()[0])
        nid = eat_node(line)
        if nid is None:
            raise SystemExit("错误：无法识别的行（形态超限）：%s" % line)
        add_module(nid)

    if stack:
        raise SystemExit("错误：未闭合的 %s（形态超限）" % stack[-1]["kind"])

    # ── band/domain 收尾：丢弃空 domain，无 domain 模块归「其他」，丢弃空 band ──
    final_bands = []
    for b in bands:
        doms = [d for d in b["domains"] if d["ids"]]
        if b["direct"]:
            doms.append({"title": "其他", "ids": b["direct"]})
        if doms:
            final_bands.append({"title": b["title"], "domains": doms})
    bands = final_bands

    # rel 引用未定义模块 → 形态超限
    for e in edges:
        if e["from"] not in nodes:
            raise SystemExit("错误：rel 引用未定义模块 %s（形态超限）" % e["from"])
        if e["to"] not in nodes:
            raise SystemExit("错误：rel 引用未定义模块 %s（形态超限）" % e["to"])

    n_modules = len(nodes)
    n_domains = sum(len(b["domains"]) for b in bands)
    if n_modules > MAX_MODULES:
        raise SystemExit("错误：模块总数 %d 超过上限 %d（形态超限）" % (n_modules, MAX_MODULES))
    if len(bands) > MAX_BANDS:
        raise SystemExit("错误：band 数 %d 超过上限 %d（形态超限）" % (len(bands), MAX_BANDS))
    if n_domains > MAX_DOMAINS:
        raise SystemExit("错误：domain 数 %d 超过上限 %d（形态超限）" % (n_domains, MAX_DOMAINS))
    if not nodes:
        raise SystemExit("错误：没有可布局的模块（形态超限）")

    # 渲染顺序：先 bands 各 domain 模块、再 left rail、再 right rail
    order = []
    for b in bands:
        for d in b["domains"]:
            order += d["ids"]
    order += rails["left"]
    order += rails["right"]

    spec = {
        "spec": SPEC_VERSION,
        "meta": meta,
        "direction": direction,
        "bands": [{"title": b["title"],
                   "domains": [{"title": d["title"], "modules": [nodes[i] for i in d["ids"]]}
                               for d in b["domains"]]} for b in bands],
        "rails": {"left": [nodes[i] for i in rails["left"]],
                  "titles": rails["titles"],
                  "right": [nodes[i] for i in rails["right"]]},
        "nodes": [nodes[i] for i in decl_order],
        "edges": edges,
        "order": order,
    }
    return spec


def load_spec(path):
    text = open(path, encoding="utf-8").read()
    return parse_mermaid(text)


def iter_labels(spec):
    m = spec.get("meta") or {}
    if m.get("title"):
        yield m["title"]
    if m.get("view"):
        yield "能力地图"
    for k in ("scope", "version"):
        if m.get(k):
            yield m[k]
    for t in m.get("todos", []):
        yield t["id"]
        yield t["text"]
    for b in spec["bands"]:
        if b.get("title"):
            yield b["title"]
        for d in b["domains"]:
            if d.get("title"):
                yield d["title"]
            for n in d["modules"]:
                for seg in n.get("segs", []):
                    yield seg["text"]
                    for r in seg["refs"]:
                        yield r
    for n in spec["rails"]["left"] + spec["rails"]["right"]:
        for seg in n.get("segs", []):
            yield seg["text"]
            for r in seg["refs"]:
                yield r
    for e in spec["edges"]:
        for l in e.get("label", []):
            yield l
        for r in e.get("refs", []):
            yield r


# ── 布局层 ──────────────────────────────────────────────────────────
TARGET_ASPECT_LR = 1.6
TARGET_ASPECT_TB = 1.0 / 1.6


def _cell_size(spec, st):
    """统一模块尺寸：宽取最宽文本行；高取全图最多实际文本行数（锚点徽章不增高节点）。"""
    max_w = 0.0
    max_lines = 1
    lines_by_id = {}
    for n in spec["nodes"]:
        lines = _node_lines(n, st)
        lines_by_id[n["id"]] = lines
        max_lines = max(max_lines, len(lines))
        for text, fs, kind in lines:
            w = text_width(text, fs) + (28 if kind == "pill" else 0)
            max_w = max(max_w, w)
    cell_w = max(96, min(220, round(max_w) + 24))
    cell_h = 16 + min(max_lines, 4) * 13
    return cell_w, cell_h, lines_by_id, max_lines


def _seg_hits_box(p1, p2, cx, cy, w, h, pad=0.0):
    x0, x1 = cx - w / 2 - pad, cx + w / 2 + pad
    y0, y1 = cy - h / 2 - pad, cy + h / 2 + pad
    if abs(p1[1] - p2[1]) < 0.01:      # 水平
        if not (y0 < p1[1] < y1):
            return False
        sx, ex = sorted((p1[0], p2[0]))
        return sx < x1 and ex > x0
    if abs(p1[0] - p2[0]) < 0.01:      # 垂直
        if not (x0 < p1[0] < x1):
            return False
        sy, ey = sorted((p1[1], p2[1]))
        return sy < y1 and ey > y0
    return False


def _box_hits(pts, N, exclude):
    hits = 0
    for k in range(len(pts) - 1):
        p1, p2 = pts[k], pts[k + 1]
        for nid, n in N.items():
            if nid in exclude:
                continue
            if _seg_hits_box(p1, p2, n["x"], n["y"], n["w"], n["h"]):
                hits += 1
    return hits


def _build_legend(spec):
    edges = spec["edges"]
    used = {_node_style(n) for n in spec["nodes"]}
    legend = [("业务域", "domain")]
    if "container" in used:
        legend.append(("模块", "container"))
    if "datastore" in used:
        legend.append(("数据存储", "datastore"))
    if "external" in used:
        legend.append(("外部系统", "external"))
    has_sync = any(not e.get("async") for e in edges)
    has_async = any(e.get("async") for e in edges)
    if has_sync:
        legend.append(("同步调用", "sync"))
    if has_async:
        legend.append(("异步事件", "async"))
    return legend


def _bends(pts):
    n = 0
    for i in range(1, len(pts) - 1):
        h1 = abs(pts[i][1] - pts[i - 1][1]) < 0.01
        h2 = abs(pts[i + 1][1] - pts[i][1]) < 0.01
        if h1 != h2:
            n += 1
    return n


def _route_len(pts):
    return sum(abs(pts[k + 1][0] - pts[k][0]) + abs(pts[k + 1][1] - pts[k][1])
               for k in range(len(pts) - 1))


def _route_edges(spec, N, st, cell_w, cell_h, geo):
    """关键关系正交路由：端口家族优先（少折弯短路径）→ 质量评分贪心。

    候选按正确端口顺序生成：同 band 左右端口直连/L 形；相邻 band 底→顶直落或两折；
    长跨/跨列走脊柱（直列 4 折弯）；rail 水平直连。评分 = 碰撞/穿盒（硬）
    ×1e8/1e7 + 折弯 ×1e4 + 绕行比 ×1e3 + 通道拥挤，全部候选取最小。
    """
    edges = [dict(e) for e in spec["edges"]]
    band_y = geo["band_y"]
    band_h = geo["band_h"]
    domain_geo = geo["domain_geo"]
    row_gap = geo["row_gap"]
    band_of = geo["band_of"]
    band_col = geo["band_col"]
    gaps = geo["gaps"]
    routes = []

    # 同列相邻 band 间隙通道（使用登记）
    gap_lanes = {}
    gap_between = {}
    gap_below = {}
    gap_above = {}
    for gi, (ab, bb, t, b) in enumerate(gaps):
        gap_lanes[gi] = [t + (b - t) * k / 5.0 for k in range(1, 5)]
        gap_between[(ab, bb)] = gi
        gap_between[(bb, ab)] = gi
        gap_below[ab] = gi
        gap_above[bb] = gi
    lane_use = {}

    # 每 band 的上/下走廊通道（间隙通道 + 列顶/列底区），供跨列/长跨边出入线
    upper_zones = {}
    lower_zones = {}
    col_top_y = {}
    col_bottom_y = {}
    for bi in range(len(band_y)):
        c = band_col[bi]
        col_top_y.setdefault(c, band_y[bi])
        col_bottom_y[c] = band_y[bi] + band_h[bi]
    for bi in range(len(band_y)):
        c = band_col[bi]
        gi = gap_above.get(bi)
        if gi is not None:
            ups = list(gap_lanes[gi])
        else:
            span = band_y[bi] - col_top_y[c]
            ups = [col_top_y[c] + span * k / 3.0 for k in (1, 2)] if span > 0 \
                else [band_y[bi] - 16, band_y[bi] - 8]
        gi = gap_below.get(bi)
        if gi is not None:
            los = list(gap_lanes[gi])
        else:
            bottom = col_bottom_y[c]
            span = bottom - (band_y[bi] + band_h[bi])
            los = [band_y[bi] + band_h[bi] + span * k / 3.0 for k in (1, 2)] if span > 0 \
                else [band_y[bi] + band_h[bi] + 8, band_y[bi] + band_h[bi] + 16]
        upper_zones[bi] = ups
        lower_zones[bi] = los

    # 脊柱槽位（长跨 band 或跨列边）：每边一个专属槽位；同对反向边强制分左右两侧
    rev_map = {}
    for e in edges:
        key = (min(e["from"], e["to"]), max(e["from"], e["to"]))
        rev_map.setdefault(key, []).append(id(e))
    reverse_pairs = {key: ids for key, ids in rev_map.items() if len(ids) >= 2}
    long_edges = sorted(
        [e for e in edges if isinstance(band_of.get(e["from"]), int)
         and isinstance(band_of.get(e["to"]), int)
         and (abs(band_of[e["from"]] - band_of[e["to"]]) >= 2
              or band_col[band_of[e["from"]]] != band_col[band_of[e["to"]]])],
        key=lambda e: abs(band_of[e["from"]] - band_of[e["to"]])
        + (0 if band_col[band_of[e["from"]]] == band_col[band_of[e["to"]]] else 5),
        reverse=True)
    spine_of = {}
    for k, e in enumerate(long_edges):
        # 槽位锚定预留线廊区：左 [band_x - spine_w, band_x]、右 [right_x - spine_w, right_x]
        sr = (geo["right_spine_x0"] + 20 + 28 * k)
        sl = (geo["left_spine_x0"] + 20 + 28 * k)
        key = (min(e["from"], e["to"]), max(e["from"], e["to"]))
        if key in reverse_pairs:
            if id(e) == reverse_pairs[key][0]:
                spine_of[id(e)] = (sr, None, k % 4)
            else:
                spine_of[id(e)] = (None, sl, k % 4)
        else:
            spine_of[id(e)] = (sr, sl, k % 4)

    # 模块可用垂直走廊 x（domain 左右间隙 + 列间隙 + 侧栏间隙）
    mod_gapx = {}
    for dg in domain_geo:
        for dd in dg:
            left = dd["x"] - 8
            right = dd["x"] + dd["w"] + 8
            for nid in dd["ids"]:
                xs = [left, right]
                for c in range(dd["cols"] - 1):
                    xs.append(dd["x"] + 8 + (c + 1) * cell_w + c * 8 + 4)
                mod_gapx[nid] = xs
    for nid in geo["left_ids"]:
        mod_gapx[nid] = [geo["left_gap_x"]]
    for nid in geo["right_ids"]:
        mod_gapx[nid] = [geo["right_gap_x"]]

    def _mk(pts, lx, ly, anchor="middle", lanes=None):
        return {"pts": pts, "lx": lx, "ly": ly, "anchor": anchor,
                "lanes": lanes or []}

    def _cands(e):
        a, b = N[e["from"]], N[e["to"]]
        ia, ib = band_of.get(e["from"]), band_of.get(e["to"])
        ax, ay = a["x"], a["y"]
        bx, by = b["x"], b["y"]
        cands = []
        axs = mod_gapx.get(e["from"], [])
        bxs = mod_gapx.get(e["to"], [])
        down = ay <= by

        if isinstance(ia, int) and isinstance(ib, int):
            same_col = band_col[ia] == band_col[ib]
            if ia == ib:
                # 同 band：左右端口优先（0/2 折弯），兜底上下 gap 绕行
                if abs(ay - by) < 0.5:
                    if ax <= bx:
                        cands.append(_mk([(ax + cell_w / 2, ay), (bx - cell_w / 2, by)],
                                         (ax + bx) / 2, ay - 8))
                    else:
                        cands.append(_mk([(ax - cell_w / 2, ay), (bx + cell_w / 2, by)],
                                         (ax + bx) / 2, ay - 8))
                if abs(ax - bx) < 0.5:
                    if down:
                        cands.append(_mk([(ax, ay + cell_h / 2), (bx, by - cell_h / 2)],
                                         ax + 10, (ay + by) / 2, "start"))
                    else:
                        cands.append(_mk([(ax, ay - cell_h / 2), (bx, by + cell_h / 2)],
                                         ax + 10, (ay + by) / 2, "start"))
                # L 形（2 折弯）：经左右列间隙
                for gx in sorted(set(axs + bxs)):
                    if gx >= max(ax, bx) + cell_w / 4 and bx >= ax:
                        cands.append(_mk([(ax + cell_w / 2, ay), (gx, ay),
                                          (gx, by), (bx - cell_w / 2, by)],
                                         gx + 6, (ay + by) / 2, "start"))
                    if gx <= min(ax, bx) - cell_w / 4 and bx <= ax:
                        cands.append(_mk([(ax - cell_w / 2, ay), (gx, ay),
                                          (gx, by), (bx + cell_w / 2, by)],
                                         gx - 6, (ay + by) / 2, "middle"))
                for gi in (gap_below.get(ia), gap_above.get(ia)):
                    if gi is None:
                        continue
                    for lane_y in gap_lanes[gi]:
                        for gax in axs:
                            for gbx in bxs:
                                cands.append(_mk(_v_pts(ax, ay, bx, by, gax, gbx, lane_y, down),
                                                 (gax + gbx) / 2, lane_y + 4,
                                                 lanes=[("gap-%d" % gi, lane_y)]))
            elif abs(ia - ib) == 1 and same_col and (ia, ib) in gap_between:
                gi = gap_between[(ia, ib)]
                # 相邻 band：直落（0 折弯）或 VHV（2 折弯），兜底域间隙绕行
                if abs(ax - bx) < 0.5:
                    if down:
                        cands.append(_mk([(ax, ay + cell_h / 2), (bx, by - cell_h / 2)],
                                         ax + 10, (ay + by) / 2, "start"))
                    else:
                        cands.append(_mk([(ax, ay - cell_h / 2), (bx, by + cell_h / 2)],
                                         ax + 10, (ay + by) / 2, "start"))
                for lane_y in gap_lanes[gi]:
                    if down:
                        pts = [(ax, ay + cell_h / 2), (ax, lane_y), (bx, lane_y),
                               (bx, by - cell_h / 2)]
                    else:
                        pts = [(ax, ay - cell_h / 2), (ax, lane_y), (bx, lane_y),
                               (bx, by + cell_h / 2)]
                    cands.append(_mk(pts, (ax + bx) / 2, lane_y - 8,
                                     lanes=[("gap-%d" % gi, lane_y)]))
                for lane_y in gap_lanes[gi]:
                    for gax in axs:
                        for gbx in bxs:
                            cands.append(_mk(_v_pts(ax, ay, bx, by, gax, gbx, lane_y, down),
                                             (gax + gbx) / 2, lane_y + 4,
                                             lanes=[("gap-%d" % gi, lane_y)]))
            else:
                # 长跨 / 跨列：顶部/底部共享总线优先（T 形汇入零交叉），脊柱兜底
                y_top = geo["y_band_top"] - 10
                y_bot = geo["content_bottom"] - 8
                if down:
                    cands.append(_mk([(ax, ay + cell_h / 2), (ax, y_bot),
                                      (bx, y_bot), (bx, by + cell_h / 2)],
                                     (ax + bx) / 2, y_bot - 8,
                                     lanes=[("bus-bottom", y_bot)]))
                    cands.append(_mk([(ax, ay + cell_h / 2), (ax, y_top),
                                      (bx, y_top), (bx, by - cell_h / 2)],
                                     (ax + bx) / 2, y_top - 8,
                                     lanes=[("bus-top", y_top)]))
                    # 域间隙出线变体（节点列被同列模块挡住时从域边缘出线）
                    for gax in axs:
                        cands.append(_mk([(ax, ay + cell_h / 2), (gax, ay + cell_h / 2),
                                          (gax, y_bot), (bx, y_bot), (bx, by + cell_h / 2)],
                                         (gax + bx) / 2, y_bot - 8,
                                         lanes=[("bus-bottom", y_bot)]))
                        cands.append(_mk([(ax, ay + cell_h / 2), (gax, ay + cell_h / 2),
                                          (gax, y_top), (bx, y_top), (bx, by - cell_h / 2)],
                                         (gax + bx) / 2, y_top - 8,
                                         lanes=[("bus-top", y_top)]))
                else:
                    cands.append(_mk([(ax, ay - cell_h / 2), (ax, y_top),
                                      (bx, y_top), (bx, by - cell_h / 2)],
                                     (ax + bx) / 2, y_top - 8,
                                     lanes=[("bus-top", y_top)]))
                    cands.append(_mk([(ax, ay - cell_h / 2), (ax, y_bot),
                                      (bx, y_bot), (bx, by + cell_h / 2)],
                                     (ax + bx) / 2, y_bot - 8,
                                     lanes=[("bus-bottom", y_bot)]))
                    for gax in axs:
                        cands.append(_mk([(ax, ay - cell_h / 2), (gax, ay - cell_h / 2),
                                          (gax, y_top), (bx, y_top), (bx, by - cell_h / 2)],
                                         (gax + bx) / 2, y_top - 8,
                                         lanes=[("bus-top", y_top)]))
                        cands.append(_mk([(ax, ay - cell_h / 2), (gax, ay - cell_h / 2),
                                          (gax, y_bot), (bx, y_bot), (bx, by + cell_h / 2)],
                                         (gax + bx) / 2, y_bot - 8,
                                         lanes=[("bus-bottom", y_bot)]))
                # 脊柱兜底（直列 4 折弯 / 域间隙 8 折弯）
                sr, sl, _li = spine_of[id(e)]
                lanesA = lower_zones.get(ia, []) if down else upper_zones.get(ia, [])
                lanesB = upper_zones.get(ib, []) if down else lower_zones.get(ib, [])
                for spine_x in (sr, sl):
                    if spine_x is None:
                        continue
                    for laneA in lanesA:
                        for laneB in lanesB:
                            if down:
                                pts = [(ax, ay + cell_h / 2), (ax, laneA),
                                       (spine_x, laneA), (spine_x, laneB),
                                       (bx, laneB), (bx, by - cell_h / 2)]
                            else:
                                pts = [(ax, ay - cell_h / 2), (ax, laneA),
                                       (spine_x, laneA), (spine_x, laneB),
                                       (bx, laneB), (bx, by + cell_h / 2)]
                            cands.append(_mk(pts, (ax + spine_x) / 2, laneA + 4,
                                             lanes=[("z-%d" % ia, laneA),
                                                    ("z-%d" % ib, laneB)]))
                # 域间隙脊柱（8 折弯兜底，仅在直列不可用时）
                if lanesA and lanesB:
                    for spine_x in (sr, sl):
                        if spine_x is None:
                            continue
                        for gax in axs:
                            for gbx in bxs:
                                for laneA in lanesA:
                                    for laneB in lanesB:
                                        cands.append(_mk(_spine_pts(
                                            ax, ay, bx, by, spine_x, gax, gbx,
                                            laneA, laneB, down),
                                            (gax + spine_x) / 2, laneA + 4,
                                            lanes=[("z-%d" % ia, laneA),
                                                   ("z-%d" % ib, laneB)]))
        else:
            # rail 边：水平直连 + gap 兜底
            side = ia if isinstance(ia, str) else ib
            lane_x = geo["left_gap_x"] if side == "L" else geo["right_gap_x"]
            a_rail = isinstance(ia, str)
            if a_rail:
                if side == "L":
                    p1, p2 = (ax + cell_w / 2, ay), (bx - cell_w / 2, by)
                else:
                    p1, p2 = (ax - cell_w / 2, ay), (bx + cell_w / 2, by)
                cands.append(_mk([p1, (lane_x, ay), (lane_x, by), p2],
                                 (lane_x + bx) / 2, by + 4))
            else:
                if side == "L":
                    p1, p2 = (ax - cell_w / 2, ay), (bx + cell_w / 2, by)
                else:
                    p1, p2 = (ax + cell_w / 2, ay), (bx - cell_w / 2, by)
                cands.append(_mk([p1, (lane_x, ay), (lane_x, by), p2],
                                 (lane_x + ax) / 2, ay + 4))
            for gi in range(len(gaps)):
                for lane_y in gap_lanes[gi]:
                    for gax in axs:
                        for gbx in bxs:
                            cands.append(_mk(_v_pts(ax, ay, bx, by, gax, gbx, lane_y, down),
                                             (gax + gbx) / 2, lane_y + 4,
                                             lanes=[("gap-%d" % gi, lane_y)]))
        return cands

    def _v_pts(ax, ay, bx, by, gax, gbx, lane_y, down):
        if down:
            oy = ay + cell_h / 2 + row_gap / 2
            iy = by - cell_h / 2 - row_gap / 2
            return [(ax, ay + cell_h / 2), (ax, oy), (gax, oy), (gax, lane_y),
                    (gbx, lane_y), (gbx, iy), (bx, iy), (bx, by - cell_h / 2)]
        oy = ay - cell_h / 2 - row_gap / 2
        iy = by + cell_h / 2 + row_gap / 2
        return [(ax, ay - cell_h / 2), (ax, oy), (gax, oy), (gax, lane_y),
                (gbx, lane_y), (gbx, iy), (bx, iy), (bx, by + cell_h / 2)]

    def _spine_pts(ax, ay, bx, by, spine_x, gax, gbx, laneA, laneB, down):
        if down:
            oy = ay + cell_h / 2 + row_gap / 2
            iy = by - cell_h / 2 - row_gap / 2
            return [(ax, ay + cell_h / 2), (ax, oy), (gax, oy), (gax, laneA),
                    (spine_x, laneA), (spine_x, laneB), (gbx, laneB), (gbx, iy),
                    (bx, iy), (bx, by - cell_h / 2)]
        oy = ay - cell_h / 2 - row_gap / 2
        iy = by + cell_h / 2 + row_gap / 2
        return [(ax, ay - cell_h / 2), (ax, oy), (gax, oy), (gax, laneA),
                (spine_x, laneA), (spine_x, laneB), (gbx, laneB), (gbx, iy),
                (bx, iy), (bx, by + cell_h / 2)]

    def _reserved_hits(pts):
        rects = geo.get("reserved_rects", [])
        n = 0
        for k in range(len(pts) - 1):
            p1, p2 = pts[k], pts[k + 1]
            for x0, y0, x1, y1 in rects:
                if abs(p1[1] - p2[1]) < 0.01:
                    if y0 < p1[1] < y1:
                        sx, ex = sorted((p1[0], p2[0]))
                        if sx < x1 and ex > x0:
                            n += 1
                            break
                elif abs(p1[0] - p2[0]) < 0.01:
                    if x0 < p1[0] < x1:
                        sy, ey = sorted((p1[1], p2[1]))
                        if sy < y1 and ey > y0:
                            n += 1
                            break
        return n

    # 处理顺序：跨度大的先占脊柱/走廊
    edges = sorted(edges, key=lambda e: (
        0 if isinstance(band_of.get(e["from"]), str) or isinstance(band_of.get(e["to"]), str)
        else abs(band_of[e["from"]] - band_of[e["to"]])
        + (0 if band_col[band_of[e["from"]]] == band_col[band_of[e["to"]]] else 5)), reverse=True)
    for e in edges:
        a, b = N[e["from"]], N[e["to"]]
        cands = _cands(e)
        direct = abs(a["x"] - b["x"]) + abs(a["y"] - b["y"])
        base = len(ortho_crossings(routes))
        best = None
        for c in cands:
            newc = len(ortho_crossings(routes + [{"pts": c["pts"]}])) - base
            hits = _box_hits(c["pts"], N, {e["from"], e["to"]})
            rhits = _reserved_hits(c["pts"])
            crowd = sum(lane_use.get(l, 0) for l in c.get("lanes", []))
            bends = _bends(c["pts"])
            detour = _route_len(c["pts"]) / max(direct, 0.001)
            score = (newc * 10 ** 7 + hits * 10 ** 8 + rhits * 10 ** 8
                     + bends * 10 ** 4 + int(detour * 1000) + crowd)
            if best is None or score < best["score"]:
                best = dict(c)
                best["score"] = score
        for l in best.get("lanes", []):
            lane_use[l] = lane_use.get(l, 0) + 1
        routes.append({"id": "%s-%s-%d" % (e["from"], e["to"], len(routes)),
                       "from": e["from"], "to": e["to"],
                       "pts": best["pts"], "label": e.get("label", []),
                       "refs": e.get("refs", []), "async": e.get("async", False),
                       "lx": best["lx"], "ly": best["ly"],
                       "anchor": best.get("anchor", "middle"), "arrow": True})
    return routes


def _place(spec, st):
    meta = spec.get("meta") or {}
    direction = spec.get("direction", "LR")
    edges = [dict(e) for e in spec["edges"]]
    bands = spec["bands"]
    rails = spec["rails"]
    warnings = []

    for key, val in st.items():
        if key.startswith("fs_") and isinstance(val, int) and val < MIN_FS:
            warnings.append("样式 fs 值 %s=%d 低于可读性硬阈值 %dpx" % (key, val, MIN_FS))

    for e in edges:
        if not e.get("label"):
            warnings.append("边 %s→%s 无语义标签：建议标注协议/行为（如「HTTPS：调用」）"
                            % (e["from"], e["to"]))

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

    # ── 1. 统一模块尺寸（实际行数定高；锚点徽章不增高）──────────────
    cell_w, cell_h, lines_by_id, max_lines = _cell_size(spec, st)
    N = {}
    for n in spec["nodes"]:
        nd = dict(n)
        nd["w"], nd["h"] = cell_w, cell_h
        nd["lines"] = lines_by_id[n["id"]]
        N[nd["id"]] = nd

    margin = 20
    gap = 16            # domain 之间水平间隙
    row_gap = 8         # domain 内模块行间隙（供正交路由穿行）
    rail_w = cell_w + 32
    rail_gap = 24       # rail 与中央内容区固定间距
    title_gap = 12
    band_gap = 20

    left_ids = [m["id"] for m in rails["left"]]
    right_ids = [m["id"] for m in rails["right"]]
    titles = [b["title"] for b in bands if b["title"]]
    band_title_w = (max(text_width(t, st["fs_section"]) for t in titles) + 16) if titles else 0

    # band 归属（结构信息，与网格方案无关）；长跨边数决定两侧脊柱线廊宽度
    band_of = {}
    for bi, b in enumerate(bands):
        for d in b["domains"]:
            for m in d["modules"]:
                band_of[m["id"]] = bi
    for nid in left_ids:
        band_of[nid] = "L"
    for nid in right_ids:
        band_of[nid] = "R"
    n_long = sum(1 for e in edges
                 if isinstance(band_of.get(e["from"]), int)
                 and isinstance(band_of.get(e["to"]), int)
                 and abs(band_of[e["from"]] - band_of[e["to"]]) >= 2)
    spine_w = (20 + 28 * n_long) if n_long else 0

    # ── 页眉 / 待确认尺寸 ───────────────────────────────────────────
    layout_mode = meta.get("layout", "stacked")
    title = meta.get("title", "")
    header_bottom = margin
    if title:
        header_bottom = margin + 20
    meta_line = " · ".join([x for x in (
        ("图种：能力地图" if layout_mode == "grid" else "图种：分层架构") if meta.get("view") else "",
        meta.get("scope"), meta.get("version")) if x])
    if meta_line:
        header_bottom += 18

    todos = meta.get("todos") or []
    todo_h = (18 * len(todos) + 30) if todos else 0
    todo_w = max([text_width("「%s」%s" % (t["id"], t["text"]), st["fs_todo"])
                  for t in todos] or [0]) + 28

    # ── 2. 候选网格搜索：按目标宽高比择优，禁止纯空白扩宽 ────────────
    legend = _build_legend(spec)

    def grid_cols(n, cap):
        if n <= 0:
            return 1
        if direction == "LR":
            return min(n, int(math.ceil(n / float(cap))))  # cap = 目标行数（横屏优先两行）
        return min(n, cap)                                  # cap = 目标列数（纵屏）

    layout_mode = meta.get("layout", "stacked")
    caps = [2] if direction == "LR" else [2, 3, 4]
    # stacked：band 始终整行上下堆叠（层级语义不可破坏）；grid：section 多列流式
    ncols_opts = [1] if layout_mode == "stacked" else [1, 2, 3]

    def _eval(cap, ncols, assign):
        bw_list, bh_list = [], []
        for b in bands:
            dw, dh = [], []
            for d in b["domains"]:
                n = len(d["modules"])
                cols = grid_cols(n, cap)
                rows = int(math.ceil(n / float(cols)))
                dw.append(cols * cell_w + (cols - 1) * 8 + 16)
                dh.append(22 + rows * cell_h + (rows - 1) * row_gap + 8)
            bw_list.append(sum(dw) + gap * max(0, len(dw) - 1))
            bh_list.append(max(dh) + 38 if dh else 38)
        # 列分配：rot = 声明序轮转（行优先阅读）；lpt = 宽度降序放入当前最窄列（列宽平衡）
        col_w = [0.0] * ncols
        col_h = [0.0] * ncols
        if assign == "rot":
            for bi, (bw, bh) in enumerate(zip(bw_list, bh_list)):
                c = bi % ncols
                col_w[c] = max(col_w[c], bw)
                col_h[c] += bh + (band_gap if col_h[c] > 0 else 0)
        else:
            order = sorted(range(len(bw_list)), key=lambda i: -bw_list[i])
            for bi in order:
                c = min(range(ncols), key=lambda i: col_w[i])
                col_w[c] = max(col_w[c], bw_list[bi])
                col_h[c] += bh_list[bi] + (band_gap if col_h[c] > 0 else 0)
        central_w = sum(col_w) + 24 * (ncols - 1)
        title_w_use = band_title_w if ncols == 1 else 0
        W = (margin + (rail_w + rail_gap if left_ids else 0)
             + (title_w_use + title_gap if title_w_use else 0)
             + spine_w + central_w + spine_w
             + (rail_gap + rail_w if right_ids else 0) + margin)
        rail_h = 22 + max(len(left_ids), len(right_ids), 1) * cell_h \
            + max(0, max(len(left_ids), len(right_ids)) - 1) * 12 + 8
        content_H = max(header_bottom + 16 + max(col_h),
                        header_bottom + 16 + rail_h)
        legend_est = 40 if legend else 0
        todo_block = (todo_h + 24) if todos else 0
        H = content_H + legend_est + todo_block + margin
        return W, H, central_w, bw_list, bh_list, col_w, col_h

    # 目标宽高比：LR 1.6–1.9（取中 1.75）；列宽不均衡计入评分（减少中部空洞）
    target = 1.75 if direction == "LR" else 1.0 / 1.75
    best = None
    assign_opts = ["rot", "lpt"] if layout_mode == "grid" else ["rot"]
    for cap in caps:
        for ncols in ncols_opts:
            for assign in assign_opts:
                if ncols > 1 and len(bands) <= 1:
                    continue
                W0, H0, cw, bw, bh, colw, colh = _eval(cap, ncols, assign)
                imbalance = max(colw) - min(colw) if ncols > 1 else 0.0
                score = abs(W0 / max(H0, 1.0) - target) + imbalance / 600.0
                if best is None or score < best[0]:
                    best = (score, cap, ncols, assign, cw, bw, bh, colw, colh)
    _, cap, ncols, assign, central_w, band_w, band_h, col_w, col_h = best

    # ── 3. domain/band 几何（选定方案）───────────────────────────────
    domain_geo = []
    for b in bands:
        dg = []
        for d in b["domains"]:
            ids = [m["id"] for m in d["modules"]]
            n = len(ids)
            cols = grid_cols(n, cap)
            rows = int(math.ceil(n / float(cols))) if n else 1
            w = cols * cell_w + (cols - 1) * 8 + 16
            h = 22 + rows * cell_h + (rows - 1) * row_gap + 8
            dg.append({"title": d["title"], "ids": ids, "w": w, "h": h,
                       "cols": cols, "rows": rows})
        domain_geo.append(dg)

    # ── 横向链（紧包围盒）：rail 紧邻中央内容区；band 两侧预留脊柱线廊 ──
    x = margin
    if left_ids:
        x += rail_w + rail_gap
    band_title_x = x
    if band_title_w and ncols == 1:
        x += band_title_w + title_gap
    x += spine_w
    band_x = x
    right_x = band_x + central_w + spine_w + (rail_gap if right_ids else 0)
    W_content = round(right_x + (rail_w if right_ids else 0) + margin)

    # ── band/section 列定位：rot = 声明序轮转；lpt = 宽度平衡分配 ─────
    y_band_top = header_bottom + 48
    band_y = [0.0] * len(bands)
    band_col = [0] * len(bands)
    col_y = [y_band_top] * ncols
    if assign == "rot":
        for bi, bh in enumerate(band_h):
            c = bi % ncols
            band_col[bi] = c
            band_y[bi] = col_y[c]
            col_y[c] += bh + band_gap
    else:
        order = sorted(range(len(bands)), key=lambda i: -band_w[i])
        colw_r = [0.0] * ncols
        for bi in order:
            c = min(range(ncols), key=lambda i: colw_r[i])
            colw_r[c] = max(colw_r[c], band_w[bi])
            band_col[bi] = c
            band_y[bi] = col_y[c]
            col_y[c] += band_h[bi] + band_gap
    y_end = max(col_y) - band_gap if band_h else y_band_top
    col_x = []
    xx = band_x
    for c in range(ncols):
        col_x.append(xx)
        xx += col_w[c] + 24

    rail_header = 22
    # rail 有标题时贯穿主体内容高度；无标题降级为普通外部域（警告 + 紧凑块）
    rail_titles = (rails.get("titles") or {}).copy()
    rail_has_title = bool(rail_titles.get("left") or rail_titles.get("right"))
    if not rail_has_title and (left_ids or right_ids):
        warnings.append("rail 未命名：降级为普通外部域（rail 需带标题并贯穿主体高度，如 rail left 外部生态）")
    rail_h_full = rail_header + max(len(left_ids), len(right_ids), 1) * cell_h \
        + max(0, max(len(left_ids), len(right_ids)) - 1) * 12 + 8
    content_bottom = max(y_end, y_band_top + rail_h_full)

    # ── 底部横向图例（一至两行）─────────────────────────────────────
    def _legend_rows(W_budget):
        rows = [[]]
        cur = 40.0

        def entry_w(label):
            return 14 + 6 + text_width(label, st["fs_legend"]) + 22

        for label, kind in legend:
            w = entry_w(label)
            if cur + w > W_budget - margin * 2 and rows[-1]:
                rows.append([])
                cur = 40.0
            rows[-1].append((label, kind))
            cur += w
        if len(rows) > 2:
            half = len(legend) // 2 + len(legend) % 2
            rows = [legend[:half], legend[half:]]
        return rows

    legend_rows = _legend_rows(W_content) if legend else []
    legend_h = 18 * len(legend_rows) if legend_rows else 0
    legend_y0 = content_bottom + 20
    legend_w_used = 0
    if legend_rows:
        legend_w_used = max([40 + sum(14 + 6 + text_width(l, st["fs_legend"]) + 22 for l, _ in row)
                             for row in legend_rows])
        W = max(W_content, round(margin + legend_w_used + margin))
    else:
        W = W_content

    todo_y0 = legend_y0 + legend_h + 12 if legend_rows else content_bottom + 24
    if todos:
        H = round(todo_y0 + todo_h + margin)
    elif legend_rows:
        H = round(legend_y0 + legend_h + margin)
    else:
        H = round(content_bottom + margin)

    # rail 横向锚定中央内容（不锚画布边缘）
    left_rail_x = margin + rail_w / 2
    right_rail_x = right_x + rail_w / 2

    # ── 4. 模块坐标：固定列起点、左对齐（禁止二次居中）；
    #        stacked 模式所有 band 同宽（完整水平层），域在内容区左对齐 ──
    band_lefts = [0.0] * len(bands)
    band_w_use = [0.0] * len(bands)
    for bi, dg in enumerate(domain_geo):
        by = band_y[bi]
        c = band_col[bi]
        band_left = col_x[c]
        band_lefts[bi] = band_left
        band_w_use[bi] = central_w if layout_mode == "stacked" else band_w[bi]
        xx = band_left
        for dd in dg:
            dd["x"] = xx
            xx += dd["w"] + gap
        for dd in dg:
            dy = by + 32
            for i, nid in enumerate(dd["ids"]):
                col = i % dd["cols"]
                row = i // dd["cols"]
                n = N[nid]
                n["x"] = dd["x"] + 8 + col * (cell_w + 8) + cell_w / 2
                n["y"] = dy + 22 + row * (cell_h + row_gap) + cell_h / 2

    for i, nid in enumerate(left_ids):
        N[nid]["x"] = left_rail_x
        N[nid]["y"] = y_band_top + rail_header + cell_h / 2 + i * (cell_h + 12)
    for i, nid in enumerate(right_ids):
        N[nid]["x"] = right_rail_x
        N[nid]["y"] = y_band_top + rail_header + cell_h / 2 + i * (cell_h + 12)

    # ── domain 配色（全图 domain 出现序循环）────────────────────────
    color_idx = 0
    for dg in domain_geo:
        for dd in dg:
            fill = DOMAIN_PALETTE[color_idx % len(DOMAIN_PALETTE)]
            dd["color"] = fill
            dd["border"] = _darken(fill)
            color_idx += 1

    # ── 路由骨架信息 ────────────────────────────────────────────────
    band_of = {}
    for bi, dg in enumerate(domain_geo):
        for dd in dg:
            for nid in dd["ids"]:
                band_of[nid] = bi
    for nid in left_ids:
        band_of[nid] = "L"
    for nid in right_ids:
        band_of[nid] = "R"
    min_band_left = min((col_x[band_col[bi]] + (col_w[band_col[bi]] - bw) / 2)
                        for bi, bw in enumerate(band_w)) if band_w else band_x
    max_band_right = max((col_x[band_col[bi]] + (col_w[band_col[bi]] - bw) / 2 + bw)
                         for bi, bw in enumerate(band_w)) if band_w else band_x
    # 同列相邻 band 之间的间隙带（供正交路由）
    gaps = []
    for c in range(ncols):
        col_bands = [bi for bi in range(len(bands)) if band_col[bi] == c]
        for k in range(len(col_bands) - 1):
            above, below = col_bands[k], col_bands[k + 1]
            gaps.append((above, below,
                         band_y[above] + band_h[above], band_y[below]))
    geo = {
        "band_y": band_y, "band_h": band_h, "domain_geo": domain_geo,
        "row_gap": row_gap, "band_of": band_of, "band_col": band_col,
        "gaps": gaps, "col_w": col_w, "col_x": col_x,
        "y_band_top": y_band_top, "content_bottom": content_bottom,
        "left_ids": left_ids, "right_ids": right_ids,
        "left_gap_x": margin + rail_w + rail_gap / 2,
        "right_gap_x": band_x + central_w + spine_w + rail_gap / 2,
        "empty_left": min_band_left - 20, "empty_right": max_band_right + 20,
        "min_band_left": min_band_left, "max_band_right": max_band_right,
        "left_spine_x0": band_x - spine_w, "right_spine_x0": right_x - spine_w,
        "n_long": n_long,
    }

    # 预留区（页眉/图例/待确认）——路由与标签都不得侵入
    reserved = [("header", 0, 0, W, y_band_top - 24)]
    if legend_rows:
        reserved.append(("legend", margin - 4, legend_y0 - 4,
                         margin + legend_w_used + 4, legend_y0 + legend_h + 4))
    if todos:
        reserved.append(("todo", margin - 4, todo_y0 - 4,
                         margin + todo_w + 4, todo_y0 + todo_h + 4))
    geo["reserved_rects"] = [(x0, y0, x1, y1) for _, x0, y0, x1, y1 in reserved]
    # band 标题区也作为路由避让区（顶/底总线垂直线不得穿过标题文字）
    for bi, t in enumerate([b["title"] for b in bands]):
        if t:
            tx = band_title_x if ncols == 1 else band_lefts[bi] + 8
            geo["reserved_rects"].append(
                (tx, band_y[bi],
                 tx + text_width(t, st["fs_section"]) + 2, band_y[bi] + 26))

    # ── 路由 ────────────────────────────────────────────────────────
    routes = _route_edges(spec, N, st, cell_w, cell_h, geo)

    # 路由质量指标（bendCount/routeLength/directDistance/detourRatio + 门槛警告）
    route_quality = []
    for r in routes:
        a, b = N[r["from"]], N[r["to"]]
        direct = abs(a["x"] - b["x"]) + abs(a["y"] - b["y"])
        length = _route_len(r["pts"])
        bends = _bends(r["pts"])
        detour = length / max(direct, 0.001)
        ia, ib = band_of.get(r["from"]), band_of.get(r["to"])
        if isinstance(ia, int) and isinstance(ib, int):
            span = abs(ia - ib) + (0 if band_col[ia] == band_col[ib] else 3)
        else:
            span = 0  # rail 直连不适用跨层门槛
        route_quality.append({"id": r["id"], "bends": bends, "length": round(length),
                              "direct": round(direct), "detourRatio": round(detour, 2)})
        if span <= 1 and bends > 2:
            warnings.append("边 %s 折弯 %d 次（同/相邻 band 建议 ≤2：检查端口与对齐）"
                            % (r["id"], bends))
        if span <= 1 and detour > 1.3:
            warnings.append("边 %s 绕行比 %.2f > 1.3（同/相邻 band 建议直连）"
                            % (r["id"], detour))
        if span >= 2 and bends > 4:
            warnings.append("边 %s 折弯 %d 次（长跨层建议 ≤4）" % (r["id"], bends))
        if span >= 2 and detour > 1.8:
            warnings.append("边 %s 绕行比 %.2f > 1.8（长跨层建议简化）" % (r["id"], detour))

    crossings = ortho_crossings(routes)
    if crossings:
        raise SystemExit("错误：关系路由交叉无法消除（%d 处，形态超限，建议 mermaid 原生渲染）"
                         % len(crossings))

    # ── 质检：模块盒 / domain 标题盒 / 重叠 ─────────────────────────
    boxes = [(nid, n["x"], n["y"], n["w"], n["h"]) for nid, n in N.items()]
    domain_title_boxes = []
    for bi, dg in enumerate(domain_geo):
        for di, dd in enumerate(dg):
            tw = text_width(dd["title"], st["fs_section"])
            domain_title_boxes.append(
                ("domain-title-%d-%d" % (bi, di), dd["x"] + dd["w"] / 2,
                 band_y[bi] + 32 + 14, tw, st["fs_section"] + 4))
    overlaps = box_overlaps(boxes + domain_title_boxes)

    # ── 关系标签贪心放置（沿自身路由各段多档搜索，避开连线/盒/预留区/已放标签）──
    labels = []
    for ri, r in enumerate(routes):
        if not r["label"]:
            continue
        t = r["label"][0]
        cand_pts = [(r["lx"], r["ly"], r["anchor"])]
        # 沿路由各段：水平段中点上方/下方、垂直段右侧
        for k in range(len(r["pts"]) - 1):
            p1, p2 = r["pts"][k], r["pts"][k + 1]
            if abs(p1[1] - p2[1]) < 0.01:
                mx = (p1[0] + p2[0]) / 2
                for m in range(0, 5):
                    cand_pts.append((mx, p1[1] - 6 - 8 * m, "middle"))
                    cand_pts.append((mx, p1[1] + 12 + 8 * m, "middle"))
            elif abs(p1[0] - p2[0]) < 0.01:
                my = (p1[1] + p2[1]) / 2
                for m in range(0, 5):
                    cand_pts.append((p1[0] + 8 + 12 * m, my, "start"))
        for k in range(1, 9):
            cand_pts.append((r["lx"], r["ly"] - 8 * k, r["anchor"]))
            cand_pts.append((r["lx"], r["ly"] + 8 * k, r["anchor"]))
        best_pt = cand_pts[0]
        for lx2, ly2, anc in cand_pts:
            lab = {"id": "edge-%d-0" % ri, "text": t, "lx": lx2, "ly": ly2,
                   "anchor": anc, "fs": st["fs_label"], "route": ri,
                   "own": [r["from"], r["to"]]}
            colls = label_collisions(routes, labels + [lab], boxes, reserved)
            lid = "edge-%d-0" % ri
            if not any(c["id"] == lid or c.get("with") == lid for c in colls):
                best_pt = (lx2, ly2, anc)
                break
        r["lx"], r["ly"], r["anchor"] = best_pt
        labels.append({"id": "edge-%d-0" % ri, "text": t,
                       "lx": r["lx"], "ly": r["ly"], "anchor": r["anchor"],
                       "fs": st["fs_label"], "route": ri, "own": [r["from"], r["to"]]})

    # 锚点徽章标签（关系旁 + 节点角标）
    for ri, r in enumerate(routes):
        if r.get("refs"):
            lw = text_width(r["label"][0], st["fs_label"]) if r["label"] else 0
            xx = r["lx"] + (lw / 2 if r["anchor"] == "middle" else lw) + 6
            for ref in r["refs"]:
                labels.append({"id": "edge-ref-%d-%s" % (ri, ref), "text": "[%s]" % ref,
                               "lx": xx + text_width("[%s]" % ref, st["fs_badge"]) / 2,
                               "ly": r["ly"] + 4, "anchor": "middle",
                               "fs": st["fs_badge"], "route": ri,
                               "own": [r["from"], r["to"]]})
                xx += text_width("[%s]" % ref, st["fs_badge"]) + 4
    # band 标题纳入碰撞检测（单列：左侧标题列；多列：band 顶部）
    for bi, t in enumerate([b["title"] for b in bands]):
        if t:
            tx = band_title_x if ncols == 1 else band_lefts[bi] + 8
            labels.append({"id": "band-title-%d" % bi, "text": t,
                           "lx": tx, "ly": band_y[bi] + 16,
                           "anchor": "start", "fs": st["fs_section"], "own": []})
    # rail 标题纳入碰撞检测（命名 rail 的栏标题）
    for side, rt in (rail_titles or {}).items():
        if rt and (left_ids if side == "left" else right_ids):
            rx = left_rail_x if side == "left" else right_rail_x
            labels.append({"id": "rail-title-%s" % side, "text": rt,
                           "lx": rx - text_width(rt, st["fs_section"]) / 2,
                           "ly": y_band_top + 16, "anchor": "start",
                           "fs": st["fs_section"], "own": []})

    label_collisions_out = label_collisions(routes, labels, boxes, reserved)

    # ── 文字溢出（模块 / domain 标题 / band 标题 / 关系标签边界）─────
    overflow = []
    for nid in spec["order"]:
        n = N[nid]
        lines = n["lines"]
        if len(lines) > 4:
            overflow.append({"id": nid, "line": 99, "text": "lines=%d" % len(lines),
                             "need": len(lines), "avail": 4})
        refs = n.get("refs") or []
        for j, (text, fs, kind) in enumerate(lines):
            need = text_width(text, fs) + (28 if kind == "pill" else 0)
            avail = cell_w - 12 - (26 if refs else 0)  # 角标占右上角
            if need > avail:
                overflow.append({"id": nid, "line": j, "text": text,
                                 "need": round(need), "avail": round(avail)})
        if refs:
            need = sum(text_width("[%s]" % r, st["fs_badge"]) + 8 for r in refs) \
                + 4 * (len(refs) - 1)
            if need > cell_w - 12:
                overflow.append({"id": nid, "line": 98, "text": "refs",
                                 "need": round(need), "avail": round(cell_w - 12)})
    for bi, dg in enumerate(domain_geo):
        for dd in dg:
            need = text_width(dd["title"], st["fs_section"])
            if need > dd["w"] - 12:
                overflow.append({"id": "domain-%s" % dd["title"], "line": 0,
                                 "text": dd["title"], "need": round(need),
                                 "avail": round(dd["w"] - 12)})
    for bi, b in enumerate(bands):
        if b["title"]:
            need = text_width(b["title"], st["fs_section"])
            avail = band_title_w - 8 if ncols == 1 else band_w[bi] - 16
            if need > avail:
                overflow.append({"id": "band-%s" % b["title"], "line": 0,
                                 "text": b["title"], "need": round(need),
                                 "avail": round(avail)})
    for r in routes:
        for j, t in enumerate(r.get("label", [])):
            need = text_width(t, st["fs_label"])
            half = need / 2
            lx, ly = r["lx"], r["ly"] + j * 13
            if r["anchor"] == "start":
                if lx < 2 or lx + need > W - 2 or ly < 2 or ly > H - 2:
                    overflow.append({"id": r["id"], "line": j, "text": t,
                                     "need": round(need), "avail": round(W - 4)})
            else:
                if lx - half < 2 or lx + half > W - 2 or ly < 2 or ly > H - 2:
                    overflow.append({"id": r["id"], "line": j, "text": t,
                                     "need": round(need), "avail": round(W - 4)})

    # ── 紧凑度指标（真实测量，防画布膨胀回归）─────────────────────────
    central_area = sum(bw * bh for bw, bh in zip(band_w, band_h))
    rail_area = rail_h_full * rail_w * (1 if left_ids else 0) + rail_h_full * rail_w * (1 if right_ids else 0)
    content_area = central_area + rail_area
    # centralFillX：各 band 相对其所在列宽的填充率均值（真实测量）
    fill = [band_w[bi] / col_w[band_col[bi]] for bi in range(len(band_w))]
    central_fill_x = round(sum(fill) / len(fill), 3) if fill else 1.0
    # railDistance：rail 与中央内容之间的实际距离（扣除标题列与脊柱线廊的配置宽度）
    if left_ids:
        rail_dist_l = min_band_left - (left_rail_x + rail_w / 2) - band_title_w - spine_w
    else:
        rail_dist_l = 0
    if right_ids:
        rail_dist_r = (right_rail_x - rail_w / 2) - max_band_right - spine_w
    else:
        rail_dist_r = 0
    rail_dist = max(rail_dist_l, rail_dist_r)
    # maxVerticalGap：同列相邻 band 实际间隙超出配置 gap 的最大值（真实测量）
    max_v_gap = 0.0
    for c in range(ncols):
        col_bands = [bi for bi in range(len(bands)) if band_col[bi] == c]
        for k in range(len(col_bands) - 1):
            above, below = col_bands[k], col_bands[k + 1]
            actual = band_y[below] - (band_y[above] + band_h[above])
            max_v_gap = max(max_v_gap, actual - band_gap)
    max_v_gap = round(max_v_gap, 1)
    metrics = {
        "centralFillX": central_fill_x,
        "contentFill": round(content_area / max(W * H, 1.0), 3),
        "maxHorizontalGap": round(max(col_w[band_col[bi]] - band_w[bi]
                                      for bi in range(len(band_w))) if band_w else 0, 1),
        "maxVerticalGap": max_v_gap,
        "railDistance": round(rail_dist, 1),
        "canvasAspect": round(W / max(H, 1.0), 3),
    }
    if layout_mode == "grid":
        if metrics["centralFillX"] < 0.6:
            warnings.append("紧凑度 centralFillX=%.2f 低于硬门槛 0.60" % metrics["centralFillX"])
        if metrics["contentFill"] < 0.5:
            warnings.append("内容填充率 %.1f%% 低于 50%%（建议列宽平衡/更方整的域网格）"
                            % (metrics["contentFill"] * 100))
    sep_budget = rail_gap + band_title_w + spine_w
    if metrics["railDistance"] > 2 * sep_budget + 8:
        warnings.append("railDistance=%.0f 超过配置间距 2 倍（%.0f）：存在异常空白"
                        % (metrics["railDistance"], 2 * sep_budget + 8))
    if direction == "LR" and metrics["canvasAspect"] < 1.0:
        warnings.append("横屏模式画布比例 %.2f < 1.0（内容本身偏高：建议减少 band 或扩充 domain）"
                        % metrics["canvasAspect"])

    extra = {
        "band_x": band_x, "band_title_w": band_title_w, "band_title_x": band_title_x,
        "ncols": ncols, "band_lefts": band_lefts,
        "band_y": band_y, "band_h": band_h, "band_w": band_w,
        "domain_geo": domain_geo, "cell_w": cell_w, "cell_h": cell_h,
        "title": title, "meta_line": meta_line, "header_bottom": header_bottom,
        "y_band_top": y_band_top, "y_end": y_end,
        "legend": legend, "legend_rows": legend_rows,
        "legend_y0": legend_y0, "legend_h": legend_h, "legend_w_used": legend_w_used,
        "todos": todos, "todo_y0": todo_y0, "todo_w": todo_w, "todo_h": todo_h,
        "left_ids": left_ids, "right_ids": right_ids,
        "rail_titles": rail_titles, "content_bottom": content_bottom,
        "rail_w": rail_w, "rail_header": rail_header,
        "right_rail_x": right_rail_x,
        "band_titles": [b["title"] for b in bands],
        "band_w_use": band_w_use, "layout_mode": layout_mode,
        "metrics": metrics,
    }

    return {"nodes": N, "order": [n["id"] for n in spec["nodes"]],
            "render_order": spec["order"], "routes": routes,
            "extra": extra, "W": W, "H": H, "style": st,
            "crossings": crossings, "overlaps": overlaps,
            "textOverflow": overflow, "labelCollisions": label_collisions_out,
            "metrics": metrics, "routeQuality": route_quality,
            "warnings": warnings}


def layout(spec, style=None, args=None):
    st = dict(STYLE)
    if style:
        st.update(style)
    return _place(spec, st)


# ── 渲染层 ──────────────────────────────────────────────────────────
def _cylinder(out, cx, cy, w, h, st):
    rx = min(10.0, w / 2)
    ry = 6.0
    x0, x1 = cx - w / 2, cx + w / 2
    yt = cy - h / 2 + ry
    yb = cy + h / 2 - ry
    out.append('<path d="M %g %g A %g %g 0 0 0 %g %g L %g %g A %g %g 0 0 0 %g %g Z" '
               'fill="%s" stroke="%s" stroke-width="1.3"/>'
               % (x0, yt, rx, ry, x1, yt, x1, yb, rx, ry, x0, yb,
                  st["fill_backend"], st["stroke_backend"]))
    out.append('<ellipse cx="%g" cy="%g" rx="%g" ry="%g" fill="%s" stroke="%s" stroke-width="1.3"/>'
               % (cx, yt, rx, ry, st["fill_backend"], st["stroke_backend"]))


def _render_node(out, n, st, idx):
    cx, cy, w, h = n["x"], n["y"], n["w"], n["h"]
    style_k = _node_style(n)
    out.append('<g class="node" id="bp-%s-%d" data-node="%s" data-style="%s">'
               % (n["id"], idx, n["id"], style_k))
    if style_k == "external":
        out.append('<rect x="%g" y="%g" width="%g" height="%g" rx="4" fill="%s" stroke="%s" '
                   'stroke-width="1.3" stroke-dasharray="5 4"/>'
                   % (cx - w / 2, cy - h / 2, w, h, st["fill_external"], st["stroke_external"]))
    elif style_k == "datastore":
        # 高密度全景图：统一矩形卡片 + 左上角数据库小图标（保持网格整齐）
        out.append('<rect x="%g" y="%g" width="%g" height="%g" rx="6" fill="%s" stroke="%s" stroke-width="1.4"/>'
                   % (cx - w / 2, cy - h / 2, w, h, st["fill_backend"], st["stroke_backend"]))
        ix, iy = cx - w / 2 + 5, cy - h / 2 + 3
        out.append('<ellipse cx="%g" cy="%g" rx="4" ry="2.5" fill="none" stroke="%s" stroke-width="1"/>'
                   % (ix + 4, iy + 2, st["stroke_backend"]))
        out.append('<path d="M %g %g a 4 2.5 0 0 0 8 0 M %g %g a 4 2.5 0 0 0 8 0" '
                   'fill="none" stroke="%s" stroke-width="1"/>'
                   % (ix, iy + 6, ix, iy + 11, st["stroke_backend"]))
        out.append('<path d="M %g %g a 4 2.5 0 0 0 8 0" fill="none" stroke="%s" stroke-width="1"/>'
                   % (ix, iy + 15, st["stroke_backend"]))
    else:
        out.append('<rect x="%g" y="%g" width="%g" height="%g" rx="6" fill="%s" stroke="%s" stroke-width="1.4"/>'
                   % (cx - w / 2, cy - h / 2, w, h, st["fill"], st["stroke"]))
    top = cy - h / 2
    y = top + 15
    refs = n.get("refs") or []
    text_cx = cx - 8 if refs else cx  # 右上角标占用时正文左移避让
    for text, fs, kind in n["lines"]:
        if kind == "pill":
            tw = text_width(text, fs)
            out.append('<rect x="%g" y="%g" width="%g" height="16" rx="8" fill="%s" stroke="%s" stroke-width="0.8"/>'
                       % (text_cx - tw / 2 - 7, y - 12, tw + 14, st["pill_fill"], st["pill_stroke"]))
            out.append('<text x="%g" y="%g" font-size="%d" fill="%s" text-anchor="middle">%s</text>'
                       % (text_cx, y, fs, st["pill_text"], esc(text)))
            y += 20
        else:
            color = st["text"] if fs == st["fs_node"] else st["band_text"]
            out.append('<text x="%g" y="%g" font-size="%d" fill="%s" text-anchor="middle">%s</text>'
                       % (text_cx, y, fs, color, esc(text)))
            y += 13
    if refs:
        # 注释锚点 = 右上角标（不增高节点）
        xx = cx + w / 2 - 4
        yy = cy - h / 2 + 2
        for r in refs:
            tw = text_width("[%s]" % r, st["fs_badge"]) + 8
            xx -= tw
            out.append('<rect x="%g" y="%g" width="%g" height="14" rx="7" fill="%s" stroke="%s" stroke-width="0.8"/>'
                       % (xx, yy, tw, st["note_fill"], st["note_stroke"]))
            out.append('<text x="%g" y="%g" font-size="%d" fill="%s" text-anchor="middle" class="note-badge">[%s]</text>'
                       % (xx + tw / 2, yy + 10, st["fs_badge"], st["note_text"], esc(r)))
            xx -= 4
    out.append('</g>')


def _legend_swatch(out, x0, y, kind, st):
    if kind == "sync":
        out.append('<line x1="%g" y1="%g" x2="%g" y2="%g" stroke="%s" stroke-width="1.5" marker-end="url(#arw)"/>'
                   % (x0, y, x0 + 14, y, st["edge_color"]))
        return
    if kind == "async":
        out.append('<line x1="%g" y1="%g" x2="%g" y2="%g" stroke="%s" stroke-width="1.4" stroke-dasharray="4 3" marker-end="url(#arw-open)"/>'
                   % (x0, y, x0 + 14, y, st["async_edge"]))
        return
    if kind == "datastore":
        out.append('<rect x="%g" y="%g" width="14" height="10" rx="2" fill="%s" stroke="%s" stroke-width="1"/>'
                   % (x0, y - 8, st["fill_backend"], st["stroke_backend"]))
        out.append('<ellipse cx="%g" cy="%g" rx="3" ry="1.8" fill="none" stroke="%s" stroke-width="0.8"/>'
                   % (x0 + 7, y - 6, st["stroke_backend"]))
        out.append('<path d="M %g %g a 3 1.8 0 0 0 6 0 M %g %g a 3 1.8 0 0 0 6 0" fill="none" stroke="%s" stroke-width="0.8"/>'
                   % (x0 + 4, y - 2.5, x0 + 4, y + 0.5, st["stroke_backend"]))
        return
    if kind == "external":
        out.append('<rect x="%g" y="%g" width="14" height="10" fill="%s" stroke="%s" stroke-width="1" stroke-dasharray="4 3"/>'
                   % (x0, y - 8, st["fill_external"], st["stroke_external"]))
        return
    if kind == "domain":
        out.append('<rect x="%g" y="%g" width="14" height="10" fill="%s" stroke="%s" stroke-width="1"/>'
                   % (x0, y - 8, DOMAIN_PALETTE[0], _darken(DOMAIN_PALETTE[0])))
        return
    out.append('<rect x="%g" y="%g" width="14" height="10" rx="3" fill="%s" stroke="%s" stroke-width="1.2"/>'
               % (x0, y - 8, st["fill"], st["stroke"]))


def render_svg(lay, title=""):
    st = lay["style"]
    ex = lay["extra"]
    out = svg_open(lay["W"], lay["H"], DATA_ATTR, st)
    out.append(arrow_marker(st))
    out.append('<defs><marker id="arw-open" viewBox="0 0 10 10" refX="9" refY="5" '
               'markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
               '<path d="M0,0 L10,5 L0,10 z" fill="#ffffff" stroke="%s" stroke-width="1.2"/>'
               '</marker></defs>' % st["edge_color"])

    # 页眉（标题逐字使用 DSL title，工具传入的 title 仅作缺省）
    if ex["title"] or title:
        out.append('<text x="%g" y="%g" font-size="%d" font-weight="700" fill="%s" text-anchor="start">%s</text>'
                   % (20, 20 + 14, st["fs_title"], st["text"], esc(ex["title"] or title)))
    if ex["meta_line"]:
        out.append('<text x="%g" y="%g" font-size="%d" fill="%s" text-anchor="start">%s</text>'
                   % (20, ex["header_bottom"] - 3, st["fs_meta"], st["label_color"],
                      esc(ex["meta_line"])))

    # band/section 组：跨宽标题条 +（stacked 模式）等宽完整水平层背景
    band_titles = ex["band_titles"]
    band_w_use = ex.get("band_w_use") or [0] * len(ex["band_h"])
    for bi in range(len(ex["band_h"])):
        by = ex["band_y"][bi]
        t = band_titles[bi] if bi < len(band_titles) else ""
        bw_use = band_w_use[bi] if bi < len(band_w_use) else 0
        out.append('<g class="band" id="bp-band-%d">' % bi)
        if ex.get("layout_mode") == "stacked":
            # 完整水平层：等宽浅底 + 标题条
            out.append('<rect x="%g" y="%g" width="%g" height="%g" rx="4" fill="%s" stroke="%s" stroke-width="0.6"/>'
                       % (ex["band_lefts"][bi], by, bw_use, ex["band_h"][bi] - 4,
                          st["rail_fill"], st["band_stroke"]))
        if t:
            tx = ex["band_title_x"] if ex.get("ncols", 1) == 1 else ex["band_lefts"][bi] + 8
            out.append('<rect x="%g" y="%g" width="%g" height="26" rx="4" fill="%s"/>'
                       % (ex["band_lefts"][bi], by, bw_use, st["titlebar_fill"]))
            out.append('<text x="%g" y="%g" font-size="%d" font-weight="700" fill="%s" text-anchor="start" class="band-title">%s</text>'
                       % (tx, by + 16, st["fs_section"] + 1, st["text"], esc(t)))
        dg = ex["domain_geo"][bi]
        for dd in dg:
            out.append('<g class="domain" data-domain="%s" data-color="%s">'
                       % (esc(dd["title"]), dd["color"]))
            out.append('<rect x="%g" y="%g" width="%g" height="%g" rx="4" fill="%s" stroke="%s" stroke-width="1"/>'
                       % (dd["x"], by + 32 - 6, dd["w"], dd["h"] + 12, dd["color"], dd["border"]))
            out.append('<text x="%g" y="%g" font-size="%d" font-weight="700" fill="%s" text-anchor="middle" class="domain-title">%s</text>'
                       % (dd["x"] + dd["w"] / 2, by + 32 + 14, st["fs_section"],
                          _darken(dd["color"], 0.45), esc(dd["title"])))
            for nid in dd["ids"]:
                n = lay["nodes"][nid]
                idx = lay["render_order"].index(nid) if nid in lay["render_order"] else 0
                _render_node(out, n, st, idx)
            out.append('</g>')
        out.append('</g>')

    # 侧栏（紧邻中央内容区：右侧锚定中央区右缘，不锚画布边缘）
    for side, ids in (("left", ex["left_ids"]), ("right", ex["right_ids"])):
        if not ids:
            continue
        rail_x = (20 + ex["rail_w"] / 2) if side == "left" else ex["right_rail_x"]
        n = len(ids)
        rail_title = (ex.get("rail_titles") or {}).get(side, "")
        if rail_title:
            # 命名 rail：贯穿主体内容高度 + 栏标题
            rail_h = ex["content_bottom"] - ex["y_band_top"]
        else:
            rail_h = ex["rail_header"] + n * ex["cell_h"] + (n - 1) * 12 + 8
        out.append('<g class="rail" id="bp-rail-%s">' % side)
        out.append('<rect x="%g" y="%g" width="%g" height="%g" rx="4" fill="%s" stroke="none"/>'
                   % (rail_x - ex["rail_w"] / 2, ex["y_band_top"], ex["rail_w"], rail_h,
                      st["rail_fill"]))
        if rail_title:
            out.append('<text x="%g" y="%g" font-size="%d" font-weight="700" fill="%s" '
                       'text-anchor="middle" class="rail-title">%s</text>'
                       % (rail_x, ex["y_band_top"] + 16, st["fs_section"], st["text"],
                          esc(rail_title)))
        for nid in ids:
            node = lay["nodes"][nid]
            idx = lay["render_order"].index(nid) if nid in lay["render_order"] else 0
            _render_node(out, node, st, idx)
        out.append('</g>')

    # 路由（同步实线 / 异步虚线）与标签（含锚点标记）
    for r in lay["routes"]:
        p = " ".join("%g,%g" % (x, y) for x, y in r["pts"])
        if r.get("async"):
            out.append('<polyline points="%s" fill="none" stroke="%s" stroke-width="1.4" stroke-dasharray="5 4" marker-end="url(#arw-open)"/>'
                       % (p, st["async_edge"]))
        else:
            out.append('<polyline points="%s" fill="none" stroke="%s" stroke-width="1.5" marker-end="url(#arw)"/>'
                       % (p, st["edge_color"]))
        if r["label"] and r["lx"] is not None:
            for k, t in enumerate(r["label"]):
                out.append('<text x="%g" y="%g" font-size="%d" fill="%s" text-anchor="%s">%s</text>'
                           % (r["lx"], r["ly"] + k * 13, st["fs_label"], st["label_color"],
                              r["anchor"], esc(t)))
        if r.get("refs"):
            lw = text_width(r["label"][0], st["fs_label"]) if r.get("label") else 0
            x = r["lx"] + (lw / 2 if r["anchor"] == "middle" else lw) + 6
            for ref in r["refs"]:
                out.append('<text x="%g" y="%g" font-size="%d" fill="%s" text-anchor="start" class="note-badge">[%s]</text>'
                           % (x, r["ly"] + 4, st["fs_badge"], st["note_text"], esc(ref)))
                x += text_width("[%s]" % ref, st["fs_badge"]) + 4

    # 图例（底部横向一至两行）
    if ex["legend_rows"]:
        out.append('<g class="legend" id="bp-legend">')
        x0 = 20
        yy = ex["legend_y0"]
        for row in ex["legend_rows"]:
            out.append('<text x="%g" y="%g" font-size="%d" font-weight="700" fill="%s" text-anchor="start">图例</text>'
                       % (x0, yy + 10, st["fs_legend"], st["text"]))
            xx = x0 + 40
            for label, kind in row:
                _legend_swatch(out, xx, yy + 4, kind, st)
                out.append('<text x="%g" y="%g" font-size="%d" fill="%s" text-anchor="start">%s</text>'
                           % (xx + 20, yy + 10, st["fs_legend"], st["text"], esc(label)))
                xx += 20 + text_width(label, st["fs_legend"]) + 22
            yy += 18
        out.append('</g>')

    # 待确认项
    if ex["todos"]:
        out.append('<g class="todo" id="bp-todo">')
        out.append('<rect x="%g" y="%g" width="%g" height="%g" rx="4" fill="%s" stroke="%s" stroke-width="0.8"/>'
                   % (20, ex["todo_y0"], ex["todo_w"], ex["todo_h"],
                      st["rail_fill"], st["stroke_external"]))
        out.append('<text x="%g" y="%g" font-size="%d" font-weight="700" fill="%s" text-anchor="start">待确认项</text>'
                   % (32, ex["todo_y0"] + 17, st["fs_todo"], st["text"]))
        for k, t in enumerate(ex["todos"]):
            out.append('<text x="%g" y="%g" font-size="%d" fill="%s" text-anchor="start">「%s」%s</text>'
                       % (32, ex["todo_y0"] + 33 + k * 18, st["fs_todo"], st["label_color"],
                          esc(t["id"]), esc(t["text"])))
        out.append('</g>')

    out += svg_close()
    return "\n".join(out)


def render_html(lay, title):
    return _render_html(render_svg(lay, title), title, lay["style"]["font_family"])


def main_cli(args):
    return common_main(args, sys.modules[__name__])


if __name__ == "__main__":
    ap = common_argparse("flow-canvas 企业应用架构全景图布局器（blueprintspec/1）")
    raise SystemExit(main_cli(ap.parse_args()))
