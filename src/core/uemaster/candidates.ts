/**
 * 生成器候选表：仓库里唯一一份「本机可能装着哪些 CLI」的清单。
 *
 * P2.6 把这件事写成了「claude 优先，否则 codex」——那是**一台机器上的运气**
 * 被写成了产品策略。P2.7 把它换成一个固定的、可读的清单。
 *
 * P2.8 换了这张清单的两个用法（不是它的内容）：
 * - **探测只做标注，不做过滤**（`dropdownOptions`）。P2.7 只列探测到的候选，
 *   于是「这台机器上有什么」被当成了「你能选什么」；用户看不到 WorkBuddy、
 *   Grok Bot 这种还没装的名字，也就不知道还能换。现在七行全列，装没装写在
 *   选项文字后面（`· 已安装` / `· 未安装`），选不选由人定。
 * - **不知道命令的候选不再假装知道**：`workbuddy` / `grokbot` 的 `command` 是空串，
 *   配 `needsCommand` 标记。界面不替它们编一条命令，选了就问一次（一个输入框）。
 *
 * 本文件刻意**不 import 任何 node 内建模块**：它同时被服务端（探测、跑命令）和
 * 客户端（下拉、设置页）读取，而客户端里没有 `node:fs`。纯数据 + 纯函数，
 * 两边共用同一张表、同一套占位符判断、同一套选项顺序。
 */

export type CandidateId =
  | 'claude' | 'codex' | 'dsh' | 'ollama' | 'workbuddy' | 'grokbot' | 'custom';

export type Candidate = {
  id: CandidateId;
  /** 界面上那行左边写的名字。 */
  label: string;
  /**
   * 命令模板。两种形状由**有没有 `{prompt}`** 决定（见 `generator.ts`）：
   * - 有：任务包作为那个 argv 元素传进去（`dsh headless {prompt}`）；
   * - 没有：任务包从 stdin 进（`claude -p`、`codex exec -`、`ollama run x`）。
   *
   * 空串 = 我们**不知道**这条命令，不是「它就是空的」。见 `needsCommand`。
   */
  command: string;
  /** 一句说明。只在这张表、下拉与文档里出现；设置页的行上不写解释。 */
  note: string;
  /** PATH 里要找的可执行文件名；`null` = 不靠 PATH（自建 / 自定义）。 */
  binary: string | null;
  /**
   * 需要用户自己填命令（空串模板）。
   *
   * 两个来源：`workbuddy` / `grokbot` 的 CLI 调用形状我们还不知道（不编），
   * 与「自建 / 自定义」本来就是用户写一条。界面对这一类只有一个动作：
   * 选中之后露出一个输入框，填了才能测、才能存。
   */
  needsCommand: boolean;
};

/**
 * 七个候选。顺序就是表的顺序：先 agent CLI（会自己写文件），再 harness，
 * 再本地模型，再两个待填命令的，最后才是「自己写一条」。
 *
 * `ollama` 的命令里带着 `<模型名>`：它不是「装好就能跑」的那一类，用户得先把
 * 模型名填进去。`commandReady()` 认得这种占位符，所以它会被探测到、会被列出来，
 * 但不会被当成「可以直接跑」的那一个——它需要被改一次。
 *
 * `workbuddy` / `grokbot` 的命令是空串 + `needsCommand: true`：我们不知道它们
 * 怎么被调用，就不写一条猜的。猜出来的命令比空串更糟——它会在第一次真跑时以
 * 一个与生成无关的原因失败（参数不认识、子命令不存在）。
 */
