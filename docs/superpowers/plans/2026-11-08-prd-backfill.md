# 2026-11-08 老系统的 PRD 链接回填：按标题全等，203 条

分支 `main`（基于 `7b81dfc`）。一条编号迁移、一份生成好的种子文件、一个取数/执行脚本、
一组用例。**没有表结构变化**（新增的一张 `prd_url_backfill_seed` 是这次回填的台账，
不是业务表）。

| 交付 | 文件 | 形状 |
|---|---|---|
| 迁移 | `src/db/migrations/0025_prd_url_backfill.sql` + `meta/_journal.json` | 建种子表 + 一条 `update ... from prd_url_backfill_seed`，判据四道门，幂等 |
| 数据 | `src/db/seeds/prd-url-backfill.json` | 203 条 `{title, url}`，**一条配对一行**，按标题码点排序（35 KB / 211 行） |
| 取数与执行 | `scripts/prd-backfill.ts`（`--emit` / `--apply` / 默认 dry-run） | 从 Flower 取 `documents`、配对、生成种子；`--apply` 装种子并**重跑 0025 那个文件** |
| 用例 | `tests/prd-backfill.test.ts`（10） | 跑真迁移文件；一条变异用例钉住「唯一」 |
| `package.json` | `prd:backfill` / `prd:backfill:emit` | 两条命令，没有新依赖 |

---

## 1. 链接的依据：标题全等（先查证，再动手）

老系统（Flower，`ssh dogyun` 只读）**确实存着 PRD 链接**：`documents.external_url`。
但文档与需求之间**没有任何一条结构化链接**——这是查证过的四件事：

| 查什么 | 结果 | 结论 |
|---|---|---|
| `documents` | 217 行，`kind` 全为 `change`，其中 `external_url` 非空 **205** 行 | 链接在文档行上 |
| `entity_links` | **0 行**（空表） | 没有 link 行 |
| `requirements.brief_document_id` / `change_document_id` | 258 行里 **0 行**有值（全 null） | 没有外键指向文档 |
| `documents.title` 命中 `PAN-[0-9]` | **0 行** | 标题里没有需求号 |

于是文档与需求之间**唯一存在的对应关系就是「标题一样」**。这不是本轮的折中方案，
是那份数据里只有这一个抓手。反过来验一次：205 条带 URL 的文档标题，**全部**能在我们
的 815 条需求里找到同名行（0 条对不上）。所以回填按标题**全等**做：不 trim、不归一化、
不分大小写、不做模糊匹配。任何一处放宽，都会把链接推到一条「看起来对」的需求上。

**标题本来就是需求标题**：205 条文档标题逐条对到需求标题上，203 条只对应一条需求，
2 条各对应两条（下一节）。`--emit` 生成种子时用的就是这条口径
（`scripts/prd-backfill.ts` 的 `buildPlan`，与 0025 的 `where` 一一对应）。

## 2. 203 条怎么落库：种子文件 + 迁移里的规则

迁移文件是被 **pg 驱动**逐条执行的纯 SQL，它唯一看得见的数据就是文件的字节；而
`external_url` 只在 Flower 里，CI 与新克隆都没有那条 ssh 通道。所以数据和规则分开放：

- **规则**在 `0025_prd_url_backfill.sql`：一条 `update ... from prd_url_backfill_seed`，
  四道门全在里面（`legacy_ref is not null` / `prd_url is null` / `btrim(url) <> ''` /
  同题需求 `count(*) = 1`）；
- **数据**在 `src/db/seeds/prd-url-backfill.json`，由 `npm run prd:backfill:emit` 从
  Flower 生成、**签进仓库**。一条配对一行，重新生成只剩真正变化的几行 diff；
- **执行**是 `npm run prd:backfill`：把种子装进 `prd_url_backfill_seed`，再**重跑 0025
  那个文件本身**（不是脚本里另抄一份口径）。没有种子时（新克隆 / CI /
  `npm run db:migrate`）种子表是空的，0025 命中 0 行、不报错。

`title` 是种子表的主键 → 文档侧「同题唯一」由表的形状保证；需求侧的「同题唯一」数不了，
只能当场 `count(*)`（0025 里那条子查询）。

## 3. 2 条歧义：不猜，交 owner 选

各有两个候选，**一条都没写**。

| 文档标题 | PAN | 文档 URL |
|---|---|---|
| 用户部分权益缩减调整 | **PAN-338** · **PAN-742** | https://doc.weixin.qq.com/doc/w3_AY0AtQboAD4CNh0SmhkawQQeGX256?scode=ALgASwf6AA00dBNilLAY0AtQboAD4 |
| 【风控】我的分享违规文件展示逻辑问题 | **PAN-27** · **PAN-206** | https://doc.weixin.qq.com/doc/w3_AX8A6ga3ADQCNsN4Zo0WCRi6e1Aob?scode=ALgASwf6AA0dkbU2JSAY0AtQboAD4 |

