# 2026-11-08 三条裁定：类型可空 · 无主回收集 · 来源字段

分支 `main`（基于 `6874fd0`）。三个编号迁移，一次一条裁定，每条都可单独回滚。

| 迁移 | 裁定 | 形状 |
|---|---|---|
| `0020_type_optional.sql` | 1. 类型不再必填 | 只放宽约束（`DROP NOT NULL`），不动既有值 |
| `0021_ownerless_to_inbox.sql` | 2. 没有负责人的需求回到「收集」 | 数据迁移，`where owner_member_id is null and state <> 'inbox'` |
| `0022_source.sql` | 3. 新增「来源」 | 两列 + 按 `legacy_ref` 从迁移事件回填 |

三条都幂等（跑第二遍命中 0 行 / 是 no-op），`npm run db:migrate` 连跑两次的证明见第 4 节。

---

## 1. 裁定 1：`requirements.type` 可空，立项不再要求类型

### 列

`ALTER TABLE requirements ALTER COLUMN type DROP NOT NULL`（`0020`）。既有 815 行的值一个
字都没改：`feature` 748 / `commercial` 67，没有一行被写成 null，也没有一行被填一个默认值。

服务层值域：`src/core/requirements/type.ts` 是词表唯一来源
（`TYPES` / `TYPE_UNSET = '未指定'` / `normalizeType` / `typeLabel` / `typeSuffix`）。
`create.ts` 用 `z.string().nullish()` 收形状、`toType()` 收值域：缺字段 / 空串（表单里那个
「未指定」）/ null → `null`；认不出的值**报错**
（`类型只能是 commercial / feature（或留空 = 未指定）`），不静默落成 null。

> 值域刻意不写进 zod（`z.enum` / `z.preprocess` 都不行）：`CreateInput` 同时是 MCP
> `requirement_create` 的**唯一** `inputSchema`，`ZodEffects` 在 JSON Schema 里没有忠实
> 表示，那样会产生一份和真正校验对不上的 schema。这条理由与 `priority` 那条路同源。

### 门：删掉，不是改成恒真

`src/core/state-machine.ts`：

- `TRANSITIONS` 里 `inbox → design` 的 `guard: 'type'` **删除**（保留 `trigger: 'evaluate'`）；
- `Guard` 类型从 `'prd' | 'type'` 收成 `'prd'`；
- `TransitionContext` 去掉 `hasType`；
- `assertGuards` 删掉 `missing_type` 分支与那句中文；
- `evaluate.ts` 的 `assertTrigger(..., { hasType: !!row.type })` → `assertTrigger(...,'evaluate')`。

留一个没人读的 `guard: 'type'` 是更坏的形态：下一个人会以为它在生效。所以连类型带分支
一起删，`hasType` 从 ctx 里消失之后，任何还想着「读类型判门」的代码在 `tsc` 里就会暴露。

### 门移除的爆炸半径（还有谁读 `type`）

| 位置 | 读它做什么 | 现在 |
|---|---|---|
| `state-machine.ts` | 立项门 | **删了**（唯一的行为变化） |
| `requirements/evaluate.ts` | 传 `hasType` | **删了** |
| `requirements/lock.ts` | `select r.type`（曾是 guard 依据） | 列留着（`Locked` 是公共形状），注释改成「不再是 guard 依据」 |
| `requirements/create.ts` | zod 必填 + insert + `requirement.created` payload | 可空；payload 里照写 `null`，不编默认值 |
| `requirements/manage.ts` | `type` 在 `FORBIDDEN` 里（描述不可改） | **不动**（owner 的既有裁决：类型不可改） |
| `requirements/fields.ts` | `hintFor(..., type)` 的 `commercialHint` | 签名放宽成 `string \| null`；null 走普通提示（「商业需求没有成功口径」只在确实是商业时成立） |
| `requirements/fingerprint.ts` | **不参与** | 不动，现在有用例钉住它 |
| `read/detail.ts` | `TYPE_LABEL` 本地映射 | 换成 `typeLabel()` / `typeSuffix()`（本地那份删掉） |
| `export/queue.ts` | `row.type === 'commercial' ? '商业' : '功能'` | `typeLabel(row.type)`，null → 未指定 |
| `mcp/tools.ts` | `planTool` / `showTool` 输出 | 输出 `type`（可能 null）+ `typeLabel` |
| `uemaster/packs.ts` · `compose` · `review` · `inspect` | 生成 prompt 里「类型：`${req.type}`」 | 换成 `typeLabel()`，空值写「未指定」（原来会写成一个空串，`类型：　提出人：`） |
| `app/components/RequirementForm.tsx` | 类型下拉，初值 `?? 'feature'` | 初值 `?? ''`（第一项「未指定」），选项从 `TYPES` 派生 |
| `app/components/Drawer.tsx` · `app/page.tsx` · `app/actions.ts` | 显示 / 初值 / 提交 | 空值走第 3 小节那套；actions 只是把空串交给服务层归一 |
| `scripts/migrate-flower.ts` | `TYPE_MAP` 映射 | **不动**（任务约束） |

