import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseRepos } from '../src/core/codemirror/mirror.js';
import {
  CODEUP_ORG, DEFAULT_STALE_AFTER_DAYS, FALLBACK_BRANCH, STALE_NEVER, cloneUrl, cloneUrlOf,
  diffRepos, formatInventoryLine, inventoryToRepos, parseRepoInventory, readRepoInventory,
  reposSettingJson, staleThresholdsOf,
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
 * 5. **`path=` 这一格**（2026-11-09 新增）：它决定克隆地址。它坏掉的方式必须是大声的
 *    ——`path` 最后一段不等于仓名时，「目录里是 A 仓、每晚去 fetch B 仓」是安静的。
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
    // 没写 path= 的三行都落在**历史默认** `123pan/<仓名>` 上：旧清单读出来仍然指向原地址。
    expect(parsed.data.repos).toEqual([
      {
        id: '123pan-pc', branch: 'master', path: '123pan/123pan-pc', line: 2,
        staleAfterDays: DEFAULT_STALE_AFTER_DAYS,
      },
      {
        id: '123pan-uni-app', branch: 'master', path: '123pan/123pan-uni-app', line: 3,
        staleAfterDays: DEFAULT_STALE_AFTER_DAYS,
      },
      {
        id: '123pan-gateway', branch: FALLBACK_BRANCH, path: '123pan/123pan-gateway', line: 6,
        staleAfterDays: DEFAULT_STALE_AFTER_DAYS,
      },
    ]);
    // 注释 2 行 + 空行 2 行（含结尾换行造出来的那一行）：计数只为「这份文件确实被读到了」。
    expect(parsed.data.skipped).toBe(4);
    // 只有仓名是「明显省略」，但猜出来的东西要留一句提示：猜错分支的错法是安静的。
    expect(parsed.data.notes.join('')).toContain('123pan-gateway');
  });

  it('连续空格当一格（有人用对齐）', () => {
    const parsed = parseRepoInventory('a    dev\n');
    expect(parsed.ok && parsed.data.repos[0]).toEqual({
      id: 'a', branch: 'dev', path: '123pan/a', line: 1, staleAfterDays: DEFAULT_STALE_AFTER_DAYS,
    });
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

  it('多出来的格子整份失败（第四格起，注释只能整行）', () => {
    const parsed = parseRepoInventory('a master 365 主线\n');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain('多了');
  });

  it('第三格：数字 = 每仓阈值；缺省 = 7；never = 永不因旧提醒', () => {
    const parsed = parseRepoInventory('a master 365\nb dev\nc main never\n');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.repos.map((entry) => entry.staleAfterDays))
      .toEqual([365, DEFAULT_STALE_AFTER_DAYS, null]);
    // `null` 与 `7` 必须是两件事：前者是「上游已归档」，后者是「照常提醒」。
    expect(parsed.data.repos[2]!.staleAfterDays).toBeNull();
    expect(staleThresholdsOf(parsed.data.repos)).toEqual({ a: 365, b: 7, c: null });
  });

  it('第三格写 0 / 负数 / 非数字整份失败并点名（0 不是一个天数）', () => {
    for (const bad of ['0', '-1', '7d', 'never!', '1.5']) {
      const parsed = parseRepoInventory(`a master ${bad}\n`);
      expect(parsed.ok, bad).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.message).toContain('stale_after_days');
      expect(parsed.message).toContain('never');
    }
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

  it('path= 决定克隆地址：组织根 / 组下 / 顺序无关', () => {
    const parsed = parseRepoInventory(
      'apisrv master path=123pan/apisrv\n'
      + 'artifacts master path=artifacts\n'
      + 'beats main path=cdn-groups/beats\n'
      + 'tl dev stale=30 path=test-groups/tl\n',
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.repos.map((entry) => entry.path)).toEqual([
      '123pan/apisrv', 'artifacts', 'cdn-groups/beats', 'test-groups/tl',
    ]);
    // 格子顺序无关：stale 写在 path 前面也认。
    expect(parsed.data.repos[3]!.staleAfterDays).toBe(30);
    // 地址只在 cloneUrlOf 一处拼：组织根 + path + .git。
    expect(parsed.data.repos.map(cloneUrl)).toEqual([
      `${CODEUP_ORG}/123pan/apisrv.git`,
      `${CODEUP_ORG}/artifacts.git`,
      `${CODEUP_ORG}/cdn-groups/beats.git`,
      `${CODEUP_ORG}/test-groups/tl.git`,
    ]);
  });

  it('path 的最后一段必须等于仓名（目录名与地址指向同一个仓）', () => {
    // 这条校验拦的是**安静**的错法：目录叫 a、地址指着 b，每晚 fetch 的是别人。
    const parsed = parseRepoInventory('a master path=123pan/b\n');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain('最后一段');
    expect(parsed.message).toContain('123pan/b');
  });

  it('path= 写成空的 / 带 .. / 带奇怪字符整份失败', () => {
    for (const bad of ['path=', 'path=123pan/../etc', 'path=/abs', 'path=a//b', 'path=a b']) {
      const parsed = parseRepoInventory(`a master ${bad}\n`);
      expect(parsed.ok, bad).toBe(false);
    }
  });

  it('两个 path= 或两个 stale= 整份失败（一个仓只有一条路径/一个阈值）', () => {
    const twicePath = parseRepoInventory('a master path=123pan/a path=cdn-groups/a\n');
    expect(twicePath.ok).toBe(false);
    if (!twicePath.ok) expect(twicePath.message).toContain('两个 path=');
    const twiceStale = parseRepoInventory('a master stale=30 stale=never\n');
    expect(twiceStale.ok).toBe(false);
    if (!twiceStale.ok) expect(twiceStale.message).toContain('两个 stale=');
  });

  it('认不出的格子点名（第三格起只认 path= 与 stale=）', () => {
    const parsed = parseRepoInventory('a master group=123pan\n');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain('认不出');
    expect(parsed.message).toContain('group=123pan');
  });

  it('cloneUrlOf：org 的尾斜杠不会拼出双斜杠', () => {
    expect(cloneUrlOf('cdn-groups/beats', `${CODEUP_ORG}/`)).toBe(`${CODEUP_ORG}/cdn-groups/beats.git`);
    expect(cloneUrlOf('/cdn-groups/beats')).toBe(`${CODEUP_ORG}/cdn-groups/beats.git`);
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
      {
        id: 'a', branch: 'master', path: '123pan/a', line: 1,
        staleAfterDays: DEFAULT_STALE_AFTER_DAYS,
      },
      { id: 'b', branch: 'dev', path: 'cdn-groups/b', line: 2, staleAfterDays: null },
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
    expect(formatInventoryLine(result.data.inventory.repos[0]!)).toBe('shop-web\tmain\tpath=123pan/shop-web');
    // 偏离默认的第三格才写出来（一份 30 行的清单里 24 行写 7 只是噪音）。
    const withStale = parseRepoInventory('a master 365\nb main never\nc dev\n');
    expect(withStale.ok).toBe(true);
    if (!withStale.ok) return;
    // `path=` 永远写出来（它才是「这个仓在哪」的记录）；stale 只在偏离默认时写。
    expect(withStale.data.repos.map(formatInventoryLine)).toEqual([
      'a\tmaster\tpath=123pan/a\tstale=365',
      `b\tmain\tpath=123pan/b\tstale=${STALE_NEVER}`,
      'c\tdev\tpath=123pan/c',
    ]);
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
