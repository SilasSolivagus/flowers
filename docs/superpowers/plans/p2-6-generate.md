# P2.6 · 参考段的「生成」：Flowers 自己跑 UEmaster

owner 的原话：「我要的是拿这个需求里已经填写好的信息作为输入，通过 UEmaster 这个能力，
出来的 html，而且可以直接点击看到的」。

所以「复制任务包」从主路上去掉了：任务包还在（`src/core/uemaster/packs.ts` 一字未改），
但它不再是给人复制的文本，而是**喂给生成器的输入**。抽屉的「参考」段三行各一个「生成」，
按下之后由服务端跑本机装着的 agent CLI，产物落到 `data/uemaster/<PAN-n>/<stage>.html`，
那一行变成链接，点开就是材料。

本次提交：`56d53b4`。

`src/core` 的六个领域服务（create / evaluate / review / schedule / bounce / terminal）
一行没动。改动落在 `src/core/uemaster/*`、`src/core/read/detail.ts`、`app/*`、
`src/db/*`、`scripts/gen-worker.ts`、`tests/*`。

---

## 1. 生成器契约

`src/core/uemaster/generator.ts` 只有两个导出（外加一个常量表）：

```ts
export type GenResult = { ok: true; url: string } | { ok: false; error: string };
export async function runGenerator(pack: string, opts: { cwd: string; timeoutMs: number }): Promise<GenResult>
```

一条规矩：**命令从 stdin 拿整段任务包，自己把 HTML 写到包里指定的路径**。这正是
`claude -p` / `codex exec` 的形状——让 agent 用写文件工具落盘，而不是把几 MB 的 HTML
从 stdout 里捞出来。stdout / stderr 都被收集（各留最后 8 KB），退出码 0 = 成功、非 0
或超时 = 失败。

成功时返回的 `url` **不是模型给的**，是从任务包本身读出来的：

```ts
const SITE_PATH = /\/uemaster\/PAN-\d+\/(?:evaluate|review|inspect)\.html/;
```

包在「交付」那一段写死了 `data/uemaster/<PAN-n>/<stage>.html` 与站内路径
`/uemaster/<PAN-n>/<stage>.html`，生成器与 worker 用同一个正则取它；包怎么写，文件就
该在哪，两边不靠第二份约定。

### 1.1 两条默认命令（以及为什么是这些 flag）

`FLOWERS_GEN_CMD` 非空时用它；否则按 `claude` → `codex` 的顺序在 `PATH` 里探测。

| CLI | 默认命令 | 为什么 |
| --- | --- | --- |
| claude | `claude -p --permission-mode acceptEdits` | `-p` = print 模式、非交互，prompt 从 stdin 读；`acceptEdits` 让它在工作目录里直接写文件，不再逐次问权限（否则后台生成会停在确认上直到超时） |
| codex | `codex exec --sandbox workspace-write --skip-git-repo-check -` | `-` = 从 stdin 读 prompt；`workspace-write` 才允许它写产物（`read-only` 写不了）；`--skip-git-repo-check` 是因为部署副本不一定有 `.git` |

**为什么 `claude` 用 `acceptEdits` 而不是 `--dangerously-skip-permissions`**：这条命令
只会收到一段固定的任务包（`packFor` 的输出：人写的模板 + 这条需求的字段），它要做的事
就是画图、写一个 HTML 到 `data/uemaster/`。`acceptEdits` 恰好把「写 / 改文件」这一格
放开，仍不给任意 bash 的免确认执行；skip-permissions 会把 bash、hook、网络工具一起
放开，对一件事来说太宽。真正的落盘动作是 Write/Edit 工具，不是 bash，所以够用。

两条命令都是 2026-11 的 `claude --help` / `codex exec --help` 对出来的；CLI 升级后
flag 可能变，那时改的就是这张表（`DEFAULT_COMMANDS`）。

### 1.2 失败原因：stderr 的尾巴，不是「生成失败」

