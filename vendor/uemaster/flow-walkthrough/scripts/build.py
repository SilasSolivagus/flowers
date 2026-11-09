#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""flow-walkthrough 构建器（零依赖，Python 标准库）。

输入 walkmap JSON（契约见 contract/walkmap-v1.md）：flow-canvas 产出的 SVG +
页面片段集合 + 节点到页面的映射与标注（可选：页面状态组 state_groups），
组装成单文件三栏联动 HTML。

用法：
  python3 build.py walkmap.json -o out.html
  python3 build.py walkmap.json --check          # 仅校验，输出报告 JSON
"""
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
import argparse
import json
import os
import re
import sys

SPEC = "walkmap/1"
HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.join(os.path.dirname(HERE), "templates", "walkthrough.html")

EMOJI_RANGES = [(0x1F000, 0x1FAFF), (0x2600, 0x27BF), (0x2B00, 0x2BFF),
                (0xFE0F, 0xFE0F), (0x2705, 0x2705), (0x274C, 0x274C)]


def find_emoji(text):
    return [ch for ch in text if any(a <= ord(ch) <= b for a, b in EMOJI_RANGES)]


LEGEND_COLORS = [
    ("#c0392b", "P0 缺口"),
    ("#d98324", "P1 缺口"),
    ("#8a8a8a", "P2 缺口"),
    ("#2f6fed", "评审新增"),
    ("#7b4fa8", "评审存疑"),
]


def legend_html(svg):
    """按 SVG 里实际出现的标记色生成图例；没有标记就不占位。"""
    low = svg.lower()
    items = []
    for color, label in LEGEND_COLORS:
        if color in low:
            items.append('<span class="lg"><i style="border-color:%s"></i>%s</span>' % (color, label))
    if not items:
        return ""
    return '<div class="fp-legend">%s</div>' % "".join(items)


THEME_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))), "_theme")
DEFAULT_THEME = os.path.join(THEME_DIR, "default.walkmap.json")


def theme_vars(override):
    """默认主题的 css_vars 打底，walkmap 里的同键覆盖。"""
    base = {}
    if os.path.exists(DEFAULT_THEME):
        try:
            with open(DEFAULT_THEME, encoding="utf-8") as f:
                base = json.load(f).get("css_vars", {}) or {}
        except Exception:
            base = {}
    base.update(override or {})
    return base


def svg_blocks(wm, svg_dark):
    """浅色 SVG 常显；有深色版本时叠加一份默认隐藏的，供页面内切换。"""
    light = '<div id="flow-svg-light" class="svg-slot">%s</div>' % wm["_svg"]
    if not svg_dark:
        return light
    dark = '<div id="flow-svg-dark" class="svg-slot" style="display:none">%s</div>' % svg_dark
    return light + dark


def main():
    ap = argparse.ArgumentParser(description="flow-walkthrough 构建器")
    ap.add_argument("walkmap")
    ap.add_argument("-o", "--output")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    base = os.path.dirname(os.path.abspath(args.walkmap))
    wm = json.loads(open(args.walkmap, encoding="utf-8").read())
    errors, warnings = [], []

    spec = wm.get("spec", "")
    if not spec.startswith("walkmap/"):
        errors.append("缺少 spec 字段（期望 %s）" % SPEC)
    elif spec.split("/")[1].split(".")[0] != SPEC.split("/")[1]:
        errors.append("walkmap 主版本不兼容：%s" % spec)

    svg_path = os.path.join(base, wm.get("svg", ""))
    svg = ""
    if not os.path.isfile(svg_path):
        errors.append("svg 文件不存在：%s" % wm.get("svg"))
    else:
        svg = open(svg_path, encoding="utf-8").read()
        wm["_svg"] = svg
        svg_dark = ""
        if wm.get("svg_dark"):
            dpath = os.path.join(base, wm["svg_dark"])
            if os.path.isfile(dpath):
                svg_dark = open(dpath, encoding="utf-8").read()
            else:
                warnings.append("svg_dark 文件不存在：%s" % wm["svg_dark"])
        if 'data-flowspec="1"' not in svg:
            errors.append("SVG 缺少 data-flowspec=\"1\" 契约标记（需要 flow-canvas flowspec/1 产物）")

    pages, page_frame = {}, {}
    for p in wm.get("pages", []):
        f = os.path.join(base, p["file"])
        if not os.path.isfile(f):
            errors.append("页面文件不存在：%s" % p["file"])
            continue
        pages[p["id"]] = open(f, encoding="utf-8").read()
        page_frame[p["id"]] = p.get("frame", "phone")

    nodes = wm.get("nodes", {})
    for nid, meta in nodes.items():
        if meta.get("page") not in pages:
            errors.append("节点 %s 引用了未定义页面 %s" % (nid, meta.get("page")))

    # 页面状态组：同一页面的多个状态互切（右侧「页面状态切换」）
    groups = wm.get("state_groups", {}) or {}
    state_owner = {}
    if not isinstance(groups, dict):
        errors.append("state_groups 必须是对象：{组id: {title, states:[...]}}")
        groups = {}
    for gid, g in groups.items():
        states = g.get("states") or []
        if len(states) < 2:
            errors.append("状态组 %s 只有 %d 个状态：单状态页面不建组、右侧不放按钮" % (gid, len(states)))
        seen_page = {}
        for st in states:
            sid, rep = st.get("id"), st.get("node")
            if not sid or not st.get("label"):
                errors.append("状态组 %s 的状态缺少 id 或 label" % gid)
                continue
            if rep not in nodes:
                errors.append("状态组 %s 的状态 %s 引用了未定义节点 %s" % (gid, sid, rep))
                continue
            key = "%s/%s" % (gid, sid)
            declared = nodes[rep].get("state")
            if declared and declared != key:
                errors.append("节点 %s 是状态 %s 的代表节点，但又声明了 state=%s" % (rep, key, declared))
            nodes[rep]["state"] = key
            state_owner[key] = rep
            pg = nodes[rep].get("page")
            if pg in seen_page:
                warnings.append("状态组 %s 的状态 %s 与 %s 使用同一页面 %s：页面无差异就不是真正的状态，建议合并"
                                % (gid, seen_page[pg], sid, pg))
            seen_page[pg] = sid
    for nid, meta in nodes.items():
        st = meta.get("state")
        if not st:
            continue
        if st not in state_owner:
            errors.append("节点 %s 的 state=%s 不在任何状态组里" % (nid, st))
        elif meta.get("page") != nodes[state_owner[st]].get("page"):
            warnings.append("节点 %s 声明状态 %s，但页面 %s 与该状态代表节点 %s 的页面不同"
                            % (nid, st, meta.get("page"), state_owner[st]))

    svg_nodes = set(re.findall(r'data-node="([\w-]+)"', svg))
    map_nodes = set(nodes.keys())
    for nid in sorted(svg_nodes - map_nodes):
        warnings.append("SVG 节点 %s 未配置映射（点击将无响应）" % nid)
    for nid in sorted(map_nodes - svg_nodes):
        warnings.append("映射中的节点 %s 在 SVG 里不存在" % nid)

    default = wm.get("default_node") or (sorted(map_nodes)[0] if map_nodes else "")
    if default and default not in nodes:
        errors.append("default_node %s 不在映射中" % default)

    report = {"pages": len(pages), "nodes": len(nodes), "svg_nodes": len(svg_nodes),
              "state_groups": len(groups), "errors": errors, "warnings": warnings}
    merged_pages = "".join(pages.values())
    bad_pages = find_emoji(merged_pages)
    if bad_pages:
        errors.append("页面片段含 emoji 字符 %s（构建器硬校验）" % bad_pages[:5])

    if args.check or errors:
        print(json.dumps(report, ensure_ascii=False, indent=1))
        sys.exit(1 if errors else 0)
    if not args.output:
        raise SystemExit("错误：需要 -o 指定输出文件（或使用 --check）")

    def page_divs(frame):
        out = []
        for pid, html in pages.items():
            if page_frame[pid] == frame:
                out.append('<div class="page" id="%s">\n%s\n</div>' % (pid, html))
        return "\n".join(out)

    css_vars = "".join("  %s: %s;\n" % (k, v) for k, v in theme_vars(wm.get("css_vars", {})).items())
    html = (open(TEMPLATE, encoding="utf-8").read()
            .replace("__TITLE__", wm.get("title", "流程走查"))
            .replace("__CSS_VARS__", css_vars)
            .replace("__LEGEND__", legend_html(svg))
            .replace("__SVG__", svg_blocks(wm, svg_dark))
            .replace("__PAGES_PHONE__", page_divs("phone"))
            .replace("__PAGES_WIDE__", page_divs("wide"))
            # 本地补丁（2026-11-09，非上游）：后端流程那一格（frame=sequence，时序图）。
            # 上游只有 phone / wide 两种 frame，page_divs 的过滤会把第三种静默丢掉——
            # 静默丢是这里最坏的失败方式（节点点开一片白），所以必须显式接上。
            .replace("__PAGES_SEQ__", page_divs("sequence"))
            .replace("__NODES_JSON__", json.dumps(nodes, ensure_ascii=False))
            .replace("__STATE_GROUPS_JSON__", json.dumps(groups, ensure_ascii=False))
            .replace("__PAGE_FRAME_JSON__", json.dumps(page_frame, ensure_ascii=False))
            .replace("__DEFAULT__", default))

    bad = find_emoji(html)
    if bad:
        raise SystemExit("错误：产物含 emoji 字符 %s" % bad[:5])
    with open(args.output, "w", encoding="utf-8", newline="\n") as f:
        f.write(html)
    print(json.dumps(report, ensure_ascii=False))
    print("已生成 %s" % args.output)


if __name__ == "__main__":
    main()
