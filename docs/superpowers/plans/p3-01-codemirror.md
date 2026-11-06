# P3.1 走查的只读层：`src/core/codemirror/mirror.ts` + `route.ts`

日期：2026-11-06　分支：`main`　工作目录：`/Users/silas/flowers`

这一层只做一件事：**不 checkout、不落到本地，直接读一台远端服务器上的 bare 镜像**。
owner 的三个镜像（`dogyun:/srv/123pan-mirror/*.git`）是走查阶段一的唯一依据，而
走查要回答的是「HEAD 上现在是什么样」——所以这里没有工作区、没有 index、没有
`git pull`，只有四类读命令。

```
src/core/codemirror/mirror.ts   transport + 配置解析 + 四个读口 + 噪音过滤
src/core/codemirror/route.ts    阶段一需要的「形状」：页面 / 接口 / 组件
tests/codemirror.test.ts        24 个用例（真 git、真 bare 仓）+ 1 个默认跳过的 live smoke
```

## 1. 传输与配置解析

三格，键名是服务层常量（写在本文件顶部，库不解释它们）：

| 键 | 环境变量 | 默认 |
| --- | --- | --- |
| `code.mirror.transport`（`local` \| `ssh`） | `FLOWERS_MIRROR_TRANSPORT` | `local` |
| `code.mirror.repos`（JSON `[{id,path}]`） | `FLOWERS_MIRROR_REPOS` | **无**（缺就是失败） |
| `code.mirror.sshHost` | `FLOWERS_MIRROR_SSH_HOST` | `dogyun` |

解析顺序与 `uemaster/provider.ts` 的三格同形：**env → `app_settings` → 默认**，
逐格回落。`app_settings` 的读走 `uemaster/settings.ts` 的 `readSetting()`——它是
那个表的唯一读写口，镜像配置不另开一个口子。

为什么 `repos` 没有默认值、缺了整份失败：

> 一个「配了 transport、没配仓库」的部署看起来是配好的（`listRepos()` 回 `[]`），
> 走查会安静地产出一份空报告。宁可在第一格就失败，并**点名**缺的是
> `code.mirror.repos` 还是 `FLOWERS_MIRROR_REPOS`。

`parseRepos()` 的口径是**整份作废、不拼半份**：

```json
[
  { "id": "123pan-pc",             "path": "/srv/123pan-mirror/123pan-pc.git" },
  { "id": "123pan-uni-app",        "path": "/srv/123pan-mirror/123pan-uni-app.git" },
  { "id": "123pan-cross-frontend", "path": "/srv/123pan-mirror/123pan-cross-frontend.git" }
]
```

失败的话术（都点名是哪一格）：

| 情况 | 返回 `code` | 消息（节选） |
| --- | --- | --- |
| 没配 repos | `bad_config` | 没有配置代码镜像仓库：在设置里填「code.mirror.repos」，或设环境变量 FLOWERS_MIRROR_REPOS… |
| repos 不是 JSON / 不是数组 / 空数组 | `bad_config` | `设置项 code.mirror.repos` 不是合法的 JSON（…） |
| 某项缺 id / 缺 path / path 不是绝对路径 / id 重名 | `bad_config` | …第 2 项（123pan-pc）缺 path |
| transport 不是 local/ssh | `bad_config` | `环境变量 FLOWERS_MIRROR_TRANSPORT` 只能是 local 或 ssh（现在是「ftp」） |
| 库连不上 | `bad_config` | 读不到设置「code.mirror.repos」：数据库错误（…）——**不**当成「没配」 |

`resolveMirrorConfig(database?)` 的 `database` 可注入：用例里用一个空库句柄就能钉住
「缺 repos」那句话，不需要真的 postgres。

## 2. 命令形状：argv，永远没有 shell

```ts
// local
git --git-dir=<REPO_PATH> <sub> <args…>

// ssh
ssh -o BatchMode=yes -o ConnectTimeout=10 <HOST> git --git-dir=<REPO_PATH> <sub> <args…>
```

