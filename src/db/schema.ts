import { pgTable, uuid, text, timestamp, integer, index, uniqueIndex } from 'drizzle-orm/pg-core';

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
  number: integer('number').notNull(),                      // PAN-1、PAN-2…
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
  seq: integer('seq').primaryKey(),          // 单调递增
  requirementId: uuid('requirement_id'),
  actor: text('actor').notNull(),
  type: text('type').notNull(),
  payload: text('payload').notNull(),        // JSON 字符串
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
});
