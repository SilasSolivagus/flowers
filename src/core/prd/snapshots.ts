import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';

/**
 * PRD 快照的读写口。
 *
 * 一件事：**把「这一次读到的正文」钉在时间里。** PRD 会被改，而走查/评审要回答的
 * 是「这份实现与**哪一版** PRD 对不上」。只留 url 的话，明天读到的就是另一份文档，
 * 昨天的结论再也无法复现——所以每次 fetch 落一行正文 + 它的 sha256。
 *
 * 三条口径：
 *
 * 1. **一条 fetch 一行，不做 upsert。** 历史本身有用：「这行代码是照着哪一版写的」
 *    要能回答。读侧取 `fetched_at` 最新的那一行（`latestSnapshot`）。
 * 2. **同一个正文连着存两次是空操作。** 走查一次流程会读两三次同一个链接，第二次
 *    读到的如果还是同一份正文，多出来的那一行没有任何新信息，只会让「这一版用了
 *    多久」这种问题变得难答。`saveSnapshot` 因此先看最新一行：hash 相同就把它原样
 *    交回（`created: false`），不插新行。注意这个去重是**同一条需求**范围内的，
 *    而且只与**最新那一行**比——A→B→A 会留下三行，因为「回到了旧版」本身是一个
 *    值得记下来的事实。
 * 3. **hash 是正文的 sha256（十六进制）。** 只有它参与比对；`markdown` 是给人看
 *    的原件。
 */

/** 库句柄：`Db` 与事务句柄都满足（都只有 `execute` 这一条被用到）。 */
export type Writable = Pick<Db, 'execute'>;

export type Snapshot = {
  id: string;
  requirementId: string;
  url: string;
  markdown: string;
  hash: string;
  fetchedAt: Date;
};

export type SaveResult = {
  snapshot: Snapshot;
  /** false = 与最新一版正文相同，没有插入新行。 */
  created: boolean;
};

export function hashMarkdown(markdown: string): string {
  return createHash('sha256').update(markdown, 'utf8').digest('hex');
}

type Row = {
  id: string;
  requirement_id: string;
  url: string;
  markdown: string;
  hash: string;
  fetched_at: Date | string;
};

function toSnapshot(row: Row): Snapshot {
  return {
    id: row.id,
    requirementId: row.requirement_id,
    url: row.url,
    markdown: row.markdown,
    hash: row.hash,
    // pg 对 `timestamptz` 给的是 Date；string 那一支只是为了不让一个驱动差异
    // 把整条读路径变成 500。
    fetchedAt: row.fetched_at instanceof Date ? row.fetched_at : new Date(row.fetched_at),
  };
}

/** 一条需求最新的快照；没有就是 null（「还没读过 PRD」不是错误）。 */
export async function latestSnapshot(db: Writable, requirementId: string): Promise<Snapshot | null> {
  const res = await db.execute<Row>(sql`
    select id, requirement_id, url, markdown, hash, fetched_at
      from prd_snapshots
     where requirement_id = ${requirementId}
     order by fetched_at desc, ctid desc
     limit 1`);
  const row = res.rows[0];
  return row === undefined ? null : toSnapshot(row);
}

/**
 * 按 id 取一条。走查/评审拿着「这次评审用的是 snapshot id」回来复现时用它——
 * 那时候最新一行可能已经被 PRD 的新版本顶掉了。
 */
export async function snapshotById(db: Writable, id: string): Promise<Snapshot | null> {
  const res = await db.execute<Row>(sql`
    select id, requirement_id, url, markdown, hash, fetched_at
      from prd_snapshots
     where id = ${id}
     limit 1`);
  const row = res.rows[0];
  return row === undefined ? null : toSnapshot(row);
}

/**
 * 存一次读到的正文。
 *
 * `actor` 是本次动作的归属人。这一行本身没有 actor 列（快照是文档的事实，不是人
 * 的动作；动作在 `events` 里，由 `readPrd` 记），但签名与其余服务保持同形，
 * 调用方不必记两套顺序。
 *
 * 去重的并发口径：两次并发的 fetch 可能各插一行相同 hash 的行（先读后写之间没有
 * 锁）。那不会读错——两行正文一样、hash 一样，`latestSnapshot` 取哪一行都是同一份
 * 内容——所以这里不加唯一约束（加了反而会让 A→B→A 这类历史写不进去）。
 */
export async function saveSnapshot(
  db: Writable,
  actor: string,
  input: { requirementId: string; url: string; markdown: string },
): Promise<SaveResult> {
  void actor;
  const hash = hashMarkdown(input.markdown);
  const latest = await latestSnapshot(db, input.requirementId);
  if (latest !== null && latest.hash === hash) return { snapshot: latest, created: false };

  const res = await db.execute<Row>(sql`
    insert into prd_snapshots (requirement_id, url, markdown, hash)
    values (${input.requirementId}, ${input.url}, ${input.markdown}, ${hash})
    returning id, requirement_id, url, markdown, hash, fetched_at`);
  const row = res.rows[0];
  if (row === undefined) throw new Error('保存 PRD 快照失败：insert 没有返回行');
  return { snapshot: toSnapshot(row), created: true };
}

/** 一条需求有过几版（走查报告里的「PRD 改过 4 次」）。 */
export async function snapshotCount(db: Writable, requirementId: string): Promise<number> {
  const res = await db.execute<{ n: string }>(sql`
    select count(*)::text as n from prd_snapshots where requirement_id = ${requirementId}`);
  const n = Number.parseInt(res.rows[0]?.n ?? '0', 10);
  return Number.isFinite(n) ? n : 0;
}
