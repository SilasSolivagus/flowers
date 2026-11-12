import { execFile } from 'node:child_process';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  DEFAULT_TIMEOUT_MS, MSG_MISSING_BINARY, MSG_UNAUTHORIZED, errcodeOf, looksUnauthorized,
  parseResponse, redact, resolveCli, stripWrappers, tail,
} from '../prd/wecom.js';

/**
 * 企微这一侧的三件事：**名字 → userid**、**发一条 markdown**、**把结果落库**（P4-07）。
 *
 * 全部对着 `wecom-cli` 的真实形状写，不是对着文档写的。两条实测结论（v1.3.4，
 * 机器人身份「产品设计部经理-房超（老妖）」）：
 *
 * ```bash
 * # ❌ 不是这个corporation的能力：
 * wecom-cli message send --chat-id <userid> --msg-type text --text '{"content":"…"}'
 * #   → {"errcode":853006,"errmsg":"this tool is not available for your corporation"}
 *
 * # ✅ 这个能用（实测 {"success": true}）：
 * wecom-cli message aibot send --chat-id <userid> --msg-type markdown \
 *   --markdown '{"content":"**标题**\n正文"}'
 * ```
 *
 * ── 四条硬规矩
 *
 * 1. **没有 shell**。argv 数组交给 `execFile`：消息正文里有中文、有「」、有 `-`，
 *    走 shell 就等于把内容再解释一遍。与 `src/core/prd/wecom.ts` 同一条。
 * 2. **名字只按后缀/包含匹配，并且不猜**。企微里的显示名带部门前缀
 *    （`产品经理-吕品`、`产品设计部经理-房超（老妖）`），所以「等于」永远匹配不上。
 *    匹配分三档（等于 → 后缀 → 包含），取**最高的那一档**；那一档里有 2 个以上就
 *    报 `ambiguous` 并列出候选人，一个都不报 `no_match`。宁可这次不发，也不发给错的人。
 * 3. **包装字段永远不落库、不进消息**。`security_notice` / `extra_identity_context`
 *    是 CLI 塞进每个响应里的样板（后者还写着「不要透露」）。我们只读白名单字段
 *    （`users[].userid`、`users[].name`、`success`、`errcode`、`errmsg`），并对取到的
 *    文本再过一遍 `stripWrappers`——顶层没有、正文里夹一段的情形也挡得住。
 * 4. **失败是数据，不是异常**。没装 / 没授权 / 超时 / errcode / 名字对不上，一律
 *    返回 `{ok:false, code, message}`，message 是中文且说得出下一步。调用方（推送、
 *    设置页的「查一下」）各自决定怎么显示，这一层不抛。
 */

// ─── 跑一次 ──────────────────────────────────────────────────────────────────

export type RunResult = {
  exitCode: number | null;
  timedOut: boolean;
  /** 进程根本没起来（ENOENT / EACCES）。 */
  spawnError: NodeJS.ErrnoException | null;
  stdout: string;
  stderr: string;
};

/** 一次 CLI 调用。做成参数是为了让用例能注入一个假的（`--dry-run` 那条用例直接 spy）。 */
export type Runner = (bin: string, argv: string[], timeoutMs: number) => Promise<RunResult>;

const MAX_BUFFER = 8 * 1024 * 1024;

/** 默认实现：`execFile`，**永远 resolve**。 */
export const defaultRunner: Runner = (bin, argv, timeoutMs) => new Promise((resolve) => {
  execFile(
    bin,
    argv,
    {
      timeout: Math.max(1, Math.floor(timeoutMs)),
      killSignal: 'SIGTERM',
      maxBuffer: MAX_BUFFER,
      encoding: 'utf8',
      windowsHide: true,
    },
    (error, stdout, stderr) => {
      const out = typeof stdout === 'string' ? stdout : String(stdout ?? '');
      const err = typeof stderr === 'string' ? stderr : String(stderr ?? '');
      if (error === null) {
        resolve({ exitCode: 0, timedOut: false, spawnError: null, stdout: out, stderr: err });
        return;
      }
      const e = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: number | string };
      if (typeof e.code === 'string') {
        resolve({ exitCode: null, timedOut: false, spawnError: e, stdout: out, stderr: err });
        return;
      }
      const timedOut = Boolean(e.killed) && (e.signal === 'SIGTERM' || e.signal === 'SIGKILL');
      resolve({
        exitCode: typeof e.code === 'number' ? e.code : null,
        timedOut,
        spawnError: null,
        stdout: out,
        stderr: err,
      });
    },
  );
});

