# P3.2 PRD 快照层：`src/core/prd/{wecom,snapshots,read}.ts`

日期：2026-11-06　分支：`main`　工作目录：`/Users/silas/flowers`

走查要回答的是「这份实现与**哪一版** PRD 对不上」。PRD 会改，链接不会变，
所以这一层做两件事：**读进来**（企业微信自己的 CLI）与**钉下来**（每次读到一行
快照，正文 + sha256）。没有 UI，没有缓存，只有三个纯服务函数。

```
src/core/prd/wecom.ts       URL 品类路由 + argv + 一次调用 + 中文失败 + 包装字段剥离
src/core/prd/snapshots.ts   prd_snapshots 的读写口 + hash 去重
src/core/prd/read.ts        readPrd()：取需求 → 读 → 快照 + 事件（一个事务）
src/db/migrations/0006_prd_snapshots.sql
tests/prd.test.ts           31 条用例（假 CLI，一次真请求都不发）
```

## 0. 与最初任务书的两处偏差（先说清楚，因为它们改了实现）

任务书给的接口来自**厂商 skill 文档**，本机装的 CLI 是 v1.3.4，两者不是同一个
版本。任务中途 owner 用真机核对了一遍，结论是：

| 任务书（skill 文档） | v1.3.4 实测 |
| --- | --- |
| `wecom-cli doc get_doc_content '{"url":…,"type":2}'` | **不存在**：`error: unrecognized subcommand 'get_doc_content'` |
| 第一次回 `task_id`，`task_done:false` → 轮询直到 `true` | **没有异步、没有 `task_id`、没有 `task_done`**，一次同步返回 |
| `errcode === 0` 是成功 | 同样，但**退出码永远是 0**，`errcode` 是唯一成功信号 |
| `/smartsheet/` 由本层回 `851002` 的兜底 | 它不是「文档」的一种，是另一个服务（`wecom-cli smartsheet …`） |

所以：

- 命令面改成实测形状 `wecom-cli doc contents get --docid <url> --content-type markdown`；
- **`pollMs` / `task_done` / `task_id` / 两段轮询整段删掉**，`readDoc` 的 opts 只剩
  `timeoutMs`（一次调用的预算，默认 60 秒）；
- 我还多花了约 20 分钟写了一版「先按 skill 文档发、`unrecognized subcommand` 时换
  一次形状」的回落。**已删除**——一个版本号里只有一套命令是真的，回落代码只会让人
  误以为轮询有用。
- 品类上，`smartpage`（智能文档 / 智能主页）与 `smartsheet`（智能表格）各自回
  `unsupported_kind`，消息**点名服务**；两者都不拉 CLI。

## 1. URL 路由表

分类规则：`new URL(url)` → `pathname` 的第一段（大小写不敏感）。host 不参与判定。

| 链接形状 | `kind` | 命令 | 结果 |
| --- | --- | --- | --- |
| `https://doc.weixin.qq.com/doc/<docid>` | `doc` | `doc contents get --docid <url> --content-type markdown` | 同步 JSON → Markdown |
| `https://doc.weixin.qq.com/sheet/<docid>` | `sheet` | 同上 | 同上（`sheet` 与 `doc` 共用一个读口） |
| `…/smartsheet/<id>`、`…/smartmatrix/<id>`（老写法） | `smartsheet` | **不调用** | `unsupported_kind`「智能表格（smartsheet）暂不支持读取」 |
| `…/smartpage/<id>` | `smartpage` | **不调用** | `unsupported_kind`「智能文档（smartpage）暂不支持读取」 |
| 其它 / 不是 http(s) / 空串 | `unknown` | **不调用** | `unknown_kind` + 点明期望的形状（`/doc/<docid>`、`/sheet/<docid>` 等） |

`smartmatrix` 归到 `smartsheet`：老链接里出现过这个写法，与智能表格是同一类东西
（同一句「暂不支持」）。

「路由先于命令」是构造上的：`classifyUrl` 跑完、`unsupported_kind` 直接返回，
`resolveCli()` 与 `execFile` 都还没被调用。用例钉的就是这一点——假 CLI 一次都没跑，
连它「被误调」时留下的 marker 文件都不存在。

