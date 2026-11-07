import { sql } from 'drizzle-orm';

import type { Db } from '../../db/client.js';
import type { LocateResult } from './types.js';

/**
 * 每次定位记一条账（`locate_runs`）。
 *
 * 第一版**不设门槛、不判对错**：这一层的唯一用途是攒真实案例，够 30 条再去定
 * 「多少算准」。所以这里做的事只有一件——把「这次定位属于三种里的哪一种」写成一个
 * 库能统计的值，而不是服务里的一个对象。攒数期间最怕的不是记错一行（可改），而是
 * 三种情况在库里长得一样：那 30 条攒完仍然说不出准确率。
 */

/**
 * `locate_runs.outcome` 的词表。
 *
 * 注意它与 `LocateResult['kind']` **不是同一套词**：库里第三个值是 `low`（候选但不确定），
 * 而结果类型里是 `candidates`。两个词各自都有道理——类型描述的是「这次查找产出了什么」，
 * 库那一列描述的是「这次查找的结论有多硬」（`none` 是结论，`low` 只是线索，`absent`
 * 是没看见）。把两套词合成一套，等于让「有候选」和「候选多可信」挤进同一个字段。
 */
type Outcome = 'absent' | 'none' | 'low';

/**
 * 一轮一案的分仓明细，原样进 `locate_runs.detail`（jsonb）。
 *
 * 键是仓 id，值是该仓这一轮的 `kind` 与（仅 `absent` 时）原因原句。
 * 形状与库里的列一致：`{"repos":{"123pan-pc":{"kind":"absent","why":"…"}}}`。
 *
 * 为什么 `why` 必须逐字进库（2026-11-07 修复二波，推翻「一轮一行、不留细节」）：
 * 合出来的 `why` 是「仓 id：原句」拼成的一句话，那是给 PM 看的文案；**句子不进库，
 * 读回来就没了**。而「哪个仓没读到」正是以后要拿去催运维的那条线索。
 */
export type LocateDetail = {
  repos: Record<string, { kind: LocateResult['kind']; why?: string }>;
};

/**
 * kind → outcome，**显式写全**，不写成 `result.kind as Outcome`。
 *
 * 强转能通过编译（`candidates` 也在字符串里），但会往库里写一个不存在的 outcome：
 * 它读起来不像错误，只是让 `outcome = 'low'` 的那一档永远是 0，而准确率的分母
 * 悄悄少了一类。写成 `Record<LocateResult['kind'], Outcome>` 之后，`kind` 以后
 * 长出第四支时**编译就会失败**（Record 缺键），而不是先上线、再在某次统计里发现
 * 少了一档。
 *
 * 为什么不用 `switch` + `default`：`default` 分支是可选的，删掉它也能编译，
 * 而「漏了一支」正是这里唯一要挡的错。Record 没有可以省略的兜底。
 */
const OUTCOME_BY_KIND: Record<LocateResult['kind'], Outcome> = {
  absent: 'absent',
  none: 'none',
  candidates: 'low',
};

/**
 * 记一条。
 *
 * `hit` 写 `null`：这个值回答「这条线索后来被研发确认是对的吗」，而**写这一行的
 * 那一秒我们无从知道**——候选是人去确认的。它由评估那一步回填。这里若先填一个
 * `false`，「还没评」就会被算成「评错了」，准确率的分母里从此混着没评过的行。
 *
 * `detail` 是**可选**的：给得出分仓明细的调用点（走查一轮两仓）写进去，给不出的
 * （评审那一轮只有一个合起来的结论）就留 null。null 的语义是「这一行没有分仓信息」，
 * 与「两仓都全见」不是一回事，所以统计脚本必须把 null 单独一档，不许当 0 处理。
 *
 * 失败一律往上抛（不 try/catch、不降级成一条「记不上就算了」的日志）：这一层不产生
 * 业务结论，没有可以退回去的地方；而一次静默丢失在攒数阶段是不可见的——报告里只会
 * 显示「案例比预期少几条」，没有人会去数应该有多少条。
 */
export async function recordLocate(
  db: Db,
  input: {
    requirementId: string | null;
    stage: 'inspect' | 'review';
    result: LocateResult;
    detail?: LocateDetail | null;
  },
): Promise<void> {
  const { result } = input;

  // 候选数只在真的拿到候选时才有意义。`absent` / `none` 一律 0，而且**必须**是 0
  // 而不是 null：统计要能放心 `avg(candidates)`，两种「没有」在这里不需要再分。
  const candidates = result.kind === 'candidates' ? result.items.length : 0;

  // 显式 `JSON.stringify` 再 `::jsonb`：让绑定参数永远是文本或 null，不指望驱动的
  // 对象序列化（那是一条隐式约定，`pg` 与将来任何驱动都可能不一样）。
  const detail = input.detail === undefined || input.detail === null
    ? null
    : JSON.stringify(input.detail);

  await db.execute(sql`
    insert into locate_runs (requirement_id, stage, outcome, candidates, hit, detail)
    values (${input.requirementId}, ${input.stage}, ${OUTCOME_BY_KIND[result.kind]},
            ${candidates}, null, ${detail}::jsonb)`);
}
