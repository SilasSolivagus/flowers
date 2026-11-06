# P2.9 · 把 flow-canvas 搬进来，图由引擎画，不由模型画

「生成器」那条路走到 P2.8 之后能用了：选一个 CLI、跑一次、产出一份 HTML。但它有个
不改就绕不过去的性质——**同一份需求跑两次，出来的图不一样**。这不是提示词没写好，
是这件事本来就不该由模型决定：一张流程图的"对不对"有客观判据（线有没有交叉、
框有没有重叠、字有没有溢出框），而模型每次都会给出一个不同的近似答案。

UEmaster 里有一个 `flow-canvas` 技能，把这件事做成了排版器：喂 mermaid，出规范 SVG，
外加一份**可判定的检查报告**（`crossings` / `overlaps` / `textOverflow` 三个计数）。
它是零依赖 Python 3，纯函数，跑一次几十毫秒。于是这一版把它整个搬进仓库，
在进程内直接调用：不需要 agent、不需要一次对话、不需要等模型，图和判据一次拿到。

本次提交：见本节末尾的验证清单；改动落在
`vendor/uemaster/*`（新增）、`src/core/uemaster/flow.ts`（新增）、
`tests/flow.test.ts` + `tests/stubs/flow-*.py`（新增）、本文。
`src/core` 既有服务、`src/db`、`app/`、`mcp/` 一行没动；没有新 npm 依赖。

---

## 1. 搬了什么

上游 `https://github.com/SilasSolivagus/UEmaster`，commit
`f080b15cdbcfcaa0b64af841df41dba330110b3c`（2026-11-04 13:33:36 +0800，
"判断节点可点击 + 五类图共用主题底色"），MIT，Copyright (c) 2026 roxor。
**脚本与主题逐字节未改**，`diff -r` 两边全等：

```
diff -r vendor/uemaster/flow-canvas/scripts /tmp/uem/skills/flow-canvas/scripts   → 相同
diff -r vendor/uemaster/_theme                  /tmp/uem/skills/_theme            → 相同
```

| 文件 | 字节 | 行 |
| --- | ---: | ---: |
| `flow-canvas/scripts/flowlayout.py` | 33,910 | 724 |
| `flow-canvas/scripts/flowcommon.py` | 22,794 | 532 |
| `flow-canvas/scripts/layout_blueprint.py` | 80,680 | 1,693 |
| `flow-canvas/scripts/layout_arch.py` | 62,080 | 1,287 |
| `flow-canvas/scripts/layout_er.py` | 21,691 | 558 |
| `flow-canvas/scripts/layout_gantt.py` | 14,749 | 363 |
| `flow-canvas/scripts/layout_seq.py` | 13,832 | 332 |
| `flow-canvas/scripts/selftest.py` | 7,776 | 160 |
| `flow-canvas/scripts/selftest_arch.py` | 18,949 | 303 |
| `flow-canvas/scripts/selftest_blueprint.py` | 22,714 | 414 |
| `flow-canvas/scripts/selftest_er.py` | 11,770 | 230 |
| `flow-canvas/scripts/selftest_gantt.py` | 6,907 | 124 |
| `flow-canvas/scripts/selftest_seq.py` | 6,276 | 142 |
| `flow-canvas/contract/flowspec-v1.md` | 3,060 | 50 |
| `flow-canvas/LICENSE` | 1,062 | — |
| `_theme/default.style.json` | 1,792 | — |
| `_theme/dark.style.json` | 1,844 | — |
| `_theme/default.walkmap.json` | 320 | — |
| `_theme/README.md` | 803 | — |
| `README.md`（我们写的） | 3,734 | 81 |

**合计 368 KB**，其中 `scripts/` 340 KB / 6,862 行。`.gitignore` 没有排除 `vendor/`
（`git check-ignore vendor/uemaster/flow-canvas/scripts/flowlayout.py` 无输出）。

两个"看上去多余"的文件夹，各有理由：

- **`contract/flowspec-v1.md`**。没有任何脚本在运行时读它——见下一节。但它是 prompt 的
  依据：模型必须知道 mermaid 的哪个子集能被排版器接受（`A["文本"]` 是 process、
  `A{"文本"}` 是 decision、`A[["文本"]]` 是 backend、`class I2,L external` …）。
  换句话说它是**运行时资产**，只是消费者是"拼 prompt 的那段代码"而不是 Python。
