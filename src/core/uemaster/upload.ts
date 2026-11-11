import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';

import type { Db } from '../../db/client.js';
import { AppError } from '../errors.js';
import { attachArtifact } from './attach.js';
import { isStage, type Stage } from './packs.js';
import { MAX_UPLOAD_BYTES, artifactUrl } from './store.js';
import { nextArtifactVersion, versionedFileOf } from './versions.js';

/**
 * 上传产物（2026-11-11）：把**本地生成好的 HTML** 直接交回来。
 *
 * 之前只有两条路：站内路径（文件得已经在服务器上）或 http(s) 外链。让 agent 在
 * 自己电脑上跑 UEmaster 生成一份 HTML 时，两条都不通——这是 MCP 侧最后一个硬缺口。
 *
 * 这条口子只做三件事，业务规则一条不新增：
 * 1. 形状：必须是 `.html`、不超过 `MAX_UPLOAD_BYTES`（5 MB）、内容里得有 HTML 的样子；
 * 2. 落盘：`data/uemaster/PAN-<n>/<stage>-v<NNN>.html`——版本号与生成器同一个函数算，
 *    不会覆盖历史版本；
 * 3. 交回：写完之后调**同一个** `attachArtifact`，所以状态、权限、事件、指纹行为
 *    与「人贴链接」完全一致（也不改状态）。
 */
export async function uploadArtifact(
  db: Db,
  actor: string,
  input: { requirementId: string; stage: string; fileName: string; bytes: Uint8Array },
): Promise<{ stage: Stage; url: string }> {
  const stage = input.stage.trim();
  if (!isStage(stage)) throw new AppError('invalid_stage', '阶段只能是 evaluate、review、inspect 之一');

  if (!/\.html?$/i.test(input.fileName)) {
    throw new AppError('invalid_file', '只收 .html 文件（UEmaster 的产物是 HTML）');
  }
  if (input.bytes.byteLength === 0) throw new AppError('invalid_file', '文件是空的');
  if (input.bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new AppError('file_too_large', `文件不能超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`);
  }
  const text = Buffer.from(input.bytes).toString('utf8');
  if (!/<(html|body|div|section)[\s>]/i.test(text)) {
    throw new AppError('invalid_file', '这个文件不像 HTML：没有 html/body/div/section 标签');
  }

  const found = await db.execute<{ id: string; number: number }>(
    sql`select id, number from requirements where id = ${input.requirementId} and deleted_at is null`);
  const row = found.rows[0];
  if (row === undefined) throw new AppError('not_found', '需求不存在');

  const version = await nextArtifactVersion(db, row.id, Number(row.number), stage);
  const file = versionedFileOf(Number(row.number), stage, version);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, 'utf8');

  // 走同一条 attach：权限、事件、状态都在那一处，不在上传口子里另写一份。
  const attached = await attachArtifact(db, actor, {
    requirementId: row.id, stage, url: artifactUrl(file),
  });
  return { stage: attached.stage, url: attached.url };
}
