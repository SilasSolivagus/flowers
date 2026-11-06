"""报告里带 warnings、三个计数全 0 的夹具。

上游契约把「提醒」与「不合格」分成两件事：`warnings` 非空但 crossings/overlaps/
textOverflow 全 0 仍然是合格产物。这个夹具就为了把那条判断钉住——用真引擎很难构造
出干净的图里夹一条提醒，用假引擎一秒就能说清。
"""
import json
import sys

out = None
argv = sys.argv[1:]
if "-o" in argv:
    out = argv[argv.index("-o") + 1]

if out:
    with open(out, "w", encoding="utf-8") as f:
        f.write('<svg id="flowsvg" data-flowspec="1" viewBox="0 0 100 50"><text>ok</text></svg>\n')

print(json.dumps({
    "nodes": 1,
    "edges": 1,
    "crossings": 0,
    "overlaps": 0,
    "textOverflow": 0,
    "warnings": ["边 A→B 使用了通用回退路由"],
    "canvas": [100, 50],
    "spine": ["A"],
}, ensure_ascii=False))
print("已生成 %s" % (out or "-"))