// ─── 命令形状 ────────────────────────────────────────────────────────────────

/** 通讯录检索。`--keywords` 收名字的**任意片段**，返回可能是 0..n 个人。 */
export function searchArgv(keywords: string): string[] {
  return ['contact', 'users', 'search', '--keywords', keywords];
}

/**
 * 发一条 markdown。
 *
 * `--chat-id` 对单聊就是对方的 **userid**（不是名字，也不是会话 id）。
 * `--markdown` 的实参是一个 JSON 字符串 `{"content":"…"}`——两层引号，所以它是
 * 一个 argv 元素，不经过 shell。
 */
export function sendArgv(userid: string, content: string): string[] {
  return [
    'message', 'aibot', 'send',
    '--chat-id', userid,
    '--msg-type', 'markdown',
    '--markdown', JSON.stringify({ content }),
  ];
}

// ─── 失败码 ──────────────────────────────────────────────────────────────────

export type WecomFailCode =
  | 'bad_config'      // 读不到 CLI 路径（库错误）
  | 'missing_binary'  // CLI 没装
  | 'unauthorized'    // CLI 没授权
  | 'cli_failed'      // 退出码非 0（非授权那类）
  | 'timeout'         // 超预算
  | 'bad_output'      // stdout 不是 JSON / 没有 users
  | 'errcode'         // errcode 非 0（errmsg 原样带出）
  | 'no_match'        // 通讯录里找不到这个人
  | 'ambiguous';      // 找到了不止一个，不猜

export type WecomFail = { ok: false; code: WecomFailCode; message: string };

function fail(code: WecomFailCode, message: string): WecomFail {
  return { ok: false, code, message };
}

/** 一次调用里所有「进程层面的失败」共用这一段，两个入口不各写一遍。 */
function processFailure(bin: string, run: RunResult, timeoutMs: number): WecomFail | null {
  const combined = `${run.stderr}\n${run.stdout}`;
  if (run.spawnError !== null) {
    return run.spawnError.code === 'ENOENT'
      ? fail('missing_binary', MSG_MISSING_BINARY)
      : fail('cli_failed', `${bin} 起不来（${redact(`${run.spawnError.code ?? '未知'}：${run.spawnError.message}`)}）`);
  }
  if (run.timedOut) {
    return fail('timeout', `wecom-cli 超时：等了 ${Math.round(timeoutMs / 1000)} 秒还没返回`);
  }
  if (run.exitCode !== 0) {
    if (looksUnauthorized(combined)) return fail('unauthorized', MSG_UNAUTHORIZED);
    /**
     * 853008（2026-11-11）：**不是 userid 错了**，而是企微的规矩——机器人只能给「最近和
     * 它说过话」的成员发消息。第一次用之前，那个人要先在企微里点开这个机器人发一句话。
     * 原来这里把整段 JSON 原样吐出去，看起来像配置错误；换成一句能照着做的中文。
     */
    if (combined.includes('853008')) {
      // 2026-11-11 实测：这个 aibot 是**个人机器人**，别人根本点不开（企微提示
      // 「该机器人仅 …个人使用，你无法与它聊天」）。所以「让他先发一句话」是错的指引。
      return fail(
        'cli_failed',
        '这台机器人是个人机器人，只能给本人发消息，其他成员无法与它对话。'
          + '要让这个人收到推送，请改用「用自己的机器人」（群机器人 webhook），或由管理员配置企业应用消息。',
      );
    }
    const code = run.exitCode === null ? '被信号终止' : `退出码 ${run.exitCode}`;
    const text = tail(run.stderr) || tail(run.stdout) || '（stderr 与 stdout 都是空的）';
    return fail('cli_failed', `${bin} 调用失败（${code}）：${text}`);
  }
  return null;
}