为什么不取「第一条」（`number` 最小的那条）：这一列的读者不是人——`prd_snapshots` 与
材料生成把它当**权威源**。写错一条，下游会照着一份别人的 PRD 生成材料，而**没有人
看得出来**：库里那一列有值，界面就显示「PRD 已挂」。空着只是「还没挂」，错挂是
「挂错了」。owner 挑完之后各写一条 `update requirements set prd_url = '…' where number = …;`
即可（`prd_url is null` 的门不会挡人工写入，因为那道门只在迁移里）。

## 4. 计数（执行前后，均为实测）

| 时刻 | 总行 | 迁移行 | 演示行 | 迁移行有 prd_url | 演示行有 prd_url |
|---|---|---|---|---|---|
| 执行前 | 815 | 803 | 12 | **0** | 10 |
| 执行后 | 815 | 803 | 12 | **203** | 10 |
| 第二次跑 | 815 | 803 | 12 | 203 | **0 条变化** |

- 815 / 803 一个字节没变；10 条演示行的 `prd_url` 原样（`https://docs.123pan.example/prd/PAN-*`）；
- 203 条写入的值与种子逐条相等（`join on title and url` = 203），且抽 18 / 26 / 522 / 685
  回 Flower 对过原文一致；
- 全库没有一条 `prd_url = ''`；
- 幂等：`npm run prd:backfill` 第二遍 `写入 0 条`、种子表 `装载 0 行`。

## 5. 剩下 600 条没有 PRD（803 − 203）意味着什么

它们**不是同一件事**，分三类（`--emit` 每次都会打印）：

| 类 | 条数 | 意思 |
|---|---|---|
| 老系统里一条同名文档都没有 | **596** | 这条需求当年就没写过 PRD（或写在别处：企微聊天、口头、别的表格）。标题全等对不上任何文档行 |
| 有同名文档，但那条文档 `external_url` 为空 | **0** | 值得单独说：12 条空 URL 的文档（`flower使用手册`、`[分享转存]分享创建模块`、`[文件管理]回收站` 等）**都是模块级文档**，没有一条与需求标题同名。所以这一类实际是 0，不是「一批人忘了填链接」 |
| 有 URL，但同题需求不止一条 | **4** | 就是第 3 节那 2 个标题 × 2 条需求 |

也就是说：**596 条的缺口是「老系统里没有这份文档」，不是「链接丢了」。** 其中 12 条
空 URL 的模块级文档值得 owner 单独看一次——它们看着像「本来该有链接、只是没贴」，但
它们不是需求粒度，对不上任何一条需求，本迁移也不该把它们硬塞进某一格。

## 6. 不碰什么

- `src/core/locate/*`、`src/db/reset.ts`（守卫）、除 0025 外的任何迁移：一个字节没动；
- `prd_url_backfill_seed` **故意不进 `RESET_TABLES`**（与 `code_index` 同类：老系统的
  快照，`cascade` 带不到它，重建的代价是 `npm run prd:backfill` 一条命令；清掉它只会让
  0025「看起来跑过、其实什么也没填」）。用例自己清这张表，不依赖 `resetDb`；
- `git clean` / 任何删 ignored 文件的操作：没跑过。

## 7. 复现

```bash
npm run db:migrate          # 0025 建种子表；种子为空 → 0 行（新克隆/CI 的正常结果）
npm run prd:backfill        # 装 203 条种子 + 重跑 0025 → 写入 203
npm run prd:backfill        # 第二遍 → 写入 0
npm run prd:backfill:emit   # 需要 ssh dogyun；重新从 Flower 生成种子（会打印歧义与缺口分类）
npx vitest run tests/prd-backfill.test.ts   # 10 条
```

用例钉的五件事：一对一才写；**两条需求同题 + 一条文档 → 一条都不写**；混在一起时只写
唯一的那条；不覆盖已有值 / 不碰演示行 / 不收空 URL；第二遍 0 行。另有一条**变异用例**：
把「唯一」放宽成「至少一条」（`= 1` → `>= 1`，等价于「取第一条」的写法），同一个歧义
场景立刻写成 2 行——证明那个 `= 1` 是承重的，不是防御性代码。种子文件本身也被钉住：
203 条、标题两两不同、URL 都是 http(s)、标题无首尾空白。

---

## 8. owner 裁定之后的收尾（迁移 0026）

### 8.1 裁定

