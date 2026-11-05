# SDD ledger — plan: docs/superpowers/plans/2026-11-05-flowers-gate-p1-core.md

Spec: docs/superpowers/specs/2026-11-05-flower-gate-product-design.md（已复制进本仓库，随代码走）
Worktree: ~/flowers 分支 feat/p1-core（空仓库 main 无 commit，故直接建分支）

## 预检扫描（分发 Task 1 前）

| 检查 | 发现 |
|---|---|
| T1 schema ↔ T6 review_assignments | 表在 T1 建、T6 用；字段名一致（requirement_id / reviewer_member_id / verdict）✓ |
| T2 recordEvent ↔ T4,T5,T6,T7,T9,T10 | 签名 `(tx,{requirementId,actor,type,payload})` 六处调用一致 ✓ |
| T3 assertTransition ↔ T5,T6,T7,T9,T10 | ctx 两个键 hasPrd/hasType 一致；T9 的 test→dev 在 TRANSITIONS 里 ✓ |
| T6 assignReviewer ↔ T5 submitReview | **冲突**：T6 定义了 assignReviewer 但 T5 从未调用，且 T6 测试里的 reviewerOf 未定义 → 见 R1 |
| T7 schedule ↔ T8 tick | T7 写 release_id/window_start 依赖，T8 读同一组列 ✓ |
| T8 tick ↔ T9 bounce | tick 把 test 推到 live；bounce 在 test 里把状态拉回 dev。同一状态两个出口，顺序上 bounce 先于 tick 生效需应用层保证 → 见 R4 |
| T4 测试内部自洽 | 用了 `sql` 但没 import → 见 R2 |
| T8 测试内部自洽 | 缺 vitest 与 resetDb/seedPeople 的 import → 见 R3 |
| T1 events.seq | `max(seq)+1` 有并发写风险，单写入方下可接受 → 见 R5 |

### 裁决

- **R1**：Task 6 除新建 review.ts 外，**还要改 submit-review.ts 在进入 review 时调用 assignReviewer**，并在 `tests/helpers/factory.ts` 补 `reviewerOf(requirementId)`。代价：若错，评审派单可能派错人，返工 T6。
- **R2**：Task 4 测试顶部补 `import { sql } from 'drizzle-orm'`。代价：测试编译不过，几分钟。
- **R3**：Task 8 测试顶部补 `import { describe,it,expect,beforeEach } from 'vitest'` 与 `resetDb, seedPeople`。代价：同上。
- **R4**：tick 与 bounce 竞争同一状态时，以「先执行用户动作，再跑 tick」为准（应用层顺序），本轮不在 tick 里加锁。代价：极端情况下一次 tick 可能把刚打回的需求又推上线，需 P3 加 guard。
- **R5**：events.seq 用 `max+1` 接受单写入方假设，P2 引入多写入方时换成 sequence。代价：并发落事件可能撞主键。

### R6（Task 1 期间发现的真实占用）
`Flower` 项目长期占用 54329。裁决：flowers 默认改用 **54330**，不改动 flower-postgres-1（它在跑另一个项目的库）。
代价：若错，后续任何命令要用回 54329 需同时改 compose 与 client.ts 默认值。

- Task 1: fix round 1/5（1 addressed, 0 open — 默认端口 → 54330；commit eaec0c1..aa5cab2）

### Task 1 期间接受的偏离（计划外，但必要）
- **R7** 迁移输出改到 `src/db/migrations`（`drizzle/` 在 .gitignore 里，迁移必须入库）。代价：与 brief 字面不符，需在后续任务里保持一致。
- **R8** 加 `@types/node`（tsconfig 有 `types:["node"]`）。代价：无。
- **R9** 加 `skipLibCheck`（19 条 tsc 错全在 drizzle-orm 的 .d.ts 里，自身源码 0 错）。代价：第三方类型错误不再暴露。
- **R10** `tests/helpers/factory.ts` 首行 `// @ts-nocheck`（它 import 的 5 个模块到 Task 5-7 才有）。**Task 7 完成后必须删掉这行并重跑 tsc**。
- **R11** 提交 `package-lock.json`（可复现）。代价：无。

