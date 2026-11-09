#!/usr/bin/env tsx
/**
 * 把 `config/repos.txt` **播种**成 `app_settings.code.mirror.repos`——清单与设置之间唯一的那条路。
 *
 * ── 为什么需要这个脚本（而不是「让 TS 直接读文件」）
 *
 * 读侧（走查 / 评审 / 材料 / MCP / 夜间索引）都通过 `resolveMirrorConfig()` 读**设置**。
 * 改成读文件会踩三件事：测试进程与 MCP 进程的 cwd 不是仓库根；服务器那次同步根本不
 * 经过 node；而「现在这批仓是哪几个」是一个**部署状态**，不该要求读侧能碰文件系统。
 *
 * 所以：文件是录入界面，设置是读侧。中间**只允许**这一个脚本，且它写之前先过
 * `parseRepos()`（`mirror.ts` 的同一个解析器）——「写进去的东西读不回来」在构造上
 * 不可能发生。仓库里没有第二条 `insert into app_settings ... code.mirror.repos`。
 *
 * ── 为什么先打印 diff 再写
 *
 * 这一步改的是**正在被用的**配置。加仓时人想知道的只有三件事：多了谁、少了谁、
 * 谁的 path 变了（`MIRROR_ROOT` 挪过、仓名改过）。`--dry-run` 让这三件事能在写之前
 * 看一眼；写完之后再打一次同样的 diff，并附上新值（出问题时能直接贴进复盘）。
 *
 * ── 用法
 *
 *   npx tsx scripts/repos-apply.ts --dry-run     # 只看 diff，不写
 *   npx tsx scripts/repos-apply.ts               # 写进设置
 *   npx tsx scripts/repos-apply.ts --json        # 给脚本用的结果
 *
 * 退出码：0 成功（含「已经一致」）；2 清单读不到 / 不合法 / 现状读不回来；1 写库失败。
 */
import { db, pool } from '../src/db/client.js';
import { MIRROR_REPOS_KEY, parseRepos, resolveMirrorConfig, type RepoRef } from '../src/core/codemirror/mirror.js';
import {
  diffRepos, inventoryPath, inventoryToRepos, mirrorRoots, readRepoInventory, reposSettingJson,
} from '../src/core/codemirror/repo-inventory.js';
import { readSetting, writeSetting } from '../src/core/uemaster/settings.js';

