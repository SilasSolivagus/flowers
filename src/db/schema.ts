import { sql } from 'drizzle-orm';
import {
  check, pgTable, pgSequence, uuid, text, timestamp, integer, index, uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * 两把并发安全的编号来源。
 *
 * 为什么不是 `max(col)+1`：那是一次无锁的「读—算—写」，两个事务读到同一个 max
 * 就会算出同一个值，输的那个撞唯一约束（events_pkey / requirements_number_unique）。
 * 行锁救不了它——不同的需求是不同的行，彼此之间根本没有互斥。
 *
 * 序列的 nextval 是原子的、不参与事务：并发调用只会拿到不同的值，回滚也不归还
 * （于是编号会有空洞，这是刻意的：编号的唯一用途是标识，不是计数）。
 *
 * OWNED BY 由迁移手写（drizzle 不表达 ownership）：`truncate ... restart identity`
 * 只重置「属于被清空表的」序列，测试靠它把编号复位到 1。
 */
export const eventsSeqSeq = pgSequence('events_seq_seq');
export const requirementsNumberSeq = pgSequence('requirements_number_seq');

/**
 * 花名册（P4-04 起它同时是账号表）。
 *
 * 四列是这一轮加的，各自的理由：
 *
 * - `line`：**人也属于条线**，不只是评审人。`feature` / `commercial` / null。PM 有
 *   条线（王妍在商业线、吕品在功能线……），条线负责人的 `line` 与他的角色必须对应。
 *   它参与两件事：负责人转交时「只能在自己这条线内转」（见 `core/auth/roles.ts` 的
 *   `can`），以及界面按线筛人。**权限判断不看这一列**——「谁是这条线的负责人」由
 *   `role` 决定（`feature_reviewer` / `commercial_reviewer`），那是唯一的映射来源；
 *   两列同时存在时，role 是权威，line 是展示与招聘（转交/建人）用的。
 * - `password_hash`：null = 这个账号还没有口令（老数据、或刚建还没设密码）。null
 *   一律按「登录失败」处理，绝不当成「空密码可以登」。格式见
 *   `src/core/auth/password.ts`（scrypt + 每人一个盐，参数写进串里，改参数不炸老行）。
 * - `password_updated_at`：改口令的时刻。它只有一个用途——审计（谁什么时候重置过）。
 * - `notify_prefs`：JSON 文本，P4-07 起是**两个频道 × 三档**：
 *   `{"site":"key","wecom":"key"}`（站点铃铛 / 企微推送 × 全部 / 只关键 / 关）。
 *   null 与缺字段都等于 `key`（只收「需要我动手」与「有结果」两类），这是产品定的
 *   默认档：默认给 `all` 会把超管按 48 条的量淹掉。为什么是文本而不是几张枚举列：
 *   口味会长（P4-03 只有两个布尔，这一轮是三档 × 两频道），每加一格就改一次表结构；
 *   解释权在 `src/core/notify/prefs.ts`，改口径不用改表（与 `app_settings.value`
 *   同一条理由）。校验在写入端（服务层），读侧对认不出的值一律回落 `key`。
 * - `deactivated_at`：**停用，不硬删**。`requirements.owner_member_id`、
 *   `review_assignments.reviewer_member_id`、`mcp_tokens.member_id` 三处外键都指着
 *   这一行，硬删要么被拦住，要么把「谁在哪天承诺了什么」一起删掉——那正是这个系统
 *   存在的意义。停用后：登录被拒（与密码错同一句话）、不再收通知、不出现在负责人
 *   下拉里；历史行仍然指向他。
 */
export const members = pgTable('members', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  // 'product_owner' | 'feature_reviewer' | 'commercial_reviewer' | 'pm'
  role: text('role').notNull(),
  // 'feature' | 'commercial' | null
  line: text('line'),
  passwordHash: text('password_hash'),
  passwordUpdatedAt: timestamp('password_updated_at', { withTimezone: true }),
  /**
   * JSON 文本，P4-07 起是**两个频道 × 三档**：`{"site":"key","wecom":"key"}`。
   *
   * 解释权在 `src/core/notify/prefs.ts`：读不懂 / 缺字段 / 老形状一律回落到 `key`，
   * 不抛——一个读不懂的设置不该让通知静默消失。
   */
  notifyPrefs: text('notify_prefs'),
  /**
   * 企微通讯录里的 userid（P4-07）。null = 还没对上账号。
   *
   * 为什么要缓存：`wecom-cli contact users search` 是一次网络往返，而推送每次都要
   * 知道「发给谁」。名字→userid 只解析一次，之后只读这一列。
   * 企微的显示名带部门前缀（`产品经理-吕品`），所以匹配规则在
   * `src/core/notify/wecom.ts` 里，不在这一列上。
   */
  wecomUserId: text('wecom_userid'),
  /**
   * 上一次尝试解析 userid 的时刻（成功留档，失败也留档）。
   *
   * 失败也要写：它是「别再在这一个人身上反复问」的唯一依据，也是排查时说得出
   * 「上次试是什么时候」的那一格。失败原因不进这一列（它会过期），进
   * `notify_deliveries.error`。
   */
  wecomLookupAt: timestamp('wecom_lookup_at', { withTimezone: true }),
  deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  /**
   * 角色的 CHECK：四个值是服务层 `ROLES` 的同一份词表。它挡住绕过服务层的写入
   * （脚本直连、手改），与 `uemaster_jobs.status` 那条同一条口径——服务层给中文，
   * 库这一层守底线。
   */
  roleCheck: check(
    'members_role_check',
    sql`${t.role} in ('product_owner', 'feature_reviewer', 'commercial_reviewer', 'pm')`,
  ),
  lineCheck: check(
    'members_line_check',
    sql`${t.line} in ('feature', 'commercial')`,
  ),
  /** 名字是登录名：同名的两个人无法区分，登录会取决于 `order by id limit 1`。 */
  nameUnique: uniqueIndex('members_name_unique').on(t.name),
}));