两个歧义标题各有两个候选，第 3 节「不猜」的结果是 4 条需求一条都没挂 PRD。owner 现在
逐条判了：

| 标题 | 编号 | 状态 | 裁定 |
|---|---|---|---|
| 用户部分权益缩减调整 | **PAN-338** | rejected | **删掉**（软删） |
| 用户部分权益缩减调整 | **PAN-742** | queue | 保留，**补上** PRD 链接 |
| 【风控】我的分享违规文件展示逻辑问题 | PAN-27 | live | 保留，**继续没有 PRD**（不填、不删） |
| 【风控】我的分享违规文件展示逻辑问题 | PAN-206 | live | 保留，**继续没有 PRD**（不填、不删） |

「已拒绝的那条删掉」是这个标题变成唯一的前提：删之前那个标题在表里有 2 行，0025 的
第 4 道门（`count(*) = 1`）永远数出 2 条；删之后未删的行只剩 PAN-742，规则才成立。

### 8.2 为什么是新开 0026，而不是重跑 `npm run prd:backfill`

**选择：新编号迁移 `0026_prd_backfill_after_ruling.sql`。** 理由是实测出来的两条：

1. **种子文件里没有那个标题**。`src/db/seeds/prd-url-backfill.json` 是 `--emit` 按
   「需求侧唯一」筛出来的 203 条，两个歧义标题**从来不在里面**（`buildPlan` 把它们
   收进 `ambiguous`，不进 `pairs`）。所以 `npm run prd:backfill --apply` 重跑 0025 时，
   种子表里根本没有「用户部分权益缩减调整」这一行 —— 它设计上就是「重放已判定过的那
   203 条」，不会因为库里的数据变了而自己长出新的配对。
2. **0025 的判据数的是全表**。就算种子表里有那一行，`(select count(*) ... where
   r2.title = s.title) = 1` 连软删的行一起数，删掉 PAN-338 之后仍然是 2 → 照样命中
   0 行。「删一条」本身**不会**让 0025 的规则自动生效，差的是「数哪些行」。

所以 0026 做三件事，各一段、各带守卫：

| 段 | 做什么 | 判据 |
|---|---|---|
| 1 | 软删 PAN-338 | `number = 338` **且** `legacy_ref is not null` **且** `state = 'rejected'` **且** 未删；命中不是 1 行就 `raise exception` 停下 |
| 2 | 把裁定选定的那份文档写进 `prd_url_backfill_seed`（1 行） | `title` 是主键 → 文档侧同题唯一由表的形状保证 |
| 3 | `update ... from prd_url_backfill_seed` 补 PAN-742 | 0025 的四道门原样，**只把「唯一」从「全表唯一」改成「未删的行唯一」** |
| 4 | 自检 | 删对了（未删的迁移行里该标题唯一）且填上了（`prd_url` = 裁定 URL） |

第 3 段不按 `number = 742` 点名：判据是「标题全等 + 未删的行唯一」，今天那一条正好是
PAN-742。哪天再冒出第二条未删的同题需求，这条 `update` 会自己停下（命中 0 行）而不是
挑一条 —— 与 0025 拒写歧义的理由完全一样。

URL 只出现在第 2 段一处，来源是本文第 3 节记录的那份文档，同日 `ssh dogyun` 只读复核过
与 Flower `documents.external_url` 原文一致。

**幂等**：第二遍第 1 段走「已经删过」分支（0 行）、第 2 段 `on conflict` 0 行、第 3 段
`prd_url is null` 不成立（0 行）、第 4 段照旧通过。**空库**（新克隆 / CI）：`number = 338`
那行不存在 → 第 1 段什么都不做，第 3 段命中 0 行，不报错（与 0025「种子为空 → 0 行」同一种
正常结果）。但**那行在、判据却对不上**时（不是迁移行 / 不是 rejected）一定抛错：宁可让
迁移红着，也不猜一条要删掉的真实数据。

### 8.3 动到的两行（执行后实测）

| PAN | `requirements.id` | 动作 | 结果 |
|---|---|---|---|
| **PAN-338** | `7b823110-584d-416f-8de0-01ae9101e783` | 软删 | `deleted_at = 2026-11-07 23:34:57.133398+00`，`state` 仍 `rejected`，`legacy_ref` 仍 `123bd3a8-…` |
| **PAN-742** | `23bc6d1f-fd72-459f-86ec-55f83190bfc1` | 写 `prd_url` | `https://doc.weixin.qq.com/doc/w3_AY0AtQboAD4CNh0SmhkawQQeGX256?scode=ALgASwf6AA00dBNilLAY0AtQboAD4` |

PAN-27 / PAN-206 一个字节没动（`state = live`、`deleted_at` 为空、`prd_url` 仍为 null）。

