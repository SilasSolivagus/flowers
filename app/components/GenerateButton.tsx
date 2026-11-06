'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { GeneratorView } from '../../src/core/uemaster/candidates';
import { generateAction, generationStatusAction } from '../actions';
import { GeneratorPicker } from './GeneratorPicker';

/**
 * 参考段那一行右边的「生成」：按下 → 服务端开一次作业 → 这一行变「生成中」→
 * 变成产物链接，或者一行中文失败原因。
 *
 * P2.7 起这个按钮还承担**生成器解析**在界面上的那一半（服务端那一半在
 * `startGeneration` / `runJob`）：
 * - `ready`：一条命令（env / 已保存 / 唯一探测到的），直接跑；
 * - `choose`：探测到多条 → 按下先开选择器，选完保存再跑；
 * - `none`：一条都没有 → 按钮**禁用**，旁边一行说「未检测到生成器」并指路去设置。
 *
 * 还有一条来自本机的口径：自动探测到的那一条**没有被验证过**（本机的 codex
 * `login status` 说已登录、`exec` 却 401）。所以它的第一次真跑要是失败，除了照登
 * 原文，还要把选择器打开——让用户当场换一条，而不是盯着「OAuth session expired」
 * 猜自己能做什么。
 *
 * 三条从 P2.6 留下来的取舍：
 * 1. **没有进度条、没有 spinner**。真正要告诉用户的只有两件：「在跑」和「结果 / 原因」。
 * 2. **错误就在行里**，由服务端作业的 `error` 原文加前缀「生成失败：」组成。
 *    `OAuth session expired` 是合法且有用的句子；「生成失败」四个字什么也没说。
 * 3. **刷新之后状态还在**。初始的 `runningJobId` 由服务端读模型给出（正在跑的作业），
 *    所以刷新页面、换一个人打开同一条需求，看到的都是「生成中」。
 */

/** 轮询间隔：够快看到结果，又不至于把 server action 当日志刷。 */
const POLL_MS = 1500;

/** 客户端等不到结果的上限。服务端的硬超时是 10 分钟，这里多留一分钟。 */
const GIVE_UP_MS = 11 * 60 * 1000;

export function GenerateButton({
  requirementId, stage, runningJobId, generator,
}: {
  requirementId: string;
  stage: string;
  runningJobId: string | null;
  generator: GeneratorView;
}) {
  const router = useRouter();
  const [jobId, setJobId] = useState<string | null>(runningJobId);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [picking, setPicking] = useState(false);
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
        // 自动探测出来的那条命令从没被验证过：失败了就当场给出选择器，别让人对着
        // 一句 stderr 猜自己能换什么。
        if (generator.source === 'detected') setPicking(true);
        return;
      }
      timer = setTimeout(() => void tick(), POLL_MS);
    };

    timer = setTimeout(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [jobId, router, generator.source]);

  const start = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      const form = new FormData();
      form.set('requirementId', requirementId);
      form.set('stage', stage);
      const result = await generateAction(form);
      if (!result.ok) {
        // 服务端说「多条 / 没有生成器」时，界面状态已经过期（另一个标签页刚改过设置）：
        // 刷新一次让服务端把新的解析结果送上来。
        if (!result.ok && /生成器/.test(result.message)) router.refresh();
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

  // 一条都没有：按钮禁用，理由在行里，指路就在旁边（设置页那一格）。
  if (generator.state === 'none') {
    return (
      <span className="gen-off">
        <span className="gerr">
          未检测到生成器 · <Link className="gen-link" href="/settings?tab=project">设置</Link>
        </span>
        <button className="btn gen" type="button" disabled>生成</button>
      </span>
    );
  }

  return (
    <>
      {error !== null && (
        <span className="gerr" title={error}>{`生成失败：${error}`}</span>
      )}
      <button
        className="btn gen"
        type="button"
        onClick={() => {
          if (generator.state === 'choose') setPicking(true);
          else void start();
        }}
        disabled={pending}
      >
        {error === null ? '生成' : '重试'}
      </button>
      {picking && (
        <div
          className="sheet on"
          onClick={(event) => {
            // 点遮罩 = 关闭（与动作条、交回材料同一个行为）；点 box 内部不关。
            if (event.target === event.currentTarget) setPicking(false);
          }}
        >
          <div className="box">
            <div className="h">生成器</div>
            <div className="b">
              <GeneratorPicker
                candidates={generator.candidates}
                known={generator.known}
                onCancel={() => setPicking(false)}
                onPicked={() => {
                  setPicking(false);
                  // 保存之后服务端的解析结果变了（source=settings）：刷新让这一行
                  // 拿到新的 generator，再开始这一次生成。
                  router.refresh();
                  void start();
                }}
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default GenerateButton;
