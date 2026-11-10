import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { AppError } from '../errors.js';

/**
 * 密码：`node:crypto` 的 scrypt，每人一个盐，比较是常数时间。
 *
 * 为什么是 scrypt 而不是 sha256：这里的输入是**人选的密码**，不是 32 字节随机值。
 * 人会选 `12345678`、会用生日，而 sha256 快到每秒几十亿次——一张消费级显卡就能把
 * 一个小字典跑穿。scrypt 是内存硬的（N=16384, r=8 → 约 16 MB / 次），把「并行猜」
 * 的成本从「多买几张卡」抬成「多买几台机器」。
 *
 * 为什么参数写进存储串：将来调 N（或换算法）时，**老行仍然能验**——验证只看串里
 * 记着的参数，不看今天代码里的常量。不写进串的后果是「改一次参数，所有人登录不了」。
 *
 * 存储格式（`$` 分隔）：
 *
 * ```
 * scrypt$16384$8$1$<salt: base64url>$<derivedKey: base64url>
 * ```
 *
 * 为什么不用 bcrypt/argon2：node 里没有（bcrypt 是原生模块，argon2 要编译），而
 * 「不新增依赖」是本轮的硬约束。scrypt 在 `node:crypto` 里，标准库自带。
 */

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

/**
 * 团队统一的新人密码（2026-11-10，owner 的裁定）。
 *
 * 为什么不再随机生成：随机密码的代价落在**发密码那条路**上——种子把七行印在终端里、
 * 超管把一串 `kXm3…` 念给新人，念错一个字符就进不去，而谁都拿不回明文（库里只有
 * scrypt 串）。owner 的判断是：这个部署是内网、人不多、入职当天就要能登，**统一一个
 * 大家都知道的初始密码**比「每人一串抄不走的东西」更可靠。这不是把密码强度降级成
 * 秘密共享——它仍然是一条要改的密码，所以界面上明确写着「在我的 · 改」。
 *
 * 三处口径**同一份**（都读这个常量，没有第二处写这串字面量）：
 * - `createMember` 建人时的默认密码（设置 · 成员 · 新增）；
 * - 迁移 `0037`（存量成员一次性落到这条密码上，哈希是**预先算好**写进 SQL 的）；
 * - `scripts/seed.ts`（重灌之后的七个人）。
 *
 * 明文**不进日志**：种子与报告只说「统一为团队约定的初始密码」，不再把它打印到终端；
 * 迁移文件里只有 scrypt 串，没有明文。
 */
export const DEFAULT_MEMBER_PASSWORD = '2026@123pan';

/** 最短密码长度。**只在一个地方**（`assertPassword`），界面与测试都从它读。 */
export const MIN_PASSWORD_LENGTH = 8;

export const WEAK_PASSWORD = `密码至少 ${MIN_PASSWORD_LENGTH} 位`;

/** 密码太短 / 不是文本。中文，逐字给用户看。 */
export function assertPassword(plain: unknown): string {
  if (typeof plain !== 'string') throw new AppError('weak_password', WEAK_PASSWORD);
  if (plain.length < MIN_PASSWORD_LENGTH) throw new AppError('weak_password', WEAK_PASSWORD);
  return plain;
}

function b64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

/**
 * 生成一个密码。字符表刻意去掉 `0 O 1 l I`：这些字符会被念错、抄错，而初始密码是
 * 要**人念给人**的（种子跑完打印一次）。
 */
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generatePassword(length = 14): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

/** 明文 → 存储串。每次调用都换一个新盐（同一密码的两个账号不会有同一个 hash）。 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await scrypt(plain, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, b64url(salt), b64url(key)].join('$');
}

/**
 * 验一个密码。**永远不抛**（除了返回值 false）：存储串坏掉、缺字段、长度不对，
 * 一律是「验不过」。密码校验不该因为一行脏数据把登录页变成 500——那会把「这个库
 * 里有一条坏行」升级成「谁都进不来」，而且错误信息还会把坏行的细节漏出去。
 */
export async function verifyHash(plain: string, stored: string | null | undefined): Promise<boolean> {
  if (typeof stored !== 'string' || stored === '') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, 'base64url');
    expected = Buffer.from(parts[5]!, 'base64url');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = await scrypt(plain, salt, expected.length, { N: n, r, p });
  } catch {
    // 参数不合法（N 不是 2 的幂之类）会在这里抛，按验不过处理。
    return false;
  }
  if (actual.length !== expected.length) return false;
  // 常数时间比较：长度相等之后 timingSafeEqual 不随内容提前返回。
  return timingSafeEqual(actual, expected);
}

/**
 * 写一个新密码（调用方负责鉴权——`setPassword` 只管落库）。
 *
 * `password_updated_at` 与 hash 同一条 update：两列必须一起变，否则审计线会说谎。
 */
export async function setPassword(
  db: Db | { execute: Db['execute'] },
  memberId: string,
  plain: string,
): Promise<void> {
  const password = assertPassword(plain);
  const hash = await hashPassword(password);
  const res = await db.execute(sql`
    update members set password_hash = ${hash}, password_updated_at = now(), session_epoch = now()
     where id = ${memberId}
     returning id`);
  if (res.rows.length === 0) throw new AppError('not_found', '成员不存在');
}

/**
 * 一个固定的假 hash，用来给「这个账号不存在」的那条路**同样跑一次 scrypt**。
 *
 * 不这么做的话，「查无此人」会在 1 毫秒内返回，而「密码错」要 60 毫秒——时间差本身
 * 就是一台花名册探测器，和错误文案分不分叉是同一件事的两面。
 *
 * 懒生成、只生成一次：它是常量，不值得在模块加载时占 60ms。
 */
let decoy: Promise<string> | null = null;
function decoyHash(): Promise<string> {
  decoy ??= hashPassword('flowers-decoy-password');
  return decoy;
}

/**
 * 给「没有这一行 / 这一行没有密码」的登录尝试跑一次等价的计算，然后返回 false。
 *
 * 停用的账号也走这一条（登录被拒，且与「密码错」同一句话，见 login.ts）。
 */
export async function burnDecoy(plain: string): Promise<false> {
  await verifyHash(plain, await decoyHash());
  return false;
}