## 2. 一次读的契约（没有轮询）

```ts
readDoc(url: string, opts?: { timeoutMs?: number }): Promise<DocRead>
```

1. 分类（上表）；`doc`/`sheet` 才继续。
2. 解析可执行文件：`FLOWERS_WECOM_CLI` env → `app_settings['wecom.cliPath']` →
   `wecom-cli`（PATH）。env 那一支**不读库**，用例因此不需要为「设置读失败」造库。
3. `execFile(bin, ['doc','contents','get','--docid',url,'--content-type','markdown'],
   { timeout: 60_000, maxBuffer: 32MB, encoding: 'utf8' })`。**argv，没有 shell**。
4. 进程没起来（ENOENT）→ 装什么；被 timeout 杀掉 → 等了多久；退出码非 0 → 分授权 /
   其它。
5. 解析 stdout：从第一个 `{` 切到最后一个 `}`（CLI 是 node 写的，前后可能带
   `[UNDICI-EHPA] Warning` 一类噪音行）。
6. **`errcode === 0` 才算成**；非 0 时 `errmsg` 原样 + errcode。
7. 正文：`content` → 否则 `file_path`（大文档 CLI 会把正文写进本地文件）→ 两路都过
   `stripWrappers()`。
8. 标题：优先响应里的 `name`（真机回的是 `📖 123云盘 · PRD导航中心（管理端）`），
   没有才退回第一个 Markdown 标题；都没有是 `null`。**不从正文猜**能用 `name` 的场合。

### 包装字段

v1.3.4 会在正文之外塞两段样板：

```
security_notice        <security_notice>…</security_notice>
extra_identity_context <extra_identity_context>…</extra_identity_context>（明说不要外传）
```

顶层这两个字段我们**根本不读**；`stripWrappers()` 另外把「被拼进 `content` 里」的
情形也剥掉（版本之间不保证只出现在顶层）。为什么要剥，不只是「不该进模型」：
样板一旦进正文，每次读到的 hash 都会因为样板而变化，`prd_snapshots` 的去重会永远
失效，快照历史也会被样板灌满。

## 3. 错误分类

| `code` | 触发 | 消息（节选） |
| --- | --- | --- |
| `unknown_kind` | 链接不是认得的品类 / 不是 URL | 这条链接读不了：「…」。只认企业微信文档链接：https://doc.weixin.qq.com/doc/<docid> 或 /sheet/<docid>；… |
| `unsupported_kind` | `/smartsheet/`（含 `smartmatrix`） | 智能表格（smartsheet）暂不支持读取 |
| `unsupported_kind` | `/smartpage/` | 智能文档（smartpage）暂不支持读取 |
| `bad_config` | 读 `wecom.cliPath` 时库错误 | 读不到设置「wecom.cliPath」：数据库错误（…） |
| `missing_binary` | `execFile` ENOENT | 没装 wecom-cli，先 npm i -g @wecom/cli |
| `unauthorized` | stderr/stdout 有 `Status: unauthorized`（或 `未授权`），或 `errcode ∈ {40001,40014,42001,41001,48001}` | wecom-cli 未授权，先在企业微信里扫码（wecom-cli auth init） |
| `cli_failed` | 退出码非 0 且不是上面两种 | wecom-cli 读取失败（退出码 9）：boom: 服务端 500 |
| `bad_output` | stdout 不是 JSON（或没有 errcode） | wecom-cli 的输出不是 JSON：… |
| `errcode` | `errcode !== 0` | 企业微信接口报错 851002：incompatible doc type |
| `empty_content` | `errcode === 0` 但正文为空（含只有空白） | wecom-cli 返回了空正文：… （可能是一份空文档，或正文只在另一个服务里） |
| `timeout` | 单次调用超过 `timeoutMs` | wecom-cli 读取超时：等了 60000 毫秒（60 秒）还没返回（…） |

所有消息里由 CLI 输出拼进来的片段都先过 `redact()`：`access_token=…`、
`Authorization: Bearer …`、`apiKey=…` 一律打码（用例钉着 `abc123def456789` 不出现在
message 里）。本模块从不读 `wecom-cli auth show`、不打印任何凭证。

## 4. 快照规则

表（迁移 `0006_prd_snapshots.sql`）：

