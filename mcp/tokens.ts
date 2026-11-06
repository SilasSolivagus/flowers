import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from '../src/db/client.js';
import { AppError } from '../src/core/errors.js';
import { parseId } from '../src/core/validate.js';

/**
 * MCP 的 HTTP 端点怎样把「一个请求」换成「一个人」。
 *
 * 这个文件只做一件事：`Authorization` 头 → `Identity`。它不改任何领域服务，
 * 也不在服务层的签名上加参数——服务层收的一直是 `actor: string`（那个人名），
 * 这里只是把这个字符串的**来源**从 cookie 换成 token。
 *
 * 三条口径：
 *
 * 1. **只有 sha256 进库。** 生成时算一次，验的时候算一次，原文只出现在 mint 的返回值里
 *    一次。选 sha256 而不是 bcrypt：token 是 32 字节的随机值，没有字典可以查，
 *    而每个 `tools/call` 都要验一次——慢哈希在这里买不到任何东西，只买到延迟。
 * 2. **鉴权先于一切。** 缺头、形状不对这两种失败**一次查询都不发**：它们是
 *    「这个请求根本不是我们的客户端」，不该换来一次数据库往返。只有形状对了才去查
 *    `token_hash`（唯一索引），查不到或 `revoked_at` 非空都是同一句话——
 *    分开说「不存在」与「已撤销」等于告诉试探者哪个 token 曾经是真的。
 * 3. **scope 是包含关系**（read ⊂ write）。**没有 admin 这一级**：今天没有任何工具
 *    需要它，留一个用不到的更高级权限，迟早有人以为它「更管用」而去申请。等真有
 *    管理类工具再加，加的时候顺带改库里的 CHECK 约束。
 */

/** token 的取值集合。库里有一条 CHECK 约束逐字守着它（schema.ts 的 mcpTokens）。 */
export const SCOPES = ['read', 'write'] as const;
export type Scope = (typeof SCOPES)[number];

/**
 * 两级权限的高低。数值只用来比较，不落库。
 *
 * read：只读工具（看板、详情、PRD 快照、任务包）——**保证不写库**；
 * write：一切会写 `events.actor`、会推进状态、会落产物的工具。
 */
const RANK: Record<Scope, number> = { read: 0, write: 1 };

/** `held` 够不够干 `needed` 这件事。 */
export function scopeAllows(held: Scope, needed: Scope): boolean {
  return RANK[held] >= RANK[needed];
}

/** 中文名只给错误消息用：界面与文档里说的都是「写权限」，不是 `write`。 */
const SCOPE_LABEL: Record<Scope, string> = {
  read: '读',
  write: '写',
};

export function scopeLabel(scope: Scope): string {
  return SCOPE_LABEL[scope];
}

export function isScope(value: unknown): value is Scope {
  return typeof value === 'string' && (SCOPES as readonly string[]).includes(value);
}

/**
 * token 长什么样：`flw_` + 43 个 base64url 字符（32 字节）。
 *
 * 前缀不是为了好看：它让「这是不是我们的 token」在**查库之前**就能回答，
 * 于是配置错（比如把 `Bearer` 后面接了一个旧密钥）不会换来一次数据库往返。
 * 长度固定在正则里，等于把「格式」这件事只写一份。
 */
const TOKEN_SHAPE = /^flw_[A-Za-z0-9_-]{43}$/;

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** 请求换来的身份。`member` 就是服务层的 `actor`——整套服务对外都用姓名标识人。 */
export type Identity = {
  tokenId: string;
  memberId: string;
  member: string;
  scope: Scope;
};

/** 「这个人是谁、能干什么」之外，还要能回答「这个 token 是哪个」。 */
export type TokenView = {
  id: string;
  member: string;
  label: string;
  scope: Scope;
  createdAt: Date;
  revokedAt: Date | null;
};

export const MISSING_TOKEN = '缺少 token：请求头要带 Authorization: Bearer <token>';
export const BAD_TOKEN = 'token 无效或已撤销';

export type AuthResult =
  | { ok: true; identity: Identity }
  | { ok: false; status: 401; message: string };

/**
 * `Authorization` 头 → 原文 token。只认 `Bearer <值>`，scheme 大小写不敏感
 * （客户端各家写法不一样，RFC 7235 也说 scheme 不区分大小写）。
 *
 * 其它形状（`Basic …`、只给一个裸的值）一律当没有：一个「差不多能用」的鉴权头
 * 比一个明确的 401 更难查。
 */
export function bearerOf(header: string | null | undefined): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * 查一个 hash 对应的、**未撤销**的身份。
 *
 * 单独抽出来是为了可测：`authenticate` 里唯一会碰库的那一步就是它，于是
 * 「缺头 / 形状不对时一次查询都不发」这条可以由用例直接钉住（spy 这个方法没被调用）。
 * join `members` 而不是分两次查：token 存在而成员不存在的行只可能来自绕过外键的
 * 手改，那时 join 不出行、按「无效」处理，比一层 `if (member === undefined)` 更短。
 */
export async function lookupTokenByHash(db: Db, hash: string): Promise<Identity | null> {
  const res = await db.execute<{
    id: string; member_id: string; name: string; scopes: string;
  }>(sql`
    select t.id, t.member_id, m.name, t.scopes
      from mcp_tokens t
      join members m on m.id = t.member_id
     where t.token_hash = ${hash} and t.revoked_at is null
     limit 1`);
  const row = res.rows[0];
  if (row === undefined || !isScope(row.scopes)) return null;
  return {
    tokenId: row.id,
    memberId: row.member_id,
    member: row.name,
    scope: row.scopes,
  };
}