type Args = { dryRun: boolean; json: boolean; file: string };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { dryRun: false, json: false, file: inventoryPath() };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? '';
    if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--json') args.json = true;
    else if (flag === '--file') {
      args.file = argv[i + 1] ?? '';
      i += 1;
    } else if (flag === '--help' || flag === '-h') {
      console.log([
        '用法：tsx scripts/repos-apply.ts [--dry-run] [--json] [--file <清单路径>]',
        '',
        `读 ${inventoryPath()}（一行「仓名<TAB>分支<TAB>source=<来源><TAB>path=<组路径>」），`,
        `把仓名播种成 ${MIRROR_REPOS_KEY} 的 [{"id","path"}]`,
        '（path = 该来源的根目录/<仓名>.git；根由 MIRROR_ROOT / MIRROR_ROOT_GITLAB 决定）。',
        '--dry-run 只打印 diff，不写库。',
        '退出码：0 成功 / 2 清单或现状不合法 / 1 写库失败。',
      ].join('\n'));
      process.exit(0);
    }
  }
  return args;
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

  // 两个根：来源是**仓的属性**（清单里的 `source=`），根是**部署事实**（环境变量或默认
  // 的本机目录）。这一行把两者合起来，之后的路径就是 217 条绝对路径——但它们是**算出来**的，
  // 换机只要改环境变量，不用手改 217 行。
  const roots = mirrorRoots();
  const next = inventoryToRepos(inventory.repos, roots);

  // 先自检：这份东西写进去之后，`resolveMirrorConfig()` 必须能原样读回来。
  // 这是「一个来源」的守卫——清单多一列、path 写成相对路径，都会在这里当场失败，
  // 而不是等夜里索引的时候以「读不到镜像配置」的形式暴露。
  const selfCheck = parseRepos(reposSettingJson(next), 'settings');
  if (!selfCheck.ok) {
    console.error(`清单转成设置后不合法：${selfCheck.message}`);
    return 2;
  }

  // 现状：读原值再走同一个解析器。读失败（库连不上）是**失败**，不是「没配」——
  // 把「读不到」当成「没有」会让人以为这次是第一次播种，于是删掉一份还能用的配置。
  let currentJson: string | null;
  try {
    currentJson = (await readSetting(db, MIRROR_REPOS_KEY))?.trim() ?? '';
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`读不到设置「${MIRROR_REPOS_KEY}」：${detail}`);
    return 2;
  }
  let current: RepoRef[] = [];
  if (currentJson !== '') {
    const parsed = parseRepos(currentJson, 'settings');
    if (!parsed.ok) {
      // 现状已经坏了：仍然照清单写（这正是这个脚本该干的活），但要说清「我是覆盖一份坏的」。
      console.error(`现有设置读不回来（${parsed.message}）——本轮按清单整份覆盖`);
    } else {
      current = parsed.data;
    }
  }

  const diff = diffRepos(currentJson === '' ? null : current, next);
  const summary = {
    file: loaded.data.file,
    inventoryCount: inventory.repos.length,
    settingCount: next.length,
    wrote: false,
    diff,
  };

  if (args.json) {
    if (!args.dryRun && !diff.same) {
      try {
        await writeSetting(db, MIRROR_REPOS_KEY, reposSettingJson(next));
        summary.wrote = true;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.log(JSON.stringify({ ...summary, error: detail }, null, 2));
        console.error(`写设置失败：${detail}`);
        return 1;
      }
    }
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  }

  console.log(`清单      ${loaded.data.file}（${inventory.repos.length} 个仓，跳过 ${inventory.skipped} 行注释/空行）`);
  // 两个根各报一次：一份清单现在跨两台主机，只打「第一个仓的前缀」会让人以为
  // 另一种来源也落在同一个根下（那正是换机时最容易看漏的一句）。
  console.log(`去向      app_settings.${MIRROR_REPOS_KEY}`);
  console.log(`  根      codeup=${roots.codeup}`);
  console.log(`  根      gitlab=${roots.gitlab}`);
  if (currentJson === '') console.log('现状      设置里还没有这一格（第一次播种）');
  else console.log(`现状      设置里 ${current.length} 个仓`);

  if (diff.same) {
    console.log('diff      没有变化（清单与设置一致）');
  } else {
    if (diff.added.length > 0) console.log(`diff      + ${diff.added.join('、')}`);
    if (diff.removed.length > 0) console.log(`diff      - ${diff.removed.join('、')}`);
    for (const move of diff.moved) console.log(`diff      ~ ${move.id}: ${move.from} → ${move.to}`);
    if (diff.reordered) console.log('diff      ↕ 顺序变了（读侧不在意顺序，但这里看得见有人重排过）');
  }

  if (args.dryRun) {
    console.log('结果      仅预览（--dry-run），没有写库');
    return 0;
  }
  if (diff.same) {
    console.log('结果      一致，未改动');
    return 0;
  }

  try {
    await writeSetting(db, MIRROR_REPOS_KEY, reposSettingJson(next));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`写设置失败：${detail}`);
    return 1;
  }
  console.log(`结果      已写入 ${next.length} 个仓`);

  // 写完之后再用**读侧**的入口读一遍：这是「一个来源」的最后一道验证。
  // env 覆盖优先于设置，所以有人在环境里钉了 `FLOWERS_MIRROR_REPOS` 时，
  // 读侧看到的**不是**这一份——那是最典型的「两边不一致」，必须说出来。
  const resolved = await resolveMirrorConfig();
  if (!resolved.ok) {
    console.error(`写完了但读侧仍读不到配置：${resolved.message}`);
    return 1;
  }
  const seen = resolved.data.repos.map((repo) => repo.id);
  const expected = next.map((repo) => repo.id);
  if (seen.join('\u0000') !== expected.join('\u0000')) {
    console.error(`读侧看到的不是刚写的这份：${seen.join('、')}`
      + '（环境变量 FLOWERS_MIRROR_REPOS 优先于设置——删掉它，或改用 --file 对准同一份清单）');
    return 1;
  }
  console.log(`校验      读侧 resolveMirrorConfig() 读回 ${seen.length} 个仓，与清单一致`);
  return 0;
}

try {
  process.exitCode = await main();
} finally {
  await pool.end();
}
