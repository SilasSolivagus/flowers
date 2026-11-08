import type { Db } from '../../db/client.js';
import { head } from '../codemirror/mirror.js';
import { repoIndex } from '../codemirror/index-store.js';
import { knownSurfaces, type KnownSurface } from '../locate/copy.js';

/**
 * 「现在有哪些页面」——评估提示词的上下文，从代码索引里读。
 *
 * 为什么单独一个模块而不是塞进 `compose.ts`：compose 只该知道**提示词要什么形状**，
 * 不该知道镜像怎么读。这条边界也是用例能不发一次 ssh 的原因——读口在这里注入。
 *
 * 两条硬规则，都是「宁可不说」：
 *
 * 1. **任何一个仓读不到，整份清单作废（返回空数组）**。半份清单比没有清单更坏：
 *    提示词写着「已知现有页面（共 N 个）」并声明「不要假设清单之外还有页面」，
 *    模型会把另半份里真实存在的页面标成「新增页面」——那正好是本任务要测的那个
 *    错误指标，而不完整的清单会**制造**它。评审的 `absent` 用同一条理由
 *    （`readBaselineInputs`：一个仓失败就整段 absent）。
 * 2. **失败不抛**。这份清单只是上下文，不是结论；读不到就说不出「现有页面」，
 *    材料照旧生成——只是这一次不计入基线（报告里要写明哪几份没测到）。
 *
 * 顺序 = 声明顺序。`123pan-uni-app` 在前：它有 27 页，`123pan-pc` 只有 2 页
 * （Task 2b+3 的实测数字），先列页多的那个，模型的注意力才不会被两行 pc 占掉。
 */
export const SURFACE_REPOS = ['123pan-uni-app', '123pan-pc'] as const;

/** 一份清单最多几页。两个仓 29 页，正常路径不会截断；换大仓时它兜底。 */
export const SURFACE_LIMIT = 40;

/** 读口（用例注入假的，生产用真镜像 + 真索引）。 */
export type SurfaceDeps = {
  head: typeof head;
  repoIndex: typeof repoIndex;
};

const LIVE: SurfaceDeps = { head, repoIndex };

/**
 * 读三个仓？不：只读 `SURFACE_REPOS`。
 *
 * `123pan-cross-frontend` 有 4 页、12 个轮廓文件（实测），已经接入索引，但它**不在**
 * 评估的语境里（评估讲的是「123 云盘这个产品的页面」）。把它列进来只会让模型把
 * 跨端设备页当成主产品页面。要改这份名单是产品决定，改完同步 `tests/evaluate-known-surfaces.test.ts`。
 */
export async function loadKnownSurfaces(
  db: Db,
  deps: SurfaceDeps = LIVE,
): Promise<KnownSurface[]> {
  const out: KnownSurface[] = [];
  for (const repo of SURFACE_REPOS) {
    let built: Awaited<ReturnType<typeof repoIndex>>;
    try {
      const h = await deps.head(repo);
      if (!h.ok || h.data === null) return [];
      built = await deps.repoIndex(db, repo, h.data.sha);
    } catch {
      // ssh 层自己抛也算「没读到」：这里不追因，材料里不该出现一个我们没验证的原因。
      return [];
    }
    if (!built.ok) return [];
    out.push(...knownSurfaces(built.data.index, SURFACE_LIMIT));
  }
  return out.slice(0, SURFACE_LIMIT);
}
