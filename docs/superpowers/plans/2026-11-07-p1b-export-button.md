# P1b 实施报告：待排期列头的「导出」

日期：2026-11-08
计划：`docs/superpowers/plans/2026-11-07-finish-gaps.md` §P1「导出按钮」
分支：`main` · 提交 `b52e3c6`（服务层）+ `bdc408d`（界面/动作）+ 本报告

## 结论（先看这段）

| 项目 | 结果 |
|---|---|
| 真实导出 | **成功**，2 行（= 当时待排期条数），9 列，见 §6 |
| 待排期为空 | 服务返回 `no_rows` 且**一次 CLI 都不调**；列头**不渲染按钮** |
| 导出的列序 | `编号/标题/类型/负责人/提出人/等什么/停留天数/PRD/版本`（真表 `fields list` 逐条核过） |
| 变异表 | 9 条变异，**9 条全红**（§5） |
| 全量测试 | `npx vitest run`：49 文件 / **1248 passed** / 1 skipped |
| 类型 | `npx tsc --noEmit` 干净 |
| 迁移行 | 未改动：只读导出，一条状态都没动（没有搬任何需求进 `queue`） |

## 1. 抽出来的模块：`src/core/export/queue.ts`

导出这件事原来只活在一个脚本里，于是「导出待排期」依赖一个人记得 `npx tsx scripts/export-queue.ts`。
现在它是 `src/core` 里的一个函数，脚本与列头按钮**调的是同一个**——列序与查询只有一份。

形状（`exportQueue(deps)`）：

```ts
type ExportDeps = {
  database?: Db;      // 默认 src/db/client 的 db：脚本与页面同一个答案
  run?: Runner;       // 默认 execFile；用例注入假的，永不碰二进制/网络
  bin?: string;       // 默认 FLOWERS_WECOM_CLI → app_settings → PATH 上的 wecom-cli
  now?: Date;         // 表名里的日期（`待排期需求 MM-DD`），用例钉得住
  timeoutMs?: number; // 默认 60s（DEFAULT_TIMEOUT_MS）
};

exportQueue(deps): Promise<
  | { ok: true; url: string; docid: string; rows: number; name: string }
  | { ok: false; code: ExportFailCode; message: string }
>
```

`ExportFailCode` = `no_rows | bad_config | missing_binary | unauthorized | cli_failed | timeout | bad_output | errcode`。
失败一律**是数据不是异常**（与 `prd/wecom.ts`、`notify/wecom.ts` 同形），`message` 是中文且带原始原因。

同一文件里另外导出（都是「只有一处」的东西）：

- `QUEUE_COLUMNS` —— 9 列的唯一列序来源；
- `loadQueueRows(database)` —— `state = 'queue' and deleted_at is null`，`order by number`；
- `recordValues(row)` / `sheetFields()` / `sheetName(now)` / `createArgv(name)` / `recordsArgv(docid, rows)` —— 载荷拼接，纯函数。

CLI 调用仍然是**两步**，理由写在文件头并保留在原处：建表只带 `fields`，`grid_data` 一次性写行实测
`record_count` 仍是 0（字段到了、行没到）。两步各自报错——「表已建、行没写进去：docid …」这句话
只有在两步分开时说得出来。

`scripts/export-queue.ts` 只剩 argv、打印、`pool.end()`。顺带删掉注释里那条 `--append <docid|url>`：
代码里从来没有过这条分支（`--append` 只出现在注释里，传进去会被静默忽略）。`--dry-run` 保留，
现在走 `loadQueueRows` + `recordValues`，打印的那几行与真正写进去的值同源。

## 2. 权限：`exportQueueAction` 只过 `currentMember()`

```ts
export async function exportQueueAction(): Promise<ExportQueueResult> {
  await currentMember();                       // 就是权限：没登录 / 没有成员会抛 AppError
  const outcome = await exportQueue({ database: db });
  ...
}
```

为什么没有 `can(actor, facts, 'export')`：导出的是**这个人打开看板就能看到的同一批行**（待排期那一列），
没有一条比看板更细的数据。造一个永远为真的能力只会让人以为这里挡着什么，还多一处要维护的判断。
`roles.ts` 与 `can()` 一个字没动。