```sql
prd_snapshots(id uuid pk, requirement_id uuid fk → requirements, url text,
              markdown text, hash text, fetched_at timestamptz default clock_timestamp())
index prd_snapshots_req (requirement_id, fetched_at)
```

- `hash` = `sha256(markdown)` 十六进制；只有它参与比对，`markdown` 是给人看的原件。
- **一条 fetch 一行，不做 upsert**：历史本身有用（「这行是照着哪一版写的」）。
- **同一条需求、连着两次同一个 hash = 空操作**：`saveSnapshot` 先看最新一行，
  相同就把那一行原样交回（`created:false`），不插新行。`A→B→A` 仍然留三行——
  「回到旧版」是一个值得记下来的事实。
- 顺序：`order by fetched_at desc, ctid desc limit 1`。`fetched_at` 用
  `clock_timestamp()` 而不是 `now()`：后者是**事务开始**时间，同一事务里两行会同值；
  `ctid` 是同一微秒内的兜底，保证「最后写的那一行」确定。
- `saveSnapshot(db, actor, {requirementId, url, markdown})`、`latestSnapshot(db, id)`、
  `snapshotById(db, id)`，另加 `snapshotCount(db, id)`（报告里的「PRD 改过 4 次」）。
  `actor` 不进快照行（快照是文档的事实，不是人的动作），只为调用点顺序一致。

`readPrd(db, actor, {requirementId})`：

1. id 不是 uuid → `bad_id`（不进 SQL，避免 22P02 变成 500）；
2. 需求不存在 → `not_found`；`prd_url` 空 → `missing_prd_url`（点明「PRD 链接」），
   且**不拉 CLI**；
3. `readDoc(url)` 失败原样上抛（code 与中文都不二次翻译）；
4. 一个事务里 `saveSnapshot` + `recordEvent('prd.fetched', {url, hash, chars})`。

事件**每次 fetch 都写**（包括去重那一次）：事件记「读了」，快照记「读到了什么」。
读三次、正文没变 → 三条事件、一行快照。

## 5. 假 CLI 夹具

`tests/prd.test.ts` 在 `beforeAll` 里往临时目录写一个 `fake-wecom-cli.cjs`
（`chmod 0o755`），`FLOWERS_WECOM_CLI` 指向它。它说 **v1.3.4 那套接口**：
从 argv 里取 `--docid`（或 `--json` 的 `docid`/`url`），按 URL 里的标记词分支，
每次调用先把 argv 追加进 `calls.log`。

| URL 里的标记 | 假 CLI 的行为 | 钉住什么 |
| --- | --- | --- |
| （无） | `{errcode:0, name:'📖 PRD · 分享链接改版', content:'# …', security_notice, extra_identity_context}` | 正常路径、`name` 作标题、包装字段不进正文 |
| `/smartsheet/`、`/smartpage/` | 写 `wrong-service-hit` 再回一份假成功 | 守卫在拼 argv 之前就拒（marker 不该出现） |
| `UNAUTH` | stderr `Status: unauthorized`，退出码 1 | 授权映射 |
| `AUTHERR` | `{errcode:40001, errmsg:'invalid credential: access_token=…'}`，**退出码 0** | 成功信号是 errcode；token 被打码 |
| `INCOMPAT` | `{errcode:851002, errmsg:'incompatible doc type'}`，退出码 0 | errmsg 原样 + errcode |
| `EMPTY` | `{errcode:0, content:'   '}` | 空正文是失败 |
| `BADOUT` | stdout `这不是 JSON`，退出码 0 | `bad_output` |
| `NOPE` | stderr `boom: 服务端 500`，退出码 9 | `cli_failed` + stderr 尾巴 |
| `HANG` | `setInterval(() => {}, 1000)` 永不返回 | 超时准时、不挂住用例 |
| `WRAP` | 正文里夹着两段包装标签 | 夹带的包装也剥掉，真正文一段不少 |
| `NONAME` | 没有 `name`，正文有 `# 只有正文标题` | 标题回落 |
| `FILEPATH` | `content:''` + 写到临时目录的 `file_path` | 大文档支路 |