`gitArgv()` 造数组、`execFile(bin, argv.slice(1))` 执行。为什么不走 shell：路径、
搜索词里有中文、引号、`$()`；argv 里没有 shell，`$()` 就是四个字符（与
`uemaster/flow.ts` 同一条理由）。

`BatchMode=yes` 是必须的：没有它，密钥不对时 ssh 会**停在密码提示**上，20 秒后被
我们杀掉，人看到的是一句「超时」——真正的原因（密钥没配）反而被藏了。

四个读口的实际命令：

```bash
git --git-dir=<repo> log -1 --format=%H%x1f%cI%x1f%s HEAD
git --git-dir=<repo> ls-tree -r --name-only -z HEAD [-- <prefix>]
git --git-dir=<repo> grep -n -I -F --no-color -e <pattern> HEAD [-- <paths…>]
git --git-dir=<repo> cat-file -s HEAD:<path>          # 先问大小
git --git-dir=<repo> show HEAD:<path>                 # 再读正文（缓冲 = maxBytes+64K）
```

几个细节：

- `ls-tree -z`：路径里可以有空格和中文，按行切会在这种仓里读歪。
- `grep -F`：走查搜的是业务词/接口名，字面量才是它要的语义；正则会让中文串里的
  `(` `?` 偶发报错。`-I` 跳过二进制，`--no-color` 让输出可解析。
- `grep` 的退出码 1 是「没命中」，不是失败：`read()` 用 `allowExit:[1]` 放行。
- 输出形如 `HEAD:<path>:<line>:<text>`；路径本身可能带冒号，所以用
  `^HEAD:(.+?):(\d+):(.*)$` 从数字那一段锚定切分。
- 超时 20 秒（`GIT_TIMEOUT_MS`），kill 用 SIGTERM；超时的话术里带了秒数。
- 失败一律 `{ ok:false, code, message }`，message 是中文 + **stderr 的尾巴**：
  `git 读取失败（退出码 128）：fatal: path 'x' does not exist in 'HEAD'`。
  ssh 连不上时那句 `ssh: Could not resolve hostname …` 原样跟着回来。

## 3. 「只读」是构造出来的，不是靠自觉

所有命令都要过 `isReadOnlyGitArgs(args)`：

- 子命令白名单：`ls-tree / log / grep / show / cat-file / rev-parse / for-each-ref / symbolic-ref`；
- 任何位置出现 `--output`、`update-ref`、`update-index`、`write-tree`、`checkout`、
  `commit-tree`、`hash-object`、`gc`、`prune`、`repack`、`push`、`fetch`、`clone`、
  `worktree`、`stash`、`reset`、`clean`、`filter-branch` 都拒；
- 拒绝时返回 `not_read_only`（这是本模块的 bug，不是用户输入的问题），不抛。

用例钉住了这两条：`['show','--output=/tmp/x','HEAD:a']` → false；
`['update-ref', …]` / `['checkout','master']` / `['reset','--hard']` → false；
而 `gitArgv()` 造出来的本地/远端两种 argv 都通过。

## 4. 噪音过滤：每条排除都有实据

`isNoisePath(p)` 对 `lsTree` 与 `grep` 的结果生效（`show` 不滤——那是调用方点名要读
的文件）。规则与理由：

| 规则 | 为什么 |
| --- | --- |
| 目录段 `dist/ build/ out/` | 三个仓都把打包产物提交进去了：`123pan-pc` 的 `web-file/frontend/dist/web.asar` 就是一条 2.4M 的黑箱。`grep 分享链接` 在它上面命中，会顶掉真正有用的源码命中。 |
| 目录段 `node_modules/` | 就算被提交（有的老仓真这么干），它不是这个项目的代码。 |
| 目录段 `coverage/ .next/ .nuxt/` | 与 dist 同类：生成物，且往往上千个文件。 |
| `*.asar` | Electron 包体，二进制；命中它等于命中一份压缩过的私有副本。 |
| `*.min.js` / `*.min.css` / `*.map` | 压缩产物与源映射。映射里的 `sourcesContent` 会让「这里有没有这个字符串」永远为真。 |
| 锁文件（`package-lock.json`、`yarn.lock`、`pnpm-lock.yaml`、`bun.lockb`、`go.sum`…） | 几万行依赖坐标，检索时噪声占比最高，没有一个字是业务代码。 |
| 图片 / 字体 / 音视频（png jpg gif webp ico woff ttf mp4…） | `git grep -I` 会跳过二进制，但 `lsTree` 会把它们全列出来；阶段一的「页面结构」里出现一堆 `.png` 只会误导。 |
| 二进制 / 归档（exe dll so dylib wasm class jar zip tar gz pdf sqlite…） | 同上，且它们的内容对走查没有语义。 |

