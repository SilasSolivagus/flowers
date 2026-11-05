export class AppError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AppError';
  }
}

/**
 * Postgres 唯一约束冲突（unique_violation）。
 *
 * 编号从序列取之后这条错误码不该再从正常路径出现；留着这道转换是为了「万一出现」：
 * 它会以英文的 `duplicate key value violates unique constraint ...` 漏到控制器，
 * 而控制器是按 `e.code` 分支的（见 validate.ts 里对 22P02 的同一类处理）。
 */
const UNIQUE_VIOLATION = '23505';

/** 只关心 code：pg 的 DatabaseError 是个普通 Error 子类，带上 driver 自己的字段。 */
function isPgError(value: unknown): value is { code: string; constraint?: string } {
  return typeof value === 'object' && value !== null && 'code' in value
    && typeof (value as { code: unknown }).code === 'string';
}

/**
 * 把 PG 的 23505 翻成 AppError，其它错误原样放行（不吞、不改写）。
 *
 * 为什么不带出 constraint 名：那是库内结构，不该出现在用户消息里；
 * 需要定位时看服务端日志的原始错误即可。
 */
export function translatePgError(error: unknown): unknown {
  if (!isPgError(error) || error.code !== UNIQUE_VIOLATION) return error;
  return new AppError('conflict', '编号冲突，请重试');
}

/**
 * 在「分配编号」的边界上做一次转换：调用方拿到的一定是 AppError 或原样错误，
 * 不会是裸的 pg 错误。写在边界而不是每个 insert 上，是为了让事务里抛出的任何
 * 唯一冲突都走同一条翻译（事务会回滚，原始错误原样穿出 db.transaction）。
 */
export async function withPgErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw translatePgError(error);
  }
}
