/**
 * 进度卡上那格时间：`00:47`。**零依赖**，客户端组件直接 import。
 *
 * 为什么单独一个文件：`read/progress.ts` 要连库（它 import 了 `db/client`），而
 * 右下角那张卡是**客户端**组件——它每次轮询都通过 server action 问服务端，自己
 * 一个 SQL 都不发。若把 `elapsedLabel` 留在 `progress.ts` 里，这个纯字符串函数会
 * 连带把 `pg` 拖进浏览器包（webpack 立刻报 `Can't resolve 'fs'`，因为 `pg` 的
 * TLS 分支 require 了 fs）。同一个坑在 `requirements/fields.ts` 里已经踩过一次。
 */

/**
 * 毫秒 → `mm:ss`（超过一小时写 `h:mm:ss`，那次生成最长的硬超时是十分钟，这一支
 * 只是兜底）。
 *
 * 负数（客户端时钟比服务端慢）夹到 0：显示 `-00:03` 只会让人以为系统坏了，而它
 * 真实的含义是「两端的钟差了几秒」。
 */
export function elapsedLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}
