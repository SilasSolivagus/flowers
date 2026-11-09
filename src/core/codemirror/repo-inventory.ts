import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { REPO_ROOT } from '../runtime-dir.js';
import type { MirrorResult, RepoRef } from './mirror.js';

/**
 * 仓清单（`config/repos.txt`）：**「哪些仓」的唯一一份名单**。
 *
 * ── 为什么需要这一层（以及为什么不复用 `code.mirror.repos`）
 *
 * 现在已经有两套「仓列表」了，而且它们已经漂过一次：
 *
 * 1. `scripts/sync-mirrors.sh` 里的 `REPOS=(123pan-pc 123pan-uni-app)`——bash 用；
 * 2. `app_settings.code.mirror.repos`——TS 用（`resolveMirrorConfig()` 读它）。
 *
 * 2026-11-08 的 `123pan-cross-frontend` 就掉在这条缝里：设置里有它、数组里没有，于是
 * 服务器从来不去抓，镜像停在 10-21，材料上「代码快照较旧」挂了十几天。
 * 3 个仓时靠人记得同步两处还能撑住，139 个时不可能。
 *
 * 所以从这一版起：**清单是文件，设置是清单的投影**。
 *
 *     config/repos.txt ──(scripts/repos-apply.ts)──> app_settings.code.mirror.repos
 *            │
 *            └──(install-cron.sh rsync)──> dogyun:/opt/123pan/tools/_ro/repos.txt
 *                                              └── sync-mirrors.sh 读它
 *
 * 为什么不干脆让 TS 直接读文件、废掉设置：「现在这批仓是哪几个」是一个**部署状态**，
 * 材料的生成、走查、评审都在读它，读侧不该为了一个数字去碰文件系统（`server`/`local`
 * 两种传输、测试进程、MCP 进程都各有自己的 cwd）。文件是**录入界面**，设置是**读侧**，
 * 两者之间只允许一条路：`repos-apply.ts`。它在写之前先过 `parseRepos()`（`mirror.ts`
 * 的同一个解析器），所以「写进去的东西读不回来」在构造上不可能发生。
 *
 * ── 为什么是 text 而不是 JSON/YAML
 *
 * 三处要读它，其中一处是 **Linux 上的 bash**（服务器上没有 node）。JSON 得靠 jq，
 * YAML 得靠 yq，两者在服务器上都不保证有；而 `while read name branch` 是 POSIX。
 * 同时它也得对人友好：加一个仓 = 加一行 + commit，diff 里看得见。
 *
 * ── 分支为什么在清单里
 *
 * `sync-mirrors.sh` 以前对所有仓 fetch 同一个 `$BRANCH`。仓一多，这个假设立刻不成立
 * （有的仓主线叫 `master`、有的叫 `main`、有的就是 `dev`）。更麻烦的是**它的错法是安静的**：
 * 分支写错时 `head()` 读到的是另一个分支的最新提交，`mirror_health` 显示「很新」，
 * 而材料对着的是错的代码。所以分支是每仓一格，且是必填（不猜默认值）。
 *
 * ── 路径为什么在清单里（2026-11-09，这是 34 个仓「不存在」的真正原因）
 *
 * 克隆地址原来是**拼**的：`https://…/60f9058e68e2993a8e6d0750/123pan/<仓名>.git`。
 * 拼法把「仓在哪个组」写死成 `123pan`。而 `ListRepositories`（`x-total: 144`）的真实返回
 * 里，多数仓在**组织根**（`…/artifacts.git`）、少数在 `123pan/`、`cdn-groups/`、
 * `test-groups/`。于是我们拿 `…/123pan/artifacts.git` 去问，远端答
 * `未知的仓库路径`——一句听起来像「这个仓不存在」的话；证据（`repo_coverage.error`）
 * 于是被写成了「不存在」，而真相是**我们问错了地址**。
 *
 * 所以清单多一格 `path=`，值是**组织相对、含仓名**的整条路径（与 `real-repos.tsv`
 * 第二列逐字相同）：`apisrv`（根）、`123pan/apisrv`、`cdn-groups/beats`。
 * 克隆地址 = `CODEUP_ORG` + `/` + `path` + `.git`，**只在 `cloneUrlOf()` 一处拼**。
 *
 * 镜像目录名仍然是**裸仓名**（`/srv/123pan-mirror/<仓名>.git`）：66 个已有镜像不用改名，
 * 而 `path` 的最后一段被强制等于仓名（见 `parseRepoInventory` 的校验），所以
 * 「目录叫 A、地址指着 B」这种安静错法在解析阶段就不可能发生。
 *
 * ── 第三格 `stale_after_days` 为什么在这里（2026-11-09）
 *
 * 镜像新鲜度的判据一直是**全局一个数**（`MIRROR_STALE_DAYS = 7`）。仓少的时候够用，仓多
 * 之后它把两类完全不同的事混成一条红点：
 *
 * - 「这个仓真的停摆了」——该报，而且是越早越好；
 * - 「这个仓的上游本来就一年不动一次」——`123pan-virtuallist-antd` 停在 2023-06（1254 天）、
 *   `123pan-ele-react` 364 天、`share` 339 天。这类仓每晚各产一条提醒，owner 的铃铛里
 *   从此常驻 5–6 条**永远不会消失**的红点。永远非零的告警不再是信号。
 *
 * 所以阈值要按仓定，而**按仓的属性属于清单**（它描述的是「我们这个仓是什么」），不属于
 * 读侧的测量表（`mirror_health` 存的是「它现在怎样」）。这也是为什么这一格**不落库、
 * 不需要迁移**：清单本身就是这份策略的存储，读侧每次从文件里读一次。
 *
 * 语义：超过这么多天才报；`never` = 不因「上游不动了」报。**同步失败照报**（`ok = false`
 * 那条判据不看这一列）——「上游死了」与「我们抓不到」是两件事，不能因为前者被静音
 * 而把后者一起吞掉。
 */

