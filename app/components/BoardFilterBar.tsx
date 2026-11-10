'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, type ChangeEvent, type FormEvent } from 'react';

import {
  boardQuery, parseBoardFilter, type BoardFilter, type BoardOwner, type BoardScope,
} from '../../src/core/read/board-filter';

/**
 * 看板顶部的筛选工具条：搜索框 + 负责人下拉 + 「筛出 N / M」 + 「清空」。
 *
 * ## 为什么是一个 `<form method="get">`，而不是一组受控 state
 *
 * 筛选的状态住在 URL 里（与 `?open=`、`?tab=` 同一条规矩），所以「提交」这件事的
 * 本质是**换一条 URL**，不是改本地状态。用表单而不是一堆 `onChange` 有三个好处：
 * 地址栏、刷新、分享、后退全都自动正确；提交前不发请求（`q` 只有按下回车或
 * 「筛选」才生效，不是每键一次）；没有 JS 时它仍然是一个能用的 GET 表单。
 *
 * JS 在场时 `onSubmit` 只做一件事：把两个字段重新解析一遍再 `router.push`——走的是
 * 同一条 RSC 导航，左轨不重挂，地址栏一样对。解析仍交给 `parseBoardFilter`，
 * 页面与工具条对「什么算一个筛选」只有一个来源。
 *
 * ## 下拉为什么改一下就生效
 *
 * 搜索框必须按回车（那是打字，不能每键一次请求），但**下拉没有「打到一半」这回事**：
 * 选择本身就是一个完成的动作，再要求点一次按钮是无意义的第二步。所以 `onChange`
 * 直接把当前（可能还没提交的）搜索词一起带上跳过去——用户刚输完标题就去筛负责人，
 * 两件事本来就该一起生效。
 *
 * ## 文案
 *
 * 一行灰字 `筛出 N / 815`：N 是筛后的条数（= 十列计数之和），815 是全库总数。
 * 分母由读模型给（`BoardView.total`），这里不自己数——工具条没有第二份数据。
 * 「清空」只在真的筛过之后出现：一个点了什么都不会变的按钮会让人以为筛选还开着。
 */
export function BoardFilterBar({
  q, owner, scope, members, shown, total, filtered,
}: {
  q: string;
  owner: BoardOwner;
  /** 时间范围（2026-11-10）：`active` 藏着上线超过 90 天的历史。 */
  scope: BoardScope;
  /** 负责人下拉的候选：名册（停用的也照收，历史需求还挂在那些人名下）。 */
  members: ReadonlyArray<{ id: string; name: string }>;
  shown: number;
  total: number;
  filtered: boolean;
}) {
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);

  /** 当前表单里的两个字段 → 一条筛选 → 一条 URL。搜过的词原样带过去。 */
  function go(source: HTMLFormElement) {
    const data = new FormData(source);
    const next: BoardFilter = parseBoardFilter({
      q: String(data.get('q') ?? ''),
      owner: String(data.get('owner') ?? ''),
      // 隐藏字段带过来的范围：「筛一下标题」不该顺手把「含历史」关掉。
      scope: String(data.get('scope') ?? ''),
    });
    const query = boardQuery(next);
    router.push(query === '' ? '/' : `/?${query}`);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    go(event.currentTarget);
  }

  function changeOwner(event: ChangeEvent<HTMLSelectElement>) {
    const source = event.currentTarget.form;
    if (source === null) return;
    go(source);
  }

  const selected = owner.kind === 'member' ? owner.id : owner.kind;

  /** 翻转时间范围的那条链接：当前的搜索词与负责人原样带过去。 */
  const flipScope: BoardScope = scope === 'all' ? 'active' : 'all';
  const flipQuery = boardQuery({ q, owner, scope: flipScope });
  const flipHref = flipQuery === '' ? '/' : `/?${flipQuery}`;

  return (
    <form className="fbar" method="get" action="/" role="search" ref={form} onSubmit={submit}>
      {/* `key={q}`：`defaultValue` 只在挂载时读一次，而清空 / 后退之后 URL 里的 q
          可能变了——不给 key 的话输入框会留着上一轮的词，看起来像筛选还在。 */}
      <input
        key={q}
        className="fq"
        type="search"
        name="q"
        defaultValue={q}
        placeholder="搜索需求标题"
        aria-label="搜索需求标题"
        maxLength={200}
      />
      <select name="owner" value={selected} onChange={changeOwner} aria-label="按负责人筛选">
        <option value="all">全部</option>
        <option value="me">只看我的</option>
        <option value="none">未指定</option>
        {members.map((member) => (
          <option key={member.id} value={member.id}>{member.name}</option>
        ))}
      </select>
      {/* 时间范围是**表单的一部分**：提交「筛选」时它跟着走，否则一次搜索就会把
          「含历史」悄悄关掉。切换用链接（与「清空」同一个形状），不新增一种控件语言。 */}
      <input type="hidden" name="scope" value={scope} />
      <button className="btn sm" type="submit">筛选</button>
      <Link
        className={scope === 'all' ? 'btn sm fclear' : 'btn ghost sm fclear'}
        href={flipHref}
        title={scope === 'all'
          ? '收起上线超过 90 天的需求'
          : '把上线超过 90 天的需求也显示出来'}
      >
        {scope === 'all' ? '只看近期' : '含历史'}
      </Link>
      {filtered && <Link className="btn ghost sm fclear" href="/">清空</Link>}
      <span className="hint">筛出 {shown} / {total}</span>
    </form>
  );
}

export default BoardFilterBar;
