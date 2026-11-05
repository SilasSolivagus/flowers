import { z } from 'zod';
import { AppError } from './errors.js';

/**
 * 非对象 body（undefined / null / 数组 / 字符串 / 数字）统一成中文错误。
 * 服务入口不先过这一关，字段访问就会抛 TypeError，控制器只能兜底 500。
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 表单字段运行时可能是 undefined / null / 非字符串，先归一成去掉首尾空白的字符串。
 *
 * 六个服务各自实现过一遍（其中两处逐字相同，三处是内联的三元表达式）：`a.trim()`
 * 对 undefined 抛的是 TypeError，而控制器只会把它当 500。归一到一处，行为与文案
 * 都不必在六份实现之间保持一致。
 */
export function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 入口守卫：入参必须是普通对象，否则 `AppError('invalid', '参数不合法')`。 */
export function requirePlainObject(raw: unknown): Record<string, unknown> {
  if (!isPlainObject(raw)) throw new AppError('invalid', '参数不合法');
  return raw;
}

const BAD_REQUIREMENT_ID = '需求 ID 格式不正确';
const BAD_RELEASE_ID = '版本 ID 格式不正确';

/**
 * 任一 uuid 字段的入口校验。
 *
 * 先校验成 uuid 再进 SQL：非 uuid 会被 PG 以 **22P02** 拒绝，那不是 AppError，
 * 控制器按 `e.code` 分支时只能把它当未知错误（500）。
 *
 * required_error / invalid_type_error 显式给中文：缺字段或给 null 时 zod 默认是
 * 英文的 'Required' / 'Expected string, received null'，而这里的中文是唯一对外出口。
 */
export function parseId(value: unknown, message: string): string {
  const parsed = z.string({
    required_error: message,
    invalid_type_error: message,
  }).uuid(message).safeParse(value);
  if (!parsed.success) {
    throw new AppError('invalid', parsed.error.issues[0]?.message ?? message);
  }
  return parsed.data;
}

/** 需求 ID（uuid）。 */
export function parseRequirementId(input: Record<string, unknown>): string {
  return parseId(input.requirementId, BAD_REQUIREMENT_ID);
}

/**
 * 版本 ID（uuid）。
 *
 * 单独一个入口而不是让 schedule 自己调 parseId：文案属于这一层，调用点只该说
 * 「这是版本 ID」。空值仍然由调用方先报 missing_dates（缺字段与格式不对是两回事，
 * 用户看到的提示也不同）。
 */
export function parseReleaseId(value: unknown): string {
  return parseId(value, BAD_RELEASE_ID);
}
