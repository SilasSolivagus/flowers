import { DESCRIPTIVE_FIELDS } from '../requirements/fields.js';
import { STATE_LABEL, type State } from '../state-machine.js';

/**
 * 评估材料**生成前的两道门**（2026-11-10 owner 的两次裁定）。
 *
 * 1. **v1 阶段门**（`evaluateStageLock`，本文件末尾）：评估材料只在「收集」阶段生成。
 *    v1 承诺的那条链是「需求进收集 → 点评估 → 出三栏材料」，所以材料只能产在这条链的
 *    起点上；一条已经过了评估的需求，它的材料应该是在过门之前就有的东西。
 * 2. **六问门**（`evaluateLock`，本文件主体）：三问（场景 / 现状 / 成功口径）没填完，
 *    材料只能靠编。
 *
 * 两道门共用一个出口形状：**一句话（不能生成的理由）或 `null`（可以生成）**。服务层
 * （`startGeneration`）把它抛给按钮那一行，读模型（`read/detail.ts`）把它交给抽屉——
 * 同一个字符串，界面与服务不会各说一句。谁先生效：阶段门在前（见 `detail.ts` 的
 * `evaluateReason` 与 `start.ts` 里那一段的注释）。
 *
 * ── 六问门：挡的是什么
 *
 * ── 这一条挡的是什么
 *
 * 一条六个问题全空的收集需求，今天还是可以被送到「评估」：模型拿到一个标题，于是编出
 * 一套流程、一套页面、一套成功口径。材料看起来很完整——它有图、有线框、有「待确认」
 * 清单——而里面没有一格来自写需求的人。owner 的原话：「如果需求的描述没填写 是需要让
 * 用户先填 才能生成的」。
 *
 * ── 哪三问必填（owner 定的，可被推翻）
 *
 * 必填：谁在什么情况下用（context）／现在怎么做、哪不好（problem）／做成什么样算成功
 * （outcome）。理由：**前三条缺任何一条，材料只能编**——没有角色与入口，图就是一张
 * 无主的框子；没有现状，问题清单只能凭空造；没有成功口径，边界与异常只能靠猜。
 *
 * 不必填：涉及哪些页面／失败空无权限怎么办／这次不做什么。后三问在收集阶段本来就
 * 常常没有（需求刚进来时，页面清单还没人看、异常还没人想），而材料已经把「没写」
 * 当作待确认项列出来——那不是编，那是**如实**说「这一格还没人填」。
 *
 * ── 为什么判据只在这一处
 *
 * 三个消费者：服务层（`startGeneration`，**唯一的真相**：绕过界面的 POST 也走它）、
 * 读模型（`read/detail.ts`，把这一句话交给抽屉，按钮先禁用并写出理由）、以及用例。
 * 界面只是**提前告知**；一个把判据复制到客户端的实现，会在某天让「按钮能点」与
 * 「服务拒绝」说两句不同的话。
 *
 * 这个模块是**纯**的（只 import 一张零依赖的标签表）：`startGeneration` 在服务端 import
 * 它，读模型也在服务端 import 它，将来若要让客户端自己判也不会把 `pg` 拖进浏览器包。
 */

/**
 * 评估生成之前必须写完的三问，顺序就是提示里那句中文的顺序。
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
 * 缺项 → 那句话。**同一句话**同时是服务端的错误原文与界面上按钮旁边那行提示
 * （一个字符串，两个地方用，不会各说各的）。
 *
 * 措辞三件事都要有：缺几条（几秒内判断要不要动）、缺的是哪几条（不用回头找）、
 * 为什么（否则「先补完」只是一个额外的门槛，用户会去别处找捷径）。
 * 一条都不缺 → 空串（调用方按 `''` 判「放行」，不必再判一次 null）。
 */
export function lockMessage(missing: readonly RequiredKey[]): string {
  if (missing.length === 0) return '';
  const names = missing.map(labelOf).join('、');
  return `还差${COUNT_ZH[missing.length] ?? String(missing.length)}条没填：${names}。`
    + '先补完再生成——否则材料只能靠编。';
}

/**
 * 这一条需求的评估能不能生成：不能 → 那句中文；能 → null。
 *
 * 返回 null 而不是空串：这一格会一路传到抽屉（`DetailRef.needsDescription`），
 * 而「没有理由」与「理由是空字符串」在 JSX 里会画出两种东西（第二个会画出一个空的行）。
 */
export function evaluateLock(answer: SixAnswers): string | null {
  const missing = missingRequired(answer);
  return missing.length === 0 ? null : lockMessage(missing);
}

/**
 * v1 承诺的那个起点：**收集**。评估材料只在这个阶段生成。
 *
 * 写成常量而不是在判据里写 `state === 'inbox'`：这句话要能被读模型、服务层、用例
 * 同时引用，而三处各写一个字面量，某一天就会有一处留在旧值上。
 */
export const EVALUATE_STAGE: State = 'inbox';

/**
 * v1 阶段门（2026-11-10，owner 裁决 A）：**不在「收集」阶段，评估材料不许生成**。
 *
 * ── 为什么有这道门
 *
 * `docs/superpowers/plans/2026-11-10-v1-scope.md` 说的 v1 只有一条链：
 * 「需求进收集 → 点评估 → 出三栏材料」。这条链之前的所有条件（六问拆解、页面清单、
 * 时序图、三栏装配、禁词自检）都已经具备，所以**材料是这个阶段该做的事**：一个人
 * 在收集里写完描述、点一次评估，拿到的就是那份材料。
 *
 * 反过来说，一条已经过了门的需求（待设计 / 待评审 / 已上线…）不该再产出一份**新的**
 * 评估材料：
 * - 它的评估**已经发生过**（状态就是从收集走到后面的过程里推进的），再生成一次等于
 *   用今天的描述重画一张当初没人看过的图，而这张图会被当成「当时评审依据的那一份」；
 * - v1 的评估不读代码、也不读评审意见，对一条已经在排期 / 开发里的需求，它能给出的
 *   仍然只是需求描述的三栏推演——读者会以为它是针对现状的（v1 的硬约束一：推演的
 *   时序图必须标「推演」；这条门是同一个担心的上游版本）。
 *
 * 所以：**存量材料照常显示**（老的链接仍然打得开，那是历史），**只有「生成」被关**。
 * 同一个理由也写在读模型里（`DetailRef.needsDescription`），抽屉在点之前就禁用按钮。
 *
 * ── 措辞三件事
 *
 * owner 定的原话，一字不改：**说清规则**（v1 只在收集阶段生成评估材料）、**点名现在
 * 在哪**（用 `STATE_LABEL` 的中文，绝不出现 `design` 这种键）、**给出两条出路**
 * （在收集里新建一条；或先把它退回收集）。
 *
 * ── 不顺手扩大
 *
 * 只作用于评估。评审 / 走查两行由 `FEATURE_REVIEW_MATERIALS` 关着（v1 不承诺），
 * 这条裁定说的是评估材料的阶段，不改那两行、也不给它们加第二道门。
 */
export function evaluateStageLock(state: State): string | null {
  if (state === EVALUATE_STAGE) return null;
  return `v1 只在收集阶段生成评估材料。这条需求现在在「${STATE_LABEL[state]}」`
    + '——想用这个能力，请把描述补在收集里新建一条，或先把它退回收集。';
}
