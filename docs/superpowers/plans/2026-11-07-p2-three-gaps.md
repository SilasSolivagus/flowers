# P2 三处「静默失败」：企微绑定自愈 / MCP 读工具接权限 / 派单选人

- 日期：2026-11-08
- 起点：`main` @ `bf27839`
- 计划：`2026-11-07-finish-gaps.md` §P2 的最后三项
- 提交：`372f487`（派单选人）→ `5d52a0b`（MCP 接权限）→ `22138e3`（企微绑定自愈）
- 结论：三项各自有了**可执行的规则 + 会红的用例**；全量 **1266 passed / 1 skipped**
  （新增 18 条），`tsc --noEmit` 干净；`flowers` 仍是 **815 条需求（803 条 `legacy_ref`
  非空）**，`events` 860 行、`notify_deliveries` 0 行——测试一行没碰真库（附 §5）。

## 0. 为什么这三项算一类

前四次修的都是同一件事：**系统做了一件对的事或错的事，而没有人能看见。**
（`mergeHistory` 吞掉退出码、`ensureHistory` 写一半、`--reset` 能删掉 803 条、导出口
在列头没有入口。）

这三项是同一条线上的三格：

| 项 | 出错时的样子 | 谁会发现 | 多久之后 |
|---|---|---|---|
| 企微绑定失效 | 推送静默变成 `skipped`，摘要里多一个数字 | 那个人自己 | 几周（「最近怎么没收到通知」） |
| MCP 读工具不接权限 | agent 被告知一堆「它的人做不到」的动作 | 没人——直到 agent 照着做，撞一次「你不是评审人」 | 每次会话 |
| 同线多负责人派单 | 永远派第一个人；本人也能派给自己 | 没人 | 永远 |

三项的修法共用一条口径：**改的必须是「唯一口径」那一处**，不是再加一层判断。
所以在实现上它们分别落到了 `can()`（权限）、`addressed`（谁收到）、`assignReviewer`
的一条 `order by`（派给谁）——三处都已经是各自规则的唯一来源。

---

## 1. Item 1 · 企微绑定自愈

### 1.1 规则（可执行版）

`checkWecomBindings(db, now)`（新文件 `src/core/notify/self-heal.ts`）。对每一个
`deactivated_at is null` 的成员：

1. `prefsOf(notify_prefs).wecom === 'off'` → **跳过**。关掉是「我不要」，不是「我收不到」；
   替人报警等于不听话，而且会把超管的铃铛变成一台坏掉的打印机。
2. `wecom_userid` 为空 → 候选（`reason: 'missing'`）。
3. 否则取该成员 `channel = 'wecom'` 的最近 `FAILED_STREAK = 3` 行投递：**行数够 3 且没有
   一条是 `sent`** → 候选（`reason: 'failing'`，`streak = 3`）。中间夹一条 `sent` 不算
   （通道是通的，那是偶发抖动）；不足 3 行也不算（还没攒够证据）。
4. 候选 → 在事务里按成员 `pg_advisory_xact_lock(hashtext(member_id))`，再判
   「今天（`payload.day`）已经有一条吗」，没有就写一条事件。

**每人每天最多一条**的判据是 `payload.day`——与 `clock/tick.ts` 的 `shanghaiDayOf`
**同一个整数天数**（自 epoch 起第几天，按 Asia/Shanghai）。不按事件时刻判：`events.at`
是数据库的 `now()`，而「今天」必须跟着被 tick 的那一天走，否则一次补跑（注入过去的
`now`）会把别人的当日额度吃掉。

### 1.2 走的是哪个通道（没有第二个）

站内通知在这套系统里**没有表**：它是 `events` 的投影（`src/core/read/notify.ts`）。
所以这一项写的是**一条事件**：

```
type = 'member.wecom_unlinked'   requirement_id = null   actor = 'system'
payload = { memberId, memberName, reason, streak, day }
```

读模型加了三处，缺一不可：

1. `addressed()` 多一个或项：`e.requirement_id is null and e.type = 'member.wecom_unlinked'`
   —— **只有超管**（`role = 'product_owner'`）。刻意不排除「自己做的事」：这条是
   `actor = 'system'` 写的，不属于任何人。