### 指纹：不会 churn

`FINGERPRINT_FIELDS` 十格里没有 `type`（文件头写明了理由：它不是「描述」，而且
`state` 那条更极端的例子已经解释过为什么「会变的东西」不能进指纹）。所以把这一列放宽成
可空**不会**让任何历史 `input_hash` 失效。这条现在有正面用例（补 / 清类型后指纹不变）与
反面证据（同一个指纹函数算得出那十格）。

### 空值口径（我选的，并说明为什么）

- **抽屉抬头**（`PAN-7 · 功能类`）：空值时**整段不渲染**，只剩编号。理由：`· 未指定类`
  不是中文；而抬头是标题行，少一段不丢信息。
- **抽屉信息表「类型」一行**：显示**「未指定」**，**不隐藏**。理由：信息表是一张字段表，
  「这一格没填」本身就是要说得清的事实；隐藏它等于让人以为这条需求没有类型这个属性。
- **看板卡**：本来就不显示类型（卡片只有「标题 / 等谁 / 编号 + 天数」三行），所以没有
  假值可显示——这里什么都不用改。
- 措辞与 `PRIORITY_UNSET`（未定）、`PLATFORM_UNSET`（未标注）刻意不同字：类型是「还没选」。

---

## 2. 裁定 2：没有负责人的需求一律回到「收集」

`0021_ownerless_to_inbox.sql`：

```sql
update requirements
   set state = 'inbox', state_entered_at = now()
 where owner_member_id is null and state <> 'inbox';
```

### 先查再改（实测数字）

执行前：

| 项 | 数字 |
|---|---:|
| `requirements` 总数 | **815** |
| `legacy_ref` 非空 | **803** |
| 无负责人（`owner_member_id is null`） | **195** |
| 其中已在 `inbox` | 143 |
| **会被这条语句移动** | **52** |

52 条的分布：`design` 22 · `rejected` 17 · `shelved` 6 · `live` 6 · `dev` 1。

执行后：

```
select state, count(*) from requirements where owner_member_id is null group by state
→ inbox | 195        （只剩一行，符合验收）
```

有负责人的 620 行一个字都没动（用例里有断言：状态与 `state_entered_at` 逐字相等）。

### `state_entered_at` 重置是刻意的

这一列的含义是「进入当前状态的时刻」：看板的「停了 N 天」、抽屉的「进入本状态」都读它。
这 52 条现在真的**重新进入**收集状态——它们从这一刻起重新排队等领取，而不是「在待设计
停了 40 天」（那 40 天里根本没有负责人，把它算成停留时间是假的）。迁移文件里写明了这一点。

代价（也写进 concerns）：`live` 那 6 条已上线的无主需求会从「已上线」列回到「收集」列，
`rejected` 17 条同理。这是裁定本身的意思（没有主人的状态不算数），但它是一个**看得见**的
变化，不是纯数据整理。

### 幂等

`state <> 'inbox'` 是幂等键：第二次跑命中 0 行，`state_entered_at` 不会被再刷一次
（用例用「第一遍之后的值 == 第二遍之后的值」钉住）。刻意**不用**
`state is distinct from 'inbox'` 之类的写法——那会把以后被人工推回 inbox 的行再刷一次时间。

---

## 3. 裁定 3：新增「来源」

### 列

