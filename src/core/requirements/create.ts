import { z } from 'zod';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { recordEvent } from '../events.js';
import { findDuplicates } from './duplicates.js';
import { AppError, withPgErrors } from '../errors.js';
import { requirePlainObject } from '../validate.js';
import { assertCan, requireActor } from '../auth/guard.js';
import { memberByName } from '../auth/members.js';
import { can, type Member } from '../auth/roles.js';
import { normalizePlatforms } from './platforms.js';
import { PRIORITIES } from './priority.js';
import { normalizeType, type TypeKey } from './type.js';
import { normalizeSource, SOURCES, type SourceKey } from './source.js';

// required_error / invalid_type_error 显式给中文：缺字段时 zod 默认抛 'Required'，
// 而对外错误只暴露 issues[0].message，前端会看到英文。
const NOT_BLANK = (message: string) => ({
  required_error: message,
  invalid_type_error: message,
});

const BAD_OWNER = '负责人 ID 格式不正确';

/** 来源六类的名字，拼进报错里（从词表派生，改词表不必改这句）。 */
const SOURCES_LABEL = SOURCES.map((item) => item.key).join(' / ');

/**
 * 六问的入参形状（P4-02）。
 *
 * 全部 `nullish`：**新建只要 title / type / requester**。六问是「鼓励写」，不是门槛
 * ——真实的需求常常先建一条再补描述，把六问做成必填只会逼人在每一格里填「无」，
 * 而这种「无」比空着更坏：它看起来像有内容。
 *
 * 空白串在 `createRequirement` 里归一成 null：库里 null 与 '' 是同一件事
 * （见 `fingerprint.ts` 文件头第 2 条），写入端只保留一种写法。
 */
export const DescriptiveInput = z.object({
  /**
   * 备注（2026-11-10）：随手记的一句上下文。它**不在六问里**，也不进生成链路——
   * 唯一去处是企微汇总表最后一列（见 src/core/sheet/queue-sheet.ts）。
   */
  remark: z.string().nullish(),
  context: z.string().nullish(),
  problem: z.string().nullish(),
  outcome: z.string().nullish(),
  surfaces: z.string().nullish(),
  edgeCases: z.string().nullish(),
  outOfScope: z.string().nullish(),
});

/**
 * 平台（P4-08）：多值，可空。
 *
 * 这里**不**校验词表——`normalizePlatforms` 会丢掉认不出的键、去重、按词表排序。
 * 理由：这一列的值来自界面上的勾选（服务层是第二道门），一个写错的键不该让整条
 * 需求建不出来。空数组 = 未标注，与老需求同一种写法。
 */
const PlatformsInput = z.array(z.string()).nullish();

/**
 * 优先级（P4-09）：单值、可空。
 *
 * 枚举写在这里（不是 `z.string()`）是刻意的：这一列是单选，写错一个键（`p4` / `高`）
 * 不该落成「未定」——那会把一次明确的表态变成没表态。中文消息给出全部五个合法值。
 */
const PRIORITY_KEYS = PRIORITIES.map((item) => item.key) as [string, ...string[]];
const PriorityInput = z.enum(PRIORITY_KEYS, {
  message: '优先级只能是 P0 / P1 / P2 / P3 / 绿色通道',
}).nullish();

/**
 * 类型（Ruling 1）：**可空**。
 *
 * 这里刻意**不写成 zod 枚举**（改动前是 `z.enum(['commercial','feature'])`）：表单里
 * 那个「未指定」选项提交上来的是空串，而空串要算「没填」而不是「填错了」。用
 * `z.string().nullish()` 接住它，再由 `toType()` 归一（空 / null → null，认不出 →
 * 中文报错），与 `priority` 那条路同一种分工：形状归 zod，值域归服务层。
 *
 * 为什么值域不放 zod：`z.preprocess` / `z.union` 会让 `CreateInput` 变成 `ZodEffects`，
 * 而它同时也是 MCP 工具入参的**唯一 schema**（`mcp/tools.ts` 直接把它拿去做
 * `inputSchema`）。ZodEffects 在 JSON Schema 里没有忠实表示，MCP 客户端看到的会是
 * 一份和真正的校验对不上的 schema——那正是「工具说能调、服务拒了」的来源。
 */
const TYPE_KEYS = ['commercial', 'feature'] as const;
const TypeInput = z.string({
  invalid_type_error: `类型只能是 ${TYPE_KEYS.join(' / ')}（或留空 = 未指定）`,
}).nullish();

/**
 * 来源（Ruling 3）：可空，词表校验在 `toSource()`（同一个理由：值域归服务层）。
 * `sourceNote` 是「其他」那句自述，自由文本，空串归一成 null（与六问同一口径）。
 */
