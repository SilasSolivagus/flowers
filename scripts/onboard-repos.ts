#!/usr/bin/env tsx
/**
 * 批量接入：**从清单文件**（`config/repos.txt`）把每个仓从「服务器上没有」推到「索引里看得见」，
 * 并把这次测量落成 `repo_coverage` 的一行（迁移 0033）。
 *
 * 这套机器的存在理由是数量：3 个仓靠人记得，139 个仓只能靠流程。所以它有三条硬要求。
 *
 * 1. **仓名一个都不许写死。** 清单是唯一来源（`config/repos.txt`），仓名只在运行时从
 *    文件里读出来。写死意味着「加第 140 个仓要改代码」，而改代码需要一次部署——
 *    那一天起，清单与代码就会开始各自变旧。
 * 2. **一个仓失败不许停住一批。** 139 个仓里注定有几个是空的、几个是 Java 的、
 *    几个镜像拉不下来的。批量脚本的失败语义必须是「记下来、接着跑、最后一起说」，
 *    否则第一个坏仓会把后面 138 个没跑过的好仓一起变成「不知道」。
 * 3. **可续跑。** 这一批跑 40 分钟，中途断一次很正常。已经测过**同一个 HEAD** 且
 *    成功的仓必须跳过（`--force` 才重测）——否则每次重跑都从头开始，而重跑恰恰是
 *    最容易发生的事（失败后、断线后、扩盘后）。
 *
 * ── 为什么走 `ssh <host> git …`，而不是把 git 逻辑写两套
 *
 * 读（HEAD / ls-tree / 索引装配）一律走 `src/core/codemirror/mirror.ts`——那是走查、
 * 评审、夜间索引共用的**同一个**只读层（命令白名单、超时、中文错误、userinfo 抹除
 * 都在那一层）。本脚本自己只做三件 `mirror.ts` **故意**拒绝的事：`clone`、`symbolic-ref`、
 * `du`/`df`（它把写命令挡在进程之前，这是它的价值，不是障碍）。这三件都放在
 * `server()` 里，参数全是本文件造的字面量，没有 shell 拼接。
 *
 * ── 内容地址为什么让这件事「负担得起」（这是整个规模化的前提）
 *
 * `blob_index` 的主键是 **git blob sha**，不是 `(repo, path, commit)`。同一块内容在
 * 40 个提交、2 个仓里只有**一行**、只解析**一次**。于是：
 *
 *     总成本 ≈ Σ(每仓的**唯一**内容) × 解析单价     而不是     Σ(文件数 × 提交数) × 解析单价
 *
 * 123pan 这套仓里「唯一内容」远小于「文件 × 提交」：三个仓 312 行 blob 就覆盖了全部
 * 已索引提交。加到 139 个仓时，重复率只会更高（同一个组件被复制到多个仓、脚手架生成
 * 的模板、锁文件与图标）。所以这里**不许**按仓清 `blob_index`（那是 `--force-reparse`，
 * 一次全量重扫，不是增量），也不许改成按提交存——那会把 139 个仓变成几百万行。
 *
 * ── 磁盘闸
 *
 * 每仓镜像的大小差两个数量级（12 M 的 uni-app vs 2.4 G 的 pc）。139 个仓对着 49 GB
 * 可用空间，这件事必须在 clone **之前**判，而不是等 `ENOSPC`（git 会写一半 pack 后
 * 失败，留下一个半成品 bare 仓——比没建更糟，而且下一次看起来「目录已经在了」）。
 * 判据、水位、首轮「只测量不拦」的取舍都在 `diskGuard()` / `projectDisk()`
 * （`src/core/codemirror/repo-coverage.ts`）里，那两个是纯函数，能被用例钉住。
 *
 * ── 用法
 *
 *   npx tsx scripts/onboard-repos.ts                    # 全清单，断点续跑
 *   npx tsx scripts/onboard-repos.ts --force            # 重测（同 HEAD 也重测）
 *   npx tsx scripts/onboard-repos.ts --limit 10         # 只做前 10 个待做的（分批上线）
 *   npx tsx scripts/onboard-repos.ts --budget-gb 20     # 这一批最多占 20 GB
 *   npx tsx scripts/onboard-repos.ts --json             # 给上层脚本的结果
 *
 * 退出码：0 全部成功（含「已测过、跳过」）；3 至少一个仓失败（结尾点名）；
 *         2 环境/清单/配置读不到（一个仓都还没动）。
 */
