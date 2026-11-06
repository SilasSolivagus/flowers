import { access, constants } from 'node:fs/promises';
import path from 'node:path';
import { CANDIDATES, commandReady, type Candidate } from './candidates.js';

/**
 * 探测：PATH 里有哪些生成器可执行文件。
 *
 * **只查文件系统，不执行任何东西。** 这是本文件唯一一条硬规矩，而它来自本机的一条
 * 实证：`codex login status` 打印 "Logged in using ChatGPT"，紧接着 `codex exec`
 * 却回 401 `refresh token already used`。`codex auth status` 一类的探针报告的是
 * **凭证文件的样子**，不是「现在真的能跑」；`claude auth status` 同样只说
 * `{"loggedIn": false}`，不说它到底能不能生成。把它们当检测依据，等于把一句可能
 * 会撒谎的话当成了答案。
 *
 * 所以分工是：
 * - 这里回答「要不要把它**列出来**」（PATH 里有没有这个可执行文件）；
 * - `generator.ts` 的 `testGenerator` 回答「它**能不能用**」（真跑一次）。
 * 界面上的「通过 / 未通过测试」只认后者。
 *
 * 便宜且缓存：一次 `detect()` 最多是五个 `access`（每个可能跨几个 PATH 目录）。
 * 缓存按 PATH 字符串做键——同一个进程里 PATH 不变就不会重复查；PATH 变了
 * （用例里会这么干）缓存自动失效，不需要谁记得手动清。
 */

export type Detected = {
  candidate: Candidate;
  /** 命令能不能直接跑（`ollama run <模型名>` 这种还是 false）。 */
  ready: boolean;
};

/** PATH 里有没有这个可执行文件（不执行它）。 */
async function onPath(name: string): Promise<boolean> {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir === '') continue;
    try {
      await access(path.join(dir, name), constants.X_OK);
      return true;
    } catch {
      // 继续找下一个目录：找不到是常态，不是错误。
    }
  }
  return false;
}

/** 一个进程一份缓存，键是 PATH 的当前值。 */
let cache: { key: string; found: Detected[] } | null = null;

/**
 * 探测结果，按 `CANDIDATES` 的顺序。
 *
 * 不抛错：一个都探不到是**一种正常状态**（新机器、干净的 CI），由调用方决定
 * 是禁用按钮还是给一句指路的话。
 */
export async function detect(): Promise<Detected[]> {
  const key = process.env.PATH ?? '';
  if (cache !== null && cache.key === key) return cache.found;

  const found: Detected[] = [];
  for (const candidate of CANDIDATES) {
    if (candidate.binary === null) continue; // 自建：没有可探测的文件名
    if (await onPath(candidate.binary)) {
      found.push({ candidate, ready: commandReady(candidate.command) });
    }
  }

  cache = { key, found };
  return found;
}

/**
 * 清缓存。用例在同一个进程里改 PATH 时用；生产路径上不需要——缓存本来就是按
 * PATH 值失效的。
 */
export function clearDetectionCache(): void {
  cache = null;
}