/** 服务器上 bare 镜像的根目录。与 `scripts/sync-mirrors.sh` 的 `MIRROR_ROOT` 同一个默认值。 */
export const DEFAULT_MIRROR_ROOT = '/srv/123pan-mirror';

/**
 * codeup 的**组织根**（不是 `123pan` 组）。克隆地址 = `CODEUP_ORG/<path>.git`。
 *
 * ── 为什么这一层必须存在（2026-11-09 的那次根因）
 *
 * 在这之前，克隆地址是**拼**出来的：`${CODEUP_ORG}/123pan/${仓名}.git`。这个拼法把
 * 「仓在哪个组」这件事写死成了 `123pan`。而 `ListRepositories` 的真实返回（144 个仓）里，
 * 大部分仓就在**组织根**下（`…/artifacts.git`）、少数在 `123pan/`、`cdn-groups/`、
 * `test-groups/` 下。于是那 26 个仓的失败长得像「仓不存在」（`未知的仓库路径`），
 * 而实际上是**我们问错了地址**：`…/123pan/artifacts.git` 当然不存在，
 * 存在的是 `…/artifacts.git`。
 *
 * 这就是为什么清单要带 `path=`：组路径是**仓的属性**，不是可以拼出来的常量。
 */
export const CODEUP_ORG = 'https://codeup.aliyun.com/60f9058e68e2993a8e6d0750';

/**
 * 清单里没写 `path=` 时的兜底组。故意等于历史默认值——旧清单（只有 `仓名 分支`）逐行
 * 读出来仍然指向它原来指向的那个地址，不会因为这次改格式而全体漂到别处。
 */
export const DEFAULT_GROUP = '123pan';

/** 清单里没写分支时的兜底。**故意只用于「这一行只有仓名」这种明确省略**，见 `parseRepoInventory`。 */
export const FALLBACK_BRANCH = 'master';

/**
 * 清单默认位置。`FLOWERS_REPO_INVENTORY` 可以整条覆盖——用例与「从别处拷来的清单」用。
 * 相对路径按仓库根解析一次，而不是留给下游各自去猜 cwd。
 */
