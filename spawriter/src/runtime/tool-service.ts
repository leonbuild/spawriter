export interface ToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

/**
 * Tool executor bridge.
 * In Phase 2 transition, MCP tool implementations remain in mcp.ts.
 * This module provides the interface that control-routes and cli-globals use.
 * The actual executor function is passed in at registration time by relay.ts,
 * which invokes the MCP tool handler or a direct CDP implementation.
 */
export type ToolExecutorFn = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
