/**
 * 版本日报·图（2026-11-16）
 *
 * 把 `group-dispatch --daily` 的卡片渲染成 PNG，用群机器人 `image` 消息发出去。
 * 版式对齐旧 Onus 那张：右上角「实际 vs 理论」小熊图、五个状态格、重点需求进度条。
 *
 * ```bash
 * npx tsx scripts/version-daily-image.ts --dry-run   # 只渲染，打印 PNG 路径
 * npx tsx scripts/version-daily-image.ts --send      # 真的发
 * FLOWERS_GROUP_TAG=bdf1 ... --send                   # 第二个群
 * ```
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';

import { db, pool } from '../src/db/client.js';
import { listReleases } from '../src/core/read/version.js';
import type { Release, ReleaseItem } from '../src/core/read/version.js';
import { activeReleases, todayInShanghai, versionCards } from '../src/core/read/version-daily.js';
import { enqueueDailyImage, publicBaseUrl, readGroupWebhook } from '../src/core/notify/group.js';
import { resolveOutboxBin } from '../src/core/notify/wecom.js';

const CHROME = process.env.CHROME_BIN ?? '/usr/bin/google-chrome';
const KIND = 'daily';

type Box = { label: string; count: number; bg: string; fg: string };
type Point = { x: number; y: number };

function boxes(release: Release): Box[] {
  const by = (state: string) => release.requirements.filter((r) => r.state === state).length;
  return [
    { label: '待开发', count: by('ready'), bg: '#f1f2f4', fg: '#5f6b7a' },
    { label: '开发中', count: by('dev'), bg: '#e8f0ff', fg: '#2b6ff0' },
    { label: '测试中', count: by('test'), bg: '#f3ecff', fg: '#7a45e6' },
    { label: '已完成', count: by('live'), bg: '#e7f7ec', fg: '#1a9c52' },
    { label: '延期', count: release.late, bg: '#fdecec', fg: '#d93b3b' },
  ];
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

/** 「开发中 · 已停留 5 天」。 */
function stateText(item: ReleaseItem | undefined): string | null {
  if (item === undefined) return null;
  return item.days <= 0 ? item.stateLabel : `${item.stateLabel} · ${item.days} 天`;
}

/**
 * 右上角小熊图：横轴＝版本时间窗，纵轴＝剩余工作量（100% → 0%）。
 * 理论＝从 100% 直线降到 0 的虚线；实际＝台账里每天那条日报的进度反推出来的折线。
 */
