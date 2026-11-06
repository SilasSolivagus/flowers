/**
 * 模型回话的**形状容错**层。
 *
 * 为什么要有这一层，以及它和校验的分工：
 *
 * - 这一层只解决「同一个意思写成了另一种形状」，例如 `一致` / `implemented`、
 *   `anno: ["一致","说明"]` 少了一层数组、`evidence: {file:"repo:path"}` 换了字段名。
 *   这些都是**读得懂**的，退回重答等于拿一次调用（真实成本：一轮两分钟）换一个标点。
 * - 这一层**绝不**判断内容真假。路径是否存在、`missing` 有没有乱引、结论是否自相矛盾，
 *   全部留给 `validateStructure` / `validateWalkmap` 那些硬门。放宽形状，不放松事实。
 *
 * 三个解析器（`readFragments` / `readStructure` / `readVerify`）共用本文件——
 * 早前容错只写在走查那两个里，评估材料那条路一直裸奔，只是恰好没被打中。
 *
 * 每一处容错都对应一次**真实观测**（模型是哪个、原话长什么样），不是猜的。
 */

// ─── 枚举：判断结论、设备框、节点类型 ────────────────────────────────────────

export type Verdict = 'implemented' | 'missing' | 'extra' | 'differs';

/**
 * verdict 的别名表。
 *
 * 为什么要有它：真实跑出来的第一版回话写的是 `"verdict": "missing/缺失"`——模型把
 * 枚举值和自己要写的中文标注粘在了一起。这**不是**「判断错了」，只是同一个判断的
 * 另一种拼法；为它整份退回重答，等于拿一次调用（和一次预扣）换一个斜杠。
 * 收窄回四选一仍然是硬要求：认不出来的字符串照样让 zod 拒掉。
 */
const VERDICT_ALIASES: Record<string, Verdict> = {
  implemented: 'implemented', missing: 'missing', extra: 'extra', differs: 'differs',
  一致: 'implemented', 缺失: 'missing', 多余: 'extra', 不一致: 'differs',
};

export function normalizeVerdict(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  const direct = VERDICT_ALIASES[trimmed] ?? VERDICT_ALIASES[trimmed.toLowerCase()];
  if (direct !== undefined) return direct;
  // `missing/缺失` / `implemented（一致）` / `differs | 不一致`：取第一个片段。
  const head = trimmed.split(/[/|｜、,，;；\s（()）]+/).map((part) => part.trim()).filter((part) => part !== '')[0] ?? '';
  const byHead = VERDICT_ALIASES[head] ?? VERDICT_ALIASES[head.toLowerCase()];
  if (byHead !== undefined) return byHead;
  // 兜底：整句里出现哪个词就归哪一类（`"部分一致但缺面包屑"` 这种）。
  if (trimmed.includes('缺') || /miss/i.test(trimmed)) return 'missing';
  if (trimmed.includes('多') || /extra|unexpected/i.test(trimmed)) return 'extra';
  if (trimmed.includes('不一致') || trimmed.includes('差异') || /differ/i.test(trimmed)) return 'differs';
  if (trimmed.includes('一致') || /implement|match|ok/i.test(trimmed)) return 'implemented';
  return value;
}

/**
 * 设备框宽度。模型常把这一格写成一句人话（实测 `"分享页浏览"`）。
 * 判据只影响排版，不影响事实判断，所以给默认值而不是退回重答。
 */
export function normalizeFrame(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t === 'phone' || t === 'wide') return t;
  if (/wide|宽|后台|管理|PC|web|desktop|table/i.test(t)) return 'wide';
  return 'phone';
}

/** 节点类型同源：`"判断"` / `"系统"` 写成中文也要认得。 */
export function normalizeKind(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t === 'page' || t === 'decision' || t === 'system') return t;
  if (t.includes('判') || /decision|branch/i.test(t)) return 'decision';
  if (t.includes('系统') || /system/i.test(t)) return 'system';
  return 'page';
}

// ─── 标注 anno：少一层数组、写成对象 ─────────────────────────────────────────

/**
 * 标注的形状：我们要 `[["一致","说明"], …]`，模型常写成 `["一致","说明"]`——
 * 一个节点只有一条标注时，它把成对的两个字段摊成了一层。这是**同一条信息**，
 * 只是少了那一层数组；配对收上来，别为它重跑一轮（一轮两分钟）。
 */
export function coerceAnno(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  if (value.every((row) => Array.isArray(row))) return value;
  const strs = value.filter((row): row is string => typeof row === 'string');
  if (strs.length !== value.length) return value;
  if (strs.length === 0) return value;
  if (strs.length % 2 !== 0) return [[strs[0]!, strs.slice(1).join(' ')]];
  const rows: string[][] = [];
  for (let i = 0; i < strs.length; i += 2) rows.push([strs[i]!, strs[i + 1]!]);
  return rows;
}

// ─── 证据 evidence：字符串 / {file:...} / 单对象 ──────────────────────────────