返回值比 `ActionResult` 多几项（所以没用 `run()` 那个只回 `{ok:true}` 的外壳）：

```ts
{ ok: true; url: string; rows: number; docid: string } | { ok: false; code: string; message: string }
```

`code` 要带回去，因为 `no_rows` 与「企微未授权」在界面上的处理不一样（前者是「这里现在没事」，
后者要去扫码）。动作**不 revalidate**：导出不改任何一条需求，看板不需要重画。

## 3. 界面：列头的第三格

- 列头抽成 `app/components/ColumnHeader.tsx`（`Board.tsx` 仍然只负责十列的网格）。抽出来的唯一理由是
  「导出什么时候出现」必须被用例钉住：留在 `Board` 里就得渲染整块看板，而卡片是 `next/link`，
  在用例进程里起不来；抽出来之后，用例渲染的正是页面上那一格。
- 出现条件：`column.state === 'queue' && column.cards.length > 0`。**零待排期 = 没有按钮**，
  不是「点了才告诉你没有可导出的行」——待排期每天会被清空一次，一个把「现在没事可做」伪装成
  「可以点一下」的按钮比没有按钮更糟。
- `app/components/ExportQueueButton.tsx`（`'use client'`，`useActionState`）：
  - 成功 → 同一个位置变成 `已生成 · N 行` 的链接，`target="_blank" rel="noreferrer"`；
    CLI 没回 url（只有 docid）时降级为纯文字，不编一个空链接；
  - 失败 → 按钮下面一行中文原因（`flex:1 1 100%` 换行），`title` 里带全文；
    `企微未授权：…` / `命令不存在：…` 都是能照着做下一步的句子。
- 样式只加在 `app/globals.css` 的 `.colhd .hdexport …` 六行，列头高度不变（按钮是文字链接大小）。

## 4. 待排期为空时发生什么

三层，都是「不去做那件事」：

1. **服务**：`loadQueueRows` → `[]` → 立刻 `{ ok:false, code:'no_rows', message:'没有可导出的行：待排期是空的' }`，
   **runner 一次都没被调用**（不留空表；用例断言 `calls.length === 0`）。
2. **按钮**：列头不渲染它——空列里根本没有这个入口。
3. **脚本**：`--dry-run` 打印「待排期是空的，没有可导出的行。」；真跑时走同一条 `no_rows`，打到 stderr 并以非 0 退出。

## 5. 变异表

方法：逐条把「保护那一行」改坏 → 跑对应用例 → 记录是否红 → 还原（`diff` 备份文件确认还原干净）。

| # | 变异（改坏哪一行） | 期望红的用例 | 结果 |
|---|---|---|---|
| M1 | 删掉 `if (rows.length === 0) return fail('no_rows', …)` | 空列返回 `no_rows` 且 0 次 CLI | **RED**（1 failed / 10 passed） |
| M2 | 列头 `cards.length > 0` → `>= 0` | 空列里没有「导出」 | **RED**（1 failed / 2 passed） |
| M3 | 列头去掉 `state === 'queue'` | 别的列有卡片也没有「导出」 | **RED**（1 failed / 2 passed） |
| M4 | `QUEUE_COLUMNS` 里「类型」「负责人」对调 | 9 列顺序（建表 fields + 每行 values） | **RED**（2 failed / 9 passed） |
| M5 | SQL 删掉 `r.state = 'queue'` | 行数 = 待排期条数；别的状态不进导出 | **RED**（2 failed / 9 passed） |
| M6 | `if (errcode !== null && errcode !== 0)` → `if (false)` | errcode 非 0 带 errmsg；写行失败带 docid | **RED**（2 failed / 9 passed） |
| M7 | `cli_failed` 的 message 压成「导出失败」 | 原始 stderr 首行进 message | **RED**（1 failed / 10 passed） |
| M8 | 取消 ENOENT 分支（不认「命令不存在」） | `missing_binary` + 那句提示 | **RED**（1 failed / 10 passed） |
| M9 | 写行失败时直接返回，不加「表已建、行没写进去」 | 带 docid 的那句交代 | **RED**（1 failed / 10 passed） |

