# P2.12 · 每人一把 key，配的时候能测

> owner 的两句话：「自己配自己的 llm key 简单的多」与「配 key 的时候给测试一下」。
> 这一版把 `provider.baseUrl / apiKey / model` 从**一个部署一份**变成**每个人可以有自己的
> 一份**，并在设置页「我的」里给出一行能当场测试的入口。

---

## 1. 解析顺序

```
env（FLOWERS_PROVIDER_BASE_URL / _API_KEY / _MODEL）
  → 当前成员自己的三格（member.<members.id>.provider.*）
  → 平台的三格（app_settings 的 provider.*）
  → null
```

- **每一层都要求三格齐全，缺一格整层作废**，绝不与下一层拼成半份。
  这条在 P2.12 之后不只是「口径统一」：成员只填了模型名、key 留空时，若与平台的
  地址 / key 拼起来，发出去的请求会带着**别人的 key**去一个他没填过的地址。
- 「当前成员」= **这次动作的归属人**（`created_by` 写的就是这个字符串），不是全局默认值：
  同一个部署里 A 配了 key、B 没配，A 按生成走 provider，B 按生成走 CLI。
- 成员名不在名册上（cookie 里是个离职的人）→ **静默跳过成员这一层**，退到平台。
- 传入 `actor = undefined`（脚本、worker 兜底、旧用例、以及「平台配置」那半页）→ 成员这一层
  不存在，只看 env 与平台三格。

实现：`resolveProvider(actor?)` → `{config, scope}`（`scope` 是 `'env' | 'member' | 'platform'`）；
`resolveProviderConfig(actor?)` 是只要配置的那一半，其余调用方不变。

被 thread 到的地方：`resolveStrategy(actor?)` → `startGeneration`（按请求里那个人）→
`runJob`（按 `opts.actor`，worker 是另一个进程，不能信请求那一刻的结论）→
`composeEvaluation(db, actor, req, { resolveConfig: () => resolveProviderConfig(actor) })`
（`compose.ts` 没改一行：它本来就收 `deps: Partial<ComposeDeps>`）→ `generatorView(db, actor?)`
→ `app/page.tsx`、`app/settings/page.tsx`。

## 2. 存储键

复用 `app_settings`（键值表），不建新表、不要迁移：

| 键 | 内容 |
| --- | --- |
| `member.<members.id>.provider.baseUrl` | 接口地址 |
| `member.<members.id>.provider.apiKey` | key |
| `member.<members.id>.provider.model` | 模型名 |

- 键名**只在一处拼**：`memberProviderKey(memberId, field)`（`src/core/uemaster/member-provider.ts`）。
- 读写口是**带类型的一对**：`memberProviderSettings(db, memberId)` / `saveMemberProviderSettings(db, memberId, cfg)`
  （另有 `memberProviderParts()` 给「三格不齐也要预填表单」用）。
- SQL 原语仍只有 `settings.ts` 一处：它导出了 `readSetting` / `writeSetting` / `settingCell`，
  `member-provider.ts` 只负责键名与语义，不再抄一遍 `insert … on conflict`。
- **为什么用 `members.id` 而不是名字**：身份入口（cookie）给的是**名字**，是自由文本，可以有
  `.`、空格、标点；而键的形状是 `member.<id>.provider.*`，一个带点的名字会让这个键有两种读法。
  名字 → id 只查一次（`memberIdByName()`，`src/core/read/member.ts`）。
- 空串等于**没设**（与 `generator.command` 同一条口径）；保存时去首尾空白，超长
  （地址 500 / key 400 / 模型 200）当场拒绝。

## 3. 「我的模型 key」那一行的状态

| 状态 | 行上的值 | 附带 |
| --- | --- | --- |
| 都没有 | `未配置` | 无 |
| 退到平台 | `平台统一模型 · <模型>` | 无 |
| 部署级 env | `环境变量 · <模型>` | 无 |
| 自己的 key | `<模型>` | `已配置 · <末 4 位>` |

