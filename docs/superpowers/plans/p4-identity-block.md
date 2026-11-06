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

（截图时把 Next 的 dev 指示浮标 `nextjs-portal` 隐掉了，否则它正好压住左下角身份块。）

## 验证

- `npx tsc --noEmit` 干净；
- `npx vitest run` 239 passed，随后 `npm run seed -- --reset` 已把演示数据灌回。
