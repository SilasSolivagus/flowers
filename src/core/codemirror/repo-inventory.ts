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
 */

/** 服务器上 bare 镜像的根目录。与 `scripts/sync-mirrors.sh` 的 `MIRROR_ROOT` 同一个默认值。 */
export const DEFAULT_MIRROR_ROOT = '/srv/123pan-mirror';

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

/** 清单里的一行：仓名 + 分支 + 它在文件里的行号（报错时点名「第 12 行」比「某个仓」有用）。 */
export type InventoryLine = { id: string; branch: string; line: number };

export type Inventory = {
  repos: InventoryLine[];
  /** 非致命的问题（重复的仓名已经按错误处理；这里放「写了默认分支」这类提示）。 */
  notes: string[];
  /** 文件里出现的注释/空行数，只为「这份清单确实被读到了」的可观察性。 */
  skipped: number;
};

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
    if (cells.length > 2) {
      return {
        ok: false, code: 'bad_config',
        message: `第 ${lineNo} 行多了 ${cells.length - 2} 格：「${trimmed}」`
          + '（格式是「仓名<空白>分支」，注释只能整行）',
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
    const firstLine = seen.get(id);
    if (firstLine !== undefined) {
      // 重名不是「后者覆盖前者」：清单里两行同一个仓，说明有人改到一半，而
      // 两处的分支可能不同——按哪一行都会有人觉得自己的改动生效了。
      return {
        ok: false, code: 'bad_config',
        message: `仓「${id}」出现了两次（第 ${firstLine} 行与第 ${lineNo} 行）`,
      };
    }
    seen.set(id, lineNo);
    repos.push({ id, branch, line: lineNo });
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

/** 把一份清单变成 shell 可消费的行（`仓名<TAB>分支`），只为测试与文档里的示例。 */
export function formatInventoryLine(entry: InventoryLine): string {
  return `${entry.id}\t${entry.branch}`;
}
