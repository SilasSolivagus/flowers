import { AppError } from '../errors.js';
import type { ProviderConfig, ProviderResolution } from './provider.js';
import { keyTail, type MemberKeyView } from './candidates.js';
import {
  readSetting, settingCell, writeSetting, type Queryable,
} from './settings.js';

/**
 * P2.12：**每个人自己的三格模型接口**。
 *
 * 为什么要有这一层：`provider.*` 是**平台级**的三行——一个部署一个 key，所有人都
 * 用它，账单和配额也都记在它头上。owner 的原话是「自己配自己的 llm key 简单的多」：
 * 每个人的额度、模型、网关都不一样，而这件事本来就不需要管理员。
 *
 * 形状：复用 `app_settings`，键名带成员作用域
 *
 *     member.<memberId>.provider.baseUrl
 *     member.<memberId>.provider.apiKey
 *     member.<memberId>.provider.model
 *
 * 不建新表：三行键值与平台那三行是同一个形状，多一张表就要多一次迁移、多一套读写口，
 * 而这一层要回答的问题与平台那一层一模一样（「这个作用域把这一格设成了什么」）。
 *
 * 三条硬规矩，与 `settings.ts` 里平台那三条一一对应：
 *
 * 1. **键名只在这里拼**。别处写 `member.${id}.provider.baseUrl` 就等于把格式抄了
 *    第二遍——抄漏一个点，读的写的是两行，而两边都不会报错，只会在某天「key 存了
 *    但没生效」。
 * 2. **三格同进同退**：只有地址没有 key、或只有 key 没有模型，都不是一份能发请求的
 *    配置。`memberProviderSettings()` 因此在缺一格时给 null，**不与平台那三格拼**。
 *    拼出来的半份配置会把一个人的 key 发到另一个人填的地址上——这是这一层唯一
 *    会造成真实损失的写法，所以它在类型上就不存在（这里没有任何接受半个配置的入参）。
 * 3. **不把 key 交出去**：`apiKey` 只出现在 `ProviderConfig`（进 `Authorization` 头）
 *    与这里的库里。给界面的东西只有 `MemberKeyView`——它最多带 key 的**末 4 位**，
 *    其余部分是它的类型上根本没有的字段。
 *
 * 身份用 `members.id` 而不是名字：名字是自由文本，可以有 `.` 与空格，而键的形状是
 * `member.<id>.provider.*`（带点的名字会让一个键有两种读法）。名字 → id 只查一次，
 * 在入口（`provider.ts` 的 `resolveProvider`、`app/actions.ts`）做。
 */

// ─── 键名 ────────────────────────────────────────────────────────────────────

/** 成员作用域的命名空间前缀。测试与文档都从这里引用，不抄字面量。 */
export const MEMBER_KEY_NAMESPACE = 'member';

export type MemberProviderField = 'baseUrl' | 'apiKey' | 'model';

/** `member.<id>.provider.<field>` —— 全仓库唯一一处拼这个键名的地方。 */
export function memberProviderKey(memberId: string, field: MemberProviderField): string {
  return `${MEMBER_KEY_NAMESPACE}.${memberId}.provider.${field}`;
}

/** 三个字段的长度上限：与平台那三格同一口径（它们进同一组 HTTP 头与请求体）。 */
const MAX_BASE_URL = 500;
const MAX_API_KEY = 400;
const MAX_MODEL = 200;

// ─── 读 ──────────────────────────────────────────────────────────────────────

/**
 * 成员自己那三行的**原值**（没设 / 空串都是 null）。
 *
 * 为什么要一个「原值」版本：界面预填表单需要「地址填过什么、模型填过什么」，即便
 * 三格不全（比如只填了模型还没抄 key）。完整的配置要三格齐全，而表单往往是在
 * 补齐的过程中打开的。
 */
export type MemberProviderParts = {
  baseUrl: string | null;
  apiKey: string | null;
  model: string | null;
};

export async function memberProviderParts(
  db: Queryable,
  memberId: string,
): Promise<MemberProviderParts> {
  const id = memberId.trim();
  if (id === '') return { baseUrl: null, apiKey: null, model: null };
  const [baseUrl, apiKey, model] = await Promise.all([
    readSetting(db, memberProviderKey(id, 'baseUrl')),
    readSetting(db, memberProviderKey(id, 'apiKey')),
    readSetting(db, memberProviderKey(id, 'model')),
  ]);
  return { baseUrl: settingCell(baseUrl), apiKey: settingCell(apiKey), model: settingCell(model) };
}

/**
 * 原值 → 可发请求的三格；缺任意一格就是 null（**整层作废**，不与平台拼半份）。
 *
 * 纯函数：解析顺序与「什么算一份完整配置」这两条判据，用例不用连库就能钉住。
 */
export function configOf(parts: MemberProviderParts): ProviderConfig | null {
  const { baseUrl, apiKey, model } = parts;
  if (baseUrl === null || apiKey === null || model === null) return null;
  return { baseUrl, apiKey, model };
}

/** 成员自己那一份配置；三格不齐（或一格都没填）返回 null。 */
export async function memberProviderSettings(
  db: Queryable,
  memberId: string,
): Promise<ProviderConfig | null> {
  return configOf(await memberProviderParts(db, memberId));
}

// ─── 写 ──────────────────────────────────────────────────────────────────────

/**
 * 写成员那三行。传字符串就写，传空串等于**清掉这一格**；不传的字段保持原样。
 *
 * 与 `saveProviderSettings` 同一条口径（设置页只有一行，不必每次把三格一起送来）。
 * 长度超限在这里就拦（`AppError`）：超过上限的 key 一定不是一个能用的 key，等发
 * 请求时才失败更难查。
 */
export async function saveMemberProviderSettings(
  db: Queryable,
  memberId: string,
  input: { baseUrl?: string; apiKey?: string; model?: string },
): Promise<void> {
  const id = memberId.trim();
  if (id === '') throw new AppError('invalid_member', '成员 id 是空的');

  const writes: Array<[MemberProviderField, string | undefined, number, string]> = [
    ['baseUrl', input.baseUrl, MAX_BASE_URL, '接口地址'],
    ['apiKey', input.apiKey, MAX_API_KEY, 'API Key'],
    ['model', input.model, MAX_MODEL, '模型名'],
  ];
  for (const [field, raw, max, label] of writes) {
    if (raw === undefined) continue;
    const value = raw.trim();
    if (value.length > max) throw new AppError('invalid_provider', `${label}不能超过 ${max} 个字符`);
    await writeSetting(db, memberProviderKey(id, field), value);
  }
}

// ─── 给界面的那一份 ──────────────────────────────────────────────────────────

/**
 * 由「他自己的原值」+「解析出来的那一份」拼出视图。
 *
 * 纯函数：`resolveProvider()` 的结果里带着 `scope`，所以这里不需要再猜一次
 * 「这一份是谁的」——界面与本层的说法因此不可能分叉。
 *
 * 视图类型与那一行的文案住在 `candidates.ts`（客户端也要读），这里只负责**拼**：
 * 存储的那一半（含 `apiKey`）不进客户端模块图。
 */
export function memberKeyView(
  parts: MemberProviderParts,
  resolved: ProviderResolution | null,
): MemberKeyView {
  return {
    scope: resolved?.scope ?? null,
    model: resolved?.config.model ?? null,
    baseUrl: parts.baseUrl,
    ownModel: parts.model,
    keyTail: keyTail(parts.apiKey),
  };
}