export const CANDIDATES: readonly Candidate[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    command: 'claude -p --permission-mode acceptEdits',
    note: 'print 模式，任务包走 stdin；acceptEdits 让它直接写产物文件。',
    binary: 'claude',
    needsCommand: false,
  },
  {
    id: 'codex',
    label: 'Codex',
    command: 'codex exec --sandbox workspace-write --skip-git-repo-check -',
    note: '`-` 表示任务包走 stdin；workspace-write 才写得进产物。',
    binary: 'codex',
    needsCommand: false,
  },
  {
    id: 'dsh',
    label: 'DeepSeek Harness',
    command: 'dsh headless {prompt}',
    note: 'headless 非交互；任务包是位置参数，不是 stdin。',
    binary: 'dsh',
    needsCommand: false,
  },
  {
    id: 'ollama',
    label: 'Ollama',
    command: 'ollama run <模型名>',
    note: '本地模型：任务包走 stdin，HTML 从 stdout 出来——先把模型名填上再测。',
    binary: 'ollama',
    needsCommand: false,
  },
  {
    id: 'workbuddy',
    label: 'WorkBuddy',
    // 空串是**事实**（我们不知道它怎么被调用），不是占位。选了它，界面问一次命令。
    command: '',
    note: '命令待定：选中后填一条（读 stdin，或带 {prompt} 收任务包）。',
    binary: 'workbuddy',
    needsCommand: true,
  },
  {
    id: 'grokbot',
    label: 'Grok Bot',
    command: '',
    note: '命令待定：选中后填一条（读 stdin，或带 {prompt} 收任务包）。',
    binary: 'grokbot',
    needsCommand: true,
  },
  {
    id: 'custom',
    label: '自建 / 自定义',
    command: '',
    note: '自己写一条：读 stdin，或带 {prompt} 接收任务包；HTML 写到 stdout 或产物路径都行。',
    binary: null,
    needsCommand: true,
  },
];

/** 按 id 取候选（未知 id 返回 undefined）。 */
export function candidateById(id: string): Candidate | undefined {
  return CANDIDATES.find((candidate) => candidate.id === id);
}

/**
 * 命令里还没填的占位符，`<模型名>` 这种形状。
 *
 * 为什么要在跑之前认它：`ollama run <模型名>` 交给 shell 会被解释成**重定向**——
 * 它不会报「你忘了填模型名」，而是去找一个叫「模型名」的文件读 stdin，然后以
 * 一个与生成毫无关系的原因失败（或者更糟：读成功、跑了个空 prompt）。所以这条
 * 形状必须在执行之前拦下来，并且说清楚要填什么。
 *
 * 只认「尖括号里没有空白/尖括号」：`cmd < file` 这种真的重定向有一个空格，
 * 不会命中。
 */
const PLACEHOLDER = /<[^<>\s]{1,24}>/;

export function placeholderIn(command: string): string | null {
  return PLACEHOLDER.exec(command)?.[0] ?? null;
}

/** 命令是否已经可以拿去跑（没有未填的占位符）。 */
export function commandReady(command: string): boolean {
  return command.trim() !== '' && placeholderIn(command) === null;
}

/** 客户端也要用的一行视图：设置页与下拉只拿这些字段，拿不到任何 node API。 */
export type CandidateView = {
  id: CandidateId;
  label: string;
  command: string;
  note: string;
  /** 命令是否可以直接跑（`ollama` 的 `<模型名>` 没填、`workbuddy` 的空命令都是 false）。 */
  ready: boolean;
  /** 这一类需要用户自己填一条命令。 */
  needsCommand: boolean;
};

export function viewOf(candidate: Candidate): CandidateView {
  return {
    id: candidate.id,
    label: candidate.label,
    command: candidate.command,
    note: candidate.note,
    ready: commandReady(candidate.command),
    needsCommand: candidate.needsCommand,
  };
}

/**
 * 下拉里的一行：视图 + 探测结论。
 *
 * `state` 就是选项文字后面那半句。它有三种，各有各的信息量：
 * - `已安装`：PATH 里有这个可执行文件（**不代表能用**——本机的 codex 就是装了、
 *   登录了、`exec` 还是 401）；
 * - `未安装`：PATH 里没有。仍然可选：装上之后不用再改设置；
 * - `需要填命令`：命令未知，选它就要填一条（`workbuddy` / `grokbot`）。
 *
 * 自建那一行不带后缀：「已装 / 未装」对它没有意义，它本来就没有可执行文件名。
 */
