/**
 * v1 范围裁剪的开关与那句标记（2026-11-10）。
 *
 * 三个东西，一份出处：
 * 1. `FEATURE_REVIEW_MATERIALS` —— 评审 / 走查材料的**入口**开关，**默认关**。
 *    代码、服务、接口、用例一个都不删（`uemaster_artifacts` 里 21 行历史产物、
 *    磁盘上那些静态 HTML 全留着），只是抽屉「参考」段不再渲染那两行。理由写在这里
 *    而不是写进组件：v1.1 要打开它时，只有这一处需要改。
 * 2. `FEATURE_EVALUATE_READS_CODE` —— 评估要不要读「现有页面清单」（代码索引）。
 *    **默认关**：v1 的评估输入是需求本身（六问 + PRD），不读代码。开着它的时候，
 *    提示词里会出现「已知现有页面（来自代码索引…）」并要求节点标「现有页面：<route>」，
 *    而 v1 的材料一条都经不起这种断言——没人核过那些页面今天还在不在。
 * 3. `V1_CLOSED_MARK` —— 非「收集」状态上那一行字。文案只有这一份：看板卡与抽屉
 *    写的是同一句话，读者不会以为两个地方说的是两件事。
 *
 * 为什么开关读 `process.env` 而不是库里的 `app_settings`：这两个是**部署形态**的开关
 * （这一版发出去有没有这个入口），不是某个人的偏好。`app_settings` 是给「这台机器连
 * 哪个模型、镜像走哪条传输」这类可改配置用的；把「这版有没有评审材料」写进去，等于
 * 让线上任何一个人都能把未完成的能力打开。
 */

/** 评审 / 走查材料入口的开关名。允许的值见 `flagOn`。 */
export const REVIEW_MATERIALS_FLAG = 'FEATURE_REVIEW_MATERIALS';

/** 评估是否读代码索引的开关名（v1 默认关）。 */
export const EVALUATE_READS_CODE_FLAG = 'FEATURE_EVALUATE_READS_CODE';

/**
 * 非「收集」状态上那行标记。
 *
 * 为什么是「v1 暂未开放」而不是「不可用」或灰掉按钮：灰掉的按钮仍在说「这里有个能做的事」，
 * 而这批需求不是坏了，是这一版没开。写清楚「这一版没做」，人才不会去查为什么点不动。
 */
export const V1_CLOSED_MARK = 'v1 暂未开放';

/**
 * 一个环境变量开关。**只有明确写「开」才算开**：`1` / `true` / `on` / `yes`（不分大小写）。
 *
 * 为什么不按「非空即开」：`FEATURE_REVIEW_MATERIALS=0` 是运维最自然的关法，而一个
 * 空字符串（`docker -e FOO=`）也常常出现在部署脚本里。两种写法都必须读成「关」。
 */
export function flagOn(name: string, env: Record<string, string | undefined> = process.env): boolean {
  const raw = (env[name] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

/** 评审 / 走查材料的入口开不开。默认关（v1 只有评估这一条链）。 */
export function reviewMaterialsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return flagOn(REVIEW_MATERIALS_FLAG, env);
}

/** 评估是否读代码索引。默认关（v1 不读代码，见文件头第 2 条）。 */
export function evaluateReadsCode(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return flagOn(EVALUATE_READS_CODE_FLAG, env);
}

/**
 * 参考段要渲染哪几行。
 *
 * 唯一的判据在这里，不在组件里：抽屉渲染、以后的 MCP 或别的读侧都问这一句，
 * 「关掉入口」才不会出现「界面没了、另一处还有」的分叉。
 *
 * **关掉时整行不渲染**，不是把按钮置灰：v1 的抽屉里那一段只剩「评估材料」一行，
 * 没有第二个按钮、没有 tooltip、点不到任何 404（置灰也行，但那需要一个悬停说明，
 * 而「v1 暂未开放」这句说明已经给了非收集状态的需求——同一句话在两个地方各说一遍，
 * 读者会以为是两件事）。
 */
export function refsForV1<T extends { stage: string }>(
  refs: readonly T[],
  reviewMaterials: boolean = reviewMaterialsEnabled(),
): T[] {
  return reviewMaterials ? [...refs] : refs.filter((ref) => ref.stage === 'evaluate');
}
