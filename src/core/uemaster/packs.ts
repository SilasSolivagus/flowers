import { AppError } from '../errors.js';
import { typeLabel } from '../requirements/type.js';

/**
 * 三处产物槽位的名字。
 *
 * 这三个值是**库里的 CHECK 约束**（见迁移 `0002_uemaster`）、也出现在事件 payload 里，
 * 所以顺序与拼写都是对外的：加第四个 stage 要同时改迁移、读模型与这里。
 */
export type Stage = 'evaluate' | 'review' | 'inspect';

/** 运行时同样需要这份名单（MCP 工具、读模型），所以它不只是一组类型。 */
export const STAGES = ['evaluate', 'review', 'inspect'] as const satisfies readonly Stage[];

/** 收窄到 Stage。入参是 `unknown` 时先过 `asText`，这里只认精确的三个字面量。 */
export function isStage(value: unknown): value is Stage {
  return typeof value === 'string' && (STAGES as readonly string[]).includes(value);
}

/**
 * 任务包要的输入：需求的身份 + PRD 链接。
 *
 * 为什么要 `id` 与 `requester` 而不只是编号标题：`uemaster_attach` 收的是 uuid
 * （不是 PAN-7），而「复制任务包」那条路（计划 Task 4）里 agent 手里只有这段文本，
 * 没有 MCP 那份结构化的 requirement。少一个字段，agent 就得回头问人。
 */
export type PackInput = {
  id: string;
  number: number;
  title: string;
  /** `commercial` / `feature` / null（Ruling 1：类型可空）。null 时包里写「未指定」。 */
  type: string | null;
  requester: string;
  prdUrl: string | null;
};

