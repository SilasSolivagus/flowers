'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GeneratorView } from '../../src/core/uemaster/candidates';
import { attemptLine, classifyFailure, type AttemptView, type Failure } from '../../src/core/uemaster/trace';
import { generateAction, generationStatusAction } from '../actions';
import { GeneratorDialog } from './GeneratorDialog';
import { Toast } from './Toast';

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
 *
 * P2.13 起失败多两件东西，各管一件事：
 * - 行里那句仍是**留档**：`生成失败：<原文>`，一个字不改写；
 * - 行下多一个「详情」，列出这一次作业的每一次尝试（`第 1 次 · flow · 2 个节点 1 条连线被拒`），
 *   数据来自 `uemaster_job_attempts`——原来只有最后那句能活下来，前几次的理由全蒸发了；
 * - 外加一个 6 秒的浮层：点完去看别处的人回来时，行还在，但他没看见那一声。
 * 三者只在**失败**时出现；成功的作业一条尝试记录也会写库，只是界面不显示（无噪音）。
 */

/** 轮询间隔：够快看到结果，又不至于把 server action 当日志刷。 */
const POLL_MS = 1500;

/** 客户端等不到结果的上限。服务端的硬超时是 10 分钟，这里多留一分钟。 */
const GIVE_UP_MS = 11 * 60 * 1000;

export function GenerateButton({
  requirementId, stage, runningJobId, generator, present, fresh,
}: {
  requirementId: string;
  stage: string;
  runningJobId: string | null;
  generator: GeneratorView;
  /**
   * 这一阶段已经有一份产物（P4-02）。
   *
   * 它只改**按钮上的字**（`生成` → `重新生成`）与鼠标悬停时那一句警告，不改行为：
   * 重新生成**永远允许**（owner 的裁决）。生成是一次可能的覆盖，但「有一份旧的、
   * 我想再做一份」是常态——把它拦下来只会逼人去删产物。
   *
   * `fresh` 只用于那句警告的措辞：当前版本已有一份（`fresh`）与旧版本还在（`stale`）
   * 是两件不同的事，但两者的后果一样「会再存一版」，所以都不拦。
   */
  present: boolean;
  fresh: boolean;
}) {
  const router = useRouter();
  const [jobId, setJobId] = useState<string | null>(runningJobId);
  const [error, setError] = useState<string | null>(null);
  /**
   * 这一次失败的那条作业的尝试清单（P2.13）。只在失败时非空：成功的作业不显示任何东西，
   * 但库里照样有它的行（诊断要用）。
   */
  const [attempts, setAttempts] = useState<AttemptView[]>([]);
  /** 浮层：`seq` 让「又失败了一次」重新计时，而不是沿用上一次那 6 秒。 */
  const [toast, setToast] = useState<{ seq: number; failure: Failure } | null>(null);
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
        const message = '生成没有回报（后台进程可能已退出）';
        setError(message);
        setToast((was) => ({ seq: (was?.seq ?? 0) + 1, failure: classifyFailure(message) }));
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
        const message = status.error ?? '未知原因';
        setError(message);
        // 详情与浮层同源：都是这条作业的尝试清单 / 那句原文的分类。分类只决定浮层
        // 说哪句人话，行里那句始终是原文。
        setAttempts(status.attempts);
        setToast((was) => ({ seq: (was?.seq ?? 0) + 1, failure: classifyFailure(message) }));
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

  const closeToast = useCallback(() => setToast(null), []);

  const start = async (): Promise<void> => {
    setPending(true);
    setError(null);
    setAttempts([]);
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
        // 连作业都没开成（没生成器 / 正在生成中）：这也是一次终端失败，同样要那一声。
        setToast((was) => ({ seq: (was?.seq ?? 0) + 1, failure: classifyFailure(result.message) }));
        return;
      }
      deadline.current = Date.now() + GIVE_UP_MS;
      setJobId(result.jobId);
    } catch {
      setError('生成请求没有送达');
      setToast((was) => ({ seq: (was?.seq ?? 0) + 1, failure: classifyFailure('生成请求没有送达') }));
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
        <>
          <span className="gerr" title={error}>{`生成失败：${error}`}</span>
          {/* 详情：只在失败时出现，成功时界面一个新元素都不多。一条尝试一行，
              没有散文——这里要的是「几次、卡在哪一步」，不是第二篇报错。 */}
          {attempts.length > 0 && (
            <details className="gen-trace">
              <summary>详情</summary>
              <ol className="gen-trace-l">
                {attempts.map((item) => (
                  <li key={`${item.phase}-${item.attempt}`}>{attemptLine(item)}</li>
                ))}
              </ol>
            </details>
          )}
        </>
      )}
      <button
        className="btn gen"
        type="button"
        title={present
          ? (fresh
            ? '已有一份当前版本的产物，重新生成会再存一版'
            : '已有一份旧版本的产物，重新生成会再存一版')
          : undefined}
        onClick={() => {
          if (generator.state === 'choose') setAsking(true);
          else void start();
        }}
        disabled={pending}
      >
        {error === null ? (present ? '重新生成' : '生成') : '重试'}
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
      {toast !== null && (
        <Toast key={toast.seq} failure={toast.failure} onClose={closeToast} />
      )}
    </>
  );
}

export default GenerateButton;
