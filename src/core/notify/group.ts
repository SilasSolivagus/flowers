import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { readSetting, writeSetting } from '../uemaster/settings.js';
import { checkWebhook, sendWebhook } from './wecom.js';

/**
 * 群播报（2026-11-10）：**需求状态变动**发到团队群。
 *
 * ── 它要回答的问题
 *
 * 「这条需求现在走到哪了」不再靠人问。七种动静进群：认领、进待设计、提交评审、
 * 进待排期、被拒绝、被搁置、已上线（`auto_live`，同时一句「请验收」）。回滚也进——
 * 它同样是「这条需求的动静」，漏掉它群里就会以为那版还发着。
 *
 * ── 为什么不复用 `notify/delivery` 那一套
 *
 * 那一套是**一人一条**：主角是「谁该被打断」，所以有口味三档、每人每轮 5 条、
 * userid 解析。群播报没有收件人：它是一条公告，发一次，谁在群里谁看见。混进同一张表
 * 会让「谁收到」这个语义分叉（member_id 可空 + 唯一索引改形状），也会把「每人限流」
 * 那条规则错误地套到公告上。所以台账单独一张（`group_posts`），发的是群机器人 webhook。
 *
 * ── 去重与顺序
 *
 * `(kind, ref)` 唯一：`evt:<seq>` 一条事件播一次。先落 pending 再发（发送收不回来），
 * 失败改 failed、下一轮按原样重发。**一轮合成一条消息**（最多 `BATCH_MAX` 条事件），
 * 不逐条刷屏——那 20 条/分钟的群机器人频控就是为这种场景设的。
 */

/** 会进群的事件类型。顺序 = 消息里希望出现的顺序（越靠前越像「有进展」）。 */
export const GROUP_EVENT_TYPES = [
  'requirement.owner_assigned',
  'requirement.evaluated',
  'requirement.review_requested',
  'requirement.review_passed',
  'requirement.rejected',
  'requirement.shelved',
  'requirement.auto_live',
  'requirement.rolled_back',
  // 恢复（2026-11-12）：搁置回来也是状态变动，群里要能看见——之前漏了，吕品把
  // PAN-181 从搁置恢复时群里一声不响。
  'requirement.restored',
] as const;

export type GroupEventType = (typeof GROUP_EVENT_TYPES)[number];

/** 一轮最多播几条。群机器人有频控，且一次刷 30 条等于没人看。 */
export const BATCH_MAX = 10;

/** 台账里 `GROUP_EVENT_TYPES` 的 kind。 */
export const KIND_EVENTS = 'events';
export const KIND_DAILY = 'daily';

/** 群 webhook 存在 `app_settings` 的这个键上（与生成器命令同一张表）。 */
export const GROUP_WEBHOOK_SETTING = 'notify.groupWebhook';
/** 消息里链接的站址；没配置时给本机地址（群里点得到的前提是同一个网络）。 */
export const PUBLIC_URL_SETTING = 'app.publicUrl';

/**
 * 起始水位：开启播报那一刻的 `events.seq`。
 *
 * 没有它，第一次跑会把库里**全部历史事件**补播一遍（814 条需求的立项、评审…），
 * 群里会被几百条旧消息刷穿。所以要先 `--init` 记一个水位，之后只播它之后的事件。
 */
export const GROUP_WATERMARK_SETTING = 'notify.groupWatermark';

