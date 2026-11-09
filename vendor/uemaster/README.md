# vendor/uemaster

UEmaster 里两个技能的运行时资产，原样搬进来，让 `flowers` 能**进程内**：

- 把一份 mermaid 流程图排成规范 SVG 并拿到检查报告（`flow-canvas/`）——不经过任何
  agent / CLI 对话；
- 把「流程图 + 页面片段」组装成一份三栏联动的走查 HTML（`flow-walkthrough/`）——
  产物就是 UEmaster 的产物，不是我们照着做的近似版。

## 来源

| 项 | 值 |
| --- | --- |
| upstream | https://github.com/SilasSolivagus/UEmaster |
| 路径 | `skills/flow-canvas/`、`skills/_theme/` |
| commit | `f080b15cdbcfcaa0b64af841df41dba330110b3c` |
| commit 日期 | 2026-11-04 13:33:36 +0800（"判断节点可点击 + 五类图共用主题底色"） |
| vendored | 2026-11-06 |
| 许可 | MIT（见 `flow-canvas/LICENSE`，Copyright (c) 2026 roxor） |

## 来源（二）：flow-walkthrough

| 项 | 值 |
| --- | --- |
| upstream | https://github.com/SilasSolivagus/UEmaster |
| 路径 | `skills/flow-walkthrough/`、`skills/_theme/` |
| commit | `f080b15cdbcfcaa0b64af841df41dba330110b3c`（与 flow-canvas 同一次同步） |
| commit 日期 | 2026-11-04 13:33:36 +0800 |
| vendored | 2026-11-06 |
| 许可 | MIT（见 `flow-walkthrough/LICENSE`，Copyright (c) 2026 roxor） |

文件：

```
flow-walkthrough/
  LICENSE
  contract/walkmap-v1.md       walkmap/1 契约（app 按它拼 JSON，也按它写提示词）
  references/page-guide.md     页面片段画法（wt-* 词表、375/690、状态与弹窗写法）
  scripts/build.py             入口：walkmap.json + 片段 → 单文件三栏 HTML
  scripts/selftest.py          上游自测脚本，不参与运行时
  templates/walkthrough.html   构建器的骨架模板（**必需**，见下）
_theme/default.walkmap.json    构建器的默认 css_vars（与 flow-canvas 共用 _theme/）
```

### 两个「不看代码就会漏」的依赖

**`templates/walkthrough.html`** —— `build.py` 第 26 行把模板算成
`<scripts 的上一级>/templates/walkthrough.html`，**读不到就 `FileNotFoundError`**。
第 57 行的 `_theme` 更阴：它按 `__file__` 往上三层拼 `_theme/default.walkmap.json`，
文件不在就静默退回脚本内置的默认颜色（`theme_vars` 里 `os.path.exists` 为假就走
`base = {}`）。所以这两个目录**必须保持上游的相对关系**：

```
vendor/uemaster/flow-walkthrough/scripts/build.py   →  …/flow-walkthrough/templates/
                                                    →  vendor/uemaster/_theme/
```

`vendor/uemaster/_theme/` 是 flow-canvas 那次就带进来的，`default.walkmap.json` 也在
里面——这也是为什么两个技能能共用一份主题目录。把 `flow-walkthrough` 挪到别处（比如
`vendor/flow-walkthrough/`）会同时丢掉模板（硬错）和主题（静默错）。

**验证方式**（P2.11 的证明）：同一份 walkmap 分别用 vendored 与上游原件跑一遍，
产物**逐字节相同**：

```
cp -r /tmp/uem/skills/flow-walkthrough/examples /tmp/wm && \
python3 vendor/uemaster/flow-walkthrough/scripts/build.py /tmp/wm/walkmap.json -o /tmp/a.html && \
python3 /tmp/uem/skills/flow-walkthrough/scripts/build.py /tmp/wm/walkmap.json -o /tmp/b.html && \
cmp /tmp/a.html /tmp/b.html && echo 一致
```

（`tests/walkmap.test.ts` 把这条做成了用例，含报告 JSON 的比对。）

## 我们改了什么

**两处（2026-11-08 一处，2026-11-09 一处）。** 其余部分与上游逐字节一致，可直接
`diff -r` 比对（`flow-walkthrough` 因为下面两处补丁而不同；`flow-canvas` 与 `_theme`
仍然一模一样）：