- Task 1: complete (commits dd13afc..aa5cab2, review clean — Approved，0 Critical / 1 Important 已在计划文档修掉 / 7 Minor 见下)
- **R12**: 评审指出的 Important 不在代码里，在**计划文档**：6 处仍写 54329 与 `./drizzle`。已直接改计划（端口→54330、迁移目录→`./src/db/migrations`）。代价：若错，任务 2-10 的分支说明会带错值。
- Task 1: minor (deferred): schema 测试只断言索引名、未验唯一性行为
- Task 1: minor (deferred): 4 个外键仅手工 psql 验证，无测试守护
- Task 1: minor (deferred): 缺 globalSetup 自动迁移，全新克隆首次跑测试会 relation does not exist
- Task 1: minor (deferred): src/db/migrate.ts 顶层副作用 + 失败路径不关池
- Task 1: minor (deferred): src/db/client.ts 缺 pool.on('error')
- Task 1: minor (deferred): package.json 无 engines node>=22
- Task 1: minor (deferred): tests/helpers/schema.test.ts 位置与 helpers 混放
- Task 2+3: 合并分发（两个同形小模块），commit eaa6bc0，12/12 测试 + tsc 0 错
- Task 2+3: 评审 Needs fixes — 0 Critical / 1 Important（守卫路径测试只比消息，不比 code/类）/ 7 Minor
- Task 2+3: minor (deferred): afterAll(pool.end) 在 describe 内而非文件级
- Task 2+3: minor (deferred): events.payload 收 unknown 会让 undefined 变 NULL 撞 notNull
- Task 2+3: minor (deferred): seq=max+1 并发写会撞主键（已记录，待 P2 换 sequence）
- Task 2+3: minor (deferred): recordEvent 未证明用了 tx 而非 db
- Task 2+3: minor (deferred): TRANSITIONS 导出可变数组
- Task 2+3: minor (deferred): isClockTransition 对非法对会抛而不是返回 false
- Task 2+3: minor (deferred): 无运行时状态常量表，Task 4 校验时可能需要
- Task 2+3: fix round 1/5（1 addressed, 0 open — 守卫断言改为 caught() + toMatchObject 钉 instance/code/message；commit eaa6bc0..47754c6）
- Task 2+3: complete (commits 252ba38..47754c6, review clean)
- **R13（标准指令，携带到 Task 4-10）**：新增断言必须同时钉住「instanceOf AppError + code + message」，禁止裸 `toThrowError(new AppError(...))`（在 vitest 里只比 message）。代价：测试稍长，但错 code 不再漏网。
- Task 4: commit cb00ac4，19/19 全过 + tsc 0 错；实现者自带变异探针（拆事务、max↔count）与触发器原子性证明
- Task 4: 评审 Needs fixes — 0 Critical / 2 Important（ownerMemberId 与非对象 body 漏英文消息；原子性用例的错误断言没钉 class/code）+ 触发器夹具非幂等（同轮加固）
- Task 4: minor (deferred): tests:78 对"校验在事务前"的归因过度
- Task 4: minor (deferred): 重复实现 requirementCount
- Task 4: minor (deferred): create.ts:42 `as 'inbox'` 绕过类型系统
- Task 4: minor (deferred): 并发取号抛原始 23505 而非 AppError
- Task 4: minor (deferred): ownerMemberId 正例未测
- Task 4: fix round 1/5（2 addressed + 1 hardening, 0 open；commit cb00ac4..7f8d998）
- Task 4: complete (commits 47754c6..7f8d998, review clean)
- **R14**：复核指出「测试进程被杀 → 残留 boom 触发器会毒化后续事件用例」。裁决：不为此单开一轮，把 `drop trigger if exists` 加进 `resetDb()` 的活并入 Task 5 分发（Task 5 本来就要往同一文件追加测试）。代价：若错，Task 5 起首跑可能被触发器打死一次。
- Task 5: commits d1ba292 + 72ce3ed（自查抓到 prdUrl 缺失抛 TypeError → 归一为 missing_prd）；34/34 全过；R14 已在 resetDb() 落地（触发器 true→false 实测）
- Task 5: 评审 Needs fixes — 0 Critical / 1 Important（两个服务入口不校验入参对象与 uuid → TypeError / PG 22P02 而非 AppError，与 create.ts 约定不一致）+ 8 Minor
- Task 5: minor (deferred): evaluate.ts hasPrd:true 是惰性不实声明
- Task 5: minor (deferred): 两处 `as never` 可换 `as State`
- Task 5: minor (deferred): 并发用例未断言 review_requested 恰 1 条 / prd_url 属赢家
- Task 5: minor (deferred): 缺 evaluate 并发、missing_type、event 回滚三类覆盖
- Task 5: minor (deferred): prdUrl 不校验形态
- Task 5: minor (deferred): 两服务重复 6 行锁行模板（第三次出现时抽 lockRequirement，预计 Task 9）
- Task 5: fix round 1/5（1 addressed, 0 open — 入口校验统一到 src/core/validate.ts；commit 72ce3ed..69d9f91）
- Task 5: complete (commits 7f8d998..69d9f91, review clean)
- Task 6: commit 5d75d95，73/73 全过；R1 接线完成（review.ts 单向依赖）；自查抓到两个真 bug（reject 借道 inbox→design、REVIEWER_ROLE 原型链查表）并修掉
- **R15**：类型两种失败拆成两个 code——未知类型 `invalid_type`、类型合法但无该角色成员 `no_reviewer`。代价：控制器要分支两次；若错，历史脏数据会报「类型不认识」而非「没配评审人」。
- **R16**：factory.ts 里对 schedule.js 的前向引用改成 makeReadyAt 内动态 import（静态引用会让整文件在 Task 7 之前解析失败）。Task 7 完成后应改回静态 import。
- Task 6: 评审 Needs fixes — 0 Critical / 1 Important（no_reviewer 只钉 code 未钉 message，违反 R13）+ 8 Minor
- Task 6: minor (deferred): REVIEWER_ROLE 导出零消费者
- Task 6: minor (deferred): `where not exists` 兜底不可达且非竞态安全，缺 partial unique index
- Task 6: minor (deferred): review.ts:78 复制了 state-machine 的消息模板
- Task 6: minor (deferred): 缺类型时会报 invalid_type 而非 missing_type
- Task 6: minor (deferred): pass/reject 约 90% 重复
- Task 6: minor (deferred): review_requested payload 未带指派到的评审人
- Task 6: fix round 1/5（2 addressed, 0 open；commit 5d75d95..e4ecede）
- Task 6: complete (commits 69d9f91..e4ecede, review clean)
- Task 7: commit 25786f4，94/94 全过；@ts-nocheck 与 factory 动态 import 均已清除（注入错误证明真在类型检查内）；抓到 timestamptz 字符串比较 NaN 陷阱
- Task 7: complete (commits e4ecede..25786f4, review clean — Approved，0 Important / 11 Minor)
- Task 7: minor (deferred): release 侧解析缺 Invalid 守卫
- Task 7: minor (deferred): 日期格式只承诺不校验（'2026' 会被接受）
- Task 7: minor (deferred): schedule 传了伪造的 hasPrd/hasType
- Task 7: minor (deferred): releaseId 未 uuid 校验（与 requirementId 不对称）
- Task 7: minor (deferred): 审计 payload 存用户原始字符串而库里存 ISO
- Task 7: minor (deferred): due==release_date 的相等依赖 DB 会话时区为 UTC
- **R17**：tick 不为「刚被打回的行」特判——打回后 commit_test_at 未变，下一次 tick 会立刻把它推回测试中。行为保留（语义上仍处测试窗），但必须用一条测试把这个交互钉死并写进报告。代价：若非预期，需在 Task 9 补一条 guard。
- Task 8: commit a076374，115/115 全过
- **R18**：计划第 4 条 tick 用例自相矛盾（fixture 里 commit_test_at == window_start，01:00 那次 tick 合法地把 dev 推到 test，却断言 0 移动）。裁决：保留断言语义（第二次 tick 不重复推进），把该 fixture 的 commit_test_at 改成 12-03。计划文本有错，spec 优先。代价：与 brief 字面不一致。
- **R19**：按 Asia/Shanghai **日历天**比较，而非瞬时比较。计划 Global Constraints 明写「天按 Asia/Shanghai 计算」；brief 字面的 `now >= new Date(window_start)` 会因 8 小时时差让第一条用例必挂（实测 19 红）。代价：跨时区部署时语义是「自然日到点」，不是「瞬时到点」。
- **R20**：缺 deadline / release_id 的行让整次 tick 回滚失败（不做跳过）。理由：这种行只能由直接改库产生，属于数据损坏告警；服务层保证不可达。代价：一行脏数据会冻住整条时钟 —— P3 接 cron 时必须告警而非静默重试。
- Task 8: 评审 Needs fixes — 0 Critical / 2 Important（release_id 只在 ready 状态被发现；并发用例失败路径泄漏未关闭事务，会让下一次 resetDb 卡死）+ 9 Minor
- Task 8: minor (deferred): tick 会锁住全部在途行（convoy，无死锁循环），SQL 侧预筛留给 cron 任务
- Task 8: minor (deferred): tests:229 注释描述的失败机制写错（实际写 dev 两次）
- Task 8: minor (deferred): 并发断言隐式依赖 commit_test_at 晚于 tick 时刻
- Task 8: minor (deferred): waiter 轮询走同一连接池且谓词是全局的
- Task 8: minor (deferred): NEXT[row.state as ...] 需要 Partial<Record> 去掉断言
- Task 8: minor (deferred): shanghaiDayOf 应抽到 clock/day.ts 供 Task 9/10 复用
- Task 8: minor (deferred): caught 在 requirements.test.ts 里被复制
- Task 8: fix round 1/5（2 addressed + 1 comment fix, 0 open；commit a076374..00f5665）
- Task 8: complete (commits 25786f4..00f5665, review clean)
- Task 9: two commits a722457（抽出 lock.ts，测试零改动）+ cde3553（bounce，+25 测试），143/143
- Task 9: TDD 第三轮抓到 brief 代码里的真 bug —— assertTransition 接受 ready→dev（时钟转移），bounce 会让 ready 直接跳到 dev、跳过整个开工窗口；已用 trigger 钉死
- **R21**：bounce **不**校验新完成日是否晚于版本发版日。理由：打回本来就意味着原承诺已不现实，硬卡会让「迟到的需求」无处可去；超期由版本页呈现为延期。代价：可能出现完成日晚于发版日的需求，需要版本页看得见。
- **R22**：接受新增 `bad_new_due` /「打回必须填有效的承诺完成日」。理由：单日期路径复用 `bad_dates` 会描述错误对象，且不校验会让 `Invalid Date.toISOString()` 抛 RangeError。
- Task 9: 评审 Needs fixes — 0 Critical / 1 Important（过去的 newCommitDueAt 被接受，两拍 tick 直接把需求推到已上线）+ 7 Minor
- **R23**：bounce 拒绝早于「今天」（Asia/Shanghai 自然日）的新完成日，`bad_new_due` /「承诺完成日不能早于今天」；今天本身合法。代价：想做「补一个昨天的日期」会被挡住，需要改今天。
- Task 9: minor (deferred): 「不能从「x」直接到「y」」消息模板已在三处重复，会漂
- Task 9: minor (deferred): review.ts 的 assertReviewTransition 仍是 `from: string` + as never，与 bounce 的干净写法不一致
- Task 9: minor (deferred): Locked.state 是把 text 列断言成 State
- Task 9: minor (deferred): moveTo 的 extraSet 不变量只在文档里
- Task 9: minor (deferred): 缺 double bounce 并发用例
- **待记录（symmetry gap）**：schedule 目前只卡上界（不可晚于发版日），没有下界；同一类「过去日期导致瞬间推进」风险仍在。留给最终审查或下一期。
- **R24**：bounce 增加可注入 `now`（默认 `new Date()`），修掉 R23 引入的测试时间炸弹（'2026-12-10' 之后必挂）。签名与 `tick(db, now)` 同形。代价：多一个参数；若错，生产调用方需注意默认值。
- **待产品确认（不阻塞 P1）**：schedule 是否也给 commitDueAt 加「不早于今天」下界——需先确认「补排过去日期」是不是必需工作流。
- Task 9: fix rounds 1-2/5（2 addressed, 0 open；commits cde3553..bc0d93a）
- Task 9: complete (commits 00f5665..bc0d93a, review clean)
- Task 9: minor (deferred): tick.ts:119 内联了它自己导出的 shanghaiDayOf（同式两份），bounce.ts:30 注释「全库只有一处」因此不准
- Task 9: minor (deferred): tests:969 注释对 mutant 的描述不成立
- **待产品裁决**：bounce 允许 due == 今天，该类行两次 tick 内即 dev→test→live（R23 只挡昨天）。要不要连今天也拒？
- Task 10: commit 9447f38，197/197 全过；搁置规则用穷尽 switch（加状态会 tsc 失败）而非黑名单；搁置作废 handed 派单（否则恢复后永远派不出人）
- **R25**：`live → shelved` 合法（spec §3 明写「每个状态都可搁置，已拒绝/已搁置除外」）。代价：已上线需求可被搁置，需在版本页可见。
- **R26（计划缺陷）**：验收标准里的 `scripts/demo.ts` 冒烟脚本从未分配给任何任务。裁决：在最终整支审查后单开一个小修复派发补上。
- Task 10: complete (commits bc0d93a..9447f38, review clean — Approved，0 Important / 12 Minor)
- **R27**：`skip_reason` 在**恢复**时清，不在搁置时清（搁置期间保留历史，恢复=这一轮重启才清）。评审认为现在写法更好，采纳。代价：搁置中的行仍带跳过标记，按 skip_reason 统计捷径时会计入搁置项。
- Task 10: minor (deferred): isShelvable 对越界值返回 undefined，声明类型撒谎（建议加 default: never 兜底）
- Task 10: minor (deferred): asText 已在两个文件逐字重复，应进 validate.ts
- Task 10: minor (deferred): terminal 三处 assertTransition 未钉 trigger
- Task 10: minor (deferred): payload 用 toMatchObject 断言，多写字段抓不到
- R26 补完: scripts/demo.ts 落地（commit 59d6603），跑通 inbox→…→live，8 事件，退出码 0；负控（改错期望）会 exit 1

