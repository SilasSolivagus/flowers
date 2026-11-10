import { DESCRIPTIVE_FIELDS } from './fields.js';

/**
 * 立项前的**核心三问**：判据、缺项、那一句话，全仓库只有这一份。
 *
 * ── owner 的裁决（2026-11-10，记录在 `state-machine.ts` 与报告里）
 *
 * 「六问不齐不能立项」：收集阶段必须填好核心三问才能点立项；点了立项就进待设计，
 * 所以「六问不齐」既不能生成材料、也不能进待设计。存量数据同一规则，但**已过立项的
 * 状态一律不动**（见 `scripts/migrate-brief-to-inbox.ts`）。
 *
 * 被否决的选项是「六问全齐」：实测收集 244 条里只有 1 条六问全齐（后三格在收集阶段
 * 本来就填不出来），卡它会等于上线即空转。所以必填只取三条：
 *
 * ```
 * 必填      context 谁在什么情况下用
 *           problem 现在怎么做 / 哪不好
 *           outcome 做成什么样算成功
 * 不必填    surfaces / edge_cases / out_of_scope
 * ```
 *
 * 理由：**前三条缺任何一条，材料只能编**——没有角色与入口，图就是一张无主的框子；
 * 没有现状，问题清单只能凭空造；没有成功口径，边界与异常只能靠猜。后三问在收集阶段
 * 常常还没有（页面清单没人看、异常没人想），而材料已经把「没写」当作待确认项列出来
 * ——那不是编，那是如实说「这一格还没人填」。
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
 * 立项 / 生成评估材料之前必须写完的三问，顺序就是提示里那句中文的顺序。
 *
 * 顺序有讲究：它同时是「还差三条没填：…」里那串标签的顺序。写成 `Set` 或按存储顺序，
 * 同一份缺项会有两种说法，用户与用例就会各记一种。
 */
export const REQUIRED_BEFORE_EVALUATE = ['context', 'problem', 'outcome'] as const;

export type RequiredKey = typeof REQUIRED_BEFORE_EVALUATE[number];

/**
 * 六问的值（null / 空串都算没写，与指纹的归一一致）。
 *
 * 后三问也留在类型里：它们**不参与**判据，但读模型传下来的是整行六问，而调用方
 * （以及用例）需要能不写它们。把它们从类型里删掉，只会让每一处调用都多一次对象
 * 重建——那是一次没有收益的搬砖。
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
const COUNT_ZH: Record<number, string> = { 1: '一', 2: '两', 3: '三' };

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
 * `uemaster/attach.ts` 的「不再改状态」），但**它们要的是同一份东西**：核心三问。
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
    + '补完才能立项，也才能出评估材料——立项要拿这三问站住，材料要按这三问画，缺了只能靠编。';
}

/**
 * 这一条需求的核心三问齐不齐：不能 → 那句中文；能 → null。
 *
 * 返回 null 而不是空串：这一格会一路传到抽屉（`DetailRef.needsDescription`），
 * 而「没有理由」与「理由是空字符串」在 JSX 里会画出两种东西（第二个会画出一个空的行）。
 */
export function evaluateLock(answer: SixAnswers): string | null {
  const missing = missingRequired(answer);
  return missing.length === 0 ? null : lockMessage(missing);
}
