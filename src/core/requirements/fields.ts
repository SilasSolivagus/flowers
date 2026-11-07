/**
 * 六个描述性问题的定义（P4-02）：**标签、列名、策略提示只写在这一处**。
 *
 * 为什么单独一个模块、而且不 import 任何东西：它同时被三处消费——
 * 1. 服务层（`manage.ts` 的更新白名单与事件里的字段中文名）；
 * 2. 录入表单（`app/components/RequirementForm.tsx`，**客户端**组件）；
 * 3. 抽屉（只读渲染六问）。
 *
 * 第 2 条是它必须「零依赖」的原因：客户端组件 import 一个会连带 import `drizzle-orm`
 * 或 `db/client.js` 的模块，那份代码就会进浏览器包（甚至试图连库）。所以这里只有
 * 字面量，没有 sql、没有 zod、没有类型体操。
 */

/**
 * 一问的定义。
 *
 * `key` 是**对外的字段名**（表单 name、服务入参、zod 字段、读模型的键都是它），
 * `column` 是**库里的列名**。两者不同（`edgeCases` / `edge_cases`）：SQL 用 snake_case
 * 是这个库从第一张表起的写法，而 JS 侧的入参从第一个服务起就是 camelCase。这条映射
 * 也只有一个来源，改列名不必去四个文件里找。
 */
export type DescriptiveField = {
  /** 对外字段名：表单 name、服务入参、读模型的键。 */
  key: 'context' | 'problem' | 'outcome' | 'surfaces' | 'edgeCases' | 'outOfScope';
  /** 库里的列名。 */
  column: 'context' | 'problem' | 'outcome' | 'surfaces' | 'edge_cases' | 'out_of_scope';
  /** 界面上的标签：就是这一问本身，问句而不是名词。 */
  label: string;
  /** 事件 / 时间轴里用的短名（一行放得下）。 */
  short: string;
  /**
   * 「这一问空着」时那一行提示。**只有这三问有提示**：它们各自对应生成链路上
   * 一处会直接猜错的地方，而另外三问空着只是信息少一点，不会让材料画错。
   *
   * 措辞是后果，不是要求：这些字符串是屏幕上唯一允许出现的解释性文字
   * （见任务书「userask strategy hints」），所以每一句都必须说清「不填会怎样」。
   */
  hint: string | null;
  /** 类型 = 商业、且这一问空着时替换掉 `hint` 的那一句（更狠的那一版）。 */
  commercialHint?: string;
};

export const DESCRIPTIVE_FIELDS: readonly DescriptiveField[] = [
  {
    key: 'context',
    column: 'context',
    label: '谁在什么情况下用',
    short: '使用场景',
    hint: '没有它，模型编不出角色和入口',
  },
  {
    key: 'problem',
    column: 'problem',
    label: '现在怎么做 / 哪不好',
    short: '现状问题',
    hint: null,
  },
  {
    key: 'outcome',
    column: 'outcome',
    label: '做成什么样算成功',
    short: '成功口径',
    hint: '没有它，边界和异常只能靠猜',
    commercialHint: '商业需求没有成功口径，评审过不了',
  },
  {
    key: 'surfaces',
    column: 'surfaces',
    label: '涉及哪些页面 / 入口',
    short: '涉及页面',
    hint: '没有它，流程图会画出不存在的页面',
  },
  {
    key: 'edgeCases',
    column: 'edge_cases',
    label: '失败 / 空 / 无权限怎么办',
    short: '异常处理',
    hint: null,
  },
  {
    key: 'outOfScope',
    column: 'out_of_scope',
    label: '这次不做什么',
    short: '不做什么',
    hint: null,
  },
] as const;

/** 字段名 → 事件里那个短名。认不出的（`title` / `prdUrl`）由调用方自己给。 */
export const SHORT_LABEL: Record<string, string> = {
  title: '标题',
  prdUrl: 'PRD 链接',
  /**
   * 平台（P4-08）。它在 `SHORT_LABEL` 里而不在 `DESCRIPTIVE_FIELDS` 里：六问是**文本**
   * （`textarea`），平台是一组键（chips）。事件与「改了什么」的字段名共用这张表，
   * 所以它必须在这里——否则时间轴上那一行会写成 `platforms` 而不是「平台」。
   */
  platforms: '平台',
  ...Object.fromEntries(DESCRIPTIVE_FIELDS.map((f) => [f.key, f.short])),
};

/**
 * 这一问空着时该显示哪一句提示：`null` = 不显示。
 *
 * 空判定与指纹的归一一致（`trim()` 之后为空）：只有空白的 textarea 在库里会被写成
 * null，它在语义上就是「没写」，提示该出来。
 */
export function hintFor(field: DescriptiveField, value: string, type: string): string | null {
  if (value.trim() !== '') return null;
  if (type === 'commercial' && field.commercialHint !== undefined) return field.commercialHint;
  return field.hint;
}

/** 六问在库里的列名，顺序与 `DESCRIPTIVE_FIELDS` 相同（读模型拼 select 用）。 */
export const DESCRIPTIVE_COLUMNS = DESCRIPTIVE_FIELDS.map((f) => f.column).join(', ');