// ─── 名字 → userid ──────────────────────────────────────────────────────────

export type WecomUser = { userid: string; name: string };

/**
 * 响应里能认的人。**只读白名单字段**，包装字段在源头就不进来（见文件头第 3 条）。
 */
export function usersOf(response: Record<string, unknown>): WecomUser[] {
  const raw = response.users;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const users: WecomUser[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const userid = typeof record.userid === 'string' ? record.userid.trim() : '';
    const name = typeof record.name === 'string' ? stripWrappers(record.name).trim() : '';
    if (userid === '' || seen.has(userid)) continue;
    seen.add(userid);
    users.push({ userid, name });
  }
  return users;
}

/** 匹配的三档，从强到弱。`产品经理-吕品` 对输入 `吕品` 命中第二档。 */
const TIERS: ReadonlyArray<(name: string, input: string) => boolean> = [
  (name, input) => name === input,
  (name, input) => name.endsWith(input),
  (name, input) => name.includes(input),
];

export type PickResult =
  | { ok: true; user: WecomUser; tier: 0 | 1 | 2 }
  | WecomFail;

/**
 * 名字 → 那一个人。**不猜**。
 *
 * 三档取最高档：一条「等于」压过十条「包含」（输入 `王妍` 时，名册里真有一个人就叫
 * 王妍，那就该是她，而不是另外两个名字里带「王妍」的人）。最高档里 2 个以上 →
 * `ambiguous`，把那几个名字列出来让人去改通讯录；一个都没有 → `no_match`。
 */
export function pickUser(input: string, users: WecomUser[]): PickResult {
  const wanted = input.trim();
  if (wanted === '') return fail('no_match', '成员名字是空的，没法去企微里对账号');
  for (let tier = 0; tier < TIERS.length; tier += 1) {
    const test = TIERS[tier]!;
    const hits = users.filter((user) => test(user.name, wanted));
    if (hits.length === 1) {
      return { ok: true, user: hits[0]!, tier: tier as 0 | 1 | 2 };
    }
    if (hits.length > 1) {
      const list = hits.map((user) => user.name).join('、');
      return fail('ambiguous', `企微里有 ${hits.length} 个「${wanted}」：${list}，不猜是哪一个`);
    }
  }
  return fail('no_match', `企微通讯录里没有匹配「${wanted}」的人`);
}

export type LookupOptions = {
  run?: Runner;
  bin?: string | null;
  timeoutMs?: number;
};

/**
 * 查一次：名字 → userid。**不落库**（落库在下面 `resolveUserid`）。
 *
 * `bin` 传 null 时按 `prd/wecom.ts` 那三级解析（环境变量 → `app_settings` → PATH），
 * 与「读 PRD」共用同一个配置格：一台机器上只该有一个 `wecom-cli` 路径。
 */
export async function lookupUserid(
  name: string, opts: LookupOptions = {},
): Promise<{ ok: true; user: WecomUser } | WecomFail> {
  const timeoutMs = positive(opts.timeoutMs, DEFAULT_TIMEOUT_MS);
  const run = opts.run ?? defaultRunner;

  let bin = opts.bin ?? null;
  if (bin === null) {
    const resolved = await resolveCli();
    if (!resolved.ok) return fail('bad_config', resolved.message);
    bin = resolved.bin;
  }

  const result = await run(bin, searchArgv(name), timeoutMs);
  const broken = processFailure(bin, result, timeoutMs);
  if (broken !== null) return broken;

  const response = parseResponse(result.stdout);
  if (response === null) {
    const combined = `${result.stderr}\n${result.stdout}`;
    if (looksUnauthorized(combined)) return fail('unauthorized', MSG_UNAUTHORIZED);
    return fail('bad_output', `wecom-cli 的通讯录输出不是 JSON：${tail(combined) || '（什么都没打印）'}`);
  }
  const record = response as Record<string, unknown>;
  const errcode = errcodeOf(response);
  if (errcode !== null && errcode !== 0) {
    const errmsg = typeof record.errmsg === 'string' ? redact(record.errmsg) : '';
    if ([40001, 40014, 42001, 41001, 48001].includes(errcode)) {
      return fail('unauthorized', MSG_UNAUTHORIZED);
    }
    return fail('errcode', `企业微信接口报错 ${errcode}：${errmsg || '（没有给 errmsg）'}`);
  }
  if (!Array.isArray(record.users)) {
    return fail('bad_output', `wecom-cli 的通讯录响应里没有 users：${tail(result.stdout)}`);
  }

  const picked = pickUser(name, usersOf(record));
  return picked.ok ? { ok: true, user: picked.user } : picked;
}