`0022_source.sql`：`source text null`、`source_note text null`（`ADD COLUMN IF NOT EXISTS`）。
没有 CHECK：词表是服务层的一份常量（与 `platforms` / `priority` / `type` 同一条做法，
加一类来源不该是一次迁移）。

词表唯一来源 `src/core/requirements/source.ts`：`SOURCES`（六类，顺序 = 下拉顺序）、
`SOURCE_OTHER = '其他'`、`SOURCE_UNSET = '未标注'`、`normalizeSource`、`sourceLabel`、
`sourceNoteVisible`。**键就是中文**，因为库里存的也是这几个中文串：

- 六类里只有两类在老系统有英文键（`online_issue` / `original`），另外四类是这次新起的名字；
- 「原创 → 需求挖掘」是一次**判断**而不是一次翻译，硬造英文键会把判断藏进一层映射里；
- owner 的验收查询就是按中文看的（`select source, count(*)` 要直接读到「线上问题 / 需求挖掘」）。

### 回填（幂等，只碰 `legacy_ref is not null`）

老系统的 `source` 没有列可搬，但**没丢**：`migrate-flower.ts` 把它原样记进了
`requirement.migrated` 的 payload（键名 `sourceSource`）。所以回填是从自己写下过的事实里
读回来。实测（803 条迁移行）：

| 老系统值（payload） | 条数 | → `source` |
|---|---:|---|
| `online_issue` | 8 | 线上问题 |
| `original` | 332 | 需求挖掘 |
| 空（payload 里没有这个键） | 463 | 留空（null） |

回填后（全库 815 行）：

| `source` | 条数 |
|---|---:|
| 线上问题 | **8** |
| 需求挖掘 | **332** |
| null | **475** |

475 = 463 条老数据没有来源 + 12 条演示数据（本来就无此格）。与预期逐数一致。

`原创 → 需求挖掘` 的**可回滚**：原始值仍在 `events.payload.sourceSource`
（`= 'original'`），要推翻只需一条 `update ... where source = '需求挖掘' and exists (...)`。
迁移注释里写明了这条映射是控制器的判断，以及判断的依据（六类里只有「需求挖掘」表示
「我们自己发现的」；线上问题 / 客服反馈 / 领导需求 / 技术反馈 都是别人给的）。

幂等键是 `r.source is null`（第二次命中 0 行）。刻意**不用**
`source is distinct from '线上问题'`：那会把以后被人工改成「客服反馈」的行拉回来，覆盖人的判断。

### 写入与读回

- `create.ts`：`CreateInput` 加 `source` / `sourceNote`（都 `nullish`）；`toSource()` 值域校验，
  认不出的值报错并列出六类（`来源只能是 线上问题 / 客服反馈 / … （或留空 = 未标注）`，
  那条消息从 `SOURCES` 派生）。自述只在「其他」时被表单渲染，但服务层**不拦**别的来源带
  自述（静默丢掉调用方给的一句话比留着更坏）。`requirement.created` 的 payload 里也记
  `source`，时间轴答得出「这条是哪来的」。
- 读模型 `read/detail.ts`：`info.source` / `sourceLabel` / `sourceNote`，都进抽屉；
  认不出的历史值原样显示（`sourceLabel` 兜底 = 键本身），不折成 null。
- 抽屉：信息段一行「来源」，空值「未标注」（与平台同字）；`source === '其他'` 且有自述时，
  自述以 `（…）` 跟在后面，不占第二格字段。
- 表单：新建表单一行下拉（第一项「未标注」+ 六类，从 `SOURCES` 派生），选中「其他」时
  多出一格「其他说明」（`name="sourceNote"`）。
- MCP：`requirement_show` 输出 `source` / `sourceLabel` / `sourceNote`；`requirement_create`
  自动接受这两格（与 `CreateInput` 同一个 schema）。
- 看板卡上没有来源（与平台 / 优先级同一条理由：两行放不下第三个标签）。

**来源在新建时设定，编辑面不改它**：与 `type` / `requester` 同一条既有口径（说清「这条需求
是什么」的字段不在描述编辑面上），因此 `manage.ts` 的 `EDITABLE_FIELDS` / `FORBIDDEN` 一个字
都没动。要改成可编辑，是下一轮的事——加进去要同时给 `compareKey` / `brief` 两处表态。