export type CandidateOption = CandidateView & {
  installed: boolean;
  state: '已安装' | '未安装' | '需要填命令' | '';
  /** 选项文字（名字 + 后缀）。由这里拼，界面不再自己判断。 */
  text: string;
};

function stateOf(view: CandidateView, installed: boolean): CandidateOption['state'] {
  if (view.id === 'custom') return '';
  if (view.needsCommand) return '需要填命令';
  return installed ? '已安装' : '未安装';
}

/**
 * 下拉的选项顺序：**装了的在前、没装的后、自建永远最后**。
 *
 * 已安装那一组把 `dsh` 提到第一个：零条时的指路文案一直是「先试 DeepSeek Harness」，
 * 而它也是这个产品最想要的那条（headless 形态、一条命令、不需要 agent 的写文件权限）。
 * 装了的那一组里其余按候选表的顺序——顺序稳定，用户第二次打开时位置不会乱跳。
 *
 * 没装的为什么不删掉：删掉就等于「你能选的只有这台机器上已经有的」，而用户要的
 * 恰恰是「以后想换一个」——列表是产品给的可能性，PATH 只是给它的注脚。
 */
export function dropdownOptions(
  known: readonly CandidateView[],
  installedIds: ReadonlySet<string>,
): CandidateOption[] {
  const annotated = known.map((view) => {
    const installed = installedIds.has(view.id);
    const state = stateOf(view, installed);
    return {
      ...view,
      installed,
      state,
      text: state === '' ? view.label : `${view.label} · ${state}`,
    };
  });

  const custom = annotated.filter((option) => option.id === 'custom');
  const rest = annotated.filter((option) => option.id !== 'custom');
  const installed = rest.filter((option) => option.installed);
  const dsh = installed.filter((option) => option.id === 'dsh');
  const installedRest = installed.filter((option) => option.id !== 'dsh');
  const missing = rest.filter((option) => !option.installed);

  return [...dsh, ...installedRest, ...missing, ...custom];
}

/**
 * 第一次被问时，下拉里预选哪一行：**装了的第一个**（顺序见 `dropdownOptions`）。
 *
 * 没有一个是装着的就返回 null（那时界面根本不该问：零探测是「按钮禁用 + 一句原因」
 * 那个状态，见 `GeneratorView.state === 'none'`）。预选不等于替人决定：它只是让
 * 「测试并使用」变成一次确认，而不是一次选择加一次确认。
 */
export function defaultOptionId(options: readonly CandidateOption[]): CandidateId | null {
  return options.find((option) => option.installed)?.id ?? null;
}

/**
 * 库里存着的那条命令 → 下拉该选中哪一行。
 *
 * 存的是命令，不是 id：`app_settings` 只有一个键（`generator.command`），加第二列
 * 就得迁移，而这一层不需要它——命令本身就是身份。两条判定：
 * 1. 与某一行**逐字相同** → 就是那一行；
 * 2. 否则看**第一个词**：`ollama run qwen2.5-coder` 仍然是 Ollama（用户只是把
 *    `<模型名>` 填了），`claude -p --dangerously-skip-permissions` 仍然是 Claude Code。
 *    只认「二进制名 + 空格」这个形状，`codex-tool x` 不会被误判成 Codex。
 * 3. 都不是 → 自建 / 自定义：下拉里没有任何一行能诚实地代表它。
 *
 * 为什么需要第 2 条：没有它，填完模型名之后下拉会跳回「自建 / 自定义」——用户
 * 明明选的是 Ollama，界面却说他用的是别的东西。那是这一格唯一会「说谎」的地方。
 */
export function idForCommand(command: string | null): CandidateId | null {
  const value = command?.trim() ?? '';
  if (value === '') return null;

  const exact = CANDIDATES.find((candidate) => candidate.command.trim() === value);
  if (exact !== undefined) return exact.id;

  const byBinary = CANDIDATES.find((candidate) => candidate.binary !== null
    && value.startsWith(`${candidate.binary} `));
  return byBinary?.id ?? 'custom';
}