function sparkline(history: readonly Point[], width = 186, height = 92): string {
  const pad = 8;
  const w = width - pad * 2;
  const h = height - pad * 2;
  const toXY = (p: Point) => [pad + p.x * w, pad + p.y * h] as const;
  const [tx0, ty0] = toXY({ x: 0, y: 0 });
  const [tx1, ty1] = toXY({ x: 1, y: 1 });

  const pts = history.map((p) => toXY(p));
  const dots = pts.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.6" fill="#f0862a"/>`).join('');
  const line = pts.length > 1
    ? `<polyline points="${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}"
         fill="none" stroke="#f0862a" stroke-width="1.8" stroke-linejoin="round"/>`
    : '';

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${width}" height="${height}" rx="8" fill="#f7f8fa"/>
    <line x1="${tx0}" y1="${ty0}" x2="${tx1}" y2="${ty1}" stroke="#c9ced8" stroke-width="1.4" stroke-dasharray="4 3"/>
    ${line}${dots}
  </svg>`;
}

function html(card: {
  kicker: string; title: string; sub: string;
  pct: number; theory: number;
  boxes: Box[]; focus: string | null; focusState: string | null; focusPct: number;
  chart: string; baseUrl: string;
}): string {
  const lag = card.theory - card.pct;
  const verdict = lag > 0 ? `落后 ${lag}pt` : '进度正常';
  const verdictColor = lag > 0 ? '#d93b3b' : '#1a9c52';
  const verdictBg = lag > 0 ? '#fdecec' : '#e7f7ec';
  const boxHtml = card.boxes.map((b) => `
      <div class="box" style="background:${b.bg}">
        <div class="box-n" style="color:${b.fg}">${b.count}</div>
        <div class="box-l">${b.label}</div>
      </div>`).join('');
  const focusHtml = card.focus === null ? '' : `
    <div class="focus">
      <div class="focus-h">重点需求 <span class="focus-n">1 项</span></div>
      <div class="focus-row">
        <div class="focus-l">
          <div class="focus-t">${escapeHtml(card.focus)}</div>
          <div class="chips">${card.focusState === null ? '' : `<span class="chip">${escapeHtml(card.focusState)}</span>`}</div>
        </div>
        <div class="focus-r">
          <div class="bar"><div class="bar-in" style="width:${Math.max(3, card.focusPct)}%"></div></div>
          <div class="bar-n">${card.focusPct}%</div>
        </div>
      </div>
    </div>`;

  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:620px; background:#eef0f4; padding:22px;
         font-family:"Noto Sans CJK SC","Noto Sans SC","Noto Serif CJK SC",system-ui,sans-serif; }
  .card { background:#fff; border-radius:14px; padding:22px 24px 16px; border:1px solid #e3e6ec; }
  .brand { font-size:12.5px; color:#1a9c52; font-weight:600; }
  .rule { height:1px; background:#eef0f4; margin:9px 0 14px; }
  .head { display:flex; gap:16px; align-items:flex-start; }
  .head-l { flex:1; min-width:0; }
  .head-r { width:186px; flex:none; }
  h1 { font-size:22px; color:#1b1f26; font-weight:700; line-height:1.3; }
  .sub { margin-top:6px; font-size:13px; color:#8a93a3; }
  .legend { margin-top:6px; text-align:right; font-size:11.5px; color:#9aa2b1; }
  .legend i { display:inline-block; width:7px; height:7px; border-radius:50%; background:#f0862a; margin-right:4px; }
  .legend s { color:#c9ced8; text-decoration:none; }
  .big { margin-top:14px; display:flex; align-items:flex-end; gap:10px; }
  .pct { font-size:50px; line-height:1; font-weight:800; color:#1a9c52; }
  .theory { font-size:12.5px; color:#8a93a3; padding-bottom:7px; }
  .verdict { margin-left:auto; font-size:12px; font-weight:600; color:${verdictColor};
             background:${verdictBg}; padding:5px 10px; border-radius:6px; }
  .boxes { margin-top:18px; display:flex; gap:10px; }
  .box { flex:1; border-radius:10px; padding:11px 6px; text-align:center; }
  .box-n { font-size:25px; font-weight:700; line-height:1.1; }
  .box-l { margin-top:3px; font-size:12px; color:#8a93a3; }
  .focus { margin-top:16px; border-top:1px solid #eef0f4; padding-top:14px; }
  .focus-h { font-size:14px; font-weight:700; color:#1b1f26; }
  .focus-n { font-weight:400; color:#8a93a3; font-size:13px; margin-left:5px; }
  .focus-row { margin-top:10px; display:flex; gap:18px; align-items:center; }
  .focus-l { flex:1; min-width:0; }
  .focus-t { font-size:14.5px; color:#1b1f26; }
  .chips { margin-top:7px; }
  .chip { display:inline-block; font-size:11.5px; color:#5f6b7a; background:#f1f2f4;
          padding:2px 8px; border-radius:4px; margin-right:6px; }
  .focus-r { width:210px; flex:none; }
  .bar { height:6px; background:#eef0f4; border-radius:3px; overflow:hidden; }
  .bar-in { height:6px; background:#2b6ff0; border-radius:3px; }
  .bar-n { margin-top:5px; text-align:right; font-size:12px; color:#2b6ff0; font-weight:600; }
  .foot { margin-top:16px; padding-top:13px; border-top:1px solid #eef0f4;
          font-size:12px; color:#a8b0bd; }
</style></head><body><div class="card">
  <div class="brand">${escapeHtml(card.kicker)}</div>
  <div class="rule"></div>
  <div class="head">
    <div class="head-l">
      <h1>${escapeHtml(card.title)}</h1>
      <div class="sub">${escapeHtml(card.sub)}</div>
    </div>
    <div class="head-r">
      ${card.chart}
      <div class="legend"><i></i>实际&nbsp;&nbsp;<s>– –</s> 理论</div>
    </div>
  </div>
  <div class="big">
    <div class="pct">${card.pct}%</div>
    <div class="theory">整体进度&nbsp;&nbsp;理论 ${card.theory}%</div>
    <div class="verdict">${verdict}</div>
  </div>
  <div class="boxes">${boxHtml}
  </div>${focusHtml}
  <div class="foot">完整需求与甘特：${escapeHtml(card.baseUrl)}/releases</div>
</div></body></html>`;
}

