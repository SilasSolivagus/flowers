import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { recordEvent } from '../events.js';
import { AppError } from '../errors.js';
import { parseRequirementId, requirePlainObject } from '../validate.js';
import { assertCan, requirementFacts } from '../auth/guard.js';
import { DESCRIPTIVE_FIELDS, SHORT_LABEL } from './fields.js';

/**
 * 需要的写路径只有两件事：改描述、软删除（P4-02）。
 *
 * 为什么单独一个模块、而不是塞进 `create.ts`：`create.ts` 与六个状态动作同属
 * 「入口」那一批（它们都从 `app/actions.ts` 直连），而这里回答的问题完全不同——
 * 「一条已经存在的需求，它的**描述**能被改成什么」。状态机一个字都不动（P4-02
 * 的约束），所以这个模块里没有 `moveTo`、没有 `assertTransition`。
 */

/** 描述里可改的字段。`type` / `requester` / `state` / 排期日期**不在里面**。 */
export const EDITABLE_FIELDS = [
  'title',
  ...DESCRIPTIVE_FIELDS.map((field) => field.key),
  'prdUrl',
] as const;

export type EditableField = (typeof EDITABLE_FIELDS)[number];

/**
 * 不接受字段的白名单（负面清单），只用于把「你改错地方了」说成一句中文。
 *
 * 为什么是**报错**而不是静默忽略：`type` 不在录入面里是 owner 的决定（描述可改、
 * 分类不可改），而静默丢掉一个字段的后果是调用方以为改了——MCP 的 agent 会拿着
 * 「成功」的返回值去写下一条需求，人会在看板上找不到自己刚选的「商业」。
 * 一个明确的 `not_editable` 比一次安静的失败便宜。
 */
const FORBIDDEN: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'type', label: '类型' },
  { key: 'requester', label: '提出人' },
  { key: 'state', label: '状态' },
];

const NOT_FOUND = '需求不存在';

/** 事件 payload 里每个值最多这么长：它是时间轴上的一行，不是一个存档。 */
const VALUE_MAX = 80;

/** 一个值在事件里的写法：超长截断、null 就是 null（不改写成空串）。 */
function brief(value: string | null): string | null {
  if (value === null) return null;
  return value.length <= VALUE_MAX ? value : `${value.slice(0, VALUE_MAX)}…`;
}

/** 比较用的归一：null 与 '' 同值（与指纹的规则一致），去首尾空白。 */
function norm(value: string | null): string {
  return (value ?? '').trim();
}

/** 入参里的一个描述值 → 落库的写法：字符串去空白、空串归 null、其余原样。 */
function toStored(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new AppError('invalid', `${label}必须是文本`);
  const text = value.trim();
  return text === '' ? null : text;
}

type CurrentRow = {
  id: string;
  title: string;
  context: string | null;
  problem: string | null;
  outcome: string | null;
  surfaces: string | null;
  edge_cases: string | null;
  out_of_scope: string | null;
  prd_url: string | null;
};

/** camelCase 的字段名 → 这一行上的当前值。只有一处映射，读与写都用它。 */
function storedOf(row: CurrentRow, field: EditableField): string | null {
  switch (field) {
    case 'title': return row.title;
    case 'context': return row.context;
    case 'problem': return row.problem;
    case 'outcome': return row.outcome;
    case 'surfaces': return row.surfaces;
    case 'edgeCases': return row.edge_cases;
    case 'outOfScope': return row.out_of_scope;
    case 'prdUrl': return row.prd_url;
  }
}

/** 同上，另一个方向：字段名 → 列名。SQL 的标识符不接受参数绑定，所以走白名单 raw。 */
function columnOf(field: EditableField): string {
  switch (field) {
    case 'title': return 'title';
    case 'prdUrl': return 'prd_url';
    default: return DESCRIPTIVE_FIELDS.find((f) => f.key === field)!.column;
  }
}

export type UpdateResult = {
  id: string;
  /** 真的变了的字段（没有变化就是空数组）。 */
  changed: EditableField[];
};

/**
 * 改一条需求的描述：标题 + 六问 + PRD 链接。
 *
 * 五条规矩：
 * 1. **只碰描述**。`type` / `requester` / `state` 出现在入参里就报 `not_editable`
 *    （见 `FORBIDDEN` 的注释：静默忽略会让调用方以为改了）。
 * 2. **只写变了的字段**。值相等的字段不写进 update：一次「打开表单、什么都没改、
 *    保存」不该产生一条 `requirement.updated`，更不该让产物变旧——指纹是内容算的，
 *    内容没变，指纹就没变，那么这条事件只会污染时间轴。
 * 3. **没有变化就没有事件**，返回 `changed: []`。空事件是噪音。
 * 4. **事件记下改了哪几个字段**（旧值 → 新值，每个值截到 80 字）。时间轴要回答的是
 *    「描述什么时候被谁改过、改了哪一问」，而不是把整段新描述再存一遍——那会让
 *    `events` 变成需求的第二份正文。
 * 5. 软删除的行视为不存在（`deleted_at is null`），与读侧同一条口径：一条已经删掉的
 *    需求不该还能被一条直连服务改描述。
 *
 * 锁行（`for update`）而不是裸 update：两个标签页同时改同一问时，事件里那两行
 * 「旧值 → 新值」必须能串成一条链；不加锁时两边都读到同一个旧值，第二条事件就是假的。
 */