type Spec = {
  /** 任务行里的名词：生成<评估材料|评审材料|走查材料>。 */
  noun: string;
  /** 没有 PRD 时这份包还做不做得了。评估做得了（输入是需求本身），走查与评审不行。 */
  needsPrd: boolean;
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
 *
 * 约束行也是三份各写一份，因为评估与评审的输入根本不同：
 * 评估的输入是需求本身（PRD 只是额外依据），所以「推断」是允许的、但必须标注；
 * 评审的输入就是 PRD，没有 PRD 这件事不成立。把它们写成一句话，就会逼出一句
 * 自相矛盾的约束。
 */
const SPEC: Record<Stage, Spec> = {
  evaluate: {
    noun: '评估材料',
    // 评估是加速器不是关卡：它要能在任何一条需求上跑起来，而 prd_url 只有
    // 提交评审那一步才会被写上——inbox / design 的需求根本没有 PRD。
    needsPrd: false,
    output: [
      '  1. 业务流程图：把流程画成一张横平竖直的流程图（用 flow-canvas），',
      '     每个节点写清「谁、做什么、之后去哪里」。',
      '  2. 线框页：流程里每一个「用户会看到的步骤」都要有一张对应的线框页',
      '     （用 flow-walkthrough 的三栏页），页上标出这一步的入口、字段与按钮、以及流向下一步的出口。',
      '  3. 两样放在同一个 HTML 里联动：点左边的流程节点，右边切到对应线框页。',
      '     用途是讨论可行性——「这一步到底有没有页面、这么走通不通」。',
      '  4. 每一处靠推断得来的节点、状态、页面，都在图上标「PRD 未提供」：',
      '     读的人要能一眼分出「需求 / PRD 里写着的」和「你想出来的」两类。',
    ],
    constraint: '约束：材料从这条需求本身出发——PRD 里写了的就照它画；PRD 没写的允许推断，'
      + '但推断出来的东西一律标「PRD 未提供」，不要画成有依据的样子，也不要替需求加它没有的角色或状态。',
  },
  review: {
    noun: '评审材料',
    needsPrd: true,
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
    needsPrd: true,
    output: [
      '  1. 实际实现版：以本项目根目录（Flowers 仓库）里的代码与页面为准——读 src/ 与 app/',
      '     （必要时含 app/components），把真实存在的流程画成流程图 + 每步对应的线框页；',
      '     不要照 PRD 修图，实现跟 PRD 不一样的照实画。',
      '  2. 与 PRD 版的差异清单：基线是本需求已交回的那一版评审材料——',
      '     stage=review 的最新产物，没有就退到 stage=evaluate 的最新产物，',
      '     路径形如 data/uemaster/PAN-7/review.html，先确认这个文件在项目里存在再动手；',
      '     然后同一条流程两边逐节点对比，每条标一个档位——',
      '     一致（两边都有且一样）、缺失（PRD 里有、实现里没有）、溢出（实现里有、PRD 里没写）。',
      '     每条都要带位置：PRD 侧写小节号或原文摘句，实现侧写文件路径或节点编号。',
      '  3. 两版放在同一页、可切换，便于逐节点对比。',
    ],
    constraint: '约束：PRD 版只画 PRD 里写到的内容，实现版只画代码与页面里实际存在的；'
      + '两版都不要替对方补页面、补状态，也不要推测意图，差异一律进差异清单。',
  },
};

const REPO = 'https://github.com/SilasSolivagus/UEmaster';

/** 一行一个事实：标题/类型里的换行会把六段骨架改写掉，先压成单行。 */
function flat(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/**
 * 生成一份自足的任务包。
 *
 * 纯函数、不碰库：调用方（MCP 的 `uemaster_plan`、页面上的「复制任务包」）拿到
 * 文本就直接递给 agent。读这段文字的人（agent）**不知道 Flowers 是什么**，也不
 * 会回来追问，所以每一行都必须自带答案：这条需求是谁的、PRD 在哪、装什么 skill、
 * 产出什么形状、文件写到哪里、拿什么交回来。少任何一段，agent 就会停下来问人
 * ——那正是这套设计要消灭的往返。
 *
 * 没有 PRD 时三份包分两种走法（R-P2-2）：
 * - 评估：**照做**。它的输入是需求本身（编号、标题、类型、提出人），PRD 只是额外
 *   依据；缺 PRD 不是缺件，而是「推断要标注」。
 * - 评审 / 走查：**停**。评审的输入就是 PRD，走查的基线也是 PRD 版产物；没有它
 *   做出来的东西是编的。所以这两份包在缺 PRD 时**不出产出与交付**——留着它们，
 *   一个照做的 agent 就会交回一份猜出来的材料，而一个谨慎的 agent 只能回头问人。
 */
export function packFor(stage: Stage, req: PackInput): string {
  const spec = SPEC[stage];
  // 类型上 stage 已经收窄过，但从 MCP 的 JSON 进来的是 unknown：给一个中文出口，
  // 而不是 TypeError / `undefined.noun`。
  if (!spec) throw new AppError('invalid_stage', '阶段只能是 evaluate、review、inspect 之一');

  const number = flat(String(req.number));
  const title = flat(req.title ?? '');
  const type = typeLabel(req.type);
  const requester = flat(req.requester ?? '');
  const name = `PAN-${number}`;
  const id = flat(req.id ?? '');

  const head = [
    `任务：为 ${name}「${title}」生成${spec.noun}`,
    '输入：',
    `  · 需求：${name}「${title}」；类型：${type}；提出人：${requester}；需求 ID：${id}`,
  ];

  if (req.prdUrl === null && !spec.needsPrd) {
    head.push(
      '  · PRD：未提供 —— 不用等它：评估的输入就是这条需求本身（编号、标题、类型、提出人），',
      '    按常识把流程与页面想出来即可；但每一处没有 PRD 依据的地方都要标「PRD 未提供」。',
    );
  } else if (req.prdUrl === null) {
    // 评审 / 走查缺 PRD：到此为止。刻意不写产出与交付——它们会被当成「照做」的许可。
    return [
      ...head,
      `  · PRD：未提供 —— 没有 PRD 无法生成${spec.noun}。`,
      `停止：到此停止。不要画图、不要生成文件、不要调用 uemaster_attach，也不要凭印象替 PRD 编一份。`
        + `把「缺少 PRD 链接」回报给用户（${name}「${title}」，需求 ID ${id}），`
        + '说明 PRD 到位之后重来一次即可。',
    ].join('\n');
  } else {
    head.push(
      stage === 'evaluate'
        ? `  · PRD：${req.prdUrl}（额外依据：有就照着画，与需求描述冲突时以 PRD 为准）`
        : `  · PRD：${req.prdUrl}`,
    );
  }

  return [
    ...head,
    `技能：UEmaster（${REPO}）的两个 sub-skill：\`flow-canvas\`（画流程图）、`
      + '`flow-walkthrough`（出三栏评审页）。按该仓库 README 把这两个 skill 装好再动手；'
      + '它们是纯提示词 + 排版脚本，不需要模型 key。',
    '产出：',
    ...spec.output,
    `交付：把文件写到本项目根目录下的 data/uemaster/${name}/${stage}.html，`
      + `然后调用 uemaster_attach，把站内路径 /uemaster/${name}/${stage}.html`
      + ` 和需求 ID ${id} 一起交回（工具收的就是以 / 开头的站内路径，或 http(s) 完整链接）。`
      + '文件必须是单个自足的 HTML：样式与脚本内联、不引 CDN、不引任何相对资源，双击就能在浏览器里打开。',
    spec.constraint,
  ].join('\n');
}
