/**
 * 「平台」那一列的词表（P4-08 建，P4-09 换成生产词表）：**标签、写入顺序、空值口径
 * 只写在这一处**。
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
 * ## 为什么是这十二个（P4-09：从真实数据里抄回来）
 *
 * P4-08 的词表（`pc / web / h5 / ios / android / api / admin / mini`）是**编的**。
 * 接上生产库之后，803 条线上需求里真正被勾过的平台是这些（括号里是条数）：
 *
 *   Web端 277 · 移动端 223 · PC客户端 219 · 小程序 46 · 后端 35
 *   管理后台 14 · Manager后台 11 · 前端 7 · H5 6 · H5-分享页 3
 *   开放平台 3 · 鸿蒙 2 · TV端 2 · manager 2 · 管理端 2 · pc端 1
 *   企业管理后台 1 · 支付宝 1
 *
 * 于是词表按「团队实际怎么打标签」重写：`mobile` 取代 `ios` / `android`（**真实数据
 * 里没有 iOS / Android 之分**，223 条只写「移动端」），`api` → `backend`（后端），
 * `admin` 保留（管理后台），另外补上 `manager` / `frontend` / `open` / `harmony` / `tv`。
 * 这是表达力上的一次**降级**（我们以前能分清 iOS 与 Android），但它换来的是「界面上的
 * 选项 = 库里真实存在的值」，而一个没人用的更细的维度只是让人多一次选择。
 *
 * 真实数据里还有 `H5-分享页`、`管理端`、`pc端`、`企业管理后台`、`支付宝` 这五个
 * **长尾写法**。它们没有被收进词表：`H5-分享页` / `pc端` / `管理端` / `企业管理后台`
 * 各自只是已收录平台的另一种写法（迁移时按词表前缀/同义归并，见 `LEGACY_PLATFORM_KEYS`
 * 与迁移 0014），`支付宝` 是一个渠道而不是一个端（它是 `mobile` 上的一种能力）。
 *
 * ## 顺序就是写入顺序
 *
 * `normalizePlatforms` 按这张表的顺序输出。这不是排版偏好，是**指纹的稳定性**：
 * `['h5','mobile']` 与 `['mobile','h5']` 是同一条需求的同一组平台，若它们哈希出两个
 * 值，同一个人换一次勾选顺序就会把产物打成「需求已更新」。
 */

export type PlatformKey =
  | 'web' | 'mobile' | 'pc' | 'mini' | 'backend' | 'admin'
  | 'manager' | 'frontend' | 'h5' | 'open' | 'harmony' | 'tv';

export type Platform = {
  key: PlatformKey;
  /** 界面上的名字（chips、抽屉那一行、事件里的「旧值 → 新值」）。 */
  label: string;
};

export const PLATFORMS: readonly Platform[] = [
  { key: 'web', label: 'Web端' },
  { key: 'mobile', label: '移动端' },
  { key: 'pc', label: 'PC客户端' },
  { key: 'mini', label: '小程序' },
  { key: 'backend', label: '后端' },
  { key: 'admin', label: '管理后台' },
  { key: 'manager', label: 'Manager后台' },
  { key: 'frontend', label: '前端' },
  { key: 'h5', label: 'H5' },
  { key: 'open', label: '开放平台' },
  { key: 'harmony', label: '鸿蒙' },
  { key: 'tv', label: 'TV端' },
] as const;

/** 空数组的界面写法。库里的 `'{}'` 与它是同一件事。 */
export const PLATFORM_UNSET = '未标注';

const ORDER: readonly string[] = PLATFORMS.map((p) => p.key);

/**
 * P4-08 的旧键 → 新键。**保留它，不因为「已经迁过了」而删掉**：
 *
 * - 迁移 0014 用它把库里那批旧值搬到新词表（那份 SQL 是这张表的一份镜像）；
 * - 写入端用它兜住还没更新的客户端 / 脚本 / MCP 调用方：一句 `platforms: ['ios']`
 *   应该落成 `['mobile']`，而不是被当成拼错的键悄悄丢掉。
 *
 * 六个旧键里有五个映射到自己，只有 `api` / `ios` / `android` 真的换了名字。
 * `ios` 与 `android` **都映射到 mobile**：迁完之后一条原本是 `['ios','android']`
 * 的需求只剩一个 `mobile`（去重是映射之后的自然结果，见 `normalizePlatforms`），
 * 这正是真实数据的形状。
 */
export const LEGACY_PLATFORM_KEYS: Readonly<Record<string, PlatformKey>> = {
  pc: 'pc',
  web: 'web',
  h5: 'h5',
  admin: 'admin',
  mini: 'mini',
  api: 'backend',
  ios: 'mobile',
  android: 'mobile',
};

/**
 * 真实数据里的长尾写法 → 词表键。只在迁移里用得到（不放进 `normalizePlatforms`：
 * 它们是历史数据的一次性清洗，不是「以后也要接受的输入」）。
 *
 * 每条都有依据，不是猜：
 * - `h5-分享页`：H5 的一个页面，端仍然是 H5；
 * - `pc端` / `管理端` / `企业管理后台` / `manager`：同一个端的大小写 / 同义写法；
 * - `支付宝`：小程序/移动端里的一个投放渠道，端是 `mobile`。
 */
export const LONG_TAIL_PLATFORM_KEYS: Readonly<Record<string, PlatformKey>> = {
  'h5-分享页': 'h5',
  'pc端': 'pc',
  '管理端': 'admin',
  '企业管理后台': 'admin',
  manager: 'manager',
  '支付宝': 'mobile',
};

/** 这个词在不在词表里（大小写不敏感；旧键也算「认识」，见 LEGACY_PLATFORM_KEYS）。 */
export function isPlatformKey(value: string): value is PlatformKey {
  const key = value.trim().toLowerCase();
  return ORDER.includes(key) || Object.hasOwn(LEGACY_PLATFORM_KEYS, key);
}

/**
 * 任意输入 → 落库的写法：折小写、旧键折成新键、去重、丢掉词表外的值、按词表顺序排。
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
    const raw = item.trim().toLowerCase();
    const key = Object.hasOwn(LEGACY_PLATFORM_KEYS, raw)
      ? LEGACY_PLATFORM_KEYS[raw]!
      : raw;
    if (ORDER.includes(key)) seen.add(key);
  }
  return ORDER.filter((key) => seen.has(key)) as PlatformKey[];
}

/** 键 → 中文名。认不出的键原样返回：读侧不该丢掉一条需求里的东西。 */
export function platformLabel(key: string): string {
  const normalized = Object.hasOwn(LEGACY_PLATFORM_KEYS, key)
    ? LEGACY_PLATFORM_KEYS[key]!
    : key;
  return PLATFORMS.find((p) => p.key === normalized)?.label ?? key;
}

/** 一组键 → 一行中文（抽屉、事件）。空数组 → `未标注`。 */
export function platformsLabel(keys: readonly string[]): string {
  if (keys.length === 0) return PLATFORM_UNSET;
  return keys.map(platformLabel).join(' · ');
}