「没有 shell」也是用这个夹具钉的：URL 用
`…/doc/$(touch${IFS}pwned)_OK`，断言假 CLI 收到的第 5 个 argv **逐字**等于这条 URL，
且工作目录里没有多出 `pwned`。

## 6. 测试（真实输出）

```
$ npx tsc --noEmit
（无输出）
```

```
$ npx vitest run tests/prd.test.ts
 ✓ readDoc：一条同步命令 > doc 链接：argv 就是 v1.3.4 的读口，一次调用拿到正文 425ms
 ✓ readDoc：一条同步命令 > sheet 与 doc 走同一个读口
 ✓ readDoc：一条同步命令 > 响应里没有 name 时退回第一个 Markdown 标题
 ✓ readDoc：一条同步命令 > 包装字段永远不进正文（顶层与夹带两种）
 ✓ readDoc：一条同步命令 > stripWrappers 是纯函数，可以单独钉
 ✓ readDoc：一条同步命令 > /smartsheet/ 与 /smartpage/ 在拼 argv 之前各自说明，假 CLI 一次都没跑
 ✓ readDoc：一条同步命令 > 不确定的链接给一句点名形状的中文
 ✓ readDoc：一条同步命令 > 分类器认得四类路径（含老写法 smartmatrix）
 ✓ readDoc：一条同步命令 > argvOf 里 url 只是一个参数值
 ✓ readDoc：错误分类 > 未授权（Status: unauthorized）→ 扫码那句话
 ✓ readDoc：错误分类 > errcode 40001（退出码 0）也归到未授权，且回显的 token 被打码
 ✓ readDoc：错误分类 > 别的 errcode → errmsg 原样 + errcode（证明成功信号是 errcode，不是退出码）
 ✓ readDoc：错误分类 > redact 把凭证形状打码
 ✓ readDoc：错误分类 > 没装 CLI → 装什么写清楚
 ✓ readDoc：错误分类 > 永远不回 → 计时结束后准时给超时（不挂住用例） 410ms
 ✓ readDoc：错误分类 > 退出码非 0 → 把 stderr 尾巴带上
 ✓ readDoc：错误分类 > stdout 不是 JSON → bad_output
 ✓ readDoc：错误分类 > 空正文是失败，不是空字符串的成功
 ✓ readDoc：错误分类 > 正文只在 file_path 里（大文档）也读得到
 ✓ readDoc：错误分类 > 链接里带 shell 语法也只是字面量（argv，没有 shell）
 ✓ readDoc：错误分类 > firstHeading 跳过代码块里的井号
 ✓ readDoc：错误分类 > parseResponse 容忍前后有噪音行
 ✓ readDoc：错误分类 > 设置里那一格只在没有环境变量时才读（env 优先，不碰库）
 ✓ 快照 > 同一份正文连着存两次：第二次是空操作，只有一行
 ✓ 快照 > 正文变了就多一行，latestSnapshot 取最新；A→B→A 留三行
 ✓ 快照 > latestSnapshot 按 fetched_at 取，不按插入顺序；没读过是 null
 ✓ 快照 > snapshotById 复现任意一版
 ✓ readPrd > prd_url 为空：一句点明缺什么的中文，不抛
 ✓ readPrd > 找不到需求 / 坏 id 都是失败而不是异常
 ✓ readPrd > 读到了：快照（包装字段已剥掉）+ 一条 prd.fetched 事件
 ✓ readPrd > 读失败（没授权）不落快照也不落事件
 Test Files  1 passed (1)
      Tests  31 passed (31)
```

全量：

```
$ npx vitest run
 Test Files  21 passed (21)
      Tests  541 passed | 1 skipped (542)
   Duration  20.51s
```

（510 → 541，+31 全是本文件的用例；`1 skipped` 是 P3.1 那条默认跳过的 ssh live smoke。）

跑完两条收尾（本轮已做）：

```bash
npm run seed -- --reset     # 结论：PASS —— 12 条需求铺满 10 列，3 条是当前成员现在要动手的
# provider.* 三行写回并校验（只打印 key / 长度 / sha256 前 12 位，从不打印值）
# provider.apiKey  len=51 sha256[:12]=5429414e5c65 match=true
# provider.baseUrl len=29 sha256[:12]=16c993d65f0e match=true
# provider.model   len=12 sha256[:12]=d416b3a370c3 match=true
```