/** 证据的形状漂移：模型常把 `{repo,path,note}` 写成 `"repo:path"` 或光一个路径。 */
const REPO_PREFIX = /^([A-Za-z0-9_.-]+):(.+)$/;

/**
 * 把 evidence 里的一格尽量"扶正"成对象。
 *
 * 为什么容错而不是退回重答：实测 deepseek-flash 第一次把 evidence 写成
 * `["123pan-pc:src/x.ts"]`——它**说的是对的**，只是没照我们的对象格式写。
 * 为这种形状差异烧一次调用不合算，而**校验仍然在后面**：扶正出来的 path 一样要
 * 拿 `lsTree` 核，编造照样拦得住。所以这里放宽形状，不放松事实。
 *
 * 第二次实测又换了写法：`{file:"123pan-pc:src/x.ts", note:"…"}`。所以这里不去猜
 * 字段名，而是看**值**——哪个字符串里带 `仓库id:路径`，就用哪一个。
 */
export function coerceEvidence(item: unknown, repoIds: string[]): unknown {
  if (typeof item === 'object' && item !== null) {
    const o = item as Record<string, unknown>;
    if (typeof o.repo === 'string' && typeof o.path === 'string') return o;
    const values = Object.values(o).filter((v): v is string => typeof v === 'string');
    for (const v of values) {
      const m = REPO_PREFIX.exec(v.trim());
      if (m !== null && repoIds.includes(m[1]!)) return { ...o, repo: m[1], path: m[2]!, note: o.note ?? '' };
    }
    // 只给了路径（没有仓库前缀）：单仓才敢补，多仓留给校验器点名。
    const pathish = values.find((v) => /\.\w{1,6}$/.test(v) && !/\s/.test(v));
    if (pathish !== undefined && repoIds.length === 1) {
      return { ...o, repo: repoIds[0], path: pathish.trim(), note: o.note ?? '' };
    }
    return o;
  }
  if (typeof item !== 'string') return item;
  const text = item.trim();
  if (text === '') return item;
  const m = REPO_PREFIX.exec(text);
  if (m !== null && repoIds.includes(m[1]!)) return { repo: m[1], path: m[2]!, note: '' };
  // 没有 repo 前缀：只给了一个路径。仓库留空，交给校验器指出来是哪一家缺。
  if (repoIds.length === 1) return { repo: repoIds[0], path: text, note: '' };
  return { repo: '', path: text, note: '' };
}

// ─── 顶层与 findings ────────────────────────────────────────────────────────

/**
 * 顶层形状：模型有时把整个回答写成数组（只有 findings），有时用 `results` 当键。
 *
 * 只在模型**确实用了别名**时才改名；**绝不凭空补 `flows`/`findings`**——
 * 复核段的回话是 `{nodes, …}`，补进去两个空数组会让它看起来"结构不完整"，
 * 于是还没校验就报「flows 有 0 个」，白烧一次调用（实测过一次）。
 */
function coerceRoot(raw: unknown): unknown {
  if (Array.isArray(raw)) return { flows: [], findings: raw };
  if (typeof raw !== 'object' || raw === null) return raw;
  const o = raw as Record<string, unknown>;
  if (Array.isArray(o.nodes)) {
    return {
      ...o,
      nodes: o.nodes.map((n) =>
        typeof n === 'object' && n !== null && 'anno' in n
          ? { ...(n as Record<string, unknown>), anno: coerceAnno((n as Record<string, unknown>).anno) }
          : n),
    };
  }
  if (o.findings === undefined && Array.isArray(o.results)) return { ...o, findings: o.results };
  return raw;
}

/** findings 里逐条扶正：evidence 的形状 + searched 写成字符串。 */
function coerceFindings(raw: unknown, repoIds: string[]): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.findings)) return raw;
  return {
    ...o,
    findings: o.findings.map((f) => {
      if (typeof f !== 'object' || f === null) return f;
      let g = f as Record<string, unknown>;
      // searched 写成单个字符串（实测）：套一层数组。
      // 注意：这里**不能提前 return**——早前那样写会把下面的 evidence 扶正整段跳过，
      // 于是 `["repo:path"]` 原样进了校验器（冒烟测出来的）。
      if (typeof g.searched === 'string') g = { ...g, searched: [g.searched] };
      // evidence 写成单个数（对象或字符串）而不是数组：套成一层数组，别退回重答。
      let evidence = g.evidence;
      if (evidence !== undefined && !Array.isArray(evidence)) evidence = [evidence];
      if (!Array.isArray(evidence)) return g;
      return { ...g, evidence: evidence.map((item) => coerceEvidence(item, repoIds)) };
    }),
  };
}

/**
 * 一个入口：回话原文 → 尽量扶正成我们 schema 认得的形状。
 *
 * `repoIds` 只有走查用得上（证据要认仓库），评估材料那条路传空数组即可。
 */
export function coerceAnswer(raw: unknown, repoIds: string[] = []): unknown {
  return coerceFindings(coerceRoot(raw), repoIds);
}
