'use client';

import { useRouter } from 'next/navigation';
import { useState, type ChangeEvent } from 'react';

/** 成员名单。Task 2 起改成 src/core/read/member.ts 的 listMembers() 真数据。 */
export const MEMBERS = ['吕正豪', '赵越', '吕品', '房超', '王妍'] as const;
export const DEFAULT_ACTOR = '吕正豪';

interface MemberSwitchProps {
  /** 服务端从 flowers_actor cookie 读到的当前成员；缺省是 DEFAULT_ACTOR。 */
  current?: string;
}

export function MemberSwitch({ current }: MemberSwitchProps) {
  const router = useRouter();
  const [actor, setActor] = useState<string>(current ?? DEFAULT_ACTOR);

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
        {MEMBERS.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    </span>
  );
}

export default MemberSwitch;