2. 四处查询（铃铛 / 红点 / 水位线 / 推送候选）统一用 `EVENTS_FROM` + `ALIVE` 两个片段：
   把 `join requirements` 换成 **`left join`**，并把 `r.deleted_at is null` 改成
   `(r.deleted_at is null or e.requirement_id is null)`。
   为什么必须一起改：`inner join` 会把「没有需求的事件」整类扔掉；而 `left join` 之后
   `r.deleted_at is null` 对 NULL 行恒为 NULL（= 被过滤），只改一半仍然一条读不到。
   四处共用一个片段，是因为「铃铛有 3 条、红点 2 条」这类分歧就长在「四处各抄一遍」上。
3. 扇出那条老规则加上 `e.requirement_id is not null`：它说的是「**需求**变更」，不加这条，
   超管会连同 `release.created / updated / deleted` 一起收进来——那是这次改动之外的一整类
   新噪音，属于顺手改了别人的口径。

`classes.ts` 里归 **`action`**（「要你做」）。不是 `change`：默认档 `key` = 动手 + 结果，
归 `change` 就等于**白报**（超管默认收不到，而这一项的全部意义就是让他收到）。
企微推送那边不用另写：候选走同一个 `addressed`，超管的手机因此也会响（若他绑过）。

### 1.3 接线位置与顺序

`tickThenDispatch()`（`src/core/notify/dispatch.ts`，`scripts/wecom-dispatch.ts --tick`
是 cron 入口）：`tick` → `dispatchWecom` → `checkWecomBindings`。

- 排在推送**之后**：它看的是「最近几条投递发出去没有」，而这一轮的投递正是刚写下的。
  排在前面，判断依据永远是上一轮的——一条今天刚坏的绑定要等下一轮才发现，而一天只跑
  几次的 cron 就是几个小时。
- `--dry-run` **不跑**：自检要写事件（提醒本身），而预览的语义是「什么都不改」。
  返回空数组 + 脚本打一行「dry-run 不跑」，而不是预测「会提醒谁」——预测要么是第二份
  实现，要么就是一个会撒谎的数字。
- 不放进 `tick()` 的事务：`tick` 是「状态机在时钟上的一次推进」，必须一个事务全成或全不动；
  自检是另一件事，而且它一进 `tick`，每个调用 `tick` 的脚本与用例都会顺手写 7 条提醒。

### 1.4 文案（两处必须说同一句话）

- 铃铛一行（`memberLineOf`）：
  - `missing`：「吕品」还没对上企微账号，通知发不出去——去设置里点一次「查一下」
  - `failing`：「吕品」的企微账号最近 3 条通知都没发出去——去设置里点一次「查一下」确认企微账号
- 企微消息：第一行加粗「企微绑定提醒」，第二行就是上面那句话（`sentenceOf` 的兄弟函数，
  与铃铛共用同一份措辞）。
- 铃铛点开：`requirementId === null` → 去 `/settings`（拼 `?open=null` 会开一个空抽屉，
  看起来像点坏了）。

**文案里必须带「点查一下」**：只说「绑定有问题」是把诊断结果丢给人；他要的是下一步动作，
而设置页上那个按钮就叫「查一下」。

### 1.5 变异表（Item 1）

`tests/wecom-self-heal.test.ts`（8 条）。

| # | 变异 | 期望 | 实测 |
|---|---|---|---|
| 1 | 删掉「今天已报过」的判断（无条件插） | 同一天两次只剩一条 → 红 | 1 红 |
| 2 | 忽略 `wecom: 'off'`（`if (false) continue`） | off 的人不报警 → 红 | 1 红 |
| 3 | 只看 `missing`，不读投递失败 | 连续失败报警 → 红 | 1 红 |
| 4 | 事件归 `change`（不是 `action`） | 默认档超管看不到 → 红 | 3 红 |
| 5 | 扇出不分超管（人人都收） | PM 收不到 → 红 | 1 红 |
| 6 | `tickThenDispatch` 里不调自检 | 一次 tick 后有一条 → 红 | 3 红 |

第 4 条是最值得记的一条：它证明「分类」不是文案层面的装饰——同样的代码、同样的文案，
只把 `action` 改成 `change`，默认档的超管就**一条都收不到**，而所有别的用例仍然是绿的。

---

## 2. Item 2 · MCP 只读工具接权限

### 2.1 规则

`requirement_show` 的 `actions` / `permissions` 一律是
`visibleActions(state, actor, facts)` / `permissionsFor(actor, facts)`——与抽屉、动作条
**同一个 `can()`**。actor 来自 token：`activeMemberByName(db, identity.member)`。

