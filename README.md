# Antigravity Context Monitor

一个面向 **Google Antigravity** 的轻量级原生侧边栏（Aux Pane）UI 插件，让你实时看到当前对话的 **上下文使用情况** 与 **自动压缩阈值**，告别盲猜。

## 核心特性

- **实时上下文监控（零额外 Token 消耗）**：通过本地 Sidecar 后台只读解析当前会话的 `transcript.jsonl`，精准统计 `input_tokens + cache_read_tokens`。
- **压缩阈值与预警**：清晰展示 `当前已用 / 压缩阈值` 进度条与剩余空间，达到 **75%（黄）/ 90%（红）** 自动变色预警。
- **原生窗口对照**：在模型原生上下文窗口（如 1M）上标出压缩阈值线位置。
- **辅助指标与趋势图**：同时显示 Prompt Cache 命中率、本轮输出、下轮输入基线预估及上下文增长曲线。
- **自定义阈值与自动压缩检测**：内置 `128K / 200K / 256K / 512K / 1M` 预设和自定义输入；检测到会话发生压缩时自动记录触发前峰值并支持一键校准。
- **隐私与安全**：纯本地运行，仅只读访问当前会话的本地 transcript 日志，无任何外联请求，不主动操控 Agent。

## 目录结构

```text
.
├── plugin.json
├── README.md
├── LICENSE
├── assets/
│   └── logo.svg
└── sidecars/
    └── monitor/
        ├── package.json
        ├── sidecar.json
        ├── main.mjs
        ├── index.html
        ├── styles.css
        └── app.js
```

## 安装方法

### 方式一：直接克隆到本地插件目录（推荐）

```bash
git clone https://github.com/pinchuan54/antigravity-context-monitor.git ~/.gemini/config/plugins/context-monitor
```

Windows PowerShell：

```powershell
git clone https://github.com/pinchuan54/antigravity-context-monitor.git "$env:USERPROFILE\.gemini\config\plugins\context-monitor"
```

### 方式二：使用 Antigravity CLI 安装

```bash
agy plugin install https://github.com/pinchuan54/antigravity-context-monitor
```

安装完成后 Antigravity 会自动发现并启动插件，无需重启 App。在对话右侧辅助面板（Aux Pane）的 **+** 菜单中打开 **Context** 即可使用。

## 关于压缩阈值说明

Antigravity 目前未将内部自动压缩阈值直接暴露在 transcript 日志中：
- 默认按引擎常见上限 **256K tokens** 作为参考值（如设置了 `AGY_CLI_AUTO_COMPACT_OVERRIDE` 环境变量也会优先读取）。
- 你可以在面板底部随时切换预设或输入自定义阈值，设置会自动持久化保存。

## License

MIT