非 0 退出时 `error` = stderr 尾巴（去 ANSI），stderr 为空才退到 stdout，再退到退出码。
超时是唯一一条自己写的原因：`生成超时（600 秒）——命令没有在时限内结束，已终止`。

本机环境里每条 `node` 进程都会先打一行 `(node:123) [UNDICI-EHPA] Warning: …` 加一行
`(Use \`node --trace-warnings\` …)`。它会把「OAuth session expired」挤到第二行，所以
`reasonOf()` 只过滤这个形状的两行（不按 `Warning` 泛指过滤——CLI 自己的警告可能是
原因的一部分）。过滤前后各跑过一次失败 stub：

```
过滤前： (node:54544) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental…
         (Use `node --trace-warnings ...` …)Failed to authenticate: OAuth session expired and could not be refreshed
过滤后： Failed to authenticate: OAuth session expired and could not be refreshed
```

---

## 2. 作业生命周期

### 2.1 表（迁移 `0003_uemaster_jobs.sql`）

```sql
create table uemaster_jobs (
  id uuid primary key default gen_random_uuid(),
  requirement_id uuid not null references requirements(id),
  stage text not null check (stage in ('evaluate','review','inspect')),
  status text not null check (status in ('running','done','failed')),
  error text,
  artifact_id uuid references uemaster_artifacts(id),
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create unique index uemaster_jobs_running_unique
  on uemaster_jobs (requirement_id, stage) where status = 'running';
create index uemaster_jobs_req on uemaster_jobs (requirement_id, stage, created_at desc);
```

`where status = 'running'` 的部分唯一索引是**并发兜底**：服务层的「正在生成中」是给用户
的一句中文，库这条索引保证绕过服务层的写入也同时只有一个 running。

### 2.2 起点：`startGeneration(db, actor, raw)`

1. `requirePlainObject` → `parseRequirementId` → `parseStage`（与 attach 同一套中文错误）。
2. 事务里 `select id from requirements where id = … for update`：需求不存在 → `not_found`
   「需求不存在」。锁需求行是为了让两个标签页同时点「生成」时的顺序确定。
3. 同一个 `(requirement, stage)` 已有 running：
   - 年龄 < 11 分钟 → `generation_running`：「这个阶段正在生成中，等这次结束再试」；
   - 更老 → 当成死进程留下的，`update … set status='failed', error='生成超时：后台进程没有回报'`
     然后放行（否则一条僵死的行会把那个阶段永久锁住）。
4. `insert … running returning id`，提交。
5. `spawn(process.execPath, [node_modules/tsx/dist/cli.mjs, scripts/gen-worker.ts, jobId, actor],
   { cwd: 仓库根, detached: true, stdio: 'ignore', env: process.env }).unref()`。
   worker 活过这次请求；`tsx` 找不到时作业收成 failed 并抛中文 `generator_unavailable`。

### 2.3 执行体：`runJob(db, jobId, opts)`

`scripts/gen-worker.ts` 只做三件事：取 `jobId` / `actor`、调 `runJob`、`pool.end()`。
真正的逻辑在 `src/core/uemaster/start.ts` 里，所以它能被用例直接跑（不必起 detached 进程）：

1. 读 job + requirement；不是 running 就直接返回（可重入）。
2. 没有 PRD 的 review / inspect：**在这里就停**，`缺少 PRD 链接，无法生成评审材料`——
   不把那段「停止：到此停止…」的包交给 agent 白烧一次调用。
3. `packFor(stage, …)` → `artifactUrlIn(pack)` → `artifactFile(url)` → 记 mtime 快照。
4. `runGenerator(pack, { cwd: 仓库根, timeoutMs })`（默认 10 分钟，测试可传小值）。
5. 失败：`update status='failed', error=<stderr 尾巴>, finished_at=now()`。
6. 成功：验文件——**不存在** → `生成命令已结束，但产物文件不存在：data/uemaster/…`；
   **mtime 没变**（上一版文件还在、这次没重写）→ `生成命令已结束，但产物文件没有更新：…`。
   两条都收成 failed，不把旧材料当新结果。
