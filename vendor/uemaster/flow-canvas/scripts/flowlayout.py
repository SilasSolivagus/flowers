#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""flow-canvas 正交流程图布局器（零依赖，Python 标准库）。

输入 mermaid flowchart 子集（.mmd）或 flowspec JSON（.json），
输出横平竖直的正交流程图 SVG，或带缩放/拖拽画布的单文件 HTML。

布局规则（正交规范）：
  - 主干节点排纵向主列，分支节点排右列并与判断节点垂直居中对齐；
  - 判断菱形为扁菱形；"否"类分支从右侧水平顶点出线，主干从底部顶点出线；
  - 回边走最右侧通道，90 度折线，进入目标右侧端口（多入口自动错位）；
  - 分支链汇回主干：目标为判断节点时 T 形汇入主干线（目标顶部上方 18px），目标为普通节点时进右端口；
  - 主干跳级边（首尾都在主干、非相邻的前向边）：目标为判断节点时走右侧前向通道 T 形汇入，
    其余走左侧远端通道进目标左端口；
  - 无入边的旁路源节点排左列，与目标水平对齐；--left 可把分支链改放左列
    （与右链镜像，经左侧远端通道汇入目标左端口），用于避开右侧通道冲突；
  - 输出前自动做线段交叉检测，交叉数超过阈值时建议降级为 mermaid 原生渲染。

用法：
  python3 flowlayout.py input.mmd  -o out.svg
  python3 flowlayout.py input.mmd  -o out.html --html [--title "标题"]
  python3 flowlayout.py input.json -o out.svg
  python3 flowlayout.py input.mmd  --check          # 仅输出布局检查报告 JSON
  python3 flowlayout.py input.mmd  -o out.svg --style style.json   # 覆盖样式变量
  python3 flowlayout.py input.mmd  -o out.svg --spine A,B,C        # 强制主干顺序（覆盖自动选择）
  python3 flowlayout.py input.mmd  -o out.svg --type arch          # 多图类型：flowchart|arch|er|gantt|seq
