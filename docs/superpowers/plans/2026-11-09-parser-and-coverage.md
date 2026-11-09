# 解析器与覆盖率：903 字节让整晚索引停摆的两件事

2026-11-09，分支 `main`（起点 `a7d800f`）。两个修复，两个提交，顺序执行：

| # | 提交 | 内容 |
|---|---|---|
| 1 | `0f9a4d1` | `src/core/codemirror/code-index.ts`：让 903 字节的 `SvgIcon/index.vue` 不再挂住索引 + 类别守卫 |
| 2 | `938325e` | 覆盖率测量与传输方式解耦，216 个仓都有一行 `repo_coverage` |

---

## Fix 1 — 灾难性…不，是「匹配永不前进」

### 结论先说

| 问题 | 答案 |
|---|---|
| 卡住的那个正则 | `/\bdefineComponent\s*\(|name\s*:\s*['"]([\w$-]+)['"]/`（`COMPONENT_NAME`，**没有 `g`**） |
| 为什么卡住 | 不是回溯。**不带 `g` 的 `exec` 每次都从下标 0 重新开始**，而它被 `for (… exec(text) …)` 驱动——含 `defineComponent(` 的文件里每一次都命中同一处，循环永不结束 |
| 为什么栈像回溯 | `RegExpPrototypeExec` 是这条路径上唯一的可命名帧，回溯与死循环都停在那儿。区别在**次数**：回溯是「一次 exec 太久」，这里是「exec 次数无限」 |
| 新形状 | `/name\s*:\s*['"]([\w$-]+)['"]/g`（带 `g`、单分支、无嵌套量词），`defineComponent` 那道门槛改用 `indexOf` |

### 怎么找到的（不是猜的）

1. 两份镜像的 `SvgIcon/index.vue` 不同 —— 而且**真正的触发者不是同一份**：

   | 仓 | 路径 | 字节 | 含 `defineComponent` | 实测 |
   |---|---|---|---|---|
   | `platform-fontend` | `src/components/SvgIcon/index.vue` | 903 | 是 | 挂死 |
   | `fe-tool` | `packages/kola/src/components/svg-icon/index.vue` | 870 | **否** | 1 ms 正常 |
   | `fe-tool` | `apps/123pan-admin/src/components/menu/index.vue` | 5296 | 是 | 挂死 |

   `fe-tool` 里同名同用途的那份是**正常**的，它挂在另一个含 `defineComponent` 的 `.vue` 上。
   所以「两个仓各有一份同名文件」这句话只对一半：**触发条件是内容里有 `defineComponent`**，
   不是路径。

2. 逐条正则实测（`.tmpwork/probe-regex.mjs`）：把 `code-index.ts` 里扫出来的 53 条正则字面量
   × 5 种用法（exec 循环 / test / match-all / replace / split）共 265 组，每组一个独立子进程 +
   2 s SIGKILL，喂的正是那 903 字节：

   | 组 | 结果 |
   |---|---|
   | 265 组（修复后的源码） | **0 组挂住**，全部 ≤ 105 ms（那是 node 冷启动） |
   | 补测：修复前那条字面量 + exec 循环 | **`NONADVANCE`** —— 子进程自己数到 10 万次 `exec` 仍未前进 |

   这一步把「回溯」排除了：单条 `exec` 一次都没慢过；慢的是**次数**。

3. 真正的定位工具是 `.tmpwork/probe-parseblob.mts`：把 `RegExp.prototype.exec` 包一层、每次
   调用往固定 fd 写一行「当前正则」，然后拿 `timeout` 杀进程。被 SIGKILL 后最后一行就是凶手：

   ```
   5824586  /\bdefineComponent\s*\(|name\s*:\s*['"]([\w$-]+)['"]/
   5824587  /\bdefineComponent\s*\(|name\s*:\s*['"]([\w$-]+)['"]/
   ```

   为什么必须这么干：回溯/死循环都是**同步**的，`setTimeout`、`alarm`、`AbortSignal` 一次都
   轮不到执行（`onboard-repos.ts` 里那条 240 s 看门狗当晚就是这么失效的）。能停下一个同步
   死循环的只有**别的进程**。

### 为什么新形式是线性的

```
name  \s*  :  \s*  ['"]  [\w$-]+  ['"]
```