## 最终整支审查（dd13afc..59d6603）
结论：**不可合并**，1 Critical + 8 Important。Critical 有实测数据（12 并发 evaluate 失败 5-9/12，全 23505），推翻了 R5。

- **R28（推翻 R5）**：`events.seq` 与 `requirements.number` 的 `max+1` 是假的单写入方假设——两个 PM 同时点一下就撞主键，且抛原始 23505（英文），破坏全支 AppError 边界。必须换 sequence，并兜底 23505 → AppError。代价：一次迁移。
- **R29（I6 裁决）**：评审签字必须校验签字人 == 该类型派单到的评审人，不符抛 `not_reviewer`。spec §2「评审人由类型决定，不是由人挑」不落到签字就是空话。代价：reviewPass/reviewReject 需要解析 actor→member。
- **R30（I7 裁决）**：拒绝/搁置的「原因必填」保留，**改 spec**（§3 第 3、4 行的门由「无」改为「原因必填」）。理由：事件留痕与 P3 通知都需要理由；一个没有 why 的拒绝在日志里等于没发生。
- **R31（I8 裁决）**：demo 的 resetDb 必须加库名守卫（`current_database() = 'flowers'` 或要求 `FLOWERS_ALLOW_RESET=1`），`resetDb` 从测试助手提到 `src/db/reset.ts`。