// ─── 发一条 ──────────────────────────────────────────────────────────────────

export const SEND_TIMEOUT_MS = 30_000;

/**
 * 消息正文。**两行**：加粗的编号+标题，一句「发生了什么 / 要你做什么」。
 *
 * 没有链接：这一版没有公网地址，`http://localhost:3000/?open=…` 在手机上点不开，
 * 一条点不开的链接会让整条推送显得是坏的。要带人回去，靠的是编号。
 *
 * `redact` + `stripWrappers` 是两道闸：标题和原因都是**人写进库里的文本**，
 * 而这条消息会离开这台机器。包装字段（如果有人在标题里贴了一段）不许跟着走。
 */
/**
 * 一条私聊消息 = 抬头 + 一句话 + 「谁 · 什么时候」。
 *
 * 末行是 2026-11-11 加的：群里的播报一直带着 `吕品 · 11-10 18:40`，私聊却只写「发生了什么」，
 * 于是把个人机器人接到一个群之后（李嘉那种用法），群里看到的是一串没有主语的搁置通知
 * ——「谁动的、什么时候动的」全靠猜。两个频道说同一件事，就不该只在一个频道里署名。
 */
/**
 * 私聊里不发 HTML：`<font color="…">` 在企微单聊 markdown 里有效，但个人机器人常常被
 * 接到第三方群桥（2026-11-11 李嘉那次），那边会把标签原样显示出来——读者看到的是
 * `<font color="comment">系统 · 11-11 10:50</font>` 这种噪音。私聊不需要颜色，剥掉。
 */
function stripTags(text: string): string {
  return text.replace(/<\/?font[^>]*>/g, '');
}

export function messageOf(
  headline: string,
  sentence: string,
  meta?: { actor: string; at: string; timeText: (raw: string) => string },
): string {
  const lines = [`**${headline}**`, `${sentence}。`];
  if (meta && meta.timeText(meta.at) !== '') {
    const actor = meta.actor === 'system' ? '系统' : meta.actor;
    lines.push(`<font color="comment">${actor} · ${meta.timeText(meta.at)}</font>`);
  }
  return stripWrappers(stripTags(redact(lines.join('\n'))));
}

export type SendOptions = {
  run?: Runner;
  bin?: string | null;
  timeoutMs?: number;
};

/**
 * 发一条 markdown 给一个 userid。
 *
 * 成功信号是响应里的 `success === true`（实测形状），**不是**退出码——CLI 在业务
 * 失败时也是 0 退出（与读文档那一层同一条教训）。errcode 非 0 时把 errmsg **原文**
 * 带出来：`853006 this tool is not available for your corporation` 这种话是运维
 * 唯一能搜到答案的线索，改写它只会让人多绕一圈。
 */
