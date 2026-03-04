# AI 使用规范（MCP 调用）

## 必须使用的 MCP
- 当需要判断“当前页面是否为 single-spa 项目”时，必须调用 `spawriter` 这个 MCP。
- 不要自行通过页面源码或 DOM 做主观判断，统一使用该 MCP 的返回结果。

## 调用时机
- 任何涉及当前页面识别、单页应用框架识别、root-config/importmap 识别的需求，优先调用 `spawriter`。

## 目标输出
- MCP 返回后，只输出“是/否”结论，除非用户明确要求更多细节。
