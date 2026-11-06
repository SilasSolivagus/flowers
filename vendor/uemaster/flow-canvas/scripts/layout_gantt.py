#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""甘特图布局模块（layout_gantt）。实现 ganttspec/1 契约，见 contract/ganttspec-v1.md。"""
import math
import re
import sys
from datetime import datetime

from flowcommon import (
    COMMON_STYLE, text_width, esc, box_overlaps, text_overflow_check,
    svg_open, svg_close, svg_text,
    render_html as _render_html, common_argparse, common_main)

SPEC_VERSION = "ganttspec/1"
DATA_ATTR = 'data-ganttspec="1"'

STYLE = dict(COMMON_STYLE)
STYLE.update({
    "fs_axis": 10,
    "fs_title": 15,
    "fs_section": 11,
    "row_h": 28,
    "bar_h": 16,
    "axis_color": "#999999",
    "grid_color": "#e8e8e8",
    "band_color": "#f2f2f2",
    "band_text": "#666666",
    "fill_bar": "#d9d9d9",
    "fill_done": "#8f8f8f",
    "fill_active": "#b8b8b8",
    "fill_crit": "#e0e0e0",
    "stroke_crit": "#333333",
    "fill_milestone": "#555555",
})

MAX_TASKS = 40
MAX_WIDTH = 2000

DATE_FMT_RE = re.compile(r'^\s*dateFormat\s+(\S+)\s*$')
TITLE_RE = re.compile(r'^\s*title\s+(.*?)\s*$')
SECTION_RE = re.compile(r'^\s*section\s+(.*?)\s*$')
TASK_RE = re.compile(r'^(.*?)\s*:\s*(.*?)\s*$')
DUR_RE = re.compile(r'^(\d+)\s*([dwm])$')
AFTER_RE = re.compile(r'^after\s+(\S+)$')


def _parse_date(fmt, tok):
    try:
        if fmt == "YYYY-MM-DD":
            return datetime.strptime(tok, "%Y-%m-%d").date()
        return datetime.strptime(tok, "%H:%M").time()
    except ValueError:
        raise SystemExit("错误：日期 %s 不符合 dateFormat %s（形态超限，请改用 mermaid 原生渲染）" % (tok, fmt))


def parse_mermaid(src):
    fmt = None
    title = ""
    section = ""
    tasks = []
    ids = set()
    for raw in src.splitlines():
        line = raw.strip()
        if not line or line.startswith("%%"):
            continue
        m = DATE_FMT_RE.match(line)
        if m:
            fmt = m.group(1)
            if fmt not in ("YYYY-MM-DD", "HH:mm"):
                raise SystemExit("错误：dateFormat %s 不支持（形态超限，仅支持 YYYY-MM-DD / HH:mm）" % fmt)
            continue
        if line.startswith("gantt") or line.startswith("axisFormat"):
            continue
        m = TITLE_RE.match(line)
        if m:
            title = m.group(1)
            continue
        m = SECTION_RE.match(line)
        if m:
            section = m.group(1)
            continue
        m = TASK_RE.match(line)
        if m:
            name, spec = m.group(1).strip(), m.group(2)
            parts = [p.strip() for p in spec.split(",") if p.strip()]
            flags = set()
            while parts and parts[0] in ("crit", "done", "active", "milestone"):
                flags.add(parts.pop(0))
            if len(parts) != 3:
                raise SystemExit("错误：任务行「%s」语法不完整或含不支持字段（形态超限，v1 不支持 until 等）" % line)
            tid, start_tok, dur_tok = parts
            dm = DUR_RE.match(dur_tok)
            if not dm:
                raise SystemExit("错误：任务「%s」时长 %s 无法解析（形态超限，支持 Nd/Nw/Nm）" % (name, dur_tok))
            num = int(dm.group(1))
            unit = dm.group(2)
            if fmt == "HH:mm":
                if unit != "m":
                    raise SystemExit("错误：HH:mm 模式下时长单位必须为 m（形态超限）" % name)
                dur = float(num)
            else:
                dur = float(num) * {"d": 1, "w": 7, "m": 30}[unit]
            if "milestone" in flags:
                if dur != 0:
                    raise SystemExit("错误：里程碑「%s」时长必须为 0d（形态超限）" % name)
            if tid in ids:
                raise SystemExit("错误：任务 id %s 重复（形态超限）" % tid)
            ids.add(tid)
            tasks.append({"id": tid, "label": name, "section": section,
                          "crit": "crit" in flags, "done": "done" in flags,
                          "active": "active" in flags, "milestone": "milestone" in flags,
                          "start_tok": start_tok, "dur": dur})
            continue
        raise SystemExit("错误：无法识别的行「%s」（形态超限，请改用 mermaid 原生渲染）" % line)
    if fmt is None:
        raise SystemExit("错误：缺少 dateFormat（形态超限）")
    if len(tasks) > MAX_TASKS:
        raise SystemExit("错误：任务数 %d 超过上限 %d（形态超限）" % (len(tasks), MAX_TASKS))
    return {"spec": SPEC_VERSION, "title": title, "dateFormat": fmt,
            "nodes": tasks, "edges": []}


