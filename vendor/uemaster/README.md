# vendor/uemaster

UEmaster 里 `flow-canvas` 技能的排版引擎，原样搬进来，让 `flowers` 能**进程内**把一份
mermaid 流程图排成规范 SVG 并拿到检查报告（不经过任何 agent / CLI 对话）。

## 来源

| 项 | 值 |
| --- | --- |
| upstream | https://github.com/SilasSolivagus/UEmaster |
| 路径 | `skills/flow-canvas/`、`skills/_theme/` |
| commit | `f080b15cdbcfcaa0b64af841df41dba330110b3c` |
| commit 日期 | 2026-11-04 13:33:36 +0800（"判断节点可点击 + 五类图共用主题底色"） |
| vendored | 2026-11-06 |
| 许可 | MIT（见 `flow-canvas/LICENSE`，Copyright (c) 2026 roxor） |

## 我们改了什么

**没有改。** `flow-canvas/scripts/*.py` 与 `_theme/*` 与上游逐字节一致，可直接
`diff -r` 比对：

```
diff -r vendor/uemaster/flow-canvas/scripts /tmp/uem/skills/flow-canvas/scripts
diff -r vendor/uemaster/_theme /tmp/uem/skills/_theme
```

升级方式就是整目录覆盖，不要就地打补丁——补丁会让下一次同步变成人工合并。

## 文件

```
flow-canvas/
  LICENSE
  contract/flowspec-v1.md     流程图中间格式与 SVG 结构契约（app 读它来拼 prompt）
  scripts/
    flowlayout.py             入口：解析 mermaid → 布局 → 写 SVG / 打 JSON 报告
    flowcommon.py             共用：文本量算、折行、检查报告、主题读取
    layout_arch.py            架构图（--type arch）
    layout_blueprint.py       蓝图（--type blueprint）
    layout_er.py              ER 图（--type er）
    layout_gantt.py           甘特图（--type gantt）
    layout_seq.py             时序图（--type seq）
    selftest*.py              上游自测脚本，不参与运行时（见下）
_theme/                       可选样式覆盖，见下
```

## 为什么带了两个"多余"的东西

**`contract/flowspec-v1.md`** —— 没有任何脚本在运行时读它（`grep -rn "contract/"
scripts/` 的命中全是注释与一条报错文案），但它是 prompt 的依据：告诉模型 mermaid 子集
怎么写才能被排版器接受。所以它属于运行时资产。

**`_theme/`** —— `flowcommon.py` 里 `THEME_DIR` 按脚本位置算：`__file__` 往上三层
（`scripts → flow-canvas → uemaster`）再拼 `_theme`，也就是 `vendor/uemaster/_theme`。
这是**相对路径**，不是包内资源，所以放错位置会静默丢掉主题（`load_style` 在文件不存在时
返回 `None`，不报错）。带上它，与本机上游渲染出的 SVG 逐字节相同；不带，颜色与字号会退回
脚本内置默认值。保留上游的目录关系是有意的。

`selftest*.py` 一并搬过来了（"整个 scripts/ 一起搬"），它们只有手工执行才会跑，
`flowlayout.py` 不 import 它们。

## 运行时要求

零依赖 Python 3（只用标准库）。本机 `/usr/bin/python3`。调用约定见
`src/core/uemaster/flow.ts`：

```
python3 vendor/uemaster/flow-canvas/scripts/flowlayout.py INPUT.mmd -o OUT.svg
python3 vendor/uemaster/flow-canvas/scripts/flowlayout.py INPUT.mmd --check
```

stdout = 一行紧凑 JSON 报告（`--check` 时是缩进 JSON）+ 一行 `已生成 OUT.svg`；
stderr = 错误文案；不合格形态以非零退出码结束。

## 没搬的东西

- `examples/` —— 演示用输入，不是运行时资产
- `agents/` —— UEmaster 自己的 agent 定义，与排版无关
- 其余图类型的 `contract/*.md`（`archspec-*`、`erspec-*`、`ganttspec-*`、`seqspec-*`、
  `blueprintspec-*`）—— 没有脚本在运行时读取它们。脚本里只有注释与一条 `SystemExit`
  文案提到路径。将来真要接甘特图，再单独把 `ganttspec-v1.md` 搬过来即可，脚本不用动。