- 查不到这一行（停用 / 已删）传 `null`：`getRequirementDetail` 对 `null` 给**空动作 +
  全 false 权限**。不退回「状态允许的全部」——一个 token 换了主人不该凭空看见动作。
- `permissions` 也进返回体：只给 `actions` 会让 agent 用「有动作」去猜「能不能改描述」，
  而两者本来就来自同一次 `can()` 的五个格。
- `facts`（`ownerMemberId` / `ownerLine` / `state` / `reviewerMemberId`）全部由读模型从
  **那一行**读出来，不由工具层拼——「这条需求归谁管」不接受调用方的口头断言。

只改了 `showTool`。`requirement_list / prd / prd_refresh / uemaster_plan` 不返回动作或权限，
加传身份只是多一次查询、零行为变化，所以没动——但那也意味着「下一个人加一个返回动作的读
工具时会不会传身份」仍然靠自觉（见 §5）。

### 2.2 变异表（Item 2）

`tests/mcp-tools.test.ts`（24 条，其中 3 条新加）。

| # | 变异 | 期望 | 实测 |
|---|---|---|---|
| 1 | `getRequirementDetail(requirementId)`（不传身份，回到 p4-05） | 两个 token 两份动作 / PM 只读 / 停用清空 → 红 | 4 红（含被改写的旧用例） |

一条变异红掉四条用例，是因为那四条从四个角度问同一个问题：同一条需求两个 token、
别人的需求、停用的 token、以及「服务被调用时带了谁」。

### 2.3 一处不得不改的既有断言

`tests/mcp-tools.test.ts` 里原来那条 `expect(parsed.actions).toEqual(['reviewPass',
'reviewReject', 'shelve'])` **必须**改成 `['shelve']`：默认身份是吕品（该需求的负责人，
PM），待评审状态下签字不归他。它红的那一下正是这一项的证据——旧值就是那个 bug。
`tests/auth.test.ts` 的一个本地 helper 参数类型（`Array<{requirementId: string}>`）跟着
`Notice.requirementId` 变可空而放宽，只影响类型。

---

## 3. Item 3 · 同线多负责人时的派单选人

### 3.1 规则

`assignReviewer`（`src/core/requirements/review.ts`）的候选 = 该条线、该角色、在职的成员。
`order by` 三条：

```sql
order by (m.id = $owner) asc,            -- 1. 不是需求负责人本人
         act.last_at desc nulls last,    -- 2. events 里最近有活动
         m.id asc                        -- 3. 平手时稳定
limit 1
```

- **第 1 条是唯一有实质后果的**：本人签自己的字，评审这道关口就空了，而界面上一切正常
  （有条派单、有人能签、点了就通过）。
- **第 2 条**：轮班 / 代管场景下，最近还在动的人更可能是这周值班的那个。不看活动时，
  两个人永远按 id 取第一个 = 「同线两人」又变回「只有第一个」。
- **第 3 条**：只为「同一份输入给同一个答案」。派单结果进了 `review_assignments`，
  每次跑都不一样的派单会让「谁该签」变成掷骰子。
- `nulls last` 是必须的：PG 的 `desc` 默认 **NULLS FIRST**，少了它「一条事件都没有的人」
  会排到「刚动过的人」前面，第 2 条就反了（变异 3 专门钉这一格）。
- 活动时刻用 `left join lateral (select max(e.at) where e.actor = m.name)`：`events.actor`
  存的是**名字**不是 id（P1 的口径）。用 left join 而不是 where：刚配上、还没干过活的人
  不能被过滤掉，否则「新负责人永远排不上队」。

**「避开本人」是偏好，不是禁令。** 线上此刻两条线各只有一位负责人，其中 54 条
「收集 / 待设计」的需求就归这两位本人；改成 `where m.id <> owner` 会让这 54 条下一次提交
评审当场 `no_reviewer`。所以本人排在最后，但只要他是唯一候选，仍然是答案——谁在什么时候
签了自己的需求，看 `review_assignments` 那一行就能看出来。

### 3.2 变异表（Item 3）

`tests/reviewer-pick.test.ts`（7 条）。成员用**固定 uuid** 插入，让「按 id 选」与
「按规则选」给出不同答案——否则「只按 id 的实现」也能绿。

| # | 变异 | 期望 | 实测 |
|---|---|---|---|
| 1 | 去掉第 1 条（非本人） | 派给另一个人 → 红 | 5 红 |
| 2 | 去掉第 2 条（最近活动） | 活动胜过 id → 红 | 2 红 |
| 3 | 去掉 `nulls last` | 「没活动过」不排前面 → 红 | 3 红 |

