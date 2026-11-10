import { DESCRIPTIVE_FIELDS } from './fields.js';

/**
 * 立项前的**六问**：判据、缺项、那一句话，全仓库只有这一份。
 *
 * ── owner 的裁决（2026-11-11，推翻 2026-11-10 的三问版本）
 *
 * 第一版只把核心三问做成硬门，理由是「收集 244 条里只有 1 条六问全齐，卡六问等于
 * 上线即空转」。上线第二天 owner 改了口径：**六问全必填**。
 *
 * ```
 * 必填  context 谁在什么情况下用 · problem 现在怎么做 / 哪不好 · outcome 做成什么样算成功
 *       surfaces 涉及哪些页面 / 入口 · edgeCases 失败 / 空 / 无权限怎么办 · outOfScope 这次不做什么
 * ```
 *
 * 为什么改：后三问不是「补充说明」，它们各自决定材料里的一整块——没有页面清单，
 * 流程图会画出不存在的入口；没有异常处理，边界与空态只能靠猜；没有「不做什么」，
 * 范围会在评审时膨胀。三问版放过的那 260 条，最后都要在评审或返工时补回来。
 *
 * 代价写在明处：生产库 261 条收集需求现在一条都过不了这道门（迁移只把 Flower 的
 * 一段描述塞进了 `context`，其余五格是空的）。这是有意的——它们本来就该补完再立项。
 *
 * ── 为什么判据单独一个模块（而不是留在 `uemaster/gate.ts`）
 *
 * 这道门现在挂在**状态变迁**上（`inbox → design` 的 `guard: 'brief'`，见
 * `src/core/state-machine.ts`），而状态机是核心协议、被界面与其他服务普遍 import。
 * 它不能反向依赖 `uemaster/*`（那一条会拖进 db、拖进生成管线，还会绕成一个环），
 * 所以判据与那句话下沉到这里：**零依赖**（只 import 一张零依赖的标签表），
 * 三个消费者才能共用同一份：
 *
 * 1. 状态机（`assertGuards`）：点立项触发的那条迁移（`inbox → design`，trigger `approve`）；
 * 2. 生成前（`uemaster/start.ts`）：六问不齐连作业都不落——否则等于先烧一次模型调用
 *    再让迁移失败；
 * 3. 读模型（`read/detail.ts`）：抽屉那一行按钮先禁用并写出理由，用的是**同一个字符串**。
 *
 * 一个把判据复制到客户端或另写一句的实现，会在某天让「按钮能点」与「服务拒绝」
 * 说两句不同的话。
 *
 * ── 为什么门在变迁上，而不在生成器上
 *
 * 立项**是一个动作**（收集 → 待设计），材料是**另一个动作**的产物（2026-11-10 起彻底
 * 分开：生成不改状态）。把门只装在生成器上，挡的是「不许出材料」，而「没有六问的需求
 * 照样能立项」这件事会从别的入口漏过去（MCP 的 `requirement_start_design`、将来的
 * 批量导入）。装在那条边上，全部入口一次覆盖：**没有六问，就没有立项**。
 */

/**
 * 立项 / 生成评估材料之前必须写完的**六问**，顺序就是提示里那句中文的顺序。
 *
 * ── 2026-11-11 的改动：三问 → 六问（owner 的口径）
 *
 * 原来只有核心三问是硬门，理由是「收集里 244 条只有 1 条六问全齐，卡六问等于上线即
 * 空转」。上线第二天 owner 拍了：**六问全必填**。所以现在后三问（涉及哪些页面、
 * 失败/空/无权限、这次不做什么）也是门，缺任何一条都过不去。
 *
 * 代价是清楚的：生产库里 261 条收集需求现在一条都过不了这道门（迁移只把 Flower 的
 * 一段描述塞进了 `context`，其余五格是空的）。这是有意为之——它们本来就该在补完
 * 六问之后才立项，而不是带着一句描述往下走。
 *
 * 顺序有讲究：它同时是「还差六条没填：…」里那串标签的顺序。写成 `Set` 或按存储顺序，
 * 同一份缺项会有两种说法，用户与用例就会各记一种。
 */
export const REQUIRED_BEFORE_EVALUATE = [
  'context', 'problem', 'outcome', 'surfaces', 'edgeCases', 'outOfScope',
] as const;

export type RequiredKey = typeof REQUIRED_BEFORE_EVALUATE[number];

