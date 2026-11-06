'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { GeneratorView } from '../../src/core/uemaster/candidates';
import { generateAction, generationStatusAction } from '../actions';
import { GeneratorDialog } from './GeneratorDialog';

/**
 * 参考段那一行右边的「生成」：按下 → 服务端开一次作业 → 这一行变「生成中」→
 * 变成产物链接，或者一行中文失败原因。
 *
 * 生成器在这条链路上只出现一次，就是**第一次**（P2.8）：
 * - `ready`（配过了 / env）：直接跑，不弹任何东西——story map 第 4 行。
 * - `choose`（还没配）：在原地弹那个小对话框（一个下拉 + 测试并使用）。
 *   测通就存下并**接着开跑**（一次点击的意图）；测不通，对话框留着，换一个再按。
 *   存过之后，这一支再也不会走到——story map 第 2、3 行。
 * - `none`（一个可执行文件都没有）：按钮禁用，一句原因 + 去设置那一格。
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
  /** 第一次用时的那个对话框：只在「还没配」时开，而且只开一次（答完就落库）。 */
  const [asking, setAsking] = useState(false);
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
        // 服务端说「还没选 / 没有生成器」时，界面状态已经过期（另一个标签页刚改过
        // 设置）：刷新一次让服务端把新的解析结果送上来。
        if (/生成器/.test(result.message)) router.refresh();
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

  // 一个可执行文件都没有：按钮禁用，理由在行里，指路就在旁边（设置页那一格）。
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
          if (generator.state === 'choose') setAsking(true);
          else void start();
        }}
        disabled={pending}
      >
        {error === null ? '生成' : '重试'}
      </button>
      {asking && (
        <div
          className="sheet on"
          onClick={(event) => {
            // 点遮罩 = 关闭（与动作条、交回材料同一个行为）；点 box 内部不关。
            if (event.target === event.currentTarget) setAsking(false);
          }}
        >
          <div className="box">
            <div className="h">生成器</div>
            <div className="b">
              <GeneratorDialog
                view={generator}
                onCancel={() => setAsking(false)}
                onDone={() => {
                  // 测通并落库之后：关框、刷新（服务端的解析结果从 choose 变 ready）、
                  // 立刻开跑。一次点击的意图，不是两次。
                  setAsking(false);
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
