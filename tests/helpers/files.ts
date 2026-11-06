import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * 站内产物文件的测试助手。
 *
 * `attachArtifact` 现在会 stat 站内链接（没有文件就是 `artifact_missing`），所以
 * 任何「attach 一个 /uemaster/... 」的用例都必须先在 public/ 下造出那个文件。
 * 解析口径与 `src/core/uemaster/attach.ts` 的 `siteFile` 一致：仓库根的 public/。
 */
export const PUBLIC_ROOT = path.resolve(process.cwd(), 'public');

/** 站内路径 → 磁盘路径。 */
export function siteFile(url: string): string {
  return path.resolve(PUBLIC_ROOT, `.${url}`);
}

/** 造一个产物文件（父目录一并建）。 */
export async function writeArtifact(
  url: string,
  html = '<!doctype html><meta charset="utf-8"><title>artifact</title>',
): Promise<string> {
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
 * 清掉整个 `public/uemaster/` 树。
 *
 * 只在测试里调用：`.gitignore` 已经把 `public/uemaster/` 划成运行期产物，测试造的
 * 文件不该留在一个跑完的仓库里；更要紧的是**下一条用例要能确定地问「这个文件不在」**。
 */
export async function cleanArtifacts(): Promise<void> {
  await rm(path.join(PUBLIC_ROOT, 'uemaster'), { recursive: true, force: true });
}