export async function sendMarkdown(
  userid: string, content: string, opts: SendOptions = {},
): Promise<{ ok: true } | WecomFail> {
  const timeoutMs = positive(opts.timeoutMs, SEND_TIMEOUT_MS);
  const run = opts.run ?? defaultRunner;

  let bin = opts.bin ?? null;
  if (bin === null) {
    const resolved = await resolveCli();
    if (!resolved.ok) return fail('bad_config', resolved.message);
    bin = resolved.bin;
  }

  const result = await run(bin, sendArgv(userid, content), timeoutMs);
  const broken = processFailure(bin, result, timeoutMs);
  if (broken !== null) return broken;

  const response = parseResponse(result.stdout);
  if (response === null) {
    const combined = `${result.stderr}\n${result.stdout}`;
    if (looksUnauthorized(combined)) return fail('unauthorized', MSG_UNAUTHORIZED);
    return fail('bad_output', `wecom-cli 的发送输出不是 JSON：${tail(combined) || '（什么都没打印）'}`);
  }
  const record = response as Record<string, unknown>;
  if (record.success === true) return { ok: true };

  const errcode = errcodeOf(response);
  const errmsg = typeof record.errmsg === 'string' ? redact(record.errmsg) : '';
  if (errcode !== null && errcode !== 0) {
    if ([40001, 40014, 42001, 41001, 48001].includes(errcode)) {
      return fail('unauthorized', MSG_UNAUTHORIZED);
    }
    return fail('errcode', `企业微信报错 ${errcode}：${errmsg || '（没有给 errmsg）'}`);
  }
  return fail('bad_output', `wecom-cli 的发送响应里没有 success：${tail(result.stdout)}`);
}

// ─── 落库：缓存与「查一下」 ──────────────────────────────────────────────────

/** 需要解析 userid 的那一行成员。`wecomUserId` 非空就是已经缓存过。 */
export type LookupTarget = {
  id: string;
  name: string;
  wecomUserId?: string | null;
};

export type ResolveResult =
  | { ok: true; userid: string; name: string; cached: boolean }
  | WecomFail;

/**
 * 取这个人的 userid：**先看缓存，再问 CLI**，两个结果都留档。
 *
 * 缓存命中就不再问（一次网络往返省下来，且企微那边不会因为我们的轮询被限流）。
 * 失败也要写 `wecom_lookup_at`：它是「上次试过」的唯一依据，排查时那句
 * 「是不是根本没人查过」由此可答；失败原因写进 `notify_deliveries.error`
 * （见 `dispatch.ts` 的 `skipped`）。
 *
 * 成功时**两个字段一起写**（userid + 时刻）：它们是一件事的两半，分开写会出现
 * 「有 userid 但没有时刻」这种半截状态。
 */
export async function resolveUserid(
  db: Db, target: LookupTarget, opts: LookupOptions = {},
): Promise<ResolveResult> {
  const cached = typeof target.wecomUserId === 'string' ? target.wecomUserId.trim() : '';
  if (cached !== '') {
    return { ok: true, userid: cached, name: target.name, cached: true };
  }

  const found = await lookupUserid(target.name, opts);
  if (!found.ok) {
    await db.execute(sql`
      update members set wecom_lookup_at = now() where id = ${target.id}`);
    return found;
  }

  await db.execute(sql`
    update members
       set wecom_userid = ${found.user.userid},
           wecom_lookup_at = now()
     where id = ${target.id}`);
  return { ok: true, userid: found.user.userid, name: found.user.name, cached: false };
}

/** 正数才有意义；坏值回落默认（与 prd/wecom.ts 同一条）。 */
function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

// ─── 2026-11-10：绑定自己的 userid / 用自己的机器人 ──────────────────────────

/**
 * 用户贴进来的 userid 的形状。
 *
 * 企微的 userid 是管理员在通讯录里定的账号名（`fangchao`、`lvpin` 这种），字符集是
 * 字母数字加 `_ . - @`，长度不超过 64。这里**只拦「肯定不是」的形态**（空白、长度、
 * 奇怪字符）——真正的判据是下面那次通讯录查询，形状检查只是为了让一个粘贴错了的东西
 * （例如整段「企业微信 → 我」的界面文字）在发请求之前就说清楚。
 */
const USERID_SHAPE = /^[A-Za-z0-9_.@-]{1,64}$/;

