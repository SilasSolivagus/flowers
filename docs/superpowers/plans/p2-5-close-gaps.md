# P2.5 收口 · 三处缺口

三个独立缺口，三个 commit（`main` 上）：

| commit | 内容 |
| --- | --- |
| `082f692` | A：产物搬出 `public/`、sandbox 路由、抽屉的交回表单 |
| `9d5453a` | B：`npm run mcp` 不再依赖 `tsx`（编译到 `dist/`） |
| `68cd8db` | C：已上线卡片的走查从「一句话」变成一个状态 |

`src/core` 的服务（create / evaluate / review / schedule / bounce / terminal）一行没动。
改动只落在 `src/core/uemaster/*`、`src/core/read/*`、`app/*`、`mcp/*`、`tests/*`、
`scripts/mcp-smoke.ts`、`next.config.ts`、`package.json`、`tsconfig.mcp.json`、
`.gitignore`、`README.md`、`docs/mcp.md`。

---

## A. 交回材料：人走的那条路，和它带来的 XSS

### A1 产物搬出 `public/`

P2 之前，产物落在 `public/uemaster/`，由 Next 的静态根直接服务。那是一份**同源的第三方
HTML**：agent（或任何人）写进去的 `<script>` 会以本站的 origin 执行，`fetch('/', {credentials:
'include'})` 就是一条持久的储存型 XSS，而站点没有任何一层能说「不」。

改成：

- 存储根 `public/uemaster/` → `data/uemaster/`（`.gitignore` 里换成 `data/uemaster/`）。
  路径翻译收进 `src/core/uemaster/store.ts` 一处：`artifactFile()`（站内名 → 磁盘）与
  `artifactUrl()`（反向），`ARTIFACT_ROOT` 仍从**模块位置**往上三层推，不认 `process.cwd()`
  ——这条 P2 的裁决原样保留，MCP server 被客户端起在 `/tmp` 里也不影响它。
- 唯一的读出口是新的动态路由 `app/uemaster/[...path]/route.ts`，流式返回，固定三条头
  （逐字）：

  ```
  Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:
  Content-Type: text/html; charset=utf-8
  X-Content-Type-Options: nosniff
  ```

> **这一行 CSP 已被 R-P2-9 推翻**（`sandbox` → `sandbox allow-scripts`，并单独放开
> `script-src 'unsafe-inline'`）。下面「代价：脚本不执行」那一段是当时的事实、不是现在的：
> 现在的头与它的三条浏览器观察见文末 `## R-P2-9：放宽到 sandbox allow-scripts`。

- `attachArtifact` 的站内路径口径同时收紧：必须是 `/uemaster/` 开头。静态根既然已经不是
  产物的家，`/foo/bar.html` 这种名字在这个系统里不再指向任何可服务的文件——收下它只会
  造出一条「attach 说成功、点开 404」的链接。`artifact_missing` 的文案从
  `public/uemaster/…` 改成 `data/uemaster/…`：

  ```
  产物文件不存在：data/uemaster/PAN-9/evaluate.html —— 先把文件写到项目根目录下的 data/uemaster/PAN-9/evaluate.html，再把链接交回来
  ```

- 三份任务包（`packs.ts`）的「交付」行、走查包里的基线路径、`docs/mcp.md`、`README`、
  `scripts/mcp-smoke.ts` 的抠路径正则，全部跟着改。

**穿越在这里判了两次**，因为错一次就是把整个仓库读出去：