"""
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
import importlib
import json
import re
import sys
import argparse

from flowcommon import (find_emoji, text_width, wrap_label, node_size, esc,
                        ortho_crossings, box_overlaps, text_overflow_check,
                        build_report, render_html, is_clean, load_style)

SPEC_VERSION = "flowspec/1"

# ── 默认样式（灰度线框；调用方可用 --style 覆盖任意键） ──────────────
DEFAULT_STYLE = {
    "font_family": "-apple-system, PingFang SC, Segoe UI, Microsoft YaHei, sans-serif",
    "fs_node": 13,
    "fs_sub": 11,
    "fs_label": 11,
    "stroke_process": "#333333",
    "stroke_external": "#888888",
    "stroke_backend": "#999999",
    "stroke_decision": "#aaaaaa",
    "fill_process": "#ffffff",
    "fill_external": "#ffffff",
    "fill_backend": "#d9d9d9",
    "fill_decision": "#ededed",
    "fill_p0": "#fbe9e9", "stroke_p0": "#c0392b",
    "fill_p1": "#fdf1e3", "stroke_p1": "#d98324",
    "fill_p2": "#f0f0f0", "stroke_p2": "#8a8a8a",
    "fill_added": "#e8f0fb", "stroke_added": "#2f6fed",
    "fill_disputed": "#f3ecf9", "stroke_disputed": "#7b4fa8",
    "text_process": "#333333",
    "text_external": "#666666",
    "text_backend": "#333333",
    "text_decision": "#333333",
    "edge_color": "#555555",
    "label_color": "#888888",
    "sel_ring_stroke": "#4a90d9",
    "sel_ring_fill": "rgba(74,144,217,0.08)",
}

# ── 解析层 ──────────────────────────────────────────────────────────
NODE_SHAPES = [
    (re.compile(r'^\[\["?(.*?)"?\]\]'), "backend"),
    (re.compile(r'^\{"?(.*?)"?\}'), "decision"),
    (re.compile(r'^\["?(.*?)"?\]'), "process"),
    (re.compile(r'^\("?(.*?)"?\)'), "process"),
]
ID_RE = re.compile(r'([A-Za-z][A-Za-z0-9_]*)')
CLASS_TYPE = {"external": "external", "wallet": "external", "ext": "external",
              "backend": "backend", "back": "backend", "admin": "backend"}

# 缺口严重度着色：class A,B p0  → 红；p1 → 橙；p2 → 灰
SEVERITY_TYPE = {"p0": "p0", "critical": "p0", "blocker": "p0",
                 "p1": "p1", "major": "p1", "high": "p1",
                 "p2": "p2", "minor": "p2", "low": "p2"}

# 评审标记：区分「PRD 原文写的」与「评审认为需要改的」
MARK_TYPE = {"added": "added", "proposed": "added", "suggest": "added",
             "disputed": "disputed", "doubt": "disputed", "wrong": "disputed"}


def parse_mermaid(src):
    nodes, order, edges = {}, [], []

    def ensure(nid, label=None, ntype=None):
        if nid not in nodes:
            nodes[nid] = {"id": nid, "type": "process", "label": [nid]}
            order.append(nid)
        if label is not None:
            nodes[nid]["label"] = [l.strip() for l in label.split("<br>") if l.strip()]
        if ntype is not None:
            nodes[nid]["type"] = ntype

    def eat_node(chunk):
        """chunk 形如 'A["文本"]' 或 'A'，注册节点并返回 id。"""
        m = ID_RE.match(chunk)
        if not m:
            return None
        nid = m.group(1)
        rest = chunk[m.end():]
        for rx, ntype in NODE_SHAPES:
            sm = rx.match(rest)
            if sm:
                ensure(nid, sm.group(1), ntype)
                return nid
        ensure(nid)
        return nid

    for raw in src.splitlines():
        line = raw.strip()
        if (not line or line.startswith("%%") or line.startswith("flowchart")
                or line.startswith("graph") or line.startswith("classDef")):
            continue
        cm = re.match(r'^class\s+([\w,\s]+?)\s+(\w+);?$', line)
        if cm:
            key = cm.group(2).lower()
            t = CLASS_TYPE.get(key)
            sev = None if t else SEVERITY_TYPE.get(key)
            mark = None if (t or sev) else MARK_TYPE.get(key)
            if t or sev or mark:
                for nid in [x.strip() for x in cm.group(1).split(",")]:
                    ensure(nid)
                    if t:
                        nodes[nid]["type"] = t
                    if sev:
                        nodes[nid]["severity"] = sev
                    if mark:
                        nodes[nid]["severity"] = mark
            continue
        if "-->" in line or "-.->" in line:
            parts = re.split(r'\s*(?:-->|-\.->)\s*', line)
            for i in range(len(parts) - 1):
                left, right = parts[i], parts[i + 1]
                label = ""
                lm = re.match(r'^\|(.*?)\|\s*(.*)$', right)
                if lm:
                    label, right = lm.group(1), lm.group(2)
                a = eat_node(left.strip())
                b = eat_node(right.strip())
                if a and b:
                    edges.append({"from": a, "to": b,
                                  "label": [l for l in label.split("<br>") if l]})
            continue
        eat_node(line)

    for n in nodes.values():
        if n["type"] == "process" and any("（外部）" in l or "(外部)" in l for l in n["label"]):
            n["type"] = "external"
    return {"spec": SPEC_VERSION, "nodes": [nodes[i] for i in order], "edges": edges}


def load_spec(path):
    text = open(path, encoding="utf-8").read()
    if path.endswith(".json"):
        spec = json.loads(text)
        got = spec.get("spec", "")
        if not got.startswith("flowspec/"):
            raise SystemExit("错误：缺少 spec 字段（期望 %s）" % SPEC_VERSION)
        if got.split("/")[1].split(".")[0] != SPEC_VERSION.split("/")[1]:
            raise SystemExit("错误：flowspec 主版本不兼容：%s（本工具支持 %s）" % (got, SPEC_VERSION))
        for e in spec["edges"]:
            if isinstance(e.get("label"), str):
                e["label"] = [e["label"]] if e["label"] else []
            e.setdefault("label", [])
        for n in spec["nodes"]:
            if isinstance(n.get("label"), str):
                n["label"] = [n["label"]]
            n.setdefault("type", "process")
        return spec
    return parse_mermaid(text)


# ── 图分析层 ────────────────────────────────────────────────────────
class Graph:
    def __init__(self, spec, start=None):
        self.nodes = {n["id"]: dict(n) for n in spec["nodes"]}
        self.order = [n["id"] for n in spec["nodes"]]
        self.edges = [dict(e) for e in spec["edges"]]
        for nid in set(e["from"] for e in self.edges) | set(e["to"] for e in self.edges):
            if nid not in self.nodes:
                raise SystemExit("错误：边引用了未定义节点 %s" % nid)
        self.out = {i: [] for i in self.order}
        self.inn = {i: [] for i in self.order}
        for e in self.edges:
            self.out[e["from"]].append(e)
            self.inn[e["to"]].append(e)
        # 两阶段起点推断：先按声明序首节点标回边，再用 DAG 入度选正式起点
        self.start = start or self.order[0]
        self._mark_back_edges()
        self.dout = {i: [e for e in self.out[i] if not e["back"]] for i in self.order}
        self.dinn = {i: [e for e in self.inn[i] if not e["back"]] for i in self.order}
        if not start:
            cands = [i for i in self.order if not self.dinn[i]]
            cands.sort(key=lambda i: (0 if self.nodes[i]["type"] in ("process", "decision") else 1,
                                      self.order.index(i)))
            if cands and cands[0] != self.start:
                self.start = cands[0]
                for e in self.edges:
                    e["back"] = False
                self._mark_back_edges()
                self.dout = {i: [e for e in self.out[i] if not e["back"]] for i in self.order}
                self.dinn = {i: [e for e in self.inn[i] if not e["back"]] for i in self.order}
        self._desc_cache = {}

    def _mark_back_edges(self):
        state = {i: 0 for i in self.order}  # 0未访问 1栈上 2完成
        def dfs(u):
            state[u] = 1
            for e in self.out[u]:
                v = e["to"]
                if state[v] == 1:
                    e["back"] = True
                elif state[v] == 0:
                    e.setdefault("back", False)
                    dfs(v)
                else:
                    e.setdefault("back", False)
            state[u] = 2
        roots = [self.start] + [i for i in self.order if not self.inn[i] and i != self.start]
        for r in roots:
            if state[r] == 0:
                dfs(r)
        for i in self.order:
            if state[i] == 0:
                dfs(i)
        for e in self.edges:
            e.setdefault("back", False)

    def desc_count(self, nid):
        if nid in self._desc_cache:
            return self._desc_cache[nid]
        seen, stack = set(), [nid]
        while stack:
            u = stack.pop()
            for e in self.dout[u]:
                if e["to"] not in seen:
                    seen.add(e["to"])
                    stack.append(e["to"])
        self._desc_cache[nid] = len(seen)
        return len(seen)

    POS_LABELS = {"是", "有效", "通过", "成功", "完成", "已绑定", "已完善", "已实名",
                  "已登录", "已开通", "已完成", "满足", "允许", "yes", "ok", "pass"}
    NEG_WORDS = ("否", "不通过", "无效", "失效", "失败", "过期", "拒绝", "不满足", "no", "fail")

    @classmethod
    def label_score(cls, e):
        text = "".join(e.get("label", []))
        if not text:
            return 0
        if text.lower() in cls.POS_LABELS:
            return 2
        if text.startswith("未") or any(w in text.lower() for w in cls.NEG_WORDS):
            return -2
        return 0

    def spine(self):
        chain, cur, guard = [self.start], self.start, 0
        while guard < 1000:
            guard += 1
            outs = self.dout[cur]
            if not outs:
                break
            def rank(e):
                t = self.nodes[e["to"]]
                return (-Graph.label_score(e),
                        0 if t["type"] in ("process", "decision") else 1,
                        -len(self.dinn[e["to"]]),
                        -self.desc_count(e["to"]))
            outs = sorted(outs, key=rank)
            nxt = outs[0]["to"]
            if nxt in chain:
                break
            chain.append(nxt)
            cur = nxt
        return chain


# ── 布局层 ──────────────────────────────────────────────────────────
def layout(spec, start=None, style=None, force_spine=None, force_left=None):
    st = dict(DEFAULT_STYLE)
    if style:
        st.update(style)
    g = Graph(spec, start or (force_spine[0] if force_spine else None))
    if force_spine:
        for nid in force_spine:
            if nid not in g.nodes:
                raise SystemExit("错误：--spine 指定了不存在的节点 %s" % nid)
        for u, v in zip(force_spine, force_spine[1:]):
            if not any(e["to"] == v for e in g.dout[u]):
                raise SystemExit("错误：--spine 相邻节点 %s→%s 之间不存在前向边" % (u, v))
        spine = list(force_spine)
    else:
        spine = g.spine()
    sset = set(spine)
    spine_pairs = set(zip(spine, spine[1:]))

    force_left = set(force_left or [])
    for nid in force_left:
        if nid not in g.nodes:
            raise SystemExit("错误：--left 指定了不存在的节点 %s" % nid)
        if nid in sset:
            raise SystemExit("错误：--left 节点 %s 在主干上，不能放左列" % nid)
    lane_nodes, col = {}, {}
    left_chain = set()
    chains = []          # {anchor, chain[], merge, side}
    for sid in spine:
        for e in g.dout[sid]:
            if e["to"] in sset or e["to"] in col:
                continue
            side = "L" if e["to"] in force_left else "R"
            chain, cur = [], e["to"]
            while cur not in sset and cur not in col:
                chain.append(cur)
                col[cur] = side
                if side == "L":
                    left_chain.add(cur)
                nxt = [x for x in g.dout[cur]]
                if len(nxt) != 1:
                    cur = None
                    break
                cur = nxt[0]["to"]
            chains.append({"anchor": sid, "chain": chain, "side": side,
                           "merge": cur if (cur in sset) else None})
    left_nodes = []
    for nid in g.order:
        if nid in sset or nid in col:
            continue
        if not g.dinn[nid] and len(g.dout[nid]) == 1 and g.dout[nid][0]["to"] in sset:
            col[nid] = "L"
            left_nodes.append(nid)
    for nid in force_left:
        if nid not in left_chain:
            raise SystemExit("错误：--left 节点 %s 不是主干分支链节点" % nid)
    unplaced = [i for i in g.order if i not in sset and i not in col]
    warnings = []
    if unplaced:
        raise SystemExit("错误：节点 %s 不符合『单主干+右分支+回线』适用形态，"
                         "建议改用 mermaid 原生渲染。" % ",".join(unplaced))

    N = {}
    for nid in g.order:
        n = dict(g.nodes[nid])
        n["w"], n["h"] = node_size(n, st)
        N[nid] = n

    # ── 主干跳级边（首尾都在主干、非相邻、非回边的前向边）与左链汇入边收集 ──
    # 跳级边：decision 目标走右侧前向通道（LANE 外侧）T 形汇入；其余走左侧远端通道进左端口。
    # 左列分支链（--left）汇入边：同走左侧远端通道进目标左端口。
    # 通道按跨度升序由内向外分配；几何冲突由末端交叉检测兜底。
    sidx = {nid: i for i, nid in enumerate(spine)}
    skipR, skipL = [], []
    for e in g.edges:
        if (e["back"] or e["from"] not in sset or e["to"] not in sset
                or (e["from"], e["to"]) in spine_pairs):
            continue
        if sidx[e["from"]] >= sidx[e["to"]]:
            continue
        (skipR if g.nodes[e["to"]]["type"] == "decision" else skipL).append(e)
    skipR.sort(key=lambda e: sidx[e["to"]] - sidx[e["from"]])
    skipL.sort(key=lambda e: sidx[e["to"]] - sidx[e["from"]])
    lmerge = []
    for c in chains:
        if c["side"] == "L" and c["merge"] and c["chain"]:
            for e in g.dout[c["chain"][-1]]:
                if e["to"] == c["merge"]:
                    lmerge.append(e)
    lane_extra = 16 * max(0, len(skipL) + len(lmerge) - 1)

    # 列宽与 x
    def colw(ids):
        return max([N[i]["w"] for i in ids]) if ids else 0
    Lids = [i for i in col if col[i] == "L"]
    Lw = colw(Lids)
    Sw = colw(spine)
    Rids = [i for i in col if col[i] == "R"]
    Rw = colw(Rids)
    margin = 20
    Lx = margin + lane_extra + Lw / 2 if Lids else 0
    Sx = (margin + lane_extra + Lw + 70 + Sw / 2) if Lids else (margin + 60 + Sw / 2)
    Rx = Sx + Sw / 2 + 120 + Rw / 2 if Rids else Sx
    LANE = Rx + Rw / 2 + 42 if Rids else Sx + Sw / 2 + 42
    W = LANE + 118

    skip_lane = {}
    for k, e in enumerate(skipR):
        skip_lane[id(e)] = LANE + 26 + 18 * k
    # 左侧通道统一分配：目标越深（主干序越靠后）越靠外（x 越小），
    # 嵌套跨度时入线不会穿越内侧通道；交错跨度无解，由交叉检测兜底报告。
    left_users = [(e, "skip") for e in skipL] + [(e, "merge") for e in lmerge]
    left_users.sort(key=lambda t: -sidx[t[0]["to"]])
    lmerge_lane = {}
    for k, (e, kind) in enumerate(left_users):
        (skip_lane if kind == "skip" else lmerge_lane)[id(e)] = 12 + 16 * k
    if skipR:
        W = max(W, max(skip_lane[id(e)] for e in skipR) + 60)

    # 主干 y 初排
    def edge_gap(e):
        return 38 + 13 * max(0, len(e.get("label", [])))
    y = 0
    for i, sid in enumerate(spine):
        n = N[sid]
        if i == 0:
            y = margin + n["h"] / 2 + 4
        else:
            prev = N[spine[i - 1]]
            gap = 40
            for e in g.dout[spine[i - 1]]:
                if e["to"] == sid:
                    gap = edge_gap(e)
            y = prev["y"] + prev["h"] / 2 + gap + n["h"] / 2
        n["y"] = y

    # 右链排布 + 汇入约束（两遍收敛）
    for _ in range(2):
        for c in chains:
            ay = N[c["anchor"]]["y"]
            cy = ay
            for k, nid in enumerate(c["chain"]):
                n = N[nid]
                if k == 0:
                    n["y"] = ay
                else:
                    prev = N[c["chain"][k - 1]]
                    n["y"] = prev["y"] + prev["h"] / 2 + 46 + n["h"] / 2
                cy = n["y"] + n["h"] / 2
            if c["merge"]:
                t = N[c["merge"]]
                need = cy + (52 if t["type"] == "decision" else 26)
                min_top = need
                if t["y"] - t["h"] / 2 < min_top:
                    delta = min_top - (t["y"] - t["h"] / 2)
                    started = False
                    for sid in spine:
                        if sid == c["merge"]:
                            started = True
                        if started:
                            N[sid]["y"] += delta
    for nid in left_nodes:
        tgt = g.dout[nid][0]["to"]
        N[nid]["y"] = N[tgt]["y"]
    for nid in g.order:
        N[nid]["x"] = {"L": Lx, "R": Rx}.get(col.get(nid), Sx)

    H = max(n["y"] + n["h"] / 2 for n in N.values()) + margin + 10

    # ── 右端口预扫与分配：前向汇入走上侧(-9,-18...)，回边走下侧(+9,+18...)，单入口居中 ──
    plan = {}
    for e in g.edges:
        uses = None
        if e["back"]:
            uses = "back"
        elif col.get(e["from"]) == "R" and e["to"] in sset and N[e["to"]]["type"] != "decision":
            uses = "fwd"
        if uses:
            plan.setdefault(e["to"], {"fwd": [], "back": []})[uses].append(id(e))
    port_off = {}
    for nid, p in plan.items():
        if len(p["fwd"]) + len(p["back"]) == 1:
            only = (p["fwd"] + p["back"])[0]
            port_off[only] = 0
        else:
            for i, eid in enumerate(p["fwd"]):
                port_off[eid] = -9 * (i + 1)
            for i, eid in enumerate(p["back"]):
                port_off[eid] = 9 * (i + 1)
    routes = []  # {pts, label, lx, ly, anchor, arrow}
    chain_of = {}
    for c in chains:
        for k, nid in enumerate(c["chain"]):
            chain_of[nid] = (c, k)

    def add(pts, e, lx=None, ly=None, anchor="start", arrow=True):
        routes.append({"pts": pts, "label": wrap_label(e.get("label", []), 12),
                       "lx": lx, "ly": ly, "anchor": anchor, "arrow": arrow})

    for e in g.edges:
        a, b = N[e["from"]], N[e["to"]]
        if e["back"]:
            if col.get(e["from"]) == "L" and e["to"] in sset:
                # 左列节点回边：从节点顶部向上，左侧 T 形汇入目标顶部上方的主干线
                merge_y = b["y"] - b["h"] / 2 - 18
                pts = [(a["x"], a["y"] - a["h"] / 2), (a["x"], merge_y), (Sx, merge_y)]
                add(pts, e, lx=(a["x"] + Sx) / 2, ly=merge_y - 8, anchor="middle", arrow=False)
                continue
            sy = a["y"]
            ty = b["y"] + port_off.get(id(e), 0)
            if abs(sy - ty) < 1:
                # 同层回边：源与目标同高时，绕行段竖直落差为 0，路径退化成正水平线
                # 穿过节点（画面上表现为悬空横线）。给回线一个最小落差。
                ty = sy + 14
            pts = [(a["x"] + a["w"] / 2, sy), (LANE, sy), (LANE, ty), (b["x"] + b["w"] / 2, ty)]
            add(pts, e, lx=LANE - 8, ly=(sy + ty) / 2, anchor="end")
            continue
        if (e["from"], e["to"]) in spine_pairs:
            pts = [(Sx, a["y"] + a["h"] / 2), (Sx, b["y"] - b["h"] / 2)]
            add(pts, e, lx=Sx + 8, ly=(a["y"] + a["h"] / 2 + b["y"] - b["h"] / 2) / 2 + 4)
            continue
        if id(e) in skip_lane:
            lx0 = skip_lane[id(e)]
            lift = 8 + 13 * max(0, len(wrap_label(e.get("label", []), 12)) - 1)
            if b["type"] == "decision":
                merge_y = b["y"] - b["h"] / 2 - 18
                pts = [(a["x"] + a["w"] / 2, a["y"]), (lx0, a["y"]), (lx0, merge_y), (Sx, merge_y)]
                add(pts, e, lx=(a["x"] + a["w"] / 2 + lx0) / 2, ly=a["y"] - lift, anchor="middle", arrow=False)
            else:
                pts = [(a["x"] - a["w"] / 2, a["y"]), (lx0, a["y"]), (lx0, b["y"]), (b["x"] - b["w"] / 2, b["y"])]
                add(pts, e, lx=(a["x"] - a["w"] / 2 + lx0) / 2, ly=a["y"] - lift, anchor="middle")
            continue
        if id(e) in lmerge_lane:
            lx0 = lmerge_lane[id(e)]
            pts = [(a["x"] - a["w"] / 2, a["y"]), (lx0, a["y"]), (lx0, b["y"]), (b["x"] - b["w"] / 2, b["y"])]
            wl = wrap_label(e.get("label", []), 12)
            add(pts, e, lx=(lx0 + b["x"] - b["w"] / 2) / 2, ly=b["y"] - 8 - 13 * max(0, len(wl) - 1), anchor="middle")
            continue
        if e["from"] in sset and col.get(e["to"]) == "R":
            x1, x2 = a["x"] + a["w"] / 2, b["x"] - b["w"] / 2
            pts = [(x1, a["y"]), (x2, a["y"])]
            wl = wrap_label(e.get("label", []), 12)
            add(pts, e, lx=(x1 + x2) / 2, ly=a["y"] - 8 - 13 * max(0, len(wl) - 1), anchor="middle")
            continue
        if col.get(e["from"]) == "R" and col.get(e["to"]) == "R":
            pts = [(Rx, a["y"] + a["h"] / 2), (Rx, b["y"] - b["h"] / 2)]
            add(pts, e, lx=Rx + 8, ly=(a["y"] + a["h"] / 2 + b["y"] - b["h"] / 2) / 2 + 4)
            continue
        if col.get(e["from"]) == "R" and e["to"] in sset:
            if b["type"] == "decision":
                merge_y = b["y"] - b["h"] / 2 - 18
                pts = [(Rx, a["y"] + a["h"] / 2), (Rx, merge_y), (Sx, merge_y)]
                add(pts, e, lx=(Sx + Rx) / 2, ly=merge_y - 8, anchor="middle", arrow=False)
            else:
                ty = b["y"] + port_off.get(id(e), 0)
                pts = [(Rx, a["y"] + a["h"] / 2), (Rx, ty), (b["x"] + b["w"] / 2, ty)]
                add(pts, e, lx=Rx + 8, ly=(a["y"] + a["h"] / 2 + ty) / 2)
            continue
        if e["from"] in sset and col.get(e["to"]) == "L":
            x1, x2 = a["x"] - a["w"] / 2, b["x"] + b["w"] / 2
            pts = [(x1, a["y"]), (x2, a["y"])]
            wl = wrap_label(e.get("label", []), 12)
            add(pts, e, lx=(x1 + x2) / 2, ly=a["y"] - 8 - 13 * max(0, len(wl) - 1), anchor="middle")
            continue
        if col.get(e["from"]) == "L" and col.get(e["to"]) == "L":
            pts = [(Lx, a["y"] + a["h"] / 2), (Lx, b["y"] - b["h"] / 2)]
            add(pts, e, lx=Lx + 8, ly=(a["y"] + a["h"] / 2 + b["y"] - b["h"] / 2) / 2 + 4)
            continue
        if col.get(e["from"]) == "L":
            x1, x2 = a["x"] + a["w"] / 2, b["x"] - b["w"] / 2
            if x2 - x1 < 90:
                add([(x1, b["y"]), (x2, b["y"])], e, lx=a["x"], ly=a["y"] - a["h"] / 2 - 10 - 13 * max(0, len(e.get("label", [])) - 1), anchor="middle")
            else:
                add([(x1, b["y"]), (x2, b["y"])], e, lx=(x1 + x2) / 2, ly=b["y"] - 8, anchor="middle")
            continue
        warnings.append("边 %s→%s 使用了通用回退路由" % (e["from"], e["to"]))
        add([(a["x"], a["y"] + a["h"] / 2), (a["x"], b["y"] - b["h"] / 2)], e)

    # ── 质检：交叉 / 重叠 / 文字溢出（共享件） ──
    crossings = ortho_crossings(routes)
    boxes = [(nid, n["x"], n["y"], n["w"], n["h"]) for nid, n in N.items()]
    overlaps = box_overlaps(boxes)

    def metrics(n, j):
        fs = st["fs_node"] if (j == 0 or n["type"] == "decision") else st["fs_sub"]
        if n["type"] == "decision":
            d = abs(j - (len(n["label"]) - 1) / 2) * (fs + 4)
            avail = n["w"] * (1 - 2 * d / n["h"]) - 8
        else:
            avail = n["w"] - 10
        return fs, avail

    text_overflow = text_overflow_check(N, g.order, metrics)

    return {"nodes": N, "order": g.order, "routes": routes, "spine": spine,
            "W": round(W), "H": round(H), "style": st,
            "crossings": crossings, "overlaps": overlaps,
            "textOverflow": text_overflow, "warnings": warnings, "col": col}


# ── 渲染层 ──────────────────────────────────────────────────────────
def render_svg(lay, title=""):
    st = lay["style"]
    out = []
    out.append('<svg id="flowsvg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" '
               'width="%d" height="%d" data-flowspec="1" font-family="%s">'
               % (lay["W"], lay["H"], lay["W"], lay["H"], st["font_family"]))
    if st.get("bg"):
        out.append('<rect x="0" y="0" width="%d" height="%d" fill="%s"/>'
                   % (lay["W"], lay["H"], st["bg"]))
    out.append('<defs><marker id="arw" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" '
               'markerHeight="7" orient="auto-start-reverse">'
               '<path d="M0,0 L10,5 L0,10 z" fill="%s"/></marker></defs>' % st["edge_color"])
    for r in lay["routes"]:
        p = " ".join("%g,%g" % (x, y) for x, y in r["pts"])
        m = ' marker-end="url(#arw)"' if r["arrow"] else ""
        out.append('<polyline points="%s" fill="none" stroke="%s" stroke-width="1.5"%s/>'
                   % (p, st["edge_color"], m))
        if r["label"] and r["lx"] is not None:
            for i, t in enumerate(r["label"]):
                out.append('<text x="%g" y="%g" font-size="%d" fill="%s" text-anchor="%s">%s</text>'
                           % (r["lx"], r["ly"] + i * 13, st["fs_label"], st["label_color"], r["anchor"], esc(t)))
    for i, nid in enumerate(lay["order"]):
        n = lay["nodes"][nid]
        cx, cy, w, h, typ = n["x"], n["y"], n["w"], n["h"], n["type"]
        # 判断节点也可点击：点开要看的是判定规则（公式、阈值、边界），不是页面
        clickable = ' data-node="%s"' % nid
        out.append('<g class="node" id="flowchart-%s-%d"%s>' % (nid, i, clickable))
        if typ == "decision":
            sev = n.get("severity")
            fill_key = "fill_" + (sev or "decision")
            stroke_key = "stroke_" + (sev or "decision")
            sw = "1.8" if sev else "1.3"
            pts = "%g,%g %g,%g %g,%g %g,%g" % (cx, cy - h / 2, cx + w / 2, cy, cx, cy + h / 2, cx - w / 2, cy)
            out.append('<polygon points="%s" fill="%s" stroke="%s" stroke-width="%s"/>'
                       % (pts, st[fill_key], st[stroke_key], sw))
        else:
            dash = ' stroke-dasharray="5 4"' if typ == "external" else ""
            sw = "1.5" if typ == "process" else "1.3"
            sev = n.get("severity")
            fill_key = "fill_" + (sev or typ)
            stroke_key = "stroke_" + (sev or typ)
            if sev:
                sw = "2"
            out.append('<rect x="%g" y="%g" width="%g" height="%g" rx="4" fill="%s" stroke="%s" stroke-width="%s"%s/>'
                       % (cx - w / 2, cy - h / 2, w, h, st[fill_key], st[stroke_key], sw, dash))
            if typ == "backend":
                for dx in (cx - w / 2 + 6, cx + w / 2 - 6):
                    out.append('<line x1="%g" y1="%g" x2="%g" y2="%g" stroke="%s" stroke-width="1.3"/>'
                               % (dx, cy - h / 2, dx, cy + h / 2, st["stroke_backend"]))
        nl = len(n["label"])
        for j, t in enumerate(n["label"]):
            fs = st["fs_node"] if (j == 0 or typ == "decision") else st["fs_sub"]
            ty = cy + (j - (nl - 1) / 2) * (fs + 4) + fs * 0.35
            out.append('<text x="%g" y="%g" font-size="%d" fill="%s" text-anchor="middle">%s</text>'
                       % (cx, ty, fs, st["text_" + typ], esc(t)))
        out.append('</g>')
    out.append('<rect id="sel-ring" fill="%s" stroke="%s" stroke-width="2" '
               'stroke-dasharray="5 4" rx="6" visibility="hidden"/>'
               % (st["sel_ring_fill"], st["sel_ring_stroke"]))
    out.append('</svg>')
    return "\n".join(out)


# ── 入口 ────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="flow-canvas 多图类型排版引擎（flowchart 为正交流程图布局器）")
    ap.add_argument("input")
    ap.add_argument("-o", "--output")
    ap.add_argument("--html", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--title", default="")
    ap.add_argument("--type", default="flowchart",
                    choices=["flowchart", "arch", "er", "gantt", "seq", "blueprint"],
                    help="图类型：flowchart|arch|er|gantt|seq|blueprint（默认 flowchart）")
    ap.add_argument("--start", default=None)
    ap.add_argument("--style", default=None, help="样式覆盖 JSON 文件")
    ap.add_argument("--spine", default=None, help="逗号分隔节点 id，强制指定主干顺序（覆盖自动主干选择）")
    ap.add_argument("--left", default=None, help="逗号分隔节点 id，指定分支链放左列（经左侧远端通道汇入目标左端口）")
    args = ap.parse_args()

    if args.type != "flowchart":
        mod_name = {"arch": "layout_arch", "er": "layout_er",
                    "gantt": "layout_gantt", "seq": "layout_seq",
                    "blueprint": "layout_blueprint"}[args.type]
        try:
            mod = importlib.import_module(mod_name)
        except ImportError as exc:
            raise SystemExit("错误：布局模块 %s 不可用：%s" % (mod_name, exc))
        raise SystemExit(mod.main_cli(args))

    spec = load_spec(args.input)
    if not spec["nodes"]:
        raise SystemExit("错误：输入为空或未解析出任何节点（形态超限）")
    bad = []
    for n in spec["nodes"]:
        for l in n["label"]:
            bad += find_emoji(l)
    for e in spec["edges"]:
        for l in e.get("label", []):
            bad += find_emoji(l)
    if bad:
        raise SystemExit("错误：输入含 emoji 字符 %s（本工具产物禁用 emoji）" % bad)

    style = load_style(args.style)
    force = [s.strip() for s in args.spine.split(",") if s.strip()] if args.spine else None
    fleft = [s.strip() for s in args.left.split(",") if s.strip()] if args.left else None
    lay = layout(spec, args.start, style, force, fleft)

    report = build_report(len(spec["nodes"]), len(spec["edges"]), lay)
    report["spine"] = lay["spine"]
    if len(lay["crossings"]) > 3:
        report["warnings"].append("交叉过多：该图不适合正交模式，建议使用 mermaid 原生渲染")

    if args.check:
        print(json.dumps(report, ensure_ascii=False, indent=1))
        raise SystemExit(0 if is_clean(report) else 1)
    if not args.output:
        raise SystemExit("错误：需要 -o 指定输出文件（或使用 --check）")
    if not is_clean(report):
        raise SystemExit("错误：布局检查未通过（交叉 %d / 重叠 %d / 文字溢出 %d），"
                         "形态超限已拒绝产出——建议拆图、折叠细节或改用 mermaid 原生渲染。"
                         % (report["crossings"], report["overlaps"], report["textOverflow"]))
    content = render_html(render_svg(lay, args.title), args.title,
                          lay["style"]["font_family"]) if args.html else render_svg(lay, args.title)
    with open(args.output, "w", encoding="utf-8", newline="\n") as f:
        f.write(content)
    print(json.dumps(report, ensure_ascii=False))
    print("已生成 %s" % args.output)


if __name__ == "__main__":
    main()
