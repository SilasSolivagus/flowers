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

export const members = pgTable('members', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  // 'pm' | 'commercial_reviewer' | 'feature_reviewer'
  role: text('role').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const releases = pgTable('releases', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  releaseDate: timestamp('release_date', { withTimezone: true }).notNull(),
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