def load_spec(path):
    text = open(path, encoding="utf-8").read()
    return parse_mermaid(text)


def iter_labels(spec):
    if spec.get("title"):
        yield spec["title"]
    seen = set()
    for t in spec["nodes"]:
        yield t["label"]
        if t["section"] and t["section"] not in seen:
            seen.add(t["section"])
            yield t["section"]


def layout(spec, style=None, args=None):
    st = dict(STYLE)
    if style:
        st.update(style)
    fmt = spec["dateFormat"]
    tasks = [dict(t) for t in spec["nodes"]]
    by_id = {t["id"]: t for t in tasks}

    def to_val(d):
        return d.toordinal() if fmt == "YYYY-MM-DD" else d.hour * 60 + d.minute

    def resolve_start(t):
        if "start_val" in t:
            return t["start_val"]
        tok = t["start_tok"]
        am = AFTER_RE.match(tok)
        if not am:
            t["start_val"] = to_val(_parse_date(fmt, tok))
            return t["start_val"]
        ref = by_id.get(am.group(1))
        if ref is None:
            raise SystemExit("错误：任务「%s」的 after 依赖 %s 不存在（形态超限）" % (t["label"], am.group(1)))
        if ref is t or "resolving" in ref:
            raise SystemExit("错误：after 依赖成环（形态超限）")
        ref["resolving"] = True
        try:
            t["start_val"] = resolve_start(ref) + ref["dur"]
        finally:
            ref.pop("resolving", None)
        return t["start_val"]

    for t in tasks:
        resolve_start(t)
    for t in tasks:
        t["end_val"] = t["start_val"] + (0 if t["milestone"] else t["dur"])
    t0 = min(t["start_val"] for t in tasks)
    t1 = max(t["end_val"] for t in tasks)
    span = max(t1 - t0, 1.0)

    margin = 20
    fs = st["fs_node"]
    row_h = st["row_h"]
    bar_h = st["bar_h"]
    label_w = max([text_width(t["label"], fs) for t in tasks] or [40]) + 24

    pxp = 720.0 / span
    axis_w = span * pxp
    if axis_w < 320:
        pxp = 320.0 / span
        axis_w = 320.0
    x0 = margin + label_w + 10

    def x_of(v):
        return x0 + (v - t0) * pxp

    if fmt == "HH:mm":
        steps = [1, 2, 5, 10, 15, 30, 60, 120, 180, 240, 480, 720, 1440]
        tick_label = "00:00"
    else:
        steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000]
        tick_label = "2026-02-02"
    # 刻度间距 ≥ 刻度标签宽度 + 16px（日期文案互不重叠）
    min_tick_sp = text_width(tick_label, st["fs_axis"]) + 16
    step = next((s for s in steps if s * pxp >= min_tick_sp), steps[-1])

    title_h = 28 if spec.get("title") else 0
    axis_y = margin + title_h + 12

    y = axis_y + 26
    cur_sec = None
    bands = []
    for t in tasks:
        if t["section"] != cur_sec:
            cur_sec = t["section"]
            if cur_sec:
                bands.append({"x": margin, "y": y - 2, "w": 0, "h": 20, "label": cur_sec})
            y += 22
        t["row_y"] = y
        y += row_h
    rows_bottom = y
    H = y + margin

    N = {}
    boxes = []
    bar_meta = {}
    for t in tasks:
        xs = x_of(t["start_val"])
        xe = x_of(t["end_val"])
        if t["milestone"]:
            w = 12.0
            xc = xs
            t["x"], t["y"], t["w"], t["h"] = xc, t["row_y"], w, w
            bar_meta[t["id"]] = {"x": xc - w / 2, "y": t["row_y"] - w / 2, "w": w, "h": w, "kind": "milestone"}
        else:
            w = max(xe - xs, 4.0)
            xc = xs + w / 2
            t["x"], t["y"], t["w"], t["h"] = xc, t["row_y"], w, bar_h
            bar_meta[t["id"]] = {"x": xs, "y": t["row_y"] - bar_h / 2, "w": w, "h": bar_h, "kind": "bar"}
        boxes.append((t["id"], t["x"], t["y"], t["w"], t["h"]))
        N[t["id"]] = {"id": t["id"], "label": [t["label"]], "x": t["x"], "y": t["y"],
                      "w": t["w"], "h": t["h"], "milestone": t["milestone"],
                      "done": t["done"], "active": t["active"], "crit": t["crit"]}

    # 条内/条外标签决定（初算 W 后可能加宽）
    W0 = x0 + axis_w + 40
    need_right = W0
    for t in tasks:
        tw = text_width(t["label"], fs)
        inside = (not t["milestone"]) and tw <= t["w"] - 8
        t["label_inside"] = inside
        if not inside:
            need_right = max(need_right, t["x"] + t["w"] / 2 + tw + 8)
    if need_right > MAX_WIDTH:
        raise SystemExit("错误：条外标签超出画布右缘上限（形态超限，请缩短任务名或改用 mermaid 原生渲染）")
    W = round(max(W0, need_right))
    for band in bands:
        band["w"] = W - margin * 2

    # 质检
    overlaps = box_overlaps(boxes, tol=1.0)
    overflow = []
    for t in tasks:
        need = text_width(t["label"], fs)
        if need > label_w - 20:
            overflow.append({"id": t["id"], "line": 0, "text": t["label"],
                             "need": round(need), "avail": round(label_w - 20)})

        def metrics(n, j, _t=t):
            fs2 = fs
            if _t["label_inside"]:
                return fs2, _t["w"] - 8
            return fs2, W - (_t["x"] + _t["w"] / 2) - 4
        overflow += text_overflow_check({t["id"]: N[t["id"]]}, [t["id"]], metrics)

    ticks = []
    k = math.ceil(t0 / step) * step
    while k <= t1:
        label = (datetime.fromordinal(int(k)).strftime("%Y-%m-%d") if fmt == "YYYY-MM-DD"
                 else "%02d:%02d" % (int(k) // 60, int(k) % 60))
        ticks.append({"x": x_of(k), "label": label})
        k += step
    # 防御检查：相邻刻度标签必须互不重叠（间距 ≥ 标签宽 + 4）
    if ticks:
        tick_w = text_width(ticks[0]["label"], st["fs_axis"])
        for i in range(1, len(ticks)):
            gap_px = ticks[i]["x"] - ticks[i - 1]["x"]
            if gap_px < tick_w + 4:
                overflow.append({"id": "tick-%d" % i, "line": 0, "text": ticks[i]["label"],
                                 "need": round(tick_w + 4), "avail": round(gap_px)})

    return {"nodes": N, "order": [t["id"] for t in tasks], "routes": [],
            "extra": {"title": spec.get("title", ""), "margin": margin,
                      "title_y": margin + 18, "axis": {"x0": x0, "x1": x0 + axis_w, "y": axis_y,
                                                      "rows_bottom": rows_bottom, "ticks": ticks},
                      "bands": bands, "bars": bar_meta, "label_x": x0 - 8},
            "W": int(W), "H": int(H), "style": st,
            "crossings": [], "overlaps": overlaps,
            "textOverflow": overflow, "warnings": []}


def render_svg(lay, title=""):
    st = lay["style"]
    ex = lay["extra"]
    out = svg_open(lay["W"], lay["H"], DATA_ATTR, st)
    if title or ex["title"]:
        out.append(svg_text(ex["margin"], ex["title_y"], st["fs_title"], st["text"],
                            "start", title or ex["title"]))
    axis = ex["axis"]
    out.append('<line x1="%g" y1="%g" x2="%g" y2="%g" stroke="%s" stroke-width="1"/>'
               % (axis["x0"], axis["y"], axis["x1"], axis["y"], st["axis_color"]))
    for tk in axis["ticks"]:
        out.append('<line x1="%g" y1="%g" x2="%g" y2="%g" stroke="%s" stroke-width="0.6"/>'
                   % (tk["x"], axis["y"], tk["x"], axis["rows_bottom"], st["grid_color"]))
        out.append('<line x1="%g" y1="%g" x2="%g" y2="%g" stroke="%s" stroke-width="1"/>'
                   % (tk["x"], axis["y"], tk["x"], axis["y"] + 4, st["axis_color"]))
        out.append(svg_text(tk["x"], axis["y"] + 15, st["fs_axis"], st["label_color"], "middle", tk["label"]))
    for band in ex["bands"]:
        out.append('<rect x="%g" y="%g" width="%g" height="%g" fill="%s"/>'
                   % (band["x"], band["y"], band["w"], band["h"], st["band_color"]))
        out.append(svg_text(band["x"] + 8, band["y"] + band["h"] / 2 + 4, st["fs_section"],
                            st["band_text"], "start", band["label"]))
    for i, nid in enumerate(lay["order"]):
        n = lay["nodes"][nid]
        meta = ex["bars"][nid]
        out.append('<g class="task" id="gantt-%s-%d" data-task="%s">' % (nid, i, nid))
        if meta["kind"] == "milestone":
            pts = "%g,%g %g,%g %g,%g %g,%g" % (meta["x"] + meta["w"] / 2, meta["y"],
                                               meta["x"] + meta["w"], meta["y"] + meta["h"] / 2,
                                               meta["x"] + meta["w"] / 2, meta["y"] + meta["h"],
                                               meta["x"], meta["y"] + meta["h"] / 2)
            out.append('<polygon points="%s" fill="%s" stroke="%s" stroke-width="1"/>'
                       % (pts, st["fill_milestone"], st["stroke"]))
        else:
            fill = st["fill_done"] if n.get("done") else (st["fill_active"] if n.get("active") else st["fill_bar"])
            sw = "1.6" if n.get("crit") else "1"
            out.append('<rect x="%g" y="%g" width="%g" height="%g" rx="2" fill="%s" stroke="%s" stroke-width="%s"/>'
                       % (meta["x"], meta["y"], meta["w"], meta["h"], fill, st["stroke"], sw))
            if n.get("crit"):
                out.append('<line x1="%g" y1="%g" x2="%g" y2="%g" stroke="%s" stroke-width="1"/>'
                           % (meta["x"], meta["y"], meta["x"] + meta["w"], meta["y"], st["stroke_crit"]))
        if n.get("label_inside"):
            out.append(svg_text(meta["x"] + meta["w"] / 2, meta["y"] + meta["h"] / 2 + 4,
                                st["fs_node"], st["text"], "middle", n["label"][0]))
        else:
            out.append(svg_text(meta["x"] + meta["w"] + 6, meta["y"] + meta["h"] / 2 + 4,
                                st["fs_node"], st["text"], "start", n["label"][0]))
        out.append('</g>')
    for nid in lay["order"]:
        n = lay["nodes"][nid]
        out.append(svg_text(ex["label_x"], n["y"] + 4, st["fs_node"], st["text"], "end", n["label"][0]))
    out += svg_close()
    return "\n".join(out)


def render_html(lay, title):
    return _render_html(render_svg(lay, title), title, lay["style"]["font_family"])


def main_cli(args):
    return common_main(args, sys.modules[__name__])


if __name__ == "__main__":
    ap = common_argparse("flow-canvas 甘特图布局器（ganttspec/1）")
    raise SystemExit(main_cli(ap.parse_args()))
