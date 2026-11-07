# P4-09：优先级字段、平台词表回迁、Flower → Flowers 状态映射

日期：2026-11-07
分支：`main`（基于 `2dbb334`）
一句话：给需求加 `priority`，把「平台」从上一轮编的八个键换成生产数据里的十二个端，
并把 Flower（生产实例，803 条未删需求）的 11 个状态映射到我们现有的 10 个状态。

> **状态这一项没有新增任何一格。** 我按第一版任务书起草过 `to_evaluate` / `evaluated`
> 两格（12 状态、看板 12 列），owner 看过之后否掉了：
> 「没有已评估 所有已评估都改为待设计 没有待评估 待评估都是收集」。
> 那份草稿在**任何提交之前**被完整回滚（`state-machine.ts` / `evaluate.ts` 用
> `git checkout` 还原、新建的 `assess.ts` 删除），所以仓库里没有 revert commit——
> `grep to_evaluate src/core/state-machine.ts` 是 0 行，10 状态原封不动。
> 下面第 2 节是这次真正做的那件事：**数据映射**，不是状态机变更。

---

## 1. `requirements.priority`

| 项 | 取值 |
|---|---|
| 列 | `requirements.priority text`，可空，无默认值 |
| 键 | `p0` · `p1` · `p2` · `p3` · `green` |
| 界面标签 | P0 · P1 · P2 · P3 · 绿色通道 |
| 空值 | `null` = 未定（生产库 803 条里有 3 条没有优先级） |

- 服务层：`src/core/requirements/priority.ts` 是词表唯一来源；`create.ts` 的 zod 枚举
  与 `manage.ts` 的可改字段都从它取。写错一个值（`p9` / `急`）**报中文错误**，不静默
  变成「未定」——单选被丢掉等于把一次表态变成没表态。
- 读模型：`Detail.info.priority` / `priorityLabel`；抽屉「信息」段多一行「优先级」。
- 录入面：新建 / 编辑表单各一个单选（第一项是「未定」）。
- 指纹：`FINGERPRINT_FIELDS` 加第十格 `priority`（`p0..green` 折成词表键，null 与空串
  同值）。**这让所有历史产物变旧**——与 P4-08 加平台那一格同一条理由：优先级会改变
  材料的写法（P0 的异常处理要写全、P3 可以留缺口），它属于「这份材料是照着什么生成的」。
- 事件：改优先级写一条 `requirement.updated`，`fields[].from/to` 是 `P2 → P0`（标签，
  不是键）。

## 2. Flower → Flowers 状态映射（11 → 10，一条不丢）

`scripts/migrate-flower.ts`（默认 `--dry-run`，`--apply` 才写；对生产库**只读**）。
数据源：`ssh dogyun 'docker exec flower-postgres-1 psql -U flower_admin -d flower …'`。

| Flower（803 条未删） | 条数 | Flowers | 中文 |
|---|---:|---|---|
| `collect` | 158 | `inbox` | 收集 |
| `to_evaluate` | 102 | `inbox` | 收集 ← owner 裁决（待评估 = 还没人接） |
| `to_design` | 48 | `design` | 待设计 |
| `designing` | 18 | `design` | 待设计 ← owner 裁决（正在设计 = PRD 在写） |
| `evaluated` | 41 | `design` | 待设计 ← owner 裁决（评估完 = 去写 PRD） |
| `to_develop` | 18 | `ready` | 待开发 |
| `developing` | 15 | `dev` | 开发中 |
| `testing` | 2 | `test` | 测试中 |
| `launched` | 264 | `live` | 已上线 |
| `rejected` | 73 | `rejected` | 已拒绝 |
| `shelved` | 64 | `shelved` | 已搁置 |
| **合计** | **803** | | **11 个旧状态全部有落点，没有任何一条被丢弃** |

`--dry-run` 的真实输出（节选，完整表由脚本打印）：

```
== 状态映射（Flower 11 → 我们 10） ==
旧状态          条数    我们的状态      中文
launched        264     live            已上线
collect         158     inbox           收集
to_evaluate     102     inbox           收集
rejected        73      rejected        已拒绝
shelved         64      shelved         已搁置
to_design       48      design          待设计
evaluated       41      design          待设计
designing       18      design          待设计
to_develop      18      ready           待开发
developing      15      dev             开发中
testing         2       test            测试中
合计            803
```

我们自己的状态机（**10 个，没有变**）：

```
收集 → 待设计 → 待评审 → 待排期 → 待开发 → 开发中 → 测试中 → 已上线
  ↘ 已拒绝（终态）      ↘ 已搁置 → 恢复回收集（任意非终态都能搁置）
（评估材料 attach 会把「收集」推进到「待设计」；直接从收集提交评审 = 跳过评估）
```