- 每个量词都锚在一个**必需的字面字符**后面（`:`、引号），没有「一个量词直接套在另一个量词上」；
- 没有共享前缀的多分支（原来的 `defineComponent\s*\( | name:…` 两条分支在 `d`/`n` 上不同，
  但分支本身让「这条正则到底在找什么」变得可以有两种读法）；
- 匹配长度 ≥ 5 个字符，带 `g` 的 `exec` 每命中一次必然把 `lastIndex` 推过匹配末尾——
  **前进是结构性的，不依赖调用方**；
- 唯一的「可回退」点是 `\s*` 撞上非 `:` / 非引号时的空跑，那是 O(空白游程)，不是指数。

`defineComponent` 这道门槛从正则里搬到 `text.indexOf('defineComponent')`：它本来就是
「这个文件里得有 defineComponent」一句话，而原来那个分支一个字符都不捕获（`m[1]` 永远是
`undefined`，原代码在 `if` 里什么都不做）。

### 输出有没有变（口径）

**没变。** 证据两条：

1. `COMPONENT_NAME` 只被 `exportsOf()` 用，`outlineOf()` / `vueOutline()` / `jsxOutline()` /
   `goOutline()` 一个字节都没动；
2. 把 `exportsOf()` 的**老实现整份**复制到探针里（老字面量、只手加 `g`），与仓库里的新实现
   逐文件比对两个真实仓的全部 `.vue`：

   ```
   vue files=610  withDefineComponent=7  diffs=0
   ```

   那 7 个含 `defineComponent` 的文件里，老实现**加了 `g`** 才跑得完——它的答案与新实现逐字
   相同。唯一「变了」的是原本没有输出的情形：903 字节那个文件的 `parseBlob` 现在是

   ```json
   {"lang":"vue","symbols":[],"outline":[],"refs":{"specs":[],"locals":{},"routes":[]}}
   ```

   `outline` 空是**对的**：template 里只有 `<svg>` / `<use>` 两个小写标签，而 outline 的口径
   是「大写开头的组件」。修复前这个调用**没有返回值**（永远不返回），所以谈不上先后 diff。

### 前后耗时

| 对象 | 修复前 | 修复后 |
|---|---|---|
| `parseBlob()` 处理那 903 字节 | 永不返回（15 s 内 580 万次 `exec`；30 s 也到不了头） | **0.582 ms** |
| `index-sync platform-fontend` | `> 180 s` 被 `timeout` 杀（`time real 3m0.149s`，`user 2m37.624s`） | **403 ms** 装配 / 1.78 s 墙钟 |
| `index-sync fe-tool` | `> 180 s` 被杀（同上一模一样：用户态烧满） | **815 ms** 装配 / 2.57 s 墙钟 |

修复后两个仓的索引都完成，且数字对得上：

| 仓 | 树里文件 | 进索引 | pages | outline 文件 | imports |
|---|---|---|---|---|---|
| `platform-fontend` | 574 | 396 | 15 | 174 | 278 |
| `fe-tool` | 819 | 584 | 10 | 200 | 1135 |

（`fe-tool` 的 584 与修复前 `syncRepoIndex` 在别的仓上量到的 350–500 ms 同一量级——它本来就
该是这个速度。）

---

## 守卫：预算名 `PARSE_BUDGET_MS = 2000`

`tests/code-index-backtracking.test.ts`，4 条用例。**全部在子进程里跑**
（`tests/helpers/parse-budget-runner.mts` + `spawnSync` + `SIGKILL`），预算名就是
`PARSE_BUDGET_MS`：一条形状 2 000 ms；父进程的击杀线是 `PARSE_BUDGET_MS + 8 000 ms`
（后 8 s 只买 `node`/`tsx` 冷启动，不算进预算）。

| 用例 | 钉的是什么 |
|---|---|
| 事故文件 | `tests/fixtures/svg-icon-index.vue`（**903 字节，sha256 与镜像逐字一致**：`c4fd5f86…b2ed`）在 2 s 内解析完，`outline`/`symbols`/`specs` 与这份内容应有的样子一致 |
| 病态形状 | 五个形状各自 < 2 s：长属性串（4 000 个属性）、两万层 `<div>`、200 KB 未闭合标签、400 KB 单行模板、无词边界的长大写游程 |
| 类别守卫 | 扫 `src/` 下 **27 处** exec 循环，驱动的正则必须带 `g`（`for (const re of [A, B])` 这种别名也展开）；「一处都没扫到」本身断言失败，防这条守卫扫空 |
| 口径不变 | `defineComponent` + `name:` 仍抽出组件名；没有 `defineComponent` 的文件仍不抽 |