1. 路由逐段判：每段解一到两层百分号编码后，必须仍是「一个普通文件名」——空、`.`、`..`、
   含 `/`、含 `\`、含 NUL、绝对路径，一律 404。`/uemaster/PAN-7/..%2F..%2Fpackage.json`
   解完是**一个含斜杠的段**，`%252e%252e` 要解两层才现形，两条都在这里断掉。
2. `artifactFile` 再围一次：`path.resolve` 折完 `..` 之后回头看是否仍在 `data/uemaster`
   内，否则 `invalid_url`。路由把 `invalid_url` 翻成 404（对 HTTP 这一层它就是「没有这个
   资源」）。

### `sandbox` 挡住了什么、没挡住什么，以及它的代价

挡住：

- **读本站 cookie**：文档被放进**不透明源**，`document.cookie` 是空串；
- **同源 storage**：`localStorage` / `sessionStorage` / `indexedDB` 访问抛 `SecurityError`；
- **带凭据调本站接口**：从那个文档发出的请求是另一个源发起的匿名请求；本应用没有任何
  CORS 头，所以响应读不到（即使请求本身会到服务端）；
- **外部资源**：`default-src 'none'` 关掉除行内样式与 `data:`/`blob:` 图片之外的一切
  （产物本来就要求自足，不引 CDN）。`nosniff` 让浏览器别按内容猜类型。

**代价：脚本不执行。** 这一点与任务描述里的假设相反，必须写清楚：CSP 的 `sandbox` 指令
等价于 iframe 的 `sandbox` 属性，**不带 `allow-scripts` 时脚本被禁用**；而且
`default-src 'none'` 本身就把 `script-src` 一起关了（`script-src` 没有单独列出，回落到
`default-src`）。所以 `flow-walkthrough` 那种「点左边流程节点、右边切线框页」的交互在站内
是死的，双击本地文件打开仍然是活的。

要恢复交互，唯一的一行改动是 `sandbox allow-scripts`（不透明源仍然成立，脚本照样读不到
cookie）——但那是**扩大**放行面，属于产品裁决，不在这次「按给定头实现」的范围里。这里按
任务给的头逐字实现，并把后果记在下面「还糙的地方」第 1 条。

### A2 抽屉的交回表单

参考段三行，每行右侧现在固定有两个控件：`复制任务包`（P2 已有）与 `交回材料`（新）。
**有产物那一行也留着它们**：同一 stage 重做一版是常态（库里允许多行，读侧取最新）。

`交回材料` 打开一个 sheet，复用动作条那一套 `.sheet .box .h .b .fld .f .dfail`（没有新造
弹窗样式），里面只有两个字段与两个按钮，一句解释都没有：

- `链接` —— 一个文本框；
- `文件` —— `<input type="file" accept=".html,text/html">`；
- 底栏 `取消` / `交回材料`。

两条进法合成**一次提交**，服务端按「文件优先」决定交回哪一份（一份刚生成的产物比一个
手打的老链接新，猜错的代价只是再交一次）。落盘与校验：

- 扩展名只认 `.html` / `.htm`（`accept` 只是浏览器侧过滤，可以被绕过，真正的门在服务端）；
- 大小 ≤ 5 MB，空文件单独一句；
- 写到 `data/uemaster/<PAN-n>/<stage>-<毫秒时间戳>.html`——**原文件名只用来判扩展名**，
  绝不进路径（它是调用方给的：`../../evil.html` 在用例里过的就是这条）；
- 然后调 `attachArtifact`，所以「写文件」与「落库」仍是同一条写路径、同一套中文消息。

两处实现细节值得记：

1. **`<input type="url">` 换成了 `type="text"`。** 站内那一种合法形状是
   `/uemaster/PAN-7/evaluate.html`，而浏览器的 url 校验要求**带 scheme** 的绝对 URL：
   `type="url"` 会把「任务包让 agent 交回来的那种路径」直接拦在提交之外，而且原生气泡是
   一句英文的 "Please enter a URL"。这条是在真浏览器里点出来的（第一次提交毫无反应、
   也没有任何失败消息）。合法性归 `attachArtifact` 的 `invalid_url`，它说的是中文，并且
   知道站内路径也是合法的。
2. **`experimental.serverActions.bodySizeLimit` 抬到 `6mb`。** Next 默认 1 MB，我们自己的
   上限是 5 MB：不抬这一格，2 MB 的产物会在**到达领域层之前**被 Next 拒掉，界面于是拿不到
   「文件不能超过 5 MB」那句判定，而是撞一个通用错误。多留 1 MB 给 multipart 边界。

失败：`AppError` 的原文照登在 sheet 里（`.dfail`），sheet 不关——链接与文件是这界面上最贵
的输入，关掉等于把它们扔掉。成功：sheet 关闭，`revalidatePath('/')` 之后那一行自己变成
链接 + 日期（截图 `p2-5-drawer-attach.png`）。

split：`app/actions.ts` 的 `attachAction` 只留三件 Next 专有的东西（身份、失效、把
`AppError` 翻成一句话），「取字段 → 存文件 → attach」搬进 `app/attach-form.ts` 的
`attachFromForm`（普通函数，不在 `'use server'` 文件里）。理由是可测：`revalidatePath`
在请求上下文之外抛的是 Next 的内部 invariant，而这段翻译恰恰是最该被真 `FormData` +
真 `File` 跑一遍的部分。

### A3 证明

自动（`tests/uemaster-route.test.ts`，8 条）：

| 断言 | 结论 |
| --- | --- |
| 响应带三条头，且 CSP 与给定字符串**逐字相等** | 通过 |
| 文档内容原样出去（`<script>document.title=document.cookie</script>` 还在里面） | 通过 |
| `..`、`%2e%2e`、`%252e%252e`、`..%2F..%2F`、`/etc/passwd`、反斜杠、空段 —— 全 404 | 通过 |
| 目录不是文件 → 404；同名文件放在 `public/` 下不会被服务（只读 `data/`） | 通过 |
| `saveUploaded`：命名、扩展名、空文件、5 MB、stage/编号守卫 | 通过 |

自动（`tests/uemaster-upload.test.ts`，8 条）：真 `FormData` + 真 `File` 走完两条路——
文件分支落盘 + 落库 + 路由带 CSP 服务它、`../../evil.html` 不进路径、`.zip` 与 5 MB+ 各是
自己那句中文、链接分支、文件优先、两条都空、以及领域错误（需求不存在 / invalid_url /
artifact_missing）不被吞。

真浏览器（Chromium，dev server `http://127.0.0.1:3000`，这一节是**手工核对**，不是自动用例）：

