# P4 设计修正：身份块搬到左轨底部

一句话：顶栏的成员下拉框删掉了。身份是**只读**的一块（姓名 / 角色），坐在左轨底部；
顶栏只剩当前页的标题。

## 移动了什么

| 之前 | 现在 |
| --- | --- |
| `app/components/MemberSwitch.tsx`（`<select>` + 写 `flowers_actor` cookie） | 删除 |
| `layout.tsx` 顶栏：`.sp` + `<MemberSwitch>` | `<PageTitle />` 一个 `<h1>` |
| `RailNav.tsx` 里三条入口（需求 / 版本 / **设置**） | 只剩两条（需求 / 版本） |
| — | 新增 `RailFooter.tsx`：设置链接 + `.me` 身份块 |
| — | 新增 `sections.ts`：路径 → 中文的唯一一张表 |
| — | 新增 `PageTitle.tsx`：顶栏标题（client，`usePathname()`） |

左轨从上到下的 DOM 顺序：`h1`（Flower）→ `.sub` → `.railtoggle` → 需求 / 版本 →
`.sp`（`flex:1`，把下面这一组压到底）→ 设置 → `.me`（姓名 + 角色）。
`globals.css` 里 `.member` 那一整组样式删掉，`.rail > a` 的选择器放宽成 `.rail a`
（设置现在与导航链接同一个形状，只是位置在 `.sp` 下面），`.me` 按线稿
`~/Flower/docs/ux/gate-console/views.css` 的 `.me` 移植：
`margin:0 8px; padding:12px 8px 0; border-top:1px solid var(--c-line)`，
姓名 `600 var(--t-body)`、角色 `400 var(--t-caption)` + `--c-text-3`。
那条 hairline 落在**设置与身份之间**（线稿 `.me` 的 `border-top` 位置）。

设置页的文案同步改了：`app/settings/page.tsx` 里「顶栏的那个下拉框」那句换成
「左轨底部的身份块」；`app/page.tsx`、`README.md` 里描述下拉框的句子一并更正。

## 收起（56px）时怎么退化

判据仍是**宽度**（`@container (max-width:100px)`，与 RailNav / RailToggle 同一套），
不是 cookie 的值：

- 设置 → 「设」，`aria-label` / `title` 仍是「设置」；
- 姓名 → 首字（「吕」），完整姓名用 1px 裁剪式视觉隐藏而不是 `display:none`
  ——`display:none` 会把可访问名字一起删掉，读屏与悬停的 `title` 要的都是「吕品」；
- 角色行整行 `display:none`：40px 可用宽（`margin:8×2`）放不下「商业线」这种三字角色，
  半截角色名比没有更糟。

实测（1280 视口）：展开时 `.me` 占 53px 高（底边距 12px），收起时 `.rail` 的
`scrollWidth === clientWidth === 55`，`.me` 宽 39px 且居中（字符框 21–34，左轨中心 28），
无重叠、无溢出。390 视口下 `document.documentElement.scrollWidth === 390`。

## 顶栏标题：为什么是 client component

选了**一个小的 client component**（`PageTitle.tsx`，`usePathname()` + `sections.ts`
的 `pageTitle()`），而不是三个页面各写一个值：

1. 路径 → 中文只有一张表（`app/components/sections.ts`），左轨链接与顶栏标题共用；
   三处各写一遍，第四次改文案就会出现「顶栏写版本、左轨写发版」。
2. 客户端导航时标题与内容同帧到位，不会出现「标题还是上一页」的那一帧。
3. 代价只有一行 JS：没有 state、没有 effect，服务端首帧就带着正确的字
   （实测 `curl /`、`/releases`、`/settings` 的 SSR HTML 里分别是 需求 / 版本 / 设置）。

认不出的路径退回「需求」：顶栏必须有一行字，空着正是这次要修的毛病。

## 身份从哪来

身份现在**由配置决定，SSO 上线前不会变**：`src/core/read/member.ts` 原样不动
（`currentMember()` 读 `flowers_actor` cookie，没有就落 `DEFAULT_MEMBER`「吕品」），
服务端动作照旧从它取 actor；但**界面里没有任何一处写这个 cookie**，也没有藏在
URL 参数或 dev-only 控件里的后门。

