# 页面片段画法

适用于 flow-walkthrough 中间设备框里的页面片段（`pages/*.html`）。调用方已有原型时，从原型里提取页面，本文只用来查漏；没有原型、要按 PRD 画页面时，按本文画。调用方声明了自己的设计规范时，以调用方规范为准，样式差异用 walkmap 的 `css_vars` 覆盖。

## 一、设备框里只放用户会看到的东西

设备框就是用户的手机屏幕或浏览器窗口，框里的每一段文字都应该是产品上线后用户真的会看到的内容。

- 可以放：标题、正文、按钮文字、输入框提示、弹窗、toast、空态文案，以及自然、中性的占位内容（比如一个示例门店、一条普通的动态）。
- 不能放：设计理由、讨论过程、边界条件、「本期不做 / 待确认」、演示操作说明。这些写进节点标注（`nodes[].anno`）。
- 元素下方不加解释性的小字。只有产品本身就带说明小字的元素（比如设置项下面的说明、数据卡片的口径提示）才写，而且写的是产品文案。
- 占位内容不要写成「这是用来测试某功能的内容」。
- 交付前逐句自查：这句话会出现在上线的产品里吗？不会，就移到标注里。

## 二、标注怎么指到页面上的位置

- 右栏标注需要指向页面某个位置时，用方括号编号加位置描述，比如「[A] 顶部状态卡片」「[B] 底部预约按钮」。
- 编号只写在标注里，不画进页面；不用圆形数字，以免和产品里常见的消息数字角标混淆。

## 三、一个状态一个文件

- 同一页面的不同状态（弹窗、toast、只读态、空态等）各画一个文件。各文件只在规则规定的地方不同，其余部分保持一致，方便评审时对比。
- 弹窗态 = 原页面 + 遮罩和对话框（`wt-screen` 里放 `wt-modal`）；toast 态 = 原页面 + `wt-toast`。
- 页面里能推进流程的按钮，写 `onclick="goNode('节点id')"` 跳到下一个节点。演示用的切换按钮不放进页面，统一放在右栏「页面状态切换」（见 SKILL.md 对应原则第 4 条）。
- 由外部系统承接的页面（支付、第三方平台、线上已有页面）画成简化页面：导航栏写页面名，内容用占位块和必要的按钮。不要在框里写「该页面由外部系统承接」这类说明，这句话写进节点标注。

## 四、尺寸与风格

- 手机页面按 375px 宽画，放在 phone 框；后台和网页页面放在 690px 宽的 wide 框。真实产品按 1200–1440px 设计的网页，在走查里保留结构、按比例压缩，不必和设计稿像素一致。
- 低保真灰度线框：浅色背景、白底卡片、细边框、深灰文字。强调色只用在主按钮和选中态，不用渐变、阴影和装饰图形。
- 图片和图标用占位块（`wt-img`）或文字占位（如「[图标]」），不用 emoji（构建器会校验并拒绝）。
- 只画 PRD 里有的内容和行为，不自行添加功能；PRD 写明的空态、错误态、超长文本截断等边界情况要画出来。

## 五、组件

模板内置以下样式类，页面片段直接使用即可，不需要自带样式。

| 类名 | 用途 |
|---|---|
| `wt-titlebar` | 只有居中标题的简单标题栏 |
| `wt-body` | 带内边距的内容区 |
| `wt-input` | 输入框（整行宽） |
| `wt-btn` | 主按钮（整行宽）；加 `wt-btn-ghost` 为次按钮，加 `wt-btn-sm` 为行内小按钮 |
| `wt-card` | 白底细边框卡片 |
| `wt-badge` | 状态标签 |
| `wt-dimtext` | 次要说明文字（必须是产品文案） |
| `wt-screen` | 手机整屏容器，需要弹窗、toast、底部操作栏时用它包住整个页面 |
| `wt-statusbar` | 手机状态栏（时间 + 电量占位） |
| `wt-nav` | 导航栏：`wt-nav-back` 返回、`wt-nav-title` 标题、`wt-nav-action` 右侧操作 |
| `wt-tabs` / `wt-tab` | 标签切换，当前项加 `wt-on` |
| `wt-section` | 列表或内容分组的小标题 |
| `wt-list` / `wt-list-item` | 列表行：`wt-li-main` 里放 `wt-li-title`、`wt-li-sub`，右侧放 `wt-li-extra` 或 `wt-li-arrow` |
| `wt-img` | 图片占位块，高度按需要写在行内样式里 |
| `wt-empty` | 空态（圆形虚线占位 + 文案） |
| `wt-bottombar` | 固定在屏幕底部的操作栏（放在 `wt-screen` 里） |
| `wt-modal` / `wt-dialog` | 遮罩和对话框：`wt-dialog-title`、`wt-dialog-body`、`wt-dialog-actions` |
| `wt-toast` | 屏幕中间的轻提示（放在 `wt-screen` 里） |
| `wt-browserbar` | 后台页面顶部的浏览器地址栏：三个 `<i>` 加一个 `<span>` 写页面名 |
| `wt-table` | 后台表格 |

### 手机页面骨架

```html
<div class="wt-screen">
  <div class="wt-statusbar"><span>9:41</span><span class="wt-sb-icons"></span></div>
  <div class="wt-nav"><span class="wt-nav-back"></span><span class="wt-nav-title">页面标题</span><span class="wt-nav-action">分享</span></div>
  <div class="wt-section">分组标题</div>
  <div class="wt-list">
    <div class="wt-list-item">
      <div class="wt-li-main"><div class="wt-li-title">列表标题</div><div class="wt-li-sub">次要信息</div></div>
      <span class="wt-li-arrow"></span>
    </div>
  </div>
  <div class="wt-bottombar"><button class="wt-btn" onclick="goNode('E')">主操作</button></div>
</div>
```

### 弹窗态与 toast 态

```html
<div class="wt-screen">
  <!-- 与原页面相同的内容 -->
  <div class="wt-modal">
    <div class="wt-dialog">
      <div class="wt-dialog-title">弹窗标题</div>
      <div class="wt-dialog-body">弹窗正文</div>
      <div class="wt-dialog-actions">
        <button class="wt-btn wt-btn-ghost">取消</button>
        <button class="wt-btn" onclick="goNode('N')">确定</button>
      </div>
    </div>
  </div>
</div>
```

toast 态把 `wt-modal` 换成 `<div class="wt-toast">提示文案</div>`。

### 后台页面

```html
<div class="wt-browserbar"><i></i><i></i><i></i><span>后台名称 - 页面名称</span></div>
<div class="wt-body">
  <table class="wt-table">
    <tr><th>提交时间</th><th>内容</th><th>操作</th></tr>
    <tr><td>09-28 14:32</td><td>示例内容</td>
      <td><button class="wt-btn wt-btn-sm" onclick="goNode('I1')">通过</button> <button class="wt-btn wt-btn-sm wt-btn-ghost" onclick="goNode('H1')">驳回</button></td></tr>
  </table>
</div>
```

## 六、交付前检查

1. 流程图里每个可点节点都有对应页面；多状态页面的每个状态都有自己的文件。
2. 设备框里的文字逐句过一遍第一节的自查问题。
3. 运行 `build.py walkmap.json --check`：error 必须为 0，warning 逐条向用户说明。