1. 先在站点上按一次左轨折叠开关，落下真 cookie `flowers_rail=collapsed`。
2. **对照组**：同一份探针 HTML 放进 `public/xss-control.html`，浏览器读到的正文是
   `SCRIPT-RAN COOKIE=[flowers_rail=collapsed]` ——这就是「从静态根直接服务」时的储存型
   XSS，cookie 真的读到了。
3. **实验组**：同一份字节放到 `data/uemaster/PAN-7/xss-probe2.html`，从
   `/uemaster/PAN-7/xss-probe2.html` 打开，正文只有 `probe2`——`SCRIPT-RAN` 那一行根本没被
   插进 DOM，也没有 `COOKIE=[…]`。截图：`p2-5-csp-sandbox.png`。
4. 对照页用完立即删除（`public/` 现在没有这个文件）。

由此能说的：那份 payload 在这个站点上**没有执行**，所以它没有读到 cookie；而且它是从
`data/` 出去、带着 `sandbox` 头出去的。

**没有证到的那一半（精确）**：「脚本能跑、但读不到 cookie」这一态没有在浏览器里被观察到——
因为 `sandbox` 把脚本整个关掉了，payload 连跑的机会都没有。要观察它需要临时换成
`sandbox allow-scripts`（那一态的不透明源性质由 CSP 规范与上面的 header 断言支撑，不是
本轮的实测结果）。另外只测了 Chromium：Safari / Firefox 对 `sandbox` 指令与
`img-src data:` 的实现差异没有验。这两点是本轮 A3 的边界，不藏。

---

## B. `npm run mcp` 不再依赖 `tsx`

`tsx` 是 devDependency，`npm ci --omit=dev` 之后 `npm run mcp` 直接坏在「找不到 tsx」上。
改成编译产物：

```json
"mcp": "node dist/mcp/server.js",
"mcp:build": "tsc -p tsconfig.mcp.json",
```

`tsconfig.mcp.json`：`extends ./tsconfig.json`，只覆盖 `noEmit: false`、`outDir: "dist"`、
`rootDir: "."`、`incremental: false`、`plugins: []`，`include` 只收 `mcp` 与 `src`（`app` /
`tests` / `scripts` 不进产物）。`.gitignore` 加 `dist/`。

为什么这条路成立：领域层的相对导入全部**带扩展名**（`./packs.js`、`./errors.js`），编译后
它们在 `dist/` 里就是真实存在的文件；`rootDir` 是仓库根，于是 `dist/mcp/server.js` 引用的
`../src/core/...` 落地成 `dist/src/core/...`，Node 直接解析得到。**Node 的原生 type stripping
做不到这一点**：它不做扩展名改写、不做目录解析，`import './packs.js'` 会去找一个不存在的
`.js`。

验证（每条都真跑过）：

```
$ npm run mcp:build            # tsc -p tsconfig.mcp.json → 27 个 .js
$ (cd /tmp && ... | npm run mcp)
  {"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":true}},
   "serverInfo":{"name":"flowers","version":"1.0.0"}},"jsonrpc":"2.0","id":1}
  {"result":{"tools":[{"name":"uemaster_plan",...},{"name":"uemaster_attach",...},...]}}
```

