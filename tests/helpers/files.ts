import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ARTIFACT_ROOT } from '../../src/core/uemaster/store.js';
import { dataLayout, isTestDataRoot, TEST_DATA_PREFIX } from '../../src/core/runtime-dir.js';

/**
 * 站内产物文件的测试助手。
 *
 * `attachArtifact` 现在会 stat 站内链接（没有文件就是 `artifact_missing`），所以
 * 任何「attach 一个 /uemaster/... 」的用例都必须先在磁盘上造出那个文件。
 *
 * 解析口径与服务层**同一套**：直接 import `ARTIFACT_ROOT`，而不是自己再拼一遍
 * `仓库根/data/uemaster`。2026-11-08 起产物根搬到了**仓库外**（见
 * `src/core/runtime-dir.ts`：`git clean -fdx` 删过它一次，库里行还在、文件没了），
 * 助手若还按旧路径拼，用例会往一个空目录里造文件，而服务层看的是另一个目录——
 * 那种失败会表现成一堆「文件不存在」，查起来极贵。
 *
 * 用例进程里 `FLOWERS_DATA_DIR` 由 `vitest.config.ts` 指到临时目录，所以这里造的
 * 文件绝不会落进开发者**真的** `~/Library/Application Support/flowers`。
 */
export { REPO_ROOT } from '../../src/core/runtime-dir.js';

/**
 * 数据根：从**同一个解析器**重新算一遍，而不是 `dirname(ARTIFACT_ROOT)`。
 *
 * `ARTIFACT_ROOT` 是模块加载时算好的常量；用例里若有人改了 `FLOWERS_DATA_DIR`
 * （`tests/runtime-dir.test.ts` 就会改），常量不会跟着动。目录这件事只有一个答案。
 */
export const DATA_ROOT = dataLayout().root;

/**
 * 破坏性操作之前的那道门：**这个根必须是测试的盘**。
 *
 * 为什么非要一条守卫在这里（2026-11-08 的事故就是它缺席造成的）：
 * `cleanArtifacts()` 里是一句 `rm -rf`，而它用的路径来自**生产代码**的
 * `ARTIFACT_ROOT`。只要「测试进程的根」与「生产的根」有可能相等——一个漏设的
 * `FLOWERS_DATA_DIR`、一次在普通 shell 里 `node --run` 跑到的调用——这条路径就会
 * 把开发机上**真**的产物全删掉：库里 `uemaster_artifacts` 的行还在，抽屉里那条
 * `/uemaster/PAN-11/evaluate.html` 点开是 404，而 `git status` 是干净的、当场没人发现。
 * 库与库之间我们靠「每轮一张库」隔开了，盘也要有同一条硬线。
 *
 * 判据（`isTestDataRoot`，两条同时成立）：在系统临时目录下、且目录名带
 * `flowers-test-` 前缀。判据放在 `src/core/runtime-dir.ts`，与生产侧解析器同一份。
 */
export function assertTestDataRoot(what: string): string {
  if (isTestDataRoot(DATA_ROOT)) return DATA_ROOT;
  throw new Error(
    `拒绝${what}：数据根是「${DATA_ROOT}」，它看起来不是测试的盘`
    + `（测试盘必须是系统临时目录下、以 ${TEST_DATA_PREFIX} 开头的目录）。`
    + '这一步会 rm -rf 整棵产物树——如果这个根是生产的，几百份别人的评审材料就没了。'
    + '请确认测试进程带着 FLOWERS_DATA_DIR=$TMPDIR/'
    + `${TEST_DATA_PREFIX}<runId>（npx vitest run 会自动设，见 vitest.config.ts）。`,
  );
}

/** 站内路径 → 磁盘路径（`/uemaster/PAN-7/x.html` → `<产物根>/PAN-7/x.html`）。 */
export function siteFile(url: string): string {
  const rest = url.startsWith('/uemaster/') ? url.slice('/uemaster/'.length) : url.replace(/^\//, '');
  return path.join(ARTIFACT_ROOT, rest);
}

/** 造一个产物文件（父目录一并建）。 */
export async function writeArtifact(
  url: string,
  html = '<!doctype html><meta charset="utf-8"><title>artifact</title>',
): Promise<string> {
  // 写入侧同样不许碰生产的根：往那儿写一份假产物，等于让「生成中 / 已交回」这类
  // 判断题在真数据上跑用例，事后还查不出是谁写的。
  assertTestDataRoot('在测试里写产物');
  const file = siteFile(url);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, html, 'utf8');
  return file;
}

/** 删掉一个产物文件（用于「文件被移走」这类用例）。 */
export async function removeArtifact(url: string): Promise<void> {
  await rm(siteFile(url), { force: true });
}

/** 文件在不在。 */
export async function artifactExists(url: string): Promise<boolean> {
  try {
    return (await stat(siteFile(url))).isFile();
  } catch {
    return false;
  }
}

/**
 * 清掉整个产物根。
 *
 * 只在测试里调用，两个理由：**下一条用例要能确定地问「这个文件不在」**；以及本轮
 * 之后产物根在 `FLOWERS_DATA_DIR`（测试里是临时目录）下，跑完不该留东西。
 * 目录本身删掉再建回来：`ARTIFACT_ROOT` 是模块加载时算好的常量，之后要能继续用。
 */
export async function cleanArtifacts(): Promise<void> {
  assertTestDataRoot('清空产物树');
  await rm(ARTIFACT_ROOT, { recursive: true, force: true });
  await mkdir(ARTIFACT_ROOT, { recursive: true });
}