/** userid 形状不对时的那句话（说清该贴什么，而不是「格式错误」）。 */
export const MSG_USERID_SHAPE = 'userid 只能有字母、数字与 _ . - @，最长 64 个字符；'
  + '它通常就是你的工号/英文名（企业微信 → 我 → 资料页）';

/**
 * 按 **userid** 去通讯录里查一个人（「验证」那一步）。
 *
 * 为什么要问一次通讯录，而不是「贴进来就存」：`wecom_userid` 是**发消息的收件人**，
 * 存错一个字，这个人的通知就会静默地发给别人（或者发给一个不存在的人）。通讯录是
 * 唯一能回答「这个 userid 是不是真有一个人」的地方。
 *
 * 匹配是**逐字相等**：`search` 收的是关键词，命中一串包含它的名字是常态，而这一条
 * 要的不是「像」，是「就是」。命中不到就说「没有」——不猜、不取第一个。
 */
export async function lookupUseridExact(
  userid: string, opts: LookupOptions = {},
): Promise<{ ok: true; user: WecomUser } | WecomFail> {
  const wanted = userid.trim();
  if (wanted === '') return fail('no_match', '先把 userid 贴进来');
  if (!USERID_SHAPE.test(wanted)) return fail('bad_output', MSG_USERID_SHAPE);

  const timeoutMs = positive(opts.timeoutMs, DEFAULT_TIMEOUT_MS);
  const run = opts.run ?? defaultRunner;

  let bin = opts.bin ?? null;
  if (bin === null) {
    const resolved = await resolveCli();
    if (!resolved.ok) return fail('bad_config', resolved.message);
    bin = resolved.bin;
  }

  const result = await run(bin, searchArgv(wanted), timeoutMs);
  const broken = processFailure(bin, result, timeoutMs);
  if (broken !== null) return broken;

  const response = parseResponse(result.stdout);
  if (response === null) {
    const combined = `${result.stderr}\n${result.stdout}`;
    if (looksUnauthorized(combined)) return fail('unauthorized', MSG_UNAUTHORIZED);
    return fail('bad_output', `wecom-cli 的通讯录输出不是 JSON：${tail(combined) || '（什么都没打印）'}`);
  }
  const record = response as Record<string, unknown>;
  const errcode = errcodeOf(response);
  if (errcode !== null && errcode !== 0) {
    const errmsg = typeof record.errmsg === 'string' ? redact(record.errmsg) : '';
    if ([40001, 40014, 42001, 41001, 48001].includes(errcode)) {
      return fail('unauthorized', MSG_UNAUTHORIZED);
    }
    return fail('errcode', `企业微信接口报错 ${errcode}：${errmsg || '（没有给 errmsg）'}`);
  }
  if (!Array.isArray(record.users)) {
    return fail('bad_output', `wecom-cli 的通讯录响应里没有 users：${tail(result.stdout)}`);
  }

  const hit = usersOf(record).find((user) => user.userid === wanted);
  if (hit === undefined) {
    return fail(
      'no_match',
      `企微通讯录里没有 userid 为「${wanted}」的人。核对工号/英文名（企业微信 → 我 → 资料页），`
      + '或让管理员在企微后台「通讯录」里确认这个账号',
    );
  }
  return { ok: true, user: hit };
}

/**
 * 绑定结果的四种状态（设置页那一行要显示的那个词）。
 *
 * `need_init`（2026-11-11）：userid 已绑定，但**一条都没发出去过**，最近一次失败是
 * 企微 853008「当前会话不是机器人的最近会话」——意思是这个人还没在企微里跟机器人说过话。
 * 之前的三种状态只看库里那一列，于是界面显示「已绑定」，人以为自己通了，实际一条都
 * 收不到（赵越就是这样丢了 5 条）。这个状态是**算出来的**：读最近一次投递结果。
 */
export type BindingState = 'bound' | 'need_init' | 'unbound' | 'failed';

/**
 * 这一行该显示成哪种状态。
 *
 * 算出来的，不是存出来的（迁移 0038 的注释里写了为什么）：
 * - `wecom_userid` 非空 → 已绑定；
 * - 空、但 `wecom_lookup_at` 有过值 → 上次验证失败（那一列是「试过」的唯一记号，
 *   成功与失败都写它，见 `resolveUserid`）；
 * - 两个都空 → 从没绑过。
 */
