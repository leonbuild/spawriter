# AI 使用规范（MCP 调用）

## 必须使用的 MCP
- 当需要判断"当前页面是否为 single-spa 项目"时，必须调用 `spawriter` 这个 MCP。
- 不要自行通过页面源码或 DOM 做主观判断，统一使用该 MCP 的返回结果。

## 调用时机
- 任何涉及当前页面识别、单页应用框架识别、root-config/importmap 识别的需求，优先调用 `spawriter`。

## 目标输出
- MCP 返回后，只输出"是/否"结论，除非用户明确要求更多细节。

## 多 Agent 协作

当多个 AI Agent 并行使用 spawriter 时，Tab Lease System 自动管理 tab 所有权：

- 每个 MCP 进程有唯一 client ID，relay 强制执行 tab 租约
- CDP 事件仅路由给租约持有者，防止跨 agent 干扰
- Agent 断开连接或 tab 关闭时，租约自动释放

### 环境变量配置

- `SSPA_AGENT_LABEL` — Agent 可读标签（显示在 `list_tabs` 中）
- `SSPA_PROJECT_URL` — 自动匹配 tab 的 URL 子串

### 新增工具

- `connect_tab` — 通过 URL 匹配或创建新 tab 来连接
- `release_tab` — 释放当前 tab 的租约，使其可供其他 agent 使用
- `list_tabs` — 现在显示 `MINE`、`LEASED by <label>`、`AVAILABLE` 标记
- `switch_tab` — 租约感知：拒绝切换到其他 agent 的 tab

### 注意事项

- 单 agent 场景无需额外配置，行为与之前完全一致
- 多 agent 场景下 `reset` 会先释放所有租约再重置连接