import { execFile } from 'node:child_process';
import path from 'node:path';

import { db, pool } from '../src/db/client.js';
import { head, lsTreeEntries, resolveMirrorConfig, type MirrorResult } from '../src/core/codemirror/mirror.js';
import { syncRepoIndex } from '../src/core/codemirror/index-store.js';
import {
  DEFAULT_DISK_FLOOR_GB, coverageCounts, diskGuard, listCoverage, projectDisk, readCoverage,
  recordCoverage, shouldSkip, type CoverageRow,
} from '../src/core/codemirror/repo-coverage.js';
import {
  inventoryPath, inventoryToRepos, mirrorRoot, readRepoInventory, reposSettingJson,
  type InventoryLine,
} from '../src/core/codemirror/repo-inventory.js';

/** 清单里 owner 说的目标仓数：只用于报告里的外推，不参与任何判断。 */
const TARGET_REPOS = 139;

/** clone 的超时：2.4 G 的仓在跨国 HTTPS 上要几分钟，给 30 分钟。`sync-mirrors.sh` 的 fetch 是 300 s。 */
const CLONE_TIMEOUT_MS = 30 * 60 * 1000;

/** 一次 ssh 的小命令（test/du/df/rev-parse）超时。 */
const SHORT_TIMEOUT_MS = 30_000;

type Args = {
  file: string;
  force: boolean;
  limit: number | null;
  budgetGb: number | null;
  floorGb: number;
  noClone: boolean;
  json: boolean;
  targetCount: number;
  /** clone 失败后的重试次数（不含第一次）。见 `cloneWithRetry` 的注释。 */
  retries: number;
};

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    file: inventoryPath(), force: false, limit: null, budgetGb: null,
    floorGb: DEFAULT_DISK_FLOOR_GB, noClone: false, json: false, targetCount: TARGET_REPOS,
    retries: 2,
  };
  const number = (raw: string | undefined): number | null => {
    const value = Number(raw ?? '');
    return Number.isFinite(value) && value >= 0 ? value : null;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? '';
    if (flag === '--file') { args.file = argv[i + 1] ?? args.file; i += 1; }
    else if (flag === '--force') args.force = true;
    else if (flag === '--no-clone') args.noClone = true;
    else if (flag === '--json') args.json = true;
    else if (flag === '--limit') { args.limit = number(argv[i + 1]); i += 1; }
    else if (flag === '--budget-gb') { args.budgetGb = number(argv[i + 1]); i += 1; }
    else if (flag === '--floor-gb') { args.floorGb = number(argv[i + 1]) ?? DEFAULT_DISK_FLOOR_GB; i += 1; }
    else if (flag === '--target-count') { args.targetCount = number(argv[i + 1]) ?? TARGET_REPOS; i += 1; }
    else if (flag === '--retries') { args.retries = number(argv[i + 1]) ?? 2; i += 1; }
    else if (flag === '--help' || flag === '-h') { usage(); process.exit(0); }
  }
  return args;
}

function usage(): void {
  console.log([
    '用法：tsx scripts/onboard-repos.ts [--file <清单>] [--force] [--limit N]',
    '                                   [--budget-gb N] [--floor-gb N] [--no-clone] [--json]',
    '',
    `读 ${inventoryPath()}，对每个仓：确保镜像在服务器上存在 → 读 HEAD → 增量索引`,
    '→ 量覆盖率（files_total / files_indexed / pages / outline_files / imports）→ 写 repo_coverage。',
    '',
    '  --force        同一个 HEAD 也重测（默认跳过，续跑就靠它）',
    '  --limit N      只做前 N 个「待做的」（分批上线；已跳过的不占名额）',
    '  --budget-gb N  这一批最多占用 N GB（默认：按已测样本外推；首轮只测量不拦）',
    `  --floor-gb N   可用空间减掉这批之后必须还剩下的水位（默认 ${DEFAULT_DISK_FLOOR_GB} GB）`,
    '  --no-clone     只做已有的镜像（不动服务器；缺镜像的仓记 ok=false）',
    '  --retries N    clone 失败重试次数（默认 2：codeup 的 DNS/HTTPS 会间歇性失败）',
    '  --json         打一份 JSON 结果（含每仓覆盖率与磁盘外推）',
    '',
    '退出码：0 全部成功（含跳过）/ 3 至少一个仓失败 / 2 环境、清单或配置读不到。',
  ].join('\n'));
}