## 修复波（59d6603..cff0f97，8 commits）
220/220 测试、tsc 干净、demo exit 0；复审结论 **mergeable**。C1 用加回 max+1 反证（6/12 失败且落到 code:'conflict'）确认真死；删掉 ready→dev 会让 19 条测试红（含 12 条时钟用例），证明表重新成为权威。
- 修复波额外发现并修掉一个 reviewer 漏掉的生产洞：evaluate 曾能借 review→design 合法配对把待评审静默写回待设计
- Task 10 之后补的 23505→AppError 边界（`conflict`）、`not_reviewer` 签字门、序列 owned by 修正

### 残余（不阻塞合并，已裁决）
- **R32**：`review.ts:74-80` 用 `members.name` 标量子查询解析签字的 actor，而 `members.name` 无唯一约束；重名会抛英文 21000。P1 写路径不可达（seed 每次 truncate 后重建）。裁决：**park**，与延后的 `review_assignments` handed 部分唯一索引一起做（届时必须同时给 `assignReviewer` 的 insert 套 withPgErrors，否则新索引会引入未包装的 23505）。代价：重名成员在 P2 加成员管理后会成为真实故障。
- **R33**：`tick.ts:177` 在时钟行数为 0 时会渲染 `in ()` 触发 42601。已由三条测试禁止该状态。裁决：**park**。代价：微小。
- **R34**：计划文档两处（:386/:467）仍写 `isClockTransition`，代码已删。裁决：**不改历史文档**，spec 是权威且已更新；ledger 记在此处。代价：读计划的人可能去找一个不存在的函数。

## 收尾
- 分支 feat/p1-core，HEAD cff0f97，22+8=30 commits，220 tests，tsc 干净，demo 跑通。
- **未推送**：`SilasSolivagus/flowers` 远端仍是空仓库；推送是工作区外的副作用，等用户点头。
