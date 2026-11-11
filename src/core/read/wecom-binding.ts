import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  BINDING_LABEL, NEED_INIT_HINT, bindingStateOf, looksUninitialized, maskWebhook,
  type BindingState,
} from '../notify/wecom.js';

/**
 * 设置 · 我的 →「企微」那两行要的全部事实（2026-11-10）。
 *
 * 为什么单独一个读模型：`Member`（`auth/members.ts`）是**权限与身份**用的行，它没有
 * `wecom_lookup_at`（那是「上次试过」的时刻，与权限无关）；而绑定状态需要它才能区分
 * 「从没绑过」和「上次验证失败」。把这一列塞进 `Member`，等于让每个权限判断都多读
 * 一列它不需要的数据。所以这一层只查三个字段，按 id 读一行。
 *
 * 三条铁规矩：
 * 1. **webhook 只给掩码**（`maskWebhook`）。整串等于一个可以往群里发消息的凭证，
 *    进了响应体就等于进了浏览器历史、缓存、截图。
 * 2. **状态是算出来的**（`bindingStateOf`）：`wecom_userid` 非空 = 已绑定；
 *    空 + `wecom_lookup_at` 有过值 = 验证失败；两者都空 = 未绑定。同一件事只有一个
 *    来源（迁移 0038 的注释里写了为什么不加一列状态）。
 * 3. **userid 全给**（不是掩码）：它不是一个秘密——它是「你的工号」，而且**必须**能
 *    看见：绑错了要能当场认出「这不是我」。
 */
export type WecomBindingView = {
  state: BindingState;
  /** 那一行 pill 的字（`已绑定` / `已绑定 · 未激活` / `未绑定` / `验证失败`）。 */
  stateLabel: string;
  /** 未激活时那句可照做的说明；其余状态是 null。 */
  hint: string | null;
  /** 绑着的 userid（没绑是 null）。 */
  userid: string | null;
  /** 自己的机器人：**掩码**后的地址；没设是 null。 */
  webhook: string | null;
  /** 有没有设（与 `webhook` 分开：掩码可能因格式异常退化成一个不完整的串）。 */
  webhookSet: boolean;
  /** 上次验证/查询的日期（`YYYY-MM-DD`，上海）；没试过是 null。失败文案要用它。 */
  lastLookupDay: string | null;
};

/** 上海那一天（`YYYY-MM-DD`）：这一行只说「哪天试过」，不说到秒。 */
function shanghaiDay(at: Date | string | null): string | null {
  if (at === null) return null;
  const date = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

/** 读一行；成员不存在时给「未绑定」的空视图（页面不该为一行不存在的成员白屏）。 */
export async function wecomBindingView(memberId: string): Promise<WecomBindingView> {
  const res = await db.execute<{
    wecom_userid: string | null;
    wecom_lookup_at: Date | string | null;
    wecom_webhook: string | null;
  }>(sql`
    select wecom_userid, wecom_lookup_at, wecom_webhook
      from members where id = ${memberId} limit 1`);
  const row = res.rows[0];
  if (row === undefined) {
    return {
      state: 'unbound', stateLabel: BINDING_LABEL.unbound, userid: null, hint: null,
      webhook: null, webhookSet: false, lastLookupDay: null,
    };
  }
  const userid = typeof row.wecom_userid === 'string' && row.wecom_userid.trim() !== ''
    ? row.wecom_userid.trim()
    : null;
  let state = bindingStateOf({ wecomUserId: userid }, row.wecom_lookup_at);
  // 已绑定但一条没发出去过、最近一次还是 853008 → 未激活（见 `BindingState`）。
  if (state === 'bound') {
    const last = await db.execute<{ status: string; error: string | null }>(sql`
      select status, error from notify_deliveries
       where member_id = ${memberId} and channel = 'wecom'
       order by created_at desc limit 1`);
    const latest = last.rows[0];
    if (latest !== undefined && latest.status === 'failed' && looksUninitialized(latest.error)) {
      state = 'need_init';
    }
  }
  const webhookSet = typeof row.wecom_webhook === 'string' && row.wecom_webhook.trim() !== '';
  return {
    state,
    stateLabel: BINDING_LABEL[state],
    hint: state === 'need_init' ? NEED_INIT_HINT : null,
    userid,
    webhook: maskWebhook(row.wecom_webhook),
    webhookSet,
    lastLookupDay: shanghaiDay(row.wecom_lookup_at),
  };
}
