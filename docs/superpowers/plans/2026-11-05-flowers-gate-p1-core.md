# P1 核心状态机与时间推进 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在空仓库 `SilasSolivagus/flowers` 里建起一个可以跑测试的后端核心：10 个状态、13 条转移、三个日期、一个时钟，能完整走通「建需求 → 评估 → 待设计 → 提交评审 → 通过 → 排期 → 到点自动上线」。

**Architecture:** 领域逻辑（`src/core`）与存储（`src/db`）分离；所有写操作走 `service(db, actor, input)` 签名，在同一事务里改行 + 写事件；状态只能经由 `state-machine.ts` 里显式列出的转移改变，其余一律抛 `IllegalTransition`。没有 Web UI、没有 MCP、没有通知——那是 P2 之后的事。

**Tech Stack:** Node 22 · TypeScript strict · PostgreSQL 17（docker compose）· drizzle-orm + drizzle-kit · zod · Vitest

**Spec:** `~/Flower/docs/superpowers/specs/2026-11-05-flower-gate-product-design.md`

## Global Constraints

- Node ≥ 22，TypeScript `strict: true`，不开 `any`
- Postgres 17（`docker compose up -d` 拉起来，宿主机端口 **54329**，避免撞现有 5432）
- 状态值只能是：`inbox | design | review | queue | ready | dev | test | live | rejected | shelved`
- 需求类型只能是：`commercial | feature`，**必填**
- 状态变更**只能**走 `TRANSITIONS` 里列出的 13 条；任何其他组合抛 `AppError('illegal_transition')`
- 每个写操作必须在**同一事务**里写一条 `events`
- 时间字段一律 `timestamptz`；「天」按 `Asia/Shanghai` 计算
- 面向用户的错误是一句中文，通过 `AppError(code, message)` 抛出
- 依赖上限：`drizzle-orm`、`pg`、`zod`、`vitest`、`typescript`、`tsx`；不引 ORM 之外的重框架
- 本计划**不建** `uemaster_artifacts` 表（spec §7 有，但只被 P2 使用，建在这里会是死表）

---

## 文件结构

```
flowers/
├── docker-compose.yml           Postgres 17，端口 54329
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── drizzle.config.ts
├── src/
│   ├── db/
│   │   ├── client.ts            连接池 + drizzle 实例
│   │   ├── schema.ts            5 张表
│   │   └── migrate.ts           跑迁移的脚本
│   ├── core/
│   │   ├── errors.ts            AppError
│   │   ├── events.ts            recordEvent(tx, …)
│   │   ├── state-machine.ts     10 状态 + 13 转移 + assertTransition
│   │   ├── requirements/
│   │   │   ├── create.ts
│   │   │   ├── evaluate.ts      inbox → design
│   │   │   ├── submit-review.ts design → review
│   │   │   ├── review.ts        review → queue / design
│   │   │   ├── schedule.ts      queue → ready（三个日期）
│   │   │   ├── bounce.ts        test → dev（重填完成日）
│   │   │   └── terminal.ts      reject / shelve / restore
│   │   └── clock/
│   │       └── tick.ts          三条自动转移
│   └── index.ts
└── tests/
    ├── helpers/db.ts
    ├── helpers/factory.ts        makeRelease / makeQueued / makeReadyAt
    ├── state-machine.test.ts
    ├── requirements.test.ts
    └── clock.test.ts
```

**为什么这样切：** 一个状态一个文件——因为每个状态的入口条件不同，混在一个 `requirements.ts` 里会长成 800 行、没人敢改。`state-machine.ts` 是唯一知道「允许哪些转移」的地方，服务函数只负责准备数据，合法性由它把关。

---

## Task 1: 项目骨架与数据库

**Files:**
- Create: `docker-compose.yml`, `package.json`, `tsconfig.json`, `vitest.config.ts`, `drizzle.config.ts`
- Create: `src/db/schema.ts`, `src/db/client.ts`, `src/db/migrate.ts`
- Create: `tests/helpers/db.ts`

**Interfaces:**
- Produces: `db`（drizzle 实例）、`schema.requirements / members / releases / events / reviewAssignments`、`resetDb()` 测试助手

- [ ] **Step 1: 建 docker-compose.yml**

```yaml
services:
  db:
    image: postgres:17-alpine
    ports: ["54329:5432"]
    environment:
      POSTGRES_PASSWORD: flowers
      POSTGRES_DB: flowers
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 2s
      retries: 20
```

- [ ] **Step 2: 建 package.json**

```json
{
  "name": "flowers",
  "private": true,
  "type": "module",
  "scripts": {
    "db:up": "docker compose up -d db",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "tsx src/db/migrate.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "drizzle-orm": "^0.36.0",
    "pg": "^8.13.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/pg": "^8.11.10",
    "drizzle-kit": "^0.28.0",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 3: 建 tsconfig.json / vitest.config.ts / drizzle.config.ts**

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler",
    "strict": true, "noUncheckedIndexedAccess": true, "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "tests"]
}
```

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { fileParallelism: false, testTimeout: 20000 } });
```

```ts
// drizzle.config.ts
export default { dialect: 'postgresql', schema: './src/db/schema.ts', out: './drizzle' } as const;
```

- [ ] **Step 4: 建 schema.ts —— 5 张表**

```ts
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
```

- [ ] **Step 5: 建 client.ts / migrate.ts**

```ts
// src/db/client.ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:flowers@localhost:54329/flowers',
});
export const db = drizzle(pool, { schema });
export type Db = typeof db;
```

```ts
// src/db/migrate.ts
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from './client.js';