export async function readWatermark(db: Db): Promise<number> {
  const raw = await readSetting(db, GROUP_WATERMARK_SETTING);
  const value = Number(raw ?? 0);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export async function writeWatermark(db: Db): Promise<number> {
  const max = (await db.execute<{ n: number }>(sql`select coalesce(max(seq), 0)::int as n from events`)).rows[0]?.n ?? 0;
  await writeSetting(db, GROUP_WATERMARK_SETTING, String(max));
  return Number(max);
}

/**
 * 企微群机器人地址的形状：`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<密钥>`。
 *
 * `key` 实测是 36 位带连字符的 UUID（少数老机器人是 43 位），所以下限取 20：
 * 比这短的多半是把文档里的 `key=…` 直接粘了过来——那是占位符，不是地址。
 */
const WEBHOOK_SHAPE = /^https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=[\w-]{20,}$/;

/** 本地回显端点：只给「不往真群发、验证一下渲染与投递」用（见 saveGroupWebhook 的注释）。 */
const LOCAL_ECHO = /^http:\/\/(127\.0\.0\.1|localhost)(:\d{2,5})?\//;

export function looksLikeGroupWebhook(url: string): boolean {
  const text = url.trim();
  return WEBHOOK_SHAPE.test(text) || LOCAL_ECHO.test(text);
}

/** 告警专用的群机器人（2026-11-12）：告警与业务播报分开，免得淹在产品群。 */
export const ALERT_WEBHOOK_SETTING = 'notify.alertWebhook';

/**
 * 告警发到哪：优先 `notify.alertWebhook`（owner 指定），没配才退回群播报那条。
 * 两者都是企微群机器人，形状校验同一套。
 */
export async function readAlertWebhook(db: Db): Promise<string | null> {
  const stored = (await readSetting(db, ALERT_WEBHOOK_SETTING))?.trim() ?? '';
  if (stored !== '') return stored;
  return readGroupWebhook(db);
}

export async function readGroupWebhook(db: Db): Promise<string | null> {
  const stored = await readSetting(db, GROUP_WEBHOOK_SETTING);
  const env = process.env.FLOWERS_GROUP_WEBHOOK;
  const picked = (stored ?? env ?? '').trim();
  return picked === '' ? null : picked;
}

/**
 * 保存群 webhook。**校验形状**再落库：一个拼错/贴错串的 URL 存进去之后，症状是
 * 每条播报都 404 而没人知道该改哪——所以在入口就拒掉，并说清它长什么样。
 */
export async function saveGroupWebhook(db: Db, raw: string): Promise<string> {
  const url = raw.trim();
  if (url === '') throw new Error('群 webhook 不能为空');
  if (!looksLikeGroupWebhook(url)) {
    /**
     * 报错要说清「你给的那串哪里不对」，否则最常见的两种错误（粘了文档里的 `key=…`
     * 占位符、粘成了「添加机器人」页面地址）都只会得到同一句话，然后各自再猜一次。
     */
    const key = url.includes('key=') ? (url.split('key=')[1] ?? '') : '';
    const hint = key === ''
      ? '没找到 key= 参数'
      : `key 只有 ${key.length} 位，像是占位符（真实密钥是 36 位带连字符的串）`;
    throw new Error(
      `这不是企微群机器人 webhook（${hint}）：形如 `
      + 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx；'
      + '本地验证可传 http://127.0.0.1:PORT/（只回显，不往群里发）',
    );
  }
  await writeSetting(db, GROUP_WEBHOOK_SETTING, url);
  return url;
}

/** 只回显末 4 位：整串 webhook 等于一个能往群里发消息的凭证（与成员 webhook 同一条口径）。 */
export function maskWebhook(url: string): string {
  const key = url.split('key=')[1] ?? '';
  return `…${key.slice(-4)}`;
}

export async function publicBaseUrl(db: Db): Promise<string> {
  const stored = (await readSetting(db, PUBLIC_URL_SETTING))?.trim();
  const url = stored !== undefined && stored !== '' ? stored : (process.env.FLOWERS_PUBLIC_URL ?? 'http://localhost:3000');
  return url.replace(/\/+$/, '');
}

export type GroupEventItem = {
  seq: number;
  type: string;
  actor: string;
  requirementId: string;
  number: number;
  title: string;
  payload: Record<string, unknown>;
  /** 提出人：只给「已上线请验收」那一句用。 */
  requester: string | null;
  at: string;
};

/** 事件的中文名（与 Flower 的 `EVENT_TYPE_LABELS` 同一层：播报抬头那一行）。 */
const EVENT_LABEL: Record<GroupEventType, string> = {
  'requirement.owner_assigned': '需求认领',
  'requirement.evaluated': '立项',
  'requirement.review_requested': '提交评审',
  'requirement.review_passed': '评审通过',
  'requirement.rejected': '需求拒绝',
  'requirement.shelved': '需求搁置',
  'requirement.auto_live': '版本上线 · 待验收',
  'requirement.rolled_back': '回滚',
  'requirement.restored': '需求恢复',
};

/** 颜色：进展用 info(绿)，坏消息用 warning(橙红)，其余 comment(灰)。与 Flower 同一套语义。 */
const EVENT_TONE: Record<GroupEventType, 'info' | 'warning' | 'comment'> = {
  'requirement.owner_assigned': 'comment',
  'requirement.evaluated': 'info',
  'requirement.review_requested': 'comment',
  'requirement.review_passed': 'info',
  'requirement.rejected': 'warning',
  'requirement.shelved': 'warning',
  'requirement.auto_live': 'info',
  'requirement.rolled_back': 'warning',
  'requirement.restored': 'comment',
};

/** 状态的中文名：`payload.from` / `payload.to` 是状态键，播报里要写「待评审 → 待排期」。 */
const STATE_TEXT: Record<string, string> = {
  inbox: '收集', design: '待设计', review: '待评审', queue: '待排期', ready: '待开发',
  dev: '开发中', test: '测试中', live: '已上线', rejected: '已拒绝', shelved: '已搁置',
};

/** 播报里的产品名。Flower 抬头写产品名；这里是单团队部署，写死一个口径。 */
export const GROUP_PRODUCT_NAME = '123云盘';

/** 事件时间：`MM-DD HH:mm`（上海）。与 Flower 的 `formatMinute` 同一个形状。 */
export function eventTimeText(raw: string): string {
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return '';
  const text = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(at);
  return text.replace(/\//g, '-');
}

/**
 * 一条事件 → 一条消息，**逐字照 Flower 的「默认 · 事件推送」模板**：
 *
 * ```text
 * <font color="info">评审通过</font><font color="comment"> · 123云盘</font>
 * **[PAN-5 权益套餐产品结构改造](http://…/?open=…）**
 * > 状态　<font color="comment">待评审</font> → <font color="info">待排期</font>
 * <font color="comment">吕品 · 11-10 18:40</font>
 * ```
 *
 * 三个细节都不能省，否则与 Flower 群里那几条长得不一样：
 * 1. 抬头是「彩色事件名 + 灰色产品名」，不是加粗标题；
 * 2. 状态变化那一行用全角空格分隔「状态」与旧值，旧值灰、新值彩色；
 * 3. 末行是「谁 · 什么时候」，灰色、不带标签。
 *
 * 「状态」那一行只在有 `from`/`to` 时出现；原因（拒绝 / 搁置 / 回滚）另起一行，
 * 与 Flower 的 `detail` 一样是引用行。
 */
export function renderEventMessage(item: GroupEventItem, baseUrl: string): string | null {
  const type = item.type as GroupEventType;
  const label = EVENT_LABEL[type];
  if (label === undefined) return null;

  const tone = EVENT_TONE[type];
  const key = `PAN-${item.number}`;
  const url = `${baseUrl}/?open=${item.requirementId}`;
  const lines: string[] = [
    `<font color="${tone}">${label}</font><font color="comment"> · ${GROUP_PRODUCT_NAME}</font>`,
    `**[${key} ${item.title}](${url})**`,
  ];

  const from = typeof item.payload.from === 'string' ? item.payload.from : null;
  const to = typeof item.payload.to === 'string' ? item.payload.to : null;
  const fromText = from === null ? '空' : (STATE_TEXT[from] ?? from);
  const toText = to === null ? '空' : (STATE_TEXT[to] ?? to);

  // 认领没有状态变化（inbox → inbox），它变的是负责人：抬头那句已经说了谁认领，
  // 这里再补一行「负责人」——与 Flower 的 `changes` 一样，只写变了的那一格。
  if (type === 'requirement.owner_assigned') {
    /**
     * 认领/转交（2026-11-11 修正）：旧文案把「谁操作的」当成「改成了谁」，旧值还写成
     * 字面的「原负责人」——于是「房超把负责人改成吕品」被播成「原负责人 → 房超」。
     * 正确写法：`from` → `to`（都来自 payload），`actor` 只在末行署名。
     */
    const oldOwner = typeof item.payload.from === 'string' && item.payload.from.trim() !== ''
      ? item.payload.from
      : '空';
    const newOwner = typeof item.payload.to === 'string' && item.payload.to.trim() !== ''
      ? item.payload.to
      : item.actor;
    lines.push(`> 负责人　<font color="comment">${oldOwner}</font> → <font color="info">${newOwner}</font>`);
  } else if (from !== null || to !== null) {
    // 两个都没有就不画这一行（2026-11-11）：原来硬画成「空 → 空」，读者只会问
    // 「什么是空到空」。没有状态可说的播报（导入、认领之后的评审通过）不该自带一行噪音。
    lines.push(`> 状态　<font color="comment">${fromText}</font> → <font color="${tone}">${toText}</font>`);
  }

  const reason = typeof item.payload.reason === 'string' && item.payload.reason.trim() !== ''
    ? item.payload.reason.trim()
    : null;
  if (reason !== null) lines.push(`> ${reason}`);

  // 已上线那条要催验收：与「状态」同一段，不提人名的播报没人会去验收。
  if (type === 'requirement.auto_live' && item.requester !== null && item.requester !== '') {
    lines.push(`> 请提出人 ${item.requester} 验收`);
  }

  const actor = item.actor === 'system' ? '系统' : item.actor;
  lines.push(`<font color="comment">${actor} · ${eventTimeText(item.at)}</font>`);
  return lines.join('\n');
}

/** 群机器人卡片消息的形状（Flower 的 `template_card` / text_notice）。 */
export type TextNoticeCard = {
  title: string;
  desc: string;
  source: { desc: string; desc_color: number };
  emphasis: { title: string; desc: string } | null;
  stats: Array<{ keyname: string; value: string }> | null;
  quote: { title: string; quote_text: string } | null;
  jumps: Array<{ title: string; url: string }>;
  action: { url: string };
};

/**
 * 发一张 text_notice 卡片。
 *
 * 为什么不能拿 markdown 拼出同样的效果：Flower 的研发日报是**模板卡片**——一张带
 * 大号关键数据、横排统计、引用区和跳转按钮的卡片。markdown 做不出那三块版式，
 * 而 owner 要的是「跟群里原来那张一模一样」。
 */
export async function sendGroupCard(
  webhook: string, card: TextNoticeCard, opts: { fetchImpl?: typeof fetch } = {},
): Promise<{ ok: true } | { ok: false; message: string }> {
  const checked = checkWebhook(webhook);
  if (!checked.ok) return { ok: false, message: checked.message };

  const body = JSON.stringify({
    msgtype: 'template_card',
    template_card: {
      card_type: 'text_notice',
      source: card.source,
      main_title: { title: card.title, desc: card.desc },
      ...(card.emphasis === null ? {} : { emphasis_content: { title: card.emphasis.title, desc: card.emphasis.desc } }),
      ...(card.stats === null ? {} : { horizontal_content_list: card.stats }),
      ...(card.quote === null ? {} : { quote_area: { type: 0, title: card.quote.title, quote_text: card.quote.quote_text } }),
      jump_list: card.jumps.map((jump) => ({ type: 1, title: jump.title, url: jump.url })),
      card_action: { type: 1, url: card.action.url },
    },
  });

  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const response = await doFetch(checked.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { ok: false, message: `机器人回了非 JSON：${text.slice(0, 120)}` };
    }
    const errcode = typeof parsed.errcode === 'number' ? parsed.errcode : null;
    if (errcode === 0) return { ok: true };
    return {
      ok: false,
      message: `企业微信机器人报错 ${errcode ?? '?'}：${typeof parsed.errmsg === 'string' ? parsed.errmsg : '（没有 errmsg）'}`,
    };
  } catch (error) {
    return { ok: false, message: `发到机器人失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

/** 发一条。失败是数据，不是异常（与 `sendWebhook` 同一口径）。 */
export async function postGroup(
  webhook: string, content: string, opts: { fetchImpl?: typeof fetch } = {},
): Promise<{ ok: true } | { ok: false; message: string }> {
  const got = await sendWebhook(webhook, content, opts);
  return got.ok ? { ok: true } : { ok: false, message: got.message };
}

/**
 * 待播的事件：`GROUP_EVENT_TYPES` 里、还没进台账的那些。
 *
 * 用 `not exists` 而不是游标：游标要维护「上次读到哪」，而台账本身就是进度。
 * 上限 `BATCH_MAX`：一轮最多播十条，剩下的下一轮。
 */
export async function pendingGroupEvents(
  db: Db, limit = BATCH_MAX, sinceSeq = 0,
): Promise<GroupEventItem[]> {
  const found = await db.execute<{
    seq: number; type: string; actor: string; requirement_id: string;
    number: number; title: string; requester: string; payload: string; at: string;
  }>(sql`
    select e.seq, e.type, e.actor, e.requirement_id, r.number, r.title, r.requester,
           e.payload::text as payload, e.at::text as at
      from events e
      join requirements r on r.id = e.requirement_id
     where e.seq > ${sinceSeq}
       and e.type = any(${sql.param([...GROUP_EVENT_TYPES])}::text[])
       and r.deleted_at is null
       -- 批量事件不播报（2026-11-11）：导入/批量改状态带 payload.batch，
       -- 与站内通知、企微私聊同一条口径（read/notify.ts 的 notBatch）。
       and not (e.payload::jsonb ? 'batch')
       and not exists (
         select 1 from group_posts g
          where g.kind = ${KIND_EVENTS} and g.ref = 'evt:' || e.seq::text
       )
     order by e.seq
     limit ${limit}`);

  return found.rows.map((row) => ({
    seq: Number(row.seq),
    type: row.type,
    actor: row.actor,
    requirementId: row.requirement_id,
    number: Number(row.number),
    title: row.title,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    requester: row.requester,
    at: row.at,
  }));
}
