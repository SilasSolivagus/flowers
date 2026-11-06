# P2.9 · 直连 chat 接口：一个 key 就够

P2.8 之后，「生成」仍然等于在本机跑一条 CLI（`FLOWERS_GEN_CMD`，或 `app_settings` 里
`generator.command` 那一行）。owner 的下一句要求把这条前提拆掉：「我有一个 LLM 的 key
（用户配上来的）」——**一个 key 就该够产出材料**，不该先在他机器上装一个 agent CLI、
再让它自己去认证（P2.7 的实测已经说明那些 CLI 的凭证会过期：`claude` 的 OAuth 过期、
`codex` 的 refresh token 已用、`dsh` 缺 key）。

这一版只做**地基**：一个不带 SDK 的客户端，加上它要读的三条设置键。不接生成流程、
不加设置页 UI——那是 P2.10 的事。

改动范围：

| 文件 | 性质 |
| --- | --- |
| `src/core/uemaster/provider.ts` | 新增。唯一的直连客户端。 |
| `src/core/uemaster/settings.ts` | 增量。加三条键的常量、一个读口、一个写口。 |
| `tests/provider.test.ts` | 新增。29 条用例，零外网。 |
| `docs/superpowers/plans/p2-9-provider.md` | 本文。 |

`src/core` 其余服务、`src/db` schema、`app/`、`mcp/` 一行没动；没有新依赖；
没有迁移（仍旧只用 `app_settings` 那张键值表）。

---

## 1. 契约

```ts
export type ProviderConfig = { baseUrl: string; apiKey: string; model: string };
export type ProviderResult =
  | { ok: true; text: string; usage?: { prompt?: number; completion?: number } }
  | { ok: false; error: string };

export async function complete(
  cfg: ProviderConfig, prompt: string,
  opts?: { maxTokens?: number; timeoutMs?: number },
): Promise<ProviderResult>;

export async function resolveProviderConfig(): Promise<ProviderConfig | null>;
export function extractJson<T>(text: string): T | null;
export function redactSecret(text: string, secret: string): string;
```

请求本体（`src/core/uemaster/provider.ts`）：

```
POST {baseUrl}/chat/completions
content-type: application/json
authorization: Bearer <apiKey>

{ "model": "<model>",
  "messages": [{ "role": "user", "content": "<prompt>" }],
  "max_tokens": <maxTokens> }
```

- `baseUrl` 末尾的 `/` 先削掉；已经被写成完整 `/chat/completions` 的不重复拼
  （自建网关的面板上两种写法都常见）。
- `maxTokens` 默认 **4096**：不设的话有的网关按模型上限放行，一份 HTML 能吐几万字。
- `timeoutMs` 默认 **120 秒**：够慢模型吐完一份需求文档，又不至于让人以为卡死。
- 用 `AbortSignal.timeout(timeoutMs)`——**整条**请求（含读正文）都在那个窗口里，
  服务端先回头再慢慢吐字的情况一样会被掐掉。

## 2. 解析顺序：env → 库 → null

```
FLOWERS_PROVIDER_BASE_URL / FLOWERS_PROVIDER_API_KEY / FLOWERS_PROVIDER_MODEL
        ↓ 三格齐全才用
app_settings: provider.baseUrl / provider.apiKey / provider.model
        ↓ 三格齐全才用
null
```

三条硬口径：

1. **三格齐全才算一个配置。** 缺一格就整层作废、往下一层走，`null` 表示「还没配」。
   env 只设了地址、库里存着 key 时，**不拼**成「env 的地址 + 库里的 key」——那种混合
   配置出问题时没人说得出是哪一层错了。这和 `resolveGenerator()`「一条命令要么全用、
   要么不用」是同一个判断。
2. **空串等于没设**（与 `generator.command` 同口径）：设置页的「清空」不需要删除
   接口，存空串就退回下一层。
3. **库读失败不吞。** 连不上库是基础设施坏了，把它说成「未配置」会让人去翻设置页。
   只有「两个来源都不全」才是 `null`。