病态形状语料住在 `tests/helpers/parse-shapes.ts`——用例与子进程 runner 读**同一份**，否则
「预算内」会是一句没人核对的话。

为什么要子进程：这三条用例里的任何一条在修复被打回时都会**同步挂住**。第一次做的时候
「口径不变」放在父进程里，mutation 一打上去整份文件 300 s 不退出（既不红也不绿）——比红更糟。
现在所有 `parseBlob`/`exportsOf` 调用都在子进程，违反一律变成一条能读到的失败。

### Mutation 表（逐条打回源码，跑守卫，再从备份恢复）

| id | 打回去的是什么 | 期望 | 实测 | 被哪条用例抓住 |
|---|---|---|---|---|
| M1 | 去掉 `g`（原始缺陷） | 红 | **红** | 类别守卫（`COMPONENT_NAME = /…/` 无 `g`）+ 口径用例（子进程 10 007 ms 被杀） |
| M2 | `COMPONENT_TAG` → `/<([A-Z][A-Za-z0-9_]*)*>/g`（量词套量词） | 红 | **红** | 病态形状（子进程 10 013 ms 被杀，"至少一个形状把子进程挂住了"） |
| M3 | `TEMPLATE_OPEN` → `/<template(?:\s[^>]*)*>/i`（量词套量词） | 红 | **红** | 病态形状（子进程 10 015 ms 被杀） |
| M4 | 对照：加一条多分支但保留 `g` | 绿 | **绿** | ——（守卫不误报） |

M1 的细节值得记：事故文件本身没有 `name:`，所以「去掉 `g`」在**那个文件**上退不出循环
（正则不命中 → `exec` 返回 null）。抓住它的是口径用例（含 `name: 'SearchEntrance'`）与
静态守卫。也就是说：这条缺陷有两个入水口，两个都被钉住了。

---

## Fix 2 — 216 个仓的覆盖率

### 为什么那 75 个仓一行都没有

不是「测量坏了」，是**测量被绑在接入上**。`onboard-repos.ts` 的活是「服务器上还没有 →
clone → 索引 → 记账」，所以它写死 `ssh <host> git …`，并在 `transport !== 'ssh'` 时
**直接退出**——对它是对的（它的参数是服务器约定：盘在哪、`du`/`df` 怎么读）。2026-11-09 的
cutover 把镜像搬到本机盘（`transport = local`）之后，这个退出条件把测量整条带离线了。

而测量本身从来不依赖传输方式：`lsTreeEntries()` / `syncRepoIndex()` 都走 `mirror.ts` 的只读层，
两种传输都认。

### 做了什么

| 文件 | 改动 |
|---|---|
| `src/core/codemirror/coverage-measure.ts`（新） | `measureRepo()` 从 `onboard-repos.ts` **原样搬来**（先列树、再索引、`coverageCounts()` 数五个数）；另加纯函数 `zeroCauseOf()` |
| `scripts/onboard-repos.ts` | 删掉本地那份 `measureOne()`，改调 `measureRepo()`——**只有一套测量实现** |
| `scripts/measure-coverage.ts`（新） | 读 `config/repos.txt` → 逐仓 `head()` + `measureRepo()` + `recordCoverage()`；不克隆、不 ssh、不碰磁盘闸；`--resume` / `--only` / `--json` / `--index-timeout-s` |
| `src/core/codemirror/repo-inventory.ts` | 新增常量 `REPO_EXCLUDED_PATH`（排除账本的位置只有一处） |

行形状与 `onboard-repos.ts` 完全一致：`files_total`（`ls-tree` 去噪后）、`files_indexed`、
`files_skipped_generated`、`pages`、`outline_files`、`imports`、`ok`、`error`。

### 实测（`node_modules/.bin/tsx scripts/measure-coverage.ts --json`）

```
清单      config/repos.txt（216 个仓，本轮 216 个）
镜像传输  local
ok=true   216
ok=false  0
files_indexed=0  50
耗时 45.5 s
```

- **表里 219 行**：216 行是当前清单（全部 `ok=true`）+ 3 行**过期仓**，见下；
- `files_indexed = 0` 的 50 个仓，一词原因分布：