7. `attachArtifact(db, actor, { requirementId, stage, url })`：校验 + 落库 + 记
   `uemaster.attached` 事件；`evaluate` 落在 inbox 需求上照旧推进到待设计（R-P2-8 那条
   语义透过生成这条路照样成立）。成功则 `update status='done', artifact_id=…`。
8. 任何异常都被这一层接住写成 failed；UPDATE 都带 `status = 'running'` 条件，先到的
   那个写入说了算。

`jobStatus(db, jobId)` 返回 `{ id, stage, status, error, url, createdAt, finishedAt }`；
非 uuid / 查不到返回 null（与读模型对「不存在的需求」同一条口径）。

### 2.4 两种「没人回报」的情况

| 情况 | 收口者 | 结果 |
| --- | --- | --- |
| 命令卡住 | worker 里的硬超时（默认 10 分钟） | 杀进程组，job failed，原因写明超时 |
| worker 进程被 kill / 机器重启 | 下一次 `startGeneration`（>11 分钟） | 旧行 failed，放行新的一次 |

界面自己还有一个 11 分钟的客户端上限：到点停止轮询，行里显示「生成失败：生成没有回报
（后台进程可能已退出）」。它不写库，只是一个诚实的停手。

---

## 3. 界面

- **三行各一个「生成」**（`.row3[data-stage]`）。按下 → `generateAction` 返回 `jobId`
  → 这一行变「生成中」→ 轮询 `generationStatusAction(jobId)`（1.5 s）→ 成功
  `router.refresh()`，这一行变成 `/uemaster/PAN-n/stage.html` + 日期；失败就在行里
  显示「生成失败：<原因>」，按钮变「重试」。
- **刷新之后「生成中」还在**：读模型多查一次 `uemaster_jobs` 里 running 的行，放进
  `DetailRef.generation`，所以刷新页面、换个人打开同一条需求，看到的都是「生成中」，
  而不是一个可以再按一次、按了只撞「正在生成中」的按钮。
- **失败不持久化**：它是行内一次性的提示，刷新后那一行回到「生成」。失败原因在库里
  （`uemaster_jobs.error`），但抽屉不再展示历史失败——那会让一条需求看起来永远坏着，
  也没有重试的入口。
- **「复制任务包」删除**：`app/components/CopyPack.tsx` 整个删掉，`DetailRef.pack` 与
  服务端算三份包的代码一起从读模型移除（任务包只在 worker 里算）。`uemaster_plan`
  这个 MCP 工具不动——agent 走 MCP 时仍然拿得到包。
- 「交回材料」保留：主路是生成，但材料也可能是在别处做完的，那条人走的路仍然需要入口。
- 行内没有一句解释性文案：只有「生成」「生成中」「重试」「交回材料」和「生成失败：…」。

---

## 4. 验证

真 CLI 在本机登不进去，所以管线用 `tests/stubs/*.mjs` 证明；它们与真 CLI 吃同一个输入
（stdin 上的完整任务包）、按同一个约定落盘（包自己写的路径）。

### 4.1 成功：stub 写文件，作业 running → done，产物 attach，页面变链接

启动：`FLOWERS_GEN_CMD='"<node>" "<repo>/tests/stubs/gen-ok.mjs"' npm run dev`，
在 PAN-7 的「评估材料」行点「生成」。

作业行（点完约 2 秒）：

```
                  id                  |  stage   | status | error | has_artifact
--------------------------------------+----------+--------+-------+--------------
 c4598987-df30-430f-ac46-f90dfba147aa | evaluate | done   |       | t
```

产物与作业的关联：

```
c0245c43-9098-4bab-aa69-af0f84dbd65b | dfc0dea2-… | evaluate | /uemaster/PAN-7/evaluate.html | 吕品
  | c4598987-… | done | c0245c43-9098-4bab-aa69-af0f84dbd65b
```