**离线依赖的证明**：把 `node_modules/tsx` 整个移走之后再跑一次
`npm run mcp:build && npm run mcp`——`initialize` 正常、`tools/call` 正常返回领域错误
（`需求不存在`），全程没有碰 tsx（跑完把目录移回去）。

`npx tsx scripts/mcp-smoke.ts` 仍然全绿（三个工具 + 七条反例），且它现在从
`data/uemaster/...` 抠路径、从 `/tmp` 起 server，报错文案也是新的
`产物文件不存在：data/uemaster/PAN-1/review.html …`。

`README.md` 与 `docs/mcp.md` 都写明了：**生产（`npm ci --omit=dev`）先 `mcp:build` 再 `mcp`**，
以及客户端配置里的 `npx tsx …` 只在开发态成立（生产可写 `node /绝对路径/dist/mcp/server.js`）。

---

## C. 走查是一个状态，不是一句话

`live` 的卡以前写死一句「可发起走查」：它说的是「你可以动」，不是「这件事做没做」，
于是同一列里做过与没做过的卡长得一模一样。现在两个值：

- 没有 `stage='inspect'` 的产物 → `待走查`；
- 有一份 → `已走查 · MM-DD`（MM-DD 就是那份材料的日期）。

数据来自读模型，不是组件：`getBoard` 的那一条大 SQL 加了一个相关子查询取
`uemaster_artifacts` 里 `stage='inspect'` 的最新一行，卡片形状多一个
`inspectAtLabel`（已经折成 `MM-DD`，页面不再自己算日期）。子查询的排序口径与
`listArtifacts` **逐字一致**（`created_at desc, id desc`）——否则重做之后抽屉说一份、
看板说另一份的日期。

三条不变：`waitingOn` 仍是 `'none'`（走查不改状态、不欠人动作），`mine` 继续由
`waiting` 派生（所以 `live` 的卡不会被框），界面不加一句解释文案、不加新样式。
点卡片照旧进抽屉，而抽屉的走查那一行本来就摆着任务包与交回入口。

用例（`tests/read.test.ts` 新增 5 条）：两态；日期来源（把 `created_at` 钉成
`2026-01-02T00:00:00Z` 断言 `已走查 · 01-02`，不依赖运行时间）；重做取最新；别人的材料不算；
`stage='review'` 的材料不算。

真浏览器核对：`PAN-10`（已上线）原本 `待走查`，在抽屉里交回一份走查材料之后，同一张卡变成
`已走查 · 11-06`，抽屉那一行同时变成链接 + 日期（`p2-5-drawer-attach.png`）。

---

## 验证汇总

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 类型 | `npx tsc --noEmit` | 干净（无输出） |
| 用例 | `npx vitest run` | **308 passed**（287 原有 + 8 route + 8 upload + 5 board） |
| 生产构建 | `npm run build` | 通过；路由表里出现 `ƒ /uemaster/[...path]` |
| MCP 构建 | `npm run mcp:build && npm run mcp` | initialize / tools/list / tools/call 正常（tsx 移走也正常） |
| MCP 冒烟 | `npx tsx scripts/mcp-smoke.ts` | 三个工具 + 七条反例全绿，路径已是 `data/uemaster/…` |
| 演示数据 | `npm run seed -- --reset` | PASS（12 条铺满 10 列，3 条待动手） |

**构建是在隔离副本里跑的**：`rsync` 到 `/tmp/flowers-build`（排除 `node_modules` /
`.next` / `.git` / `data`），`node_modules` 用符号链接指回仓库，`.next` 是那份副本自己的
——`:3000` 的 dev server 全程没停，也没有和构建抢 `.next`。dev server 本身仍在
`127.0.0.1:3000`（`--webpack`）跑着。

---

## 还糙的地方（这一轮新增/变化）

1. **站内产物的脚本不执行。** `sandbox` 不带 `allow-scripts`：材料读得到、改不了本站，
   但 `flow-walkthrough` 的点击切换在站内是死的（双击本地文件仍然活）。要恢复就是
   `sandbox allow-scripts` 一行——那是一次放宽，得由产品裁决。
2. **「传文件」没有在真浏览器里按过一次。** 本会话的浏览器没有配置上传目录，`input[type=file]`
   只能用进程内的真 `FormData` + 真 `File` 验（`tests/uemaster-upload.test.ts`）。剩下没证的
   只有「浏览器把选中的文件塞进 FormData」这一步本身。
