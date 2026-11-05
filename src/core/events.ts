import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { translatePgError } from './errors.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * 写一条事件。
 *
 * `seq` 由 events_seq_seq 分配（列上有 default），这里**不写**它，也不再扫
 * `max(seq)+1`：那是一次读—算—写，并发事务会算出同一个值，输的那个撞
 * events_pkey。序列的 nextval 是原子的，并发调用只会得到不同的值。
 *
 * 唯一冲突仍然在这里翻成 AppError（见 errors.ts）：未来若真撞上，控制器拿到的是
 * `code: 'conflict'`，而不是一句英文的 duplicate key。
 */
export async function recordEvent(
  tx: Tx,
  input: { requirementId: string | null; actor: string; type: string; payload: unknown },
) {
  try {
    await tx.execute(sql`
      insert into events (requirement_id, actor, type, payload)
      values (
        ${input.requirementId}, ${input.actor}, ${input.type},
        ${JSON.stringify(input.payload)}
      )`);
  } catch (error) {
    throw translatePgError(error);
  }
}