### 8.4 计数（执行前后，均为实测）

| 时刻 | 未删需求 | 未删且 `legacy_ref` 非空 | `deleted_at` 非空 | `prd_url_backfill_seed` |
|---|---|---|---|---|
| 执行前 | 815 | 803 | 0 | 203 |
| 执行后 | **814** | **802** | **1** | 204 |
| 0026 第二遍 | 814 | 802 | 1 | 204（0 条变化） |

- `用户部分权益缩减调整`：未删 **1** 条（PAN-742），且 **有** `prd_url`；
- PAN-27 / PAN-206：都还在（`live`），`prd_url` 都还是 null；
- 表里总行数仍是 815 —— 软删不动行数，这是它唯一的区别。

### 8.5 软删后留下的孤儿行（清单）

软删不级联，引用 PAN-338 的行全部留在表里。六张带 `requirement_id` 的表逐张数过：

| 表 | 行数 | 说明 |
|---|---|---|
| `events` | **1** | `seq 378` · `requirement.migrated` · actor `migrate-flower` · 2026-11-07 16:00:32Z（payload 里 `sourceNumber: 775`、`sourceState: "rejected"`） |
| `review_assignments` | 0 | — |
| `uemaster_artifacts` | 0 | — |
| `uemaster_jobs` | 0 | — |
| `prd_snapshots` | 0 | — |
| `locate_runs` | 0 | — |
| `notify_deliveries` | 0 | 那条事件从未投递过（`event_seq = 378` 无行） |

**这一条孤儿事件不渲染在任何地方。** 逐个读路径实测（`cards` = 看板卡片、`notices` = 铃铛）：

| 读路径 | 结果 |
|---|---|
| 看板 `getBoard()` | 814 张卡，**PAN-338 不在**，PAN-742 在 |
| 抽屉 `getRequirementDetail(PAN-338)` | `null`（404，`:633` 的 `deleted_at is null` 挡住） |
| 产物 `listArtifacts(PAN-338)` | 0 份 |
| PRD `readPrd(PAN-338)` | `missing_prd_url`（空链接先于抓取返回，**不会**建出 `prd_snapshots`，也不会记 `prd.fetched`） |
| 通知 `notificationsFor()` | 7 条里没有 PAN-338；`ALIVE = (r.deleted_at is null or e.requirement_id is null)` 把 `seq 378` 整条滤掉（按同口径数出来 **0 条**，而原表里是 1 条） |

也就是说：**孤儿行只存在于直接 SQL 里**，界面、MCP 列表、通知、导出都看不见它。

### 8.6 顺带查出来的两处口径漏洞（本次未改，记录在案）

1. **`src/core/prd/read.ts:60` 没有 `deleted_at is null`** —— 唯一一处按 id 读需求却不过
   软删判据的读路径。今天伤不到人（PAN-338 的 `prd_url` 是空的，先撞 `missing_prd_url`），
   但一条**有** PRD 的软删需求，`readPrd` 仍能抓 doc 并写一份 `prd_snapshots` + 一条
   `prd.fetched` 事件 —— 那就成了「一条不在板上的需求还在产出快照」。
2. **`src/core/requirements/lock.ts:51` 的 `lockRequirement` 不带 `deleted_at is null`** ——
   所有状态动作（提交评审 / 评审 / 排期 / 打回 / 认领 / 转交）都走它，理论上软删的行仍可被
   推进并写出事件。对 PAN-338 不成立（`state = 'rejected'` 在迁移表里没有出边，任何动作都撞
   `illegal_transition`），但换个状态被软删就会踩到。

另一件留给后来人的事：`scripts/prd-backfill.ts` 的 `loadRequirements` / `buildPlan` 仍把
软删的行算进「同题需求」的计数里，所以现在 `npm run prd:backfill:emit` 重新生成种子时，
「用户部分权益缩减调整」**仍会被判为歧义、不进种子文件**（203 条不变）。这不影响已落库
的数据（`prd_url` 已有值，`prd_url is null` 那道门永不覆盖），但下次 emit 之后种子文件与
库会差这一条 —— 要么让 `buildPlan` 也按未删的行分组，要么把这一条单独记住。

### 8.7 复现

```bash
npm run db:migrate                                  # 0026：空库上是 0 行（不报错）
docker exec flowers-db-1 psql -U postgres -d flowers -f /dev/stdin \
  < src/db/migrations/0026_prd_backfill_after_ruling.sql   # 第二遍：0 行
```

不碰的东西：`src/core/locate/*`、`src/db/reset.ts`、除 0026 外的任何迁移；没跑 `git clean`；
没有新依赖。