3. **交回失败会留下一份孤儿文件。** 顺序是「先写文件 → 再 attach」，attach 因为
   `not_found` / `invalid_url` 失败时，`data/uemaster/PAN-x/<stage>-<ts>.html` 已经落盘了。
   目录是 git 忽略的运行期目录，代价只是垃圾；要收干净得给文件加一次回滚（或先验需求再写）。
4. **路由对 `data/uemaster/` 里的任何文件都按 `text/html` 服务**（不看后缀）。这是刻意的：
   这一层只收 HTML，响应类型不该由磁盘上的名字决定。反过来说，往这个目录塞别的东西也会被
   当成 HTML 返回——只是带着 `sandbox` 与 `nosniff`。
5. **没有缓存头、没有清理。** 每次请求都读盘（`force-dynamic`）；产物文件永不回收，重做十次
   就有十份文件（库里同样十行，读侧只看最新）。
6. **`data/uemaster/` 不进 git**：材料在每台机器上是各自的，换机/克隆之后抽屉里的链接会是
   死链（与 R-P2-5「死链不追溯」同一条取舍）。
7. **`mcp:build` 是手动的。** 改了 `src/` 或 `mcp/` 之后不重编，`dist/` 就是旧的；没有 watch，
   也没有在 `npm run mcp` 前面自动 build（那会把每次启动变成一次编译）。
8. **走查仍然靠人**：`待走查` 说的是事实，但系统不会催、不会自动要包。看板只诚实地显示状态。
9. **`tsconfig.mcp.json` 只编 `mcp` + `src`**：`app/` 的类型由 `npx tsc --noEmit`（主配置）管，
   两边不是同一份 include，所以「主配置干净」不等于「mcp 配置干净」——本轮两个都跑过，
   但没有把这条关系写进 CI。

---

## R-P2-9：放宽到 `sandbox allow-scripts`

上一轮按给定头逐字实现，头是对的、实现是对的，**但那个头写错了规格**：`sandbox` 不带
`allow-scripts` 时脚本被禁用，`default-src 'none'` 又顺手把 `script-src` 关死，于是
`flow-walkthrough` 那种「点左边节点、右边切线框页」的走查页在站内是一张死图——材料读得到，
看不了。裁决改为：**脚本要活，同源仍然不给**。

### 头（唯一一处，`app/uemaster/[...path]/route.ts`）

```
Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:
```

另外两条没变：

```
Content-Type: text/html; charset=utf-8
X-Content-Type-Options: nosniff
```

为什么这仍然安全，一句话讲清：**`allow-same-origin` 不在这一行里**。`sandbox` 只要少了
它，文档就落在一个不透明源中——脚本能跑，但 `document.cookie` 抛、`localStorage` 抛、
同源请求带上不凭据也读不到响应；`default-src 'none'` 同时把 `connect-src` 关掉，请求在
CSP 这一层就被拒，连发都发不出去。危险的那一种组合是 `allow-scripts allow-same-origin`
**同时**出现（脚本能自己把沙箱拆掉），这里没有它。测试里加了一条负断言钉这件事：
`expect(CSP).not.toContain('allow-same-origin')`。

`tests/uemaster-route.test.ts` 的 `CSP` 常量改成上面那一行、断言逐字相等；上一版那条
「脚本被禁止」的口径（断言里只有 `sandbox`）整条作废——它编码的是一个已经被推翻的决定。

### 真浏览器里的三条观察（Chromium 156，`127.0.0.1:3000`，同一个会话、同一个 profile）

探针产物：`docs/superpowers/plans/p2-5-csp-probe.html`（一个两栏页面：左侧流程节点、右侧
正文，外加一块自报状态的 `<pre>`；用的时候拷到 `data/uemaster/PAN-7/csp-probe.html`
再打开，看完删掉——`data/` 是运行期目录，不进 git）。先在本站 origin 上把两个真 cookie 放好，再用 CDP 的
`Network.getAllCookies` 在**访问前 / 访问后**各取一次。

1. **脚本真的在跑。** `document.title` 从 `"CSP 探针"` 变成 `"SCRIPT-RAN"`；真的点一下
   左侧节点之后，正文从 `"这是页面 A 的内容。"` 变成
   `"这是页面 B 的内容——点一下换过来了，说明 onclick 真的在跑。"`，`aria-current` 从
   `A:true,B:false` 变成 `A:false,B:true`。截图：`p2-5-csp-scripts-on.png`。