/** 「开发中 · 已停留 5 天」——只有 1 条需求的版本，这条比百分比有信息量。 */
function focusStateLabel(release: Release): string | null {
  const item = release.requirements[0];
  if (item === undefined) return null;
  const days = item.days;
  const tail = days <= 0 ? '今天进入' : `已停留 ${days} 天`;
  return `${item.stateLabel} · ${tail}`;
}

function renderPng(pageHtml: string): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'vd-'));
  const htmlPath = join(dir, 'card.html');
  const pngPath = join(dir, 'card.png');
  writeFileSync(htmlPath, pageHtml, 'utf8');
  execFileSync(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--force-device-scale-factor=2', '--window-size=620,2200',
    `--screenshot=${pngPath}`, `file://${htmlPath}`,
  ], { stdio: 'ignore', timeout: 60_000 });
  // 底部多余画布按「最后一行非背景色」裁掉
  const crop = `
import sys
from PIL import Image
p = sys.argv[1]
im = Image.open(p).convert('RGB')
w, h = im.size
bg = im.getpixel((2, 2))
last = h - 1
for y in range(h - 1, -1, -1):
    if any(im.getpixel((x, y)) != bg for x in range(0, w, 32)):
        last = y
        break
im.crop((0, 0, w, min(h, last + 46))).save(p)
`;
  execFileSync('python3', ['-c', crop, pngPath], { stdio: 'ignore', timeout: 30_000 });
  return readFileSync(pngPath);
}

/** 台账里这个版本每天的进度 → 小熊图的点（x=0 开始日，x=1 发版日，y=0 满，y=1 空）。 */
async function progressHistory(release: Release): Promise<Point[]> {
  const start = Date.parse(`${release.windowStart.slice(0, 10)}T00:00:00+08:00`);
  const end = Date.parse(`${release.releaseDate.slice(0, 10)}T00:00:00+08:00`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];

  const rows = (await db.execute<{ ref: string; content: string }>(sql`
    select ref, content from group_posts
     where kind = ${KIND} and ref like ${'daily:' + release.id + ':%'} and status = 'sent'
     order by ref`)).rows;

  const points: Point[] = [];
  for (const row of rows) {
    const day = (row.ref.split(':')[2] ?? '').slice(0, 10);
    const at = Date.parse(`${day}T00:00:00+08:00`);
    if (!Number.isFinite(at)) continue;
    const matched = /"title"\s*:\s*"(\d+)%"/.exec(row.content);
    if (matched === null) continue;
    points.push({
      x: Math.min(1, Math.max(0, (at - start) / (end - start))),
      y: Math.min(1, Math.max(0, Number(matched[1]) / 100)),
    });
  }
  // 今天（还没进台账时）用当前进度补一个点
  return points;
}