## 7. 一次真实读（owner 提供的链接）

CLI 已授权，owner 给了 `https://doc.weixin.qq.com/doc/w3_AX8A6ga3ADQCNyTs0J3UtRZqM2kzu`，
用**本模块**（不是手敲命令）读了一次，只打印元信息，不落正文：

```
{ "ok": true, "kind": "doc",
  "title": "📖 123云盘 · PRD导航中心（管理端）",
  "chars": 8106,
  "hasSecurityNotice": false, "hasIdentityContext": false,
  "head": "## 🗂 模块总览\n\n**模块**<br>**当前版本**<br>…" }
```

标题来自响应里的 `name`（不是从正文猜的），8106 字，两段包装字段都已被剥掉。
这一次读没有进 `prd_snapshots`（脚本直接调 `readDoc`，没走 `readPrd`），库里没有
任何真实 PRD 正文。

## 8. 还不顺手的地方

1. **智能文档（smartpage）与智能表格（smartsheet）真的没做。** owner 说这个组织的
   PRD 两种形态都有（例如 `PRD · 套餐商品化与并存叠加规则` 是 smartpage），所以
   走查遇到这类需求会直接拿到 `unsupported_kind`。这是**如实上报的缺口**，不是
   静默跳过——但缺口是真的：需要 `wecom-cli smartpage pages get` 与
   `wecom-cli smartsheet …` 两个服务各自的适配，各自的正文形状还不一样。
2. **`name` 之外只能从 Markdown 猜标题。** 响应没有 `name` 时取第一个 `#`，可能
   抓到正文里的小节标题（不是文档标题）。真机一直有 `name`，所以先这样。
3. **`stripWrappers()` 认标签。** 如果哪天 CLI 换成「纯文本样板」或别的标签名，
   这段就失效。目前的判定依据是实测响应里的两个标签名。
4. **去重只在「最新一行」上比，且没有库级唯一约束。** 两个并发的 fetch 可能各插
   一行相同 hash 的行（无害：正文一样，`latestSnapshot` 取哪行都一样）。代价是
   「改过几次」可能多算一次。
5. **`errcode ∈ {40001,40014,42001,41001,48001}` 一律归到「去扫码」。** token 过期
   与从未授权在同一句话里，排障时要自己看日志。
6. **`file_path` 支路没有真实样本。** 单个文档上千行才可能触发，我只有假 CLI 的
   人造样本；真的触发时是「读到本地文件内容」，路径来自 CLI 自己。
7. **`wecom.cliPath` 设置没有 UI。** 只有 env 与 `app_settings` 这一格；改它要直接
   写库（或等下一个小版本）。换机器时这是唯一需要手改的东西。
8. **没有把快照接进走查提示词。** 这一版只到「读进来 + 钉下来」；「把哪一版 PRD
   喂给模型、模型怎么引用 hash」是下一阶段的事。
9. **正文上限没测。** `maxBuffer` 32MB、`stripWrappers` 之后仍可能有几 MB；走查
   阶段的截断口径（多长算太长）还没有定。
10. **`actors` 只有一个 `readDoc` 的真实用例。** 真机那次读是我手跑的，不是用例；
    用例全是假 CLI。真接口的字段是否稳定（`name` / `content` / `errcode`）靠这次
    实测 + owner 的核对，没有回归保护（除非将来加一个 skippable 的 live smoke）。

## 9. 复现

```bash
npx tsc --noEmit
npx vitest run tests/prd.test.ts
npx vitest run

# 跑完 vitest 之后（本轮已做）
npm run seed -- --reset
# provider.* 三行写回（值不打印，用 sha256 前 12 位核对）

# 换一台机器 / 换一个 CLI 版本
export FLOWERS_WECOM_CLI=/opt/homebrew/bin/wecom-cli
wecom-cli auth show          # Status: authorized 才读得动
```

`prd_snapshots` 已加进 `src/db/reset.ts` 的 truncate 列表——用例之间因此互不干扰，
代价是**跑测试会清掉真实的 PRD 快照**（与其余六张表一致，这条库本来就是
`flowers` 的开发库）。