2. **同一个脚本读不到本站 cookie。** 探针写进 DOM 的原文是
   `document.cookie THREW SecurityError: Failed to read the 'cookie' property from 'Document': The document is sandboxed and lacks the 'allow-same-origin' flag.`
   （不是空串，是抛错——不透明源连这个属性都不给）。旁边的 `localStorage.setItem` 同样抛：
   `SecurityError: Failed to read the 'localStorage' property from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag.`
   访问前后 cookie 一字不差：
   `["flowers_actor=%E5%90%95%E5%93%81 (domain=127.0.0.1 path=/ httpOnly=false)","flowers_rail=open (domain=127.0.0.1 path=/ httpOnly=false)"]`
   （前后两次 `JSON.stringify` 相等，`COOKIES_UNCHANGED: true`）。回到本站，站点仍然认出
   这个身份（正文里还是「吕品」），`document.cookie` 读回来还是
   `flowers_actor=%E5%90%95%E5%93%81; flowers_rail=open`。
3. **同源 fetch 出不去。** 探针里 `fetch('/', {credentials:'include'})` 的结果是
   `fetch(/) REJECTED TypeError: Failed to fetch`。原因不是「网络不通」而是 CSP 拒的，控制台
   原文：
   `error: Connecting to 'http://127.0.0.1:3000/' violates the following Content Security Policy directive: "default-src 'none'". Note that 'connect-src' was not explicitly set, so 'default-src' is used as a fallback. The action has been blocked.`
   并且 `Network.loadingFailed blocked=csp`——请求出现在事件流里，但没有发出去。
   `XMLHttpRequest` 同样：`xhr.onerror (status=0)` + `blocked=csp`。

### 这条口径**仍然不防**什么（同一次会话里逐条按过）

- **它自己的界面能撒谎。** 脚本活着就等于能任意改自己的 DOM：一个产物可以把整个页面画成
  「本站的登录框」或「操作成功」，用户看到的是产物自己说的。沙箱管的是「改不了本站」，
  不是「说的是真话」。
- **它能把整个标签页导航走。** `location.href = '…'` 从沙箱文档里执行成功，落到了
  `http://127.0.0.1:3000/?pwned=1`（`Page.navigatedWithinDocument`）。因为读不到 cookie，
  这不能带走凭据；但它能把人送到任意页面（包括站外钓鱼页），而地址栏是浏览器画的。
- **它照旧吃 CPU / 内存**：死循环、`while(1)`、几千个 DOM 节点，沙箱不管这些。
- 已经被挡住、这次复核过的：`window.open()` →
  `Blocked opening '…' in a new window … 'allow-popups' permission is not set`；
  `form.submit()` → `Blocked form submission … 'allow-forms' permission is not set`；
  XHR / fetch → `blocked=csp`；`document.cookie`、`localStorage` → `SecurityError`。
- **仍然只有 Chromium 验过。** Safari / Firefox 对 CSP `sandbox` 指令的落地程度没有测。

### 顺手修掉的一条：失败的交回不再留孤儿文件

顺序是「先写文件 → 再 attach」，而 attach 会在 `not_found`（编号打错，最常见）、
`invalid_stage`、`artifact_missing`、评估缺类型上说不行。失败之后那份
`data/uemaster/PAN-x/<stage>-<ts>.html` 没有任何一行指向它，永久躺在那儿。

改法在 `app/attach-form.ts`（`src/core` 一行没动）：把「这次自己写的那个路径」记住，
`attachArtifact` 抛错时先 `unlink` 文件、再 `rmdir` 父目录（非空时失败，吞掉），然后
**把原始错误原样抛出去**——用户该读到的是「需求不存在」，不是一句 ENOENT。三条边界：
只回收这一次写的文件（用户贴进来的链接一律不碰）；回收失败不掩盖原始错误；失败后的
磁盘状态与提交前一致（连空目录都不留）。

证明（`tests/uemaster-upload.test.ts` 新增两条）：

- `attach 说不的时候，刚写的文件被收回去：磁盘上不留孤儿`——用一个不存在的需求编号提交
  一份真 `File`，断言 `not_found` / `需求不存在`、库里 0 行，并且 `data/uemaster/` 递归
  列出来是 `[]`（提交前也是 `[]`）。
- `回收只碰这一次写的文件：同一目录里已有的产物还在`——先成功交一份 `inspect`，记下目录树
  （1 个文件），再往**同一个 PAN 目录**交一份注定失败的 `evaluate`，断言目录树与失败前
  **逐字相同**、库里仍只有成功那一条。

用例总数从 308 变成 **310**（+2），`npx tsc --noEmit` 干净。
