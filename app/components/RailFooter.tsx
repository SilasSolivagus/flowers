'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { SETTINGS_SECTION, isCurrent } from './sections';

/**
 * 左轨底部的一组：设置 + 身份块（姓名在上、角色在下）。
 *
 * **这里没有切换。** 身份是配置（`flowers_actor` cookie，缺省「吕品」，见
 * `src/core/read/member.ts`），界面只显示它、不写它。曾经在顶栏放一个 `<select>`
 * 让任何人一键变成任何人，那让「签字人必须是派单到的评审人」变成装饰：谁都点得到
 * 那个下拉框。这一版把身份读到屏上就停手——SSO 之前它就是固定的。
 *
 * 布局对齐线稿 `~/Flower/docs/ux/gate-console/views.css` 的 `.me`：
 * `margin:0 8px; padding:12px 8px 0; border-top:1px solid var(--c-line)`，
 * 姓名 `600 var(--t-body)`、角色 `400 var(--t-caption)` 且更浅一档（`--c-text-3`）。
 * 那条 hairline 就是「设置」与身份之间的分隔。
 *
 * 收起（56px）时与 RailNav/RailToggle 同一套退化规则，判据仍是**宽度**（CSS 容器查询）：
 * - 设置 → 「设」，`aria-label`/`title` 仍是「设置」；
 * - 姓名 → 首字，完整姓名退成视觉隐藏（`.lbl` 用 clip 而不是 `display:none`），
 *   所以读屏读到的还是「吕品」，鼠标悬停的 `title` 也是它；
 * - 角色行整行藏起来：40px 可用宽放不下「商业线」这种三个字，而半截角色名比没有更糟。
 *
 * 一整块不折行、不换行：姓名与角色各占一行，卡片/看板的高度不受它影响（它在 `.rail`
 * 这个独立的栅格列里，`flex` 列把 `.sp` 之外的剩余高度吃满，不会挤到主区）。
 */
export function RailFooter({ name, role }: { name: string; role: string }) {
  const pathname = usePathname();

  return (
    <>
      <Link
        href={SETTINGS_SECTION.href}
        className="railset"
        aria-current={isCurrent(pathname, SETTINGS_SECTION.href) ? 'true' : undefined}
        aria-label={SETTINGS_SECTION.label}
        title={SETTINGS_SECTION.label}
      >
        <span className="lbl">{SETTINGS_SECTION.label}</span>
        <span className="abbr" aria-hidden="true">{SETTINGS_SECTION.label.slice(0, 1)}</span>
      </Link>
      {/* 身份：一个只读块，没有任何控件。`title` 只是把收起时看不见的全名补回来，
          不是一句解释——屏上仍然只有名字与角色两行。 */}
      <div className="me">
        <b title={name}>
          <span className="lbl">{name}</span>
          <span className="abbr" aria-hidden="true">{name.slice(0, 1)}</span>
        </b>
        {role === '' ? null : <div className="r">{role}</div>}
      </div>
    </>
  );
}

export default RailFooter;