export function bindingStateOf(
  member: { wecomUserId?: string | null }, lastLookupAt: Date | string | null,
): BindingState {
  const userid = typeof member.wecomUserId === 'string' ? member.wecomUserId.trim() : '';
  if (userid !== '') return 'bound';
  return lastLookupAt === null ? 'unbound' : 'failed';
}

/** 三种状态的中文（界面那一行的 pill 用它，报告里也用——一处措辞）。 */
export const BINDING_LABEL: Record<BindingState, string> = {
  bound: '已绑定',
  need_init: '已绑定 · 未激活',
  unbound: '未绑定',
  failed: '验证失败',
};

/** 未激活时那一句话：说清要做什么，不说技术名词。 */
export const NEED_INIT_HINT = '还没打通：这台机器人是个人机器人，只能给本人发消息，你无法与它对话。'
  + '要让消息送到你手上，请在下面「用自己的机器人」里填一个群机器人 webhook（企微群 → 添加机器人）。';

/** 是不是「没跟机器人说过话」这一类失败（853008）。 */
export function looksUninitialized(error: string | null | undefined): boolean {
  const text = error ?? '';
  return text.includes('853008') || text.includes('还没和机器人说过话');
}

/**
 * webhook 的掩码：域名与路径照给，`key` 只留末 4 位。
 *
 * 为什么不是整串：一条 webhook 等于「可以往那个群里发消息」的凭证。整串回显一次，
 * 就多一个能把它抄走的地方（截图、投屏、别人站在背后）。末 4 位够认出「这是哪一条」，
 * 又不足以拿去用——与 `keyTail` 对模型 key 的处理是同一条规矩。
 */
export function maskWebhook(url: string | null | undefined): string | null {
  const text = url?.trim() ?? '';
  if (text === '') return null;
  const keyAt = text.indexOf('key=');
  if (keyAt < 0) return '已设置';
  const head = text.slice(0, keyAt + 4);
  const key = text.slice(keyAt + 4);
  return key.length <= 4 ? `${head}****` : `${head}****${key.slice(-4)}`;
}

/** webhook 的判据：必须是企微群机器人的那个地址（别把任意 URL 当成收件人）。 */
const WEBHOOK_HOST = 'qyapi.weixin.qq.com';
const WEBHOOK_PATH = '/cgi-bin/webhook/send';

export type WebhookCheck = { ok: true; url: string } | WecomFail;

/**
 * 校验并归一一条 webhook。
 *
 * 四条：https、主机就是 `qyapi.weixin.qq.com`、路径是 `/cgi-bin/webhook/send`、
 * `key` 非空。为什么这么窄：这一列会被 `POST` 出去，允许任意 URL 就等于允许成员让
 * 服务器替他请求任意地址（一个内网探测的口子）。企微的机器人只在这一个主机上，
 * 收窄它不损失任何真实用法。
 *
 * **不改写入库的值**（除了去空白）：URL 里可能有我们不该重排的 query 顺序；
 * 校验只回答「能不能用」。
 */
export function checkWebhook(raw: unknown): WebhookCheck {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') return fail('bad_config', 'webhook 是空的');
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return fail('bad_config', '这不是一个完整的地址（要 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…）');
  }
  if (parsed.protocol !== 'https:') return fail('bad_config', 'webhook 必须是 https 地址');
  if (parsed.hostname !== WEBHOOK_HOST) {
    return fail('bad_config', `webhook 的主机必须是 ${WEBHOOK_HOST}（群机器人 → 复制 Webhook 地址）`);
  }
  if (parsed.pathname !== WEBHOOK_PATH) {
    return fail('bad_config', `webhook 的路径必须是 ${WEBHOOK_PATH}`);
  }
  const key = parsed.searchParams.get('key')?.trim() ?? '';
  if (key === '') return fail('bad_config', 'webhook 里没有 key（复制地址时把 key= 那一段一起复制）');
  return { ok: true, url: text };
}

