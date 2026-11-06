/**
 * 生成器候选表：仓库里唯一一份「本机可能装着哪些 CLI」的清单。
 *
 * P2.6 把这件事写成了「claude 优先，否则 codex」——那是**一台机器上的运气**
 * 被写成了产品策略。这张表把它换成一个固定的、可读的清单：五个候选，各自的
 * 显示名、命令模板、一句说明。谁在 PATH 里是**探测**出来的（`detect.ts`），
 * 谁真的能用是**测**出来的（`generator.ts` 的 `testGenerator`）——两件事不能混：
 * 本机的 `codex login status` 说「已登录」，`codex exec` 却 401 `refresh token
 * already used`。装了、登录了、能用，是三个不同的档。
 *
 * 本文件刻意**不 import 任何 node 内建模块**：它同时被服务端（探测、跑命令）和
 * 客户端（选择器、设置页）读取，而客户端里没有 `node:fs`。纯数据 + 纯函数，
 * 两边共用同一张表、同一套占位符判断。
 */

export type CandidateId = 'claude' | 'codex' | 'dsh' | 'ollama' | 'custom';

export type Candidate = {
  id: CandidateId;
  /** 界面上那行左边写的名字。 */
  label: string;
  /**
   * 命令模板。两种形状由**有没有 `{prompt}`** 决定（见 `generator.ts`）：
   * - 有：任务包作为那个 argv 元素传进去（`dsh headless {prompt}`）；
   * - 没有：任务包从 stdin 进（`claude -p`、`codex exec -`、`ollama run x`）。
   */
  command: string;
  /** 一句说明。只在这张表、选择器与文档里出现；设置页的行上不写解释。 */
  note: string;
  /** PATH 里要找的可执行文件名；`null` = 不靠 PATH（自建 / 自定义）。 */
  binary: string | null;
};

/**
 * 五个候选。顺序就是选择器里的顺序：先 agent CLI（会自己写文件），再 harness，
 * 再本地模型，最后才是「自己填」。
 *
 * `ollama` 的命令里带着 `<模型名>`：它不是「装好就能跑」的那一类，用户得先把
 * 模型名填进去。`commandReady()` 认得这种占位符，所以它会被探测到、会被列出来，
 * 但不会被当成「可以直接跑」的那一个——它需要被改一次。
 */
export const CANDIDATES: readonly Candidate[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    command: 'claude -p --permission-mode acceptEdits',
    note: 'print 模式，任务包走 stdin；acceptEdits 让它直接写产物文件。',
    binary: 'claude',
  },
  {
    id: 'codex',
    label: 'Codex',
    command: 'codex exec --sandbox workspace-write --skip-git-repo-check -',
    note: '`-` 表示任务包走 stdin；workspace-write 才写得进产物。',
    binary: 'codex',
  },
  {
    id: 'dsh',
    label: 'DeepSeek Harness',
    command: 'dsh headless {prompt}',
    note: 'headless 非交互；任务包是位置参数，不是 stdin。',
    binary: 'dsh',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    command: 'ollama run <模型名>',
    note: '本地模型：任务包走 stdin，HTML 从 stdout 出来——先把模型名填上再测。',
    binary: 'ollama',
  },
  {
    id: 'custom',
    label: '自建 / 自定义',
    command: '',
    note: '自己写一条：读 stdin，或带 {prompt} 接收任务包；HTML 写到 stdout 或产物路径都行。',
    binary: null,
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

/** 客户端也要用的一行视图：设置页与选择器只拿这些字段，拿不到任何 node API。 */
export type CandidateView = {
  id: CandidateId;
  label: string;
  command: string;
  note: string;
  /** 命令是否可以直接跑（`ollama` 的 `<模型名>` 没填就是 false）。 */
  ready: boolean;
};

export function viewOf(candidate: Candidate): CandidateView {
  return {
    id: candidate.id,
    label: candidate.label,
    command: candidate.command,
    note: candidate.note,
    ready: commandReady(candidate.command),
  };
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
 * 界面需要的全部生成器事实：现在会跑什么、从哪来的、有哪些可选、上次测成什么样。
 *
 * `state` 与 `source` 是一对：`ready` 时 `command` 就是真会执行的那条；
 * `choose` 时 `command` 为 null，界面要打开选择器；`none` 时按钮禁用。
 */
export type GeneratorView = {
  state: 'ready' | 'choose' | 'none';
  source: 'env' | 'settings' | 'detected' | null;
  /** 真会执行的命令（`state === 'ready'` 时非空）。 */
  command: string | null;
  /** 库里存着的那条（没有就是 null）——设置页「改」用它当初始值。 */
  saved: string | null;
  /** PATH 里探测到的候选（含还不能直接跑的那一个）。 */
  candidates: CandidateView[];
  /** 五行的完整候选表（选择器里也要给出没探测到的？不——探测不到的只有「自定义」一类）。 */
  known: CandidateView[];
  test: GeneratorTest | null;
};
