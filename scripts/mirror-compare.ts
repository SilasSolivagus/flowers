#!/usr/bin/env tsx
/**
 * 镜像「换传输」的等价性证据：同一个仓，两种读法（ssh 服务器 / 本地盘）装配出的索引
 * 必须**逐字节相同**。
 *
 * ── 为什么需要这个脚本（而不是「跑一下看看有没有报错」）
 *
 * 2026-11-09 把 `code.mirror.transport` 从 `ssh` 换成 `local`：镜像从
 * `dogyun:/srv/123pan-mirror` 搬到 `~/code-mirrors`。`mirror.ts` 里两种传输唯一的差别
 * 是 argv 前面有没有 `ssh <host>`（见 `gitArgv()`），所以「能跑」几乎必然为真——
 * 而真正要回答的问题是**读到的是不是同一棵树**：
 *
 *   - `head()` 的 sha 与提交日期（材料上「代码快照」那一句的依据）；
 *   - `repoIndex()` 的文件数 / 页面数 / 轮廓条数（材料里「现有页面有什么」的依据）；
 *   - 装配出来的整份索引的字节与 sha256（不是计数相等，是**内容**相等）。
 *
 * 计数相等而内容不等是可能的（同名文件、同一页、不同内容），所以最后一条必须是
 * 字节级。这也是为什么这个脚本不打印「OK」——它打印 sha256，让两列自己说话。
 *
 * ── 怎么用（两段式，因为同一进程里只能有一份配置）
 *
 * `resolveMirrorConfig()` 是 env → 设置 → 默认，一次只解析一份；而对比要两份配置同时
 * 存在。所以分两个进程，各写一份 JSON，再在第三个进程里对：
 *
 *   # 旧：服务器（在改设置之前跑，repos 用旧设置里那份 /srv/... 的 JSON）
 *   FLOWERS_MIRROR_TRANSPORT=ssh FLOWERS_MIRROR_REPOS="$(cat old.json)" \
 *     npx tsx scripts/mirror-compare.ts capture --repos apisrv,123pan-uni-app -o a.json
 *   # 新：本地
 *   npx tsx scripts/mirror-compare.ts capture --repos apisrv,123pan-uni-app -o b.json
 *   npx tsx scripts/mirror-compare.ts compare a.json b.json
 *
 * `capture` 里的 `--repos` 也可以省略（= 全部仓），但那就不是对比、是测量。
 *
 * 退出码：0 两份完全一致 / 3 有不一致（脚本给表，不替你判断哪边对）/ 2 参数或配置不对。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { db, pool } from '../src/db/client.js';
import { head, resolveMirrorConfig } from '../src/core/codemirror/mirror.js';
import { repoIndex } from '../src/core/codemirror/index-store.js';

type Capture = {
  repo: string;
  transport: string;
  ok: boolean;
  error?: string;
  sha?: string;
  date?: string;
  files?: number;
  pages?: number;
  outline?: number;
  imports?: number;
  bytes?: number;
  sha256?: string;
  /** 装配耗时（毫秒）——含 ls-tree 那一次往返，这正是两种传输的差别所在。 */
  ms?: number;
};

type Args = { mode: 'capture' | 'compare'; repos: string[]; out: string; files: string[] };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { mode: 'capture', repos: [], out: '', files: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? '';
    if (flag === 'capture' || flag === 'compare') args.mode = flag;
    else if (flag === '--repos') { args.repos = (argv[i + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean); i += 1; }
    else if (flag === '-o' || flag === '--out') { args.out = argv[i + 1] ?? ''; i += 1; }
    else if (flag === '--help' || flag === '-h') {
      console.log([
        '用法：',
        '  mirror-compare.ts capture [--repos a,b,c] -o out.json',
        '  mirror-compare.ts compare a.json b.json',
        '',
        'capture 读的是 resolveMirrorConfig() 解析出来的那份配置（env → 设置 → 默认），',
        '所以「旧/新」两份配置各跑一次 capture；compare 只读两份 JSON，不碰镜像。',
      ].join('\n'));
      process.exit(0);
    } else if (flag.startsWith('-')) {
      console.error(`未知参数：${flag}`);
      process.exit(2);
    } else {
      args.files.push(flag);
    }
  }
  return args;
}