两条边界：

- 目录判定**只看非最后一段**：`build/` 是目录，`scripts/build.js` 是源码（用例钉住）。
- 大小写不敏感：`Dist/` 与 `dist/` 一样。

真实效果（`dogyun` 上的 `123pan-pc`，HEAD `afff7295`）：`ls-tree` 原始 817 条 →
过滤后 **575 条**。

## 5. 截断：先问大小，再读前缀

`show(repoId, path, { maxBytes = 200_000 })`：

1. `cat-file -s` 问原始大小（顺便验证路径存在——「文件不存在」与「git 坏了」是两件事）；
2. 用 `maxBytes + 64K` 的缓冲读正文；文件更大时 Node 会杀掉子进程并把已收到的
   部分交回来，那正好是我们要的前缀；
3. 切的时候**退到 UTF-8 字符边界**（`truncateUtf8`），否则中文会被切成 `�`，
   而模型会把那个符号当成源码去抄；
4. 追加一句标记，调用方决定要不要转述给模型：

```
…（已截断：只显示前 400 字节，全文 656 字节）
```

## 6. `repoShape()`：阶段一要的形状

```ts
repoShape(repoId) => {
  pages, api, components, totalFiles,
  caps:      { pages: 120, api: 80, components: 200 },
  truncated: { pages: bool, api: bool, components: bool },
}
```

分类是路径模式（宽一点没关系，漏一条路由才致命），**页面优先**：

- page：`src/router/`、`routers/`、`pages/`、`views/`、`screens/`、`app/**/page.tsx`、
  uni-app 的 `pages.json`；
- api：`api/`、`apis/`、`services/`、`http/`、`request|http|axios|fetch.{ts,js}`、
  `*.api.ts` / `*.service.ts`；
- component：`components/`、`widgets/`、`*.component.tsx`，以及兜底的 `.tsx/.jsx/.vue`。

两条修正来自真实跑：

1. **只有代码才进这三张表**（`CODE_EXT`：ts tsx js jsx mjs cjs vue json）。第一次
   实跑 `123pan-pc` 给出 25 个「页面」，一大半是 `src/pages/**/index.less`——
   模型要的是「这一页在哪」，不是样式文件叫什么。
2. 上限按树序截断，并回 `truncated`：`true` 表示「这是前 N 个」，不是「一共就这些」；
   `shapeSummary()` 会把它写成人话（`575 个源码文件、15 个页面、40 个接口文件、75 个组件`）。

实跑三个镜像（ssh，HEAD 见括号）：

| 仓库 | 源码文件 | pages | api | components |
| --- | --- | --- | --- | --- |
| `123pan-pc`（`afff7295`） | 575 | 15 | 40 | 75 |
| `123pan-uni-app`（`5eaa03cd`） | 638 | 28 | 17 | 83 |
| `123pan-cross-frontend`（`aefda585`） | 129 | 8 | 7 | 24 |

## 7. 夹具

`tests/codemirror.test.ts` 在临时目录里**当场造一个真 bare 仓**（不是 mock 的 git 输出）：

```
work/                                bare/fixture.git（HEAD → refs/heads/master）
  src/router/router.js               页面（React 路由表）
  pages/Home/Home.tsx                页面，含「分享链接」
  pages/P001…P132/*.tsx              132 个页面（为撞 120 的上限）
  api/user.ts                        接口
  src/i18n/zh.ts                     源码里的中文串
  components/Button.tsx              组件
  dist/bundle.js                     噪音
  node_modules/x/index.js            噪音
  web-file/frontend/dist/web.asar    噪音（内容里有同一句中文）
  public/logo.png                    噪音
  yarn.lock                          噪音
```