const SourceInput = z.string({ invalid_type_error: '来源必须是一类来源的名字' }).nullish();
const SourceNoteInput = z.string({ invalid_type_error: '来源说明必须是文本' }).nullish();

/** 类型归一：空 / null → null（未指定）；认不出的值**报错**（一次表态不该被静默丢掉）。 */
function toType(value: string | null | undefined): TypeKey | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const key = normalizeType(value);
  if (key === null) {
    throw new AppError('invalid', `类型只能是 ${TYPE_KEYS.join(' / ')}（或留空 = 未指定）`);
  }
  return key;
}

/** 来源归一：空 / null → null（未标注）；认不出的值报错，消息里给出全部六类。 */
function toSource(value: string | null | undefined): SourceKey | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const key = normalizeSource(value);
  if (key === null) {
    throw new AppError('invalid', `来源只能是 ${SOURCES_LABEL}（或留空 = 未标注）`);
  }
  return key;
}

export type DescriptiveInput = z.infer<typeof DescriptiveInput>;

export const CreateInput = z.object({
  title: z.string(NOT_BLANK('标题不能为空')).trim().min(1, '标题不能为空'),
  /**
   * 类型：**可省略**（Ruling 1）。新建只要标题 + 提出人。
   *
   * 删掉的是 `z.enum(...)` 那条必填：它让「还没决定商业还是功能」变成一条建不出来的
   * 需求，而 owner 已经裁定类型不承载权限（派单看负责人那一行的 line），那么挡住
   * 录入只是逼人在下拉里随便点一个——那比空着更坏（它看起来像有依据）。
   */
  type: TypeInput,
  requester: z.string(NOT_BLANK('提出人不能为空')).trim().min(1, '提出人不能为空'),
  ownerMemberId: z.string(NOT_BLANK(BAD_OWNER)).uuid(BAD_OWNER).nullish(),
  platforms: PlatformsInput,
  priority: PriorityInput,
  /** 来源（Ruling 3）：可省略；「其他」的自述另存一列。 */
  source: SourceInput,
  sourceNote: SourceNoteInput,
}).merge(DescriptiveInput);

export type CreateInput = z.infer<typeof CreateInput>;

/**
 * 负责人的人选（规则 1 的实现，见 `createRequirement` 里那段注释）。
 *
 * `undefined`（字段根本没出现）与 `null`（显式「不指定」）在**超管**那里意义不同：
 * 前者 = 我自己，后者 = 留空等人认领。对其他人两者一样：都是自己。
 *
 * P4-06：这里判的仍然是「转交权」，但锚点换成了**人的归属**——把一条还没造出来的
 * 需求挂到别人头上，等于替那个人所在的条线接活。事实里的 `ownerMemberId` 是 actor
 * 自己（他要成为负责人），`ownerLine` 是 actor 的条线：`can('reassignOwner')` 于是
 * 回答「他是不是自己这条线的负责人」。PM 不是 → forbidden；超管是 → 随便挂给谁。
 * 需求类型不参与这一格的判断（它只是内容属性）。
 */
async function resolveOwner(
  // 类型不再是这个判断的输入（Ruling 1 之前它也只是被接收、从未被读）：签名里留一个
  // 不读的 `type` 会让人以为「类型影响归属」，而那正是这条裁决要否掉的那件事。
  db: Db, actor: Member, input: { ownerMemberId?: string | null },
): Promise<string | null> {
  const wanted = input.ownerMemberId;
  const asMine = { ownerMemberId: actor.id, ownerLine: actor.line ?? null };

  if (wanted === undefined) return actor.id;
  if (wanted === null) {
    // 显式留空（演示里那条「待接单」的卡）：只有超管能造出一条没有负责人的需求。
    // 其余人照旧成为负责人——「立项即负责人」。
    return can(actor, { ownerMemberId: null, ownerLine: null }, 'admin') ? null : actor.id;
  }

  if (wanted === actor.id) return actor.id;

  // 想指定别人：必须有权转交，而且那个人得真的在名册上、还在职。
  await assertCan(db, actor.name, asMine, 'reassignOwner');
  const target = await memberByName(db, await nameOf(db, wanted));
  if (target === null || target.deactivatedAt !== null) {
    throw new AppError('invalid', '负责人不在名册上（或已停用）');
  }
  // 条线负责人只能把需求挂给本线的人（超管不受限）。「本线」= 自己那一行上的 line。
  if (!can(actor, asMine, 'admin') && target.line !== (actor.line ?? null)) {
    throw new AppError('forbidden', '只能把需求交给本线的人');
  }
  return target.id;
}

/** id → 名字。只为把「查无此人」与「名字对不上 id」合成一句中文。 */
async function nameOf(db: Db, memberId: string): Promise<string> {
  const found = await db.execute<{ name: string }>(
    sql`select name from members where id = ${memberId} limit 1`);
  return found.rows[0]?.name ?? '';
}

