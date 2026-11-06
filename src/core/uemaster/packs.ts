import { AppError } from '../errors.js';

/**
 * 三处产物槽位的名字。
 *
 * 这三个值是**库里的 CHECK 约束**（见迁移 `0002_*`）、也出现在事件 payload 里，
 * 所以顺序与拼写都是对外的：加第四个 stage 要同时改迁移、读模型与这里。
 */
export type Stage = 'evaluate' | 'review' | 'inspect';

/** 运行时同样需要这份名单（MCP 工具、读模型），所以它不只是一组类型。 */
export const STAGES = ['evaluate', 'review', 'inspect'] as const satisfies readonly Stage[];

/** 收窄到 Stage。入参是 `unknown` 时先过 `asText`，这里只认精确的三个字面量。 */
export function isStage(value: unknown): value is Stage {
  return typeof value === 'string' && (STAGES as readonly string[]).includes(value);
}

/** 任务包只需要需求的身份信息，不需要它现在在哪个状态。 */
export type PackInput = {
  number: number;
  title: string;
  type: string;
  prdUrl: string | null;
};

type Spec = {
  /** 任务行里的名词：生成<评估材料|评审材料|走查材料>。 */
  noun: string;
  /** 「产出」那一段的正文（每行原样拼进去）。 */
  output: string[];
  /** 「约束」那一行的正文。 */
  constraint: string;
};

/**
 * 三份包的差异只有两处：要生成的材料叫什么、产出要什么。
 *
 * 刻意不做成「基础模板 + 追加一句」：三份包各自被一个 agent 单独读，任何一份
 * 都不能靠「同评估材料」这种指代去省字——它手里没有上一份。
 */
const SPEC: Record<Stage, Spec> = {
  evaluate: {
    noun: '评估材料',
    output: [
      '  1. 业务流程图：把 PRD 描述的流程画成一张横平竖直的流程图（用 flow-canvas），',
      '     每个节点写清「谁、做什么、之后去哪里」。',
      '  2. 线框页：流程里每一个「用户会看到的步骤」都要有一张对应的线框页',
      '     （用 flow-walkthrough 的三栏页），页上标出这一步的入口、字段与按钮、以及流向下一步的出口。',
      '  3. 两样放在同一个 HTML 里联动：点左边的流程节点，右边切到对应线框页。',
      '     用途是讨论可行性——「这一步到底有没有页面、这么走通不通」。',
    ],
    constraint: '约束：只画 PRD 里写到的内容；PRD 里没有的页面、状态、角色、分支都不要画、不要补、不要推测。'
      + 'PRD 没写清的地方就留空，并在该节点上写「PRD 未说明」。',
  },
  review: {
    noun: '评审材料',
    output: [
      '  1. 业务流程图 + 每步对应的线框页，两样放在同一个 HTML 里联动（点左边的流程节点，',
      '     右边切到对应线框页），用来把 PRD 完整走一遍——评审就是照着它一步一步过。',
      '  2. 问题清单：把 PRD 走不通、说不清的地方逐条列出来，下面五类都要过一遍——',
      '     死路（走到某个节点之后没有出口）、无页面步骤（流程里有这一步，PRD 却没给页面）、',
      '     缺状态（只写了正常流程，异常/失败/进行中没定义）、歧义词（同一个词在 PRD 里指两样东西）、',
      '     未知角色（某个动作的主语在 PRD 里没有定义）。',
      '     每一条都必须带位置：PRD 侧写小节号或原文摘句，图侧写节点编号，缺一不可。',
      '  3. 问题清单按严重度排序，死路与无页面步骤放最前面。',
    ],
    constraint: '约束：只画 PRD 里写到的内容；PRD 里没有的页面、状态、角色、分支都不要画、不要补、不要推测——'
      + 'PRD 缺的这些东西属于问题清单的条目，不进图。',
  },
  inspect: {
    noun: '走查材料',
    output: [
      '  1. 实际实现版：以现在代码与页面里真实存在的流程为准，画流程图 + 每步对应的线框页；',
      '     不要照 PRD 修图，实现跟 PRD 不一样的地方就照实画。',
      '  2. 与 PRD 版的差异清单：同一条流程两边逐条对比，每条标一个档位——',
      '     一致（两边都有且一样）、缺失（PRD 里有、实现里没有）、溢出（实现里有、PRD 里没写）。',
      '     每条都要带位置：PRD 侧写小节号或原文摘句，实现侧写页面路径或节点编号。',
      '  3. 两版放在同一页、可切换，便于逐个节点对比。',
    ],
    constraint: '约束：PRD 版只画 PRD 里写到的内容，实现版只画代码与页面里实际存在的；'
      + '两版都不要替对方补页面、补状态，也不要推测意图，差异一律进差异清单。',
  },
};

const REPO = 'https://github.com/SilasSolivagus/UEmaster';

/**
 * 生成一份自足的任务包。
 *
 * 纯函数、不碰库：调用方（MCP 的 `uemaster_plan`、页面上的「复制任务包」）拿到
 * 文本就直接递给 agent。读这段文字的人（agent）**不知道 Flowers 是什么**，也不
 * 会回来追问，所以每一行都必须自带答案：PRD 在哪、装什么 skill、产出什么形状、
 * 文件写到哪、拿什么交回来。少任何一段，agent 就会停下来问人——那正是这套设计
 * 要消灭的往返。
 *
 * PRD 为 null 时不省略「输入」行，而是明说没提供、以及没有它不能开工：把缺件
 * 藏起来只会让 agent 自己编一份 PRD，那比卡住更糟。
 */
export function packFor(stage: Stage, req: PackInput): string {
  const spec = SPEC[stage];
  // 类型上 stage 已经收窄过，但从 MCP 的 JSON 进来的是 unknown：给一个中文出口，
  // 而不是 TypeError / `undefined.noun`。
  if (!spec) throw new AppError('invalid_stage', '阶段只能是 evaluate、review、inspect 之一');

  const name = `PAN-${req.number}`;
  const prd = req.prdUrl === null
    ? 'PRD：未提供 —— 没有 PRD 就无法开工：不要凭印象画图或猜需求，先把 PRD 链接要到再动手。'
    : `PRD：${req.prdUrl}`;

  return [
    `任务：为 ${name}「${req.title}」生成${spec.noun}`,
    '输入：',
    `  · ${prd}`,
    `  · 需求：${name}「${req.title}」；类型：${req.type}`,
    `技能：UEmaster（${REPO}）的两个 sub-skill：\`flow-canvas\`（画流程图）、`
      + '`flow-walkthrough`（出三栏评审页）。按该仓库 README 把这两个 skill 装好再动手；'
      + '它们是纯提示词 + 排版脚本，不需要模型 key。',
    '产出：',
    ...spec.output,
    `交付：把生成的文件放到 public/uemaster/${name}/${stage}.html，然后调用 uemaster_attach，`
      + `把站内路径 /uemaster/${name}/${stage}.html 交回来（这个工具收的就是以 / 开头的站内路径，`
      + '或 http(s) 完整链接）。',
    spec.constraint,
  ].join('\n');
}
