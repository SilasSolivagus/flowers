'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';

// 只取类型：`import type` 在编译后消失，`notify.ts` 里的 `db/client` 不会进包。
// 运行时要的那两个数（列表、已读数）全部来自 server action。
import type { Notice, NotifyView } from '../../src/core/read/notify';
import { markAllReadAction, markReadAction, noticesAction } from '../actions';

/**
 * 顶栏的铃铛：站内通知（「找过我的」）。
 *
 * 三个来源，各说一件事：
 * - **首帧**由布局的服务端渲染给出（`initial`）：刷新之后立刻是完整的列表与正确的
 *   红点，不是「先闪一下 0、半秒后变 3」。
 * - **轮询**每 30 秒问一次（`noticesAction`），与 `ProgressCard` 同一个模式
 *   （`setInterval` + server action），没有 websocket：这件事的价值是「不用手动刷新」，
 *   不是「毫秒级」。
 * - **点击**自己更新：`markReadAction` 返回推完水位线之后重新读的那一页，直接
 *   `setState`。所以点开一条之后红点立刻变小，而且变小的数与服务端是同一个口径。
 *
 * 面板是**锚在下拉**（绝对定位在铃铛下），不是抽屉：它读的是「最近发生了什么」，
 * 一秒内要关掉。点一行 = 打开那条需求的抽屉（`?open=`），与看板卡片同一个入口。
 */
const POLL_MS = 30_000;

/**
 * 时间列。「MM-DD HH:mm」，按固定 +08:00 折算。
 *
 * 不用 `toLocaleString` / `Intl`：那会让服务端（Node 的 ICU）与浏览器各按自己的
 * 时区/区域规则给一个字符串，水合时对不上；而上海自 1991 年起没有夏令时，
 * 固定偏移就是事实。日期规则仍然只有 `clock/tick.ts` 那一份在用天数——
 * 这里要的是「几点」，不是「第几天」。
 */
function stamp(iso: string): string {
  const shifted = new Date(new Date(iso).getTime() + 8 * 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} `
    + `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
}

export function NotifyBell({ initial }: { initial: NotifyView }) {
  const pathname = usePathname();
  const router = useRouter();
  const [view, setView] = useState<NotifyView>(initial);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement | null>(null);

  // 30 秒一次的轮询。`mounted` 不是为了省一次 setState：切页时组件不卸载（它在布局里），
  // 但整页换成一个已经卸载的 RSC 时，挂到一个已卸载的组件上会让 React 警告。
  useEffect(() => {
    let alive = true;
    const timer = setInterval(() => {
      void noticesAction().then((next) => {
        if (alive) setView(next);
      });
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  // 点外面 / Esc 关闭。只在打开时挂监听：一个常驻的 document 监听是白交的钱。
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent) => {
      if (anchor.current !== null && !anchor.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // 铃铛只属于看板那一页（需求页顶栏）。其它页的顶栏只有自己的录入入口。
  if (pathname !== '/') return null;

  /**
   * 点一行：先关面板、开抽屉，同时把水位线推到这个事件的 seq。
   *
   * 顺序不是「等已读成功再跳」：跳转是用户的意图，已读是副作用；让副作用拖住导航
   * 会在网络慢的时候让一次点击像没反应。两条请求都发出去，各自的返回值各自收口
   * （`setView` 用的是推完之后重新读到的那一页）。
   */
  const openRow = (notice: Notice) => {
    setOpen(false);
    void markReadAction(notice.eventSeq).then(setView);
    // 成员级提醒没有需求可开（P2 的企微绑定自愈）：它的下一步动作在设置页——去那里
    // 点一次「查一下」。拼成 `?open=null` 会打开一个空的抽屉，看起来像点坏了。
    router.push(
      notice.requirementId === null ? '/settings' : `/?open=${notice.requirementId}`,
    );
  };

  const markAll = () => {
    void markAllReadAction().then(setView);
  };

  const count = view.unread;

  return (
    <div className="notify" ref={anchor}>
      <button
        type="button"
        className="bell"
        aria-label="站内通知"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path
            d="M8 1.5a4 4 0 0 0-4 4v2.2L2.8 10a.7.7 0 0 0 .6 1h9.2a.7.7 0 0 0 .6-1L12 7.7V5.5a4 4 0 0 0-4-4Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          <path d="M6.4 12.6a1.7 1.7 0 0 0 3.2 0" fill="none" stroke="currentColor" strokeWidth="1.2" />
        </svg>
        {/* 0 的时候不渲染那个圆点：一个「0」的角标只会让人以为有东西没读。 */}
        {count > 0 && <span className="cnt">{count > 99 ? '99+' : count}</span>}
      </button>

      {open && (
        <div className="npanel" role="dialog" aria-label="站内通知">
          <div className="nhd">
            <span>站内通知</span>
            {count > 0 && (
              <button type="button" className="nall" onClick={markAll}>全部已读</button>
            )}
          </div>
          {view.notices.length === 0 ? (
            // 空状态只有一行字：没有图、没有「当有人 @ 你…」的解释。
            <div className="nempty">暂无通知</div>
          ) : (
            <div className="nlist">
              {view.notices.map((notice) => (
                <button
                  key={notice.eventSeq}
                  type="button"
                  className={notice.unread ? 'nrow un' : 'nrow'}
                  onClick={() => openRow(notice)}
                >
                  <span className="nt">{stamp(notice.at)}</span>
                  <span className="nl">{notice.line}</span>
                  <span className="nd" aria-hidden="true" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default NotifyBell;
