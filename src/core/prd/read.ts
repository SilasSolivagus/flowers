import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { AppError } from '../errors.js';
import { recordEvent } from '../events.js';
import { readDoc, type DocFailCode, type DocKind } from './wecom.js';
import { saveSnapshot, type Snapshot } from './snapshots.js';

/**
 * `readPrd()`：走查与评审都调的那一个入口。
 *
 * 三步，没有 UI，也没有缓存：
 *
 * 1. 取需求 → 它必须有 `prd_url`（没有就是一句中文失败，点明缺的是什么）；
 * 2. `readDoc()` 把链接读成 Markdown（失败码与中文消息原样往上抛，不翻译第二遍——
 *    两处翻译一定会分叉）；
 * 3. 同一个事务里：落一行快照（同 hash 是空操作）+ 写一条 `prd.fetched` 事件。
 *
 * 为什么**每次 fetch 都写事件**（包括去重的那一次）：事件记的是「读了」，快照记的
 * 是「读到了什么」。一次走查里同一个链接被读三次、正文没变，事件应该有三条——
 * 这样「这份 PRD 被谁在什么时候读过」才答得出来；而快照只有一行，因为正文没变。
 *
 * 失败一律 `{ ok:false, code, message }`：调用方（走查流程、评审页、将来的 MCP
 * 工具）都有同一个分支形状，不必为「读文档」这一格单独写 try/catch。
 */

export type PrdFailCode = DocFailCode | 'bad_id' | 'not_found' | 'missing_prd_url' | 'write_failed';

export type PrdFetched = {
  snapshot: Snapshot;
  /** false = 正文与上一版相同，没有新行。 */
  created: boolean;
  title: string | null;
  kind: DocKind;
};

export type PrdReadResult =
  | { ok: true; data: PrdFetched }
  | { ok: false; code: PrdFailCode; message: string };

export const EVENT_PRD_FETCHED = 'prd.fetched';

const BAD_ID = '需求 ID 格式不正确';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 读一条需求的 PRD，并把这一版存成快照。
 *
 * `actor` 只进事件（`events.actor`）：快照是文档的事实，不是人的动作。
 */
export async function readPrd(
  db: Db,
  actor: string,
  input: { requirementId: string },
): Promise<PrdReadResult> {
  const requirementId = typeof input?.requirementId === 'string' ? input.requirementId.trim() : '';
  // 先校验成 uuid 再进 SQL：非 uuid 会被 PG 以 22P02 拒掉，那不是我们能翻成中文的错误。
  if (!UUID.test(requirementId)) return { ok: false, code: 'bad_id', message: BAD_ID };

  // `deleted_at is null`：软删的含义就是「从每一条读路径上消失，只为历史保留」，而
  // 读 PRD 是一条读路径。少了这一句，一条已经不在板上的需求仍能被抓正文、落一行
  // `prd_snapshots`、写一条 `prd.fetched` —— 那是「一条不存在的需求在产出快照」。
  // 对软删的行返回与「真的没有这一行」同样的 not_found：调用方本来就只认这一种
  // 缺席（不新开错误码，不让删除与不存在分成两种故事）。
  const found = await db.execute<{ prd_url: string | null }>(sql`
    select prd_url from requirements
     where id = ${requirementId} and deleted_at is null
     limit 1`);
  const row = found.rows[0];
  if (row === undefined) return { ok: false, code: 'not_found', message: '找不到这条需求' };

  const url = (row.prd_url ?? '').trim();
  if (url === '') {
    return {
      ok: false,
      code: 'missing_prd_url',
      message: '这条需求没有 PRD 链接（prd_url 是空的）：提交评审时填上链接，走查才有东西可读',
    };
  }

  const doc = await readDoc(url);
  if (!doc.ok) return { ok: false, code: doc.code, message: doc.message };

  try {
    return await db.transaction(async (tx) => {
      // 同一事务：快照与事件要么都在，要么都不在。只落事件不落快照，会留下一条
      // 「读到了但没存」的假历史；反过来则是一条没人知道来自哪次读的快照。
      const { snapshot, created } = await saveSnapshot(tx, actor, {
        requirementId,
        url,
        markdown: doc.markdown,
      });
      await recordEvent(tx, {
        requirementId,
        actor,
        type: EVENT_PRD_FETCHED,
        payload: { url, hash: snapshot.hash, chars: doc.markdown.length },
      });
      return { ok: true as const, data: { snapshot, created, title: doc.title, kind: doc.kind } };
    });
  } catch (error) {
    const message = error instanceof AppError ? error.message : (error instanceof Error ? error.message : String(error));
    return { ok: false, code: 'write_failed', message: `PRD 读到了但没存下来：${message}` };
  }
}