async function main(): Promise<void> {
  const send = process.argv.includes('--send');
  const tag = (process.env.FLOWERS_GROUP_TAG ?? '').trim();
  const today = todayInShanghai();
  const baseUrl = await publicBaseUrl(db);
  const releases = activeReleases(await listReleases(), today);
  const cards = versionCards(await listReleases(), today, baseUrl);
  const byId = new Map(releases.map((r) => [r.id, r]));
  if (cards.length === 0) { process.stdout.write('今天没有要播的版本。\n'); return; }

  const outboxEnabled = resolveOutboxBin() !== null;
  const webhook = send ? await readGroupWebhook(db) : null;
  if (send && webhook === null && !outboxEnabled) { process.stderr.write('没有配置群 webhook。\n'); process.exitCode = 2; return; }

  const dateKey = new Date(today * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  for (const { releaseId, releaseName, card } of cards) {
    const release = byId.get(releaseId);
    if (release === undefined) continue;
    const pct = Number(String(card.emphasis?.title ?? '').replace(/[^\d]/g, ''));
    const theory = Number(String(card.emphasis?.desc ?? '').replace(/[^\d]/g, ''));

    const mmdd = release.releaseDate.slice(5, 7) + '/' + release.releaseDate.slice(8, 10);
    const workdays = (String(card.desc).match(/还剩 (\d+) 个工作日/) ?? [])[1] ?? '?';
    const iteration = '迭代' + release.releaseDate.slice(5, 7) + release.releaseDate.slice(8, 10);

    const history = await progressHistory(release);
    // 末尾补今天这个点（当天还没落账时）
    const last = history.at(-1);
    const todayPoint: Point = { x: Math.min(1, Math.max(0, (Date.now() - Date.parse(release.windowStart.slice(0,10) + 'T00:00:00+08:00')) / (Date.parse(release.releaseDate.slice(0,10) + 'T00:00:00+08:00') - Date.parse(release.windowStart.slice(0,10) + 'T00:00:00+08:00')))), y: pct / 100 };
    if (last === undefined || Math.abs(last.y - todayPoint.y) > 1e-6) history.push(todayPoint);

    const page = html({
      kicker: String(card.source?.desc ?? 'Flower · 研发日报'),
      title: `${mmdd} 发版，还剩 ${workdays} 个工作日`,
      sub: `123云盘 研发日报 · ${iteration}`,
      pct, theory,
      boxes: boxes(release),
      focus: release.requirements[0]?.title ?? null,
      focusState: stateText(release.requirements[0]),
      focusPct: pct,
      chart: sparkline(history),
      baseUrl,
    });
    const png = renderPng(page);
    const out = `/tmp/version-daily-${dateKey}${tag === '' ? '' : '-' + tag}.png`;
    writeFileSync(out, png);
    process.stdout.write(`渲染完成：${out}（${Math.round(png.length / 1024)} KB，走势点 ${history.length} 个）\n`);

    if (!send) continue;

    const ref = `daily:${releaseId}:${dateKey}${tag === '' ? '' : ':' + tag}:img`;
    const already = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from group_posts
       where kind = ${KIND} and ref = ${ref} and status = 'sent'`)).rows[0]?.n ?? 0;
    if (already > 0) { process.stdout.write(`${releaseName}：今天已经发过图，跳过（${ref}）\n`); continue; }

    await db.execute(sql`
      insert into group_posts (kind, ref, content, status)
      values (${KIND}, ${ref}, ${'image:' + out}, 'pending')
      on conflict (kind, ref) do nothing`);
    const sent = await enqueueDailyImage({
      pngPath: out,
      png,
      webhook,
      tag,
      releaseId,
      dateKey,
    });
    await db.execute(sent.ok
      ? sql`update group_posts set status='sent', error=null, posted_at=now(), attempts=attempts+1 where kind=${KIND} and ref=${ref}`
      : sql`update group_posts set status='failed', error=${sent.message}, attempts=attempts+1 where kind=${KIND} and ref=${ref}`);
    process.stdout.write(`${sent.ok ? '已发' : '失败'}：${releaseName} 日报图（${ref}）${sent.message}\n`);
    if (!sent.ok) process.exitCode = 1;
  }
}

await main();
await pool.end();
