# walkmap/1 契约

flow-walkthrough 的输入格式。上游依赖 flow-canvas 的 flowspec/1 SVG 契约（`data-flowspec="1"`、节点 `data-node="{id}"`、`#sel-ring`）。契约破坏性变更时主版本 +1。

```json
{
  "spec": "walkmap/1",
  "title": "走查标题",
  "svg": "相对本文件的 SVG 路径",
  "default_node": "C",
  "css_vars": { "--wt-accent": "#555555" },
  "pages": [
    { "id": "p-home-none", "frame": "phone", "file": "pages/home-none.html" },
    { "id": "p-admin",     "frame": "wide",  "file": "pages/admin.html" }
  ],
  "state_groups": {
    "home": {
      "title": "寄养首页",
      "states": [
        { "id": "none",     "label": "未预约",     "node": "C" },
        { "id": "pending",  "label": "待门店确认", "node": "F" },
        { "id": "success",  "label": "预约成功",   "node": "K" }
      ]
    }
  },
  "nodes": {
    "A": { "page": "p-home-none", "state": "home/none", "title": "节点标题", "anno": [["标注小标题", "标注正文"]] }
  }
}
```

- `pages[].frame`：`phone`（375px 手机框）｜`wide`（690px 后台/浏览器宽窗口），切换节点时自动切换设备框
- `pages[].file`：页面 HTML 片段（body 内片段，不含 html/head），可使用模板内置的 `wt-*` 组件类与 `goNode(id)` API
- `nodes`：仅需覆盖 SVG 中带 `data-node` 的节点；多个节点可指向同一页面；缺失映射的 SVG 节点构建时给警告
- `state_groups` 可选：页面状态组，驱动右侧「页面状态切换」。每组 `title` + `states`（至少 2 个，否则报错：单状态页面不建组、右侧不放按钮）；每个状态 `id`、`label`、`node`（该状态的代表节点，必须在 `nodes` 里）。代表节点自动归属该状态；其他节点用 `state: "组id/状态id"` 声明自己处在哪个状态（如「关闭弹窗：停留预约表单页」处在表单页的填写中状态）。构建器校验：状态引用未定义节点、节点 `state` 不在任何组里、代表节点又声明了别的 `state` 均报错；两个状态使用同一页面文件、声明节点的页面与代表节点不同均给警告
- 右侧「页面状态切换」渲染规则：当前节点有 `state` 且所在组状态数 ≥ 2 时出现，当前态高亮不可点，其他态点击 `goNode(代表节点)`（流程图选中同步）；单状态页面不出现。标注区不放「所属分支」「下一步」之类的导航按钮，节点推进靠点流程图或页面内 `goNode`
- `css_vars` 可选：覆盖模板 `:root` 的 `--wt-*` 样式变量；缺省为灰度线框
- 产物为单文件 HTML，零运行时依赖、离线可用