/** 一条 webhook 消息的预算：15 秒。比 CLI 那条路短——它是一次普通的 HTTPS POST。 */
/**
 * 群机器人超时（2026-11-12 由 15s 提到 30s）。
 *
 * 实测：日报那张 template_card 偶尔 15 秒回不来（`The operation was aborted due to timeout`），
 * 于是 group_posts 记 failed、告警又跟着响一次。卡片本身不大，是企微侧偶发慢；
 * 30 秒够它回完，又短到 cron 不会堆。
 */
export const WEBHOOK_TIMEOUT_MS = 30_000;

/** 群机器人的正文上限是 4096 字节（企微文档）；超了会被服务端拒。留 200 字节余量。 */
const WEBHOOK_MAX_BYTES = 3900;

/**
 * 往一个人的机器人发一条 markdown。
 *
 * 与 `sendMarkdown`（CLI 那条路）是并联的两条：**同一份正文**、**同一套失败码**，
 * 差别只在传输——这条是一次 HTTPS POST，不需要 `wecom-cli`、不需要通讯录、不需要
 * 授权。所以一个人的机器人坏了，最多是这个人收不到，不会牵连别人。
 *
 * 成功信号是 `errcode === 0`（企微的 webhook 在有业务错误时也是 **HTTP 200**）。
 * 失败时把 `errmsg` 原文带出来（`invalid webhook url` / `rate limited` 这类话是唯一
 * 能搜到答案的线索），并把 URL 里的 key 抹掉——错误信息会进 `notify_deliveries.error`
 * 与界面。
 */
export async function sendWebhook(
  webhook: string,
  content: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ ok: true } | WecomFail> {
  const checked = checkWebhook(webhook);
  if (!checked.ok) return checked;

  const timeoutMs = positive(opts.timeoutMs, WEBHOOK_TIMEOUT_MS);
  const doFetch = opts.fetchImpl ?? fetch;
  const body = JSON.stringify({
    msgtype: 'markdown',
    markdown: { content: clipBytes(content, WEBHOOK_MAX_BYTES) },
  });

  /**
   * 一次重试（2026-11-12）：服务器到 qyapi 的 DNS 会偶发抖动（实测 3 次里 1 次解析超时），
   * 于是「其实没事」的一条播报被记成 failed、再触发一条告警——噪音叠噪音。
   * 只在**根本没拿到响应**（连接/DNS/超时）时重试一次；拿到 HTTP 响应就不重试，
   * 否则会把一条已经发出去的消息再发一遍。
   */
  let response: Response | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await doFetch(checked.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (response === null) {
    return fail('cli_failed', `发到机器人失败：${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }
  try {
    const text = await response.text();
    if (!response.ok) {
      return fail('cli_failed', `机器人的接口回了 HTTP ${response.status}：${tail(text) || '（没有正文）'}`);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return fail('bad_output', `机器人的接口回了非 JSON：${tail(text)}`);
    }
    const record = typeof payload === 'object' && payload !== null
      ? payload as Record<string, unknown>
      : {};
    const errcode = errcodeOf(record);
    if (errcode === 0) return { ok: true };
    const errmsg = typeof record.errmsg === 'string' ? redact(record.errmsg) : '';
    return fail('errcode', `企业微信机器人报错 ${errcode ?? '?'}：${errmsg || '（没有给 errmsg）'}`);
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      return fail('timeout', `发到机器人超时：等了 ${Math.round(timeoutMs / 1000)} 秒没回`);
    }
    const message = error instanceof Error && error.message !== '' ? error.message : String(error);
    return fail('cli_failed', `发到机器人失败：${redact(message)}`);
  }
}

/** 按**字节**截断（中文一个字 3 字节，按字符数截会超）。 */
function clipBytes(text: string, max: number): string {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= max) return text;
  let out = text;
  while (Buffer.byteLength(out, 'utf8') > max - 1) out = out.slice(0, -1);
  return `${out}…`;
}