第 1 条的变异红了 5 条而不是 1 条，是因为那 5 条用例的 owner 都是同线负责人：去掉偏好
之后每一条都会派给「id 最小的人」，而好几条用例里那个人就是 owner 自己。

---

## 4. 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 全量测试 | `npx vitest run` | **51 files / 1266 passed / 1 skipped**（新增 18 条：7 + 3 + 8） |
| 类型 | `npx tsc --noEmit` | 干净 |
| 真库未被改 | `select count(*)` ×4 | requirements **815**、`legacy_ref` 非空 **803**、events **860**、`notify_deliveries` **0**、`member.wecom_unlinked` **0** |
| 变异 | 见 §1.5 / §2.2 / §3.2 | 每一条都被至少一条用例抓到（共 10 个变异） |

测试全程跑在 `flowers_test`（P0 的库选择 + `resetDb` 的库名守卫）。没有跑
`npm run seed -- --reset`（它会拒绝，那是正确行为）。

## 5. 已知的上限（写清楚，别让下一个人以为是完善的自愈循环）

1. **自检只报告，不修。** 修仍然要点「查一下」——解析 userid 要问企微通讯录，而「同名多
   命中」必须有人看一眼（`wecom.ts` 的 `pickUser`）。一个自动挑人的自愈会把「猜错人」变成
   静默的日常。
2. **「今天」跟着注入的时钟走。** 一次补跑（`now` 是历史时刻）会用那一天的额度；数据库里
   的 `events.at` 是真实发现时刻。两者只在补跑时分叉，这是刻意的（见 §1.1）。
3. **超管的绑定坏掉时，他会收到一条关于自己的提醒**，这条提醒自己也会去推送、失败、
   第二天再触发一次。这是有意的：一个收不到通知的超管更需要知道这件事。有界（每天一条）。
4. **提醒不会因为修好了而撤回**：账本只追加。修好了只是下一天不再新增。
5. **`member.wecom_unlinked` 的查询对 `events` 做 `payload::jsonb` 过滤**，没有索引
   （不加迁移）。现在 860 行，一次全表扫描；事件流到十万行时这里应该有一个表达式索引
   `((payload::jsonb ->> 'memberId')) where type = 'member.wecom_unlinked'`。
6. **派单的活动时刻没有索引**：`events(actor)` 不存在，`left join lateral` 会对每个候选
   （2–3 人）扫一次 `events`。当前规模可以忽略，事件流变大后要加索引或改成一次聚合。
7. **MCP 只在 `requirement_show` 上接了权限。** 别的读工具今天不返回动作，所以没接；
   「下一个返回动作的读工具会不会传身份」没有机制保证（见 §6）。

## 6. 有更多时间，我会做的那一件事

**把「绑定健康」做成一个状态，而不是一串事件。**

现在「吕品收不到通知」这件事只能从两条路读出来：今天的提醒事件（有/没有），或者自己去数
`notify_deliveries` 里连续几条没有 `sent`。超管真正要问的是「**现在**谁收不到」——一个
`select` 就该回答的问题，现在要数事件流才知道，而且「坏了 14 天」与「坏了 1 天」在铃铛里
长得一样。正确形状是一个成员级的健康行（`wecom_userid` 之外再存 `wecom_health` +
`wecom_health_since`），提醒只是它的一次投影——「一天一条」也就变成「状态变化时才写」，
不需要 `payload.day` 去重，也不需要 advisory lock。

我这一轮没做，因为没有迁移窗口（而且「不加迁移」是这一批的约束）。但下一次为通知做表结构
时，这件事应该先做——否则每加一类「某人收不到」的检查，都会再长一个 `payload.day`。

另外两件小一号的：

- **`getRequirementDetail` 的 `actor` 应该变成必填。** 现在「不传身份」这条口子留在生产
  签名里（`actor?: Member | null`），靠调用点自觉传。把它改成必填、把 `actionsFor(state)`
  那条路收进测试专用入口，下一个人就不会再漏一个读工具——这一类「参数可选 = 可以忘记」
  的坑，这个仓库在 `owner_member_id` 上已经踩过。
- **派单的「唯一候选是本人」应该有一条可见的警告**（事件流里一行「这条由本人签字」），
  而不是只留在 `review_assignments` 里等人去查。它是数据、不是错误，但现在读不出来。