/**
 * 版本（发版窗口）。
 *
 * P4-02 起多了三列：
 * - `goal` / `note` 是**版本自己的描述**，不是需求描述的一部分。owner 的原话是
 *   「新建版本时告诉最近一个版本是几号到几号」——那是对**上下文**的要求，而上下文
 *   的另一半恰恰是「这一版想干什么」。两列都可空：老版本行没有它们，也不该因为
 *   少一段描述就不能用。
 * - `deleted_at` 是软删除。版本行被需求通过 `requirements.release_id` 引用，
 *   `events` 里也有它的名字；硬删会把那些引用断在一个不存在的主键上（或者被外键
 *   直接拦住），于是「删掉一个建错的版本」会变成「删不掉」。软删之后读侧一律
 *   `deleted_at is null`，被删的版本从版本页、看板的版本标签、排期下拉里一起消失，
 *   但那条需求、那条事件仍然指向同一个 id。
 */
export const releases = pgTable('releases', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  releaseDate: timestamp('release_date', { withTimezone: true }).notNull(),
  goal: text('goal'),
  note: text('note'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const requirements = pgTable('requirements', {
  id: uuid('id').primaryKey().defaultRandom(),
  // PAN-1、PAN-2…：值来自 requirements_number_seq，不扫 max。
  number: integer('number').notNull().default(sql`nextval('requirements_number_seq')`),
  title: text('title').notNull(),
  type: text('type').notNull(),                              // commercial | feature
  state: text('state').notNull(),
  stateEnteredAt: timestamp('state_entered_at', { withTimezone: true }).notNull().defaultNow(),
  requester: text('requester').notNull(),                    // 只是字段，不是账号
  ownerMemberId: uuid('owner_member_id').references(() => members.id),
  prdUrl: text('prd_url'),
  skipReason: text('skip_reason'),
  releaseId: uuid('release_id').references(() => releases.id),
  commitTestAt: timestamp('commit_test_at', { withTimezone: true }),
  commitDueAt: timestamp('commit_due_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

  /**
   * 六个描述性问题（P4-02）：录入面唯一可编辑的东西。
   *
   * 为什么是这六问、为什么是**可空文本**而不是非空：
   * - 六问的用途只有一个——把「生成材料的 agent 需要知道的上下文」从人的脑子里
   *   搬到库里。缺哪一问，生成就会在那一处猜（`surfaces` 缺 → 流程图里会出现不存在
   *   的页面；`outcome` 缺 → 边界与异常只能靠猜），所以界面在缺的时候给一行提示；
   *   但**录入不该被拦下**：真实的需求常常是先建一条再补描述，把六问做成必填只会
   *   逼人造六个「无」。
   * - 可空而不是 not null default ''：历史行没有这些值，加非空列要回填一个假值
   *   （''），而 '' 与 null 在语义上是同一件事——「没写」。指纹函数因此把两者
   *   哈希成同一个值（见 `src/core/requirements/fingerprint.ts`）。
   * - 全部是 `text`：一问就是一段话，长度不设上限；界面里是 textarea。
   *
   * 列名与语义一一对应，界面上的标签就是这里注释的中文（两处只有一个来源：
   * `src/core/requirements/manage.ts` 的 `FIELD_FIELDS`）。
   */
  context: text('context'),          // 谁在什么情况下用
  problem: text('problem'),          // 现在怎么做 / 哪不好
  outcome: text('outcome'),          // 做成什么样算成功
  surfaces: text('surfaces'),        // 涉及哪些页面 / 入口
  edgeCases: text('edge_cases'),     // 失败 / 空 / 无权限怎么办
  outOfScope: text('out_of_scope'),  // 这次不做什么

  /**
   * 软删除（P4-02）。
   *
   * 只软删、不硬删：`events` 用 `requirement_id`（无外键、可空）指向需求，
   * `uemaster_artifacts` / `uemaster_jobs` / `prd_snapshots` / `review_assignments`
   * 四张表都是外键引用。硬删要么被外键拦住，要么把「谁在哪天承诺了什么」这条
   * 审计线一起删掉——那正是这个系统存在的意义。所以删除 = 打一个时间戳，
   * 读侧一律 `deleted_at is null`。
   */
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => ({ numUnique: uniqueIndex('requirements_number_unique').on(t.number) }));

export const reviewAssignments = pgTable('review_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  requirementId: uuid('requirement_id').notNull().references(() => requirements.id),
  reviewerMemberId: uuid('reviewer_member_id').notNull().references(() => members.id),
  verdict: text('verdict'),                  // handed | passed | rejected | voided
  reason: text('reason'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
}, (t) => ({ byReq: index('review_assignments_req').on(t.requirementId) }));

/**
 * UEmaster 产物：只存链接，不存正文（spec §5）。
 *
 * 同一 (requirement_id, stage) 允许多行：重做一次就是一条新版本，读侧取最新一条
 * （见 `src/core/uemaster/list.ts`）。所以这里是普通索引而不是唯一索引——写成
 * 唯一就再也交不了第二版，而「重做」是常态。
 *
 * stage 的 CHECK 写在表上、也写在服务层（attach.ts）：服务层给中文错误，CHECK 守住
 * 绕过服务层的写入（脚本、MCP 之外的直连）。
 */
export const uemasterArtifacts = pgTable('uemaster_artifacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  requirementId: uuid('requirement_id').notNull().references(() => requirements.id),
  stage: text('stage').notNull(),            // evaluate | review | inspect
  url: text('url').notNull(),                // http(s) 完整链接，或 / 开头的站内路径
  createdBy: text('created_by').notNull(),   // 成员名或 'agent'
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /**
   * 这份产物是照着哪一版描述生成的 = 那一刻需求的指纹（P4-02）。
   *
   * `src/core/requirements/fingerprint.ts` 的 sha256（十六进制）。读侧拿它与**当前**
   * 描述的指纹比：相等 → 产物还是新的；不等 → 「需求已更新」；null → 「版本未知」
   * （P4-02 之前落库的行，以及绕过生成器直接 attach 的行）。
   *
   * 为什么存成列、而不是在读的时候比对 `created_at` 与 `requirements` 的更新时间：
   * 时间先后**不等于**内容变了——改一个字再改回来，时间戳变了，产物却仍然是照它生成的。
   * 内容指纹是这件事唯一的正确答案。
   *
   * 为什么可空、且不允许「就地推算」：生成要跑 2–3 分钟，attach 发生在**之后**；
   * 若在 attach 那一刻现算指纹，中途有人改了描述，这次生成就会被记成「照着新版做的」。
   * 指纹必须在**读需求的那一刻**取（见 `start.ts` / `compose.ts` 的 loadRequirement），
   * 拿不到就存 null —— 存一个编出来的值比存 null 坏得多。
   */
  inputHash: text('input_hash'),
}, (t) => ({
  stageCheck: check(
    'uemaster_artifacts_stage_check',
    sql`${t.stage} in ('evaluate', 'review', 'inspect')`,
  ),
  byReq: index('uemaster_artifacts_req').on(t.requirementId, t.stage, t.createdAt.desc()),
}));

/**
 * 一次「让 Flowers 自己生成材料」的作业（P2.6）。
 *
 * 为什么作业要落库、而不是一个进程内的 promise：生成由 `claude -p` / `codex exec`
 * 这种 CLI 跑，几十秒到几分钟；它必须活过发出请求的那次 HTTP 往返（worker 是
 * detached 的），而界面要能问「那次生成怎么样了」。进程的内存里没有答案，只有这一行有。
 *
 * 三条约束各有分工：
 * - `status` 的 CHECK 让库自己拒绝第四种状态（服务层同时给中文错误，与 artifacts 同一条口径）。
 * - `(requirement_id, stage) where status='running'` 的唯一索引是**并发兜底**：
 *   服务层先 `select ... for update` 住需求行再查 running，是为了给用户一句中文；
 *   这条索引保证即使有人绕过服务层（脚本直连），同一个阶段也不会同时跑两次。
 * - `artifact_id` 可空且指向 `uemaster_artifacts`：成功才有产物；失败的那一行
 *   必须留着（error 里是用户要读的原因），不能因为「没产物」就被删掉。
 *
 * 行只增不改语义：一次生成一行。`finished_at` 为空就是还在跑（或进程被杀了，
 * 由下一次 `startGeneration` 的陈旧回收把它收成 failed）。
 */
export const uemasterJobs = pgTable('uemaster_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  requirementId: uuid('requirement_id').notNull().references(() => requirements.id),
  stage: text('stage').notNull(),            // evaluate | review | inspect
  status: text('status').notNull(),          // running | done | failed
  error: text('error'),                      // 失败原因原文（CLI 的 stderr 尾巴）
  artifactId: uuid('artifact_id').references(() => uemasterArtifacts.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (t) => ({
  statusCheck: check(
    'uemaster_jobs_status_check',
    sql`${t.status} in ('running', 'done', 'failed')`,
  ),
  stageCheck: check(
    'uemaster_jobs_stage_check',
    sql`${t.stage} in ('evaluate', 'review', 'inspect')`,
  ),
  runningUnique: uniqueIndex('uemaster_jobs_running_unique')
    .on(t.requirementId, t.stage)
    .where(sql`${t.status} = 'running'`),
  byReq: index('uemaster_jobs_req').on(t.requirementId, t.stage, t.createdAt.desc()),
}));

/**
 * 一次作业里**每一次对外动作**的痕迹（P2.13）。
 *
 * 为什么要有它：`uemaster_jobs.error` 只留得下**最后**那句话。一次生成最多问模型 3 次
 * 图 + 2 次页面 + 1 次构建，前几次被拒的原因（「只有 2 个节点、1 条连线」「这一页没有
 * 用 wt- 类」）在原来的形状里全部蒸发，于是 owner 看到「生成失败：…」时无法判断
 * 是「模型一直画不对」还是「key 没余额」。
 *
 * 为什么**不存提示词与回话**：提示词里是整份 PRD 与节点清单（几万字符），回话是 HTML；
 * 存下来会把这张表变成一个语料库，而排查要的是三个数字：问了多少、答了多少、卡在哪。
 * `prompt_chars` / `output_chars` 足够看出「模型返回了空内容」与「模型根本没写完」。
 *
 * 一行 = 一次模型调用或一次构建。`error` 就是**这一次**被拒/失败的那句话（成功为 null），
 * `attempt` 是这一阶段内的第几次（1 基）。作业最终那句话仍然只在 `uemaster_jobs.error`。
 */
export const uemasterJobAttempts = pgTable('uemaster_job_attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id').notNull().references(() => uemasterJobs.id, { onDelete: 'cascade' }),
  attempt: integer('attempt').notNull(),     // 阶段内的第几次（1 基）
  phase: text('phase').notNull(),            // flow | pages | build | locate | verify | findings
  model: text('model').notNull(),            // 这一次用的模型名（换模型后旧行仍有意义）
  promptChars: integer('prompt_chars').notNull(),
  outputChars: integer('output_chars').notNull(),
  error: text('error'),                      // null = 这一次通过了
  ms: integer('ms').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  phaseCheck: check(
    'uemaster_job_attempts_phase_check',
    sql`${t.phase} in ('flow', 'pages', 'build', 'locate', 'verify', 'findings')`,
  ),
  byJob: index('uemaster_job_attempts_job').on(t.jobId, t.id),
}));

export const events = pgTable('events', {
  // 单调递增：值来自 events_seq_seq，不扫 max。
  seq: integer('seq').primaryKey().default(sql`nextval('events_seq_seq')`),
  requirementId: uuid('requirement_id'),
  actor: text('actor').notNull(),
  type: text('type').notNull(),
  payload: text('payload').notNull(),        // JSON 字符串
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 站内通知的**已读位置**（P4-03）。
 *
 * 这张表里没有一条通知。通知是从 `events` 派生出来的（「这条事件该通知谁」是
 * 需求的函数，见 `src/core/read/notify.ts`），这里只记一个**水位线**：
 * 每个人读到事件流的哪一格。于是：
 * - 历史是免费的——第一次打开的人会看到所有曾经点到他的事件，因为派生是在读的
 *   那一刻做的，不是写入的那一刻；
 * - 没有第二份副本可以漂移——规则改了，旧事件按新规则重新解释（这是刻意的取舍：
 *   宁可让历史换一种说法，也不要让库存一份永远对不上的影子）。
 *
 * 主键就是 `member_id`：一个人一个水位线。`last_seq` 是 events.seq 的**闭区间右端**，
 * 读 = `seq <= last_seq`。单调不回退（写路径用 greatest 夹住），因为「已读」在
 * 一个水位线上只能表达「到这里为止」，表达不了洞——点一条新通知会把更早的一起
 * 认掉，这正是水位线的语义，报告里写明了为什么接受它。
 *
 * `updated_at` 只用于排查（什么时候读到这里的），读路径不看它。
 */
export const notificationReads = pgTable('notification_reads', {
  memberId: uuid('member_id').primaryKey().references(() => members.id),
  lastSeq: integer('last_seq').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 一次推送的痕迹（P4-07）。
 *
 * 为什么必须有这张表：企微的发送接口**不幂等**——我们这边没有一个「这条已经发过」的
 * 记号，一次重启、一次 tick 重叠、一次网络超时后重跑，都会让人收到第二条一模一样的
 * 推送。唯一索引 `(member_id, event_seq, channel)` 就是那个记号：同一格事件对同一个人
 * 在同一个频道上只可能有一行，于是「发过没有」永远只有一个答案。
 *
 * 三个状态各有分工：
 * - `sent`：CLI 回了 `success: true`。**只有它可以阻止下一次发送**——`sent_at` 是
 *   事后审计（什么时候发出去的），判定只看 `status`。
 * - `failed`：试过了，没成（CLI 报错 / 超时 / 没装 / 没授权）。`error` 是原文（已脱敏），
 *   下一次 tick 会**就地重试**（更新这一行，不是插第二行）。
 * - `skipped`：**没有尝试发送**，因为这一步缺前置（企微账号还没对上）。它与 `failed`
 *   分开，是为了让「我们没试」与「试了没成」在报告里不是一个数字。
 *
 * `event_seq` 不建外键：事件流是账本，投递是账本上的批注；批注不该反过来约束账本
 * （也免得 events 的 truncate/归档把审计行一起带走）。`member_id` 有外键，因为一行
 * 投递离开人就不可解释。
 */
export const notifyDeliveries = pgTable('notify_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  memberId: uuid('member_id').notNull().references(() => members.id),
  /** `events.seq`：投递的对象是**一条事件**，不是「这条需求」。 */
  eventSeq: integer('event_seq').notNull(),
  channel: text('channel').notNull(),        // site | wecom
  status: text('status').notNull(),          // sent | failed | skipped
  /** 失败 / 跳过的那句话（已脱敏）。sent 时为 null。 */
  error: text('error'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  channelCheck: check(
    'notify_deliveries_channel_check',
    sql`${t.channel} in ('site', 'wecom')`,
  ),
  statusCheck: check(
    'notify_deliveries_status_check',
    sql`${t.status} in ('sent', 'failed', 'skipped')`,
  ),
  /** 不重复发送的唯一保证。名字就是它的职责，报错里会带着它出现。 */
  onceUnique: uniqueIndex('notify_deliveries_once_unique')
    .on(t.memberId, t.eventSeq, t.channel),
  byMember: index('notify_deliveries_member').on(t.memberId, t.status),
}));

/**
 * 键值设置（P2.7 起）。
 *
 * 第一件住进来的东西是生成器命令（`generator.command`）与它上一次的测试结果
 * （`generator.test`）。为什么不新开两张列明确的表：设置这一层要回答的问题是
 * 「这个部署把这一格设成了什么」，键值表是它的最小形状；而键是**服务层常量**
 * （见 `src/core/uemaster/settings.ts`），不是散在代码里的字符串字面量。
 *
 * `value` 一律是文本：命令是一行 shell，测试结果是 JSON。库不解释它们——
 * 解释权在服务层，改口径不用改表。
 */
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * MCP 的 HTTP 端点用来换身份的 token（P4.1）。
 *
 * 为什么必须有一张表，而不是「一个环境变量里的密钥」：owner 选的是「整套状态机都
 * 交给 agent」——agent 能排期、能打回。而每一次这样的动作都会在 `events.actor` 上
 * 写下一行「谁承诺了哪一天」。一个匿名的共享密钥会让那一行失去意义，所以 token 必须
 * 绑到 `members` 上：**请求 → token → 成员 → actor**，服务层的签名一个字都不用改。
 *
 * 三条硬规矩：
 * - **只存 sha256**（`token_hash`），原文只在生成的那一秒出现在响应里。库被读走时，
 *  里面的东西换不成一个能用的 token。为什么不是 bcrypt/argon2：token 是 32 字节随机
 *  值，不是人选的口令——没有字典可查、没有彩虹表，sha256 的「太快」在这里不是缺点，
 *   而每次请求都要验一次，慢哈希会把每个 tools/call 拖上几十毫秒。
 * - **撤销是软删除**（`revoked_at`，不改行、不删行）：时间线上那句「这个 agent 交的材料」
 *   要能追到它当时用的是哪个 token。「删掉」会让这条线索断在一个不存在的主键上。
 * - `scopes` 是**单值**，不是数组：read ⊂ write 是包含关系，一次给两级
 *   等于给高的那一级。列名取复数是因为它取值来自那三个词的集合（与服务层
 *   `Scope` 类型同一份词表），不是因为它存了多个。
 *
 * 唯一索引落在 `token_hash` 上：查 token 是每个请求的第一件事，它必须是一次索引命中，
 * 而不是全表扫。
 */
export const mcpTokens = pgTable('mcp_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  tokenHash: text('token_hash').notNull(),
  memberId: uuid('member_id').notNull().references(() => members.id),
  label: text('label').notNull(),
  scopes: text('scopes').notNull(),          // read | write
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => ({
  scopeCheck: check(
    'mcp_tokens_scopes_check',
    sql`${t.scopes} in ('read', 'write')`,
  ),
  hashUnique: uniqueIndex('mcp_tokens_hash_unique').on(t.tokenHash),
  byMember: index('mcp_tokens_member').on(t.memberId),
}));

/**
 * PRD 快照（P3.2）。
 *
 * 为什么要存正文而不是只存链接：PRD 是会改的，而走查/评审要回答的是「**这一版**
 * 的 PRD 与这份实现能不能对上」。只存 url 的话，同一个 url 明天读到的就是另一份
 * 文档，昨天的结论再也无法复现。
 *
 * 一条 fetch 一行（不是 upsert）：历史版本本身就有用——「这行是照着哪一版写的」
 * 要能回答，而 hash 相同的行由服务层去重（见 `src/core/prd/snapshots.ts`），
 * 不在库上做唯一约束。读侧取 `fetched_at` 最新的那一行。
 *
 * `fetched_at` 用 `clock_timestamp()` 而不是 `now()`：`now()` 是**事务开始**的时间，
 * 同一个事务里写两行会拿到同一个值，而这一列正是排序依据。`clock_timestamp()` 是
 * 语句时间（微秒级），两次相邻的 insert 不会撞在一起。
 *
 * `hash` 是 markdown 的 sha256（十六进制），存成文本而不是 bytea：它只用来比对，
 * 不参与计算。
 */
export const prdSnapshots = pgTable('prd_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  requirementId: uuid('requirement_id').notNull().references(() => requirements.id),
  url: text('url').notNull(),
  markdown: text('markdown').notNull(),
  hash: text('hash').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, (t) => ({ byReq: index('prd_snapshots_req').on(t.requirementId, t.fetchedAt) }));