`settings.ts` 里原本没有「允许的键」这种白名单——键就是服务层常量，`readKey` /
`writeKey` 接受任意键。所以这次按同样的风格加了三件事，没有引入新机制：

```ts
export const PROVIDER_BASE_URL_KEY = 'provider.baseUrl';
export const PROVIDER_API_KEY_KEY = 'provider.apiKey';
export const PROVIDER_MODEL_KEY = 'provider.model';

export async function providerSettings(db): Promise<ProviderConfig | null>;   // 三条齐全才给
export async function saveProviderSettings(db, { baseUrl?, apiKey?, model? }): Promise<void>;
```

`saveProviderSettings` 是给 P2.10 的设置页用的：传字符串就写、传空串就是清、不传的
字段保持原样，长度超限当场 `AppError('invalid_provider', …)`。**本任务没有调用它的
UI**，它由用例覆盖。之所以现在就写：`app_settings` 的读写口只有 `settings.ts` 一处，
让 `provider.ts` 自己写 SQL 就会裂出第二套「空串算什么」的解读。

## 3. 脱敏规则

> **key 只出现在 `Authorization` 头里。**

具体做法与理由：

- `complete()` 的每一个 `{ ok: false, error }` 都过一遍 `redactSecret(text, cfg.apiKey)`，
  **包括**超时、连接失败、服务端 `error.message`。下游（生成流程、事件流、任务错误、
  设置页小测）只从 `error` 取文案，所以只要这一个口子洗干净，全链路就是干净的。
- 替换用 `split(needle).join('***')` 而不是正则：key 里可能有 `.` `+` `/`（本次用例里
  就故意用了 `sk-live-ABC.123/x+y`）。拼进正则就要转义，转义写错就是「看着脱敏了，
  其实没有」。
- 空 key 不做替换（否则会把整句话切成碎块）——那种情况下面板本来就发不出去请求。
- 只换掉 key 本身，句子的其余部分**保留**：`Incorrect API key provided: ***` 仍然
  告诉 owner 是 key 的问题，而不是把整句删成「请求失败」。
- 成功路径的 `text` 不脱敏：那是模型产出的材料，不是错误文案，也不该被改写。
- `resolveProviderConfig()` 的返回值会进 `Authorization` 头，**不进**响应体、日志、
  事件。本任务没有把它暴露给任何客户端。

## 4. 错误分类

`complete()` **不抛异常**。全部出口：

| 情形 | `error` 文案 | 是否含服务端原文 |
| --- | --- | --- |
| 配置缺格 | `接口地址是空的` / `API Key 是空的` / `模型名是空的` | — |
| 服务端 4xx/5xx 且有 `error.message` | **原文照登**（只脱敏 key） | 是 |
| 服务端非 2xx 且无 message | `HTTP 429` 或 `HTTP 502 Bad Gateway` | 状态短语 |
| 非 JSON 正文（反代常回一行纯文本） | 那行纯文本，截到 300 字 | 是 |
| 2xx 但正文不是 JSON | `模型接口返回的内容不是 JSON` | — |
| 2xx 但 `choices[0].message.content` 不是字符串 | `响应不是 chat 补全的格式` | — |
| 内容为空 / 只有空白 | `模型返回了空内容` | — |
| 超时 | `请求超时：120 秒内没有响应`（短超时写毫秒：`请求超时：150 毫秒内没有响应`） | — |
| 其余传输失败 | `请求失败：fetch failed（connect ECONNREFUSED 127.0.0.1:PORT）` | 系统原文 |

两条刻意的选择：

- **服务端的话不改写。** `分组 auto 下模型 x 的可用渠道不存在` 这句话里有分组名、
  有模型名，是唯一能指向「哪里配错了」的线索。翻成「请求失败」等于把线索扔了。
- **超时数值写进文案。** 光说「请求超时」，owner 不知道该等多久、该不该重试；
  短超时的用例读起来也不会像玄学。
- `请求失败：…（connect ECONNREFUSED …）` 里那段英文是操作系统/undici 的原话，
  不翻译：它才是能 Google 的那半句。中文外壳 + 原始原因并存，不是「英文泄漏」——
  全句没有一句英文句子。

## 5. `extractJson`