export function inventoryPath(env: Record<string, string | undefined> = process.env): string {
  const override = (env.FLOWERS_REPO_INVENTORY ?? '').trim();
  if (override !== '') return path.resolve(REPO_ROOT, override);
  return path.join(REPO_ROOT, 'config', 'repos.txt');
}

/** 镜像根目录：`MIRROR_ROOT` 与 shell 侧同名同义（服务器上那份脚本也读这个变量）。 */
export function mirrorRoot(env: Record<string, string | undefined> = process.env): string {
  const value = (env.MIRROR_ROOT ?? '').trim();
  return value === '' ? DEFAULT_MIRROR_ROOT : value;
}

/**
 * 仓名允许的字符。**这是安全边界，不是风格**：仓名会被拼成
 * `/srv/123pan-mirror/<仓名>.git` 交给 ssh 与 git——`../` 就是一次路径穿越，
 * 空格会把一条命令拆成两条。所以先卡形状，再谈别的。
 */
export const REPO_NAME_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 分支名的形状：git 自己允许的字符很宽，这里只拦最危险的那几个（空格 / `..` / 控制字符）。 */
export const BRANCH_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * 组路径（清单里的 `path=`）的形状：一段或多段，用 `/` 连接，如 `123pan/apisrv`、
 * `cdn-groups/go-protobuf`、`apisrv`（组织根）。
 *
 * 为什么**允许** `/`（而仓名不允许）：这两者进的是完全不同的位置。仓名进服务器路径
 * （`/srv/123pan-mirror/<仓名>.git`），一个 `/` 就是一次路径穿越；组路径只进 URL 的
 * 路径段（`…/<path>.git`），它本来就是多级的。`..` 仍然一律拒绝——URL 里出现 `..`
 * 一样是一次上跳，且它从来不是任何一个真仓的路径。
 */
export const REPO_PATH_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/**
 * 「上游多少天没有新提交才算旧」的默认值。与 `health.ts` 的 `MIRROR_STALE_DAYS` 是同一个数，
 * 但**不是同一个常量**：这一份是**清单语法**的默认（清单里没写这一格时填什么），那一份是
 * **判定逻辑**的默认（调用方没给这张表时按几天判）。两者今天相等是巧合，不是约束——
 * 一个是「文件的缺省」，一个是「函数的缺省」，值的来源不同。
 */
export const DEFAULT_STALE_AFTER_DAYS = 7;

/**
 * 第三格的「永不为旧」写法。
 *
 * 为什么要有这个哨兵，而不是「写一个很大的数」：`123pan-virtuallist-antd` 的 HEAD 停在
 * 2023-06-04（1254 天），任何有限的数**早晚会被跨过**——写 1460 只是把同一句谎话推迟
 * 一年，而下一年的维护者会看到一个「阈值」并以为它是量出来的。`never` 说的是实话：
 * 这个仓的上游已经归档，HEAD 的年龄**不是**关于我们管道的任何事实。
 *
 * 它换掉的是哪一种提醒：**只有「上游不动了」那一条**。同步真的坏掉（fetch 失败、索引
 * 失败、镜像里没有 HEAD）走的是 `ok = false` / `unknown` 两条路，那两条**不读**这一列，
 * 照报（见 `health.ts` 的 `judgeMirror`）。代价写在 `docs/superpowers/plans/
 * 2026-11-08-repo-onboarding.md` 的收尾一节：这两类仓「cron 停了」这种安静坏法也没有
 * 铃铛了。
 */
export const STALE_NEVER = 'never';

/**
 * 清单里的一行：仓名 + 分支 + 它的陈旧阈值 + 行号（报错时点名「第 12 行」比「某个仓」有用）。
 *
 * `staleAfterDays`：`null` = `never`（不因「上游不动了」提醒），数字 = 超过这么多天才提醒。
 * 清单里没写这一格时填 `DEFAULT_STALE_AFTER_DAYS`，于是**读侧永远拿到一个确定的值**，
 * 不必在三个调用点上各自再写一遍「缺省 7」。
 */
