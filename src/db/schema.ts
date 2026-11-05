import { sql } from 'drizzle-orm';
import {
  pgTable, pgSequence, uuid, text, timestamp, integer, index, uniqueIndex,
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

export const events = pgTable('events', {
  // 单调递增：值来自 events_seq_seq，不扫 max。
  seq: integer('seq').primaryKey().default(sql`nextval('events_seq_seq')`),
  requirementId: uuid('requirement_id'),
  actor: text('actor').notNull(),
  type: text('type').notNull(),
  payload: text('payload').notNull(),        // JSON 字符串
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
});