await migrate(db, { migrationsFolder: './drizzle' });
await pool.end();
```

- [ ] **Step 6: 建测试助手**

```ts
// tests/helpers/db.ts
import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';

export async function resetDb() {
  await db.execute(sql`truncate requirements, review_assignments, events, releases, members restart identity cascade`);
}

export async function seedPeople() {
  const rows = await db.execute(sql`
    insert into members (name, role) values
      ('房超','pm'), ('王妍','pm'), ('吕品','pm'),
      ('赵越','commercial_reviewer'), ('吕正豪','feature_reviewer')
    returning id, name, role`);
  return rows.rows as Array<{ id: string; name: string; role: string }>;
}
```

- [ ] **Step 7: 建测试工厂**

```ts
// tests/helpers/factory.ts
import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { createRequirement } from '../../src/core/requirements/create.js';
import { evaluate } from '../../src/core/requirements/evaluate.js';
import { submitReview } from '../../src/core/requirements/submit-review.js';
import { reviewPass } from '../../src/core/requirements/review.js';
import { schedule } from '../../src/core/requirements/schedule.js';

export async function makeRelease(name: string, windowStart: string, releaseDate: string) {
  const r = await db.execute<{ id: string }>(sql`
    insert into releases (name, window_start, release_date)
    values (${name}, ${windowStart}, ${releaseDate}) returning id`);
  return r.rows[0]!.id;
}

export async function makeQueued() {
  const r = await createRequirement(db, '吕品', { title: 'q', type: 'feature', requester: 'b' });
  await evaluate(db, '吕品', { requirementId: r.id });
  await submitReview(db, '吕品', { requirementId: r.id, prdUrl: 'https://x' });
  await reviewPass(db, '吕正豪', { requirementId: r.id });
  return r;
}

/** 造一条已排期的需求；返回 id */
export async function makeReadyAt(windowStart: string, commitTestAt: string, commitDueAt: string) {
  const releaseId = await makeRelease(`R-${windowStart}`, windowStart, commitDueAt);
  const r = await makeQueued();
  await schedule(db, '吕品', { requirementId: r.id, releaseId, commitTestAt, commitDueAt });
  return { id: r.id, releaseId };
}
```

- [ ] **Step 8: 跑起来验证**

Run:
```bash
npm install
npm run db:up && sleep 3
npm run db:generate && npm run db:migrate
```

Expected: 容器 healthy，`drizzle/` 下生成 SQL，迁移执行无报错。

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "chore: scaffold flowers core with postgres and drizzle schema"
```

---

## Task 2: 错误与事件

**Files:**
- Create: `src/core/errors.ts`, `src/core/events.ts`
- Test: `tests/state-machine.test.ts`（先只放 errors 的用例）

**Interfaces:**
- Produces: `AppError(code: string, message: string)`、`recordEvent(tx, { requirementId, actor, type, payload })`

- [ ] **Step 1: 写失败的测试**

```ts
import { describe, it, expect } from 'vitest';
import { AppError } from '../src/core/errors.js';

describe('AppError', () => {
  it('带上 code 和中文消息', () => {
    const e = new AppError('illegal_transition', '这个状态不能直接到那里');
    expect(e.code).toBe('illegal_transition');
    expect(e.message).toBe('这个状态不能直接到那里');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/state-machine.test.ts`
Expected: FAIL — `Cannot find module '../src/core/errors.js'`

- [ ] **Step 3: 实现 errors.ts 与 events.ts**

```ts
// src/core/errors.ts
export class AppError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AppError';
  }
}
```

```ts
// src/core/events.ts
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export async function recordEvent(
  tx: Tx,
  input: { requirementId: string | null; actor: string; type: string; payload: unknown },
) {
  await tx.execute(sql`
    insert into events (seq, requirement_id, actor, type, payload)
    values (
      coalesce((select max(seq) from events), 0) + 1,
      ${input.requirementId}, ${input.actor}, ${input.type},
      ${JSON.stringify(input.payload)}
    )`);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/state-machine.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add AppError and append-only event writer"
```

---

## Task 3: 状态机（13 条转移）

**Files:**
- Create: `src/core/state-machine.ts`
- Test: `tests/state-machine.test.ts`（追加）

**Interfaces:**
- Produces: `State`、`Transition`、`TRANSITIONS`、`assertTransition(from, to, ctx)`、`isClockTransition(from, to)`

- [ ] **Step 1: 写失败的测试**

