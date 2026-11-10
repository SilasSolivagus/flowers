/**
 * 立项前必填的**核心三问**（2026-11-10 owner 的裁决，判据在
 * `src/core/requirements/brief.ts`）。
 *
 * 为什么要有这么一个夹具：那条规则说的是「六问不齐不能立项」，于是**所有走到待设计
 * 及其之后的用例**都必须先把这三格填上——否则它测的那件事（排期、时钟、通知、
 * 权限…）根本跑不到，红的是一条与它无关的门。
 *
 * 只在**测这道门本身**的地方才空着它们（`tests/brief-guard.test.ts`、
 * `tests/generate-gate.test.ts`、`tests/brief-backfill.test.ts`）；别处一律 spread 进来。
 *
 * 三个值故意写得像一条真需求（角色 + 现状 + 成功口径），而不是 'x' / 'y' / 'z'：
 * 它们会一路出现在抽屉、材料提示词和通知正文里，读用例的人该看得出这是一条正常的
 * 需求，而不是一串占位符。
 */
export const BRIEF = {
  context: '运营在后台给客户开权限时',
  problem: '每次要跳七个页面，容易漏配',
  outcome: '一次点完，漏配为 0',
} as const;
