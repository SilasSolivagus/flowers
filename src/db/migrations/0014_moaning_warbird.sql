-- P4-09：优先级列 + 平台词表迁移（旧键 → 生产词表）
--
-- 这一份迁移做两件事，第三件（Flower 旧状态 → 我们十个状态）不在库里做，见
-- `scripts/migrate-flower.ts`：那是一次跨系统搬数据，不是本库的结构变更。

-- ── 1. 优先级 ────────────────────────────────────────────────────────────────
-- 可空、不给默认值：生产库 803 条里有 3 条没有优先级，178 条连描述都没写。
-- 回填一个假值（'' 或 'p2'）等于替那 3 条编一个优先级。null = 未定，这是合法状态。
ALTER TABLE "requirements" ADD COLUMN "priority" text;

-- ── 2. 平台词表：旧键 → 新键，映射后去重、按词表顺序排 ──────────────────────
--
-- 旧词表（P4-08，编的）：pc / web / h5 / ios / android / api / admin / mini
-- 新词表（P4-09，生产数据）：web / mobile / pc / mini / backend / admin / manager /
--                           frontend / h5 / open / harmony / tv
--
-- 逐条：pc→pc、web→web、h5→h5、admin→admin、mini→mini、api→backend、
--       ios→mobile、android→mobile。
--
-- 去重是映射的**自然结果**：一条原本 `['ios','android']` 的需求映射后是
-- `['mobile','mobile']`，DISTINCT ON 把它收成一个 `mobile`。这正是真实数据的形状
-- ——线上 223 条只写「移动端」，没有 iOS / Android 之分。
CREATE TEMP TABLE p409_platform_map (old_key text PRIMARY KEY, new_key text NOT NULL, ord int NOT NULL) ON COMMIT DROP;

INSERT INTO p409_platform_map (old_key, new_key, ord) VALUES
  ('web',     'web',      1),
  ('mobile',  'mobile',   2),
  ('pc',      'pc',       3),
  ('mini',    'mini',     4),
  ('backend', 'backend',  5),
  ('admin',   'admin',    6),
  ('manager', 'manager',  7),
  ('frontend','frontend', 8),
  ('h5',      'h5',       9),
  ('open',    'open',    10),
  ('harmony', 'harmony', 11),
  ('tv',      'tv',      12),
  -- 旧键
  ('api',     'backend',  5),
  ('ios',     'mobile',   2),
  ('android', 'mobile',   2);

WITH calculated AS (
  SELECT r.id,
         COALESCE((
           SELECT array_agg(picked.new_key ORDER BY picked.ord)
             FROM (
               SELECT DISTINCT ON (m.new_key) m.new_key, m.ord
                 FROM unnest(r.platforms) AS u(raw)
                 JOIN p409_platform_map m ON m.old_key = lower(btrim(u.raw))
                ORDER BY m.new_key, m.ord
             ) AS picked
         ), '{}'::text[]) AS mapped
    FROM requirements r
)
UPDATE requirements r
   SET platforms = c.mapped
  FROM calculated c
 WHERE c.id = r.id
   AND r.platforms IS DISTINCT FROM c.mapped;

-- 认不出的键：**丢掉、不失败**，但要说出来是哪些（stdout 的 NOTICE）。
-- 静默丢一个平台等于让一条需求少一个端，而看板上看不出来少了什么。
DO $$
DECLARE
  row_rec record;
  dropped text[];
BEGIN
  FOR row_rec IN SELECT id, platforms FROM requirements LOOP
    SELECT array_agg(u.raw)
      INTO dropped
      FROM unnest(row_rec.platforms) AS u(raw)
     WHERE lower(btrim(u.raw)) NOT IN (SELECT old_key FROM p409_platform_map);

    IF dropped IS NOT NULL THEN
      RAISE NOTICE 'P4-09 平台迁移：需求 % 上无法识别的平台键已丢弃：%', row_rec.id, dropped;
    END IF;
  END LOOP;
END $$;