---

## 4. 验证（真实输出）

| 命令 | 结果 |
|---|---|
| `npm run db:migrate`（第 1 次） | 三条迁移应用；`type` `is_nullable = YES`；无主 195 全在 inbox；source 8 / 332 / 475 |
| `npm run db:migrate`（第 2 次） | **no-op**：815 行的 `md5(string_agg(id‖state‖source‖source_note‖type‖state_entered_at))` 前后完全相同 |
| `npm run db:test:setup` | `迁移完成：flowers_test` |
| `npx vitest run` | **54 文件 · 1291 passed · 1 skipped（1292）** |
| `npx tsc --noEmit` | 0 错误 |
| `npm run build` | 成功（6 条路由，`/` `/login` `/mcp` `/releases` `/settings` `/uemaster/[...path]`） |

迁移后的账：`requirements` 仍是 **815** 行，`legacy_ref` **803** 行（一行没丢、一行没多）。

新增用例 23 条：`tests/type-optional.test.ts` 8 · `tests/source.test.ts` 11 ·
`tests/ownerless-inbox.test.ts` 4。改动的既有用例：`tests/state-machine.test.ts`、
`tests/requirements.test.ts`、`tests/entry.test.ts`、`tests/uemaster.test.ts`
（原来钉 `missing_type` 的三处，按裁定翻成「不再有这道门」/「没有类型也照样立项」）。

---

## 5. Mutation 表（把裁定改回去，测试必须红）

| # | 变异 | 预期 | 实测 |
|---|---|---|---|
| M1 | `state-machine.ts` 恢复 `guard: 'type'` + `hasType` 分支 + `evaluate.ts` 传 `{ hasType: !!row.type }` | 立项用例红 | **6 条红**：`state-machine` 4 条（13 条能过 / 转移表逐条 / inbox→design 不再要求类型 / type 门不在了）+ `type-optional` 2 条（没有类型也能立项 / 边没有 guard） |
| M2 | `0021` 去掉 `and state <> 'inbox'` | 幂等与「已在收集不动」变红 | **2 条红**：`再跑一次是 no-op`、`已经在收集里的无主需求不会被再动一次` |
| M3 | `RequirementForm.tsx` 把 `SOURCES.map(...)` 换成硬编码 `<option value="线上问题">` | 单一来源用例红 | **1 条红**：`表单从 SOURCES 派生选项，六个中文标签不在组件里再写一遍` |

M1 的变异是手写复原（`/tmp` 备份 → 变异 → 跑 → 还原），M2/M3 同理；三处还原后 `vitest`
立刻回到全绿（28 / 15 条）。**"从 SOURCES 加一个值就改变界面"** 由 M3 的反面证明：界面
唯一的那份选项列表就是 `SOURCES.map`，`source.test.ts` 还逐条断言六个标签不以选项字面量
出现在组件里。

---

## 6. Concerns（留给下一个人）

1. **`live` 6 条无主需求从「已上线」回到了「收集」**，`rejected` 17 条同理。这是裁定 2 的
   字面意思（没有主人的状态不算数），但看板上是一处看得见的变化——如果 owner 的本意是
   「只把进行中的拉回收集、终态别动」，那这条迁移的 where 需要加一个终态白名单。
2. **抬头那一段不渲染、信息表那一行显示「未指定」** 是两种处理，有意为之（理由见 1.4）。
   如果设计上要求两处一致，改的是 `Drawer.tsx` 一处。
3. **来源不可编辑**（只在新建时设）。若要可编辑，`manage.ts` 的 `EDITABLE_FIELDS` /
   `compareKey` / `brief` 三处要同时表态，并把 `source` / `sourceNote` 从"录入事实"改成
   "描述性字段"。
4. **`lock.ts` 仍 `select r.type`**：`Locked` 是 `evaluateInTx` 的公共返回形状，删列要同时
   动 attach 那条路；它现在不参与任何判断，只是白读一列。
5. `npm run build` 会重写 `next-env.d.ts`（引用 `.next/types/*` 而不是 `.next/dev/types/*`）
   ——这是 Next 的生成物，已 `git checkout` 还原，没有进提交。