`git init` → `git add -A` → `commit` → `git init --bare` → `symbolic-ref HEAD
refs/heads/master` → `push HEAD:refs/heads/master`。测的是真实的 `execFile`、真实的
退出码、真实的 `git grep` 输出格式与真实的 UTF-8 截断。

配置全部走环境变量（`FLOWERS_MIRROR_*`），所以用例**一张表都不读**；唯一直接调
`resolveMirrorConfig()` 的两条注入一个空库句柄。ssh 那条指向
`flowers-test.invalid`（.invalid 保证 NXDOMAIN，快速失败）。

## 8. 用例与真实输出

`npx vitest run tests/codemirror.test.ts --reporter=verbose`：

```
✓ isNoisePath：三个仓里真实存在的形状 > 构建产物、依赖目录、二进制、锁文件都算噪音
✓ isNoisePath：三个仓里真实存在的形状 > 源码不算噪音（build.js 是文件不是目录）
✓ lsTree > 列出源码，一个噪音路径都不带
✓ lsTree > prefix 只回一个子树
✓ grep > 找得到源码里的中文，且 .asar 里的同一句不会回来
✓ grep > paths 收窄范围；没命中是空数组，不是失败
✓ grep > max 截断结果（预算不会被噪音吃掉）
✓ show > 返回文件原文
✓ show > 不存在的路径是中文的类型化失败，不是异常
✓ show > 绝对路径与 .. 在到达 git 之前就被拒
✓ show > maxBytes 之后截断并写明（中文不被切成替换符）
✓ truncateUtf8 > 切在汉字中间时退到字符边界
✓ head > 给出那个提交的 sha / 时间 / 标题
✓ repoShape > 分类正确，且上限与截断标志一致
✓ repoShape > classifyPath 认三种布局（React / uni-app / 通用）
✓ 配置与失败 > 未知仓库 id
✓ 配置与失败 > 坏 transport 点名是哪一格
✓ 配置与失败 > 设置里的坏 transport 点名 code.mirror.transport
✓ 配置与失败 > 缺 repos 时说清该填哪个键、哪个环境变量
✓ 配置与失败 > repos 配置坏了整份作废（不拼半份）
✓ 配置与失败 > 连不上的 ssh 是一句中文失败，不是异常
✓ argv 与只读白名单 > 本地与远端都是 argv 数组，没有 shell
✓ argv 与只读白名单 > 写命令与 --output 一律拒绝
✓ argv 与只读白名单 > 本模块真的只有那四个读口
Tests  24 passed | 1 skipped (25)
```

几个断言的实际形状：

- `lsTree('fixture')` 137 条（132 个页面 + 5 个其它源码），`dist/bundle.js`、
  `node_modules/x/index.js`、`web-file/frontend/dist/web.asar`、`public/logo.png`、
  `yarn.lock` 一个都不在。
- `grep('fixture','分享链接')` 命中 `src/i18n/zh.ts:1` 与 `pages/Home/Home.tsx:2`；
  同一句话在 `.asar` 里也有，但结果里没有它。
- `show('fixture','src/i18n/zh.ts',{maxBytes:16})`：比全文短、含「已截断」「16 字节」、
  不含 `\ufffd`。
- `show('fixture','src/nope.ts')` → `{ code:'git_failed', message:'仓库里没有这个文件：src/nope.ts（HEAD）' }`。
- `head` 的 sha 与 `git rev-parse HEAD` 一致，subject 是 `fixture: 走查用的最小仓`。
- 坏 transport（env）→ 消息里是 `FLOWERS_MIRROR_TRANSPORT`；坏 transport（设置）→
  `code.mirror.transport`。
- ssh 到 `flowers-test.invalid`：约 1.1 秒返回 `git_failed`，消息里带 `ssh`。

全量：`npx vitest run` → **20 files / 510 passed | 1 skipped**（486 + 新增 24）。
`npx tsc --noEmit` 无输出。

### live smoke（默认跳过）

```ts
describe.skipIf(LIVE_HOST === undefined || LIVE_HOST === '')
```

