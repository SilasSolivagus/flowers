# 主题包

来源：`SilasSolivagus/silas-UX`（全局设计规范，私有）。

不要在这里手改。改 `silas-UX/tokens/tokens.json` → 跑 `scripts/build_theme.py` →
把 `integrations/uemaster/` 下的三个文件复制过来。

| 文件 | 用途 |
| --- | --- |
| `default.style.json` | 浅色主题，flow-canvas 默认自动加载 |
| `dark.style.json` | 深色主题，需显式 `--style` |
| `default.walkmap.json` | flow-walkthrough 的 css_vars 打底 |

## 自动生效

`flowcommon.load_style()` 在未传 `--style` 时读 `default.style.json`；
`build.py` 在 walkmap 未写 `css_vars` 时读 `default.walkmap.json`。

## 同步命令

```bash
cd ~/skills-src/silas-UX && python3 scripts/build_theme.py
cp integrations/uemaster/*.json ~/skills-src/UEmaster/skills/_theme/
```
