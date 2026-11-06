'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { generateAction, generationStatusAction } from '../actions';

/**
 * 参考段那一行右边的「生成」：按下 → 服务端开一次作业 → 这一行变「生成中」→
 * 变成产物链接，或者一行中文失败原因。
 *
 * 三条刻意的取舍：
 * 1. **没有进度条、没有 spinner**。这个功能真正告诉用户的事情只有两件：
 *    「在跑」和「结果 / 原因」。中间态给一个词就够——假装知道 37% 才是最不诚实的
 *    那种界面。
 * 2. **错误就在行里**，由服务端作业的 `error` 原文加前缀「生成失败：」组成。
 *    `OAuth session expired` 是合法且有用的句子：它告诉 owner 该去登录，
 *    而「生成失败」四个字什么也没说。
 * 3. **刷新之后状态还在**。初始的 `runningJobId` 由服务端读模型给出（正在跑的作业），
 *    所以刷新页面、换一个人打开同一条需求，看到的都是「生成中」而不是一个可以
 *    再按一次的按钮。失败不持久化：它是行内一次性的提示，刷新后回到「生成」——
 *    那正是重试的入口。
 */

/** 轮询间隔：够快看到结果，又不至于把 server action 当日志刷。 */
const POLL_MS = 1500;

/** 客户端等不到结果的上限。服务端的硬超时是 10 分钟，这里多留一分钟。 */
const GIVE_UP_MS = 11 * 60 * 1000;

export function GenerateButton({
  requirementId, stage, runningJobId,
}: { requirementId: string; stage: string; runningJobId: string | null }) {
  const router = useRouter();
  const [jobId, setJobId] = useState<string | null>(runningJobId);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /** 这一次轮询的截止时刻：作业可以被杀掉，客户端不能陪着一起永远转。 */
  const deadline = useRef<number>(0);

  useEffect(() => {
    if (jobId === null) return undefined;
    if (deadline.current === 0) deadline.current = Date.now() + GIVE_UP_MS;

    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async (): Promise<void> => {
      if (!alive) return;
      if (Date.now() > deadline.current) {
        deadline.current = 0;
        setJobId(null);
        setError('生成没有回报（后台进程可能已退出）');
        return;
      }

      const status = await generationStatusAction(jobId);
      if (!alive) return;

      if (status === null) {
        // 作业不见了（库被重置 / id 被改坏）：停手，把控制权还给按钮。
        deadline.current = 0;
        setJobId(null);
        return;
      }
      if (status.status === 'done') {
        deadline.current = 0;
        setJobId(null);
        // 让服务端重新渲染这一行：产物链接、日期、时间轴上的新事件都从库里来。
        router.refresh();
        return;
      }
      if (status.status === 'failed') {
        deadline.current = 0;
        setJobId(null);
        setError(status.error ?? '未知原因');
        return;
      }
      timer = setTimeout(() => void tick(), POLL_MS);
    };

    timer = setTimeout(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [jobId, router]);

  const start = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      const form = new FormData();
      form.set('requirementId', requirementId);
      form.set('stage', stage);
      const result = await generateAction(form);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      deadline.current = Date.now() + GIVE_UP_MS;
      setJobId(result.jobId);
    } catch {
      setError('生成请求没有送达');
    } finally {
      setPending(false);
    }
  };

  if (jobId !== null) {
    return <span className="pill warn">生成中</span>;
  }

  return (
    <>
      {error !== null && (
        <span className="gerr" title={error}>{`生成失败：${error}`}</span>
      )}
      <button className="btn gen" type="button" onClick={() => void start()} disabled={pending}>
        {error === null ? '生成' : '重试'}
      </button>
    </>
  );
}

export default GenerateButton;