compose 那一步要的是「从一段人话里拿到一个对象」。`extractJson<T>` 的规则：

1. **围栏优先**：先找 ``` ```json … ``` ``` 这类块（``` 后允许带语言标记），
   块内先 `JSON.parse`，失败再在块内扫描。
2. 其次在整段文本里按出现顺序找 `{` / `[`，用**自己数括号**的方式找配对的收尾
   （字符状态机：字符串内、转义引号内的括号不算），切片 `JSON.parse`，第一个能
   解析成功的就返回。
3. 都不成就 `null`——半截 JSON 也返回 `null`，不猜、不补括号。

为什么先围栏：围栏是模型**明确标注**的代码块；而散文里的 `{需求}`、`<占位符>` 也是
花括号。为什么自己数括号：模型常在 JSON **后面**接着写「以上就是配置」，`indexOf('}')`
会把正文切成半截。

返回类型由调用方声明（`extractJson<ComposeResult>`），本函数不校验字段——字段口径属于
compose 的契约，不属于传输层。

## 6. 用例与真实输出

`tests/provider.test.ts` 一共 **29 条**，零外网：所谓「provider」是一个真的
`http.createServer`，监听 `127.0.0.1:0`（内核给的临时端口），`baseUrl` 就是
`http://127.0.0.1:<port>/v1`。所以测到的是真 `fetch`、真 `AbortSignal.timeout`、
真的状态码与正文。

```
 ✓ tests/provider.test.ts > complete：happy path > 发出一次 /chat/completions，带回文字与 usage
 ✓ tests/provider.test.ts > complete：happy path > baseUrl 已经写成完整路径时不重复拼 /chat/completions
 ✓ tests/provider.test.ts > complete：happy path > 没有 usage 时不硬塞一个空对象
 ✓ tests/provider.test.ts > complete：服务端的错 > 4xx 时把 error.message 原样带回来（分组、模型名都在里面）
 ✓ tests/provider.test.ts > complete：服务端的错 > 没有 error.message 就退回状态码，不吞
 ✓ tests/provider.test.ts > complete：服务端的错 > 非 JSON 的正文按纯文本带出（反代常这么回）
 ✓ tests/provider.test.ts > complete：服务端的错 > 200 但正文不是 JSON：说清楚是它不像 JSON
 ✓ tests/provider.test.ts > complete：超时 > 服务端不回应，短超时把它掐掉，并说出超了几毫秒
 ✓ tests/provider.test.ts > complete：超时 > 默认超时是 120 秒，那句话里写的是秒 1010ms
 ✓ tests/provider.test.ts > complete：空内容算失败 > content 是空串时不是成功
 ✓ tests/provider.test.ts > complete：空内容算失败 > 只有空白也不算内容
 ✓ tests/provider.test.ts > complete：空内容算失败 > choices 形状不对时说的是格式不对，不是空
 ✓ tests/provider.test.ts > complete：key 不外泄 > 服务端把 Authorization 回显在错误里时，回来的那句话里只有 ***
 ✓ tests/provider.test.ts > complete：key 不外泄 > 传输层失败的那句话里也不带 key
 ✓ tests/provider.test.ts > complete：key 不外泄 > redactSecret 是字面替换，不是正则
 ✓ tests/provider.test.ts > resolveProviderConfig > 库里三条齐全就用库里的
 ✓ tests/provider.test.ts > resolveProviderConfig > env 排在库之前：三格都设了就用 env
 ✓ tests/provider.test.ts > resolveProviderConfig > env 只有一格时不与库里拼成半份——整层作废，落到库里
 ✓ tests/provider.test.ts > resolveProviderConfig > 库里只有两条：null，不是半份配置
 ✓ tests/provider.test.ts > resolveProviderConfig > 条目存在但值是空串：等于没设
 ✓ tests/provider.test.ts > resolveProviderConfig > 两层都没有：null（「还没配」，不是错误）
 ✓ tests/provider.test.ts > resolveProviderConfig > 保存时去掉首尾空白，并在超长时拒绝
 ✓ tests/provider.test.ts > extractJson > 裸 JSON
 ✓ tests/provider.test.ts > extractJson > ```json 围栏里的
 ✓ tests/provider.test.ts > extractJson > 先说话后 JSON
 ✓ tests/provider.test.ts > extractJson > 回话里没有 JSON：null
 ✓ tests/provider.test.ts > extractJson > 散文里的 {占位符} 与字符串里的括号都不会被当成 JSON
 ✓ tests/provider.test.ts > extractJson > 顶层是数组也算
 ✓ tests/provider.test.ts > extractJson > 半截 JSON 不算：不加猜测地返回 null

 Test Files  1 passed (1)
      Tests  29 passed (29)
```

全量（这次一起跑）：

```
 Test Files  14 passed (14)
      Tests  409 passed (409)
   Duration  36.34s
```

另外用一个一次性脚本（`npx tsx`，本地 `http.createServer`，不碰任何外部接口）
把五条出口的**真实返回值**打了一遍：

```
happy      : {"ok":true,"text":"```json\n{\"title\":\"评估\",\"items\":[1,2]}\n```","usage":{"prompt":11,"completion":5}}
extractJson: {"title":"评估","items":[1,2]}
server 400 : {"ok":false,"error":"分组 auto 下模型 glm-5.3 的可用渠道不存在"}
redaction  : {"ok":false,"error":"Incorrect API key provided: ***"}
timeout    : {"ok":false,"error":"请求超时：200 毫秒内没有响应"} (204ms)
empty cfg  : {"ok":false,"error":"接口地址是空的"}
```

对着上面那张表逐条核对：

- **happy path**：文字与 `usage` 都在，模型回话原样（围栏不作处理——要不要去围栏是
  compose 的事）；`extractJson` 从同一段回话里拿回了对象。
- **服务端原文透传**：`分组 auto 下模型 glm-5.3 的可用渠道不存在` 一个字符没改。
- **超时**：`timeoutMs: 200`，实测 204ms 回来，文案写了 200 毫秒。
- **脱敏**：服务端把 `Authorization` 回显在 `error.message` 里，回来的那句话里是 `***`，
  句子其余部分保留。
- **配置缺格**：`接口地址是空的`——不是发一个没有地址的请求再去报网络错误。

## 7. 还没做 / 还糙的地方

1. **没接进生成流程。** `start.ts` / `runJob` 仍然走 CLI。P2.10 要在
   「有 provider 配置」时改走 `complete()`，并处理「两者都配了先信谁」——建议：
   配了 provider 就用 provider，CLI 作为回退，且这件事要写进设置的展示里。
2. **没有设置页 UI，也没有读写这三条键的 API。** 用户现在只能靠
   `FLOWERS_PROVIDER_*` 环境变量或直接写库。`saveProviderSettings` 已经就位，
   留给下一版的那个「一行表单」。
3. **key 是明文存在 `app_settings.value` 里的。** 与 `generator.command` 同库同位；
   库的访问控制就是边界。要加密得先有密钥管理，这一版不做——但**任何**出口
   （API 响应、事件、日志、任务错误）都不带它，这是已经做到的。
4. **一次只发一问。** 没有 system 提示、没有多轮、没有流式。compose 如果要多轮，
   得把 `complete` 的 `prompt: string` 放宽成 `messages: Message[]`——那是个签名变更，
   这一版刻意没提前放宽。
5. **`max_tokens` 这个名字**：OpenAI 新一代推理模型改叫 `max_completion_tokens`，
   有的网关两者都收、有的只收一个。按 owner 那个 router 的实测口径，`max_tokens`
   是通的；将来若撞上只认新名的部署，改 `complete()` 的请求体一处即可。
6. **没有重试。** 429 / 5xx 直接回给调用方。生成流程那边是否要一次指数退避，
   等 P2.10 看实际失败率再定——现在加等于凭空猜一个策略。
7. **`usage` 只映射 `prompt_tokens` / `completion_tokens`。** 有的网关给
   `total_tokens` 或 `cache_*`，暂时不要。
8. **`extractJson` 只认对象与数组**（模型给的 JSON 标量→`null`）。compose 要的是对象，
   这个限制是有意的。
