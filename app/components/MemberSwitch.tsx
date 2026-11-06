'use client';

import { useRouter } from 'next/navigation';
import { useState, type ChangeEvent } from 'react';

/**
 * 顶栏的成员切换。
 *
 * 名册与当前成员都由服务端给（`src/core/read/member.ts` 的 `listMembers()` /
 * `currentMember()`）：这是 client component，不能连库，也不该自己维护第二份名单。
 * 之前写死的五个名字已经从实现里删掉——加人只需要插一行 members表。
 */
interface MemberSwitchProps {
  /** 服务端从 flowers_actor cookie 读到的当前成员（缺省「吕品」）。 */
  current: string;
  /**
   * 全部成员姓名，顺序来自 `listMembers()` 的 `order by name`（见 src/core/read/member.ts：
   * 种子一次 insert 建完五个人，created_at 全相同，按它排等于按 uuid 排）。
   */
  members: string[];
}

export function MemberSwitch({ current, members }: MemberSwitchProps) {
  const router = useRouter();
  const [actor, setActor] = useState<string>(current);

  // 当前成员不在名册里（库里还没 seed、或 cookie 里是个已经离职的人）时，
  // 仍然把它显示出来：一个对不上下拉框的身份会让顶栏看起来像坏了。
  const options = members.includes(actor) ? members : [actor, ...members];

  function onChange(event: ChangeEvent<HTMLSelectElement>) {
    const next = event.target.value;
    document.cookie = 'flowers_actor=' + encodeURIComponent(next) + '; path=/';
    setActor(next);
    router.refresh();
  }

  return (
    <span className="member">
      <span className="dot" aria-hidden="true" />
      <span className="lbl">当前成员</span>
      <select value={actor} onChange={onChange} aria-label="切换当前成员">
        {options.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    </span>
  );
}

export default MemberSwitch;