/**
 * 第一次被问时，选中的是哪一行。
 *
 * 顺序：库里已经有的 → 装了的第一个 → 自建。
 * 第一条是给「打开对话框时其实已经存过一条」这种情况兜底（例如用户清空了测试结果、
 * 或者从另一个标签页改过）；正常路径上它是 null，于是落在第二条——**装了的第一个**，
 * 按 `dropdownOptions` 的顺序也就是 `dsh`（装了的里面它排第一）。这就是 story map
 * 第 2 行要的那一件事：问一次，但已经替他把最可能的那一行指好。
 *
 * 一个都没装时落在「自建」：那时对话框不该替他编一个候选，让他自己写一条。
 */
export function initialOptionId(
  view: Pick<GeneratorView, 'savedId' | 'defaultId' | 'options'>,
): CandidateId {
  return view.savedId ?? view.defaultId ?? view.options[view.options.length - 1]?.id ?? 'custom';
}

/** 一次测试的结果，落库（`app_settings`）也给界面读。 */
export type GeneratorTest = {
  ok: boolean;
  /** 测的是哪条命令：命令改了，这条结果就不算数。 */
  command: string;
  /** ISO 时间。 */
  at: string;
  /** 通过时产物的字节数 / 耗时毫秒；失败时是 null。 */
  size: number | null;
  ms: number | null;
  /** 失败时 stderr 的原文尾巴。 */
  error: string | null;
};

/**
 * 测试结果那一行的字：`通过 · 74B · 0.9s` / `失败：<stderr>`。
 *
 * 成功用一律的单位（字节 / 秒），失败**原文照登**——`OAuth session expired` 与
 * `MISSING_CREDENTIAL: … DEEPSEEK_API_KEY` 本身就是下一步，改写它等于替 CLI 编原因。
 * 成功时也不写「生成器可以用了」：那一行已经在说这件事。
 */
export function testLabel(test: GeneratorTest): string {
  if (!test.ok) return `失败：${test.error ?? '未知原因'}`;
  const size = test.size ?? 0;
  const ms = test.ms ?? 0;
  return `通过 · ${size}B · ${(ms / 1000).toFixed(1)}s`;
}

/**
 * 配好的模型接口里**能露给界面的三格**。
 *
 * 模型名、接口地址、以及「这是谁的那一份」：`apiKey` 不在这张类型上，因此它没有
 * 一条路能进响应体、事件或界面（`provider.ts` 的脱敏只管错误文本，这一条管的是
 * 视图本身）。
 *
 * P2.12 起 `scope` 是必须的：同一个部署里，吕品看到的是「平台统一模型」，
 * 而配了自己 key 的人看到的是他自己的模型名——只写模型名的话，后者会被这句
 * 前缀骗到（他会以为全组都在用他这把 key）。
 */
export type ProviderView = {
  model: string;
  baseUrl: string;
  scope: 'env' | 'member' | 'platform';
};

/**
 * 界面需要的全部生成器事实：现在会跑什么、从哪来的、有哪些可选、上次测成什么样。
 *
 * `state` 与 `source` 是一对：`ready` 时要么 `command` 就是真会执行的那条（CLI 路），
 * 要么 `provider` 非空（直连模型路，没有命令可跑）；`choose` 时是「第一次用，还没选」
 * ——界面要打开那个一次性的小对话框；`none` 时按钮禁用（一句原因 + 一条可抄的命令，
 * 见设置页）。
 *
 * **`state` 只看哪条路是活的**（P2.10 的修正）：配齐了三格模型接口，`state` 恒为
 * `ready`、`source` 恒为 `'provider'`——那时 `choose` / `none` 说的是另一条路
 * （CLI）的状态，而那条路不会被执行，把它摆在按钮上就是在问一件不会发生的事。
 *
 * `options` / `candidates` / `saved` / `test` 描述的是 **CLI 那一条路**，与 provider
 * 在不在无关：设置页要能随时改它（provider 撤掉之后它就是活的），所以它们照旧。
 */