抽屉「参考」段（浏览器里的实际文本）：

```
参考
评估材料
/uemaster/PAN-7/evaluate.html
11-06
生成
交回材料
评审材料
生成
交回材料
走查材料
生成
交回材料
…

记录
11-06  吕品 提交评估材料 · /uemaster/PAN-7/evaluate.html
```

点开链接（`curl -D -` 的头与正文）：

```
HTTP/1.1 200 OK
content-security-policy: sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:
content-type: text/html; charset=utf-8
x-content-type-options: nosniff

<!doctype html>
<meta charset="utf-8">
<title>stub 产物</title>
<p data-stub="ok">这是测试 stub 写出来的材料，不是模型生成的。</p>
```

### 4.2 失败：stub 用真 CLI 的那句话退出 1，作业 failed，没有产物行

`FLOWERS_GEN_CMD='"<node>" "<repo>/tests/stubs/gen-fail.mjs"' npm run dev`，
在 PAN-7 的「评审材料」行点「生成」：

```
 stage  | status | error
--------+--------+-----------------------------------------------------------------------
 review | failed | Failed to authenticate: OAuth session expired and could not be refreshed
```

抽屉那一行（实际文本）：

```
评审材料
生成失败：Failed to authenticate: OAuth session expired and could not be refreshed
重试
交回材料
```

`select count(*) from uemaster_artifacts` = `0`；`data/uemaster/PAN-7/` 里只有上一次成功
的 `evaluate.html`，没有 `review.html`。需求状态不动（评审材料没有产出，就不该被推进）。

### 4.3 「生成中」是真的、且活过刷新

`FLOWERS_GEN_CMD` 指向永不退出的 `gen-hang.mjs`，点「评估材料」的「生成」：

```
参考
评估材料
生成中
交回材料
```

整页刷新（重新请求 `/?open=<id>`）之后仍然是「生成中」——它来自读模型里的 running 作业，
不是客户端 state。这条同时证明了「卡住的命令有硬超时」：该作业在 10 分钟后会被 worker
收成 failed（`生成超时（600 秒）…`），超时路径由单测钉住（见 4.5）。

### 4.4 真 CLI 的那一次尝试（今天的样子）

不设 `FLOWERS_GEN_CMD`，自动探测到 `claude`，命令是
`claude -p --permission-mode acceptEdits`，在 PAN-7 的「走查材料」行点「生成」：

```
 stage   | status | error
---------+--------+-----------------------------------------------------------------------
 inspect | failed | Failed to authenticate: OAuth session expired and could not be refreshed
```

抽屉那一行：

```
走查材料
生成失败：Failed to authenticate: OAuth session expired and could not be refreshed
重试
交回材料
```

`uemaster_artifacts` 仍然是 0 行。也就是说：**今天这次点击真的把任务包喂给了 claude，
claude 真的因为登录过期拒绝了，界面把这句话原样交给 owner**——没有假装成功，也没有
把它压成「生成失败」。`codex exec` 的环境同样没有 key（refresh token 已用过），
所以没有再去跑一次；默认探测顺序里它在 claude 后面。

### 4.5 单测 / 类型 / 构建

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 类型 | `npx tsc --noEmit` | 0 错 |
| 单测 | `npx vitest run` | 11 文件 / **325** 通过（310 + 新增 15） |
| 构建 | 隔离副本里 `npm run build`（`--webpack`） | 通过；路由表 5 条，含 `/uemaster/[...path]` 为动态 |

`tests/generate.test.ts` 15 条，覆盖：

- 成功：running → done、`artifact_id`、文件存在、`created_by` 是按按钮的人、
  inbox 需求被推进到 design、`jobStatus` 返回 url；
