# 2026-11-08 · 两条裁定：批量事件不推送 / 评审材料没有 PRD 直接拒绝

分支 `main`，起点 `6a86119`（0028 过期审计批量搁置之后）。两条裁定互不相干，各自一段
代码、各自一组用例，两个 commit 分开落地。

| # | 裁定 | 一句话 | 落地位置 |
|---|---|---|---|
| 1 | **批量操作不该刷屏** | `payload` 里带 `batch` 的事件留账、不进通知（站内 + 企微） | `src/core/read/notify.ts` 的 `addressed()` |
| 2 | **评审材料：没有 PRD 直接拒绝生成** | 缺 `prd_url` 时给一句点名修法的中文，一行作业都不落 | `src/core/uemaster/start.ts` + `src/core/uemaster/review.ts` |

---

## 1. 裁定 1：带 `payload.batch` 的事件默认不推送

### 1.1 现场

`0028_stale_shelve_batch.sql` 一次搁置 34 条，事件的 `actor` 是 `system`。通知扇出里
「排除自己做的事」那条规则（`e.actor <> 我`）因此**谁都排除不掉**——超管为**一条命令**
收到 34 条通知。规则不是「超管不该收搁置」，是「一次批量不该是 34 声滴滴」。

### 1.2 卡片放哪一张：`addressed()`

改一处就够，因为「某条事件点到某个人」这件事**只有一处实现**：
`src/core/read/notify.ts` 的 `addressed(member, channel)`。四个读口全部经过它：

| 读口 | 用它做什么 |
|---|---|
| `notificationsFor` | 站内「找过我的」那一页 |
| `unreadCount` / `latestNoticeSeq` | 铃铛红点、全部已读的水位线 |
| `pendingDeliveries` | 企微推送的候选（同一谓词，另一个 `channel`） |

所以条件是**一个**片段，加在谓词最外层（与 `levelFilter` 同一条位置）：

```ts
// 事件是账，通知是打扰，批量只写账。
const notBatch = sql`(e.payload::jsonb ->> 'batch') is null`;
```

- **两个频道自动一致**：站内与企微读同一个 `addressed`，不会出现「铃铛静了、手机还在响」。
- **账照旧**：`events` 那一行不动（它是审计记录），只是不进 feed、不计红点、不发企微。
  0028 的 34 行今天仍然在库里（`events` 899 行不变），`shelved` 98 条不变。
- **判据是「有没有这个键」，不是某个具体值**：每批带自己的标识
  （0028 是 `2026-11-08-stale-audit`），扇出只关心「这是一次批量」。
- **老事件类型不受影响**：`payload` 是 `text` 列，值永远是 `JSON.stringify` 的产物
  （`src/core/events.ts` 是唯一写入点，迁移 0028 照同一形状写），`->>` 在键不存在时给
  null → 照常通知。读法沿用 `self-heal.ts` / `skips.ts` 已有的 `payload::jsonb ->> 'k'`。

**没有改**任何写 `payload` 的地方（迁移、`recordEvent`、`shelveRequirement` 都不动）。

### 1.3 用例（`tests/notify.test.ts` 末尾一组）

造两行与 0028 同形状的事件（`requirement.shelved` + `payload.batch` + `actor='system'`），
断言两侧：

1. **批量 → 七个人（含超管房超）一条通知都没有**，站内 `notificationsFor` 与企微
   `pendingDeliveries` 都空；`unreadCount` 与推送候选在批量事件前后**逐字相等**；
   两行事件仍在 `events` 里（账还在）。
2. **同一批需求上一条不带 `batch` 的搁置**（走真服务 `shelveRequirement`）→ 超管照常
   收到，行里带原因；企微候选里也在。

只测第 1 条的话，一个「把所有搁置都吞掉」的实现也会绿。

---

## 2. 裁定 2：评审材料：没有 PRD 直接拒绝生成

### 2.1 入口在哪

按钮那一条链是：

```
app/components/GenerateButton.tsx  ──「生成」──▶
app/actions.ts  generateAction()   （'use server'，只做两件事：开作业、交回 jobId）
   └─▶ src/core/uemaster/start.ts  startGeneration()   ← 落 uemaster_jobs 的那一格
         └─▶ (worker) scripts/gen-worker.ts → runJob()
               └─▶ src/core/uemaster/review.ts  reviewRequirement() → prdBaseline()
```

`generateAction` 的 catch 是 `if (error instanceof AppError) return { ok: false, message: error.message }`
——**中文原文就是界面上那一行字**，不改写、不吞。所以拒绝放在 `startGeneration` 里，
用户拿到的就是服务抛出的那句话。

### 2.2 两道门，一句话

| 门 | 位置 | 拦住什么 |
|---|---|---|
| 第一道 | `startGeneration`，锁需求行之后、**落作业之前** | 被拒的点击不产生 `uemaster_jobs` 行，不甩 worker，不读 PRD |
| 第二道 | `reviewRequirement` → `prdBaseline` 的第一句 | 直接调用方 / 老作业也拦住；**先看链接，再看快照** |

第二道为什么必须**不看快照**：旧写法把链接判断写在「没有快照」那个分支里，于是
「库里有上一版快照、需求上的链接却没了」会一路走完，产出一份读起来像「PRD 已经评过」
的材料——那正是这条裁定要掐掉的形状。

