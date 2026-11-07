# 状态机：十个状态、十三条迁移

> 代码是唯一来源：`src/core/state-machine.ts`（定义）与 `src/core/read/detail.ts`（谁能做什么）。
> 本文是给人读的一张表，不是第二份实现——两者若不一致，以代码为准，并且那是 bug。

## 十个状态

| # | key | 中文 | 含义 | 怎么进来 | 怎么出去 |
|---|---|---|---|---|---|
| 1 | `inbox` | **收集** | 还没人接。**谁录入谁就是负责人** | 新建需求 / 从搁置恢复 | 立项、提交 PRD、拒绝、搁置 |
| 2 | `design` | **待设计** | 接了，PRD 在写 | 立项（`evaluate`） | 提交 PRD、搁置 |
| 3 | `review` | **待评审** | 等条线负责人签字 | 提交 PRD（需 PRD 链接） | 通过、打回、搁置 |
| 4 | `queue` | **待排期** | 过了评审，等排进版本 | 评审通过 | 排期、搁置 |
| 5 | `ready` | **待开发** | 已排期，等开工日 | 排期（定版本 + 提测日 + 承诺完成日） | **时钟**推进 |
| 6 | `dev` | **开发中** | 在写代码 | 时钟到开工日 | **时钟**推进 |
| 7 | `test` | **测试中** | 已提测 | 时钟到提测日 | **时钟**上线；或打回开发 |
| 8 | `live` | **已上线** | 上线了 | 时钟到承诺完成日 | 搁置 |
| 9 | `rejected` | **已拒绝** | 明确不做 | 拒绝（**必须给理由**） | 无出口（终态） |
| 10 | `shelved` | **已搁置** | 暂缓，不是不做 | 任何非终态都能搁置（**必须给理由**） | 恢复 → 回收集 |

两件事值得单独记：

- **「已拒绝」和「已搁置」都是终态，但只有搁置能恢复。** 拒绝是不可逆的——要重开就新建
  一条，历史留在原来那条上。
- **`collect`（旧 Flower）与 `inbox` 是同一个东西**：还没人接。老系统把它拆成
  `collect` 与 `to_evaluate` 两个状态，迁移时合并进这里。

## 十三条迁移

```
inbox   → design     evaluate        需类型
inbox   → review     submit_review   需 PRD 链接     ← 可跳过待设计
inbox   → rejected   reject          需理由
inbox   → shelved    shelve          需理由
design  → review     submit_review   需 PRD 链接
review  → queue      review_pass
review  → design     review_reject   需理由           ← 打回，回待设计
queue   → ready      schedule        需版本 + 两个日期
ready   → dev        clock（自动）                    需开工日
dev     → test       clock（自动）                    需提测日
test    → live       clock（自动）                    需承诺完成日
test    → dev        bounce          需新承诺日 + 理由  ← 打回开发
shelved → inbox      restore
```

三点：

1. **三条是时钟推的**（`ready→dev→test→live`），人点不了。`tick` 按**上海日历天**判，
   不用时长差——「11-13 提测」指的是那一天，不是 24 小时后。
2. **提交 PRD 能从「收集」直接跳「待评审」**，跳过待设计。给「PRD 已经写好」的情况留的路。
3. **打回有两个方向**：评审打回回待设计；测试打回回开发。两者的理由与日期要求不同。

## 看板列顺序

```
收集 → 待设计 → 待评审 → 待排期 → 待开发 → 开发中 → 测试中 → 已上线 → 已拒绝 → 已搁置
```

`BOARD_STATES`（`src/core/read/board.ts`）是唯一来源，列头和卡片都从它生成。

## 谁能做什么

权限锚点是**负责人所在的条线**（不是需求类型）：

| 动作 | 谁能做 |
|---|---|
| 认领（无主时） | 任何 PM / 条线负责人 / 超管 |
| 立项、提交 PRD、排期、打回、拒绝、搁置 | 负责人本人；负责人所在条线的负责人；超管 |
| 评审签字 | **只有派单到的那个人**（条线负责人或超管） |
| 改负责人 | 负责人所在条线的负责人；超管 |
| 全部只读 | 任何人 |

## 与旧 Flower 的映射

线上 803 条需求分布在 11 个状态，折叠进这里的 10 个：

| 旧状态 | 条数 | → 新状态 |
|---|---|---|
| `collect` | 158 | `inbox` 收集 |
| `to_evaluate` | 102 | `inbox` 收集 |
| `to_design` | 48 | `design` 待设计 |
| `designing` | 18 | `design` 待设计 |
| `evaluated` | 41 | `design` 待设计 |
| `to_develop` | 18 | `ready` 待开发 |
| `developing` | 15 | `dev` 开发中 |
| `testing` | 2 | `test` 测试中 |
| `launched` | 264 | `live` 已上线 |
| `rejected` | 73 | `rejected` 已拒绝 |
| `shelved` | 64 | `shelved` 已搁置 |

**11 个状态全部有去处，一个不丢。** 其中 `to_evaluate→收集`、`evaluated→待设计`、
`designing→待设计` 三条是 owner 裁决的（见 `p4-09` 报告）。