映射的两处语义损失（写在这里，不藏在代码注释里）：
- `to_evaluate` 折进「收集」之后，102 条需求在看板上与「刚提、还没人接」同列；
  它们实际上在等评估，而收集列的动作是「立项」。这是 owner 明确接受的。
- `evaluated` / `designing` / `to_design` 三格合成「待设计」：系统分不出「评估完了」、
  「PRD 正在写」和「等着排设计」。这也是 owner 的裁决。

字段映射（同一脚本）：

| Flower | Flowers | 说明 |
|---|---|---|
| `title` | `title` | 原文 |
| `state_key` | `state` | 上表 |
| `description`（单段自由文本） | `context` | **近似**：旧库只有一段话，我们六问没有对应格；原文放「谁在什么情况下用」，其余五格留空（不编）。整段原文同时进迁移事件 payload |
| `line`（功能 / 商业，340 条有值） | `type`（feature / commercial） | Flower 自己的 `type` 字段 0 条使用；没有 line 的 463 条默认 `feature` 并打印条数 |
| `platform`（多选，856 个值） | `platforms` | 按**标签**映射（Flower 的 `x_` 随机键不可用），同一行去重 |
| `priority`（800 条有值） | `priority` | 键完全一致，直接搬 |
| `source`（原创 / 线上问题） | — | 我们没有这一列；原值记进事件 payload |
| owner / requester（display_name） | 按名字对花名册 | 对不上的负责人留空（待接单），提出人写「未知」 |

幂等：`--apply` 按 Flower 的 uuid 查 `requirement.migrated` 事件，已搬过的跳过；
每条迁入行写一条 `requirement.migrated`（`change` 类），时间轴显示「从 Flower 迁入 ·
Flower #n」。

## 3. 平台词表：从 8 个编的键换成生产里的 12 个端

真实数据（803 条需求的 856 个平台值，按出现次数）：

`Web端 277 · 移动端 223 · PC客户端 219 · 小程序 46 · 后端 35 · 管理后台 14 ·
Manager后台 11 · 前端 7 · H5 6 · 开放平台 3 · 鸿蒙 2 · TV端 2`（长尾写法见下）

### 新词表（顺序 = 写入顺序 = 指纹顺序）

| 键 | 标签 |
|---|---|
| `web` | Web端 |
| `mobile` | 移动端 |
| `pc` | PC客户端 |
| `mini` | 小程序 |
| `backend` | 后端 |
| `admin` | 管理后台 |
| `manager` | Manager后台 |
| `frontend` | 前端 |
| `h5` | H5 |
| `open` | 开放平台 |
| `harmony` | 鸿蒙 |
| `tv` | TV端 |

### 旧键 → 新键（迁移 0014 + 写入端归一，共用一张表）

| 旧 | 新 | 说明 |
|---|---|---|
| `pc` | `pc` | 不变 |
| `web` | `web` | 不变 |
| `h5` | `h5` | 不变 |
| `admin` | `admin` | 不变（标签从「运营后台」改成「管理后台」） |
| `mini` | `mini` | 不变 |
| `api` | `backend` | 改名 |
| `ios` | `mobile` | 合并 |
| `android` | `mobile` | 合并；`['ios','android']` 映射后去重成一个 `mobile` |

迁移 0014 的做法：`unnest(platforms)` → 映射表 → `DISTINCT ON (new_key)` 去重 →
按词表序 `array_agg`。认不出的键**丢掉但不失败**，逐条 `RAISE NOTICE`（`src/db/migrate.ts`
把 PG 的 notice 打到 stdout；否则它会被 node-postgres 默认吞掉）。本机迁移输出里没有
drop 通知——现有 12 条演示数据只有 `android` 一个旧键。

### 表达力上的降级（事实，不是 bug）

真实数据里**没有 iOS / Android 的区分**：223 条只写「移动端」。我们上一轮把移动端
拆成两个键，比现实更细；这一轮合回 `mobile`。代价是「iOS 与 Android 分开排期 / 分开
定价」这种场景在标签上表达不出来——但既然团队从来不这么打标签，保留两个没人选的
选项只是让人多一次选择。

Flower 里的长尾写法（按标签归并）：`H5-分享页 → h5`、`pc端 → pc`、`管理端 → admin`、
`企业管理后台 → admin`、`manager → manager`、`支付宝 → mobile`。
唯一无法表示的一条是复合值 `Web / PC / App / H5商品中心 / 分享页`（1 条），
`--dry-run` 会把它列在「未映射的平台标签」里，迁移时丢弃。