**后果：之前的负向用例（换身份点通过 → 失败）已经无法再从界面上走一遍。**
那条用例只能在种子/curl 里改 `flowers_actor` 才复现；评审时不能再指望「用下拉框换个
不是评审人的人」来演示门禁。

## 截图（`docs/superpowers/shots/`）

- `09-ce-rail-expanded.png` — 1280 展开：设置 / hairline / 吕品 / PM，顶栏「需求」
- `10-ce-rail-collapsed.png` — 1280 收起：设 / 吕，无重叠无溢出
- `11-ce-settings-collapsed.png` — /settings 收起：设 高亮，顶栏「设置」，「我的」显示 吕品 / PM
- `12-ce-390.png` — 390 收起（默认档）：同上，看板不被挤坏
- `13-ce-390-expanded.png` — 390 手动展开（184px）：同样不溢出

（当时那几张是把 Next 的 dev 指示浮标 `nextjs-portal` 手动隐掉的——它正好压住左下角身份块；
现在 `next.config.ts` 里 `devIndicators: false` 直接关掉了，见文末补记。）

## 验证

- `npx tsc --noEmit` 干净；
- `npx vitest run` 239 passed，随后 `npm run seed -- --reset` 已把演示数据灌回。

## 补记：dev 指示浮标关掉，并复检左轨底部

### 配置键

`next.config.ts` 顶层加 `devIndicators: false`。

选它而不是「把浮标挪个角」：装的 16.4.5 里这个键的类型是
`devIndicators?: false | { position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' }`
（`node_modules/next/dist/server/config-shared.d.ts:1532`，默认值 `{ position: 'bottom-left' }`
在同文件 1831 行的完整配置里）。布尔就是「整个关掉」，对象只是换位置——而四个角里
左下角正好压着身份块，右上角压顶栏标题、右下角压在途卡片，挪到哪儿都还是有一块浮标挡内容。
所以用布尔。

A/B 验过：把这一行临时改成 `{ position: 'bottom-left' }`，dev 服务热重启后黑色「N」圆标
立刻回来、正压住「吕品 / PM」（截图当时存在 `/tmp/ab-with-badge.png`，不进仓库）；
改回 `false` 后同一个视口同一份截图里圆标消失。所以是这个键在起作用，不是缓存或巧合。
（`nextjs-portal` 这个宿主元素仍在 DOM 里，但它是 0×0——圆标在它的 shadow root 里，
量宿主量不出来，只有截图算数。）

### 三个状态的左轨底部

截图在 `docs/superpowers/shots/`（每张另附 `-rail.png` 是左轨底部 140px 的 2× 放大裁切）：

- `14-dev-1280-expanded.png`（1280 展开，184px）——设置 → hairline → 吕品 / PM，
  圆标没了，整块读得清；底边到视口还有 12px（`.rail` 的 `padding-bottom`），
  上不贴导航、下不贴边，是「一组」而不是「贴边的一堆字」。
- `15-dev-1280-collapsed.png`（1280 收起，56px）——设 / hairline / 吕 竖着叠在一起、都居中，
  一条 hairline 把它们括成一组；间距是 10px（`.me` 收起态的 `padding-top`），
  读起来是一块，不是两个互不相干的东西。
- `16-dev-390-collapsed.png`（390 收起，默认档）——与 1280 收起逐像素同形（裁切图 sha 相同），
  居中、无溢出，`documentElement.scrollWidth === 390`。

量出来的几何（三种状态一致）：`.me` 高 53px / 收起 31px，底边距恒为 12px，
`.rail` 的 `scrollWidth === clientWidth`（183 / 55），页面上没有任何 `position: fixed`
元素落在左下 160px 内。

**结论：间距没动。** 圆标是唯一压在身份块上的东西，它一走，12px 的底边距与 10px 的
hairline 间距就是对的——没有为了「看起来改过」而调 CSS。