```
diff -r vendor/uemaster/flow-canvas/scripts /tmp/uem/skills/flow-canvas/scripts
diff -r vendor/uemaster/_theme /tmp/uem/skills/_theme
diff -r vendor/uemaster/flow-walkthrough/scripts /tmp/uem/skills/flow-walkthrough/scripts
diff -r vendor/uemaster/flow-walkthrough/templates /tmp/uem/skills/flow-walkthrough/templates
```

### 本地补丁：全屏时撤掉中栏与右栏

文件：`flow-walkthrough/templates/walkthrough.html`，紧跟 `.flow-panel.fs` 那条规则后面：

```css
.flow-panel.fs ~ .stage, .flow-panel.fs ~ .anno-panel { display: none; }
```

为什么：`.flow-panel.fs` 是 `position: fixed; inset: 0`，只盖住视口内的那一片；中栏
`.stage` 与右栏 `.anno-panel` 照旧参与布局（窄视口那条 media query 还把它们的 `position`
改回 `static`），于是点「全屏」之后画布左下角会露出一条手机框的边。整块补丁（含上面那段
中文注释）以 `本地补丁（2026-11-08，非上游）` 开头，`tests/walkmap.test.ts` 的字节比对
靠这两个锚点把它剥掉再比——**补丁变多或变样，那条用例就会红**。

### 本地补丁二：后端流程（时序图）那一格（2026-11-09）

两个文件、三段，都以 `本地补丁（2026-11-09，非上游）` 开头（`build.py` 那一段是括号
里的注释行，没有结束标记；模板里的两段以 `本地补丁结束（2026-11-09）` 结尾）：

1. `flow-walkthrough/templates/walkthrough.html` 的 CSS 段：`.frame-seq` 与 `.seq-*`
   （时序图 SVG 的样式，颜色走模板的 CSS 变量，深色模式跟着走）；
2. 同一文件 `.stage` 里多一个容器 `<div class="frame-seq">__PAGES_SEQ__</div>`；
3. `flow-walkthrough/scripts/build.py` 的 `html = (...)` 链里多一行
   `.replace("__PAGES_SEQ__", page_divs("sequence"))`。

为什么：纯后端需求（`PAN-815`「权益发放新增回调机制」那一类）的节点没有页面，中栏原本
无内容，`assembleWalkmap` 把它们挂到空页面上、整份材料被 `validateWalkmap` 拒收。owner
的裁定是「没有页面的节点不再强行挂页面，改成挂后端流程区块，页面原型那一栏改放一张
时序图」。上游只有 `phone` / `wide` 两种 frame，`page_divs` 会**静默**丢掉第三种——静默丢
在这里是最坏的失败方式（节点点开一片白），所以给它第三种 frame 和一个自己的容器。JS 一个
字没改：`setViewByNode` 按 frame 收起两格，`frame=sequence` 时两格都收起，剩下的正好是
这一格里的 `.page.active`。

升级时怎么办：整目录覆盖之后，把这一条规则（连注释）重新贴回同一位置，然后跑
`npx vitest run tests/walkmap.test.ts`。不要为了省这一步去改那条用例——它是唯一会
告诉你「上游的模板长什么样、我们差了哪一行」的东西。

（2026-11-09 的补丁同样按这句办：三段按原文贴回 `#frame-wide` 之后、
`page_divs("wide")` 之后、`.page.active` 之后；字节比对里的剥除表也要跟着加。
`tests/walkmap.test.ts` 的 `LOCAL_PATCHES` 就是那张表。）

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

- `examples/` —— 演示用输入，不是运行时资产。它被**用**在测试里（`tests/walkmap.test.ts`
  从 `/tmp/uem/skills/flow-walkthrough/examples` 读 pet-boarding 样本做字节比对；
  本机没有那个克隆时那两条用例跳过，不失败——「样本不在」与「我们对不上」是两件事）
- `agents/` —— UEmaster 自己的 agent 定义，与排版无关
- 其余图类型的 `contract/*.md`（`archspec-*`、`erspec-*`、`ganttspec-*`、`seqspec-*`、
  `blueprintspec-*`）—— 没有脚本在运行时读取它们。脚本里只有注释与一条 `SystemExit`
  文案提到路径。将来真要接甘特图，再单独把 `ganttspec-v1.md` 搬过来即可，脚本不用动。