export type InventoryLine = {
  id: string;
  branch: string;
  /**
   * **组织相对的克隆路径**（清单第二格 `path=`），与 `real-repos.tsv` 的第二列逐字相同：
   * `123pan/apisrv`、`cdn-groups/go-protobuf`、`apisrv`（组织根）。
   *
   * 为什么它不是「组名」而是「整条路径」：TSV 里给的、API 的 `pathWithNamespace` 给的，
   * 都是**含仓名**的那一整条。把它拆成「组 + 名」只会多一次拼装（也就多一次拼错的机会），
   * 而 `…/<path>.git` 只需要一次字符串连接。所以这一格的最后一段必须等于 `id`（下面有校验）。
   */
  path: string;
  line: number;
  staleAfterDays: number | null;
};

export type Inventory = {
  repos: InventoryLine[];
  /** 非致命的问题（重复的仓名已经按错误处理；这里放「写了默认分支」这类提示）。 */
  notes: string[];
  /** 文件里出现的注释/空行数，只为「这份清单确实被读到了」的可观察性。 */
  skipped: number;
};

/**
 * 第三格之一：`never` 或 1–999999 的整数 → 阈值；其余（含 `0`、`-1`、`7d`）→ `undefined`
 * （调用方负责报错，因为报错要带行号）。
 *
 * `undefined` 与 `null` 是两件事：`null` 是「never」这个**合法答案**，`undefined` 是
 * 「这一格根本不是一个阈值」。混成一个值，`a master 0` 就会变成「永不为旧」。
 */
function parseStaleCell(raw: string): number | null | undefined {
  if (raw.toLowerCase() === STALE_NEVER) return null;
  if (/^[1-9][0-9]{0,5}$/.test(raw)) return Number(raw);
  return undefined;
}

/**
 * 解析清单文本。
 *
 * 返回**整份**而不是「能认出来的那几行」：与 `parseRepos()` 同一条取舍——半份仓库
 * 列表比没有更糟，因为调用方会以为自己读的是全部。一行坏了就整份失败，且报错点名
 * 行号、行内容、以及为什么。
 */
