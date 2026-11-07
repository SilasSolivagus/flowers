/**
 * 「平台」那一列的词表（P4-08）：**标签、写入顺序、空值口径只写在这一处**。
 *
 * 为什么单独一个模块、而且不 import 任何东西：它同时被四处消费——
 * 1. 服务层（`create.ts` / `manage.ts` 的归一与校验）；
 * 2. 录入表单（`app/components/RequirementForm.tsx`，**客户端**组件，多选 chips）；
 * 3. 抽屉（只读那一行）；
 * 4. 指纹（`fingerprint.ts`：平台的集合变了，产物就该变旧）。
 *
 * 与 `fields.ts` 同一条理由：客户端组件 import 一个会连带 import `drizzle-orm` 或
 * `db/client.js` 的模块，那份代码就会进浏览器包。所以这里只有字面量。
 *
 * ## 为什么是这八个
 *
 * owner 的原话是「一条需求常常跨好几个端——PAN-6 是 H5 + APP」。所以词表按**端**分，
 * 不按技术栈分（没有 `node` / `flutter`：那是实现，不是这条需求落在哪）；`api` 与
 * `admin` 也在里面，因为它们各自是一个真实的交付面（开放接口、运营后台）。
 *
 * `ios` / `android` 分开而不合成 `app`：改一个端的价格、发一个端的版、走一次端的
 * 走查，都是分开的。PAN-6 那种「App 端后置」的场景，只有分开写才表达得出来。
 *
 * ## 顺序就是写入顺序
 *
 * `normalizePlatforms` 按这张表的顺序输出。这不是排版偏好，是**指纹的稳定性**：
 * `['h5','app']` 与 `['app','h5']` 是同一条需求的同一组平台，若它们哈希出两个值，
 * 同一个人换一次勾选顺序就会把产物打成「需求已更新」。
 */

export type PlatformKey =
  | 'pc' | 'web' | 'h5' | 'ios' | 'android' | 'api' | 'admin' | 'mini';

export type Platform = {
  key: PlatformKey;
  /** 界面上的名字（chips、抽屉那一行、事件里的「旧值 → 新值」）。 */
  label: string;
};

export const PLATFORMS: readonly Platform[] = [
  { key: 'pc', label: 'PC 客户端' },
  { key: 'web', label: 'Web' },
  { key: 'h5', label: 'H5' },
  { key: 'ios', label: 'iOS' },
  { key: 'android', label: 'Android' },
  { key: 'api', label: '开放接口' },
  { key: 'admin', label: '运营后台' },
  { key: 'mini', label: '小程序' },
] as const;

/** 空数组的界面写法。库里的 `'{}'` 与它是同一件事。 */
export const PLATFORM_UNSET = '未标注';

const ORDER: readonly string[] = PLATFORMS.map((p) => p.key);

/** 这个词在不在词表里（大小写不敏感：`H5` 与 `h5` 是同一个平台）。 */
export function isPlatformKey(value: string): value is PlatformKey {
  return ORDER.includes(value.trim().toLowerCase());
}

/**
 * 任意输入 → 落库的写法：小写、去重、丢掉词表外的值、按词表顺序排。
 *
 * 为什么**丢掉**认不出的值而不是报错：这一列的值来自界面上的勾选，服务层是第二道
 * 门（MCP / 脚本直连）。一个写错的键（`h5 ` / `APP`）不该让整条需求建不出来——
 * 它该被忽略，而「忽略了什么」在报告里说得清。空数组是合法值（= 未标注）。
 *
 * 非数组输入（`null` / `'h5'` / 对象）一律当空：这一列只有一种形状，
 * 「一个平台」在库里也是长度 1 的数组。
 */
export function normalizePlatforms(value: unknown): PlatformKey[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const key = item.trim().toLowerCase();
    if (ORDER.includes(key)) seen.add(key);
  }
  return ORDER.filter((key) => seen.has(key)) as PlatformKey[];
}

/** 键 → 中文名。认不出的键原样返回：读侧不该丢掉一条需求里的东西。 */
export function platformLabel(key: string): string {
  return PLATFORMS.find((p) => p.key === key)?.label ?? key;
}

/** 一组键 → 一行中文（抽屉、事件）。空数组 → `未标注`。 */
export function platformsLabel(keys: readonly string[]): string {
  if (keys.length === 0) return PLATFORM_UNSET;
  return keys.map(platformLabel).join(' · ');
}