只有人显式 `FLOWERS_MIRROR_SSH_HOST=dogyun npx vitest run tests/codemirror.test.ts`
才会 ssh 到 47.115.229.192；CI 没有这条变量，永远不碰 owner 的机器。人工跑过一次：

```
live head: afff7295beaa2c0006b6355db3f9bec4b9c9d349 Merge #236 into master from release-revert-professional-space
live grep 命中:
live shape: 575 files; 25 pages
✓ live smoke：真实 dogyun 镜像 > 能读到 123pan-pc 的 HEAD、路由文件与一次中文 grep
```

`live grep 命中:` 是空的是**正确答案**：`分享链接` 在这个仓里只出现在
`web-file/frontend/dist/web.asar` 里（构建产物），噪音过滤把它丢掉了——这正是
过滤要解决的问题。「25 pages」是 `.less` 修正之前的数，修正后是 15。

## 9. 仍粗糙的地方

1. **返回值形状与计划里的签名不同。** 计划写的是 `lsTree(): Promise<string[]>` 等，
   同时又要求「非零退出 → 类型化失败，不抛」。两者不能同时成立，所以四个读口都
   返回 `MirrorResult<T> = { ok:true, data } | { ok:false, code, message }`。
   `data` 的载荷与计划里的成功类型一致。下一阶段的调用方要写 `if (!r.ok)`。
2. **ssh 的参数会被远端 shell 再解释一次。** ssh 把 argv 从第二个参数起用空格拼成
   一条远程命令，所以带空格的 grep pattern 在远端可能被拆成两个词（不会变成一条
   新命令，因为 `-e` 后面跟的是参数位）。彻底消除这层要换成
   `ssh <host> -- git …` 的协议式调用或自定义 `GIT_SSH_COMMAND`；当前 pattern 来自
   走查自己的中文短句，先不做。
3. **`pages/**` 里的组件也被算成 page。** `123pan-pc` 的 `src/pages/Login/components/*`
   进了 pages 表（页面优先）。这在「找这一页在哪」的任务里不算错，但如果阶段一要
   严格的路由表，应该改成读 `src/router/router.js` 的 AST。当前是路径模式，不做 AST。
4. **上限截断按树序、不按重要性。** 撞上上限时丢掉的可能是排在后面但更重要的目录
   （例如 `src/router/router.js` 在夹具里就被 120 条上限挤掉了）。`truncated` 已经
   如实上报；要不要改成「按目录分组 + 每组取前 N」留给阶段一决定。
5. **`grep` 的 `max` 没有配套的 `truncated` 标志。** 结果数组被截到 max 时调用方
   分不出「就这么多」与「还有」。约定是「拿到 max 条就等于被截断」，但没写进类型。
6. **每次调用都重读配置。** 一次走查要跑十几次读，会有十几次 `app_settings` 主键读
   （env 覆盖时零次）。主键读很便宜，先不加缓存；等阶段一把这些调用串成一条流程
   再决定要不要一次解析、传下去。
7. **`head()` 的空仓判定靠 stderr 的英文。** `does not have any commits` / `bad revision`
   是 git 的文案，换语言或换版本可能失配——失配的后果是「空仓」变成一条失败消息，
   不影响正确性。
8. **`show` 是两步（cat-file + show）。** 大文件会多一次 RTT（ssh 下约 20–40ms）。
   换成一次 `cat-file --batch` 能省掉，但会引入一个长连接状态机，暂不做。

## 10. 复现

```bash
npx tsc --noEmit
npx vitest run tests/codemirror.test.ts
npx vitest run
# 人工 smoke（会 ssh 到 owner 的机器）
FLOWERS_MIRROR_SSH_HOST=dogyun npx vitest run tests/codemirror.test.ts

# 跑完 vitest 之后（本轮已做）
npm run seed -- --reset
# provider.* 三行先备份、跑完写回（api key 不打印）
```

本轮跑完全量测试后已执行 `npm run seed -- --reset`，并把 `provider.baseUrl /
provider.apiKey / provider.model` 三行写回（apiKey 与备份的 sha256 一致）。
