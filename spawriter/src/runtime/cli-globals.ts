import type { PlaywrightExecutor } from '../pw-executor.js';

export interface ToolContext {
  executeTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Inject spawriter-specific tools into executor's global scope.
 * Playwright-native API (page, context, state) is already provided by the executor.
 *
 * Only injects capabilities that Playwright native API cannot directly accomplish:
 * - Single-spa management (spawriter-unique)
 * - Tab Lease System (spawriter-unique)
 * - CDP-enhanced wrappers (complex CDP operations)
 */
export function injectSpawriterGlobals(
  executor: PlaywrightExecutor,
  sessionId: string,
  toolContext: ToolContext,
): void {
  executor.setGlobals({
    singleSpa: async (
      action: string,
      opts?: { appName?: string; url?: string },
    ) => {
      switch (action) {
        case 'status':
          return toolContext.executeTool('dashboard_state', {});
        case 'override_set':
          return toolContext.executeTool('override_app', { action: 'set', appName: opts?.appName, url: opts?.url });
        case 'override_remove':
          return toolContext.executeTool('override_app', { action: 'remove', appName: opts?.appName });
        case 'override_enable':
          return toolContext.executeTool('override_app', { action: 'enable', appName: opts?.appName });
        case 'override_disable':
          return toolContext.executeTool('override_app', { action: 'disable', appName: opts?.appName });
        case 'override_reset_all':
          return toolContext.executeTool('override_app', { action: 'reset_all' });
        case 'mount':
        case 'unmount':
        case 'unload':
          return toolContext.executeTool('app_action', { action, appName: opts?.appName });
        default:
          throw new Error(`Unknown single_spa action: ${action}`);
      }
    },

    tab: async (
      action: string,
      opts?: { url?: string; create?: boolean; ref?: number; targetId?: string },
    ) => {
      switch (action) {
        case 'connect':
          return toolContext.executeTool('connect_tab', { url: opts?.url, create: opts?.create, session_id: sessionId });
        case 'list':
          return toolContext.executeTool('list_tabs', { session_id: sessionId });
        case 'switch':
          return toolContext.executeTool('switch_tab', { targetId: opts?.targetId, session_id: sessionId });
        case 'release':
          return toolContext.executeTool('release_tab', { session_id: sessionId });
        default:
          throw new Error(`Unknown tab action: ${action}`);
      }
    },

    consoleLogs: async (opts?: { level?: string; clear?: boolean; count?: number; search?: string }) =>
      toolContext.executeTool('console_logs', opts || {}),

    networkLog: async (opts?: { status_filter?: string; url_filter?: string; count?: number; clear?: boolean }) =>
      toolContext.executeTool('network_log', opts || {}),

    networkDetail: async (requestId: string, opts?: { include?: string; max_body_size?: number }) =>
      toolContext.executeTool('network_detail', { requestId, ...opts }),

    cssInspect: async (selector: string, properties?: string) =>
      toolContext.executeTool('css_inspect', { selector, ...(properties ? { properties } : {}) }),

    labeledScreenshot: async (opts?: { quality?: string; model?: string }) =>
      toolContext.executeTool('screenshot', { labels: true, ...opts }),

    accessibilitySnapshot: async (opts?: { search?: string; interactive_only?: boolean; diff?: boolean }) =>
      toolContext.executeTool('accessibility_snapshot', opts || {}),

    networkIntercept: {
      enable: async () => toolContext.executeTool('network_intercept', { action: 'enable' }),
      disable: async () => toolContext.executeTool('network_intercept', { action: 'disable' }),
      listRules: async () => toolContext.executeTool('network_intercept', { action: 'list_rules' }),
      addRule: async (rule: { url_pattern: string; mock_status?: number; mock_headers?: string; mock_body?: string; block?: boolean; resource_type?: string }) =>
        toolContext.executeTool('network_intercept', { action: 'add_rule', ...rule }),
      removeRule: async (rule_id: string) =>
        toolContext.executeTool('network_intercept', { action: 'remove_rule', rule_id }),
    },

    dbg: {
      enable: async () => toolContext.executeTool('debugger', { action: 'enable' }),
      resume: async () => toolContext.executeTool('debugger', { action: 'resume' }),
      stepOver: async () => toolContext.executeTool('debugger', { action: 'step_over' }),
      stepInto: async () => toolContext.executeTool('debugger', { action: 'step_into' }),
      stepOut: async () => toolContext.executeTool('debugger', { action: 'step_out' }),
      setBreakpoint: async (file: string, line: number, condition?: string) =>
        toolContext.executeTool('debugger', { action: 'set_breakpoint', file, line, ...(condition ? { condition } : {}) }),
      removeBreakpoint: async (breakpointId: string) =>
        toolContext.executeTool('debugger', { action: 'remove_breakpoint', breakpointId }),
      listBreakpoints: async () => toolContext.executeTool('debugger', { action: 'list_breakpoints' }),
      inspectVariables: async () => toolContext.executeTool('debugger', { action: 'inspect_variables' }),
      evaluate: async (expression: string) =>
        toolContext.executeTool('debugger', { action: 'evaluate', expression }),
      listScripts: async (search?: string) =>
        toolContext.executeTool('debugger', { action: 'list_scripts', ...(search ? { search } : {}) }),
      pauseOnExceptions: async (state: 'none' | 'uncaught' | 'all') =>
        toolContext.executeTool('debugger', { action: 'pause_on_exceptions', state }),
    },

    browserFetch: async (url: string, opts?: { method?: string; headers?: string; body?: string; max_body_size?: number }) =>
      toolContext.executeTool('browser_fetch', { url, ...opts }),

    storage: async (action: string, opts?: Record<string, unknown>) =>
      toolContext.executeTool('storage', { action, ...opts }),

    emulation: async (action: string, opts?: Record<string, unknown>) =>
      toolContext.executeTool('emulation', { action, ...opts }),

    performance: async (action?: string) =>
      toolContext.executeTool('performance', { action: action || 'get_metrics' }),
  });
}
