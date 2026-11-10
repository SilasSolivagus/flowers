import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { ARTIFACT_ROOT } from './store.js';
import { versionedName, type Stage } from './packs.js';

/**
 * 「产物落到第几个文件名」这件事的唯一一处（2026-11-10 owner 的第一次纠正）。
 *
 * ── 修的是什么
 *
 * 在这之前产物路径是写死的 `data/uemaster/PAN-47/evaluate.html`：同一条需求生成两次，
 * 第二份**覆盖**第一份，而 `uemaster_artifacts` 里是两行。库说「存过两版」，磁盘上只有
 * 一份文件——两边对不上账，而「历史版本」这个说法在磁盘上根本不成立（实测 PAN-47：
 * 两行，一份文件）。材料是不可重建的（那是当时给人看过的图），覆盖就是丢。
 *
 * ── 名字的形状：`evaluate-v001.html`
 *
 * 选版本号而不是时间戳，因为**版本号是读者要的那个数字**：抽屉里写「第 3 版」、
 * 历史行写「v2」，文件名与界面能对上；时间戳文件名只能让人再去查一次库里那一行。
 * 三位零填充（`v001`）是为了**自然排序**：不填充时 `ls` 会把 `-v10` 排在 `-v2` 前面
 * （字典序 ≠ 版本序），而「版本化」的一半价值就是「按名字排出来就是时间顺序」。
 * 999 版之内这条都成立；真到第 1000 版名字会变成 `v1000` 重新破序——那时它已经是
 * 「同一需求重做过一千次」的极端情形，不值得为它牺牲现在的可读性。
 *
 * 拼名字的纯函数在 `packs.ts`（`versionedName`），因为**任务包也要写同一个名字**：
 * 包对外部 CLI 说的那句「写到 data/uemaster/PAN-7/evaluate-v001.html」与这里落盘的
 * 必须是同一个字符串，而 `packs.ts` 是两者都依赖、且不依赖 db / 磁盘的那一层。
 *
 * ── 只改「新写的」，不改「已经写过的」
 *
 * 存量那些 `evaluate.html` 一个字节都不动（那是历史，磁盘上剩的哪份就是哪份），
 * 它们的「内容已被覆盖」由 0036 那条迁移在库里标注（`content_lost`），由抽屉如实说出来。
 * 清理旧文件不在这一版的范围（盘很小，删了才是真丢）。
 *
 * 导出 `versionedName` 只为让调用方少记一个模块名：真身仍在 `packs.ts`。
 */
export { versionedName };

/** 磁盘上认这个形状（与 `versionedName` 同一件事的读法；`\d+` 兼容将来的四位）。 */
const VERSIONED_FILE = /^(evaluate|review|inspect)-v(\d+)\.html$/;

/** 产物目录：`<产物根>/PAN-7`。`number` 已经是整数（调用方从库里读的编号）。 */
export function artifactDirOf(number: number): string {
  return path.join(ARTIFACT_ROOT, `PAN-${number}`);
}

/** 一份版本化产物的绝对路径。 */
export function versionedFileOf(number: number, stage: Stage, version: number): string {
  return path.join(artifactDirOf(number), versionedName(stage, version));
}

/**
 * 磁盘上这一阶段已有的最大版本号（没有就 0）。
 *
 * 为什么要看盘、而不是只看库里的行数：两边会漂——有人手工删过一行、或者一次 attach
 * 失败但文件已经写下来了。**写文件这件事只能以盘为准**：算出来的号若与盘上某份同名，
 * 那份历史就被这一版覆盖，正是要修的那个 bug。
 *
 * 读目录失败（目录还不存在 = 第一次生成）按 0 处理：那不是一个错误，是新的一格。
 */
export async function highestVersionOnDisk(number: number, stage: Stage): Promise<number> {
  try {
    const names = await readdir(artifactDirOf(number));
    let highest = 0;
    for (const name of names) {
      const found = VERSIONED_FILE.exec(name);
      if (found === null || found[1] !== stage) continue;
      highest = Math.max(highest, Number(found[2]));
    }
    return highest;
  } catch {
    return 0;
  }
}

/**
 * 下一次生成该用第几版。
 *
 * 两个来源取**大者 + 1**：
 * - 库里的行数（`uemaster_artifacts`）——那是「存过几版」的官方口径，抽屉的「第 N 版」
 *   与它同源。存量那些指向 `evaluate.html` 的行也算在内，所以 PAN-47 的下一版是 v003
 *   （v1 / v2 的内容已被覆盖，号不重复用）。
 * - 磁盘上的最大版本号——防止一次 attach 失败留下的孤儿文件被同名覆盖。
 *
 * 并发的安全性来自调用点而不是这里：同一条需求的同一个阶段同一时刻只可能有一条
 * `running` 作业（`uemaster_jobs_running_unique`），所以两次「按下生成」不会同时算出版本号。
 * 本函数仍然是纯读的，不占事务、不留痕迹。
 */
export async function nextArtifactVersion(
  db: Db, requirementId: string, number: number, stage: Stage,
): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from uemaster_artifacts
     where requirement_id = ${requirementId} and stage = ${stage}`);
  const stored = Number(rows.rows[0]?.n ?? 0);
  const onDisk = await highestVersionOnDisk(number, stage);
  return Math.max(stored, onDisk) + 1;
}