- 同一套判据在「项目」栏那格 `生成器` 上也用了（`ProviderView` 多了 `scope`）：
  配了自己 key 的人在那里看到的是 `我的模型 · gpt-5.4-mini`，不再被「平台统一模型」这四个字骗到。
- 三个按钮/控件：`测试`、`改`（打开后变 `取消`）。表单三行：`接口地址`（占位
  `https://api.openai.com/v1`）、`模型`、`key`（`type=password`），外加 `保存` / `取消`。
  没有解释段落、没有开关、没有 toast。

## 4. 「测试」的语义（明确定义）

**测的是「屏上这一份」；通过即存，失败什么都不改。**

| 场景 | 测哪一份 | 失败 | 通过 |
| --- | --- | --- | --- |
| 表单开着 | 表单里那三格（key 空着 = 沿用已存的那把，改模型不必重打 key） | 什么都不写，原文进那一行 | 落库 + 收起表单 + 刷新 |
| 表单关着、自己有配置 | 他自己存的那一份 | 原文进那一行 | 只报结果（本来就已经存着） |
| 他自己一格都没有 | 平台 / env 那一份 | 原文进那一行 | 只报结果（**不把平台的 key 抄成自己的**） |

- 为什么「通过即存」：这是抽屉里「测试并使用」（`applyGeneratorAction`）的同一条既有规矩。
  于是 owner 要的两个动作各自成立——填一个错的 key 按测试，**行不会变成「已配置」**；
  填一个能用的按测试，通过、存下，刷新后那一行就是自己的模型。`保存` 仍然存在，
  给「我就是要先存下来再慢慢调」的人。
- 一次小测 = 一次 `POST {baseUrl}/chat/completions`，提示词 `只回四个字：接口可用`，
  `max_tokens: 16`。**15 秒超时**（`PROBE_TIMEOUT_MS`）。真机第一次 1848ms、第二次 9638ms——
  10 秒的那一版会把第二次直接判成超时，用户的结论会是「key 坏了」，而它其实只是慢。
- 那一行的字：`通过 · 412ms · 21 tokens`（服务端没给 `usage` 时是 `通过 · 412ms`），
  失败就是**服务端原文**（已脱敏）：真机上是 `Invalid token (request id: 2026…)`。
- 不抛：`complete()` 从不抛，`probeProvider()` 只加耗时与 token 数。配置缺项也只是
  `接口地址是空的` / `API Key 是空的` / `模型名是空的` 这三句之一。

## 5. 不泄露 key —— 两道闸 + 一条用例

1. **类型闸**：`MemberKeyView`（客户端可见的那份视图）上没有 `apiKey` 字段，只有 `keyTail`。
   `ProviderView` 同样没有。key 的每一处出现只可能在 `ProviderConfig`（进 `Authorization` 头）
   与库里。
2. **文本闸**：`complete()` 的错误文本先过 `redactSecret()`（字面替换，不是正则），
   所以「服务端把 Authorization 回显在 error.message 里」那种情况到界面时已经是 `***`。
3. **用例闸**（`tests/member-provider.test.tsx`）：
   - 把那一行真的渲染成 HTML（`renderToStaticMarkup`），对 key 取**所有长度 ≥ 5 的子串**，
     逐个断言不出现在 HTML 里（只放过末 4 位本身）——整串搜索抓不到「被截断 / 被拆进两个
     span」这类漏法；
   - 视图对象 `JSON.stringify` 里没有 key、没有 `apiKey` 这个键名；
   - 401 的用例里，服务端回显的 key 到 `probeProvider().label` 时已是 `***`，而那句话的
     其余部分（`Incorrect API key provided`、`https://…/keys`）**原样保留**——脱敏不该把线索删掉。

## 6. 用例（`tests/member-provider.test.tsx`，22 条）

- 键名形状；成员赢过平台；**只填一格 → 整层作废、退到平台**（并断言地址是平台的）；
  一格没填 → 平台；两层都没有 → null；名册里没这个人 → 平台；env 排在成员之前。
- `resolveStrategy` 按人：只给吕品配 key 时，吕品 provider / 房超 CLI / 无 actor CLI；
  平台补上之后所有人都是 provider，但各用自己的那一份。