export async function updateRequirement(
  db: Db,
  actor: string,
  raw: unknown,
): Promise<UpdateResult> {
  const input = requirePlainObject(raw);
  const id = parseRequirementId(input);

  for (const field of FORBIDDEN) {
    if (Object.prototype.hasOwnProperty.call(input, field.key)) {
      throw new AppError(
        'not_editable',
        `描述里不能改${field.label}：这里只能改标题和六个问题`,
      );
    }
  }

  // 先归一入参（不碰库）：标题空了、值不是文本这类错误不值得开一个事务。
  const wanted: Partial<Record<EditableField, string | null>> = {};
  for (const field of EDITABLE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) continue;
    const label = SHORT_LABEL[field] ?? field;
    const value = toStored(input[field], label);
    if (field === 'title' && value === null) throw new AppError('invalid', '标题不能为空');
    wanted[field] = value;
  }

  return db.transaction(async (tx) => {
    const found = await tx.execute<CurrentRow>(sql`
      select id, title, context, problem, outcome, surfaces, edge_cases, out_of_scope, prd_url
        from requirements
       where id = ${id} and deleted_at is null
       for update`);
    const row = found.rows[0];
    if (!row) throw new AppError('not_found', NOT_FOUND);

    /**
     * 权限（P4-04）：改描述是 `edit`——负责人、本线条线负责人、超管。
     *
     * 为什么在锁行之后、算 diff 之前：锁住了才读得到「这一行的负责人是谁」，而且
     * 这一步之后同一个事务里的写入不会被别人插队。`not_found` 排在权限之前：一条
     * 不存在的需求对**任何人**都是 404，不该先回答「你有没有权限」——那会让
     * 「这条需求存不存在」变成一次权限探测。
     */
    await assertCan(tx, actor, await requirementFacts(tx, id), 'edit');

    const changes = (Object.keys(wanted) as EditableField[])
      .map((field) => {
        const from = storedOf(row, field);
        const to = wanted[field] ?? null;
        return { field, from, to };
      })
      // 归一后再比：描述里多一个尾随换行、或者 null 与 '' 互换，都不是「内容变了」。
      .filter((change) => norm(change.from) !== norm(change.to));

    if (changes.length === 0) return { id, changed: [] };

    const sets = changes.map(
      (change) => sql`${sql.raw(columnOf(change.field))} = ${change.to}`,
    );
    await tx.execute(sql`
      update requirements set ${sql.join(sets, sql`, `)} where id = ${id}`);

    await recordEvent(tx, {
      requirementId: id,
      actor,
      type: 'requirement.updated',
      payload: {
        fields: changes.map((change) => ({
          field: change.field,
          label: SHORT_LABEL[change.field] ?? change.field,
          from: brief(change.from),
          to: brief(change.to),
        })),
      },
    });

    return { id, changed: changes.map((change) => change.field) };
  });
}

/**
 * 软删除一条需求。
 *
 * 为什么只打时间戳：`events` / `uemaster_artifacts` / `uemaster_jobs` / `prd_snapshots`
 * / `review_assignments` 五处都指向这一行。硬删要么被外键拦住，要么把「谁在哪天
 * 承诺了什么」一起删掉——而这个系统的全部价值就是那条审计线。删除的含义因此只是
 * 「别再出现在界面和读模型里」（见 `deletedAt` 列的注释）。
 *
 * **正在跑的生成不会被掐断**（它活在另一个 detached 进程里，见 `start.ts` 文件头）。
 * 后果写在 P4-02 的报告里：worker 跑完后 attach 会因为这条需求已被软删而失败
 * （`attach.ts` 的存在性检查带 `deleted_at is null`），错误原文落进
 * `uemaster_jobs.error`；进度卡立刻不再显示它（读侧 join 同样带这条过滤）。
 */
export async function deleteRequirement(
  db: Db,
  actor: string,
  raw: unknown,
): Promise<{ id: string }> {
  const input = requirePlainObject(raw);
  const id = parseRequirementId(input);

  return db.transaction(async (tx) => {
    // 权限先判（`edit`：负责人 / 本线条线负责人 / 超管）。
    await assertCan(tx, actor, await requirementFacts(tx, id), 'edit');

    const deleted = await tx.execute<{ number: number; title: string }>(sql`
      update requirements set deleted_at = now()
       where id = ${id} and deleted_at is null
       returning number, title`);
    const row = deleted.rows[0];
    if (!row) throw new AppError('not_found', NOT_FOUND);

    await recordEvent(tx, {
      requirementId: id,
      actor,
      type: 'requirement.deleted',
      payload: { number: Number(row.number), title: row.title },
    });

    return { id };
  });
}
