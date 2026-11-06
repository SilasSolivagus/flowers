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
  // 实测：模型发明了第五个取值 `partial/部分实现`。语义上就是「不一致」，
  // 收进来而不是退回——它不是判断错，只是枚举里多了一个同义词。
  partial: 'differs', 部分实现: 'differs', 部分一致: 'differs',
  inconsistent: 'differs', 不在范围: 'extra', 多出: 'extra', 未实现: 'missing',
};

export function normalizeVerdict(value: unknown): unknown {
  // 实测出现过 `["inconsistent/不一致"]`：只包了一层数组，取第一个再走同一套判定。
  if (Array.isArray(value) && value.length > 0) return normalizeVerdict(value[0]);
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

// ─── 评审问题的类型：六个固定档，模型会写成别的说法 ─────────────────────────

/**
 * 评审「问题清单」的六类。**只有这六个**，因为界面按它决定那一行的中文标签
 * （`死路` / `无页面步骤` / `缺状态` / `歧义` / `缺验收口径` / `边界未定`）。
 */
export type ReviewFindingType =
  // 文档自身的毛病：不知道代码现状也能挑出来
  | 'dead_end' | 'no_screen' | 'missing_state' | 'ambiguous' | 'no_acceptance' | 'unbounded'
  // 改动层面的毛病：**必须先知道现状**才说得出来（见 review.ts 的 baseline 段）
  | 'conflicts_current' | 'misses_current_edge' | 'no_migration';

/** 需要「现状」才能成立的类型。它们必须带代码证据。 */
export const BASELINE_TYPES: readonly ReviewFindingType[] =
  ['conflicts_current', 'misses_current_edge', 'no_migration'];

/**
 * 别名表。三种来源，都是**同一个判断的另一种拼法**，不是判断错：
 * 1. 界面标签本身（模型看得见提示词里的六个中文名，直接抄回来）；
 * 2. 旧任务包（`packs.ts` 的 review 段）里的那份词表——同一个模型在别的入口见过
 *    「歧义词」「未知角色」，会顺手用；
 * 3. 一句近义短语（`状态不全`、`没有出口`、`边界不清`）。
 *
 * 认不出来的字符串照样让 zod 拒掉（与 `normalizeVerdict` 同一条口径）：
 * 放宽形状，不放松「必须是这六类之一」。
 */
const REVIEW_TYPE_ALIASES: Record<string, ReviewFindingType> = {
  dead_end: 'dead_end', no_screen: 'no_screen', missing_state: 'missing_state',
  ambiguous: 'ambiguous', no_acceptance: 'no_acceptance', unbounded: 'unbounded',
  死路: 'dead_end', 无页面步骤: 'no_screen', 缺状态: 'missing_state', 歧义: 'ambiguous',
  缺验收口径: 'no_acceptance', 边界未定: 'unbounded',
  conflicts_current: 'conflicts_current', misses_current_edge: 'misses_current_edge',
  no_migration: 'no_migration',
  与现状冲突: 'conflicts_current', 和现状冲突: 'conflicts_current', 现状冲突: 'conflicts_current',
  漏了现状边界: 'misses_current_edge', 漏了现状的边界: 'misses_current_edge',
  现状边界遗漏: 'misses_current_edge', 忽略既有边界: 'misses_current_edge',
  没说怎么迁移: 'no_migration', 缺迁移方案: 'no_migration', 迁移未说明: 'no_migration',
  未说明迁移: 'no_migration',
  死循环: 'dead_end', 断头: 'dead_end', 无出口: 'dead_end', 没有出口: 'dead_end',
  无页面: 'no_screen', 缺页面: 'no_screen', 没有页面: 'no_screen', 页面缺失: 'no_screen',
  状态缺失: 'missing_state', 状态不全: 'missing_state', 缺交互状态: 'missing_state',
  异常态缺失: 'missing_state', 缺异常态: 'missing_state',
  歧义词: 'ambiguous', 二义: 'ambiguous', 有歧义: 'ambiguous', 表述歧义: 'ambiguous',
  缺验收: 'no_acceptance', 无验收标准: 'no_acceptance', 缺验收标准: 'no_acceptance',
  没有验收口径: 'no_acceptance', 验收缺失: 'no_acceptance',
  边界未定义: 'unbounded', 边界不清: 'unbounded', 边界不明: 'unbounded',
  未定边界: 'unbounded', 未知角色: 'unbounded', 角色未定义: 'unbounded',
};

function reviewType(value: string): ReviewFindingType | undefined {
  return REVIEW_TYPE_ALIASES[value] ?? REVIEW_TYPE_ALIASES[value.toLowerCase()];
}

/**
 * `type` 这一格：`"死路"`、`"dead_end"`、`["missing_state"]`、`"no_screen/无页面步骤"`
 * 收成六选一；收不回来的原样交回 zod。
 */
export function normalizeFindingType(value: unknown): unknown {
  // 实测同族：`["inconsistent/不一致"]`——只包了一层数组，取第一个再走同一套判定。
  if (Array.isArray(value) && value.length > 0) return normalizeFindingType(value[0]);
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  const direct = reviewType(trimmed);
  if (direct !== undefined) return direct;
  // `no_screen/无页面步骤` / `缺状态（异常）`：取第一个片段。
  const head = trimmed.split(/[/|｜、,，;；\s（()）]+/).map((part) => part.trim()).filter((part) => part !== '')[0] ?? '';
  const byHead = reviewType(head);
  if (byHead !== undefined) return byHead;
  // 兜底：整句里出现哪个词就归哪一类（`"这一步之后走不下去了"`）。
  if (trimmed.includes('死路') || trimmed.includes('出口')) return 'dead_end';
  if (trimmed.includes('页面')) return 'no_screen';
  if (trimmed.includes('验收')) return 'no_acceptance';
  if (trimmed.includes('状态')) return 'missing_state';
  if (trimmed.includes('现状冲突') || trimmed.includes('冲突')) return 'conflicts_current';
  if (trimmed.includes('迁移')) return 'no_migration';
  if (trimmed.includes('既有') || trimmed.includes('现状')) return 'misses_current_edge';
  if (trimmed.includes('歧义') || /ambigu/i.test(trimmed)) return 'ambiguous';
  if (trimmed.includes('边界') || /unbound/i.test(trimmed)) return 'unbounded';
  return value;
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
/**
 * 一条字符串里其实写了**多份**证据。
 *
 * 实测（132 次调用里 30 条）：模型把三个证据拼成了一段——
 * `"123pan-pc:src/a.ts、123pan-uni-app:src/b.vue、123pan-pc:src/c.ts"`。
 * 早前的容错只认第一个，于是把**真实存在**的路径报成「不存在」——容错反而造了假。
 * 这里按中英文顿号/逗号/分号/换行切开，每一段各自扶正。
 */
function splitEvidenceString(text: string): string[] {
  return text.split(/[、，,;；\n]+/).map((part) => part.trim()).filter((part) => part !== '');
}

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
      nodes: o.nodes.map((n) => {
        if (typeof n !== 'object' || n === null) return n;
        const node = n as Record<string, unknown>;
        const out: Record<string, unknown> = { ...node };
        if ('anno' in out) out.anno = coerceAnno(out.anno);
        // 漏写 title（实测 nodes.3.title Required）：标题就是节点 id，不算编造——
        // 它没有提供新信息，也不会让读者误解这一步是什么（id 是流程图的唯一标识）。
        if (typeof out.title !== 'string' || out.title.trim() === '') {
          if (typeof out.id === 'string') out.title = out.id;
        }
        return out;
      }),
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
      // 实测：`searched: true`。布尔只表示"搜过了"，没给词组，等价于没给。
      if (typeof g.searched === 'boolean') { const { searched: _drop, ...rest } = g; g = rest; }
      // evidence 写成单个数（对象或字符串）而不是数组：套成一层数组，别退回重答。
      let evidence = g.evidence;
      if (evidence !== undefined && !Array.isArray(evidence)) evidence = [evidence];
      if (!Array.isArray(evidence)) return g;
      const flattened = evidence.flatMap((item) => {
        // 字符串里拼了多份：先切开，再逐段扶正（否则只认第一个，把真话判成假话）。
        if (typeof item === 'string') {
          const parts = splitEvidenceString(item);
          if (parts.length > 1) return parts.map((part) => coerceEvidence(part, repoIds));
        }
        return [coerceEvidence(item, repoIds)];
      });
      return { ...g, evidence: flattened };
    }),
  };
}

