# flowspec/1 契约

flow-canvas 的中间格式与产物契约。下游（如 flow-walkthrough）只依赖本契约，不依赖布局器实现。契约破坏性变更时主版本 +1。

## 输入：flowspec JSON

```json
{
  "spec": "flowspec/1",
  "title": "可选标题",
  "start": "A",
  "nodes": [
    { "id": "A",  "type": "process",  "label": ["进入寄养频道"] },
    { "id": "B",  "type": "decision", "label": ["是否登录？"] },
    { "id": "I2", "type": "external", "label": ["支付平台 · 收银台"] },
    { "id": "G",  "type": "backend",  "label": ["门店接单后台"] }
  ],
  "edges": [
    { "from": "A", "to": "B", "label": [] },
    { "from": "B", "to": "C", "label": ["是"] }
  ]
}
```

- `type`：`process` 实线框（本产品页面/状态）｜`decision` 扁菱形（判断，不可点）｜`external` 虚线框（外部系统/已有页面）｜`backend` 双边线灰底（后台/非前端环节）
- `label` / 边 `label`：字符串数组，一项一行；禁止 emoji
- `start` 可省略：布局器按"声明序首节点标回边 → DAG 入度 0 且非后台类型的最靠前节点"推断
- 判断节点出边应带"是/否"类标签——主干选择的第一判据是标签语义（是/通过/有效/已绑定 等为主干方向）

## 等价 mermaid 子集

`A["文本"]`＝process；`A{"文本"}`＝decision；`A[["文本"]]`＝backend；`class I2,L external` / `class G,M backend` 标注类型；`-->|label|` 边；`<br>` 换行；label 含"（外部）"自动识别为 external。

## 输出：SVG 结构契约

- 根元素：`<svg id="flowsvg" data-flowspec="1" viewBox="0 0 W H">`
- 可交互节点：`<g class="node" id="flowchart-{id}-{n}" data-node="{id}">`；判断节点无 `data-node`
- 选中框：`<rect id="sel-ring" visibility="hidden"/>`（下游按目标节点 `getBBox()` 外扩 7px 定位）
- 交叉检测：布局报告 JSON 的 `crossings` 为 0 是合格产物的必要条件

## 布局规则（无 python3 时的手工降级依据）

1. 主干节点排纵向主列；判断菱形扁形（宽约为高的 3 倍）
2. 判断出线端口：主干方向走底部顶点垂直出线；分支走右侧水平顶点，分支首节点与判断垂直居中（水平直线）
3. 分支链沿右列垂直向下；汇回主干时——目标为判断节点：T 形汇入主干线段（无箭头）；目标为普通节点：进右侧端口
4. 回边走最右侧通道，90 度折线，入目标右侧端口；同一节点多入口错位 ±9px（前向汇入在上、回边在下）
5. 无入边旁路源节点排左列，与目标水平对齐直线接入
6. 主干跳级边（首尾都在主干、非相邻的前向边）：目标为判断节点时走右侧前向通道（回边通道外侧）T 形汇入目标顶部上方；其余走左侧远端通道进目标左端口
7. 分支链可指定放左列（与右链镜像）：从锚点左侧出线，链沿左列向下，经左侧远端通道汇入目标左端口；多条左侧通道按目标深度分配（越深越靠外）
8. 线与线不得交叉