- **`_theme/`**。`flowcommon.py` 的 `THEME_DIR` 是按 `__file__` 往上三层再拼 `_theme`
  算出来的，落脚点是 `vendor/uemaster/_theme`，**不是** `flow-canvas/_theme`。
  `load_style()` 在文件不存在时静默返回 `None`，不报错——放错位置的结果就是"图能画，
  但颜色字号退回脚本内置默认值"，而且没人会立刻发现。保留上游的目录关系之后，
  vendored 渲染与本机上游渲染**逐字节相同**（`cmp` 验证过）。

### 有没有脚本在运行时读 `contract/`？

`grep -rn "contract/" scripts/` 六处命中，**全部不是运行时读取**：

```
layout_blueprint.py:5   """… 实现 blueprintspec/2 契约，见 contract/blueprintspec-v2.md。"""   ← 注释
layout_er.py:3          """ER 图布局模块。实现 erspec/2 契约，见 contract/erspec-v2.md。        ← 注释
layout_arch.py:3        """… 实现 archspec/4 契约，见 contract/archspec-v4.md。"""              ← 注释
layout_seq.py:3         """… 实现 seqspec/1 契约，见 contract/seqspec-v1.md。"""                 ← 注释
layout_seq.py:77        raise SystemExit("错误：%s（形态超限：seqspec/1 见 contract/…）")        ← 报错文案
layout_gantt.py:3       """… 实现 ganttspec/1 契约，见 contract/ganttspec-v1.md。"""             ← 注释
```

没有一处 `open()` 落在 `contract/` 上（`grep -rn "open("` 的命中只有输入 `.mmd`、
输出 `.svg`、`_theme/*.style.json` 与自测脚本的工作文件）。所以其余图类型的
`archspec-*` / `erspec-*` / `ganttspec-*` / `seqspec-*` / `blueprintspec-*` 一个都没搬：
缺它们不改变任何运行时行为，只影响"读注释时找不到对应文档"。将来真接甘特图，
再单搬 `ganttspec-v1.md` 即可，脚本不用动。

`examples/` 与 `agents/` 同理没搬——前者是演示输入，后者是 UEmaster 自己的 agent 定义。

### 为什么连 `selftest*.py` 也搬了

一句"整个 `scripts/` 一起搬"就够了：它们是上游的自测，只有手工执行才会跑，
`flowlayout.py` 不 import 它们。拆开搬的唯一后果是下次同步要做判断，
而判断就可能判断错。

---

## 2. `renderFlowchart` 的契约

```ts
export type FlowCheck = {
  ok: boolean;
  crossings: number; overlaps: number; textOverflow: number;
  warnings: string[];
  report: unknown;            // 原始 JSON，喂回模型用
  svg?: string;               // ok 时才有
  error?: string;             // 引擎报错 / 非零退出 / 超时 / 报告读不懂
};

export async function renderFlowchart(mermaid: string, options?: FlowOptions): Promise<FlowCheck>
```

`options` 是给测试与将来换脚本留的窄口子（`timeoutMs` / `scriptPath` / `python`），
不传就是 `renderFlowchart(mermaid)`，与约定的签名一致。

一次调用的全过程：

1. `mkdtemp(os.tmpdir()/flowers-flow-)` 造一个**一次性的工作目录**，`cwd` 也指向它。
   （脚本靠 `sys.path[0]` 找 `flowcommon`、靠 `__file__` 找 `_theme`，与 cwd 无关，
   所以把子进程放进临时目录是安全的，也是必要的——别让它有理由写进仓库。）
2. 写 `input.mmd`（UTF-8）。
3. `execFile('python3', [script, mmd, '-o', svgPath], { cwd, timeout, killSignal: 'SIGTERM' })`。
   **argv 数组，没有 shell**：喂进去的是用户写的 mermaid，里面可以有引号、`$()`、
   反引号；走 shell 就等于把那段文本交给 shell 再解释一遍。
4. `code !== 0` / 超时 / 起不来 / 报告读不懂 → `ok:false` + `error`。
5. 从 stdout 挖报告，读三个计数，读 SVG，`finally` 里 `rm -rf` 临时目录。

`ok` 的判据**只有一条**：报告读得懂，且三个计数全为 0。
`warnings` 非空但计数全 0 **仍然是 `ok:true`**——上游契约里"提醒"（主干推断、
通用回退路由）与"不合格"（交叉/重叠/溢出）是两种东西；把 warnings 也塞进 ok，
会让绝大多数本来能用的图变成红的。

### 路径按**模块**定位，不认 `cwd`

```ts
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const FLOW_SCRIPT = path.join(REPO_ROOT, 'vendor/uemaster/flow-canvas/scripts/flowlayout.py');
```