### 2.3 拒绝的那句话（`REVIEW_NEEDS_PRD`，全仓一份）

```
这条需求还没有正式 PRD 链接，评审材料要先有 PRD。请在「信息 · PRD 链接」里补上，或先把需求退回待设计补 PRD。
```

一句话三件事：**缺什么**（没有正式 PRD 链接）、**为什么不能凑**（评审材料要先有 PRD）、
**下一步动手做什么**（补链接，或退回待设计补 PRD）。`startGeneration` 与 `prdBaseline`
读同一个常量，两处不可能说出两种修法。

### 2.4 边界

- **只有评审材料**。评估材料（输入是六段描述）照旧；走查材料照旧由 `runJob` 那一句拦。
  用例里各有一条「不受这条规则影响」的断言（评估在没有 PRD 的需求上照样开得起来）。
- **零副作用**：拒绝发生在落作业之前，所以 `uemaster_jobs` / `uemaster_artifacts` /
  `prd_snapshots` 三张表**一行不增**，也**一次模型调用都不发**（用例把 `complete` 换成一个
  记账的假函数，断言它一次都没被调）。
- 没有新依赖，没有动 `src/core/locate/*`、迁移、状态机。

### 2.5 用例（`tests/review-prd-gate.test.ts`，5 条）

| 用例 | 断言 |
|---|---|
| `startGeneration` 缺链接 | `code = prd_missing_url`；`message` 全等于 `REVIEW_NEEDS_PRD`；三张表都是 0 |
| 同一份需求生成评估材料 | 照旧成功（规则不外溢） |
| 有链接（`submitReview` 落 `prd_url`）再开评审 | 照旧成功，恰好一行 review 作业 |
| `reviewRequirement` 缺链接 | `prd_missing_url` + 那句中文；`complete` 零调用；三张表都是 0 |
| 有旧快照、链接被清掉 | 仍然拒绝（看链接，不看快照） |

`tests/review.test.ts` 里原有那条「没有 prd_url」的用例改成断言新文案（`REVIEW_NEEDS_PRD`
逐字相等 + 仍断言零模型调用、零产物）。

---

## 3. 变异表（每条都真跑过，红是红的）

| # | 变异 | 预期 | 实际（失败用例） |
|---|---|---|---|
| M1 | `addressed()` 里删掉 `notBatch`（不再跳过批量事件） | 批量那一条红 | ✅ `notify.test.ts > 批量搁置：一条通知都没有` 红；「不带 batch 照常通知」仍绿（证明差异只来自这一条） |
| M2 | `startGeneration` 的 PRD 门改成 `if (false && …)` | 按钮那条红 | ✅ 红，且**暴露的正是裁定描述的症状**：`expected 'generator_unconfigured' to be 'prd_missing_url'`（没有 PRD 时先撞上一句与 PRD 无关的配置报错） |
| M3 | 删掉 `prdBaseline` 的链接判断 | 生成那条红 | ✅ 3 条红：`review-prd-gate` 两条 + `review.test.ts` 那条 |
| M4 | 判据写反：`is null` → `is not null` | 「不带 batch 照常通知」红 | ✅ 红一大片（所有正常通知用例都静音了），说明这个谓词不是空转的 |

---

## 4. 这条门今天挡住了多少条

`814` 条活需求（`deleted_at is null`）里，**600 条没有 PRD 链接**（`prd_url is null`，
没有「空字符串」那种脏值）：

| 状态 | 无 PRD 条数 |
|---|---|
| `inbox` | 218 |
| `live` | 123 |
| `design` | 100 |
| `shelved` | 87 |
| `rejected` | 72 |
| **合计** | **600** |

今天 `state = 'review'` 的两条**都有** PRD，所以这条门此刻挡住的不是「评审中的需求」，
而是那些「在别处点生成评审材料」的尝试：`design` 100 条最贴身（PRD 正在写、材料想先要），
`inbox` 218 与 `live` 123 是顺手点一下就会被拒的那一批。被拒时看到的是那句点名修法的中文，
不是一句「生成失败」。

---

## 5. 验证

| 命令 | 结果 |
|---|---|
| `npx vitest run` | 64 文件 / **1432 passed · 1 skipped**（含新增 7 条：批量 2 + PRD 门 5） |
| `npx tsc --noEmit` | 干净（无输出） |
| `npm run build` | 通过（`.next/BUILD_ID` 08:56 生成） |

**线上库没被碰过**（改动前后各查一次，逐字相同）：

| 项 | 值 |
|---|---|
| 活需求 | 814 |
| `inbox` | 250 |
| `shelved` | 98 |
| `events` | 899 |
| `uemaster_jobs` / `uemaster_artifacts` / `prd_snapshots` | 7 / 4 / 0 |
| 带 `batch` 的事件（0028 那 34 行） | 34 |

用例跑的是 `flowers_test_<runId>`（`vitest.config.ts` 每轮建一张、跑完删掉），一次都没有
连到 `flowers` 这张库；`npm run build` 不写业务表。0028 那 34 行事件仍在账上——这一轮
改的是**读侧**，一行数据都没动。