九条全部当场红、还原后全部绿。没有「改坏了还绿」的用例——上一轮三次评审都栽在这一条上，
所以这一栏这次是逐条跑出来的，不是估的。

## 6. 真导一次（活库）

导出前实测（`flowers`，`deleted_at is null`）：**815 条需求，其中待排期 2 条**（`PAN-5`、`PAN-6`，
负责人都是吕品，均停 0 天）。所以**不需要**把任何演示需求临时挪进 `queue`，也没有动过任何迁移行的状态。

```
$ npx tsx scripts/export-queue.ts --dry-run
2 行，9 列（编号 / 标题 / 类型 / 负责人 / 提出人 / 等什么 / 停留天数 / PRD / 版本）
  PAN-5  权益套餐产品结构改造  吕品  0 天
  PAN-6  分享页搜索补齐 H5 / 移动端  吕品  0 天

$ npx tsx scripts/export-queue.ts
已建表：待排期需求 11-08 · 2 行
https://doc.weixin.qq.com/smartsheet/s3_AFEAz3gEAKMCNgxfPvFHMRhO3i1hu_a?scode=ALgASwf6AA00N1WqtCAFEAz3gEAKM
docid: s3_AFEAz3gEAKMCNgxfPvFHMRhO3i1hu_a
```

链接：<https://doc.weixin.qq.com/smartsheet/s3_AFEAz3gEAKMCNgxfPvFHMRhO3i1hu_a?scode=ALgASwf6AA00N1WqtCAFEAz3gEAKM>

产物的独立核对（不信脚本自己那句「2 行」）：

- `wecom-cli smartsheet records list --docid s3_AFEA… --sheet-title 待排期` → `errcode 0`、`next: 2`、
  `records[0].values` 是那 9 个字段标题；
- `wecom-cli smartsheet fields list …` → 9 条，顺序与 `QUEUE_COLUMNS` 逐字一致，只有「停留天数」是 `number`。

也就是说：**建表 + 写行两步在真环境里都成立**，不是只建出一张空表。

## 7. 测试

- `tests/export.test.tsx`（11 条，真库 `flowers_test`，CLI 是注入的 runner）：
  空列（`no_rows` + 0 次调用）、查询只问 `queue`、行数/链接/表名、9 列顺序（建表与每行 values 各一条）、
  退出码非 0 带原始首行、errcode 非 0 带 errmsg、ENOENT、未授权、写行失败交代 docid、没有 docid 时不继续写。
- `tests/export-ui.test.tsx`（3 条，`renderToStaticMarkup` + mock 掉 `../app/actions`）：
  空列无「导出」、有卡片有「导出」、别的列有卡片也没有「导出」。
- 全量：`npx vitest run` → 49 文件、1248 passed、1 skipped（skip 是既有的那条）。
- `npx tsc --noEmit` 干净。

## 8. 没做 / 边界

- **追加导到已有表**：仍然没有。`--append` 是注释里的幻觉，删掉了；真要做就是 `exportQueue` 的一个新入参
  （`docid`），不是脚本多认一个 flag。这次不做，因为按钮的语义是「给我一份现在的」，追加是另一个动作。
- **导出后不 revalidate**：成功后按钮变链接、需要重新导出时刷新页面。这是刻意的——导出不改数据，
  为它刷一次看板会让「刚生成的那张表」这条反馈跟着消失一次。
- **没有做的事故回滚**：`smartsheet create` 成功、`records add` 失败时**不会**自动删掉那张空表。
  删文档要拿 docid 去删别人马上就要看见的东西，这件事该由人决定；服务只把 docid 说出来
  （「表已建、行没写进去：docid …」），人自己去处理。
- **界面没在浏览器里真点过**：`/` 需要登录态，而这套演示库的口令是 `npm run seed` 随机生成、
  只打印过一次的（改某人的口令不属于这次任务，也不该为了验一次按钮就动真库）。所以按钮那一格
  由 `tests/export-ui.test.tsx` 对着渲染出来的 HTML 断言，服务端那条路由由 §6 的真导出覆盖；
  「点一下 → 出链接」这一段没有第二次证据。要看的话：登录后打开看板，待排期列头即那个入口。
- 未触：`src/core/locate/*`、状态机、`roles.ts`/`can()`、迁移行的状态。
