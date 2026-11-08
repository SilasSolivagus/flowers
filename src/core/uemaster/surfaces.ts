import type { Db } from '../../db/client.js';
import { head } from '../codemirror/mirror.js';
import { repoIndex } from '../codemirror/index-store.js';
import {
  EMPTY_SURFACES, knownSurfaces, pagesOutlineMissing,
  type KnownSurface, type KnownSurfaces,
} from '../locate/copy.js';

/**
 * 「现在有哪些页面」——评估提示词的上下文，从代码索引里读。
 *
 * 为什么单独一个模块而不是塞进 `compose.ts`：compose 只该知道**提示词要什么形状**，
 * 不该知道镜像怎么读。这条边界也是用例能不发一次 ssh 的原因——读口在这里注入。
 *
 * 两条硬规则，都是「宁可不说」：
 *
 * 1. **任何一个仓读不到，整份清单作废（返回空清单）**。读不到 = ssh 失败、建索引失败，
 *    或这个仓的页面**一行组件轮廓都没读到**（`pagesOutlineMissing`：0032 之前索引过的
 *    仓 `outline` 永远是 null，见 `copy.ts` 那个函数的注释）。后一种比前一种更阴：
 *    清单非空、每页都写着「没读到组件」，读者分不出「扫过、确实没有」和「压根没扫」。
 * 2. **失败不抛**。这份清单只是上下文，不是结论；读不到就说不出「现有页面」，
 *    材料照旧生成——只是这一次不计入基线（报告里要写明哪几份没测到）。
 *
 * 第三条是 C1 的裁决：**清单的覆盖率必须写进提示词**。`complete === false` 的三种来源
 * （仓被跳过、仓的轮廓全空、`SURFACE_LIMIT` 截断）各自给一句话，`compose.ts` 会把
 * 「不要假设清单之外还有页面」那句换成「本清单不完整：…」。没有这条信号时，一句话
 * 一半清单的语气比空清单更权威，而被漏掉的页面全都会被材料标成「新增」。
 *
 * 顺序 = 声明顺序。`123pan-uni-app` 在前：它有 27 页，`123pan-pc` 只有 2 页
 * （Task 2b+3 的实测数字），先列页多的那个，模型的注意力才不会被两行 pc 占掉。
 */
export const SURFACE_REPOS = ['123pan-uni-app', '123pan-pc'] as const;

/** 一份清单最多几页。两个仓 29 页，正常路径不会截断；换大仓时它兜底并让 `complete` 变 false。 */
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
 *
 * 也正因为这份名单是写死的，「只覆盖 X 仓」这句话才必须进提示词：被产品决定排除在外的
 * 那个仓的页面，在材料里只能算「不确定」，不能算「不存在」。
 */
export async function loadKnownSurfaces(
  db: Db,
  deps: SurfaceDeps = LIVE,
): Promise<KnownSurfaces> {
  const surfaces: KnownSurface[] = [];
  const covered: string[] = [];
  const gaps: string[] = [];
  let total = 0;
  let complete = true;

  for (const repo of SURFACE_REPOS) {
    let built: Awaited<ReturnType<typeof repoIndex>>;
    try {
      const h = await deps.head(repo);
      if (!h.ok || h.data === null) return EMPTY_SURFACES;
      built = await deps.repoIndex(db, repo, h.data.sha);
    } catch {
      // ssh 层自己抛也算「没读到」：这里不追因，材料里不该出现一个我们没验证的原因。
      return EMPTY_SURFACES;
    }
    if (!built.ok) return EMPTY_SURFACES;
    const one = knownSurfaces(built.data.index, SURFACE_LIMIT);
    total += one.total;
    if (!one.complete) {
      complete = false;
      if (one.note !== null) gaps.push(`${repo} ${one.note}`);
    }
    // 整仓轮廓为空 = 这一仓的组件清单**没读到**（0032 之前索引过的仓就是这一格）。
    // 与其列出 27 页「没读到组件」，不如把这一仓从清单里去掉、并说清原因。
    if (pagesOutlineMissing(built.data.index)) {
      complete = false;
      gaps.push(`${repo} 的组件轮廓没读到（可能还没按新口径重解析）`);
      continue;
    }
    surfaces.push(...one.surfaces);
    covered.push(repo);
  }

  if (surfaces.length === 0) return EMPTY_SURFACES;
  if (total > SURFACE_LIMIT) surfaces.length = Math.min(surfaces.length, SURFACE_LIMIT);
  if (covered.length !== SURFACE_REPOS.length) complete = false;
  // 只有一部分仓换来清单时，「本清单只覆盖 …」本身就是一个原因；和截断/空轮廓的原因拼在一起。
  const reasons = [...(covered.length === SURFACE_REPOS.length ? [] : [`本清单只覆盖 ${covered.join('、')}`]), ...gaps];
  return {
    surfaces,
    total,
    complete: complete && reasons.length === 0,
    note: reasons.length === 0 ? null : reasons.join('；'),
  };
}
