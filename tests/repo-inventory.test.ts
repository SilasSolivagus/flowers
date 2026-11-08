import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseRepos } from '../src/core/codemirror/mirror.js';
import {
  FALLBACK_BRANCH, diffRepos, formatInventoryLine, inventoryToRepos, parseRepoInventory,
  readRepoInventory, reposSettingJson,
} from '../src/core/codemirror/repo-inventory.js';

/**
 * 仓清单（`config/repos.txt`）：这是「哪些仓」的**唯一来源**，所以它坏掉的方式必须都是
 * 大声的。
 *
 * 这一组钉的是四件事：
 *
 * 1. **格式**：制表符/空格/连续空白都认；`#` 只整行注释；空行忽略；只有仓名时给提示
 *    而不是静默猜。
 * 2. **坏行整份失败**（与 `parseRepos()` 同一条取舍：半份仓库列表比没有更糟）。
 *    重名、坏字符、多出来的格子，都必须点名行号。
 * 3. **路径**：`path` 由 `MIRROR_ROOT` 拼出来，仓名不许带 `/` 或 `..`（它进的是服务器路径）。
 * 4. **与设置同构**：清单 → `[{"id","path"}]` 之后必须能被 `parseRepos()` 原样读回来
 *    ——这条是这个文件存在的理由（一个来源、零漂移）。
 */

const SAMPLE = `# 注释：三行真数据
123pan-pc\tmaster
123pan-uni-app  master

# 下面这行只有仓名
123pan-gateway
`;

describe('parseRepoInventory', () => {
  it('认制表符与空格两种分隔，跳过注释与空行', () => {
    const parsed = parseRepoInventory(SAMPLE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.repos).toEqual([
      { id: '123pan-pc', branch: 'master', line: 2 },
      { id: '123pan-uni-app', branch: 'master', line: 3 },
      { id: '123pan-gateway', branch: FALLBACK_BRANCH, line: 6 },
    ]);
    // 注释 2 行 + 空行 2 行（含结尾换行造出来的那一行）：计数只为「这份文件确实被读到了」。
    expect(parsed.data.skipped).toBe(4);
    // 只有仓名是「明显省略」，但猜出来的东西要留一句提示：猜错分支的错法是安静的。
    expect(parsed.data.notes.join('')).toContain('123pan-gateway');
  });

  it('连续空格当一格（有人用对齐）', () => {
    const parsed = parseRepoInventory('a    dev\n');
    expect(parsed.ok && parsed.data.repos[0]).toEqual({ id: 'a', branch: 'dev', line: 1 });
  });

  it('重名整份失败，并点名两行', () => {
    const parsed = parseRepoInventory('a master\na dev\n');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain('第 1 行');
    expect(parsed.message).toContain('第 2 行');
  });

  it('仓名带路径穿越整份失败', () => {
    for (const bad of ['../etc', 'a/b', '.hidden', '-x']) {
      const parsed = parseRepoInventory(`${bad}\tmaster\n`);
      expect(parsed.ok, bad).toBe(false);
    }
  });

  it('多出来的格子整份失败（注释只能整行）', () => {
    const parsed = parseRepoInventory('a master 主线\n');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain('多了');
  });

  it('分支带 .. 整份失败', () => {
    const parsed = parseRepoInventory('a ../b\n');
    expect(parsed.ok).toBe(false);
  });

  it('空清单是一句能照着做的中文', () => {
    const parsed = parseRepoInventory('# 只有注释\n\n');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain('一个仓都没有');
  });

  it('CRLF 不会把 \\r 带进分支名', () => {
    const parsed = parseRepoInventory('a master\r\nb main\r\n');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.repos.map((entry) => entry.branch)).toEqual(['master', 'main']);
  });
});

describe('inventoryToRepos / reposSettingJson', () => {
  it('path 由 MIRROR_ROOT 拼出来（尾斜杠不影响）', () => {
    const lines = [
      { id: 'a', branch: 'master', line: 1 },
      { id: 'b', branch: 'dev', line: 2 },
    ];
    expect(inventoryToRepos(lines, '/srv/x/')).toEqual([
      { id: 'a', path: '/srv/x/a.git' },
      { id: 'b', path: '/srv/x/b.git' },
    ]);
  });

  it('转成设置后能被 parseRepos 原样读回来（一个来源的守卫）', () => {
    const lines = parseRepoInventory('a master\nb dev\n');
    expect(lines.ok).toBe(true);
    if (!lines.ok) return;
    const json = reposSettingJson(inventoryToRepos(lines.data.repos, '/srv/123pan-mirror'));
    const back = parseRepos(json, 'settings');
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.data).toEqual([
      { id: 'a', path: '/srv/123pan-mirror/a.git' },
      { id: 'b', path: '/srv/123pan-mirror/b.git' },
    ]);
  });
});

describe('diffRepos', () => {
  const current = [
    { id: 'a', path: '/srv/a.git' },
    { id: 'b', path: '/srv/b.git' },
  ];

  it('一致时 same = true', () => {
    expect(diffRepos(current, current).same).toBe(true);
  });

  it('加仓 / 删仓 / path 变 / 顺序变各自看得见', () => {
    const added = diffRepos(current, [...current, { id: 'c', path: '/srv/c.git' }]);
    expect(added.added).toEqual(['c']);
    expect(added.same).toBe(false);

    const removed = diffRepos(current, [current[0]!]);
    expect(removed.removed).toEqual(['b']);

    const moved = diffRepos(current, [current[0]!, { id: 'b', path: '/other/b.git' }]);
    expect(moved.moved).toEqual([{ id: 'b', from: '/srv/b.git', to: '/other/b.git' }]);

    const reordered = diffRepos(current, [current[1]!, current[0]!]);
    expect(reordered.reordered).toBe(true);
    expect(reordered.added).toEqual([]);
    expect(reordered.removed).toEqual([]);

    // 设置里还没有这一格：全算「加」。
    expect(diffRepos(null, current).added).toEqual(['a', 'b']);
  });
});

describe('readRepoInventory', () => {
  it('文件不存在时点名该建哪个文件', async () => {
    const missing = path.join(await mkdtemp(path.join(tmpdir(), 'flowers-inv-')), 'nope.txt');
    const result = await readRepoInventory(missing);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('读不到仓清单');
    expect(result.message).toContain(missing);
  });

  it('读到之后带上文件名与行号', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'flowers-inv-'));
    const file = path.join(dir, 'repos.txt');
    await writeFile(file, 'shop-web\tmain\n', 'utf8');
    const result = await readRepoInventory(file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.file).toBe(file);
    expect(formatInventoryLine(result.data.inventory.repos[0]!)).toBe('shop-web\tmain');
  });

  it('坏行的报错里有文件名', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'flowers-inv-'));
    const file = path.join(dir, 'repos.txt');
    await writeFile(file, 'ok master\n../bad master\n', 'utf8');
    const result = await readRepoInventory(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain(file);
    expect(result.message).toContain('第 2 行');
  });
});
