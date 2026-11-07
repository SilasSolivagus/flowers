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
