import { z } from 'zod';
import { AppError } from './errors.js';

/**
 * 非对象 body（undefined / null / 数组 / 字符串 / 数字）统一成中文错误。
 * 服务入口不先过这一关，字段访问就会抛 TypeError，控制器只能兜底 500。
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 入口守卫：入参必须是普通对象，否则 `AppError('invalid', '参数不合法')`。 */
export function requirePlainObject(raw: unknown): Record<string, unknown> {
  if (!isPlainObject(raw)) throw new AppError('invalid', '参数不合法');
  return raw;
}

const BAD_REQUIREMENT_ID = '需求 ID 格式不正确';

// required_error / invalid_type_error 显式给中文：缺字段或给 null 时 zod 默认是
// 英文 'Required' / 'Expected string, received null'，而这里的中文是唯一对外出口。
const RequirementId = z.string({
  required_error: BAD_REQUIREMENT_ID,
  invalid_type_error: BAD_REQUIREMENT_ID,
}).uuid(BAD_REQUIREMENT_ID);

/**
 * 需求 ID 先校验成 uuid 再进 SQL：非 uuid 会被 PG 以 22P02 拒绝，那不是 AppError，
 * 控制器按 `e.code` 分支时只能把它当未知错误。
 */
export function parseRequirementId(input: Record<string, unknown>): string {
  const parsed = RequirementId.safeParse(input.requirementId);
  if (!parsed.success) {
    throw new AppError('invalid', parsed.error.issues[0]?.message ?? BAD_REQUIREMENT_ID);
  }
  return parsed.data;
}