/**
 * 一个入口：回话原文 → 尽量扶正成我们 schema 认得的形状。
 *
 * `repoIds` 只有走查用得上（证据要认仓库），评估材料那条路传空数组即可。
 */
/** 上一次 coerceAnswer 丢掉的多余节点（诊断/留痕用，按调用顺序追加）。 */
export const droppedNodeLog: string[] = [];

/**
 * 丢掉"图里不存在的节点"。
 *
 * 为什么丢而不是退回重答：流程图已经过引擎验收，是这一份材料的**权威结构**。
 * 模型多写的那个节点挂不到任何流程节点上，walkmap 根本放不进去——**零信息**。
 * 而退回重答要花一整轮（实测每轮 1–2 分钟，这一类的发生率约 1/4）。
 *
 * 覆盖检查仍然在后面：丢掉之后如果真少了节点，`readFragments` 照样拒。
 */
function dropUnknownNodes(raw: unknown, allowed: string[]): unknown {
  if (allowed.length === 0) return raw;
  if (typeof raw !== 'object' || raw === null) return raw;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.nodes)) return raw;
  const seen = new Set(allowed);
  const kept = o.nodes.filter((n) => {
    const id = typeof n === 'object' && n !== null ? (n as { id?: unknown }).id : undefined;
    if (typeof id !== 'string') return true;
    if (seen.has(id)) return true;
    droppedNodeLog.push(id);
    return false;
  });
  return kept.length === o.nodes.length ? raw : { ...o, nodes: kept };
}