export function parseRepoInventory(text: string): MirrorResult<Inventory> {
  const repos: InventoryLine[] = [];
  const notes: string[] = [];
  const seen = new Map<string, number>();
  let skipped = 0;
  const rows = text.split(/\r?\n/);
  for (let i = 0; i < rows.length; i += 1) {
    const raw = rows[i] ?? '';
    const lineNo = i + 1;
    // `#` 只在行首算注释：仓名里不会有 `#`，而「行尾注释」会让「分支 = master # 主线」
    // 这种写法看起来能用、实际把 `#` 和 `主线` 都塞进分支名。宁可不支持。
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      skipped += 1;
      continue;
    }
    // 制表符或空格分隔；连续空白当一格（有人用多个空格对齐）。
    const cells = trimmed.split(/[\t ]+/);
    const id = cells[0] ?? '';
    const branchCell = cells[1] ?? '';
    if (id === '') {
      return { ok: false, code: 'bad_config', message: `第 ${lineNo} 行没有仓名：「${raw}」` };
    }
    if (!REPO_NAME_SHAPE.test(id)) {
      return {
        ok: false, code: 'bad_config',
        message: `第 ${lineNo} 行的仓名「${id}」形状不合法：只允许 [A-Za-z0-9._-]，且不能以 . 或 - 开头`
          + '（它会被拼成 /srv/123pan-mirror/<仓名>.git）',
      };
    }
    let branch = branchCell;
    if (branch === '') {
      // 只有仓名：当成「明显省略」。给一个提示而不是静默——猜错分支的错法是安静的。
      branch = FALLBACK_BRANCH;
      notes.push(`第 ${lineNo} 行「${id}」没写分支，按 ${FALLBACK_BRANCH} 处理`);
    }
    if (!BRANCH_SHAPE.test(branch) || branch.includes('..')) {
      return {
        ok: false, code: 'bad_config',
        message: `第 ${lineNo} 行的分支「${branch}」形状不合法（不许空格、不许 ..）`,
      };
    }
    // ─── 第三格起：`key=value`（keys: path / stale）───
    //
    // 为什么是 key=value 而不是再加两个位置格：位置格一旦超过两个，「哪一格是 stale、
    // 哪一格是 path」就只能靠数格子，而 `stale_after_days` 是**可选**的——可选的位置格
    // 与「下一个位置格」天生分不开（`a master 365` 到底是 stale 还是 path？）。
    // 带名字的格子没有这个歧义，也允许以后加格而不动前两格。
    //
    // 兼容：第三格如果**光着**写 `never` 或正整数，仍按 `stale_after_days` 读
    // （历史格式）。这个兼容是安全的：没有任何组路径是「全数字」或「never」。
    let path = '';
    let staleAfterDays: number | null = DEFAULT_STALE_AFTER_DAYS;
    let staleSeen = false;
    for (let k = 2; k < cells.length; k += 1) {
      const cell = cells[k] ?? '';
      const eq = cell.indexOf('=');
      if (eq > 0) {
        const key = cell.slice(0, eq).toLowerCase();
        const value = cell.slice(eq + 1);
        if (key === 'path') {
          if (path !== '') {
            return {
              ok: false, code: 'bad_config',
              message: `第 ${lineNo} 行写了两个 path=：（「${trimmed}」）；一个仓只有一条路径`,
            };
          }
          if (value === '') {
            return {
              ok: false, code: 'bad_config',
              message: `第 ${lineNo} 行的 path= 是空的：组织根下的仓写仓名本身（如 path=artifacts）`,
            };
          }
          if (value.includes('..') || !REPO_PATH_SHAPE.test(value)) {
            return {
              ok: false, code: 'bad_config',
              message: `第 ${lineNo} 行的 path「${value}」形状不合法：`
                + '只允许 [A-Za-z0-9._-] 组成的段，用 / 连接，不许 .. 与空段',
            };
          }
          path = value;
        } else if (key === 'stale') {
          if (staleSeen) {
            return {
              ok: false, code: 'bad_config',
              message: `第 ${lineNo} 行写了两个 stale=：（「${trimmed}」）`,
            };
          }
          staleSeen = true;
          const parsedStale = parseStaleCell(value);
          if (parsedStale === undefined) {
            return {
              ok: false, code: 'bad_config',
              message: `第 ${lineNo} 行的 stale「${value}」不合法：`
                + `只接受 1–999999 的整数，或 ${STALE_NEVER}（不因「上游不动了」提醒，`
                + '但同步失败照样报）。写成 0 或 -1 一律拒绝：这两种都不是一个天数。',
            };
          }
          staleAfterDays = parsedStale;
        } else {
          return {
            ok: false, code: 'bad_config',
            message: `第 ${lineNo} 行有认不出的格子「${cell}」：第三格起只认 path= 与 stale=`
              + '（注释只能整行）',
          };
        }
        continue;
      }
      // 光着的一格：只允许出现在第三格，且只能是 stale（历史写法）。
      // 第三格是**位置格**，所以它写坏时的报错必须说 stale 而不是「多了格子」——
      // 否则 `a master 0` 会被读成「第四个格子」，而人会去数格子数。
      if (k === 2) {
        const parsedStale = parseStaleCell(cell);
        if (parsedStale === undefined) {
          return {
            ok: false, code: 'bad_config',
            message: `第 ${lineNo} 行的 stale_after_days「${cell}」不合法：`
              + `只接受 1–999999 的整数，或 ${STALE_NEVER}（不因「上游不动了」提醒，`
              + '但同步失败照样报）。写成 0 或 -1 一律拒绝：这两种都不是一个天数。',
          };
        }
        staleSeen = true;
        staleAfterDays = parsedStale;
        continue;
      }
      return {
        ok: false, code: 'bad_config',
        message: `第 ${lineNo} 行多了 ${cells.length - 3} 格：「${trimmed}」`
          + '（格式是「仓名<空白>分支[<空白>path=<组路径>][<空白>stale=<天数>|never]」，'
          + '注释只能整行）',
      };
    }
    if (path === '') {
      // 旧清单（只有「仓名 分支」）逐行读出来仍然指向历史地址 `123pan/<仓名>`：**不静默**，
      // 留一条提示——本次改格式的全部理由就是「地址不能再靠拼」。
      path = `${DEFAULT_GROUP}/${id}`;
      notes.push(`第 ${lineNo} 行「${id}」没写 path=，按历史默认 ${path} 处理`);
    }
    // 镜像目录名（id）与路径最后一段必须是同一个名字：同步脚本按 id 找目录、按 path 拼
    // 克隆地址，两者不一致时错法是**安静的**——目录里躺着 A 仓的镜像，而每晚去 fetch B。
    const lastSegment = path.slice(path.lastIndexOf('/') + 1);
    if (lastSegment !== id) {
      return {
        ok: false, code: 'bad_config',
        message: `第 ${lineNo} 行 path「${path}」的最后一段「${lastSegment}」不等于仓名「${id}」：`
          + '镜像目录按仓名建，克隆地址按 path 拼，两者必须是同一个仓',
      };
    }
    const firstLine = seen.get(id);
    if (firstLine !== undefined) {
      // 重名不是「后者覆盖前者」：清单里两行同一个仓，说明有人改到一半，而
      // 两处的分支可能不同——按哪一行都会有人觉得自己的改动生效了。
      // （同一个仓名在 codeup 的两个组下各有一份时，只能收一份：另一份属于
      //  `config/repos-excluded.txt`，那里记的是「为什么不要它」。）
      return {
        ok: false, code: 'bad_config',
        message: `仓「${id}」出现了两次（第 ${firstLine} 行与第 ${lineNo} 行）`,
      };
    }
    seen.set(id, lineNo);
    repos.push({ id, branch, path, line: lineNo, staleAfterDays });
  }
  if (repos.length === 0) {
    return { ok: false, code: 'bad_config', message: '清单里一个仓都没有（全空或是全注释）' };
  }
  return { ok: true, data: { repos, notes, skipped } };
}