// ─── 服务器上那三件 mirror.ts 故意不做的事 ──────────────────────────────────

type ServerRun = { code: number; stdout: string; stderr: string };

/**
 * 在镜像宿主机上跑一条命令。
 *
 * 参数是 argv 数组，不是拼出来的字符串：ssh 会把第二个参数起用空格拼成远端命令行，
 * 所以**我们传的每个参数都必须是本文件造的字面量**（路径来自清单 + `MIRROR_ROOT`，
 * 且清单里的仓名已被 `REPO_NAME_SHAPE` 卡过形状）。这与 `mirror.ts` 的 `gitArgv`
 * 是同一条约定——区别只在于这里允许写命令（clone / symbolic-ref）。
 */
function server(host: string, argv: readonly string[], timeoutMs: number = SHORT_TIMEOUT_MS): Promise<ServerRun> {
  return new Promise((resolve) => {
    execFile(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, ...argv],
      { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error === null
          ? 0
          : typeof (error as { code?: unknown }).code === 'number'
            ? Number((error as { code?: number }).code)
            : /timed? ?out|ETIMEDOUT/i.test(String((error as { message?: string }).message ?? '')) ? 124 : 1;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });
}

/** 服务器上的绝对路径：镜像根 + 仓名（仓名形状已校验，不会再带 `/` 或 `..`）。 */
function mirrorPathOf(id: string, root: string): string {
  return path.posix.join(root.replace(/\/+$/, ''), `${id}.git`);
}

/** 服务器上镜像根所在文件系统的可用空间（GB）；读不出时返回 null（调用方按「不知道」处理）。 */
async function freeGbOf(host: string, root: string): Promise<number | null> {
  const run = await server(host, ['df', '-Pk', root]);
  if (run.code !== 0) return null;
  // `df -Pk` 的输出固定是 6 列：Filesystem 1024-blocks Used Available Capacity Mounted
  const line = run.stdout.trim().split('\n').filter((row) => row.trim() !== '')[1];
  const cells = (line ?? '').trim().split(/\s+/);
  const availKb = Number(cells[3] ?? '');
  if (!Number.isFinite(availKb)) return null;
  return availKb / 1024 / 1024;
}

/** 一个镜像在磁盘上占多少（GB）。`du -sk` 是**块**占用，比文件的逻辑大小更接近「还剩多少空间」。 */
async function mirrorSizeGb(host: string, dir: string): Promise<number | null> {
  const run = await server(host, ['du', '-sk', dir]);
  if (run.code !== 0) return null;
  const kb = Number((run.stdout.trim().split(/\s+/)[0] ?? ''));
  return Number.isFinite(kb) ? kb / 1024 / 1024 : null;
}

function shortErr(run: ServerRun): string {
  const text = (run.stderr.trim() || run.stdout.trim()).split('\n').filter((l) => l.trim() !== '').slice(-2).join(' ');
  return text === '' ? `退出码 ${String(run.code)}` : text;
}

// ─── 报告用的形状 ────────────────────────────────────────────────────────────

type RepoOutcome = {
  repo: string;
  branch: string;
  /** 这一轮做了什么：`skipped`（同 HEAD 续跑）/ `deferred`（超出 --limit）/ 测量 / 失败。 */
  action: 'skipped' | 'deferred' | 'cloned+measured' | 'measured' | 'failed';
  headSha: string | null;
  headDate: string | null;
  filesTotal: number | null;
  filesIndexed: number | null;
  /** 因为生成代码被跳过的文件数（`Code generated … DO NOT EDIT.`）。 */
  filesSkippedGenerated: number | null;
  pages: number | null;
  outlineFiles: number | null;
  imports: number | null;
  mirrorGb: number | null;
  error: string | null;
};

function oneLine(row: RepoOutcome): string {
  const size = row.mirrorGb === null ? '?' : `${row.mirrorGb.toFixed(2)}G`;
  if (row.action === 'failed') {
    return `${row.repo.padEnd(26)} 失败  ${size.padStart(7)}  ${row.error ?? ''}`;
  }
  if (row.action === 'deferred') {
    // 没读 HEAD、也没测：这一行不该显示 0/0，否则看起来像「索引看不见这个仓」。
    return `${row.repo.padEnd(26)} 限流  ${size.padStart(7)}  ${row.error ?? ''}`;
  }
  const sha = (row.headSha ?? '').slice(0, 8).padEnd(8);
  const files = `${String(row.filesIndexed ?? 0)}/${String(row.filesTotal ?? 0)}`.padStart(9);
  // `跳过生成` 只在非零时出现：一列恒为 0 的数是噪音，而 Go 仓里它常常是几百。
  const generated = (row.filesSkippedGenerated ?? 0) > 0
    ? ` 跳过生成 ${String(row.filesSkippedGenerated).padStart(4)}`
    : '';
  return `${row.repo.padEnd(26)} ${sha} ${row.action === 'skipped' ? '跳过' : '测量'} `
    + `${files}${generated} 页面 ${String(row.pages ?? 0).padStart(3)} `
    + `轮廓 ${String(row.outlineFiles ?? 0).padStart(3)} `
    + `import ${String(row.imports ?? 0).padStart(4)} ${size.padStart(7)}`;
}

// ─── 一个仓的完整流程 ────────────────────────────────────────────────────────

type Ctx = {
  host: string;
  root: string;
  args: Args;
  /** 本轮测到的镜像大小（GB）：先建先测，后面的仓用中位数外推磁盘闸。 */
  sizes: number[];
  /** 本轮是否已经用「没有样本」的方式告警过（只告警一次）。 */
  warnedNoSample: boolean;
};

/**
 * clone 一次，失败按次数重试。
 *
 * 为什么需要：`codeup.aliyun.com` 从这台机器上**间歇性**失败——同一分钟内
 * `git ls-remote` 成功、`curl` 拿到 000、`getent hosts` 解析不出来（0031 记的就是这一类）。
 * 139 个仓每个都要 clone 一次，只要单次成功率不是 100%，批量就一定会撞上几次；
 * 不重试的话，一次 15 秒的连接失败会让一个本来完全正常的仓被记成「接入失败」，
 * 而人要重新跑一整批才知道它其实没问题。
 *
 * 退避是线性的（`attempt × 5 s`）：这类失败是几秒级的瞬时抖动，指数退避在这里
 * 只是把人挡在键盘外面。
 */
async function cloneWithRetry(
  host: string,
  argv: readonly string[],
  attempts: number,
): Promise<{ run: ServerRun; tries: number }> {
  let run = await server(host, argv, CLONE_TIMEOUT_MS);
  let tries = 1;
  while (run.code !== 0 && tries < attempts) {
    const waitMs = tries * 5000;
    console.log(`  clone 第 ${tries} 次失败（${shortErr(run)}），${String(waitMs / 1000)} 秒后重试…`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    run = await server(host, argv, CLONE_TIMEOUT_MS);
    tries += 1;
  }
  return { run, tries };
}

async function ensureMirror(ctx: Ctx, entry: InventoryLine): Promise<{ ok: true; cloned: boolean; gb: number | null } | { ok: false; error: string }> {
  const dir = mirrorPathOf(entry.id, ctx.root);
  const exists = await server(ctx.host, ['test', '-d', dir]);
  if (exists.code === 0) return { ok: true, cloned: false, gb: await mirrorSizeGb(ctx.host, dir) };

  if (ctx.args.noClone) {
    return { ok: false, error: `镜像不存在（${dir}），且本轮给了 --no-clone` };
  }

  // 磁盘闸：在 clone **之前**判，判据见 `diskGuard()`。首轮没有样本时只告警不拦。
  const freeGb = await freeGbOf(ctx.host, ctx.root);
  if (freeGb === null) {
    return { ok: false, error: `读不到 ${ctx.root} 的可用空间（df 失败），不敢 clone` };
  }
  let needGb: number;
  if (ctx.args.budgetGb !== null) {
    needGb = ctx.args.budgetGb;
  } else if (ctx.sizes.length === 0) {
    needGb = 0;
    if (!ctx.warnedNoSample) {
      ctx.warnedNoSample = true;
      console.error(`提示：本轮还没有实测的镜像大小，磁盘闸只测量不拦（可用 ${freeGb.toFixed(1)} GB；`
        + '要拦就显式给 --budget-gb）');
    }
  } else {
    needGb = projectDisk(ctx.sizes, 1).medianGb;
  }
  const decision = diskGuard({ freeGb, needGb, floorGb: ctx.args.floorGb });
  console.log(`  磁盘 ${decision.message}`);
  if (!decision.ok) return { ok: false, error: decision.message };

  // 先 clone 到临时目录，成功后才 mv 到位：半成品 bare 仓（git 在写 pack 时被打断）
  // 看起来「目录已经在了」，下一轮就会被当成「镜像存在」——那是最难查的一类假成功。
  const tmp = `${dir}.tmp-onboard`;
  const url = `https://codeup.aliyun.com/60f9058e68e2993a8e6d0750/123pan/${entry.id}.git`;
  console.log(`  clone ${entry.id}（${url} → ${dir}）…`);
  const cloned = await cloneWithRetry(ctx.host, ['git', 'clone', '--mirror', '--quiet', url, tmp], ctx.args.retries + 1);
  if (cloned.run.code !== 0) {
    await server(ctx.host, ['rm', '-rf', tmp]);
    return { ok: false, error: `clone 失败（试了 ${cloned.tries} 次）：${shortErr(cloned.run)}` };
  }
  // 分支：`head()` 读的是 HEAD，而 `clone --mirror` 的 HEAD 跟着远端的默认分支走。
  // 清单里写的分支才是我们要的那一条（错法的代价见 `repo-inventory.ts` 文件头）。
  const branchCheck = await server(ctx.host, ['git', `--git-dir=${tmp}`, 'rev-parse', '--verify', `refs/heads/${entry.branch}`]);
  if (branchCheck.code !== 0) {
    await server(ctx.host, ['rm', '-rf', tmp]);
    return { ok: false, error: `镜像里没有分支 ${entry.branch}（清单第 ${entry.line} 行写的是它）` };
  }
  const setHead = await server(ctx.host, ['git', `--git-dir=${tmp}`, 'symbolic-ref', 'HEAD', `refs/heads/${entry.branch}`]);
  if (setHead.code !== 0) {
    await server(ctx.host, ['rm', '-rf', tmp]);
    return { ok: false, error: `把 HEAD 指向 ${entry.branch} 失败：${shortErr(setHead)}` };
  }
  // `clone --mirror` 会写一条 `[remote "origin"]`，而镜像的既有约定是**不许有 remote**
  // （`sync-mirrors.sh` 收尾那段检查 `grep '^\[remote' config`，有就 rc=3；它自己
  // fetch 用的是显式 URL，不靠 remote）。第一次跑批量接入时正是这里漏了：两个新仓的
  // `remotes=1` 让整轮同步以 rc=3 收尾——真仓明明都好好的。
  // 顺带的好处：`.git/config` 里没有远端 URL，就不可能有 userinfo 留在里面
  // （凭据在 `/root/.git-credentials`，镜像本身 444 交给别人读也安全）。
  const dropRemote = await server(ctx.host, ['git', `--git-dir=${tmp}`, 'remote', 'remove', 'origin']);
  if (dropRemote.code !== 0) {
    await server(ctx.host, ['rm', '-rf', tmp]);
    return { ok: false, error: `删掉 clone 留下的 remote origin 失败：${shortErr(dropRemote)}` };
  }
  const moved = await server(ctx.host, ['mv', tmp, dir]);
  if (moved.code !== 0) {
    await server(ctx.host, ['rm', '-rf', tmp]);
    return { ok: false, error: `把临时镜像移到 ${dir} 失败：${shortErr(moved)}` };
  }

  // 与 `sync-mirrors.sh` 同一条收尾：只读权限（目录 555 / 文件 444，owner root）。
  // root 自己下一次 fetch 不受影响（CAP_DAC_OVERRIDE），非 root 谁都改不动。
  await server(ctx.host, ['chown', '-R', 'root:root', dir]);
  await server(ctx.host, ['find', dir, '-type', 'd', '-exec', 'chmod', '555', '{}', '+']);
  await server(ctx.host, ['find', dir, '-type', 'f', '-exec', 'chmod', '444', '{}', '+']);

  return { ok: true, cloned: true, gb: await mirrorSizeGb(ctx.host, dir) };
}

/** 索引一个仓并量覆盖率。失败一律是 `{ ok: false, error }`，不抛。 */
async function measureOne(
  entry: InventoryLine,
  sha: string,
): Promise<{
  ok: true;
  counts: Pick<CoverageRow, 'filesTotal' | 'filesIndexed' | 'filesSkippedGenerated'
    | 'pages' | 'outlineFiles' | 'imports'>;
} | { ok: false; error: string }> {
  const synced = await syncRepoIndex(db, entry.id, sha);
  if (!synced.ok) return { ok: false, error: `索引失败：${synced.message}` };
  // `files_total` 来自 `ls-tree`，与索引不是同一趟 I/O：索引只回答「我记得什么」，
  // 树回答「实际有多少」——两者的差就是这张表的全部意义，所以必须真去列一次。
  const tree = await lsTreeEntries(entry.id, { ref: sha });
  if (!tree.ok) return { ok: false, error: `列树失败：${tree.message}` };
  return { ok: true, counts: coverageCounts(synced.data.index, tree.data.length) };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  const loaded = await readRepoInventory(args.file);
  if (!loaded.ok) {
    console.error(loaded.message);
    return 2;
  }
  const { inventory } = loaded.data;
  for (const note of inventory.notes) console.error(`提示：${note}`);

  // 仓列表来自**清单**，不是设置。做法是把它注入成 `resolveMirrorConfig()` 的第一优先级
  // 来源（env 覆盖），而不是在这里再写一套解析：`transport` / `sshHost` 仍然从设置读，
  // 只有 `repos` 被清单盖住。好处是后面的 `head()` / `lsTreeEntries()` / 索引装配全都
  // 自动认得这些新仓——**包括设置里还没播种的那些**（`repos-apply.ts` 可以晚一步跑）。
  const refs = inventoryToRepos(inventory.repos);
  process.env.FLOWERS_MIRROR_REPOS = reposSettingJson(refs);

  const config = await resolveMirrorConfig();
  if (!config.ok) {
    console.error(`读不到镜像配置：${config.message}`);
    return 2;
  }
  if (config.data.transport !== 'ssh') {
    // 本地传输意味着镜像就在这台机器上；但清单里的 path 是服务器约定，两者不一致时
    // 后面每一步都会以「目录不存在」的形式失败——先在这里说清楚。
    console.error(`镜像传输是 ${config.data.transport}，而清单的 path 是服务器约定（${mirrorRoot()}）：`
      + '批量接入只支持 ssh（settings.code.mirror.transport = ssh）');
    return 2;
  }
  const host = config.data.sshHost;
  const root = mirrorRoot();

  const ctx: Ctx = { host, root, args, sizes: [], warnedNoSample: false };

  console.log(`清单      ${loaded.data.file}（${inventory.repos.length} 个仓）`);
  console.log(`镜像宿主机 ${host}:${root}`);

  const freeAtStart = await freeGbOf(host, root);
  if (freeAtStart === null) {
    console.error(`读不到 ${host}:${root} 的可用空间（df 失败）：磁盘闸失效，先确认 ssh 与路径`);
    return 2;
  }
  console.log(`可用空间  ${freeAtStart.toFixed(1)} GB（水位 ${args.floorGb} GB）`);

  const outcomes: RepoOutcome[] = [];
  const failures: { repo: string; reason: string }[] = [];
  let measured = 0;
  let skipped = 0;
  /** 真的去测了的仓数（成功 + 失败）。`--limit` 数的是它，不是「循环到第几个」
      ——续跑跳过的仓不该占名额，否则「--limit 10」在断点续跑时会一个都不做。 */
  let attempted = 0;
  let deferred = 0;
  const budgetLeft = args.limit;

  for (const entry of inventory.repos) {
    const base: RepoOutcome = {
      repo: entry.id, branch: entry.branch, action: 'failed', headSha: null, headDate: null,
      filesTotal: null, filesIndexed: null, filesSkippedGenerated: null,
      pages: null, outlineFiles: null, imports: null,
      mirrorGb: null, error: null,
    };

    // 一个仓的**任何**异常都不许逸出：批量脚本的价值在于「其余 138 个照跑」。
    // 所以这里 catch 的是异常，而 mirror.ts / syncRepoIndex 的失败是以返回值形式来的
    // （两套都要接住，否则一个 `throw` 就把整批停了）。
    try {
      const existing = await readCoverage(db, entry.id);

      // 续跑判据需要 HEAD，而 HEAD 需要镜像；所以顺序是「先保镜像 → 读 HEAD → 再判跳过」。
      const mirror = await ensureMirror(ctx, entry);
      if (!mirror.ok) {
        base.error = mirror.error;
        failures.push({ repo: entry.id, reason: mirror.error });
        outcomes.push(base);
        await recordCoverage(db, {
          repo: entry.id, headSha: null, headDate: null, filesTotal: 0, filesIndexed: 0,
          filesSkippedGenerated: 0, pages: 0, outlineFiles: 0, imports: 0, ok: false, error: mirror.error,
        });
        console.error(`[${entry.id}] 失败：${mirror.error}`);
        continue;
      }
      base.mirrorGb = mirror.gb;
      if (mirror.gb !== null) ctx.sizes.push(mirror.gb);

      // 预算：只数「真的去测了的」仓（续跑跳过的不占名额），失败也算跑过。
      if (budgetLeft !== null && attempted >= budgetLeft) {
        base.action = 'deferred';
        base.error = `超出 --limit ${String(budgetLeft)}，本轮没做（下一轮接着做，续跑不重来）`;
        deferred += 1;
        outcomes.push(base);
        continue;
      }

      const headRes: MirrorResult<{ sha: string; date: string; subject: string } | null> = await head(entry.id);
      if (!headRes.ok) {
        base.error = headRes.message;
        failures.push({ repo: entry.id, reason: headRes.message });
        outcomes.push(base);
        await recordCoverage(db, {
          repo: entry.id, headSha: null, headDate: null, filesTotal: 0, filesIndexed: 0,
          filesSkippedGenerated: 0, pages: 0, outlineFiles: 0, imports: 0, ok: false, error: headRes.message,
        });
        console.error(`[${entry.id}] 失败：${headRes.message}`);
        continue;
      }
      if (headRes.data === null) {
        base.error = '镜像里没有任何提交';
        failures.push({ repo: entry.id, reason: '镜像里没有任何提交' });
        outcomes.push(base);
        await recordCoverage(db, {
          repo: entry.id, headSha: null, headDate: null, filesTotal: 0, filesIndexed: 0,
          filesSkippedGenerated: 0, pages: 0, outlineFiles: 0, imports: 0, ok: false, error: '镜像里没有任何提交',
        });
        console.error(`[${entry.id}] 失败：镜像里没有任何提交`);
        continue;
      }
      base.headSha = headRes.data.sha;
      base.headDate = headRes.data.date;

      if (!args.force && shouldSkip(existing, headRes.data.sha)) {
        // 跳过也是结果：把上一轮的覆盖率原样带进汇总，报告里 5 行仍然是 5 行。
        skipped += 1;
        outcomes.push({
          ...base,
          action: 'skipped',
          filesTotal: existing?.filesTotal ?? null,
          filesIndexed: existing?.filesIndexed ?? null,
          filesSkippedGenerated: existing?.filesSkippedGenerated ?? null,
          pages: existing?.pages ?? null,
          outlineFiles: existing?.outlineFiles ?? null,
          imports: existing?.imports ?? null,
        });
        console.log(`[${entry.id}] 跳过（同一个 HEAD ${headRes.data.sha.slice(0, 8)} 已测过）`);
        continue;
      }

      attempted += 1;
      const result = await measureOne(entry, headRes.data.sha);
      if (!result.ok) {
        base.error = result.error;
        failures.push({ repo: entry.id, reason: result.error });
        outcomes.push(base);
        await recordCoverage(db, {
          repo: entry.id, headSha: headRes.data.sha, headDate: headRes.data.date,
          filesTotal: 0, filesIndexed: 0, filesSkippedGenerated: 0, pages: 0, outlineFiles: 0, imports: 0,
          ok: false, error: result.error,
        });
        console.error(`[${entry.id}] 失败：${result.error}`);
        continue;
      }

      const row: CoverageRow = {
        repo: entry.id, headSha: headRes.data.sha, headDate: headRes.data.date,
        ...result.counts, ok: true, error: null,
      };
      await recordCoverage(db, row);
      measured += 1;
      outcomes.push({
        ...base, action: mirror.cloned ? 'cloned+measured' : 'measured',
        filesTotal: row.filesTotal, filesIndexed: row.filesIndexed,
        filesSkippedGenerated: row.filesSkippedGenerated, pages: row.pages,
        outlineFiles: row.outlineFiles, imports: row.imports,
      });
      console.log(`[${entry.id}] ${row.filesIndexed}/${row.filesTotal} 文件`
        + `（跳过生成 ${row.filesSkippedGenerated}）、页面 ${row.pages}、`
        + `轮廓 ${row.outlineFiles}、import ${row.imports}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      base.error = `未预期的异常：${detail}`;
      failures.push({ repo: entry.id, reason: base.error });
      outcomes.push(base);
      console.error(`[${entry.id}] 未预期的异常：${detail}`);
    }
  }

  // ─── 收尾：表、总盘、外推 ────────────────────────────────────────────────
  const sizes = ctx.sizes;
  const totalGb = sizes.reduce((sum, value) => sum + value, 0);
  const projection = projectDisk(sizes, args.targetCount);
  const freeAtEnd = await freeGbOf(host, root);
  const byRepo = new Map(outcomes.map((row) => [row.repo, row]));

  if (!args.json) {
    console.log('');
    console.log('仓                             HEAD     状态    索引/树   页面 轮廓 import  磁盘');
    for (const entry of inventory.repos) {
      const row = byRepo.get(entry.id);
      if (row !== undefined) console.log(oneLine(row));
    }
    console.log('');
    console.log(`本轮      测量 ${measured} 个、跳过（同 HEAD）${skipped} 个、`
      + `限流 ${deferred} 个、失败 ${failures.length} 个`);
    console.log(`镜像占用  本清单 ${sizes.length} 个仓合计 ${totalGb.toFixed(2)} GB`
      + `（最大 ${(sizes.length === 0 ? 0 : Math.max(...sizes)).toFixed(2)} GB、`
      + `最小 ${(sizes.length === 0 ? 0 : Math.min(...sizes)).toFixed(2)} GB）`);
    if (freeAtEnd !== null) console.log(`可用空间  ${freeAtEnd.toFixed(1)} GB（本轮开始时 ${freeAtStart.toFixed(1)} GB）`);
    console.log(`外推      ${args.targetCount} 个仓：中位数 ${projection.medianGb.toFixed(2)} GB × ${args.targetCount} `
      + `= ${projection.projectedGb.toFixed(1)} GB（区间 ${projection.lowGb.toFixed(1)}–${projection.highGb.toFixed(1)} GB，`
      + `样本 ${sizes.length} 个）`);
  }

  if (args.json) {
    console.log(JSON.stringify({
      inventory: loaded.data.file,
      host,
      root,
      measured,
      skipped,
      deferred,
      freeGb: { start: freeAtStart, end: freeAtEnd },
      totals: { repos: sizes.length, mirrorGb: Number(totalGb.toFixed(3)), maxGb: sizes.length === 0 ? 0 : Math.max(...sizes), minGb: sizes.length === 0 ? 0 : Math.min(...sizes) },
      projection: { ...projection, targetCount: args.targetCount },
      outcomes,
      failures,
    }, null, 2));
  } else if (failures.length > 0) {
    // 失败清单必须点名：一句「有仓失败」在 139 个仓的批量里等于没有信息。
    console.log('');
    console.log(`失败 ${failures.length} 个：`);
    for (const item of failures) console.log(`  ${item.repo}: ${item.reason}`);
  }

  // 顺带看一眼库里有没有别的仓的旧行（清单删掉的仓，历史仍在表里）：读侧按**清单**遍历，
  // 所以这不影响任何判断，但报告里提一句能省掉下一次「表里怎么多了个仓」的困惑。
  if (!args.json) {
    const rows = await listCoverage(db);
    const known = new Set(inventory.repos.map((entry) => entry.id));
    const orphans = rows.filter((row) => !known.has(row.repo)).map((row) => row.repo);
    if (orphans.length > 0) console.log(`表里另有 ${orphans.length} 个不在清单里的仓（历史行，不影响读侧）：${orphans.join('、')}`);
  }

  return failures.length === 0 ? 0 : 3;
}

try {
  process.exitCode = await main();
} finally {
  await pool.end();
}