export function coerceAnswer(raw: unknown, repoIds: string[] = [], allowedNodeIds: string[] = []): unknown {
  return dropUnknownNodes(coerceFindings(coerceRoot(raw), repoIds), allowedNodeIds);
}

// ─── 截断识别 ────────────────────────────────────────────────────────────────

/**
 * 回话是不是被输出预算截断了。
 *
 * 为什么要单独认这一种：截断的 JSON 解析失败，看起来和「模型写坏了」一模一样，
 * 但处理方式完全相反——写坏了要退回重答，截断要**调大 max_tokens**。报错含糊，
 * 人就会去改提示词，改到天亮也没用。
 *
 * 实测：deepseek-v4-pro 回话 3593 字符、大括号差 2 个，正是这个情形。
 * 判据刻意宽松（括号不配平、或以逗号/冒号收尾），避免把真正的语法错误也认成截断。
 */
export function looksTruncated(text: string): boolean {
  const t = text.trimEnd();
  if (t === '') return false;
  if (/[,:，：]$/.test(t)) return true;
  let curly = 0;
  let square = 0;
  let inStr = false;
  let esc = false;
  for (const ch of t) {
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') curly++;
    else if (ch === '}') curly--;
    else if (ch === '[') square++;
    else if (ch === ']') square--;
  }
  return curly > 0 || square > 0;
}

/**
 * 回话整体看起来是"被截断的 JSON"。
 *
 * 为什么不只看 `extractJson` 的返回：截断的 `{"nodes":[{...` 里，`extractJson` 会
 * **退到内层的第一个配对对象**（比如某个 node），于是报「nodes：Required」——
 * 把"预算不够"诊断成"结构不对"。实测 11 格都是这么错的（completion 正好等于预算）。
 * 所以判据要在解析**之前**跑。
 */
export function answerTruncated(text: string): boolean {
  const t = text.trim();
  if (t === '') return false;
  if (!t.startsWith('{') && !t.startsWith('[') && !t.startsWith('```')) {
    // 前面有人话：只检查最后一个代码围栏之后的部分。
    const fence = t.lastIndexOf('```');
    if (fence < 0) return looksTruncated(t);
    return looksTruncated(t.slice(fence + 3));
  }
  return looksTruncated(t.replace(/^```[a-z]*\n?/i, ''));
}

/** 「没抠出 JSON」时的统一措辞：截断与真·语法错误分开说。 */
export function noJsonReason(text: string, maxTokens?: number): string {
  if (looksTruncated(text)) {
    return `回话被输出预算截断了（JSON 没闭合${maxTokens === undefined ? '' : `，max_tokens=${String(maxTokens)}`}）。把这一段的 max_tokens 调大，或让它少说一点`;
  }
  return '回话里没有 JSON 对象（第一个字符就该是 {）';
}