`src/core/uemaster/flow.ts` 往上三层就是仓库根，常量**在模块加载时算一次**，
之后的 `chdir` 影响不到它。这一条是照着 `store.ts` 的口径抄的：`attach.ts` 曾经把
`public/` 按 cwd 解析，结果 MCP server 被别人的客户端起在任意目录时，
"文件明明在仓库里"却永远报不存在。有一条用例专门 `process.chdir('/tmp')` 之后跑一遍
（macOS 的 `/tmp` 是指向 `/private/tmp` 的链接，所以断言写的是"确实换了目录"
而不是字面相等于 `/tmp`）。

### stdout 的两样东西

引擎往 stdout 上打两行：一行报告 JSON，外加一行人类看的 `已生成 out.svg`。
`--check` 时报告是**缩进**的、跨多行。所以既不能整段 `JSON.parse`，也不能只读第一行；
`reportIn()` 取第一个 `{` 到最后一个 `}` 之间的原文——对两种排版都成立，
而那行中文永远不含花括号。

---

## 3. 超时与错误的分类

超时默认 **20 秒**（`FLOW_TIMEOUT_MS`）。实测一份 5 节点图 126ms 端到端（含起 Python）；
20 秒是给"几百节点的图"留的余量，同时是**上限**：排版器在超大输入上会退化，
与其把 web 请求挂死，不如报一句"超时"让人改输入。`timeout` 由 Node 自己掐，
`killSignal: 'SIGTERM'`，`err.killed` + 信号名一起判定"是我们杀的"。

| 情形 | 判定 | `error` 文案 |
| --- | --- | --- |
| 逗号超时 | `err.killed && signal ∈ {SIGTERM, SIGKILL}` | `排版器超时（200ms 未结束，已终止）` |
| 起不来（没装 python3 / 脚本不存在，`errno` 是字符串） | `typeof err.code === 'string'` | `排版器起不来（ENOENT: spawn …）` |
| 引擎拒绝这份输入（非零退出） | `code !== 0` | stderr 尾部（最多 800 字），空则退到 stdout 尾部，再空则 `退出码 N` |
| 退出 0 但 stdout 里没有 JSON | `reportIn() === null` | `报告读不懂：<stdout 尾部 400 字>` |
| 报告在、计数非 0 | 三个计数不全是 0 | `布局不合格：交叉 N、重叠 N、文字溢出 N` |
| 报告说干净但没有 SVG 文件 | `readFile` 失败 | `报告说没问题，但没有产物：<fs 错误>` |
| 宿主侧失败（TMPDIR 不可写、磁盘满） | 外层 `catch` | 原始 `message` |

**没有一条路径会抛。** 四种失败在 `run()` 里被压成同一种形状
（`{code, signal, timedOut, stdout, stderr, spawnError}`），永远是 resolve；
外层再兜一次 `catch`，连 `mkdtemp` 失败都是 `ok:false`。调用方不该为了"画一张图"
写 `try/catch`——`ok` 就是那个 `if`。

`warnings` 永远是 `string[]`（报告里不是字符串的项被滤掉），`crossings` 等三个数
永远是有限数字（缺字段当 0，但缺字段时报告本身就没通过"读得懂"的检查，
不会出现"读到 0 就当合格"）。

---

## 4. 测试（8 条，跑的是真 Python）

命令：`npx vitest run tests/flow.test.ts --reporter=verbose`

```
 ✓ tests/flow.test.ts > vendored flow-canvas > 脚本在仓库里、相对模块定位（与 cwd 无关）
 ✓ tests/flow.test.ts > renderFlowchart > 5 节点 flowchart：ok、三个计数为 0、SVG 里有 <svg 与节点文案
 ✓ tests/flow.test.ts > renderFlowchart > 计数是从引擎报告里读出来的，不是我们自己猜的
 ✓ tests/flow.test.ts > renderFlowchart > 孤岛/不合格形态：ok=false、有 error、不抛
 ✓ tests/flow.test.ts > renderFlowchart > 超时：睡着的脚本被真的杀掉（夹具 script + 200ms），不是等它自己醒
 ✓ tests/flow.test.ts > renderFlowchart > warnings 非空但三个计数全 0 ⇒ 仍然 ok
 ✓ tests/flow.test.ts > renderFlowchart > 引擎起不来（脚本不存在）也不抛，报成 error
 ✓ tests/flow.test.ts > renderFlowchart > process.chdir("/tmp") 之后照样能用（模块相对定位）

 Test Files  1 passed (1)
      Tests  8 passed (8)
   Duration  1.05s
```