| 原因 | 个数 | 判据 | 例子 |
|---|---|---|---|
| `language` | 24 | 仓里有源码，但**不是**我们解析的语言（Java/Dart/C/Lua/Rust/PHP…） | `app`（Dart/Swift）、`trafficserver`（C++）、`php-audit` |
| `generated` | 17 | 有可索引的文件，全被判成生成代码（`.pb.go` / 生成的 bundle） | `activity`、`auth`、`go-protobuf` |
| `docs` | 8 | 只有文档与图片 | `review`（1 个 `.md`）、`api-pay`、`blank` |
| `config` | 1 | 只有配置/数据（空仓也算这一类） | `thumbnail` |
| `other` | **0** | 上面都不成立——没人解释得通的那一格 | —— |

判据复用 `isIndexable()`（不在脚本里另写扩展名白名单）：否则这张表会与索引自己数出来的
`files_indexed` 用两套口径，那正是这张表存在的理由被破坏的方式。

### 仍然排除（必须单独列出，不许静默消失）

`config/repos-excluded.txt` 共 5 条，都不在 216 里、不进表：

| 仓 | 为什么 |
|---|---|
| `fre/pc/ai` | GitLab 返回 **permission denied**（重试无意义）；拿到权限后用 `source=gitlab` 加进来 |
| `fre/pc/Code Review Agent` | GitLab 返回 **permission denied**（同上）；仓名带空格，接入时要给合法 id |
| `gocron`（codeup 根下） | **空仓**（`ls-remote` 零 refs）；真正的 gocron 已作为 `gl-gocron` 接入 |
| `cdn-groups/artifacts` | `artifacts` 的另一个副本（取 `lastActivityAt` 更新的根下那份） |
| `cdn-groups/go-protobuf` | `go-protobuf` 的另一个副本（同上） |

另有三行**历史行**留在表里，都不在当前清单（`ok=false`，原因写在 `error` 列，没有删）：

| 仓 | `error` |
|---|---|
| `gocron` | 远端是空仓（clone 成功但一个 ref 都没有） |
| `ploto` | 不存在：`ls-remote` → 未知的仓库路径 |
| `sqlstring` | clone 失败（3 次）：未知的仓库路径 |

所以读表的算式是 `216 (ok) + 3 (历史 false) = 219 行`；「不遗不漏」的分母是
`216 + 5 排除 = 221`，`221 - 216 = 5` 就是上面那张排除表。

---

## 用例与约束

| 项 | 数 |
|---|---|
| 新增用例文件 | `tests/code-index-backtracking.test.ts`（4 条） |
| 新增守卫夹具 | `tests/fixtures/svg-icon-index.vue`、`tests/helpers/parse-shapes.ts`、`tests/helpers/parse-budget-runner.mts` |
| 新增用例（覆盖率） | `tests/repo-coverage.test.ts` 11 → 16（`zeroCauseOf` 的 5 条判据） |
| 新依赖 | 0（子进程用 `node:child_process`，fixture 用 `node:fs`） |

约束遵守情况：

- `git clean` / `git checkout -- .`：**一次都没跑**；mutation 用 `.tmpwork` 里的备份文件恢复
  （`.tmpwork/` 全程未被跟踪、未被清理）；
- `requirements` 表：未动（814），未 reseed；
- 抽取规则：未改（见「输出有没有变」）；`outline` 相关代码零改动。

## 还没做的 / 下一眼要看的地方

1. `fe-tool` 的触发文件与任务描述里那份**不是同一个路径**（`apps/123pan-admin/src/components/
   menu/index.vue`）。如果想把「哪个文件挂的」变成夜间日志里的一句话，`index-sync` 需要把
   「当前在解析哪块 blob」写进 stderr——现在只能靠外部探针复现。
2. `PARSE_BUDGET_MS` 是**测试预算**，不是运行时保护：生产里一条同步死循环仍然只能靠
   `index-nightly` 的 `spawnSync` 超时兜住（它会杀，但那一轮那个仓就废了）。要不要给解析器
   加一条「单文件墙钟上限」是另一个决定，本次没做。
3. `files_indexed = 0` 里 24 个 `language` 是**选型问题**，不是 bug：Java/Dart/C 仓要不要进
   索引，取决于材料要不要回答它们的问题。