export type GeneratorView = {
  state: 'ready' | 'choose' | 'none';
  /** 这一版会执行哪条路：provider（直连模型）/ env、settings（CLI）/ null（都没有）。 */
  source: 'provider' | 'env' | 'settings' | null;
  /** CLI 路真会执行的命令；provider 路没有命令，所以是 null（`ready` 也不例外）。 */
  command: string | null;
  /** 配齐了的模型接口；没有就是 null。有值时 `state` 必为 `ready`、`source` 必为 `'provider'`。 */
  provider: ProviderView | null;
  /** 库里存着的那条（没有就是 null）——设置页的「高级」用它当初始值。 */
  saved: string | null;
  /** PATH 里探测到的候选（探测结论，不是选项表）。 */
  candidates: CandidateView[];
  /** 七行完整候选表。 */
  known: CandidateView[];
  /** 下拉的选项：已安装 / 未安装 / 需要填命令 / 自建，顺序见 `dropdownOptions`。 */
  options: CandidateOption[];
  /** 预选：装了的第一个；一个都没装是 null。 */
  defaultId: CandidateId | null;
  /** 库里那条命令落在哪一行（null = 没存）。 */
  savedId: CandidateId | null;
  test: GeneratorTest | null;
};

// ─── P2.12：我的模型 key 那一行 ──────────────────────────────────────────────

/**
 * key 的末 4 位。
 *
 * 为什么允许露 4 位：一个人可能配过两把 key（换过网关），而界面上一行「已配置」
 * 两把 key 长得一模一样；末 4 位足够他自己认出来「这是哪一把」，又不足以拿去用。
 * 太短的 key（不足 8 位）一个字符都不露——4 位占它一半，那已经不算「提示」了。
 */
export function keyTail(apiKey: string | null): string | null {
  const value = apiKey?.trim() ?? '';
  if (value.length < 8) return null;
  return value.slice(-4);
}

/**
 * 「我的模型 key」那一行需要的全部事实。
 *
 * **`apiKey` 不在这张类型上**，所以它没有任何一条路能进响应体、进页面、进事件流。
 * 这是「不泄露」的第一道闸；`provider.ts` 的脱敏管的是错误文本，是第二道。
 *
 * 住在 `candidates.ts` 而不是存储层（`member-provider.ts`）：客户端要读这个类型与
 * 下面那句文案，而存储层 import 了库。视图类型不能顺手把 pg 拖进浏览器包里。
 */
export type MemberKeyView = {
  /**
   * 现在生效的是哪一层：`member` = 他自己那三格；`platform` = 平台统一模型；
   * `env` = 部署的环境变量；`null` = 都没有（那一行显示「未配置」）。
   */
  scope: 'member' | 'platform' | 'env' | null;
  /** 会生效的模型名（`scope` 为 null 时是 null）。 */
  model: string | null;
  /** 他自己存过的接口地址——只用来预填表单，不是秘密。 */
  baseUrl: string | null;
  /** 他自己存过的模型名——表单预填用（与 `model` 不同：后者是「生效的」）。 */
  ownModel: string | null;
  /** 他自己那把 key 的末 4 位；没有 key（或 key 太短）就是 null。 */
  keyTail: string | null;
};

/**
 * 那一行左边要写的字。三条，各自说一件不同的事：
 * - `未配置`：这个部署和他自己都没有一份能用的三格——按「生成」会退回 CLI 那条路；
 * - `平台统一模型 · <模型>`：他自己没配，用的是平台那一份（不是他的 key）；
 * - `<模型>`：这就是他自己的 key，模型名本身就是全部信息，再加前缀反而啰嗦；
 * - `环境变量 · <模型>`：部署级覆盖（CI / 临时换接口），成员那三格不会生效。
 *
 * 拼在这里而不是组件里：这是「这一行说什么」的判据，与 `testLabel` 同一个位置。
 */
export function memberKeyText(view: MemberKeyView): string {
  if (view.scope === null) return '未配置';
  const model = view.model ?? '';
  if (view.scope === 'member') return model;
  if (view.scope === 'env') return `环境变量 · ${model}`;
  return `平台统一模型 · ${model}`;
}