- 失败：stderr 原文进 `error`、无产物行、无文件、状态不动；
- 超时：600 ms 超时 → failed、原因含「生成超时」、无产物；
- 退出 0 但没写文件 → failed（`产物文件不存在`）；
- 旧文件没被重写 → failed（`产物文件没有更新`）；
- 没有 PRD 的评审 → 不调用生成器，直接 `缺少 PRD 链接，无法生成评审材料`；
- 已收口作业再跑一次不改任何东西（可重入）；
- 同一阶段 running 时 `startGeneration` 拒绝（`generation_running`，中文），且不新增作业；
- 不同阶段可以并行（两条作业）；
- 陈旧 running（20 分钟）被收成 failed 后放行新作业；
- 入参校验（stage / 需求 ID / 需求不存在 / 非对象）；
- `jobStatus` 的 null 口径；`artifactUrlIn` 的解析与缺路径；
- 端到端甩真 worker 一条（detached + tsx + stub），几秒后 done 且产物出现。

`tests/read.test.ts` 里两条旧用例（「三行都带任务包正文」「没有 PRD 时的包」）被**改写**
而不是删除：参考段不再携带任务包，改为钉「三行默认没有正在生成的作业」「只有 running
的那一行带 generation」「done / failed 不算生成中」。任务包本身的行为仍由
`tests/uemaster.test.ts` 的 `packFor` 用例覆盖。

---

## 5. owner 要做什么才能让它真的出材料

只需要补上「登录」这一格，什么都不用改代码：

1. **用 claude**：在一个终端里跑一次 `claude`，按提示在浏览器完成登录（或 `claude /login`）；
   也可以 `export ANTHROPIC_API_KEY=…`（`claude -p` 会直接用它）。然后回到抽屉点「生成」。
2. **用 codex**：`codex login`（浏览器），或 `export OPENAI_API_KEY=…`。
3. **换一条命令**：`export FLOWERS_GEN_CMD='<你的命令>'`。约定只有一条：读 stdin 的整段
   任务包，按包里的路径写出 HTML，退出码 0。命令要在**跑 dev server 的那个环境**里设置
   （`npm run dev` 继承它），不是浏览器里。

判断是否生效：点一次「生成」，行里从「生成中」变成 `/uemaster/…` 链接就是通了；还是
「生成失败：…」时，那句话就是生成器给的原话，照着修即可。

---

## 6. 还粗糙的地方

- **失败提示刷新即消失**：它在行内，是客户端 state；刷新后回到「生成」。作业行与
  `error` 都还在库里（可查），但抽屉不展示历史失败。要长期可见，需要给作业事件建一条
  时间轴（现在只有成功时的 `uemaster.attached` 会进记录）。
- **没有取消**：一次生成最长占住那个阶段 10 分钟（+1 分钟陈旧窗口）。owner 想中途放弃
  只能等，或直接杀 `gen-worker` 进程（下一次「生成」会在 11 分钟后回收）。
- **同一需求的不同阶段可以并行**：两个 CLI 会被同时拉起。产品上也许该串行化（一次只跑
  一个），现在没有做。
- **产物路径固定、重做会覆盖**：`data/uemaster/<PAN-n>/<stage>.html` 是任务包写死的，
  重做后旧 artifact 行仍指向同一个 URL，内容已经变了；历史版本实际没有留存。这是 P2
  就有的形状，生成让它变成常态。
- **没有进度**：只有「生成中」，没有百分比/日志。真 CLI 的中间输出被吞掉（`stdio` 收在
  worker 里），失败时才取尾巴。
- **默认命令依赖 CLI 版本**：`claude` / `codex` 的 flag 是 2026-11 对出来的；升级后如果
  flag 变了，`DEFAULT_COMMANDS` 要跟着改。`FLOWERS_GEN_CMD` 是绕开它的口子。
- **worker 用 `tsx` 跑 `.ts`**：没有「worker 单独构建」这一步；`node_modules/tsx` 不在时
  生成直接失败并说明原因（`后台执行器不可用：找不到 node_modules/tsx`）。生产部署要
  保证 devDependencies 也在（或改为预编译 worker）。