async function capture(repos: readonly string[], out: string): Promise<number> {
  const config = await resolveMirrorConfig();
  if (!config.ok) {
    console.error(`读不到镜像配置：${config.message}`);
    return 2;
  }
  const ids = repos.length > 0 ? [...repos] : config.data.repos.map((repo) => repo.id);
  const rows: Capture[] = [];
  for (const repo of ids) {
    const headResult = await head(repo);
    if (!headResult.ok || headResult.data === null) {
      rows.push({
        repo, transport: config.data.transport, ok: false,
        error: headResult.ok ? '镜像里没有 HEAD（空仓？）' : headResult.message,
      });
      continue;
    }
    const { sha, date } = headResult.data;
    const built = await repoIndex(db, repo, sha);
    if (!built.ok) {
      rows.push({ repo, transport: config.data.transport, ok: false, sha, date, error: built.message });
      continue;
    }
    // 索引的**字节**：不是摘要的摘要，而是 `JSON.stringify` 的每一字节都参与。
    // 键序由装配过程决定（文件按树序、imports 按解析序），两份配置下必须一致。
    const json = Buffer.from(JSON.stringify(built.data.index), 'utf8');
    rows.push({
      repo,
      transport: config.data.transport,
      ok: true,
      sha,
      date,
      files: Object.keys(built.data.index.files).length,
      pages: built.data.index.pages.length,
      outline: Object.values(built.data.index.outline).reduce((sum, nodes) => sum + nodes.length, 0),
      imports: Object.keys(built.data.index.imports).length,
      bytes: json.byteLength,
      sha256: createHash('sha256').update(json).digest('hex'),
      ms: built.data.buildMs,
    });
    console.log(`${repo}\t${config.data.transport}\t${sha.slice(0, 8)}\t${date}\t`
      + `files=${rows[rows.length - 1]!.files}\tpag=${rows[rows.length - 1]!.pages}\t`
      + `out=${rows[rows.length - 1]!.outline}\tB=${rows[rows.length - 1]!.bytes}\t`
      + `${rows[rows.length - 1]!.sha256!.slice(0, 16)}\t${built.data.buildMs}ms`);
  }
  if (out !== '') {
    await writeFile(out, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
    console.log(`写出 ${out}（${rows.length} 个仓，transport=${config.data.transport}）`);
  }
  return rows.every((row) => row.ok) ? 0 : 3;
}

async function compare(left: string, right: string): Promise<number> {
  const a = JSON.parse(await readFile(left, 'utf8')) as Capture[];
  const b = JSON.parse(await readFile(right, 'utf8')) as Capture[];
  const byRepoB = new Map(b.map((row) => [row.repo, row]));
  const fields: (keyof Capture)[] = ['sha', 'date', 'files', 'pages', 'outline', 'imports', 'bytes', 'sha256'];
  let mismatch = 0;
  console.log('repo\tsha\tdate\tfiles\tpages\toutline\tbytes\tsha256\t判定');
  for (const row of a) {
    const other = byRepoB.get(row.repo);
    if (other === undefined || !other.ok || !row.ok) {
      mismatch += 1;
      console.log(`${row.repo}\t-\t-\t-\t-\t-\t-\t-\t读不到（${row.error ?? other?.error ?? '对方没有这个仓'}）`);
      continue;
    }
    const diffs = fields.filter((field) => row[field] !== other[field]);
    if (diffs.length > 0) mismatch += 1;
    console.log([
      row.repo,
      row.sha === other.sha ? '同' : '异',
      row.date === other.date ? '同' : '异',
      `${row.files}/${other.files}`,
      `${row.pages}/${other.pages}`,
      `${row.outline}/${other.outline}`,
      `${row.bytes}/${other.bytes}`,
      row.sha256 === other.sha256 ? '逐字节同' : '不同',
      diffs.length === 0 ? 'match' : `mismatch(${diffs.join(',')})`,
    ].join('\t'));
  }
  console.log(mismatch === 0 ? `结论\t${a.length} 个仓全部 match` : `结论\t${mismatch} 个仓 mismatch`);
  return mismatch === 0 ? 0 : 3;
}

const args = parseArgs(process.argv.slice(2));
try {
  if (args.mode === 'compare') {
    const [left, right] = args.files;
    if (left === undefined || right === undefined) {
      console.error('compare 需要两个 JSON 文件：mirror-compare.ts compare a.json b.json');
      process.exitCode = 2;
    } else {
      process.exitCode = await compare(left, right);
    }
  } else {
    process.exitCode = await capture(args.repos, args.out);
  }
} finally {
  await pool.end();
}
