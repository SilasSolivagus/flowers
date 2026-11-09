import type { Db } from '../../db/client.js';

import { isIndexable } from './code-index.js';
import { syncRepoIndex } from './index-store.js';
import { lsTreeEntries } from './mirror.js';
import { coverageCounts, type CoverageRow } from './repo-coverage.js';

/**
 * 「测一个仓的覆盖率」——**与传输方式无关的那一半**（2026-11-09 从
 * `scripts/onboard-repos.ts` 里提出来）。
 *
 * ── 为什么必须提出来（这是 Fix 2 的全部内容）
 *
 * `onboard-repos.ts` 是**接入**流程：它要 `clone`、要 `du`/`df`、要 `symbolic-ref`，
 * 所以它写死了走 `ssh <host> git …`，并且在 `transport !== 'ssh'` 时**直接退出**
 * （那是它对的做法：它的参数全是服务器约定）。而 2026-11-09 的 cutover 把镜像搬到了
 * 本机盘（`transport = local`）——于是「量覆盖率」这件事随接入那套一起离线了：
 * GitLab 那 75 个仓 `repo_coverage` 里一行都没有，`files_total`/`files_indexed` 读的人
 * 只能看见 codeup 那一批。表因此有了一个**看起来完整**的缺口。
 *
 * 测量本身从来没有依赖 ssh：`lsTreeEntries()` / `syncRepoIndex()` 都走
 * `mirror.ts` 的只读层，那一层两种传输都认（`config.transport === 'local'` 时用本地
 * git）。所以这里只做一次搬家，不写第二套实现：`coverageCounts()` 仍然是数出五个数的
 * 唯一地方，`recordCoverage()` 仍然是写行的唯一地方。
 *
 * 调用方：
 * - `scripts/onboard-repos.ts`（接入：clone 完就地量一次）；
 * - `scripts/measure-coverage.ts`（补测：镜像已经在盘上，只量不克隆）。
 */

export type MeasuredCounts = Pick<
  CoverageRow,
  'filesTotal' | 'filesIndexed' | 'filesSkippedGenerated' | 'pages' | 'outlineFiles' | 'imports'
>;

export type MeasureResult = { ok: true; counts: MeasuredCounts } | { ok: false; error: string };

/**
 * 索引一个仓并量出覆盖率五格。失败一律是 `{ ok: false, error }`，不抛。
 *
 * `files_total` 来自 `ls-tree`，与索引不是同一趟 I/O：索引只回答「我记得什么」，
 * 树回答「实际有多少」——两者的差就是这张表的全部意义，所以必须真去列一次。
 * （`lsTreeEntries` 已经去掉了噪音目录，所以 `files_total` 是「去噪之后」的数，
 * 与 `repo_coverage` 一直以来的口径一致。）
 *
 * 顺序：**先列树，再索引**。理由只在失败路径上——索引失败时那句「git cat-file 读取超时」
 * 本身不含任何量级信息，读的人无法判断是「仓坏了」还是「这个仓有 1.3 万个文件、
 * 单个 blob 106 MB」（`beats` 就是后者）。把树先数出来，失败原因就能带上「树里有 N 个文件」，
 * 这是 `repo_coverage.error` 这一列唯一的价值：让下一次的人不用重新跑一遍才知道为什么。
 */
export async function measureRepo(db: Db, repo: string, sha: string): Promise<MeasureResult> {
  const tree = await lsTreeEntries(repo, { ref: sha });
  if (!tree.ok) return { ok: false, error: `列树失败：${tree.message}` };
  const synced = await syncRepoIndex(db, repo, sha);
  if (!synced.ok) {
    return { ok: false, error: `索引失败（树里 ${tree.data.length} 个文件）：${synced.message}` };
  }
  return { ok: true, counts: coverageCounts(synced.data.index, tree.data.length) };
}

/**
 * `files_indexed = 0` 的**一词原因**。顺序就是判据的顺序，每一步都能从树上看出来：
 *
 * 1. `generated`：有可索引的文件，但全被判成生成代码（`files_skipped_generated` 顶到可索引数）；
 * 2. `language`：仓里有源码，只是**不是**我们在解析的语言（Java/PHP/Python…）——解析器只认
 *    `ts|tsx|js|jsx|mjs|cjs|vue|go` 与 `pages.json`；
 * 3. `docs`：只有文档与图片，没有源码；
 * 4. `config`：只有配置/数据（yml、lock、Dockerfile、csv…）——空仓也算这一类（它一个文件都没有）；
 * 5. `other`：上面都不成立（这句话本身就是下一次要看的线索）。
 */
export type ZeroCause = 'generated' | 'language' | 'docs' | 'config' | 'other';

const DOC_EXT = /\.(?:md|mdx|txt|rst|adoc|pdf|png|jpe?g|gif|svg|ico|webp|woff2?|ttf)$/i;
const CODE_EXT = /\.(?:java|kt|kts|scala|py|rb|php|cs|c|cc|cpp|h|hpp|rs|swift|m|mm|pl|lua|dart|ex|exs|erl|clj|sh|bash|zsh|ps1|bat)$/i;

export function zeroCauseOf(entries: readonly { path: string }[], filesSkippedGenerated: number): ZeroCause {
  // 「可索引」的判据只留一份：`isIndexable()`（`code-index.ts`）。在这里另写一条扩展名
  // 白名单会让这张表与索引自己数出来的 `files_indexed` 用两套口径——那正是这张表
  // 存在的理由被破坏的方式。
  const indexable = entries.filter((entry) => isIndexable(entry.path));
  if (indexable.length > 0 && filesSkippedGenerated >= indexable.length) return 'generated';
  if (indexable.length > 0) return 'other';
  if (entries.some((entry) => CODE_EXT.test(entry.path))) return 'language';
  const nonDoc = entries.filter((entry) => !DOC_EXT.test(entry.path));
  if (nonDoc.length === 0) return entries.length === 0 ? 'config' : 'docs';
  return 'config';
}