/** 读清单文件；文件不存在时给一句「该建哪个文件」而不是 ENOENT。 */
export async function readRepoInventory(
  file: string = inventoryPath(),
): Promise<MirrorResult<{ file: string; inventory: Inventory }>> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false, code: 'bad_config',
      message: `读不到仓清单 ${file}（${detail}）：加仓的第一步是编辑这个文件`,
    };
  }
  const parsed = parseRepoInventory(text);
  if (!parsed.ok) return { ...parsed, message: `${file} ${parsed.message}` };
  return { ok: true, data: { file, inventory: parsed.data } };
}

/**
 * 清单 → 设置里那种 `{id, path}` 形状。
 *
 * path 由 `MIRROR_ROOT` 拼出来，而不是清单里再写一列：镜像位置是**部署事实**
 * （服务器上的约定），不是「这个仓的属性」。写两列只会让两个值有机会不一致。
 */
export function inventoryToRepos(
  lines: readonly InventoryLine[],
  root: string = mirrorRoot(),
): RepoRef[] {
  const base = root.replace(/\/+$/, '');
  return lines.map((entry) => ({ id: entry.id, path: `${base}/${entry.id}.git` }));
}

/** `code.mirror.repos` 的规范 JSON：键顺序固定、无空白，便于 diff 与「两边是否相等」的判断。 */
export function reposSettingJson(repos: readonly RepoRef[]): string {
  return JSON.stringify(repos.map((repo) => ({ id: repo.id, path: repo.path })));
}

