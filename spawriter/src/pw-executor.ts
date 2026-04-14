import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import * as vm from 'node:vm';
import * as util from 'node:util';
import { getCdpUrl, getRelayPort, log, error } from './utils.js';

export class CodeExecutionTimeoutError extends Error {
  constructor(timeout: number) {
    super(`Code execution timed out after ${timeout}ms`);
    this.name = 'CodeExecutionTimeoutError';
  }
}

const usefulGlobals = {
  setTimeout,
  setInterval,
  clearTimeout,
  clearInterval,
  URL,
  URLSearchParams,
  fetch,
  Buffer,
  TextEncoder,
  TextDecoder,
  AbortController,
  AbortSignal,
  structuredClone,
} as const;

export interface ExecuteResult {
  text: string;
  isError: boolean;
  images: Array<{ data: string; mimeType: string }>;
}

/**
 * Detect Playwright ChannelOwner objects.
 * These objects leak process.env when traversed by util.inspect
 * via _connection._platform.env. Must intercept before serialization.
 */
export function isPlaywrightChannelOwner(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as any)._type === 'string' &&
    typeof (value as any)._guid === 'string'
  );
}

/**
 * Parse code and check if it's a single expression that should be auto-returned.
 * Returns the expression source or null. Uses async-function heuristic to handle
 * `await` expressions: wraps in `async function` before testing compilability.
 */
export function getAutoReturnExpression(code: string): string | null {
  const trimmed = code.replace(/;+\s*$/, '').trim();
  if (!trimmed) return null;

  if (/^\s*(const|let|var|function|class|if|for|while|do|switch|try|throw|import|export)\b/.test(trimmed)) return null;
  if (/^\s*return\b/.test(trimmed)) return null;

  const lines = trimmed.split('\n');
  if (lines.length > 1) {
    for (const line of lines) {
      const stripped = line.trim();
      if (stripped.endsWith(';') || stripped.endsWith('{') || stripped.endsWith('}')) return null;
    }
  }

  try {
    new Function(`return async function() { return (${trimmed}) }`);
    return trimmed;
  } catch {
    return null;
  }
}

export function wrapCode(code: string): string {
  const expr = getAutoReturnExpression(code);
  if (expr !== null) {
    return `(async () => { return await (${expr}) })()`;
  }
  return `(async () => { ${code} })()`;
}

export class PlaywrightExecutor {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private userState: Record<string, unknown> = {};
  private isConnected = false;
  private activeAbortController: AbortController | null = null;
  private customGlobals: Record<string, unknown> = {};

  setGlobals(globals: Record<string, unknown>): void {
    this.customGlobals = { ...this.customGlobals, ...globals };
  }