## 4. 漂移探测器抓到了什么（这次真的抓到过）

| 探测器 | 抓到的事 | 处理 |
|---|---|---|
| `npx tsc --noEmit` | `scripts/shape-corpus.ts`、`tests/review.test.ts` 的 `RequirementRow` 少 `priority`（指纹读它，形状必须对齐） | 补字段与 select |
| `tests/entry.test.ts`（指纹键序） | 「与键的书写顺序无关」那条用例重排对象时漏了 `priority`，指纹不相等 | 重排对象补 `priority`（这条用例正是为这种漏项存在的） |
| `tests/notify-channels.test.ts`（事件分类穷举） | 新事件 `requirement.migrated` 没有类 | 在 `EVENT_CLASS` 登记为 `change`（迁移不该给所有人推 803 条通知） |
| `tests/mcp-legal-from.test.ts`（MCP ↔ UI 动作集合） | 未变（10 状态、9 个动作），全绿 | — |
| `tests/state-machine.test.ts` | 13 条迁移、10 个状态，全绿 | 证明 10 状态形状没被这次改动碰过 |

## 5. 验证

- `npx tsc --noEmit`：干净。
- `npx vitest run`：**1075 passed / 1 skipped**（基线 1063，新增 12 条：`tests/priority.test.ts`
  11 条 + 平台旧键去重 1 条）。
- `npm run build`：通过。
- 浏览器（dev server :3000，1280×720）：
  - 看板仍是 **10 列**，`收集` 在左、`待设计` 紧随其后，没有多出两列
    → `assets/p4-09/01-board-10-states-1280.png`
  - PAN-6 抽屉：平台「移动端 · H5」（由旧值 `android + h5` 迁移而来），优先级 P1
    → `assets/p4-09/02-drawer-platform-priority.png`
  - 新建表单：平台 12 个 chips 是生产标签；优先级下拉是 未定 / P0 / P1 / P2 / P3 / 绿色通道
    → `assets/p4-09/03-create-form-platform-priority.png`
  - 建了一条 PAN-13，勾「Web端 + 移动端」→ 抽屉显示「Web端 · 移动端」；
    优先级改成 P0（走真实服务 `updateRequirement`）→ 抽屉显示 P0，时间轴多一行
    「更新描述 · 优先级」 → `assets/p4-09/04-drawer-priority-p0.png`
  - 编辑表单回填：平台两个 chip 选中、优先级下拉选中 P0
    → `assets/p4-09/05-edit-form-priority-prefill.png`
  - 说明：浏览器工具不能驱动原生 `<select>`（Playwright 的 `fill` 不接受 select，
    option 不可见），所以「改优先级」这一步走的是服务层 + 刷新，而不是在浏览器里点下拉。
    表单提交路径由类型与 `createRequirementAction`/`updateRequirementAction` 的字段传递
    + 用例覆盖。
- 迁移 mapper：`npx tsx scripts/migrate-flower.ts`（默认 dry-run）对生产库只读，
  输出见第 2 节；没有对生产库执行 `--apply`。

## 6. 还粗糙的地方

1. **143 条需求的当前动作被改变**：`to_evaluate` 折进「收集」后，它们在看板上会得到
   「立项 / 提交评审 / 拒绝 / 搁置」这组动作，而它们在旧系统里其实在等「评估」。
   要让它们从「收集」走到「待设计」，迁移之后需要人工或脚本再过一次评估。
2. **`designing` / `evaluated` / `to_design` 合成一格**：看板上看不出「PRD 在写」，
   「停了几天」把三段停留时间加在一起算。
3. **description → context 是近似**：旧库一段话里常常同时有背景、目标、范围、阶段备注；
   放进「谁在什么情况下用」之后，其余五问是空的，生成材料时会显示「没有它，模型猜」。
4. **463 条没有 line 的需求按 feature 落**：`type` 是 NOT NULL，没有「未定」。真值只能
   回旧库补。
5. **`source` 没搬**（只进事件 payload）：「原创 / 线上问题」这个维度在我们的模型里没有
   位置，要做来源统计只能查事件。
6. **平台表达力降级**：iOS / Android 合并成「移动端」，见第 3 节。
7. **一个复合平台值丢失**：`Web / PC / App / H5商品中心 / 分享页`（1 条）无法用一个
   键表示，dry-run 会列出来。
8. **迁移不是一次的**：`--apply` 目前只做「首次搬入」，不做「增量同步 / 改过的需求
   回写」。旧库还在被使用的那段时间，需要再定同步策略。