```ts
import { assertTransition, TRANSITIONS } from '../src/core/state-machine.js';
import { AppError } from '../src/core/errors.js';

it('13 条合法转移都能过', () => {
  expect(TRANSITIONS).toHaveLength(13);
  for (const t of TRANSITIONS) {
    expect(() => assertTransition(t.from, t.to, { hasPrd: true, hasType: true })).not.toThrow();
  }
});

it('inbox 不能直接到 开发中', () => {
  expect(() => assertTransition('inbox', 'dev', { hasPrd: true, hasType: true }))
    .toThrowError(AppError);
});

it('inbox → review 必须有 PRD', () => {
  expect(() => assertTransition('inbox', 'review', { hasPrd: false, hasType: true }))
    .toThrowError(new AppError('missing_prd', '直接提交评审必须有正式 PRD 链接'));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/state-machine.test.ts`
Expected: FAIL — `TRANSITIONS is not defined`

- [ ] **Step 3: 实现 state-machine.ts**

```ts
import { AppError } from './errors.js';

export type State =
  | 'inbox' | 'design' | 'review' | 'queue' | 'ready'
  | 'dev' | 'test' | 'live' | 'rejected' | 'shelved';

export type Transition = {
  from: State; to: State; trigger: string;
  clock?: boolean;
  guard?: 'prd' | 'type' | 'dates' | 'new_due';
};

export const TRANSITIONS: Transition[] = [
  { from: 'inbox',  to: 'design',  trigger: 'evaluate',      guard: 'type' },
  { from: 'inbox',  to: 'review',  trigger: 'submit_review', guard: 'prd'  },
  { from: 'inbox',  to: 'rejected', trigger: 'reject' },
  { from: 'inbox',  to: 'shelved', trigger: 'shelve' },
  { from: 'design', to: 'review',  trigger: 'submit_review', guard: 'prd'  },
  { from: 'review', to: 'queue',   trigger: 'review_pass' },
  { from: 'review', to: 'design',  trigger: 'review_reject' },
  { from: 'queue',  to: 'ready',   trigger: 'schedule',      guard: 'dates' },
  { from: 'ready',  to: 'dev',     trigger: 'clock',         clock: true },
  { from: 'dev',    to: 'test',    trigger: 'clock',         clock: true },
  { from: 'test',   to: 'live',    trigger: 'clock',         clock: true },
  { from: 'test',   to: 'dev',     trigger: 'bounce',        guard: 'new_due' },
  { from: 'shelved', to: 'inbox',  trigger: 'restore' },
];

export function find(from: State, to: State) {
  const t = TRANSITIONS.find((x) => x.from === from && x.to === to);
  if (!t) throw new AppError('illegal_transition', `不能从「${from}」直接到「${to}」`);
  return t;
}

export function assertTransition(
  from: State, to: State, ctx: { hasPrd: boolean; hasType: boolean },
) {
  const t = find(from, to);
  if (t.guard === 'prd' && !ctx.hasPrd) {
    throw new AppError('missing_prd', '直接提交评审必须有正式 PRD 链接');
  }
  if (t.guard === 'type' && !ctx.hasType) {
    throw new AppError('missing_type', '需求必须有类型（商业 / 功能）才能进入下一步');
  }
  return t;
}

export const isClockTransition = (from: State, to: State) => !!find(from, to).clock;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/state-machine.test.ts`
Expected: PASS（3 条）

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: state machine with 13 explicit transitions"
```

---

## Task 4: 建需求

**Files:**
- Create: `src/core/requirements/create.ts`
- Test: `tests/requirements.test.ts`

**Interfaces:**
- Consumes: `recordEvent`、`AppError`
- Produces: `createRequirement(db, actor, input)` → `{ id, number, state: 'inbox' }`

- [ ] **Step 1: 写失败的测试**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../src/db/client.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { AppError } from '../src/core/errors.js';

beforeEach(async () => { await resetDb(); await seedPeople(); });

describe('createRequirement', () => {
  it('建出来就是 inbox，编号从 1 开始', async () => {
    const r = await createRequirement(db, '吕品', {
      title: 'S3 协议支持', type: 'feature', requester: '孙建宏',
    });
    expect(r.state).toBe('inbox');
    expect(r.number).toBe(1);
  });

  it('类型缺失直接拒绝', async () => {
    await expect(createRequirement(db, '吕品', {
      title: 'x', requester: 'y',
    } as never)).rejects.toThrowError(AppError);
  });

  it('每次创建写一条事件', async () => {
    await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
    const rows = await db.execute(sql`select type from events`);
    expect(rows.rows).toHaveLength(1);
    expect((rows.rows[0] as { type: string }).type).toBe('requirement.created');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/requirements.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 create.ts**

```ts
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { recordEvent } from '../events.js';
import { AppError } from '../errors.js';

export const CreateInput = z.object({
  title: z.string().trim().min(1, '标题不能为空'),
  type: z.enum(['commercial', 'feature'], { message: '必须选择类型：商业或功能' }),
  requester: z.string().trim().min(1, '提出人不能为空'),
  ownerMemberId: z.string().uuid().nullish(),
});

export type CreateInput = z.infer<typeof CreateInput>;