真实输出（直接 `tsx` 调模块跑一遍，用于本节的数字）：

```
ok=true crossings=0 overlaps=0 textOverflow=0 warnings=0 ms=126
report= {"nodes":5,"edges":4,"crossings":0,"crossing_points":[],"overlaps":0,
         "overlap_points":[],"textOverflow":0,"textOverflow_points":[],
         "warnings":[],"canvas":[630,353],"spine":["A","B","C","E"]}
svg bytes= 2442 has <svg= true
island ok=false error=错误：节点 X,Y 不符合『单主干+右分支+回线』适用形态，建议改用 mermaid 原生渲染。
timeout ok=false ms=205 error=排版器超时（200ms 未结束，已终止）
```

几点说明：

- **计数不是我们猜的**。有一条用例绕过 `renderFlowchart`，直接在测试里
  `execFile` 跑一次 `flowlayout.py --check` 拿原始 JSON，再逐字段与
  `renderFlowchart` 的返回值比对（三个计数、`warnings`、`canvas`、`spine`）。
  这条用例的价值在于：引擎换版本把字段改名了，它会红，而不是我们这边悄悄当 0。
- **"坏输入"选的是形态而不是语法**。实测 `this is not mermaid at all ###` 不会失败——
  引擎把它当成一个节点（`nodes:1, spine:["this"]`，退出 0）。语法错误在这个引擎里
  不构成错误，**形态不合法**才构成。所以夹具用的是孤岛（`X→Y` 与主干无关），
  引擎非零退出并在 stderr 说清原因，用例还断言了那句原文里的"单主干"。
- **超时用的是真夹具，不是改常量**。题目允许"把超时常量改成 1ms"，但那样证明的是
  "1ms 会超时"，证明不了"到点真的把子进程杀了"。这里用
  `tests/stubs/flow-sleep.py`（睡 30 秒，永不产出），传 `timeoutMs: 200`，断言
  ①`ok:false` ②`error` 含"超时"与"200ms" ③**整轮耗时 < 5s**——它要真睡满 30 秒，
  第三条就会红（实测整轮 205ms）。子进程被杀这件事，只有墙钟能证明。
- **`flow-warn.py`** 是另一个假夹具，只为钉住"warnings 非空但计数全 0 ⇒ ok"
  这条容易在重构里被顺手写反的判断。真引擎很难构造"干净的图里夹一条提醒"。
- 全量：`npx vitest run` → **13 个文件 / 380 条全绿**（本次新增 8 条，
  其余 372 条是既有用例）。`npx tsc --noEmit` 干净。跑完按约定
  `npm run seed -- --reset`。

---

## 5. 还是毛的

- **没有接到界面上。** 这一版只有"mermaid → 检查过的 SVG"这一个函数，没有 mermaid
  生成（那份工作要么模型写、要么规则拼），也没有路由、没有"图不合格就回喂模型重画"
  的循环。`report` 字段是给那个循环准备的输入，但循环本身没写。
- **mermaid 方言是个子集，而且是窄的。** 引擎只接"单主干 + 右分支 + 回线"这一种形态：
  两个互不相干的子图、多个入口、`subgraph`、`classDef` 全都不认（多数以非零退出结束）。
  这意味着 prompt 必须把 `contract/flowspec-v1.md` 里那段子集讲清楚，否则模型的
  正常输出会有一半被判不合格。这是**下一件事**要解决的，不是这个函数能解决的。
- **`ok:false` 的错误是给人看的，不是给模型看的。** 眼下 `error` 里是引擎原文
  （"不符合『单主干+右分支+回线』适用形态"），模型看懂了也未必知道该怎么改。
  真要闭环，得把几个失败模式翻译成"把 X 改成 Y"级别的指令。
- **20 秒是拍的。** 没有测过几百节点的真实上限；也没有并发压测——同时来 10 张图
  就是 10 个 Python 进程，各自 30MB 上下。走 MCP server 那种长驻进程时值得再看一眼。
- **没有对 `--html` 下手。** 引擎还能出可缩放 HTML（架构图那套），`--spine` /
  `--left` / `--style` 也都没暴露。等真需要手工干预主干顺序时再说。
- **`selftest*.py` 搬进来了但从没跑过。** 它们是上游的自测（会往临时目录写文件、
  比较像素级结果），在这里跑一遍能额外证明"搬对了"，但会拖慢 CI，且上游自己也没在
  CI 里跑。先记着。
