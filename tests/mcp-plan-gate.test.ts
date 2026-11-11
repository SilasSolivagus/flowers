import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { toolByName, runTool } from '../mcp/tools.js';
import { resetDb, seedPeople } from './helpers/db.js';
import { BRIEF } from './helpers/brief.js';
const who = { tokenId: 't', memberId: 'm', member: '吕品', scope: 'read' } as never;
beforeEach(async () => { await resetDb(); await seedPeople(); });
afterAll(async () => { await pool.end(); });
describe('MCP 出包门', () => {
  it('六问不齐 → evaluate 出包被拒（与生成同一句话）', async () => {
    const r = await createRequirement(db, '吕品', { ...BRIEF, allowDuplicate: true, title: '缺六问', type: 'feature', requester: 'x' });
    await db.execute(sql`update requirements set problem=null, outcome=null, surfaces=null, edge_cases=null, out_of_scope=null where id=${r.id}`);
    const res = await runTool(toolByName('uemaster_plan')!, who, { requirementId: r.id, stage: 'evaluate' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('还差');
  });
  it('六问齐 → 出包成功', async () => {
    const r = await createRequirement(db, '吕品', { ...BRIEF, allowDuplicate: true, title: '齐了', type: 'feature', requester: 'x' });
    const res = await runTool(toolByName('uemaster_plan')!, who, { requirementId: r.id, stage: 'evaluate' });
    expect(res.isError).toBeUndefined();
  });
});