export async function createRequirement(db: Db, actor: string, raw: unknown) {
  const parsed = CreateInput.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('invalid', parsed.error.issues[0]?.message ?? '参数不合法');
  }
  const input = parsed.data;

  return db.transaction(async (tx) => {
    const next = await tx.execute<{ n: number }>(sql`select coalesce(max(number),0)+1 as n from requirements`);
    const number = Number(next.rows[0]!.n);
    const inserted = await tx.execute<{ id: string; state: string }>(sql`
      insert into requirements (number, title, type, state, requester, owner_member_id)
      values (${number}, ${input.title}, ${input.type}, 'inbox', ${input.requester}, ${input.ownerMemberId ?? null})
      returning id, state`);
    const row = inserted.rows[0]!;
    await recordEvent(tx, {
      requirementId: row.id, actor, type: 'requirement.created',
      payload: { number, title: input.title, type: input.type },
    });
    return { id: row.id, number, state: row.state as 'inbox' };
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/requirements.test.ts`
Expected: PASS（3 条）

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: create requirement with required type"
```

---

## Task 5: 评估与提交评审

**Files:**
- Create: `src/core/requirements/evaluate.ts`, `src/core/requirements/submit-review.ts`
- Test: `tests/requirements.test.ts`（追加）

**Interfaces:**
- Produces: `evaluate(db, actor, { requirementId })`、`submitReview(db, actor, { requirementId, prdUrl })`

- [ ] **Step 1: 写失败的测试**

```ts
it('评估后进待设计，并记 state_entered_at', async () => {
  const r = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
  const out = await evaluate(db, '吕品', { requirementId: r.id });
  expect(out.state).toBe('design');
});

it('提交评审必须带 URL', async () => {
  const r = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
  await evaluate(db, '吕品', { requirementId: r.id });
  await expect(submitReview(db, '吕品', { requirementId: r.id, prdUrl: '' }))
    .rejects.toThrowError(new AppError('missing_prd', '提交评审必须填正式 PRD 链接'));
});

it('提交后进待评审', async () => {
  const r = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
  await evaluate(db, '吕品', { requirementId: r.id });
  const out = await submitReview(db, '吕品', { requirementId: r.id, prdUrl: 'https://x/prd' });
  expect(out.state).toBe('review');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/requirements.test.ts -t 评审`
Expected: FAIL — `evaluate is not defined`

- [ ] **Step 3: 实现两个服务**

```ts
// src/core/requirements/evaluate.ts
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { assertTransition } from '../state-machine.js';
import { recordEvent } from '../events.js';
import { AppError } from '../errors.js';

export async function evaluate(db: Db, actor: string, input: { requirementId: string }) {
  return db.transaction(async (tx) => {
    const cur = await tx.execute<{ state: string; type: string | null }>(
      sql`select state, type from requirements where id = ${input.requirementId} for update`);
    const row = cur.rows[0];
    if (!row) throw new AppError('not_found', '找不到这条需求');
    assertTransition(row.state as never, 'design', { hasPrd: true, hasType: !!row.type });
    await tx.execute(sql`
      update requirements set state='design', state_entered_at=now()
      where id=${input.requirementId}`);
    await recordEvent(tx, {
      requirementId: input.requirementId, actor, type: 'requirement.evaluated',
      payload: { from: row.state, to: 'design' },
    });
    return { state: 'design' as const };
  });
}
```

```ts
// src/core/requirements/submit-review.ts
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { assertTransition } from '../state-machine.js';
import { recordEvent } from '../events.js';
import { AppError } from '../errors.js';

export async function submitReview(
  db: Db, actor: string, input: { requirementId: string; prdUrl: string },
) {
  const url = input.prdUrl.trim();
  if (!url) throw new AppError('missing_prd', '提交评审必须填正式 PRD 链接');

  return db.transaction(async (tx) => {
    const cur = await tx.execute<{ state: string; type: string | null }>(
      sql`select state, type from requirements where id=${input.requirementId} for update`);
    const row = cur.rows[0];
    if (!row) throw new AppError('not_found', '找不到这条需求');
    assertTransition(row.state as never, 'review', { hasPrd: true, hasType: !!row.type });
    const skipped = row.state === 'inbox';
    await tx.execute(sql`
      update requirements
         set state='review', prd_url=${url}, state_entered_at=now(),
             skip_reason = case when ${skipped} then '跳过评估，直接提交 PRD' else skip_reason end
       where id=${input.requirementId}`);
    await recordEvent(tx, {
      requirementId: input.requirementId, actor, type: 'requirement.review_requested',
      payload: { from: row.state, prdUrl: url, skippedEvaluation: skipped },
    });
    return { state: 'review' as const, skippedEvaluation: skipped };
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/requirements.test.ts`
Expected: PASS（6 条）

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: evaluate and submit review with PRD guard"
```

---

## Task 6: 评审派单、通过与打回

**Files:**
- Create: `src/core/requirements/review.ts`
- Test: `tests/requirements.test.ts`（追加）

**Interfaces:**
- Consumes: `reviewAssignments` 表
- Produces: `assignReviewer(db, tx, requirementId, type)`、`reviewPass(...)`、`reviewReject(...)`

- [ ] **Step 1: 写失败的测试**

```ts
it('功能类派给功能线评审人，商业类派给商业线', async () => {
  const f = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
  await evaluate(db, '吕品', { requirementId: f.id });
  await submitReview(db, '吕品', { requirementId: f.id, prdUrl: 'https://x' });
  const who = await reviewerOf(f.id);
  expect(who).toBe('吕正豪');

  const c = await createRequirement(db, '吕品', { title: 'c', type: 'commercial', requester: 'b' });
  await evaluate(db, '吕品', { requirementId: c.id });
  await submitReview(db, '吕品', { requirementId: c.id, prdUrl: 'https://y' });
  expect(await reviewerOf(c.id)).toBe('赵越');
});

it('通过后进待排期', async () => {
  const r = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
  await evaluate(db, '吕品', { requirementId: r.id });
  await submitReview(db, '吕品', { requirementId: r.id, prdUrl: 'https://x' });
  const out = await reviewPass(db, '吕正豪', { requirementId: r.id });
  expect(out.state).toBe('queue');
});

it('打回回到待设计，且必须写原因', async () => {
  const r = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
  await evaluate(db, '吕品', { requirementId: r.id });
  await submitReview(db, '吕品', { requirementId: r.id, prdUrl: 'https://x' });
  await expect(reviewReject(db, '吕正豪', { requirementId: r.id, reason: '' }))
    .rejects.toThrowError(new AppError('missing_reason', '打回必须写原因'));
  const out = await reviewReject(db, '吕正豪', { requirementId: r.id, reason: '页面状态没写清' });
  expect(out.state).toBe('design');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/requirements.test.ts -t 评审`
Expected: FAIL — `reviewPass is not defined`

- [ ] **Step 3: 实现 review.ts**

```ts
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { AppError } from '../errors.js';
import { assertTransition } from '../state-machine.js';
import { recordEvent } from '../events.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** 类型 → 评审人角色 */
export const REVIEWER_ROLE = {
  commercial: 'commercial_reviewer',
  feature: 'feature_reviewer',
} as const;

export async function assignReviewer(tx: Tx, requirementId: string, type: string) {
  const role = REVIEWER_ROLE[type as keyof typeof REVIEWER_ROLE];
  if (!role) throw new AppError('invalid_type', '需求类型不认识');
  const m = await tx.execute<{ id: string }>(sql`select id from members where role = ${role} limit 1`);
  const reviewer = m.rows[0];
  if (!reviewer) throw new AppError('no_reviewer', '这个类型还没有配评审人');
  await tx.execute(sql`
    insert into review_assignments (requirement_id, reviewer_member_id, verdict)
    values (${requirementId}, ${reviewer.id}, 'handed')`);
  return reviewer.id;
}

export async function reviewPass(db: Db, actor: string, input: { requirementId: string }) {
  return db.transaction(async (tx) => {
    const cur = await tx.execute<{ state: string }>(
      sql`select state from requirements where id=${input.requirementId} for update`);
    const row = cur.rows[0];
    if (!row) throw new AppError('not_found', '找不到这条需求');
    assertTransition(row.state as never, 'queue', { hasPrd: true, hasType: true });
    await tx.execute(sql`
      update requirements set state='queue', state_entered_at=now() where id=${input.requirementId}`);
    await tx.execute(sql`
      update review_assignments set verdict='passed', decided_at=now()
      where requirement_id=${input.requirementId} and verdict='handed'`);
    await recordEvent(tx, {
      requirementId: input.requirementId, actor, type: 'requirement.review_passed', payload: {},
    });
    return { state: 'queue' as const };
  });
}

export async function reviewReject(
  db: Db, actor: string, input: { requirementId: string; reason: string },
) {
  const reason = input.reason.trim();
  if (!reason) throw new AppError('missing_reason', '打回必须写原因');
  return db.transaction(async (tx) => {
    const cur = await tx.execute<{ state: string }>(
      sql`select state from requirements where id=${input.requirementId} for update`);
    const row = cur.rows[0];
    if (!row) throw new AppError('not_found', '找不到这条需求');
    assertTransition(row.state as never, 'design', { hasPrd: true, hasType: true });
    await tx.execute(sql`
      update requirements set state='design', state_entered_at=now() where id=${input.requirementId}`);
    await tx.execute(sql`
      update review_assignments set verdict='rejected', reason=${reason}, decided_at=now()
      where requirement_id=${input.requirementId} and verdict='handed'`);
    await recordEvent(tx, {
      requirementId: input.requirementId, actor, type: 'requirement.review_rejected', payload: { reason },
    });
    return { state: 'design' as const };
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/requirements.test.ts`
Expected: PASS（9 条）

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: review assignment by requirement type with pass and reject"
```

---

## Task 7: 排期（三个日期）

**Files:**
- Create: `src/core/requirements/schedule.ts`
- Test: `tests/requirements.test.ts`（追加）

**Interfaces:**
- Produces: `schedule(db, actor, { requirementId, releaseId, commitTestAt, commitDueAt })`

- [ ] **Step 1: 写失败的测试**

```ts
it('三个日期齐全才能排期', async () => {
  const r = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
  await evaluate(db, '吕品', { requirementId: r.id });
  await submitReview(db, '吕品', { requirementId: r.id, prdUrl: 'https://x' });
  await reviewPass(db, '吕正豪', { requirementId: r.id });
  await expect(schedule(db, '吕品', { requirementId: r.id, releaseId: null as never, commitTestAt: null as never, commitDueAt: null as never }))
    .rejects.toThrowError(new AppError('missing_dates', '排期必须填版本、提测日和承诺完成日'));
});

it('完成日早于提测日 或 晚于发版日 都拒绝', async () => {
  const rel = await makeRelease('2026.12', '2026-12-01', '2026-12-04');
  const r = await makeQueued();
  await expect(schedule(db, '吕品', {
    requirementId: r.id, releaseId: rel, commitTestAt: '2026-12-03', commitDueAt: '2026-12-02',
  })).rejects.toThrowError(new AppError('bad_dates', '承诺完成日不能早于提测日'));
  await expect(schedule(db, '吕品', {
    requirementId: r.id, releaseId: rel, commitTestAt: '2026-12-01', commitDueAt: '2026-12-10',
  })).rejects.toThrowError(new AppError('bad_dates', '承诺完成日不能晚于版本发版日'));
});

it('排期后进待开发', async () => {
  const rel = await makeRelease('2026.12', '2026-12-01', '2026-12-04');
  const r = await makeQueued();
  const out = await schedule(db, '吕品', {
    requirementId: r.id, releaseId: rel, commitTestAt: '2026-12-01', commitDueAt: '2026-12-04',
  });
  expect(out.state).toBe('ready');
});
```

`tests/requirements.test.ts` 顶部加一行：

```ts
import { makeRelease, makeQueued } from './helpers/factory.js';
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/requirements.test.ts -t 排期`
Expected: FAIL — `schedule is not defined`

- [ ] **Step 3: 实现 schedule.ts**

```ts
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { assertTransition } from '../state-machine.js';
import { recordEvent } from '../events.js';
import { AppError } from '../errors.js';

export async function schedule(
  db: Db, actor: string,
  input: { requirementId: string; releaseId: string; commitTestAt: string; commitDueAt: string },
) {
  if (!input.releaseId || !input.commitTestAt || !input.commitDueAt) {
    throw new AppError('missing_dates', '排期必须填版本、提测日和承诺完成日');
  }
  const testAt = new Date(input.commitTestAt);
  const dueAt = new Date(input.commitDueAt);
  if (testAt > dueAt) throw new AppError('bad_dates', '承诺完成日不能早于提测日');

  return db.transaction(async (tx) => {
    const rel = await tx.execute<{ release_date: string }>(
      sql`select release_date from releases where id=${input.releaseId}`);
    const release = rel.rows[0];
    if (!release) throw new AppError('not_found', '找不到这个版本');
    if (dueAt > new Date(release.release_date)) {
      throw new AppError('bad_dates', '承诺完成日不能晚于版本发版日');
    }
    const cur = await tx.execute<{ state: string }>(
      sql`select state from requirements where id=${input.requirementId} for update`);
    const row = cur.rows[0];
    if (!row) throw new AppError('not_found', '找不到这条需求');
    assertTransition(row.state as never, 'ready', { hasPrd: true, hasType: true });
    await tx.execute(sql`
      update requirements
         set state='ready', release_id=${input.releaseId},
             commit_test_at=${testAt.toISOString()}, commit_due_at=${dueAt.toISOString()},
             state_entered_at=now()
       where id=${input.requirementId}`);
    await recordEvent(tx, {
      requirementId: input.requirementId, actor, type: 'requirement.scheduled',
      payload: { releaseId: input.releaseId, commitTestAt: input.commitTestAt, commitDueAt: input.commitDueAt },
    });
    return { state: 'ready' as const };
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/requirements.test.ts`
Expected: PASS（12 条）

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: schedule into release with three dates validated"
```

---

## Task 8: 时钟推进（三条自动转移）

**Files:**
- Create: `src/core/clock/tick.ts`
- Test: `tests/clock.test.ts`

**Interfaces:**
- Produces: `tick(db, now: Date)` → `{ moved: Array<{ id: string; from: State; to: State }> }`

- [ ] **Step 1: 写失败的测试**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../src/db/client.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { sql } from 'drizzle-orm';
import { tick } from '../src/core/clock/tick.js';
import { makeReadyAt } from './helpers/factory.js';

it('到开工日，待开发 → 开发中', async () => {
  const { id } = await makeReadyAt('2026-12-01', '2026-12-01', '2026-12-04');
  const out = await tick(db, new Date('2026-12-01T00:00:00+08:00'));
  expect(out.moved).toContainEqual({ id, from: 'ready', to: 'dev' });
});

it('到提测日，开发中 → 测试中', async () => {
  const { id } = await makeReadyAt('2026-12-01', '2026-12-01', '2026-12-04');
  await tick(db, new Date('2026-12-01T00:00:00+08:00'));
  const out = await tick(db, new Date('2026-12-03T00:00:00+08:00'));
  expect(out.moved).toContainEqual({ id, from: 'dev', to: 'test' });
});

it('到承诺完成日，测试中 → 已上线', async () => {
  const { id } = await makeReadyAt('2026-12-01', '2026-12-01', '2026-12-04');
  await tick(db, new Date('2026-12-01T00:00:00+08:00'));
  await tick(db, new Date('2026-12-03T00:00:00+08:00'));
  const out = await tick(db, new Date('2026-12-04T00:00:00+08:00'));
  expect(out.moved).toContainEqual({ id, from: 'test', to: 'live' });
});

it('重复 tick 不会重复推进', async () => {
  await makeReadyAt('2026-12-01', '2026-12-01', '2026-12-04');
  await tick(db, new Date('2026-12-01T00:00:00+08:00'));
  const again = await tick(db, new Date('2026-12-01T01:00:00+08:00'));
  expect(again.moved).toHaveLength(0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/clock.test.ts`
Expected: FAIL — `tick is not defined`

- [ ] **Step 3: 实现 tick.ts**

```ts
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { recordEvent } from '../events.js';
import type { State } from '../state-machine.js';

type Moved = { id: string; from: State; to: State };

export async function tick(db: Db, now: Date): Promise<{ moved: Moved[] }> {
  return db.transaction(async (tx) => {
    const moved: Moved[] = [];

    const due = await tx.execute<{ id: string; state: State; release_id: string; window_start: string; commit_test_at: string; commit_due_at: string }>(sql`
      select r.id, r.state, r.release_id, rel.window_start, r.commit_test_at, r.commit_due_at
        from requirements r join releases rel on rel.id = r.release_id
       where r.state in ('ready','dev','test')
       for update of r`);

    for (const row of due.rows) {
      const step = (from: State, to: State) => moved.push({ id: row.id, from, to });
      let next: State | null = null;

      if (row.state === 'ready' && now >= new Date(row.window_start)) next = 'dev';
      else if (row.state === 'dev' && now >= new Date(row.commit_test_at)) next = 'test';
      else if (row.state === 'test' && now >= new Date(row.commit_due_at)) next = 'live';

      if (!next) continue;
      await tx.execute(sql`
        update requirements set state=${next}, state_entered_at=${now.toISOString()} where id=${row.id}`);
      await recordEvent(tx, {
        requirementId: row.id, actor: 'system', type: `requirement.auto_${next}`,
        payload: { from: row.state, to: next, at: now.toISOString() },
      });
      step(row.state, next);
    }
    return { moved };
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/clock.test.ts`
Expected: PASS（4 条）

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: clock advances ready/dev/test by committed dates"
```

---

## Task 9: 打回（测试中 → 开发中，必须重算完成日）

**Files:**
- Create: `src/core/requirements/bounce.ts`
- Test: `tests/requirements.test.ts`（追加）

**Interfaces:**
- Produces: `bounce(db, actor, { requirementId, reason, newCommitDueAt })`

- [ ] **Step 1: 补 import 再写失败的测试**

`tests/requirements.test.ts` 顶部加：

```ts
import { sql } from 'drizzle-orm';
import { bounce } from '../src/core/requirements/bounce.js';
import { tick } from '../src/core/clock/tick.js';
import { makeReadyAt } from './helpers/factory.js';
```


```ts
it('打回不填新完成日就拒绝', async () => {
  const { id } = await makeReadyAt('2026-12-01', '2026-12-01', '2026-12-04');
  await tick(db, new Date('2026-12-01T00:00:00+08:00'));
  await tick(db, new Date('2026-12-03T00:00:00+08:00'));
  await expect(bounce(db, '王妍', { requirementId: id, reason: '自测没过', newCommitDueAt: '' }))
    .rejects.toThrowError(new AppError('missing_new_due', '打回必须重填承诺完成日'));
});

it('打回后回开发中，且完成日变成新的', async () => {
  const { id } = await makeReadyAt('2026-12-01', '2026-12-01', '2026-12-04');
  await tick(db, new Date('2026-12-01T00:00:00+08:00'));
  await tick(db, new Date('2026-12-03T00:00:00+08:00'));
  const out = await bounce(db, '王妍', { requirementId: id, reason: '自测没过', newCommitDueAt: '2026-12-10' });
  expect(out.state).toBe('dev');
  const due = await db.execute<{ commit_due_at: string }>(sql`select commit_due_at from requirements where id=${id}`);
  expect(new Date(due.rows[0]!.commit_due_at).toISOString().slice(0, 10)).toBe('2026-12-10');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/requirements.test.ts -t 打回`
Expected: FAIL — `bounce is not defined`

- [ ] **Step 3: 实现 bounce.ts**

```ts
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { assertTransition } from '../state-machine.js';
import { recordEvent } from '../events.js';
import { AppError } from '../errors.js';

export async function bounce(
  db: Db, actor: string,
  input: { requirementId: string; reason: string; newCommitDueAt: string },
) {
  if (!input.newCommitDueAt?.trim()) {
    throw new AppError('missing_new_due', '打回必须重填承诺完成日');
  }
  const reason = input.reason?.trim();
  if (!reason) throw new AppError('missing_reason', '打回必须写原因');

  return db.transaction(async (tx) => {
    const cur = await tx.execute<{ state: string }>(
      sql`select state from requirements where id=${input.requirementId} for update`);
    const row = cur.rows[0];
    if (!row) throw new AppError('not_found', '找不到这条需求');
    assertTransition(row.state as never, 'dev', { hasPrd: true, hasType: true });
    await tx.execute(sql`
      update requirements
         set state='dev', commit_due_at=${new Date(input.newCommitDueAt).toISOString()},
             state_entered_at=now()
       where id=${input.requirementId}`);
    await recordEvent(tx, {
      requirementId: input.requirementId, actor, type: 'requirement.bounced',
      payload: { reason, newCommitDueAt: input.newCommitDueAt },
    });
    return { state: 'dev' as const };
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/requirements.test.ts`
Expected: PASS（14 条）

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: bounce back to dev with mandatory new due date"
```

---

## Task 10: 拒绝 / 搁置 / 恢复

**Files:**
- Create: `src/core/requirements/terminal.ts`
- Test: `tests/requirements.test.ts`（追加）

**Interfaces:**
- Produces: `rejectRequirement`、`shelveRequirement`、`restoreRequirement`

- [ ] **Step 1: 写失败的测试**

```ts
it('只有 inbox 能拒绝', async () => {
  const r = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
  await evaluate(db, '吕品', { requirementId: r.id });
  await expect(rejectRequirement(db, '吕品', { requirementId: r.id, reason: '不做' }))
    .rejects.toThrowError(new AppError('illegal_transition', '只有收集状态的需求可以拒绝'));
});

it('搁置后恢复回 inbox', async () => {
  const r = await createRequirement(db, '吕品', { title: 'a', type: 'feature', requester: 'b' });
  await shelf(db, '吕品', { requirementId: r.id, reason: '本期不做' });
  const out = await restore(db, '吕品', { requirementId: r.id });
  expect(out.state).toBe('inbox');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/requirements.test.ts -t 拒绝`
Expected: FAIL — `rejectRequirement is not defined`

- [ ] **Step 3: 实现 terminal.ts**

```ts
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { assertTransition } from '../state-machine.js';
import { recordEvent } from '../events.js';
import { AppError } from '../errors.js';

export async function rejectRequirement(
  db: Db, actor: string, input: { requirementId: string; reason: string },
) {
  return db.transaction(async (tx) => {
    const cur = await tx.execute<{ state: string }>(
      sql`select state from requirements where id=${input.requirementId} for update`);
    const row = cur.rows[0];
    if (!row) throw new AppError('not_found', '找不到这条需求');
    if (row.state !== 'inbox') throw new AppError('illegal_transition', '只有收集状态的需求可以拒绝');
    assertTransition('inbox', 'rejected', { hasPrd: true, hasType: true });
    await tx.execute(sql`
      update requirements set state='rejected', state_entered_at=now() where id=${input.requirementId}`);
    await recordEvent(tx, {
      requirementId: input.requirementId, actor, type: 'requirement.rejected',
      payload: { reason: input.reason ?? '' },
    });
    return { state: 'rejected' as const };
  });
}

export async function shelf(
  db: Db, actor: string, input: { requirementId: string; reason: string },
) {
  return db.transaction(async (tx) => {
    const cur = await tx.execute<{ state: string }>(
      sql`select state from requirements where id=${input.requirementId} for update`);
    const row = cur.rows[0];
    if (!row) throw new AppError('not_found', '找不到这条需求');
    if (row.state === 'rejected' || row.state === 'shelved') {
      throw new AppError('illegal_transition', '终态不能再搁置');
    }
    await tx.execute(sql`
      update requirements set state='shelved', state_entered_at=now() where id=${input.requirementId}`);
    await recordEvent(tx, {
      requirementId: input.requirementId, actor, type: 'requirement.shelved',
      payload: { from: row.state, reason: input.reason ?? '' },
    });
    return { state: 'shelved' as const };
  });
}

export async function restore(db: Db, actor: string, input: { requirementId: string }) {
  return db.transaction(async (tx) => {
    const cur = await tx.execute<{ state: string }>(
      sql`select state from requirements where id=${input.requirementId} for update`);
    const row = cur.rows[0];
    if (!row) throw new AppError('not_found', '找不到这条需求');
    assertTransition(row.state as never, 'inbox', { hasPrd: true, hasType: true });
    await tx.execute(sql`
      update requirements set state='inbox', state_entered_at=now() where id=${input.requirementId}`);
    await recordEvent(tx, {
      requirementId: input.requirementId, actor, type: 'requirement.restored', payload: {},
    });
    return { state: 'inbox' as const };
  });
}
```

- [ ] **Step 4: 跑全量测试**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全部 PASS，类型无错

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: reject, shelve and restore with terminal-state guards"
```

---

## 验收标准

P1 做完时，以下命令全绿：

```bash
npm run db:up && npm run db:migrate
npx vitest run        # ≥ 18 条测试
npx tsc --noEmit
```

并且能手动跑通一条完整链路（写在 `scripts/demo.ts` 里，作为冒烟脚本）：

```bash
npx tsx scripts/demo.ts
# PAN-1 建出来 → 评估 → 待设计 → 提交评审 → 吕正豪通过 → 待排期
# → 排进 2026.12（12-01 提测 / 12-04 完成）→ tick 到 12-01 变开发中
# → tick 到 12-03 变测试中 → tick 到 12-04 变已上线
```

## 不在 P1 范围

| 内容 | 落在 |
|---|---|
| UEmaster 三个环节、MCP plan/attach、LLM 三态 | P2 |
| 通知（企微 / 站内） | P3 |
| 前端三页（看板 / 详情 / 设置） | P4 |
| 走查 | P4 之后 |