/**
 * 请求头 → 身份。**这是唯一入口**，HTTP 路由与用例都只碰这一个函数。
 *
 * 顺序是刻意的：先判头在不在、再判形状、最后才查库。前两步失败时这个函数
 * 一次数据库都不碰——「一个没有 token 的请求不该让服务器替它查一次索引」。
 */
export async function authenticate(
  db: Db,
  authorization: string | null | undefined,
): Promise<AuthResult> {
  const raw = bearerOf(authorization);
  if (raw === null) return { ok: false, status: 401, message: MISSING_TOKEN };
  // 形状不对不必查库：这条分支覆盖「旧密钥」「把别的服务的 key 贴过来了」这些最常见的
  // 配置错误，它们的答案与「查了但没查到」是同一句中文。
  if (!TOKEN_SHAPE.test(raw)) return { ok: false, status: 401, message: BAD_TOKEN };

  const identity = await lookupTokenByHash(db, hashToken(raw));
  if (identity === null) return { ok: false, status: 401, message: BAD_TOKEN };
  return { ok: true, identity };
}

/** 生成一次 token 的结果。`raw` **只在这里出现一次**，之后库里只有它的 sha256。 */
export type Minted = {
  id: string;
  raw: string;
  label: string;
  scopes: Scope;
  createdAt: Date;
};

const BAD_LABEL = '给这个 token 起个名字（例如 claude-code），列表里才分得清是谁的';
const BAD_SCOPE = '权限只能是 read、write 之一';
const BAD_MEMBER = '成员不存在';

/**
 * 生成一个 token。
 *
 * 为什么 label 必填：设置页那一列是「label + 日期 + 撤销」，一个空 label 让 owner 面对
 * 三个长得一样的 token，撤销的时候只能猜。`agent` 这种默认值比空串好，但仍然是猜——
 * 所以这里要求调用方给一个能认出来的名字。
 *
 * 为什么成员必须存在（先查一次 `members`）：外键会拦住不存在的 id，但那是 23503，
 * 一句英文；这里先查一次换成中文，代价是生成 token 时多一次索引命中——这件事一天
 * 做不了几次，而「把 token 记在一个不存在的人头上」是这个功能最坏的坏法：
 * 时间线上会出现一个查无此人的 actor。
 */
export async function mintToken(
  db: Db,
  input: { memberId: string; label: string; scopes: Scope },
): Promise<Minted> {
  const memberId = parseId(input.memberId, BAD_MEMBER);
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  if (label === '') throw new AppError('invalid', BAD_LABEL);
  if (!isScope(input.scopes)) throw new AppError('invalid', BAD_SCOPE);

  const found = await db.execute<{ id: string }>(
    sql`select id from members where id = ${memberId} limit 1`);
  if (found.rows[0] === undefined) throw new AppError('not_found', BAD_MEMBER);

  const raw = `flw_${randomBytes(32).toString('base64url')}`;
  const inserted = await db.execute<{ id: string; created_at: Date }>(sql`
    insert into mcp_tokens (token_hash, member_id, label, scopes)
    values (${hashToken(raw)}, ${memberId}, ${label}, ${input.scopes})
    returning id, created_at`);
  const row = inserted.rows[0];
  if (row === undefined) throw new Error('生成 token 失败：insert 没有返回行');

  return {
    id: row.id,
    raw,
    label,
    scopes: input.scopes,
    createdAt: new Date(row.created_at),
  };
}

/**
 * 撤销：写 `revoked_at`，**不删行**。
 *
 * 返回值是「这次有没有真的撤销一个还活着的 token」：已撤销的再撤一次是 false，
 * 而不是抛错——按两次「撤销」不该给用户一句报错，库里那条时间线也不该被改写。
 */
export async function revokeToken(db: Db, id: string): Promise<boolean> {
  const tokenId = parseId(id, 'token ID 格式不正确');
  const res = await db.execute<{ id: string }>(sql`
    update mcp_tokens set revoked_at = now()
     where id = ${tokenId} and revoked_at is null
     returning id`);
  return res.rows.length > 0;
}

/**
 * 设置页那一列：全部 token（含已撤销的），按生成时间倒序。
 *
 * 为什么把已撤销的也列出来：撤销是「这个 token 从现在起不能用」，不是「它没存在过」。
 * 时间线上还可能留着它写过的事件，列表里少了那一行，owner 会以为是自己记错了。
 */
export async function listTokens(db: Db): Promise<TokenView[]> {
  const res = await db.execute<{
    id: string; name: string; label: string; scopes: string;
    created_at: Date; revoked_at: Date | null;
  }>(sql`
    select t.id, m.name, t.label, t.scopes, t.created_at, t.revoked_at
      from mcp_tokens t
      join members m on m.id = t.member_id
     order by t.created_at desc, t.id desc`);
  return res.rows.flatMap((row): TokenView[] => {
    // 认不出的 scope（手改过的库）不猜、也不假装成 read：整行跳过，列表如实少一行。
    if (!isScope(row.scopes)) return [];
    return [{
      id: row.id,
      member: row.name,
      label: row.label,
      scope: row.scopes,
      createdAt: new Date(row.created_at),
      revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at),
    }];
  });
}