/** 空白 → null。写库只保留一种「没写」。 */
function blankToNull(value: string | null | undefined): string | null {
  const text = (value ?? '').trim();
  return text === '' ? null : text;
}

export async function createRequirement(db: Db, actor: string, raw: unknown) {
  // 非对象 body（null / 数组 / 字符串）zod 只给英文 'Expected object, received …'，
  // 这里的错误消息是唯一对外出口，统一走 validate.ts 的同一句中文。
  const parsed = CreateInput.safeParse(requirePlainObject(raw));
  if (!parsed.success) {
    throw new AppError('invalid', parsed.error.issues[0]?.message ?? '参数不合法');
  }
  const input = parsed.data;

  /**
   * 规则 1「录入即负责人」（P4-04）：**谁建谁负责**。P4-06 确认「任何 PM 都能立项，
   * 立项即成为负责人」——于是新建这条路上没有第二种默认：owner 就是 actor，
   * 除非超管显式指定别人 / 显式留空。
   *
   * 为什么把这条规则从「界面默认值」搬进服务层：界面把 `ownerMemberId` 预填成当前成员，
   * 于是从页面上看这条规则永远成立；而 API / MCP 的调用方不经过那个表单——一个 PM
   * 的 token 只要塞一个别人的 id，就能造出一条「归别人、但由我创建」的需求。默认值
   * 不是规则，服务层里的这一句才是。
   *
   * 四个分支，逐个说：
   * 1. 没传（或传 null）→ 负责人就是 actor；
   * 2. 传的是自己 → 照写；
   * 3. 传的是别人 → 需要 `reassignOwner`（超管、或本线的条线负责人）。条线负责人
   *    只能把本线的需求交给本线的人：跨线转交等于他能往别人的线上塞活；
   * 4. 超管显式传 null → 允许「没人认领」（演示里那条「待接单」的卡就是靠它，
   *    否则创建者总会变成负责人，看板上就再也画不出「等认领」这个真实状态）。
   */
  const actorMember = await requireActor(db, actor);
  const ownerMemberId = await resolveOwner(db, actorMember, input);
  // 类型 / 来源的值域校验也放在开事务之前：认不出的值不值得开一个事务。
  // （Ruling 1：type 现在可以是 null；Ruling 3：source 同理，两者都比「必填」多一步归一。）
  const type = toType(input.type);
  const source = toSource(input.source);
  // 自述只在「其他」时被表单渲染，但服务层**不拦**别的来源带自述：那是调用方给的
  // 一句话，静默丢掉比留着更坏（要清就显式传空串/ null）。
  const sourceNote = blankToNull(input.sourceNote);

  // `number` 由 requirements_number_seq 分配（列上有 default），这里**不写**它，
  // 也不再扫 `max(number)+1`：并发建需求时两个事务会读到同一个 max，输的那个撞
  // requirements_number_unique。序列的 nextval 是原子的，且不参与事务。
  //
  // 六问与标题同一条 insert（P4-02）：分成「先建再 update」会让这条需求在两次提交
  // 之间处于「有标题、没描述」的状态，而它已经出现在看板上了。
  return withPgErrors(() => db.transaction(async (tx) => {
    const inserted = await tx.execute<{ id: string; number: number; state: string }>(sql`
      insert into requirements
        (title, type, state, requester, owner_member_id,
         context, problem, outcome, surfaces, edge_cases, out_of_scope, platforms, priority,
         source, source_note, remark)
      values (
        ${input.title}, ${type}, 'inbox', ${input.requester}, ${ownerMemberId},
        ${blankToNull(input.context)}, ${blankToNull(input.problem)}, ${blankToNull(input.outcome)},
        ${blankToNull(input.surfaces)}, ${blankToNull(input.edgeCases)}, ${blankToNull(input.outOfScope)},
        ${sql.param(normalizePlatforms(input.platforms))}::text[],
        ${input.priority ?? null},
        ${source}, ${sourceNote}, ${blankToNull(input.remark)}
      )
      returning id, number, state`);
    const row = inserted.rows[0]!;
    const number = Number(row.number);
    await recordEvent(tx, {
      requirementId: row.id, actor, type: 'requirement.created',
      // `type` 可能是 null（Ruling 1）：事件里照写 null，而不是编一个默认值——
      // 时间轴要回答的是「建的时候填了没有」，不是「大概率算哪一类」。
      payload: { number, title: input.title, type, source },
    });
    // 建完之后附一句「像它的那几条」（2026-11-11）：不拦，只让人/agent 看见。
    const duplicates = await findDuplicates(db, input.title);
    return {
      id: row.id, number, state: row.state as 'inbox',
      ...(duplicates.length === 0 ? {} : { duplicates }),
    };
  }));
}
