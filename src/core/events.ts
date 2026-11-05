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