/**
 * 一个仓的克隆地址：`<CODEUP_ORG>/<path>.git`。
 *
 * **只在这一处拼地址。** `scripts/sync-mirrors.sh`（bash）与 `scripts/onboard-repos.ts`
 * 都调它，而不是各自 `${org}/123pan/${name}.git` 一遍——2026-11-09 那 26 个
 * 「仓不存在」就是同一个拼法在两处各写了一次的直接结果：错的地方一致，所以错得很像真的。
 *
 * `org` 可覆盖（`CODEUP_ORG` 指向自建 codeup / 演练环境时用），但**不含**任何组：组在
 * `path` 里。给它一个以 `/` 结尾的值也不会拼出双斜杠。
 */
export function cloneUrlOf(path: string, org: string = CODEUP_ORG): string {
  return `${org.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}.git`;
}

/** 一个清单行的克隆地址（`path` + 默认 org）。 */
export function cloneUrl(entry: Pick<InventoryLine, 'path'>): string {
  return cloneUrlOf(entry.path);
}

/**
 * 两份仓库列表的差。`current = null` 表示「设置里还没有这一格」。
 *
 * 为什么要 diff 而不只是「写进去就好了」：这一步会改掉读侧**正在用**的配置。
 * 加仓时人想看的只有三件事——多了谁、少了谁、谁的 path 变了（`MIRROR_ROOT` 改过、
 * 或仓名改过）。把这三件事打出来，比一句「已保存」有用得多。
 */
export type ReposDiff = {
  added: string[];
  removed: string[];
  moved: { id: string; from: string; to: string }[];
  /** 顺序变了（读侧不在意顺序，但 diff 里能看出来有人重排过）。 */
  reordered: boolean;
  same: boolean;
};

export function diffRepos(current: readonly RepoRef[] | null, next: readonly RepoRef[]): ReposDiff {
  const before = new Map((current ?? []).map((repo) => [repo.id, repo.path]));
  const after = new Map(next.map((repo) => [repo.id, repo.path]));
  const added = next.filter((repo) => !before.has(repo.id)).map((repo) => repo.id);
  const removed = (current ?? []).filter((repo) => !after.has(repo.id)).map((repo) => repo.id);
  const moved: ReposDiff['moved'] = [];
  for (const repo of next) {
    const was = before.get(repo.id);
    if (was !== undefined && was !== repo.path) moved.push({ id: repo.id, from: was, to: repo.path });
  }
  const beforeOrder = (current ?? []).map((repo) => repo.id).filter((id) => after.has(id));
  const afterOrder = next.map((repo) => repo.id).filter((id) => before.has(id));
  const reordered = beforeOrder.join('\u0000') !== afterOrder.join('\u0000');
  return {
    added, removed, moved, reordered,
    same: added.length === 0 && removed.length === 0 && moved.length === 0 && !reordered,
  };
}

/** 把一份清单变成 shell 可消费的行（`仓名<TAB>分支<TAB>path=…`），测试与文档里的示例用。 */
export function formatInventoryLine(entry: InventoryLine): string {
  // `path=` 永远写出来：它是「这个仓在哪」的唯一记录，省掉它就等于把地址退回给拼装。
  const pathCell = `\tpath=${entry.path}`;
  // 只写**偏离默认**的第三格：一份 30 行的清单里 24 行写着 7 只是噪音，而第三格存在的
  // 理由是「这几个仓要单独定阈值」——不偏离就不该出现。
  const stale = entry.staleAfterDays === DEFAULT_STALE_AFTER_DAYS
    ? ''
    : `\tstale=${entry.staleAfterDays === null ? STALE_NEVER : String(entry.staleAfterDays)}`;
  return `${entry.id}\t${entry.branch}${pathCell}${stale}`;
}

/**
 * 清单里的「仓 → 陈旧阈值」表（`null` = 永不为旧）。
 *
 * 为什么要这一层而不是让调用方各自 `Object.fromEntries(repos.map(...))`：`null = never`
 * 这个约定只有一处写下来的地方最安全——读侧（`checkMirrorFreshness`）与用例都必须
 * 用同一个含义读它，而「有人把 null 写成 0」这种错法在两边都表现为「永远提醒」。
 */
export function staleThresholdsOf(
  lines: readonly InventoryLine[],
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const entry of lines) out[entry.id] = entry.staleAfterDays;
  return out;
}