- 空串清掉一份；去空白；超长拒绝且不写坏已有的一格。
- 四种行文案；`keyTail` 只给够长的 key（< 8 位一个字符都不露）；`configOf` 的「缺一格就 null」。
- 渲染那一行：自己的（含片段搜索）/ 平台 / 未配置三种 HTML。
- `probeProvider`：`通过 · \d+ms · 21 tokens`、没有 usage 时不编 0、401 原文（含脱敏）、
  缺项只是一句话、超时常量是 15000。
- 网络一律打到本机的 `http.createServer` 桩（临时端口），一条外部请求都不发。

## 7. 真机验证（`/settings?tab=me`，:3000，--webpack）

| 截图 | 状态 |
| --- | --- |
| `p2-12-member-key-fallback.png` | 吕品没配自己的 key：`平台统一模型 · gpt-5.4-mini` |
| `p2-12-member-key-wrong.png` | 改 → 填一个错的 key → 测试 → 行上 `Invalid token (request id: …)`；行仍是 `平台统一模型 · …`，**没有**变成「已配置」 |
| `p2-12-member-key-pass.png` | 自己的 key 通过：`通过 · 9638ms · 21 tokens`（第一次 1848ms） |
| `p2-12-member-key-reload.png` | 刷新之后：`gpt-5.4-mini` + `已配置 · 3RaC`，key 本身不回显 |
| `p2-12-member-key-project-scope.png` | 「项目」栏那格跟着变成 `我的模型 · gpt-5.4-mini` |

**生成还通不通**（单独一条，隔离库 `flowers_p212`，走服务层 + worker 的真路径）：
平台上**一行都没有**、只给吕品写了自己的三格 →

```
platform rows: 0
strategy 吕品: provider | strategy 房超: cli
runJob 9.9s → status done, url /uemaster/PAN-1/evaluate.html
artifact 28686 bytes, has <svg>: true
state after: design   （inbox → design，与 provider 那条路的既有形状一致）
```

也就是说：**路由按人算，compose 拿到的也是同一个人的那一份配置**（靠 `resolveConfig` 注入，
没有改 `compose.ts` 一行）。用隔离库是因为共享的 `flowers` 当时被另外两个 worker 的
`resetDb()` 反复 truncate（实测 2–12 次/秒），跑不出可信的端到端证据。

## 8. 还粗糙的地方

- **身份仍然是 cookie 里的一个名字，可伪造。** 没有登录之前，改 cookie 就能改「我是谁」，
  于是也就能改「用哪把 key」——这在本机自用是合理的，上线前必须由 SSO 收口。
  这一条写在这里，而不是等以后被人发现。
- **没有「清除我的 key」。** 现在的撤销方式是清掉地址与模型（三格不齐整层作废，退回平台），
  但库里那把 key 还在。要彻底删，得给这一行第三个动作，或者认「换一把新的覆盖」。
- **「通过即存」让 `测试` 不是一个纯只读动作。** 好处是 owner 少按一次；坏处是有人会以为
  测试是「干跑」。失败分支是纯只读的，所以最坏情况只是「留了一份能用的配置」。
- **`compose.ts` 的 `deps.resolveConfig` 是注入点。** 另一个 worker 正在重写那个文件；
  只要 `ComposeDeps` 里还有 `resolveConfig: () => Promise<ProviderConfig | null>`，这条线就不断；
  它若改名/改形，`npx tsc --noEmit` 会在 `start.ts` 那一行报错（不会静默退化）。
- **共享库。** 三个 worker 共用 `flowers`：`tests/provider.test.ts` 的 `beforeEach` 会
  `delete from app_settings where key like 'provider.%'`，任何人跑一轮 vitest 都会清掉平台那三行；
  `resetDb()` 会清掉成员那三行。收口时必须重跑 `npm run seed -- --reset` 再写回 `provider.*`。
- 15 秒是针对「人坐在设置页等」的折中。真机上已经出现过 9.6 秒的成功案例，
  再往下压就会开始误报；真要让慢网关也能测，得改成「先返回、后台继续」——那是另一个交互。