/**
 * 六问的值（null / 空串都算没写，与指纹的归一一致）。
 *
 * 六问全部参与判据（2026-11-11 起），但类型里仍然**全部可选**：`createRequirement`
 * 允许先建一条再补（真实需求常常如此），门只装在「立项」与「生成」两个动作上。
 */
export type SixAnswers = {
  context?: string | null;
  problem?: string | null;
  outcome?: string | null;
  surfaces?: string | null;
  edgeCases?: string | null;
  outOfScope?: string | null;
};

/** 「还差**几**条」里的那个数字：中文数词，跟条数走。 */
const COUNT_ZH: Record<number, string> = { 1: '一', 2: '两', 3: '三', 4: '四', 5: '五', 6: '六' };

/**
 * 标签从 `DESCRIPTIVE_FIELDS` 来（唯一来源），只把 `/` 两边的空格去掉：
 * 表单上是「现在怎么做 / 哪不好」（留白读起来不挤），而这句话读起来要像一句中文。
 */
function labelOf(key: RequiredKey): string {
  const field = DESCRIPTIVE_FIELDS.find((f) => f.key === key);
  return (field?.label ?? key).replace(/\s*\/\s*/g, '/');
}

/** 缺了哪几问（key，按 `REQUIRED_BEFORE_EVALUATE` 的顺序）。全齐 → 空数组。 */
export function missingRequired(answer: SixAnswers): RequiredKey[] {
  return REQUIRED_BEFORE_EVALUATE.filter((key) => (answer[key] ?? '').trim() === '');
}

/**
 * 缺项 → 那句话。**同一句话**同时是状态机抛出的错误原文、生成前的拒绝理由、以及
 * 抽屉里按钮旁边那行提示（一个字符串，四个地方用，不会各说各的）。
 *
 * 措辞三件事都要有：缺几条（几秒内判断要不要动手）、缺的是哪几条（不用回头找）、
 * 为什么门在这里（否则「先补完」只是一个额外的门槛，用户会去别处找捷径）。
 *
 * ── 只说完能做到的事（2026-11-10 owner 的第二次裁定）
 *
 * 这句话曾经在**阶段门**那边带过一句「或先把它退回收集」——那是空头支票：状态机里
 * 没有「待设计 → 收集」这条边（见 `TRANSITIONS`），照着做会撞一句「不能从「待设计」
 * 直接到「收集」」。这里给的那一步是**真的能做**的：抽屉里那张六问表单就在同一个
 * 页面的 `?edit=1` 后面，补完再回来点。所以这里只说「补完才能立项，也才能出评估
 * 材料」，并说清为什么（这三问站不住，立项就是空的；材料只能按它画）。
 *
 * ── 一句话为什么点名两件事（2026-11-10 的第二次纠正之后）
 *
 * 立项与生成材料已经拆成两个动作（`state-machine.ts` 的 trigger `approve` 与
 * `uemaster/attach.ts` 的「不再改状态」），但**它们要的是同一份东西**：六问。
 * 立项要用它说明「这件事站得住」，生成要用它画图与页面。拆开之后如果有人以为
 * 「反正不立项，随便出份材料看看」——那句话会告诉他不成立：缺三问，材料也不出
 * （`start.ts` 在落作业之前拿同一个函数问一次）。
 *
 * 所以这句话**不能**只说「补完才能立项」：那样「生成材料」那道门就没有名字，
 * 用户点生成被拒时读到一句只在讲立项的话。两件事一起点名，一句话仍然只说一个理由
 * （缺的是同一格，补它也是同一个地方）。
 */
export function lockMessage(missing: readonly RequiredKey[]): string {
  if (missing.length === 0) return '';
  const names = missing.map(labelOf).join('、');
  return `还差${COUNT_ZH[missing.length] ?? String(missing.length)}条没填：${names}。`
    + '补完才能立项，也才能出评估材料——立项要拿这六问站住，材料要按这六问画，缺了只能靠编。';
}

/**
 * 这一条需求的六问齐不齐：不能 → 那句中文；能 → null。
 *
 * 返回 null 而不是空串：这一格会一路传到抽屉（`DetailRef.needsDescription`），
 * 而「没有理由」与「理由是空字符串」在 JSX 里会画出两种东西（第二个会画出一个空的行）。
 */
export function evaluateLock(answer: SixAnswers): string | null {
  const missing = missingRequired(answer);
  return missing.length === 0 ? null : lockMessage(missing);
}