  async ensureConnection(): Promise<{ page: Page; context: BrowserContext }> {
    if (this.isConnected && this.browser && this.page && !this.page.isClosed()) {
      return { page: this.page, context: this.context! };
    }

    await this.closeQuietly();

    const port = getRelayPort();
    const clientId = `pw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const cdpUrl = getCdpUrl(port, clientId);

    log('Connecting Playwright over CDP:', cdpUrl);

    const browser = await Promise.race([
      chromium.connectOverCDP(cdpUrl),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('CDP connection timeout (15s)')), 15000)),
    ]);

    browser.on('disconnected', () => {
      log('Playwright browser disconnected');
      this.clearConnectionState();
    });

    const contexts = browser.contexts();
    const context = contexts.length > 0 ? contexts[0] : await browser.newContext();

    context.setDefaultTimeout(30000);
    context.setDefaultNavigationTimeout(15000);

    const pages = context.pages().filter(p => !p.isClosed());
    const page = pages.length > 0 ? pages[0] : await context.newPage();

    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 });
    } catch {
      // Best-effort stabilization: the page may already be in a valid state.
    }

    this.browser = browser;
    this.context = context;
    this.page = page;
    this.isConnected = true;

    return { page, context };
  }

  cancelActiveExecution(): void {
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }
  }

  async execute(code: string, timeout = 30000, retryOnContextError = true): Promise<ExecuteResult> {
    const consoleLogs: Array<{ method: string; args: unknown[] }> = [];

    this.cancelActiveExecution();
    const abortController = new AbortController();
    this.activeAbortController = abortController;

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    try {
      const { page, context } = await this.ensureConnection();

      const prevDefaultTimeout = 30000;
      page.setDefaultTimeout(Math.min(timeout, prevDefaultTimeout));
      page.setDefaultNavigationTimeout(Math.min(timeout, 15000));

      const customConsole = {
        log: (...args: unknown[]) => consoleLogs.push({ method: 'log', args }),
        info: (...args: unknown[]) => consoleLogs.push({ method: 'info', args }),
        warn: (...args: unknown[]) => consoleLogs.push({ method: 'warn', args }),
        error: (...args: unknown[]) => consoleLogs.push({ method: 'error', args }),
        debug: (...args: unknown[]) => consoleLogs.push({ method: 'debug', args }),
      };

      // Warm up execution context. Some CDP flows emit a transient
      // "Execution context was destroyed" right after connect/navigation.
      try {
        await Promise.race([
          page.evaluate('1'),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Warmup timeout')), 3000)),
        ]);
      } catch {
        // Best-effort warmup only; user code execution below has full error handling.
      }

      const vmContextObj: Record<string, unknown> = {
        page,
        context,
        state: this.userState,
        console: customConsole,
        ...usefulGlobals,
        ...this.customGlobals,
      };

      const vmContext = vm.createContext(vmContextObj);
      const autoReturnExpr = getAutoReturnExpression(code);
      const wrappedCode = autoReturnExpr !== null
        ? `(async () => { return await (${autoReturnExpr}) })()`
        : `(async () => { ${code} })()`;
      const hasExplicitReturn = autoReturnExpr !== null || /\breturn\b/.test(code);

      const result = await Promise.race([
        vm.runInContext(wrappedCode, vmContext, { timeout, displayErrors: true }),
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new CodeExecutionTimeoutError(timeout));
          }, timeout);
        }),
        new Promise((_, reject) => {
          abortController.signal.addEventListener('abort', () => reject(new CodeExecutionTimeoutError(timeout)));
        }),
      ]);
      if (timeoutHandle) clearTimeout(timeoutHandle);

      page.setDefaultTimeout(prevDefaultTimeout);
      page.setDefaultNavigationTimeout(15000);

      let responseText = PlaywrightExecutor.formatConsoleLogs(consoleLogs);

      if (hasExplicitReturn && result !== undefined && !isPlaywrightChannelOwner(result)) {
        const formatted = typeof result === 'string'
          ? result
          : util.inspect(result, { depth: 4, colors: false, maxArrayLength: 100, maxStringLength: 1000, breakLength: 80 });
        if (formatted.trim()) {
          responseText += `[return value] ${formatted}\n`;
        }
      }

      if (!responseText.trim()) {
        responseText = 'Code executed successfully (no output)';
      }

      const MAX_LENGTH = 10000;
      let finalText = responseText.trim();
      if (finalText.length > MAX_LENGTH) {
        finalText = finalText.slice(0, MAX_LENGTH)
          + `\n\n[Truncated to ${MAX_LENGTH} characters]`;
      }

      return { text: finalText, isError: false, images: [] };
    } catch (err: unknown) {
      if (timeoutHandle) clearTimeout(timeoutHandle);

      const e = err as Error;
      const isTimeoutError = e instanceof CodeExecutionTimeoutError
        || e.name === 'TimeoutError'
        || e.name === 'AbortError';
      const isRecoverableContextError =
        /Execution context was destroyed/i.test(e.message)
        || /Cannot find context with specified id/i.test(e.message);

      if (retryOnContextError && isRecoverableContextError) {
        log('Playwright execution context stale, retrying once...');
        await new Promise(resolve => setTimeout(resolve, 150));
        return this.execute(code, timeout, false);
      }

      error('Error in playwright execute:', e.stack || e.message);

      if (isTimeoutError) {
        try {
          if (this.page && !this.page.isClosed()) {
            await Promise.race([
              this.page.evaluate('1'),
              new Promise((_, reject) => setTimeout(() => reject(new Error('post-timeout check')), 3000)),
            ]).catch(() => {});
          }
        } catch { /* ignore */ }
      }

      const logsText = PlaywrightExecutor.formatConsoleLogs(consoleLogs, 'Console output (before error)');
      const resetHint = isTimeoutError
        ? '\n\n[HINT: Execution timed out. The operation may still be running in the browser. Use reset if the browser is in a bad state.]'
        : '\n\n[HINT: If this is a Playwright connection error, call reset to reconnect.]';
      const errorText = isTimeoutError ? e.message : (e.stack || e.message);

      return {
        text: `${logsText}\nError executing code: ${errorText}${resetHint}`,
        isError: true,
        images: [],
      };
    } finally {
      if (this.activeAbortController === abortController) {
        this.activeAbortController = null;
      }
    }
  }

  async reset(): Promise<void> {
    this.userState = {};
    await this.closeQuietly();
  }

  getStatus(): { connected: boolean; stateKeys: string[] } {
    return {
      connected: this.isConnected,
      stateKeys: Object.keys(this.userState),
    };
  }

  private clearConnectionState() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.isConnected = false;
  }

  private async closeQuietly(): Promise<void> {
    if (this.browser) {
      try { await this.browser.close(); } catch { /* ignore */ }
    }
    this.clearConnectionState();
  }

  static formatConsoleLogs(logs: Array<{ method: string; args: unknown[] }>, prefix = 'Console output'): string {
    if (logs.length === 0) return '';
    let text = `${prefix}:\n`;
    for (const { method, args } of logs) {
      const formattedArgs = args.map(arg =>
        typeof arg === 'string' ? arg : util.inspect(arg, { depth: 4, colors: false, maxArrayLength: 100, maxStringLength: 1000, breakLength: 80 })
      ).join(' ');
      text += `[${method}] ${formattedArgs}\n`;
    }
    return text + '\n';
  }
}

/**
 * Manages multiple PlaywrightExecutor instances keyed by session ID.
 * Each session has its own browser connection and persistent state.
 */
export class ExecutorManager {
  private executors = new Map<string, PlaywrightExecutor>();
  private maxSessions: number;

  constructor(maxSessions = 5) {
    this.maxSessions = maxSessions;
  }

  getOrCreate(sessionId: string): PlaywrightExecutor {
    let executor = this.executors.get(sessionId);
    if (!executor) {
      if (this.executors.size >= this.maxSessions) {
        throw new Error(
          `Playwright executor limit reached (${this.maxSessions}). ` +
          `Active sessions: ${Array.from(this.executors.keys()).join(', ')}. ` +
          `Delete an existing session first.`,
        );
      }
      executor = new PlaywrightExecutor();
      this.executors.set(sessionId, executor);
    }
    return executor;
  }

  get(sessionId: string): PlaywrightExecutor | null {
    return this.executors.get(sessionId) ?? null;
  }

  async remove(sessionId: string): Promise<boolean> {
    const executor = this.executors.get(sessionId);
    if (executor) {
      await executor.reset();
      return this.executors.delete(sessionId);
    }
    return false;
  }

  listSessions(): Array<{ id: string; connected: boolean; stateKeys: string[] }> {
    return Array.from(this.executors.entries()).map(([id, executor]) => ({
      id,
      ...executor.getStatus(),
    }));
  }

  async resetAll(): Promise<void> {
    const resets = Array.from(this.executors.values()).map(e => e.reset().catch(() => {}));
    await Promise.all(resets);
    this.executors.clear();
  }

  get size(): number {
    return this.executors.size;
  }
}
